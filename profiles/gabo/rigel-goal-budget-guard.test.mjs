import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import guardGoalEngine, {
  BUDGET_GUARD_INSTRUCTION,
  GOAL_BUDGET_FIELDS,
  budgetDiscardNotice,
  hardenGoalTool,
} from "./rigel-goal-budget-guard.mjs"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const vendorDir = path.join(repoRoot, "profiles", "gabo", "vendor", "opencode-goal-plugin")
const vendorTarballs = path.join(vendorDir, "tarballs")
const vendorArchive = path.join(vendorTarballs, "prevalentware-opencode-goal-plugin-0.1.91.tgz")
const temporaryDirectories = []

afterEach(() => {
  while (temporaryDirectories.length > 0) fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true })
})

function goalDefinition(name = "create_goal", execute = async (args) => ({ content: JSON.stringify(args) })) {
  return {
    name,
    description: "Create or replace the active goal.",
    input: {
      type: "object",
      properties: {
        objective: { type: "string" },
        token_budget: { type: "integer" },
        max_auto_turns: { type: "integer" },
        max_duration_seconds: { type: "integer" },
      },
      required: ["objective", ...GOAL_BUDGET_FIELDS],
      additionalProperties: false,
    },
    execute,
  }
}

function extractVendorPackage(archive, destination) {
  execFileSync("tar", ["-xzf", archive, "-C", destination], { stdio: "pipe" })
}

function extractVendorDependency(archive, destination) {
  fs.mkdirSync(destination, { recursive: true })
  execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", destination], { stdio: "pipe" })
}

function realVendorEngineEntry() {
  const materialized = path.join(vendorDir, "node_modules", "@prevalentware", "opencode-goal-plugin", "dist", "server.js")
  if (fs.existsSync(materialized)) return { engineEntry: materialized, extracted: false }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-goal-vendor-"))
  temporaryDirectories.push(temporaryRoot)
  extractVendorPackage(vendorArchive, temporaryRoot)
  const packageRoot = path.join(temporaryRoot, "package")
  const dependencies = [
    ["zod-4.6.7.tgz", "zod"],
    ["effect-3.22.2.tgz", "effect-goal-state"],
    ["fast-check-3.23.2.tgz", "effect-goal-state/node_modules/fast-check"],
    ["pure-rand-6.1.0.tgz", "effect-goal-state/node_modules/pure-rand"],
  ]
  for (const [archive, installPath] of dependencies) {
    extractVendorDependency(path.join(vendorTarballs, archive), path.join(packageRoot, "node_modules", installPath))
  }
  return { engineEntry: path.join(packageRoot, "dist", "server.js"), extracted: true }
}

async function captureVendorTools(vendor) {
  const captured = []
  const disposable = { dispose() {} }
  await vendor.setup({
    options: { auto_continue: false, register_command: false },
    tool: {
      transform: (callback) => {
        callback({ add: (definition) => captured.push(definition) })
        return disposable
      },
      hook: () => disposable,
    },
    session: {
      hook: () => disposable,
      prompt: async () => {},
      get: async () => ({ data: {} }),
    },
    command: {
      transform: () => disposable,
      list: async () => ({ data: [] }),
    },
    event: { subscribe: async function* () {} },
  })
  return captured
}

describe("goal budget guard", () => {
  test("#given a create_goal definition #when hardened #then the budget schema is removed and configuration owns limits", () => {
    const definition = goalDefinition()
    const hardened = hardenGoalTool(definition)

    expect(hardened).not.toBe(definition)
    expect(hardened.input.properties).toEqual({ objective: { type: "string" } })
    expect(hardened.input.required).toEqual(["objective"])
    expect(hardened.input.additionalProperties).toBe(true)
  })

  test("#given a set_goal or replace_goal definition #when hardened #then it is hardened too", () => {
    for (const name of ["set_goal", "replace_goal"]) {
      const definition = goalDefinition(name)
      const hardened = hardenGoalTool(definition)

      expect(hardened).not.toBe(definition)
      expect(hardened.input.properties.token_budget).toBeUndefined()
      expect(hardened.input.required).toEqual(["objective"])
    }
  })

  test("#given get_goal or clear_goal #when hardened #then the original definition and schema stay untouched", () => {
    for (const name of ["get_goal", "clear_goal"]) {
      const definition = goalDefinition(name)

      expect(hardenGoalTool(definition)).toBe(definition)
      expect(definition.input.properties.token_budget).toEqual({ type: "integer" })
    }
  })

  test("#given a hardened execute #when the model supplies budgets #then they are stripped without mutating the original arguments", async () => {
    let received
    const definition = goalDefinition("create_goal", async (args) => {
      received = args
      return { content: "created" }
    })
    const args = {
      objective: "Finish the migration",
      token_budget: 12_000,
      max_auto_turns: 3,
      max_duration_seconds: 60,
      retained: true,
    }

    await hardenGoalTool(definition, { onStripped: () => {} }).execute(args, { sessionID: "ses_123" })

    expect(received).toEqual({ objective: "Finish the migration", retained: true })
    expect(received).not.toBe(args)
    expect(args).toEqual({
      objective: "Finish the migration",
      token_budget: 12_000,
      max_auto_turns: 3,
      max_duration_seconds: 60,
      retained: true,
    })
  })

  test("#given a hardened execute #when onStripped is provided #then it receives the goal tool and present budget fields", async () => {
    const stripped = []
    const hardened = hardenGoalTool(goalDefinition(), { onStripped: (event) => stripped.push(event) })

    await hardened.execute({ objective: "Secure the shim", token_budget: 12_000, max_duration_seconds: 60 })

    expect(stripped).toEqual([{
      tool: "create_goal",
      fields: ["token_budget", "max_duration_seconds"],
    }])
  })

  test("#given no onStripped option #when a hardened execute receives token_budget #then console.warn receives one line and the original execute receives stripped args", async () => {
    const originalWarn = console.warn
    const warnings = []
    let received
    console.warn = (...args) => warnings.push(args)

    try {
      await hardenGoalTool(goalDefinition("create_goal", async (args) => {
        received = args
        return { content: "created" }
      })).execute({ objective: "Secure the shim", token_budget: 12_000 })
    } finally {
      console.warn = originalWarn
    }

    expect(warnings).toEqual([[expect.stringContaining("create_goal")]])
    expect(warnings[0][0]).toContain("token_budget")
    expect(received).toEqual({ objective: "Secure the shim" })
  })

  test("#given an explicit onStripped that throws #when execute runs #then it does not throw and the underlying execute still runs", async () => {
    let executions = 0
    const hardened = hardenGoalTool(goalDefinition("create_goal", async () => {
      executions += 1
      return { content: "created" }
    }), { onStripped: () => { throw new Error("logger unavailable") } })

    await expect(hardened.execute({ objective: "Secure the shim", token_budget: 12_000 })).resolves.toEqual({
      content: `created\n\n${budgetDiscardNotice(["token_budget"])}`,
    })
    expect(executions).toBe(1)
  })

  test("#given an explicit no-op onStripped #when execute runs #then console.warn is not called", async () => {
    const originalWarn = console.warn
    const warnings = []
    console.warn = (...args) => warnings.push(args)

    try {
      await hardenGoalTool(goalDefinition(), { onStripped: () => {} }).execute({ objective: "Secure the shim", token_budget: 12_000 })
    } finally {
      console.warn = originalWarn
    }

    expect(warnings).toEqual([])
  })

  test("#given no budget fields #when a hardened execute runs #then onStripped is not called", async () => {
    const stripped = []
    const hardened = hardenGoalTool(goalDefinition(), { onStripped: (event) => stripped.push(event) })

    await hardened.execute({ objective: "Secure the shim" })

    expect(stripped).toEqual([])
  })

  test("#given a vendor engine that adds create_goal #when guarded setup runs #then the editor receives a definition without token_budget", () => {
    const captured = []
    const vendor = {
      id: "local.goal-mode.server",
      setup(context) {
        context.tool.transform((draft) => draft.add(goalDefinition()))
      },
    }
    const context = {
      options: {},
      tool: { transform: (callback) => callback({ add: (definition) => captured.push(definition) }) },
      session: { hook: () => {} },
    }

    guardGoalEngine(vendor).setup(context)

    expect(captured).toHaveLength(1)
    expect(captured[0].input.properties.token_budget).toBeUndefined()
  })

  test("#given prototype-owned context methods and a frozen editor #when guarded setup runs #then siblings survive, add is hardened, and setup arguments are forwarded", () => {
    class ToolSurface {
      constructor(draft) {
        this.draft = draft
      }

      transform(callback) {
        return callback(this.draft)
      }

      hook() {}
    }
    class SessionSurface {
      hook() {}
      prompt() {}
      wait() {}
    }

    let capturedDefinition
    let receivedContext
    let receivedRenderer
    const frozenEditor = Object.freeze({ add: (definition) => { capturedDefinition = definition } })
    const tool = new ToolSurface(frozenEditor)
    const session = new SessionSurface()
    const renderer = { id: "renderer" }
    const vendor = {
      server() {},
      setup(context, rendererInstance) {
        receivedContext = context
        receivedRenderer = rendererInstance
        context.tool.transform((draft) => draft.add(goalDefinition()))
      },
    }

    guardGoalEngine(vendor).setup({ options: {}, tool, session }, renderer)

    expect(receivedRenderer).toBe(renderer)
    expect(typeof receivedContext.tool.transform).toBe("function")
    expect(typeof receivedContext.tool.hook).toBe("function")
    expect(typeof receivedContext.session.hook).toBe("function")
    expect(typeof receivedContext.session.prompt).toBe("function")
    expect(typeof receivedContext.session.wait).toBe("function")
    expect(capturedDefinition.input.properties.token_budget).toBeUndefined()
    // V1 never loads this shim: the installer deletes `plugin`, and its V1 tool
    // shape uses `args`, not the V2 `input` schema hardened above.
    expect(guardGoalEngine(vendor).server).toBe(vendor.server)
  })

  test("#given extra execute arguments and a discarded budget #when the hardened tool returns content #then arguments are forwarded and the result tells the model the budget was ignored", async () => {
    const toolContext = { sessionID: "ses_123" }
    const extra = { traceID: "trace_123" }
    let received
    const hardened = hardenGoalTool(goalDefinition("create_goal", async (...args) => {
      received = args
      return { content: "goal created" }
    }), { onStripped: () => {} })

    const result = await hardened.execute({ objective: "Secure the shim", token_budget: 12_000 }, toolContext, extra)

    expect(received).toEqual([{ objective: "Secure the shim" }, toolContext, extra])
    expect(result.content).toBe(`goal created\n\n${budgetDiscardNotice(["token_budget"])}`)
  })

  test("#given no budget fields #when a hardened tool returns content #then the result is byte-identical", async () => {
    const originalResult = { content: "goal created\nwithout alteration" }
    const hardened = hardenGoalTool(goalDefinition("create_goal", async () => originalResult), { onStripped: () => {} })

    const result = await hardened.execute({ objective: "Secure the shim" })

    expect(result).toBe(originalResult)
    expect(result.content).toBe("goal created\nwithout alteration")
  })

  test("#given a discarded budget #when the original result has no string content #then the result remains untouched", async () => {
    const originalResult = { content: { structured: true } }
    const hardened = hardenGoalTool(goalDefinition("create_goal", async () => originalResult), { onStripped: () => {} })

    const result = await hardened.execute({ objective: "Secure the shim", token_budget: 12_000 })

    expect(result).toBe(originalResult)
  })

  if (fs.existsSync(vendorArchive)) {
    test("#given the real vendored goal engine #when its setup registers its tools through the guarded context #then create_goal, set_goal and replace_goal expose no budget properties and every other goal tool keeps its original schema", async () => {
      const source = realVendorEngineEntry()
      const isolatedStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-goal-state-"))
      temporaryDirectories.push(isolatedStateRoot)
      const previousStatePath = process.env.OPENCODE_GOAL_STATE_PATH
      process.env.OPENCODE_GOAL_STATE_PATH = path.join(isolatedStateRoot, "goals.json")

      try {
        const { default: vendor } = await import(pathToFileURL(source.engineEntry).href)
        const unguarded = await captureVendorTools(vendor)
        const guarded = await captureVendorTools(guardGoalEngine(vendor))
        const unguardedByName = Object.fromEntries(unguarded.map((definition) => [definition.name, definition]))
        const guardedByName = Object.fromEntries(guarded.map((definition) => [definition.name, definition]))

        for (const name of ["create_goal", "set_goal", "replace_goal"]) {
          const definition = guardedByName[name]
          expect(definition).toBeDefined()
          expect(definition.input.properties.token_budget).toBeUndefined()
          expect(definition.input.properties.max_auto_turns).toBeUndefined()
          expect(definition.input.properties.max_duration_seconds).toBeUndefined()
          expect(definition.input.required).toEqual(["objective"])
          expect(definition.input.additionalProperties).toBe(true)
        }
        for (const name of ["get_goal", "clear_goal", "update_goal"]) {
          expect(guardedByName[name]).toBeDefined()
          expect(guardedByName[name].input).toEqual(unguardedByName[name].input)
        }
      } finally {
        if (previousStatePath === undefined) delete process.env.OPENCODE_GOAL_STATE_PATH
        else process.env.OPENCODE_GOAL_STATE_PATH = previousStatePath
      }
    })
  } else {
    test.skip("#given the real vendored goal engine #when its archive is missing #then the integration test is skipped with the missing artifact identified", () => {})
  }

  test("#given a vendor engine that registers a context hook #when its hook runs twice #then the system gains one guard instruction after the vendor part", () => {
    let registered
    const vendor = {
      setup(context) {
        context.session.hook("context", (payload) => payload.system.push({ type: "text", text: "Vendor context" }))
      },
    }
    const context = {
      options: {},
      tool: { transform: () => {} },
      session: { hook: (_name, callback) => { registered = callback } },
    }
    const payload = { system: [] }

    guardGoalEngine(vendor).setup(context)
    registered(payload)
    registered(payload)

    expect(payload.system).toEqual([
      { type: "text", text: "Vendor context" },
      { type: "text", text: BUDGET_GUARD_INSTRUCTION },
      { type: "text", text: "Vendor context" },
    ])
  })

  test("#given an asynchronous context hook #when it resolves #then the instruction is appended before the wrapped result resolves", async () => {
    let registered
    const order = []
    const vendor = {
      setup(context) {
        context.session.hook("context", async (payload) => {
          await Promise.resolve()
          payload.system.push({ type: "text", text: "Vendor context" })
          order.push("vendor")
          return "vendor result"
        })
      },
    }
    const context = {
      options: {},
      tool: { transform: () => {} },
      session: { hook: (_name, callback) => { registered = callback } },
    }
    const payload = { system: [] }

    guardGoalEngine(vendor).setup(context)
    const result = await registered(payload)
    order.push("wrapped")

    expect(result).toBe("vendor result")
    expect(order).toEqual(["vendor", "wrapped"])
    expect(payload.system).toEqual([
      { type: "text", text: "Vendor context" },
      { type: "text", text: BUDGET_GUARD_INSTRUCTION },
    ])
  })

  test("#given a context without transform or hook APIs #when guarded setup runs #then it does not throw and the vendor receives a usable context", () => {
    let received
    const vendor = { setup: (context) => { received = context; return "ready" } }
    const context = { options: {}, tool: {}, session: {} }

    expect(guardGoalEngine(vendor).setup(context)).toBe("ready")
    expect(received).not.toBe(context)
    expect(received.options).toBe(context.options)
  })

  test("#given a vendor object without setup #when guardGoalEngine runs #then the same object is returned", () => {
    const vendor = { id: "local.goal-mode.server" }

    expect(guardGoalEngine(vendor)).toBe(vendor)
  })

  test("#given the guard module #when imported #then it declares no vendored engine import", () => {
    const guardPath = fileURLToPath(new URL("./rigel-goal-budget-guard.mjs", import.meta.url))

    expect(fs.readFileSync(guardPath, "utf8")).not.toContain("@prevalentware")
  })
})
