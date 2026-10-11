/**
 * Behavioural tests for the V2 sidebar CLI surface: the gate, the slot +
 * durable receipt, and the headless path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SIDEBAR_CLI_ID, SIDEBAR_SLOT_APPEND, createSidebarCliSurface, resolveSidebarSnapshotPath } from "./rigel-v2-native-cli-sidebar.mjs"

function createFakeContext({ options, directory, renderer = { isDestroyed: false }, sessions = [], backgroundTasks, roster, withDataOn = true } = {}) {
  const handlers = new Map()
  const unsubscribed = []
  const slotCalls = []
  const data = {
    session: { list: () => sessions },
  }
  if (backgroundTasks !== undefined) data.background = { tasks: backgroundTasks }
  if (roster !== undefined) data.roster = roster
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
  return { context, handlers, unsubscribed, slotCalls, handler: (name) => handlers.get(name) }
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
        roster: [{ name: "sisyphus", model: "anthropic/claude-sonnet-4" }],
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

    test("#then the slot render returns the plain view text", () => {
      const fake = createFakeContext({ options: {}, directory, sessions: [{ id: "ses-1", agent: "atlas", status: "running" }] })
      build(fake)
      const rendered = fake.slotCalls[0].render()
      expect(rendered).toContain("atlas running")
      expect(rendered).toContain("Agents")
    })

    test("#then an idle host renders the empty roster notice", () => {
      const fake = createFakeContext({ options: {}, directory })
      build(fake)
      expect(fake.slotCalls[0].render()).toBe("No configured models")
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
})
