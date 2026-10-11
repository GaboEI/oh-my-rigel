/**
 * Behavioural tests for the V2 sidebar CLI surface: the gate, the slot +
 * durable receipt, and the headless path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SIDEBAR_CLI_ID, SIDEBAR_SLOT_APPEND, createSidebarCliSurface, resolveSidebarSnapshotPath } from "./rigel-v2-native-cli-sidebar.mjs"
import { nodeText } from "./rigel-v2-sidebar-node.mjs"

const stubSolid = {
  createElement: (tag) => ({ tag, props: {}, children: [] }),
  setProp: (node, name, value) => { node.props[name] = value },
  insert: (parent, child) => { parent.children.push(child) },
}

function createFakeContext({ options, directory, renderer = { isDestroyed: false }, sessions = [], backgroundTasks, hostAgents, hostModels, hostModelListThrows = false, v2Sessions, withDataOn = true, withEventBus = false } = {}) {
  const handlers = new Map()
  const unsubscribed = []
  const slotCalls = []
  const data = {
    session: { list: () => sessions },
  }
  if (backgroundTasks !== undefined) data.background = { tasks: backgroundTasks }
  // The canonical 2.0.26 host inventory lives under `context.data.location`:
  // `location.agent.list(...)` and `location.model.list(location)`. Only install
  // it when the case asks for a host, so the host-missing path stays real.
  if (hostAgents !== undefined || hostModels !== undefined) {
    data.location = {
      ...(hostAgents !== undefined ? { agent: { list: () => hostAgents } } : {}),
      ...(hostModels !== undefined
        ? { model: { list: () => { if (hostModelListThrows) throw new Error("model.list unavailable"); return hostModels } } }
        : {}),
    }
  }
  if (withDataOn) {
    data.on = (name, handler) => {
      handlers.set(name, handler)
      return () => {
        handlers.delete(name)
        unsubscribed.push(name)
      }
    }
  }
  const context = {
    options,
    renderer,
    location: { current: { directory } },
    data,
    ui: {
      slot: (args) => {
        slotCalls.push(args)
        return () => {}
      },
    },
  }
  // The V2 TUI API (`TuiPluginApi`) keeps live sessions on `state.session` with
  // a per-id `status(id)`/`get(id)` and publishes on `event.on`. Stub both when
  // the case asks for them, so the real V2 data path is exercised, not a
  // synthetic flat roster.
  if (v2Sessions !== undefined) {
    context.state = {
      session: {
        list: () => v2Sessions.map((session) => ({ id: session.id, agent: session.agent })),
        get: (id) => v2Sessions.find((session) => session.id === id),
        status: (id) => v2Sessions.find((session) => session.id === id)?.status,
        count: () => v2Sessions.length,
      },
    }
  }
  if (withEventBus) {
    context.event = {
      on: (name, handler) => {
        handlers.set(`event:${name}`, handler)
        return () => {
          handlers.delete(`event:${name}`)
          unsubscribed.push(`event:${name}`)
        }
      },
    }
  }
  return { context, handlers, unsubscribed, slotCalls, handler: (name) => handlers.get(name) }
}

function agentFixture() {
  return {
    defaultAgent: "sisyphus",
    agents: {
      sisyphus: { name: "sisyphus", model: "anthropic/claude-opus-5-5" },
      atlas: { name: "atlas", model: "kimi-for-coding/kimi-k3" },
    },
    metadata: { global: { agentOverrides: { atlas: { model: "openai/gpt-6-astra" } }, categories: {} } },
    modes: { defaultUltrawork: false },
  }
}

function categoryFixture() {
  return {
    categories: {
      "deep-low": { model: "openai/gpt-6.1-sol", variant: "medium" },
      writing: { model: "anthropic/claude-opus-5-5" },
    },
  }
}

/** Drain the microtask queue so a fire-and-forget host read settles (no timers). */
async function flushMicrotasks() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

describe("createSidebarCliSurface", () => {
  let stateRoot
  let directory
  let logs
  let clock
  let snapshotPath

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), "rigel-sidebar-state-"))
    directory = mkdtempSync(join(tmpdir(), "rigel-sidebar-dir-"))
    logs = []
    clock = 0
    snapshotPath = resolveSidebarSnapshotPath({ stateRoot })
  })

  afterEach(() => {
    rmSync(stateRoot, { recursive: true, force: true })
    rmSync(directory, { recursive: true, force: true })
  })

  function build(fake, overrides = {}) {
    return createSidebarCliSurface({
      stateRoot,
      log: (entry) => logs.push(entry),
      now: () => clock,
      ...overrides,
    }).setup(fake.context)
  }

  function readReceipt() {
    return JSON.parse(readFileSync(snapshotPath, "utf8"))
  }

  test("#then the surface advertises the V1 id and the sidebar.content slot", () => {
    expect(SIDEBAR_CLI_ID).toBe("oh-my-rigel.sidebar")
    expect(SIDEBAR_SLOT_APPEND).toBe("sidebar.content")
    expect(resolveSidebarSnapshotPath({ stateRoot })).toBe(snapshotPath)
  })

  describe("#given an explicit disabled gate", () => {
    test("#then setup registers nothing and writes no receipt", () => {
      const fake = createFakeContext({ options: { tui: { sidebar: { enabled: false } } }, directory })
      const cleanup = build(fake)

      expect(cleanup).toBeUndefined()
      expect(fake.slotCalls).toHaveLength(0)
      expect(fake.handlers.size).toBe(0)
      expect(existsSync(snapshotPath)).toBe(false)
      expect(logs).toHaveLength(0)
    })
  })

  describe("#given an absent gate", () => {
    test("#then the surface is enabled, registers the slot, and writes the receipt", () => {
      const fake = createFakeContext({ options: {}, directory })
      const cleanup = build(fake)

      expect(typeof cleanup).toBe("function")
      expect(fake.slotCalls).toHaveLength(1)
      expect(fake.slotCalls[0].append).toBe("sidebar.content")
      expect(typeof fake.slotCalls[0].render).toBe("function")
      expect(existsSync(snapshotPath)).toBe(true)
    })
  })

  describe("#given an explicit enabled gate", () => {
    test("#then the surface registers the slot", () => {
      const fake = createFakeContext({ options: { tui: { sidebar: { enabled: true } } }, directory })
      build(fake)
      expect(fake.slotCalls).toHaveLength(1)
    })
  })

  describe("#given a headless host", () => {
    test("#then no slot is registered but the receipt is still written", () => {
      const fake = createFakeContext({ options: {}, directory, renderer: null })
      const cleanup = build(fake)

      expect(typeof cleanup).toBe("function")
      expect(fake.slotCalls).toHaveLength(0)
      expect(existsSync(snapshotPath)).toBe(true)
      expect(logs.some((entry) => entry.event === "headless-receipt-only")).toBe(true)
      const receipt = readReceipt()
      expect(receipt.version).toBe(1)
      expect(receipt.view.kind).toBe("idle")
    })
  })

  describe("#given active sessions and background tasks", () => {
    test("#then the receipt carries the snapshot and the derived active view", () => {
      const fake = createFakeContext({
        options: {},
        directory,
        sessions: [
          { id: "ses-1", agent: "atlas", status: "running" },
          { id: "ses-2", agent: "idle-agent", status: "idle" },
        ],
        backgroundTasks: [{ agent: "atlas", status: "running", title: "bg-task", toolCalls: 2, lastTool: "bash" }],
      })
      build(fake)

      const receipt = readReceipt()
      expect(receipt.version).toBe(1)
      expect(receipt.projectDir).toBe(directory)
      expect(receipt.updatedAt).toBe(0)
      expect(receipt.activeAgents).toEqual([{ name: "atlas", status: "running" }])
      expect(receipt.jobBoard[0]).toEqual({ title: "bg-task", status: "running", toolCalls: 2, lastTool: "bash" })
      expect(receipt.view.kind).toBe("active")
      expect(receipt.view.agents.agents[0].name).toBe("atlas")
      expect(receipt.view.jobs.jobs[0].title).toBe("bg-task")
      expect(typeof receipt.viewKey).toBe("string")
    })

    test("#then the slot render returns a host node tree, never a raw string", () => {
      const fake = createFakeContext({ options: {}, directory, sessions: [{ id: "ses-1", agent: "atlas", status: "running" }] })
      build(fake, { solid: stubSolid })
      const rendered = fake.slotCalls[0].render({ sessionID: "ses-1" })
      expect(typeof rendered).not.toBe("string")
      expect(rendered).toBeTruthy()
      const text = nodeText(rendered)
      expect(text).toContain("atlas running")
      expect(text).toContain("Agents")
    })

    test("#given no manifest roles and no host #then the empty roster notice is a node with a next action", () => {
      const fake = createFakeContext({ options: {}, directory })
      build(fake, { solid: stubSolid, agentManifest: { agents: {}, metadata: { global: {} } }, categoryManifest: { categories: {} } })
      const rendered = fake.slotCalls[0].render({ sessionID: "ses-1" })
      expect(typeof rendered).not.toBe("string")
      expect(typeof rendered.tag).toBe("string")
      expect(nodeText(rendered)).toContain("No configured models")
      expect(nodeText(rendered)).toContain("run doctor to configure models")
    })

    test("#given a nested host theme #then the section border color is adapted into the tree", () => {
      const fake = createFakeContext({ options: {}, directory })
      fake.context.theme = {
        text: { base: "T", muted: "M", feedback: { warning: { base: "W" }, success: { base: "S" }, error: { base: "E" }, info: { base: "I" } } },
        hue: { accent: { 400: "A" } },
        border: { base: "BORDER" },
      }
      build(fake, { solid: stubSolid })
      const rendered = fake.slotCalls[0].render({ sessionID: "ses-1" })
      expect(rendered.children[0].props.borderColor).toBe("BORDER")
    })

    test("#given an ACTIVE view #then the slot render is a valid element with the active text", () => {
      const fake = createFakeContext({ options: {}, directory, sessions: [{ id: "ses-1", agent: "atlas", status: "running" }] })
      build(fake, { solid: stubSolid })
      const rendered = fake.slotCalls[0].render({ sessionID: "ses-1" })
      expect(typeof rendered.tag).toBe("string")
      expect(nodeText(rendered)).toContain("atlas running")
    })

    test("#given a BROKEN config view #then the slot render is a valid element with the notice", () => {
      const fake = createFakeContext({ options: {}, directory })
      build(fake, { solid: stubSolid, config: () => ({ valid: false, messages: ["config broken"] }) })
      const rendered = fake.slotCalls[0].render({ sessionID: "ses-1" })
      expect(typeof rendered.tag).toBe("string")
      expect(nodeText(rendered)).toContain("config invalid - run doctor")
    })
  })

  describe("#given a live ulw-loop on disk", () => {
    test("#then the receipt view is live and activeGoal is redacted", () => {
      const loopDir = join(directory, ".omo", "ulw-loop", "run-1")
      mkdirSync(loopDir, { recursive: true })
      writeFileSync(
        join(loopDir, "goals.json"),
        JSON.stringify({
          version: 1,
          activeGoalId: "g1",
          goals: [
            { id: "g1", title: "secret-goal", status: "in_progress", successCriteria: [{ status: "pass" }, { status: "pending" }] },
            { id: "g0", title: "done", status: "complete", successCriteria: [{ status: "pass" }] },
          ],
        }),
      )
      clock = Date.now()

      const fake = createFakeContext({ options: {}, directory })
      build(fake)

      const receipt = readReceipt()
      expect(receipt.loop.kind).toBe("live")
      expect(receipt.loop.activeGoal).toBeNull()
      expect(JSON.stringify(receipt)).not.toContain("secret-goal")
      expect(receipt.loop.goalsDone).toBe(1)
      expect(receipt.loop.goalsTotal).toBe(2)
      expect(receipt.view.kind).toBe("active")
      expect(receipt.view.loop.kind).toBe("live")
    })
  })

  describe("#given a refresh-triggering event", () => {
    test("#then the receipt is rewritten with the new data", () => {
      const sessions = []
      const fake = createFakeContext({ options: {}, directory, sessions })
      build(fake)
      expect(readReceipt().view.kind).toBe("idle")

      sessions.push({ id: "ses-9", agent: "hephaestus", status: "busy" })
      clock = 500
      fake.handler("session.created")({ type: "session.created", data: { sessionID: "ses-9" } })

      const receipt = readReceipt()
      expect(receipt.updatedAt).toBe(500)
      expect(receipt.view.kind).toBe("active")
      expect(receipt.activeAgents[0].name).toBe("hephaestus")
    })
  })

  describe("#given a slot implementation that throws", () => {
    test("#then setup is contained, the failure is logged, and the receipt still lands", () => {
      const fake = createFakeContext({ options: {}, directory })
      fake.context.ui.slot = () => {
        throw new Error("slot blew up")
      }
      const cleanup = build(fake)

      expect(typeof cleanup).toBe("function")
      expect(logs.some((entry) => entry.event === "slot-register-failed")).toBe(true)
      expect(existsSync(snapshotPath)).toBe(true)
    })
  })

  describe("#given a context without data.on", () => {
    test("#then setup still writes the receipt and returns a safe disposer", () => {
      const fake = createFakeContext({ options: {}, directory, withDataOn: false })
      const cleanup = build(fake)
      expect(typeof cleanup).toBe("function")
      expect(fake.handlers.size).toBe(0)
      expect(existsSync(snapshotPath)).toBe(true)
      expect(() => cleanup()).not.toThrow()
    })
  })

  describe("#given the surface is disposed", () => {
    test("#then every subscription is released", () => {
      const fake = createFakeContext({ options: {}, directory })
      const cleanup = build(fake)
      cleanup()

      for (const name of ["session.created", "session.deleted", "session.execution.succeeded", "session.execution.failed"]) {
        expect(fake.unsubscribed).toContain(name)
      }
    })
  })

  describe("#given the model roster sources", () => {
    test("#given the Rigel manifests #then the receipt carries the effective role roster and ignores a synthetic data.roster", () => {
      const fake = createFakeContext({ options: {}, directory })
      // A stale/foreign `data.roster` must be ignored: the roster comes from the
      // manifests, never from a host field that nothing populates.
      fake.context.data.roster = [{ name: "ghost", model: "ghost/ghost-model" }]
      build(fake, { agentManifest: agentFixture(), categoryManifest: categoryFixture() })

      const receipt = readReceipt()
      expect(receipt.view.kind).toBe("idle")
      expect(receipt.view.roster.kind).toBe("rows")
      const rows = receipt.view.roster.rows
      expect(rows).toContainEqual({ label: "atlas", model: "gpt-6-astra" })
      expect(rows).toContainEqual({ label: "sisyphus", model: "claude-opus-5-5" })
      expect(rows).toContainEqual({ label: "deep-low", model: "gpt-6.1-sol" })
      expect(JSON.stringify(rows)).not.toContain("ghost")
    })

    test("#given no host endpoint (host-missing) #then the manifest roster still renders", async () => {
      const fake = createFakeContext({ options: {}, directory })
      build(fake, { agentManifest: agentFixture(), categoryManifest: categoryFixture() })
      await flushMicrotasks()

      const receipt = readReceipt()
      expect(receipt.view.kind).toBe("idle")
      expect(receipt.view.roster.kind).toBe("rows")
      expect(receipt.view.roster.rows).toContainEqual({ label: "sisyphus", model: "claude-opus-5-5" })
    })

    test("#given a live host agent inventory #then the host roster wins over the manifests", async () => {
      const fake = createFakeContext({
        options: {},
        directory,
        hostAgents: [{ id: "live-oracle", name: "live-oracle", model: "openai/gpt-6-luna-fast" }],
      })
      build(fake, { agentManifest: agentFixture(), categoryManifest: categoryFixture() })
      await flushMicrotasks()

      const receipt = readReceipt()
      expect(receipt.view.roster.rows).toContainEqual({ label: "live-oracle", model: "gpt-6-luna-fast" })
      expect(receipt.view.roster.rows).not.toContainEqual({ label: "sisyphus", model: "claude-opus-5-5" })
    })

    test("#given no roles but an available host model catalog #then the catalog is the truthful state", async () => {
      const fake = createFakeContext({
        options: {},
        directory,
        hostModels: [{ providerID: "openai", id: "gpt-6-luna-fast", enabled: true }],
      })
      build(fake, { agentManifest: { agents: {}, metadata: { global: {} } }, categoryManifest: { categories: {} } })
      await flushMicrotasks()

      const receipt = readReceipt()
      expect(receipt.view.kind).toBe("idle")
      expect(receipt.view.roster.rows).toContainEqual({ label: "openai", model: "gpt-6-luna-fast" })
    })

    test("#given a host whose model endpoint throws #then setup never rejects and the manifest roster holds", async () => {
      const fake = createFakeContext({ options: {}, directory, hostModels: [], hostModelListThrows: true })
      const cleanup = build(fake, { agentManifest: agentFixture(), categoryManifest: categoryFixture() })
      await flushMicrotasks()

      expect(typeof cleanup).toBe("function")
      expect(readReceipt().view.roster.rows).toContainEqual({ label: "sisyphus", model: "claude-opus-5-5" })
    })

    test("#given the bundled manifests #then a category roster renders without any host", () => {
      const fake = createFakeContext({ options: {}, directory })
      build(fake, { solid: stubSolid })
      const rendered = fake.slotCalls[0].render({ sessionID: "ses-1" })
      expect(typeof rendered).not.toBe("string")
      expect(nodeText(rendered)).toContain("deep-low")
    })
  })

  describe("#given the real V2 TUI host surface", () => {
    // Distinguishes V1 heritage from V2 proof. V1 heritage: a flat
    // `data.session.list()` of records that carry their own status. V2 proof:
    // the `TuiPluginApi` keeps sessions on `state.session` and exposes the status
    // separately as `state.session.status(id)`. Both must drive the Agents view.
    test("#given V2 state.session statuses #then the materialized Agents view lists the busy/retry/running roles", () => {
      const fake = createFakeContext({
        options: {},
        directory,
        v2Sessions: [
          { id: "ses-a", agent: "atlas", status: "busy" },
          { id: "ses-b", agent: "oracle", status: "retry" },
          { id: "ses-c", agent: "sisyphus", status: "running" },
          { id: "ses-d", agent: "momus", status: "idle" },
        ],
      })
      build(fake, { solid: stubSolid, agentManifest: agentFixture(), categoryManifest: categoryFixture() })
      const rendered = fake.slotCalls[0].render({ session_id: "ses-a" })
      expect(typeof rendered).not.toBe("string")
      const text = nodeText(rendered)
      expect(text).toContain("Agents")
      expect(text).toContain("atlas busy")
      expect(text).toContain("oracle retry")
      expect(text).toContain("sisyphus running")
      expect(text).not.toContain("momus idle")
    })

    test("#given the V1 heritage data.session shape #then the Agents view still renders (functionality not reduced)", () => {
      const fake = createFakeContext({
        options: {},
        directory,
        sessions: [
          { id: "ses-1", agent: "atlas", status: "running" },
          { id: "ses-2", agent: "idle-agent", status: "idle" },
        ],
      })
      build(fake, { solid: stubSolid, agentManifest: agentFixture(), categoryManifest: categoryFixture() })
      const text = nodeText(fake.slotCalls[0].render({ session_id: "ses-1" }))
      expect(text).toContain("atlas running")
      expect(text).not.toContain("idle-agent idle")
    })

    test("#given a V2 event bus #then setup subscribes and a session event refreshes the view", () => {
      const v2Sessions = [{ id: "ses-a", agent: "atlas", status: "idle" }]
      const fake = createFakeContext({ options: {}, directory, v2Sessions, withEventBus: true, withDataOn: false })
      build(fake, { agentManifest: agentFixture(), categoryManifest: categoryFixture() })
      expect(readReceipt().view.kind).toBe("idle")

      // The host flips the session to busy and emits on the V2 event bus.
      v2Sessions[0].status = "busy"
      clock = 500
      fake.handler("event:session.updated")({ type: "session.updated" })

      const receipt = readReceipt()
      expect(receipt.updatedAt).toBe(500)
      expect(receipt.view.kind).toBe("active")
      expect(receipt.activeAgents).toContainEqual({ name: "atlas", status: "busy" })
    })
  })

  describe("#given a single current runtime (no duplicate plugin)", () => {
    test("#then the idle roster is non-empty with no data.roster and no host inventory", () => {
      // Regression: a single current runtime must render its real roster from the
      // co-located manifests. Reverting the adapter to the pre-fix
      // `context.data.roster` read makes this empty, which is exactly the live
      // one-plugin regression.
      const fake = createFakeContext({ options: {}, directory })
      expect(fake.context.data.roster).toBeUndefined()
      build(fake, { agentManifest: agentFixture(), categoryManifest: categoryFixture() })

      const receipt = readReceipt()
      expect(receipt.view.kind).toBe("idle")
      expect(receipt.view.roster.kind).toBe("rows")
      expect(receipt.view.roster.rows.length).toBeGreaterThan(0)
    })
  })
})
