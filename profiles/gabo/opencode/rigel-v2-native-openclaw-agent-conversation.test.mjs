import { describe, expect, test } from "bun:test"
import { createNativeOpenclaw } from "./rigel-v2-native-openclaw.mjs"
import {
  OPENCLAW_AGENT_REGISTRY_PREFIX,
  createOpenclawAgentRegistry,
  deriveOpenclawContextId,
} from "./rigel-v2-native-openclaw-agent-registry.mjs"
import { createOpenclawAgentQueue } from "./rigel-v2-native-openclaw-agent-queue.mjs"
import {
  OPENCLAW_AGENT_REPLY_SURFACE,
  agentReplyPrefix,
  createOpenclawAgentResponder,
} from "./rigel-v2-native-openclaw-agent-responder.mjs"
import {
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

function harness({ send = [], getTask = [], deliver = injectionRecorder(), peers } = {}) {
  const order = []
  const time = clock()
  const storage = spyStorage(order)
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
    const { responder, registry, status } = harness()
    // Exactly the state a crash between write-ahead and send leaves behind: a
    // record and no payload to send, so no vendor id can ever be learned.
    await registry.register({ peer: "alpha", contextId: "rigel-crashed", taskId: "task-crashed", sessionID: SESSION_A, agentId: "rigel" })
    const pass = await responder.reconcileOnce()

    expect(pass.lost).toBe(1)
    expect(registry.lookup("alpha", "rigel-crashed", "task-crashed").state).toBe("lost")
    expect(status.failures.map((entry) => entry.errorClass)).toContain("task-lost")
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
