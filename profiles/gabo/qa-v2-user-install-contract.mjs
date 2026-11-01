#!/usr/bin/env node
/**
 * A03 / A04 / A11 user-installation contract (P2-1 closure).
 *
 * Drives `rigel-v2-user-install.mjs` exactly as a new user would on an isolated
 * HOME/XDG: clean install from source, first operation, idempotent reinstall,
 * upgrade between two real runtime versions with state migration, rollback to the
 * previous version (byte-identical), and bounded uninstall that preserves foreign
 * data. It never launches OpenCode, never uses Docker or `--standalone`, and
 * refuses to run if the isolated roots resolve under V1.
 *
 * Not a laboratory harness: the installer is the productized user route; the
 * laboratory wrapper is only re-exercised separately by the lab acceptance.
 */
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { buildProtectedManifest, diffProtectedManifests } from "./v1-protected-surfaces.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const installer = path.join(root, "profiles/gabo/rigel-v2-user-install.mjs")
const evidenceDir = path.join(root, ".omo/evidence/20261008-production-readiness/rotation4-user-install")
const checks = []
const created = []

function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? "" : String(detail) })
}
function sha(file) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") } catch { return null }
}
function run(args, options = {}) {
  return spawnSync(process.execPath, [installer, ...args], { cwd: root, encoding: "utf8", timeout: 180_000, ...options, env: { ...process.env, RIGEL_V2_SG_PROVISION: "0" } })
}
function runJson(args, options = {}) {
  const result = run(args, options)
  let json = null
  try { json = JSON.parse(result.stdout) } catch { /* reported by caller */ }
  return { result, json }
}
function stripVolatile(state) {
  if (Array.isArray(state)) return state.map(stripVolatile)
  if (state && typeof state === "object") {
    return Object.fromEntries(Object.entries(state).filter(([key]) => !["installedAt", "updatedAt", "generatedAt", "at"].includes(key)).map(([key, item]) => [key, stripVolatile(item)]))
  }
  return state
}
function readCli(file) { return JSON.parse(fs.readFileSync(file, "utf8")) }
function cliFamily(cli) {
  return (Array.isArray(cli.plugins) ? cli.plugins : []).filter((entry) => entry && typeof entry === "object" && typeof entry.package === "string" && entry.package.includes("/versions/"))
}
function cliMarkerCount(cli) { return (Array.isArray(cli.plugins) ? cli.plugins : []).filter((entry) => entry === "-opencode.notifications").length }
/** One plugin specifier: bare string, legacy `[spec, options]` tuple, or native `{package, options}` object. */
function pluginSpec(entry) {
  if (typeof entry === "string") return entry
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0]
  if (entry && typeof entry === "object" && typeof entry.package === "string") return entry.package
  return undefined
}
/**
 * Effective server plugin specifiers of a config document. The installer writes
 * the native `plugins` key and drops `plugin`, so a reader that only looks at
 * `plugin` sees nothing after the first install. Order mirrors the host
 * normalizer: legacy entries first, then native ones.
 */
function configPluginSpecs(config) {
  const legacy = Array.isArray(config?.plugin) ? config.plugin : []
  const native = Array.isArray(config?.plugins) ? config.plugins : []
  return [...legacy, ...native].map(pluginSpec).filter((spec) => typeof spec === "string")
}

const v1Config = path.join(os.homedir(), ".config", "opencode", "opencode.json")
const v1Before = { config: sha(v1Config), protected: buildProtectedManifest(os.homedir()) }

try {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-user-install-"))
  created.push(base)
  const home = path.join(base, "home")
  const configDir = path.join(base, "config", "opencode")
  const configFile = path.join(configDir, "opencode.json")
  const stateRoot = path.join(base, "state")
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  fs.writeFileSync(configFile, `${JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "rigel-fixture/fixture", plugin: ["rigel-foreign-plugin"] }, null, 2)}\n`, { mode: 0o600 })
  const cliFile = path.join(configDir, "cli.json")
  fs.writeFileSync(cliFile, `${JSON.stringify({ plugins: ["rigel-foreign-cli-plugin"] }, null, 2)}\n`, { mode: 0o600 })
  fs.writeFileSync(path.join(stateRoot, "foreign-note.txt"), "user data\n", { mode: 0o600, flag: "w" })
  const foreignSkillDir = path.join(home, ".agents", "skills", "foreign-user-skill")
  fs.mkdirSync(foreignSkillDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(foreignSkillDir, "SKILL.md"), "---\nname: foreign-user-skill\n---\n", { mode: 0o600 })
  const common = ["--home", home, "--config", configFile, "--state", stateRoot, "--json"]

  // Two REAL runtime versions: v2 is v1 plus a real extra module wired into the
  // server entrypoint, so the upgrade installs different bytes and the rollback
  // returns to v1's exact tree, not a re-materialization.
  const v1Source = path.join(base, "runtime-v1")
  const v2Source = path.join(base, "runtime-v2")
  fs.cpSync(path.join(root, "profiles/gabo/opencode"), v1Source, { recursive: true })
  fs.cpSync(v1Source, v2Source, { recursive: true })
  fs.writeFileSync(path.join(v2Source, "rigel-v2-upgrade-probe.mjs"), "export const RIGEL_V2_UPGRADE_PROBE = \"v2\"\n", { mode: 0o600 })
  fs.appendFileSync(path.join(v2Source, "rigel-v2-native.mjs"), "\nexport * from \"./rigel-v2-upgrade-probe.mjs\"\n")

  // ------------------------------------------------------------ clean install
  const install = runJson(["install", "--version", "1", "--runtime-source", v1Source, ...common])
  check("A03.install.exitZero", install.result.status === 0, install.result.stderr?.slice(0, 200))
  const stateFile = path.join(stateRoot, "install-state.json")
  const v1Runtime = path.join(stateRoot, "versions", "1", "runtime")
  check("A03.config.generatedWithRuntime", fs.existsSync(configFile) && configPluginSpecs(JSON.parse(fs.readFileSync(configFile, "utf8"))).includes(v1Runtime))
  check("A03.runtime.materialized", fs.existsSync(path.join(v1Runtime, "index.js")) && fs.existsSync(path.join(v1Runtime, "rigel-v2-native-agent-manifest.mjs")))
  check("A03.state.scopedToTempRoot", install.json?.version === "1" && fs.existsSync(stateFile))
  check("A03.launcher.installedExecutable", fs.existsSync(path.join(stateRoot, "bin", "rigel-v2")) && (fs.statSync(path.join(stateRoot, "bin", "rigel-v2")).mode & 0o111) !== 0)
  check("A03.isolation.notUnderV1", !stateRoot.startsWith(path.join(os.homedir(), ".config")) && !stateRoot.startsWith(path.join(os.homedir(), ".local", "share", "opencode")))
  check("A03.upgradeProbe.absentInV1", !fs.existsSync(path.join(v1Runtime, "rigel-v2-upgrade-probe.mjs")))
  const cliAfterInstall = readCli(cliFile)
  check("A04.install.cliSingleFamilyEntry", cliFamily(cliAfterInstall).length === 1 && cliFamily(cliAfterInstall)[0].package === v1Runtime)
  check("A04.install.cliNoBuiltinNotifierSuppression", cliMarkerCount(cliAfterInstall) === 0)
  check("A04.install.cliPreservesForeign", (cliAfterInstall.plugins ?? []).includes("rigel-foreign-cli-plugin"))

  // ------------------------------------------------------- first operation
  const status1 = runJson(["status", ...common])
  check("A11.firstOperation.statusPass", status1.result.status === 0 && status1.json?.pass === true, JSON.stringify(status1.json?.checks ?? null))

  // --------------------------------------------------- idempotent reinstall
  const stateBeforeReinstall = stripVolatile(JSON.parse(fs.readFileSync(stateFile, "utf8")))
  const reinstall = runJson(["install", "--version", "1", "--runtime-source", v1Source, ...common])
  const stateAfterReinstall = stripVolatile(JSON.parse(fs.readFileSync(stateFile, "utf8")))
  check("A04.reinstall.exitZero", reinstall.result.status === 0, reinstall.result.stderr?.slice(0, 200))
  check("A04.reinstall.idempotentState", JSON.stringify(stateBeforeReinstall) === JSON.stringify(stateAfterReinstall))

  // ---------------------------------------------------------------- upgrade
  const upgrade = runJson(["upgrade", "--version", "2", "--runtime-source", v2Source, ...common])
  check("A04.upgrade.exitZero", upgrade.result.status === 0, upgrade.result.stderr?.slice(0, 200))
  const stateAfterUpgrade = JSON.parse(fs.readFileSync(stateFile, "utf8"))
  const v2Runtime = path.join(stateRoot, "versions", "2", "runtime")
  check("A04.upgrade.versionTransition", stateAfterUpgrade.version === "2" && stateAfterUpgrade.previousVersion === "1")
  check("A04.upgrade.stateMigrated", Array.isArray(stateAfterUpgrade.migrationLog) && stateAfterUpgrade.migrationLog.length === 1 && stateAfterUpgrade.migrationLog[0].from === "1" && stateAfterUpgrade.migrationLog[0].to === "2")
  check("A04.upgrade.newRuntimeInstalled", fs.existsSync(path.join(v2Runtime, "rigel-v2-upgrade-probe.mjs")))
  check("A04.upgrade.configRepointed", configPluginSpecs(JSON.parse(fs.readFileSync(configFile, "utf8"))).includes(v2Runtime) && !configPluginSpecs(JSON.parse(fs.readFileSync(configFile, "utf8"))).includes(v1Runtime))
  const cliAfterUpgrade = readCli(cliFile)
  check("A04.upgrade.cliNoDuplicate", cliFamily(cliAfterUpgrade).length === 1)
  check("A04.upgrade.cliPointsAtNewRuntime", cliFamily(cliAfterUpgrade)[0]?.package === v2Runtime)
  check("A04.upgrade.cliNoStaleV1", !cliFamily(cliAfterUpgrade).some((entry) => entry.package === v1Runtime))
  const status2 = runJson(["status", ...common])
  check("A04.upgrade.statusPass", status2.result.status === 0 && status2.json?.pass === true)

  // Negative: rollback must refuse a previous runtime whose bytes drifted from
  // the recorded digest, and leave config/cli/state untouched at the active v2.
  const v1IndexFile = path.join(v1Runtime, "index.js")
  const v1IndexBackup = fs.readFileSync(v1IndexFile)
  fs.appendFileSync(v1IndexFile, "\n// tampered previous runtime\n")
  const tamperedRollback = runJson(["rollback", ...common])
  check("A04.rollback.rejectsAlteredPreviousRuntime", tamperedRollback.result.status !== 0, `status=${tamperedRollback.result.status}`)
  check("A04.rollback.tamperLeavesStateAtV2", JSON.parse(fs.readFileSync(stateFile, "utf8")).version === "2")
  check("A04.rollback.tamperLeavesCliAtV2", cliFamily(readCli(cliFile))[0]?.package === v2Runtime)
  fs.writeFileSync(v1IndexFile, v1IndexBackup)

  // --------------------------------------------------------------- rollback
  const rollback = runJson(["rollback", ...common])
  check("A04.rollback.exitZero", rollback.result.status === 0, rollback.result.stderr?.slice(0, 200))
  check("A04.rollback.byteIdentical", rollback.json?.byteIdentical === true)
  check("A04.rollback.probeRemoved", !fs.existsSync(path.join(v1Runtime, "rigel-v2-upgrade-probe.mjs")))
  const stateAfterRollback = JSON.parse(fs.readFileSync(stateFile, "utf8"))
  check("A04.rollback.configRestored", stateAfterRollback.version === "1" && configPluginSpecs(JSON.parse(fs.readFileSync(configFile, "utf8"))).includes(v1Runtime))
  check("A04.rollback.logged", Array.isArray(stateAfterRollback.rollbackLog) && stateAfterRollback.rollbackLog.at(-1)?.byteIdentical === true)
  const cliAfterRollback = readCli(cliFile)
  check("A04.rollback.cliRestored", cliFamily(cliAfterRollback).length === 1 && cliFamily(cliAfterRollback)[0].package === v1Runtime)
  check("A04.rollback.cliNoBuiltinNotifierSuppression", cliMarkerCount(cliAfterRollback) === 0)
  check("A04.rollback.cliNoStaleV2", !cliFamily(cliAfterRollback).some((entry) => entry.package === v2Runtime))

  // Skew RED: a stale family entry in cli.json, and a stale runtime in
  // opencode.json, must each make `status` fail. No green on contaminated state.
  const cliBeforeSkew = fs.readFileSync(cliFile)
  const configBeforeSkew = fs.readFileSync(configFile)
  const skewCli = readCli(cliFile)
  skewCli.plugins.push({ package: path.join(stateRoot, "versions", "999", "runtime"), options: { notification: { enabled: true } } })
  fs.writeFileSync(cliFile, `${JSON.stringify(skewCli, null, 2)}\n`)
  const cliSkewStatus = runJson(["status", ...common])
  check("A04.status.detectsCliSkew", cliSkewStatus.result.status !== 0 && cliSkewStatus.json?.pass === false, JSON.stringify(cliSkewStatus.json?.checks?.filter((entry) => !entry.pass) ?? null))
  fs.writeFileSync(cliFile, cliBeforeSkew)
  const skewConfig = JSON.parse(fs.readFileSync(configFile, "utf8"))
  if (!Array.isArray(skewConfig.plugins)) skewConfig.plugins = []
  skewConfig.plugins.push(path.join(stateRoot, "versions", "999", "runtime"))
  fs.writeFileSync(configFile, `${JSON.stringify(skewConfig, null, 2)}\n`)
  const configSkewStatus = runJson(["status", ...common])
  check("A04.status.detectsConfigSkew", configSkewStatus.result.status !== 0 && configSkewStatus.json?.pass === false)
  fs.writeFileSync(configFile, configBeforeSkew)

  // --------------------------------------------------------------- uninstall
  const uninstall = runJson(["uninstall", ...common])
  check("A04.uninstall.exitZero", uninstall.result.status === 0, uninstall.result.stderr?.slice(0, 200))
  const configAfterUninstall = JSON.parse(fs.readFileSync(configFile, "utf8"))
  check("A04.uninstall.runtimeRemoved", !fs.existsSync(path.join(stateRoot, "versions")) && !fs.existsSync(path.join(stateRoot, "bin")) && !fs.existsSync(stateFile))
  check("A04.uninstall.configDeregistered", !configPluginSpecs(configAfterUninstall).some((entry) => entry.includes("/versions/")))
  check("A04.uninstall.preservesForeignConfig", configPluginSpecs(configAfterUninstall).includes("rigel-foreign-plugin") && configAfterUninstall.model === "rigel-fixture/fixture")
  check("A04.uninstall.preservesForeignState", fs.existsSync(path.join(stateRoot, "foreign-note.txt")) && (uninstall.json?.preserved ?? []).includes("foreign-note.txt"))
  check("A04.uninstall.skillsRemoved", Array.isArray(uninstall.json?.removedSkills) && uninstall.json.removedSkills.length > 0 && !fs.existsSync(path.join(home, ".local", "share", "oh-my-rigel", "skills-v2.json")))
  check("A04.uninstall.preservesForeignSkill", fs.existsSync(path.join(foreignSkillDir, "SKILL.md")))
  const cliAfterUninstall = readCli(cliFile)
  check("A04.uninstall.cliNoFamilyEntry", cliFamily(cliAfterUninstall).length === 0)
  check("A04.uninstall.cliMarkerRemoved", cliMarkerCount(cliAfterUninstall) === 0)
  check("A04.uninstall.cliPreservesForeign", (cliAfterUninstall.plugins ?? []).includes("rigel-foreign-cli-plugin"))

  // ------------------------------------------------ isolation refusal (RED)
  const guardedState = path.join(os.homedir(), ".config", "opencode", "rigel-user-install-should-refuse")
  const refused = run(["install", "--version", "1", "--runtime-source", v1Source, "--home", home, "--config", configFile, "--state", guardedState, "--json"])
  check("A05.isolation.refusesV1Root", refused.status !== 0 && !fs.existsSync(guardedState), `status=${refused.status}`)

  // ------------------------------------------------ reinstall after uninstall
  const reinstall2 = runJson(["install", "--version", "1", "--runtime-source", v1Source, ...common])
  check("A04.uninstall.reinstallWorks", reinstall2.result.status === 0 && fs.existsSync(path.join(v1Runtime, "index.js")))
} finally {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true })
}

const v1After = { config: sha(v1Config), protected: buildProtectedManifest(os.homedir()) }
const protectedDiff = diffProtectedManifests(v1Before.protected, v1After.protected)
check("v1.untouched", v1Before.config === v1After.config && protectedDiff.added.length === 0 && protectedDiff.removed.length === 0 && protectedDiff.changed.length === 0, JSON.stringify(protectedDiff))

const failed = checks.filter((entry) => !entry.pass)
fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
fs.writeFileSync(path.join(evidenceDir, "user-install-contract.json"), `${JSON.stringify({ spawnedOpenCode: false, dockerUsed: false, standaloneUsed: false, checks, failed: failed.map((entry) => entry.name) }, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify({ passed: checks.length - failed.length, total: checks.length, failed: failed.map((entry) => entry.name) }, null, 2))
if (failed.length > 0) process.exitCode = 1
