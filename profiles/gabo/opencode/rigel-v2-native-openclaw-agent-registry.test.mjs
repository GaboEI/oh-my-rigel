import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  OPENCLAW_AGENT_MAPPING_VERSION,
  OPENCLAW_AGENT_REGISTRY_PREFIX,
  OPENCLAW_CONTEXT_ID_PATTERN,
  createOpenclawAgentRegistry,
  deriveOpenclawContextId,
  isValidAgentMapping,
  openclawAgentKey,
  resolveOpenclawAgentNamespace,
} from "./rigel-v2-native-openclaw-agent-registry.mjs"
import { OPENCLAW_REGISTRY_PREFIX } from "./rigel-v2-native-openclaw-registry.mjs"

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

const seed = (overrides = {}) => ({
  peer: "peer-alpha",
  agentId: "sisyphus",
  contextId: "rigel-0123456789abcdef01234567",
  taskId: "task-1",
  sessionID: "ses_1",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
})

const clock = (iso) => () => Date.parse(iso)

describe("openclaw agent key space", () => {
  test("#given a peer, a context and a task #when keying #then the key is the pinned agent hash and never the chat key", () => {
    const key = openclawAgentKey("peer-alpha", "rigel-ctx", "task-1")
    const expected = createHash("sha1").update("peer-alpha\u0000rigel-ctx\u0000task-1").digest("hex")
    expect(key).toBe(`${OPENCLAW_AGENT_REGISTRY_PREFIX}${expected}`)
    expect(OPENCLAW_AGENT_REGISTRY_PREFIX).toBe("rigel-v2/openclaw/agent/")
    // The two key spaces must not overlap, or a chat hydration would read agent
    // records and vice versa.
    expect(key.startsWith(OPENCLAW_REGISTRY_PREFIX)).toBe(false)
    expect(OPENCLAW_REGISTRY_PREFIX.startsWith(OPENCLAW_AGENT_REGISTRY_PREFIX)).toBe(false)
  })

  test("#given the same peer and task under another context #when keying #then the keys differ", () => {
    expect(openclawAgentKey("peer-alpha", "ctx-a", "task-1")).not.toBe(openclawAgentKey("peer-alpha", "ctx-b", "task-1"))
  })
})

describe("openclaw agent record validation", () => {
  test("#given a complete agent record #when validating #then it is accepted at version 2", () => {
    expect(isValidAgentMapping({
      v: OPENCLAW_AGENT_MAPPING_VERSION,
      kind: "agent",
      peer: "peer-alpha",
      agentId: "sisyphus",
      contextId: "rigel-ctx",
      taskId: "task-1",
      sessionID: "ses_1",
      state: "submitted",
      attempts: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      inflight: false,
    })).toBe(true)
  })

  test("#given a chat mapping #when validating as an agent record #then it is rejected instead of coerced", () => {
    // This is the shape the chat registry persists today.
    const chatMapping = {
      sessionID: "ses_1",
      projectPath: "/p",
      platform: "discord-bot",
      messageId: "m1",
      createdAt: "2026-01-01T00:00:00.000Z",
    }
    expect(isValidAgentMapping(chatMapping)).toBe(false)
  })

  test("#given a record with a wrong version, an unknown state, or a terminal task holding the slot #when validating #then each is rejected", () => {
    const base = {
      v: OPENCLAW_AGENT_MAPPING_VERSION,
      kind: "agent",
      peer: "peer-alpha",
      agentId: "sisyphus",
      contextId: "rigel-ctx",
      taskId: "task-1",
      sessionID: "ses_1",
      state: "submitted",
      attempts: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      inflight: false,
    }
    expect(isValidAgentMapping({ ...base, v: 1 })).toBe(false)
    expect(isValidAgentMapping({ ...base, kind: "chat" })).toBe(false)
    expect(isValidAgentMapping({ ...base, state: "canceled" })).toBe(false)
    expect(isValidAgentMapping({ ...base, attempts: -1 })).toBe(false)
    expect(isValidAgentMapping({ ...base, inflight: "yes" })).toBe(false)
    expect(isValidAgentMapping({ ...base, state: "completed", inflight: true })).toBe(false)
  })
})

describe("openclaw agent registry", () => {
  test("#given a registered task #when looking it up #then only its own conversation resolves it", async () => {
    const storage = memoryStorage()
    const registry = createOpenclawAgentRegistry({ storage, now: clock("2026-01-01T00:00:00.000Z") })
    expect(await registry.register(seed())).toBe(true)
    expect(registry.lookup("peer-alpha", "rigel-0123456789abcdef01234567", "task-1")).toMatchObject({ sessionID: "ses_1", state: "submitted", attempts: 0 })
    expect(registry.lookup("peer-alpha", "rigel-other", "task-1")).toBeNull()
    expect(registry.lookup("peer-beta", "rigel-0123456789abcdef01234567", "task-1")).toBeNull()
    expect([...storage.map.keys()]).toEqual([openclawAgentKey("peer-alpha", "rigel-0123456789abcdef01234567", "task-1")])
  })

  test("#given an invalid seed #when registering #then nothing is written", async () => {
    const storage = memoryStorage()
    const registry = createOpenclawAgentRegistry({ storage })
    expect(await registry.register({ peer: "peer-alpha" })).toBe(false)
    expect(await registry.register(seed({ sessionID: "" }))).toBe(false)
    expect(storage.map.size).toBe(0)
    expect(registry.size()).toBe(0)
  })

  test("#given a record another process persisted #when hydrating #then the record resolves", async () => {
    const storage = memoryStorage()
    const writer = createOpenclawAgentRegistry({ storage, now: clock("2026-01-01T00:00:00.000Z") })
    await writer.register(seed({ taskId: "task-7" }))
    const reader = createOpenclawAgentRegistry({ storage, now: clock("2026-01-01T00:00:01.000Z") })
    await reader.hydrate()
    expect(reader.lookup("peer-alpha", "rigel-0123456789abcdef01234567", "task-7")).toMatchObject({ taskId: "task-7" })
  })

  test("#given an agent record under a non-derived occupied key #when it hydrates and its session is deleted #then removeSession deletes that occupied key without a migration", async () => {
    const storage = memoryStorage()
    const record = {
      v: OPENCLAW_AGENT_MAPPING_VERSION,
      kind: "agent",
      ...seed({ taskId: "task-occupied", sessionID: "ses_occupied" }),
      state: "submitted",
      attempts: 0,
      inflight: false,
    }
    const occupiedKey = `${OPENCLAW_AGENT_REGISTRY_PREFIX}fixture-occupied-not-derived`
    const derivedKey = openclawAgentKey(record.peer, record.contextId, record.taskId)
    await storage.set(occupiedKey, record)
    expect(occupiedKey).not.toBe(derivedKey)

    const registry = createOpenclawAgentRegistry({ storage, now: clock("2026-01-01T00:00:01.000Z") })
    await registry.hydrate()
    expect(registry.lookup(record.peer, record.contextId, record.taskId)).toMatchObject({ sessionID: "ses_occupied" })

    expect(await registry.removeSession("ses_occupied")).toBe(1)
    expect(storage.map.has(occupiedKey)).toBe(false)
    expect(storage.map.has(derivedKey)).toBe(false)

    const restarted = createOpenclawAgentRegistry({ storage, now: clock("2026-01-01T00:00:02.000Z") })
    await restarted.hydrate()
    expect(restarted.lookup(record.peer, record.contextId, record.taskId)).toBeNull()
  })

  test("#given a shadowed agent record under a non-derived occupied key #when its session is deleted #then removeSession deletes the shadow without removing the active record", async () => {
    const storage = memoryStorage()
    const shadowed = {
      v: OPENCLAW_AGENT_MAPPING_VERSION,
      kind: "agent",
      ...seed({ taskId: "task-shadowed", sessionID: "ses_shadowed" }),
      state: "submitted",
      attempts: 0,
      inflight: false,
    }
    const active = { ...shadowed, sessionID: "ses_active" }
    const shadowedKey = `${OPENCLAW_AGENT_REGISTRY_PREFIX}fixture-shadowed-not-derived`
    const derivedKey = openclawAgentKey(active.peer, active.contextId, active.taskId)
    await storage.set(shadowedKey, shadowed)
    await storage.set(derivedKey, active)
    expect(shadowedKey).not.toBe(derivedKey)

    const registry = createOpenclawAgentRegistry({ storage, now: clock("2026-01-01T00:00:01.000Z") })
    await registry.hydrate()
    expect(registry.lookup(active.peer, active.contextId, active.taskId)).toMatchObject({ sessionID: "ses_active" })

    expect(await registry.removeSession("ses_shadowed")).toBe(1)
    expect(storage.map.has(shadowedKey)).toBe(false)
    expect(storage.map.get(derivedKey)).toMatchObject({ sessionID: "ses_active" })

    const restarted = createOpenclawAgentRegistry({ storage, now: clock("2026-01-01T00:00:02.000Z") })
    await restarted.hydrate()
    expect(restarted.lookup(active.peer, active.contextId, active.taskId)).toMatchObject({ sessionID: "ses_active" })
  })

  test("#given a paginated durable registry with a repeated entry #when hydrating across a restart #then every task and the in-flight slot are restored once", async () => {
    const writerStorage = memoryStorage()
    const writer = createOpenclawAgentRegistry({ storage: writerStorage, now: clock("2026-01-01T00:00:00.000Z") })
    await writer.register(seed({ taskId: "task-inflight" }))
    await writer.register(seed({ taskId: "task-pending", createdAt: "2026-01-01T00:00:01.000Z" }))
    await writer.claim("peer-alpha", "rigel-0123456789abcdef01234567", "task-inflight")
    const [inflight, pending] = [...writerStorage.map.entries()]
    const scanCalls = []
    const storage = {
      scan: async ({ after } = {}) => {
        scanCalls.push(after)
        if (after === undefined) return { entries: [{ key: inflight[0], value: inflight[1] }], next: "page-2" }
        if (after === "page-2") {
          return {
            entries: [{ key: inflight[0], value: inflight[1] }, { key: pending[0], value: pending[1] }],
          }
        }
        throw new Error(`unexpected page token: ${String(after)}`)
      },
    }

    const reader = createOpenclawAgentRegistry({ storage, now: clock("2026-01-01T00:00:02.000Z") })
    await reader.hydrate()
    expect(scanCalls).toEqual([undefined, "page-2"])
    expect(reader.size()).toBe(2)
    expect(reader.inflightCount()).toBe(1)
    expect(reader.lookup("peer-alpha", "rigel-0123456789abcdef01234567", "task-pending")).toMatchObject({ taskId: "task-pending" })
    expect(reader.nextPendingFor("peer-alpha", "rigel-0123456789abcdef01234567")).toBeNull()

    const restarted = createOpenclawAgentRegistry({ storage, now: clock("2026-01-01T00:00:03.000Z") })
    await restarted.hydrate()
    expect(restarted.size()).toBe(2)
    expect(restarted.inflightCount()).toBe(1)
    expect(restarted.nextPendingFor("peer-alpha", "rigel-0123456789abcdef01234567")).toBeNull()
  })

  test("#given a repeated or malformed storage continuation #when hydrating #then scanning stops with a named diagnostic", async () => {
    const lines = []
    const repeatedCalls = []
    const repeated = createOpenclawAgentRegistry({
      storage: {
        scan: async ({ after } = {}) => {
          repeatedCalls.push(after)
          return { entries: [], next: "again" }
        },
      },
      log: (line) => lines.push(line),
    })
    await repeated.hydrate()
    expect(repeatedCalls).toEqual([undefined, "again"])
    expect(lines).toContain("[oh-my-rigel] Native V2 openclaw agent registry hydrate stopped on a repeated pagination token")

    const malformedLines = []
    const malformed = createOpenclawAgentRegistry({
      storage: { scan: async () => ({ entries: [], next: 3 }) },
      log: (line) => malformedLines.push(line),
    })
    await malformed.hydrate()
    expect(malformedLines).toContain("[oh-my-rigel] Native V2 openclaw agent registry hydrate stopped on an invalid pagination token")

    const malformedPageLines = []
    const malformedPage = createOpenclawAgentRegistry({
      storage: { scan: async () => ({ entries: "not-an-array" }) },
      log: (line) => malformedPageLines.push(line),
    })
    await malformedPage.hydrate()
    expect(malformedPageLines).toContain("[oh-my-rigel] Native V2 openclaw agent registry hydrate stopped on a malformed storage page")
  })

  test("#given a persisted record with an invalid shape #when hydrating #then it is skipped and reported instead of trusted", async () => {
    const storage = memoryStorage()
    await storage.set(`${OPENCLAW_AGENT_REGISTRY_PREFIX}broken`, { sessionID: "ses_1" })
    const lines = []
    const registry = createOpenclawAgentRegistry({ storage, log: (line) => lines.push(line) })
    await registry.hydrate()
    expect(registry.size()).toBe(0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("skipped a record with an invalid shape")
  })

  test("#given persisted invalid-version and invalid-shape agent records #when the registry hydrates #then each is skipped with its named diagnostic", async () => {
    const storage = memoryStorage()
    await storage.set(`${OPENCLAW_AGENT_REGISTRY_PREFIX}future-version`, {
      v: OPENCLAW_AGENT_MAPPING_VERSION + 1,
      kind: "agent",
      ...seed(),
      state: "submitted",
      attempts: 0,
      inflight: false,
    })
    await storage.set(`${OPENCLAW_AGENT_REGISTRY_PREFIX}invalid-shape`, { sessionID: "ses_1" })
    const lines = []
    const registry = createOpenclawAgentRegistry({ storage, log: (line) => lines.push(line) })

    await registry.hydrate()

    expect(registry.size()).toBe(0)
    expect(lines).toContain("[oh-my-rigel] Native V2 openclaw agent registry skipped a record with an unknown version")
    expect(lines).toContain("[oh-my-rigel] Native V2 openclaw agent registry skipped a record with an invalid shape")
  })

  test("#given a conversation with two pending tasks #when claiming #then the oldest holds the single slot until it settles", async () => {
    const registry = createOpenclawAgentRegistry({ now: clock("2026-01-01T00:00:00.000Z") })
    await registry.register(seed({ taskId: "task-old", createdAt: "2026-01-01T00:00:00.000Z" }))
    await registry.register(seed({ taskId: "task-new", createdAt: "2026-01-01T00:00:05.000Z" }))
    expect(registry.nextPendingFor("peer-alpha", "rigel-0123456789abcdef01234567")).toMatchObject({ taskId: "task-old" })
    expect(await registry.claim("peer-alpha", "rigel-0123456789abcdef01234567", "task-old")).toMatchObject({ inflight: true, attempts: 1 })
    // OpenClaw completes the oldest pending task of the conversation, so a second
    // concurrent send would complete the wrong task. The slot is exclusive.
    expect(registry.nextPendingFor("peer-alpha", "rigel-0123456789abcdef01234567")).toBeNull()
    expect(await registry.claim("peer-alpha", "rigel-0123456789abcdef01234567", "task-new")).toBeNull()
    await registry.settle("peer-alpha", "rigel-0123456789abcdef01234567", "task-old", "completed")
    expect(registry.nextPendingFor("peer-alpha", "rigel-0123456789abcdef01234567")).toMatchObject({ taskId: "task-new" })
  })

  test("#given a claimed slot another instance persisted #when a fresh registry hydrates #then the slot is still taken", async () => {
    const storage = memoryStorage()
    const first = createOpenclawAgentRegistry({ storage, now: clock("2026-01-01T00:00:00.000Z") })
    await first.register(seed({ taskId: "task-a" }))
    await first.register(seed({ taskId: "task-b", createdAt: "2026-01-01T00:00:05.000Z" }))
    await first.claim("peer-alpha", "rigel-0123456789abcdef01234567", "task-a")
    const second = createOpenclawAgentRegistry({ storage, now: clock("2026-01-01T00:00:06.000Z") })
    await second.hydrate()
    expect(second.hasInflight("peer-alpha", "rigel-0123456789abcdef01234567")).toBe(true)
    expect(second.nextPendingFor("peer-alpha", "rigel-0123456789abcdef01234567")).toBeNull()
  })

  test("#given a claim that is released #when the conversation is read again #then the task is still pending and the slot is free", async () => {
    const registry = createOpenclawAgentRegistry({ now: clock("2026-01-01T00:00:00.000Z") })
    await registry.register(seed({ taskId: "task-a" }))
    await registry.claim("peer-alpha", "rigel-0123456789abcdef01234567", "task-a")
    expect(await registry.release("peer-alpha", "rigel-0123456789abcdef01234567", "task-a")).toMatchObject({ inflight: false, state: "submitted", attempts: 1 })
    expect(registry.hasInflight("peer-alpha", "rigel-0123456789abcdef01234567")).toBe(false)
  })

  test("#given a pending record past the hard horizon #when pruning #then it is reported as lost instead of dropped in silence", async () => {
    const lines = []
    const registry = createOpenclawAgentRegistry({ now: clock("2026-01-09T00:00:00.000Z"), log: (line) => lines.push(line) })
    await registry.register(seed({ taskId: "task-stale", createdAt: "2026-01-01T00:00:00.000Z" }))
    await registry.register(seed({ taskId: "task-done", createdAt: "2026-01-01T00:00:00.000Z", state: "completed" }))
    await registry.register(seed({ taskId: "task-live", createdAt: "2026-01-08T00:00:00.000Z" }))
    const result = await registry.prune()
    expect(result.removed).toBe(2)
    expect(result.lost.map((record) => record.taskId)).toEqual(["task-stale"])
    expect(result.lost[0].state).toBe("lost")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("task lost")
    expect(registry.lookup("peer-alpha", "rigel-0123456789abcdef01234567", "task-live")).not.toBeNull()
  })

  test("#given a stale record #when looking it up #then it is hidden but not deleted, so prune can report it", async () => {
    const registry = createOpenclawAgentRegistry({ now: clock("2026-01-09T00:00:00.000Z") })
    await registry.register(seed({ createdAt: "2026-01-01T00:00:00.000Z" }))
    expect(registry.lookup("peer-alpha", "rigel-0123456789abcdef01234567", "task-1")).toBeNull()
    expect(registry.size()).toBe(1)
  })

  test("#given records of two sessions #when one session is deleted #then only its records are removed", async () => {
    const storage = memoryStorage()
    const registry = createOpenclawAgentRegistry({ storage, now: clock("2026-01-01T00:00:01.000Z") })
    await registry.register(seed({ taskId: "task-1", sessionID: "ses_1" }))
    await registry.register(seed({ taskId: "task-2", sessionID: "ses_2" }))
    expect(await registry.removeSession("ses_1")).toBe(1)
    expect(registry.lookup("peer-alpha", "rigel-0123456789abcdef01234567", "task-1")).toBeNull()
    expect(registry.lookup("peer-alpha", "rigel-0123456789abcdef01234567", "task-2")).not.toBeNull()
    expect(storage.map.size).toBe(1)
  })
})

describe("openclaw context id derivation", () => {
  test("#given a session id #when deriving #then the id is stable, colon-free and inside the vendor pattern", () => {
    const contextId = deriveOpenclawContextId("ses_abc")
    expect(contextId).toBe(`rigel-${createHash("sha256").update("ses_abc").digest("hex").slice(0, 24)}`)
    expect(contextId).toBe(deriveOpenclawContextId("ses_abc"))
    expect(contextId).toHaveLength("rigel-".length + 24)
    expect(contextId.includes(":")).toBe(false)
    expect(OPENCLAW_CONTEXT_ID_PATTERN.test(contextId)).toBe(true)
    expect(deriveOpenclawContextId("ses_abc")).not.toBe(deriveOpenclawContextId("ses_abd"))
  })

  test("#given an empty session id #when deriving #then there is no context instead of a shared default", () => {
    expect(deriveOpenclawContextId("")).toBeNull()
    expect(deriveOpenclawContextId(undefined)).toBeNull()
  })
})

describe("openclaw agent namespace resolution", () => {
  test("#given a legacy config #when resolving #then the new namespace is not declared", () => {
    const resolved = resolveOpenclawAgentNamespace({
      enabled: true,
      gateways: { hook: { url: "https://gateway.test/hook" } },
      hooks: { "session.idle": { gateway: "hook" } },
      replyListener: { discordBotToken: "t" },
    })
    expect(resolved).toEqual({ declared: false, identities: [], chatIdentities: [], a2aDeclared: false, peers: [], a2aEnabled: false })
  })

  test("#given channels naming an identity #when resolving #then it is declared with its identities", () => {
    const resolved = resolveOpenclawAgentNamespace({ channels: { a2a: { enabled: true, peers: { alpha: { token: "x" }, beta: { token: "y" } } } } })
    expect(resolved.declared).toBe(true)
    expect(resolved.identities).toEqual(["a2a"])
    expect(resolved.peers).toEqual(["alpha", "beta"])
    expect(resolved.a2aEnabled).toBe(true)
    expect(resolved.chatIdentities).toEqual([])
    expect(resolved.a2aDeclared).toBe(true)
  })

  test("#given an a2a channel without peers #when resolving #then the channel is declared but not configured", () => {
    // The vendor treats `configured` as "at least one peer": `peers: {}` starts
    // nothing, so the identity exists while the surface is inert.
    const resolved = resolveOpenclawAgentNamespace({ channels: { a2a: { enabled: true, peers: {} } } })
    expect(resolved.declared).toBe(true)
    expect(resolved.a2aEnabled).toBe(false)
  })

  test("#given a disabled a2a channel #when resolving #then the identity is declared and the surface is not enabled", () => {
    const resolved = resolveOpenclawAgentNamespace({ channels: { a2a: { enabled: false, peers: { alpha: { token: "x" } } } } })
    expect(resolved.declared).toBe(true)
    expect(resolved.a2aEnabled).toBe(false)
  })

  test("#given malformed named entries #when resolving #then declaration preserves the named identity for its owner", () => {
    // `declared` records the raw named namespace for diagnostics and A2A setup only.
    // Chat governance consumes `chatIdentities`, so reserved a2a never governs chat.
    expect(resolveOpenclawAgentNamespace({ channels: { a2a: "nope" } })).toMatchObject({
      declared: true,
      identities: ["a2a"],
      chatIdentities: [],
      a2aDeclared: true,
    })
    expect(resolveOpenclawAgentNamespace({ channels: { telegram: "nope" } })).toMatchObject({
      declared: true,
      identities: ["telegram"],
      chatIdentities: ["telegram"],
    })
    expect(resolveOpenclawAgentNamespace({ channels: {} })).toMatchObject({ declared: false, identities: [], chatIdentities: [] })
    expect(resolveOpenclawAgentNamespace(undefined)).toMatchObject({ declared: false, identities: [], chatIdentities: [] })
  })
})
