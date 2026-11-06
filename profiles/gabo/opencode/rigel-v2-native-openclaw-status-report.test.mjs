import { describe, expect, test } from "bun:test"
import { createNativeOpenclaw } from "./rigel-v2-native-openclaw.mjs"
import { createOpenclawInbound } from "./rigel-v2-native-openclaw-inbound.mjs"
import { createOpenclawRegistry } from "./rigel-v2-native-openclaw-registry.mjs"
import {
  OPENCLAW_DISCORD_STATUS_SURFACE,
  OPENCLAW_INJECTION_STATUS_SURFACE,
  OPENCLAW_TELEGRAM_STATUS_SURFACE,
} from "./rigel-v2-native-openclaw-inbound.mjs"
import { OPENCLAW_STATUS_KEY, createOpenclawStatusDocument } from "./rigel-v2-native-openclaw-agent-status.mjs"
import {
  OPENCLAW_STATUS_COMMAND_NAME,
  createOpenclawStatusCommand,
  formatOpenclawStatusReport,
  registerOpenclawStatusCommand,
} from "./rigel-v2-native-openclaw-status-command.mjs"

// U4, `Unidades_Atomicas_OpenClaw.md` §U4 and
// `Contrato_Transportes_OpenClaw.md` §9. The unit closes the silent half of the
// surface:
//
//   - a `fatal` (invalid configuration, unreadable live chain, unusable
//     credential) leaves a STARTUP BANNER and a `fatal` surface in the document;
//   - a `degraded` failure becomes exactly ONE line per transition, deduplicated
//     by class, and a recovery is one more line;
//   - `/openclaw-status` reflects the document on demand;
//   - §9.3 stays intact: an individual rate-limit drop and an unauthorized author
//     produce NO line and NO transition, only the aggregate counter (or nothing at
//     all for the author, whose silence is deliberate).
//
// The 26 pinned tests in the four legacy suites do not change: the reporting is
// additive and a healthy legacy dispatch still writes nothing.

const STATUS_PREFIX = "[oh-my-rigel] openclaw surface "
// Row 30 / U-P16: a legacy gateway delivery owns the row `outbound:<gatewayName>`.
const OUTBOUND_ROW = "outbound:hook"

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

function statusLines(lines) {
  return lines.filter((line) => line.startsWith(STATUS_PREFIX))
}

function recordingFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

function okGateway() {
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{"messageId":"m1","platform":"discord"}' }
}

const LEGACY_CONFIG = {
  enabled: true,
  gateways: { hook: { url: "https://gateway.test/hook" } },
  hooks: { "session.idle": { gateway: "hook", instruction: "notify {{sessionId}}" } },
}

function context(storage, delivered = []) {
  return { storage, session: { prompt: async (input) => { delivered.push(input); return {} } } }
}

describe("openclaw status: a fatal leaves a startup banner and a fatal surface", () => {
  test("#given an invalid configuration #when composed #then one line is emitted and the document records why the surface is down", async () => {
    // given
    const lines = []
    const native = createNativeOpenclaw({
      context: context(memoryStorage()),
      config: { enabled: true, gateways: { primary: { url: "https://gateway.test", stray: true } }, hooks: {} },
      fetchImpl: recordingFetch(() => okGateway()),
      log: (line) => lines.push(line),
    })

    // when
    const ready = await native.ready
    const report = await native.report()

    // then
    expect(ready).toEqual({ started: false, reason: "disabled" })
    // Exactly one line, and it is the configuration error, not a second banner.
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("openclaw.gateways.primary.stray")
    expect(report.surfaces.config).toMatchObject({ state: "fatal", errorClass: "OpenclawConfigValidationError" })
    await native.dispose()
  })

  test("#given a live chain that could not be resolved #when composed #then the surface stays inert and the document says the read failed", async () => {
    // given
    const lines = []
    const native = createNativeOpenclaw({
      context: context(memoryStorage()),
      config: undefined,
      configState: "error",
      fetchImpl: recordingFetch(() => okGateway()),
      log: (line) => lines.push(line),
    })

    // when
    const ready = await native.ready
    const report = await native.report()

    // then
    expect(ready).toEqual({ started: false, reason: "disabled" })
    // The resolver already announced the failure at the call site; the document
    // must not announce it a second time.
    expect(statusLines(lines)).toEqual([])
    expect(report.surfaces.config).toMatchObject({ state: "fatal", errorClass: "live-config-error" })
    await native.dispose()
  })

  test("#given an unresolvable credential reference #when composed #then the credential line stays single and the surface is recorded fatal", async () => {
    // given
    const lines = []
    const native = createNativeOpenclaw({
      context: context(memoryStorage()),
      config: {
        enabled: true,
        gateways: {},
        hooks: {},
        replyListener: { discordBotToken: "env:MISSING_DISCORD_TOKEN", discordChannelId: "c1", authorizedDiscordUserIds: ["u1"] },
      },
      env: {},
      fetchImpl: recordingFetch(() => okGateway()),
      log: (line) => lines.push(line),
    })

    // when
    await native.ready
    const report = await native.report()

    // then
    const credentialLines = lines.filter((line) => line.includes("openclaw credential"))
    expect(credentialLines).toHaveLength(1)
    expect(credentialLines[0]).toContain("openclaw.replyListener.discordBotToken")
    expect(credentialLines[0]).toContain("MISSING_DISCORD_TOKEN")
    expect(statusLines(lines)).toEqual([])
    expect(report.surfaces["credentials.discord"]).toMatchObject({ state: "fatal", errorClass: "missing-env-variable" })
    await native.dispose()
  })

  // A `fatal` is a setup verdict, and the durable document keeps it forever unless
  // the setup that just ran is allowed to contradict it. Reconciling is the whole
  // point of the row: `/openclaw-status` on a repaired install must stop saying a
  // surface is disabled.
  test("#given a persisted setup fatal whose cause now resolves #when the report is read #then the surface recovers and the runtime surface is left alone", async () => {
    // given
    const lines = []
    const storage = memoryStorage()
    const previous = createOpenclawStatusDocument({ storage, log: () => {} })
    await previous.recordFailure("config", { errorClass: "OpenclawConfigValidationError", fatal: true, emitLine: false })
    await previous.recordFailure("credentials.discord", { errorClass: "missing-env-variable", fatal: true, emitLine: false })
    // A runtime degradation is NOT a setup verdict: only traffic can prove it healed.
    await previous.recordFailure(OUTBOUND_ROW, { errorClass: "http-500" })
    const native = createNativeOpenclaw({
      context: context(storage),
      config: LEGACY_CONFIG,
      fetchImpl: recordingFetch(() => okGateway()),
      log: (line) => lines.push(line),
    })

    // when
    await native.ready
    const report = await native.report()

    // then
    expect(report.surfaces.config).toMatchObject({ state: "up", errorClass: null, consecutiveFailures: 0 })
    expect(report.surfaces["credentials.discord"]).toMatchObject({ state: "up", errorClass: null, consecutiveFailures: 0 })
    expect(report.surfaces[OUTBOUND_ROW]).toMatchObject({ state: "degraded", errorClass: "http-500" })
    // One line per transition: exactly the two recoveries, and none on a second read.
    const recoveries = () => statusLines(lines).filter((line) => line.includes("surface recovered:"))
    expect(recoveries()).toEqual([
      "[oh-my-rigel] openclaw surface recovered: config",
      "[oh-my-rigel] openclaw surface recovered: credentials.discord",
    ])
    await native.report()
    expect(recoveries()).toHaveLength(2)
    // Durability: the clear is persisted, so a restart cannot resurrect the fatal.
    expect(storage.map.get(OPENCLAW_STATUS_KEY).surfaces.config.state).toBe("up")
    const restarted = createNativeOpenclaw({
      context: context(storage),
      config: LEGACY_CONFIG,
      fetchImpl: recordingFetch(() => okGateway()),
      log: () => {},
    })
    await restarted.ready
    const afterRestart = await restarted.report()
    expect(afterRestart.surfaces.config.state).toBe("up")
    expect(afterRestart.surfaces["credentials.discord"].state).toBe("up")
    expect(afterRestart.surfaces[OUTBOUND_ROW]).toMatchObject({ state: "degraded" })
    await restarted.dispose()
    await native.dispose()
  })

  test("#given a persisted setup fatal whose cause is still broken #when the report is read #then the surface stays fatal", async () => {
    // given
    const storage = memoryStorage()
    const previous = createOpenclawStatusDocument({ storage, log: () => {} })
    await previous.recordFailure("config", { errorClass: "live-config-error", fatal: true, emitLine: false })
    const lines = []
    const native = createNativeOpenclaw({
      context: context(storage),
      config: { enabled: true, gateways: { primary: { url: "https://gateway.test", stray: true } }, hooks: {} },
      fetchImpl: recordingFetch(() => okGateway()),
      log: (line) => lines.push(line),
    })

    // when
    await native.ready
    const report = await native.report()

    // then
    expect(report.surfaces.config).toMatchObject({ state: "fatal", errorClass: "OpenclawConfigValidationError" })
    expect(statusLines(lines).filter((line) => line.includes("surface recovered:"))).toEqual([])
    await native.dispose()
  })
})

describe("openclaw status: one line per transition", () => {
  test("#given a gateway that keeps failing #when the same class repeats #then exactly one degraded line is emitted and a new class or a recovery is a new line", async () => {
    // given
    const lines = []
    let mode = "http-500"
    const fetchImpl = recordingFetch(() => {
      if (mode === "http-500") return { ok: false, status: 500, headers: { get: () => null }, text: async () => "" }
      if (mode === "http-503") return { ok: false, status: 503, headers: { get: () => null }, text: async () => "" }
      if (mode === "throw") throw new Error("socket hang up")
      return okGateway()
    })
    const native = createNativeOpenclaw({ context: context(memoryStorage()), config: LEGACY_CONFIG, fetchImpl, log: (line) => lines.push(line) })
    await native.ready

    // when
    await native.handleEvent({ type: "session.idle", sessionID: "s1" })
    await native.handleEvent({ type: "session.idle", sessionID: "s2" })
    const afterRepeat = statusLines(lines)
    const degradedTwice = (await native.report()).surfaces[OUTBOUND_ROW]

    mode = "http-503"
    await native.handleEvent({ type: "session.idle", sessionID: "s3" })
    mode = "throw"
    await native.handleEvent({ type: "session.idle", sessionID: "s4" })
    mode = "ok"
    await native.handleEvent({ type: "session.idle", sessionID: "s5" })
    const final = await native.report()

    // then
    expect(afterRepeat).toHaveLength(1)
    expect(afterRepeat[0]).toContain(`surface degraded: ${OUTBOUND_ROW} (http-500)`)
    expect(afterRepeat[0]).toContain("after 1 consecutive failure(s)")
    expect(degradedTwice).toMatchObject({ state: "degraded", consecutiveFailures: 2 })
    expect(statusLines(lines)).toHaveLength(4)
    expect(statusLines(lines)[1]).toContain("(http-503)")
    expect(statusLines(lines)[2]).toContain("(transport-error)")
    expect(statusLines(lines)[3]).toContain(`surface recovered: ${OUTBOUND_ROW}`)
    expect(final.surfaces[OUTBOUND_ROW]).toMatchObject({ state: "up", consecutiveFailures: 0 })
    await native.dispose()
  })

  test("#given a listener whose polls fail #when the transport errors #then the poller surface reports the transition", async () => {
    // given
    const lines = []
    const fetchImpl = recordingFetch((url) => {
      if (url.includes("/channels/")) return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}), text: async () => "" }
      return okGateway()
    })
    const native = createNativeOpenclaw({
      context: context(memoryStorage()),
      config: {
        enabled: true,
        gateways: {},
        hooks: {},
        replyListener: { discordBotToken: "token", discordChannelId: "c1", authorizedDiscordUserIds: ["u1"], pollIntervalMs: 1 },
      },
      env: { RIGEL_OPENCLAW_DISCORD_API_BASE: "http://127.0.0.1:1/discord" },
      fetchImpl,
      log: (line) => lines.push(line),
    })

    // when
    await native.ready
    for (let index = 0; index < 5000 && statusLines(lines).length === 0; index += 1) await new Promise((resolve) => setImmediate(resolve))
    const report = await native.report()

    // then
    const transitions = statusLines(lines)
    expect(transitions.length).toBeGreaterThanOrEqual(1)
    expect(transitions[0]).toContain(`surface degraded: ${OPENCLAW_DISCORD_STATUS_SURFACE} (http-500)`)
    // Dedup: a second failing poll is the same transition and adds no line.
    expect(transitions.every((line) => line.includes(OPENCLAW_DISCORD_STATUS_SURFACE))).toBe(true)
    expect(report.surfaces[OPENCLAW_DISCORD_STATUS_SURFACE].consecutiveFailures).toBeGreaterThanOrEqual(1)
    await native.dispose()
  })

  // An HTTP 200 whose body is not a message list is not an empty window: the body
  // shape is the only evidence the poll succeeded, so accepting it reports a
  // misconfigured proxy as healthy and clears a real failure.
  test("#given a Discord poll body that is not a message list #when the request succeeds #then the surface reports a malformed response", async () => {
    // given
    const document = createOpenclawStatusDocument({ log: () => {} })
    const inbound = createOpenclawInbound({
      replyListener: { discordBotToken: "token", discordChannelId: "chan", authorizedDiscordUserIds: ["u1"], pollIntervalMs: 3000 },
      registry: createOpenclawRegistry({}),
      deliverInboundReply: async () => true,
      fetchImpl: recordingFetch(() => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ message: "the proxy answered with an object" }),
        text: async () => "",
      })),
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
      log: () => {},
      statusDocument: document,
    })

    // when
    await inbound.start()
    for (let index = 0; index < 5000 && document.snapshot().surfaces[OPENCLAW_DISCORD_STATUS_SURFACE] === undefined; index += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    await inbound.stop()

    // then
    expect(document.snapshot().surfaces[OPENCLAW_DISCORD_STATUS_SURFACE]).toMatchObject({
      state: "degraded",
      errorClass: "malformed-response",
    })
  })

  test("#given a Telegram poll body without an update list #when the request succeeds #then the surface reports a malformed response", async () => {
    // given
    const document = createOpenclawStatusDocument({ log: () => {} })
    const inbound = createOpenclawInbound({
      replyListener: { telegramBotToken: "t", telegramChatId: "chat", pollIntervalMs: 3000 },
      registry: createOpenclawRegistry({}),
      deliverInboundReply: async () => true,
      fetchImpl: recordingFetch(() => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }), text: async () => "" })),
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
      log: () => {},
      statusDocument: document,
    })

    // when
    await inbound.start()
    for (let index = 0; index < 5000 && document.snapshot().surfaces[OPENCLAW_TELEGRAM_STATUS_SURFACE] === undefined; index += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    await inbound.stop()

    // then
    expect(document.snapshot().surfaces[OPENCLAW_TELEGRAM_STATUS_SURFACE]).toMatchObject({
      state: "degraded",
      errorClass: "malformed-response",
    })
  })

  test("#given an empty message list #when the poll succeeds #then nothing is recorded: that window is healthy, not malformed", async () => {
    // given
    const document = createOpenclawStatusDocument({ log: () => {} })
    const fetchImpl = recordingFetch(() => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => [], text: async () => "" }))
    const inbound = createOpenclawInbound({
      replyListener: { discordBotToken: "token", discordChannelId: "chan", authorizedDiscordUserIds: ["u1"], pollIntervalMs: 3000 },
      registry: createOpenclawRegistry({}),
      deliverInboundReply: async () => true,
      fetchImpl,
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
      log: () => {},
      statusDocument: document,
    })

    // when
    await inbound.start()
    for (let index = 0; index < 5000 && fetchImpl.calls.length < 2; index += 1) await new Promise((resolve) => setImmediate(resolve))
    await inbound.stop()

    // then
    expect(document.snapshot().surfaces).toEqual({})
  })

  test("#given a healthy legacy dispatch #when it succeeds #then no status line and no status surface is produced", async () => {
    // given
    const lines = []
    const storage = memoryStorage()
    const native = createNativeOpenclaw({ context: context(storage), config: LEGACY_CONFIG, fetchImpl: recordingFetch(() => okGateway()), log: (line) => lines.push(line) })
    await native.ready

    // when
    await native.handleEvent({ type: "session.idle", sessionID: "s1" })
    const report = await native.report()

    // then
    // The seam is additive: a working legacy path is byte-identically quiet.
    expect(statusLines(lines)).toEqual([])
    expect(report.surfaces).toEqual({})
    expect([...storage.map.keys()]).not.toContain("rigel-v2/openclaw/status")
    await native.dispose()
  })
})

describe("openclaw status: §9.3 keeps the channel readable", () => {
  function discordListener({ statusDocument, log, messages }) {
    const registry = createOpenclawRegistry({})
    registry.register({ sessionID: "ses_1", projectPath: "/p", platform: "discord-bot", messageId: "botmsg", createdAt: new Date().toISOString() })
    const delivered = []
    const fetchImpl = recordingFetch((url) => {
      if (url.includes("/reactions/")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => "" }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => messages, text: async () => "" }
    })
    const inbound = createOpenclawInbound({
      replyListener: {
        discordBotToken: "token",
        discordChannelId: "chan",
        authorizedDiscordUserIds: ["u1"],
        pollIntervalMs: 3000,
        rateLimitPerMinute: 1,
        maxMessageLength: 500,
        includePrefix: true,
      },
      registry,
      deliverInboundReply: async (input) => { delivered.push(input); return true },
      fetchImpl,
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
      log,
      statusDocument,
    })
    return { inbound, delivered, fetchImpl }
  }

  test("#given a rate-limited drop #when it happens #then no line and no transition are produced, only the aggregate counter", async () => {
    // given
    const lines = []
    const rateLimitEvents = []
    const document = {
      recordFailure: async () => true,
      recordSuccess: async () => true,
      recordRateLimit: async (id) => { rateLimitEvents.push(id); return true },
    }
    const { inbound, delivered } = discordListener({
      statusDocument: document,
      log: (line) => lines.push(line),
      messages: [
        { id: "m2", content: "one", author: { id: "u1" }, message_reference: { message_id: "botmsg" } },
        { id: "m3", content: "two", author: { id: "u1" }, message_reference: { message_id: "botmsg" } },
      ],
    })

    // when
    await inbound.start()
    for (let index = 0; index < 5000 && rateLimitEvents.length === 0; index += 1) await new Promise((resolve) => setImmediate(resolve))
    await inbound.stop()

    // then
    expect(delivered).toHaveLength(1)
    expect(rateLimitEvents).toEqual([OPENCLAW_DISCORD_STATUS_SURFACE])
    // §9.3: the incident is NOT reported. The legacy per-drop WARN is gone.
    expect(lines.filter((line) => /rate limit/i.test(line))).toEqual([])
    expect(inbound.status().errors).toBeGreaterThanOrEqual(1)
  })

  test("#given an unauthorized author #when the message is dropped #then nothing is reported at all: no line, no counter, no transition", async () => {
    // given
    const lines = []
    const recorded = []
    const document = {
      recordFailure: async (id, options) => { recorded.push({ id, options }); return true },
      recordSuccess: async (id) => { recorded.push({ id }); return true },
      recordRateLimit: async (id) => { recorded.push({ id }); return true },
    }
    const { inbound, delivered, fetchImpl } = discordListener({
      statusDocument: document,
      log: (line) => lines.push(line),
      messages: [{ id: "m2", content: "hello", author: { id: "intruder" }, message_reference: { message_id: "botmsg" } }],
    })

    // when
    await inbound.start()
    for (let index = 0; index < 5000 && !fetchImpl.calls.some((call) => call.url.includes("/messages")); index += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    await inbound.stop()

    // then
    expect(delivered).toHaveLength(0)
    // The only recording allowed is the poller's own success: the author's drop
    // produced nothing, because answering it would be an oracle.
    expect(recorded.filter((entry) => entry.id === OPENCLAW_INJECTION_STATUS_SURFACE)).toEqual([])
    expect(recorded.filter((entry) => entry.options !== undefined)).toEqual([])
    expect(lines.filter((line) => !/reply listener (started|stopped)/.test(line))).toEqual([])
  })

  test("#given a refused injection #when the gate declines the reply #then the injection surface becomes degraded once", async () => {
    // given
    const lines = []
    const transitions = []
    const document = {
      recordFailure: async (id, options) => { transitions.push({ id, options }); return true },
      recordSuccess: async () => true,
      recordRateLimit: async () => true,
    }
    const registry = createOpenclawRegistry({})
    registry.register({ sessionID: "ses_1", projectPath: "/p", platform: "discord-bot", messageId: "botmsg", createdAt: new Date().toISOString() })
    const fetchImpl = recordingFetch((url) => {
      if (url.includes("/reactions/")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => "" }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => [{ id: "m2", content: "hello", author: { id: "u1" }, message_reference: { message_id: "botmsg" } }], text: async () => "" }
    })
    const inbound = createOpenclawInbound({
      replyListener: { discordBotToken: "token", discordChannelId: "chan", authorizedDiscordUserIds: ["u1"], pollIntervalMs: 3000 },
      registry,
      // The V2 host refuses the prompt: this used to be a silent `errors += 1`.
      deliverInboundReply: async () => false,
      fetchImpl,
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
      log: (line) => lines.push(line),
      statusDocument: document,
    })

    // when
    await inbound.start()
    for (let index = 0; index < 5000 && transitions.length === 0; index += 1) await new Promise((resolve) => setImmediate(resolve))
    await inbound.stop()

    // then
    expect(transitions[0]).toEqual({
      id: OPENCLAW_INJECTION_STATUS_SURFACE,
      options: { errorClass: "delivery-refused", detail: "discord" },
    })
    expect(lines.filter((line) => /rate limit|discord|author/i.test(line))).toEqual([])
    expect(inbound.status().errors).toBeGreaterThanOrEqual(1)
  })

  test("#given a refused injection a later poll accepts #when the reply lands #then the injection surface recovers", async () => {
    // given
    const lines = []
    const document = createOpenclawStatusDocument({ log: (line) => lines.push(line) })
    const registry = createOpenclawRegistry({})
    registry.register({ sessionID: "ses_1", projectPath: "/p", platform: "discord-bot", messageId: "botmsg", createdAt: new Date().toISOString() })
    let refusals = 1
    const fetchImpl = recordingFetch((url) => {
      if (url.includes("/reactions/")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => "" }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => [{ id: "m2", content: "hello", author: { id: "u1" }, message_reference: { message_id: "botmsg" } }], text: async () => "" }
    })
    const inbound = createOpenclawInbound({
      replyListener: { discordBotToken: "token", discordChannelId: "chan", authorizedDiscordUserIds: ["u1"], pollIntervalMs: 3000 },
      registry,
      // The first attempt is refused, the retry of the same message is accepted:
      // that is what "the gate works again" looks like from the poller.
      deliverInboundReply: async () => {
        if (refusals > 0) {
          refusals -= 1
          return false
        }
        return true
      },
      fetchImpl,
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
      log: (line) => lines.push(line),
      statusDocument: document,
    })

    // when
    await inbound.start()
    for (let index = 0; index < 5000 && inbound.status().messagesInjected === 0; index += 1) await new Promise((resolve) => setImmediate(resolve))
    await inbound.stop()

    // then
    // Without the recovery the surface stays `degraded` for the life of the
    // document: the poller's own success never reaches it.
    expect(document.snapshot().surfaces[OPENCLAW_INJECTION_STATUS_SURFACE]).toMatchObject({
      state: "up",
      errorClass: null,
      consecutiveFailures: 0,
    })
    const injectionLines = lines.filter((line) => line.startsWith(STATUS_PREFIX) && line.includes(OPENCLAW_INJECTION_STATUS_SURFACE))
    expect(injectionLines.filter((line) => line.includes("degraded"))).toHaveLength(1)
    expect(injectionLines.filter((line) => line.includes("recovered"))).toHaveLength(1)
  })
})

describe("openclaw status: /openclaw-status reflects the document", () => {
  const REPORT = {
    enabled: true,
    started: true,
    configState: "declared",
    surfaces: {
      outbound: { state: "degraded", errorClass: "http-500", consecutiveFailures: 2, lastErrorAt: "2026-11-02T00:00:00.000Z", truncations: 0, rateLimited: 0 },
      "credentials.telegram": { state: "fatal", errorClass: "missing-env-variable", consecutiveFailures: 1, lastErrorAt: "2026-11-02T00:00:01.000Z", truncations: 0, rateLimited: 0 },
    },
    updatedAt: "2026-11-02T00:00:02.000Z",
  }

  test("#given a report #when rendered #then every surface appears once, sorted, with its state and aggregates", () => {
    // when
    const text = formatOpenclawStatusReport(REPORT)

    // then
    expect(text).toBe([
      "openclaw: enabled (config: declared)",
      "listener: started",
      "surfaces:",
      "- credentials.telegram: fatal (missing-env-variable) failures=1 last=2026-11-02T00:00:01.000Z",
      "- outbound: degraded (http-500) failures=2 last=2026-11-02T00:00:00.000Z",
      "updated: 2026-11-02T00:00:02.000Z",
    ].join("\n"))
  })

  test("#given no recorded surface #when rendered #then it says so instead of inventing rows", () => {
    expect(formatOpenclawStatusReport({ enabled: false, started: false, surfaces: {} })).toBe([
      "openclaw: disabled",
      "listener: stopped",
      "surfaces: none recorded",
    ].join("\n"))
  })

  test("#given the command #when executed #then the rendering travels through session.prompt with the caller delivery and nothing else changes", async () => {
    // given
    const delivered = []
    const command = createOpenclawStatusCommand({ getReport: async () => REPORT, context: { session: { prompt: async (input) => { delivered.push(input); return {} } } } })

    // when
    await command.execute({ sessionID: "ses_1", prompt: { text: "/openclaw-status" }, delivery: "queue" })

    // then
    expect(command.name).toBe(OPENCLAW_STATUS_COMMAND_NAME)
    expect(delivered).toHaveLength(1)
    expect(delivered[0].sessionID).toBe("ses_1")
    expect(delivered[0].delivery).toBe("queue")
    expect(delivered[0].text).toContain("- outbound: degraded (http-500)")
    // The prompt input is reused, exactly like `/goal`, so the host keeps its own
    // attachments; only `text` and `delivery` are decided here.
    expect(delivered[0].text).toContain("- credentials.telegram: fatal")
  })

  test("#given a host without session.prompt #when executed #then the command is a no-op instead of throwing", async () => {
    // given
    const command = createOpenclawStatusCommand({ getReport: () => REPORT, context: {} })

    // when / then
    await command.execute({ sessionID: "ses_1" })
    expect(await command.execute({})).toBeUndefined()
  })

  test("#given the registration options #when registered #then the host editor receives the command name, respects the denylist and tolerates a host without commands", async () => {
    // given
    const added = []
    const context = { command: { transform: async (editor) => { editor({ add: (definition) => added.push(definition) }); return { dispose: async () => {} } } } }

    // when
    const registration = await registerOpenclawStatusCommand({ context, getReport: async () => REPORT })
    const denied = await registerOpenclawStatusCommand({ context, getReport: async () => REPORT, disabledCommands: [OPENCLAW_STATUS_COMMAND_NAME] })
    const headless = await registerOpenclawStatusCommand({ context: {}, getReport: async () => REPORT })

    // then
    expect(added.map((definition) => definition.name)).toEqual([OPENCLAW_STATUS_COMMAND_NAME])
    expect(registration).toBeDefined()
    expect(denied).toBeUndefined()
    expect(headless).toBeUndefined()
  })

  test("#given a composed surface with a recorded fatal #when the report is rendered #then the command explains why the surface is down without leaking the secret", async () => {
    // given
    const secret = "discord-secret-value-4a91"
    const native = createNativeOpenclaw({
      context: context(memoryStorage()),
      config: {
        enabled: true,
        gateways: {},
        hooks: {},
        replyListener: { discordBotToken: secret, discordChannelId: "c1", authorizedDiscordUserIds: ["u1"], telegramBotToken: { env: "TELEGRAM_MISSING" } },
      },
      env: {},
      fetchImpl: recordingFetch(() => okGateway()),
      log: () => {},
    })
    await native.ready

    // when
    const delivered = []
    const command = createOpenclawStatusCommand({
      getReport: () => native.report(),
      context: { session: { prompt: async (input) => { delivered.push(input); return {} } } },
    })
    await command.execute({ sessionID: "ses_1" })

    // then
    expect(delivered[0].text).toContain("credentials.telegram: fatal (missing-env-variable)")
    expect(delivered[0].text).not.toContain(secret)
    expect(delivered[0].text).not.toContain("TELEGRAM_MISSING")
    await native.dispose()
  })

  // Row 29 / U-P10 (Gate 5, finding #10): a persisted `channels.<name>` fatal for a
  // channel this run did NOT evaluate must never be promoted to `up`. Reachable
  // fixture only: `enabled: true`, a persisted channel fatal from an earlier run, and
  // that channel no longer present in the configuration, so setup does not evaluate it
  // and the keep set omits it. `hasReport()` is true because the surface is enabled
  // (and a recorded state exists), so the command is registered and `report()` runs.
  // The `enabled:false` + empty setup-fatals form is deliberately NOT used: `hasReport()`
  // reads an in-memory map without hydrating, so the command is never registered and
  // `reconcileFatals` never runs (unreachable; 06-critique O7, 04-audit §5.3).
  test("#given a persisted channel fatal for a channel this run did not evaluate #when the report is read #then the row is never rendered healthy and the command is reachable", async () => {
    // given
    const lines = []
    const storage = memoryStorage()
    const previous = createOpenclawStatusDocument({ storage, log: () => {} })
    await previous.recordFailure("channels.alerts", { errorClass: "missing-env-variable", fatal: true, emitLine: false })
    // A runtime degradation is NOT a setup verdict: only traffic can prove it healed.
    await previous.recordFailure(OUTBOUND_ROW, { errorClass: "http-500" })
    const native = createNativeOpenclaw({
      context: context(storage),
      // `channels.alerts` is absent: setup does not evaluate it and the keep set omits it.
      config: LEGACY_CONFIG,
      fetchImpl: recordingFetch(() => okGateway()),
      log: (line) => lines.push(line),
    })

    // when
    await native.ready
    // Control: the fixture is reachable (enabled surface => command registration).
    expect(native.hasReport()).toBe(true)
    const report = await native.report()

    // then: the removed channel is never rendered healthy (Gate 5: not established by this run).
    expect(report.surfaces["channels.alerts"]).toBeDefined()
    expect(report.surfaces["channels.alerts"].state).toBe("unevaluated")
    // Gate 5 representation is explicit in the rendered report (not `up`).
    expect(formatOpenclawStatusReport(report)).toContain("- channels.alerts: unevaluated")
    expect(formatOpenclawStatusReport(report)).not.toContain("- channels.alerts: up")
    // A runtime degradation is still traffic-owned and must not be cleared by setup reconciliation.
    expect(report.surfaces[OUTBOUND_ROW]).toMatchObject({ state: "degraded", errorClass: "http-500" })
    // Idempotent: a second report produces no duplicated transition line for the unevaluated row.
    const before = statusLines(lines).length
    const second = await native.report()
    expect(statusLines(lines).length).toBe(before)
    expect(second.surfaces["channels.alerts"].state).toBe("unevaluated")
    // Persisted snapshot matches the rendered state.
    expect(storage.map.get(OPENCLAW_STATUS_KEY).surfaces["channels.alerts"].state).toBe("unevaluated")
    await native.dispose()
  })
})

// Row 30 / U-P16 (Gate 5, finding #16): every platform and channel owns its own row.
// A legacy gateway delivery is `outbound:<gatewayName>`; a `channels.<name>` route is
// `channels.<name>`; the bare `outbound` row is retired, never rendered `up`.
describe("openclaw status: row 30 one row per platform and channel", () => {
  const BASES = {
    RIGEL_OPENCLAW_DISCORD_API_BASE: "http://127.0.0.1:9/discord",
    RIGEL_OPENCLAW_TELEGRAM_API_BASE: "http://127.0.0.1:9/telegram",
  }
  const CHANNELS_CONFIG = {
    enabled: true,
    channels: {
      alerts: { transport: "discord", token: "synthetic-discord-token", channelId: "chan-1", instruction: "finished {{sessionId}}", events: ["session.idle"] },
      ops: { transport: "telegram", token: "synthetic-telegram-token", chatId: "42", instruction: "finished {{sessionId}}", events: ["session.idle"] },
    },
  }
  function jsonReply(payload, status = 200) {
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => payload, text: async () => JSON.stringify(payload) }
  }
  const DISCORD_OK = () => jsonReply({ id: "m-9", channel_id: "chan-1" })
  const TELEGRAM_OK = () => jsonReply({ ok: true, result: { message_id: 500, chat: { id: 42 } } })
  function platformFetch(outcomes) {
    return recordingFetch(async (url) => (url.includes("/discord") ? outcomes.discord() : outcomes.telegram()))
  }

  test("#given a Discord failure and a Telegram success in one event #when both report #then the Discord row stays degraded and no legacy row appears", async () => {
    // given
    const outcomes = { discord: () => jsonReply({ message: "Unauthorized" }, 401), telegram: TELEGRAM_OK }
    const native = createNativeOpenclaw({ context: context(memoryStorage()), config: CHANNELS_CONFIG, env: BASES, fetchImpl: platformFetch(outcomes), log: () => {} })
    await native.ready

    // when
    await native.handleEvent({ type: "session.idle", sessionID: "s1" })
    const report = await native.report()

    // then
    expect(report.surfaces["channels.alerts"]).toMatchObject({ state: "degraded", errorClass: "http-401", consecutiveFailures: 1 })
    expect(report.surfaces["channels.ops"]?.state ?? "up").toBe("up")
    expect(report.surfaces.outbound).toBeUndefined()
    await native.dispose()
  })

  test("#given a Telegram failure and a Discord success in one event #when both report #then the Telegram row stays degraded and the Discord row is not cleared by it", async () => {
    // given
    const outcomes = { discord: DISCORD_OK, telegram: () => jsonReply({ ok: false, description: "Unauthorized" }, 401) }
    const native = createNativeOpenclaw({ context: context(memoryStorage()), config: CHANNELS_CONFIG, env: BASES, fetchImpl: platformFetch(outcomes), log: () => {} })
    await native.ready

    // when
    await native.handleEvent({ type: "session.idle", sessionID: "s1" })
    const report = await native.report()

    // then
    expect(report.surfaces["channels.ops"]).toMatchObject({ state: "degraded", errorClass: "http-401" })
    expect(report.surfaces["channels.alerts"]?.state ?? "up").toBe("up")
    expect(report.surfaces.outbound).toBeUndefined()
    await native.dispose()
  })

  test("#given two channels failing with the same class #when both report #then each channel emits its own degraded line", async () => {
    // given
    const lines = []
    const outcomes = { discord: () => jsonReply({ message: "Unauthorized" }, 401), telegram: () => jsonReply({ ok: false, description: "Unauthorized" }, 401) }
    const native = createNativeOpenclaw({ context: context(memoryStorage()), config: CHANNELS_CONFIG, env: BASES, fetchImpl: platformFetch(outcomes), log: (line) => lines.push(line) })
    await native.ready

    // when
    await native.handleEvent({ type: "session.idle", sessionID: "s1" })

    // then
    const degraded = statusLines(lines).filter((line) => line.includes("surface degraded:"))
    expect(degraded).toHaveLength(2)
    expect(degraded.some((line) => line.includes("channels.alerts (http-401)"))).toBe(true)
    expect(degraded.some((line) => line.includes("channels.ops (http-401)"))).toBe(true)
    await native.dispose()
  })

  test("#given a legacy gateway that refuses #when an event flows #then the row is the gateway's own outbound row and no bare outbound row is written", async () => {
    // given
    const native = createNativeOpenclaw({
      context: context(memoryStorage()),
      config: LEGACY_CONFIG,
      fetchImpl: recordingFetch(() => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => "" })),
      log: () => {},
    })
    await native.ready

    // when
    await native.handleEvent({ type: "session.idle", sessionID: "s1" })
    const report = await native.report()

    // then
    expect(report.surfaces["outbound:hook"]).toMatchObject({ state: "degraded", errorClass: "http-500" })
    expect(report.surfaces.outbound).toBeUndefined()
    await native.dispose()
  })

  test("#given a persisted bare outbound row #when the report is read #then the row is retired as unevaluated, never up, and the retirement is one line", async () => {
    // given
    const lines = []
    const storage = memoryStorage()
    const previous = createOpenclawStatusDocument({ storage, log: () => {} })
    await previous.recordFailure("outbound", { errorClass: "http-500" })
    const native = createNativeOpenclaw({ context: context(storage), config: LEGACY_CONFIG, fetchImpl: recordingFetch(() => okGateway()), log: (line) => lines.push(line) })
    await native.ready

    // when
    const report = await native.report()
    await native.report()

    // then
    expect(report.surfaces.outbound).toMatchObject({ state: "unevaluated", errorClass: null, consecutiveFailures: 0 })
    expect(formatOpenclawStatusReport(report)).toContain("- outbound: unevaluated")
    expect(formatOpenclawStatusReport(report)).not.toContain("- outbound: up")
    expect(statusLines(lines).filter((line) => line.includes("surface retired: outbound"))).toHaveLength(1)
    expect(storage.map.get(OPENCLAW_STATUS_KEY).surfaces.outbound.state).toBe("unevaluated")
    await native.dispose()
  })

  test("#given a healthy legacy dispatch #when recordSuccess runs on an absent row #then it neither reads nor writes storage", async () => {
    // given
    let reads = 0
    let writes = 0
    const document = createOpenclawStatusDocument({
      storage: { get: async () => { reads += 1; return undefined }, set: async () => { writes += 1 } },
      log: () => {},
    })

    // when
    const recorded = await document.recordSuccess("outbound:hook")

    // then
    expect(recorded).toBe(false)
    expect(reads).toBe(0)
    expect(writes).toBe(0)
  })
})
