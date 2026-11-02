import { describe, expect, test } from "bun:test"
import {
  OPENCLAW_STATUS_KEY,
  OPENCLAW_STATUS_STATES,
  createOpenclawStatusDocument,
} from "./rigel-v2-native-openclaw-agent-status.mjs"

function memoryStorage() {
  const map = new Map()
  return {
    map,
    get: async (key) => map.get(key),
    set: async (key, value) => { map.set(key, value) },
    remove: async (key) => { map.delete(key) },
  }
}

const at = (iso) => () => Date.parse(iso)

describe("openclaw status document shape", () => {
  test("#given a fresh document #when read #then it holds no surfaces and the pinned storage key", () => {
    const document = createOpenclawStatusDocument({ now: at("2026-01-01T00:00:00.000Z") })
    expect(OPENCLAW_STATUS_KEY).toBe("rigel-v2/openclaw/status")
    expect(OPENCLAW_STATUS_STATES).toEqual(["up", "degraded", "fatal"])
    expect(document.snapshot()).toEqual({ surfaces: {}, updatedAt: "2026-01-01T00:00:00.000Z" })
  })

  test("#given a recorded failure #when read #then the surface carries exactly the contract fields", async () => {
    const document = createOpenclawStatusDocument({ now: at("2026-01-01T00:00:00.000Z") })
    await document.recordFailure("agent-queue", { errorClass: "queue-full" })
    expect(document.snapshot().surfaces["agent-queue"]).toEqual({
      state: "degraded",
      errorClass: "queue-full",
      consecutiveFailures: 1,
      lastErrorAt: "2026-01-01T00:00:00.000Z",
      truncations: 0,
      rateLimited: 0,
    })
  })

  test("#given a reported document #when the reader mutates the snapshot #then the document is untouched", async () => {
    const document = createOpenclawStatusDocument({ now: at("2026-01-01T00:00:00.000Z") })
    await document.recordFailure("agent-queue", { errorClass: "queue-full" })
    const snapshot = document.snapshot()
    snapshot.surfaces["agent-queue"].state = "up"
    snapshot.surfaces.injected = { state: "fatal" }
    expect(document.snapshot().surfaces["agent-queue"].state).toBe("degraded")
    expect(document.snapshot().surfaces.injected).toBeUndefined()
  })
})

describe("openclaw status reporting channels", () => {
  test("#given a fatal failure #when recorded #then it takes the startup banner channel", async () => {
    const lines = []
    const document = createOpenclawStatusDocument({ now: at("2026-01-01T00:00:00.000Z"), log: (line) => lines.push(line) })
    await document.recordFailure("a2a", { errorClass: "unresolvable-token", fatal: true })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("surface disabled: a2a")
    expect(lines[0]).toContain("unresolvable-token")
    expect(document.snapshot().surfaces.a2a.state).toBe("fatal")
  })

  test("#given the same failure repeated #when recorded #then only one line is emitted", async () => {
    const lines = []
    const document = createOpenclawStatusDocument({ now: at("2026-01-01T00:00:00.000Z"), log: (line) => lines.push(line) })
    await document.recordFailure("a2a", { errorClass: "http-500" })
    await document.recordFailure("a2a", { errorClass: "http-500" })
    await document.recordFailure("a2a", { errorClass: "http-500" })
    expect(lines).toHaveLength(1)
    expect(document.snapshot().surfaces.a2a.consecutiveFailures).toBe(3)
  })

  test("#given a degraded surface that recovers #when success is recorded #then one recovery line is emitted", async () => {
    const lines = []
    const document = createOpenclawStatusDocument({ now: at("2026-01-01T00:00:00.000Z"), log: (line) => lines.push(line) })
    await document.recordFailure("a2a", { errorClass: "http-500" })
    await document.recordSuccess("a2a")
    await document.recordSuccess("a2a")
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain("surface recovered: a2a")
    expect(document.snapshot().surfaces.a2a).toMatchObject({ state: "up", errorClass: null, consecutiveFailures: 0 })
  })

  test("#given a recovery followed by the same failure #when recorded #then the dedup does not swallow it", async () => {
    const lines = []
    const document = createOpenclawStatusDocument({ now: at("2026-01-01T00:00:00.000Z"), log: (line) => lines.push(line) })
    await document.recordFailure("a2a", { errorClass: "http-500" })
    await document.recordSuccess("a2a")
    await document.recordFailure("a2a", { errorClass: "http-500" })
    expect(lines).toHaveLength(3)
    expect(lines[2]).toContain("surface degraded: a2a")
  })

  test("#given truncations and rate limits #when recorded #then only aggregate counters move and no line is emitted", async () => {
    const lines = []
    const document = createOpenclawStatusDocument({ now: at("2026-01-01T00:00:00.000Z"), log: (line) => lines.push(line) })
    await document.recordTruncation("agent-queue")
    await document.recordTruncation("agent-queue", 4)
    await document.recordRateLimit("agent-queue")
    await document.recordRateLimit("agent-queue", 2)
    expect(lines).toEqual([])
    expect(document.snapshot().surfaces["agent-queue"]).toMatchObject({ state: "up", truncations: 5, rateLimited: 3, consecutiveFailures: 0 })
  })
})

describe("openclaw status document durability", () => {
  test("#given a written document #when a fresh one hydrates #then the surfaces resolve", async () => {
    const storage = memoryStorage()
    const writer = createOpenclawStatusDocument({ storage, now: at("2026-01-01T00:00:00.000Z") })
    await writer.recordFailure("a2a", { errorClass: "http-500", fatal: true })
    expect([...storage.map.keys()]).toEqual([OPENCLAW_STATUS_KEY])
    const reader = createOpenclawStatusDocument({ storage, now: at("2026-01-01T00:00:01.000Z") })
    await reader.hydrate()
    expect(reader.snapshot().surfaces.a2a).toMatchObject({ state: "fatal", errorClass: "http-500", consecutiveFailures: 1 })
  })

  test("#given an unusable persisted document #when hydrating #then it is reported and never trusted", async () => {
    const storage = memoryStorage()
    await storage.set(OPENCLAW_STATUS_KEY, { surfaces: { a2a: { state: "exploded" } } })
    const lines = []
    const document = createOpenclawStatusDocument({ storage, log: (line) => lines.push(line) })
    await document.hydrate()
    expect(document.snapshot().surfaces).toEqual({})
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("skipped surface a2a")
  })

  test("#given a document with no storage #when recording #then it still works in process", async () => {
    const document = createOpenclawStatusDocument({ log: () => {} })
    await document.recordFailure("a2a", { errorClass: "http-500" })
    await document.hydrate()
    expect(document.snapshot().surfaces.a2a.state).toBe("degraded")
  })
})

// U4 additions. The document is now shared by the legacy surfaces (outbound,
// discord, telegram, injection, config, credentials) and by the agent namespace,
// so three properties became contract:
//
//   - a write hydrates first, once, or a fresh failure would erase the surfaces
//     another owner had already written to the same key;
//   - a success on an `up` surface records nothing, which is what keeps the
//     healthy legacy call sequence at zero status writes;
//   - a fatal whose owner already announced itself at setup is recorded WITHOUT a
//     second line, because one transition must produce one line.

function storageSpy() {
  const map = new Map()
  const ops = []
  return {
    map,
    ops,
    get: async (key) => { ops.push({ op: "get", key }); return map.get(key) },
    set: async (key, value) => { ops.push({ op: "set", key }); map.set(key, value) },
    remove: async (key) => { ops.push({ op: "remove", key }); map.delete(key) },
  }
}

describe("openclaw status document sharing (U4)", () => {
  test("#given another owner already persisted surfaces #when a failure is recorded without an explicit hydrate #then those surfaces survive", async () => {
    // given
    const storage = storageSpy()
    const previous = createOpenclawStatusDocument({ storage, now: at("2026-01-01T00:00:00.000Z") })
    await previous.recordFailure("telegram", { errorClass: "http-500" })

    // when
    const shared = createOpenclawStatusDocument({ storage, now: at("2026-01-01T00:00:05.000Z") })
    await shared.recordFailure("outbound", { errorClass: "http-503" })

    // then
    const persisted = storage.map.get(OPENCLAW_STATUS_KEY)
    expect(Object.keys(persisted.surfaces).sort()).toEqual(["outbound", "telegram"])
    expect(persisted.surfaces.telegram).toMatchObject({ state: "degraded", errorClass: "http-500" })
  })

  test("#given an already up surface #when success is recorded #then neither a read nor a write happens", async () => {
    // given
    const storage = storageSpy()
    const document = createOpenclawStatusDocument({ storage })
    await document.recordFailure("outbound", { errorClass: "http-500" })
    await document.recordSuccess("outbound")
    storage.ops.length = 0

    // when
    const changed = await document.recordSuccess("outbound")

    // then
    expect(changed).toBe(false)
    expect(storage.ops).toEqual([])
  })

  test("#given a surface this process never recorded #when success is recorded #then the document is not touched", async () => {
    // given
    const storage = storageSpy()
    const document = createOpenclawStatusDocument({ storage })

    // when
    const changed = await document.recordSuccess("outbound")

    // then
    expect(changed).toBe(false)
    expect(storage.ops).toEqual([])
    expect(document.snapshot().surfaces).toEqual({})
  })

  test("#given a fatal its owner already announced #when recorded without a line #then the state is stored and no second line is written", async () => {
    // given
    const lines = []
    const document = createOpenclawStatusDocument({ log: (line) => lines.push(line), now: at("2026-01-01T00:00:00.000Z") })

    // when
    await document.recordFailure("credentials.discord", {
      errorClass: "missing-env-variable",
      fatal: true,
      emitLine: false,
      detail: "openclaw.replyListener.discordBotToken",
    })

    // then
    expect(lines).toEqual([])
    expect(document.snapshot().surfaces["credentials.discord"]).toMatchObject({
      state: "fatal",
      errorClass: "missing-env-variable",
      consecutiveFailures: 1,
    })
  })

  test("#given a document #when hydrate runs twice #then the persisted read happens once", async () => {
    // given
    const storage = storageSpy()
    const document = createOpenclawStatusDocument({ storage })

    // when
    await document.hydrate()
    await document.hydrate()

    // then
    expect(storage.ops.filter((op) => op.op === "get")).toHaveLength(1)
  })
})
