import { describe, expect, test } from "bun:test"
import {
  ANTHROPIC_GA_1M_LIMIT,
  DEFAULT_ANTHROPIC_ACTUAL_LIMIT,
  INCIDENT_PENDING_TIMEOUT_MS,
  contextUsage,
  createNativeCompactionIncidentRegistry,
  createNativePreemptiveCompaction,
  isNoTextAssistantContent,
  readAssistantUsage,
  resolveNativeContextLimit,
  usageRatio,
} from "./rigel-v2-native-preemptive-compaction.mjs"

const LIMIT = 100_000

function usage(overrides = {}) {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, ...overrides }
}

/** A transcript reader that returns a fixed usage per call. */
function fixedReader(value) {
  return async () => value
}

function assistant(messageID, tokens, extra = {}) {
  return { messageID, tokens, providerID: "openai", modelID: "gpt-5", noText: false, ...extra }
}

describe("preemptive compaction", () => {
  describe("#given a token footprint and a context limit", () => {
    test("#then it matches the V1 input plus cache.read math", () => {
      expect(contextUsage(usage({ input: 100, output: 50, reasoning: 20, cache: { read: 300, write: 7 } }))).toEqual({
        input: 100,
        cacheRead: 300,
        total: 400,
      })
    })

    test("#then a missing limit yields a zero ratio and a real limit yields the fraction", () => {
      expect(usageRatio(usage({ input: 50 }), 0)).toBe(0)
      expect(usageRatio(usage({ input: 50_000, cache: { read: 28_000, write: 0 } }), 100_000)).toBeCloseTo(0.78, 6)
    })
  })

  describe("#given the V1 Anthropic context-limit rules", () => {
    test("#then the explicit 1M env override wins", () => {
      expect(resolveNativeContextLimit({ providerID: "anthropic", modelID: "claude-sonnet-5", modelContextLimit: 200_000, env: { ANTHROPIC_1M_CONTEXT: "true" } })).toBe(ANTHROPIC_GA_1M_LIMIT)
    })

    test("#then a GA-1M model reads the model row when present and falls back to 1M otherwise", () => {
      expect(resolveNativeContextLimit({ providerID: "anthropic", modelID: "claude-opus-4-8-high", modelContextLimit: 900_000 })).toBe(900_000)
      expect(resolveNativeContextLimit({ providerID: "anthropic", modelID: "claude-opus-4-8", modelContextLimit: undefined })).toBe(ANTHROPIC_GA_1M_LIMIT)
    })

    test("#then the catalog limit wins for every Anthropic model, including one the id regex does not know", () => {
      // The reported defect: `claude-sonnet-5-5` has a 1M window but the GA-1M
      // id regex does not match it, so the old precedence pinned it to the 200k
      // V1 default and the trigger asked for a compaction five times too early.
      expect(resolveNativeContextLimit({ providerID: "anthropic", modelID: "claude-sonnet-5-5", modelContextLimit: 1_000_000 })).toBe(1_000_000)
      expect(resolveNativeContextLimit({ providerID: "google-vertex-anthropic", modelID: "claude-sonnet-5-5", modelContextLimit: 1_000_000 })).toBe(1_000_000)
      expect(resolveNativeContextLimit({ providerID: "anthropic", modelID: "claude-sonnet-5", modelContextLimit: 1_000_000 })).toBe(1_000_000)
      expect(resolveNativeContextLimit({ providerID: "anthropic", modelID: "claude-haiku-4-5", modelContextLimit: 500_000 })).toBe(500_000)
      expect(resolveNativeContextLimit({ providerID: "google", modelID: "claude-sonnet-4-6", modelContextLimit: undefined })).toBe(ANTHROPIC_GA_1M_LIMIT)
    })

    test("#then a model row without a usable limit.context keeps the documented fallbacks", () => {
      expect(resolveNativeContextLimit({ providerID: "anthropic", modelID: "claude-sonnet-5-5", modelContextLimit: undefined })).toBe(DEFAULT_ANTHROPIC_ACTUAL_LIMIT)
      expect(resolveNativeContextLimit({ providerID: "anthropic", modelID: "claude-opus-4-8", modelContextLimit: 0 })).toBe(ANTHROPIC_GA_1M_LIMIT)
    })

    test("#then a non-Anthropic model uses the V2 model row and returns null when unknown", () => {
      expect(resolveNativeContextLimit({ providerID: "openai", modelID: "gpt-5", modelContextLimit: 400_000 })).toBe(400_000)
      expect(resolveNativeContextLimit({ providerID: "opencode-go", modelID: "deepseek-v4.1-flash", modelContextLimit: undefined })).toBeNull()
    })
  })

  describe("#given a V2 session transcript", () => {
    test("#then it reads the last non-compaction assistant message", () => {
      const transcript = [
        { id: "m1", type: "user", text: "hi" },
        { id: "m2", type: "assistant", model: { providerID: "openai", id: "gpt-5" }, tokens: usage({ input: 10 }) },
        { id: "m3", type: "assistant", agent: "compaction", tokens: usage({ input: 999_999 }) },
      ]
      expect(readAssistantUsage(transcript)).toMatchObject({ messageID: "m2", providerID: "openai", modelID: "gpt-5" })
    })

    test("#then it normalizes a { data } envelope and an absent transcript", () => {
      expect(readAssistantUsage({ data: [{ id: "m1", type: "assistant", tokens: usage({ input: 1 }) }] })?.messageID).toBe("m1")
      expect(readAssistantUsage(undefined)).toBeUndefined()
      expect(readAssistantUsage([{ id: "u", type: "user" }])).toBeUndefined()
    })

    test("#then V1 step-only tails and V2 reasoning-only tails are no-text, text and tool are not", () => {
      expect(isNoTextAssistantContent([{ type: "step-start" }, { type: "step-finish" }])).toBe(true)
      expect(isNoTextAssistantContent([{ type: "reasoning", text: "thinking" }])).toBe(true)
      expect(isNoTextAssistantContent([{ type: "text", text: "answer" }])).toBe(false)
      expect(isNoTextAssistantContent([{ type: "tool", name: "read" }])).toBe(false)
      expect(isNoTextAssistantContent([])).toBe(false)
    })
  })

  describe("#given a shared incident registry", () => {
    test("#then two parties cannot hold one incident and a stuck mark self-heals", () => {
      let clock = 0
      const registry = createNativeCompactionIncidentRegistry({ now: () => clock, pendingTimeoutMs: 1_000 })
      expect(registry.begin("ses_1")).toBe(true)
      expect(registry.begin("ses_1")).toBe(false)
      expect(registry.has("ses_1")).toBe(true)
      clock = 1_500
      expect(registry.begin("ses_1")).toBe(true)
      registry.end("ses_1")
      expect(registry.has("ses_1")).toBe(false)
    })
  })

  describe("#given a preemptive controller at the threshold", () => {
    test("#then a footprint below the threshold never compacts", async () => {
      const compacted = []
      const controller = createNativePreemptiveCompaction({
        readUsage: fixedReader(assistant("m1", usage({ input: 50_000, cache: { read: 20_000, write: 0 } }))),
        resolveContextLimit: () => LIMIT,
        requestCompact: async (input) => { compacted.push(input) },
      })
      const result = await controller.observe({ sessionID: "ses_1" })
      expect(result).toMatchObject({ decision: "skip", reason: "below-threshold" })
      expect(compacted).toEqual([])
    })

    test("#then a 500k footprint on a 1M catalog window does not compact early", async () => {
      // The reported defect end to end: `claude-sonnet-5-5` used to resolve to
      // the 200k V1 default even though its catalog row says 1M, so this exact
      // footprint (ratio 0.5 on the real window, 2.5 on the wrong one) compacted
      // on the first observed turn.
      const compacted = []
      const controller = createNativePreemptiveCompaction({
        readUsage: fixedReader(assistant("m1", usage({ input: 450_000, cache: { read: 50_000, write: 0 } }), {
          providerID: "anthropic",
          modelID: "claude-sonnet-5-5",
        })),
        resolveContextLimit: ({ providerID, modelID }) => resolveNativeContextLimit({
          providerID,
          modelID,
          modelContextLimit: 1_000_000,
        }),
        requestCompact: async (input) => { compacted.push(input) },
      })
      const result = await controller.observe({ sessionID: "ses_1" })
      expect(result).toMatchObject({ decision: "skip", reason: "below-threshold", limit: 1_000_000 })
      expect(compacted).toEqual([])
    })

    test("#then a footprint at or above the threshold compacts exactly once", async () => {
      const compacted = []
      const controller = createNativePreemptiveCompaction({
        readUsage: fixedReader(assistant("m1", usage({ input: 50_000, cache: { read: 28_000, write: 0 } }))),
        resolveContextLimit: () => LIMIT,
        requestCompact: async (input) => { compacted.push(input) },
      })
      const first = await controller.observe({ sessionID: "ses_1" })
      expect(first).toMatchObject({ decision: "compact" })
      const second = await controller.observe({ sessionID: "ses_1" })
      expect(second).toMatchObject({ decision: "skip", reason: "already-pending" })
      expect(compacted).toEqual([{ sessionID: "ses_1" }])
    })

    test("#then an unknown context limit is a verifiable no-op", async () => {
      const compacted = []
      const controller = createNativePreemptiveCompaction({
        readUsage: fixedReader(assistant("m1", usage({ input: 999_999 }))),
        resolveContextLimit: () => null,
        requestCompact: async (input) => { compacted.push(input) },
      })
      expect(await controller.observe({ sessionID: "ses_1" })).toMatchObject({ decision: "skip", reason: "unknown-limit" })
      expect(compacted).toEqual([])
    })

    test("#then a request failure releases the incident but V1 cooldown still gates the retry", async () => {
      let clock = 0
      let fail = true
      const attempts = []
      const controller = createNativePreemptiveCompaction({
        now: () => clock,
        cooldownMs: 1_000,
        readUsage: fixedReader(assistant("m1", usage({ input: 90_000 }))),
        resolveContextLimit: () => LIMIT,
        requestCompact: async (input) => {
          attempts.push(input)
          if (fail) throw new Error("compact rejected")
        },
      })
      expect(await controller.observe({ sessionID: "ses_1" })).toMatchObject({ decision: "error" })
      expect(controller.getState("ses_1").pending).toBe(false)
      fail = false
      // V1 sets the cooldown before the summarize, so a failed compaction still
      // holds the cooldown and the retry only happens after the window.
      expect(await controller.observe({ sessionID: "ses_1" })).toMatchObject({ decision: "skip", reason: "cooldown" })
      clock = 1_001
      expect(await controller.observe({ sessionID: "ses_1" })).toMatchObject({ decision: "compact" })
      expect(attempts).toHaveLength(2)
    })
  })

  describe("#given cooldown and re-arm", () => {
    test("#then a new assistant turn re-arms after a self-healed incident even without a compaction event", async () => {
      let clock = 0
      let current = assistant("m1", usage({ input: 90_000 }))
      const compacted = []
      const incident = createNativeCompactionIncidentRegistry({ now: () => clock, pendingTimeoutMs: 500 })
      const controller = createNativePreemptiveCompaction({
        now: () => clock,
        cooldownMs: 1_000,
        readUsage: async () => current,
        resolveContextLimit: () => LIMIT,
        requestCompact: async (input) => { compacted.push(input) },
        incident,
      })
      await controller.observe({ sessionID: "ses_1" })
      expect(compacted).toHaveLength(1)
      // No `onCompacted` fired (event lost); the incident self-heals after its
      // window and a fresh assistant turn must re-arm the trigger.
      clock = 1_001
      current = assistant("m2", usage({ input: 90_000 }))
      expect(await controller.observe({ sessionID: "ses_1" })).toMatchObject({ decision: "compact" })
      expect(compacted).toHaveLength(2)
    })

    test("#then a second crossing inside the cooldown is skipped and allowed after it", async () => {
      let clock = 0
      let current = assistant("m1", usage({ input: 90_000 }))
      const compacted = []
      const controller = createNativePreemptiveCompaction({
        now: () => clock,
        cooldownMs: 1_000,
        readUsage: async () => current,
        resolveContextLimit: () => LIMIT,
        requestCompact: async (input) => { compacted.push(input) },
      })
      await controller.observe({ sessionID: "ses_1" })
      controller.onCompacted("ses_1")
      // A new assistant turn re-arms, but the cooldown still holds.
      current = assistant("m2", usage({ input: 90_000 }))
      expect(await controller.observe({ sessionID: "ses_1" })).toMatchObject({ decision: "skip", reason: "cooldown" })
      clock = 1_001
      expect(await controller.observe({ sessionID: "ses_1" })).toMatchObject({ decision: "compact" })
      expect(compacted).toHaveLength(2)
    })
  })

  describe("#given the shared incident with the reactive recovery", () => {
    test("#then an already-pending incident blocks the preemptive trigger", async () => {
      const incident = createNativeCompactionIncidentRegistry()
      incident.begin("ses_1")
      const compacted = []
      const controller = createNativePreemptiveCompaction({
        readUsage: fixedReader(assistant("m1", usage({ input: 90_000 }))),
        resolveContextLimit: () => LIMIT,
        requestCompact: async (input) => { compacted.push(input) },
        incident,
      })
      expect(await controller.observe({ sessionID: "ses_1" })).toMatchObject({ decision: "skip", reason: "already-pending" })
      expect(compacted).toEqual([])
    })
  })

  describe("#given the post-compaction degradation monitor", () => {
    test("#then a streak of no-text tails requests a bounded recovery compaction", async () => {
      let current = assistant("m0", usage({ input: 90_000 }))
      const compacted = []
      const controller = createNativePreemptiveCompaction({
        now: () => 1_000,
        readUsage: async () => current,
        resolveContextLimit: () => LIMIT,
        requestCompact: async (input) => { compacted.push(input) },
      })
      await controller.observe({ sessionID: "ses_1" })
      controller.onCompacted("ses_1")
      current = assistant("m1", usage({ input: 1 }), { noText: true })
      await controller.observe({ sessionID: "ses_1" })
      current = assistant("m2", usage({ input: 1 }), { noText: true })
      await controller.observe({ sessionID: "ses_1" })
      expect(compacted).toHaveLength(1)
      current = assistant("m3", usage({ input: 1 }), { noText: true })
      expect(await controller.observe({ sessionID: "ses_1" })).toMatchObject({ decision: "recovery" })
      expect(compacted).toHaveLength(2)
    })

    test("#then duplicate compaction event names for one compaction arm the monitor once", async () => {
      let clock = 1_000
      let current = assistant("m0", usage({ input: 90_000 }))
      const compacted = []
      const controller = createNativePreemptiveCompaction({
        now: () => clock,
        readUsage: async () => current,
        resolveContextLimit: () => LIMIT,
        requestCompact: async (input) => { compacted.push(input) },
      })
      await controller.observe({ sessionID: "ses_1" })
      controller.onCompacted("ses_1")
      // The V2 stream may repeat the compaction under a second event name.
      controller.onCompacted("ses_1")
      expect(controller.getState("ses_1").postCompactionEpoch).toBe(1)
      for (const id of ["m1", "m2", "m3"]) {
        current = assistant(id, usage({ input: 1 }), { noText: true })
        await controller.observe({ sessionID: "ses_1" })
      }
      expect(compacted).toHaveLength(2)
    })

    test("#then a spent epoch does not re-fire and the session cap bounds recovery", async () => {
      let clock = 1_000
      let current = assistant("m0", usage({ input: 90_000 }))
      const compacted = []
      const controller = createNativePreemptiveCompaction({
        now: () => clock,
        readUsage: async () => current,
        resolveContextLimit: () => LIMIT,
        requestCompact: async (input) => { compacted.push(input) },
        maxRecoveryAttempts: 1,
      })
      await controller.observe({ sessionID: "ses_1" })
      controller.onCompacted("ses_1")
      for (const id of ["m1", "m2", "m3"]) {
        current = assistant(id, usage({ input: 1 }), { noText: true })
        await controller.observe({ sessionID: "ses_1" })
      }
      expect(compacted).toHaveLength(2)
      expect(controller.getState("ses_1").postCompactionRecoveryCount).toBe(1)
      // The epoch's monitor is spent; extra no-text tails do not re-fire.
      for (const id of ["m4", "m5", "m6"]) {
        current = assistant(id, usage({ input: 1 }), { noText: true })
        await controller.observe({ sessionID: "ses_1" })
      }
      expect(compacted).toHaveLength(2)
      // A new epoch past the suppression window still honors the session cap.
      clock = 30_000
      controller.onCompacted("ses_1")
      for (const id of ["n1", "n2", "n3"]) {
        current = assistant(id, usage({ input: 1 }), { noText: true })
        await controller.observe({ sessionID: "ses_1" })
      }
      expect(compacted).toHaveLength(2)
      expect(controller.getState("ses_1").postCompactionRecoveryCount).toBe(1)
    })
  })

  describe("#given session lifecycle", () => {
    test("#then cleanup drops every per-session mark and leaves siblings intact", async () => {
      const compacted = []
      const controller = createNativePreemptiveCompaction({
        readUsage: async (sessionID) => assistant(`m_${sessionID}`, usage({ input: 90_000 })),
        resolveContextLimit: () => LIMIT,
        requestCompact: async (input) => { compacted.push(input) },
      })
      await controller.observe({ sessionID: "ses_a" })
      await controller.observe({ sessionID: "ses_b" })
      expect(compacted).toHaveLength(2)
      controller.clear("ses_a")
      expect(controller.getState("ses_a").pending).toBe(false)
      expect(controller.getState("ses_a").compacted).toBe(false)
      expect(controller.getState("ses_b").compacted).toBe(true)
      controller.clearAll()
      expect(controller.getState("ses_b").compacted).toBe(false)
    })

    test("#then a decision sink receives only a real trigger", async () => {
      const events = []
      const controller = createNativePreemptiveCompaction({
        readUsage: async (sessionID) => (sessionID === "ses_1" ? assistant("m1", usage({ input: 90_000 })) : assistant("m2", usage({ input: 1 }))),
        resolveContextLimit: () => LIMIT,
        requestCompact: async () => {},
        onDecision: (entry) => { events.push(entry) },
      })
      await controller.observe({ sessionID: "ses_2" })
      await controller.observe({ sessionID: "ses_1" })
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ kind: "preemptive", sessionID: "ses_1" })
    })
  })

  test("#then the pending timeout constant is a positive window", () => {
    expect(INCIDENT_PENDING_TIMEOUT_MS).toBeGreaterThan(0)
  })
})
