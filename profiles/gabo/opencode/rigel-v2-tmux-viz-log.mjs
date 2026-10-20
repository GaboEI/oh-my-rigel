/**
 * Durable diagnostics for the tmux visualization.
 *
 * The plugin's `console.error` output does NOT reach the host log: in the V2
 * service the plugin's console is a socket, so every visualization decision -
 * "degraded for <dir>: ambiguous caller pane", "spawned pane %9", "deferred
 * spawn for <session>" - was written somewhere no operator can read. A live run
 * that created two real sessions and zero panes therefore produced a log with
 * no trace of the feature at all, and "nothing ran" could not be distinguished
 * from "ran and refused" (retest 5).
 *
 * This sink follows the convention the sibling CLI features already use
 * (`task-toast.log`, `session-notification.log`): one JSON object per line under
 * `<XDG_STATE_HOME or ~/.local/state>/oh-my-rigel/`, resolved from the SAME
 * environment the plugin itself was given.
 *
 * Contract:
 * - never throws: a logging failure must not affect a spawn or a close;
 * - disables itself after the first write error instead of retrying per event;
 * - `RIGEL_TMUX_VIZ_LOG=off` disables it entirely;
 * - `RIGEL_TMUX_VIZ_LOG_FILE` (or the `logFile` option) overrides the path.
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/** Absolute path of the visualization log for one environment. */
export function resolveTmuxVizLogPath(options = {}) {
  const env = options.env ?? process.env
  const explicit = typeof options.logFile === "string" && options.logFile.length > 0
    ? options.logFile
    : env?.RIGEL_TMUX_VIZ_LOG_FILE
  if (typeof explicit === "string" && explicit.length > 0) return explicit
  const base = typeof env?.XDG_STATE_HOME === "string" && env.XDG_STATE_HOME.length > 0
    ? env.XDG_STATE_HOME
    : join(homedir(), ".local", "state")
  return join(base, "oh-my-rigel", "tmux-viz.log")
}

/**
 * Build the logger the manager, the project registry and the status seam share.
 *
 * @param {{ env?: Record<string, string|undefined>, logFile?: string }} [options]
 * @returns {(message: string, detail?: unknown) => void}
 */
export function createTmuxVizLogSink(options = {}) {
  const env = options.env ?? process.env
  if (env?.RIGEL_TMUX_VIZ_LOG === "off") return () => {}
  const logPath = resolveTmuxVizLogPath({ ...options, env })
  let active = true
  return (message, detail) => {
    if (!active) return
    try {
      mkdirSync(dirname(logPath), { recursive: true })
      const entry = { at: new Date().toISOString(), scope: "tmux-viz", message: String(message) }
      if (detail !== undefined) entry.detail = detail
      appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf-8")
    } catch {
      // Unwritable log: stay silent from now on rather than throwing inside a
      // spawn/close decision that has nothing to do with logging.
      active = false
    }
  }
}
