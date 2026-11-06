/**
 * Native V2 OpenClaw agent queue: the bounded structure the conversational path
 * must cross, so a single 120 s `SendMessage` can never head-of-line block the
 * plugin's ONE shared `ctx.event.subscribe` iterable
 * (`Contrato_Transportes_OpenClaw.md` §3, §10).
 *
 * The queue is structure plus limits, not a sender. It owns:
 *
 *   - one in-flight send per `(peer, contextId)`, enforced through the DURABLE
 *     `inflight` slot of the agent registry, because OpenClaw completes the
 *     oldest pending task of a conversation (`completeNext`) and two overlapping
 *     sends would complete the wrong one (§6.2);
 *   - a bounded per-conversation depth and a bounded total depth, so a peer that
 *     never answers cannot grow the process;
 *   - a 64 KiB payload cap, truncated at a code-point boundary (§10);
 *   - 30 requests per minute per peer, with NO retry: a rate-limited send is
 *     reported and dropped, because a blind retry creates a second task the
 *     server does not deduplicate (§1);
 *   - one entry per `taskId`, because `(peer, contextId, taskId)` IS the
 *     correlation key: enqueuing it twice would produce a second task with no
 *     second record, which is the duplicate the contract forbids.
 *
 * Reporting follows §9.3: a bound that rejects is a `degraded` transition and is
 * reported through the status document; a rate limit is not. Truncation is only
 * an aggregate counter, never a line.
 */

import { OPENCLAW_AGENT_TERMINAL_STATES } from "./rigel-v2-native-openclaw-agent-registry.mjs"

/** Default depth of one conversation. Chosen bound; the contract fixes only the single in-flight slot. */
export const OPENCLAW_QUEUE_MAX_PER_CONVERSATION = 8
/** Default depth of the whole queue across conversations. */
export const OPENCLAW_QUEUE_MAX_PENDING = 64
/** Payload cap per message, per §10 (64 KiB). */
export const OPENCLAW_QUEUE_MAX_PAYLOAD_BYTES = 64 * 1024
/** Requests per minute per peer, per §10. */
export const OPENCLAW_QUEUE_RATE_LIMIT_PER_MINUTE = 30
/** Client-side wait before a claim is considered expired, per §10. */
export const OPENCLAW_QUEUE_REPLY_TIMEOUT_MS = 120_000
/** Status-document surface this queue reports under. */
export const OPENCLAW_QUEUE_STATUS_SURFACE = "agent-queue"

const RATE_WINDOW_MS = 60_000

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0
}

/**
 * Truncate to a byte budget without splitting a code point. A half-written UTF-8
 * sequence would be a corrupted prompt, not a shorter one.
 */
export function truncateToBytes(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false }
  let bytes = 0
  let output = ""
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8")
    if (bytes + size > maxBytes) break
    bytes += size
    output += character
  }
  return { text: output, truncated: true }
}

/**
 * Create the bounded queue over an agent registry.
 *
 * @param {object} [options]
 * @param {object} options.registry the agent registry (`register/claim/release/settle/markLost/nextPendingFor`)
 * @param {object} [options.status] status document (`recordFailure/recordSuccess/recordTruncation/recordRateLimit`)
 * @param {number} [options.maxPerConversation]
 * @param {number} [options.maxPending]
 * @param {number} [options.maxPayloadBytes]
 * @param {number} [options.rateLimitPerMinute]
 * @param {number} [options.replyTimeoutMs]
 * @param {() => number} [options.now]
 * @param {(line: string) => void} [options.log]
 */
export function createOpenclawAgentQueue({
  registry,
  status,
  maxPerConversation = OPENCLAW_QUEUE_MAX_PER_CONVERSATION,
  maxPending = OPENCLAW_QUEUE_MAX_PENDING,
  maxPayloadBytes = OPENCLAW_QUEUE_MAX_PAYLOAD_BYTES,
  rateLimitPerMinute = OPENCLAW_QUEUE_RATE_LIMIT_PER_MINUTE,
  replyTimeoutMs = OPENCLAW_QUEUE_REPLY_TIMEOUT_MS,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  /** conversation key -> pending entries, oldest first. */
  const pending = new Map()
  /** peer -> send timestamps inside the sliding window. */
  const peerWindows = new Map()
  /** Full agent identity currently awaiting durable registration. */
  const registering = new Set()
  let accepting = true

  function conversationKey(peer, contextId) {
    return `${peer}\u0000${contextId}`
  }

  function taskKey(peer, contextId, taskId) {
    return `${peer}\u0000${contextId}\u0000${taskId}`
  }

  function entriesFor(peer, contextId) {
    return pending.get(conversationKey(peer, contextId)) ?? []
  }

  function pendingTotal() {
    let total = 0
    for (const entries of pending.values()) total += entries.length
    return total
  }

  function rateLimitReached(peer) {
    const window = peerWindows.get(peer) ?? []
    const current = now()
    const live = window.filter((stamp) => current - stamp <= RATE_WINDOW_MS)
    peerWindows.set(peer, live)
    if (live.length >= rateLimitPerMinute) return true
    live.push(current)
    return false
  }

  /**
   * Enqueue one conversational send. Reserve the payload synchronously before
   * registering its durable write-ahead record, so capacity and the payload stay
   * visible through every await. A task stays unclaimable while registration is
   * in progress; after the record is durable it can be claimed, and a crash after
   * that point is the genuinely ambiguous write-ahead loss the registry reports.
   *
   * Every rejection is named. A bound never drops a message in silence.
   */
  async function enqueue({ peer, contextId, taskId, sessionID, agentId, text } = {}) {
    if (!registry || typeof registry.register !== "function") return { accepted: false, reason: "no-registry" }
    if (!accepting) return { accepted: false, reason: "shutting-down" }
    if (!isNonEmptyString(peer) || !isNonEmptyString(contextId) || !isNonEmptyString(taskId)) {
      return { accepted: false, reason: "invalid-identity" }
    }
    if (!isNonEmptyString(sessionID) || !isNonEmptyString(agentId) || !isNonEmptyString(text)) {
      return { accepted: false, reason: "invalid-payload" }
    }
    const known = Boolean(registry.lookup?.(peer, contextId, taskId))
      || entriesFor(peer, contextId).some((entry) => entry.taskId === taskId)
    if (known) {
      await status?.recordFailure?.(OPENCLAW_QUEUE_STATUS_SURFACE, { errorClass: "duplicate-task" })
      return { accepted: false, reason: "duplicate-task" }
    }
    if (entriesFor(peer, contextId).length >= maxPerConversation) {
      await status?.recordFailure?.(OPENCLAW_QUEUE_STATUS_SURFACE, { errorClass: "conversation-full" })
      return { accepted: false, reason: "conversation-full" }
    }
    if (pendingTotal() >= maxPending) {
      await status?.recordFailure?.(OPENCLAW_QUEUE_STATUS_SURFACE, { errorClass: "queue-full" })
      return { accepted: false, reason: "queue-full" }
    }
    if (rateLimitReached(peer)) {
      // §9.3: a rate limit is jitter, not a state change. Counter only.
      await status?.recordRateLimit?.(OPENCLAW_QUEUE_STATUS_SURFACE)
      return { accepted: false, reason: "rate-limited" }
    }

    const { text: bounded, truncated } = truncateToBytes(text, maxPayloadBytes)
    const key = conversationKey(peer, contextId)
    const entries = pending.get(key) ?? []
    const entry = { taskId, text: bounded, bytes: Buffer.byteLength(bounded, "utf8"), enqueuedAt: now() }
    entries.push(entry)
    pending.set(key, entries)
    const registrationKey = taskKey(peer, contextId, taskId)
    registering.add(registrationKey)

    if (truncated) await status?.recordTruncation?.(OPENCLAW_QUEUE_STATUS_SURFACE)
    let registered
    try {
      registered = await registry.register({ peer, contextId, taskId, sessionID, agentId, state: "submitted" })
    } catch (error) {
      dropEntry(peer, contextId, taskId)
      throw error
    } finally {
      registering.delete(registrationKey)
    }
    if (!registered) {
      dropEntry(peer, contextId, taskId)
      return { accepted: false, reason: "invalid-record" }
    }
    await status?.recordSuccess?.(OPENCLAW_QUEUE_STATUS_SURFACE)
    return { accepted: true, taskId, bytes: entry.bytes, truncated }
  }

  /**
   * Claim the conversation's next send, or `null` while one is in flight.
   *
   * A durable record with no local payload means the process died between the
   * write-ahead and the send: its text is unrecoverable, so the task is marked
   * `lost` and the next one is considered. It is never discarded in silence.
   */
  async function claimNext(peer, contextId) {
    if (!registry || typeof registry.nextPendingFor !== "function") return null
    for (;;) {
      const next = registry.nextPendingFor(peer, contextId)
      if (!next) return null
      const registrationKey = taskKey(peer, contextId, next.taskId)
      if (registering.has(registrationKey)) return null
      const entries = entriesFor(peer, contextId)
      const index = entries.findIndex((entry) => entry.taskId === next.taskId)
      if (index < 0) {
        // Only a real transition is a loss: a record that settled between the
        // snapshot and this call keeps its terminal outcome and is not reported.
        const reported = await registry.markLost?.(peer, contextId, next.taskId)
        if (reported?.changed === true) {
          log(`[oh-my-rigel] openclaw agent task lost before send: peer=${peer} task=${next.taskId}`)
        }
        continue
      }
      const claimed = await registry.claim(peer, contextId, next.taskId)
      if (!claimed) return null
      const entry = entries[index]
      const claimedAt = now()
      return {
        taskId: claimed.taskId,
        text: entry.text,
        bytes: entry.bytes,
        attempts: claimed.attempts,
        claimedAt,
        deadlineAt: claimedAt + replyTimeoutMs,
      }
    }
  }

  /** A claim whose client-side wait ran out. The task itself stays in OpenClaw. */
  function isExpired(claim) {
    return Boolean(claim) && now() >= claim.deadlineAt
  }

  /**
   * Settle a claimed task in a terminal state and drop its payload.
   *
   * Returns whether the record actually changed. A record that is already
   * terminal keeps its first outcome, so this answers `false` there instead of
   * reporting a settlement that never happened.
   */
  async function settle({ peer, contextId, taskId, state } = {}) {
    if (!OPENCLAW_AGENT_TERMINAL_STATES.includes(state)) return false
    if (!isNonEmptyString(peer) || !isNonEmptyString(contextId) || !isNonEmptyString(taskId)) return false
    dropEntry(peer, contextId, taskId)
    const settled = await registry.settle?.(peer, contextId, taskId, state)
    return settled?.changed === true
  }

  /** Free the slot without settling: the task is still pending, the send is not retried. */
  async function release({ peer, contextId, taskId } = {}) {
    if (!isNonEmptyString(peer) || !isNonEmptyString(contextId) || !isNonEmptyString(taskId)) return false
    const released = await registry.release?.(peer, contextId, taskId)
    return Boolean(released)
  }

  /** Report an unobservable task and drop its payload. `true` only on a real transition. */
  async function markLost({ peer, contextId, taskId } = {}) {
    if (!isNonEmptyString(peer) || !isNonEmptyString(contextId) || !isNonEmptyString(taskId)) return false
    dropEntry(peer, contextId, taskId)
    const lost = await registry.markLost?.(peer, contextId, taskId)
    return lost?.changed === true
  }

  /** Record the distinct terminal outcome for work a graceful shutdown could not drain. */
  async function markShutdownLost({ peer, contextId, taskId } = {}) {
    if (!isNonEmptyString(peer) || !isNonEmptyString(contextId) || !isNonEmptyString(taskId)) return false
    dropEntry(peer, contextId, taskId)
    const lost = await registry.markShutdownLost?.(peer, contextId, taskId)
    return lost?.changed === true
  }

  function closeAdmissions() {
    accepting = false
  }

  function dropEntry(peer, contextId, taskId) {
    const key = conversationKey(peer, contextId)
    const entries = pending.get(key)
    if (!entries) return
    const next = entries.filter((entry) => entry.taskId !== taskId)
    if (next.length === 0) pending.delete(key)
    else pending.set(key, next)
  }

  function clearAll() {
    pending.clear()
    peerWindows.clear()
    registering.clear()
  }

  /**
   * Whether the process still holds the payload of one task.
   *
   * A durable record with no local payload and no `remoteTaskId` is unrecoverable:
   * the text is gone and there is no vendor id to ask about. The responder uses
   * this to report such a record as `lost` exactly once instead of waiting for a
   * send that can never happen.
   */
  function hasPayload(peer, contextId, taskId) {
    return entriesFor(peer, contextId).some((entry) => entry.taskId === taskId)
  }

  return {
    enqueue,
    claimNext,
    isExpired,
    settle,
    release,
    markLost,
    markShutdownLost,
    hasPayload,
    pendingFor: (peer, contextId) => entriesFor(peer, contextId).length,
    pendingTotal,
    replyTimeoutMs: () => replyTimeoutMs,
    closeAdmissions,
    clearAll,
  }
}
