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
