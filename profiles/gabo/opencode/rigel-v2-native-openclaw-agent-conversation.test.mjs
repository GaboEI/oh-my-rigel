import { describe, expect, test } from "bun:test"
import { createNativeOpenclaw } from "./rigel-v2-native-openclaw.mjs"
import {
  OPENCLAW_AGENT_REGISTRY_PREFIX,
  createOpenclawAgentRegistry,
  deriveOpenclawContextId,
} from "./rigel-v2-native-openclaw-agent-registry.mjs"
import {
  OPENCLAW_QUEUE_REPLY_TIMEOUT_MS,
  createOpenclawAgentQueue,
} from "./rigel-v2-native-openclaw-agent-queue.mjs"
import {
  OPENCLAW_AGENT_REPLY_SURFACE,
  agentReplyPrefix,
  createOpenclawAgentResponder,
} from "./rigel-v2-native-openclaw-agent-responder.mjs"
import {
  OPENCLAW_A2A_REQUESTS_PER_MINUTE,
  OPENCLAW_AGENT_STATUS_SURFACE,
  createOpenclawAgentTransport,
  resolveOpenclawAgentPeers,
} from "./rigel-v2-native-openclaw-agent-transport.mjs"

const PEER_URL = "http://127.0.0.1:4011"
const SESSION_A = "ses_alpha"
const SESSION_B = "ses_beta"
const START = Date.parse("2026-01-01T00:00:00.000Z")

/** Shared clock: the queue window, the record TTL and the reconcile throttle all read it. */
function clock(start = START) {
  let current = start
  return {
    now: () => current,
    advance: (ms) => { current += ms },
  }
}

/** Storage spy that keeps its calls in the SAME log as the fetch spy, in order. */
function spyStorage(order) {
  const map = new Map()
  return {
    map,
    get: async (key) => { order.push({ op: "get", key }); return map.get(key) },
    set: async (key, value) => { order.push({ op: "set", key }); map.set(key, value) },
    remove: async (key) => { order.push({ op: "remove", key }); map.delete(key) },
    scan: async ({ prefix } = {}) => {
      order.push({ op: "scan", prefix })
      return {
        entries: [...map.entries()]
          .filter(([key]) => (prefix ? key.startsWith(prefix) : true))
          .map(([key, value]) => ({ key, value })),
      }
    },
  }
}

function statusRecorder() {
  const failures = []
  const successes = []
  const truncations = []
  return {
    failures,
    successes,
    truncations,
    recordFailure: async (id, info) => { failures.push({ id, errorClass: info?.errorClass }) },
    recordSuccess: async (id) => { successes.push(id) },
    recordTruncation: async (id) => { truncations.push(id) },
    recordRateLimit: async () => {},
    hydrate: async () => {},
    snapshot: () => ({ surfaces: {}, updatedAt: null }),
  }
}

function injectionRecorder(result = true) {
  const calls = []
  const deliver = async (input) => {
    calls.push(input)
    if (result instanceof Error) throw result
    return result
  }
  deliver.calls = calls
  return deliver
}

/**
 * A2A peer double. `send` and `getTask` answer from scripted queues so a test can
 * pin one exchange per assertion instead of one global handler.
 */
function a2aFetch(order, { send = [], getTask = [] } = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    order.push({ op: "fetch", method: init.method })
    if (init.method === "GET") return { ok: false, status: 404, text: async () => "{}" }
    const body = JSON.parse(init.body)
    const script = body.method === "SendMessage" ? send : getTask
    const next = script.shift()
    if (next === undefined) throw new Error(`openclaw test double has no ${body.method} answer left`)
    if (typeof next === "function") return next(body)
    return { ok: true, status: 200, text: async () => JSON.stringify(next) }
  }
  fetchImpl.calls = calls
  fetchImpl.posts = () => calls.filter((call) => call.init.method === "POST")
  return fetchImpl
}

const taskAnswer = (state, extra = {}) => ({
  jsonrpc: "2.0",
  id: "x",
  result: { task: { id: `task-${state.toLowerCase()}`, contextId: "rigel-derived", status: { state }, ...extra } },
})

/**
 * Bounded wait for a state the test double owns. There is no event to subscribe to
 * inside the transport, so the spy is polled against an explicit deadline and a
 * deadline miss fails loudly instead of silently continuing.
 */
async function waitFor(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`waited ${timeoutMs}ms for ${label}, never happened`)
}

function harness({ send = [], getTask = [], deliver = injectionRecorder(), peers, storage: existingStorage } = {}) {
  const order = []
  const time = clock()
  const storage = existingStorage ?? spyStorage(order)
  const registry = createOpenclawAgentRegistry({ storage, now: time.now })
  const status = statusRecorder()
  const queue = createOpenclawAgentQueue({ registry, status, now: time.now })
  const resolved = peers ?? resolveOpenclawAgentPeers({ enabled: true, peers: { alpha: { token: "env:ALPHA_TOKEN", url: PEER_URL } } }, { env: { ALPHA_TOKEN: "alpha-secret" } })
  const fetchImpl = a2aFetch(order, { send, getTask })
  const transport = createOpenclawAgentTransport({ peers: resolved.peers, fetchImpl, now: time.now })
  const responder = createOpenclawAgentResponder({
    peers: resolved.peers,
    registry,
    queue,
    transport,
    status,
    deliverAgentReply: deliver,
    now: time.now,
  })
  return { order, time, storage, registry, status, queue, transport, responder, fetchImpl, deliver, peers: resolved }
}

/**
 * Deadline timers a test drives by hand. The shutdown budget is measured in
 * wall-clock milliseconds, so a test that waited it out for real would take two
 * minutes; the responder accepts its timer object, and this one records the
 * delays it was asked for and fires them only when the test says so.
 */
function deadlineTimers() {
  const scheduled = []
  return {
    scheduled,
    setInterval: () => null,
    clearInterval: () => {},
    setTimeout: (run, ms) => {
      const handle = { run, ms, cancelled: false }
      scheduled.push(handle)
      return handle
    },
    clearTimeout: (handle) => {
      if (handle) handle.cancelled = true
    },
    fireAll: () => {
      for (const handle of scheduled) if (!handle.cancelled) handle.run()
    },
  }
}

/**
 * A responder whose drain is BETWEEN claims, which is the state the shutdown
 * budget has to survive: `activeClaims` is empty while a drain is still running.
 * `claimNext` never answers (or answers after `releaseClaimAfterMs`), so the
 * drain is in flight for the whole test and no claim is ever registered.
 */
function shutdownFixture({ replyTimeoutMs, timers = deadlineTimers(), releaseClaimAfterMs } = {}) {
  const order = []
  const time = clock()
  const storage = spyStorage(order)
  const registry = createOpenclawAgentRegistry({ storage, now: time.now })
  const status = statusRecorder()
  const queue = createOpenclawAgentQueue({ registry, status, now: time.now, replyTimeoutMs })
  const settledClaim = releaseClaimAfterMs === undefined
    ? null
    : new Promise((resolve) => { setTimeout(() => resolve(null), releaseClaimAfterMs) })
  const heldQueue = {
    ...queue,
    claimNext: () => settledClaim ?? new Promise(() => {}),
  }
  const resolved = resolveOpenclawAgentPeers(
    { enabled: true, peers: { alpha: { token: "env:ALPHA_TOKEN", url: PEER_URL } } },
    { env: { ALPHA_TOKEN: "alpha-secret" } },
  )
  const transport = createOpenclawAgentTransport({
    peers: resolved.peers,
    fetchImpl: async () => { throw new Error("shutdown fixture: no request expected") },
    now: time.now,
  })
  const responder = createOpenclawAgentResponder({
    peers: resolved.peers,
    registry,
    queue: heldQueue,
    transport,
    status,
    deliverAgentReply: injectionRecorder(),
    now: time.now,
    timers,
  })
  return { order, time, storage, registry, status, queue: heldQueue, transport, responder, timers }
}

describe("openclaw A2A conversational send", () => {
  test("#given text that starts with a slash #when sending #then it is rejected before a task or a request exists", async () => {
    const { responder, registry, status, fetchImpl, order } = harness()
    const receipt = await responder.send({ sessionID: SESSION_A, peer: "alpha", text: "  /goal start" })

    expect(receipt).toEqual({ kind: "rejected", errorClass: "slash-command" })
    expect(fetchImpl.calls).toHaveLength(0)
    expect(registry.size()).toBe(0)
    expect(order.filter((entry) => entry.op === "set" && entry.key.startsWith(OPENCLAW_AGENT_REGISTRY_PREFIX))).toHaveLength(0)
    expect(status.failures).toEqual([{ id: OPENCLAW_AGENT_STATUS_SURFACE, errorClass: "slash-command" }])
  })

  test("#given an unknown peer #when sending #then the refusal is named and nothing is dialled", async () => {
    const { responder, fetchImpl } = harness()
    const receipt = await responder.send({ sessionID: SESSION_A, peer: "ghost", text: "hello" })
    expect(receipt).toEqual({ kind: "failed", errorClass: "unknown-peer" })
    expect(fetchImpl.calls).toHaveLength(0)
  })

  test("#given an accepted turn #when sending #then the durable record is written before the request", async () => {
    const { responder, order } = harness({ send: [taskAnswer("WORKING")] })
    const receipt = await responder.send({ sessionID: SESSION_A, peer: "alpha", text: "hello" })

    expect(receipt).toMatchObject({ kind: "task", state: "working", queued: false })
    expect(receipt.remoteTaskId).toBe("task-working")
    const writeIndex = order.findIndex((entry) => entry.op === "set" && entry.key.startsWith(OPENCLAW_AGENT_REGISTRY_PREFIX))
    const fetchIndex = order.findIndex((entry) => entry.op === "fetch" && entry.method === "POST")
    expect(writeIndex).toBeGreaterThanOrEqual(0)
    expect(writeIndex).toBeLessThan(fetchIndex)
  })

  test("#given a send already in flight on a conversation #when a second turn arrives #then it queues behind the single slot", async () => {
    let releaseFirst
    const firstAnswer = new Promise((resolve) => { releaseFirst = resolve })
    const { responder, registry, fetchImpl } = harness({
      send: [() => firstAnswer, taskAnswer("WORKING")],
    })

    const first = responder.send({ sessionID: SESSION_A, peer: "alpha", text: "first" })
    // Wait until the first request is actually on the wire; the second turn must
    // then queue behind the conversation's single in-flight slot.
    await waitFor(() => fetchImpl.posts().length === 1, "the first SendMessage")
    const second = await responder.send({ sessionID: SESSION_A, peer: "alpha", text: "second" })
    expect(second).toMatchObject({ kind: "task", queued: true })
    expect(fetchImpl.posts()).toHaveLength(1)

    releaseFirst({ ok: true, status: 200, text: async () => JSON.stringify(taskAnswer("WORKING")) })
    const firstReceipt = await first
    expect(firstReceipt).toMatchObject({ kind: "task", queued: false })
    // The drain that owned the slot sent the queued turn once the slot was free.
    expect(fetchImpl.posts()).toHaveLength(2)
    expect(registry.size()).toBe(2)
    expect(registry.inflightCount()).toBe(0)
  })

  test("#given thirty turns inside one minute #when the thirty-first arrives #then the budget refuses it without a request", async () => {
    // One conversation caps at its own depth, so the peer budget is measured
    // across conversations: the window is per peer, not per contextId.
    const answers = Array.from({ length: 30 }, () => taskAnswer("WORKING"))
    const { responder, fetchImpl } = harness({ send: answers })
    for (let turn = 0; turn < 30; turn += 1) {
      const receipt = await responder.send({ sessionID: `${SESSION_A}_${turn}`, peer: "alpha", text: `turn ${turn}` })
      expect(receipt.kind).toBe("task")
    }
    const refused = await responder.send({ sessionID: `${SESSION_A}_refused`, peer: "alpha", text: "turn 31" })
    expect(refused).toEqual({ kind: "failed", errorClass: "rate-limited" })
    expect(fetchImpl.posts()).toHaveLength(30)
  })

  test("#given a task the peer rejected #when sending #then the receipt is a rejection and the task is never injected", async () => {
    const { responder, registry, status, deliver } = harness({
      send: [{
        result: {
          task: {
            id: "task-rejected",
            status: { state: "REJECTED", message: { parts: [{ text: "A2A peer was blocked by channel ingress policy" }] } },
          },
        },
      }],
    })
    const receipt = await responder.send({ sessionID: SESSION_A, peer: "alpha", text: "hello" })
    expect(receipt).toMatchObject({ kind: "rejected", state: "rejected" })
    expect(deliver.calls).toHaveLength(0)
    expect(registry.lookup("alpha", receipt.contextId ?? registry.list()[0].contextId, receipt.taskId)).toMatchObject({ state: "rejected" })
    expect(status.failures).toEqual([{ id: OPENCLAW_AGENT_STATUS_SURFACE, errorClass: "task-rejected" }])
  })

  test("#given a request that definitely created no task #when it fails #then the record is failed, not lost", async () => {
    const { responder, registry } = harness({
      send: [() => ({ ok: false, status: 401, text: async () => "Unauthorized" })],
    })
    const receipt = await responder.send({ sessionID: SESSION_A, peer: "alpha", text: "hello" })
    expect(receipt).toEqual({ kind: "failed", errorClass: "unauthorized" })
    expect(registry.list()[0]).toMatchObject({ state: "failed" })
  })

  test("#given an ambiguous transport failure #when the send dies #then the task is reported as lost and never resent", async () => {
    const { responder, registry, status } = harness({
      send: [() => new Promise((_resolve, reject) => reject(Object.assign(new Error("boom"), { name: "TypeError" })))],
    })
    const receipt = await responder.send({ sessionID: SESSION_A, peer: "alpha", text: "hello" })
    expect(receipt).toMatchObject({ kind: "failed", errorClass: "network", lost: true })
    expect(registry.list()[0]).toMatchObject({ state: "lost" })
    expect(status.failures.map((entry) => entry.errorClass)).toContain("network")
  })
})

describe("openclaw A2A reconciliation", () => {
  test("#given a working task that completed with an answer #when reconciling #then the answer is injected into the session that owns it", async () => {
    const deliver = injectionRecorder()
    const { responder, registry, time, status } = harness({
      send: [taskAnswer("WORKING")],
      getTask: [{ result: { id: "task-working", status: { state: "COMPLETED" }, artifacts: [{ parts: [{ text: "the answer" }] }] } }],
      deliver,
    })
    const receipt = await responder.send({ sessionID: SESSION_A, peer: "alpha", text: "hello" })
    time.advance(60_000)
    const pass = await responder.reconcileOnce()

    expect(deliver.calls).toEqual([{ sessionID: SESSION_A, text: `${agentReplyPrefix("alpha")}the answer` }])
    expect(deliver.calls[0].text.startsWith("[agent:alpha] ")).toBe(true)
    expect(pass).toMatchObject({ checked: 1, settled: 1, injected: 1 })
    expect(registry.list()[0]).toMatchObject({ state: "completed", remoteTaskId: "task-working" })
    expect(status.successes).toContain(OPENCLAW_AGENT_REPLY_SURFACE)
    expect(receipt.kind).toBe("task")
  })

  test("#given a completed task with no reply text #when reconciling #then the task settles without an injection", async () => {
    const deliver = injectionRecorder()
    const { responder, time } = harness({
      send: [taskAnswer("WORKING")],
      getTask: [{ result: { id: "task-working", status: { state: "COMPLETED" }, artifacts: [] } }],
      deliver,
    })
    await responder.send({ sessionID: SESSION_A, peer: "alpha", text: "hello" })
    time.advance(60_000)
    const pass = await responder.reconcileOnce()
    expect(pass).toMatchObject({ settled: 1, injected: 0 })
    expect(deliver.calls).toHaveLength(0)
  })

  test("#given a task the peer rejected later #when reconciling #then it is reported as a rejection and never injected", async () => {
    const deliver = injectionRecorder()
    const { responder, registry, time, status } = harness({
      send: [taskAnswer("WORKING")],
      getTask: [{
        result: {
          id: "task-working",
          status: { state: "REJECTED", message: { parts: [{ text: "A2A channel declined the turn" }] } },
          artifacts: [{ parts: [{ text: "must not be injected" }] }],
        },
      }],
      deliver,
    })
    await responder.send({ sessionID: SESSION_A, peer: "alpha", text: "hello" })
    time.advance(60_000)
    const pass = await responder.reconcileOnce()
    expect(pass).toMatchObject({ settled: 1, injected: 0, rejected: 1 })
    expect(deliver.calls).toHaveLength(0)
    expect(registry.list()[0].state).toBe("rejected")
    expect(status.failures.map((entry) => entry.errorClass)).toContain("task-rejected")
  })

  test("#given a write-ahead record whose payload never reached a send #when reconciling #then it is reported as lost, never discarded", async () => {
    const order = []
    const storage = spyStorage(order)
    const beforeCrash = createOpenclawAgentRegistry({ storage })
    // Exactly the state a crash between write-ahead and send leaves behind: a
    // record and no payload to send, so no vendor id can ever be learned.
    await beforeCrash.register({ peer: "alpha", contextId: "rigel-crashed", taskId: "task-crashed", sessionID: SESSION_A, agentId: "rigel" })
    const durableSnapshot = structuredClone([...storage.map.entries()])
    const { responder, registry, status, fetchImpl } = harness({ storage })
    await registry.hydrate()
    const pass = await responder.reconcileOnce()

    expect(pass.lost).toBe(1)
    expect(registry.lookup("alpha", "rigel-crashed", "task-crashed").state).toBe("lost")
    expect(status.failures).toEqual([{ id: OPENCLAW_AGENT_STATUS_SURFACE, errorClass: "task-lost" }])
    expect(fetchImpl.posts()).toHaveLength(0)
    expect(responder.status().pending).toBe(0)
    expect(durableSnapshot[0][1]).not.toHaveProperty("shutdownOutcome")
  })

  test("#given a shutdown deadline expires during a SendMessage #when the composition disposes #then shutdown-lost is distinct from crash loss", async () => {
    const order = []
    const storage = spyStorage(order)
    const time = clock()
    let sendStarted
    const started = new Promise((resolve) => { sendStarted = resolve })
    const fetchImpl = async (_url, init = {}) => {
      const body = JSON.parse(init.body)
      if (body.method === "SendMessage") {
        sendStarted()
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })
        })
      }
      throw new Error(`unexpected ${body.method}`)
    }
    const config = {
      enabled: true,
      channels: {
        a2a: {
          enabled: true,
          peers: { alpha: { token: "env:ALPHA_TOKEN", url: PEER_URL } },
        },
      },
    }
    const first = createNativeOpenclaw({
      context: { storage, session: { prompt: async () => ({}) } },
      config,
      env: { ALPHA_TOKEN: "alpha-secret" },
      fetchImpl,
      now: time.now,
      log: () => {},
    })
    await first.ready
    const sending = first.agentCore.responder.send({ sessionID: SESSION_A, peer: "alpha", text: "hello" })
    await started
    time.advance(120_000)

    await first.dispose()
    expect(await sending).toMatchObject({ kind: "failed", errorClass: "shutdown-deadline", shutdownLost: true })
    expect(first.status().agent.surfaces.a2a.errorClass).toBe("task-shutdown-lost")

    const restarted = createNativeOpenclaw({
      context: { storage, session: { prompt: async () => ({}) } },
      config,
      env: { ALPHA_TOKEN: "alpha-secret" },
      fetchImpl,
      now: time.now,
      log: () => {},
    })
    await restarted.ready
    await restarted.agentCore.responder.reconcileOnce()
    const record = restarted.agentCore.registry.list()[0]
    expect(record.state).toBe("shutdown-lost")
    expect(record.remoteTaskId).toBeUndefined()
    await restarted.dispose()
  })

  test("#given an in-flight SendMessage finishes before its reply deadline #when the composition disposes #then the turn drains without a shutdown loss", async () => {
    const order = []
    const storage = spyStorage(order)
    let sendStarted
    let releaseSend
    const started = new Promise((resolve) => { sendStarted = resolve })
    const sendAnswer = new Promise((resolve) => { releaseSend = resolve })
    const fetchImpl = async (_url, init = {}) => {
      const body = JSON.parse(init.body)
      if (body.method !== "SendMessage") throw new Error(`unexpected ${body.method}`)
      sendStarted()
      return sendAnswer
    }
    const config = {
      enabled: true,
      channels: {
        a2a: {
          enabled: true,
          peers: { alpha: { token: "env:ALPHA_TOKEN", url: PEER_URL } },
        },
      },
    }
    const native = createNativeOpenclaw({
      context: { storage, session: { prompt: async () => ({}) } },
      config,
      env: { ALPHA_TOKEN: "alpha-secret" },
      fetchImpl,
      log: () => {},
    })
    await native.ready
    void native.agentCore.responder.send({ sessionID: SESSION_A, peer: "alpha", text: "hello" })
    await started

    const disposing = native.dispose()
    releaseSend({ ok: true, status: 200, text: async () => JSON.stringify(taskAnswer("WORKING")) })
    await disposing

    expect(native.agentCore.registry.list()[0]).toMatchObject({ state: "submitted", remoteTaskId: "task-working" })
    expect(await native.agentCore.responder.send({ sessionID: SESSION_A, peer: "alpha", text: "later" })).toEqual({ kind: "failed", errorClass: "shutting-down" })
    expect(storage.map.size).toBe(1)
  })

  test("#given a drain in flight and no active claim #when shutdown is called #then it waits the reply budget before marking shutdown-lost", async () => {
    const fixture = shutdownFixture()
    await fixture.registry.register({
      peer: "alpha",
      contextId: "rigel-held",
      taskId: "task-held",
      sessionID: SESSION_A,
      agentId: "rigel",
    })
    // The drain sits between claims for the whole test: nothing is on the wire,
    // so no claim carries a deadline shutdown could borrow.
    void fixture.responder.drainConversation("alpha", "rigel-held")

    const shuttingDown = fixture.responder.shutdown()
    // Long enough for an instant give-up to have happened: the pre-fix budget was
    // `Infinity`, which the platform clamps to one millisecond.
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(fixture.registry.list()[0].state).toBe("submitted")
    expect(fixture.timers.scheduled.map((handle) => handle.ms)).toEqual([OPENCLAW_QUEUE_REPLY_TIMEOUT_MS])

    fixture.timers.fireAll()
    expect(await shuttingDown).toEqual({ drained: false, shutdownLost: 1 })
    expect(fixture.registry.list()[0].state).toBe("shutdown-lost")
  })

  test("#given a drain in flight and no active claim #when the drain settles within the budget #then shutdown reports drained", async () => {
    // The claim answers after a real, short delay, and the queue's reply budget is
    // far longer than it, so a shutdown that honours the budget sees the drain
    // finish. The pre-fix budget did not: `Infinity` fires after one millisecond.
    const fixture = shutdownFixture({ replyTimeoutMs: 500, releaseClaimAfterMs: 25 })
    void fixture.responder.drainConversation("alpha", "rigel-held")

    expect(await fixture.responder.shutdown()).toEqual({ drained: true, shutdownLost: 0 })
  })

  test("#given a failed check #when reconciling #then the task stays pending and the failure is reported as a check, not a task failure", async () => {
    const { responder, registry, time, status } = harness({
      send: [taskAnswer("WORKING")],
      getTask: [{ error: { code: -32000, message: "internal" } }],
    })
    await responder.send({ sessionID: SESSION_A, peer: "alpha", text: "hello" })
    time.advance(60_000)
    const pass = await responder.reconcileOnce()
    expect(pass.settled).toBe(0)
    expect(registry.list()[0].state).toBe("submitted")
    expect(status.failures.map((entry) => entry.errorClass)).toContain("get-task-rpc--32000")
  })

  test("#given the peer budget already spent on sends #when reconciling inside the same minute #then no GetTask leaves the process", async () => {
    const answers = Array.from({ length: 30 }, () => taskAnswer("WORKING"))
    const getAnswers = Array.from({ length: 30 }, () => ({ result: { id: "task-working", status: { state: "WORKING" } } }))
    const { responder, fetchImpl, time } = harness({ send: answers, getTask: getAnswers })
    for (let turn = 0; turn < 30; turn += 1) {
      await responder.send({ sessionID: `${SESSION_A}_${turn}`, peer: "alpha", text: `turn ${turn}` })
    }
    // Past the per-record throttle but still inside the peer's minute window.
    time.advance(10_000)
    await responder.reconcileOnce()
    expect(fetchImpl.posts()).toHaveLength(30)

    time.advance(60_000)
    await responder.reconcileOnce()
    expect(fetchImpl.posts().length).toBeGreaterThan(30)
  })

  test("#given a record past the prune horizon #when reconciling #then it is reported as lost instead of lingering", async () => {
    const { responder, registry, status } = harness()
    await registry.register({
      peer: "alpha",
      contextId: "rigel-old",
      taskId: "task-old",
      sessionID: SESSION_A,
      agentId: "rigel",
      createdAt: new Date(START - 8 * 24 * 60 * 60 * 1000).toISOString(),
    })
    const pass = await responder.reconcileOnce()
    expect(pass.lost).toBe(1)
    expect(registry.lookup("alpha", "rigel-old", "task-old")).toBeNull()
    expect(status.failures.map((entry) => entry.errorClass)).toContain("task-lost")
  })

  test("#given a record checked this tick #when reconciling again inside the interval #then no second request is made", async () => {
    const { responder, fetchImpl, time } = harness({
      send: [taskAnswer("WORKING")],
      getTask: [
        { result: { id: "task-working", status: { state: "WORKING" } } },
        { result: { id: "task-working", status: { state: "COMPLETED" } } },
      ],
    })
    await responder.send({ sessionID: SESSION_A, peer: "alpha", text: "hello" })
    time.advance(60_000)
    await responder.reconcileOnce()
    const afterFirst = fetchImpl.posts().length
    await responder.reconcileOnce()
    expect(fetchImpl.posts()).toHaveLength(afterFirst)
  })

  test("#given an answer whose payload names another conversation #when reconciling #then the record's own session still receives it", async () => {
    const deliver = injectionRecorder()
    const { responder, time } = harness({
      send: [taskAnswer("WORKING")],
      getTask: [{
        result: {
          id: "task-working",
          // The vendor task is bound to the context of session A; the record is
          // session B's. Nothing in the payload may move the injection.
          contextId: "rigel-context-of-session-a",
          status: { state: "COMPLETED" },
          artifacts: [{ parts: [{ text: "answer for B only" }] }],
        },
      }],
      deliver,
    })
    await responder.send({ sessionID: SESSION_B, peer: "alpha", text: "hello" })
    time.advance(60_000)
    await responder.reconcileOnce()
    expect(deliver.calls).toHaveLength(1)
    expect(deliver.calls[0].sessionID).toBe(SESSION_B)
  })

  test("#given two sessions #when each sends #then their conversations are distinct and a task cannot be moved to the other", async () => {
    const { responder } = harness({
      send: [taskAnswer("WORKING"), taskAnswer("WORKING"), taskAnswer("WORKING")],
    })
    const first = await responder.send({ sessionID: SESSION_A, peer: "alpha", text: "one" })
    const second = await responder.send({ sessionID: SESSION_B, peer: "alpha", text: "two" })
    expect(deriveOpenclawContextId(SESSION_A)).not.toBe(deriveOpenclawContextId(SESSION_B))
    expect(first.taskId).not.toBe(second.taskId)

    // A deliberately shared conversation is allowed once, and refused for a
    // second session: two sessions may not own one contextId.
    const bound = await responder.send({ sessionID: SESSION_A, peer: "alpha", text: "three", contextId: "rigel-shared" })
    expect(bound.kind).toBe("task")
    const stolen = await responder.send({ sessionID: SESSION_B, peer: "alpha", text: "four", contextId: "rigel-shared" })
    expect(stolen).toEqual({ kind: "failed", errorClass: "invalid-context" })
  })
})

describe("openclaw A2A composition", () => {
  const namespaceConfig = {
    enabled: true,
    gateways: { h: { url: "https://gateway.test/h" } },
    hooks: { "session.created": { gateway: "h", instruction: "go" } },
    channels: { a2a: { enabled: true, peers: { alpha: { token: "env:ALPHA_TOKEN", url: PEER_URL } } } },
  }

  function compose(config, { fetchImpl, storage } = {}) {
    const order = []
    const store = storage ?? spyStorage(order)
    const native = createNativeOpenclaw({
      context: { storage: store, session: { prompt: async () => ({}) } },
      config,
      fetchImpl,
      env: { ALPHA_TOKEN: "alpha-secret" },
      log: () => {},
    })
    return { native, order, store }
  }

  test("#given a dialable A2A peer #when setup runs #then there is no discovery request and the responder is reconciling", async () => {
    const fetchImpl = a2aFetch([])
    const { native } = compose(namespaceConfig, { fetchImpl })
    const ready = await native.ready

    expect(fetchImpl.calls).toHaveLength(0)
    expect(ready).toMatchObject({ started: false })
    expect(native.status().agent.dialablePeers).toEqual(["alpha"])
    expect(native.agentCore.responder.status().reconciling).toBe(true)
    await native.dispose()
    expect(native.agentCore.responder.status().reconciling).toBe(false)
  })

  test("#given a peer with a broken secret reference #when composed #then the peer is named once and never dialable", async () => {
    const lines = []
    const native = createNativeOpenclaw({
      context: { storage: spyStorage([]), session: { prompt: async () => ({}) } },
      config: { enabled: true, channels: { a2a: { enabled: true, peers: { alpha: { token: "env:NOT_SET_ANYWHERE", url: PEER_URL } } } } },
      fetchImpl: a2aFetch([]),
      env: {},
      log: (line) => lines.push(line),
    })
    await native.ready
    expect(native.status().agent.dialablePeers).toEqual([])
    expect(native.agentCore.responder.status().reconciling).toBe(false)
    expect(lines.filter((line) => line.includes("NOT_SET_ANYWHERE"))).toHaveLength(1)
    await native.dispose()
  })

  test("#given a slow A2A send in flight #when a session.created arrives #then the shared event path is not held behind it", async () => {
    let releaseSend
    const pendingSend = new Promise((resolve) => { releaseSend = resolve })
    const fetchImpl = a2aFetch([], {
      send: [() => pendingSend],
    })
    // The legacy gateway answer, so the event path has a real observable.
    const eventFetch = async (url, init = {}) => {
      if (url === "https://gateway.test/h") return { ok: true, status: 200, text: async () => '{"messageId":"m1","platform":"discord"}' }
      return fetchImpl(url, init)
    }
    const { native } = compose(namespaceConfig, { fetchImpl: eventFetch })
    await native.ready

    const conversation = native.agentCore.responder.send({ sessionID: SESSION_A, peer: "alpha", text: "a long question" })
    // The request has to be on the wire for the assertion to mean anything.
    await waitFor(() => fetchImpl.posts().length === 1, "the pending SendMessage")

    const dispatched = await native.handleEvent({ type: "session.created", sessionID: SESSION_A, projectPath: "/p" })
    expect(dispatched).toMatchObject({ success: true, messageId: "m1" })
    // The A2A request is still unresolved while the shared event path completed.
    expect(fetchImpl.posts()).toHaveLength(1)

    releaseSend({ ok: true, status: 200, text: async () => JSON.stringify(taskAnswer("WORKING")) })
    expect(await conversation).toMatchObject({ kind: "task" })
    await native.dispose()
  })

  test("#given a legacy configuration #when composed #then the conversational surface does not exist at all", async () => {
    const { native } = compose({ enabled: true, gateways: { h: { url: "https://gateway.test/h" } }, hooks: {} }, { fetchImpl: a2aFetch([]) })
    expect(native.agentCore).toBeNull()
    expect(native.status()).toEqual({ enabled: true, registry: 0, started: false })
    await native.ready
    await native.dispose()
  })
})

describe("openclaw A2A reconciliation hardening", () => {
  test("#given two reconciliation passes started together #when both reach the same pending task #then the peer is asked once and the answer is injected once", async () => {
    const deliver = injectionRecorder()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const completed = {
      result: { id: "task-working", status: { state: "COMPLETED" }, artifacts: [{ parts: [{ text: "the answer" }] }] },
    }
    const { responder, time, fetchImpl } = harness({
      send: [taskAnswer("WORKING")],
      // Both passes must be able to reach the peer, or the assertion would be
      // about the double's script instead of about the overlap.
      getTask: [() => gate, () => gate],
      deliver,
    })
    await responder.send({ sessionID: SESSION_A, peer: "alpha", text: "hello" })
    time.advance(60_000)

    const getTaskCalls = () => fetchImpl.posts().filter((call) => JSON.parse(call.init.body).method === "GetTask")
    const passes = [responder.reconcileOnce(), responder.reconcileOnce()]
    await waitFor(() => getTaskCalls().length >= 1, "the first GetTask")
    release({ ok: true, status: 200, text: async () => JSON.stringify(completed) })
    await Promise.all(passes)

    expect(getTaskCalls()).toHaveLength(1)
    expect(deliver.calls).toEqual([{ sessionID: SESSION_A, text: `${agentReplyPrefix("alpha")}the answer` }])
  })

  test("#given a pending set larger than the peer's minute budget #when the next window opens #then the records the first window could not reach are polled", async () => {
    const total = 40
    const { responder, registry, time, fetchImpl } = harness({
      getTask: Array.from({ length: total * 2 }, () => ({ result: { id: "task-bulk", status: { state: "WORKING" } } })),
    })
    for (let index = 0; index < total; index += 1) {
      await registry.register({
        peer: "alpha",
        contextId: `rigel-bulk-${index}`,
        taskId: `task-bulk-${index}`,
        sessionID: `${SESSION_A}_${index}`,
        agentId: "rigel",
        remoteTaskId: `remote-bulk-${index}`,
        createdAt: new Date(START - 600_000).toISOString(),
      })
    }
    const polled = () => fetchImpl.posts()
      .filter((call) => JSON.parse(call.init.body).method === "GetTask")
      .map((call) => JSON.parse(call.init.body).params.id)

    await responder.reconcileOnce()
    const firstWindow = new Set(polled())
    expect(firstWindow.size).toBe(OPENCLAW_A2A_REQUESTS_PER_MINUTE)

    // The window rolls over; the pass that starts now must reach the tail rather
    // than spending the whole budget on the same heads again.
    time.advance(61_000)
    await responder.reconcileOnce()
    const secondWindow = new Set(polled().slice(firstWindow.size))

    expect(new Set([...firstWindow, ...secondWindow]).size).toBe(total)
  })

  test("#given a send the peer accepted #when the request returns #then the a2a surface records recovery", async () => {
    const { responder, status } = harness({ send: [taskAnswer("WORKING")] })
    await responder.send({ sessionID: SESSION_A, peer: "alpha", text: "hello" })
    expect(status.successes.filter((id) => id === OPENCLAW_AGENT_STATUS_SURFACE)).toHaveLength(1)
  })

  test("#given a task still working #when reconciliation reads it #then the healthy check also records recovery", async () => {
    const { responder, time, status } = harness({
      send: [taskAnswer("WORKING")],
      getTask: [{ result: { id: "task-working", status: { state: "WORKING" } } }],
    })
    await responder.send({ sessionID: SESSION_A, peer: "alpha", text: "hello" })
    time.advance(60_000)
    await responder.reconcileOnce()
    // One recovery for the accepted send, one for the healthy check.
    expect(status.successes.filter((id) => id === OPENCLAW_AGENT_STATUS_SURFACE)).toHaveLength(2)
  })
})

describe("openclaw A2A conversation ownership", () => {
  test("#given a session that derived its conversation #when another session names that context #then it is refused and only the owner holds a record", async () => {
    const { responder, registry } = harness({ send: [taskAnswer("WORKING"), taskAnswer("WORKING"), taskAnswer("WORKING")] })
    const derived = deriveOpenclawContextId(SESSION_A)

    const owned = await responder.send({ sessionID: SESSION_A, peer: "alpha", text: "mine" })
    const stolen = await responder.send({ sessionID: SESSION_B, peer: "alpha", text: "not mine", contextId: derived })

    expect(owned.kind).toBe("task")
    expect(stolen).toEqual({ kind: "failed", errorClass: "invalid-context" })
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]).toMatchObject({ sessionID: SESSION_A, contextId: derived })

    // The refused claim must not poison the owner's binding: the owner continues
    // its own conversation.
    expect(await responder.send({ sessionID: SESSION_A, peer: "alpha", text: "one more" })).toMatchObject({ kind: "task" })
  })

  test("#given a conversation hydrated from a previous process #when another session names it #then it is refused before any turn runs here", async () => {
    const order = []
    const storage = spyStorage(order)
    const time = clock()
    const contextId = deriveOpenclawContextId(SESSION_A)
    const writer = createOpenclawAgentRegistry({ storage, now: time.now })
    await writer.register({ peer: "alpha", contextId, taskId: "task-earlier", sessionID: SESSION_A, agentId: "rigel" })

    // A new process: the in-memory binding map is empty, the durable record is not.
    const registry = createOpenclawAgentRegistry({ storage, now: time.now })
    await registry.hydrate()
    const queue = createOpenclawAgentQueue({ registry, now: time.now })
    const resolved = resolveOpenclawAgentPeers(
      { enabled: true, peers: { alpha: { token: "env:ALPHA_TOKEN", url: PEER_URL } } },
      { env: { ALPHA_TOKEN: "alpha-secret" } },
    )
    const fetchImpl = a2aFetch(order, { send: [taskAnswer("WORKING")] })
    const transport = createOpenclawAgentTransport({ peers: resolved.peers, fetchImpl })
    const responder = createOpenclawAgentResponder({
      peers: resolved.peers,
      registry,
      queue,
      transport,
      deliverAgentReply: injectionRecorder(),
      now: time.now,
    })

    const stolen = await responder.send({ sessionID: SESSION_B, peer: "alpha", text: "not mine", contextId })
    expect(stolen).toEqual({ kind: "failed", errorClass: "invalid-context" })
    expect(fetchImpl.posts()).toHaveLength(0)
  })

  test("#given a turn admitted while the last send of a drain is in flight #when the drain ends #then that turn is still sent", async () => {
    // The queue admits at most eight pending entries per conversation, so the turn
    // that lands while the last send is on the wire is the one an iteration cap
    // would strand: its payload survives, reconciliation skips it, and no other
    // path reopens the conversation.
    const gates = []
    const working = { ok: true, status: 200, text: async () => JSON.stringify(taskAnswer("WORKING")) }
    const rejected = { ok: true, status: 200, text: async () => JSON.stringify(taskAnswer("REJECTED")) }
    const answers = [
      ...Array.from({ length: 8 }, () => () => new Promise((resolve) => { gates.push(resolve) })),
      () => working,
    ]
    const { responder, queue, registry, fetchImpl } = harness({ send: answers })

    const first = responder.send({ sessionID: SESSION_A, peer: "alpha", text: "t1" })
    await waitFor(() => gates.length === 1, "the first SendMessage")
    for (let turn = 2; turn <= 8; turn += 1) {
      expect(await responder.send({ sessionID: SESSION_A, peer: "alpha", text: `t${turn}` })).toMatchObject({ kind: "task", queued: true })
    }
    gates[0](working)
    // A rejected send is the one way to free a queue entry while the drain runs.
    await waitFor(() => gates.length === 2, "the second SendMessage")
    gates[1](rejected)
    for (let index = 2; index <= 6; index += 1) {
      await waitFor(() => gates.length === index + 1, `SendMessage #${index + 1}`)
      gates[index](working)
    }
    await waitFor(() => gates.length === 8, "the eighth SendMessage")

    const ninth = await responder.send({ sessionID: SESSION_A, peer: "alpha", text: "t9" })
    expect(ninth).toMatchObject({ kind: "task", queued: true })
    gates[7](working)
    await first

    expect(fetchImpl.posts().filter((call) => JSON.parse(call.init.body).method === "SendMessage")).toHaveLength(9)
    expect(registry.list().filter((record) => typeof record.remoteTaskId === "string")).toHaveLength(9)
    // No record is left written-ahead with a payload and no vendor id: that is the
    // stranded turn the capped pass produced, which nothing else could ever send.
    const stranded = registry.list().filter(
      (record) => record.remoteTaskId === undefined && queue.hasPayload(record.peer, record.contextId, record.taskId),
    )
    expect(stranded).toHaveLength(0)
  })
})
