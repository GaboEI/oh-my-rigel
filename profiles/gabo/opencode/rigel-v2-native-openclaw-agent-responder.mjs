/**
 * Native V2 OpenClaw agent responder: the conversational path's reconciliation
 * half (`Contrato_Transportes_OpenClaw.md` §2, §6, §7).
 *
 * Chat and agent ingress are deliberately NOT unified behind one "reply source"
 * interface. A chat reply is found by sweeping a cursor; an A2A answer is found by
 * asking `GetTask` about a `taskId` the runtime already knows, because the vendor
 * offers no listing and no streaming. One honest implementation per branch is not
 * an abstraction, it is ceremony.
 *
 * What the two branches DO share is the injection chokepoint: the same
 * `deliverInboundReply({ sessionID, text })` gate with the same pinned call shape,
 * and a different prefix (`[agent:<peer>] `, never `[reply:discord] `, which would
 * make the transcript ambiguous and fight the pinned prefix test).
 *
 * The five invariants this module exists to hold:
 *
 *   - **Write-ahead.** The durable record is written BEFORE the request (the
 *     bounded queue does the write through the agent registry). A request without
 *     a record is an orphan no endpoint can find again.
 *   - **One send in flight per `(peer, contextId)`.** OpenClaw completes the
 *     OLDEST pending task of a conversation (`completeNext`), so two overlapping
 *     sends complete the wrong one. The slot is durable, so a restart does not
 *     reopen the race.
 *   - **`status.state` is the only truth.** A `REJECTED` task arrives as a
 *     JSON-RPC success and is reported as a rejection, never injected and never
 *     counted as an answer.
 *   - **Injection uses `record.sessionID`, only.** Nothing derived from a
 *     response payload can move an answer into another session, and `contextId` is
 *     a pure function of `sessionID`, so a task cannot resolve to a second session.
 *   - **Never a silent drop.** A record the runtime cannot observe is reported as
 *     `lost`; a refusal is reported as a refusal; a bound that rejects is a
 *     `degraded` transition.
 *
 * Nothing here is awaited by the composition's event path: the shared
 * `ctx.event.subscribe` iterable must never wait on a `SendMessage` that may take
 * `replyTimeoutMs` (§3, §10).
 *
 * Only Node built-ins and sibling native modules are imported so the flat
 * laboratory runtime (no `node_modules`) can load this module.
 */
import { randomUUID } from "node:crypto"
import {
  OPENCLAW_AGENT_PENDING_STATES,
  OPENCLAW_CONTEXT_ID_PATTERN,
  deriveOpenclawContextId,
  openclawConversationKey,
} from "./rigel-v2-native-openclaw-agent-registry.mjs"
import {
  OPENCLAW_QUEUE_MAX_PER_CONVERSATION,
  truncateToBytes,
} from "./rigel-v2-native-openclaw-agent-queue.mjs"
import {
  OPENCLAW_AGENT_STATUS_SURFACE,
  OPENCLAW_A2A_REQUESTS_PER_MINUTE,
} from "./rigel-v2-native-openclaw-agent-transport.mjs"

/** Surface the injection gate reports under. Separate from the transport surface. */
export const OPENCLAW_AGENT_REPLY_SURFACE = "agent-reply"

/** Reconciliation cadence. Bounded per record, so one conversation cannot spam a peer. */
export const OPENCLAW_AGENT_RECONCILE_INTERVAL_MS = 5_000

/** Answer cap, the same 64 KiB the vendor applies to a message (§10). */
export const OPENCLAW_AGENT_MAX_REPLY_BYTES = 64 * 1024

/** Sliding window of the per-peer request budget. */
const REQUEST_WINDOW_MS = 60_000

/** Agent id recorded on every task when the caller does not name one. */
export const OPENCLAW_AGENT_DEFAULT_AGENT_ID = "rigel"

/**
 * Prefix of an injected agent answer (§2). The chat prefix is pinned and must not
 * be reused: an operator reading a transcript has to be able to tell a Discord
 * reply from an agent answer.
 */
export function agentReplyPrefix(peerName) {
  return `[agent:${peerName}] `
}

/**
 * Create the agent responder over an existing agent core (registry, bounded queue,
 * status document) and the A2A transport.
 *
 * @param {object} [options]
 * @param {Array<object>} [options.peers] resolved peers (`resolveOpenclawAgentPeers`)
 * @param {object} options.registry agent registry (`lookup/attachRemoteTask/touch/list`)
 * @param {object} options.queue bounded queue (`enqueue/claimNext/settle/markLost/hasPayload`)
 * @param {object} options.transport A2A client (`send/getTask/isDefinitiveSendFailure`)
 * @param {object} [options.status] status document (`recordFailure/recordSuccess/...`)
 * @param {(input: { sessionID: string, text: string }) => Promise<boolean>} [options.deliverAgentReply]
 *   the SAME internal-prompt gate the chat responder uses
 * @param {number} [options.pollIntervalMs] reconciliation cadence and per-record throttle
 * @param {number} [options.maxReplyBytes]
 * @param {() => number} [options.now]
 * @param {(line: string) => void} [options.log]
 * @param {() => string} [options.generateTaskId]
 * @param {{ setInterval: Function, clearInterval: Function }} [options.timers]
 */
export function createOpenclawAgentResponder({
  peers = [],
  registry,
  queue,
  transport,
  status,
  deliverAgentReply,
  pollIntervalMs = OPENCLAW_AGENT_RECONCILE_INTERVAL_MS,
  maxReplyBytes = OPENCLAW_AGENT_MAX_REPLY_BYTES,
  now = () => Date.now(),
  log = () => {},
  generateTaskId = () => randomUUID(),
  timers = { setInterval, clearInterval },
} = {}) {
  const peerIndex = new Map(peers.map((peer) => [peer.name, peer]))
  /** Explicit `contextId` overrides, bound 1:1 against the session that used them (§7). */
  const contextBindings = new Map()
  /** Conversations whose drain loop is running, so a re-entrant send cannot overlap. */
  const draining = new Set()
  const lifecycle = new AbortController()
  /** peer name -> request timestamps inside the sliding window. */
  const peerWindows = new Map()
  let timer = null

  /**
   * The per-peer request budget (§10): thirty requests per minute, counting BOTH
   * `SendMessage` and `GetTask`.
   *
   * The queue already caps admissions at thirty sends per minute, but a
   * conversation with several pending tasks would otherwise reconcile past the
   * documented budget with checks alone. Both limiters are kept: the queue's is the
   * admission gate U0 owns, and this one bounds every request that actually leaves
   * the process. Whichever refuses first, no request is issued.
   */
  function consumeRequest(peerName) {
    const window = peerWindows.get(peerName) ?? []
    const current = now()
    const live = window.filter((stamp) => current - stamp <= REQUEST_WINDOW_MS)
    peerWindows.set(peerName, live)
    if (live.length >= OPENCLAW_A2A_REQUESTS_PER_MINUTE) return false
    live.push(current)
    return true
  }

  function failure(errorClass) {
    return { kind: "failed", errorClass }
  }

  /**
   * Resolve the conversation id for one turn.
   *
   * Derived by default, so two sessions can never share a conversation and a
   * restart with the same `sessionID` continues it. An explicit override is
   * allowed (a deliberately long-lived conversation) but must bind to exactly one
   * session: a second binding is a configuration error, not a shared resource.
   */
  function resolveContext({ sessionID, contextId }) {
    if (contextId === undefined || contextId === null) {
      const derived = deriveOpenclawContextId(sessionID)
      return derived !== null && OPENCLAW_CONTEXT_ID_PATTERN.test(derived) ? derived : null
    }
    if (typeof contextId !== "string" || !OPENCLAW_CONTEXT_ID_PATTERN.test(contextId)) return null
    if (contextId === deriveOpenclawContextId(sessionID)) return contextId
    const bound = contextBindings.get(contextId)
    if (bound !== undefined && bound !== sessionID) return null
    contextBindings.set(contextId, sessionID)
    return contextId
  }

  /**
   * Inject one answer into the session that owns the task.
   *
   * `sessionID` comes from the durable record, never from the response. The three
   * outcomes are distinct on purpose: `delivered` settles the task, `refused`
   * (a host that will not accept a queued prompt) is reported and still settles,
   * and `transient` (the gate threw) leaves the task pending for the next tick.
   */
  async function deliverToSession(record, text) {
    if (typeof deliverAgentReply !== "function") return { kind: "refused" }
    const bounded = truncateToBytes(text, maxReplyBytes)
    if (bounded.truncated) await status?.recordTruncation(OPENCLAW_AGENT_REPLY_SURFACE)
    const payload = `${agentReplyPrefix(record.peer)}${bounded.text}`
    try {
      const accepted = await deliverAgentReply({ sessionID: record.sessionID, text: payload })
      return accepted === true ? { kind: "delivered" } : { kind: "refused" }
    } catch (error) {
      log(`[oh-my-rigel] Native V2 openclaw agent injection failed: ${error instanceof Error ? error.message : String(error)}`)
      return { kind: "transient" }
    }
  }

  /**
   * Apply one terminal task state. Shared by the send path and the reconciliation
   * path so both report a rejection identically.
   */
  async function applyTerminal(peerName, contextId, taskId, outcome) {
    const record = registry.lookup(peerName, contextId, taskId)
    if (record === null) return { settled: false, injected: false, state: outcome.state }
    if (outcome.state === "rejected") {
      await queue.settle({ peer: peerName, contextId, taskId, state: "rejected" })
      await status?.recordFailure(OPENCLAW_AGENT_STATUS_SURFACE, { errorClass: "task-rejected" })
      log(`[oh-my-rigel] openclaw a2a task rejected: peer=${peerName} task=${taskId}`)
      return { settled: true, injected: false, state: "rejected" }
    }
    if (outcome.state === "failed") {
      await queue.settle({ peer: peerName, contextId, taskId, state: "failed" })
      await status?.recordFailure(OPENCLAW_AGENT_STATUS_SURFACE, { errorClass: "task-failed" })
      log(`[oh-my-rigel] openclaw a2a task failed: peer=${peerName} task=${taskId}`)
      return { settled: true, injected: false, state: "failed" }
    }
    const text = typeof outcome.replyText === "string" ? outcome.replyText : ""
    if (text.length === 0) {
      // The vendor completes a task with empty artifacts when the agent answered
      // nothing. That is a legitimate terminal state with nothing to inject.
      await queue.settle({ peer: peerName, contextId, taskId, state: "completed" })
      return { settled: true, injected: false, state: "completed" }
    }
    const delivery = await deliverToSession(record, text)
    if (delivery.kind === "transient") {
      await status?.recordFailure(OPENCLAW_AGENT_REPLY_SURFACE, { errorClass: "injection-failed" })
      return { settled: false, injected: false, state: "working" }
    }
    if (delivery.kind === "refused") {
      await status?.recordFailure(OPENCLAW_AGENT_REPLY_SURFACE, { errorClass: "injection-refused" })
    } else {
      await status?.recordSuccess(OPENCLAW_AGENT_REPLY_SURFACE)
    }
    await queue.settle({ peer: peerName, contextId, taskId, state: "completed" })
    return { settled: true, injected: delivery.kind === "delivered", state: "completed" }
  }

  /**
   * Perform the one send a claim authorises, then free the conversation's slot.
   *
   * The slot guards the REQUEST, not the task: once the vendor accepted the send
   * there is no second `SendMessage` overlapping it, and the next queued message
   * may go while this task is still `WORKING`.
   */
  async function performSend(target, contextId, claim) {
    const peerName = target.name
    const outcome = await transport.send({
      peer: peerName,
      text: claim.text,
      contextId,
      messageId: `rigel-a2a-${claim.taskId}`,
      signal: lifecycle.signal,
      // The peer's client budget, which the resolver guarantees exceeds
      // `replyTimeoutMs`: a blocking send may consume its whole budget and still
      // be healthy.
      timeoutMs: target.clientTimeoutMs,
    })
    if (outcome.kind === "failed") {
      if (transport.isDefinitiveSendFailure(outcome.errorClass)) {
        // The request provably created no task (401/404/413 or a request-level
        // JSON-RPC error), so the record is settled instead of reported lost.
        await queue.settle({ peer: peerName, contextId, taskId: claim.taskId, state: "failed" })
        await status?.recordFailure(OPENCLAW_AGENT_STATUS_SURFACE, { errorClass: outcome.errorClass })
        return failure(outcome.errorClass)
      }
      // Ambiguous: a timeout or a truncated answer cannot tell us whether the peer
      // created the task, and the vendor does not deduplicate a retry.
      await queue.markLost({ peer: peerName, contextId, taskId: claim.taskId })
      await status?.recordFailure(OPENCLAW_AGENT_STATUS_SURFACE, { errorClass: outcome.errorClass })
      log(`[oh-my-rigel] openclaw a2a task lost on send: peer=${peerName} task=${claim.taskId} reason=${outcome.errorClass}`)
      return { kind: "failed", errorClass: outcome.errorClass, taskId: claim.taskId, lost: true }
    }
    await registry.attachRemoteTask(peerName, contextId, claim.taskId, outcome.remoteTaskId)
    await queue.release({ peer: peerName, contextId, taskId: claim.taskId })
    const receipt = {
      kind: "task",
      taskId: claim.taskId,
      remoteTaskId: outcome.remoteTaskId,
      state: outcome.state,
      queued: false,
    }
    if (outcome.state === "completed" || outcome.state === "failed" || outcome.state === "rejected") {
      // A blocking send can come back terminal; the answer must not wait a tick.
      await applyTerminal(peerName, contextId, claim.taskId, outcome)
      if (outcome.state === "rejected") return { ...receipt, kind: "rejected" }
    }
    return receipt
  }

  /**
   * Drain one conversation in order. Bounded by the queue's per-conversation depth,
   * so a peer that never answers cannot keep this loop running. The caller owns the
   * conversation lock.
   */
  async function runDrain(peerName, contextId) {
    const target = peerIndex.get(peerName)
    if (target === undefined) return new Map()
    const receipts = new Map()
    for (let step = 0; step < OPENCLAW_QUEUE_MAX_PER_CONVERSATION; step += 1) {
      const claim = await queue.claimNext(peerName, contextId)
      if (claim === null) break
      receipts.set(claim.taskId, await performSend(target, contextId, claim))
    }
    return receipts
  }

  /** Drain one conversation, guarded against a concurrent drain of the same one. */
  async function drainConversation(peerName, contextId) {
    const key = openclawConversationKey(peerName, contextId)
    if (draining.has(key)) return null
    draining.add(key)
    try {
      return await runDrain(peerName, contextId)
    } finally {
      draining.delete(key)
    }
  }

  /**
   * Start one conversational turn.
   *
   * The receipt is a §1 receipt: `task` when the peer accepted a task (with the
   * vendor id when the request already returned one, or `queued: true` when
   * another send holds the conversation), `rejected` when the turn was refused,
   * `failed` with a named class otherwise. Nothing here returns a bare success.
   */
  async function send(input = {}) {
    const { sessionID, peer, text, agentId = OPENCLAW_AGENT_DEFAULT_AGENT_ID, contextId } = input
    const target = peerIndex.get(peer)
    if (target === undefined) return failure("unknown-peer")
    if (typeof sessionID !== "string" || sessionID.length === 0) return failure("missing-session")
    if (typeof text !== "string" || text.trim().length === 0) return failure("empty-text")
    if (text.trimStart().startsWith("/")) {
      // The vendor answers this as a REJECTED task. Mirroring the gate locally
      // spends no task and no request, and still reports the rejection.
      await status?.recordFailure(OPENCLAW_AGENT_STATUS_SURFACE, { errorClass: "slash-command" })
      return { kind: "rejected", errorClass: "slash-command" }
    }
    const resolvedContext = resolveContext({ sessionID, contextId })
    if (resolvedContext === null) return failure("invalid-context")
    if (!consumeRequest(target.name)) {
      // §9.3: a rate limit is jitter, never a state change; only the counter moves.
      await status?.recordRateLimit(OPENCLAW_AGENT_STATUS_SURFACE)
      return failure("rate-limited")
    }

    const taskId = generateTaskId()
    // The conversation lock is taken BEFORE the first await, so a second turn that
    // arrives while the first send is still on the wire is reported as queued
    // instead of racing for the claim.
    const conversation = openclawConversationKey(target.name, resolvedContext)
    const busy = draining.has(conversation)
    // Write-ahead: the record exists before the request does.
    const enqueued = await queue.enqueue({
      peer: target.name,
      contextId: resolvedContext,
      taskId,
      sessionID,
      agentId,
      text,
    })
    if (!enqueued.accepted) return failure(enqueued.reason)
    if (busy) return { kind: "task", taskId, state: "submitted", queued: true }

    draining.add(conversation)
    let receipts
    try {
      receipts = await runDrain(target.name, resolvedContext)
    } catch (error) {
      log(`[oh-my-rigel] Native V2 openclaw a2a dispatch failed: ${error instanceof Error ? error.message : String(error)}`)
      receipts = null
    } finally {
      draining.delete(conversation)
    }
    const mine = receipts?.get(taskId)
    if (mine !== undefined) return mine
    // Older pending tasks went first; this one is durable and will be sent in order.
    return { kind: "task", taskId, state: "submitted", queued: true }
  }

  /**
   * One reconciliation pass.
   *
   * Two phases, both bounded: first report records that were written ahead and can
   * never be sent (the process died between the write and the request), then ask
   * `GetTask` about every known task whose throttle window elapsed.
   */
  async function reconcileOnce() {
    const result = { checked: 0, settled: 0, injected: 0, lost: 0, rejected: 0 }
    // Hard prune horizon (§6.4): a record past seven days never gets an answer, so
    // it is reported as lost here instead of lingering forever.
    const pruned = await registry.prune?.()
    if (pruned !== undefined && pruned.lost.length > 0) {
      result.lost += pruned.lost.length
      for (const record of pruned.lost) {
        await status?.recordFailure(OPENCLAW_AGENT_STATUS_SURFACE, { errorClass: "task-lost" })
        log(`[oh-my-rigel] openclaw a2a task lost to the prune horizon: peer=${record.peer} task=${record.taskId}`)
      }
    }
    for (const record of registry.list()) {
      if (!OPENCLAW_AGENT_PENDING_STATES.includes(record.state)) continue
      if (typeof record.remoteTaskId === "string") continue
      if (queue.hasPayload(record.peer, record.contextId, record.taskId)) continue
      const marked = await queue.markLost({
        peer: record.peer,
        contextId: record.contextId,
        taskId: record.taskId,
      })
      if (!marked) continue
      result.lost += 1
      await status?.recordFailure(OPENCLAW_AGENT_STATUS_SURFACE, { errorClass: "task-lost" })
      log(`[oh-my-rigel] openclaw a2a task lost before send: peer=${record.peer} task=${record.taskId}`)
    }

    for (const record of registry.list()) {
      if (!OPENCLAW_AGENT_PENDING_STATES.includes(record.state)) continue
      if (typeof record.remoteTaskId !== "string") continue
      if (!peerIndex.has(record.peer)) continue
      const lastChecked = Date.parse(record.lastCheckedAt ?? record.createdAt)
      if (Number.isFinite(lastChecked) && now() - lastChecked < pollIntervalMs) continue
      if (!consumeRequest(record.peer)) {
        await status?.recordRateLimit(OPENCLAW_AGENT_STATUS_SURFACE)
        continue
      }
      result.checked += 1
      const outcome = await transport.getTask({
        peer: record.peer,
        remoteTaskId: record.remoteTaskId,
        signal: lifecycle.signal,
        timeoutMs: peerIndex.get(record.peer).clientTimeoutMs,
      })
      if (outcome.kind === "failed") {
        // A failed CHECK is not a failed task: keep the record pending and let the
        // next tick try again, bounded by the registry's hard prune horizon.
        await status?.recordFailure(OPENCLAW_AGENT_STATUS_SURFACE, {
          errorClass: `get-task-${outcome.errorClass}`,
        })
        await registry.touch(record.peer, record.contextId, record.taskId)
        continue
      }
      if (outcome.state === "submitted" || outcome.state === "working") {
        await registry.touch(record.peer, record.contextId, record.taskId)
        continue
      }
      const applied = await applyTerminal(record.peer, record.contextId, record.taskId, outcome)
      if (applied.settled) result.settled += 1
      if (applied.injected) result.injected += 1
      if (outcome.state === "rejected") result.rejected += 1
    }
    return result
  }

  /**
   * Start the reconciliation loop. Never started on a surface with no peer, and
   * every request it makes stays inside the per-record throttle.
   */
  function start({ intervalMs = pollIntervalMs } = {}) {
    if (timer !== null) return { started: false, reason: "already-started" }
    if (peerIndex.size === 0) return { started: false, reason: "no-peers" }
    timer = timers.setInterval(() => {
      void reconcileOnce().catch((error) => {
        log(`[oh-my-rigel] Native V2 openclaw a2a reconcile failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, intervalMs)
    // A reconciliation timer must never keep the host process alive.
    timer?.unref?.()
    return { started: true, intervalMs }
  }

  /** Stop reconciling. In-flight requests keep their own timeout. */
  function stop() {
    if (timer === null) return false
    timers.clearInterval(timer)
    timer = null
    return true
  }

  /** Terminal teardown: stop, abort in-flight requests, drop the bindings. */
  function dispose() {
    stop()
    lifecycle.abort()
    contextBindings.clear()
  }

  return {
    send,
    reconcileOnce,
    drainConversation,
    start,
    stop,
    dispose,
    agentReplyPrefix,
    status: () => ({
      peers: [...peerIndex.keys()],
      pending: queue.pendingTotal?.() ?? 0,
      inflight: registry.inflightCount?.() ?? 0,
      reconciling: timer !== null,
    }),
  }
}
