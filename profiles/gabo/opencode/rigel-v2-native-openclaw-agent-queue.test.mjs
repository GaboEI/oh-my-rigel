import { describe, expect, test } from "bun:test"
import {
  OPENCLAW_QUEUE_MAX_PAYLOAD_BYTES,
  OPENCLAW_QUEUE_RATE_LIMIT_PER_MINUTE,
  OPENCLAW_QUEUE_REPLY_TIMEOUT_MS,
  OPENCLAW_QUEUE_STATUS_SURFACE,
  createOpenclawAgentQueue,
  truncateToBytes,
} from "./rigel-v2-native-openclaw-agent-queue.mjs"
import { createOpenclawAgentRegistry } from "./rigel-v2-native-openclaw-agent-registry.mjs"

const CONTEXT = "rigel-0123456789abcdef01234567"

function memoryStorage() {
  const map = new Map()
  return {
    map,
    get: async (key) => map.get(key),
    set: async (key, value) => { map.set(key, value) },
    remove: async (key) => { map.delete(key) },
    scan: async ({ prefix } = {}) => ({
      entries: [...map.entries()]
        .filter(([key]) => (prefix ? key.startsWith(prefix) : true))
        .map(([key, value]) => ({ key, value })),
    }),
  }
}

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

async function waitForSignal(signal, description) {
  let timeout
  try {
    await Promise.race([
      signal,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`waited 5s for ${description}`)), 5_000)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

function storageWithBlockedFirstWrite() {
  const map = new Map()
  const firstWrite = deferred()
  const releaseFirstWrite = deferred()
  let first = true
  return {
    map,
    firstWrite,
    releaseFirstWrite,
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value)
      if (!first) return
      first = false
      firstWrite.resolve()
      await releaseFirstWrite.promise
    },
    remove: async (key) => { map.delete(key) },
    scan: async ({ prefix } = {}) => ({
      entries: [...map.entries()]
        .filter(([key]) => (prefix ? key.startsWith(prefix) : true))
        .map(([key, value]) => ({ key, value })),
    }),
  }
}

function statusRecorder() {
  const failures = []
  const successes = []
  const truncations = []
  const rateLimits = []
  return {
    failures,
    successes,
    truncations,
    rateLimits,
    recordFailure: async (id, info) => { failures.push({ id, errorClass: info?.errorClass }) },
    recordSuccess: async (id) => { successes.push(id) },
    recordTruncation: async (id) => { truncations.push(id) },
    recordRateLimit: async (id) => { rateLimits.push(id) },
  }
}

function harness(options = {}) {
  const storage = memoryStorage()
  const registry = createOpenclawAgentRegistry({ storage, now: () => Date.parse("2026-01-01T00:00:00.000Z") })
  const status = statusRecorder()
  const queue = createOpenclawAgentQueue({ registry, status, now: () => Date.parse("2026-01-01T00:00:00.000Z"), ...options })
  return { storage, registry, status, queue }
}

const message = (overrides = {}) => ({
  peer: "peer-alpha",
  contextId: CONTEXT,
  taskId: "task-1",
  sessionID: "ses_1",
  agentId: "sisyphus",
  text: "hello peer",
  ...overrides,
})

describe("openclaw agent queue contracts", () => {
  test("#given the default limits #when reading them #then they are the values the contract fixes", () => {
    expect(OPENCLAW_QUEUE_MAX_PAYLOAD_BYTES).toBe(64 * 1024)
    expect(OPENCLAW_QUEUE_RATE_LIMIT_PER_MINUTE).toBe(30)
    expect(OPENCLAW_QUEUE_REPLY_TIMEOUT_MS).toBe(120_000)
    expect(OPENCLAW_QUEUE_STATUS_SURFACE).toBe("agent-queue")
  })

  test("#given an accepted message #when claiming #then the payload comes back with a deadline and a taken slot", async () => {
    const { queue, registry } = harness()
    const accepted = await queue.enqueue(message())
    expect(accepted).toEqual({ accepted: true, taskId: "task-1", bytes: 10, truncated: false })
    expect(queue.pendingFor("peer-alpha", CONTEXT)).toBe(1)
    const claim = await queue.claimNext("peer-alpha", CONTEXT)
    expect(claim).toMatchObject({ taskId: "task-1", text: "hello peer", attempts: 1 })
    expect(claim.deadlineAt - claim.claimedAt).toBe(OPENCLAW_QUEUE_REPLY_TIMEOUT_MS)
    expect(registry.hasInflight("peer-alpha", CONTEXT)).toBe(true)
    // A second claim on the same conversation must not overlap: OpenClaw would
    // complete the wrong task.
    expect(await queue.claimNext("peer-alpha", CONTEXT)).toBeNull()
  })

  test("#given a claimed task #when settled #then the payload is dropped and the slot frees", async () => {
    const { queue } = harness()
    await queue.enqueue(message({ taskId: "task-1" }))
    await queue.enqueue(message({ taskId: "task-2" }))
    await queue.claimNext("peer-alpha", CONTEXT)
    expect(await queue.settle({ peer: "peer-alpha", contextId: CONTEXT, taskId: "task-1", state: "completed" })).toBe(true)
    expect(queue.pendingFor("peer-alpha", CONTEXT)).toBe(1)
    expect(await queue.claimNext("peer-alpha", CONTEXT)).toMatchObject({ taskId: "task-2" })
  })

  test("#given a released claim #when reading the queue #then the task is still pending and the send is not retried blindly", async () => {
    const { queue } = harness()
    await queue.enqueue(message())
    await queue.claimNext("peer-alpha", CONTEXT)
    expect(await queue.release({ peer: "peer-alpha", contextId: CONTEXT, taskId: "task-1" })).toBe(true)
    expect(queue.pendingFor("peer-alpha", CONTEXT)).toBe(1)
    expect(await queue.claimNext("peer-alpha", CONTEXT)).toMatchObject({ taskId: "task-1", attempts: 2 })
  })

  test("#given a conversation at its depth #when enqueuing #then the rejection is named and reported as degraded", async () => {
    const { queue, status } = harness({ maxPerConversation: 1 })
    await queue.enqueue(message({ taskId: "task-1" }))
    expect(await queue.enqueue(message({ taskId: "task-2" }))).toEqual({ accepted: false, reason: "conversation-full" })
    expect(queue.pendingFor("peer-alpha", CONTEXT)).toBe(1)
    expect(status.failures).toEqual([{ id: OPENCLAW_QUEUE_STATUS_SURFACE, errorClass: "conversation-full" }])
  })

  test("#given the whole queue at its depth #when enqueuing another conversation #then the rejection is named and reported", async () => {
    const { queue, status } = harness({ maxPending: 1, maxPerConversation: 4 })
    await queue.enqueue(message({ taskId: "task-1" }))
    expect(await queue.enqueue(message({ contextId: "rigel-other", taskId: "task-2" }))).toEqual({ accepted: false, reason: "queue-full" })
    expect(queue.pendingTotal()).toBe(1)
    expect(status.failures).toEqual([{ id: OPENCLAW_QUEUE_STATUS_SURFACE, errorClass: "queue-full" }])
  })

  test("#given concurrent registrations at both depth limits #when both reserve before persistence #then only one task is admitted", async () => {
    const storage = storageWithBlockedFirstWrite()
    const registry = createOpenclawAgentRegistry({ storage, now: () => Date.parse("2026-01-01T00:00:00.000Z") })
    const queue = createOpenclawAgentQueue({ registry, maxPerConversation: 1, maxPending: 1, now: () => Date.parse("2026-01-01T00:00:00.000Z") })

    const first = queue.enqueue(message({ taskId: "task-1" }))
    const second = queue.enqueue(message({ taskId: "task-2" }))
    await waitForSignal(storage.firstWrite.promise, "the first durable registration write")
    storage.releaseFirstWrite.resolve()

    await expect(first).resolves.toMatchObject({ accepted: true, taskId: "task-1" })
    await expect(second).resolves.toEqual({ accepted: false, reason: "conversation-full" })
    expect(queue.pendingTotal()).toBe(1)
    expect(queue.pendingFor("peer-alpha", CONTEXT)).toBe(1)
  })

  test("#given a rejected durable registration #when its reservation rolls back #then the released capacity admits a later task", async () => {
    let accepted = false
    const registry = {
      lookup: () => null,
      register: async () => {
        if (accepted) return true
        accepted = true
        return false
      },
    }
    const queue = createOpenclawAgentQueue({ registry, maxPerConversation: 1, maxPending: 1 })

    expect(await queue.enqueue(message({ taskId: "task-rejected" }))).toEqual({ accepted: false, reason: "invalid-record" })
    expect(queue.pendingTotal()).toBe(0)
    await expect(queue.enqueue(message({ taskId: "task-live" }))).resolves.toMatchObject({ accepted: true, taskId: "task-live" })
    expect(queue.pendingTotal()).toBe(1)
  })

  test("#given a claim interleaved with its durable registration #when the payload is reserved #then the accepted task is neither lost nor claimed early", async () => {
    const storage = storageWithBlockedFirstWrite()
    const registry = createOpenclawAgentRegistry({ storage, now: () => Date.parse("2026-01-01T00:00:00.000Z") })
    const queue = createOpenclawAgentQueue({ registry, now: () => Date.parse("2026-01-01T00:00:00.000Z") })

    const enqueuing = queue.enqueue(message({ taskId: "task-1" }))
    await waitForSignal(storage.firstWrite.promise, "the durable registration write")
    expect(await queue.claimNext("peer-alpha", CONTEXT)).toBeNull()
    storage.releaseFirstWrite.resolve()

    await expect(enqueuing).resolves.toMatchObject({ accepted: true, taskId: "task-1" })
    expect(registry.lookup("peer-alpha", CONTEXT, "task-1")).toMatchObject({ state: "submitted", inflight: false })
    await expect(queue.claimNext("peer-alpha", CONTEXT)).resolves.toMatchObject({ taskId: "task-1", text: "hello peer" })
  })

  test("#given a payload over the byte cap #when enqueuing #then it is truncated at a code-point boundary and only counted", async () => {
    const { queue, status } = harness({ maxPayloadBytes: 4 })
    const accepted = await queue.enqueue(message({ text: "ab\u20acde" }))
    expect(accepted).toEqual({ accepted: true, taskId: "task-1", bytes: 2, truncated: true })
    // The euro sign is three bytes; writing it half would corrupt the prompt.
    expect((await queue.claimNext("peer-alpha", CONTEXT)).text).toBe("ab")
    // §9.3: truncation is an aggregate counter, never a line.
    expect(status.truncations).toEqual([OPENCLAW_QUEUE_STATUS_SURFACE])
    expect(status.failures).toEqual([])
  })

  test("#given the per-peer minute budget #when the next message arrives #then it is dropped as rate-limited without a failure line", async () => {
    const { queue, status } = harness({ rateLimitPerMinute: 2 })
    await queue.enqueue(message({ taskId: "task-1" }))
    await queue.enqueue(message({ taskId: "task-2" }))
    expect(await queue.enqueue(message({ taskId: "task-3" }))).toEqual({ accepted: false, reason: "rate-limited" })
    expect(status.rateLimits).toEqual([OPENCLAW_QUEUE_STATUS_SURFACE])
    // Rate-limit jitter is not a state change: nothing reaches the failure channel.
    expect(status.failures).toEqual([])
    // A different peer has its own budget.
    expect((await queue.enqueue(message({ peer: "peer-beta", taskId: "task-4" }))).accepted).toBe(true)
  })

  test("#given a durable record whose payload never reached this process #when claiming #then the task is reported lost and the next one is considered", async () => {
    const storage = memoryStorage()
    const first = createOpenclawAgentRegistry({ storage, now: () => Date.parse("2026-01-01T00:00:00.000Z") })
    // Simulates a crash between the write-ahead and the send: the record exists,
    // the in-memory payload does not.
    await first.register({ peer: "peer-alpha", agentId: "sisyphus", contextId: CONTEXT, taskId: "task-crashed", sessionID: "ses_1", createdAt: "2026-01-01T00:00:00.000Z" })
    const registry = createOpenclawAgentRegistry({ storage, now: () => Date.parse("2026-01-01T00:00:01.000Z") })
    await registry.hydrate()
    const queue = createOpenclawAgentQueue({ registry, now: () => Date.parse("2026-01-01T00:00:01.000Z") })
    await queue.enqueue(message({ taskId: "task-live" }))
    const claim = await queue.claimNext("peer-alpha", CONTEXT)
    expect(claim).toMatchObject({ taskId: "task-live", text: "hello peer" })
    expect(registry.lookup("peer-alpha", CONTEXT, "task-crashed")).toMatchObject({ state: "lost" })
  })

  test("#given an invalid message #when enqueuing #then each rejection names its cause and writes nothing", async () => {
    const { queue, registry } = harness()
    expect(await queue.enqueue(message({ peer: "" }))).toEqual({ accepted: false, reason: "invalid-identity" })
    expect(await queue.enqueue(message({ taskId: "" }))).toEqual({ accepted: false, reason: "invalid-identity" })
    expect(await queue.enqueue(message({ sessionID: "" }))).toEqual({ accepted: false, reason: "invalid-payload" })
    expect(await queue.enqueue(message({ agentId: "" }))).toEqual({ accepted: false, reason: "invalid-payload" })
    expect(await queue.enqueue(message({ text: "" }))).toEqual({ accepted: false, reason: "invalid-payload" })
    expect(queue.pendingTotal()).toBe(0)
    expect(registry.size()).toBe(0)
  })

  test("#given a task already in the conversation #when the same task is enqueued again #then it is rejected instead of producing a second entry", async () => {
    const { queue, status } = harness()
    await queue.enqueue(message({ taskId: "task-1" }))
    expect(await queue.enqueue(message({ taskId: "task-1" }))).toEqual({ accepted: false, reason: "duplicate-task" })
    expect(await queue.enqueue(message({ taskId: "task-1" }))).toEqual({ accepted: false, reason: "duplicate-task" })
    expect(queue.pendingFor("peer-alpha", CONTEXT)).toBe(1)
    expect(status.failures).toEqual([
      { id: OPENCLAW_QUEUE_STATUS_SURFACE, errorClass: "duplicate-task" },
      { id: OPENCLAW_QUEUE_STATUS_SURFACE, errorClass: "duplicate-task" },
    ])
  })

  test("#given a claimed task past its deadline #when checked #then it is expired", async () => {
    let clock = Date.parse("2026-01-01T00:00:00.000Z")
    const { queue } = harness({ now: () => clock, replyTimeoutMs: 1000 })
    await queue.enqueue(message())
    const claim = await queue.claimNext("peer-alpha", CONTEXT)
    expect(queue.isExpired(claim)).toBe(false)
    clock += 1000
    expect(queue.isExpired(claim)).toBe(true)
    expect(queue.isExpired(null)).toBe(false)
  })

  test("#given a drained queue #when cleared #then nothing is left pending", async () => {
    const { queue } = harness()
    await queue.enqueue(message({ taskId: "task-1" }))
    await queue.enqueue(message({ contextId: "rigel-other", taskId: "task-2" }))
    expect(queue.pendingTotal()).toBe(2)
    queue.clearAll()
    expect(queue.pendingTotal()).toBe(0)
    expect(queue.pendingFor("peer-alpha", CONTEXT)).toBe(0)
  })
})

describe("openclaw queue payload bounding", () => {
  test("#given bytes under the cap #when truncating #then the text is untouched", () => {
    expect(truncateToBytes("hello", 64)).toEqual({ text: "hello", truncated: false })
  })

  test("#given a multi-byte character straddling the cap #when truncating #then it is dropped whole", () => {
    expect(truncateToBytes("ab\u20ac", 4)).toEqual({ text: "ab", truncated: true })
    expect(truncateToBytes("abcde", 3)).toEqual({ text: "abc", truncated: true })
    expect(truncateToBytes("\u20ac\u20ac", 3)).toEqual({ text: "\u20ac", truncated: true })
  })
})

describe("openclaw agent queue idempotency", () => {
  test("#given a task already settled #when the same task is enqueued again #then the correlation key still refuses a second task", async () => {
    const { queue, registry } = harness()
    await queue.enqueue(message({ taskId: "task-1" }))
    await queue.claimNext("peer-alpha", CONTEXT)
    await queue.settle({ peer: "peer-alpha", contextId: CONTEXT, taskId: "task-1", state: "completed" })
    expect(queue.pendingFor("peer-alpha", CONTEXT)).toBe(0)
    expect(await queue.enqueue(message({ taskId: "task-1" }))).toEqual({ accepted: false, reason: "duplicate-task" })
    expect(registry.size()).toBe(1)
    expect(queue.pendingTotal()).toBe(0)
  })
})
