import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { createNativeOpenclaw } from "./rigel-v2-native-openclaw.mjs"
import { createOpenclawInbound } from "./rigel-v2-native-openclaw-inbound.mjs"
import { createOpenclawRegistry } from "./rigel-v2-native-openclaw-registry.mjs"
import {
  authorizeTelegramAuthors,
  describeOpenclawReplyPolicyDiagnostic,
  resolveOpenclawReplyPolicy,
} from "./rigel-v2-native-openclaw-reply-policy.mjs"
import { createOpenclawStatusDocument, OPENCLAW_STATUS_KEY } from "./rigel-v2-native-openclaw-agent-status.mjs"

/**
 * §U7: the Telegram ingress filter. The contract this suite protects is the one
 * `Unidades_Atomicas_OpenClaw.md` §U7 states: in the new namespace the authorized
 * user list is MANDATORY (its absence is a reported configuration error with the
 * poller closed, never an open poller), an unauthorized user stays silent with no
 * response, and legacy keeps filtering by chat only.
 */

const TELEGRAM_BASE = "http://127.0.0.1:9/telegram"
const SECRET = `synthetic-${Math.random().toString(36).slice(2)}`
const AUTHORIZED_USER = "u-authorized"
const INTRUDER = "u-intruder"

async function waitFor(predicate, message, maxIterations = 5000) {
  for (let index = 0; index < maxIterations; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`timed out: ${message}`)
}

function memoryStorage() {
  const map = new Map()
  const writes = []
  return {
    map,
    writes,
    get: async (key) => map.get(key),
    set: async (key, value) => {
      writes.push(key)
      map.set(key, value)
    },
    remove: async (key) => {
      map.delete(key)
    },
    scan: async ({ prefix } = {}) => ({
      entries: [...map.entries()].filter(([key]) => (prefix ? key.startsWith(prefix) : true)).map(([key, value]) => ({ key, value })),
    }),
  }
}

function spyFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

function jsonResponse(payload, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] ?? null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }
}

/**
 * A Telegram port that serves `updates` once and then keeps answering empty, so
 * the poller can be observed without a timer.
 */
function telegramPort(updates) {
  let served = false
  return spyFetch(async (url) => {
    if (url.includes("/getUpdates")) {
      if (served) return jsonResponse({ ok: true, result: [] })
      served = true
      return jsonResponse({ ok: true, result: updates })
    }
    return jsonResponse({ ok: true, result: {} })
  })
}

function telegramMessage({ messageId = 9, userId, text = "tg hello", chatId = "chat" } = {}) {
  return {
    message_id: messageId,
    chat: { id: chatId },
    text,
    ...(userId === undefined ? {} : { from: { id: userId } }),
    reply_to_message: { message_id: "tg-bot" },
  }
}

/**
 * Seed the durable chat correlation the composition's registry hydrates at
 * `ready`, so a Telegram reply can be resolved without publishing first. The key
 * space is the pinned one (`Contrato_Transportes_OpenClaw.md` §6.1).
 */
function seedTelegramCorrelation(storage, messageId = "tg-bot", sessionID = "ses_tg") {
  const hash = createHash("sha1").update(`telegram\u0000${messageId}`).digest("hex")
  storage.map.set(`rigel-v2/openclaw/registry/${hash}`, {
    sessionID,
    platform: "telegram",
    messageId,
    projectPath: "/p",
    createdAt: new Date().toISOString(),
  })
}

function registryWith(platform, messageId, sessionID) {
  const registry = createOpenclawRegistry({})
  registry.register({ sessionID, projectPath: "/p", platform, messageId, createdAt: new Date().toISOString() })
  return registry
}

function telegramReplyListener(overrides = {}) {
  return { telegramBotToken: SECRET, telegramChatId: "chat", pollIntervalMs: 500, ...overrides }
}

function inboundWith(replyListener, { telegramAuthorization, fetchImpl, registry, delivered = [], statusDocument } = {}) {
  const calls = []
  const handler = fetchImpl ?? telegramPort([])
  const recordingFetch = async (url, init = {}) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  const inbound = createOpenclawInbound({
    replyListener,
    ...(telegramAuthorization === undefined ? {} : { telegramAuthorization }),
    registry: registry ?? registryWith("telegram", "tg-bot", "ses_tg"),
    deliverInboundReply: async (input) => {
      delivered.push(input)
      return true
    },
    fetchImpl: recordingFetch,
    telegramApiBase: TELEGRAM_BASE,
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
    log: () => {},
    ...(statusDocument === undefined ? {} : { statusDocument }),
  })
  return { inbound, delivered, calls }
}

function harmonyComposition(config, { storage = memoryStorage(), fetchImpl = telegramPort([]), prompts = [] } = {}) {
  const lines = []
  const native = createNativeOpenclaw({
    context: { storage, session: { prompt: async (input) => { prompts.push(input); return {} } } },
    config,
    fetchImpl,
    env: {
      RIGEL_OPENCLAW_TELEGRAM_API_BASE: TELEGRAM_BASE,
      RIGEL_OPENCLAW_DISCORD_API_BASE: "http://127.0.0.1:9/discord",
    },
    log: (line) => lines.push(line),
  })
  return { native, lines, storage, prompts, fetchImpl }
}

/** A Telegram notification channel: it is what makes `channels` declared. */
const TELEGRAM_CHANNEL = { transport: "telegram", token: SECRET, chatId: "chat", instruction: "done", events: ["session.idle"] }
const DISCORD_CHANNEL = { transport: "discord", token: SECRET, channelId: "discord-channel", instruction: "done", events: ["session.idle"] }

describe("openclaw reply policy: telegram is a served identity with its own list", () => {
  test("#given a policy naming telegram #when resolved #then exactly those users are authorized once", () => {
    const policy = resolveOpenclawReplyPolicy({ telegram: { allowedAuthors: [AUTHORIZED_USER, "u2", AUTHORIZED_USER] } })

    expect(policy.declared).toBe(true)
    expect(policy.diagnostics).toEqual([])
    expect(policy.identities).toEqual([{ identity: "telegram", allowedAuthors: [AUTHORIZED_USER, "u2"] }])
    expect(authorizeTelegramAuthors(policy)).toEqual({
      source: "replyPolicy",
      explicit: true,
      allowedAuthors: [AUTHORIZED_USER, "u2"],
    })
  })

  test("#given a telegram block that cannot authorize anybody #when resolved #then one named diagnostic and no user", () => {
    const policy = resolveOpenclawReplyPolicy({ telegram: { allowedAuthors: [] } })
    const telegramDiagnostics = policy.diagnostics.filter((diagnostic) => diagnostic.identity === "telegram")

    expect(telegramDiagnostics).toEqual([
      { path: "openclaw.replyPolicy.telegram.allowedAuthors", reason: "missing-authorized-authors", identity: "telegram" },
    ])
    expect(authorizeTelegramAuthors(policy)).toEqual({ source: "replyPolicy", explicit: false, allowedAuthors: [] })
  })

  test("#given a rejected telegram policy #when described #then the line names the key and never a user id", () => {
    const line = describeOpenclawReplyPolicyDiagnostic({
      path: "openclaw.replyPolicy.telegram.allowedAuthors",
      reason: "invalid-authorized-authors",
    })

    expect(line).toContain("openclaw.replyPolicy.telegram.allowedAuthors")
    expect(line).not.toContain(AUTHORIZED_USER)
  })
})

describe("openclaw inbound: the Telegram poller filters by user, not only by chat", () => {
  test("#given a telegram list authorizing one user #when that user replies #then it is injected with the pinned prefix and acked", async () => {
    const { inbound, delivered, calls } = inboundWith(telegramReplyListener(), {
      telegramAuthorization: { source: "replyPolicy", explicit: true, allowedAuthors: [AUTHORIZED_USER] },
      fetchImpl: telegramPort([{ update_id: 7, message: telegramMessage({ userId: AUTHORIZED_USER }) }]),
    })

    await inbound.start()
    await waitFor(() => delivered.length > 0, "telegram injection")
    await inbound.stop()

    expect(delivered).toEqual([{ sessionID: "ses_tg", text: "[reply:telegram] tg hello" }])
    const ack = calls.find((call) => call.url.includes("/sendMessage"))
    expect(ack).toBeDefined()
    expect(ack.init.method).toBe("POST")
    expect(inbound.status().messagesInjected).toBe(1)
    expect(inbound.status().telegramAuthorization).toEqual({ source: "replyPolicy", explicit: true })
  })

  test("#given a telegram list authorizing one user #when an intruder writes in the same chat #then it is dropped with no line, no counter and no response", async () => {
    const storage = memoryStorage()
    const statusDocument = createOpenclawStatusDocument({ storage })
    const { inbound, delivered, calls } = inboundWith(telegramReplyListener(), {
      telegramAuthorization: { source: "replyPolicy", explicit: true, allowedAuthors: [AUTHORIZED_USER] },
      fetchImpl: telegramPort([
        { update_id: 1, message: telegramMessage({ messageId: 10, userId: AUTHORIZED_USER, text: "mine" }) },
        { update_id: 2, message: telegramMessage({ messageId: 11, userId: INTRUDER, text: "intruder" }) },
      ]),
      statusDocument,
    })

    await inbound.start()
    await waitFor(() => delivered.length > 0, "authorized injection")
    await inbound.stop()

    // §9.3: silence is deliberate — answering would be an oracle.
    expect(delivered).toEqual([{ sessionID: "ses_tg", text: "[reply:telegram] mine" }])
    expect(inbound.status().messagesInjected).toBe(1)
    expect(inbound.status().errors).toBe(0)
    expect(statusDocument.snapshot().surfaces).toEqual({})
    expect(storage.writes).toEqual([])
    const acks = calls.filter((call) => call.url.includes("/sendMessage"))
    expect(acks).toHaveLength(1)
    expect(JSON.parse(acks[0].init.body)).toMatchObject({ reply_to_message_id: 10 })
  })

  test("#given a telegram list authorizing one user #when the message carries no author #then it is refused", async () => {
    const { inbound, delivered, calls } = inboundWith(telegramReplyListener(), {
      telegramAuthorization: { source: "replyPolicy", explicit: true, allowedAuthors: [AUTHORIZED_USER] },
      fetchImpl: telegramPort([{ update_id: 3, message: telegramMessage({ userId: undefined }) }]),
    })

    await inbound.start()
    await waitFor(() => calls.some((call) => call.url.includes("/getUpdates")), "telegram poll")
    await inbound.stop()

    expect(delivered).toEqual([])
  })

  test("#given a telegram authorization that authorizes nobody #when the listener starts #then the poller never opens", async () => {
    const fetchImpl = telegramPort([{ update_id: 4, message: telegramMessage({ userId: AUTHORIZED_USER }) }])
    const { inbound, delivered } = inboundWith(telegramReplyListener(), {
      telegramAuthorization: { source: "replyPolicy", explicit: false, allowedAuthors: [] },
      fetchImpl,
    })

    const started = await inbound.start()

    expect(started).toEqual({ started: false, reason: "no-credentials" })
    expect(inbound.status().platforms.telegram).toBe(false)
    expect(inbound.status().telegramAuthorization).toEqual({ source: "replyPolicy", explicit: false })
    expect(delivered).toEqual([])
    expect(fetchImpl.calls).toEqual([])
  })

  test("#given no telegram authorization at all #when an unknown user writes in the configured chat #then the legacy chat-only filter still injects it", async () => {
    const { inbound, delivered } = inboundWith(telegramReplyListener(), {
      fetchImpl: telegramPort([{ update_id: 5, message: telegramMessage({ userId: "someone-else" }) }]),
    })

    await inbound.start()
    await waitFor(() => delivered.length > 0, "legacy telegram injection")
    await inbound.stop()

    expect(delivered).toEqual([{ sessionID: "ses_tg", text: "[reply:telegram] tg hello" }])
    expect(inbound.status().telegramAuthorization).toBeUndefined()
  })
})

describe("openclaw composition: the new namespace requires a Telegram user list", () => {
  test("#given channels declared and a telegram reply port with no user list #when composed #then one banner names the key, the fatal is recorded and no poll happens", async () => {
    const { native, lines, storage, fetchImpl } = harmonyComposition({
      enabled: true,
      channels: { alerts: TELEGRAM_CHANNEL },
      replyListener: telegramReplyListener(),
    })

    const ready = await native.ready

    const banners = lines.filter((line) => line.includes("openclaw.replyPolicy.telegram.allowedAuthors"))
    expect(banners).toHaveLength(1)
    expect(banners[0]).not.toContain(SECRET)
    expect(ready).toEqual({ started: false, reason: "no-credentials" })
    expect(native.inbound.status().platforms.telegram).toBe(false)
    expect(storage.map.get(OPENCLAW_STATUS_KEY).surfaces.telegram).toMatchObject({
      state: "fatal",
      errorClass: "missing-authorized-authors",
    })
    expect(fetchImpl.calls.filter((call) => call.url.includes("/getUpdates"))).toEqual([])
    // No policy was declared, so the composition still reports only the surfaces a
    // policy can speak about; the banner and the fatal carry the Telegram decision.
    expect(native.status().authorization).toBeUndefined()
    await native.dispose()
  })

  test("#given channels declared and a telegram user list #when an authorized user replies #then it is injected and nothing is reported", async () => {
    const storage = memoryStorage()
    seedTelegramCorrelation(storage)
    const { native, lines, fetchImpl, prompts } = harmonyComposition(
      {
        enabled: true,
        channels: { alerts: TELEGRAM_CHANNEL },
        replyPolicy: { telegram: { allowedAuthors: [AUTHORIZED_USER] } },
        replyListener: telegramReplyListener(),
      },
      {
        storage,
        fetchImpl: telegramPort([
          { update_id: 1, message: telegramMessage({ messageId: 20, userId: AUTHORIZED_USER, text: "mine" }) },
          { update_id: 2, message: telegramMessage({ messageId: 21, userId: INTRUDER, text: "intruder" }) },
        ]),
      },
    )

    const ready = await native.ready
    await waitFor(() => prompts.length > 0, "telegram injection")
    await native.dispose()

    expect(ready).toEqual({ started: true })
    expect(native.inbound.status().messagesInjected).toBe(1)
    expect(lines.filter((line) => /reply policy|stay off/.test(line))).toEqual([])
    expect(native.status().authorization.telegram).toEqual({ source: "replyPolicy", explicit: true })
    expect(fetchImpl.calls.some((call) => call.url.includes("/getUpdates"))).toBe(true)
  })

  test("#given a telegram block that authorizes nobody #when composed #then it is reported once and the document records the closed surface", async () => {
    const { native, lines, storage, fetchImpl } = harmonyComposition({
      enabled: true,
      channels: { alerts: TELEGRAM_CHANNEL },
      replyPolicy: { telegram: {} },
      replyListener: telegramReplyListener(),
    })

    const ready = await native.ready

    expect(lines.filter((line) => line.includes("openclaw.replyPolicy.telegram.allowedAuthors"))).toHaveLength(1)
    expect(ready).toEqual({ started: false, reason: "no-credentials" })
    expect(storage.map.get(OPENCLAW_STATUS_KEY).surfaces.telegram).toMatchObject({
      state: "fatal",
      errorClass: "missing-authorized-authors",
    })
    expect(fetchImpl.calls).toEqual([])
    await native.dispose()
  })

  test("#given a legacy telegram replyListener plus replyPolicy without channels #when the list is absent then restored #then polling stays closed then resumes while Discord remains legacy", async () => {
    const replyListener = {
      ...telegramReplyListener(),
      discordBotToken: SECRET,
      discordChannelId: "discord",
      authorizedDiscordUserIds: [AUTHORIZED_USER],
    }
    const closedFetch = telegramPort([])
    const { native: closed, fetchImpl: closedFetchImpl } = harmonyComposition({
      enabled: true,
      replyPolicy: { telegram: {} },
      replyListener,
    }, { fetchImpl: closedFetch })

    expect(await closed.ready).toEqual({ started: true })
    expect(closed.inbound.status().platforms).toMatchObject({ discord: true, telegram: false })
    expect(closedFetchImpl.calls.filter((call) => call.url.includes("/getUpdates"))).toEqual([])
    await closed.dispose()

    const storage = memoryStorage()
    seedTelegramCorrelation(storage)
    const resumedFetch = telegramPort([{
      update_id: 10,
      message: telegramMessage({ messageId: 34, userId: AUTHORIZED_USER, text: "authorized" }),
    }])
    const { native: resumed, fetchImpl: resumedFetchImpl, prompts } = harmonyComposition({
      enabled: true,
      replyPolicy: { telegram: { allowedAuthors: [AUTHORIZED_USER] } },
      replyListener,
    }, { storage, fetchImpl: resumedFetch })

    expect(await resumed.ready).toEqual({ started: true })
    await waitFor(() => prompts.length > 0, "authorized Telegram reply after list declaration")
    expect(resumed.inbound.status().platforms).toMatchObject({ discord: true, telegram: true })
    expect(resumedFetchImpl.calls.some((call) => call.url.includes("/getUpdates"))).toBe(true)
    expect(prompts).toEqual([{ sessionID: "ses_tg", text: "[reply:telegram] authorized", delivery: "queue" }])
    await resumed.dispose()
  })

  test("#given a legacy telegram listener and a replyPolicy naming only Discord #when composed #then Telegram stays on its chat-only route", async () => {
    const storage = memoryStorage()
    seedTelegramCorrelation(storage)
    const { native, lines, fetchImpl, prompts } = harmonyComposition({
      enabled: true,
      replyPolicy: { "discord-bot": { allowedAuthors: [AUTHORIZED_USER] } },
      replyListener: telegramReplyListener(),
    }, {
      storage,
      fetchImpl: telegramPort([{ update_id: 11, message: telegramMessage({ messageId: 35, userId: INTRUDER, text: "legacy" }) }]),
    })

    expect(await native.ready).toEqual({ started: true })
    await waitFor(() => prompts.length > 0, "Telegram legacy reply without Telegram policy")
    expect(native.inbound.status().platforms.telegram).toBe(true)
    expect(fetchImpl.calls.some((call) => call.url.includes("/getUpdates"))).toBe(true)
    expect(prompts).toEqual([{ sessionID: "ses_tg", text: "[reply:telegram] legacy", delivery: "queue" }])
    expect(lines.filter((line) => line.includes("Telegram replies stay off"))).toEqual([])
    await native.dispose()
  })

  test("#given a legacy telegram config #when composed #then the chat-only filter runs and no new line appears", async () => {
    const storage = memoryStorage()
    seedTelegramCorrelation(storage)
    const { native, lines, prompts } = harmonyComposition(
      { enabled: true, replyListener: telegramReplyListener() },
      {
        storage,
        fetchImpl: telegramPort([{ update_id: 6, message: telegramMessage({ messageId: 30, userId: "someone-else", text: "legacy" }) }]),
      },
    )

    const ready = await native.ready
    await waitFor(() => prompts.length > 0, "legacy telegram injection")
    await native.dispose()

    expect(ready).toEqual({ started: true })
    expect(prompts[0]).toEqual({ sessionID: "ses_tg", text: "[reply:telegram] legacy", delivery: "queue" })
    // Only the listener lifecycle speaks; no authorization line and no stay-off line.
    expect(lines.filter((line) => !line.includes("reply listener"))).toEqual([])
    expect(storage.map.has(OPENCLAW_STATUS_KEY)).toBe(false)
    expect(native.status().authorization).toBeUndefined()
  })

  test("#given a malformed named Telegram channel #when composed #then only Telegram is closed and named", async () => {
    const { native, lines, storage, fetchImpl } = harmonyComposition({
      enabled: true,
      channels: { telegram: "not-an-object" },
      replyListener: telegramReplyListener(),
    })

    const ready = await native.ready

    expect(ready).toEqual({ started: false, reason: "no-credentials" })
    expect(fetchImpl.calls).toEqual([])
    expect(lines.some((line) => line.includes("openclaw.channels.telegram"))).toBe(true)
    expect(storage.map.get(OPENCLAW_STATUS_KEY).surfaces).toMatchObject({
      telegram: { state: "fatal", errorClass: "missing-authorized-authors" },
      "channels.telegram": { state: "fatal", errorClass: "not-an-object" },
    })
    await native.dispose()
  })

  test("#given an A2A-only channel block #when a legacy Telegram listener runs #then chat stays on the legacy route", async () => {
    const storage = memoryStorage()
    seedTelegramCorrelation(storage)
    const { native, lines, prompts } = harmonyComposition(
      {
        enabled: true,
        channels: { a2a: { enabled: true, peers: { alpha: { token: SECRET, url: "https://peer.test" } } } },
        replyListener: telegramReplyListener(),
      },
      {
        storage,
        fetchImpl: telegramPort([{ update_id: 7, message: telegramMessage({ messageId: 31, userId: "someone-else", text: "a2a" }) }]),
      },
    )

    const ready = await native.ready
    await waitFor(() => prompts.length > 0, "A2A-only legacy Telegram injection")
    await native.dispose()

    expect(ready).toEqual({ started: true })
    expect(prompts[0]).toEqual({ sessionID: "ses_tg", text: "[reply:telegram] a2a", delivery: "queue" })
    expect(native.status().authorization).toBeUndefined()
    expect(lines.filter((line) => /reply policy|stay off/.test(line))).toEqual([])
  })

  test("#given a Discord channel declaration #when a legacy Telegram listener runs #then Telegram stays on the legacy route", async () => {
    const storage = memoryStorage()
    seedTelegramCorrelation(storage)
    const { native, lines, prompts } = harmonyComposition(
      { enabled: true, channels: { discord: DISCORD_CHANNEL }, replyListener: telegramReplyListener() },
      {
        storage,
        fetchImpl: telegramPort([{ update_id: 8, message: telegramMessage({ messageId: 32, userId: "someone-else", text: "discord" }) }]),
      },
    )

    const ready = await native.ready
    await waitFor(() => prompts.length > 0, "Discord-only legacy Telegram injection")
    await native.dispose()

    expect(ready).toEqual({ started: true })
    expect(prompts[0]).toEqual({ sessionID: "ses_tg", text: "[reply:telegram] discord", delivery: "queue" })
    expect(native.status().authorization).toBeUndefined()
    expect(lines.filter((line) => /reply policy|stay off/.test(line))).toEqual([])
  })

  test("#given an empty channel namespace #when a legacy Telegram listener runs #then chat stays indistinguishable from no namespace", async () => {
    const storage = memoryStorage()
    seedTelegramCorrelation(storage)
    const { native, lines, prompts } = harmonyComposition(
      { enabled: true, channels: {}, replyListener: telegramReplyListener() },
      {
        storage,
        fetchImpl: telegramPort([{ update_id: 9, message: telegramMessage({ messageId: 33, userId: "someone-else", text: "empty" }) }]),
      },
    )

    const ready = await native.ready
    await waitFor(() => prompts.length > 0, "empty namespace legacy Telegram injection")
    await native.dispose()

    expect(ready).toEqual({ started: true })
    expect(prompts[0]).toEqual({ sessionID: "ses_tg", text: "[reply:telegram] empty", delivery: "queue" })
    expect(native.status().authorization).toBeUndefined()
    expect(lines.filter((line) => /reply policy|stay off/.test(line))).toEqual([])
  })
})
