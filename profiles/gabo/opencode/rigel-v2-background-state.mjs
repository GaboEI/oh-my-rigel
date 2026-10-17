/**
 * Durable background-task state for Oh My Rigel's native OpenCode V2 runtime.
 *
 * The V1 owner keeps the background queue, active children, and undelivered
 * parent wakes in memory and persists only a coarse run-continuation marker, so
 * those are lost on restart. The T20 contract requires the queue, the active
 * tasks, and the wakes to survive a restart and be reconciled without losing or
 * duplicating work, so this module persists the real per-parent background state
 * as JSON and the manager reconciles it at setup.
 *
 * Layout: `<directory>/.omo/background/<parentSessionID>.json`
 *   {
 *     schema: 1,
 *     parentSessionID,
 *     parentDirectory,
 *     updatedAt,
 *     tasks: [{ taskId, status, route, agent, category, subagentType, model, key,
 *               limit, sessionID, prompt, loadSkills, createdAt }],
 *     wakes: [{ taskId, sessionID, status, agent }]
 *   }
 *
 * `parentDirectory` is the parent session's own project directory, so a restart
 * refreshes the continuation marker in that project instead of the plugin
 * instance's static location.
 *
 * `prompt` is persisted only while a descriptor has NOT started (queued /
 * starting); once a child owns the work its session carries it, so the prompt is
 * dropped from the durable state to bound size.
 *
 * Writes are atomic (temp file + rename) and best-effort: a filesystem failure
 * never breaks the runtime. No imports beyond `node:fs` / `node:path`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** State directory relative to the project directory. */
export const BACKGROUND_STATE_DIR = ".omo/background"

function stateDir(directory) {
  return join(directory, BACKGROUND_STATE_DIR)
}

function statePath(directory, parentSessionID) {
  return join(stateDir(directory), `${parentSessionID}.json`)
}

function isDirectory(value) {
  return typeof value === "string" && value.length > 0
}

/**
 * Write the durable state for one parent session. Returns true when the file was
 * written, false on any filesystem failure or invalid input.
 */
export function writeBackgroundState(directory, parentSessionID, state, now) {
  if (!isDirectory(directory) || typeof parentSessionID !== "string" || parentSessionID.length === 0) return false
  const timestamp = typeof now === "function" ? now() : new Date().toISOString()
  const payload = {
    schema: 1,
    parentSessionID,
    // The parent's own project directory, so a restart writes and clears its
    // continuation marker inside that project rather than the plugin location.
    parentDirectory: typeof state?.parentDirectory === "string" && state.parentDirectory.length > 0 ? state.parentDirectory : undefined,
    updatedAt: timestamp,
    tasks: Array.isArray(state?.tasks) ? state.tasks : [],
    wakes: Array.isArray(state?.wakes) ? state.wakes : [],
  }
  const file = statePath(directory, parentSessionID)
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    mkdirSync(stateDir(directory), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 })
    renameSync(temporary, file)
    return true
  } catch (error) {
    if (error instanceof Error) return false
    return false
  }
}

/**
 * Read the durable state for one parent session, or null when the file is
 * absent or malformed.
 */
export function readBackgroundState(directory, parentSessionID) {
  if (!isDirectory(directory) || typeof parentSessionID !== "string" || parentSessionID.length === 0) return null
  const file = statePath(directory, parentSessionID)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return {
      schema: parsed.schema ?? 0,
      parentSessionID: typeof parsed.parentSessionID === "string" ? parsed.parentSessionID : parentSessionID,
      parentDirectory: typeof parsed.parentDirectory === "string" ? parsed.parentDirectory : undefined,
      updatedAt: parsed.updatedAt,
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      wakes: Array.isArray(parsed.wakes) ? parsed.wakes : [],
    }
  } catch (error) {
    if (error instanceof Error) return null
    return null
  }
}

/** List every parent-session id that has a durable state file. */
export function listBackgroundStateParents(directory) {
  if (!isDirectory(directory)) return []
  const dir = stateDir(directory)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json") && !name.includes(".tmp-"))
      .map((name) => name.slice(0, -".json".length))
  } catch (error) {
    if (error instanceof Error) return []
    return []
  }
}

/**
 * Async store interface the background manager persists through. The manager
 * never touches a file or `ctx.storage` directly; it calls this contract, so the
 * official `ctx.storage` surface (durable JSON scoped to the plugin id) can back
 * it in the runtime while tests inject a deterministic file/in-memory store.
 *
 *   write(parentSessionID, { tasks, wakes }) => Promise<boolean>
 *   read(parentSessionID) => Promise<state|null>
 *   list() => Promise<string[]>
 *   clear(parentSessionID) => Promise<void>
 */
export function createNoopBackgroundState() {
  return {
    async write() { return false },
    async read() { return null },
    async list() { return [] },
    async clear() {},
  }
}

/** The file-backed store (kept for tests and hosts without `ctx.storage`). */
export function createFileBackgroundState(directory, now) {
  return {
    async write(parentSessionID, state) { return writeBackgroundState(directory, parentSessionID, state, now) },
    async read(parentSessionID) { return readBackgroundState(directory, parentSessionID) },
    async list() { return listBackgroundStateParents(directory) },
    async clear(parentSessionID) { clearBackgroundState(directory, parentSessionID) },
  }
}

/**
 * The official `ctx.storage`-backed store. Keys are namespaced under
 * `background/state/<parentSessionID>` with an index at `background/index` so
 * the manager can enumerate parents without a filesystem. `storage` is the V2
 * plugin storage domain (`get`/`set`/`remove`/`scan`, all async).
 */
export function createStorageBackgroundState({ storage, now } = {}) {
  const INDEX_KEY = "background/index"
  const keyFor = (parentSessionID) => `background/state/${parentSessionID}`
  const canUse = () => Boolean(storage) && typeof storage.get === "function" && typeof storage.set === "function"
  async function readIndex() {
    if (!canUse()) return []
    const value = await storage.get(INDEX_KEY)
    return Array.isArray(value) ? value.filter((id) => typeof id === "string") : []
  }
  return {
    async write(parentSessionID, state) {
      if (!canUse() || typeof parentSessionID !== "string" || parentSessionID.length === 0) return false
      try {
        await storage.set(keyFor(parentSessionID), {
          schema: 1,
          parentSessionID,
          parentDirectory: typeof state?.parentDirectory === "string" && state.parentDirectory.length > 0 ? state.parentDirectory : undefined,
          updatedAt: typeof now === "function" ? now() : new Date().toISOString(),
          tasks: Array.isArray(state?.tasks) ? state.tasks : [],
          wakes: Array.isArray(state?.wakes) ? state.wakes : [],
        })
        const ids = await readIndex()
        if (!ids.includes(parentSessionID)) {
          ids.push(parentSessionID)
          await storage.set(INDEX_KEY, ids)
        }
        return true
      } catch (error) {
        if (error instanceof Error) return false
        return false
      }
    },
    async read(parentSessionID) {
      if (!canUse()) return null
      const value = await storage.get(keyFor(parentSessionID))
      return value && typeof value === "object" && !Array.isArray(value) ? value : null
    },
    async list() {
      if (!canUse()) return []
      const ids = await readIndex()
      if (ids.length > 0) return ids
      if (typeof storage.scan !== "function") return []
      const page = await storage.scan({ prefix: "background/state/" })
      return (page?.entries ?? []).map((entry) => entry.key.slice("background/state/".length))
    },
    async clear(parentSessionID) {
      if (!canUse()) return
      if (typeof storage.remove === "function") await storage.remove(keyFor(parentSessionID))
      const ids = await readIndex()
      const next = ids.filter((id) => id !== parentSessionID)
      if (next.length !== ids.length) await storage.set(INDEX_KEY, next)
    },
  }
}

/** Remove the durable state file for one parent session. Best-effort. */
export function clearBackgroundState(directory, parentSessionID) {
  if (!isDirectory(directory) || typeof parentSessionID !== "string" || parentSessionID.length === 0) return
  const file = statePath(directory, parentSessionID)
  if (!existsSync(file)) return
  try {
    rmSync(file)
  } catch (error) {
    if (error instanceof Error) return
    return
  }
}
