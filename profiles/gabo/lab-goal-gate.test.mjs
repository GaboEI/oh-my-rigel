import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { detectGoalMode, probeGoalState, verifyGoalInvariant, readGoalConfig, internalGoalEnabled } from "./lab-goal-gate.mjs"

const createdHomes = []
const gatePath = fileURLToPath(new URL("./lab-goal-gate.mjs", import.meta.url))

const managedConfigs = {
  "opencode.json": `{"plugin":[["/state/versions/1/runtime/rigel-goal-engine",{"auto_continue":true}]]}`,
  "tui.json": "{}",
  "cli.json": `{"plugins":["-opencode.goal",{"package":"/state/versions/1/runtime/rigel-goal-tui"}]}`,
}

afterEach(() => {
  while (createdHomes.length > 0) {
    fs.rmSync(createdHomes.pop(), { recursive: true, force: true })
  }
})

function makeHome({ configs = {}, omoGoalEnabled = null, stateDirs = [], cacheDirs = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-goal-gate-"))
  createdHomes.push(home)
  const cfgDir = path.join(home, ".config/opencode")
  fs.mkdirSync(cfgDir, { recursive: true })
  for (const [name, content] of Object.entries(configs)) {
    fs.writeFileSync(path.join(cfgDir, name), content)
  }
  if (omoGoalEnabled !== null) {
    fs.mkdirSync(path.join(home, ".omo"), { recursive: true })
    const goal = omoGoalEnabled ? ', "goal": { "enabled": true }' : ', "goal": { "enabled": false }'
    fs.writeFileSync(path.join(home, ".omo/omo.jsonc"), `{ "models": {}\n${goal}\n}\n`)
  }
  for (const rel of stateDirs) fs.mkdirSync(path.join(home, rel), { recursive: true })
  for (const rel of cacheDirs) fs.mkdirSync(path.join(home, rel), { recursive: true })
  return home
}

function detectModeAtCliBoundary(home, overrides = {}) {
  const env = { ...process.env, HOME: home }
  for (const name of ["RIGEL_V2_CONFIG", "RIGEL_V2_USER_ROOT", "OPENCODE_GOAL_STATE_PATH", "XDG_DATA_HOME"]) delete env[name]
  Object.assign(env, overrides)
  const result = spawnSync(process.execPath, [gatePath, "--mode", home], { encoding: "utf8", env })
  expect(result.status).toBe(0)
  expect(result.stderr).toBe("")
  return result.stdout
}

describe("Rigel lab goal gate: mode detection", () => {
  test("#given the former internal-only shape #when detecting #then it fails closed as unknown", () => {
    const home = makeHome({ configs: { "opencode.json": "{}", "tui.json": "{}", "cli.json": "{}" }, omoGoalEnabled: true })
    expect(detectGoalMode(home).mode).toBe("unknown")
  })

  test("#given the external plugin referenced in opencode.json #when detecting #then mode is legacy", () => {
    const home = makeHome({ configs: { "opencode.json": `{"plugin":["@prevalentware/opencode-goal-plugin@latest"]}` }, omoGoalEnabled: true })
    expect(detectGoalMode(home).mode).toBe("legacy")
  })

  test("#given the retired plugin referenced only in cli.json #when detecting #then mode is legacy", () => {
    const home = makeHome({ configs: { "opencode.json": "{}", "cli.json": `{"plugins":["@prevalentware/opencode-goal-plugin@latest"]}` }, omoGoalEnabled: true })
    expect(detectGoalMode(home).mode).toBe("legacy")
  })

  test("#given the external state directory present #when detecting #then mode is legacy", () => {
    const home = makeHome({ configs: { "opencode.json": "{}" }, omoGoalEnabled: true, stateDirs: [".local/share/opencode-goal-plugin"] })
    expect(detectGoalMode(home).mode).toBe("legacy")
  })

  test("#given the exact retired cache path present #when detecting #then mode is legacy", () => {
    const home = makeHome({ configs: { "opencode.json": "{}" }, omoGoalEnabled: true, cacheDirs: [".cache/opencode/packages/@prevalentware/opencode-goal-plugin@latest"] })
    expect(detectGoalMode(home).mode).toBe("legacy")
  })

  test("#given one server shim, one CLI shim, and the builtin-disable marker #when detecting #then mode is managed", () => {
    const home = makeHome({ configs: managedConfigs })
    const stateRoot = path.join(home, ".local", "share", "oh-my-rigel")
    const detected = detectGoalMode(home, { stateRoot })
    expect(detected.mode).toBe("managed")
    expect(detected.managed).toEqual({
      serverEntries: 1,
      cliEntries: 1,
      goalMarkerCount: 1,
      goalStatePath: path.join(stateRoot, "goal-state", "goals.json"),
      configuredGoalStatePath: path.join(stateRoot, "goal-state", "goals.json"),
      goalStatePathMatchesRoot: true,
    })
  })

  test("#given a managed install without optional tui.json #when detecting #then mode is managed", () => {
    const { "tui.json": _optionalTui, ...configs } = managedConfigs
    const home = makeHome({ configs })

    expect(detectGoalMode(home).mode).toBe("managed")
  })

  test("#given an XDG-rooted managed install #when the CLI gate resolves state #then it accepts the XDG state root", () => {
    const home = makeHome({ configs: managedConfigs })
    const xdgDataHome = path.join(home, "xdg-data")
    const goalStatePath = path.join(xdgDataHome, "oh-my-rigel", "goal-state", "goals.json")

    expect(detectModeAtCliBoundary(home, { XDG_DATA_HOME: xdgDataHome, OPENCODE_GOAL_STATE_PATH: goalStatePath })).toBe("managed")
  })

  test("#given RIGEL_V2_USER_ROOT and XDG_DATA_HOME #when the CLI gate resolves state #then RIGEL_V2_USER_ROOT wins", () => {
    const home = makeHome({ configs: managedConfigs })
    const stateRoot = path.join(home, "rigel-state")

    expect(detectModeAtCliBoundary(home, {
      RIGEL_V2_USER_ROOT: stateRoot,
      XDG_DATA_HOME: path.join(home, "wrong-xdg-data"),
      OPENCODE_GOAL_STATE_PATH: path.join(stateRoot, "goal-state", "goals.json"),
    })).toBe("managed")
  })

  test("#given a noncanonical Goal state path inside the configured root #when detecting #then mode is unknown", () => {
    const home = makeHome({ configs: managedConfigs })
    const stateRoot = path.join(home, ".local", "share", "oh-my-rigel")
    const detected = detectGoalMode(home, { stateRoot, goalStatePath: path.join(stateRoot, "goal-state", "other-goals.json") })
    expect(detected.mode).toBe("unknown")
    expect(detected.managed.goalStatePathMatchesRoot).toBe(false)
  })

  test("#given a Goal state path outside the configured root #when detecting #then mode is unknown", () => {
    const home = makeHome({ configs: managedConfigs })
    const stateRoot = path.join(home, ".local", "share", "oh-my-rigel")
    const detected = detectGoalMode(home, { stateRoot, goalStatePath: path.join(home, "outside", "goals.json") })
    expect(detected.mode).toBe("unknown")
    expect(detected.managed.goalStatePathMatchesRoot).toBe(false)
  })

  test("#given an explicitly missing Goal state path #when detecting #then mode is unknown", () => {
    const home = makeHome({ configs: managedConfigs })
    const detected = detectGoalMode(home, { goalStatePath: undefined })
    expect(detected.mode).toBe("unknown")
    expect(detected.managed.goalStatePathMatchesRoot).toBe(false)
  })

  test("#given a missing config file #when detecting #then mode is unknown, never internal", () => {
    const home = makeHome({ configs: { "opencode.json": "{}", "tui.json": "{}" }, omoGoalEnabled: true })
    expect(detectGoalMode(home).mode).toBe("unknown")
  })

  test("#given an unreadable required config #when detecting #then mode is unknown", () => {
    for (const requiredConfig of ["opencode.json", "cli.json"]) {
      const home = makeHome({ configs: managedConfigs })
      const configPath = path.join(home, ".config/opencode", requiredConfig)
      fs.rmSync(configPath)
      fs.mkdirSync(configPath)

      expect(detectGoalMode(home).mode).toBe("unknown")
    }
  })

  test("#given a malformed required config #when detecting #then mode is unknown", () => {
    for (const requiredConfig of ["opencode.json", "cli.json"]) {
      const home = makeHome({ configs: { ...managedConfigs, [requiredConfig]: "{" } })

      expect(detectGoalMode(home).mode).toBe("unknown")
    }
  })

  test("#given no complete managed shim shape #when detecting #then mode is unknown", () => {
    const home = makeHome({ configs: { "opencode.json": "{}", "tui.json": "{}", "cli.json": "{}" }, omoGoalEnabled: false })
    expect(detectGoalMode(home).mode).toBe("unknown")
  })

  test("#given a shim shape without the builtin-disable marker #when detecting #then mode is unknown", () => {
    const home = makeHome({
      configs: {
        "opencode.json": `{"plugin":[["/state/versions/1/runtime/rigel-goal-engine",{}]]}`,
        "tui.json": "{}",
        "cli.json": `{"plugins":[{"package":"/state/versions/1/runtime/rigel-goal-tui"}]}`,
      },
    })
    expect(detectGoalMode(home).mode).toBe("unknown")
  })
})

describe("Rigel lab goal gate: probe and invariant", () => {
  test("#given the retired goals.json is absent #when probing #then it reports absent", () => {
    const home = makeHome({ configs: { "opencode.json": "{}" } })
    expect(probeGoalState(home)).toEqual({ present: false, version: null, count: 0 })
  })

  test("#given managed mode #when the retired V1 goals.json stays absent #then the invariant passes", () => {
    const verdict = verifyGoalInvariant("managed", { present: false, version: null, count: 0 }, { present: false, version: null, count: 0 })
    expect(verdict.pass).toBe(true)
  })

  test("#given managed mode #when the retired V1 goals.json appears #then the invariant fails", () => {
    const verdict = verifyGoalInvariant("managed", { present: false, version: null, count: 0 }, { present: true, version: "2", count: 1 })
    expect(verdict.pass).toBe(false)
    expect(verdict.reason).toContain("managed goal mode")
  })

  test("#given legacy mode with schema 1 unchanged #when verifying #then it passes", () => {
    const verdict = verifyGoalInvariant("legacy", { present: true, version: "1", count: 4 }, { present: true, version: "1", count: 4 })
    expect(verdict.pass).toBe(true)
  })

  test("#given legacy mode with a schema bump #when verifying #then it fails", () => {
    const verdict = verifyGoalInvariant("legacy", { present: true, version: "1", count: 4 }, { present: true, version: "2", count: 4 })
    expect(verdict.pass).toBe(false)
    expect(verdict.reason).toContain("version 1")
  })

  test("#given legacy mode with the goals.json missing #when verifying #then it fails", () => {
    const verdict = verifyGoalInvariant("legacy", { present: false, version: null, count: 0 }, { present: false, version: null, count: 0 })
    expect(verdict.pass).toBe(false)
  })

  test("#given unknown mode #when verifying #then it fails loudly", () => {
    const verdict = verifyGoalInvariant("unknown", { present: false, version: null, count: 0 }, { present: false, version: null, count: 0 })
    expect(verdict.pass).toBe(false)
    expect(verdict.reason).toContain("unknown goal mode")
  })
})

describe("Rigel lab goal gate: probing an existing goals.json", () => {
  test("#given an external goals.json with schema 1 and two goals #when probing #then version and count are read", () => {
    const home = makeHome({})
    const file = path.join(home, "goals.json")
    fs.writeFileSync(file, JSON.stringify({ version: 1, goals: { a: {}, b: {} } }))
    expect(probeGoalState(home, file)).toEqual({ present: true, version: "1", count: 2 })
  })
})

describe("Rigel lab goal gate: reference detection", () => {
  test("#given a config with the retired plugin package #when scanning #then it is readable and referenced", () => {
    const home = makeHome({ configs: { "opencode.json": `{"plugin":["@prevalentware/opencode-goal-plugin@latest"]}` } })
    expect(readGoalConfig(path.join(home, ".config/opencode/opencode.json"))).toEqual({ readable: true, referenced: true, managed: false, plugins: ["@prevalentware/opencode-goal-plugin@latest"] })
  })

  test("#given a missing config #when scanning #then it is not readable", () => {
    const home = makeHome({})
    expect(readGoalConfig(path.join(home, ".config/opencode/tui.json"))).toEqual({ readable: false, referenced: false, managed: false, missing: true })
  })

  test("#given internal goal enabled in JSONC with comments #when parsing #then it is true", () => {
    const home = makeHome({})
    fs.mkdirSync(path.join(home, ".omo"), { recursive: true })
    fs.writeFileSync(path.join(home, ".omo/omo.jsonc"), `{\n  // comment\n  "goal": { "enabled": true, },\n}\n`)
    expect(internalGoalEnabled(path.join(home, ".omo/omo.jsonc"))).toBe(true)
  })
})
