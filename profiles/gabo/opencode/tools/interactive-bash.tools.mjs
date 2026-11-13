/**
 * Native V2 port of OmO's `interactive_bash` tool.
 *
 * Source oracle: `packages/omo-opencode/src/tools/interactive-bash/` plus the
 * harness-neutral tmux primitives in `packages/tmux-core/`. The V1 tool spawned
 * the tmux client with `Bun.spawn`; this port keeps the exact V1 observable
 * behavior (tokenizer, prohibited/blocked messages, timeout, exit-code
 * formatting) while a V2-native PTY adapter, not `shell.exec`, runs the command.
 *
 * The tool module is deliberately dependency-injected. The production runtime
 * passes a `createPtyCommandRunner()` port backed by `ctx.pty`; owner tests pass
 * a scripted runner so the observable contract is asserted without a live host.
 */

import fs from "node:fs"

export const INTERACTIVE_BASH_TOOL_NAME = "interactive_bash"

export const DEFAULT_TIMEOUT_MS = 60_000

// V1 constants, byte-for-byte. `capture-pane` and its buffer aliases read the
// terminal, which belongs to the Bash tool; `kill-server` destroys the whole
// tmux server.
export const BLOCKED_TMUX_SUBCOMMANDS = [
  "capture-pane",
  "capturep",
  "save-buffer",
  "saveb",
  "show-buffer",
  "showb",
  "pipe-pane",
  "pipep",
]

export const PROHIBITED_TMUX_SUBCOMMANDS = [
  "kill-server",
]

export const INTERACTIVE_BASH_DESCRIPTION = `Runs commands in the persistent interactive terminal owned by this session. This is NOT tmux: there is no tmux server and no tmux session to address.

Two input forms, exactly one per call:
- action: start (launch a shell), send (write input), read (print terminal output), stop (close it), list (this session's terminals).
- tmux_command: the V1 input, without the 'tmux' prefix. Only these verbs are translated: new-session -> start, send-keys -> send, list-sessions -> list, kill-session -> stop. A '-t <name>' target is not forwarded; the command acts on this session's terminal. Any other tmux verb or option is unsupported and returns an error, never an emulation.

Examples: tmux_command "new-session -d -s omo-dev", then action send with input "npm test" followed by a newline to run it; tmux_command "send-keys -t omo-dev echo hi Enter".

Restrictions: capture-pane, save-buffer, show-buffer, pipe-pane (and their short aliases) are blocked, and kill-server is prohibited. A terminal belongs to the session that started it; another session's terminal is refused. One-shot commands -> use Bash with &.`

const GLOBAL_TMUX_OPTIONS_WITH_ARGS = new Set(["-L", "-S", "-f", "-c", "-T"])

/**
 * Quote-aware command tokenizer with escape handling. Pure port of the V1
 * implementation; handles single/double quotes and backslash escapes without an
 * external dependency.
 */
export function tokenizeCommand(cmd) {
  const tokens = []
  let current = ""
  let inQuote = false
  let quoteChar = ""
  let escaped = false

  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i]

    if (escaped) {
      current += char
      escaped = false
      continue
    }

    if (char === "\\") {
      escaped = true
      continue
    }

    if ((char === "'" || char === '"') && !inQuote) {
      inQuote = true
      quoteChar = char
    } else if (char === quoteChar && inQuote) {
      inQuote = false
      quoteChar = ""
    } else if (char === " " && !inQuote) {
      if (current) {
        tokens.push(current)
        current = ""
      }
    } else {
      current += char
    }
  }

  if (current) tokens.push(current)
  return tokens
}

/** Index of the first non-global-option token, skipping options that take an argument. */
export function findSubcommandIndex(parts) {
  let index = 0
  while (index < parts.length) {
    const part = parts[index] ?? ""

    if (part === "--") {
      return index + 1 < parts.length ? index + 1 : -1
    }

    if (GLOBAL_TMUX_OPTIONS_WITH_ARGS.has(part)) {
      index += 2
      continue
    }

    if (part.startsWith("-")) {
      index++
      continue
    }

    return index
  }

  return -1
}

export function getTargetSessionName(parts) {
  const sessionIdx = parts.findIndex((p) => p === "-t" || p.startsWith("-t"))
  if (sessionIdx === -1) {
    return "omo-session"
  }

  const sessionToken = parts[sessionIdx] ?? ""
  const nextToken = parts[sessionIdx + 1]
  if (sessionToken === "-t" && nextToken) {
    return nextToken
  }

  if (sessionToken.startsWith("-t")) {
    return sessionToken.slice(2)
  }

  return "omo-session"
}

export function buildBlockedTmuxCommandMessage(command, parts) {
  const sessionName = getTargetSessionName(parts)

  return `Error: '${command}' is blocked in interactive_bash.

**USE BASH TOOL INSTEAD:**

\`\`\`bash
# Capture terminal output
tmux capture-pane -p -t ${sessionName}

# Or capture with history (last 1000 lines)
tmux capture-pane -p -t ${sessionName} -S -1000
\`\`\`

The Bash tool can execute these commands directly. Do NOT retry with interactive_bash.`
}

export function buildProhibitedTmuxCommandMessage(command) {
  return `Error: '${command}' is prohibited in interactive_bash.

NEVER EVER run tmux kill-server from interactive_bash.

It terminates the entire tmux server, destroying every tmux session and pane that the user, Codex, or other agents may be using.

Use scoped cleanup only:

\`\`\`bash
tmux kill-session -t <session-name>
\`\`\`

If you created an omo-* session, kill only that exact session. Do not retry kill-server with Bash or any other tool.`
}

/**
 * Blocked-command message for the no-tmux path.
 *
 * V1 pointed at the Bash tool; this host has neither tmux nor a Bash capture
 * route, so the persistent terminal's own `read` action replaces it.
 */
export function buildAdaptedBlockedTmuxCommandMessage(command, parts) {
  const sessionName = getTargetSessionName(parts)

  return `Error: '${command}' is blocked in interactive_bash.

**USE THE 'read' ACTION INSTEAD:**

\`\`\`jsonc
{ "action": "read", "target": "${sessionName}" }
\`\`\`

This host runs interactive_bash over a persistent terminal, not tmux. Read the
session terminal with the \`read\` action (target defaults to this session's
terminal; omit it to read the terminal you started). List terminals with
\`{ "action": "list" }\`.

Do NOT retry '${command}' with interactive_bash.`
}

/** Classify a raw tmux command against the V1 prohibited/blocked lists. */
export function classifyTmuxCommand(parts) {
  const subcommandIndex = findSubcommandIndex(parts)
  const rawSubcommand = subcommandIndex === -1 ? "" : parts[subcommandIndex]
  const subcommand = rawSubcommand.toLowerCase()
  if (PROHIBITED_TMUX_SUBCOMMANDS.includes(subcommand)) {
    return { kind: "prohibited", rawSubcommand }
  }
  if (BLOCKED_TMUX_SUBCOMMANDS.includes(subcommand)) {
    return { kind: "blocked", rawSubcommand }
  }
  return { kind: "allowed", rawSubcommand }
}

export const SUPPORTED_TMUX_VERBS = ["new-session", "send-keys", "list-sessions", "kill-session"]

/**
 * Translate a tmux verb the no-tmux path can serve into an action input.
 *
 * The persistent-terminal port has no tmux session names, so a `-t <name>`
 * target is not forwarded: start/send/stop act on the bound session terminal.
 * Returns `{ action, input? }`, or `{ error }` when the verb has no action
 * equivalent (never a silent no-op).
 */
export function translateTmuxCommand(parts) {
  const subcommandIndex = findSubcommandIndex(parts)
  const rawSubcommand = subcommandIndex === -1 ? "" : (parts[subcommandIndex] ?? "")
  const verb = rawSubcommand.toLowerCase()

  if (verb === "new-session") {
    return { action: "start" }
  }

  if (verb === "send-keys") {
    const keys = []
    for (let index = subcommandIndex + 1; index < parts.length; index++) {
      const token = parts[index] ?? ""
      if (token === "-t") {
        index++
        continue
      }
      if (token.startsWith("-t") && token.length > 2) continue
      if (token.startsWith("-")) continue
      keys.push(token)
    }
    if (keys.length === 0) {
      return { error: "Error: send-keys requires at least one key to send." }
    }
    const lastIndex = keys.length - 1
    if (keys[lastIndex] === "Enter" || keys[lastIndex] === "C-m") keys[lastIndex] = "\n"
    return { action: "send", input: keys.join("") }
  }

  if (verb === "list-sessions") {
    return { action: "list" }
  }

  if (verb === "kill-session") {
    return { action: "stop" }
  }

  return {
    error: `Error: interactive_bash on this host runs without tmux; the '${rawSubcommand}' tmux verb is not supported.

Supported tmux verbs: ${SUPPORTED_TMUX_VERBS.join(", ")}.
Use the action form instead: start, send, read, stop, list.`,
  }
}

// ---------------------------------------------------------------------------
// tmux availability detection (the `interactive_bash` gate)
// ---------------------------------------------------------------------------

function defaultFsPorts() {
  // Deferred so unit tests can run without touching the real filesystem.
  return {
    isFile: (candidate) => {
      try {
        return fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      } catch {
        return false
      }
    },
    isExecutable: (candidate) => {
      if (process.platform === "win32") return true
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return true
      } catch {
        return false
      }
    },
  }
}

/**
 * Scan `PATH` for an executable without spawning a process. Pure when the
 * `isFile`/`isExecutable` ports are injected.
 */
export function findExecutableOnPath({ command, env = {}, platform = process.platform, isFile, isExecutable } = {}) {
  if (typeof command !== "string" || !command) return null
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
      if (isFile(full) && isExecutable(full)) return full
    }
  }
  return null
}

/**
 * The `interactive_bash` gate: register only when a real tmux executable is
 * resolvable on this host. `ports` lets the owner test drive both branches.
 */
export function detectTmuxAvailability({ env = process.env, platform = process.platform, ...ports } = {}) {
  const fsPorts = { ...defaultFsPorts(), ...ports }
  return findExecutableOnPath({ command: "tmux", env, platform, ...fsPorts })
}

// ---------------------------------------------------------------------------
// V2-native PTY command runner
// ---------------------------------------------------------------------------

/**
 * Run a command through OpenCode V2's PTY surface instead of a raw subprocess.
 *
 * `pty` is the V2 `ctx.pty` domain. `attach` is the output port: the V2 PTY API
 * streams through `pty.connect`, which returns a WebSocket, so callers inject a
 * reader that yields `{ data, exitCode }`. The default attach uses the global
 * `WebSocket` after obtaining a connect ticket; a host whose PTY surface cannot
 * stream output surfaces a clear error instead of silently returning empty.
 */
export function createPtyCommandRunner({ pty, location, baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, attach, now = () => Date.now() } = {}) {
  if (!pty || typeof pty.create !== "function" || typeof pty.remove !== "function") {
    throw new TypeError("createPtyCommandRunner requires a V2 pty domain with create/remove")
  }

  const readOutput = attach ?? ((input) => defaultPtyAttach({ ...input, baseUrl }))

  return {
    async run({ command, args = [], cwd, env } = {}) {
      const created = await pty.create({
        ...(location ? { location } : {}),
        command,
        args,
        ...(cwd ? { cwd } : {}),
        ...(env ? { env } : {}),
      })
      const ptyID = created?.data?.id ?? created?.id
      if (typeof ptyID !== "string" || !ptyID) {
        throw new Error("V2 pty.create did not return a ptyID")
      }

      const startedAt = now()
      let result
      try {
        result = await readOutput({ pty, ptyID, location, timeoutMs, startedAt, now })
      } catch (error) {
        try {
          await pty.remove({ ptyID, ...(location ? { location } : {}) })
        } catch {
          // Removal failure must not mask the original output error.
        }
        throw error
      }

      try {
        await pty.remove({ ptyID, ...(location ? { location } : {}) })
      } catch {
        // An exited session may already be gone; the command result still stands.
      }
      return result
    },
  }
}

/**
 * Default PTY output reader. V2 streams a PTY over a WebSocket at
 * `/api/pty/{ptyID}/connect?ticket=...`; the ticket comes from `connectToken`.
 * When the host cannot provide a base URL or a global WebSocket, this reports
 * the unsupported primitive instead of pretending the command produced no
 * output. Owner tests inject `attach` and do not exercise this path.
 */
async function defaultPtyAttach({ pty, ptyID, location, timeoutMs, now, startedAt, baseUrl }) {
  const token = typeof pty.connectToken === "function"
    ? await pty.connectToken({ ptyID, ...(location ? { location } : {}) })
    : undefined
  const ticket = token?.data?.ticket ?? token?.ticket
  const WebSocketImpl = globalThis.WebSocket
  if (typeof WebSocketImpl !== "function" || typeof baseUrl !== "string" || !baseUrl || typeof ticket !== "string" || !ticket) {
    throw new Error("V2 pty output stream is unavailable on this host")
  }

  const url = new URL(`/api/pty/${encodeURIComponent(ptyID)}/connect`, baseUrl)
  if (url.protocol === "http:") url.protocol = "ws:"
  else if (url.protocol === "https:") url.protocol = "wss:"
  url.searchParams.set("ticket", ticket)

  return await new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url)
    const chunks = []
    const timer = setTimeout(() => {
      try { socket.close() } catch { /* already closed */ }
      reject(new Error(`Timeout after ${timeoutMs}ms`))
    }, Math.max(0, timeoutMs - (now() - startedAt)))

    socket.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : ""
      if (typeof data === "string" && data.length > 0) chunks.push(data)
    })
    socket.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error("V2 pty output stream failed"))
    })
    socket.addEventListener("close", (event) => {
      clearTimeout(timer)
      resolve({ stdout: chunks.join(""), stderr: "", exitCode: typeof event?.code === "number" && event.code !== 0 ? event.code : 0 })
    })
  })
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const INTERACTIVE_BASH_TOOL_INPUT = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["start", "send", "read", "stop", "list"],
      description: "Persistent-terminal action (use instead of tmux_command on a host without tmux)",
    },
    command: { type: "string", description: "start: command to launch (default /bin/bash)" },
    input: { type: "string", description: "send: text to write to the terminal" },
    cwd: { type: "string", description: "start: working directory" },
    timeout_ms: { type: "number", description: "send: optional write timeout in milliseconds" },
    target: { type: "string", description: "Optional terminal id; defaults to the terminal started for this session" },
    tmux_command: { type: "string", description: "The tmux command to execute (without 'tmux' prefix)" },
  },
  required: [],
  additionalProperties: false,
}

// Per-session default terminal id. Module-level so every tool instance shares
// the binding; an explicit `target` always overrides it. The map is only a
// convenience: every id it yields is still checked against the calling
// session's own terminal list before use.
const SESSION_TERMINALS = new Map()

// The calling session id. There is no default: a terminal is created and
// addressed per session, so a call that cannot name its session fails closed.
function resolveSessionID(toolContext, getSessionID) {
  const fromContext = typeof toolContext?.sessionID === "string" ? toolContext.sessionID : ""
  if (fromContext) return fromContext
  const fromGetter = typeof getSessionID === "function" ? getSessionID() : ""
  return typeof fromGetter === "string" ? fromGetter : ""
}

function describeError(error) {
  if (error instanceof Error) return error.message
  return String(error ?? "unknown error")
}

function terminalFailure(result) {
  const error = result?.error
  if (error && typeof error.message === "string" && error.message) return error.message
  if (error) return String(error)
  return "terminal action failed"
}

const PERMISSION_UNAVAILABLE_MESSAGE = "Error: interactive_bash permission service is unavailable; refusing to touch the terminal"

// Terminal ids are server-global, so ownership is read from the calling session's
// own terminal list. An unreadable list fails closed. Returns an error string or
// undefined when the session owns the terminal.
async function terminalOwnershipError(port, ptyID) {
  let result
  try {
    result = await port.list()
  } catch (error) {
    return `Error: ${describeError(error)}`
  }
  if (!result?.ok) return `Error: ${terminalFailure(result)}`
  const terminals = Array.isArray(result.terminals) ? result.terminals : []
  return terminals.some((terminal) => terminal?.id === ptyID)
    ? undefined
    : `Error: terminal '${ptyID}' does not belong to this session`
}

/**
 * Create the `interactive_bash` ToolDefinition for the V2 `tool.transform`
 * editor.
 *
 * Two mutually exclusive backends:
 * - `runner` (+ `tmuxPath`): the V1 tmux path, unchanged.
 * - `terminalFactory(sessionID)`: the no-tmux path over a persistent terminal
 *   port, driven by the `action` interface and by the tmux verbs that map onto
 *   it. The V1-compatible `tmux_command` input still works.
 */
export function createInteractiveBashTool({ runner, tmuxPath = "tmux", timeoutMs = DEFAULT_TIMEOUT_MS, terminalFactory, getSessionID, permission } = {}) {
  const hasRunner = Boolean(runner) && typeof runner.run === "function"
  const hasTerminalFactory = typeof terminalFactory === "function"
  if (!hasRunner && !hasTerminalFactory) {
    throw new TypeError("createInteractiveBashTool requires a runner with run() or a terminalFactory")
  }

  // Every shell-capable step on the persistent terminal (start, and every write)
  // is asserted through the official V2 `context.permission` service with the
  // `shell` action, so the host's own prompt/deny/abort applies. A denial or an
  // abort rejects and propagates; nothing touches the PTY before it resolves. A
  // missing service fails closed. The Rigel tool-name `interactive_bash` gate stays
  // as deny defense-in-depth: its name-level `ask` is a hard block pending
  // approval, never a prompt, so the real approval path is this assertion.
  async function assertShellPermission({ toolContext, sessionID, resources, metadata }) {
    if (typeof permission?.assert !== "function") return PERMISSION_UNAVAILABLE_MESSAGE
    await permission.assert({
      sessionID,
      agent: toolContext?.agent,
      source: { type: "tool", messageID: toolContext?.messageID, id: toolContext?.id },
      action: "shell",
      resources,
      metadata: { tool: INTERACTIVE_BASH_TOOL_NAME, ...metadata },
    })
    return undefined
  }

  async function runTmuxRunner(parts) {
    try {
      const result = await runner.run({ command: tmuxPath, args: parts, timeoutMs })
      const stdout = typeof result?.stdout === "string" ? result.stdout : ""
      const stderr = typeof result?.stderr === "string" ? result.stderr : ""
      const exitCode = typeof result?.exitCode === "number" ? result.exitCode : 0
      if (exitCode !== 0) {
        const errorMsg = stderr.trim() || `Command failed with exit code ${exitCode}`
        return `Error: ${errorMsg}`
      }
      return stdout || "(no output)"
    } catch (error) {
      return `Error: ${describeError(error)}`
    }
  }

  async function executeAction(input, toolContext) {
    if (!hasTerminalFactory) {
      return "Error: this interactive_bash instance has no persistent-terminal factory"
    }
    const action = typeof input.action === "string" ? input.action : ""
    const sessionID = resolveSessionID(toolContext, getSessionID)
    if (!sessionID) return "Error: interactive_bash needs the calling session id; refusing to address a terminal without it"
    let port
    try {
      port = terminalFactory(sessionID)
    } catch (error) {
      return `Error: ${describeError(error)}`
    }
    if (!port || typeof port !== "object") {
      return "Error: terminalFactory did not return a terminal port"
    }

    if (action === "start") {
      const command = typeof input.command === "string" && input.command ? input.command : "/bin/bash"
      const denied = await assertShellPermission({
        toolContext,
        sessionID,
        resources: [command],
        metadata: { action: "start", command, cwd: input.cwd },
      })
      if (denied) return denied
      let result
      try {
        result = await port.start({ command, args: [], title: input.command ?? "interactive", env: {}, cwd: input.cwd })
      } catch (error) {
        return `Error: ${describeError(error)}`
      }
      if (!result?.ok) return `Error: ${terminalFailure(result)}`
      const ptyID = result.ptyID
      if (typeof ptyID === "string" && ptyID) SESSION_TERMINALS.set(sessionID, ptyID)
      return `interactive_bash started\nterminal: ${typeof ptyID === "string" && ptyID ? ptyID : "unknown"}`
    }

    if (action === "send" || action === "read" || action === "stop") {
      const requested = typeof input.target === "string" && input.target ? input.target : SESSION_TERMINALS.get(sessionID)
      if (!requested) return "Error: no active terminal for this session; run action 'start' first"
      // A terminal id is server-global: only one the calling session owns may be
      // addressed, whether it came from `target` or from this tool's own memory.
      const ownershipError = await terminalOwnershipError(port, requested)
      if (ownershipError) return ownershipError
      const target = requested

      if (action === "send") {
        const data = typeof input.input === "string" ? input.input : ""
        const denied = await assertShellPermission({
          toolContext,
          sessionID,
          resources: [data],
          metadata: { action: "send", ptyID: target },
        })
        if (denied) return denied
        let result
        try {
          result = await port.write({ ptyID: target, data })
        } catch (error) {
          return `Error: ${describeError(error)}`
        }
        return result?.ok ? "ok" : `Error: ${terminalFailure(result)}`
      }

      if (action === "read") {
        let result
        try {
          result = await port.snapshot({ ptyID: target })
        } catch (error) {
          return `Error: ${describeError(error)}`
        }
        if (!result?.ok) return `Error: ${terminalFailure(result)}`
        const text = typeof result.text === "string" ? result.text : ""
        return text || "(no output)"
      }

      let result
      try {
        result = await port.remove({ ptyID: target })
      } catch (error) {
        return `Error: ${describeError(error)}`
      }
      if (!result?.ok) return `Error: ${terminalFailure(result)}`
      if (SESSION_TERMINALS.get(sessionID) === target) SESSION_TERMINALS.delete(sessionID)
      return "ok"
    }

    if (action === "list") {
      let result
      try {
        result = await port.list()
      } catch (error) {
        return `Error: ${describeError(error)}`
      }
      if (!result?.ok) return `Error: ${terminalFailure(result)}`
      const terminals = Array.isArray(result.terminals) ? result.terminals : []
      if (terminals.length === 0) return "(no terminals)"
      return JSON.stringify(terminals)
    }

    return `Error: unknown action '${action}'; supported actions: start, send, read, stop, list`
  }

  return {
    name: INTERACTIVE_BASH_TOOL_NAME,
    options: { codemode: false },
    description: INTERACTIVE_BASH_DESCRIPTION,
    input: INTERACTIVE_BASH_TOOL_INPUT,
    async execute(input = {}, toolContext) {
      const hasAction = typeof input.action === "string" && input.action.length > 0
      const hasTmuxCommand = typeof input.tmux_command === "string" && input.tmux_command.length > 0

      if (hasAction && hasTmuxCommand) {
        return "Error: provide exactly one of 'action' or 'tmux_command'"
      }

      if (hasTmuxCommand) {
        const parts = tokenizeCommand(input.tmux_command)
        if (parts.length === 0) {
          return "Error: Empty tmux command"
        }

        const classification = classifyTmuxCommand(parts)
        if (classification.kind === "prohibited") {
          return buildProhibitedTmuxCommandMessage(classification.rawSubcommand)
        }
        if (classification.kind === "blocked") {
          return hasRunner
            ? buildBlockedTmuxCommandMessage(classification.rawSubcommand, parts)
            : buildAdaptedBlockedTmuxCommandMessage(classification.rawSubcommand, parts)
        }

        if (hasRunner) {
          return await runTmuxRunner(parts)
        }

        const translated = translateTmuxCommand(parts)
        if (translated.error) return translated.error
        return await executeAction(translated, toolContext)
      }

      if (hasAction) {
        return await executeAction(input, toolContext)
      }

      return "Error: provide exactly one of 'action' or 'tmux_command'"
    },
  }
}
