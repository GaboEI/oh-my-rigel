import { describe, expect, test } from "bun:test"
import { createOpenclawOutbound } from "./rigel-v2-native-openclaw-outbound.mjs"
import { createOpenclawInbound } from "./rigel-v2-native-openclaw-inbound.mjs"
import { createOpenclawRegistry, OPENCLAW_REGISTRY_MAX_AGE_MS, OPENCLAW_REGISTRY_PREFIX } from "./rigel-v2-native-openclaw-registry.mjs"

/**
 * C1: the reply-correlation identity of a chat-scoped platform.
 *
 * Telegram documents `message_id` as unique WITHIN a chat: ids are per-chat
 * sequences, so `77` exists in every chat. Keying the correlation registry on
 * `(platform, messageId)` therefore collapsed two channels into one record, and a
 * reply written in chat A was injected into the session that published to chat B.
 *
 * The contract this suite pins, after the fix:
 *   - a Telegram correlation is identified by `(platform, chat, messageId)`;
 *   - a record that carries no chat keeps the pre-fix key, byte for byte, and is
 *     still resolvable (the legacy/migration identity);
 *   - a Discord correlation is identified by `(platform, messageId)` exactly as
 *     before (snowflake ids are unique platform-wide);
 *   - two chats reusing one `message_id` never cross-route, in memory or across a
 *     restart;
 *   - a chat component that is not a string is refused instead of stored in a
 *     form that can never resolve.
 *
 * The storage-key literals below are computed outside this module
 * (`printf 'telegram\0\1chat-a\077' | sha1sum`), so a reordered or re-separated
 * hash input fails the pin instead of silently orphaning persisted records.
 */

const SCOPED_KEY_CHAT_A = `${OPENCLAW_REGISTRY_PREFIX}8321a5078392048fecd4702ac449e592a680ea30`
const LEGACY_TELEGRAM_KEY = `${OPENCLAW_REGISTRY_PREFIX}67b1e237bce293b429775506a96079ba1782cce3`
const PREFIX = OPENCLAW_REGISTRY_PREFIX
const CHAT_A = "chat-a"
const CHAT_B = "chat-b"
const SESSION_A = "ses_a"
const SESSION_B = "ses_b"
const SHARED_MESSAGE_ID = "77"
const TELEGRAM_BASE = "http://127.0.0.1:9/telegram"
const TOKEN = "synthetic-correlation-token"

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

function mapping(overrides = {}) {
  return {
    sessionID: SESSION_A,
    projectPath: "/p",
    platform: "telegram",
    messageId: SHARED_MESSAGE_ID,
    channelId: CHAT_A,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function storedKeys(storage) {
  return [...storage.map.keys()].filter((key) => key.startsWith(PREFIX))
}

async function waitFor(predicate, message, maxIterations = 5000) {
  for (let index = 0; index < maxIterations; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`timed out: ${message}`)
}

function immediateSleep() {
  return new Promise((resolve) => setImmediate(resolve))
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }
}

/**
 * A loopback Telegram port that publishes with the message id the platform would
 * assign in that chat (`publishedMessageId`) and serves one reply per chat once.
 */
function telegramPort({ publishedMessageId, reply }) {
  let replyServed = false
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    if (url.includes("/getUpdates")) {
      if (replyServed) return jsonResponse({ ok: true, result: [] })
      replyServed = true
      return jsonResponse({ ok: true, result: [{ update_id: 5, message: reply }] })
    }
    if (url.includes("/sendMessage")) {
      const body = JSON.parse(init.body ?? "{}")
      if (body.reply_to_message_id !== undefined) {
        return jsonResponse({ ok: true, result: { message_id: 900, chat: { id: body.chat_id } } })
      }
      return jsonResponse({ ok: true, result: { message_id: publishedMessageId, chat: { id: body.chat_id } } })
    }
    return jsonResponse({}, 404)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

function channels() {
  return [
    { name: "chat-a", transport: "telegram", token: TOKEN, target: CHAT_A, instruction: "build done {{sessionId}}", events: ["session.idle"] },
    { name: "chat-b", transport: "telegram", token: TOKEN, target: CHAT_B, instruction: "build done {{sessionId}}", events: ["session.created"] },
  ]
}

describe("openclaw telegram correlation identity", () => {
  test("#given a telegram mapping that names its chat #when persisted #then the key carries the chat", async () => {
    const storage = memoryStorage()
    const registry = createOpenclawRegistry({ storage })

    expect(await registry.register(mapping())).toBe(true)

    expect(storedKeys(storage)).toEqual([SCOPED_KEY_CHAT_A])
  })

  test("#given a telegram mapping with no chat #when persisted #then the key is the pre-fix legacy literal", async () => {
    const storage = memoryStorage()
    const registry = createOpenclawRegistry({ storage })

    expect(await registry.register(mapping({ channelId: undefined }))).toBe(true)

    // Byte-identical to the pre-fix hash input `telegram\0 77`: every record the
    // previous build wrote stays readable, and the previous build can still read
    // the ones this build writes for a chat-less legacy gateway.
    expect(storedKeys(storage)).toEqual([LEGACY_TELEGRAM_KEY])
    expect(registry.lookup("telegram", SHARED_MESSAGE_ID)?.sessionID).toBe(SESSION_A)
  })

  test("#given a discord mapping #when persisted #then the key ignores the channel exactly as before", async () => {
    const storage = memoryStorage()
    const registry = createOpenclawRegistry({ storage })

    await registry.register(mapping({ platform: "discord", messageId: "m1", channelId: "chan-1", sessionID: "ses_d" }))

    expect(storedKeys(storage)).toEqual([`${PREFIX}d57083662eb3363971f51c0b0b285259736f4d6b`])
    expect(registry.lookup("discord-bot", "m1")?.sessionID).toBe("ses_d")
  })

  test("#given two chats reusing one message id #when both register #then each chat resolves its own session", async () => {
    const registry = createOpenclawRegistry({})

    await registry.register(mapping({ channelId: CHAT_A, sessionID: SESSION_A }))
    await registry.register(mapping({ channelId: CHAT_B, sessionID: SESSION_B }))

    expect(registry.size()).toBe(2)
    expect(registry.lookup("telegram", SHARED_MESSAGE_ID, CHAT_A)?.sessionID).toBe(SESSION_A)
    expect(registry.lookup("telegram", SHARED_MESSAGE_ID, CHAT_B)?.sessionID).toBe(SESSION_B)
    expect(registry.lookup("telegram", SHARED_MESSAGE_ID, "chat-c")).toBeNull()
  })

  test("#given one chat with two message ids #when both register #then they stay independent", async () => {
    const registry = createOpenclawRegistry({})

    await registry.register(mapping({ messageId: "77" }))
    await registry.register(mapping({ messageId: "78", sessionID: SESSION_B }))

    expect(registry.size()).toBe(2)
    expect(registry.lookup("telegram", "77", CHAT_A)?.sessionID).toBe(SESSION_A)
    expect(registry.lookup("telegram", "78", CHAT_A)?.sessionID).toBe(SESSION_B)
  })

  test("#given a scoped lookup with only a legacy record #when it runs #then the legacy record still resolves", async () => {
    const registry = createOpenclawRegistry({})
    await registry.register(mapping({ channelId: undefined, sessionID: "ses_legacy" }))

    // The pinned listener suite registers Telegram records with no chat and
    // expects the reply to be delivered, so the unscoped record is the migration
    // identity, never a miss.
    expect(registry.lookup("telegram", SHARED_MESSAGE_ID, CHAT_A)?.sessionID).toBe("ses_legacy")
  })

  test("#given both a scoped and a legacy record for one id #when the owning chat looks up #then the scoped record wins", async () => {
    const registry = createOpenclawRegistry({})
    await registry.register(mapping({ channelId: undefined, sessionID: "ses_legacy" }))
    await registry.register(mapping({ channelId: CHAT_A, sessionID: SESSION_A }))

    expect(registry.lookup("telegram", SHARED_MESSAGE_ID, CHAT_A)?.sessionID).toBe(SESSION_A)
    // A chat that owns no scoped record keeps the pre-fix answer.
    expect(registry.lookup("telegram", SHARED_MESSAGE_ID, CHAT_B)?.sessionID).toBe("ses_legacy")
  })

  test("#given a malformed chat component #when it is registered or hydrated #then it is refused", async () => {
    const registry = createOpenclawRegistry({})

    expect(await registry.register(mapping({ channelId: 77 }))).toBe(false)
    expect(registry.size()).toBe(0)

    const storage = memoryStorage()
    await storage.set(`${PREFIX}foreign`, mapping({ channelId: { id: CHAT_A } }))
    const reader = createOpenclawRegistry({ storage })
    await reader.hydrate()
    expect(reader.size()).toBe(0)
  })

  test("#given two chats #when the registry restarts #then both records resolve to their own sessions", async () => {
    const storage = memoryStorage()
    const writer = createOpenclawRegistry({ storage })
    await writer.register(mapping({ channelId: CHAT_A, sessionID: SESSION_A }))
    await writer.register(mapping({ channelId: CHAT_B, sessionID: SESSION_B }))

    const reader = createOpenclawRegistry({ storage })
    await reader.hydrate()

    expect(reader.size()).toBe(2)
    expect(reader.lookup("telegram", SHARED_MESSAGE_ID, CHAT_A)?.sessionID).toBe(SESSION_A)
    expect(reader.lookup("telegram", SHARED_MESSAGE_ID, CHAT_B)?.sessionID).toBe(SESSION_B)
  })

  test("#given a stale scoped record and a fresh legacy one #when the owning chat looks up #then the stale one is evicted and the legacy survives", async () => {
    let clock = Date.parse("2026-01-02T00:00:00.000Z")
    const storage = memoryStorage()
    const registry = createOpenclawRegistry({ storage, now: () => clock })
    await registry.register(mapping({ channelId: CHAT_A, sessionID: "ses_stale", createdAt: "2026-01-01T00:00:00.000Z" }))
    await registry.register(mapping({ channelId: undefined, sessionID: "ses_legacy", createdAt: new Date(clock).toISOString() }))
    clock = Date.parse("2026-01-03T00:00:00.000Z")

    expect(registry.lookup("telegram", SHARED_MESSAGE_ID, CHAT_A)?.sessionID).toBe("ses_legacy")
    expect(storedKeys(storage)).toEqual([LEGACY_TELEGRAM_KEY])
  })

  test("#given two chats owned by two sessions #when one session is removed #then only that scope's record is deleted", async () => {
    const storage = memoryStorage()
    const registry = createOpenclawRegistry({ storage })
    await registry.register(mapping({ channelId: CHAT_A, sessionID: SESSION_A }))
    await registry.register(mapping({ channelId: CHAT_B, sessionID: SESSION_B }))

    expect(await registry.removeSession(SESSION_A)).toBe(1)

    expect(registry.size()).toBe(1)
    expect(registry.lookup("telegram", SHARED_MESSAGE_ID, CHAT_A)).toBeNull()
    expect(registry.lookup("telegram", SHARED_MESSAGE_ID, CHAT_B)?.sessionID).toBe(SESSION_B)
    expect(storedKeys(storage)).toHaveLength(1)
  })

  test("#given two chats publishing the same message id #when each chat replies #then no reply crosses into the other session", async () => {
    const storage = memoryStorage()
    const registry = createOpenclawRegistry({ storage })
    const publisher = createOpenclawOutbound({
      config: { enabled: true },
      registry,
      fetchImpl: telegramPort({ publishedMessageId: Number(SHARED_MESSAGE_ID), reply: null }),
      env: { RIGEL_OPENCLAW_TELEGRAM_API_BASE: TELEGRAM_BASE },
      notificationChannels: channels(),
    })
    // Chat A publishes on session.idle, chat B on session.created: two chats owned by
    // two sessions, which is the shape whose platform message ids collide.
    await publisher.handleEvent({ type: "session.idle", sessionID: SESSION_A })
    await publisher.handleEvent({ type: "session.created", sessionID: SESSION_B })
    expect(registry.size()).toBe(2)
    expect(registry.lookup("telegram", SHARED_MESSAGE_ID, CHAT_A)?.sessionID).toBe(SESSION_A)
    expect(registry.lookup("telegram", SHARED_MESSAGE_ID, CHAT_B)?.sessionID).toBe(SESSION_B)

    const replyIn = (chatId) => ({
      message_id: 10,
      chat: { id: chatId },
      from: { id: "u1" },
      text: `reply from ${chatId}`,
      reply_to_message: { message_id: Number(SHARED_MESSAGE_ID) },
    })

    const injectionsFor = async (chatId) => {
      const delivered = []
      const inbound = createOpenclawInbound({
        replyListener: { telegramBotToken: TOKEN, telegramChatId: chatId, pollIntervalMs: 3000, rateLimitPerMinute: 30 },
        registry,
        deliverInboundReply: async (input) => { delivered.push(input); return true },
        fetchImpl: telegramPort({ publishedMessageId: Number(SHARED_MESSAGE_ID), reply: replyIn(chatId) }),
        telegramApiBase: TELEGRAM_BASE,
        sleep: immediateSleep,
        log: () => {},
      })
      await inbound.start()
      await waitFor(() => delivered.length > 0, `reply injection for ${chatId}`)
      await inbound.stop()
      return delivered
    }

    const chatA = await injectionsFor(CHAT_A)
    const chatB = await injectionsFor(CHAT_B)

    expect(chatA).toHaveLength(1)
    expect(chatB).toHaveLength(1)
    expect(chatA[0].sessionID).toBe(SESSION_A)
    expect(chatB[0].sessionID).toBe(SESSION_B)
    expect(chatA[0].text).toBe("[reply:telegram] reply from chat-a")
    expect(chatB[0].text).toBe("[reply:telegram] reply from chat-b")
  })
})

/**
 * The upgrade path of the same registry.
 *
 * C1 changed the identity of a chat-scoped record from `(platform, messageId)` to
 * `(platform, chat, messageId)`. Every record written before that change still
 * carries the old storage key (`sha1(platform\0 messageId)`) while its VALUE
 * already names the chat, so hydration has to keep the key it scanned: a removal
 * that re-derives the key from the value deletes a key that never existed, the
 * durable record survives, and the next process re-indexes it.
 *
 * These cases pin the upgrade contract, not the identity contract the block above
 * pins: a deleted session must not come back after a restart, a stale pre-C1
 * record must be prunable, and removing one session must not silence another one
 * whose record happens to share an identity.
 */
function seed(storage, key, overrides = {}) {
  storage.map.set(key, mapping(overrides))
}

describe("openclaw registry upgrade from the pre-fix key", () => {
  test("#given a record the pre-fix writer persisted #when a new process hydrates and the session is deleted #then the correlation does not revive", async () => {
    const storage = memoryStorage()
    seed(storage, LEGACY_TELEGRAM_KEY, { sessionID: "ses_deleted" })

    const first = createOpenclawRegistry({ storage })
    await first.hydrate()
    expect(first.lookup("telegram", SHARED_MESSAGE_ID, CHAT_A)?.sessionID).toBe("ses_deleted")

    expect(await first.removeSession("ses_deleted")).toBe(1)
    expect(storedKeys(storage)).toEqual([])

    const restarted = createOpenclawRegistry({ storage })
    await restarted.hydrate()
    expect(restarted.lookup("telegram", SHARED_MESSAGE_ID, CHAT_A)).toBeNull()
    expect(restarted.size()).toBe(0)
  })

  test("#given a pre-fix record already past the TTL #when a new process hydrates and prunes #then the pre-fix key is deleted", async () => {
    const clock = Date.parse("2026-02-02T00:00:00.000Z")
    const storage = memoryStorage()
    seed(storage, LEGACY_TELEGRAM_KEY, { sessionID: "ses_stale", createdAt: new Date(clock - OPENCLAW_REGISTRY_MAX_AGE_MS - 1000).toISOString() })

    const registry = createOpenclawRegistry({ storage, now: () => clock })
    await registry.hydrate()
    expect(await registry.prune()).toBe(1)

    expect(storedKeys(storage)).toEqual([])
  })

  test("#given a hydrated pre-fix record that expires while the process runs #when prune runs #then the pre-fix key is deleted", async () => {
    let clock = Date.parse("2026-03-02T00:00:00.000Z")
    const storage = memoryStorage()
    seed(storage, LEGACY_TELEGRAM_KEY, { sessionID: "ses_old", createdAt: new Date(clock).toISOString() })

    const registry = createOpenclawRegistry({ storage, now: () => clock })
    await registry.hydrate()
    clock += OPENCLAW_REGISTRY_MAX_AGE_MS + 1000
    expect(await registry.prune()).toBe(1)

    expect(storedKeys(storage)).toEqual([])
  })

  test("#given a hydrated scoped record #when its session is deleted #then the scoped key is deleted and a restart does not resolve it", async () => {
    const storage = memoryStorage()
    seed(storage, SCOPED_KEY_CHAT_A, { sessionID: SESSION_A })

    const first = createOpenclawRegistry({ storage })
    await first.hydrate()
    expect(first.lookup("telegram", SHARED_MESSAGE_ID, CHAT_A)?.sessionID).toBe(SESSION_A)

    expect(await first.removeSession(SESSION_A)).toBe(1)
    expect(storedKeys(storage)).toEqual([])

    const restarted = createOpenclawRegistry({ storage })
    await restarted.hydrate()
    expect(restarted.lookup("telegram", SHARED_MESSAGE_ID, CHAT_A)).toBeNull()
  })

  test("#given a hydrated discord record #when its session is deleted #then the platform-wide key is deleted and a restart does not resolve it", async () => {
    const storage = memoryStorage()
    const discordKey = `${PREFIX}d57083662eb3363971f51c0b0b285259736f4d6b`
    seed(storage, discordKey, { platform: "discord-bot", messageId: "m1", channelId: "chan-1", sessionID: "ses_d" })

    const first = createOpenclawRegistry({ storage })
    await first.hydrate()
    expect(first.lookup("discord-bot", "m1")?.sessionID).toBe("ses_d")

    expect(await first.removeSession("ses_d")).toBe(1)
    expect(storedKeys(storage)).toEqual([])

    const restarted = createOpenclawRegistry({ storage })
    await restarted.hydrate()
    expect(restarted.lookup("discord-bot", "m1")).toBeNull()
  })

  test("#given a chat-less legacy record #when its session is deleted #then the pre-fix key is deleted and a restart does not resolve it", async () => {
    const storage = memoryStorage()
    seed(storage, LEGACY_TELEGRAM_KEY, { channelId: undefined, sessionID: "ses_legacy" })

    const first = createOpenclawRegistry({ storage })
    await first.hydrate()
    expect(first.lookup("telegram", SHARED_MESSAGE_ID, CHAT_A)?.sessionID).toBe("ses_legacy")

    expect(await first.removeSession("ses_legacy")).toBe(1)
    expect(storedKeys(storage)).toEqual([])
  })

  test("#given a pre-fix record and a newer scoped record for one identity #when the legacy session is deleted #then only the legacy key is deleted and the newer correlation survives the restart", async () => {
    const clock = Date.parse("2026-04-01T00:10:00.000Z")
    const storage = memoryStorage()
    // The order a real upgrade produces: the C1 record is the newest half, the
    // pre-fix record is the older one that was never cleaned up. Two durable
    // records, one identity.
    seed(storage, SCOPED_KEY_CHAT_A, { sessionID: "ses_new", createdAt: "2026-03-31T23:50:00.000Z" })
    seed(storage, LEGACY_TELEGRAM_KEY, { sessionID: "ses_legacy", createdAt: "2026-03-31T23:00:00.000Z" })

    const first = createOpenclawRegistry({ storage, now: () => clock })
    await first.hydrate()
    // The newest answer wins, so the pre-fix half can never shadow the live one.
    expect(first.lookup("telegram", SHARED_MESSAGE_ID, CHAT_A)?.sessionID).toBe("ses_new")

    expect(await first.removeSession("ses_legacy")).toBe(1)
    expect(storedKeys(storage)).toEqual([SCOPED_KEY_CHAT_A])

    const restarted = createOpenclawRegistry({ storage, now: () => clock })
    await restarted.hydrate()
    expect(restarted.lookup("telegram", SHARED_MESSAGE_ID, CHAT_A)?.sessionID).toBe("ses_new")
  })

  test("#given a record this build cannot read #when the registry hydrates and prunes #then it is neither indexed nor deleted", async () => {
    const storage = memoryStorage()
    const foreignKey = `${PREFIX}foreign`
    seed(storage, foreignKey, { channelId: { id: CHAT_A } })

    const registry = createOpenclawRegistry({ storage })
    await registry.hydrate()
    expect(registry.size()).toBe(0)
    expect(registry.lookup("telegram", SHARED_MESSAGE_ID, CHAT_A)).toBeNull()
    expect(await registry.prune()).toBe(0)

    // A shape this build does not understand may belong to a future build;
    // deleting it would be destructive. Ignoring it is the fail-closed answer.
    expect(storedKeys(storage)).toEqual([foreignKey])
  })
})
