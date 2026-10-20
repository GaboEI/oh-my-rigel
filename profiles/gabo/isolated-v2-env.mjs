/**
 * Isolation guard for every OpenCode V2 process launched by this profile.
 *
 * Boundary: `.omo/rules/protect-opencode-v1.md`. A process is V2-safe only when
 * its complete home, config, data, state, cache, goal-state, socket and plugin
 * state are inside a disposable sandbox and cannot resolve to the user's real
 * (production V1) OpenCode surfaces. Launching OpenCode with an inherited
 * `{ ...process.env }` is forbidden: the 2026-10-03 incident corrupted V1 goal
 * state exactly that way.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const REAL_HOME = os.homedir()

export const PROTECTED_V1_ROOTS = [
  path.join(REAL_HOME, ".config/opencode"),
  path.join(REAL_HOME, ".local/share/opencode"),
  path.join(REAL_HOME, ".local/share/opencode-goal-plugin"),
  path.join(REAL_HOME, ".cache/opencode"),
]

// State-bearing variables that must never be inherited from the launching
// environment: they can point at production V1 even when HOME is replaced.
const STATE_ENV_KEYS = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "OPENCODE_GOAL_STATE_PATH",
  // The installer's own state-root selector: an inherited value would place the
  // install (and the runtime's derived state root) outside the sandbox.
  "RIGEL_V2_USER_ROOT",
  "OMO_CODING_AGENT_DIR",
  "SENPI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
]

// Any variable under these prefixes is owned by the sandbox builder. An
// inherited OPENCODE_* variable (for example the production account store
// `OPENCODE_MULTI_AUTH_STORE_DIR`) must never reach a harness-spawned child.
const STATE_ENV_PREFIXES = ["OPENCODE_", "OMO_", "XDG_", "SENPI_", "PI_"]

// Environment that is safe to inherit: it selects an interpreter, locale or
// terminal, never a persistent state root.
const INHERIT_ALLOWLIST = new Set(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "SHELL", "USER", "LOGNAME", "PWD", "TMPDIR", "NODE_OPTIONS", "BUN_INSTALL"])

function inside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function pointsIntoRealHome(value) {
  if (typeof value !== "string" || !value.startsWith("/")) return false
  const candidate = path.resolve(value)
  return candidate === REAL_HOME || candidate.startsWith(REAL_HOME + path.sep)
}

function pointsIntoProtectedRoot(value) {
  if (typeof value !== "string" || !value.startsWith("/")) return false
  const candidate = path.resolve(value)
  return PROTECTED_V1_ROOTS.some((root) => candidate === root || candidate.startsWith(root + path.sep))
}

/**
 * The installer's default Rigel state root for an isolated launch:
 * `--state` / `RIGEL_V2_USER_ROOT`, else `<XDG_DATA_HOME>/oh-my-rigel`, and
 * `XDG_DATA_HOME` is `<sandbox>/data` here. The goal state must live INSIDE it,
 * because the deployed runtime derives the same root from its own location
 * (`<stateRoot>/versions/<v>/runtime` -> `<stateRoot>`) and fails closed when
 * `OPENCODE_GOAL_STATE_PATH` escapes it.
 */
function defaultRigelStateRoot(sandbox) {
  return path.join(path.resolve(sandbox), "data", "oh-my-rigel")
}

/**
 * The state root a deployed runtime derives for itself: it walks three levels up
 * from `<stateRoot>/versions/<version>/runtime`. Anything else has no derivable
 * root (a source checkout or a test load), and the runtime installs nothing.
 * This mirrors `installGoalStatePath` exactly; keep the two in step.
 */
export function rigelStateRootFromRuntime(runtimeDir) {
  if (typeof runtimeDir !== "string" || !path.isAbsolute(runtimeDir)) return undefined
  const resolved = path.resolve(runtimeDir)
  if (!/[/\\]versions[/\\][^/\\]+[/\\]runtime$/.test(resolved)) return undefined
  return path.resolve(resolved, "..", "..", "..")
}

/**
 * A goal state file the runtime refuses is a launch that loads ZERO plugin
 * registrations (no tools, no prompt seams, no slash command): the host logs a
 * WARN and keeps going, so the run looks isolated and proves nothing. Refuse it
 * before the process starts, with the runtime's own wording.
 */
export function assertGoalStateInsideRigelStateRoot(statePath, stateRoot) {
  const target = path.resolve(statePath)
  const root = path.resolve(stateRoot)
  const relative = path.relative(root, target)
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`goal state path ${target} escapes the Rigel state root ${root}`)
  }
  return target
}

/**
 * Builds an environment whose every state root lives under `sandbox`.
 * `home` optionally overrides the sandbox home directory. `rigelStateRoot`
 * selects where the install (and therefore the runtime's goal state) lives; it
 * defaults to the installer's own default so the environment the builder hands
 * out is one the deployed runtime actually accepts.
 */
export function buildIsolatedV2Env({ sandbox, home = path.join(sandbox, "home"), extra = {}, rigelStateRoot } = {}) {
  if (typeof sandbox !== "string" || sandbox.length === 0) throw new Error("buildIsolatedV2Env requires a sandbox directory")
  const sandboxRoot = path.resolve(sandbox)
  if (inside(REAL_HOME, sandboxRoot) && sandboxRoot !== REAL_HOME) {
    throw new Error(`refusing isolation inside the real home: ${sandboxRoot}`)
  }
  const env = { ...process.env }
  const stripped = []
  for (const key of Object.keys(env)) {
    const owned = STATE_ENV_KEYS.includes(key) || STATE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    if (owned) { stripped.push(key); delete env[key]; continue }
    if (INHERIT_ALLOWLIST.has(key)) continue
    if (pointsIntoRealHome(env[key]) || pointsIntoProtectedRoot(env[key])) {
      stripped.push(key)
      delete env[key]
    }
  }
  // An explicit request (argument or `extra`) wins over the default; the goal
  // state is then derived from the SAME root, never from a second guess. An
  // inherited `RIGEL_V2_USER_ROOT` is honored only when it already points inside
  // this sandbox: the caller's install layout is preserved when it is safe, and a
  // root outside the sandbox is replaced instead of trusted.
  const inheritedRoot = process.env.RIGEL_V2_USER_ROOT
  const sandboxScopedRoot = typeof inheritedRoot === "string" && inheritedRoot.startsWith("/") && inside(sandboxRoot, path.resolve(inheritedRoot))
    ? path.resolve(inheritedRoot)
    : undefined
  const requestedRoot = extra.RIGEL_V2_USER_ROOT ?? rigelStateRoot ?? sandboxScopedRoot
  const stateRoot = path.resolve(requestedRoot ?? defaultRigelStateRoot(sandboxRoot))
  const isolated = {
    ...env,
    HOME: path.resolve(home),
    XDG_CONFIG_HOME: path.join(sandboxRoot, "config"),
    XDG_DATA_HOME: path.join(sandboxRoot, "data"),
    XDG_STATE_HOME: path.join(sandboxRoot, "state"),
    XDG_CACHE_HOME: path.join(sandboxRoot, "cache"),
    RIGEL_V2_USER_ROOT: stateRoot,
    OPENCODE_GOAL_STATE_PATH: path.join(stateRoot, "goal-state", "goals.json"),
    ...extra,
  }
  assertIsolatedV2Env(isolated, { sandbox: sandboxRoot, rigelStateRoot: isolated.RIGEL_V2_USER_ROOT })
  Object.defineProperty(isolated, "__rigelStrippedEnvKeys", { value: stripped, enumerable: false })
  return isolated
}

/**
 * Positive proof of isolation. Throws on the first violation; returns a
 * report that can be written to evidence before the process starts.
 *
 * `rigelStateRoot` is the root the launched runtime will derive for itself: when
 * known, the goal state must live inside it, because the runtime treats any
 * other value as a fatal configuration error and the host then loads no plugin
 * at all (row 55 host retest 3: the plugin died on this mismatch, so `/team-mode`
 * reached the model as literal text and `team_create` never existed).
 */
export function assertIsolatedV2Env(env, { sandbox, rigelStateRoot } = {}) {
  const sandboxRoot = path.resolve(sandbox)
  const checks = [
    ["HOME", env.HOME],
    ["XDG_CONFIG_HOME", env.XDG_CONFIG_HOME],
    ["XDG_DATA_HOME", env.XDG_DATA_HOME],
    ["XDG_STATE_HOME", env.XDG_STATE_HOME],
    ["XDG_CACHE_HOME", env.XDG_CACHE_HOME],
    ["OPENCODE_GOAL_STATE_PATH", env.OPENCODE_GOAL_STATE_PATH],
  ]
  const report = []
  for (const [key, value] of checks) {
    if (typeof value !== "string" || value.length === 0) throw new Error(`isolation violation: ${key} is unset`)
    const resolved = path.resolve(value)
    if (!inside(sandboxRoot, resolved)) throw new Error(`isolation violation: ${key}=${resolved} escapes the sandbox ${sandboxRoot}`)
    if (resolved === REAL_HOME || (!inside(resolved, REAL_HOME) && inside(REAL_HOME, resolved) && resolved !== REAL_HOME)) {
      throw new Error(`isolation violation: ${key}=${resolved} resolves into the real home`)
    }
    for (const protectedRoot of PROTECTED_V1_ROOTS) {
      if (resolved === protectedRoot || inside(protectedRoot, resolved)) {
        throw new Error(`isolation violation: ${key}=${resolved} touches protected V1 surface ${protectedRoot}`)
      }
    }
    report.push(`${key}=${resolved}`)
  }
  const goalState = path.resolve(env.OPENCODE_GOAL_STATE_PATH)
  if (goalState === path.join(REAL_HOME, ".local/share/opencode-goal-plugin/goals.json")) {
    throw new Error("isolation violation: goal state resolves to the production V1 goal store")
  }
  if (typeof rigelStateRoot === "string" && rigelStateRoot) {
    assertGoalStateInsideRigelStateRoot(goalState, rigelStateRoot)
  }
  return { sandbox: sandboxRoot, realHome: REAL_HOME, rigelStateRoot, checks: report }
}

/** Convenience for contracts: build env + write the proof next to the run. */
export function buildIsolatedV2EnvWithEvidence({ sandbox, home, extra, evidenceSink, rigelStateRoot } = {}) {
  const env = buildIsolatedV2Env({ sandbox, home, extra, rigelStateRoot })
  const report = assertIsolatedV2Env(env, { sandbox, rigelStateRoot: env.RIGEL_V2_USER_ROOT })
  if (typeof evidenceSink === "function") evidenceSink(report)
  else if (typeof evidenceSink === "string") {
    fs.mkdirSync(path.dirname(evidenceSink), { recursive: true, mode: 0o700 })
    fs.writeFileSync(evidenceSink, `${report.checks.join("\n")}\n`, { mode: 0o600 })
  }
  return env
}

export { REAL_HOME }


// ---------------------------------------------------------------------------
// Launch config-chain audit
// ---------------------------------------------------------------------------
//
// State-root isolation is necessary but NOT sufficient: the OpenCode host merges
// EVERY plugin list it can resolve (the global `$XDG_CONFIG_HOME/opencode/
// opencode.json` and the `OPENCODE_CONFIG` override included). A launch whose
// chain declares two Rigel runtimes loads both plugins in one process, and the
// runtime that registered first keeps the tool names and the prompt seams, so the
// newer runtime never executes — the run then reports the OLDER code's behaviour
// (row 55 host retest 2: worktrees provisioned despite `worktree: no`, members
// left as records with no child session, and therefore a single pane).
//
// These helpers make that launch fail before it starts.

/**
 * A materialized Rigel runtime is identified by its own module set, never by a
 * name or a path convention: every delivered runtime directory carries
 * `rigel-v2-native-core.mjs` (the source checkout also carries
 * `rigel-v2-native.mjs`). The vendored goal engine lives inside the same tree
 * and carries `server.js` instead, so it is never mistaken for a runtime.
 */
const RIGEL_RUNTIME_MARKERS = Object.freeze(["rigel-v2-native-core.mjs", "rigel-v2-native.mjs"])

export function isRigelRuntimeDir(candidate, { existsSync = fs.existsSync } = {}) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) return false
  try {
    return RIGEL_RUNTIME_MARKERS.some((marker) => existsSync(path.join(candidate, marker)) === true)
  } catch {
    return false
  }
}

/** The path of one plugin entry: a bare string, or `[path, options]`. */
function pluginEntryPath(entry) {
  if (typeof entry === "string") return entry
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0]
  return undefined
}

/** Every Rigel runtime a plugin list declares, resolved and de-duplicated. */
export function rigelRuntimeEntries(plugins, { existsSync } = {}) {
  if (!Array.isArray(plugins)) return []
  const runtimes = []
  for (const entry of plugins) {
    const candidate = pluginEntryPath(entry)
    if (!isRigelRuntimeDir(candidate, existsSync ? { existsSync } : undefined)) continue
    const resolved = path.resolve(candidate)
    if (!runtimes.includes(resolved)) runtimes.push(resolved)
  }
  return runtimes
}

/**
 * The config sources a launch actually merges, with the plugin list each one
 * declares. Absent files are skipped: an unreadable or malformed config declares
 * no runtime here (the host reports its own parse error).
 */
export function launchConfigSources({ env = process.env, readJson, existsSync = fs.existsSync } = {}) {
  const home = typeof env.HOME === "string" && env.HOME ? env.HOME : REAL_HOME
  const configDir = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME
    ? env.XDG_CONFIG_HOME
    : path.join(home, ".config")
  const files = [path.join(configDir, "opencode", "opencode.json")]
  if (typeof env.OPENCODE_CONFIG === "string" && env.OPENCODE_CONFIG) files.push(env.OPENCODE_CONFIG)
  const read = readJson ?? ((file) => JSON.parse(fs.readFileSync(file, "utf8")))
  const sources = []
  for (const file of files) {
    if (!existsSync(file)) continue
    let plugins = []
    try {
      const parsed = read(file)
      if (Array.isArray(parsed?.plugin)) plugins = parsed.plugin
    } catch {
      plugins = []
    }
    sources.push({ source: path.resolve(file), plugins })
  }
  return sources
}

/**
 * Refuse a config chain that can load more than ONE Rigel runtime.
 *
 * Returns `{ runtimes, sources }` when the chain is unambiguous, and throws the
 * exact violation otherwise: a second runtime cannot be "partly active", it only
 * wins or loses registrations, so there is no safe degraded mode.
 */
export function assertSingleRigelRuntime({ configs = [], existsSync } = {}) {
  const runtimes = []
  const declarations = []
  for (const config of Array.isArray(configs) ? configs : []) {
    for (const runtime of rigelRuntimeEntries(config?.plugins, existsSync ? { existsSync } : undefined)) {
      declarations.push({ source: config?.source, runtime })
      if (!runtimes.includes(runtime)) runtimes.push(runtime)
    }
  }
  if (runtimes.length > 1) {
    const detail = declarations.map((entry) => `${entry.runtime} (from ${entry.source})`).join(", ")
    throw new Error(`isolation violation: ${runtimes.length} Rigel runtimes are reachable from the launch config chain: ${detail}. The host loads every declared plugin in one process and the first registration keeps the tool names and prompt seams, so the newer runtime never executes. Launch with a chain that declares exactly one runtime: HOME/XDG inside the sandbox and no OPENCODE_CONFIG pointing at another config.`)
  }
  return { runtimes, sources: declarations }
}

/** The launch-time form: audit the config chain the host would actually merge. */
export function assertSingleRigelRuntimeInLaunch({ env = process.env, readJson, existsSync } = {}) {
  return assertSingleRigelRuntime({ configs: launchConfigSources({ env, readJson, existsSync }), existsSync })
}

// ---------------------------------------------------------------------------
// Launch goal-state / runtime-root agreement
// ---------------------------------------------------------------------------
//
// A chain that declares exactly ONE runtime can still be unusable: the deployed
// runtime derives its state root from its own location and treats an
// `OPENCODE_GOAL_STATE_PATH` outside that root as fatal, so the host loads the
// plugin with ZERO registrations (no tools, no prompt seams, no slash command)
// and keeps serving prompts. Row 55 host retest 3 was exactly this: the goal
// state lived in `<sandbox>/goal-state` while the install lived in
// `<sandbox>/rigel`, the plugin died during setup, `/team-mode` reached the model
// as literal text, `team_create` did not exist, and the run looked isolated.

/**
 * Refuse a goal-state variable the runtime this launch loads would reject.
 *
 * An UNSET variable is always consistent: the runtime installs its own default
 * (`<stateRoot>/goal-state/goals.json`). A SET variable must land inside the
 * state root derived from the runtime's deployed location.
 */
export function assertLaunchGoalStateMatchesRuntime({ env = process.env, readJson, existsSync } = {}) {
  const sources = launchConfigSources({ env, readJson, existsSync })
  const audited = assertSingleRigelRuntime({ configs: sources, existsSync })
  const stateRoots = audited.runtimes.map((runtime) => rigelStateRootFromRuntime(runtime)).filter(Boolean)
  const configured = env.OPENCODE_GOAL_STATE_PATH
  if (typeof configured !== "string" || configured.trim() === "") {
    return { runtimes: audited.runtimes, stateRoots, goalStatePath: undefined, installedByRuntime: true }
  }
  const target = path.resolve(configured)
  if (stateRoots.length === 0) {
    // A runtime with no derivable state root (source checkout) installs nothing.
    return { runtimes: audited.runtimes, stateRoots, goalStatePath: target, installedByRuntime: false }
  }
  if (!stateRoots.some((root) => inside(root, target))) {
    throw new Error(`isolation violation: goal state path ${target} escapes the Rigel state root ${stateRoots[0]} derived from the runtime this launch loads (${audited.runtimes.join(", ")}). That runtime fails closed on the mismatch, so the host loads the plugin with NO registrations at all: no tools, no prompt seam, no slash command. Point the goal state at ${path.join(stateRoots[0], "goal-state", "goals.json")} (or unset it).`)
  }
  return { runtimes: audited.runtimes, stateRoots, goalStatePath: target, installedByRuntime: false }
}