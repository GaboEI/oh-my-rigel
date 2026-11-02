import { describe, expect, test } from "bun:test"
import { createNativeOpenclaw } from "./rigel-v2-native-openclaw.mjs"
import { createOpenclawOutbound } from "./rigel-v2-native-openclaw-outbound.mjs"
import { resolveOpenclawNotificationChannels } from "./rigel-v2-native-openclaw-notification.mjs"

const DISCORD_BASE = "http://127.0.0.1:9/discord"
const TELEGRAM_BASE = "http://127.0.0.1:9/telegram"

function memoryStorage() {
  const map = new Map()
  return {
    map,
    get: async (key) => map.get(key),
    set: async (key, value) => { map.set(key, value) },
    remove: async (key) => { map.delete(key) },
    scan: async ({ prefix } = {}) => ({
      entries: [...map.entries()].filter(([key]) => (prefix ? key.startsWith(prefix) : true)).map(([key, value]) => ({ key, value })),
    }),
  }
}

function spyFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => { calls.push({ url, init }); return handler(url, init) }
  fetchImpl.calls = calls
  return fetchImpl
}

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload, text: async () => JSON.stringify(payload) }
}

function stubRegistry() {
  const registered = []
  const removed = []
  return {
    registered,
    removed,
    register: async (mapping) => { registered.push(mapping); return true },
    removeSession: async (sessionID) => { removed.push(sessionID); return 1 },
    lookup: () => null,
    prune: async () => 0,
    hydrate: async () => {},
    size: () => registered.length,
  }
}

const LEGACY_CONFIG = {
  enabled: true,
  gateways: { h: { url: "https://gateway.test/h" } },
  hooks: { "session.idle": { gateway: "h", instruction: "go" } },
}

const DISCORD_CHANNEL = {
  transport: "discord",
  token: `synthetic-${Math.random().toString(36).slice(2)}`,
  channelId: "chan-1",
  instruction: "finished {{sessionId}} on {{event}}",
  events: ["session.idle"],
}

function channelsOf(rawChannels, env = {}) {
  const resolved = resolveOpenclawNotificationChannels(rawChannels, { env })
  expect(resolved.diagnostics).toEqual([])
  return resolved.channels
}

async function waitFor(predicate, message, maxIterations = 5000) {
  for (let index = 0; index < maxIterations; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`timed out: ${message}`)
}

describe("openclaw outbound: the legacy route keeps its exact call sequence", () => {
  test("#given a legacy-only configuration #when an event flows #then exactly the legacy send happens and no new platform is contacted", async () => {
    const fetchImpl = spyFetch(async () => jsonResponse({ messageId: "m1", platform: "discord" }))
    const outbound = createOpenclawOutbound({ config: LEGACY_CONFIG, registry: stubRegistry(), fetchImpl })
    const result = await outbound.handleEvent({ type: "session.idle", sessionID: "s1" })

    expect(fetchImpl.calls).toHaveLength(1)
    expect(fetchImpl.calls[0].url).toBe("https://gateway.test/h")
    expect(result).toMatchObject({ gateway: "h", success: true, messageId: "m1" })
    expect(fetchImpl.calls.some(({ url }) => url.includes("/channels/") || url.includes("/sendMessage"))).toBe(false)
  })

  test("#given a legacy-only configuration #when the composition is built #then no channel is registered and the token surface stays absent", async () => {
    const native = createNativeOpenclaw({ context: { storage: memoryStorage(), session: { prompt: async () => ({}) } }, config: LEGACY_CONFIG, fetchImpl: async () => jsonResponse({}), log: () => {} })
    await native.ready
    expect(native.status().channels).toBeUndefined()
    await native.dispose()
  })
})

describe("openclaw outbound: the new namespace publishes through the new transports", () => {
  test("#given a Discord channel #when its event flows #then the bot publishes and the published handle is correlated to the session", async () => {
    const registry = stubRegistry()
    const fetchImpl = spyFetch(async () => jsonResponse({ id: "m-9", channel_id: "chan-1" }))
    const outbound = createOpenclawOutbound({
      config: { enabled: true },
      registry,
      fetchImpl,
      env: { RIGEL_OPENCLAW_DISCORD_API_BASE: DISCORD_BASE },
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
      notificationChannels: channelsOf({ alerts: DISCORD_CHANNEL }),
    })

    const result = await outbound.handleEvent({ type: "session.idle", sessionID: "s1" })

    expect(fetchImpl.calls).toHaveLength(1)
    const [{ url, init }] = fetchImpl.calls
    expect(url).toBe(`${DISCORD_BASE}/channels/chan-1/messages`)
    expect(init.headers.Authorization).toBe(`Bot ${DISCORD_CHANNEL.token}`)
    expect(JSON.parse(init.body)).toEqual({ content: "finished s1 on session.idle" })
    expect(result).toMatchObject({ gateway: "alerts", success: true, messageId: "m-9", platform: "discord-bot" })
    // The handle is what a later reply is matched against: this is the correlation
    // the pre-U5 runtime could never write for a Discord notification.
    expect(registry.registered).toEqual([
      { sessionID: "s1", projectPath: "", platform: "discord-bot", messageId: "m-9", channelId: "chan-1", createdAt: "2026-01-01T00:00:00.000Z" },
    ])
  })

  test("#given a channel that names one event #when another documented event flows #then nothing is published", async () => {
    const fetchImpl = spyFetch(async () => jsonResponse({ id: "m-9" }))
    const outbound = createOpenclawOutbound({
      config: { enabled: true },
      registry: stubRegistry(),
      fetchImpl,
      notificationChannels: channelsOf({ alerts: DISCORD_CHANNEL }),
    })
    expect(await outbound.handleEvent({ type: "session.created", sessionID: "s1" })).toBeNull()
    expect(fetchImpl.calls).toHaveLength(0)
  })

  test("#given a legacy hook and a channel on the same event #when it flows #then the legacy send comes first and both happen", async () => {
    const fetchImpl = spyFetch(async (url) => (url.includes("/channels/") ? jsonResponse({ id: "m-9", channel_id: "chan-1" }) : jsonResponse({ messageId: "m1", platform: "discord" })))
    const outbound = createOpenclawOutbound({
      config: LEGACY_CONFIG,
      registry: stubRegistry(),
      fetchImpl,
      env: { RIGEL_OPENCLAW_DISCORD_API_BASE: DISCORD_BASE },
      notificationChannels: channelsOf({ alerts: DISCORD_CHANNEL }),
    })
    const result = await outbound.handleEvent({ type: "session.idle", sessionID: "s1" })
    expect(fetchImpl.calls.map(({ url }) => url)).toEqual(["https://gateway.test/h", `${DISCORD_BASE}/channels/chan-1/messages`])
    expect(result).toMatchObject({ gateway: "h", messageId: "m1" })
  })
})

describe("openclaw outbound: the Telegram reply loop is reachable", () => {
  test("#given a published Telegram notification #when a user replies #then the reply enters the session through the same chokepoint and prefix", async () => {
    const delivered = []
    const published = []
    const fetchImpl = spyFetch(async (url, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null
      if (url.includes("/getUpdates")) {
        return jsonResponse({
          ok: true,
          result: [{
            update_id: 11,
            message: {
              message_id: 12,
              text: "are you done?",
              chat: { id: 42 },
              reply_to_message: { message_id: 500 },
            },
          }],
        })
      }
      if (body !== null && body.reply_to_message_id !== undefined) return jsonResponse({ ok: true, result: {} })
      if (body !== null) {
        published.push(body)
        return jsonResponse({ ok: true, result: { message_id: 500, chat: { id: 42 } } })
      }
      return jsonResponse({ ok: true, result: [] })
    })

    const native = createNativeOpenclaw({
      context: { storage: memoryStorage(), session: { prompt: async (input) => { delivered.push(input); return {} } } },
      config: {
        enabled: true,
        channels: {
          ops: { transport: "telegram", token: "bot-token", chatId: "42", instruction: "finished {{sessionId}}", events: ["session.idle"] },
        },
        replyListener: { telegramBotToken: "bot-token", telegramChatId: "42" },
      },
      env: { RIGEL_OPENCLAW_TELEGRAM_API_BASE: TELEGRAM_BASE },
      fetchImpl,
      log: () => {},
    })

    const started = await native.ready
    expect(started.started).toBe(true)
    // Rigel now publishes a message of its own: the precondition the pre-U5
    // runtime never met, which is why `getUpdates` could never deliver a reply.
    await native.handleEvent({ type: "session.idle", sessionID: "s1" })
    expect(published).toEqual([{ chat_id: "42", text: "finished s1" }])
    expect(native.status().registry).toBe(1)

    await waitFor(() => delivered.length > 0, "Telegram reply injected through the chokepoint")
    expect(delivered[0]).toEqual({ sessionID: "s1", text: "[reply:telegram] are you done?", delivery: "queue" })
    await native.dispose()
  })
})

describe("openclaw outbound: a failed notification is reported, not swallowed", () => {
  test("#given a channel the platform refuses #when its event flows #then the outbound surface is degraded with the named class", async () => {
    const native = createNativeOpenclaw({
      context: { storage: memoryStorage(), session: { prompt: async () => ({}) } },
      config: { enabled: true, channels: { alerts: DISCORD_CHANNEL } },
      env: { RIGEL_OPENCLAW_DISCORD_API_BASE: DISCORD_BASE },
      fetchImpl: async () => jsonResponse({ message: "Unauthorized" }, 401),
      log: () => {},
    })
    await native.ready
    await native.handleEvent({ type: "session.idle", sessionID: "s1" })
    const report = await native.report()
    expect(report.surfaces.outbound).toMatchObject({ state: "degraded", errorClass: "http-401", consecutiveFailures: 1 })
    await native.dispose()
  })

  test("#given a channel that cannot be used #when the surface is composed #then one named line and one fatal are recorded with zero network and no credential", async () => {
    const lines = []
    const secret = `synthetic-${Math.random().toString(36).slice(2)}-mail-token`
    let calls = 0
    const native = createNativeOpenclaw({
      context: { storage: memoryStorage(), session: { prompt: async () => ({}) } },
      config: {
        enabled: true,
        channels: { alerts: { transport: "telegram", token: "env:MAIL_TOKEN", chatId: "1", instruction: "x", events: ["session.error"] } },
      },
      env: { MAIL_TOKEN: secret },
      fetchImpl: async () => { calls += 1; return jsonResponse({}) },
      log: (line) => lines.push(line),
    })

    const started = await native.ready
    expect(started).toEqual({ started: false, reason: "no-credentials" })
    expect(calls).toBe(0)
    expect(lines.filter((line) => line.includes("openclaw.channels.alerts.events"))).toHaveLength(1)
    // The credential DID resolve; it still never reaches a log line or the report.
    expect(lines.join("\n")).not.toContain(secret)
    const report = await native.report()
    expect(JSON.stringify(report)).not.toContain(secret)
    expect(report.surfaces["channels.alerts"]).toMatchObject({ state: "fatal", errorClass: "invalid-events" })
    await native.dispose()
  })
})
