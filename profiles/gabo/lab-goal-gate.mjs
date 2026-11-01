#!/usr/bin/env node
/**
 * Goal-state gate for the isolated V2 laboratory acceptance.
 *
 * Three explicit modes:
 *   - "managed": the complete Rigel-owned shim shape is live: one server shim,
 *     one CLI/TUI shim, and exactly one server-plane plus one defense-in-depth
 *     CLI `-opencode.goal` marker. This makes the vendored third-party Goal the
 *     sole configured owner.
 *   - "legacy": the retired external package/state/cache is still present. The
 *     historical schema-version-1 invariant applies.
 *   - "unknown": every incomplete, duplicate, malformed, or unreadable shape.
 *     It fails closed instead of treating `goal.enabled` as evidence that the
 *     host builtin is disabled.
 */
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  DISABLED_BUILTIN_GOAL,
  GOAL_ENGINE_SHIM_DIRNAME,
  GOAL_TUI_SHIM_DIRNAME,
  isRetiredExternalGoalPackage,
  pluginEntrySpec,
  serverPluginEntries,
  assertGoalStatePathSafe,
  resolveGoalStatePath,
} from "./rigel-v2-goal-registration.mjs"
import { parseJsonc } from "./notification-activation-config.mjs"

export const EXTERNAL_GOAL_STATE = ".local/share/opencode-goal-plugin"
export const EXTERNAL_GOAL_CACHE = ".cache/opencode/packages/@prevalentware/opencode-goal-plugin@latest"

function isShimEntry(entry, dirname) {
  const spec = pluginEntrySpec(entry)
  if (typeof spec !== "string") return false
  const normalized = spec.split("\\").join("/")
  return normalized.endsWith(`/${dirname}`)
}

export function readGoalConfig(filePath) {
  let parsed
  try {
    if (!fs.statSync(filePath).isFile()) return { readable: false, referenced: false, managed: false }
    parsed = parseJsonc(fs.readFileSync(filePath, "utf8"))
  } catch (error) {
    return { readable: false, referenced: false, managed: false, missing: error?.code === "ENOENT" }
  }
  const plugins = serverPluginEntries(parsed)
  const specs = plugins.map(pluginEntrySpec).filter((spec) => typeof spec === "string")
  return {
    readable: true,
    referenced: specs.some(isRetiredExternalGoalPackage),
    managed: specs.some((spec) => spec.includes("rigel-goal-")),
    plugins,
  }
}

function resolveRigelStateRoot(home, options) {
  return path.resolve(options.stateRoot || process.env.RIGEL_V2_USER_ROOT || path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "oh-my-rigel"))
}

function resolveConfigDir(home, options) {
  return options.configDir ?? path.join(home, ".config", "opencode")
}

export function internalGoalEnabled(omoConfigPath) {
  let text
  try {
    text = fs.readFileSync(omoConfigPath, "utf8")
  } catch {
    return false
  }
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/,(\s*[}\]])/g, "$1")
  try {
    const parsed = JSON.parse(stripped)
    return parsed?.goal?.enabled === true
  } catch {
    const block = /"goal"\s*:\s*\{([\s\S]*?)\}/.exec(stripped)
    return block ? /"enabled"\s*:\s*true/.test(block[1]) : false
  }
}

export function detectGoalMode(home, options = {}) {
  const cfgDir = resolveConfigDir(home, options)
  const configPaths = [
    { name: "opencode.json", required: true },
    { name: "tui.json", required: false },
    { name: "cli.json", required: true },
  ]
  const configs = configPaths.map(({ name, required }) => {
    const file = path.join(cfgDir, name)
    return { file, required, ...readGoalConfig(file) }
  })
  const referenced = configs.filter((entry) => entry.referenced).map((entry) => entry.file)
  const unreadable = configs.filter((entry) => !entry.readable && (entry.required || !entry.missing)).map((entry) => entry.file)
  const stateDirs = options.stateDirs ?? [
    path.join(home, EXTERNAL_GOAL_STATE),
    path.join(home, EXTERNAL_GOAL_CACHE),
  ]
  const presentDirs = stateDirs.filter((dir) => fs.existsSync(dir))
  const [opencode, , cli] = configs
  const serverEntries = opencode.plugins?.filter((entry) => isShimEntry(entry, GOAL_ENGINE_SHIM_DIRNAME)) ?? []
  const cliEntries = cli.plugins?.filter((entry) => isShimEntry(entry, GOAL_TUI_SHIM_DIRNAME)) ?? []
  const serverGoalMarkerCount = opencode.plugins?.filter((entry) => entry === DISABLED_BUILTIN_GOAL).length ?? 0
  const cliGoalMarkerCount = cli.plugins?.filter((entry) => entry === DISABLED_BUILTIN_GOAL).length ?? 0
  const stateRoot = resolveRigelStateRoot(home, options)
  const goalStatePath = resolveGoalStatePath(stateRoot)
  const configuredGoalStatePath = Object.prototype.hasOwnProperty.call(options, "goalStatePath") ? options.goalStatePath : goalStatePath
  let goalStatePathMatchesRoot = false
  try {
    goalStatePathMatchesRoot = configuredGoalStatePath === goalStatePath
    assertGoalStatePathSafe(configuredGoalStatePath, stateRoot)
  } catch {
    goalStatePathMatchesRoot = false
  }
  const managed = {
    serverEntries: serverEntries.length,
    cliEntries: cliEntries.length,
    serverGoalMarkerCount,
    cliGoalMarkerCount,
    goalStatePath,
    configuredGoalStatePath,
    goalStatePathMatchesRoot,
  }
  if (referenced.length > 0 || presentDirs.length > 0) {
    return { mode: "legacy", referenced, managed, presentDirs, unreadable }
  }
  if (unreadable.length === 0 && managed.serverEntries === 1 && managed.cliEntries === 1 && managed.serverGoalMarkerCount === 1 && managed.cliGoalMarkerCount === 1 && managed.goalStatePathMatchesRoot) {
    return { mode: "managed", referenced, managed, presentDirs, unreadable }
  }
  if (unreadable.length > 0) {
    return { mode: "unknown", referenced, managed, presentDirs, unreadable, reason: "managed Goal cannot be asserted: a config file is missing, unreadable, or invalid" }
  }
  return { mode: "unknown", referenced, managed, presentDirs, unreadable, reason: "managed Goal requires one server shim, one CLI shim, one server marker, one CLI marker, and the canonical Goal state path" }
}

export function probeGoalState(home, goalsFile) {
  const file = goalsFile ?? path.join(home, ".local/share/opencode-goal-plugin/goals.json")
  if (!fs.existsSync(file)) return { present: false, version: null, count: 0 }
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"))
    const goals = data?.goals
    const count = Array.isArray(goals) ? goals.length : goals && typeof goals === "object" ? Object.keys(goals).length : 0
    return { present: true, version: String(data?.version ?? ""), count }
  } catch {
    return { present: true, version: "unreadable", count: 0 }
  }
}

export function verifyGoalInvariant(mode, before, after) {
  if (mode === "managed") {
    // The shim-managed engine's state lives inside the Rigel state tree, never
    // at the retired V1 path. The invariant is that the V1 goals.json stays absent.
    if (before.present || after.present) {
      return { pass: false, reason: `managed goal mode requires the retired V1 goals.json absent; before.present=${before.present} after.present=${after.present}` }
    }
    return { pass: true, reason: "managed goal mode: third-party shim shape verified; V1 goals.json absent before and after (invariant held)" }
  }
  if (mode === "legacy") {
    if (!before.present || !after.present) {
      return { pass: false, reason: `legacy goal mode requires goals.json present; before.present=${before.present} after.present=${after.present}` }
    }
    if (before.version !== "1" || after.version !== "1" || before.version !== after.version) {
      return { pass: false, reason: `legacy goal schema must stay version 1 (${before.version} -> ${after.version})` }
    }
    if (before.count !== after.count) {
      return { pass: false, reason: `legacy goal count changed (${before.count} -> ${after.count})` }
    }
    return { pass: true, reason: `legacy goal mode: schema 1 and count ${after.count} unchanged` }
  }
  return { pass: false, reason: "unknown goal mode: the complete managed shim shape was not verified" }
}

function main(argv) {
  const [command, arg, arg2, arg3] = argv
  const home = process.env.HOME
  if (command === "--mode") {
    const configFile = process.env.RIGEL_V2_CONFIG
    const stateRoot = process.env.RIGEL_V2_USER_ROOT
    const configuredGoalStatePath = process.env.OPENCODE_GOAL_STATE_PATH
    const xdgConfigHome = process.env.XDG_CONFIG_HOME
    process.stdout.write(detectGoalMode(arg ?? home, {
      ...(typeof configFile === "string" && configFile ? { configDir: path.dirname(configFile) } : typeof xdgConfigHome === "string" && xdgConfigHome ? { configDir: path.join(xdgConfigHome, "opencode") } : {}),
      ...(typeof stateRoot === "string" && stateRoot ? { stateRoot } : {}),
      ...(configuredGoalStatePath !== undefined ? { goalStatePath: configuredGoalStatePath } : {}),
    }).mode)
    return 0
  }
  if (command === "--probe") {
    process.stdout.write(JSON.stringify(probeGoalState(arg ?? home)))
    return 0
  }
  if (command === "--verify") {
    const verdict = verifyGoalInvariant(arg, JSON.parse(arg2), JSON.parse(arg3))
    process.stdout.write(`${verdict.pass ? "PASS" : "FAIL"} ${verdict.reason}`)
    return verdict.pass ? 0 : 1
  }
  process.stderr.write("usage: lab-goal-gate.mjs --mode|--probe <home> | --verify <mode> <beforeJson> <afterJson>\n")
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
