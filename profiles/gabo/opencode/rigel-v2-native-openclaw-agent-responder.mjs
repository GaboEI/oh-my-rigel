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
 *     Ownership is bound twice: the derived id is registered the moment it is
 *     used, and the durable record answers the same question after a restart.
 *   - **One answer, one injection.** A reconciliation pass is serialized against
 *     itself, a record already claiming the answer is skipped while another path
 *     applies it, and a terminal record can never be applied again: the settlement
 *     is durable, so a second pass over the same answer cannot reach the session.
 *   - **Never a silent drop.** A record the runtime cannot observe is reported as
 *     `lost`; a refusal is reported as a refusal; a bound that rejects is a
 *     `degraded` transition; a turn admitted while a drain is running is drained
 *     by that same run instead of being left with an unsent payload.
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
  OPENCLAW_AGENT_TERMINAL_STATES,
  OPENCLAW_CONTEXT_ID_PATTERN,
  deriveOpenclawContextId,
  openclawConversationKey,
} from "./rigel-v2-native-openclaw-agent-registry.mjs"
import {
  OPENCLAW_QUEUE_REPLY_TIMEOUT_MS,
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
 * @param {{ setInterval: Function, clearInterval: Function, setTimeout?: Function, clearTimeout?: Function }} [options.timers]
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
  /** `(peer, contextId, taskId)` currently applying a terminal answer, so two paths cannot inject it twice. */
  const applying = new Set()
  /** Conversation key -> its active drain, so shutdown can join it rather than race it. */
  const drainPromises = new Map()
  /** Claimed sends that are currently on the wire, indexed for deadline-bounded shutdown. */
  const activeClaims = new Map()
  /** The pass in flight, so overlapping ticks serialize instead of polling the same task. */
  let inFlightPass = null
  const lifecycle = new AbortController()
  /** peer name -> request timestamps inside the sliding window. */
  const peerWindows = new Map()
  let timer = null
  let accepting = true
  let shutdownDeadlineExpired = false

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
   * Bind one conversation id to one session, once.
   *
   * Returns false when another session already holds it: a second binding is a
   * configuration error, not a shared resource.
   */
  function bindContext(contextId, sessionID) {
    const bound = contextBindings.get(contextId)
    if (bound !== undefined && bound !== sessionID) return false
    contextBindings.set(contextId, sessionID)
    return true
  }

  /**
   * Resolve the conversation id for one turn.
   *
   * Derived by default, so two sessions can never share a conversation and a
   * restart with the same `sessionID` continues it. An explicit override is
   * allowed (a deliberately long-lived conversation) but must bind to exactly one
   * session, and the DERIVED id is bound too: an override that merely names
   * another session's derived conversation is exactly the claim this refuses.
   *
   * The binding map is process-local, so the durable record answers the same
   * question after a restart: a hydrated conversation keeps its owning session.
   */
  function resolveContext(peerName, { sessionID, contextId }) {
    if (contextId === undefined || contextId === null) {
      const derived = deriveOpenclawContextId(sessionID)
      if (derived === null || !OPENCLAW_CONTEXT_ID_PATTERN.test(derived)) return null
      return bindContext(derived, sessionID) ? derived : null
    }
    if (typeof contextId !== "string" || !OPENCLAW_CONTEXT_ID_PATTERN.test(contextId)) return null
    // The durable record is what makes the ownership survive a restart, so the
    // check runs BEFORE the binding: a refused claim must not poison the map.
    const owners = registry.sessionOwners?.(peerName, contextId) ?? []
    if (owners.length > 0 && !owners.includes(sessionID)) return null
    return bindContext(contextId, sessionID) ? contextId : null
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
   * path so both report a rejection identically, and idempotent per answer: the
   * caller that is already applying this record owns it, and a record that is
   * already terminal is never applied again. Without that, a second hold on the
   * same `GetTask` answer injects the same prompt twice.
   */
  async function applyTerminal(peerName, contextId, taskId, outcome) {
    const record = registry.lookup(peerName, contextId, taskId)
    if (record === null) return { settled: false, injected: false, state: outcome.state }
    // The settlement is durable, so a terminal record is proof the answer was
    // already reported; re-applying it could only duplicate the injection.
    if (OPENCLAW_AGENT_TERMINAL_STATES.includes(record.state)) {
      return { settled: false, injected: false, state: outcome.state }
    }
    const key = `${openclawConversationKey(peerName, contextId)}\u0000${taskId}`
    if (applying.has(key)) return { settled: false, injected: false, state: outcome.state }
    applying.add(key)
    try {
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
    } finally {
      applying.delete(key)
    }
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
    const activeKey = `${openclawConversationKey(peerName, contextId)}\u0000${claim.taskId}`
    activeClaims.set(activeKey, { peer: peerName, contextId, taskId: claim.taskId, deadlineAt: claim.deadlineAt })
    let outcome
    try {
      outcome = await transport.send({
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
    } finally {
      activeClaims.delete(activeKey)
    }
    if (outcome.kind === "failed") {
      if (shutdownDeadlineExpired && lifecycle.signal.aborted) {
        const record = registry.lookup(peerName, contextId, claim.taskId)
        if (record?.state === "shutdown-lost") {
          return { kind: "failed", errorClass: "shutdown-deadline", taskId: claim.taskId, lost: true, shutdownLost: true }
        }
      }
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
    if (shutdownDeadlineExpired && registry.lookup(peerName, contextId, claim.taskId)?.state === "shutdown-lost") {
      return { kind: "failed", errorClass: "shutdown-deadline", taskId: claim.taskId, lost: true, shutdownLost: true }
    }
    await registry.attachRemoteTask(peerName, contextId, claim.taskId, outcome.remoteTaskId)
    // The peer accepted the request, so the transport surface is healthy again: a
    // degraded `a2a` recovers on the first success instead of staying degraded for
    // the life of the process.
    await status?.recordSuccess(OPENCLAW_AGENT_STATUS_SURFACE)
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
   * Drain one conversation in order, until nothing is claimable.
   *
   * There is deliberately NO iteration cap. The queue's per-conversation depth
   * bounds admissions, and every iteration consumes exactly one claimable record
   * (settled, marked lost, or carrying a `remoteTaskId`), so the loop is monotone
   * and terminates. A cap used to end the pass with a payload still queued — the
   * turn admitted while the last send was on the wire — and reconciliation skips a
   * record that still holds its payload, so nothing would ever send it again.
   *
   * The caller owns the conversation lock.
   */
  async function runDrain(peerName, contextId) {
    const target = peerIndex.get(peerName)
    if (target === undefined) return new Map()
    const receipts = new Map()
    for (;;) {
      const claim = await queue.claimNext(peerName, contextId)
      if (claim === null) break
      receipts.set(claim.taskId, await performSend(target, contextId, claim))
    }
    return receipts
  }

  /** Drain one conversation, guarded against a concurrent drain of the same one. */
  async function drainConversation(peerName, contextId) {
    const key = openclawConversationKey(peerName, contextId)
    if (draining.has(key)) return drainPromises.get(key) ?? null
    draining.add(key)
    const drain = runDrain(peerName, contextId)
    drainPromises.set(key, drain)
    try {
      return await drain
    } finally {
      drainPromises.delete(key)
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
    if (!accepting) return failure("shutting-down")
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
    const resolvedContext = resolveContext(target.name, { sessionID, contextId })
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

    let receipts
    try {
      receipts = await drainConversation(target.name, resolvedContext)
    } catch (error) {
      log(`[oh-my-rigel] Native V2 openclaw a2a dispatch failed: ${error instanceof Error ? error.message : String(error)}`)
      receipts = null
    }
    const mine = receipts?.get(taskId)
    if (mine !== undefined) return mine
    // Older pending tasks went first; this one is durable and will be sent in order.
    return { kind: "task", taskId, state: "submitted", queued: true }
  }

  /**
   * When a record was last polled, in milliseconds. The reconciliation order and
   * the per-record throttle read the same clock, so a record cannot be "old enough
   * to check" and "too new to sort first" at the same time.
   */
  function lastPolledAt(record) {
    const parsed = Date.parse(record.lastCheckedAt ?? record.createdAt)
    return Number.isFinite(parsed) ? parsed : 0
  }

  /**
   * One reconciliation pass, serialized.
   *
   * The cadence (5 s) is far shorter than a `GetTask` can take (the client budget
   * is `replyTimeoutMs` + 30 s), so two ticks would otherwise both see a record
   * whose `lastCheckedAt` has not been stamped yet, poll the same task twice, and
   * inject the same answer twice through the shared prompt gate. A caller that
   * arrives while a pass is running joins it instead of starting a second one.
   */
  async function reconcileOnce() {
    if (inFlightPass !== null) return inFlightPass
    const pass = runReconcilePass()
    inFlightPass = pass
    try {
      return await pass
    } finally {
      if (inFlightPass === pass) inFlightPass = null
    }
  }

  /**
   * The body of one reconciliation pass.
   *
   * Two phases, both bounded: first report records that were written ahead and can
   * never be sent (the process died between the write and the request), then ask
   * `GetTask` about every known task whose throttle window elapsed.
   */
  async function runReconcilePass() {
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

    // Oldest-checked first. The peer budget is thirty requests a minute, so a
    // fixed order would spend every window on the same head of the list and let the
    // tail reach the seven-day prune horizon without ever being polled. Sorting by
    // the same clock the throttle reads makes the next pass start where the last
    // one stopped, and a record that is skipped can only get older.
    const pollable = [...registry.list()].sort((left, right) => lastPolledAt(left) - lastPolledAt(right))
    for (const record of pollable) {
      if (!OPENCLAW_AGENT_PENDING_STATES.includes(record.state)) continue
      if (typeof record.remoteTaskId !== "string") continue
      if (!peerIndex.has(record.peer)) continue
      const lastChecked = lastPolledAt(record)
      if (lastChecked > 0 && now() - lastChecked < pollIntervalMs) continue
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
      // A healthy answer proves the transport surface works, so a degraded `a2a`
      // recovers here instead of staying degraded for the life of the process.
      await status?.recordSuccess(OPENCLAW_AGENT_STATUS_SURFACE)
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

  /**
   * How long shutdown may still wait for a drain, in milliseconds.
   *
   * A drain is BETWEEN claims most of the time, so `activeClaims` can be empty
   * while a send is still in flight. An empty map used to yield `Infinity`, and
   * the platform clamps that to one millisecond: shutdown declared the pending
   * tasks `shutdown-lost` without ever giving them the reply budget this path
   * promises. A drain queued behind the earliest active claim has no deadline of
   * its own, so the answer is that claim's remaining budget while one is on the
   * wire and a full reply window otherwise, always finite and never longer than
   * one reply window.
   */
  function shutdownWaitMs() {
    const declared = queue.replyTimeoutMs?.()
    const replyTimeoutMs = Number.isFinite(declared) && declared > 0
      ? declared
      : OPENCLAW_QUEUE_REPLY_TIMEOUT_MS
    const deadlines = [...activeClaims.values()]
      .map((claim) => claim.deadlineAt)
      .filter((deadline) => Number.isFinite(deadline))
    const deadlineAt = deadlines.length > 0 ? Math.max(0, Math.min(...deadlines)) : now() + replyTimeoutMs
    return Math.min(Math.max(0, deadlineAt - now()), replyTimeoutMs)
  }

  /**
   * Stop admitting new work, then give queued and in-flight sends the same bounded
   * reply budget they received when claimed. A deadline is a distinct terminal
   * outcome, not a crash and never an authorization to resend.
   */
  async function shutdown() {
    accepting = false
    queue.closeAdmissions?.()
    stop()
    const drains = [...drainPromises.values()]
    const finish = Promise.allSettled(drains)
    // Only a drain needs the wait; with nothing in flight the terminal marking
    // below is already the honest outcome and must not be delayed.
    const remaining = drains.length > 0 ? shutdownWaitMs() : 0
    if (remaining > 0) {
      const scheduleTimeout = timers.setTimeout ?? setTimeout
      const cancelTimeout = timers.clearTimeout ?? clearTimeout
      let timeout
      const deadline = new Promise((resolve) => { timeout = scheduleTimeout(resolve, remaining) })
      const outcome = await Promise.race([finish.then(() => "drained"), deadline.then(() => "deadline")])
      cancelTimeout(timeout)
      if (outcome === "drained") return { drained: true, shutdownLost: 0 }
    }
    shutdownDeadlineExpired = true
    let shutdownLost = 0
    for (const record of registry.list()) {
      if (!OPENCLAW_AGENT_PENDING_STATES.includes(record.state)) continue
      if (typeof record.remoteTaskId === "string") continue
      const marked = await queue.markShutdownLost({ peer: record.peer, contextId: record.contextId, taskId: record.taskId })
      if (!marked) continue
      shutdownLost += 1
      await status?.recordFailure(OPENCLAW_AGENT_STATUS_SURFACE, { errorClass: "task-shutdown-lost" })
      log(`[oh-my-rigel] openclaw a2a task lost at shutdown deadline: peer=${record.peer} task=${record.taskId}`)
    }
    // Mark before aborting. An abort can resolve the in-flight send immediately;
    // its handler must observe the distinct terminal state rather than race it into
    // the crash-only `lost` residual.
    lifecycle.abort()
    return { drained: false, shutdownLost }
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
    shutdown,
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
