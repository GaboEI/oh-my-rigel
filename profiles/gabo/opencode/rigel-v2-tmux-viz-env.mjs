/**
 * Native V2 tmux visualization: environment eligibility (rewrite of V1
 * `features/tmux-subagent/environment-eligibility.ts` + `tmux-core/environment`).
 *
 * Observable contract:
 * - `tmuxPath`: the tmux executable resolved on PATH (null when absent).
 * - `insideTmux`: a real tmux server is reachable: either inherited (`TMUX`
 *   set) or discovered (see `discoverCallerPane`).
 * - `sourcePaneId`: the pane to split from: the inherited `TMUX_PANE` when
 *   present, otherwise the single discovered caller pane.
 * - `cmux`: a cmux tmux-compat environment (`CMUX_SOCKET_PATH` set).
 * - `degradedReason`: when the visualization cannot run, the exact reason.
 *   Degraded is an explicit, logged state, never a silent failure.
 */

import fs from "node:fs"

import { OMO_SUBAGENT_PANE_OPTION } from "./rigel-v2-tmux-viz-layout.mjs"

function defaultIsFile(candidate) {
  try { return fs.existsSync(candidate) && fs.statSync(candidate).isFile() } catch { return false }
}

function defaultIsExecutable(candidate, platform) {
  if (platform === "win32") return true
  try { fs.accessSync(candidate, fs.constants.X_OK); return true } catch { return false }
}

export function findExecutableOnPath({ command, env = {}, platform = process.platform, isFile, isExecutable } = {}) {
  if (typeof command !== "string" || !command) return null
  const fileProbe = isFile ?? defaultIsFile
  const execProbe = isExecutable ?? ((candidate) => defaultIsExecutable(candidate, platform))
  const pathValue = env.PATH ?? env.Path ?? ""
  if (typeof pathValue !== "string" || !pathValue) return null
  const separator = platform === "win32" ? ";" : ":"
  const candidates = [command]
  if (platform === "win32" && !/\.[a-zA-Z0-9]+$/.test(command)) {
    const pathext = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((value) => value.trim()).filter(Boolean)
    for (const ext of pathext) candidates.push(`${command}${ext.toLowerCase()}`, `${command}${ext.toUpperCase()}`)
  }
  for (const directory of pathValue.split(separator)) {
    const dir = directory.trim().replace(/^"(.*)"$/, "$1")
    if (!dir) continue
    for (const candidate of candidates) {
      const full = platform === "win32" ? `${dir}\\${candidate}` : `${dir}/${candidate}`
      if (fileProbe(full) && execProbe(full)) return full
    }
  }
  return null
}

export function detectTmuxVizEnvironment({ env = process.env, platform = process.platform, isFile, isExecutable, discoveredPaneId = null, discoveryReason = null } = {}) {
  const tmuxPath = findExecutableOnPath({ command: "tmux", env, platform, isFile: isFile ?? defaultIsFile, isExecutable: isExecutable ?? ((candidate) => defaultIsExecutable(candidate, platform)) })
  const inheritedPaneId = typeof env.TMUX_PANE === "string" && env.TMUX_PANE ? env.TMUX_PANE : null
  const discovered = typeof discoveredPaneId === "string" && discoveredPaneId ? discoveredPaneId : null
  const discoveryReasonText = typeof discoveryReason === "string" && discoveryReason ? discoveryReason : null
  // Discovery is AUTHORITATIVE once it was attempted (a resolved pane OR a
  // recorded reason). The daemon inherits `TMUX_PANE` from whichever TUI happened
  // to spawn it, so the inherited pane can belong to ANOTHER project; preferring
  // it silently opened one project's member pane inside a sibling project's tmux
  // session. Only with no discovery attempt at all (no tmux binary, plugin running
  // inside the caller TUI) does the inherited pane remain the signal.
  const discoveryAttempted = Boolean(discovered) || Boolean(discoveryReasonText)
  const insideTmux = Boolean(env.TMUX) || Boolean(discovered)
  const sourcePaneId = discoveryAttempted ? discovered : (inheritedPaneId ?? discovered)
  const cmux = typeof env.CMUX_SOCKET_PATH === "string" && Boolean(env.CMUX_SOCKET_PATH)
  const paneCompatible = insideTmux || cmux
  let degradedReason = null
  if (!tmuxPath) degradedReason = "tmux binary not found on PATH"
  else if (!paneCompatible) degradedReason = discoveryReasonText ?? "not inside a tmux or cmux environment"
  else if (!sourcePaneId) degradedReason = discoveryAttempted && discoveryReasonText ? discoveryReasonText : "TMUX_PANE is not set: no source pane to split from"
  return { tmuxPath, insideTmux, paneCompatible, cmux, sourcePaneId, degradedReason }
}


// ---------------------------------------------------------------------------
// Caller pane discovery (official V2 topology)
// ---------------------------------------------------------------------------

/**
 * Fields the discovery query asks tmux for. Tab separated so a pane title
 * containing spaces can never shift a column. The last field is the durable
 * ownership marker a member pane carries, which is what keeps a leftover member
 * pane from being mistaken for the caller after its TUI overwrites the title.
 */
export const CALLER_PANE_FORMAT = `#{pane_id}\t#{pane_dead}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_title}\t#{${OMO_SUBAGENT_PANE_OPTION}}`

/** Member panes carry this title prefix (see `buildTitleArgs`). */
const MEMBER_PANE_TITLE_PREFIX = "omo-subagent-"

function normalizePathValue(value, realpath) {
  if (typeof value !== "string" || !value) return null
  if (typeof realpath !== "function") return value
  try {
    const resolved = realpath(value)
    return typeof resolved === "string" && resolved ? resolved : value
  } catch {
    return value
  }
}

function parsePaneRecord(line) {
  const columns = String(line ?? "").split("\t")
  if (columns.length < 6) return null
  const [paneId, dead, command, path, title, marker] = columns
  if (!paneId) return null
  return { paneId, dead: dead === "1", command, path, title, marker: marker === "1" }
}

/**
 * The exact process names an OpenCode TUI runs as. A prefix match is not safe:
 * `opencode-mcp`, `opencode-debug`, `opencodex` and any other sibling tool would
 * be mistaken for the caller TUI and could be split from instead of it.
 */
const OPENCODE_TUI_COMMANDS = new Set(["opencode", "opencode.exe"])

function isOpencodeTuiCommand(command) {
  const token = String(command ?? "").trim().split(/[\s/\\]+/).filter(Boolean).pop()
  if (!token) return false
  return OPENCODE_TUI_COMMANDS.has(token.toLowerCase())
}

function isMemberPaneTitle(title) {
  return String(title ?? "").trim().startsWith(MEMBER_PANE_TITLE_PREFIX)
}

/**
 * Discover the CALLER's pane when the plugin cannot inherit `TMUX_PANE`.
 *
 * The official topology runs this plugin inside the `opencode serve --service`
 * daemon, which has no `TMUX` and no `TMUX_PANE`, so environment-only detection
 * could never find a pane to split from. The daemon can still talk to the same
 * tmux server as a plain control client (same uid, default socket): that is one
 * short-lived query, not a bridge, and it needs no PTY.
 *
 * Fail-closed contract: exactly ONE pane may match the caller's project and be
 * running the OpenCode TUI. On zero candidates, on more than one candidate, or
 * on a failed query, the caller pane stays unresolved and the visualization
 * degrades with a recorded reason. This function never picks arbitrarily and
 * never guesses between two plausible callers.
 *
 * The ONE exception is not a guess: `preferredPaneId` is the pane this instance
 * INHERITED (`TMUX_PANE` of the process that started the service). When such a
 * pane is already one of the validated candidates - same project directory,
 * running the OpenCode TUI, not dead, not a member pane - it IS the caller, and
 * choosing it is what a second, stale TUI pane in the same project used to make
 * impossible (retest 5: `%19` left over from an earlier session made `%26`
 * unusable and the feature went dark with no log line anywhere).
 */
export async function discoverCallerPane({ tmuxPath, directory, run, realpath, excludePaneIds = [], preferredPaneId } = {}) {
  const normalizedDirectory = normalizePathValue(directory, realpath)
  if (!normalizedDirectory) {
    return { paneId: null, candidateCount: 0, reason: "caller project directory is unknown: cannot identify the caller pane" }
  }
  if (typeof run !== "function") {
    return { paneId: null, candidateCount: 0, reason: "tmux runner unavailable: cannot query tmux panes" }
  }

  let result
  try {
    result = await run(["list-panes", "-a", "-F", CALLER_PANE_FORMAT])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { paneId: null, candidateCount: 0, reason: `tmux pane query failed: ${message}` }
  }
  if (!result || result.exitCode !== 0) {
    const detail = String(result?.stderr ?? "").trim() || `exit ${result?.exitCode}`
    return { paneId: null, candidateCount: 0, reason: `tmux pane query failed: ${detail}` }
  }

  const excluded = new Set(Array.isArray(excludePaneIds) ? excludePaneIds : [])
  const candidates = []
  for (const line of String(result.stdout ?? "").split("\n")) {
    const record = parsePaneRecord(line)
    if (!record) continue
    if (record.dead) continue
    if (excluded.has(record.paneId)) continue
    if (record.marker) continue
    if (isMemberPaneTitle(record.title)) continue
    if (!isOpencodeTuiCommand(record.command)) continue
    if (normalizePathValue(record.path, realpath) !== normalizedDirectory) continue
    candidates.push(record.paneId)
  }

  if (candidates.length === 1) {
    return { paneId: candidates[0], candidateCount: 1, reason: null }
  }
  // More than one candidate: only the inherited pane may break the tie, and only
  // because it already passed every filter above (TUI, alive, this project, not a
  // member pane). A pane belonging to a DIFFERENT project can never appear in
  // `candidates`, so adopting the inherited pane cannot leak a member into a
  // sibling project's tmux session.
  if (
    candidates.length > 1
    && typeof preferredPaneId === "string"
    && preferredPaneId.length > 0
    && candidates.includes(preferredPaneId)
  ) {
    return { paneId: preferredPaneId, candidateCount: candidates.length, reason: null }
  }
  if (candidates.length === 0) {
    return { paneId: null, candidateCount: 0, reason: `no caller pane: no OpenCode TUI pane is running in ${normalizedDirectory}` }
  }
  return {
    paneId: null,
    candidateCount: candidates.length,
    reason: `ambiguous caller pane: ${candidates.length} OpenCode TUI panes run in ${normalizedDirectory} (${candidates.join(", ")})`,
  }
}
