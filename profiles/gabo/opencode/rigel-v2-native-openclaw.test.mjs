import { describe, expect, test } from "bun:test"
import { OPENCLAW_STATUS_KEY } from "./rigel-v2-native-openclaw-agent-status.mjs"
import { createNativeOpenclaw } from "./rigel-v2-native-openclaw.mjs"

async function waitFor(predicate, message, maxIterations = 5000) {
  for (let index = 0; index < maxIterations; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`timed out: ${message}`)
}

function memoryStorage() {
  const map = new Map()
  return {
    map,
    get: async (key) => map.get(key),
    set: async (key, value) => { map.set(key, value) },
    remove: async (key) => { map.delete(key) },
    scan: async ({ prefix } = {}) => ({ entries: [...map.entries()].filter(([key]) => (prefix ? key.startsWith(prefix) : true)).map(([key, value]) => ({ key, value })) }),
  }
}

function loopbackFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => { calls.push({ url, init }); return handler(url, init) }
  fetchImpl.calls = calls
  return fetchImpl
}

describe("openclaw composition gate", () => {
  test("absent config is a strict inert no-op (no dispatch, no listener, no network)", async () => {
    let calls = 0
    const native = createNativeOpenclaw({ context: { storage: memoryStorage(), session: { prompt: async () => ({}) } }, config: undefined, fetchImpl: async () => { calls += 1 } })
    expect(native.enabled).toBe(false)
    expect(await native.ready).toEqual({ started: false, reason: "disabled" })
    expect(await native.handleEvent({ type: "session.idle", sessionID: "s1" })).toBeNull()
    await native.dispose()
    expect(calls).toBe(0)
    expect(native.status()).toEqual({ enabled: false, started: false })
  })

  test("enabled without credentials dispatches outbound but starts no listener", async () => {
    const fetchImpl = loopbackFetch(async (_url, init) => ({ ok: true, status: 200, text: async () => (init?.body?.includes?.("session.idle") ? '{"messageId":"m1","platform":"discord"}' : "{}") }))
    const native = createNativeOpenclaw({
      context: { storage: memoryStorage(), session: { prompt: async () => ({}) } },
      config: { enabled: true, gateways: { h: { url: "https://gateway.test/h" } }, hooks: { "session.idle": { gateway: "h", instruction: "go" } } },
      fetchImpl,
      log: () => {},
    })
    const result = await native.ready
    expect(result.started).toBe(false)
    expect(await native.handleEvent({ type: "session.idle", sessionID: "s1" })).toMatchObject({ success: true, messageId: "m1" })
    expect(native.status().registry).toBe(1)
    await native.dispose()
  })

  test("enabled with Discord credentials starts the listener, routes a reply to the session, and dispose stops it", async () => {
    const delivered = []
    const fetchImpl = loopbackFetch(async (url) => {
      if (url.includes("gateway.test")) return { ok: true, status: 200, text: async () => '{"messageId":"bot","platform":"discord"}' }
      if (url.includes("/reactions/")) return { ok: true, status: 200, text: async () => "" }
      return {
        ok: true, status: 200, text: async () => "",
        json: async () => [{ id: "m2", content: "reply", author: { id: "u1" }, message_reference: { message_id: "bot" } }],
      }
    })
    const native = createNativeOpenclaw({
      context: { storage: memoryStorage(), session: { prompt: async (input) => { delivered.push(input); return {} } } },
      config: {
        enabled: true,
        gateways: { h: { url: "https://gateway.test/h" } },
        hooks: { "session.idle": { gateway: "h", instruction: "go" } },
        replyListener: { discordBotToken: "t", discordChannelId: "c", authorizedDiscordUserIds: ["u1"] },
      },
      env: { RIGEL_OPENCLAW_DISCORD_API_BASE: "http://127.0.0.1:1/discord" },
      fetchImpl,
      log: () => {},
    })
    const started = await native.ready
    expect(started.started).toBe(true)
    // A real outbound wake seeds the correlation the inbound route needs.
    await native.handleEvent({ type: "session.idle", sessionID: "s1", projectPath: "/p" })
    await waitFor(() => delivered.length > 0, "inbound reply injected through the gate")
    expect(delivered[0]).toEqual({ sessionID: "s1", text: "[reply:discord] reply", delivery: "queue" })
    await native.dispose()
    expect(native.status().started).toBe(false)
  })
})

describe("openclaw endpoint identity collision", () => {
  test("a non-colliding legacy endpoint keeps the listener's single-poll startup sequence", async () => {
    const fetchImpl = loopbackFetch(async () => ({ ok: true, status: 200, text: async () => "", json: async () => [] }))
    const config = {
      enabled: true,
      gateways: { legacy: { url: "https://gateway.test/legacy" } },
      hooks: { "session.idle": { gateway: "legacy", instruction: "go" } },
      replyListener: { discordBotToken: "test-token", discordChannelId: "test-channel", authorizedDiscordUserIds: ["test-author"] },
    }
    expect(config.hooks["session.idle"].gateway).toBe("legacy")
    const native = createNativeOpenclaw({
      context: { storage: memoryStorage(), session: { prompt: async () => ({}) } },
      config,
      env: { RIGEL_OPENCLAW_DISCORD_API_BASE: "http://127.0.0.1:1/discord" },
      fetchImpl,
      log: () => {},
    })
    expect(await native.ready).toEqual({ started: true })
    expect(fetchImpl.calls).toHaveLength(1)
    await native.dispose()
  })

  test("a routed legacy endpoint that collides with a channel never starts the surface", async () => {
    const storage = memoryStorage()
    const fetchImpl = loopbackFetch(async () => ({ ok: true, status: 200, text: async () => "", json: async () => [] }))
    const config = {
      enabled: true,
      gateways: { ops: { url: "https://gateway.test/ops" } },
      hooks: { "session.idle": { gateway: "ops", instruction: "go" } },
      replyListener: { discordBotToken: "test-token", discordChannelId: "test-channel", authorizedDiscordUserIds: ["test-author"] },
      replyPolicy: { "discord-bot": { allowedAuthors: ["test-author"] } },
      channels: {
        ops: {
          transport: "discord",
          token: "test-token",
          channelId: "test-channel",
          instruction: "notify",
          events: ["session.idle"],
        },
      },
    }
    expect(config.hooks["session.idle"].gateway).toBe("ops")
    const native = createNativeOpenclaw({
      context: { storage, session: { prompt: async () => ({}) } },
      config,
      env: { RIGEL_OPENCLAW_DISCORD_API_BASE: "http://127.0.0.1:1/discord" },
      fetchImpl,
      log: () => {},
    })
    expect(await native.ready).toEqual({ started: false, reason: "identity-collision" })
    expect(fetchImpl.calls).toHaveLength(0)
    const status = storage.map.get(OPENCLAW_STATUS_KEY)
    const fatalRows = Object.entries(status?.surfaces ?? {}).filter(([, row]) => row.state === "fatal")
    expect(fatalRows).toHaveLength(1)
    expect(fatalRows[0]?.[0]).toBe("config.identity-collision")
    expect(fatalRows[0]?.[1].errorClass).toContain("ops")
    await native.dispose()
  })
})
