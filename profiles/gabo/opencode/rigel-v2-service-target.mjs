/**
 * Resolve the OpenCode V2 service this process belongs to.
 *
 * The plugin runs INSIDE the `opencode serve --service` daemon, and the V2
 * plugin API exposes neither the server URL nor a credential. The runtime used
 * to pass `undefined` here, which made the server health probe fail closed and
 * left every member pane deferred forever. The daemon already publishes both
 * facts in its own registration file
 * (`$XDG_STATE_HOME/opencode/service.json`, defaulting to
 * `~/.local/state/opencode/service.json`), which is the same channel the CLI
 * itself uses to find a running server. This is a read-only V2 lookup: it reads
 * the daemon's registration, not any OpenCode V1 state.
 *
 * Security contract: the credential is returned ONLY so it can be injected into
 * a pane ENVIRONMENT, and only for a loopback server. A registration file that
 * points anywhere else yields no target at all, so the daemon password can
 * never be sent to, or leaked through, a remote host.
 */

import fs from "node:fs"
import path from "node:path"

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"])
const LOOPBACK_LITERAL = "[::1]"

const DEFAULT_FILE_SYSTEM = {
  existsSync: (candidate) => fs.existsSync(candidate),
  readFileSync: (candidate) => fs.readFileSync(candidate, "utf-8"),
}

export function resolveServiceStateDir({ env = process.env } = {}) {
  const stateHome = typeof env.XDG_STATE_HOME === "string" && env.XDG_STATE_HOME
    ? env.XDG_STATE_HOME
    : typeof env.HOME === "string" && env.HOME
      ? path.join(env.HOME, ".local", "state")
      : null
  if (!stateHome) return null
  return path.join(stateHome, "opencode")
}

export function resolveServiceStatePath({ env = process.env } = {}) {
  const directory = resolveServiceStateDir({ env })
  return directory ? path.join(directory, "service.json") : null
}

export function isLoopbackServerUrl(value) {
  if (typeof value !== "string" || !value) return false
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
  const host = parsed.hostname.toLowerCase()
  return LOOPBACK_HOSTS.has(host) || host === LOOPBACK_LITERAL
}

/**
 * Read the daemon registration. Returns `{ url, password }` (password omitted
 * when the registration carries none) or `null` when the file is absent,
 * unreadable, malformed, or not a loopback target.
 */
export function resolveServiceTarget({ env = process.env, fileSystem = DEFAULT_FILE_SYSTEM } = {}) {
  const file = resolveServiceStatePath({ env })
  if (!file) return null
  let raw
  try {
    if (!fileSystem.existsSync(file)) return null
    raw = fileSystem.readFileSync(file)
  } catch {
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(String(raw))
  } catch {
    return null
  }
  const url = typeof parsed?.url === "string" && parsed.url ? parsed.url : null
  if (!url || !isLoopbackServerUrl(url)) return null
  const password = typeof parsed?.password === "string" && parsed.password ? parsed.password : undefined
  return password ? { url, password } : { url }
}
