/**
 * Oh My Rigel sidebar, V2 companion CLI plugin surface.
 *
 * V1 `features/tui-sidebar/` ran as two processes joined by a JSON mirror on
 * disk: the plugin wrote runtime snapshots, the TUI reader derived the view and
 * registered a `sidebar_content` slot. OpenCode V2 exposes the sidebar to the
 * CLI plugin directly, so the mirror file is replaced by a reactive CLI slot.
 *
 * Effect mapping, V1 -> V2 CLI context:
 *   plugin writer -> `buildTuiRuntimeSnapshot`  -> `buildRuntimeSnapshot()` from
 *                     session/status/background data read via `context.data`
 *   TUI reader    -> derivers + `computeView`   -> the same pure core
 *   `sidebar_content` slot -> `context.ui.slot({ append: "sidebar.content", render })`
 *   mirror file   -> a durable snapshot receipt under
 *                    `$XDG_STATE_HOME/oh-my-rigel/sidebar-snapshot.json`,
 *                    written on every refresh so a headless lab can assert it
 *
 * The pure half lives in `rigel-v2-sidebar-core.mjs`. This module is the thin
 * runtime adapter: it reads `context.data`, writes the receipt, and registers
 * the slot. It is gated on `context.options?.tui?.sidebar?.enabled !== false`
 * (absent means enabled; an explicit `false` registers nothing and writes
 * nothing). Without a live renderer the UI registration is skipped but the
 * receipt is still written, so the surface is QA-assertable headless. Every
 * effect is contained and logged; a failure never throws into the host.
 *
 * RPC: NOT USED. No real `context.rpc` example could be confirmed in this
 * repository, so this surface deliberately reads `context.data` and writes the
 * durable snapshot receipt instead.
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import {
  buildRuntimeSnapshot,
  computeLoopLive,
  computeView,
  deriveAgents,
  deriveConfig,
  deriveJobBoard,
  deriveLoop,
  deriveRoster,
  describeView,
  isLoopFresh,
  parseLoopDocument,
  toRosterRow,
  viewKey,
} from "./rigel-v2-sidebar-core.mjs"

export const SIDEBAR_CLI_ID = "oh-my-rigel.sidebar"

/** The V2 sidebar content slot this surface appends to. */
export const SIDEBAR_SLOT_APPEND = "sidebar.content"

const ACTIVE_AGENT_STATUSES = new Set(["busy", "retry", "running"])

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

/**
 * Gate on `context.options?.tui?.sidebar?.enabled !== false`. An absent block
 * means enabled; an explicit `false` yields `null` and the caller registers and
 * writes exactly nothing.
 */
export function resolveSidebarGate(options) {
  const sidebar = options?.tui?.sidebar
  if (isObject(sidebar) && sidebar.enabled === false) return null
  return { enabled: true }
}

function resolveStateRoot(overrides) {
  if (typeof overrides?.stateRoot === "string" && overrides.stateRoot.length > 0) return overrides.stateRoot
  return process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
}

/** The durable snapshot receipt path, mirroring the notification surface. */
export function resolveSidebarSnapshotPath(overrides = {}) {
  if (typeof overrides.snapshotPath === "string" && overrides.snapshotPath.length > 0) return overrides.snapshotPath
  return join(resolveStateRoot(overrides), "oh-my-rigel", "sidebar-snapshot.json")
}

function resolveLogPath(overrides) {
  if (typeof overrides?.logFile === "string" && overrides.logFile.length > 0) return overrides.logFile
  return join(resolveStateRoot(overrides), "oh-my-rigel", "sidebar.log")
}

function createLogger(logPath) {
  let active = true
  return (entry) => {
    if (!active) return
    try {
      mkdirSync(dirname(logPath), { recursive: true })
      appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf-8")
    } catch (error) {
      if (error instanceof Error) active = false
    }
  }
}

/* ------------------------------------------------------------------ *
 * context.data readers (tolerant of the evolving V2 data shapes)
 * ------------------------------------------------------------------ */

function resolveDirectory(context, overrides) {
  return (
    overrides?.directory ??
    context?.location?.current?.directory ??
    context?.location?.directory ??
    process.cwd()
  )
}

function readSessions(context) {
  const data = context?.data
  if (!data) return []
  const candidates = [
    () => data.session?.list?.(),
    () => data.session?.all?.(),
    () => (Array.isArray(data.sessions) ? data.sessions : undefined),
    () => data.sessions?.list?.(),
  ]
  for (const candidate of candidates) {
    try {
      const value = candidate()
      if (Array.isArray(value)) return value
    } catch (error) {
      if (!(error instanceof Error)) throw error
    }
  }
  return []
}

function sessionStatus(session) {
  const candidate = session?.status ?? session?.state ?? session?.type
  if (typeof candidate === "string") return candidate
  if (isObject(candidate) && typeof candidate.type === "string") return candidate.type
  return undefined
}

function sessionName(session, id) {
  return firstString(session?.agent, session?.agentName, session?.title, id)
}

/** V1 `activeAgentsFromStatuses`: keep only busy/retry/running, name-resolved. */
function activeAgentsFromSessions(sessions) {
  const rows = []
  for (const session of sessions) {
    if (!isObject(session)) continue
    const status = sessionStatus(session)
    if (!ACTIVE_AGENT_STATUSES.has(status)) continue
    const id = firstString(session.id, session.sessionID, session.name)
    rows.push({ name: sessionName(session, id) ?? "session", status })
  }
  return rows
}

/** V1 `getTasksSnapshot()` mapped through `toJobRow` by the core builder. */
function readBackgroundTasks(context) {
  const data = context?.data
  if (!data) return []
  const candidates = [data.background?.tasks, data.backgroundTasks, data.jobs, data.tasks]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate
  }
  return []
}

function normalizeRosterEntry(entry) {
  if (typeof entry === "string") return { label: entry, model: "" }
  if (isObject(entry)) return toRosterRow(entry)
  return null
}

function readRosterRows(context) {
  const data = context?.data
  if (!data) return []
  const candidates = [data.roster, data.agents, data.models]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.map(normalizeRosterEntry).filter((row) => row !== null)
    }
  }
  return []
}

/* ------------------------------------------------------------------ *
 * Loop reading from disk (V1 loop-reader.ts, non-pure half)
 * ------------------------------------------------------------------ */

function statCandidate(path) {
  try {
    return { path, mtimeMs: statSync(path).mtimeMs }
  } catch (error) {
    if (error instanceof Error) return null
    throw error
  }
}

function enumerateLoopCandidates(projectDir) {
  const loopRoot = join(projectDir, ".omo", "ulw-loop")
  let entries
  try {
    entries = readdirSync(loopRoot, { withFileTypes: true })
  } catch (error) {
    if (!(error instanceof Error)) throw error
    entries = []
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => statCandidate(join(loopRoot, entry.name, "goals.json")))
    .filter((candidate) => candidate !== null)
  const legacy = statCandidate(join(projectDir, ".omo", "loop", "goals.json"))
  if (legacy !== null) candidates.push(legacy)
  return candidates
}

function readParsedLoopDocument(path) {
  try {
    return parseLoopDocument(JSON.parse(readFileSync(path, "utf8")))
  } catch (error) {
    if (error instanceof Error) return null
    throw error
  }
}

function readLiveCandidate(candidate, now) {
  if (!isLoopFresh(candidate.mtimeMs, now)) return null
  const parsed = readParsedLoopDocument(candidate.path)
  if (parsed === null || !parsed.goals.some((goal) => goal.status === "in_progress")) return null
  return { state: computeLoopLive(parsed), mtimeMs: candidate.mtimeMs }
}

/** V1 `readActiveLoop`: the freshest live loop wins, otherwise `{ kind: "none" }`. */
export function readActiveLoop(projectDir, now) {
  try {
    const live = enumerateLoopCandidates(projectDir)
      .map((candidate) => readLiveCandidate(candidate, now))
      .filter((candidate) => candidate !== null)
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
    return live[0]?.state ?? { kind: "none" }
  } catch (error) {
    if (error instanceof Error) return { kind: "none" }
    throw error
  }
}

/* ------------------------------------------------------------------ *
 * Surface
 * ------------------------------------------------------------------ */

/**
 * Build the sidebar CLI surface. `overrides` carries the test seams (`stateRoot`,
 * `snapshotPath`, `logFile`, `log`, `now`, `directory`, `renderView`, `config`);
 * the live configuration is read from `context.options`.
 */
export function createSidebarCliSurface(overrides = {}) {
  return {
    id: SIDEBAR_CLI_ID,
    setup(context) {
      const gate = resolveSidebarGate(context?.options ?? overrides.options)
      if (!gate) return undefined

      const logger =
        typeof overrides.log === "function" ? overrides.log : createLogger(resolveLogPath(overrides))
      const now = typeof overrides.now === "function" ? overrides.now : () => Date.now()
      const snapshotPath = resolveSidebarSnapshotPath(overrides)
      const directory = resolveDirectory(context, overrides)
      const renderer = context?.renderer
      const hasRenderer = Boolean(renderer) && renderer.isDestroyed !== true
      const disposers = []
      let currentView = null

      logger({ event: "setup", enabled: true, headless: !hasRenderer })

      const compute = () => {
        const snapshot = buildRuntimeSnapshot({
          projectDir: directory,
          updatedAt: now(),
          activeAgents: activeAgentsFromSessions(readSessions(context)),
          jobBoard: readBackgroundTasks(context),
          loop: readActiveLoop(directory, now()),
        })
        const config = typeof overrides.config === "function" ? overrides.config() : { valid: true, messages: [] }
        const view = computeView({
          config: deriveConfig(config),
          roster: deriveRoster(readRosterRows(context)),
          agents: deriveAgents(snapshot),
          jobs: deriveJobBoard(snapshot),
          loop: deriveLoop(snapshot),
        })
        return { snapshot, view }
      }

      const writeReceipt = (snapshot, view) => {
        try {
          mkdirSync(dirname(snapshotPath), { recursive: true })
          const receipt = { ...snapshot, view, viewKey: viewKey(view) }
          writeFileSync(snapshotPath, JSON.stringify(receipt), { mode: 0o600 })
          return true
        } catch (error) {
          logger({ event: "receipt-write-failed", error: describeError(error) })
          return false
        }
      }

      const refresh = () => {
        try {
          const { snapshot, view } = compute()
          currentView = view
          const written = writeReceipt(snapshot, view)
          logger({ event: "refresh", viewKind: view.kind, viewKey: viewKey(view), written })
          return view
        } catch (error) {
          logger({ event: "refresh-failed", error: describeError(error) })
          return currentView
        }
      }

      const renderView = (view) => {
        try {
          if (typeof overrides.renderView === "function") return overrides.renderView(view)
          return describeView(view)
        } catch (error) {
          logger({ event: "render-failed", error: describeError(error) })
          return ""
        }
      }

      const render = () => {
        try {
          const { view } = compute()
          currentView = view
          return renderView(view)
        } catch (error) {
          logger({ event: "render-failed", error: describeError(error) })
          return ""
        }
      }

      if (hasRenderer) {
        const slot = context?.ui?.slot
        if (typeof slot === "function") {
          try {
            const result = slot({ append: SIDEBAR_SLOT_APPEND, render })
            if (typeof result === "function") disposers.push(result)
            else if (result && typeof result.dispose === "function") disposers.push(() => result.dispose())
            logger({ event: "slot-registered", append: SIDEBAR_SLOT_APPEND })
          } catch (error) {
            logger({ event: "slot-register-failed", error: describeError(error) })
          }
        } else {
          logger({ event: "slot-unavailable" })
        }
      } else {
        logger({ event: "headless-receipt-only" })
      }

      // The receipt is written even headless, so a lab run can assert the
      // computed view without a TUI.
      refresh()

      const subscribe = (name) => {
        if (typeof context?.data?.on !== "function") return
        try {
          const off = context.data.on(name, () => refresh())
          if (typeof off === "function") disposers.push(off)
        } catch (error) {
          logger({ event: "subscribe-failed", name, error: describeError(error) })
        }
      }

      for (const name of [
        "session.created",
        "session.deleted",
        "session.updated",
        "session.execution.started",
        "session.execution.succeeded",
        "session.execution.failed",
      ]) {
        subscribe(name)
      }

      return () => {
        for (const dispose of disposers.reverse()) {
          try {
            dispose()
          } catch (error) {
            logger({ event: "dispose-failed", error: describeError(error) })
          }
        }
      }
    },
  }
}

export default createSidebarCliSurface()
