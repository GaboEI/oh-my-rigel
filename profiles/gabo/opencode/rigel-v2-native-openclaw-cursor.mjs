/**
 * Native V2 OpenClaw poll cursor and duplicate memory.
 *
 * V1 persisted its poll cursor to a state file so a daemon restart resumed
 * correctly. The V2 port originally kept it in the process, which is a silent
 * loss: a restart re-reads the platform window from zero, and a cursor advanced
 * before the acknowledgement turns one failed ack into a permanently dropped
 * reply (`Unidades_Atomicas_OpenClaw.md` §U8).
 *
 * This module owns that state and nothing else. Per `(platform, channel)` it
 * keeps ONE versioned record under its own storage key:
 *
 *   rigel-v2/openclaw/cursor/<platform>/<sha1(platform\0channel)>
 *   {
 *     v: 1,
 *     platform: "discord" | "telegram",
 *     channel: "<discord channel id | telegram chat id>",
 *     cursor: <string | number | null>,   // the advance boundary
 *     delivered: ["<id>", ...],           // injected, acknowledgement still owed
 *     acked: ["<id>", ...],               // acknowledged, may still trail the cursor
 *     updatedAt: "<ISO>"
 *   }
 *
 * Three properties are deliberate:
 *
 *   - The cursor is a CONTIGUOUS frontier, not "the last message seen". The
 *     poller only moves it past a message whose processing is finished, so a
 *     pending reply can never be skipped for good.
 *   - `delivered` is written BEFORE the acknowledgement and never moves the
 *     cursor. Recording that a reply already reached the session is what keeps a
 *     restart from injecting it a second time, and because the cursor does not
 *     move, the message stays retryable until its ack lands.
 *   - Both sets are bounded, oldest first, so a stuck head cannot grow the
 *     document without limit. A truncated entry costs one duplicate at worst.
 *   - The write is the gate, not the intent. A record leaves the retry set only
 *     AFTER `storage.set` resolves, so a transient failure is retried by the next
 *     flush instead of being forgotten by it, and every write reports whether the
 *     durable half actually landed (`persisted` / `in-memory` / `failed`). Retrying
 *     is bounded by the flush itself (one attempt per record per poll window) and
 *     reporting is bounded by the episode: the first failure names itself, the
 *     `OPENCLAW_CURSOR_MAX_PERSIST_ATTEMPTS`th says once that the document is
 *     behind, and the write that lands names the recovery. Nothing is lost in that
 *     state (the in-process frontier still governs), nothing is silently claimed
 *     durable either, and `unsaved()` is how the caller reports the degradation
 *     instead of a healthy poll.
 *   - A resume position expires where the platform rebuilds its id space. Telegram
 *     reassigns `update_id` after a week of inactivity, so an offset kept from before
 *     that reassignment filters out every new update. `resumeCursorFor` retires such
 *     a position after `OPENCLAW_CURSOR_MAX_AGE_MS` of no durable write (or when the
 *     record carries no readable timestamp, which cannot prove freshness) and the
 *     duplicate memory is kept, so the re-read window costs an ack retry at worst.
 *     Discord is exempt: its snowflake ids only grow, so an old `after=` value can
 *     never skip a newer message.
 *
 * §9.3 applies here too: a suppressed duplicate is NOT reported, and a retry is
 * logged only as the first failure of an episode. This module logs an unreadable
 * persisted record, the first failed write of an episode, the point at which the
 * durable cursor is declared behind, a recovery and a retirement, never a dedup hit
 * and never once per poll.
 */
import { createHash } from "node:crypto"

/** Storage prefix of the poll-cursor documents. */
export const OPENCLAW_CURSOR_PREFIX = "rigel-v2/openclaw/cursor/"
/** Schema version of one cursor document. A different version is not trusted. */
export const OPENCLAW_CURSOR_VERSION = 1
/** How many message identifiers each list remembers per platform and channel. */
export const OPENCLAW_CURSOR_MAX_TRACKED = 512
/** Platforms whose cursor shape this build understands. */
export const OPENCLAW_CURSOR_PLATFORMS = Object.freeze(["discord", "telegram"])
/**
 * Consecutive failed writes after which the store says once that the durable
 * cursor is behind. It is a REPORTING threshold, not a stop: a record keeps being
 * retried once per flush, because a domain that heals has to be able to become
 * durable again without restarting the process.
 */
export const OPENCLAW_CURSOR_MAX_PERSIST_ATTEMPTS = 3
/**
 * How long a persisted position stays usable as a resume point. One week is the
 * window Telegram documents for keeping a bot's update history: past it the
 * `update_id` space may have been rebuilt, so the stored offset would filter out
 * every new update instead of resuming after the last one.
 */
export const OPENCLAW_CURSOR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/**
 * Platforms whose resume position expires. Only the ones that rebuild their id
 * space: a Discord snowflake only grows, so a stale `after=` value can never skip
 * a newer message and retiring it would only re-read a window for nothing.
 */
export const OPENCLAW_CURSOR_AGE_LIMITED_PLATFORMS = Object.freeze(["telegram"])

const LOG_PREFIX = "[oh-my-rigel]"

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isTrackedId(value) {
  return typeof value === "string" && value.length > 0
}

/**
 * The cursor value a platform can persist. Discord message ids are snowflakes
 * (strings); Telegram's cursor is the numeric `update_id` its own `offset`
 * parameter speaks. Anything else is a record this build must not obey.
 */
function isValidCursor(platform, value) {
  if (value === null) return true
  if (platform === "telegram") return Number.isSafeInteger(value) && value >= 0
  return isTrackedId(value)
}

function isValidRecord(value) {
  if (!isPlainObject(value)) return false
  if (value.v !== OPENCLAW_CURSOR_VERSION) return false
  if (typeof value.platform !== "string" || !OPENCLAW_CURSOR_PLATFORMS.includes(value.platform)) return false
  if (typeof value.channel !== "string" || value.channel.length === 0) return false
  if (!isValidCursor(value.platform, value.cursor)) return false
  if (!Array.isArray(value.delivered) || !value.delivered.every(isTrackedId)) return false
  if (!Array.isArray(value.acked) || !value.acked.every(isTrackedId)) return false
  return true
}

/**
 * Storage key of one `(platform, channel)` cursor. The channel is hashed because
 * a Telegram chat id is not guaranteed to be a safe key segment, and the platform
 * travels in clear so a key is attributable without reading the value.
 */
export function openclawCursorKey(platform, channel) {
  const hash = createHash("sha1").update(`${platform}\u0000${channel}`).digest("hex")
  return `${OPENCLAW_CURSOR_PREFIX}${platform}/${hash}`
}

/**
 * Create the cursor store. `storage` is the V2 plugin storage domain and may be
 * absent: the store still works in process and simply does not survive a reload,
 * which is exactly the pre-U8 behaviour and the independent rollback.
 *
 * `hydrate()` must be awaited once before the poller starts. Every advance or
 * dedup record is persisted before its promise resolves, and each transition
 * reports what became of its write: `persisted` (it landed), `in-memory` (no
 * storage domain was provided, so nothing durable was owed) or `failed` (a write
 * was owed and did not land, so the record stays queued for the next flush).
 */
export function createOpenclawCursorStore({ storage, now = () => Date.now(), log = () => {}, maxTracked, maxCursorAgeMs } = {}) {
  const records = new Map()
  // Records whose in-memory state is ahead of storage: a deferred advance, or a
  // write that has not landed yet. `unsaved()` exposes exactly this set.
  const dirty = new Set()
  const failedWrites = new Map()
  const canScan = Boolean(storage && typeof storage.scan === "function")
  const canPersist = Boolean(storage && typeof storage.set === "function")
  const limit = Number.isSafeInteger(maxTracked) && maxTracked > 0 ? maxTracked : OPENCLAW_CURSOR_MAX_TRACKED
  const maxAgeMs = Number.isFinite(maxCursorAgeMs) && maxCursorAgeMs > 0 ? maxCursorAgeMs : OPENCLAW_CURSOR_MAX_AGE_MS
  let hydration

  function say(message) {
    log(`${LOG_PREFIX} Native V2 openclaw ${message}`)
  }

  function indexKey(platform, channel) {
    return `${platform}\u0000${channel}`
  }

  function recordFor(platform, channel) {
    const key = indexKey(platform, channel)
    const existing = records.get(key)
    if (existing !== undefined) return existing
    const created = {
      v: OPENCLAW_CURSOR_VERSION,
      platform,
      channel,
      cursor: null,
      delivered: [],
      acked: [],
      updatedAt: null,
    }
    records.set(key, created)
    return created
  }

  function trim(list) {
    const overflow = list.length - limit
    if (overflow > 0) list.splice(0, overflow)
  }

  function hydrate() {
    if (!canScan) return Promise.resolve()
    if (hydration === undefined) hydration = readPersisted()
    return hydration
  }

  async function readPersisted() {
    let reportedUnusable = false
    try {
      const page = await storage.scan({ prefix: OPENCLAW_CURSOR_PREFIX })
      const entries = Array.isArray(page?.entries) ? page.entries : []
      for (const entry of entries) {
        const value = entry?.value
        if (!isValidRecord(value)) {
          // A record this build cannot read is IGNORED, never obeyed: starting
          // from zero re-reads a window (one duplicate at worst), while trusting
          // a foreign shape could skip messages for good.
          if (!reportedUnusable) {
            reportedUnusable = true
            say("cursor record skipped: unrecognised shape or version")
          }
          continue
        }
        records.set(indexKey(value.platform, value.channel), {
          v: OPENCLAW_CURSOR_VERSION,
          platform: value.platform,
          channel: value.channel,
          cursor: value.cursor,
          delivered: [...value.delivered],
          acked: [...value.acked],
          updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
        })
      }
    } catch (error) {
      say(`cursor hydrate failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function persistErrorClass(error) {
    return error instanceof Error ? error.message : String(error)
  }

  /**
   * Write one record and report what became of the write.
   *
   * The record leaves the retry set only when the write LANDED. A failure keeps it
   * queued, so the next `flush()` retries it exactly once: one attempt per record
   * per poll window is a bound the window itself provides, and it is the only way a
   * store whose domain heals can ever become durable again. Reporting is bounded
   * separately: the first failure of an episode names itself, `MAX_PERSIST_ATTEMPTS`
   * consecutive failures say once that the durable half is behind, and the write
   * that finally lands names the recovery. Every outcome is honest about durability,
   * because that is the question `markDelivered` exists to answer.
   *
   * @returns {"persisted" | "in-memory" | "failed"}
   */
  async function persist(record) {
    record.updatedAt = new Date(now()).toISOString()
    const key = indexKey(record.platform, record.channel)
    if (!canPersist) {
      // No storage domain: nothing durable is owed, so nothing is pending. This is
      // the pre-U8 behaviour and the independent rollback, not a degraded state.
      dirty.delete(key)
      return "in-memory"
    }
    try {
      await storage.set(openclawCursorKey(record.platform, record.channel), {
        v: record.v,
        platform: record.platform,
        channel: record.channel,
        cursor: record.cursor,
        delivered: [...record.delivered],
        acked: [...record.acked],
        updatedAt: record.updatedAt,
      })
    } catch (error) {
      const failures = (failedWrites.get(key) ?? 0) + 1
      failedWrites.set(key, failures)
      // Safe hold: the record stays queued and the in-process frontier keeps
      // governing, so a broken domain costs latency in durability, never a message.
      dirty.add(key)
      if (failures === 1) say(`cursor persist failed: ${persistErrorClass(error)}; keeping the cursor queued`)
      else if (failures === OPENCLAW_CURSOR_MAX_PERSIST_ATTEMPTS) {
        say(`cursor persist failed ${failures} times: the durable cursor is behind, retrying once per window until it lands`)
      }
      return "failed"
    }
    const wasFailing = failedWrites.get(key)
    failedWrites.delete(key)
    dirty.delete(key)
    if (wasFailing !== undefined) say("cursor persist recovered")
    return "persisted"
  }

  /**
   * How many records are ahead of storage right now. Called after `flush()`, a
   * non-zero answer is the reason a poll must report a degraded cursor instead of a
   * healthy one: the advance is in memory and the document is not.
   */
  function unsaved() {
    return dirty.size
  }

  /** The persisted advance boundary for a port, or `null` when none is recorded. */
  function cursorFor(platform, channel) {
    if (typeof platform !== "string" || platform.length === 0) return null
    if (channel === undefined || channel === null || `${channel}`.length === 0) return null
    return recordFor(platform, `${channel}`).cursor
  }

  /**
   * Whether a persisted position may still be resumed from. A platform that
   * rebuilds its id space can hand out ids below a stored position, and an offset
   * above every new id filters the whole update feed out, so a position that has
   * not been written for `maxAgeMs` is retired instead of obeyed. A record with no
   * readable timestamp cannot prove it is fresh either, and trusting it could skip
   * messages for good, so it is retired as well: the cost is one re-read window,
   * which the duplicate memory turns into an ack retry at worst.
   */
  function isStaleResume(record) {
    if (record.cursor === null) return false
    if (!OPENCLAW_CURSOR_AGE_LIMITED_PLATFORMS.includes(record.platform)) return false
    const writtenAt = typeof record.updatedAt === "string" ? Date.parse(record.updatedAt) : Number.NaN
    if (!Number.isFinite(writtenAt)) return true
    return now() - writtenAt > maxAgeMs
  }

  /**
   * The advance boundary the poller may resume from, and whether the stored one was
   * retired. A retired position is cleared in memory and queued, so the document
   * says "no resume point" instead of repeating a stale one on every start, while
   * `delivered` and `acked` survive: they are what keeps the re-read from injecting
   * a reply that already reached its session.
   */
  function resumeCursorFor(platform, channel) {
    if (typeof platform !== "string" || platform.length === 0) return { cursor: null, expired: false }
    if (channel === undefined || channel === null || `${channel}`.length === 0) return { cursor: null, expired: false }
    const record = recordFor(platform, `${channel}`)
    if (!isStaleResume(record)) return { cursor: record.cursor, expired: false }
    record.cursor = null
    dirty.add(indexKey(record.platform, record.channel))
    say(`cursor retired: a ${platform} position older than ${maxAgeMs} ms is not a resume point`)
    return { cursor: null, expired: true }
  }

  /** `new` (never seen), `delivered` (injected, ack owed) or `acked` (finished). */
  function stateOf(platform, channel, messageId) {
    if (typeof platform !== "string" || channel === undefined || channel === null) return "new"
    if (!isTrackedId(messageId)) return "new"
    const record = recordFor(platform, `${channel}`)
    if (record.acked.includes(messageId)) return "acked"
    if (record.delivered.includes(messageId)) return "delivered"
    return "new"
  }

  /**
   * Move the in-memory frontier. Persistence is deferred to `flush()` so a poll
   * that skips several messages writes once instead of once per message. Passing
   * the value the record already has is not a change and is not written.
   */
  function setCursor(platform, channel, cursor) {
    if (typeof platform !== "string" || channel === undefined || channel === null) return false
    const record = recordFor(platform, `${channel}`)
    if (record.cursor === cursor) return false
    record.cursor = cursor
    dirty.add(indexKey(record.platform, record.channel))
    return true
  }

  /**
   * Record that a reply reached the session and its acknowledgement is still
   * owed. Persisted at once: this is the record that stops a restart from
   * injecting the same reply twice, so its answer is the durability of that mark
   * and not a plain acknowledgement of the call.
   *
   * @returns {"persisted" | "in-memory" | "failed"}. An id that is not a tracked
   *   identifier records nothing, so no durable write is owed and it answers
   *   `"in-memory"` like a store with no storage domain; only `"failed"` says a
   *   write was owed and did not land.
   */
  async function markDelivered(platform, channel, messageId) {
    if (!isTrackedId(messageId)) return "in-memory"
    const record = recordFor(platform, `${channel}`)
    if (!record.delivered.includes(messageId)) record.delivered.push(messageId)
    trim(record.delivered)
    return persist(record)
  }

  /**
   * Record a completed acknowledgement and set the frontier the caller computed.
   * `cursor` is the contiguous frontier, not necessarily this message's id: a
   * message acknowledged behind an unresolved predecessor may not move it.
   *
   * @returns {"persisted" | "in-memory" | "failed"} what became of the write that
   *   makes this acknowledgement durable, which is the same answer `markDelivered`
   *   gives and never a claim the storage domain did not honour.
   */
  async function commitAck(platform, channel, { messageId, cursor }) {
    const record = recordFor(platform, `${channel}`)
    if (isTrackedId(messageId)) {
      record.delivered = record.delivered.filter((entry) => entry !== messageId)
      if (!record.acked.includes(messageId)) record.acked.push(messageId)
      trim(record.acked)
    }
    if (cursor !== undefined) record.cursor = cursor
    return persist(record)
  }

  /**
   * Write every cursor a poll advanced in memory: one attempt per record per flush,
   * so a record whose write keeps failing is retried once per poll window instead
   * of once per message in it.
   */
  async function flush() {
    if (dirty.size === 0) return { written: 0, failed: 0 }
    let written = 0
    let failed = 0
    for (const key of [...dirty]) {
      const record = records.get(key)
      if (record === undefined) {
        dirty.delete(key)
        continue
      }
      if ((await persist(record)) === "failed") failed += 1
      else written += 1
    }
    return { written, failed }
  }

  return { hydrate, cursorFor, resumeCursorFor, unsaved, stateOf, setCursor, markDelivered, commitAck, flush }
}
