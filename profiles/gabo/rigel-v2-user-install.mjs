#!/usr/bin/env node
/**
 * Rigel V2 user lifecycle: install, reinstall, upgrade, rollback, uninstall and
 * status for a real OpenCode V2 home, without the laboratory state shape.
 *
 * Every path is supplied explicitly (or derived from the isolated HOME/XDG) and
 * guarded against the V1 roots before any write, so this never reads or mutates
 * the user's production V1 installation. It does not launch OpenCode; the caller
 * launches the normal `opencode` command afterwards.
 *
 * Usage:
 *   node rigel-v2-user-install.mjs install   --version <v> [--runtime-source <dir>]
 *   node rigel-v2-user-install.mjs upgrade   --version <v> [--runtime-source <dir>]
 *   node rigel-v2-user-install.mjs rollback
 *   node rigel-v2-user-install.mjs uninstall
 *   node rigel-v2-user-install.mjs status
 * Common: --state <dir> --home <dir> --config <file> [--json]
 */
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import {
  materializeNativeRuntime,
  registerRuntimePluginEntry,
  resolveRuntimeNotificationOptions,
} from "./rigel-v2-runtime-materialize.mjs"
import { registerCompanionCliPlugin, removeRigelCliEntries } from "./notification-activation-config.mjs"
import {
  beginLifecycleTransaction,
  failAt,
  writeJsonAtomic,
} from "./rigel-v2-lifecycle-transaction.mjs"

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const INSTALLER_PATH = fileURLToPath(import.meta.url)
const STATE_SCHEMA = 2

const V1_ROOTS = [
  path.join(os.homedir(), ".config", "opencode"),
  path.join(os.homedir(), ".local", "share", "opencode"),
  path.join(os.homedir(), ".local", "share", "opencode-goal-plugin"),
  path.join(os.homedir(), ".cache", "opencode"),
]

function canonicalize(target) {
  const resolved = path.resolve(target)
  const suffix = []
  let current = resolved
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) break
    suffix.unshift(path.basename(current))
    current = parent
  }
  let real
  try { real = fs.realpathSync(current) } catch { real = current }
  return suffix.length > 0 ? path.join(real, ...suffix) : real
}

function under(child, parent) {
  return child === parent || child.startsWith(`${parent}${path.sep}`)
}

function hashValue(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex")
}

function treeDigest(dir) {
  const files = []
  const walk = (base, rel) => {
    for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(base, entry.name)
      const next = rel === "" ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(abs, next)
      else if (entry.isFile()) files.push(next)
    }
  }
  walk(dir, "")
  const digest = crypto.createHash("sha256")
  for (const file of files) {
    digest.update(file)
    digest.update("\0")
    digest.update(crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, file))).digest("hex"))
    digest.update("\n")
  }
  return digest.digest("hex")
}

function parseArgs(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith("--")) continue
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next
      index += 1
    } else {
      flags[key] = true
    }
  }
  return flags
}

function fail(message) {
  console.error(`rigel-v2 install refused: ${message}`)
  process.exit(1)
}

function guardIsolation(paths) {
  // The install's own roots plus the isolated XDG roots it hands to the skills
  // materializer. Ambient XDG variables are NOT guarded: explicit --config /
  // --state / --home flags override them and the spawned helper never sees them.
  const targets = { ...paths, ...isolatedXdgEnv(paths.home) }
  for (const [name, target] of Object.entries(targets)) {
    const canonical = canonicalize(target)
    for (const v1 of V1_ROOTS.map(canonicalize)) {
      if (under(canonical, v1)) fail(`${name} resolves under a V1 root (${v1}): ${canonical}`)
    }
  }
}

/** Isolated XDG roots derived under `home`, so a spawned helper can never fall back to the real ones. */
function isolatedXdgEnv(home) {
  return {
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
  }
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")) }
function writeJson(file, value) { writeJsonAtomic(file, value) }

function generateAgentManifest({ versionDir, home, configFile }) {
  const output = path.join(versionDir, "agent-manifest.mjs")
  const selectionFile = path.join(sourceRoot, "profiles/gabo/v2-agent-selection.json")
  const judgeFile = path.join(sourceRoot, "profiles/gabo/opencode/agents/judge.v2.json")
  const profileSource = process.env.RIGEL_V2_PROFILE_FILE || path.join(sourceRoot, "profiles/gabo/omo.jsonc")
  const skills = spawnSync(process.execPath, [path.join(sourceRoot, "profiles/gabo/materialize-v2-skills.mjs")], {
    cwd: sourceRoot,
    env: { ...process.env, HOME: home, ...isolatedXdgEnv(home) },
    encoding: "utf8",
  })
  if (skills.status !== 0) throw new Error(`no se pudieron exponer las skills V2: ${skills.stderr || skills.stdout}`)
  const generatorHome = fs.mkdtempSync(path.join(versionDir, "generator-home-"))
  const generatorProfile = path.join(generatorHome, ".omo")
  fs.mkdirSync(path.join(generatorProfile, "opencode/prompts"), { recursive: true, mode: 0o700 })
  fs.writeFileSync(
    path.join(generatorProfile, "omo.jsonc"),
    fs.readFileSync(profileSource, "utf8").replaceAll("__OMO_PROFILE_ROOT__", generatorProfile),
    { mode: 0o600 },
  )
  fs.copyFileSync(
    path.join(sourceRoot, "profiles/gabo/opencode/prompts/sisyphus-orchestration.md"),
    path.join(generatorProfile, "opencode/prompts/sisyphus-orchestration.md"),
  )
  const generated = spawnSync(process.execPath, [
    path.join(sourceRoot, "profiles/gabo/generate-v2-agents.mjs"),
    "--input", configFile, "--output", output,
    "--selection", selectionFile, "--judge", judgeFile,
    "--directory", home, "--profile-root", generatorHome,
  ], {
    cwd: sourceRoot,
    env: { ...process.env, HOME: generatorHome, XDG_CONFIG_HOME: path.dirname(path.dirname(configFile)), OMO_PROFILE: "gabo", OMO_DISABLE_PROCESS_CLEANUP: "1" },
    encoding: "utf8",
  })
  fs.rmSync(generatorHome, { recursive: true, force: true })
  if (generated.status !== 0) throw new Error(`la generación del manifiesto falló: ${generated.stderr || generated.stdout}`)
  return output
}

function removeOurConfigEntries(configFile, stateRoot) {
  const canonicalState = canonicalize(stateRoot)
  const config = fs.existsSync(configFile) ? readJson(configFile) : {}
  if (Array.isArray(config.plugin)) {
    config.plugin = config.plugin.filter((entry) => !(typeof entry === "string" && under(canonicalize(entry), canonicalState)))
  }
  writeJsonAtomic(configFile, config)
  const cliConfigFile = path.join(path.dirname(configFile), "cli.json")
  if (fs.existsSync(cliConfigFile)) {
    const cli = readJson(cliConfigFile)
    writeJsonAtomic(cliConfigFile, removeRigelCliEntries(cli, { familyRoot: stateRoot }))
  }
}

/**
 * Remove the Rigel-managed skill links and the skills manifest. Returns the
 * removed names plus the (target, source) pairs needed to recreate the links if
 * a surrounding transaction has to roll back.
 */
function removeManagedSkills(home) {
  const skillsStateFile = path.join(home, ".local", "share", "oh-my-rigel", "skills-v2.json")
  if (!fs.existsSync(skillsStateFile)) return { removed: [], restore: [] }
  const manifest = readJson(skillsStateFile)
  const discoveryRoot = manifest.discoveryRoot ?? path.join(home, ".agents", "skills")
  const removed = []
  const restore = []
  for (const entry of manifest.managed ?? []) {
    const target = path.join(discoveryRoot, entry.name)
    try {
      const stat = fs.lstatSync(target)
      if (stat.isSymbolicLink() && fs.realpathSync(target) === fs.realpathSync(entry.source)) {
        fs.unlinkSync(target)
        removed.push(entry.name)
        restore.push({ target, source: entry.source })
      }
    } catch { /* already gone or user-owned */ }
  }
  fs.rmSync(skillsStateFile, { force: true })
  return { removed, restore }
}

function restoreSkillLinks(restore) {
  for (const { target, source } of [...restore].reverse()) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
      fs.symlinkSync(source, target, "dir")
    } catch { /* best-effort restore */ }
  }
}

function writeLauncher(stateRoot, home, configFile) {
  const launcher = path.join(stateRoot, "bin", "rigel-v2")
  fs.mkdirSync(path.dirname(launcher), { recursive: true, mode: 0o700 })
  const script = `#!/usr/bin/env bash
set -euo pipefail
export HOME=${JSON.stringify(home)}
exec node ${JSON.stringify(INSTALLER_PATH)} "$@" --state ${JSON.stringify(stateRoot)} --home ${JSON.stringify(home)} --config ${JSON.stringify(configFile)}
`
  fs.writeFileSync(launcher, script, { mode: 0o700 })
  fs.chmodSync(launcher, 0o700)
  return launcher
}

function resolvePaths(flags) {
  const home = path.resolve(flags.home || process.env.RIGEL_V2_HOME || os.homedir())
  const stateRoot = path.resolve(flags.state || process.env.RIGEL_V2_USER_ROOT || path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "oh-my-rigel"))
  const configDir = process.env.XDG_CONFIG_HOME || path.join(home, ".config")
  const configFile = path.resolve(flags.config || process.env.RIGEL_V2_CONFIG || path.join(configDir, "opencode", "opencode.json"))
  return { home, stateRoot, configFile }
}

function installVersion({ paths, version, runtimeSource, previousState, migrating }) {
  const versionDir = path.join(paths.stateRoot, "versions", version)
  fs.mkdirSync(versionDir, { recursive: true, mode: 0o700 })
  const agentManifest = generateAgentManifest({ versionDir, home: paths.home, configFile: paths.configFile })
  const result = materializeNativeRuntime({
    sourceRoot,
    runtimeSourceDir: runtimeSource,
    runtimeDir: path.join(versionDir, "runtime"),
    familyRoot: paths.stateRoot,
    agentManifestPath: agentManifest,
    configFile: paths.configFile,
    profileFile: process.env.RIGEL_V2_PROFILE_FILE || path.join(sourceRoot, "profiles/gabo/omo.jsonc"),
    env: process.env,
  })
  const runtimeDigest = treeDigest(path.join(versionDir, "runtime"))
  const versionDigests = { ...(previousState?.versionDigests ?? {}), [version]: runtimeDigest }
  const base = {
    schema: STATE_SCHEMA,
    version,
    previousVersion: migrating ? previousState?.version ?? null : null,
    home: paths.home,
    configFile: paths.configFile,
    stateRoot: paths.stateRoot,
    pluginEntry: result.pluginEntry,
    agentManifest,
    installedAt: previousState?.installedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    versionDigests,
    migrationLog: previousState?.migrationLog ?? [],
    rollbackLog: previousState?.rollbackLog ?? [],
  }
  if (migrating && previousState) {
    base.migrationLog = [...base.migrationLog, { from: previousState.version, to: version, at: base.updatedAt }]
  }
  return base
}

function statusOf(state, paths) {
  const checks = []
  const runtime = path.join(paths.stateRoot, "versions", state.version, "runtime")
  const canonicalState = canonicalize(paths.stateRoot)
  checks.push({ name: "runtime.materialized", pass: fs.existsSync(path.join(runtime, "index.js")) })
  checks.push({ name: "agentManifest.present", pass: fs.existsSync(state.agentManifest) })
  checks.push({ name: "state.pluginEntryMatchesVersion", pass: state.pluginEntry === runtime })

  // opencode.json: exactly one Rigel-family entry, and it is the active runtime.
  const config = fs.existsSync(paths.configFile) ? readJson(paths.configFile) : {}
  const configPlugins = Array.isArray(config.plugin) ? config.plugin : []
  const configFamily = configPlugins.filter((entry) => typeof entry === "string" && under(canonicalize(entry), canonicalState))
  checks.push({ name: "config.registersRuntime", pass: configPlugins.includes(state.pluginEntry) })
  checks.push({ name: "config.singleRigelEntry", pass: configFamily.length === 1 && configFamily[0] === state.pluginEntry })

  // cli.json: exactly one Rigel-family companion entry pointing at the SAME
  // runtime as the server config, and the builtin-disable marker present iff the
  // notification surface is enabled. This is the skew the P2 REJECT proved: a
  // version transition used to leave both the old and new entries behind.
  const cliConfigFile = path.join(path.dirname(paths.configFile), "cli.json")
  const cli = fs.existsSync(cliConfigFile) ? readJson(cliConfigFile) : { plugins: [] }
  const cliPlugins = Array.isArray(cli.plugins) ? cli.plugins : []
  const cliFamily = cliPlugins.filter((entry) => entry && typeof entry === "object" && typeof entry.package === "string" && under(canonicalize(entry.package), canonicalState))
  const markerCount = cliPlugins.filter((entry) => entry === "-opencode.notifications").length
  const notificationEnabled = cliFamily[0]?.options?.notification?.enabled === true
  checks.push({ name: "cli.singleRigelEntry", pass: cliFamily.length === 1 })
  checks.push({ name: "cli.runtimeMatchesConfig", pass: cliFamily.length === 1 && cliFamily[0].package === state.pluginEntry })
  checks.push({ name: "cli.disabledMarkerCorrect", pass: markerCount === (notificationEnabled ? 1 : 0) })

  const currentDigest = fs.existsSync(runtime) ? treeDigest(runtime) : null
  checks.push({ name: "runtime.digestMatches", pass: currentDigest !== null && currentDigest === state.versionDigests?.[state.version] })
  return { version: state.version, previousVersion: state.previousVersion ?? null, checks, pass: checks.every((entry) => entry.pass) }
}

function emit(value, flags) {
  if (flags.json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  else process.stdout.write(`${JSON.stringify(value)}\n`)
  if (value.pass === false || value.ok === false) process.exitCode = 1
}

/** Run a lifecycle mutation inside a compensating transaction over config/cli/state. */
function lifecycle(files, run) {
  const txn = beginLifecycleTransaction({ files })
  try {
    const value = run(txn)
    txn.commit()
    return value
  } catch (error) {
    txn.rollback()
    console.error(`rigel-v2 install refused: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

function main() {
  const [command, ...rest] = process.argv.slice(2)
  const flags = parseArgs(rest)
  const paths = resolvePaths(flags)
  guardIsolation({ home: paths.home, stateRoot: paths.stateRoot, configFile: paths.configFile })
  const stateFile = path.join(paths.stateRoot, "install-state.json")
  const cliConfigFile = path.join(path.dirname(paths.configFile), "cli.json")
  const skillsStateFile = path.join(paths.home, ".local", "share", "oh-my-rigel", "skills-v2.json")
  const transactionFiles = [paths.configFile, cliConfigFile, stateFile, skillsStateFile]
  const profileFile = process.env.RIGEL_V2_PROFILE_FILE || path.join(sourceRoot, "profiles/gabo/omo.jsonc")
  const previousState = fs.existsSync(stateFile) ? readJson(stateFile) : null

  if (command === "install") {
    const version = String(flags.version || "1")
    lifecycle(transactionFiles, (txn) => {
      txn.trackCreatedDir(path.join(paths.stateRoot, "versions", version))
      const state = installVersion({ paths, version, runtimeSource: flags["runtime-source"], previousState, migrating: false })
      txn.failAt("install:after-runtime")
      writeJson(stateFile, state)
      txn.failAt("install:after-state")
      const launcher = writeLauncher(paths.stateRoot, paths.home, paths.configFile)
      emit({ ok: true, command, version, pluginEntry: state.pluginEntry, launcher, status: statusOf(state, paths) }, flags)
    })
    return
  }

  if (command === "upgrade") {
    if (!previousState) fail("no hay una instalación Rigel V2 para actualizar; ejecute install primero")
    const version = String(flags.version || "")
    if (version === "" || version === previousState.version) fail(`upgrade requiere una versión distinta de la instalada (${previousState.version})`)
    lifecycle(transactionFiles, (txn) => {
      txn.trackCreatedDir(path.join(paths.stateRoot, "versions", version))
      const state = installVersion({ paths, version, runtimeSource: flags["runtime-source"], previousState, migrating: true })
      txn.failAt("upgrade:after-runtime")
      writeJson(stateFile, state)
      txn.failAt("upgrade:after-state")
      emit({ ok: true, command, from: previousState.version, to: version, migrated: state.migrationLog.at(-1) ?? null, status: statusOf(state, paths) }, flags)
    })
    return
  }

  if (command === "rollback") {
    if (!previousState) fail("no hay una instalación Rigel V2 para revertir")
    const target = previousState.previousVersion
    if (!target) fail("no hay una versión previa registrada para revertir")
    const targetRuntime = path.join(paths.stateRoot, "versions", target, "runtime")
    if (!fs.existsSync(targetRuntime)) fail(`el runtime de la versión previa no existe: ${targetRuntime}`)
    const expected = previousState.versionDigests?.[target]
    const actual = treeDigest(targetRuntime)
    if (expected !== undefined && expected !== actual) fail(`el runtime de la versión previa no coincide byte a byte (${target})`)
    lifecycle(transactionFiles, (txn) => {
      const config = fs.existsSync(paths.configFile) ? readJson(paths.configFile) : {}
      config.plugin = registerRuntimePluginEntry(Array.isArray(config.plugin) ? config.plugin : [], { runtimeDir: targetRuntime, familyRoot: paths.stateRoot })
      writeJson(paths.configFile, config)
      txn.failAt("rollback:after-config")
      const cliBefore = fs.existsSync(cliConfigFile) ? readJson(cliConfigFile) : { plugins: [] }
      const notificationOptions = resolveRuntimeNotificationOptions(profileFile, process.env)
      const cliAfter = registerCompanionCliPlugin(cliBefore, {
        runtimeDir: targetRuntime,
        familyRoot: paths.stateRoot,
        options: notificationOptions,
        notificationEnabled: notificationOptions.enabled,
      })
      writeJson(cliConfigFile, cliAfter)
      txn.failAt("rollback:after-cli")
      const state = {
        ...previousState,
        version: target,
        previousVersion: null,
        pluginEntry: targetRuntime,
        agentManifest: path.join(paths.stateRoot, "versions", target, "agent-manifest.mjs"),
        updatedAt: new Date().toISOString(),
        rollbackLog: [...(previousState.rollbackLog ?? []), { from: previousState.version, to: target, byteIdentical: expected === actual, at: new Date().toISOString() }],
      }
      writeJson(stateFile, state)
      txn.failAt("rollback:after-state")
      emit({ ok: true, command, version: target, byteIdentical: expected === actual, status: statusOf(state, paths) }, flags)
    })
    return
  }

  if (command === "uninstall") {
    if (!previousState) fail("no hay una instalación Rigel V2 para desinstalar")
    lifecycle(transactionFiles, (txn) => {
      const staged = []
      let skillsRestore = []
      try {
        removeOurConfigEntries(paths.configFile, paths.stateRoot)
        txn.failAt("uninstall:after-config")
        for (const dir of ["versions", "bin"]) {
          const abs = path.join(paths.stateRoot, dir)
          if (fs.existsSync(abs)) {
            const backup = `${abs}.txn-${crypto.randomBytes(4).toString("hex")}`
            fs.renameSync(abs, backup)
            staged.push({ abs, backup })
          }
        }
        txn.failAt("uninstall:after-versions")
        const skills = removeManagedSkills(paths.home)
        skillsRestore = skills.restore
        txn.failAt("uninstall:after-skills")
        fs.rmSync(stateFile, { force: true })
        txn.failAt("uninstall:after-state")
        for (const { backup } of staged) fs.rmSync(backup, { recursive: true, force: true })
        const remaining = fs.existsSync(paths.stateRoot) ? fs.readdirSync(paths.stateRoot).sort() : []
        const config = fs.existsSync(paths.configFile) ? readJson(paths.configFile) : {}
        emit({ ok: true, command, removed: ["versions", "bin", "install-state.json"], removedSkills: skills.removed, preserved: remaining, remainingPluginEntries: Array.isArray(config.plugin) ? config.plugin : [] }, flags)
      } catch (error) {
        for (const { abs, backup } of [...staged].reverse()) {
          try {
            fs.rmSync(abs, { recursive: true, force: true })
            fs.renameSync(backup, abs)
          } catch { /* best-effort restore */ }
        }
        restoreSkillLinks(skillsRestore)
        throw error
      }
    })
    return
  }

  if (command === "status") {
    if (!previousState) fail("no hay una instalación Rigel V2")
    emit({ ok: true, command, ...statusOf(previousState, paths) }, flags)
    return
  }

  fail(`comando desconocido: ${String(command)}`)
}

main()
