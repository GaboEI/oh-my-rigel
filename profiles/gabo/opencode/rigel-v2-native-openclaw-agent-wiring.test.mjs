import { describe, expect, test } from "bun:test"
import { createNativeOpenclaw } from "./rigel-v2-native-openclaw.mjs"
import { OPENCLAW_AGENT_REGISTRY_PREFIX } from "./rigel-v2-native-openclaw-agent-registry.mjs"
import { OPENCLAW_REGISTRY_PREFIX } from "./rigel-v2-native-openclaw-registry.mjs"
import { OPENCLAW_STATUS_KEY } from "./rigel-v2-native-openclaw-agent-status.mjs"

/**
 * Storage spy: records every domain call in order, so the "nothing new happens
 * on the legacy path" claim is asserted as a call sequence instead of a promise.
 */
function spyStorage() {
  const map = new Map()
  const ops = []
  return {
    map,
    ops,
    get: async (key) => { ops.push({ op: "get", key }); return map.get(key) },
    set: async (key, value) => { ops.push({ op: "set", key }); map.set(key, value) },
    remove: async (key) => { ops.push({ op: "remove", key }); map.delete(key) },
    scan: async ({ prefix } = {}) => {
      ops.push({ op: "scan", prefix })
      return {
        entries: [...map.entries()]
          .filter(([key]) => (prefix ? key.startsWith(prefix) : true))
          .map(([key, value]) => ({ key, value })),
      }
    },
  }
}

function spyFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => { calls.push({ url, init }); return handler(url, init) }
  fetchImpl.calls = calls
  return fetchImpl
}

function gatewayFetch() {
  return spyFetch(async () => ({ ok: true, status: 200, text: async () => '{"messageId":"m1","platform":"discord"}' }))
}

const LEGACY_CONFIG = {
  enabled: true,
  gateways: { h: { url: "https://gateway.test/h" } },
  hooks: { "session.idle": { gateway: "h", instruction: "go" } },
}

function context(storage) {
  return { storage, session: { prompt: async () => ({}) } }
}

function namespaceKeys(ops) {
  return ops.filter((op) => (op.key ?? op.prefix ?? "").startsWith(OPENCLAW_AGENT_REGISTRY_PREFIX))
}

describe("openclaw composition: legacy path is untouched", () => {
  test("#given a legacy config #when the surface is composed #then no agent core exists and the status surface keeps its exact keys", async () => {
    const storage = spyStorage()
    const native = createNativeOpenclaw({ context: context(storage), config: LEGACY_CONFIG, fetchImpl: gatewayFetch(), log: () => {} })
    expect(native.agentCore).toBeNull()
    expect(Object.keys(native.status()).sort()).toEqual(["enabled", "registry", "started"])
    await native.ready
    await native.dispose()
  })

  test("#given a legacy config #when setup runs #then it issues zero network calls", async () => {
    const storage = spyStorage()
    const fetchImpl = gatewayFetch()
    const native = createNativeOpenclaw({ context: context(storage), config: LEGACY_CONFIG, fetchImpl, log: () => {} })
    const ready = await native.ready
    // No credentials, so no listener. The point is the count: setup alone must
    // never reach the network (Contrato_Transportes_OpenClaw.md §11.3).
    expect(ready.started).toBe(false)
    expect(fetchImpl.calls).toHaveLength(0)
    await native.dispose()
  })

  test("#given a legacy config #when one session.idle fires #then the call sequence is exactly one POST to the gateway and no discovery GET", async () => {
    const storage = spyStorage()
    const fetchImpl = gatewayFetch()
    const native = createNativeOpenclaw({ context: context(storage), config: LEGACY_CONFIG, fetchImpl, log: () => {} })
    await native.ready
    const result = await native.handleEvent({ type: "session.idle", sessionID: "s1", projectPath: "/p" })

    expect(result).toMatchObject({ success: true, messageId: "m1" })
    // Same count, same order: one dispatch, nothing else.
    expect(fetchImpl.calls.map((call) => call.url)).toEqual(["https://gateway.test/h"])
    expect(fetchImpl.calls[0].init.method).toBe("POST")
    // The regression this pins: no lazily-discovered agent endpoint is probed.
    expect(fetchImpl.calls.some((call) => call.init.method === "GET")).toBe(false)
    expect(fetchImpl.calls.some((call) => call.url.includes(".well-known"))).toBe(false)

    // Storage speaks only the chat key space: the agent registry and the status
    // document are never constructed, so they cannot write or scan.
    expect(namespaceKeys(storage.ops)).toEqual([])
    expect(storage.ops.some((op) => op.key === OPENCLAW_STATUS_KEY)).toBe(false)
    expect(storage.ops.filter((op) => op.op === "scan").map((op) => op.prefix)).toEqual([OPENCLAW_REGISTRY_PREFIX])
    expect(storage.ops.filter((op) => op.op === "set").every((op) => op.key.startsWith(OPENCLAW_REGISTRY_PREFIX))).toBe(true)
    expect(native.status().registry).toBe(1)
    await native.dispose()
  })
})

describe("openclaw composition: new namespace owns the queue", () => {
  const namespaceConfig = { enabled: true, channels: { a2a: { enabled: true, peers: { alpha: { token: "env:ALPHA_TOKEN" } } } } }

  test("#given a legacy config #when composed #then the queue does not exist at all", () => {
    const native = createNativeOpenclaw({ context: context(spyStorage()), config: LEGACY_CONFIG, fetchImpl: gatewayFetch(), log: () => {} })
    // The queue must never sit on the current path: no new namespace, no queue.
    expect(native.agentCore?.queue).toBeUndefined()
    expect(native.status().agent).toBeUndefined()
  })

  test("#given a declared channel #when composed #then the agent core exists with its queue and status document", async () => {
    const storage = spyStorage()
    const fetchImpl = gatewayFetch()
    const native = createNativeOpenclaw({ context: context(storage), config: namespaceConfig, fetchImpl, log: () => {} })
    expect(native.agentCore).not.toBeNull()
    expect(native.agentCore.queue).toBeDefined()
    expect(native.agentCore.registry).toBeDefined()
    expect(native.agentCore.status).toBeDefined()

    await native.ready
    // Setup reads storage only. A declared peer is not a licence to probe it.
    expect(fetchImpl.calls).toHaveLength(0)
    // Exactly two reads, in order: the chat key space first (unchanged), then the
    // agent key space this namespace owns. Nothing else is touched at setup.
    expect(storage.ops.filter((op) => op.op === "scan").map((op) => op.prefix)).toEqual([OPENCLAW_REGISTRY_PREFIX, OPENCLAW_AGENT_REGISTRY_PREFIX])
    expect(storage.ops.some((op) => op.op === "get" && op.key === OPENCLAW_STATUS_KEY)).toBe(true)

    const agent = native.status().agent
    expect(agent.namespace).toEqual({ identities: ["a2a"], peers: ["alpha"], a2a: true })
    expect(agent).toMatchObject({ pending: 0, records: 0, inflight: 0 })
    await native.dispose()
  })

  test("#given a channel that declares no peers #when composed #then the identity exists but the surface is not enabled", async () => {
    const native = createNativeOpenclaw({ context: context(spyStorage()), config: { enabled: true, channels: { a2a: { enabled: true, peers: {} } } }, fetchImpl: gatewayFetch(), log: () => {} })
    expect(native.agentCore).not.toBeNull()
    expect(native.status().agent.namespace.a2a).toBe(false)
    await native.ready
    await native.dispose()
  })

  test("#given channels under a disabled openclaw block #when composed #then the global switch still wins", async () => {
    const disabled = createNativeOpenclaw({ context: context(spyStorage()), config: { enabled: false, channels: { a2a: { peers: { alpha: {} } } } }, fetchImpl: gatewayFetch(), log: () => {} })
    expect(disabled.agentCore).toBeNull()
    expect(disabled.status()).toEqual({ enabled: false, started: false })

    const undeclaredSwitch = createNativeOpenclaw({ context: context(spyStorage()), config: { channels: { a2a: { peers: { alpha: {} } } } }, fetchImpl: gatewayFetch(), log: () => {} })
    expect(undeclaredSwitch.agentCore).toBeNull()
  })

  test("#given a composed agent core #when disposed #then no queued payload survives", async () => {
    const native = createNativeOpenclaw({ context: context(spyStorage()), config: namespaceConfig, fetchImpl: gatewayFetch(), log: () => {} })
    await native.ready
    const accepted = await native.agentCore.queue.enqueue({ peer: "alpha", contextId: "rigel-ctx", taskId: "task-1", sessionID: "s1", agentId: "sisyphus", text: "hello" })
    expect(accepted.accepted).toBe(true)
    expect(native.agentCore.queue.pendingTotal()).toBe(1)
    await native.dispose()
    expect(native.agentCore.queue.pendingTotal()).toBe(0)
  })
})
