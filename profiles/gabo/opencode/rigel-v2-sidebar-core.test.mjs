/**
 * Behavioural tests for the pure V2 sidebar core.
 *
 * Each case guards an invariant the runtime adapter depends on: the snapshot
 * contract (version + fields), the deriver ordering and caps, the freshness
 * windows, activeGoal redaction, and viewKey stability. No TUI, no file system.
 */

import { describe, expect, test } from "bun:test"
import {
  AGENT_STATUS_VALUES,
  BACKGROUND_TASK_STATUS_VALUES,
  HEARTBEAT_MS,
  JOB_STATUS_PRIORITY,
  LABEL_MAX,
  LOOP_FRESH_MS,
  MAX_AGENTS,
  MAX_JOBS,
  MIRROR_SCHEMA_VERSION,
  POLL_INTERVAL_MS,
  STALE_MS,
  WRITE_DEBOUNCE_MS,
  activeGoalLabel,
  activeGoalTitle,
  buildRuntimeSnapshot,
  buildViewNodes,
  computeLoopLive,
  computeView,
  deriveAgents,
  deriveConfig,
  deriveJobBoard,
  deriveLoop,
  deriveRoster,
  describeView,
  formatModelLabel,
  isLoopFresh,
  isSnapshotFresh,
  parseLoopDocument,
  parseSnapshot,
  redactActiveGoal,
  toJobRow,
  toRosterRow,
  truncate,
  viewKey,
} from "./rigel-v2-sidebar-core.mjs"

function liveLoop(overrides = {}) {
  return {
    kind: "live",
    goalsDone: 0,
    goalsTotal: 1,
    pass: 0,
    fail: 0,
    pending: 0,
    blocked: 0,
    activeGoal: null,
    ...overrides,
  }
}

function snapshot(overrides = {}) {
  return {
    version: MIRROR_SCHEMA_VERSION,
    projectDir: "/tmp/proj",
    updatedAt: 1000,
    activeAgents: [],
    jobBoard: [],
    loop: null,
    ...overrides,
  }
}

function sections(overrides = {}) {
  return {
    config: { kind: "valid" },
    roster: { kind: "empty" },
    agents: { kind: "none" },
    jobs: { kind: "none" },
    loop: { kind: "none" },
    ...overrides,
  }
}

function agent(name, status) {
  return { name, status }
}

function job(title, status, toolCalls = null, lastTool = null) {
  return { title, status, toolCalls, lastTool }
}

describe("constants", () => {
  test("#then the V1 caps and windows are ported byte-for-byte", () => {
    expect(MIRROR_SCHEMA_VERSION).toBe(1)
    expect(STALE_MS).toBe(6_000)
    expect(LOOP_FRESH_MS).toBe(120_000)
    expect(POLL_INTERVAL_MS).toBe(1_000)
    expect(HEARTBEAT_MS).toBe(2_000)
    expect(WRITE_DEBOUNCE_MS).toBe(250)
    expect(MAX_AGENTS).toBe(12)
    expect(MAX_JOBS).toBe(12)
    expect(LABEL_MAX).toBe(24)
  })

  test("#then the status vocabularies and job priority match V1", () => {
    expect([...AGENT_STATUS_VALUES]).toEqual(["busy", "idle", "error", "running", "retry"])
    expect([...BACKGROUND_TASK_STATUS_VALUES]).toEqual([
      "pending",
      "running",
      "completed",
      "error",
      "cancelled",
      "interrupt",
    ])
    expect(JOB_STATUS_PRIORITY.running).toBeLessThan(JOB_STATUS_PRIORITY.pending)
    expect(JOB_STATUS_PRIORITY.pending).toBeLessThan(JOB_STATUS_PRIORITY.completed)
  })
})

describe("#given an arbitrary snapshot-like value", () => {
  describe("#when it matches the V1 contract", () => {
    test("#then parseSnapshot returns the normalized snapshot", () => {
      const parsed = parseSnapshot(
        snapshot({
          activeAgents: [agent("atlas", "running")],
          jobBoard: [job("build", "running", 3, "bash")],
          loop: liveLoop({ pass: 2, activeGoal: "secret-title" }),
        }),
      )

      expect(parsed).not.toBeNull()
      expect(parsed.version).toBe(1)
      expect(parsed.activeAgents).toEqual([{ name: "atlas", status: "running" }])
      expect(parsed.jobBoard[0]).toEqual({ title: "build", status: "running", toolCalls: 3, lastTool: "bash" })
      expect(parsed.loop.activeGoal).toBe("secret-title")
    })
  })

  describe("#when it violates the contract", () => {
    test("#then wrong version, missing fields, and bad enums collapse to null", () => {
      expect(parseSnapshot(null)).toBeNull()
      expect(parseSnapshot("nope")).toBeNull()
      expect(parseSnapshot(snapshot({ version: 2 }))).toBeNull()
      expect(parseSnapshot(snapshot({ projectDir: 7 }))).toBeNull()
      expect(parseSnapshot(snapshot({ updatedAt: "now" }))).toBeNull()
      expect(parseSnapshot(snapshot({ activeAgents: [{ name: "atlas", status: "sleeping" }] }))).toBeNull()
      expect(parseSnapshot(snapshot({ activeAgents: [{ status: "running" }] }))).toBeNull()
      expect(parseSnapshot(snapshot({ jobBoard: [job("x", "weird")] }))).toBeNull()
      expect(parseSnapshot(snapshot({ jobBoard: [{ title: "x", status: "running", toolCalls: 1.5, lastTool: null }] }))).toBeNull()
    })

    test("#then a malformed loop is rejected but null and live are accepted", () => {
      expect(parseSnapshot(snapshot({ loop: null }))).not.toBeNull()
      expect(parseSnapshot(snapshot({ loop: liveLoop() }))).not.toBeNull()
      expect(parseSnapshot(snapshot({ loop: { kind: "live" } }))).toBeNull()
      expect(parseSnapshot(snapshot({ loop: liveLoop({ pass: -1 }) }))).toBeNull()
      expect(parseSnapshot(snapshot({ loop: liveLoop({ activeGoal: 5 }) }))).toBeNull()
    })
  })
})

describe("#given a snapshot", () => {
  describe("#when deriving the config section", () => {
    test("#then invalid copies the messages and valid carries none", () => {
      expect(deriveConfig({ valid: true, messages: [] })).toEqual({ kind: "valid" })
      const invalid = deriveConfig({ valid: false, messages: ["bad key"] })
      expect(invalid).toEqual({ kind: "invalid", messages: ["bad key"] })
      expect(invalid.messages).not.toBe(undefined)
    })
  })

  describe("#when deriving the roster", () => {
    test("#then rows sort by label and an empty roster collapses", () => {
      expect(deriveRoster([])).toEqual({ kind: "empty" })
      const rows = [toRosterRow({ label: "zeta", model: "openai/gpt" }), toRosterRow({ label: "alpha", model: "x/y" })]
      const derived = deriveRoster(rows)
      expect(derived.kind).toBe("rows")
      expect(derived.rows.map((row) => row.label)).toEqual(["alpha", "zeta"])
    })

    test("#then the roster is capped at MAX_AGENTS", () => {
      const rows = Array.from({ length: MAX_AGENTS + 3 }, (_, index) => ({
        label: `l${String(index).padStart(2, "0")}`,
        model: "m",
      }))
      const derived = deriveRoster(rows)
      expect(derived.rows).toHaveLength(MAX_AGENTS)
      expect(derived.rows[0].label).toBe("l00")
    })
  })

  describe("#when deriving active agents", () => {
    test("#then an empty or missing list collapses and names sort ascending", () => {
      expect(deriveAgents(null)).toEqual({ kind: "none" })
      expect(deriveAgents(snapshot({ activeAgents: [] }))).toEqual({ kind: "none" })
      const derived = deriveAgents(snapshot({ activeAgents: [agent("zeta", "busy"), agent("alpha", "retry")] }))
      expect(derived.agents.map((row) => row.name)).toEqual(["alpha", "zeta"])
    })

    test("#then the agent list is capped at MAX_AGENTS", () => {
      const activeAgents = Array.from({ length: MAX_AGENTS + 4 }, (_, index) =>
        agent(`a${String(index).padStart(2, "0")}`, "running"),
      )
      expect(deriveAgents(snapshot({ activeAgents })).agents).toHaveLength(MAX_AGENTS)
    })
  })

  describe("#when deriving the job board", () => {
    test("#then jobs order by status priority and title, capped at MAX_JOBS", () => {
      const running = [job("r2", "running"), job("r1", "running"), job("r3", "running")]
      const rest = Array.from({ length: MAX_JOBS + 4 }, (_, index) => job(`c${String(index).padStart(2, "0")}`, "completed"))
      const derived = deriveJobBoard(snapshot({ jobBoard: [...rest, job("p", "pending"), ...running] }))

      expect(derived.jobs).toHaveLength(MAX_JOBS)
      expect(derived.jobs.slice(0, 3).map((row) => row.title)).toEqual(["r1", "r2", "r3"])
      expect(derived.jobs[3].status).toBe("pending")
      expect(derived.jobs).not.toContain(rest[rest.length - 1])
    })

    test("#then the full priority ladder is respected", () => {
      const order = ["running", "pending", "interrupt", "error", "cancelled", "completed"]
      const jobs = order.map((status, index) => job(`j${index}`, status))
      const derived = deriveJobBoard(snapshot({ jobBoard: [...jobs].reverse() }))
      expect(derived.jobs.map((row) => row.status)).toEqual(order)
    })

    test("#then a missing snapshot collapses to none", () => {
      expect(deriveJobBoard(null)).toEqual({ kind: "none" })
    })
  })

  describe("#when deriving the loop", () => {
    test("#then live is returned and a missing loop is none", () => {
      expect(deriveLoop(null)).toEqual({ kind: "none" })
      const loop = liveLoop({ pass: 4 })
      expect(deriveLoop(snapshot({ loop }))).toEqual(loop)
    })
  })
})

describe("#given a loop document", () => {
  describe("#when it is the current v1 schema", () => {
    test("#then goals carry successCriteria and activeGoalId", () => {
      const parsed = parseLoopDocument({
        version: 1,
        activeGoalId: "g1",
        goals: [
          {
            id: "g1",
            title: "ship it",
            status: "in_progress",
            successCriteria: [{ status: "pass" }, { status: "fail" }, { status: "blocked" }, { status: "todo" }],
          },
          { id: "g0", title: "done", status: "complete", successCriteria: [] },
        ],
      })

      expect(parsed).not.toBeNull()
      expect(parsed.activeGoalId).toBe("g1")
      expect(parsed.goals).toHaveLength(2)
      const live = computeLoopLive(parsed)
      expect(live).toEqual({
        kind: "live",
        goalsDone: 1,
        goalsTotal: 2,
        pass: 1,
        fail: 1,
        pending: 1,
        blocked: 1,
        activeGoal: "ship it",
      })
    })
  })

  describe("#when it is the legacy schema", () => {
    test("#then criteria is read and the active goal falls back to in_progress", () => {
      const parsed = parseLoopDocument({
        goals: [{ id: "g1", title: "legacy goal", status: "in_progress", criteria: [{ status: "pass" }] }],
      })
      expect(parsed.activeGoalId).toBeNull()
      expect(computeLoopLive(parsed).activeGoal).toBe("legacy goal")
      expect(activeGoalTitle(parsed)).toBe("legacy goal")
    })
  })

  describe("#when it is malformed", () => {
    test("#then it collapses to null", () => {
      expect(parseLoopDocument(null)).toBeNull()
      expect(parseLoopDocument({ version: 1 })).toBeNull()
      expect(parseLoopDocument({ goals: [{ id: "g", title: "t" }] })).toBeNull()
      expect(parseLoopDocument({ goals: [{ id: "g", title: "t", status: "s", criteria: [{ nope: 1 }] }] })).toBeNull()
    })
  })
})

describe("#given freshness windows", () => {
  test("#then the loop window is LOOP_FRESH_MS on both sides of the boundary", () => {
    expect(isLoopFresh(0, LOOP_FRESH_MS)).toBe(true)
    expect(isLoopFresh(0, LOOP_FRESH_MS + 1)).toBe(false)
    expect(isLoopFresh(LOOP_FRESH_MS, 0)).toBe(true)
  })

  test("#then the snapshot window is STALE_MS on both sides of the boundary", () => {
    expect(isSnapshotFresh(0, STALE_MS)).toBe(true)
    expect(isSnapshotFresh(0, STALE_MS + 1)).toBe(false)
  })
})

describe("#given a live loop", () => {
  describe("#when redacting", () => {
    test("#then activeGoal becomes null and the counts survive", () => {
      const redacted = redactActiveGoal(liveLoop({ activeGoal: "secret", pass: 3, fail: 1 }))
      expect(redacted.activeGoal).toBeNull()
      expect(redacted.pass).toBe(3)
      expect(redacted.fail).toBe(1)
      expect(redactActiveGoal(null)).toBeNull()
    })

    test("#then buildRuntimeSnapshot never leaks the goal title", () => {
      const built = buildRuntimeSnapshot({
        projectDir: "/tmp/proj",
        updatedAt: 42,
        loop: liveLoop({ activeGoal: "secret", goalsTotal: 2 }),
      })
      expect(built.version).toBe(1)
      expect(built.updatedAt).toBe(42)
      expect(built.loop.activeGoal).toBeNull()
      expect(JSON.stringify(built)).not.toContain("secret")
    })

    test("#then a non-live loop is written as null", () => {
      expect(buildRuntimeSnapshot({ loop: null }).loop).toBeNull()
      expect(buildRuntimeSnapshot({}).loop).toBeNull()
    })
  })
})

describe("#given raw job rows", () => {
  test("#then toJobRow applies the V1 title fallback and null-safe counts", () => {
    expect(toJobRow({ agent: "atlas", status: "running" })).toEqual({
      title: "atlas background task",
      status: "running",
      toolCalls: null,
      lastTool: null,
    })
    expect(toJobRow({ title: "named", status: "pending", toolCalls: 2, lastTool: "read" })).toEqual({
      title: "named",
      status: "pending",
      toolCalls: 2,
      lastTool: "read",
    })
  })

  test("#then formatModelLabel strips only the provider prefix", () => {
    expect(formatModelLabel("anthropic/claude-sonnet-4")).toBe("claude-sonnet-4")
    expect(formatModelLabel("bare-model")).toBe("bare-model")
    expect(formatModelLabel("trailing/")).toBe("trailing/")
  })
})

describe("#given view sections", () => {
  describe("#when something is live", () => {
    test("#then the view is active", () => {
      const view = computeView(sections({ agents: { kind: "list", agents: [agent("atlas", "running")] } }))
      expect(view.kind).toBe("active")
    })

    test("#then an invalid config rides along as the banner, not as broken", () => {
      const view = computeView(
        sections({
          config: { kind: "invalid", messages: ["bad"] },
          jobs: { kind: "list", jobs: [job("b", "running")] },
        }),
      )
      expect(view.kind).toBe("active")
      expect(view.configBanner).toEqual({ kind: "invalid" })
    })
  })

  describe("#when nothing is live", () => {
    test("#then an invalid config is broken and a valid one is idle", () => {
      expect(computeView(sections({ config: { kind: "invalid", messages: ["bad"] } })).kind).toBe("broken")
      const idle = computeView(sections({ roster: { kind: "rows", rows: [{ label: "a", model: "m" }] } }))
      expect(idle.kind).toBe("idle")
    })
  })
})

describe("#given a sidebar view", () => {
  describe("#when computing the view key", () => {
    test("#then equal views share a key and a status change moves it", () => {
      const first = computeView(sections({ agents: { kind: "list", agents: [agent("atlas", "running")] } }))
      const same = computeView(sections({ agents: { kind: "list", agents: [agent("atlas", "running")] } }))
      const changed = computeView(sections({ agents: { kind: "list", agents: [agent("atlas", "busy")] } }))

      expect(viewKey(first)).toBe(viewKey(same))
      expect(viewKey(first)).not.toBe(viewKey(changed))
    })

    test("#then a loop count change moves the key", () => {
      const base = liveLoop({ pass: 1 })
      const first = computeView(sections({ loop: base }))
      const changed = computeView(sections({ loop: { ...base, pass: 2 } }))
      expect(viewKey(first)).not.toBe(viewKey(changed))
    })

    test("#then idle and active never collide and broken carries messages", () => {
      const active = computeView(sections({ agents: { kind: "list", agents: [agent("a", "idle")] } }))
      const idle = computeView(sections({}))
      const brokenA = computeView(sections({ config: { kind: "invalid", messages: ["a"] } }))
      const brokenB = computeView(sections({ config: { kind: "invalid", messages: ["b"] } }))

      expect(viewKey(active)).not.toBe(viewKey(idle))
      expect(viewKey(brokenA)).not.toBe(viewKey(brokenB))
    })
  })

  describe("#when rendering plain lines", () => {
    test("#then the active view lists ULW, agents, and jobs", () => {
      const view = computeView(
        sections({
          agents: { kind: "list", agents: [agent("atlas", "running")] },
          jobs: { kind: "list", jobs: [job("build", "running", 3, "bash")] },
          loop: liveLoop({ goalsDone: 1, goalsTotal: 2, pass: 2, activeGoal: "private-goal" }),
        }),
      )
      const rendered = describeView(view)
      expect(rendered).toContain("ULW")
      expect(rendered).toContain("goals 1/2")
      expect(rendered).toContain("atlas running")
      expect(rendered).toContain("Jobs")
      expect(rendered).toContain("private-goal")
      expect(buildViewNodes(view, {}).length).toBe(1)
    })

    test("#then the idle view shows the roster or the empty notice", () => {
      expect(describeView(computeView(sections({})))).toBe("No configured models")
      const idle = computeView(sections({ roster: { kind: "rows", rows: [{ label: "atlas", model: "gpt-5" }] } }))
      expect(describeView(idle)).toContain("atlas gpt-5")
    })

    test("#then the broken view points at doctor", () => {
      const broken = computeView(sections({ config: { kind: "invalid", messages: ["bad key"] } }))
      expect(describeView(broken)).toContain("run doctor")
      expect(describeView(broken)).toContain("bad key")
    })
  })

  describe("#when labelling and truncating", () => {
    test("#then a redacted goal renders as private and long labels truncate", () => {
      expect(activeGoalLabel(null)).toBe("private")
      expect(activeGoalLabel("real")).toBe("real")
      expect(truncate("x".repeat(LABEL_MAX))).toHaveLength(LABEL_MAX)
      expect(truncate("x".repeat(LABEL_MAX + 1))).toHaveLength(LABEL_MAX)
      expect(truncate("x".repeat(LABEL_MAX + 1)).endsWith("...")).toBe(true)
    })
  })
})
