/**
 * Registration and state plumbing for the vendored community Goal engine.
 *
 * This module is the single authority for:
 *
 *   - the Rigel-managed DEFAULT options of the community engine and their
 *     precedence over explicit, validated user overrides;
 *   - the two-slot family model: the RiGel runtime slot owns every entry under
 *     the state root EXCEPT the vendored engine subtree, and the goal slot owns
 *     exactly the vendored engine subtree. Both `opencode.json` and `cli.json`
 *     are written this way, so exactly one runtime entry, goal entry, and
 *     builtin-disable marker survive a reinstall and a version transition;
 *   - the safe resolution of `OPENCODE_GOAL_STATE_PATH` inside the Rigel state
 *     tree, and the transactional adoption-by-copy of a compatible external
 *     state (source left byte-identical).
 *
 * Only Node built-ins are imported.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { assertGoalStatePathSafe, isV1GoalStatePath, resolveGoalStatePath } from "./opencode/rigel-v2-native-goal-state.mjs"

export { assertGoalStatePathSafe, isV1GoalStatePath, resolveGoalStatePath }

/** The vendored artifact's identifier (also the vendor directory name). */
export const GOAL_ENGINE_ID = "opencode-goal-plugin"

/**
 * The path fragment that identifies the vendored engine inside the Rigel state
 * tree (`<runtimeDir>/vendor/opencode-goal-plugin/...`). Used by both family
 * slots and by every config reader so the engine can never be mistaken for the
 * runtime family, nor the reverse.
 */
export const GOAL_ARTIFACT_MARKER = `vendor/${GOAL_ENGINE_ID}`

/** Accepted community state schema versions (legacy 1, current 2 and 3). */
export const GOAL_STATE_SCHEMA_VERSIONS = Object.freeze([1, 2, 3])

/**
 * The Rigel-owned loader shim for the vendored engine.
 *
 * The host resolves a `plugin` entry to an ENTRYPOINT: a directory needs a `.`
 * export (or `main`). The vendored artifact exports only `./server` and `./tui`,
 * so pointing the entry at the artifact directory or at `dist/server.js` makes
 * the host skip it ("configured plugin path must be a directory"). This shim is
 * a tiny Rigel-owned directory (NOT a vendor patch) whose `.` export re-exports
 * the vendored server, so the host loads it exactly once.
 */
export const GOAL_ENGINE_SHIM_DIRNAME = "rigel-goal-engine"

/**
 * The Rigel-owned loader shim for the vendored engine's CLI/TUI surface.
 *
 * The host resolves a `cli.json` `plugins` entry `{ package }` to a JS
 * entrypoint through the package's `.`/`./tui` export. The vendored artifact
 * ships its TUI as `src/tui.ts` and exposes no resolvable `.`, so pointing the
 * entry at the artifact root makes the host skip it and the community goal
 * sidebar never renders. This shim is a tiny Rigel-owned directory whose
 * `.`/`./tui` export re-exports the vendored TUI, so the host loads it and the
 * sidebar renders. NOT a vendor patch.
 */
export const GOAL_TUI_SHIM_DIRNAME = "rigel-goal-tui"

/** Explicit server/CLI marker that disables OpenCode's competing builtin Goal plugin. */
export const DISABLED_BUILTIN_GOAL = "-opencode.goal"

/**
 * The Rigel-managed DEFAULT options written into the community entry exactly
 * once. `default_token_budget` and `max_goal_duration_seconds` are deliberately
 * ABSENT: their absence means "no explicit token or duration limit", which is
 * the managed default. Every value here is a DEFAULT, not a cap: a user override
 * (see {@link resolveGoalOptions}) wins over it.
 */
export const RIGEL_GOAL_DEFAULTS = Object.freeze({
  auto_continue: true,
  defer_while_tasks_active: true,
  max_auto_turns: 1000,
  min_continue_interval_seconds: 3,
  max_prompt_failures: 3,
  no_progress_token_threshold: 50,
  max_no_progress_turns: 2,
  restricted_agents: Object.freeze([]),
  allow_goal_execution_from_plan: false,
})

/** Validators for every option the vendor supports (see its README `Options`). */
const GOAL_OPTION_SPECS = Object.freeze({
  auto_continue: "boolean",
  defer_while_tasks_active: "boolean",
  register_command: "boolean",
  wait_for_command: "boolean",
  allow_goal_execution_from_plan: "boolean",
  max_auto_turns: "positiveInteger",
  max_prompt_failures: "positiveInteger",
  max_turn_time: "positiveInteger",
  default_token_budget: "positiveInteger",
  max_goal_duration_seconds: "positiveInteger",
  min_continue_interval_seconds: "nonNegativeInteger",
  no_progress_token_threshold: "nonNegativeInteger",
  max_no_progress_turns: "nonNegativeInteger",
  max_task_block_seconds: "nonNegativeInteger",
  max_objective_chars: "nonNegativeInteger",
  restricted_agents: "stringArray",
  locale: "nonEmptyString",
  command_name: "nonEmptyString",
})

function coerceGoalOption(key, value, kind) {
  switch (kind) {
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`goal option "${key}" must be a boolean`)
      return value
    case "positiveInteger":
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`goal option "${key}" must be a positive integer`)
      return value
    case "nonNegativeInteger":
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`goal option "${key}" must be a non-negative integer`)
      return value
    case "stringArray":
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(`goal option "${key}" must be an array of strings`)
      return value.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    case "nonEmptyString":
      if (typeof value !== "string" || value.trim().length === 0) throw new Error(`goal option "${key}" must be a non-empty string`)
      return value
    default:
      throw new Error(`goal option "${key}" has no validator`)
  }
}

/**
 * Resolve the materialized community options as `defaults < validated overrides`.
 * Unknown option keys and invalid values throw with an actionable diagnostic;
 * a valid override always wins over the Rigel default, and an absent override
 * leaves the default in place. `default_token_budget` and
 * `max_goal_duration_seconds` are only present when an override supplies them.
 */
export function resolveGoalOptions({ defaults = RIGEL_GOAL_DEFAULTS, overrides } = {}) {
  const user = overrides === undefined || overrides === null ? {} : overrides
  if (typeof user !== "object" || Array.isArray(user)) throw new Error("goal option overrides must be a plain object")
  const resolved = { ...defaults }
  if (Array.isArray(resolved.restricted_agents)) resolved.restricted_agents = [...resolved.restricted_agents]
  for (const [key, value] of Object.entries(user)) {
    const kind = GOAL_OPTION_SPECS[key]
    if (kind === undefined) throw new Error(`unsupported goal option "${key}"`)
    resolved[key] = coerceGoalOption(key, value, kind)
  }
  return resolved
}

/** Read the low-priority overrides an existing goal entry already carries. */
export function goalEntryOptions(entry) {
  if (isLegacyPluginTuple(entry)) return entry[1]
  if (isNativePluginObject(entry) && entry.options !== undefined) return entry.options
  return {}
}

function normalized(candidate) {
  return typeof candidate === "string" ? candidate.split("\\").join("/") : undefined
}

/** True when a path sits inside the vendored engine subtree. */
export function isGoalVendorPath(candidate) {
  const value = normalized(candidate)
  if (value === undefined) return false
  const marker = `/${GOAL_ARTIFACT_MARKER}/`
  return value.includes(marker) || value.endsWith(`/${GOAL_ARTIFACT_MARKER}`) || value.startsWith(`${GOAL_ARTIFACT_MARKER}/`)
}

/** True when a path is a Rigel-owned loader shim (server or CLI/TUI) for the vendored engine. */
export function isGoalEngineShimPath(candidate) {
  const value = normalized(candidate)
  if (value === undefined) return false
  for (const dirname of [GOAL_ENGINE_SHIM_DIRNAME, GOAL_TUI_SHIM_DIRNAME]) {
    if (value.endsWith(`/${dirname}`) || value.includes(`/${dirname}/`)) return true
  }
  return false
}

/**
 * Lay the loader shim next to the deployed runtime and return its directory. The
 * shim's `server.js` re-exports the vendored server's default (the hybrid
 * `{ id, server, setup }` definition), so the host resolves a `.` entrypoint and
 * loads the engine exactly once. Idempotent; never touches the vendored bytes.
 */
export function materializeGoalEngineShim({ runtimeDir, engineEntry }) {
  const shimDir = path.join(runtimeDir, GOAL_ENGINE_SHIM_DIRNAME)
  fs.mkdirSync(shimDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(
    path.join(shimDir, "package.json"),
    `${JSON.stringify({ name: "rigel-goal-engine", type: "module", exports: { ".": "./server.js" } }, null, 2)}\n`,
    { mode: 0o600 },
  )
  fs.writeFileSync(path.join(shimDir, "server.js"), `export { default } from ${JSON.stringify(engineEntry)}\n`, { mode: 0o600 })
  return shimDir
}

/**
 * Lay the CLI/TUI loader shim next to the deployed runtime and return its
 * directory. The shim's `tui.js` re-exports the vendored TUI's default (the
 * `TuiPluginModule`), so the host resolves a `.`/`./tui` entrypoint and renders
 * the community goal sidebar. Idempotent; never touches the vendored bytes.
 */
export function materializeGoalTuiShim({ runtimeDir, tuiEntry }) {
  const shimDir = path.join(runtimeDir, GOAL_TUI_SHIM_DIRNAME)
  fs.mkdirSync(shimDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(
    path.join(shimDir, "package.json"),
    `${JSON.stringify({ name: "rigel-goal-tui", type: "module", exports: { ".": "./tui.js", "./tui": "./tui.js" } }, null, 2)}\n`,
    { mode: 0o600 },
  )
  fs.writeFileSync(path.join(shimDir, "tui.js"), `export { default } from ${JSON.stringify(tuiEntry)}\n`, { mode: 0o600 })
  return shimDir
}

function isOptionsObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** OpenCode 2 native `plugins` object form: `{ package, options? }`. */
export function isNativePluginObject(entry) {
  return isOptionsObject(entry)
    && typeof entry.package === "string"
    && (entry.options === undefined || isOptionsObject(entry.options))
}

/** OpenCode 1 singular `plugin` options form: `[specifier, options]`. */
export function isLegacyPluginTuple(entry) {
  return Array.isArray(entry)
    && entry.length === 2
    && typeof entry[0] === "string"
    && isOptionsObject(entry[1])
}

/** The exact accepted entry kinds for native OpenCode 2 `plugins`. */
export function hasValidNativePluginEntries(entries) {
  return Array.isArray(entries) && entries.every((entry) => typeof entry === "string" || isNativePluginObject(entry))
}

/** The exact accepted entry kinds for legacy singular OpenCode 1 `plugin`. */
export function hasValidLegacyPluginEntries(entries) {
  return Array.isArray(entries) && entries.every((entry) => typeof entry === "string" || isLegacyPluginTuple(entry))
}

/**
 * Mirror OpenCode 2.0.32's per-key plugin normalizer contract. The native
 * plural key accepts strings and `{ package, options? }` objects; the legacy
 * singular key accepts strings and `[specifier, options]` tuples.
 */
export function hasValidServerPluginShapes(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return false
  return (config.plugins === undefined || hasValidNativePluginEntries(config.plugins))
    && (config.plugin === undefined || hasValidLegacyPluginEntries(config.plugin))
}

/** The specifier a plugin entry (string | legacy tuple | native object) resolves to. */
export function pluginEntrySpec(entry) {
  if (typeof entry === "string") return entry
  if (isLegacyPluginTuple(entry)) return entry[0]
  if (isNativePluginObject(entry)) return entry.package
  return undefined
}

/**
 * The retired external package specifiers, with or without a version/tag. A
 * pre-existing external install is absorbed into the vendored engine: the
 * external entry is recognized as a goal entry so it is replaced, never doubled.
 */
export function isRetiredExternalGoalPackage(spec) {
  if (typeof spec !== "string") return false
  return (
    spec === "@prevalentware/opencode-goal-plugin" ||
    spec.startsWith("@prevalentware/opencode-goal-plugin@") ||
    spec === GOAL_ENGINE_ID ||
    spec.startsWith(`${GOAL_ENGINE_ID}@`)
  )
}

/** True when an entry belongs to the goal engine (the goal slot). */
export function isGoalEngineEntry(entry) {
  const spec = pluginEntrySpec(entry)
  return isGoalVendorPath(spec) || isGoalEngineShimPath(spec) || isRetiredExternalGoalPackage(spec)
}

function toNativePluginEntry(entry) {
  return isLegacyPluginTuple(entry) ? { package: entry[0], options: entry[1] } : entry
}

/**
 * Normalize server plugins from the native V2 `plugins` field and its V1
 * `plugin` predecessor. A document containing both is migrated to the native
 * field without dropping a foreign entry from either list; native entries stay
 * first and each source list preserves its original order. Legacy tuples are
 * converted to native objects before they are written under `plugins`.
 */
export function serverPluginEntries(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return []
  const native = Array.isArray(config.plugins) ? config.plugins : []
  const legacy = Array.isArray(config.plugin) ? config.plugin : []
  // The host normalizer concatenates legacy entries first, then native ones
  // (`plugins = [...legacy, ...native]`). Keeping that order here means a
  // document migrated from `plugin` to `plugins` keeps exactly the effective
  // plugin list and precedence it had before the migration.
  return [...legacy.map(toNativePluginEntry), ...native]
}

function withServerPluginEntries(config, plugins) {
  const next = { ...(config && typeof config === "object" && !Array.isArray(config) ? config : {}) }
  next.plugins = plugins
  delete next.plugin
  return next
}

/**
 * Register the goal engine's SERVER entry in `opencode.json` `plugins` exactly
 * once, as an OpenCode 2 native `{ package, options }` object, and retain
 * exactly one server-plane builtin-disable marker.
 * A prior version's goal entry is replaced in place, so a version transition
 * never appends a second engine. Array input remains supported for the narrow
 * list-level callers; document input is normalized to native V2 `plugins`.
 */
export function registerGoalServerEntry(configOrPlugins, { engineEntry, options }) {
  const list = Array.isArray(configOrPlugins) ? configOrPlugins : serverPluginEntries(configOrPlugins)
  const next = []
  let placed = false
  let markerPlaced = false
  for (const entry of list) {
    if (entry === DISABLED_BUILTIN_GOAL) {
      if (!markerPlaced) {
        next.push(DISABLED_BUILTIN_GOAL)
        markerPlaced = true
      }
      continue
    }
    if (isGoalEngineEntry(entry)) {
      if (!placed) {
        next.push({ package: engineEntry, options })
        placed = true
      }
      continue
    }
    next.push(entry)
  }
  if (!markerPlaced) next.push(DISABLED_BUILTIN_GOAL)
  if (!placed) next.push({ package: engineEntry, options })
  return Array.isArray(configOrPlugins) ? next : withServerPluginEntries(configOrPlugins, next)
}

/**
 * Register the goal engine's CLI/TUI entry in `cli.json` `plugins` exactly once
 * as an object pointing at the Rigel-owned TUI shim directory (the host resolves
 * its `.`/`./tui` export to the vendored TUI). The same array carries exactly one
 * `-opencode.goal` marker so the host builtin cannot contend for Goal ownership.
 * A prior version's goal entry is replaced in place; uninstall removes both the
 * shim entry and marker through {@link removeGoalEntries}.
 */
export function registerGoalCliEntry(cliConfig, { tuiShimDir }) {
  const next = { ...(cliConfig && typeof cliConfig === "object" ? cliConfig : {}) }
  const current = Array.isArray(next.plugins) ? next.plugins : []
  const plugins = []
  let goalPlaced = false
  let markerPlaced = false
  for (const entry of current) {
    if (entry === DISABLED_BUILTIN_GOAL) {
      if (!markerPlaced) {
        plugins.push(DISABLED_BUILTIN_GOAL)
        markerPlaced = true
      }
      continue
    }
    if (isGoalEngineEntry(entry)) {
      if (!goalPlaced) {
        plugins.push({ package: tuiShimDir })
        goalPlaced = true
      }
      continue
    }
    plugins.push(entry)
  }
  if (!markerPlaced) plugins.push(DISABLED_BUILTIN_GOAL)
  if (!goalPlaced) plugins.push({ package: tuiShimDir })
  next.plugins = plugins
  return next
}

/** Remove every goal-engine entry and every Goal builtin-disable marker from `opencode.json` and `cli.json`. */
export function removeGoalEntries(config, cliConfig) {
  const hadServerPlugins = Array.isArray(config?.plugins) || Array.isArray(config?.plugin)
  const nextConfig = hadServerPlugins
    ? withServerPluginEntries(config, serverPluginEntries(config).filter((entry) => entry !== DISABLED_BUILTIN_GOAL && !isGoalEngineEntry(entry)))
    : { ...(config && typeof config === "object" ? config : {}) }
  const nextCli = { ...(cliConfig && typeof cliConfig === "object" ? cliConfig : {}) }
  if (Array.isArray(nextCli.plugins)) nextCli.plugins = nextCli.plugins.filter((entry) => entry !== DISABLED_BUILTIN_GOAL && !isGoalEngineEntry(entry))
  return { config: nextConfig, cli: nextCli }
}

/** Count the goal-engine entries in an `opencode.json` / `cli.json` pair. */
export function countGoalEntries(config, cliConfig) {
  const configEntries = serverPluginEntries(config).filter(isGoalEngineEntry).length
  const cliEntries = Array.isArray(cliConfig?.plugins) ? cliConfig.plugins.filter(isGoalEngineEntry).length : 0
  return { config: configEntries, cli: cliEntries }
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex")
}

/**
 * Adopt a COMPATIBLE external community state by copy: verify its digest (when
 * an expected digest is given) and schema version, then write it atomically to
 * the Rigel state path. The source is never moved, deleted or modified. Fails
 * closed on a modified (digest mismatch), newer/unsupported (schema) or V1 state.
 */
export function adoptGoalState({ sourcePath, targetPath, stateRoot, expectedDigest }) {
  if (isV1GoalStatePath(sourcePath)) throw new Error("refusing to read the protected V1 goal state")
  const target = assertGoalStatePathSafe(targetPath, stateRoot)
  const bytes = fs.readFileSync(sourcePath)
  const digest = sha256(bytes)
  if (typeof expectedDigest === "string" && digest !== expectedDigest) {
    throw new Error(`external goal state digest mismatch (expected ${expectedDigest}, got ${digest})`)
  }
  let parsed
  try {
    parsed = JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new Error("external goal state is not valid JSON")
  }
  if (!GOAL_STATE_SCHEMA_VERSIONS.includes(parsed?.version)) {
    throw new Error(`unsupported goal state schema version ${JSON.stringify(parsed?.version)}; supported: ${GOAL_STATE_SCHEMA_VERSIONS.join(", ")}`)
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const temp = `${target}.adopt-${crypto.randomBytes(4).toString("hex")}`
  fs.writeFileSync(temp, bytes, { mode: 0o600 })
  fs.renameSync(temp, target)
  return { target, digest, version: parsed.version, bytes: bytes.length }
}
