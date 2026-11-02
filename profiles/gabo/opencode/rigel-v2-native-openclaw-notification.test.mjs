import { describe, expect, test } from "bun:test"
import {
  deliverDiscordNotification,
  deliverTelegramNotification,
  isOpenclawTransportReceipt,
  notificationEnvelope,
  resolveOpenclawNotificationChannels,
} from "./rigel-v2-native-openclaw-notification.mjs"
import { dispatchGateway, resolveGatewayTransport, wakeGateway } from "./rigel-v2-native-openclaw-transport.mjs"

/**
 * Synthetic credential, generated per run. No real platform is ever contacted:
 * every transport in these tests is driven against a loopback-style base URL and
 * a fake `fetch`, and the assertions below double as the leak check.
 */
const TOKEN = `synthetic-${Math.random().toString(36).slice(2)}-token`
const DISCORD_BASE = "http://127.0.0.1:9/discord"
const TELEGRAM_BASE = "http://127.0.0.1:9/telegram"

function spyFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload, text: async () => JSON.stringify(payload) }
}

function serialized(value) {
  return JSON.stringify(value)
}

describe("openclaw notification transports", () => {
  test("#given a Discord channel #when a notification is delivered #then it POSTs the bot message endpoint and returns the published handle", async () => {
    const fetchImpl = spyFetch(async () => jsonResponse({ id: "m-1", channel_id: "chan-1" }))
    const receipt = await deliverDiscordNotification({
      gatewayName: "alerts",
      gateway: { type: "discord", token: TOKEN, channelId: "chan-1" },
      message: { text: "session finished" },
      fetchImpl,
      env: { RIGEL_OPENCLAW_DISCORD_API_BASE: DISCORD_BASE },
    })

    expect(fetchImpl.calls).toHaveLength(1)
    const [{ url, init }] = fetchImpl.calls
    expect(url).toBe(`${DISCORD_BASE}/channels/chan-1/messages`)
    expect(init.method).toBe("POST")
    expect(init.headers.Authorization).toBe(`Bot ${TOKEN}`)
    expect(JSON.parse(init.body)).toEqual({ content: "session finished" })
    // The handle is the receipt: without it the chat reply cannot be correlated.
    expect(receipt).toEqual({ kind: "delivered", platform: "discord-bot", messageId: "m-1", channelId: "chan-1", statusCode: 200 })
    expect(isOpenclawTransportReceipt(receipt)).toBe(true)
  })

  test("#given a Telegram channel #when a notification is delivered #then it uses sendMessage and returns the message id", async () => {
    const fetchImpl = spyFetch(async () => jsonResponse({ ok: true, result: { message_id: 77, chat: { id: 42 } } }))
    const receipt = await deliverTelegramNotification({
      gatewayName: "ops",
      gateway: { type: "telegram", token: TOKEN, chatId: "42" },
      message: { text: "session finished" },
      fetchImpl,
      env: { RIGEL_OPENCLAW_TELEGRAM_API_BASE: TELEGRAM_BASE },
    })

    expect(fetchImpl.calls).toHaveLength(1)
    const [{ url, init }] = fetchImpl.calls
    expect(url).toBe(`${TELEGRAM_BASE}/bot${TOKEN}/sendMessage`)
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body)).toEqual({ chat_id: "42", text: "session finished" })
    expect(receipt).toEqual({ kind: "delivered", platform: "telegram", messageId: "77", channelId: "42", statusCode: 200 })
    expect(isOpenclawTransportReceipt(receipt)).toBe(true)
  })

  const FAILURES = [
    {
      name: "a refused HTTP status",
      run: () => deliverDiscordNotification({
        gateway: { type: "discord", token: TOKEN, channelId: "chan-1" },
        message: { text: "x" },
        fetchImpl: async () => jsonResponse({ message: "Unauthorized" }, 401),
        env: { RIGEL_OPENCLAW_DISCORD_API_BASE: DISCORD_BASE },
      }),
      expected: "http-401",
    },
    {
      name: "a Telegram answer that declines the send with 200",
      run: () => deliverTelegramNotification({
        gateway: { type: "telegram", token: TOKEN, chatId: "42" },
        message: { text: "x" },
        fetchImpl: async () => jsonResponse({ ok: false, description: "chat not found" }),
        env: { RIGEL_OPENCLAW_TELEGRAM_API_BASE: TELEGRAM_BASE },
      }),
      expected: "platform-rejected",
    },
    {
      name: "an accepted send with no handle",
      run: () => deliverTelegramNotification({
        gateway: { type: "telegram", token: TOKEN, chatId: "42" },
        message: { text: "x" },
        fetchImpl: async () => jsonResponse({ ok: true, result: {} }),
        env: { RIGEL_OPENCLAW_TELEGRAM_API_BASE: TELEGRAM_BASE },
      }),
      expected: "missing-message-id",
    },
    {
      name: "a body that is not the documented shape",
      run: () => deliverDiscordNotification({
        gateway: { type: "discord", token: TOKEN, channelId: "chan-1" },
        message: { text: "x" },
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad json") } }),
        env: { RIGEL_OPENCLAW_DISCORD_API_BASE: DISCORD_BASE },
      }),
      expected: "malformed-response",
    },
    {
      name: "a transport exception",
      run: () => deliverDiscordNotification({
        gateway: { type: "discord", token: TOKEN, channelId: "chan-1" },
        message: { text: "x" },
        fetchImpl: async () => { throw new TypeError("connection refused") },
        env: { RIGEL_OPENCLAW_DISCORD_API_BASE: DISCORD_BASE },
      }),
      expected: "transport-error",
    },
    {
      name: "an aborted request",
      run: () => deliverTelegramNotification({
        gateway: { type: "telegram", token: TOKEN, chatId: "42" },
        message: { text: "x" },
        fetchImpl: async () => { const error = new Error("aborted"); error.name = "AbortError"; throw error },
        env: { RIGEL_OPENCLAW_TELEGRAM_API_BASE: TELEGRAM_BASE },
      }),
      expected: "timeout",
    },
  ]

  for (const { name, run, expected } of FAILURES) {
    test(`#given ${name} #when the notification is delivered #then the receipt is a named failure with no handle`, async () => {
      const receipt = await run()
      expect(receipt.kind).toBe("failed")
      expect(receipt.errorClass).toBe(expected)
      expect(receipt.messageId).toBeUndefined()
      expect(isOpenclawTransportReceipt(receipt)).toBe(true)
    })
  }

  test("#given a transport exception that echoes the request URL #when it is reduced to a receipt #then the credential never appears", async () => {
    const lease = `http://127.0.0.1:9/telegram/bot${TOKEN}/sendMessage`
    const receipt = await deliverTelegramNotification({
      gateway: { type: "telegram", token: TOKEN, chatId: "42" },
      message: { text: "x" },
      fetchImpl: async () => { throw new TypeError(`fetch failed for ${lease}`) },
      env: { RIGEL_OPENCLAW_TELEGRAM_API_BASE: TELEGRAM_BASE },
    })
    // The envelope is what U4 logs, so it is checked as well as the receipt.
    const envelope = notificationEnvelope("ops", receipt)
    expect(serialized(receipt)).not.toContain(TOKEN)
    expect(serialized(envelope)).not.toContain(TOKEN)
    expect(envelope).toMatchObject({ success: false, errorClass: "transport-error", error: "Transport error" })
  })

  test("#given an incomplete notification #when it is delivered #then it is refused without a request", async () => {
    const fetchImpl = spyFetch(async () => jsonResponse({ id: "m-1" }))
    const noToken = await deliverDiscordNotification({ gateway: { type: "discord", channelId: "c" }, message: { text: "x" }, fetchImpl })
    const noTarget = await deliverTelegramNotification({ gateway: { type: "telegram", token: TOKEN }, message: { text: "x" }, fetchImpl })
    const noText = await deliverTelegramNotification({ gateway: { type: "telegram", token: TOKEN, chatId: "42" }, message: { text: "" }, fetchImpl })
    expect(noToken.errorClass).toBe("missing-credentials")
    expect(noTarget.errorClass).toBe("missing-credentials")
    expect(noText.errorClass).toBe("missing-text")
    expect(fetchImpl.calls).toHaveLength(0)
  })
})

describe("openclaw transport selection", () => {
  const CASES = [
    ["no type at all", undefined, "http"],
    ["the documented http type", "http", "http"],
    ["the legacy command type", "command", "command"],
    ["the new Discord type", "discord", "discord"],
    ["the new Telegram type", "telegram", "telegram"],
    ["an unrecognised type", "smtp", "http"],
  ]
  for (const [label, type, expected] of CASES) {
    test(`#given ${label} #when resolving the transport #then it selects ${expected}`, () => {
      expect(resolveGatewayTransport(type === undefined ? {} : { type })).toBe(expected)
    })
  }

  test("#given the legacy HTTP transport #when dispatched #then the payload and body are byte-identical to wakeGateway", async () => {
    const payload = { event: "session.idle", instruction: "go", text: "go", timestamp: "t", context: {} }
    const viaDispatch = spyFetch(async () => ({ ok: true, status: 200, text: async () => "{}" }))
    const viaWake = spyFetch(async () => ({ ok: true, status: 200, text: async () => "{}" }))
    const dispatched = await dispatchGateway({ gatewayName: "h", gateway: { type: "http", url: "https://g.test/h" }, payload, fetchImpl: viaDispatch })
    const woken = await wakeGateway({ gatewayName: "h", gateway: { url: "https://g.test/h" }, payload, fetchImpl: viaWake })
    expect(dispatched).toEqual(woken)
    expect(viaDispatch.calls[0].init.body).toBe(viaWake.calls[0].init.body)
    expect(viaDispatch.calls[0].url).toBe(viaWake.calls[0].url)
  })

  test("#given the legacy command transport #when dispatched #then the interpolated argv is unchanged", async () => {
    const argv = []
    const spawnImpl = (args) => {
      argv.push(args)
      return { pid: 1, stdout: { [Symbol.asyncIterator]: async function* () {} }, exited: Promise.resolve(0), kill() {} }
    }
    const result = await dispatchGateway({
      gatewayName: "c",
      gateway: { type: "command", command: "notify {{event}}" },
      variables: { event: "session.idle" },
      spawnImpl,
      platform: "win32",
    })
    expect(result).toEqual({ gateway: "c", success: true })
    expect(argv).toEqual([["sh", "-c", "notify 'session.idle'"]])
  })
})

describe("openclaw notification channel resolution", () => {
  test("#given the legacy configuration #when its channels are resolved #then there are none and nothing is diagnosed", () => {
    const legacy = {
      enabled: true,
      gateways: { h: { url: "https://gateway.test/h" } },
      hooks: { "session.idle": { gateway: "h", instruction: "go" } },
      replyListener: { discordBotToken: "t", discordChannelId: "c", authorizedDiscordUserIds: ["u1"] },
    }
    expect(resolveOpenclawNotificationChannels(legacy.channels)).toEqual({ channels: [], diagnostics: [] })
  })

  test("#given Discord and Telegram channels #when resolved #then endpoints keep declaration order and resolve the credential reference once", () => {
    const resolved = resolveOpenclawNotificationChannels({
      alerts: { transport: "discord", token: "env:DISCORD_BOT_TOKEN", channelId: "chan-1", instruction: "idle {{sessionId}}", events: ["session.idle"] },
      ops: { transport: "telegram", token: { env: "TELEGRAM_BOT_TOKEN" }, chatId: "42", instruction: "created", events: ["session.created", "session.created"] },
      a2a: { enabled: true, peers: { alpha: { token: "peer-token" } } },
    }, { env: { DISCORD_BOT_TOKEN: "discord-secret", TELEGRAM_BOT_TOKEN: "telegram-secret" } })

    expect(resolved.diagnostics).toEqual([])
    expect(resolved.channels).toEqual([
      { name: "alerts", transport: "discord", token: "discord-secret", target: "chan-1", instruction: "idle {{sessionId}}", events: ["session.idle"] },
      { name: "ops", transport: "telegram", token: "telegram-secret", target: "42", instruction: "created", events: ["session.created"] },
    ])
  })

  const INVALID = [
    ["a channel that is not an object", { alerts: "discord" }, "openclaw.channels.alerts", "not-an-object"],
    ["an unknown key", { alerts: { transport: "telegram", token: "t", chatId: "1", instruction: "x", events: ["session.idle"], mention: true } }, "openclaw.channels.alerts.mention", "unknown-key"],
    ["an unsupported transport", { alerts: { transport: "smtp", token: "t", chatId: "1", instruction: "x", events: ["session.idle"] } }, "openclaw.channels.alerts.transport", "unsupported-transport"],
    ["a Discord channel without its channel id", { alerts: { transport: "discord", token: "t", instruction: "x", events: ["session.idle"] } }, "openclaw.channels.alerts.channelId", "missing-target"],
    ["an unresolvable reference", { alerts: { transport: "telegram", token: "env:MISSING_TOKEN", chatId: "1", instruction: "x", events: ["session.idle"] } }, "openclaw.channels.alerts.token", "missing-env-variable"],
    ["a malformed reference", { alerts: { transport: "telegram", token: { secret: "x" }, chatId: "1", instruction: "x", events: ["session.idle"] } }, "openclaw.channels.alerts.token", "unknown-secret-reference"],
    ["no instruction to send", { alerts: { transport: "telegram", token: "t", chatId: "1", events: ["session.idle"] } }, "openclaw.channels.alerts.instruction", "missing-instruction"],
    ["no events", { alerts: { transport: "telegram", token: "t", chatId: "1", instruction: "x" } }, "openclaw.channels.alerts.events", "missing-events"],
    ["an empty event list", { alerts: { transport: "telegram", token: "t", chatId: "1", instruction: "x", events: [] } }, "openclaw.channels.alerts.events", "missing-events"],
    ["an undocumented event", { alerts: { transport: "telegram", token: "t", chatId: "1", instruction: "x", events: ["session.error"] } }, "openclaw.channels.alerts.events", "invalid-events"],
  ]

  for (const [label, channels, path, reason] of INVALID) {
    test(`#given ${label} #when resolved #then that channel is disabled with a named diagnostic at its path`, () => {
      const resolved = resolveOpenclawNotificationChannels(channels, { env: {} })
      expect(resolved.channels).toEqual([])
      expect(resolved.diagnostics).toEqual([expect.objectContaining({ path, reason })])
    })
  }

  test("#given a resolvable credential and a different failing key #when resolved #then neither the channels nor the diagnostics carry the credential", () => {
    const secret = `synthetic-${Math.random().toString(36).slice(2)}-credential`
    const resolved = resolveOpenclawNotificationChannels({
      alerts: { transport: "telegram", token: secret, chatId: "1", instruction: "x", events: ["session.error"] },
    })
    expect(resolved.channels).toEqual([])
    expect(serialized(resolved)).not.toContain(secret)
  })
})
