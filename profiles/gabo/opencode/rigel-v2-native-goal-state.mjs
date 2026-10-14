/**
 * Safe resolution of `OPENCODE_GOAL_STATE_PATH` inside the Rigel state tree.
 *
 * The vendored community engine reads exactly one persistence seam: the
 * `OPENCODE_GOAL_STATE_PATH` environment variable, falling back to
 * `XDG_DATA_HOME/opencode-goal-plugin/goals.json` when it is unset. That fallback
 * is the protected V1 file from the 2026-10-03 incident, so this module is the
 * single authority that binds the variable to a path INSIDE the versioned Rigel
 * state tree and fails closed on anything else.
 *
 * It lives under `opencode/` so the deployed runtime stages it (`discoverRuntimeModules`
 * walks the runtime's import graph) and can install the variable at setup, before
 * the community engine first touches its state.
 *
 * Only Node built-ins are imported.
 */
import path from "node:path"
import { fileURLToPath } from "node:url"

/** The protected V1 goal state file that must never be read or written. */
export function isV1GoalStatePath(candidate) {
  if (typeof candidate !== "string") return false
  return candidate.split("\\").join("/").endsWith("/.local/share/opencode-goal-plugin/goals.json")
}

/**
 * Fail-closed guard for a goal state path: it must resolve strictly inside the
 * Rigel state root and must never land on the protected V1 surface.
 */
export function assertGoalStatePathSafe(statePath, stateRoot) {
  const target = path.resolve(statePath)
  const root = path.resolve(stateRoot)
  const relative = path.relative(root, target)
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`goal state path ${target} escapes the Rigel state root ${root}`)
  }
  if (isV1GoalStatePath(target)) {
    throw new Error(`goal state path ${target} resolves to the protected V1 goal surface`)
  }
  return target
}

/** The effective state path: `<stateRoot>/goal-state/goals.json`, verified safe. */
export function resolveGoalStatePath(stateRoot) {
  const root = path.resolve(stateRoot)
  return assertGoalStatePathSafe(path.join(root, "goal-state", "goals.json"), root)
}

/**
 * Install `OPENCODE_GOAL_STATE_PATH` for this process, derived from the deployed
 * runtime's own location (`<stateRoot>/versions/<v>/runtime` → `<stateRoot>`).
 *
 * Only a real deployment binds the variable: a source or test load (whose
 * directory does not end in `versions/<v>/runtime`) leaves the environment
 * untouched, so a unit test never mutates process-wide state. Pass `force` to
 * exercise the binding seam directly.
 *
 * An already-set variable is honored only when it is safe; a variable pointing
 * outside the state root or at the V1 surface throws (the host then fails the
 * plugin load instead of silently writing V1 state). When unset, the safe path is
 * installed.
 */
export function installGoalStatePath({ env = process.env, runtimeUrl = import.meta.url, force = false } = {}) {
  const runtimeDir = path.dirname(fileURLToPath(runtimeUrl))
  if (!force && !/[/\\]versions[/\\][^/\\]+[/\\]runtime$/.test(runtimeDir)) return undefined
  const derivedRoot = path.resolve(runtimeDir, "..", "..", "..")
  const existing = env.OPENCODE_GOAL_STATE_PATH
  if (typeof existing === "string" && existing.trim() !== "") {
    return assertGoalStatePathSafe(existing, derivedRoot)
  }
  const target = resolveGoalStatePath(derivedRoot)
  env.OPENCODE_GOAL_STATE_PATH = target
  return target
}
