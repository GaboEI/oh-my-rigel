import { describe, expect, test } from "bun:test"
import { createNativeOpenclaw } from "./rigel-v2-native-openclaw.mjs"
import { createOpenclawInbound } from "./rigel-v2-native-openclaw-inbound.mjs"
import { createOpenclawRegistry } from "./rigel-v2-native-openclaw-registry.mjs"
import {
  authorizeDiscordAuthors,
  describeOpenclawReplyPolicyDiagnostic,
  resolveOpenclawReplyPolicy,
} from "./rigel-v2-native-openclaw-reply-policy.mjs"
import { OPENCLAW_STATUS_KEY } from "./rigel-v2-native-openclaw-agent-status.mjs"

const DISCORD_BASE = "http://127.0.0.1:9/discord"
const SECRET = `synthetic-${Math.random().toString(36).slice(2)}`

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

/** A Discord port that answers polls with `messages` once and then with nothing. */
function discordPort(messages) {
  let served = false
  return spyFetch(async (url) => {
    if (url.includes("/reactions/")) return jsonResponse({})
    if (served) return jsonResponse([])
    served = true
    return jsonResponse(messages)
  })
}

function harmonyComposition(config, { storage = memoryStorage(), fetchImpl = discordPort([]), prompts = [] } = {}) {
  const lines = []
  const native = createNativeOpenclaw({
    context: { storage, session: { prompt: async (input) => { prompts.push(input); return {} } } },
    config,
    fetchImpl,
    env: { RIGEL_OPENCLAW_DISCORD_API_BASE: DISCORD_BASE },
    log: (line) => lines.push(line),
  })
  return { native, lines, storage, prompts, fetchImpl }
}

function discordReplyListener(overrides = {}) {
  return {
    discordBotToken: SECRET,
    discordChannelId: "chan",
    pollIntervalMs: 500,
    ...overrides,
  }
}

/**
 * Setup diagnostics only: the listener's own start/stop lifecycle lines share the
 * same sink, and they are not reported state.
 */
function diagnostics(lines) {
  return lines.filter((line) => /reply policy|notification channel|Discord replies stay off/.test(line))
}

function registryWith(platform, messageId, sessionID) {
  const registry = createOpenclawRegistry({})
  registry.register({ sessionID, projectPath: "/p", platform, messageId, createdAt: new Date().toISOString() })
  return registry
}

function inboundWith(replyListener, { discordAuthorization, fetchImpl, registry, delivered = [], statusDocument } = {}) {
  const inbound = createOpenclawInbound({
    replyListener,
    ...(discordAuthorization === undefined ? {} : { discordAuthorization }),
    registry: registry ?? registryWith("discord-bot", "botmsg", "ses_1"),
    deliverInboundReply: async (input) => {
      delivered.push(input)
      return true
    },
    fetchImpl,
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
    log: () => {},
    ...(statusDocument === undefined ? {} : { statusDocument }),
  })
  return { inbound, delivered }
}

describe("openclaw reply policy: the new namespace's authorization is a named list", () => {
  test("#given no replyPolicy block #when resolved #then nothing is declared and nobody is authorized", () => {
    expect(resolveOpenclawReplyPolicy(undefined)).toEqual({ declared: false, identities: [], diagnostics: [] })
    expect(resolveOpenclawReplyPolicy(null)).toEqual({ declared: false, identities: [], diagnostics: [] })
    expect(authorizeDiscordAuthors(resolveOpenclawReplyPolicy(undefined))).toEqual({
      source: "replyPolicy",
      explicit: false,
      allowedAuthors: [],
    })
  })

  test("#given a declared policy with allowed authors #when resolved #then it authorizes exactly those authors once", () => {
    const policy = resolveOpenclawReplyPolicy({ "discord-bot": { allowedAuthors: ["u2", "u1", "u2"] } })

    expect(policy.declared).toBe(true)
    expect(policy.diagnostics).toEqual([])
    expect(policy.identities).toEqual([{ identity: "discord-bot", allowedAuthors: ["u2", "u1"] }])
    expect(authorizeDiscordAuthors(policy)).toEqual({ source: "replyPolicy", explicit: true, allowedAuthors: ["u2", "u1"] })
  })

  test("#given a declared policy that cannot authorize anybody #when resolved #then each mistake is one named diagnostic and no author", () => {
    const cases = [
      ["a non-object block", "nope", "openclaw.replyPolicy", "not-an-object"],
      ["an unknown key", { "discord-bot": { allowedAuthors: ["u1"], prefix: "x" } }, "openclaw.replyPolicy.discord-bot.prefix", "unknown-key"],
      ["a missing list", { "discord-bot": {} }, "openclaw.replyPolicy.discord-bot.allowedAuthors", "missing-authorized-authors"],
      ["an empty list", { "discord-bot": { allowedAuthors: [] } }, "openclaw.replyPolicy.discord-bot.allowedAuthors", "missing-authorized-authors"],
      ["non-string entries", { "discord-bot": { allowedAuthors: ["u1", 7] } }, "openclaw.replyPolicy.discord-bot.allowedAuthors", "invalid-authorized-authors"],
    ]

    for (const [label, rawPolicy, path, reason] of cases) {
      const policy = resolveOpenclawReplyPolicy(rawPolicy)
      expect({ label, declared: policy.declared }).toEqual({ label, declared: true })
      expect({ label, diagnostics: policy.diagnostics.map((diagnostic) => ({ path: diagnostic.path, reason: diagnostic.reason })) })
        .toEqual({ label, diagnostics: [{ path, reason }] })
      expect({ label, explicit: authorizeDiscordAuthors(policy).explicit }).toEqual({ label, explicit: false })
    }
  })

  test("#given an empty policy namespace #when resolved #then it declares no governed identity", () => {
    const policy = resolveOpenclawReplyPolicy({})

    expect(policy).toEqual({ declared: true, identities: [], diagnostics: [] })
  })

  test("#given a policy naming no served identity #when resolved #then it does not manufacture another surface's diagnostic", () => {
    // §5.2 rule 2: an unsupported identity is a configuration error, but it cannot
    // govern Discord or Telegram by implication.
    const policy = resolveOpenclawReplyPolicy({ "slack-bot": { allowedAuthors: ["u1"] } })

    expect(policy.diagnostics.map((diagnostic) => diagnostic.reason)).toEqual(["unsupported-identity"])
  })

  test("#given a rejected policy #when described #then the line names the path and never an author id", () => {
    const policy = resolveOpenclawReplyPolicy({ "discord-bot": { allowedAuthors: ["author-secret-id", "u1"] } })
    const line = describeOpenclawReplyPolicyDiagnostic({ path: "openclaw.replyPolicy.discord-bot.allowedAuthors", reason: "invalid-authorized-authors" })

    expect(line).toContain("openclaw.replyPolicy.discord-bot.allowedAuthors")
    expect(line).not.toContain("author-secret-id")
    // A valid policy produces no line at all: the description channel only speaks
    // about rejections.
    expect(policy.diagnostics).toEqual([])
  })
})

describe("openclaw inbound: the gate reads the authorization it is given", () => {
  const discordMessage = { id: "m2", content: "hello", author: { id: "u1" }, message_reference: { message_id: "botmsg" } }

  test("#given a policy authorizing only u2 #when a reply from u1 arrives #then nothing is delivered and nothing is recorded", async () => {
    const storage = memoryStorage()
    const statusDocument = (await import("./rigel-v2-native-openclaw-agent-status.mjs")).createOpenclawStatusDocument({ storage })
    const { inbound, delivered } = inboundWith(discordReplyListener({ authorizedDiscordUserIds: ["u1"] }), {
      discordAuthorization: { source: "replyPolicy", explicit: true, allowedAuthors: ["u2"] },
      fetchImpl: discordPort([discordMessage]),
      statusDocument,
    })

    await inbound.start()
    await waitFor(() => inbound.status().messagesSeen > 0, "discord poll")
    await inbound.stop()

    // §9.3: an unauthorized author is silent on purpose, and the legacy list is NOT
    // merged with the policy, so u1 (authorized for legacy) is still refused.
    expect(delivered).toEqual([])
    expect(statusDocument.snapshot().surfaces).toEqual({})
    expect(storage.writes).toEqual([])
  })

  test("#given a policy authorizing u1 #when a reply from u1 arrives #then it is injected and the authorization is reported", async () => {
    const { inbound, delivered } = inboundWith(discordReplyListener(), {
      discordAuthorization: { source: "replyPolicy", explicit: true, allowedAuthors: ["u1"] },
      fetchImpl: discordPort([discordMessage]),
    })

    await inbound.start()
    await waitFor(() => delivered.length > 0, "discord injection")
    await inbound.stop()

    expect(delivered).toEqual([{ sessionID: "ses_1", text: "[reply:discord] hello" }])
    expect(inbound.status().authorization).toEqual({ source: "replyPolicy", explicit: true })
  })

  test("#given a policy that authorizes nobody #when the listener starts #then the Discord poller stays down", async () => {
    const fetchImpl = discordPort([discordMessage])
    const { inbound, delivered } = inboundWith(discordReplyListener({ authorizedDiscordUserIds: ["u1"] }), {
      discordAuthorization: { source: "replyPolicy", explicit: false, allowedAuthors: [] },
      fetchImpl,
    })

    const started = await inbound.start()
    await inbound.stop()

    expect(started).toEqual({ started: false, reason: "no-credentials" })
    expect(inbound.status().platforms.discord).toBe(false)
    expect(inbound.status().authorization).toEqual({ source: "replyPolicy", explicit: false })
    expect(delivered).toEqual([])
    expect(fetchImpl.calls).toEqual([])
  })

  test("#given no policy at all #when the listener is built #then its status keeps the legacy shape", async () => {
    const { inbound } = inboundWith(discordReplyListener({ authorizedDiscordUserIds: ["u1"] }), { fetchImpl: discordPort([]) })

    expect(inbound.status().authorization).toBeUndefined()
  })
})

describe("openclaw composition: the new namespace reports an absent authorization instead of going quiet", () => {
  test("#given legacy config with no authorized authors #when composed #then the poller is off with no line and no state write", async () => {
    const { native, lines, storage, fetchImpl } = harmonyComposition({
      enabled: true,
      replyListener: discordReplyListener({ authorizedDiscordUserIds: [] }),
    })

    const ready = await native.ready

    expect(ready).toEqual({ started: false, reason: "no-credentials" })
    expect(lines).toEqual([])
    expect(storage.map.has(OPENCLAW_STATUS_KEY)).toBe(false)
    expect(native.inbound.status().platforms.discord).toBe(false)
    expect(native.status().authorization).toBeUndefined()
    expect(fetchImpl.calls).toEqual([])
    await native.dispose()
  })

  test("#given channels declared and a Discord reply port with no authors #when composed #then one banner names the missing authorization and the document records the fatal", async () => {
    const { native, lines, storage, fetchImpl } = harmonyComposition({
      enabled: true,
      channels: { alerts: { transport: "discord", token: SECRET, channelId: "chan-1", instruction: "x", events: ["session.idle"] } },
      replyListener: discordReplyListener({ authorizedDiscordUserIds: [] }),
    })

    const ready = await native.ready

    const unauthorized = lines.filter((line) => line.includes("openclaw.replyListener.authorizedDiscordUserIds"))
    expect(unauthorized).toHaveLength(1)
    expect(ready).toEqual({ started: false, reason: "no-credentials" })
    expect(native.inbound.status().platforms.discord).toBe(false)
    expect(storage.map.get(OPENCLAW_STATUS_KEY).surfaces.discord).toMatchObject({
      state: "fatal",
      errorClass: "missing-authorized-authors",
    })
    // The poller is down, so no Discord poll was attempted: the report is the only
    // difference from the legacy silence.
    expect(fetchImpl.calls.filter((call) => call.url.includes("/messages"))).toEqual([])
    await native.dispose()
  })

  test("#given channels declared and a legacy author list #when composed #then that explicit list satisfies the new namespace and the poller starts", async () => {
    const { native, lines, fetchImpl } = harmonyComposition({
      enabled: true,
      channels: { alerts: { transport: "discord", token: SECRET, channelId: "chan-1", instruction: "x", events: ["session.idle"] } },
      replyListener: discordReplyListener({ authorizedDiscordUserIds: ["u1"] }),
    })

    await native.ready
    await waitFor(() => fetchImpl.calls.some((call) => call.url.includes("/messages")), "discord poll")
    await native.dispose()

    expect(diagnostics(lines)).toEqual([])
    expect(native.inbound.status().platforms.discord).toBe(true)
  })

  test("#given a replyPolicy that authorizes an author #when composed #then the policy governs and the composition reports it as explicit", async () => {
    const { native, lines, fetchImpl } = harmonyComposition({
      enabled: true,
      replyPolicy: { "discord-bot": { allowedAuthors: ["u1"] } },
      replyListener: discordReplyListener({ authorizedDiscordUserIds: [] }),
    })

    await native.ready
    await waitFor(() => fetchImpl.calls.some((call) => call.url.includes("/messages")), "discord poll")

    expect(diagnostics(lines)).toEqual([])
    expect(native.status().authorization).toEqual({ discord: { source: "replyPolicy", explicit: true } })
    expect(native.inbound.status().platforms.discord).toBe(true)
    await native.dispose()
  })

  test("#given a replyPolicy with no allowed authors #when composed #then the banner names the path and the document records the disabled surface", async () => {
    const { native, lines, storage, fetchImpl } = harmonyComposition({
      enabled: true,
      replyPolicy: { "discord-bot": {} },
      replyListener: discordReplyListener({ authorizedDiscordUserIds: ["u1"] }),
    })

    await native.ready

    expect(lines.filter((line) => line.includes("openclaw.replyPolicy.discord-bot.allowedAuthors"))).toHaveLength(1)
    expect(native.status().authorization).toEqual({ discord: { source: "replyPolicy", explicit: false } })
    // Fail closed: the legacy list does NOT resurrect a policy that authorizes
    // nobody, because the new namespace governs its identity.
    expect(native.inbound.status().platforms.discord).toBe(false)
    expect(storage.map.get(OPENCLAW_STATUS_KEY).surfaces.discord).toMatchObject({ state: "fatal", errorClass: "missing-authorized-authors" })
    expect(fetchImpl.calls).toEqual([])
    await native.dispose()
  })

  test("#given a replyPolicy naming an identity this runtime does not serve #when composed #then it reports under replyPolicy without claiming Discord", async () => {
    const { native, lines, storage } = harmonyComposition({
      enabled: true,
      replyPolicy: { "slack-bot": { allowedAuthors: ["u1"] } },
    })

    await native.ready

    expect(lines.filter((line) => line.includes("openclaw.replyPolicy.slack-bot"))).toHaveLength(1)
    expect(storage.map.get(OPENCLAW_STATUS_KEY).surfaces.replyPolicy).toMatchObject({
      state: "fatal",
      errorClass: "unsupported-identity",
    })
    await native.dispose()
  })

  test("#given openclaw disabled #when a replyPolicy is declared #then nothing is reported and nothing is written", async () => {
    const { native, lines, storage } = harmonyComposition({ enabled: false, replyPolicy: {} })

    const ready = await native.ready

    expect(ready).toEqual({ started: false, reason: "disabled" })
    expect(lines).toEqual([])
    expect(storage.map.has(OPENCLAW_STATUS_KEY)).toBe(false)
  })

  test("#given a capturing log #when a policy is rejected #then no author id and no credential reach the line", async () => {
    const { native, lines } = harmonyComposition({
      enabled: true,
      replyPolicy: { "discord-bot": { allowedAuthors: ["author-secret-id", 7] } },
      replyListener: discordReplyListener({ authorizedDiscordUserIds: ["u1"] }),
    })

    await native.ready
    await native.dispose()

    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line).not.toContain("author-secret-id")
      expect(line).not.toContain(SECRET)
    }
  })
})
