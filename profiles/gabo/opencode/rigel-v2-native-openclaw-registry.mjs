/**
 * Native V2 OpenClaw correlation registry.
 *
 * V1 stored a file-locked JSONL mapping (`session-registry.ts`) that answered one
 * question: which OpenCode session did we send the outbound message a reply is
 * quoting? The V2 runtime answers the same question with native plugin storage
 * (`ctx.storage`), so the mapping survives a plugin reload without inventing a
 * second global file. The effect is preserved:
 *
 *   - written only on a successful outbound wake that returned a `messageId` and
 *     a `platform` (never for `session.deleted`);
 *   - looked up by `(platform, replyToMessageId)` when the platform's message id is
 *     unique platform-wide, and by `(platform, chat, replyToMessageId)` when it is
 *     only unique inside a chat (Telegram sequences `message_id` per chat, so `77`
 *     exists in every chat);
 *   - removed for a deleted session;
 *   - pruned after 24 hours, like `MAX_AGE_MS`.
 *
 * A process-local Map is the working index; storage is the durable mirror. When
 * the host exposes no storage domain (a unit fixture or a degraded host) the map
 * still works, so the surface degrades instead of throwing.
 */
import { createHash } from "node:crypto"
import { normalizePlatform } from "./rigel-v2-native-openclaw-core.mjs"

export const OPENCLAW_REGISTRY_PREFIX = "rigel-v2/openclaw/registry/"
export const OPENCLAW_REGISTRY_MAX_AGE_MS = 24 * 60 * 60 * 1000

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isValidMapping(value) {
  return isPlainObject(value)
    && typeof value.sessionID === "string" && value.sessionID.length > 0
    && typeof value.platform === "string" && value.platform.length > 0
    && typeof value.messageId === "string" && value.messageId.length > 0
    && typeof value.createdAt === "string" && value.createdAt.length > 0
    // A chat component that is not a string could never equal the chat the poller
    // reads, so the record would be stored unable to ever resolve. An absent or
    // empty one is "no scope", not an error.
    && (value.channelId === undefined || typeof value.channelId === "string")
}

/**
 * Platforms whose message id is unique only WITHIN a chat.
 *
 * Telegram documents `message_id` as a per-chat sequence, so `77` in two chats is
 * two different messages. Keying only `(platform, messageId)` let the second
 * delivery overwrite the first correlation and route a reply written in chat A
 * into the session that published to chat B. Discord ids are snowflakes, unique
 * across the platform, so its identity must stay `(platform, messageId)`.
 */
const CHAT_SCOPED_PLATFORMS = new Set(["telegram"])

function isChatScopedPlatform(platform) {
  return CHAT_SCOPED_PLATFORMS.has(platform)
}

/**
 * The chat component of a mapping's identity, or `""` for "no scope".
 *
 * A record written before this fix, or by a legacy gateway that never reported a
 * chat, has no scope and keeps the pre-fix key byte for byte, so records already
 * on disk stay readable and such a gateway stays routable.
 */
function scopeOf(mapping) {
  if (!isChatScopedPlatform(mapping.platform)) return ""
  return typeof mapping.channelId === "string" ? mapping.channelId : ""
}

/**
 * The in-memory identity. The unscoped form is the pre-fix key unchanged; the
 * scoped form adds a marker segment, so the two key spaces can never collide even
 * for a message id that carries a NUL.
 */
function indexKey(platform, messageId, scope = "") {
  return scope.length === 0
    ? `${platform}\u0000${messageId}`
    : `${platform}\u0000\u0001${scope}\u0000${messageId}`
}

/** The durable identity: the hash of exactly the in-memory identity. */
function keyFor(platform, messageId, scope = "") {
  const hash = createHash("sha1").update(indexKey(platform, messageId, scope)).digest("hex")
  return `${OPENCLAW_REGISTRY_PREFIX}${hash}`
}

/**
 * Create the registry. `storage` is the V2 plugin storage domain; it may be
 * absent. `hydrate()` should be awaited once before the inbound poller starts so
 * mappings written by a previous process are visible.
 */
export function createOpenclawRegistry({ storage, maxAgeMs = OPENCLAW_REGISTRY_MAX_AGE_MS, now = () => Date.now(), log = () => {} } = {}) {
  const map = new Map()
  const canPersist = Boolean(storage && typeof storage.set === "function" && typeof storage.get === "function")
  const canScan = Boolean(storage && typeof storage.scan === "function")
  const canRemove = Boolean(storage && typeof storage.remove === "function")

  function isFresh(mapping) {
    const created = Date.parse(mapping.createdAt)
    return Number.isFinite(created) && now() - created <= maxAgeMs
  }

  function remember(mapping) {
    map.set(indexKey(mapping.platform, mapping.messageId, scopeOf(mapping)), mapping)
  }

  async function hydrate() {
    if (!canScan) return
    try {
      const page = await storage.scan({ prefix: OPENCLAW_REGISTRY_PREFIX })
      const entries = Array.isArray(page?.entries) ? page.entries : []
      for (const entry of entries) {
        const value = entry?.value
        if (!isValidMapping(value) || !isFresh(value)) continue
        remember(value)
      }
    } catch (error) {
      log(`[oh-my-rigel] Native V2 openclaw registry hydrate failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function register(mapping) {
    if (!isValidMapping(mapping)) {
      // The repository's public contract is a boolean, so an invalid mapping is
      // still refused silently; the one case worth a line is a chat component of
      // the wrong type, because a caller that ships one would otherwise write a
      // record that can never match the chat the poller reads. The class is named,
      // the value never is.
      if (isPlainObject(mapping) && mapping.channelId !== undefined && typeof mapping.channelId !== "string") {
        log("[oh-my-rigel] Native V2 openclaw registry refused a mapping whose channelId is not a string")
      }
      return false
    }
    const normalized = { ...mapping, platform: normalizePlatform(mapping.platform) }
    const scope = scopeOf(normalized)
    remember(normalized)
    if (canPersist) {
      try {
        await storage.set(keyFor(normalized.platform, normalized.messageId, scope), normalized)
      } catch (error) {
        log(`[oh-my-rigel] Native V2 openclaw registry persist failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return true
  }

  /**
   * Resolve one correlation. `channel` is the chat the caller is reading, required
   * for a chat-scoped platform; a scoped record for that exact chat wins, and the
   * unscoped (pre-fix or legacy) record is the fallback, so a chat-less record is
   * never silently lost.
   */
  function read(platform, messageId, scope) {
    const key = indexKey(platform, messageId, scope)
    const mapping = map.get(key)
    if (!mapping) return null
    if (!isFresh(mapping)) {
      map.delete(key)
      if (canRemove) void storage.remove(keyFor(platform, messageId, scope)).catch(() => {})
      return null
    }
    return mapping
  }

  function lookup(platform, messageId, channel) {
    if (typeof platform !== "string" || typeof messageId !== "string") return null
    if (typeof channel === "string" && channel.length > 0 && isChatScopedPlatform(platform)) {
      const scoped = read(platform, messageId, channel)
      if (scoped !== null) return scoped
    }
    return read(platform, messageId, "")
  }

  async function prune() {
    let removed = 0
    for (const [key, mapping] of [...map.entries()]) {
      if (isFresh(mapping)) continue
      map.delete(key)
      removed += 1
      if (canRemove) {
        try {
          await storage.remove(keyFor(mapping.platform, mapping.messageId, scopeOf(mapping)))
        } catch {
          // best effort; the in-memory entry is already gone
        }
      }
    }
    return removed
  }

  async function removeSession(sessionID) {
    if (typeof sessionID !== "string" || sessionID.length === 0) return 0
    let removed = 0
    for (const [key, mapping] of [...map.entries()]) {
      if (mapping.sessionID !== sessionID) continue
      map.delete(key)
      removed += 1
      if (canRemove) {
        try {
          await storage.remove(keyFor(mapping.platform, mapping.messageId, scopeOf(mapping)))
        } catch {
          // best effort
        }
      }
    }
    return removed
  }

  return {
    hydrate,
    register,
    lookup,
    prune,
    removeSession,
    list: () => [...map.values()],
    size: () => map.size,
  }
}
