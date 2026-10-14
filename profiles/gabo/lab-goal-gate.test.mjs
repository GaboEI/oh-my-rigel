import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { detectGoalMode, probeGoalState, verifyGoalInvariant, readGoalConfig, internalGoalEnabled } from "./lab-goal-gate.mjs"

const createdHomes = []

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

describe("Rigel lab goal gate: mode detection", () => {
  test("#given the external plugin absent and internal goal enabled #when detecting #then mode is internal", () => {
    const home = makeHome({ configs: { "opencode.json": "{}", "tui.json": "{}", "cli.json": "{}" }, omoGoalEnabled: true })
    expect(detectGoalMode(home).mode).toBe("internal")
  })

  test("#given the external plugin referenced in opencode.json #when detecting #then mode is legacy", () => {
    const home = makeHome({ configs: { "opencode.json": `{"plugin":["@prevalentware/opencode-goal-plugin@latest"]}` }, omoGoalEnabled: true })
    expect(detectGoalMode(home).mode).toBe("legacy")
  })

  test("#given the external plugin referenced only in cli.json #when detecting #then mode is legacy", () => {
    const home = makeHome({ configs: { "opencode.json": "{}", "cli.json": `{"allow_goal_execution_from_plan":false}` }, omoGoalEnabled: true })
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

  test("#given the vendored managed engine referenced #when detecting #then mode is managed, not legacy", () => {
    const home = makeHome({
      configs: { "opencode.json": `{"plugin":[["/state/versions/1/runtime/vendor/opencode-goal-plugin/node_modules/@prevalentware/opencode-goal-plugin/dist/server.js",{"auto_continue":true}]]}` },
      omoGoalEnabled: true,
    })
    expect(detectGoalMode(home).mode).toBe("managed")
  })

  test("#given a missing config file #when detecting #then mode is unknown, never internal", () => {
    const home = makeHome({ configs: { "opencode.json": "{}", "tui.json": "{}" }, omoGoalEnabled: true })
    expect(detectGoalMode(home).mode).toBe("unknown")
  })

  test("#given an unreadable config file #when detecting #then mode is unknown, never internal", () => {
    const home = makeHome({ configs: { "opencode.json": "{}", "tui.json": "{}" }, omoGoalEnabled: true })
    fs.mkdirSync(path.join(home, ".config/opencode/cli.json"))
    expect(detectGoalMode(home).mode).toBe("unknown")
  })

  test("#given neither external plugin nor internal goal #when detecting #then mode is unknown", () => {
    const home = makeHome({ configs: { "opencode.json": "{}", "tui.json": "{}", "cli.json": "{}" }, omoGoalEnabled: false })
    expect(detectGoalMode(home).mode).toBe("unknown")
  })
})

describe("Rigel lab goal gate: probe and invariant", () => {
  test("#given an internal-mode home with no external goals.json #when probing #then it reports absent", () => {
    const home = makeHome({ configs: { "opencode.json": "{}" }, omoGoalEnabled: true })
    expect(probeGoalState(home)).toEqual({ present: false, version: null, count: 0 })
  })

  test("#given internal mode #when the external goals.json stays absent #then the invariant passes", () => {
    const verdict = verifyGoalInvariant("internal", { present: false, version: null, count: 0 }, { present: false, version: null, count: 0 })
    expect(verdict.pass).toBe(true)
  })

  test("#given internal mode #when an external goals.json appears #then the invariant fails", () => {
    const verdict = verifyGoalInvariant("internal", { present: false, version: null, count: 0 }, { present: true, version: "1", count: 1 })
    expect(verdict.pass).toBe(false)
    expect(verdict.reason).toContain("internal goal mode")
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
  test("#given a config with the plugin package #when scanning #then it is readable and referenced", () => {
    const home = makeHome({ configs: { "opencode.json": `["@prevalentware/opencode-goal-plugin@latest"]` } })
    expect(readGoalConfig(path.join(home, ".config/opencode/opencode.json"))).toEqual({ readable: true, referenced: true, managed: false })
  })

  test("#given a missing config #when scanning #then it is not readable", () => {
    const home = makeHome({})
    expect(readGoalConfig(path.join(home, ".config/opencode/tui.json"))).toEqual({ readable: false, referenced: false, managed: false })
  })

  test("#given internal goal enabled in JSONC with comments #when parsing #then it is true", () => {
    const home = makeHome({})
    fs.mkdirSync(path.join(home, ".omo"), { recursive: true })
    fs.writeFileSync(path.join(home, ".omo/omo.jsonc"), `{\n  // comment\n  "goal": { "enabled": true, },\n}\n`)
    expect(internalGoalEnabled(path.join(home, ".omo/omo.jsonc"))).toBe(true)
  })
})
