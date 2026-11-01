/**
 * Contract for the LAUNCH config-chain audit.
 *
 * Row 55 host retest 2 measured the wrong runtime: the OpenCode process merged
 * two config sources, so the plugin list carried BOTH the already-installed
 * runtime (`$HOME/.config/opencode/opencode.json`) and the freshly materialized
 * candidate (`OPENCODE_CONFIG=<sandbox>/opencode.json`). The host loads every
 * declared plugin, the OLDER runtime wins the `team_create` registration and the
 * `/team-mode` prompt seam, and the candidate never executes — which is exactly
 * what the run reported: worktrees provisioned despite `worktree: no`, members
 * left as records with no child session, and therefore one pane.
 *
 * The isolation guard so far only proved that the state ROOTS were inside a
 * sandbox. It could not see that the CONFIG CHAIN declared a second runtime, so
 * an invalid launch produced plausible-looking evidence instead of failing.
 *
 * These tests lock the missing invariant: exactly one Rigel runtime may be
 * reachable from the config sources a launch actually merges.
 *
 * Hermetic: every HOME/config root lives in a temp tree; nothing reads the real
 * HOME or launches a process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { pathToFileURL } from "node:url"

import {
  assertGoalStateInsideRigelStateRoot,
  assertIsolatedV2Env,
  assertLaunchGoalStateMatchesRuntime,
  assertSingleRigelRuntime,
  assertSingleRigelRuntimeInLaunch,
  buildIsolatedV2Env,
  launchConfigSources,
  rigelRuntimeEntries,
  rigelStateRootFromRuntime,
} from "./isolated-v2-env.mjs"
import { installGoalStatePath } from "./opencode/rigel-v2-native-goal-state.mjs"

let root

/** Materialize a directory that LOOKS like a Rigel runtime (marker module only). */
function fakeRuntime(directory) {
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, "rigel-v2-native-core.mjs"), "export default {}\n")
  return directory
}

function writeConfig(file, plugins) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({ plugin: plugins }, null, 2)}\n`)
  return file
}

/** Write a config that declares plugins under the native V2 `plugins` key. */
function writeNativeConfig(file, plugins) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({ plugins }, null, 2)}\n`)
  return file
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-launch-audit-"))
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("launch config-chain audit", () => {
  test("#given two config sources that each declare a Rigel runtime #when the launch chain is audited #then it refuses and names both runtimes", () => {
    // given: the exact retest-2 shape — an installed runtime in the global
    // config plus a candidate runtime behind OPENCODE_CONFIG.
    const caseRoot = fs.mkdtempSync(path.join(root, "collision-"))
    const installed = fakeRuntime(path.join(caseRoot, "installed", "versions", "2", "runtime"))
    const candidate = fakeRuntime(path.join(caseRoot, "candidate", "versions", "row55-host", "runtime"))
    writeConfig(path.join(caseRoot, "home", ".config", "opencode", "opencode.json"), [installed])
    const overrideConfig = writeConfig(path.join(caseRoot, "sandbox", "opencode.json"), [candidate])
    const env = { HOME: path.join(caseRoot, "home"), OPENCODE_CONFIG: overrideConfig }

    // then: a two-runtime chain is an isolation violation, not a warning, and
    // the message points at the two runtimes the operator has to reconcile
    let refusal
    try {
      assertSingleRigelRuntimeInLaunch({ env })
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error)
    }
    expect(typeof refusal).toBe("string")
    expect(refusal).toContain("2 Rigel runtimes")
    expect(refusal).toContain(installed)
    expect(refusal).toContain(candidate)
  })

  test("#given one config source declaring one Rigel runtime #when the launch chain is audited #then it reports that single runtime", () => {
    const caseRoot = fs.mkdtempSync(path.join(root, "single-"))
    const runtime = fakeRuntime(path.join(caseRoot, "state", "versions", "row55-host", "runtime"))
    writeConfig(path.join(caseRoot, "home", ".config", "opencode", "opencode.json"), [runtime])

    const report = assertSingleRigelRuntimeInLaunch({ env: { HOME: path.join(caseRoot, "home") } })

    expect(report.runtimes).toEqual([path.resolve(runtime)])
  })

  test("#given a config that declares its runtime under the native plugins key #when the launch chain is audited #then the runtime is still counted", () => {
    // given: the installer now writes ONLY the native `plugins` key, so an audit
    // that reads the legacy `plugin` key alone would see zero runtimes and skip
    // the collision and goal-state agreement checks entirely.
    const caseRoot = fs.mkdtempSync(path.join(root, "native-key-"))
    const runtime = fakeRuntime(path.join(caseRoot, "state", "versions", "native", "runtime"))
    writeNativeConfig(path.join(caseRoot, "home", ".config", "opencode", "opencode.json"), [runtime])

    const report = assertSingleRigelRuntimeInLaunch({ env: { HOME: path.join(caseRoot, "home") } })

    expect(report.runtimes).toEqual([path.resolve(runtime)])
  })

  test("#given two native-key config sources that each declare a runtime #when the launch chain is audited #then it refuses", () => {
    const caseRoot = fs.mkdtempSync(path.join(root, "native-collision-"))
    const installed = fakeRuntime(path.join(caseRoot, "installed", "versions", "2", "runtime"))
    const candidate = fakeRuntime(path.join(caseRoot, "candidate", "versions", "candidate", "runtime"))
    writeNativeConfig(path.join(caseRoot, "home", ".config", "opencode", "opencode.json"), [installed])
    const overrideConfig = writeNativeConfig(path.join(caseRoot, "sandbox", "opencode.json"), [candidate])

    let refusal
    try {
      assertSingleRigelRuntimeInLaunch({ env: { HOME: path.join(caseRoot, "home"), OPENCODE_CONFIG: overrideConfig } })
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error)
    }
    expect(typeof refusal).toBe("string")
    expect(refusal).toContain("2 Rigel runtimes")
    expect(refusal).toContain(installed)
    expect(refusal).toContain(candidate)
  })

  test("#given a native object-form runtime entry #when the plugin list is resolved #then the package path is recognized", () => {
    const caseRoot = fs.mkdtempSync(path.join(root, "native-object-"))
    const runtime = fakeRuntime(path.join(caseRoot, "state", "versions", "native", "runtime"))

    const runtimes = rigelRuntimeEntries([{ package: runtime, options: { enabled: true } }])

    expect(runtimes).toEqual([path.resolve(runtime)])
  })

  test("#given the same runtime declared by two config sources #when the launch chain is audited #then it is counted once", () => {
    const caseRoot = fs.mkdtempSync(path.join(root, "same-"))
    const runtime = fakeRuntime(path.join(caseRoot, "state", "versions", "row55-host", "runtime"))
    writeConfig(path.join(caseRoot, "home", ".config", "opencode", "opencode.json"), [runtime])
    const override = writeConfig(path.join(caseRoot, "sandbox", "opencode.json"), [runtime])

    const report = assertSingleRigelRuntimeInLaunch({ env: { HOME: path.join(caseRoot, "home"), OPENCODE_CONFIG: override } })

    expect(report.runtimes).toEqual([path.resolve(runtime)])
  })

  test("#given a config whose Rigel entries are the vendored goal engine #when the chain is audited #then the goal engine is not counted as a runtime", () => {
    // given: opencode.json declares the goal engine as `[path, options]`, and the
    // goal engine directory has no `rigel-v2-native.mjs` marker of its own.
    const caseRoot = fs.mkdtempSync(path.join(root, "goal-"))
    const goalEngine = path.join(caseRoot, "state", "versions", "row55-host", "runtime", "rigel-goal-engine")
    fs.mkdirSync(goalEngine, { recursive: true })
    fs.writeFileSync(path.join(goalEngine, "server.js"), "export default {}\n")
    writeConfig(path.join(caseRoot, "home", ".config", "opencode", "opencode.json"), [[goalEngine, { auto_continue: true }]])

    const entries = rigelRuntimeEntries([[goalEngine, { auto_continue: true }]])
    const report = assertSingleRigelRuntimeInLaunch({ env: { HOME: path.join(caseRoot, "home") } })

    expect(entries).toEqual([])
    expect(report.runtimes).toEqual([])
  })

  test("#given the isolated launch environment #when its config sources are resolved #then only the sandbox config is reachable", () => {
    // given: the builder every harness is supposed to use
    const sandbox = fs.mkdtempSync(path.join(root, "sandbox-"))
    const env = buildIsolatedV2Env({ sandbox })
    writeConfig(path.join(path.resolve(sandbox), "config", "opencode", "opencode.json"), [])

    const sources = launchConfigSources({ env })
    const report = assertSingleRigelRuntimeInLaunch({ env })

    // then: the chain resolves ONE config file, inside the sandbox, with no
    // inherited override, so a launched host cannot merge a second runtime in
    expect(env.OPENCODE_CONFIG).toBeUndefined()
    expect(env.XDG_CONFIG_HOME.startsWith(path.resolve(sandbox))).toBe(true)
    expect(sources.map((source) => source.source)).toEqual([path.join(path.resolve(sandbox), "config", "opencode", "opencode.json")])
    expect(report.runtimes).toEqual([])
  })
})

describe("runtime identity", () => {
  test("#given a directory with the runtime marker #when it is classified #then it is a Rigel runtime", () => {
    const directory = fakeRuntime(path.join(root, "identity", "runtime"))
    expect(assertSingleRigelRuntime({ configs: [{ source: "x", plugins: [directory] }] }).runtimes).toEqual([path.resolve(directory)])
  })

  test("#given a plugin entry that is not a resolvable path #when it is classified #then it is ignored instead of throwing", () => {
    expect(rigelRuntimeEntries(["oc-codex-multi-auth", undefined, null, 42])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Row 55 host retest 3: a launch that loads the plugin with ZERO registrations
// ---------------------------------------------------------------------------
//
// The retest launched the candidate alone (one config source, one runtime) and
// still saw raw `/team-mode` text reach the model, no `team_create`, no panes.
// The host log carried the cause and the isolation proof did not:
//
//   WARN failed to load plugin plugin.id=oh-my-rigel
//     cause=goal state path <sandbox>/goal-state/goals.json
//           escapes the Rigel state root <sandbox>/rigel
//
// `buildIsolatedV2Env` emitted the goal state one directory ABOVE the state root
// the installer/runtime derive, so the runtime refused to bind it and setup died
// before any hook, tool or command was registered. These tests lock the missing
// agreement: an environment the builder hands out must be one the deployed
// runtime accepts, and a launch whose goal state escapes that root must be
// refused BEFORE the process starts.

describe("goal state must live inside the runtime's own state root (retest 3)", () => {
  test("#given the retest-3 launch env #when the launch is audited #then the escaping goal state is refused with the runtime's own wording", () => {
    // given: the exact retest-3 layout — install state root <case>/rigel, goal
    // state in <case>/goal-state (one level above the root the runtime derives)
    const caseRoot = fs.mkdtempSync(path.join(root, "retest3-"))
    const runtime = fakeRuntime(path.join(caseRoot, "rigel", "versions", "row55-retest3", "runtime"))
    writeConfig(path.join(caseRoot, "config", "opencode", "opencode.json"), [runtime])
    const env = buildIsolatedV2Env({ sandbox: caseRoot })
    env.OPENCODE_GOAL_STATE_PATH = path.join(caseRoot, "goal-state", "goals.json")

    // then: refused before launch, naming the escape and the consequence
    let refusal
    try {
      assertLaunchGoalStateMatchesRuntime({ env })
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error)
    }
    expect(refusal).toBeDefined()
    expect(refusal).toContain("escapes the Rigel state root")
    expect(refusal).toContain(path.join(caseRoot, "rigel"))
    expect(refusal).toContain("NO registrations")
  })

  test("#given the corrected launch env #when the launch is audited #then it reports the state root and the goal state inside it", () => {
    const caseRoot = fs.mkdtempSync(path.join(root, "retest3-ok-"))
    const stateRoot = path.join(caseRoot, "rigel")
    const runtime = fakeRuntime(path.join(stateRoot, "versions", "row55-retest3", "runtime"))
    writeConfig(path.join(caseRoot, "config", "opencode", "opencode.json"), [runtime])
    const env = buildIsolatedV2Env({ sandbox: caseRoot, rigelStateRoot: stateRoot })

    const audited = assertLaunchGoalStateMatchesRuntime({ env })

    expect(audited.stateRoots).toEqual([stateRoot])
    expect(audited.goalStatePath).toBe(path.join(stateRoot, "goal-state", "goals.json"))
    expect(audited.installedByRuntime).toBe(false)
  })

  test("#given the builder output for that install #when the DEPLOYED runtime binds the goal state #then the runtime's fail-closed guard accepts it", () => {
    // The contract that actually broke: builder output vs the runtime's own
    // binding. No mock: the real `installGoalStatePath` from the delivered module.
    const caseRoot = fs.mkdtempSync(path.join(root, "bind-"))
    const stateRoot = path.join(caseRoot, "rigel")
    const runtime = fakeRuntime(path.join(stateRoot, "versions", "row55-retest3", "runtime"))
    const env = buildIsolatedV2Env({ sandbox: caseRoot, rigelStateRoot: stateRoot })
    const runtimeUrl = pathToFileURL(path.join(runtime, "index.js")).href

    const bound = installGoalStatePath({ env: { ...env }, runtimeUrl, force: true })

    expect(bound).toBe(path.join(stateRoot, "goal-state", "goals.json"))
  })

  test("#given the escaped path retest 3 launched with #when the deployed runtime binds it #then it still fails closed (the guard is not weakened)", () => {
    const caseRoot = fs.mkdtempSync(path.join(root, "bind-refuse-"))
    const runtime = fakeRuntime(path.join(caseRoot, "rigel", "versions", "row55-retest3", "runtime"))
    const runtimeUrl = pathToFileURL(path.join(runtime, "index.js")).href
    const escaped = path.join(caseRoot, "goal-state", "goals.json")

    expect(() => installGoalStatePath({ env: { OPENCODE_GOAL_STATE_PATH: escaped }, runtimeUrl, force: true })).toThrow(/escapes the Rigel state root/)
  })

  test("#given the isolated env assertion and a known state root #when the goal state escapes it #then the assertion refuses", () => {
    const caseRoot = fs.mkdtempSync(path.join(root, "assert-root-"))
    const stateRoot = path.join(caseRoot, "rigel")
    const env = buildIsolatedV2Env({ sandbox: caseRoot, rigelStateRoot: stateRoot })
    env.OPENCODE_GOAL_STATE_PATH = path.join(caseRoot, "goal-state", "goals.json")

    expect(() => assertIsolatedV2Env(env, { sandbox: caseRoot, rigelStateRoot: stateRoot })).toThrow(/escapes the Rigel state root/)
    expect(assertGoalStateInsideRigelStateRoot(path.join(stateRoot, "goal-state", "goals.json"), stateRoot)).toBe(path.join(stateRoot, "goal-state", "goals.json"))
  })

  test("#given the default isolated env #when the installer's default root is used #then the goal state is inside it", () => {
    const caseRoot = fs.mkdtempSync(path.join(root, "default-root-"))
    const env = buildIsolatedV2Env({ sandbox: caseRoot })
    const stateRoot = path.join(caseRoot, "data", "oh-my-rigel")

    expect(env.RIGEL_V2_USER_ROOT).toBe(stateRoot)
    expect(env.OPENCODE_GOAL_STATE_PATH).toBe(path.join(stateRoot, "goal-state", "goals.json"))
    // and the installer's default state root is exactly where the runtime expects it
    expect(assertGoalStateInsideRigelStateRoot(env.OPENCODE_GOAL_STATE_PATH, env.RIGEL_V2_USER_ROOT)).toBe(env.OPENCODE_GOAL_STATE_PATH)
  })

  test("#given an inherited RIGEL_V2_USER_ROOT #when the env is built #then the inherited install root is replaced, not honored", () => {
    const caseRoot = fs.mkdtempSync(path.join(root, "inherit-root-"))
    const previous = process.env.RIGEL_V2_USER_ROOT
    process.env.RIGEL_V2_USER_ROOT = path.join(os.homedir(), "oh-my-rigel")
    try {
      const env = buildIsolatedV2Env({ sandbox: caseRoot })
      expect(env.RIGEL_V2_USER_ROOT.startsWith(path.resolve(caseRoot))).toBe(true)
      expect(env.__rigelStrippedEnvKeys).toContain("RIGEL_V2_USER_ROOT")
    } finally {
      if (previous === undefined) delete process.env.RIGEL_V2_USER_ROOT
      else process.env.RIGEL_V2_USER_ROOT = previous
    }
  })

  test("#given an inherited install root INSIDE the sandbox #when the env is built #then it is honored and the goal state follows it", () => {
    // A harness that already selected `<sandbox>/rigel` (the retest-3 install
    // layout) keeps it: the builder aligns the goal state instead of silently
    // moving the install root somewhere the harness did not ask for.
    const caseRoot = fs.mkdtempSync(path.join(root, "inherit-inside-"))
    const stateRoot = path.join(caseRoot, "rigel")
    const previous = process.env.RIGEL_V2_USER_ROOT
    process.env.RIGEL_V2_USER_ROOT = stateRoot
    try {
      const env = buildIsolatedV2Env({ sandbox: caseRoot })
      expect(env.RIGEL_V2_USER_ROOT).toBe(stateRoot)
      expect(env.OPENCODE_GOAL_STATE_PATH).toBe(path.join(stateRoot, "goal-state", "goals.json"))
    } finally {
      if (previous === undefined) delete process.env.RIGEL_V2_USER_ROOT
      else process.env.RIGEL_V2_USER_ROOT = previous
    }
  })

  test("#given a runtime path that is not a deployed runtime #when its state root is derived #then there is none", () => {
    expect(rigelStateRootFromRuntime(path.join(root, "rigel", "versions", "v1", "runtime"))).toBe(path.join(root, "rigel"))
    expect(rigelStateRootFromRuntime(path.join(root, "source", "profiles", "gabo", "opencode"))).toBeUndefined()
    expect(rigelStateRootFromRuntime(undefined)).toBeUndefined()
  })
})
