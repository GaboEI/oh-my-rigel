import { describe, expect, test } from "bun:test"
import { createOpenclawInbound } from "./rigel-v2-native-openclaw-inbound.mjs"
import { createOpenclawRegistry } from "./rigel-v2-native-openclaw-registry.mjs"
import {
  OPENCLAW_CURSOR_PREFIX,
  OPENCLAW_CURSOR_VERSION,
  createOpenclawCursorStore,
  openclawCursorKey,
} from "./rigel-v2-native-openclaw-cursor.mjs"

/**
 * §U8: the persisted poll cursor. The contract this suite protects is the one
 * `Unidades_Atomicas_OpenClaw.md` §U8 states: a cursor versioned per platform and
 * channel, persisted, advanced ONLY after the acknowledgement, with duplicate
 * suppression by message id, so a restart before the ack loses nothing and a
 * restart after the ack duplicates nothing. The pinned acknowledgement of Telegram
 * and the processing order are asserted here as well, because they must not move.
 */

const BOT_MESSAGE_ID = "botmsg"
const TELEGRAM_BOT_MESSAGE_ID = "tg-bot"

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

function registryWith(platform, messageId, sessionID) {
  const registry = createOpenclawRegistry({})
  registry.register({ sessionID, projectPath: "/p", platform, messageId, createdAt: new Date().toISOString() })
  return registry
}

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }
}

function discordMessage(overrides = {}) {
  return { id: "m2", content: "hello", author: { id: "u1" }, message_reference: { message_id: BOT_MESSAGE_ID }, ...overrides }
}

/**
 * A Discord port. `pollLimit` decides how many polls answer with the window and
 * how many answer empty, so the loop can be observed without a timer; `ackStatuses`
 * makes the acknowledgment path deterministic attempt by attempt.
 */
function discordPort({ messages, pollLimit = Number.POSITIVE_INFINITY, ackStatuses = [200] } = {}) {
  const calls = []
  let polls = 0
  let acks = 0
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    if (url.includes("/reactions/")) {
      const status = ackStatuses[Math.min(acks, ackStatuses.length - 1)]
      acks += 1
      return response({}, status)
    }
    polls += 1
    return response(polls > pollLimit ? [] : messages)
  }
  fetchImpl.calls = calls
  fetchImpl.ackCalls = () => calls.filter((call) => call.url.includes("/reactions/"))
  fetchImpl.pollCalls = () => calls.filter((call) => call.url.includes("/messages?"))
  return fetchImpl
}

function discordListener({ storage, fetchImpl, registry, deliverInboundReply, log, statusDocument, now, replyListener }) {
  const delivered = []
  const inbound = createOpenclawInbound({
    replyListener: {
      discordBotToken: "token",
      discordChannelId: "chan",
      authorizedDiscordUserIds: ["u1"],
      pollIntervalMs: 500,
      includePrefix: true,
      ...replyListener,
    },
    registry: registry ?? registryWith("discord-bot", BOT_MESSAGE_ID, "ses_1"),
    deliverInboundReply: deliverInboundReply ?? (async (input) => { delivered.push(input); return true }),
    fetchImpl,
    sleep: immediateSleep,
    log: log ?? (() => {}),
    statusDocument,
    now,
    storage,
  })
  return { inbound, delivered }
}

function cursorDocument(storage, platform, channel) {
  return storage.map.get(openclawCursorKey(platform, channel))
}

/**
 * A storage domain whose writes fail a fixed number of times before it heals. It is
 * the only way to drive the §U8 durability path from a test: the failure has to be
 * the domain's, not a mock of the store's own bookkeeping.
 */
function failingStorage({ failWrites = Number.POSITIVE_INFINITY } = {}) {
  const map = new Map()
  const storage = {
    map,
    writes: 0,
    get: async (key) => map.get(key),
    set: async (key, value) => {
      storage.writes += 1
      if (storage.writes <= failWrites) throw new Error("storage unavailable")
      map.set(key, value)
    },
    remove: async (key) => { map.delete(key) },
    scan: async ({ prefix } = {}) => ({
      entries: [...map.entries()]
        .filter(([key]) => (prefix ? key.startsWith(prefix) : true))
        .map(([key, value]) => ({ key, value })),
    }),
  }
  return storage
}

/** The status document, reduced to the transitions a poll reports. */
function statusRecorder() {
  const events = []
  return {
    events,
    recordSuccess: async (surface) => { events.push({ kind: "success", surface }) },
    recordFailure: async (surface, { errorClass } = {}) => { events.push({ kind: "failure", surface, errorClass }) },
    recordRateLimit: async (surface) => { events.push({ kind: "rate-limit", surface }) },
  }
}

describe("openclaw poll cursor document", () => {
  test("#given two platforms and two channels #when a cursor is stored #then each names its own versioned record", async () => {
    expect(openclawCursorKey("discord", "chan")).not.toBe(openclawCursorKey("telegram", "chan"))
    expect(openclawCursorKey("discord", "chan")).not.toBe(openclawCursorKey("discord", "other"))
    expect(openclawCursorKey("discord", "chan").startsWith(OPENCLAW_CURSOR_PREFIX)).toBe(true)

    const storage = memoryStorage()
    const store = createOpenclawCursorStore({ storage })
    // The Telegram cursor is its update id, the Discord one is a message id: the
    // two platforms do not share a value space and must not share a record.
    await store.commitAck("discord", "chan", { messageId: "m2", cursor: "m2" })
    await store.commitAck("telegram", "chan", { messageId: "10", cursor: 7 })

    expect(cursorDocument(storage, "discord", "chan")).toMatchObject({
      v: OPENCLAW_CURSOR_VERSION,
      platform: "discord",
      channel: "chan",
      cursor: "m2",
    })
    expect(cursorDocument(storage, "telegram", "chan")).toMatchObject({
      v: OPENCLAW_CURSOR_VERSION,
      platform: "telegram",
      channel: "chan",
      cursor: 7,
    })
    expect(storage.map.size).toBe(2)
  })

  test("#given a document a previous process wrote #when hydrated #then the frontier and the duplicate memory come back", async () => {
    const storage = memoryStorage()
    storage.map.set(openclawCursorKey("telegram", "chat"), {
      v: OPENCLAW_CURSOR_VERSION,
      platform: "telegram",
      channel: "chat",
      cursor: 7,
      delivered: ["10"],
      acked: [],
      updatedAt: "2026-11-02T00:00:00.000Z",
    })
    const store = createOpenclawCursorStore({ storage })
    await store.hydrate()

    expect(store.cursorFor("telegram", "chat")).toBe(7)
    expect(store.stateOf("telegram", "chat", "10")).toBe("delivered")
    expect(store.stateOf("telegram", "chat", "11")).toBe("new")
  })

  test("#given a record this build cannot read #when hydrated #then it is ignored once instead of obeyed", async () => {
    const storage = memoryStorage()
    // A future schema and a foreign shape. Obeying either could skip messages for
    // good, so the store starts from zero (one duplicate at worst) and says so.
    storage.map.set(openclawCursorKey("discord", "chan"), {
      v: OPENCLAW_CURSOR_VERSION + 1,
      platform: "discord",
      channel: "chan",
      cursor: "m9",
      delivered: [],
      acked: [],
    })
    storage.map.set(`${OPENCLAW_CURSOR_PREFIX}discord/foreign`, { platform: "discord" })
    const lines = []
    const store = createOpenclawCursorStore({ storage, log: (line) => lines.push(line) })
    await store.hydrate()

    expect(store.cursorFor("discord", "chan")).toBeNull()
    expect(lines).toHaveLength(1)
  })
})

describe("openclaw inbound: the cursor advances only after the acknowledgement", () => {
  test("#given an acknowledgement that fails #when the reply is injected #then the cursor stays and the injection is remembered", async () => {
    const storage = memoryStorage()
    const fetchImpl = discordPort({ messages: [discordMessage()], pollLimit: 1, ackStatuses: [500] })
    const { inbound, delivered } = discordListener({ storage, fetchImpl })

    await inbound.start()
    await waitFor(() => fetchImpl.ackCalls().length >= 1, "failed ack")
    await inbound.stop()

    expect(delivered).toHaveLength(1)
    expect(cursorDocument(storage, "discord", "chan")).toMatchObject({ cursor: null, delivered: ["m2"], acked: [] })
    expect(inbound.status().discordLastMessageId).toBeNull()
  })

  test("#given an acknowledgement that lands #when the reply is injected #then the cursor moves past it", async () => {
    const storage = memoryStorage()
    const fetchImpl = discordPort({ messages: [discordMessage()], pollLimit: 1 })
    const { inbound } = discordListener({ storage, fetchImpl })

    await inbound.start()
    await waitFor(() => fetchImpl.ackCalls().length >= 1, "ack")
    await inbound.stop()

    expect(cursorDocument(storage, "discord", "chan")).toMatchObject({ cursor: "m2", delivered: [], acked: ["m2"] })
    expect(inbound.status().discordLastMessageId).toBe("m2")
  })

  test("#given a held cursor #when the platform re-serves the window #then the reply is injected once and only its ack is retried", async () => {
    const storage = memoryStorage()
    const fetchImpl = discordPort({ messages: [discordMessage()], pollLimit: 2, ackStatuses: [500, 200] })
    const { inbound, delivered } = discordListener({ storage, fetchImpl })

    await inbound.start()
    await waitFor(() => fetchImpl.ackCalls().length >= 2, "retried ack")
    await inbound.stop()

    // Dedup by message id: the second read of the same message reaches no session.
    expect(delivered).toHaveLength(1)
    expect(fetchImpl.ackCalls().length).toBeGreaterThanOrEqual(2)
    expect(cursorDocument(storage, "discord", "chan")).toMatchObject({ cursor: "m2", delivered: [], acked: ["m2"] })
  })

  test("#given an acknowledgement that keeps failing #when the poller retries it #then the failure is named once, not once per poll", async () => {
    const storage = memoryStorage()
    const lines = []
    const fetchImpl = discordPort({ messages: [discordMessage()], ackStatuses: [500] })
    const { inbound } = discordListener({ storage, fetchImpl, log: (line) => lines.push(line) })

    await inbound.start()
    await waitFor(() => fetchImpl.ackCalls().length >= 4, "retried acks")
    await inbound.stop()

    // §9.3: one failure per interval would be noise. The first attempt names it and
    // the held cursor is what says the acknowledgement is still owed.
    expect(lines.filter((line) => line.includes("Failed to acknowledge"))).toHaveLength(1)
    expect(inbound.status().errors).toBe(0)
  })

  test("#given a message the poller deliberately drops #when the window is processed #then the cursor still moves past it", async () => {
    const storage = memoryStorage()
    const fetchImpl = discordPort({ messages: [discordMessage({ author: { id: "intruder" } })], pollLimit: 1 })
    const { inbound, delivered } = discordListener({ storage, fetchImpl })

    await inbound.start()
    await waitFor(() => fetchImpl.pollCalls().length >= 1, "discord poll")
    await inbound.stop()

    // §9.3 keeps the drop silent, but silence is not a hold: a message with
    // nothing owed must not pin the window forever.
    expect(delivered).toEqual([])
    expect(cursorDocument(storage, "discord", "chan")).toMatchObject({ cursor: "m2", delivered: [], acked: [] })
  })

  test("#given an injection the gate refuses #when the window is processed #then the cursor holds and its successors are not injected ahead", async () => {
    const storage = memoryStorage()
    const attempts = []
    const fetchImpl = discordPort({ messages: [discordMessage({ id: "m3" }), discordMessage({ id: "m2" })], pollLimit: 1 })
    const { inbound } = discordListener({
      storage,
      fetchImpl,
      deliverInboundReply: async (input) => { attempts.push(input); return false },
    })

    await inbound.start()
    await waitFor(() => attempts.length >= 1, "refused injection")
    await inbound.stop()

    // A refused injection is not this message's problem alone: the whole window
    // would be refused the same way, so the poll stops at the head.
    expect(attempts).toHaveLength(1)
    // Nothing was resolved, so there is no frontier to persist at all: a later
    // process starts from zero and re-reads the message instead of skipping it.
    expect(cursorDocument(storage, "discord", "chan")).toBeUndefined()
  })
})

describe("openclaw inbound: a restart resumes from the persisted cursor", () => {
  test("#given a reply injected without an ack #when the process restarts #then nothing is lost and nothing is injected twice", async () => {
    const storage = memoryStorage()
    const firstPort = discordPort({ messages: [discordMessage()], pollLimit: 1, ackStatuses: [500] })
    const first = discordListener({ storage, fetchImpl: firstPort })
    await first.inbound.start()
    await waitFor(() => firstPort.ackCalls().length >= 1, "first ack attempt")
    await first.inbound.stop()
    expect(first.delivered).toHaveLength(1)

    // A NEW listener over the SAME storage domain, now able to acknowledge.
    const secondPort = discordPort({ messages: [discordMessage()], pollLimit: 1 })
    const second = discordListener({ storage, fetchImpl: secondPort })
    await second.inbound.start()
    await waitFor(() => secondPort.ackCalls().length >= 1, "retried ack")
    await second.inbound.stop()

    // Not lost: the window is still served because the frontier never moved.
    expect(secondPort.pollCalls()[0].url).toContain("/messages?limit=10")
    // Not duplicated: the reply is already in the session.
    expect(second.delivered).toEqual([])
    expect(cursorDocument(storage, "discord", "chan")).toMatchObject({ cursor: "m2", delivered: [], acked: ["m2"] })
  })

  test("#given a reply already acknowledged #when the process restarts #then the poll resumes after it and injects nothing", async () => {
    const storage = memoryStorage()
    const firstPort = discordPort({ messages: [discordMessage()], pollLimit: 1 })
    const first = discordListener({ storage, fetchImpl: firstPort })
    await first.inbound.start()
    await waitFor(() => firstPort.ackCalls().length >= 1, "first ack")
    await first.inbound.stop()

    const secondPort = discordPort({ messages: [discordMessage()], pollLimit: 1 })
    const second = discordListener({ storage, fetchImpl: secondPort })
    await second.inbound.start()
    await waitFor(() => secondPort.pollCalls().length >= 1, "restarted poll")
    await second.inbound.stop()

    expect(secondPort.pollCalls()[0].url).toContain("?after=m2&limit=10")
    expect(second.delivered).toEqual([])
  })
})

describe("openclaw inbound: Telegram keeps its pinned ack, order and offset", () => {
  function telegramUpdate(overrides = {}) {
    return {
      update_id: 7,
      message: {
        message_id: 10,
        chat: { id: "chat" },
        from: { id: "u1" },
        text: "tg hello",
        reply_to_message: { message_id: TELEGRAM_BOT_MESSAGE_ID },
        ...overrides,
      },
    }
  }

  function telegramListener({ storage, fetchImpl, deliverInboundReply }) {
    const events = []
    const inbound = createOpenclawInbound({
      replyListener: { telegramBotToken: "t", telegramChatId: "chat", pollIntervalMs: 500 },
      registry: registryWith("telegram", TELEGRAM_BOT_MESSAGE_ID, "ses_tg"),
      deliverInboundReply: deliverInboundReply ?? (async () => { events.push("inject"); return true }),
      fetchImpl,
      sleep: immediateSleep,
      log: () => {},
      storage,
    })
    return { inbound, events }
  }

  function telegramPort({ updates, pollLimit = Number.POSITIVE_INFINITY, ackStatuses = [200] }) {
    const calls = []
    let polls = 0
    let acks = 0
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, init })
      if (url.includes("getUpdates")) {
        polls += 1
        return response({ ok: true, result: polls > pollLimit ? [] : updates })
      }
      const status = ackStatuses[Math.min(acks, ackStatuses.length - 1)]
      acks += 1
      return response({ ok: true, result: {} }, status)
    }
    fetchImpl.calls = calls
    fetchImpl.pollCalls = () => calls.filter((call) => call.url.includes("getUpdates"))
    fetchImpl.ackCalls = () => calls.filter((call) => call.url.includes("sendMessage"))
    return fetchImpl
  }

  test("#given a Telegram reply #when it is injected #then the pinned acknowledgement goes out unchanged and after it", async () => {
    const storage = memoryStorage()
    const port = telegramPort({ updates: [telegramUpdate()], pollLimit: 1 })
    const order = []
    const fetchImpl = async (url, init = {}) => {
      if (url.includes("sendMessage")) order.push("ack")
      return port(url, init)
    }
    const { inbound } = telegramListener({
      storage,
      fetchImpl,
      deliverInboundReply: async () => { order.push("inject"); return true },
    })

    await inbound.start()
    await waitFor(() => port.ackCalls().length >= 1, "telegram ack")
    await inbound.stop()

    const ack = port.ackCalls()[0]
    expect(ack.init.method).toBe("POST")
    expect(ack.init.headers).toEqual({ "Content-Type": "application/json" })
    const body = JSON.parse(ack.init.body)
    expect(body).toEqual({
      chat_id: "chat",
      text: "Injected into OpenCode V2 session.",
      reply_to_message_id: 10,
    })
    expect(Object.keys(body)).toEqual(["chat_id", "text", "reply_to_message_id"])
    // The queue goes out after the injection, exactly as before this unit.
    expect(order).toEqual(["inject", "ack"])
    // The cursor is Telegram's update id, and it only moved because the ack landed.
    expect(cursorDocument(storage, "telegram", "chat")).toMatchObject({ v: OPENCLAW_CURSOR_VERSION, cursor: 7 })
  })

  test("#given a Telegram reply whose ack failed #when the process restarts #then the offset has not moved and the reply is not injected twice", async () => {
    const storage = memoryStorage()
    const firstPort = telegramPort({ updates: [telegramUpdate()], pollLimit: 1, ackStatuses: [500] })
    const first = telegramListener({ storage, fetchImpl: firstPort })
    await first.inbound.start()
    await waitFor(() => firstPort.ackCalls().length >= 1, "first failed ack")
    await first.inbound.stop()
    expect(cursorDocument(storage, "telegram", "chat")).toMatchObject({ cursor: null, delivered: ["10"] })

    const secondPort = telegramPort({ updates: [telegramUpdate()], pollLimit: 1 })
    const second = telegramListener({ storage, fetchImpl: secondPort })
    await second.inbound.start()
    await waitFor(() => secondPort.ackCalls().length >= 1, "retried ack")
    await second.inbound.stop()

    // Not lost: Telegram is asked for the same update again.
    expect(secondPort.pollCalls()[0].url).toContain("getUpdates?offset=0&timeout=0")
    // Not duplicated: the reply already reached the session.
    expect(second.events).toEqual([])
    expect(cursorDocument(storage, "telegram", "chat")).toMatchObject({ cursor: 7, delivered: [], acked: ["10"] })
  })

  test("#given a Telegram reply already acknowledged #when the process restarts #then the offset resumes after it", async () => {
    const storage = memoryStorage()
    const firstPort = telegramPort({ updates: [telegramUpdate()], pollLimit: 1 })
    const first = telegramListener({ storage, fetchImpl: firstPort })
    await first.inbound.start()
    await waitFor(() => firstPort.ackCalls().length >= 1, "first ack")
    await first.inbound.stop()

    const secondPort = telegramPort({ updates: [telegramUpdate()], pollLimit: 1 })
    const second = telegramListener({ storage, fetchImpl: secondPort })
    await second.inbound.start()
    await waitFor(() => secondPort.pollCalls().length >= 1, "restarted poll")
    await second.inbound.stop()

    expect(secondPort.pollCalls()[0].url).toContain("getUpdates?offset=8&timeout=0")
    expect(second.events).toEqual([])
  })

  test("#given two replies in one window #when they are processed #then the order is the arrival order and both are acked", async () => {
    const storage = memoryStorage()
    const injected = []
    const fetchImpl = telegramPort({
      updates: [telegramUpdate({ text: "first" }), telegramUpdate({ message_id: 11, text: "second" })],
      pollLimit: 1,
    })
    const { inbound } = telegramListener({
      storage,
      fetchImpl,
      deliverInboundReply: async (input) => { injected.push(input.text); return true },
    })

    await inbound.start()
    await waitFor(() => fetchImpl.ackCalls().length >= 2, "both acks")
    await inbound.stop()

    expect(injected).toEqual(["[reply:telegram] first", "[reply:telegram] second"])
    expect(fetchImpl.ackCalls().map((call) => JSON.parse(call.init.body).reply_to_message_id)).toEqual([10, 11])
  })
})

describe("openclaw cursor: a failed write is retried instead of forgotten", () => {
  test("#given a storage write that fails #when the next window flushes #then the record is retried and the document lands", async () => {
    const storage = failingStorage({ failWrites: 1 })
    const store = createOpenclawCursorStore({ storage, now: () => 1_000_000 })
    store.setCursor("discord", "chan", "m2")

    expect(await store.flush()).toEqual({ written: 0, failed: 1 })
    expect(storage.writes).toBe(1)
    expect(store.unsaved()).toBe(1)

    // The retry is the next flush's job, and the record left the queue only once the
    // write landed: a transient failure can no longer be forgotten by the flush that
    // saw it, which is what left `markDelivered` without a durable half.
    expect(await store.flush()).toEqual({ written: 1, failed: 0 })
    expect(storage.writes).toBe(2)
    expect(store.unsaved()).toBe(0)
    expect(cursorDocument(storage, "discord", "chan")).toMatchObject({ v: OPENCLAW_CURSOR_VERSION, cursor: "m2" })
  })

  test("#given a delivered mark whose write fails #when it is recorded #then it does not claim to be durable", async () => {
    const failing = createOpenclawCursorStore({ storage: failingStorage(), now: () => 1_000_000 })
    expect(await failing.markDelivered("discord", "chan", "m2")).toBe("failed")

    // No storage domain owes nothing durable, which is the pre-U8 rollback, not a
    // failure: the answer has to distinguish the two or a caller cannot report it.
    expect(await createOpenclawCursorStore({ now: () => 1_000_000 }).markDelivered("discord", "chan", "m2")).toBe("in-memory")

    const healthy = createOpenclawCursorStore({ storage: memoryStorage(), now: () => 1_000_000 })
    expect(await healthy.markDelivered("discord", "chan", "m2")).toBe("persisted")
  })

  test("#given a storage domain that fails for a while #when its windows flush #then each spends one attempt, the degradation is named once, and the write that lands recovers it", async () => {
    const lines = []
    const storage = failingStorage({ failWrites: 4 })
    const store = createOpenclawCursorStore({ storage, now: () => 1_000_000, log: (line) => lines.push(line) })
    store.setCursor("discord", "chan", "m2")

    for (let window = 0; window < 4; window += 1) await store.flush()

    // Bounded retry: one attempt per window, never a spin, and the state stays
    // reported as unsaved so the surface cannot call a broken domain healthy.
    expect(storage.writes).toBe(4)
    expect(store.unsaved()).toBe(1)
    expect(lines.filter((line) => line.includes("cursor persist failed:"))).toHaveLength(1)
    expect(lines.filter((line) => line.includes("retrying once per window until it lands"))).toHaveLength(1)

    await store.flush()
    expect(store.unsaved()).toBe(0)
    expect(lines.filter((line) => line.includes("cursor persist recovered"))).toHaveLength(1)
    expect(cursorDocument(storage, "discord", "chan")).toMatchObject({ cursor: "m2" })

    expect(lines.filter((line) => line.includes("cursor persist"))).toHaveLength(3)
    // A healthy write after the recovery is not a second recovery: the line marks an
    // episode boundary, so a store that never failed has to stay silent.
    store.setCursor("discord", "chan", "m3")
    await store.flush()
    expect(lines.filter((line) => line.includes("cursor persist recovered"))).toHaveLength(1)
    expect(cursorDocument(storage, "discord", "chan")).toMatchObject({ cursor: "m3" })
  })

  test("#given a poll whose cursor could not be written #when the window ends #then the surface reports the degraded cursor instead of a success", async () => {
    const storage = failingStorage({ failWrites: 3 })
    const status = statusRecorder()
    const fetchImpl = discordPort({ messages: [discordMessage()], pollLimit: 2 })
    const { inbound, delivered } = discordListener({ storage, fetchImpl, statusDocument: status })

    await inbound.start()
    await waitFor(() => status.events.some((event) => event.kind === "success"), "recovered poll")
    await inbound.stop()

    // The reply is in the session and the durable half is not, which is a degraded
    // cursor and not a healthy poll: reporting success there is the silent
    // advancement the audit named.
    expect(delivered).toHaveLength(1)
    expect(status.events[0]).toEqual({ kind: "failure", surface: "discord", errorClass: "cursor-persist" })
    expect(status.events.filter((event) => event.kind === "success")).toHaveLength(1)
    expect(cursorDocument(storage, "discord", "chan")).toMatchObject({ cursor: "m2", delivered: [], acked: ["m2"] })
  })
})

describe("openclaw inbound: a stale Telegram position is retired instead of obeyed", () => {
  const NOW = Date.parse("2026-11-03T12:00:00.000Z")
  const DAY = 24 * 60 * 60 * 1000

  function storedTelegram({ cursor, updatedAt, delivered = [], acked = [] }) {
    const storage = memoryStorage()
    storage.map.set(openclawCursorKey("telegram", "chat"), {
      v: OPENCLAW_CURSOR_VERSION,
      platform: "telegram",
      channel: "chat",
      cursor,
      delivered,
      acked,
      updatedAt,
    })
    return storage
  }

  function telegramPort(serve) {
    const calls = []
    const fetchImpl = async (url) => {
      calls.push(url)
      if (url.includes("getUpdates")) return response({ ok: true, result: serve() })
      return response({ ok: true, result: {} })
    }
    fetchImpl.pollCalls = () => calls.filter((url) => url.includes("getUpdates"))
    return fetchImpl
  }

  function resumeInbound({ storage, fetchImpl, statusDocument, delivered, at = NOW }) {
    const injected = delivered ?? []
    return createOpenclawInbound({
      replyListener: { telegramBotToken: "t", telegramChatId: "chat", pollIntervalMs: 500 },
      registry: registryWith("telegram", "tg-bot", "ses_tg"),
      deliverInboundReply: async (input) => { injected.push(input); return true },
      fetchImpl,
      sleep: immediateSleep,
      log: () => {},
      statusDocument,
      now: () => at,
      storage,
    })
  }

  test("#given a Telegram position older than the resume window #when the poller starts #then it re-reads from zero and says so once", async () => {
    const storage = storedTelegram({ cursor: 7, updatedAt: new Date(NOW - 30 * DAY).toISOString() })
    const status = statusRecorder()
    const fetchImpl = telegramPort(() => [])
    const inbound = resumeInbound({ storage, fetchImpl, statusDocument: status })

    await inbound.start()
    await waitFor(() => fetchImpl.pollCalls().length >= 1, "telegram poll")
    await inbound.stop()

    // An offset of 8 against an id space Telegram has rebuilt filters every new
    // update out; zero accepts the pending set the platform still holds.
    expect(fetchImpl.pollCalls()[0]).toContain("getUpdates?offset=0&timeout=0")
    expect(status.events.filter((event) => event.errorClass === "cursor-expired")).toHaveLength(1)
    // Retired once, and the document says "no resume point" instead of repeating it.
    expect(cursorDocument(storage, "telegram", "chat")).toMatchObject({ cursor: null })
    expect(inbound.status().telegramLastUpdateId).toBeNull()
  })

  test("#given a Telegram position inside the resume window #when the poller starts #then it resumes after it", async () => {
    const storage = storedTelegram({ cursor: 7, updatedAt: new Date(NOW - 60 * 60 * 1000).toISOString() })
    const status = statusRecorder()
    const fetchImpl = telegramPort(() => [])
    const inbound = resumeInbound({ storage, fetchImpl, statusDocument: status })

    await inbound.start()
    await waitFor(() => fetchImpl.pollCalls().length >= 1, "telegram poll")
    await inbound.stop()

    expect(fetchImpl.pollCalls()[0]).toContain("getUpdates?offset=8&timeout=0")
    expect(status.events.filter((event) => event.errorClass === "cursor-expired")).toHaveLength(0)
  })

  test("#given a Discord frontier as old as the Telegram one #when the poller starts #then it is not retired", async () => {
    const storage = memoryStorage()
    storage.map.set(openclawCursorKey("discord", "chan"), {
      v: OPENCLAW_CURSOR_VERSION,
      platform: "discord",
      channel: "chan",
      cursor: "m2",
      delivered: [],
      acked: [],
      updatedAt: new Date(NOW - 30 * DAY).toISOString(),
    })
    const fetchImpl = discordPort({ messages: [] })
    const { inbound } = discordListener({ storage, fetchImpl, now: () => NOW })

    await inbound.start()
    await waitFor(() => fetchImpl.pollCalls().length >= 1, "discord poll")
    await inbound.stop()

    // A snowflake only grows, so an old `after=` value can never skip a newer
    // message: retiring it would re-read a window for nothing.
    expect(fetchImpl.pollCalls()[0].url).toContain("?after=m2&limit=10")
    expect(cursorDocument(storage, "discord", "chan")).toMatchObject({ cursor: "m2" })
  })

  test("#given a retired position and a window the platform re-serves #when it is processed #then nothing is injected twice and the frontier recovers", async () => {
    const storage = storedTelegram({
      cursor: 7,
      updatedAt: new Date(NOW - 30 * DAY).toISOString(),
      acked: ["10"],
    })
    const injected = []
    const update = {
      update_id: 7,
      message: { message_id: 10, chat: { id: "chat" }, from: { id: "u1" }, text: "already answered", reply_to_message: { message_id: "tg-bot" } },
    }
    const fetchImpl = telegramPort(() => [update])
    const inbound = resumeInbound({ storage, fetchImpl, delivered: injected })

    await inbound.start()
    await waitFor(() => inbound.status().telegramLastUpdateId === 7, "frontier recovered")
    await inbound.stop()

    // The duplicate memory is what makes the re-read safe: the id is already acked,
    // so it moves the frontier without a second injection and without a second ack.
    expect(injected).toEqual([])
    expect(fetchImpl.pollCalls().length).toBeGreaterThanOrEqual(1)
    expect(cursorDocument(storage, "telegram", "chat")).toMatchObject({ cursor: 7, acked: ["10"] })
  })
})

describe("openclaw inbound: a reply with nothing to inject is terminal, not a refusal", () => {
  test("#given an attachment with no text #when the window is processed #then it spends no budget, does not halt, and the reply behind it is injected", async () => {
    const storage = memoryStorage()
    const status = statusRecorder()
    // Newest first: m3 carries the text, m2 is the attachment-only reply, so the
    // poller meets the empty one first.
    const fetchImpl = discordPort({
      messages: [discordMessage({ id: "m3", content: "hello" }), discordMessage({ id: "m2", content: "" })],
      pollLimit: 1,
    })
    const { inbound, delivered } = discordListener({
      storage,
      fetchImpl,
      statusDocument: status,
      replyListener: { includePrefix: false, rateLimitPerMinute: 1 },
    })

    await inbound.start()
    await waitFor(() => delivered.length >= 1, "reply behind the empty head")
    await inbound.stop()

    // One token for one reply: the empty message neither spent one nor halted the
    // window, and it is terminal so it cannot come back on the next poll.
    expect(delivered.map((input) => input.text)).toEqual(["hello"])
    expect(status.events.filter((event) => event.kind === "rate-limit")).toHaveLength(0)
    expect(status.events.filter((event) => event.errorClass === "delivery-refused")).toHaveLength(0)
    expect(inbound.status().errors).toBe(0)
    expect(cursorDocument(storage, "discord", "chan")).toMatchObject({ cursor: "m3" })
  })

  test("#given an empty reply at the head #when the next window is polled #then the cursor has moved past it instead of re-reading it", async () => {
    const storage = memoryStorage()
    const fetchImpl = discordPort({ messages: [discordMessage({ content: "" })], pollLimit: 1 })
    const { inbound } = discordListener({ storage, fetchImpl, replyListener: { includePrefix: false } })

    await inbound.start()
    await waitFor(() => fetchImpl.pollCalls().length >= 2, "second poll")
    await inbound.stop()

    expect(fetchImpl.pollCalls()[1].url).toContain("?after=m2&limit=10")
  })

  test("#given a Telegram reply whose text is only whitespace #when the prefix is off #then it is skipped without spending the budget", async () => {
    const storage = memoryStorage()
    const status = statusRecorder()
    const injected = []
    const updates = [
      { update_id: 7, message: { message_id: 10, chat: { id: "chat" }, from: { id: "u1" }, text: "   ", reply_to_message: { message_id: "tg-bot" } } },
      { update_id: 8, message: { message_id: 11, chat: { id: "chat" }, from: { id: "u1" }, text: "hello", reply_to_message: { message_id: "tg-bot" } } },
    ]
    let polls = 0
    const calls = []
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, init })
      if (url.includes("getUpdates")) {
        polls += 1
        return response({ ok: true, result: polls > 1 ? [] : updates })
      }
      return response({ ok: true, result: {} })
    }
    const inbound = createOpenclawInbound({
      replyListener: { telegramBotToken: "t", telegramChatId: "chat", pollIntervalMs: 500, includePrefix: false, rateLimitPerMinute: 1 },
      registry: registryWith("telegram", "tg-bot", "ses_tg"),
      deliverInboundReply: async (input) => { injected.push(input.text); return true },
      fetchImpl,
      sleep: immediateSleep,
      log: () => {},
      statusDocument: status,
      storage,
    })

    await inbound.start()
    await waitFor(() => injected.length >= 1, "the reply behind the whitespace one")
    await inbound.stop()

    expect(injected).toEqual(["hello"])
    expect(status.events.filter((event) => event.kind === "rate-limit")).toHaveLength(0)
    expect(calls.filter((call) => call.url.includes("sendMessage"))).toHaveLength(1)
    expect(cursorDocument(storage, "telegram", "chat")).toMatchObject({ cursor: 8 })
  })

  test("#given an empty poll response #when the next window carries a valid reply #then nothing is skipped and the reply reaches the session", async () => {
    const storage = memoryStorage()
    // The first window is empty and the second one is not: an empty answer must be a
    // healthy no-op that leaves the frontier alone, not a halt and not an advance.
    let polls = 0
    const calls = []
    const sequenced = async (url, init = {}) => {
      calls.push({ url, init })
      if (url.includes("/reactions/")) return response({}, 200)
      polls += 1
      return response(polls === 1 ? [] : [discordMessage()])
    }
    const { inbound, delivered } = discordListener({ storage, fetchImpl: sequenced })

    await inbound.start()
    await waitFor(() => delivered.length >= 1, "reply after an empty window")
    await inbound.stop()

    expect(delivered).toHaveLength(1)
    expect(inbound.status().errors).toBe(0)
    // Both windows asked for the head of the channel: the empty one moved nothing.
    const pollUrls = calls.filter((call) => call.url.includes("/messages?")).map((call) => call.url)
    expect(pollUrls).toHaveLength(2)
    expect(pollUrls.every((url) => url.endsWith("/messages?limit=10"))).toBe(true)
  })
})
