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
import manifest from "./rigel-v2-native-agent-manifest.mjs"
import categoryManifest from "./rigel-v2-category-manifest.mjs"
import { agentChain, categoryChain } from "./rigel-v2-native-model-chains.mjs"
import {
  buildRosterRows,
  buildRuntimeSnapshot,
  computeLoopLive,
  computeView,
  deriveAgents,
  deriveConfig,
  deriveJobBoard,
  deriveLoop,
  deriveRoster,
  isLoopFresh,
  parseLoopDocument,
  toRosterRow,
  viewKey,
} from "./rigel-v2-sidebar-core.mjs"
import { buildViewNodes } from "./rigel-v2-sidebar-core.mjs"
import { materialize } from "./rigel-v2-sidebar-node.mjs"
import { adaptTheme } from "./rigel-v2-sidebar-theme.mjs"
// Exact host-injected pattern (OpenCode/OpenTUI `ensurePluginRuntime` injects the
// `@opentui/solid` virtual module for directory plugins before import; no
// node_modules needed). Same idiom the goal plugin uses:
// `import { createElement, insert, setProp } from "@opentui/solid"`.
import { createElement, insert, setProp } from "@opentui/solid"

/** The OpenTUI Solid runtime the V1 `materialize` consumes. */
const hostSolid = { createElement, insert, setProp }

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

/** Read a session list from a host source exposing `list()`/`all()` or an array. */
function sessionListFrom(source) {
  if (Array.isArray(source)) return source
  if (!isObject(source)) return undefined
  for (const method of ["list", "all"]) {
    const fn = source[method]
    if (typeof fn !== "function") continue
    try {
      const value = fn.call(source)
      if (Array.isArray(value)) return value
      if (isObject(value) && Array.isArray(value.data)) return value.data
    } catch (error) {
      if (!(error instanceof Error)) throw error
    }
  }
  return undefined
}

/**
 * Read the live sessions from whichever real host source exposes them. The V2
 * TUI API keeps them on `state.session` (`TuiState.session`); the legacy data
 * surface used `data.session`/`data.sessions`, and the location-scoped
 * inventory lives on `data.location.session`. Reading all of them keeps the
 * Agents view wired regardless of which surface the host version provides, and
 * never reduces the existing sources.
 */
function readSessions(context) {
  const sources = [
    context?.state?.session,
    context?.data?.session,
    context?.data?.sessions,
    context?.data?.location?.session,
  ]
  for (const source of sources) {
    const value = sessionListFrom(source)
    if (Array.isArray(value)) return value
  }
  return []
}

function sessionId(session) {
  return firstString(session?.id, session?.sessionID, session?.session_id, session?.name)
}

function statusText(candidate) {
  if (typeof candidate === "string") return candidate
  if (isObject(candidate) && typeof candidate.type === "string") return candidate.type
  return undefined
}

/**
 * The status of a session. The legacy surface carries it on the record; the V2
 * API exposes it separately as `state.session.status(id)`, so both are read
 * (record first, live lookup as the fallback).
 */
function sessionStatus(session, context) {
  const direct = statusText(session?.status ?? session?.state ?? session?.type)
  if (direct) return direct
  const id = sessionId(session)
  const stateSession = context?.state?.session
  const statusOf = stateSession?.status
  if (typeof statusOf === "function" && id) {
    try {
      return statusText(statusOf.call(stateSession, id))
    } catch (error) {
      if (!(error instanceof Error)) throw error
    }
  }
  return undefined
}

/**
 * The role a session runs as. The V2 session record carries `agent`; when it is
 * absent the live `state.session.get(id)` record supplies it.
 */
function sessionName(session, id, context) {
  const direct = firstString(session?.agent, session?.agentName, session?.title, id)
  if (direct) return direct
  const stateSession = context?.state?.session
  const get = stateSession?.get
  if (typeof get === "function" && id) {
    try {
      const live = get.call(stateSession, id)
      return firstString(live?.agent, live?.agentName, live?.title, id)
    } catch (error) {
      if (!(error instanceof Error)) throw error
    }
  }
  return id
}

/** V1 `activeAgentsFromStatuses`: keep only busy/retry/running, name-resolved. */
function activeAgentsFromSessions(sessions, context) {
  const rows = []
  for (const session of sessions) {
    if (!isObject(session)) continue
    const status = sessionStatus(session, context)
    if (!ACTIVE_AGENT_STATUSES.has(status)) continue
    const id = sessionId(session)
    rows.push({ name: sessionName(session, id, context) ?? "session", status })
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

/* ------------------------------------------------------------------ *
 * Role roster sources: the Rigel manifests + the live V2 host inventory
 * ------------------------------------------------------------------ */

/**
 * The location ref the V2 host list APIs are scoped by, built from whichever
 * location shape the context exposes (`context.location.current` on the CLI
 * context, `context.location` on the setup/tool context).
 */
function hostLocation(context, fallbackDirectory) {
  const current = isObject(context?.location?.current) ? context.location.current : context?.location
  const directory = firstString(current?.directory, current?.path, fallbackDirectory)
  const workspace = firstString(current?.workspaceID, current?.workspace)
  return { ...(directory ? { directory } : {}), ...(workspace ? { workspace } : {}) }
}

/** A host list endpoint returns a bare array or an envelope `{ data: [...] }`. */
function hostCollection(value) {
  if (Array.isArray(value)) return value
  if (isObject(value) && Array.isArray(value.data)) return value.data
  return []
}

/**
 * The `provider/model` string a host entry describes, tolerating the shapes the
 * V2 host exposes: a free `model` string, a model-ref object (`{ providerID, id }`),
 * or a model-list row (`{ providerID, id }`). An agent row with no model and no
 * provider-qualified id resolves to "" and is skipped, so a bare agent inventory
 * never fabricates a model.
 */
function hostModelRef(entry) {
  if (!isObject(entry)) return ""
  const direct = firstString(entry.model)
  if (direct) return direct
  const nested = isObject(entry.model) ? entry.model : undefined
  const provider = firstString(nested?.providerID, nested?.provider, entry.providerID, entry.provider)
  const id = firstString(nested?.id, nested?.modelID, nested?.model, entry.id, entry.modelID, entry.modelId)
  return id && provider ? `${provider}/${id}` : ""
}

/**
 * The head of a canonical chain as a `provider/model` string. A role the
 * manifest did not bind a model to (the runtime resolves it from the chain at
 * registration) still shows its configured chain-head model, matching V1
 * `getEffectiveModel`. Returns undefined when the chain or its head is unusable.
 */
function chainModel(chain) {
  const head = Array.isArray(chain) ? chain[0] : undefined
  const provider = Array.isArray(head?.providers) ? head.providers[0] : undefined
  return typeof provider === "string" && typeof head?.model === "string" ? `${provider}/${head.model}` : undefined
}

/**
 * Best-effort live role roster from the canonical V2 host API
 * (`context.data.location.agent.list(...)` / `context.agent.list(...)`), the
 * 2.0.26 location-scoped agent inventory. Returns `[]` when the host does not
 * expose the endpoint or exposes agents without models, so the caller falls back
 * to the Rigel manifests. Never throws for a missing or failing host endpoint.
 */
async function readHostRoleRows(context, location) {
  const calls = [
    () => context?.data?.location?.agent?.list?.(location),
    () => context?.agent?.list?.(location),
  ]
  for (const call of calls) {
    try {
      const entries = hostCollection(await call())
      const rows = entries
        .map((entry) => {
          const model = hostModelRef(entry)
          return model ? toRosterRow({ label: firstString(entry?.name, entry?.id, entry?.agent), model }) : null
        })
        .filter((row) => row !== null)
      if (rows.length > 0) return rows
    } catch (error) {
      if (!(error instanceof Error)) throw error
    }
  }
  return []
}

/**
 * The host's live model inventory (`context.data.location.model.list(location)` /
 * `context.model.list(...)`). It is NOT a role list, so it is only a last-resort
 * truthful state: when neither the host roles nor the Rigel manifests yield a
 * roster, show the models the host actually has (provider + model) instead of an
 * empty card. Returns `[]` when the host does not expose the endpoint.
 */
async function readHostModelRows(context, location) {
  const calls = [
    () => context?.data?.location?.model?.list?.(location),
    () => context?.model?.list?.({ location }),
  ]
  for (const call of calls) {
    try {
      const entries = hostCollection(await call())
      const rows = entries
        .map((entry) => {
          const model = hostModelRef(entry)
          if (!model) return null
          const slash = model.indexOf("/")
          const provider = slash > 0 ? model.slice(0, slash) : ""
          const label = firstString(entry?.name, provider, model)
          return toRosterRow({ label, model })
        })
        .filter((row) => row !== null)
      if (rows.length > 0) return rows
    } catch (error) {
      if (!(error instanceof Error)) throw error
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

      // The roster is sourced, in order, from: (1) the live V2 host inventory
      // (`location.agent.list`), (2) the Rigel native manifests (agent manifest
      // plus the built-in category manifest, with user overrides applied), and
      // (3) as a last resort the host model catalog. The manifests are read
      // synchronously, so a clean install renders a real roster even when the
      // host exposes no list endpoint; the host read is asynchronous and
      // refreshes the view when it answers, so the roster stays live without
      // blocking setup. A test injects fixtures via `overrides.agentManifest` /
      // `overrides.categoryManifest`.
      const resolveAgentManifest = () => overrides.agentManifest ?? manifest
      const resolveCategoryManifest = () => overrides.categoryManifest ?? categoryManifest
      // A role the manifest did not model-bind (the runtime resolves it from its
      // canonical chain) still shows the configured chain head, so the roster is
      // complete and V1-faithful.
      const rosterChains = {
        agentModel: (id) => chainModel(agentChain(id)),
        categoryModel: (name) => chainModel(categoryChain(name)),
      }
      const location = hostLocation(context, directory)
      let hostRoleRows = []
      let hostModelRows = []
      let hostLoadInFlight = false

      const rosterRows = () => {
        if (Array.isArray(hostRoleRows) && hostRoleRows.length > 0) return hostRoleRows
        const rows = buildRosterRows(resolveAgentManifest(), resolveCategoryManifest(), rosterChains)
        if (rows.length > 0) return rows
        return Array.isArray(hostModelRows) ? hostModelRows : []
      }

      const sameRows = (left, right) => JSON.stringify(left) === JSON.stringify(right)

      const loadHostRoster = async () => {
        if (hostLoadInFlight) return
        hostLoadInFlight = true
        try {
          const [roles, models] = await Promise.all([
            readHostRoleRows(context, location).catch(() => []),
            readHostModelRows(context, location).catch(() => []),
          ])
          if (!sameRows(roles, hostRoleRows) || !sameRows(models, hostModelRows)) {
            hostRoleRows = roles
            hostModelRows = models
            refresh()
          }
        } catch (error) {
          logger({ event: "host-roster-failed", error: describeError(error) })
        } finally {
          hostLoadInFlight = false
        }
      }

      const compute = () => {
        const snapshot = buildRuntimeSnapshot({
          projectDir: directory,
          updatedAt: now(),
          activeAgents: activeAgentsFromSessions(readSessions(context), context),
          jobBoard: readBackgroundTasks(context),
          loop: readActiveLoop(directory, now()),
        })
        const config = typeof overrides.config === "function" ? overrides.config() : { valid: true, messages: [] }
        const view = computeView({
          config: deriveConfig(config),
          roster: deriveRoster(rosterRows()),
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

      // The slot must receive a REAL element tree (the V1 flow): buildViewNodes
      // -> materialize through the OpenTUI Solid runtime. The runtime is the
      // host-provided `@opentui/solid`; a test may inject a stub via `overrides.solid`.
      // A render failure surfaces (logged and rethrown) — the sidebar is never
      // hidden and no `null` fallback is used.
      const solidForRender = overrides.solid ?? hostSolid

      const render = (props) => {
        try {
          const { view } = compute()
          currentView = view
          // The V2 slot passes `{ sessionID }`; the view is session-independent
          // (derived from the snapshot). The nested host theme is adapted to the
          // flat keys `buildViewNodes` expects before materializing.
          void props
          return materialize(buildViewNodes(view, adaptTheme(context?.theme)), solidForRender)
        } catch (error) {
          logger({ event: "render-failed", error: describeError(error) })
          throw error
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
      // Kick off the live host read after the synchronous receipt, so setup never
      // waits on the host and the receipt always reflects the manifest roster.
      void loadHostRoster()

      const subscribe = (name) => {
        const onChange = () => {
          refresh()
          void loadHostRoster()
        }
        // The V2 TUI API publishes on `context.event` (`TuiEventBus.on`); the
        // legacy data surface used `context.data.on`. Subscribe on whichever the
        // host provides so a status change always refreshes the view.
        const bus = context?.event
        if (isObject(bus) && typeof bus.on === "function") {
          try {
            const off = bus.on(name, onChange)
            if (typeof off === "function") disposers.push(off)
          } catch (error) {
            logger({ event: "subscribe-failed", bus: "event", name, error: describeError(error) })
          }
        }
        if (typeof context?.data?.on !== "function") return
        try {
          const off = context.data.on(name, onChange)
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
