import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

import guardGoalEngine, {
  BUDGET_GUARD_INSTRUCTION,
  GOAL_BUDGET_FIELDS,
  hardenGoalTool,
} from "./rigel-goal-budget-guard.mjs"

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

describe("goal budget guard", () => {
  test("#given a create_goal definition #when hardened #then the budget schema is removed and configuration owns limits", () => {
    const hardened = hardenGoalTool(goalDefinition())

    expect(hardened).not.toBe(goalDefinition)
    expect(hardened.input.properties).toEqual({ objective: { type: "string" } })
    expect(hardened.input.required).toEqual(["objective"])
    expect(hardened.input.additionalProperties).toBe(true)
    expect(hardened.description).toContain("plugin configuration")
  })

  test("#given a set_goal or replace_goal definition #when hardened #then it is hardened too", () => {
    for (const name of ["set_goal", "replace_goal"]) {
      const hardened = hardenGoalTool(goalDefinition(name))

      expect(hardened).not.toBe(goalDefinition)
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

    await hardenGoalTool(definition).execute(args, { sessionID: "ses_123" })

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
