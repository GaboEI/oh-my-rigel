import { describe, expect, test } from "bun:test"
import { createNativeOpenclaw } from "./rigel-v2-native-openclaw.mjs"
import {
  auditOpenclawSecretRefs,
  parseOpenclawSecretRef,
  resolveOpenclawReplyListenerSecrets,
  resolveOpenclawSecretRef,
} from "./rigel-v2-native-openclaw-secrets.mjs"

const DISCORD_API_BASE = "http://127.0.0.1:1/discord"
const SECRET = "discord-secret-value-8f21"

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

/** Records every poll so a disabled surface is provable by the ABSENCE of requests. */
function recordingFetch(onUrl = () => undefined) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    onUrl(String(url))
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ result: [] }), text: async () => "" }
  }
  fetchImpl.calls = calls
  return fetchImpl
}

/** The composition's own credential lines, isolated from the listener's lifecycle noise. */
function credentialDiagnostics(logs) {
  return logs.filter((line) => line.startsWith("[oh-my-rigel] Native V2 openclaw credential "))
}

async function waitFor(predicate, message, maxIterations = 5000) {
  for (let index = 0; index < maxIterations; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`timed out: ${message}`)
}

/** Counts reads of the credential variables only, so setup-vs-send is measurable. */
function countingEnv(target, names) {
  const reads = []
  const proxy = new Proxy(target, {
    get(object, property) {
      if (typeof property === "string" && names.includes(property)) reads.push(property)
      return Reflect.get(object, property)
    },
  })
  return { env: proxy, reads }
}

const bothPlatforms = {
  discordBotToken: "env:DISCORD_BOT_TOKEN",
  discordChannelId: "c1",
  authorizedDiscordUserIds: ["u1"],
  telegramBotToken: { env: "TELEGRAM_BOT_TOKEN" },
  telegramChatId: "42",
  pollIntervalMs: 500,
}

describe("OpenClaw secret references", () => {
  test("#given both reference forms #when resolved #then they name the same variable and resolve to the same secret", () => {
    // given
    const env = { DISCORD_BOT_TOKEN: SECRET }

    // when
    const shortForm = resolveOpenclawSecretRef("env:DISCORD_BOT_TOKEN", { env })
    const preferredForm = resolveOpenclawSecretRef({ env: "DISCORD_BOT_TOKEN" }, { env })

    // then
    expect(parseOpenclawSecretRef("env:DISCORD_BOT_TOKEN")).toEqual({ kind: "env", name: "DISCORD_BOT_TOKEN" })
    expect(parseOpenclawSecretRef({ env: "DISCORD_BOT_TOKEN" })).toEqual({ kind: "env", name: "DISCORD_BOT_TOKEN" })
    expect(shortForm).toEqual({ ok: true, value: SECRET })
    expect(preferredForm).toEqual(shortForm)
  })

  test("#given a plaintext token #when composed #then the listener starts exactly as before and nothing is reported", async () => {
    // given
    const fetchImpl = recordingFetch()
    const logs = []
    const native = createNativeOpenclaw({
      context: { storage: memoryStorage(), session: { prompt: async () => ({}) } },
      config: { enabled: true, gateways: {}, hooks: {}, replyListener: { ...bothPlatforms, discordBotToken: SECRET, telegramBotToken: "tg-plain" } },
      env: { RIGEL_OPENCLAW_DISCORD_API_BASE: DISCORD_API_BASE },
      fetchImpl,
      log: (line) => logs.push(line),
    })

    // when
    const ready = await native.ready

    // then
    expect(ready).toEqual({ started: true })
    expect(native.inbound.status().platforms).toEqual({ discord: true, telegram: true })
    expect(credentialDiagnostics(logs)).toEqual([])
    await native.dispose()
  })

  test("#given an absent token #when composed #then that surface is simply down and it is not an error", async () => {
    // given
    const logs = []
    const native = createNativeOpenclaw({
      context: { storage: memoryStorage(), session: { prompt: async () => ({}) } },
      config: { enabled: true, gateways: {}, hooks: {}, replyListener: { telegramBotToken: "env:TELEGRAM_BOT_TOKEN", telegramChatId: "42", pollIntervalMs: 500 } },
      env: { TELEGRAM_BOT_TOKEN: "tg" },
      fetchImpl: recordingFetch(),
      log: (line) => logs.push(line),
    })

    // when
    const ready = await native.ready

    // then
    expect(ready).toEqual({ started: true })
    expect(native.inbound.status().platforms).toEqual({ discord: false, telegram: true })
    expect(credentialDiagnostics(logs)).toEqual([])
    await native.dispose()
  })

  test("#given references #when events flow #then each variable is read once at setup and never on a send", async () => {
    // given
    const { env, reads } = countingEnv(
      { DISCORD_BOT_TOKEN: SECRET, TELEGRAM_BOT_TOKEN: "tg", RIGEL_OPENCLAW_DISCORD_API_BASE: DISCORD_API_BASE },
      ["DISCORD_BOT_TOKEN", "TELEGRAM_BOT_TOKEN"],
    )
    const native = createNativeOpenclaw({
      context: { storage: memoryStorage(), session: { prompt: async () => ({}) } },
      config: { enabled: true, gateways: { h: { url: "https://gateway.test/h" } }, hooks: { "session.idle": { gateway: "h", instruction: "go" } }, replyListener: bothPlatforms },
      env,
      fetchImpl: recordingFetch(),
      log: () => {},
    })
    await native.ready
    const afterSetup = [...reads]

    // when
    await native.handleEvent({ type: "session.idle", sessionID: "s1" })
    await native.handleEvent({ type: "session.idle", sessionID: "s2" })

    // then
    expect(afterSetup).toEqual(["DISCORD_BOT_TOKEN", "TELEGRAM_BOT_TOKEN"])
    expect(reads).toEqual(afterSetup)
    await native.dispose()
  })

  test("#given one unresolvable reference #when composed #then only that surface stays down and the diagnostic names key and variable, never a value", async () => {
    // given
    const fetchImpl = recordingFetch()
    const logs = []
    const native = createNativeOpenclaw({
      context: { storage: memoryStorage(), session: { prompt: async () => ({}) } },
      config: { enabled: true, gateways: {}, hooks: {}, replyListener: bothPlatforms },
      env: { TELEGRAM_BOT_TOKEN: "tg" },
      fetchImpl,
      log: (line) => logs.push(line),
    })

    // when
    const ready = await native.ready
    await waitFor(() => fetchImpl.calls.some((url) => url.includes("getUpdates")), "the healthy surface polls")

    // then
    expect(ready).toEqual({ started: true })
    expect(native.inbound.status().platforms).toEqual({ discord: false, telegram: true })
    const diagnostics = credentialDiagnostics(logs)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toContain("openclaw.replyListener.discordBotToken")
    expect(diagnostics[0]).toContain("DISCORD_BOT_TOKEN")
    expect(fetchImpl.calls.every((url) => !url.includes(DISCORD_API_BASE))).toBe(true)
    await native.dispose()
  })

  test("#given a malformed reference #when composed #then that surface fails closed and no value is echoed", async () => {
    // given
    const malformed = ["env:", "env:not a name", { env: "" }, { env: 42 }, { env: "OK", extra: 1 }, { DISCORD_BOT_TOKEN: SECRET }]
    const observed = []

    // when
    for (const discordBotToken of malformed) {
      const logs = []
      const native = createNativeOpenclaw({
        context: { storage: memoryStorage(), session: { prompt: async () => ({}) } },
        config: { enabled: true, gateways: {}, hooks: {}, replyListener: { ...bothPlatforms, discordBotToken } },
        env: { DISCORD_BOT_TOKEN: SECRET, TELEGRAM_BOT_TOKEN: "tg" },
        fetchImpl: recordingFetch(),
        log: (line) => logs.push(line),
      })
      const ready = await native.ready
      observed.push({ ready, platforms: native.inbound.status().platforms, diagnostics: credentialDiagnostics(logs) })
      await native.dispose()
    }

    // then
    for (const entry of observed) {
      expect(entry.ready).toEqual({ started: true })
      expect(entry.platforms).toEqual({ discord: false, telegram: true })
      expect(entry.diagnostics).toHaveLength(1)
      expect(entry.diagnostics[0]).toContain("openclaw.replyListener.discordBotToken")
      expect(entry.diagnostics[0]).not.toContain(SECRET)
    }
  })

  test("#given a resolved secret #when the surface starts #then the secret appears in no diagnostic", async () => {
    // given
    const logs = []
    const native = createNativeOpenclaw({
      context: { storage: memoryStorage(), session: { prompt: async () => ({}) } },
      config: { enabled: true, gateways: {}, hooks: {}, replyListener: { ...bothPlatforms, telegramBotToken: { env: "MISSING_TELEGRAM_TOKEN" } } },
      env: { DISCORD_BOT_TOKEN: SECRET, RIGEL_OPENCLAW_DISCORD_API_BASE: DISCORD_API_BASE },
      fetchImpl: recordingFetch(),
      log: (line) => logs.push(line),
    })

    // when
    await native.ready
    await native.dispose()

    // then
    const diagnostics = credentialDiagnostics(logs)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toContain("MISSING_TELEGRAM_TOKEN")
    expect(logs.join("\n")).not.toContain(SECRET)
  })

  test("#given a disabled block #when composed #then a broken reference stays silent because nothing is active", async () => {
    // given
    const logs = []
    const fetchImpl = recordingFetch()
    const native = createNativeOpenclaw({
      context: { storage: memoryStorage(), session: { prompt: async () => ({}) } },
      config: { enabled: false, gateways: {}, hooks: {}, replyListener: bothPlatforms },
      env: {},
      fetchImpl,
      log: (line) => logs.push(line),
    })

    // when
    const ready = await native.ready

    // then
    expect(ready).toEqual({ started: false, reason: "disabled" })
    expect(credentialDiagnostics(logs)).toEqual([])
    expect(fetchImpl.calls).toEqual([])
    await native.dispose()
  })

  test("#given a resolved reference #when the listener polls #then the transport carries the resolved secret, not the reference", async () => {
    // given
    const fetchImpl = recordingFetch()

    // when
    const native = createNativeOpenclaw({
      context: { storage: memoryStorage(), session: { prompt: async () => ({}) } },
      config: { enabled: true, gateways: {}, hooks: {}, replyListener: { telegramBotToken: { env: "TELEGRAM_BOT_TOKEN" }, telegramChatId: "42", pollIntervalMs: 500 } },
      env: { TELEGRAM_BOT_TOKEN: "resolved-telegram-77" },
      fetchImpl,
      log: () => {},
    })
    await native.ready
    await waitFor(() => fetchImpl.calls.some((url) => url.includes("getUpdates")), "the listener polls Telegram")

    // then
    expect(fetchImpl.calls.some((url) => url.includes("/botresolved-telegram-77/getUpdates"))).toBe(true)
    expect(fetchImpl.calls.every((url) => !url.includes("TELEGRAM_BOT_TOKEN"))).toBe(true)
    await native.dispose()
  })

  test("#given a resolved block #when audited for installation #then references and plaintext paths are separated without exposing values", () => {
    // given
    const openclaw = {
      enabled: true,
      replyListener: { discordBotToken: "env:DISCORD_BOT_TOKEN", telegramBotToken: "plain-tg" },
    }

    // when
    const audit = auditOpenclawSecretRefs(openclaw)

    // then
    expect(audit).toEqual({
      references: ["openclaw.replyListener.discordBotToken"],
      plaintext: ["openclaw.replyListener.telegramBotToken"],
      invalid: [],
    })
    expect(JSON.stringify(audit)).not.toContain("plain-tg")
    expect(JSON.stringify(audit)).not.toContain("DISCORD_BOT_TOKEN\",")
  })

  test("#given a reference block #when resolved for the listener #then the caller's block still holds the reference verbatim", () => {
    // given
    const replyListener = { discordBotToken: { env: "DISCORD_BOT_TOKEN" }, telegramBotToken: "env:TELEGRAM_BOT_TOKEN" }

    // when
    const resolved = resolveOpenclawReplyListenerSecrets(replyListener, { env: { DISCORD_BOT_TOKEN: SECRET, TELEGRAM_BOT_TOKEN: "tg" } })

    // then
    expect(resolved.replyListener).toEqual({ discordBotToken: SECRET, telegramBotToken: "tg" })
    expect(resolved.diagnostics).toEqual([])
    expect(replyListener).toEqual({ discordBotToken: { env: "DISCORD_BOT_TOKEN" }, telegramBotToken: "env:TELEGRAM_BOT_TOKEN" })
  })
})
