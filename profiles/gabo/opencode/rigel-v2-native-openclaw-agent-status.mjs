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
 */

/** Storage key of the document. */
export const OPENCLAW_STATUS_KEY = "rigel-v2/openclaw/status"
/** `up` = working, `degraded` = up with consecutive failures, `fatal` = disabled. */
export const OPENCLAW_STATUS_STATES = Object.freeze(["up", "degraded", "fatal"])
/** Severities the document distinguishes. `info` is used for transitions only. */
export const OPENCLAW_STATUS_SEVERITIES = Object.freeze(["fatal", "degraded", "info"])

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

  /** Load a document a previous process wrote. An unusable one is reported, never trusted. */
  async function hydrate() {
    if (!canRead) return
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
   */
  async function recordFailure(id, { errorClass = null, fatal = false } = {}) {
    if (typeof id !== "string" || id.length === 0) return false
    const surface = surfaceFor(id)
    surface.state = fatal ? "fatal" : "degraded"
    surface.errorClass = errorClass
    surface.consecutiveFailures += 1
    surface.lastErrorAt = timestamp()
    const severity = fatal ? "fatal" : "degraded"
    const detail = errorClass ? ` (${errorClass})` : ""
    const message = fatal
      ? `openclaw surface disabled: ${id}${detail}`
      : `openclaw surface degraded: ${id}${detail} after ${surface.consecutiveFailures} consecutive failure(s)`
    emit(id, severity, errorClass, message)
    await persist()
    return true
  }

  /** Record a success. Emits one recovery line only when the surface was not `up`. */
  async function recordSuccess(id) {
    if (typeof id !== "string" || id.length === 0) return false
    const surface = surfaceFor(id)
    const previous = surface.state
    surface.state = "up"
    surface.errorClass = null
    surface.consecutiveFailures = 0
    if (previous !== "up") emit(id, "info", null, `openclaw surface recovered: ${id}`)
    await persist()
    return true
  }

  /** Aggregate only: §9.3 forbids a line per truncated event. */
  async function recordTruncation(id, count = 1) {
    if (typeof id !== "string" || id.length === 0) return false
    const surface = surfaceFor(id)
    surface.truncations += Number.isInteger(count) && count > 0 ? count : 1
    await persist()
    return true
  }

  /** Aggregate only: §9.3 forbids reporting rate-limit jitter at all. */
  async function recordRateLimit(id, count = 1) {
    if (typeof id !== "string" || id.length === 0) return false
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

  return { hydrate, recordFailure, recordSuccess, recordTruncation, recordRateLimit, snapshot }
}
