/**
 * Native V2 OpenClaw AGENT correlation registry: the second key space next to
 * the chat one, without a byte of change to the chat one.
 *
 * The chat registry (`rigel-v2-native-openclaw-registry.mjs`) answers exactly
 * one question: which session published the outbound message a chat reply is
 * quoting? Its key is `(platform, messageId)` and its value carries no task
 * identity. That is right for a chat reply and useless for an agent peer: A2A
 * has no message to quote, it has a `taskId` inside a `(peer, contextId)`
 * conversation, and OpenClaw completes tasks FIFO per conversation
 * (`completeNext`) rather than by id
 * (`Contrato_Transportes_OpenClaw.md` §6.1, §6.2).
 *
 *   chat  `rigel-v2/openclaw/registry/<sha1(platform\0messageId)>`   unchanged
 *   agent `rigel-v2/openclaw/agent/<sha1(peer\0contextId\0taskId)>`  this module
 *
 * Three decisions here are load-bearing:
 *
 *   - The chat validator is NOT reused. `isValidMapping` demands `platform` and
 *     `messageId`, so using it for agent records would either reject every
 *     record or force those fields into the agent shape and break hydration of
 *     records a previous process wrote. This module carries its own validator.
 *   - The FIFO slot lives in the durable record (`inflight`), not in a
 *     process-local set. Two concurrent sends on one `contextId` would let
 *     `completeNext` complete the wrong task, so at most one send per
 *     `(peer, contextId)` may be in flight, across restarts.
 *   - A record that ages out before reaching a terminal state is reported as
 *     `lost` by `prune()` and never dropped in silence: an unobservable task has
 *     no listing endpoint to find it again (§6.4).
 */

import { createHash } from "node:crypto"

/** Storage prefix of the agent key space. Deliberately NOT the chat prefix. */
export const OPENCLAW_AGENT_REGISTRY_PREFIX = "rigel-v2/openclaw/agent/"
/** Hard prune horizon of an agent record, terminal or not (§6.4). */
export const OPENCLAW_AGENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** Schema version of an agent record. Records with another version are ignored. */
export const OPENCLAW_AGENT_MAPPING_VERSION = 2
/** States in which the task is still expected to reach a terminal answer. */
export const OPENCLAW_AGENT_PENDING_STATES = Object.freeze(["submitted", "working"])
/** Terminal states. `lost` is ours: the record survived, the task is unobservable. */
export const OPENCLAW_AGENT_TERMINAL_STATES = Object.freeze(["completed", "failed", "rejected", "lost", "shutdown-lost"])
/** Every state a record may carry. */
export const OPENCLAW_AGENT_STATES = Object.freeze([...OPENCLAW_AGENT_PENDING_STATES, ...OPENCLAW_AGENT_TERMINAL_STATES])
/** Prefix of a derived conversation id. */
export const OPENCLAW_CONTEXT_ID_PREFIX = "rigel-"
/**
 * Accepted `contextId` shape. `:` is deliberately excluded: it is legal in the
 * vendor pattern but is NOT escaped when OpenClaw builds its session key
 * (`agent:<agent>:a2a:<account>:direct:<peer>:<context>`), so a `:` in the
 * context would make any key split on `:` ambiguous (§7).
 */
export const OPENCLAW_CONTEXT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0
}

/**
 * Derive the conversation id from the session id.
 *
 * Deriving instead of storing removes the map, removes the risk of two sessions
 * sharing a conversation, and survives a restart with the same `sessionID`,
 * which is the continuity we want (§7). 24 hex chars keep it inside the vendor
 * pattern with room to spare.
 */
export function deriveOpenclawContextId(sessionID) {
  if (!isNonEmptyString(sessionID)) return null
  const digest = createHash("sha256").update(sessionID).digest("hex").slice(0, 24)
  return `${OPENCLAW_CONTEXT_ID_PREFIX}${digest}`
}

/** In-memory index key of a conversation. */
export function openclawConversationKey(peer, contextId) {
  return `${peer}\u0000${contextId}`
}

/** Storage key of one agent task. */
export function openclawAgentKey(peer, contextId, taskId) {
  const hash = createHash("sha1").update(`${peer}\u0000${contextId}\u0000${taskId}`).digest("hex")
  return `${OPENCLAW_AGENT_REGISTRY_PREFIX}${hash}`
}

/**
 * Validate an agent record. Separate from the chat validator on purpose: the two
 * shapes share nothing but the storage domain, and a shared validator would
 * couple a chat hydration bug to the agent path (§6.1).
 */
export function isValidAgentMapping(value) {
  if (!isPlainObject(value)) return false
  if (value.v !== OPENCLAW_AGENT_MAPPING_VERSION) return false
  if (value.kind !== "agent") return false
  if (!isNonEmptyString(value.peer)) return false
  if (!isNonEmptyString(value.agentId)) return false
  if (!isNonEmptyString(value.contextId)) return false
  if (!isNonEmptyString(value.taskId)) return false
  if (!isNonEmptyString(value.sessionID)) return false
  if (!OPENCLAW_AGENT_STATES.includes(value.state)) return false
  if (!Number.isInteger(value.attempts) || value.attempts < 0) return false
  if (typeof value.inflight !== "boolean") return false
  if (!isNonEmptyString(value.createdAt)) return false
  if (value.lastCheckedAt !== undefined && !isNonEmptyString(value.lastCheckedAt)) return false
  // The vendor ignores `message.taskId` and generates its own id when it answers,
  // so the record keeps the id Rigel correlates by and stores the vendor's id as
  // data. Without it `GetTask` cannot be called after a restart, and the task
  // would be unobservable.
  if (value.remoteTaskId !== undefined && !isNonEmptyString(value.remoteTaskId)) return false
  // A terminal task cannot still hold the conversation's single send slot.
  if (value.inflight && OPENCLAW_AGENT_TERMINAL_STATES.includes(value.state)) return false
  return true
}

/**
 * Resolve the new-namespace identity from a RAW `openclaw` block.
 *
 * `channels` is the new namespace (`Contrato_Transportes_OpenClaw.md` §5.2 names
 * `gateways.x` versus `channels.x`; §2.7 of the verified contracts places A2A at
 * `channels.a2a`). This reads the raw block on purpose: normalizing unknown keys
 * is U1's seam, and routing through `normalizeOpenclawConfig` here would drop
 * `channels` and make the new namespace unreachable.
 *
 * `declared` and `identities` report raw named entries, including malformed ones,
 * so diagnostics never erase a declaration. Chat composition consumes
 * `chatIdentities` instead: reserved `a2a` belongs to the agent key space and
 * cannot govern a chat poller. `a2aEnabled` follows the vendor rule that
 * `configured` means "at least one peer": an `a2a` block with `peers: {}`
 * starts nothing.
 */
export function resolveOpenclawAgentNamespace(rawConfig) {
  const channels = isPlainObject(rawConfig?.channels) ? rawConfig.channels : null
  if (channels === null) return { declared: false, identities: [], chatIdentities: [], a2aDeclared: false, peers: [], a2aEnabled: false }
  const identities = Object.keys(channels)
  const chatIdentities = identities.flatMap((identity) => {
    if (identity === "discord" || identity === "discord-bot") return ["discord-bot"]
    if (identity === "telegram") return ["telegram"]
    return []
  })
  const a2aDeclared = Object.hasOwn(channels, "a2a")
  const a2a = isPlainObject(channels.a2a) ? channels.a2a : null
  const peers = isPlainObject(a2a?.peers) ? Object.keys(a2a.peers).filter((name) => isPlainObject(a2a.peers[name])) : []
  return {
    declared: identities.length > 0,
    identities,
    chatIdentities,
    a2aDeclared,
    peers,
    a2aEnabled: Boolean(a2a && a2a.enabled === true && peers.length > 0),
  }
}

/**
 * Create the agent registry. `storage` is the V2 plugin storage domain and may be
 * absent: the in-process index still works, so a host without storage degrades
 * instead of throwing.
 *
 * `hydrate()` must be awaited once before anything claims a slot, so the
 * `inflight` flag written by a previous process is visible and the durable FIFO
 * rule survives a restart.
 */
export function createOpenclawAgentRegistry({ storage, maxAgeMs = OPENCLAW_AGENT_MAX_AGE_MS, now = () => Date.now(), log = () => {} } = {}) {
  const map = new Map()
  const occupied = new Map()
  const canPersist = Boolean(storage && typeof storage.set === "function")
  const canScan = Boolean(storage && typeof storage.scan === "function")
  const canRemove = Boolean(storage && typeof storage.remove === "function")

  function indexKey(peer, contextId, taskId) {
    return `${peer}\u0000${contextId}\u0000${taskId}`
  }

  function indexOf(record) {
    return indexKey(record.peer, record.contextId, record.taskId)
  }

  function remember(record, storageKey) {
    const entry = { record, storageKey }
    occupied.set(storageKey, entry)
    map.set(indexOf(record), entry)
    return entry
  }

  function restoreVisibleRecord(key) {
    let replacement = null
    for (const entry of occupied.values()) {
      if (indexOf(entry.record) === key) replacement = entry
    }
    if (replacement === null) map.delete(key)
    else map.set(key, replacement)
  }

  function forget(storageKey) {
    const entry = occupied.get(storageKey)
    if (!entry) return null
    occupied.delete(storageKey)
    const key = indexOf(entry.record)
    if (map.get(key) === entry) restoreVisibleRecord(key)
    return entry
  }

  function replaceVisible(key, record) {
    const entry = map.get(key)
    if (!entry) return null
    const replacement = { record, storageKey: entry.storageKey }
    occupied.set(replacement.storageKey, replacement)
    map.set(key, replacement)
    return replacement
  }

  function isFresh(record) {
    const created = Date.parse(record.createdAt)
    return Number.isFinite(created) && now() - created <= maxAgeMs
  }

  function recordsFor(peer, contextId) {
    const entries = []
    for (const { record } of map.values()) {
      if (record.peer !== peer || record.contextId !== contextId) continue
      entries.push(record)
    }
    return entries
  }

  async function persist(entry) {
    if (!canPersist) return
    try {
      await storage.set(entry.storageKey, entry.record)
    } catch (error) {
      log(`[oh-my-rigel] Native V2 openclaw agent registry persist failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function hydrate() {
    if (!canScan) return
    try {
      let after
      const seenTokens = new Set()
      for (;;) {
        const page = await storage.scan({
          prefix: OPENCLAW_AGENT_REGISTRY_PREFIX,
          ...(after === undefined ? {} : { after }),
        })
        if (typeof page !== "object" || page === null || Array.isArray(page) || !Array.isArray(page.entries)) {
          log("[oh-my-rigel] Native V2 openclaw agent registry hydrate stopped on a malformed storage page")
          return
        }
        for (const entry of page.entries) {
          const value = entry?.value
          if (!isPlainObject(value)) {
            log("[oh-my-rigel] Native V2 openclaw agent registry skipped a record with an invalid shape")
            continue
          }
          if (!Object.hasOwn(value, "v")) {
            log("[oh-my-rigel] Native V2 openclaw agent registry skipped a record with an invalid shape")
            continue
          }
          if (value.v !== OPENCLAW_AGENT_MAPPING_VERSION) {
            log("[oh-my-rigel] Native V2 openclaw agent registry skipped a record with an unknown version")
            continue
          }
          if (!isValidAgentMapping(value)) {
            log("[oh-my-rigel] Native V2 openclaw agent registry skipped a record with an invalid shape")
            continue
          }
          const storageKey = typeof entry?.key === "string" && entry.key.length > 0 ? entry.key : null
          if (storageKey === null) {
            log("[oh-my-rigel] Native V2 openclaw agent registry skipped a record whose durable key is not a non-empty string")
            continue
          }
          // Aged records stay in the index so `prune()` can report them as lost
          // instead of dropping them the moment they are read.
          remember({ ...value }, storageKey)
        }
        if (page.next === undefined || page.next === null) return
        if (typeof page.next !== "string" || page.next.length === 0) {
          log("[oh-my-rigel] Native V2 openclaw agent registry hydrate stopped on an invalid pagination token")
          return
        }
        if (seenTokens.has(page.next)) {
          log("[oh-my-rigel] Native V2 openclaw agent registry hydrate stopped on a repeated pagination token")
          return
        }
        seenTokens.add(page.next)
        after = page.next
      }
    } catch (error) {
      log(`[oh-my-rigel] Native V2 openclaw agent registry hydrate failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Write the record BEFORE the send it describes (write-ahead). A record that
   * exists without a send is reported as `lost`; a send without a record is the
   * orphan this whole key space exists to prevent.
   */
  async function register(seed) {
    if (!isPlainObject(seed)) return false
    const record = {
      v: OPENCLAW_AGENT_MAPPING_VERSION,
      kind: "agent",
      peer: seed.peer,
      agentId: seed.agentId,
      contextId: seed.contextId,
      taskId: seed.taskId,
      sessionID: seed.sessionID,
      state: seed.state ?? "submitted",
      attempts: Number.isInteger(seed.attempts) ? seed.attempts : 0,
      createdAt: seed.createdAt ?? new Date(now()).toISOString(),
      inflight: seed.inflight === true,
      // Omitted rather than undefined so a chat-shaped equality assertion on a
      // freshly registered record keeps its exact key set.
      ...(isNonEmptyString(seed.remoteTaskId) ? { remoteTaskId: seed.remoteTaskId } : {}),
    }
    if (!isValidAgentMapping(record)) return false
    const entry = remember(record, openclawAgentKey(record.peer, record.contextId, record.taskId))
    await persist(entry)
    return true
  }

  /** Look up one task. A stale record is hidden here and reported by `prune()`. */
  function lookup(peer, contextId, taskId) {
    if (!isNonEmptyString(peer) || !isNonEmptyString(contextId) || !isNonEmptyString(taskId)) return null
    const entry = map.get(indexKey(peer, contextId, taskId))
    const record = entry?.record
    if (!record || !isFresh(record)) return null
    return { ...record }
  }

  /** True when the conversation already holds its single in-flight send slot. */
  function hasInflight(peer, contextId) {
    return recordsFor(peer, contextId).some((record) => record.inflight)
  }

  /**
   * Sessions that own a conversation's durable records (§7).
   *
   * The responder's binding map is process-local, so it cannot answer "who owned
   * this conversation before the restart?"; the record can. A hydrated
   * conversation therefore stays bound to its session and a second session that
   * names the same `contextId` is refused instead of sharing the remote history.
   * Stale records are ignored, exactly like `lookup`, so an expired conversation
   * is claimable again.
   */
  function sessionOwners(peer, contextId) {
    if (!isNonEmptyString(peer) || !isNonEmptyString(contextId)) return []
    const owners = new Set()
    for (const record of recordsFor(peer, contextId)) {
      if (isFresh(record)) owners.add(record.sessionID)
    }
    return [...owners]
  }

  /**
   * The task OpenClaw's `completeNext` would complete: the OLDEST pending task of
   * the conversation that has NOT been sent yet. `null` while a send of that
   * conversation is in flight, which is exactly what keeps two sends from
   * overlapping.
   *
   * A record that already carries `remoteTaskId` was accepted by the vendor and is
   * waiting for `GetTask`, so it is not a send candidate: claiming it again would
   * create the second task this whole key space exists to prevent.
   */
  function nextPendingFor(peer, contextId) {
    if (hasInflight(peer, contextId)) return null
    const pending = recordsFor(peer, contextId)
      .filter((record) => isFresh(record) && OPENCLAW_AGENT_PENDING_STATES.includes(record.state))
      .filter((record) => record.remoteTaskId === undefined)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    return pending.length > 0 ? { ...pending[0] } : null
  }

  /** Take the conversation's send slot for one task. `null` when it is taken. */
  async function claim(peer, contextId, taskId) {
    if (!isNonEmptyString(peer) || !isNonEmptyString(contextId) || !isNonEmptyString(taskId)) return null
    const key = indexKey(peer, contextId, taskId)
    const record = map.get(key)?.record
    if (!record || !isFresh(record)) return null
    if (!OPENCLAW_AGENT_PENDING_STATES.includes(record.state)) return null
    if (record.inflight) return null
    if (hasInflight(peer, contextId)) return null
    const claimed = {
      ...record,
      inflight: true,
      attempts: record.attempts + 1,
      lastCheckedAt: new Date(now()).toISOString(),
    }
    await persist(replaceVisible(key, claimed))
    return { ...claimed }
  }

  /** Release the slot without settling the task: it stays pending for a retry of the CHECK, never of the send. */
  async function release(peer, contextId, taskId) {
    if (!isNonEmptyString(peer) || !isNonEmptyString(contextId) || !isNonEmptyString(taskId)) return null
    const key = indexKey(peer, contextId, taskId)
    const record = map.get(key)?.record
    if (!record) return null
    if (!OPENCLAW_AGENT_PENDING_STATES.includes(record.state)) return null
    const released = { ...record, inflight: false, lastCheckedAt: new Date(now()).toISOString() }
    await persist(replaceVisible(key, released))
    return { ...released }
  }

  /**
   * Record the vendor's task id on a record that was written ahead.
   *
   * The vendor ignores `message.taskId` and generates its own id, so the id
   * `GetTask` accepts is only known from the answer. Persisting it is what makes
   * a task observable after a restart; a record that dies without it can never be
   * reconciled, and `prune()`/`reconcile` report that as `lost`.
   */
  async function attachRemoteTask(peer, contextId, taskId, remoteTaskId) {
    if (!isNonEmptyString(remoteTaskId)) return null
    if (!isNonEmptyString(peer) || !isNonEmptyString(contextId) || !isNonEmptyString(taskId)) return null
    const key = indexKey(peer, contextId, taskId)
    const record = map.get(key)?.record
    if (!record) return null
    const attached = { ...record, remoteTaskId, lastCheckedAt: new Date(now()).toISOString() }
    await persist(replaceVisible(key, attached))
    return { ...attached }
  }

  /** Stamp a reconciliation check. The task state is untouched: only the clock moves. */
  async function touch(peer, contextId, taskId) {
    if (!isNonEmptyString(peer) || !isNonEmptyString(contextId) || !isNonEmptyString(taskId)) return null
    const key = indexKey(peer, contextId, taskId)
    const record = map.get(key)?.record
    if (!record) return null
    if (!OPENCLAW_AGENT_PENDING_STATES.includes(record.state)) return null
    const touched = { ...record, lastCheckedAt: new Date(now()).toISOString() }
    await persist(replaceVisible(key, touched))
    return { ...touched }
  }

  /** Move a task to a terminal state and free the slot. */
  async function settle(peer, contextId, taskId, state) {
    if (!OPENCLAW_AGENT_TERMINAL_STATES.includes(state)) return null
    if (!isNonEmptyString(peer) || !isNonEmptyString(contextId) || !isNonEmptyString(taskId)) return null
    const key = indexKey(peer, contextId, taskId)
    const record = map.get(key)?.record
    if (!record) return null
    if (OPENCLAW_AGENT_TERMINAL_STATES.includes(record.state)) return { ...record }
    const settled = { ...record, state, inflight: false, lastCheckedAt: new Date(now()).toISOString() }
    await persist(replaceVisible(key, settled))
    return { ...settled }
  }

  /** Report a task as unobservable. Never a silent drop. */
  async function markLost(peer, contextId, taskId) {
    return settle(peer, contextId, taskId, "lost")
  }

  /** Record a deadline-bounded graceful shutdown that could not drain a send. */
  async function markShutdownLost(peer, contextId, taskId) {
    return settle(peer, contextId, taskId, "shutdown-lost")
  }

  /**
   * Remove a deleted session's records. `session.deleted` keeps delete-only
   * semantics; it never correlates a reply (§6.3).
   */
  async function removeSession(sessionID) {
    if (!isNonEmptyString(sessionID)) return 0
    let removed = 0
    for (const [storageKey, { record }] of [...occupied.entries()]) {
      if (record.sessionID !== sessionID) continue
      forget(storageKey)
      removed += 1
      if (canRemove) {
        try {
          await storage.remove(storageKey)
        } catch (error) {
          log(`[oh-my-rigel] Native V2 openclaw agent registry remove failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    return removed
  }

  /**
   * Drop records past the hard horizon. A record that ages out while still
   * pending never reached its answer, so it is returned as `lost` and logged
   * once; a terminal record is simply removed.
   */
  async function prune() {
    const lost = []
    let removed = 0
    for (const [storageKey, { record }] of [...occupied.entries()]) {
      if (isFresh(record)) continue
      forget(storageKey)
      removed += 1
      const unresolved = OPENCLAW_AGENT_PENDING_STATES.includes(record.state)
      const reported = unresolved ? { ...record, state: "lost", inflight: false } : { ...record }
      if (unresolved) {
        lost.push(reported)
        log(`[oh-my-rigel] openclaw agent task lost: peer=${record.peer} task=${record.taskId} state=${record.state}`)
      }
      if (canRemove) {
        try {
          await storage.remove(storageKey)
        } catch (error) {
          log(`[oh-my-rigel] Native V2 openclaw agent registry prune remove failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    return { removed, lost }
  }

  function pendingCount(peer, contextId) {
    return recordsFor(peer, contextId)
      .filter((record) => isFresh(record) && OPENCLAW_AGENT_PENDING_STATES.includes(record.state)).length
  }

  function inflightCount() {
    let count = 0
    for (const { record } of map.values()) if (record.inflight) count += 1
    return count
  }

  return {
    hydrate,
    register,
    lookup,
    claim,
    release,
    touch,
    attachRemoteTask,
    settle,
    markLost,
    markShutdownLost,
    removeSession,
    prune,
    nextPendingFor,
    hasInflight,
    sessionOwners,
    pendingCount,
    inflightCount,
    list: () => [...map.values()].map(({ record }) => ({ ...record })),
    size: () => map.size,
  }
}
