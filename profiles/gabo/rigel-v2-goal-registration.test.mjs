/**
 * Owner tests for the vendored goal engine's registration, options and state.
 *
 * These pin the PR B contract: the Rigel-managed DEFAULT options and their
 * precedence over validated user overrides (with the two limit keys absent), the
 * two-slot family registration (exactly one goal entry, idempotent across
 * installs and version transitions), and the fail-closed resolution/adoption of
 * `OPENCODE_GOAL_STATE_PATH` inside the Rigel state tree.
 */
import { afterEach, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  RIGEL_GOAL_DEFAULTS,
  DISABLED_BUILTIN_GOAL,
  adoptGoalState,
  assertGoalStatePathSafe,
  countGoalEntries,
  goalEntryOptions,
  hasValidLegacyPluginEntries,
  hasValidNativePluginEntries,
  hasValidServerPluginShapes,
  isGoalEngineEntry,
  isV1GoalStatePath,
  materializeGoalEngineShim,
  materializeGoalTuiShim,
  registerGoalCliEntry,
  registerGoalServerEntry,
  removeGoalEntries,
  resolveGoalOptions,
  resolveGoalStatePath,
} from "./rigel-v2-goal-registration.mjs"
import { installGoalStatePath } from "./opencode/rigel-v2-native-goal-state.mjs"

const created = []
afterEach(() => {
  while (created.length > 0) fs.rmSync(created.pop(), { recursive: true, force: true })
})
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-goal-reg-"))
  created.push(dir)
  return dir
}

const ENGINE = "/state/versions/1/runtime/vendor/opencode-goal-plugin/node_modules/@prevalentware/opencode-goal-plugin/dist/server.js"
const ARTIFACT = "/state/versions/1/runtime/vendor/opencode-goal-plugin/node_modules/@prevalentware/opencode-goal-plugin"
const TUI_SHIM = "/state/versions/1/runtime/rigel-goal-tui"

describe("#given the Rigel-managed goal defaults", () => {
  test("#then the exact permissive object is used and the two limit keys are absent", () => {
    const options = resolveGoalOptions({})
    expect(options).toEqual({
      auto_continue: true,
      defer_while_tasks_active: true,
      max_auto_turns: 1000,
      min_continue_interval_seconds: 3,
      max_prompt_failures: 3,
      no_progress_token_threshold: 50,
      max_no_progress_turns: 2,
      restricted_agents: [],
      allow_goal_execution_from_plan: false,
    })
    expect("default_token_budget" in options).toBe(false)
    expect("max_goal_duration_seconds" in options).toBe(false)
  })

  test("#then no agent is restricted by name and host Plan mode still cannot auto-run the Goal", () => {
    const options = resolveGoalOptions({})
    expect(options.restricted_agents).toEqual([])
    expect(options.restricted_agents.map((name) => name.toLowerCase())).not.toContain("plan")
    expect(RIGEL_GOAL_DEFAULTS.restricted_agents.length).toBe(0)
    expect(options.allow_goal_execution_from_plan).toBe(false)
  })
})

describe("#given explicit user overrides", () => {
  test("#when partial #then the override wins and the untouched keys keep their default", () => {
    const options = resolveGoalOptions({ overrides: { max_auto_turns: 10 } })
    expect(options.max_auto_turns).toBe(10)
    expect(options.min_continue_interval_seconds).toBe(3)
    expect(options.auto_continue).toBe(true)
  })

  test("#when full #then every supported key is honored, including the two limit keys", () => {
    const options = resolveGoalOptions({
      overrides: {
        auto_continue: false,
        defer_while_tasks_active: false,
        max_auto_turns: 5,
        min_continue_interval_seconds: 30,
        max_prompt_failures: 1,
        no_progress_token_threshold: 5,
        max_no_progress_turns: 1,
        restricted_agents: ["build"],
        allow_goal_execution_from_plan: true,
        default_token_budget: 50000,
        max_goal_duration_seconds: 3600,
      },
    })
    expect(options).toEqual({
      auto_continue: false,
      defer_while_tasks_active: false,
      max_auto_turns: 5,
      min_continue_interval_seconds: 30,
      max_prompt_failures: 1,
      no_progress_token_threshold: 5,
      max_no_progress_turns: 1,
      restricted_agents: ["build"],
      allow_goal_execution_from_plan: true,
      default_token_budget: 50000,
      max_goal_duration_seconds: 3600,
    })
  })

  test("#when wait_for_command is provided #then the 0.1.91 command-lifetime override is preserved", () => {
    expect(resolveGoalOptions({ overrides: { wait_for_command: true } }).wait_for_command).toBe(true)
    expect(() => resolveGoalOptions({ overrides: { wait_for_command: "yes" } })).toThrow(/boolean/)
  })

  test("#when a value is invalid #then it fails with a diagnostic instead of guessing", () => {
    expect(() => resolveGoalOptions({ overrides: { max_auto_turns: 0 } })).toThrow(/positive integer/)
    expect(() => resolveGoalOptions({ overrides: { auto_continue: "yes" } })).toThrow(/boolean/)
    expect(() => resolveGoalOptions({ overrides: { restricted_agents: "plan" } })).toThrow(/array of strings/)
    expect(() => resolveGoalOptions({ overrides: { unexpected_option: 1 } })).toThrow(/unsupported goal option/)
  })

  test("#when an existing entry and a profile override are merged #then the user choice is preserved (conservative update)", () => {
    const existing = goalEntryOptions({ package: ENGINE, options: { max_auto_turns: 7, auto_continue: false } })
    const options = resolveGoalOptions({ overrides: { ...existing, min_continue_interval_seconds: 9 } })
    expect(options.max_auto_turns).toBe(7)
    expect(options.auto_continue).toBe(false)
    expect(options.min_continue_interval_seconds).toBe(9)
    expect(options.max_no_progress_turns).toBe(2)
  })

  test("#when a string entry is inspected #then it carries no options", () => {
    expect(goalEntryOptions(ENGINE)).toEqual({})
  })

  test("#when a legacy tuple is inspected #then its options remain readable during migration", () => {
    expect(goalEntryOptions([ENGINE, { max_auto_turns: 7 }])).toEqual({ max_auto_turns: 7 })
  })
})

describe("#given the two-slot family registration", () => {
  test("#when the server entry is registered #then it is a single native object with one builtin-disable marker and re-registering is idempotent", () => {
    const once = registerGoalServerEntry(["/runtime"], { engineEntry: ENGINE, options: resolveGoalOptions({}) })
    expect(once).toHaveLength(3)
    expect(once[0]).toBe("/runtime")
    expect(once.find(isGoalEngineEntry)).toEqual({ package: ENGINE, options: resolveGoalOptions({}) })
    const twice = registerGoalServerEntry(once, { engineEntry: ENGINE, options: resolveGoalOptions({}) })
    expect(twice.filter(isGoalEngineEntry)).toHaveLength(1)
    expect(twice.filter((entry) => entry === DISABLED_BUILTIN_GOAL)).toHaveLength(1)
    expect(twice[0]).toBe("/runtime")
  })

  test("#when OpenCode 2.0.32 normalizes per-key plugin entries #then native plugins reject tuples while legacy plugin accepts them", () => {
    const native = { package: ENGINE, options: { auto_continue: true } }
    const legacy = [ENGINE, { auto_continue: true }]
    expect(hasValidNativePluginEntries(["foreign-plugin", native])).toBe(true)
    expect(hasValidNativePluginEntries(["foreign-plugin", legacy])).toBe(false)
    expect(hasValidLegacyPluginEntries(["foreign-plugin", legacy])).toBe(true)
    expect(hasValidLegacyPluginEntries(["foreign-plugin", native])).toBe(false)
    expect(hasValidServerPluginShapes({ plugins: ["foreign-plugin", native], plugin: ["legacy-plugin", legacy] })).toBe(true)
    expect(hasValidServerPluginShapes({ plugins: ["foreign-plugin", legacy] })).toBe(false)
  })

  test("#when native and legacy server fields coexist #then foreign entries retain source order and the result normalizes to native plugins", () => {
    const registered = registerGoalServerEntry({
      plugins: ["native-first.mjs", DISABLED_BUILTIN_GOAL, DISABLED_BUILTIN_GOAL],
      plugin: ["legacy-first.mjs", ["legacy-options.mjs", { enabled: true }], [ARTIFACT, {}]],
    }, { engineEntry: ENGINE, options: resolveGoalOptions({}) })

    expect(registered.plugin).toBeUndefined()
    // Host normalizer order: legacy entries first, then native entries.
    expect(registered.plugins.slice(0, 2)).toEqual(["legacy-first.mjs", { package: "legacy-options.mjs", options: { enabled: true } }])
    expect(registered.plugins).toContain("native-first.mjs")
    expect(registered.plugins).toContainEqual({ package: "legacy-options.mjs", options: { enabled: true } })
    expect(registered.plugins.filter((entry) => entry === DISABLED_BUILTIN_GOAL)).toHaveLength(1)
    expect(registered.plugins.filter(isGoalEngineEntry)).toHaveLength(1)
    expect(registered.plugins.find(isGoalEngineEntry)).toEqual({ package: ENGINE, options: resolveGoalOptions({}) })
    expect(hasValidServerPluginShapes(registered)).toBe(true)
  })

  test("#when a version transition replaces the entry #then no second engine remains", () => {
    const engine2 = ENGINE.replace("/versions/1/", "/versions/2/")
    const first = registerGoalServerEntry(["/v1/runtime"], { engineEntry: ENGINE, options: resolveGoalOptions({}) })
    const second = registerGoalServerEntry(first, { engineEntry: engine2, options: resolveGoalOptions({}) })
    expect(second.filter(isGoalEngineEntry)).toHaveLength(1)
    expect(second.find(isGoalEngineEntry).package).toBe(engine2)
  })

  test("#when the CLI entry is registered #then it is a single shim with one builtin-disable marker", () => {
    const once = registerGoalCliEntry({ plugins: [{ package: "/runtime", options: {} }] }, { tuiShimDir: TUI_SHIM })
    const twice = registerGoalCliEntry(once, { tuiShimDir: TUI_SHIM })
    expect(twice.plugins.filter(isGoalEngineEntry)).toHaveLength(1)
    expect(twice.plugins.find(isGoalEngineEntry)).toEqual({ package: TUI_SHIM })
    expect(twice.plugins.filter((entry) => entry === DISABLED_BUILTIN_GOAL)).toHaveLength(1)
    expect(twice).toEqual(once)
  })

  test("#when the goal entries are removed #then both config planes lose duplicate markers and goal entries while foreign entries stay", () => {
    const config = { plugins: ["native-server.mjs", DISABLED_BUILTIN_GOAL, DISABLED_BUILTIN_GOAL, { package: ENGINE, options: {} }], plugin: ["legacy-server.mjs", [ARTIFACT, {}]] }
    const cli = { plugins: [{ package: "/runtime", options: {} }, DISABLED_BUILTIN_GOAL, { package: ARTIFACT }] }
    const stripped = removeGoalEntries(config, cli)
    expect(countGoalEntries(config, cli)).toEqual({ config: 2, cli: 1 })
    expect(countGoalEntries(stripped.config, stripped.cli)).toEqual({ config: 0, cli: 0 })
    expect(stripped.config.plugin).toBeUndefined()
    expect(stripped.config.plugins).toEqual(["legacy-server.mjs", "native-server.mjs"])
    expect(stripped.cli.plugins).toEqual([{ package: "/runtime", options: {} }])
  })

  test("#when the loader shim is laid #then it is a directory whose `.` export re-exports the vendored server", () => {
    const runtimeDir = tempDir()
    const shim = materializeGoalEngineShim({ runtimeDir, engineEntry: ENGINE })
    expect(shim).toBe(path.join(runtimeDir, "rigel-goal-engine"))
    const pkg = JSON.parse(fs.readFileSync(path.join(shim, "package.json"), "utf8"))
    expect(pkg.exports["."]).toBe("./server.js")
    expect(fs.readFileSync(path.join(shim, "server.js"), "utf8")).toContain(ENGINE)
    // The shim directory is recognised as the goal-engine entry (its own slot).
    expect(isGoalEngineEntry([shim, {}])).toBe(true)
  })

  test("#when the TUI loader shim is laid #then it is a directory whose `.`/`./tui` export re-exports the vendored TUI", () => {
    const runtimeDir = tempDir()
    const shim = materializeGoalTuiShim({ runtimeDir, tuiEntry: `${ARTIFACT}/src/tui.ts` })
    expect(shim).toBe(path.join(runtimeDir, "rigel-goal-tui"))
    const pkg = JSON.parse(fs.readFileSync(path.join(shim, "package.json"), "utf8"))
    expect(pkg.exports["."]).toBe("./tui.js")
    expect(pkg.exports["./tui"]).toBe("./tui.js")
    expect(fs.readFileSync(path.join(shim, "tui.js"), "utf8")).toContain(`${ARTIFACT}/src/tui.ts`)
    // The TUI shim belongs to the same goal-engine family slot as the server shim.
    expect(isGoalEngineEntry({ package: shim })).toBe(true)
  })
})

describe("#given the goal state path", () => {
  test("#when resolved #then it lives inside the state root and is never the V1 path", () => {
    const root = "/var/lib/oh-my-rigel"
    const resolved = resolveGoalStatePath(root)
    expect(resolved).toBe(path.join(root, "goal-state", "goals.json"))
    expect(isV1GoalStatePath(resolved)).toBe(false)
  })

  test("#when a path escapes the root or names the V1 surface #then the guard fails closed", () => {
    expect(() => assertGoalStatePathSafe("/etc/goals.json", "/var/lib/oh-my-rigel")).toThrow(/escapes/)
    // The V1 path is outside any Rigel state root, so it is refused (as an escape,
    // or by the dedicated V1 predicate when it sits inside one).
    expect(() => assertGoalStatePathSafe("/home/u/.local/share/opencode-goal-plugin/goals.json", "/home/u/.local/share/oh-my-rigel")).toThrow(/escapes|V1/)
    expect(isV1GoalStatePath("/home/u/.local/share/opencode-goal-plugin/goals.json")).toBe(true)
  })

  test("#when a deployment binds the variable #then it is installed inside the root and an unsafe existing value is refused", () => {
    const root = tempDir()
    const runtimeDir = path.join(root, "versions", "1", "runtime")
    fs.mkdirSync(runtimeDir, { recursive: true })
    const runtimeUrl = `file://${path.join(runtimeDir, "index.js")}`
    const env = {}
    const installed = installGoalStatePath({ env, runtimeUrl })
    expect(installed).toBe(path.join(root, "goal-state", "goals.json"))
    expect(env.OPENCODE_GOAL_STATE_PATH).toBe(installed)
    // A source load (not a deployment path) leaves the environment untouched.
    expect(installGoalStatePath({ env: {}, runtimeUrl: "file:///repo/profiles/gabo/opencode/index.js" })).toBeUndefined()
    // An existing V1 value is refused.
    expect(() => installGoalStatePath({ env: { OPENCODE_GOAL_STATE_PATH: "/home/u/.local/share/opencode-goal-plugin/goals.json" }, runtimeUrl })).toThrow(/escapes|V1/)
  })
})

describe("#given a compatible external state", () => {
  function writeState(file, payload) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(payload))
  }

  test("#when compatible #then it is copied into the state root and the source stays byte-identical", () => {
    const root = tempDir()
    const source = path.join(root, "external", "goals.json")
    writeState(source, { version: 3, goals: { a: { objective: "x" } } })
    const before = fs.readFileSync(source)
    const target = resolveGoalStatePath(path.join(root, "rigel"))
    const result = adoptGoalState({ sourcePath: source, targetPath: target, stateRoot: path.join(root, "rigel") })
    expect(result.version).toBe(3)
    expect(fs.existsSync(target)).toBe(true)
    expect(fs.readFileSync(target)).toEqual(before)
    expect(fs.readFileSync(source)).toEqual(before)
  })

  test("#when modified or newer or V1 #then it fails closed", () => {
    const root = tempDir()
    const stateRoot = path.join(root, "rigel")
    const source = path.join(root, "external", "goals.json")
    writeState(source, { version: 3, goals: {} })
    const target = resolveGoalStatePath(stateRoot)
    expect(() => adoptGoalState({ sourcePath: source, targetPath: target, stateRoot, expectedDigest: "0".repeat(64) })).toThrow(/digest mismatch/)
    writeState(source, { version: 9, goals: {} })
    expect(() => adoptGoalState({ sourcePath: source, targetPath: target, stateRoot })).toThrow(/unsupported goal state schema/)
    expect(() => adoptGoalState({ sourcePath: "/home/u/.local/share/opencode-goal-plugin/goals.json", targetPath: target, stateRoot })).toThrow(/V1/)
  })
})
