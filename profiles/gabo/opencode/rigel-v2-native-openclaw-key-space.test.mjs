import { describe, expect, test } from "bun:test"
import { OPENCLAW_REGISTRY_PREFIX, createOpenclawRegistry } from "./rigel-v2-native-openclaw-registry.mjs"
import {
  OPENCLAW_AGENT_REGISTRY_PREFIX,
  createOpenclawAgentRegistry,
} from "./rigel-v2-native-openclaw-agent-registry.mjs"

/**
 * Byte-level pins of both correlation key spaces.
 *
 * These literals are the storage contract: a mapping persisted by one build is
 * read by the next one, so a change to the prefix or to the hash input would
 * silently orphan every record already on disk. The hashes below were computed
 * outside this module (`printf 'discord-bot\0m1' | sha1sum`), so the pin fails
 * if either side of the join is reordered, re-separated or rehashed.
 */
const CHAT_KEY_FOR_DISCORD_BOT_M1 = "rigel-v2/openclaw/registry/d57083662eb3363971f51c0b0b285259736f4d6b"
const AGENT_KEY_FOR_PEER_ALPHA_CTX_TASK1 = "rigel-v2/openclaw/agent/d932da3411623eeae7e9c0fa838e5c68716eeffc"

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

describe("openclaw chat key space is byte-stable", () => {
  test("#given a discord message #when it is persisted #then the storage key is the pinned literal", async () => {
    const storage = memoryStorage()
    const registry = createOpenclawRegistry({ storage })
    await registry.register({
      sessionID: "ses_1",
      platform: "discord-bot",
      messageId: "m1",
      createdAt: new Date().toISOString(),
    })
    expect([...storage.map.keys()]).toEqual([CHAT_KEY_FOR_DISCORD_BOT_M1])
    expect(OPENCLAW_REGISTRY_PREFIX).toBe("rigel-v2/openclaw/registry/")
  })
})

describe("openclaw agent key space is byte-stable and disjoint", () => {
  test("#given a peer, a context and a task #when the task is persisted #then the storage key is the pinned literal", async () => {
    const storage = memoryStorage()
    const registry = createOpenclawAgentRegistry({ storage })
    await registry.register({
      peer: "peer-alpha",
      agentId: "sisyphus",
      contextId: "rigel-ctx",
      taskId: "task-1",
      sessionID: "ses_1",
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    expect([...storage.map.keys()]).toEqual([AGENT_KEY_FOR_PEER_ALPHA_CTX_TASK1])
    expect(OPENCLAW_AGENT_REGISTRY_PREFIX).toBe("rigel-v2/openclaw/agent/")
  })

  test("#given both registries on one storage domain #when each hydrates #then each reads only its own records", async () => {
    const storage = memoryStorage()
    const chat = createOpenclawRegistry({ storage })
    const agent = createOpenclawAgentRegistry({ storage })
    await chat.register({ sessionID: "ses_1", platform: "discord-bot", messageId: "m1", createdAt: new Date().toISOString() })
    await agent.register({
      peer: "peer-alpha",
      agentId: "sisyphus",
      contextId: "rigel-ctx",
      taskId: "task-1",
      sessionID: "ses_1",
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    expect(storage.map.size).toBe(2)
    // Prefix separation is what keeps the two hydration passes from mixing shapes.
    const hydratedChat = createOpenclawRegistry({ storage })
    await hydratedChat.hydrate()
    expect(hydratedChat.size()).toBe(1)
    const hydratedAgent = createOpenclawAgentRegistry({ storage })
    await hydratedAgent.hydrate()
    expect(hydratedAgent.size()).toBe(1)
  })
})
