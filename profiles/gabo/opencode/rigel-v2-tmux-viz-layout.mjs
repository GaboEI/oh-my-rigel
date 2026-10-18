/**
 * Native V2 tmux visualization: grid planning, split decisions and command
 * builders (rewrite of V1 `features/tmux-subagent/grid-planning.ts`,
 * `spawn-action-decider.ts`, `spawn-target-finder.ts` and the layout/window
 * command builders of `tmux-core`).
 *
 * Constants and clamps reproduce V1 exactly: main pane ratio 0.5, grid capped
 * at 2 columns x 3 rows (max 4 agent panes), minimum agent pane 52x11, and a
 * split only when the window fits two minimum panes.
 */

export const MAIN_PANE_RATIO = 0.5
export const MAX_COLS = 2
export const MAX_ROWS = 3
export const MAX_GRID_SIZE = 4
export const DIVIDER_SIZE = 1
export const MIN_PANE_WIDTH = 52
export const MIN_PANE_HEIGHT = 11
export const MIN_SPLIT_WIDTH = 2 * MIN_PANE_WIDTH + DIVIDER_SIZE
export const MIN_SPLIT_HEIGHT = 2 * MIN_PANE_HEIGHT + DIVIDER_SIZE

const STRICT_MAIN_LAYOUTS = new Set(["main-vertical", "main-horizontal"])

export function clampMainPaneSize(size) {
  if (typeof size !== "number" || Number.isNaN(size)) return 50
  return Math.min(80, Math.max(20, size))
}

export function computeMainPaneWidth({ windowWidth, mainPaneSize = 60, mainPaneMinWidth = 120, agentPaneMinWidth = 40 }) {
  const percent = Math.max(clampMainPaneSize(mainPaneSize), mainPaneMinWidth)
  const capped = windowWidth - DIVIDER_SIZE - Math.max(1, agentPaneMinWidth)
  return Math.max(1, Math.min(Math.floor((windowWidth * percent) / 100), capped))
}

export function computeAgentAreaWidth(windowWidth, mainPaneWidth) {
  return Math.max(0, windowWidth - DIVIDER_SIZE - mainPaneWidth)
}

export function computeCapacity({ agentAreaWidth, windowHeight, minPaneWidth = 40, agentPaneMinWidth = 40 }) {
  void agentPaneMinWidth
  const cols = Math.min(MAX_GRID_SIZE, Math.floor((agentAreaWidth + DIVIDER_SIZE) / (minPaneWidth + DIVIDER_SIZE)))
  const rows = Math.min(MAX_GRID_SIZE, Math.floor((windowHeight + DIVIDER_SIZE) / (MIN_PANE_HEIGHT + DIVIDER_SIZE)))
  return { cols: Math.max(0, cols), rows: Math.max(0, rows) }
}

export function computeGridPlan(paneCount, capacity) {
  const usableCols = Math.min(capacity.cols, MAX_COLS)
  const usableRows = Math.min(capacity.rows, MAX_ROWS)
  if (usableCols <= 0 || usableRows <= 0) return null
  let best = null
  for (let cols = 1; cols <= usableCols; cols += 1) {
    for (let rows = 1; rows <= usableRows; rows += 1) {
      const slots = cols * rows
      if (slots < paneCount) continue
      if (!best || slots < best.slots || (slots === best.slots && rows < best.rows)) {
        best = { cols, rows, slots }
      }
    }
  }
  return best
}

function splitDirectionsFor(layout) {
  return layout === "main-horizontal" ? { first: "-v", follow: "-h" } : { first: "-h", follow: "-v" }
}

/**
 * Decide the actions that make room for one more agent pane. Returns
 * `{ canSpawn, reason, actions }`; `reason` is the exact V1 decision text so
 * degraded decisions stay observable.
 */
export function decideSpawnActions({ windowState, layout = "main-vertical", mainPaneSize = 60, mainPaneMinWidth = 120, agentPaneMinWidth = 40, sourcePaneId }) {
  const { windowWidth, windowHeight, mainPane, agentPanes } = windowState
  if (!mainPane) return { canSpawn: false, reason: "no main pane found", actions: [] }
  const mainPaneWidth = computeMainPaneWidth({ windowWidth, mainPaneSize, mainPaneMinWidth, agentPaneMinWidth })
  const agentAreaWidth = computeAgentAreaWidth(windowWidth, mainPaneWidth)
  if (windowWidth < MIN_SPLIT_WIDTH || windowHeight < MIN_SPLIT_HEIGHT) {
    return { canSpawn: false, reason: `window too small for agent panes: ${windowWidth}x${windowHeight}`, actions: [] }
  }
  if (mainPane.width < MIN_PANE_WIDTH || mainPane.height < MIN_PANE_HEIGHT) {
    return { canSpawn: false, reason: "mainPane too small to split", actions: [] }
  }
  const directions = splitDirectionsFor(layout)
  if (agentPanes.length === 0) {
    return { canSpawn: true, reason: null, actions: [{ kind: "spawn", direction: directions.first, targetPaneId: mainPane.paneId }] }
  }
  if (STRICT_MAIN_LAYOUTS.has(layout)) {
    const sorted = [...agentPanes].sort((a, b) => (a.left - b.left) || (a.top - b.top))
    return { canSpawn: true, reason: null, actions: [{ kind: "spawn", direction: directions.follow, targetPaneId: sorted[sorted.length - 1].paneId }] }
  }
  const capacity = computeCapacity({ agentAreaWidth, windowHeight, minPaneWidth: agentPaneMinWidth })
  const plan = computeGridPlan(agentPanes.length + 1, capacity)
  if (!plan || plan.slots < agentPanes.length + 1) {
    // Grid is full: evict the oldest agent pane when exactly one slot frees the grid.
    if (agentPanes.length === MAX_GRID_SIZE) {
      const oldest = [...agentPanes].sort((a, b) => a.left - b.left || a.top - b.top)[0]
      return {
        canSpawn: true,
        reason: "closed 1 pane to make room for split",
        actions: [{ kind: "close", paneId: oldest.paneId }, { kind: "spawn", direction: "-h", targetPaneId: mainPane.paneId }],
      }
    }
    return { canSpawn: false, reason: "no split target available (defer attach)", actions: [] }
  }
  const target = [...agentPanes].sort((a, b) => (a.top - b.top) || (a.left - b.left))[agentPanes.length - 1]
  return { canSpawn: true, reason: null, actions: [{ kind: "spawn", direction: "-v", targetPaneId: target.paneId }] }
}

// ---------------------------------------------------------------------------
// Command builders (exact V1 argv shapes)
// ---------------------------------------------------------------------------

// Pane user option marking a pane this feature owns. Shared with caller-pane
// discovery, which must never mistake a member pane for the caller.
export const OMO_SUBAGENT_PANE_OPTION = "@omo_subagent"

function quoteShellToken(value) {
  return `'${String(value ?? "").replace(/'/g, "'\\''")}'`
}

export function buildPlaceholderCommand(description) {
  const text = `OMO subagent pane ready: ${String(description ?? "").slice(0, 20)}`
  const script = `printf '%s\\n%s\\n' ${quoteShellToken(text)} ${quoteShellToken("Focus this pane to attach.")}; while :; do sleep 86400; done`
  return `/bin/sh -c ${quoteShellToken(script)}`
}

/**
 * Turn a placeholder pane into the tracked session's TUI.
 *
 * OpenCode V2 exposes no `attach` subcommand and no `--dir` flag; the interface
 * it does expose is `--server <url>`, `--session <id>` plus a positional
 * directory. Passing the obsolete form left every member pane as a dead
 * placeholder, so this must use the real flags.
 *
 * The credential is deliberately absent: it travels in the pane environment
 * (see `buildAttachAuthEnv`), so it can never leak through a command line, a
 * process listing, or a logged error. `serverUrl` is optional; when it is
 * unknown the session is still targeted and the CLI resolves the running
 * server itself.
 */
export function buildAttachCommand({ serverUrl, sessionID, directory, opencodePath = "opencode" }) {
  const argv = [opencodePath]
  if (typeof serverUrl === "string" && serverUrl) argv.push("--server", serverUrl)
  if (typeof sessionID === "string" && sessionID) argv.push("--session", sessionID)
  if (typeof directory === "string" && directory) argv.push(directory)
  return argv.map(quoteShellToken).join(" ")
}

/**
 * `respawn-pane`/`split-window` `-e` arguments that put the server credential
 * into the pane environment instead of the pane's command line.
 */
export function buildAttachAuthEnv({ password, username } = {}) {
  const args = []
  if (typeof username === "string" && username) args.push("-e", `OPENCODE_SERVER_USERNAME=${username}`)
  if (typeof password === "string" && password) args.push("-e", `OPENCODE_PASSWORD=${password}`)
  return args
}

export function buildTitleArgs(paneId, description) {
  return ["select-pane", "-t", paneId, "-T", `omo-subagent-${String(description ?? "").slice(0, 20)}`]
}

/**
 * Durable ownership marker for a pane this feature created.
 *
 * The pane title is not reliable: a TUI running inside the pane overwrites it
 * with its own terminal title, which would make leftover member panes look like
 * fresh callers to `discoverCallerPane` and turn every later discovery
 * ambiguous. A tmux user option on the pane survives that, so caller discovery
 * can always tell our own panes apart.
 */
export function buildPaneMarkerArgs(paneId) {
  return ["set-option", "-p", "-t", paneId, OMO_SUBAGENT_PANE_OPTION, "1"]
}

export function buildSpawnArgs({ direction, targetPaneId, placeholderCommand, authEnv = [] }) {
  const args = ["split-window", direction, "-d", "-P", "-F", "#{pane_id}"]
  if (targetPaneId) args.push("-t", targetPaneId)
  args.push(...authEnv, placeholderCommand)
  return args
}

export function buildReplaceArgs({ paneId, placeholderCommand, authEnv = [] }) {
  return ["respawn-pane", "-k", ...authEnv, "-t", paneId, placeholderCommand]
}

export function buildApplyLayoutArgs(layout, mainPaneSize) {
  const args = ["select-layout", layout]
  if (typeof layout === "string" && layout.startsWith("main-")) {
    const dimension = layout === "main-horizontal" ? "main-pane-height" : "main-pane-width"
    args.push(";", "set-window-option", dimension, `${clampMainPaneSize(mainPaneSize)}%`)
  }
  return args
}

export function buildResizeArgs(mainPaneId, width) {
  return ["resize-pane", "-t", mainPaneId, "-x", String(width)]
}

export function buildCloseArgs(paneId) {
  return [["send-keys", "-t", paneId, "C-c"], ["kill-pane", "-t", paneId]]
}
