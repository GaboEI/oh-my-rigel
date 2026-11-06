/**
 * Native V2 OpenClaw status document.
 *
 * The server plugin has no `ctx.ui` and no `ctx.log`; the only wired sink is
 * `console.error` (`rigel-v2-native.mjs:902`). So observability is designed
 * around a durable document plus a command, never around toasts
 * (`Contrato_Transportes_OpenClaw.md` §9.1, §9.2):
 *
 *   rigel-v2/openclaw/status
 *   {
 *     surfaces: {
 *       <id>: { state, errorClass, consecutiveFailures, lastErrorAt, truncations, rateLimited }
 *     },
 *     updatedAt
 *   }
 *
 * The report is DERIVED from this document. Three channels read it:
 *
 *   - a `console.error` banner at startup for `fatal` (the surface is disabled);
 *   - ONE line per state transition for `degraded` and for recovery;
 *   - the on-demand status command (U4).
 *
 * §9.3 is the rule that keeps the channel readable, and this module enforces it
 * instead of leaving it to the caller: a rate limit and a truncation only move
 * aggregate counters and NEVER produce a line, while repeated identical failures
 * are deduplicated by `(surface, severity, errorClass)` so a broken endpoint
 * cannot flood the sink.
 *
 * Two properties make the document safe to share between the legacy surface and
 * the new namespace (U4):
 *
 *   - a write HYDRATES first, once, so persisting a new failure cannot erase the
 *     surfaces another process (or another owner in this one) had written;
 *   - a success on an already-`up` surface changes nothing, so the healthy
 *     legacy path keeps its measured zero-write call sequence.
 */

/** Storage key of the document. */
export const OPENCLAW_STATUS_KEY = "rigel-v2/openclaw/status"
/** `up` = working, `degraded` = up with consecutive failures, `fatal` = disabled, `unevaluated` = persisted row not established by this run (Gate 5 / row 29). */
export const OPENCLAW_STATUS_STATES = Object.freeze(["up", "degraded", "fatal", "unevaluated"])
/** Severities the document distinguishes. `info` is used for transitions only. */
export const OPENCLAW_STATUS_SEVERITIES = Object.freeze(["fatal", "degraded", "info"])
/** The pre-split bare legacy row. Row 30 / U-P16: no producer writes it, so a persisted copy is retired. */
export const OPENCLAW_RETIRED_OUTBOUND_SURFACE = "outbound"

const LOG_PREFIX = "[oh-my-rigel]"

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function emptySurface() {
  return {
    state: "up",
    errorClass: null,
    consecutiveFailures: 0,
    lastErrorAt: null,
    truncations: 0,
    rateLimited: 0,
  }
}

function isValidSurface(value) {
  if (!isPlainObject(value)) return false
  if (!OPENCLAW_STATUS_STATES.includes(value.state)) return false
  if (value.errorClass !== null && typeof value.errorClass !== "string") return false
  if (!Number.isInteger(value.consecutiveFailures) || value.consecutiveFailures < 0) return false
  if (value.lastErrorAt !== null && typeof value.lastErrorAt !== "string") return false
  if (!Number.isInteger(value.truncations) || value.truncations < 0) return false
  if (!Number.isInteger(value.rateLimited) || value.rateLimited < 0) return false
  return true
}

/**
 * Create the status document. `storage` is the V2 plugin storage domain and may
 * be absent: the document still works in process and simply does not survive a
 * reload.
 *
 * Every recorder is async because it persists before resolving, so a caller can
 * await the write instead of racing it.
 */
export function createOpenclawStatusDocument({ storage, now = () => Date.now(), log = () => {} } = {}) {
  const surfaces = new Map()
  /** surface id -> last emitted `(severity, errorClass)` key, for dedup. */
  const lastEmitted = new Map()
  const canPersist = Boolean(storage && typeof storage.set === "function")
  const canRead = Boolean(storage && typeof storage.get === "function")
  /** Memoised first hydration: one read per document, never one per write. */
  let hydration

  function timestamp() {
    return new Date(now()).toISOString()
  }

  function surfaceFor(id) {
    const existing = surfaces.get(id)
    if (existing) return existing
    const created = emptySurface()
    surfaces.set(id, created)
    return created
  }

  function serialize() {
    const document = { surfaces: {}, updatedAt: timestamp() }
    for (const [id, surface] of surfaces.entries()) document.surfaces[id] = { ...surface }
    return document
  }

  async function persist() {
    if (!canPersist) return
    try {
      await storage.set(OPENCLAW_STATUS_KEY, serialize())
    } catch (error) {
      log(`${LOG_PREFIX} openclaw status persist failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Load a document a previous process wrote. An unusable one is reported, never
   * trusted. Memoised, so the explicit startup warm-up and the lazy read before
   * the first write are the same single read.
   */
  function hydrate() {
    if (!canRead) return Promise.resolve()
    if (hydration === undefined) hydration = readPersisted().then(retireLegacyOutboundRow)
    return hydration
  }

  /**
   * Row 30 / U-P16: the bare `outbound` row belonged to the single pre-split legacy
   * route. Gateway deliveries now own `outbound:<gatewayName>`, so nothing writes the
   * bare row again. A persisted copy is retired deterministically as `unevaluated`
   * (never `up`), announced once, and persisted so the stored and rendered rows agree.
   */
  async function retireLegacyOutboundRow() {
    const legacy = surfaces.get(OPENCLAW_RETIRED_OUTBOUND_SURFACE)
    if (legacy === undefined || legacy.state === "unevaluated") return
    retireSurface(legacy)
    emit(OPENCLAW_RETIRED_OUTBOUND_SURFACE, "info", null, `openclaw surface retired: ${OPENCLAW_RETIRED_OUTBOUND_SURFACE}`)
    await persist()
  }

  async function readPersisted() {
    try {
      const value = await storage.get(OPENCLAW_STATUS_KEY)
      if (value === undefined || value === null) return
      if (!isPlainObject(value) || !isPlainObject(value.surfaces)) {
        log(`${LOG_PREFIX} openclaw status hydrate skipped: unrecognised document shape`)
        return
      }
      for (const [id, surface] of Object.entries(value.surfaces)) {
        if (!isValidSurface(surface)) {
          log(`${LOG_PREFIX} openclaw status hydrate skipped surface ${id}: unrecognised shape`)
          continue
        }
        surfaces.set(id, { ...surface })
      }
    } catch (error) {
      log(`${LOG_PREFIX} openclaw status hydrate failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Emit at most one line per `(surface, severity, errorClass)` until the surface
   * changes state again. Recovery changes the key, so a fresh failure is reported.
   *
   * The dedup memory is per process on purpose: a `fatal` surface must print its
   * banner on every start, which is what makes a permanently broken surface
   * visible instead of silently remembered.
   */
  function emit(id, severity, errorClass, message) {
    const key = `${severity}\u0000${errorClass ?? ""}`
    if (lastEmitted.get(id) === key) return false
    lastEmitted.set(id, key)
    log(`${LOG_PREFIX} ${message}`)
    return true
  }

  /**
   * Record a failure. `fatal` disables the surface and belongs to the startup
   * banner channel; anything else is `degraded`, one line per transition.
   *
   * `emitLine: false` records the state WITHOUT a second line: it exists for a
   * fatal whose owning resolver already announced itself at setup (a credential
   * reference, a config validation error), where a second line would break the
   * one-line-per-transition rule instead of honouring it. `detail` is appended to
   * the emitted line only; it is never persisted, so the document keeps the
   * contract shape of `Contrato_Transportes_OpenClaw.md` §9.2.
   */
  async function recordFailure(id, { errorClass = null, fatal = false, emitLine = true, detail = null } = {}) {
    if (typeof id !== "string" || id.length === 0) return false
    await hydrate()
    const surface = surfaceFor(id)
    surface.state = fatal ? "fatal" : "degraded"
    surface.errorClass = errorClass
    surface.consecutiveFailures += 1
    surface.lastErrorAt = timestamp()
    const severity = fatal ? "fatal" : "degraded"
    const detailSuffix = typeof detail === "string" && detail.length > 0 ? `: ${detail}` : ""
    const errorSuffix = errorClass ? ` (${errorClass})` : ""
    const message = fatal
      ? `openclaw surface disabled: ${id}${errorSuffix}${detailSuffix}`
      : `openclaw surface degraded: ${id}${errorSuffix}${detailSuffix} after ${surface.consecutiveFailures} consecutive failure(s)`
    if (emitLine) emit(id, severity, errorClass, message)
    await persist()
    return true
  }

  /**
   * Apply the `up` half of a transition. Shared by a recovery observed in traffic
   * and by the setup reconciliation, so both write the identical surface shape.
   */
  function recoverSurface(surface) {
    surface.state = "up"
    surface.errorClass = null
    surface.consecutiveFailures = 0
  }

  /**
   * Record a success. Only a surface this process already recorded can recover,
   * and a surface that is already `up` has nothing to record, so this returns
   * WITHOUT reading or writing: that is what keeps a healthy legacy dispatch
   * byte-identical to the pre-U4 call sequence. Any surface that could be
   * degraded here was written by `recordFailure`, which hydrated first, so the
   * document is already complete when this persists the recovery.
   */
  async function recordSuccess(id) {
    if (typeof id !== "string" || id.length === 0) return false
    const surface = surfaces.get(id)
    if (surface === undefined) return false
    if (surface.state === "up" && surface.errorClass === null && surface.consecutiveFailures === 0) return false
    const previous = surface.state
    recoverSurface(surface)
    if (previous !== "up") emit(id, "info", null, `openclaw surface recovered: ${id}`)
    await persist()
    return true
  }

  function channelNameFromSurface(id) {
    if (typeof id !== "string" || !id.startsWith("channels.")) return null
    const name = id.slice("channels.".length)
    return name.length > 0 ? name : null
  }

  function retireSurface(surface) {
    surface.state = "unevaluated"
    surface.errorClass = null
    surface.consecutiveFailures = 0
    surface.lastErrorAt = null
  }

  /**
   * Reconcile the durable `fatal` rows against the setup verdict of THIS process.
   *
   * A `fatal` is a setup verdict - `recordFailure(..., { fatal: true })` is only
   * reached from the setup path - so the setup that just ran is the authority on
   * whether it still holds. The document is durable, so without this a repaired
   * configuration or credential reference leaves a surface disabled in the report
   * for the life of the install. `kept` names the surfaces this process still
   * considers fatal.
   *
   * Gate 5 (row 29): a persisted `channels.<name>` fatal whose channel was NOT
   * evaluated by this run must never be promoted to `up`. `evaluatedChannelNames`
   * names the notification channels this run actually evaluated (resolved or
   * diagnosed); a channel fatal absent from that set is retired as `unevaluated`
   * instead of recovered. A channel fatal that WAS evaluated and is not kept is
   * recovered to `up` (the configuration was repaired). Non-channel fatals keep
   * the existing recovery behavior.
   *
   * Nothing else is touched: a `degraded` row is a runtime observation from
   * traffic, and only traffic may prove it healed. When no row changes this
   * performs one read and no write, so a healthy install stays quiet.
   */
  async function reconcileFatals(kept = [], { evaluatedChannelNames } = {}) {
    const keep = new Set(Array.isArray(kept) ? kept.filter((id) => typeof id === "string") : [])
    const evaluatedChannels = evaluatedChannelNames instanceof Set
      ? evaluatedChannelNames
      : Array.isArray(evaluatedChannelNames)
        ? new Set(evaluatedChannelNames.filter((name) => typeof name === "string"))
        : null
    await hydrate()
    const changed = []
    for (const [id, surface] of surfaces.entries()) {
      if (surface.state !== "fatal" || keep.has(id)) continue
      const channelName = channelNameFromSurface(id)
      if (channelName !== null && evaluatedChannels !== null && !evaluatedChannels.has(channelName)) {
        retireSurface(surface)
        emit(id, "info", null, `openclaw surface not evaluated by this run: ${id}`)
        changed.push(id)
        continue
      }
      recoverSurface(surface)
      emit(id, "info", null, `openclaw surface recovered: ${id}`)
      changed.push(id)
    }
    if (changed.length > 0) await persist()
    return changed
  }

  /** Aggregate only: §9.3 forbids a line per truncated event. */
  async function recordTruncation(id, count = 1) {
    if (typeof id !== "string" || id.length === 0) return false
    await hydrate()
    const surface = surfaceFor(id)
    surface.truncations += Number.isInteger(count) && count > 0 ? count : 1
    await persist()
    return true
  }

  /** Aggregate only: §9.3 forbids reporting rate-limit jitter at all. */
  async function recordRateLimit(id, count = 1) {
    if (typeof id !== "string" || id.length === 0) return false
    await hydrate()
    const surface = surfaceFor(id)
    surface.rateLimited += Number.isInteger(count) && count > 0 ? count : 1
    await persist()
    return true
  }

  /** The derived report: a detached copy, so a reader cannot mutate the document. */
  function snapshot() {
    const document = { surfaces: {}, updatedAt: timestamp() }
    for (const [id, surface] of surfaces.entries()) document.surfaces[id] = { ...surface }
    return document
  }

  return { hydrate, recordFailure, recordSuccess, recordTruncation, recordRateLimit, reconcileFatals, snapshot }
}
