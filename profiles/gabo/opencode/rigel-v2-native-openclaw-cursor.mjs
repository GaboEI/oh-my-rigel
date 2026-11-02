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
 *
 * §9.3 applies here too: a suppressed duplicate is NOT reported. This module
 * logs only an unreadable persisted record or a failed write, never a dedup hit.
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
 * dedup record is persisted before its promise resolves, so a caller that awaits
 * the transition can rely on it having landed.
 */
export function createOpenclawCursorStore({ storage, now = () => Date.now(), log = () => {}, maxTracked } = {}) {
  const records = new Map()
  const dirty = new Set()
  const canScan = Boolean(storage && typeof storage.scan === "function")
  const canPersist = Boolean(storage && typeof storage.set === "function")
  const limit = Number.isSafeInteger(maxTracked) && maxTracked > 0 ? maxTracked : OPENCLAW_CURSOR_MAX_TRACKED
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

  async function persist(record) {
    record.updatedAt = new Date(now()).toISOString()
    dirty.delete(indexKey(record.platform, record.channel))
    if (!canPersist) return
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
      // The in-process cursor stays authoritative for this run; the failure is
      // named instead of swallowed so a broken storage domain is not silent.
      say(`cursor persist failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** The persisted advance boundary for a port, or `null` when none is recorded. */
  function cursorFor(platform, channel) {
    if (typeof platform !== "string" || platform.length === 0) return null
    if (channel === undefined || channel === null || `${channel}`.length === 0) return null
    return recordFor(platform, `${channel}`).cursor
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
   * injecting the same reply twice.
   */
  async function markDelivered(platform, channel, messageId) {
    if (!isTrackedId(messageId)) return false
    const record = recordFor(platform, `${channel}`)
    if (!record.delivered.includes(messageId)) record.delivered.push(messageId)
    trim(record.delivered)
    await persist(record)
    return true
  }

  /**
   * Record a completed acknowledgement and set the frontier the caller computed.
   * `cursor` is the contiguous frontier, not necessarily this message's id: a
   * message acknowledged behind an unresolved predecessor may not move it.
   */
  async function commitAck(platform, channel, { messageId, cursor }) {
    const record = recordFor(platform, `${channel}`)
    if (isTrackedId(messageId)) {
      record.delivered = record.delivered.filter((entry) => entry !== messageId)
      if (!record.acked.includes(messageId)) record.acked.push(messageId)
      trim(record.acked)
    }
    if (cursor !== undefined) record.cursor = cursor
    await persist(record)
    return true
  }

  /** Write every cursor a poll advanced in memory. Returns how many were written. */
  async function flush() {
    if (dirty.size === 0) return 0
    let written = 0
    for (const key of [...dirty]) {
      const record = records.get(key)
      if (record === undefined) {
        dirty.delete(key)
        continue
      }
      await persist(record)
      written += 1
    }
    return written
  }

  return { hydrate, cursorFor, stateOf, setCursor, markDelivered, commitAck, flush }
}
