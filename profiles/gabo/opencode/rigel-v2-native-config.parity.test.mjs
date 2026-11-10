/**
 * Differential parity for the native V2 configuration resolver.
 *
 * The resolver is a runtime-only port of the OmO config chain (the isolated V2
 * laboratory stages the runtime flat, with no `node_modules`, so it cannot
 * import the TypeScript packages). This test is the boundary owner that keeps
 * the port from drifting: it runs the real `validatePluginConfig` and the real
 * Zod schemas over the same fixtures and asserts the port's gate projection
 * matches. It runs under Bun, where the TypeScript sources resolve.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validatePluginConfig } from "../../../packages/omo-opencode/src/config/validate.ts"
import { MonitorConfigSchema } from "../../../packages/omo-opencode/src/config/schema/monitor.ts"
import { GoalConfigSchema } from "../../../packages/omo-opencode/src/config/schema/goal.ts"
import { NATIVE_GOAL_DEFAULTS, NATIVE_MONITOR_DEFAULTS, resolveNativePluginConfig } from "./rigel-v2-native-config.mjs"

const created = []

function makeFixture() {
  const home = mkdtempSync(join(tmpdir(), "rigel-native-config-parity-"))
  const project = join(home, "project")
  mkdirSync(join(home, ".omo"), { recursive: true })
  mkdirSync(join(project, ".omo"), { recursive: true })
  created.push(home)
  return {
    home,
    project,
    writeUser: (text) => writeFileSync(join(home, ".omo", "omo.jsonc"), text),
    writeProject: (text) => writeFileSync(join(project, ".omo", "omo.jsonc"), text),
  }
}

function projectGates(config) {
  return {
    monitor: config.monitor,
    goal: config.goal,
    task_system: config.experimental?.task_system ?? false,
    // The default-mode switch is a plugin config block the native view now
    // projects, so the port is pinned against the real loader here too.
    default_mode: config.default_mode,
    disabled_tools: config.disabled_tools ?? [],
    disabled_agents: config.disabled_agents ?? [],
    disabled_skills: config.disabled_skills ?? [],
    categories: config.categories ?? {},
  }
}

function nativeGates(view) {
  return {
    monitor: view.monitor,
    goal: view.goal,
    task_system: view.experimental.task_system,
    default_mode: view.default_mode,
    disabled_tools: view.disabled.tools,
    disabled_agents: view.disabled.agents,
    disabled_skills: view.disabled.skills,
    categories: view.categories,
  }
}

function assertParity(fixture, env = {}) {
  const real = validatePluginConfig(fixture.project, { HOME: fixture.home, USERPROFILE: fixture.home, ...env })
  const native = resolveNativePluginConfig({ directory: fixture.project, env: { HOME: fixture.home, USERPROFILE: fixture.home, ...env } })
  expect(nativeGates(native)).toEqual(projectGates(real.config))
  return { real, native }
}

afterEach(() => {
  while (created.length > 0) rmSync(created.pop(), { recursive: true, force: true })
})

describe("#given the real OmO loader and the native resolver", () => {
  test("#when no config exists #then both project the same defaults", () => {
    // given
    const fixture = makeFixture()
    // when / then
    assertParity(fixture)
  })

  test("#when a user [opencode] block sets every gate #then both project the same view", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{
      "[opencode]": {
        "monitor": { "enabled": true, "live_mode_enabled": true, "max_runtime_ms": 5000 },
        "goal": { "enabled": true, "auto_start": true, "default_max_iterations": 7 },
        "experimental": { "task_system": true },
        "disabled_tools": ["todowrite"],
        "disabled_agents": ["oracle"],
        "disabled_skills": ["dev-browser"],
      },
    }`)
    // when / then
    assertParity(fixture)
  })

  test("#when layers disagree #then both resolve the same precedence and unions", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{
      "categories": { "quick": { "model": "top-quick", "temperature": 0.3 }, "deep": { "model": "top-deep" } },
      "[opencode]": { "monitor": { "enabled": true }, "disabled_tools": ["t1"] },
      "profiles": { "gabo": { "[opencode]": { "monitor": { "max_runtime_ms": 9999 }, "disabled_tools": ["t3"], "goal": { "enabled": true } } } },
    }`)
    fixture.writeProject(`{
      "[opencode]": {
        "monitor": { "enabled": false },
        "experimental": { "task_system": true },
        "disabled_tools": ["t2"],
        "disabled_agents": ["a1", "a2"],
        "categories": { "quick": { "model": "project-quick" }, "newcat": { "description": "n" } },
      },
    }`)
    // when / then
    assertParity(fixture, { OMO_PROFILE: "gabo" })
  })

  test("#when a legacy ralph_loop block is present #then both migrate it into goal", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "ralph_loop": { "enabled": true, "default_max_iterations": 42 } } }`)
    // when / then
    assertParity(fixture)
  })

  test("#when a profile declares the default-mode switch #then both resolve the same block", () => {
    // given: the shipped shape - `profiles.<p>.[opencode].default_mode`, with the
    // `goal` leaf written the way the real profile does
    const fixture = makeFixture()
    fixture.writeUser(`{
      "[opencode]": { "default_mode": { "goal": false } },
      "profiles": { "gabo": { "[opencode]": { "default_mode": { "ultrawork": true } } } },
    }`)
    // when / then: parity proves the port materializes the same `false` defaults
    // the Zod schema applies, so the runtime switch reads the value a fresh
    // install would bake from the same file
    const { native } = assertParity(fixture, { OMO_PROFILE: "gabo" })
    expect(native.default_mode).toEqual({ ultrawork: true, goal: false })
  })

  test("#when no layer declares the default-mode block #then both leave it absent", () => {
    // given: `default_mode` is an OPTIONAL block, so absence must stay absence
    // instead of a materialized `{ ultrawork: false, goal: false }`
    const fixture = makeFixture()
    // when / then
    const { native } = assertParity(fixture)
    expect(native.default_mode).toBeUndefined()
  })

  test("#when values are invalid #then both drop the same leaves and keep the rest", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{
      "[opencode]": {
        "monitor": { "enabled": "yes", "max_runtime_ms": 5, "batch_max_lines": 12 },
        "experimental": { "task_system": "yes" },
        "disabled_tools": ["ok", 7],
        "categories": { "quick": { "model": 7, "temperature": 0.4 } },
      },
    }`)
    // when / then
    assertParity(fixture)
  })

  test("#when plugin keys sit at the top level #then both strip them", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "monitor": { "enabled": true }, "goal": { "enabled": true }, "disabled_tools": ["x"] }`)
    // when / then
    assertParity(fixture)
  })
})

describe("#given the real Zod schemas", () => {
  test("#when the native defaults are compared #then they match the schema defaults", () => {
    // given
    const monitor = MonitorConfigSchema.parse({})
    const goal = GoalConfigSchema.parse({})
    // when
    // The native default constants are the values the resolver applies when a
    // layer supplies a partial block. The plugin view itself preserves the
    // loader's `undefined` when a key is absent, so parity with V1 holds; these
    // constants must still equal the schema defaults they stand in for.
    // then
    expect(NATIVE_MONITOR_DEFAULTS).toEqual(monitor)
    expect(NATIVE_GOAL_DEFAULTS).toEqual(goal)
  })
})
