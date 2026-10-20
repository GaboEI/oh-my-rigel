/**
 * Conditional native V2 tool families: `interactive_bash`, the `task_*` system,
 * and the goal tools.
 *
 * Gates are read from the materialized agent manifest (`metadata.global.gates`)
 * that the pending config adapter materializes. This module consumes that plain
 * object and never parses `omo.jsonc`, so the config adapter is the single owner
 * of config parsing. A gate that is absent or false means the family is NOT
 * registered: a disabled tool can never be silently exposed.
 *
 * V2 primitives used:
 * - `ctx.pty`     -> interactive_bash command runner (never shell.exec)
 * - `ctx.storage` -> task and goal persistence (never a fake in-memory store)
 * - `ctx.tool.transform` -> real tool registration
 * - `ctx.event.subscribe` + `ctx.session.prompt` -> goal idle continuation
 */

import {
  createInteractiveBashTool,
  createPtyCommandRunner,
  detectTmuxAvailability,
  INTERACTIVE_BASH_TOOL_NAME,
} from "./tools/interactive-bash.tools.mjs"
import {
  createTaskLock,
  createTaskTools,
  createV2TaskStore,
  resolveTaskListId,
  TASK_TOOL_NAMES,
} from "./tools/task.tools.mjs"
import {
  createGoalContinuation,
  createGoalController,
  createGoalTools,
  createV2GoalStore,
  GOAL_TOOL_NAMES,
} from "./tools/goal.tools.mjs"
import { readNativeGates } from "./rigel-v2-native-config.mjs"
import { normalizeToolDefinition } from "./rigel-v2-native-core.mjs"
import { trimToolNamesToCap } from "./rigel-v2-native-tool-trimming.mjs"
import { createTeamTools, TEAM_TOOL_NAMES } from "./tools/team.tools.mjs"
import { mapTeamWorktreeToRepoRoot } from "./rigel-v2-team-worktrees.mjs"

// F1 landed: the config adapter (`rigel-v2-native-config.mjs`) owns JSONC parsing
// and `generate-v2-agents.mjs` materializes the resolved gates into
// `manifest.metadata.global.gates`. This module reads them with the single
// shared reader; there is no local duplicate.

function emptyResult() {
  return { definitions: {}, names: [] }
}

/**
 * Build the enabled tool definitions for the resolved gates.
 *
 * `interactive_bash` is additionally gated on a real tmux executable; an enabled
 * gate with no tmux is therefore unavailable, not broken. Each family is only
 * built when its `ctx` domain is present; a missing domain is reported loudly
 * and the family is skipped rather than registered with a fake backend.
 */
export function buildConditionalToolDefinitions({
  gates = {},
  tmuxPath,
  ptyRunner,
  terminalFactory,
  taskStore,
  taskLock,
  goalStore,
  goalController,
  teamStorage,
  teamScopeRegistry,
  teamResolveScope,
  teamWorktrees,
  teamWorktreeReconciler,
  teamProjectKey,
  teamStartMemberSession,
  teamTerminateMemberSession,
  syncTodos,
  getSessionID,
  onUnavailable = () => {},
} = {}) {
  const definitions = {}
  const names = []

  if (gates.interactive_bash === true) {
    // A persistent-terminal factory is the no-tmux backend; a resolved tmux path
    // plus a PTY runner is the V1 backend. Only when NEITHER exists is the
    // family unavailable.
    if (typeof terminalFactory === "function") {
      definitions[INTERACTIVE_BASH_TOOL_NAME] = createInteractiveBashTool({ terminalFactory, getSessionID })
      names.push(INTERACTIVE_BASH_TOOL_NAME)
    } else if (typeof tmuxPath !== "string" || !tmuxPath) {
      onUnavailable("interactive_bash", "tmux is not available on PATH")
    } else if (!ptyRunner) {
      onUnavailable("interactive_bash", "V2 pty runner is unavailable")
    } else {
      definitions[INTERACTIVE_BASH_TOOL_NAME] = createInteractiveBashTool({ runner: ptyRunner, tmuxPath })
      names.push(INTERACTIVE_BASH_TOOL_NAME)
    }
  }

  if (gates.task_system === true) {
    if (taskStore) {
      const tools = createTaskTools({ store: taskStore, lock: taskLock, syncTodos, getSessionID })
      for (const name of TASK_TOOL_NAMES) {
        definitions[name] = tools[name]
        names.push(name)
      }
    } else {
      onUnavailable("task_system", "V2 storage domain is unavailable")
    }
  }

  if (gates.goal === true) {
    if (goalStore) {
      const controller = goalController ?? createGoalController({ store: goalStore })
      const tools = createGoalTools({ controller, getSessionID })
      for (const name of GOAL_TOOL_NAMES) {
        definitions[name] = tools[name]
        names.push(name)
      }
    } else {
      onUnavailable("goal", "V2 storage domain is unavailable")
    }
  }

  if (gates.team_mode === true) {
    if (teamStorage) {
      const tools = createTeamTools({ storage: teamStorage, getSessionID, resolveScopeForSession: teamResolveScope, worktreeManager: teamWorktrees, worktreeReconciler: teamWorktreeReconciler, projectKey: teamProjectKey, startMemberSession: teamStartMemberSession, terminateMemberSession: teamTerminateMemberSession })
      for (const name of TEAM_TOOL_NAMES) {
        definitions[name] = tools[name]
        names.push(name)
      }
    } else {
      onUnavailable("team_mode", "V2 storage domain is unavailable")
    }
  }

  return { definitions, names }
}

function locationOf(context) {
  return context?.location ?? (context?.directory ? { directory: context.directory } : undefined)
}

/**
 * Register every enabled conditional family on the live V2 host and return a
 * disposer. Registration is additive: one `tool.transform` for the enabled
 * definitions plus one event subscription for the goal continuation.
 *
 * `gates` is the exact injection point for the config adapter. When omitted it
 * is read from the manifest; when supplied (for example by an owner test) it
 * overrides the manifest as the resolved gate set.
 */
export async function registerConditionalNativeTools({
  context,
  manifest,
  gates,
  directory,
  tmuxPath,
  ptyRunner,
  terminalFactory,
  taskStore,
  taskLock,
  goalStore,
  syncTodos,
  getSessionID,
  maxTools,
  teamWorktrees,
  teamWorktreeReconciler,
  teamProjectKey,
  teamStartMemberSession,
  teamTerminateMemberSession,
  teamScopeRegistry,
  existingToolNames = [],
  onRegistered,
  log = console.error,
} = {}) {
  const manifestGates = readNativeGates(manifest)
  const resolved = { ...manifestGates, ...(gates ?? {}) }
  // interactive_bash availability comes from the host, not a config key. A
  // persistent-terminal factory is a complete backend on its own (no tmux
  // required); only when it is absent does PATH detection decide. The probe
  // runs only when the family is actually requested.
  const hasTerminalFactory = typeof terminalFactory === "function"
  const resolvedTmuxPath = tmuxPath ?? (resolved.interactive_bash === true && !hasTerminalFactory ? detectTmuxAvailability() : undefined)
  if (resolved.interactive_bash === true && !hasTerminalFactory && !resolvedTmuxPath) {
    log("[oh-my-rigel] Native V2 interactive_bash requested but tmux is not available on PATH; family stays unregistered")
  }

  const unavailable = []
  const onUnavailable = (family, reason) => {
    unavailable.push({ family, reason })
    log(`[oh-my-rigel] Native V2 ${family} gate is enabled but ${reason}; family stays unregistered`)
  }

  const pty = context?.pty
  const location = locationOf(context)
  const serverUrl = context?.serverUrl
  const baseUrl = typeof serverUrl === "string" ? serverUrl : serverUrl?.toString?.()
  const runner = ptyRunner ?? (pty && typeof pty.create === "function"
    ? createPtyCommandRunner({ pty, location, baseUrl })
    : undefined)
  const storage = context?.storage
  // Resolve the calling session's project from its own location, so a plugin
  // instance serving several repos isolates each one.
  const teamResolveScope = teamScopeRegistry && typeof context?.session?.get === "function"
    ? async (sessionID) => {
        if (typeof sessionID !== "string" || !sessionID) throw new Error("team tool requires a calling session id")
        const info = await context.session.get({ sessionID })
        const rawDirectory = info?.data?.location?.directory ?? info?.location?.directory ?? info?.directory
        if (!rawDirectory) throw new Error("team session location is unavailable")
        // A member session rooted in its own team worktree must still resolve the
        // TEAM's repo root: otherwise it reads a different project key, loses its
        // team record, and cannot see its own tasks or messages.
        const directory = mapTeamWorktreeToRepoRoot(rawDirectory) ?? rawDirectory
        return teamScopeRegistry.forRepoRoot(directory)
      }
    : undefined
  // The task list id must follow the active project directory, not the service
  // process cwd. `directory` is the V2 setup location passed by the runtime.
  const listId = resolveTaskListId({ cwd: directory })
  const store = taskStore ?? (storage && typeof storage.get === "function"
    ? createV2TaskStore({ storage, listId })
    : undefined)
  const resolvedGoalStore = goalStore ?? (storage && typeof storage.get === "function"
    ? createV2GoalStore({ storage })
    : undefined)

  // V2 renders the storage-backed goal state, so the shared controller replaces
  // V1's file-based TUI mirror without adding another persistence path.
  const goalController = resolved.goal === true && resolvedGoalStore
    ? createGoalController({ store: resolvedGoalStore })
    : undefined
  const { definitions, names } = buildConditionalToolDefinitions({
    gates: resolved,
    tmuxPath: resolvedTmuxPath,
    ptyRunner: runner,
    terminalFactory,
    taskStore: store,
    taskLock: taskLock ?? createTaskLock(),
    goalStore: resolvedGoalStore,
    teamStorage: storage,
    teamScopeRegistry,
    teamResolveScope,
    teamWorktrees,
    teamWorktreeReconciler,
    teamProjectKey,
    teamStartMemberSession,
    teamTerminateMemberSession,
    goalController,
    syncTodos,
    getSessionID,
    onUnavailable,
  })

  // experimental.max_tools trimming (V1 tool-registry-trimming parity): the
  // cap applies to the plugin's TOTAL surface, so the names the core runtime
  // already registered count too. Lowest-priority names drop first; the goal
  // continuation below still runs against the shared controller even when its
  // create_goal tool was trimmed away, matching "state survives, surface trims".
  const trimmed = trimToolNamesToCap(names, maxTools, { existingNames: existingToolNames })
  if (trimmed.removed.length > 0) {
    log(`[oh-my-rigel] Native V2 max_tools=${maxTools}: trimmed ${trimmed.removed.length} tools (${trimmed.removed.join(", ")})`)
  }
  const registeredNames = trimmed.kept

  // Observability seam for live QA: report the resolved gates and the families
  // that actually registered, so a run can prove gates on/off without a model.
  onRegistered?.({ gates: resolved, registered: registeredNames, trimmed: trimmed.removed, unavailable, tmux: resolvedTmuxPath ?? null })

  let registration
  if (registeredNames.length > 0 && typeof context?.tool?.transform === "function") {
    registration = await context.tool.transform((editor) => {
      for (const name of registeredNames) editor.add(normalizeToolDefinition(definitions[name]))
    })
  }

  let eventSubscription
  const disposers = []
  if (resolved.goal === true && definitions.create_goal && resolvedGoalStore) {
    const dispatch = async ({ sessionID, text }) => {
      if (typeof context?.session?.prompt !== "function") return
      await context.session.prompt({ sessionID, text, delivery: "queue" })
    }
    const continuation = createGoalContinuation({ controller: goalController, dispatch })
    const abort = new AbortController()
    if (typeof context?.event?.subscribe === "function") {
      eventSubscription = (async () => {
        try {
          for await (const event of context.event.subscribe({ signal: abort.signal })) {
            await continuation.handleEvent(event)
          }
        } catch (error) {
          if (!abort.signal.aborted) {
            log(`[oh-my-rigel] Native V2 goal continuation subscription failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      })()
      disposers.push(() => abort.abort())
    }
  }

  log(`[oh-my-rigel] Native V2 conditional tools: gates=${JSON.stringify(resolved)}; registered=${registeredNames.join(",") || "none"}; tmux=${resolvedTmuxPath ?? "none"}${unavailable.length ? `; unavailable=${unavailable.map((entry) => entry.family).join(",")}` : ""}`)

  return {
    gates: resolved,
    registered: registeredNames,
    definitions,
    goalController,
    unavailable,
    async dispose() {
      for (const dispose of disposers) {
        try { dispose() } catch { /* already disposed */ }
      }
      await registration?.dispose?.()
      await eventSubscription
    },
  }
}
