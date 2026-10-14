#!/usr/bin/env node
/**
 * Goal-state gate for the isolated V2 laboratory acceptance.
 *
 * Three explicit modes:
 *   - "managed": a config references the vendored, Rigel-managed community
 *     engine (a `vendor/opencode-goal-plugin` path inside the Rigel state tree).
 *     This is the PR B owner: the retired V1 goals.json MUST stay absent.
 *   - "internal": no engine is registered and OmO's internal `goal.enabled` is
 *     true (the inherited Goal is quarantined, so this only records that no
 *     external/community engine is present). Requires POSITIVE reads of all
 *     three config files, the external state path and the exact retired cache
 *     path to be absent; the external goals.json MUST stay absent.
 *   - "legacy": the retired external plugin is referenced in a config, or its
 *     state or exact cache path exists. The historical schema-version-1
 *     invariant applies.
 * The managed mode is detected first: its artifact path also contains the
 * package name, so it must not be misread as the retired external package.
 * Any other combination, including a config that is missing or unreadable, is
 * "unknown" and fails the gate instead of silently assuming a mode.
 */
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const EXTERNAL_GOAL_MARKERS = [
  "@prevalentware/opencode-goal-plugin",
  "opencode-goal-plugin",
  "allow_goal_execution_from_plan",
]

/**
 * The vendored, Rigel-managed community engine. Its config entry points at the
 * artifact INSIDE the Rigel state tree (`<stateRoot>/versions/<v>/runtime/vendor/
 * opencode-goal-plugin/...`), so a `vendor/opencode-goal-plugin` path fragment
 * distinguishes the MANAGED engine from the retired external package/cache.
 */
const MANAGED_GOAL_MARKERS = [
  "vendor/opencode-goal-plugin",
]

export const EXTERNAL_GOAL_STATE = ".local/share/opencode-goal-plugin"
export const EXTERNAL_GOAL_CACHE = ".cache/opencode/packages/@prevalentware/opencode-goal-plugin@latest"

export function readGoalConfig(filePath) {
  let text
  try {
    if (!fs.statSync(filePath).isFile()) return { readable: false, referenced: false, managed: false }
    text = fs.readFileSync(filePath, "utf8")
  } catch {
    return { readable: false, referenced: false, managed: false }
  }
  return {
    readable: true,
    referenced: EXTERNAL_GOAL_MARKERS.some((marker) => text.includes(marker)),
    managed: MANAGED_GOAL_MARKERS.some((marker) => text.includes(marker)),
  }
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
  const cfgDir = options.configDir ?? path.join(home, ".config/opencode")
  const configPaths = ["opencode.json", "tui.json", "cli.json"].map((name) => path.join(cfgDir, name))
  const configs = configPaths.map((file) => ({ file, ...readGoalConfig(file) }))
  const referenced = configs.filter((entry) => entry.referenced).map((entry) => entry.file)
  const managed = configs.filter((entry) => entry.managed).map((entry) => entry.file)
  const unreadable = configs.filter((entry) => !entry.readable).map((entry) => entry.file)
  const stateDirs = options.stateDirs ?? [
    path.join(home, EXTERNAL_GOAL_STATE),
    path.join(home, EXTERNAL_GOAL_CACHE),
  ]
  const presentDirs = stateDirs.filter((dir) => fs.existsSync(dir))
  const enabled = internalGoalEnabled(options.omoConfigPath ?? path.join(home, ".omo/omo.jsonc"))
  // PR B: the vendored, Rigel-managed engine owns the Goal. It is checked before
  // the legacy/external detection because its path also contains the package
  // name; the retired external cache/state must stay absent.
  if (managed.length > 0) {
    return { mode: "managed", referenced, managed, presentDirs, unreadable, internalGoalEnabled: enabled }
  }
  if (referenced.length > 0 || presentDirs.length > 0) {
    return { mode: "legacy", referenced, managed, presentDirs, unreadable, internalGoalEnabled: enabled }
  }
  if (unreadable.length > 0) {
    return { mode: "unknown", referenced, managed, presentDirs, unreadable, internalGoalEnabled: enabled, reason: "external goal removal cannot be asserted: a config file is missing or unreadable" }
  }
  if (enabled) return { mode: "internal", referenced, managed, presentDirs, unreadable, internalGoalEnabled: true }
  return { mode: "unknown", referenced, managed, presentDirs, unreadable, internalGoalEnabled: false, reason: "internal goal.enabled is not true" }
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
    // The vendored engine's state lives inside the Rigel state tree, never at the
    // retired V1 path. The invariant is that the V1 goals.json stays absent.
    if (before.present || after.present) {
      return { pass: false, reason: `managed goal mode requires the retired V1 goals.json absent; before.present=${before.present} after.present=${after.present}` }
    }
    return { pass: true, reason: "managed goal mode: vendored engine registered; V1 goals.json absent before and after (invariant held)" }
  }
  if (mode === "internal") {
    if (before.present || after.present) {
      return { pass: false, reason: `internal goal mode requires the external goals.json absent; before.present=${before.present} after.present=${after.present}` }
    }
    return { pass: true, reason: "internal goal mode: external goals.json absent before and after (invariant held)" }
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
  return { pass: false, reason: "unknown goal mode: external plugin not configured and internal goal.enabled is not true" }
}

function main(argv) {
  const [command, arg, arg2, arg3] = argv
  const home = process.env.HOME
  if (command === "--mode") {
    process.stdout.write(detectGoalMode(arg ?? home).mode)
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
