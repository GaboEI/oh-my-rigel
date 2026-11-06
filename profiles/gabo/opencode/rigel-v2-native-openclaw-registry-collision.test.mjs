import { describe, expect, test } from "bun:test"
import { createOpenclawInbound } from "./rigel-v2-native-openclaw-inbound.mjs"
import { createOpenclawRegistry, OPENCLAW_REGISTRY_MAX_AGE_MS, OPENCLAW_REGISTRY_PREFIX } from "./rigel-v2-native-openclaw-registry.mjs"

/**
 * B3: a chat-less Telegram registration must not take over the record a
 * chat-scoped identity occupies.
 *
 * The pre-C1 writer keyed Telegram by `sha1("telegram\0<messageId>")` and only
 * later started carrying the chat inside the value. `hydrate()` keeps that record
 * under the key it really occupies, so the chat-scoped identity and the chat-less
 * identity can both claim the same `(platform, messageId)`:
 *
 *   - the scoped record answers `lookup(platform, messageId, chat)` for its chat;
 *   - the chat-less record keeps the pre-fix key while that slot is free, and
 *     moves to a displaced key when the slot already holds another identity;
 *   - both live under their own durable keys, so `list()` lists each identity
 *     once, `removeSession()` deletes only its own record, and `prune()` deletes
 *     the keys it scanned.
 *
 * The pre-fix key literal below is the one `correlation-chat.test.mjs` pins for
 * `telegram\0 77`, computed outside this module.
 */
const LEGACY_TELEGRAM_KEY = `${OPENCLAW_REGISTRY_PREFIX}67b1e237bce293b429775506a96079ba1782cce3`
const CHAT_A = "chat-a"
const CHAT_B = "chat-b"
const SESSION_A = "ses_chat_a"
const SESSION_GATEWAY = "ses_gateway"
const SESSION_B = "ses_chat_b"
const SHARED_MESSAGE_ID = "77"
const TELEGRAM_BASE = "http://127.0.0.1:9/telegram"
const TOKEN = "synthetic-collision-token"

function memoryStorage(seed = []) {
  const map = new Map(seed)
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

function deferredCandidateStorage() {
  const storage = memoryStorage()
  let releaseFirstRead
  let firstReadStartedResolve
  const firstReadStarted = new Promise((resolve) => { firstReadStartedResolve = resolve })
  let deferFirstRead = true
  return {
    storage: {
      ...storage,
      get: async (key) => {
        if (deferFirstRead) {
          deferFirstRead = false
          firstReadStartedResolve()
          await new Promise((resolve) => { releaseFirstRead = resolve })
        }
        return storage.map.get(key)
      },
    },
    firstReadStarted,
    releaseFirstRead: () => releaseFirstRead(),
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

const chatless = (overrides = {}) => mapping({ channelId: undefined, sessionID: SESSION_GATEWAY, ...overrides })
const storedSessions = (storage) => [...storage.map.values()].map((value) => value.sessionID).sort()
const storedKeysFor = (storage, sessionID) => [...storage.map.entries()]
  .filter(([, value]) => value.sessionID === sessionID)
  .map(([key]) => key)
const listedSessions = (registry) => registry.list().map((entry) => entry.sessionID).sort()

async function hydratedPreC1Record(extra = {}) {
  const storage = memoryStorage([[LEGACY_TELEGRAM_KEY, mapping({ sessionID: SESSION_A, ...extra })]])
  const registry = createOpenclawRegistry({ storage })
  await registry.hydrate()
  return { storage, registry }
}

describe("openclaw registry chat-scoped and chat-less coexistence", () => {
  test("#given a hydrated pre-C1 record #when a chat-less mapping reuses its message id #then the scoped chat keeps its own session and both records stay on disk", async () => {
    const { storage, registry } = await hydratedPreC1Record()

    expect(await registry.register(chatless())).toBe(true)

    expect(registry.lookup("telegram", SHARED_MESSAGE_ID, CHAT_A)?.sessionID).toBe(SESSION_A)
    expect(registry.lookup("telegram", SHARED_MESSAGE_ID)?.sessionID).toBe(SESSION_GATEWAY)
    expect(registry.size()).toBe(2)
    expect(listedSessions(registry)).toEqual([SESSION_A, SESSION_GATEWAY])
    expect(storedSessions(storage)).toEqual([SESSION_A, SESSION_GATEWAY])
    expect(storedKeysFor(storage, SESSION_A)).toHaveLength(1)
    expect(storedKeysFor(storage, SESSION_GATEWAY)).toHaveLength(1)
    expect(storedKeysFor(storage, SESSION_A)).not.toEqual(storedKeysFor(storage, SESSION_GATEWAY))
  })

  test("#given a chat-less record in the free legacy slot #when a scoped mapping registers the same id #then the two identities coexist", async () => {
    const storage = memoryStorage()
    const registry = createOpenclawRegistry({ storage })

    await registry.register(chatless())
    await registry.register(mapping({ channelId: CHAT_A, sessionID: SESSION_A }))

    expect(registry.lookup("telegram", SHARED_MESSAGE_ID, CHAT_A)?.sessionID).toBe(SESSION_A)
    expect(registry.lookup("telegram", SHARED_MESSAGE_ID, CHAT_B)?.sessionID).toBe(SESSION_GATEWAY)
    expect(registry.size()).toBe(2)
    expect(storedSessions(storage)).toEqual([SESSION_A, SESSION_GATEWAY])
  })

  test("#given the collision #when the same chat-less mapping registers again #then its displaced key is reused instead of adding a record", async () => {
    const { storage, registry } = await hydratedPreC1Record()
    await registry.register(chatless())

    await registry.register(chatless({ createdAt: new Date(Date.now() + 1_000).toISOString() }))

    expect(registry.size()).toBe(2)
    expect(storage.map.size).toBe(2)
    expect(storedKeysFor(storage, SESSION_GATEWAY)).toHaveLength(1)
    expect(registry.lookup("telegram", SHARED_MESSAGE_ID, CHAT_A)?.sessionID).toBe(SESSION_A)
  })

  test("#given the collision #when a new process hydrates the store #then both identities resolve to their own session", async () => {
    const { storage } = await hydratedPreC1Record()
    const writer = createOpenclawRegistry({ storage })
    await writer.hydrate()
    await writer.register(chatless())

    const restarted = createOpenclawRegistry({ storage })
    await restarted.hydrate()

    expect(restarted.lookup("telegram", SHARED_MESSAGE_ID, CHAT_A)?.sessionID).toBe(SESSION_A)
    expect(restarted.lookup("telegram", SHARED_MESSAGE_ID)?.sessionID).toBe(SESSION_GATEWAY)
    expect(restarted.size()).toBe(2)
  })

  test("#given the collision #when the scoped session is deleted #then only its key is deleted and the chat-less record still answers", async () => {
    const { storage, registry } = await hydratedPreC1Record()
    await registry.register(chatless())

    expect(await registry.removeSession(SESSION_A)).toBe(1)

    expect(storage.map.size).toBe(1)
    expect(storedKeysFor(storage, SESSION_A)).toEqual([])
    expect(storedSessions(storage)).toEqual([SESSION_GATEWAY])
    expect(registry.size()).toBe(1)
    // The now-unowned chat keeps the documented legacy fallback and never answers
    // with the session that was just deleted.
    expect(registry.lookup("telegram", SHARED_MESSAGE_ID, CHAT_A)?.sessionID).toBe(SESSION_GATEWAY)
    expect(registry.lookup("telegram", SHARED_MESSAGE_ID)?.sessionID).toBe(SESSION_GATEWAY)

    const restarted = createOpenclawRegistry({ storage })
    await restarted.hydrate()
    expect(restarted.lookup("telegram", SHARED_MESSAGE_ID, CHAT_A)?.sessionID).toBe(SESSION_GATEWAY)
    expect(restarted.size()).toBe(1)
  })

  test("#given the collision and an aged record #when prune runs #then it deletes the scanned keys of the stale record only", async () => {
    let clock = Date.parse("2026-05-02T00:00:00.000Z")
    const aged = new Date(clock - OPENCLAW_REGISTRY_MAX_AGE_MS - 1_000).toISOString()
    const storage = memoryStorage([
      [LEGACY_TELEGRAM_KEY, mapping({ sessionID: SESSION_A })],
      [`${OPENCLAW_REGISTRY_PREFIX}aged-foreign`, mapping({ messageId: "88", sessionID: "ses_stale", createdAt: aged })],
    ])
    const registry = createOpenclawRegistry({ storage, now: () => clock })
    await registry.hydrate()
    await registry.register(chatless())

    expect(await registry.prune()).toBe(1)

    expect(storage.map.has(`${OPENCLAW_REGISTRY_PREFIX}aged-foreign`)).toBe(false)
    expect(storage.map.size).toBe(2)
    expect(storedSessions(storage)).toEqual([SESSION_A, SESSION_GATEWAY])
    expect(registry.lookup("telegram", SHARED_MESSAGE_ID, CHAT_A)?.sessionID).toBe(SESSION_A)
    expect(registry.lookup("telegram", SHARED_MESSAGE_ID)?.sessionID).toBe(SESSION_GATEWAY)
    expect(await registry.prune()).toBe(0)
  })

  test("#given a stored pre-C1 record this process has not hydrated #when a chat-less mapping registers first #then the stored record is not overwritten", async () => {
    const storage = memoryStorage([[LEGACY_TELEGRAM_KEY, mapping({ sessionID: SESSION_A })]])
    const registry = createOpenclawRegistry({ storage })

    expect(await registry.register(chatless())).toBe(true)
    expect(storedKeysFor(storage, SESSION_A)).toHaveLength(1)
    expect(storage.map.size).toBe(2)

    await registry.hydrate()
    expect(registry.lookup("telegram", SHARED_MESSAGE_ID, CHAT_A)?.sessionID).toBe(SESSION_A)
    expect(registry.lookup("telegram", SHARED_MESSAGE_ID)?.sessionID).toBe(SESSION_GATEWAY)
  })

  test("#given a stored value that changed the identity of a key this process knows #when hydrate runs again #then the indexed identity is kept and reported", async () => {
    const storage = memoryStorage()
    const lines = []
    const registry = createOpenclawRegistry({ storage, log: (line) => lines.push(line) })
    await registry.register(mapping({ channelId: CHAT_A, sessionID: SESSION_A }))
    const [scopedKey] = [...storage.map.keys()]

    // Another writer replaced the value under the same key with a different identity.
    storage.map.set(scopedKey, mapping({ channelId: CHAT_B, sessionID: SESSION_B }))
    await registry.hydrate()

    expect(registry.lookup("telegram", SHARED_MESSAGE_ID, CHAT_A)?.sessionID).toBe(SESSION_A)
    expect(registry.lookup("telegram", SHARED_MESSAGE_ID, CHAT_B)).toBeNull()
    expect(registry.size()).toBe(1)
    expect(storage.map.size).toBe(1)
    expect(lines.length).toBeGreaterThan(0)

  })

  test("#given candidate allocation is awaiting storage #when its session is removed #then the stale registration cannot resurrect it or block independent registrations", async () => {
    const deferred = deferredCandidateStorage()
    const registry = createOpenclawRegistry({ storage: deferred.storage })
    const deleted = mapping({ sessionID: "ses_deleted_during_allocation", messageId: "race-deleted" })
    const unrelated = mapping({ sessionID: "ses_unrelated", messageId: "race-unrelated", channelId: CHAT_B })
    const reregistered = mapping({ sessionID: "ses_deleted_during_allocation", messageId: "race-reregistered" })

    const staleRegistration = registry.register(deleted)
    await deferred.firstReadStarted
    const unrelatedRegistration = await registry.register(unrelated)
    expect(unrelatedRegistration).toBe(true)
    expect(await registry.removeSession(deleted.sessionID)).toBe(0)

    deferred.releaseFirstRead()
    expect(await staleRegistration).toBe(false)
    expect(registry.lookup("telegram", deleted.messageId, CHAT_A)).toBeNull()
    expect(registry.list().map((entry) => entry.sessionID)).toEqual([unrelated.sessionID])
    expect(storedSessions(deferred.storage)).toEqual([unrelated.sessionID])

    expect(await registry.register(reregistered)).toBe(true)
    expect(registry.lookup("telegram", reregistered.messageId, CHAT_A)?.sessionID).toBe(reregistered.sessionID)

    const restarted = createOpenclawRegistry({ storage: deferred.storage })
    await restarted.hydrate()
    expect(restarted.lookup("telegram", deleted.messageId, CHAT_A)).toBeNull()
    expect(restarted.lookup("telegram", unrelated.messageId, CHAT_B)?.sessionID).toBe(unrelated.sessionID)
    expect(restarted.lookup("telegram", reregistered.messageId, CHAT_A)?.sessionID).toBe(reregistered.sessionID)
  })
})

describe("openclaw registry prune lifecycle boundary", () => {
  test("#given the production registry module #when prune call sites are inspected #then no production caller schedules destructive reclamation", async () => {
    const source = await Bun.file(new URL("./rigel-v2-native-openclaw-registry.mjs", import.meta.url)).text()
    const executable = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")
    const declaration = executable.indexOf("async function prune()")

    expect(declaration).toBeGreaterThanOrEqual(0)
    expect(executable.slice(0, declaration)).not.toMatch(/\bprune\s*\(/)
    expect(executable.slice(declaration + "async function prune()".length)).not.toMatch(/\bprune\s*\(/)
  })
})

function immediateSleep() {
  return new Promise((resolve) => setImmediate(resolve))
}

async function waitFor(predicate, message, maxIterations = 5000) {
  for (let index = 0; index < maxIterations; index += 1) {
    if (predicate()) return
    await immediateSleep()
  }
  throw new Error(`timed out: ${message}`)
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }
}

function telegramPort({ reply }) {
  let served = false
  return async (url, init = {}) => {
    if (url.includes("/getUpdates")) {
      if (served) return jsonResponse({ ok: true, result: [] })
      served = true
      return jsonResponse({ ok: true, result: [{ update_id: 5, message: reply }] })
    }
    if (url.includes("/sendMessage")) {
      const body = JSON.parse(init.body ?? "{}")
      return jsonResponse({ ok: true, result: { message_id: 900, chat: { id: body.chat_id } } })
    }
    return jsonResponse({})
  }
}

async function injectionsFor(registry, chatId) {
  const delivered = []
  const reply = {
    message_id: 10,
    chat: { id: chatId },
    from: { id: "u1" },
    text: `reply from ${chatId}`,
    reply_to_message: { message_id: Number(SHARED_MESSAGE_ID) },
  }
  const inbound = createOpenclawInbound({
    replyListener: { telegramBotToken: TOKEN, telegramChatId: chatId, pollIntervalMs: 3000, rateLimitPerMinute: 30 },
    registry,
    deliverInboundReply: async (input) => { delivered.push(input); return true },
    fetchImpl: telegramPort({ reply }),
    telegramApiBase: TELEGRAM_BASE,
    sleep: immediateSleep,
    log: () => {},
  })
  await inbound.start()
  await waitFor(() => delivered.length > 0, `reply injection for ${chatId}`)
  await inbound.stop()
  return delivered
}

describe("openclaw registry coexistence at the reply boundary", () => {
  test("#given a chat-less record sharing the id #when the owning chat replies #then the injection reaches the session that published it", async () => {
    const { registry } = await hydratedPreC1Record()
    await registry.register(chatless())

    const chatA = await injectionsFor(registry, CHAT_A)

    expect(chatA).toHaveLength(1)
    expect(chatA[0].sessionID).toBe(SESSION_A)
    expect(chatA[0].text).toBe("[reply:telegram] reply from chat-a")
    expect(registry.size()).toBe(2)
  })

  test("#given a chat with no scoped record #when it replies #then it gets the unscoped fallback and never another chat's session", async () => {
    const { registry } = await hydratedPreC1Record()
    await registry.register(chatless())

    const chatB = await injectionsFor(registry, CHAT_B)

    expect(chatB).toHaveLength(1)
    expect(chatB[0].sessionID).toBe(SESSION_GATEWAY)
    expect(chatB[0].sessionID).not.toBe(SESSION_A)
  })
})
