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
 * Every removal deletes the storage key a record REALLY occupies, never a key
 * derived from the record's value. Those are not always the same key: the chat
 * identity changed after records existed on disk, so a record written by the
 * pre-fix writer holds `sha1(platform\0 messageId)` while its value already names
 * a chat. Re-deriving on removal deleted a key that never existed, the durable
 * record survived, and the next process re-indexed the correlation of a session
 * the user had already deleted. The scanned key is therefore carried WITH the
 * record (the durable half below), and hydrate never rewrites it.
 *
 * One storage key holds one identity, and a write never changes which identity a
 * key holds. A chat-scoped record and a chat-less record of the same
 * `(platform, messageId)` are TWO identities that coexist: the scoped one answers
 * `lookup(platform, messageId, chat)`, the unscoped one is the pre-fix/legacy
 * identity that a scoped lookup falls back to. The chat-less identity keeps the
 * pre-fix key while that slot is free (byte compatibility with the previous
 * build); when the slot already holds another identity, the write moves to a
 * displaced key that no identity can derive, so neither record is overwritten.
 * Every removal still deletes the key a record really occupies, which is what
 * keeps `removeSession()` and `prune()` correct for both halves.
 *
 * The registry keeps two halves. `durable` is every record this process wrote or
 * scanned, under its real storage key; `index` is one live winner per identity,
 * fresh only, which is what `lookup`, `size()` and `list()` answer from. When the
 * host exposes no storage domain (a unit fixture or a degraded host) both halves
 * still work in memory, so the surface degrades instead of throwing.
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
 * The key a write falls back to when the identity's own slot already holds a
 * record of ANOTHER identity.
 *
 * Domain-separated from every identity key: `keyFor` hashes an identity that
 * always starts with `<platform>\0`, and this hashes one that starts with a
 * marker no platform can be, so a displaced key can never equal the key another
 * identity derives. The attempt segment keeps the derivation deterministic, so a
 * repeated write of one identity reuses its displaced key instead of piling up
 * new ones.
 */
function displacedKeyFor(identity, attempt) {
  const hash = createHash("sha1").update(`\u0002displaced\u0000${attempt}\u0000${identity}`).digest("hex")
  return `${OPENCLAW_REGISTRY_PREFIX}${hash}`
}

/**
 * Candidate keys a write may try before giving up. A hydrated store never spends
 * the budget (its own records are outnumbered by the candidates); the floor only
 * matters when storage holds shapes this process has not seen.
 */
const DISPLACED_KEY_ATTEMPTS = 8

/**
 * Create the registry. `storage` is the V2 plugin storage domain; it may be
 * absent. `hydrate()` should be awaited once before the inbound poller starts so
 * mappings written by a previous process are visible.
 */
export function createOpenclawRegistry({ storage, maxAgeMs = OPENCLAW_REGISTRY_MAX_AGE_MS, now = () => Date.now(), log = () => {} } = {}) {
  // Every record this process wrote or scanned, under the storage key it really
  // occupies. This is the durable half: removal deletes these keys verbatim.
  const durable = new Map()
  // One live winner per identity, fresh only. Never a source of storage keys.
  const index = new Map()
  const canPersist = Boolean(storage && typeof storage.set === "function" && typeof storage.get === "function")
  const canRead = Boolean(storage && typeof storage.get === "function")
  const canScan = Boolean(storage && typeof storage.scan === "function")
  const canRemove = Boolean(storage && typeof storage.remove === "function")
  // The displaced-key notice is a state of the store, not of a message: one line
  // per process keeps a chat-less gateway from flooding the log every delivery.
  let loggedDisplaced = false

  function isFresh(mapping) {
    const created = Date.parse(mapping.createdAt)
    return Number.isFinite(created) && now() - created <= maxAgeMs
  }

  function identityOf(mapping) {
    return indexKey(mapping.platform, mapping.messageId, scopeOf(mapping))
  }

  /** True when `mapping` cannot occupy `storageKey` without changing its identity. */
  function displaces(storageKey, mapping) {
    const occupant = durable.get(storageKey)
    return occupant !== undefined && identityOf(occupant) !== identityOf(mapping)
  }

  /**
   * Whether `storageKey` may hold `identity`.
   *
   * A key this process knows is usable only when it already holds the SAME
   * identity (a legitimate rewrite of one correlation); a key that holds ANOTHER
   * identity is never overwritten, because the index of that identity points at
   * it and replacing the value would resolve its readers to a different session
   * (finding B3).
   *
   * A key this process has not seen is asked of storage, so a write that lands
   * before `hydrate()` (or after a hydrate that failed) still cannot overwrite the
   * record really stored there. An unreadable value or a failed read is treated as
   * occupied: allocating a displaced key is harmless, overwriting a record is not.
   */
  async function mayUseKey(storageKey, identity) {
    const known = durable.get(storageKey)
    if (known !== undefined) return identityOf(known) === identity
    if (!canRead) return true
    try {
      const stored = await storage.get(storageKey)
      if (stored === undefined || stored === null) return true
      if (!isValidMapping(stored)) return false
      return identityOf(stored) === identity
    } catch (error) {
      log(`[oh-my-rigel] Native V2 openclaw registry could not read a candidate storage key: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * The key a write may use for `identity`.
   *
   * The identity's own key is preferred and accepted when it is free or already
   * holds the same identity; otherwise the write moves to a domain-separated
   * displaced key. The attempt budget is `max(8, durable.size + 1)`: the records
   * this process knows are always outnumbered by the candidates, so a hydrated
   * store never spends the budget. `null` therefore means "a store full of shapes
   * this build cannot represent", and `register()` fails closed instead of
   * overwriting one of them.
   */
  async function allocateStorageKey(identity, ownKey) {
    const attempts = Math.max(DISPLACED_KEY_ATTEMPTS, durable.size + 1)
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const candidate = attempt === 0 ? ownKey : displacedKeyFor(identity, attempt)
      if (await mayUseKey(candidate, identity)) return candidate
    }
    return null
  }

  /**
   * Record one mapping under the key that holds it.
   *
   * One key, one identity: a write that would change which identity a key
   * represents is REFUSED (returns false), because the index of the identity
   * already mapped there would then answer with a different session.
   *
   * `newestWins` is the hydration rule: two durable records can describe one
   * identity across the identity change (the older pre-fix half was never cleaned
   * up), and the answer a reader must get is the newest one, not whichever half
   * the scan happened to return last. `register()` is the opposite case - a write
   * that just happened is the truth - so it wins unconditionally.
   */
  function remember(mapping, storageKey, { newestWins = false } = {}) {
    if (displaces(storageKey, mapping)) return false
    durable.set(storageKey, mapping)
    const identity = identityOf(mapping)
    const currentKey = index.get(identity)
    if (newestWins && currentKey !== undefined) {
      const current = durable.get(currentKey)
      if (current !== undefined && Date.parse(current.createdAt) >= Date.parse(mapping.createdAt)) return true
    }
    index.set(identity, storageKey)
    return true
  }

  /** Forget one durable key and unindex it only if it was still the winner. */
  function forget(storageKey) {
    const mapping = durable.get(storageKey)
    durable.delete(storageKey)
    if (mapping === undefined) return null
    const identity = identityOf(mapping)
    if (index.get(identity) === storageKey) index.delete(identity)
    return mapping
  }

  /** Best-effort durable delete of an exact key. Never re-derives one. */
  function removeDurable(storageKey) {
    if (!canRemove) return
    try {
      void Promise.resolve(storage.remove(storageKey)).catch(() => {})
    } catch {
      // best effort: the in-memory halves are already consistent
    }
  }

  async function hydrate() {
    if (!canScan) return
    try {
      const page = await storage.scan({ prefix: OPENCLAW_REGISTRY_PREFIX })
      const entries = Array.isArray(page?.entries) ? page.entries : []
      let declined = 0
      for (const entry of entries) {
        const value = entry?.value
        if (!isValidMapping(value)) continue
        // A record with no readable storage key cannot be removed later without
        // inventing a key, and inventing one is exactly the defect this hydration
        // repairs. Fail closed: do not index what cannot be deleted.
        const storageKey = typeof entry?.key === "string" && entry.key.length > 0 ? entry.key : null
        if (storageKey === null) {
          log("[oh-my-rigel] Native V2 openclaw registry skipped a record whose storage key is not a string")
          continue
        }
        if (!isFresh(value)) {
          // Aged records stay in the durable half so `prune()` deletes the key
          // they really occupy instead of leaving it in storage forever. A record
          // that would change the identity of a key this process already knows is
          // kept out of the durable half; the existing record stays intact.
          if (displaces(storageKey, value)) {
            declined += 1
            continue
          }
          durable.set(storageKey, value)
          continue
        }
        if (!remember(value, storageKey, { newestWins: true })) declined += 1
      }
      if (declined > 0) {
        log("[oh-my-rigel] Native V2 openclaw registry kept the identity a storage key already represents and ignored the record that would replace it")
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
    const identity = identityOf(normalized)
    // The write is the newest truth for this identity, and it names the key it
    // occupies, so the durable half never has to re-derive one later. The key is
    // allocated, not assumed: a slot that already represents another identity is
    // left alone and the write moves to a displaced key, so neither record is
    // overwritten and every index entry keeps pointing at its own identity.
    const ownKey = keyFor(normalized.platform, normalized.messageId, scopeOf(normalized))
    const storageKey = await allocateStorageKey(identity, ownKey)
    if (storageKey === null) {
      log("[oh-my-rigel] Native V2 openclaw registry refused a mapping because every candidate storage key is held by another identity")
      return false
    }
    if (!remember(normalized, storageKey)) {
      log("[oh-my-rigel] Native V2 openclaw registry refused a mapping that would replace the identity its storage key already represents")
      return false
    }
    if (storageKey !== ownKey && !loggedDisplaced) {
      loggedDisplaced = true
      log("[oh-my-rigel] Native V2 openclaw registry stored a mapping under a displaced key because its own key holds another identity")
    }
    if (canPersist) {
      try {
        await storage.set(storageKey, normalized)
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
    const identity = indexKey(platform, messageId, scope)
    const storageKey = index.get(identity)
    if (storageKey === undefined) return null
    const mapping = durable.get(storageKey)
    if (mapping === undefined) {
      index.delete(identity)
      return null
    }
    if (!isFresh(mapping)) {
      forget(storageKey)
      removeDurable(storageKey)
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
    for (const [storageKey, mapping] of [...durable.entries()]) {
      if (isFresh(mapping)) continue
      forget(storageKey)
      removed += 1
      if (canRemove) {
        try {
          await storage.remove(storageKey)
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
    // Per durable record, not per identity: two records can describe one
    // identity, and deleting one session must not silence the other.
    for (const [storageKey, mapping] of [...durable.entries()]) {
      if (mapping.sessionID !== sessionID) continue
      forget(storageKey)
      removed += 1
      if (canRemove) {
        try {
          await storage.remove(storageKey)
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
    // The live winners, one mapping per identity: a record known only as a
    // shadow of another (or a stale one waiting for `prune`) is not listed.
    list: () => [...index.values()]
      .map((storageKey) => durable.get(storageKey))
      .filter((mapping) => mapping !== undefined),
    size: () => index.size,
  }
}
