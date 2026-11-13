// `interactive_bash` backend for the Rigel V2 runtime: the host-owned persistent
// PTY served over the verified loopback server API (no tmux, no second terminal).
//
// Scope of the hygiene, stated plainly. The PTY daemon inherits the SERVER's
// environment and a create request cannot subtract from it (`env: {}` means
// "inherit"), so the shell the model drives is started behind a POSIX `env -i`
// wrapper (`env -i -- NAME=value... program`, the portable utility form on GNU,
// BSD and macOS `env`) that carries only an allowlist. That sanitizes the PTY
// SHELL process only. It does not hide the daemon parent's `/proc` environment
// or the user-owned service file from a same-UID shell: a same-UID shell is not
// a security boundary, exactly as for the Bash tool.
//
// The tool is offered only in the managed service topology: a verified server
// API whose credential comes from the host's service handoff, with no server
// password selector in the process environment. Every other host path is
// unavailable, never a fallback to another terminal.
//
// This module never logs and never returns a credential, header or ticket.

import fs from "node:fs"
import path from "node:path"
import { createPersistentTerminalPort } from "./tools/terminal-driver.mjs"

const CREDENTIAL_SELECTORS = ["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"]
const ENV_WRAPPER_CANDIDATES = ["/usr/bin/env", "/bin/env"]
const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin"
const DEFAULT_LANG = "C.UTF-8"
const TERMINAL_TYPE = "xterm-256color"

function failure(code, message) {
  return { ok: false, error: { code, message } }
}

function isPresent(value) {
  return typeof value === "string" && value.length > 0
}

function defaultIsExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK)
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

// The only variables the PTY child sees: standard shell basics, never a
// credential family (OPENCODE/OMO/SENPI/PI/provider keys are simply not named).
function allowlistedAssignments(env) {
  return [
    `PATH=${isPresent(env.PATH) ? env.PATH : DEFAULT_PATH}`,
    ...(isPresent(env.HOME) ? [`HOME=${env.HOME}`] : []),
    `TERM=${TERMINAL_TYPE}`,
    `LANG=${isPresent(env.LANG) ? env.LANG : DEFAULT_LANG}`,
  ]
}

// An explicit absolute cwd is forwarded as given. Otherwise the calling
// session's own directory (supported session API data) roots the terminal; an
// unresolved session fails closed, never the server's process cwd.
async function resolveStartDirectory({ cwd, sessionID, resolveSessionDirectory }) {
  if (isPresent(cwd) && path.posix.isAbsolute(cwd)) return { ok: true, directory: cwd }
  let root
  try {
    root = await resolveSessionDirectory?.(sessionID)
  } catch {
    root = undefined
  }
  if (!isPresent(root) || !path.posix.isAbsolute(root)) {
    return failure("v2_terminal_session_unresolved", "The calling session's directory could not be resolved; refusing to start a terminal without it.")
  }
  return { ok: true, directory: isPresent(cwd) ? path.posix.resolve(root, cwd) : root }
}

function createSanitizedTerminalFactory({ serverApi, wrapperPath, assignments, resolveSessionDirectory }) {
  return (sessionID) => {
    const port = createPersistentTerminalPort({ serverApi, sessionID })
    return {
      ...port,
      async start({ command, args = [], title, cwd, size } = {}) {
        // `env` would read `NAME=value` as an assignment instead of the program.
        if (!isPresent(command) || command.includes("=")) {
          return failure("v2_terminal_command_invalid", "interactive_bash start needs a program name without '='.")
        }
        const resolved = await resolveStartDirectory({ cwd, sessionID, resolveSessionDirectory })
        if (!resolved.ok) return resolved
        return await port.start({
          command: wrapperPath,
          args: ["-i", "--", ...assignments, command, ...args],
          title,
          env: {},
          cwd: resolved.directory,
          size,
        })
      },
    }
  }
}

/**
 * @returns {{ status: "ready", terminalFactory: (sessionID: string) => object }
 *   | { status: "unavailable", reason: string }}
 *   `unavailable` means the family must not register at all, whatever other
 *   backend the host might offer.
 */
export function resolveInteractiveTerminalBackend({
  serverApi,
  env = process.env,
  platform = process.platform,
  isExecutable = defaultIsExecutable,
  resolveSessionDirectory,
} = {}) {
  const selector = CREDENTIAL_SELECTORS.find((name) => isPresent(env[name]))
  if (selector) {
    return {
      status: "unavailable",
      reason: `${selector} is set in the process environment; the persistent terminal supports only the managed service-file handoff`,
    }
  }
  if (serverApi?.available !== true) {
    return { status: "unavailable", reason: "no verified OpenCode V2 server API; the persistent terminal needs the managed service handoff" }
  }
  const wrapperPath = platform === "win32" ? undefined : ENV_WRAPPER_CANDIDATES.find((candidate) => isExecutable(candidate))
  if (!wrapperPath) {
    return { status: "unavailable", reason: "no POSIX env wrapper is available to sanitize the terminal environment" }
  }
  return {
    status: "ready",
    terminalFactory: createSanitizedTerminalFactory({
      serverApi,
      wrapperPath,
      assignments: allowlistedAssignments(env),
      resolveSessionDirectory,
    }),
  }
}
