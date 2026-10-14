/**
 * Transactional adoption contract for the goal state (PR B).
 *
 * `installVersion` may adopt a compatible external state into
 * `<stateRoot>/goal-state/goals.json` (opt-in via `RIGEL_V2_GOAL_ADOPT_FROM`).
 * That file is part of the lifecycle transaction: a failure AFTER adoption must
 * restore a pre-existing file byte-identically, or remove one that was absent.
 *
 * Real fault injection (`RIGEL_V2_FAIL_AT`) drives the failure at the install /
 * upgrade boundary that runs after adoption, and the external source is asserted
 * byte-identical throughout.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(moduleDirectory, "../..")
const installerPath = path.join(repoRoot, "profiles/gabo/rigel-v2-user-install.mjs")

const base = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-goal-txn-"))
const home = path.join(base, "home")
const configFile = path.join(base, "config", "opencode", "opencode.json")
const stateRoot = path.join(base, "state")
const goalStateFile = path.join(stateRoot, "goal-state", "goals.json")
const externalSource = path.join(base, "external", "goals.json")
const externalBytes = Buffer.from(`${JSON.stringify({ version: 3, goals: { adopted: { objective: "external" } } }, null, 2)}\n`)

fs.mkdirSync(home, { recursive: true, mode: 0o700 })
fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 })
fs.mkdirSync(path.dirname(externalSource), { recursive: true, mode: 0o700 })
fs.writeFileSync(configFile, `${JSON.stringify({ plugin: ["rigel-foreign-plugin"] }, null, 2)}\n`, { mode: 0o600 })
fs.writeFileSync(externalSource, externalBytes, { mode: 0o600 })

function runCommand(command, args, extraEnv = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: path.join(base, "installer-home"),
    XDG_CONFIG_HOME: path.join(base, "xdg", "config"),
    XDG_DATA_HOME: path.join(base, "xdg", "data"),
    XDG_STATE_HOME: path.join(base, "xdg", "state"),
    XDG_CACHE_HOME: path.join(base, "xdg", "cache"),
    OMO_DISABLE_PROCESS_CLEANUP: "1",
    RIGEL_V2_GOAL_ADOPT_FROM: externalSource,
    ...extraEnv,
  }
  if (process.env.TMPDIR !== undefined) env.TMPDIR = process.env.TMPDIR
  return spawnSync("node", [installerPath, command, ...args, "--json"], { cwd: repoRoot, env, encoding: "utf8", timeout: 240_000 })
}

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe("#given a pre-existing goal state and a compatible external source", () => {
  test("#when install fails after adoption #then the pre-existing target is restored byte-for-byte and the source is untouched", () => {
    const preexisting = Buffer.from(`${JSON.stringify({ version: 3, goals: { prior: { objective: "keep me" } } }, null, 2)}\n`)
    fs.mkdirSync(path.dirname(goalStateFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(goalStateFile, preexisting, { mode: 0o600 })

    const install = runCommand("install", ["--version", "1", "--home", home, "--config", configFile, "--state", stateRoot], { RIGEL_V2_FAIL_AT: "install:after-runtime" })

    expect(install.status, `expected a failed install, got: ${install.stdout}`).not.toBe(0)
    expect(fs.readFileSync(goalStateFile)).toEqual(preexisting)
    expect(fs.readFileSync(externalSource)).toEqual(externalBytes)
  }, 300_000)
})

describe("#given no pre-existing goal state and a compatible external source", () => {
  test("#when install fails after adoption #then the adopted target is removed and the source is untouched", () => {
    fs.rmSync(goalStateFile, { force: true })

    const install = runCommand("install", ["--version", "1", "--home", home, "--config", configFile, "--state", stateRoot], { RIGEL_V2_FAIL_AT: "install:after-state" })

    expect(install.status, `expected a failed install, got: ${install.stdout}`).not.toBe(0)
    expect(fs.existsSync(goalStateFile)).toBe(false)
    expect(fs.readFileSync(externalSource)).toEqual(externalBytes)
  }, 300_000)
})

describe("#given a successful install and a pre-existing goal state", () => {
  test("#when upgrade fails after adoption #then the pre-existing target is restored byte-for-byte (upgrade shares the path)", () => {
    const install = runCommand("install", ["--version", "1", "--home", home, "--config", configFile, "--state", stateRoot], {})
    expect(install.status, `install failed: ${install.stderr || install.stdout}`).toBe(0)

    const preexisting = Buffer.from(`${JSON.stringify({ version: 3, goals: { prior: { objective: "v1 state" } } }, null, 2)}\n`)
    fs.mkdirSync(path.dirname(goalStateFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(goalStateFile, preexisting, { mode: 0o600 })

    const upgrade = runCommand("upgrade", ["--version", "2", "--home", home, "--config", configFile, "--state", stateRoot], { RIGEL_V2_FAIL_AT: "upgrade:after-runtime" })

    expect(upgrade.status, `expected a failed upgrade, got: ${upgrade.stdout}`).not.toBe(0)
    expect(fs.readFileSync(goalStateFile)).toEqual(preexisting)
    expect(fs.readFileSync(externalSource)).toEqual(externalBytes)
  }, 300_000)
})
