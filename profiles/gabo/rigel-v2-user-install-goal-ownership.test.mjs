/**
 * Lifecycle owner test for Goal ownership. It drives the real installer against
 * isolated paths and fails if any lifecycle command duplicates or leaves behind
 * the host-builtin disable marker or either Rigel Goal shim.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { DISABLED_BUILTIN_GOAL, isGoalEngineEntry, pluginEntrySpec } from "./rigel-v2-goal-registration.mjs"

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(moduleDirectory, "../..")
const installerPath = path.join(repoRoot, "profiles/gabo/rigel-v2-user-install.mjs")
const base = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-goal-ownership-"))
const home = path.join(base, "home")
const configFile = path.join(base, "config", "opencode", "opencode.json")
const cliFile = path.join(path.dirname(configFile), "cli.json")
const stateRoot = path.join(base, "state")

function environment() {
  return {
    PATH: process.env.PATH,
    HOME: path.join(base, "installer-home"),
    XDG_CONFIG_HOME: path.join(base, "xdg", "config"),
    XDG_DATA_HOME: path.join(base, "xdg", "data"),
    XDG_STATE_HOME: path.join(base, "xdg", "state"),
    XDG_CACHE_HOME: path.join(base, "xdg", "cache"),
    OMO_DISABLE_PROCESS_CLEANUP: "1",
    RIGEL_V2_SG_PROVISION: "0",
    ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
  }
}

function run(command, ...args) {
  return spawnSync(
    "node",
    [installerPath, command, ...args, "--home", home, "--state", stateRoot, "--config", configFile, "--json"],
    { cwd: repoRoot, env: environment(), encoding: "utf8", timeout: 300_000 },
  )
}

function read(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

function assertManagedGoal(version) {
  const runtime = path.join(stateRoot, "versions", version, "runtime")
  const config = read(configFile)
  const cli = read(cliFile)
  const serverEntries = config.plugins.filter(isGoalEngineEntry)
  const cliEntries = cli.plugins.filter(isGoalEngineEntry)
  expect(serverEntries).toHaveLength(1)
  expect(cliEntries).toHaveLength(1)
  expect(Array.isArray(serverEntries[0])).toBe(false)
  expect(serverEntries[0].options).toBeDefined()
  expect(pluginEntrySpec(serverEntries[0])).toBe(path.join(runtime, "rigel-goal-engine"))
  expect(pluginEntrySpec(cliEntries[0])).toBe(path.join(runtime, "rigel-goal-tui"))
  expect(config.plugins.filter((entry) => entry === DISABLED_BUILTIN_GOAL)).toHaveLength(1)
  expect(cli.plugins.filter((entry) => entry === DISABLED_BUILTIN_GOAL)).toHaveLength(1)
}

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe("Rigel Goal ownership lifecycle", () => {
  test("#given a clean isolated installation #when install, reinstall, rollback, and uninstall run #then the managed Goal shape converges and is removed reversibly", () => {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(configFile, `${JSON.stringify({ plugin: ["foreign-server.mjs"] }, null, 2)}\n`, { mode: 0o600 })
    fs.writeFileSync(cliFile, `${JSON.stringify({ plugins: ["foreign-cli.mjs"] }, null, 2)}\n`, { mode: 0o600 })

    const install = run("install", "--version", "1")
    expect(install.status, install.stderr || install.stdout).toBe(0)
    expect(JSON.parse(install.stdout).status.pass).toBe(true)
    assertManagedGoal("1")

    const installedConfig = read(configFile)
    const malformedConfig = structuredClone(installedConfig)
    malformedConfig.plugins = malformedConfig.plugins.map((entry) => isGoalEngineEntry(entry) ? [entry.package, entry.options] : entry)
    fs.writeFileSync(configFile, `${JSON.stringify(malformedConfig, null, 2)}\n`, { mode: 0o600 })
    const malformedStatus = run("status")
    expect(malformedStatus.status, malformedStatus.stderr || malformedStatus.stdout).toBe(1)
    const malformedChecks = Object.fromEntries(JSON.parse(malformedStatus.stdout).checks.map((check) => [check.name, check.pass]))
    expect(malformedChecks["config.hostValidPluginShapes"]).toBe(false)
    fs.writeFileSync(configFile, `${JSON.stringify(installedConfig, null, 2)}\n`, { mode: 0o600 })

    const reinstall = run("install", "--version", "1")
    expect(reinstall.status, reinstall.stderr || reinstall.stdout).toBe(0)
    expect(JSON.parse(reinstall.stdout).status.pass).toBe(true)
    assertManagedGoal("1")

    const upgrade = run("upgrade", "--version", "2")
    expect(upgrade.status, upgrade.stderr || upgrade.stdout).toBe(0)
    expect(JSON.parse(upgrade.stdout).status.pass).toBe(true)
    assertManagedGoal("2")

    const rollback = run("rollback")
    expect(rollback.status, rollback.stderr || rollback.stdout).toBe(0)
    expect(JSON.parse(rollback.stdout).status.pass).toBe(true)
    assertManagedGoal("1")

    const uninstall = run("uninstall")
    expect(uninstall.status, uninstall.stderr || uninstall.stdout).toBe(0)
    const config = read(configFile)
    const cli = read(cliFile)
    expect(config.plugin).toBeUndefined()
    expect(config.plugins).toEqual(["foreign-server.mjs"])
    expect(cli.plugins).toEqual(["foreign-cli.mjs"])
  }, 1_200_000)
})
