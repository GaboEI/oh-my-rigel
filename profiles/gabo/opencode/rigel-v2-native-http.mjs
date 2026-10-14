// Native OpenCode V2 HTTP client for the Rigel runtime.
//
// The V2 plugin setup context exposes session enumeration and a pty domain on
// some hosts, but not the persistent-terminal, shell, or session-export
// surfaces. Those are reached through the server's own HTTP API, which the
// plugin shares the process with. This module resolves that server from the
// host-provided origin and authenticates with the server's Basic credential.
//
// SECURITY MODEL - no credential leaves the process before identity is proven.
// The credential is sent to exactly one origin, and only after that origin is
// proven local by a pre-credential anchor, never to an arbitrary loopback:
//   - host-context: the origin equals the V2 setup context `serverUrl` (the
//     host's own server). The synthetic fallback host `localhost` on port 4096
//     means "no V2 server" and is refused, because the legacy installation owns
//     that port;
//   - process-registration: the origin equals the host's OWN local service
//     handoff (`.../opencode/service.json`, the file `opencode serve --service`
//     writes and `@opencode/client/service` reads) AND that file's `pid` is this
//     same process - proving the descriptor describes this very process's server;
//   - process-argv: the origin equals this process's own `serve --hostname/--port`
//     (the plugin and the server are the same process);
//   - process-socket: an origin supplied only by the environment is trusted only
//     when the listening port is a socket owned by this same PID (Linux
//     `/proc/net/tcp` inode matched against `/proc/self/fd`).
// An origin that matches none of these is UNTRUSTED: `verifyIdentity` sends
// nothing, `raw` refuses, and no server-dependent tool registers. The port
// number is never identity; 4096 is accepted when it is genuinely this process's
// or the host's server.
//
// Identity gate: `verifyIdentity()` is the ONLY pre-verification request. It
// probes `GET /api/info` on the trusted origin and requires the V2 identity
// document (version, numeric pid, urls). Until it succeeds, `available` is
// false and every functional `raw` call returns `v2_http_unverified` without
// sending anything. The runtime awaits `verifyIdentity()` before registering any
// server-dependent tool, so a failed verification registers nothing.
//
// Credentials: the server accepts `OPENCODE_PASSWORD`, then the newer
// `OPENCODE_SERVER_PASSWORD`, with `OPENCODE_SERVER_USERNAME` (default
// `opencode`). When the process environment carries no password (the normal
// `opencode serve --service` case), the credential comes from the host's own
// service registration file's `password`, paired to that same origin so the
// credential is never redirected to a different loopback. No V1 file is ever
// read. An empty value is treated as absent so a partial host environment fails
// closed instead of sending a broken credential.
//
// Every public method resolves to a typed result and never throws. The
// exceptions are `identityCheck` and `verifyIdentity`, which return
// `{ ok }` / `{ ok, reason }` so a caller can fail closed.

import fs from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const DEFAULT_TIMEOUT_MS = 10000
const SEARCH_TIMEOUT_MS = 60000

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "0:0:0:0:0:0:0:1"])
const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/
// The only synthetic origin the host itself can emit: `serverUrl` falls back to
// this exact value when no V2 server is listening. It is refused because the
// V1 installation is the owner of that loopback port.
const SYNTHETIC_FALLBACK_HOST = "localhost"
const SYNTHETIC_FALLBACK_PORT = "4096"
const ENV_ORIGIN_KEYS = ["RIGEL_V2_SERVER_ORIGIN", "OPENCODE_SERVER_ORIGIN", "OPENCODE_SERVER_URL"]
// The host's own local service handoff: the file `opencode serve --service`
// writes and `@opencode/client/service` reads. The default path matches the
// official client: `${XDG_STATE_HOME ?? ~/.local/state}/opencode/service.json`.
const SERVICE_FILE_ENV_KEYS = ["RIGEL_V2_SERVICE_FILE", "OPENCODE_SERVICE_FILE"]
const SERVICE_CONFIG_ENV_KEYS = ["RIGEL_V2_SERVICE_CONFIG_FILE", "OPENCODE_SERVICE_CONFIG_FILE"]
const SERVICE_STATE_DIR = "opencode"
const SERVICE_FILE_NAME = "service.json"
const SERVICE_USERNAME = "opencode"
const SESSION_QUERY_KEYS = ["limit", "order", "search", "parentID", "directory", "project", "subpath", "cursor"]
const TERMINAL_BODY_KEYS = ["command", "args", "title", "env", "size"]
const SHELL_BODY_KEYS = ["command", "cwd", "timeout", "metadata"]

function typedError(code, message) {
  return { code, message: String(message ?? "") }
}

function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error ?? "unknown error")
}

// Read `--name value` or `--name=value` from a raw argv array. A missing value
// is treated as absent, never as the next flag.
function readFlag(argv, name) {
  const prefix = `${name}=`
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (typeof token !== "string") continue
    if (token === name) {
      const value = argv[index + 1]
      if (typeof value === "string" && value.length > 0 && !value.startsWith("--")) return value
      return undefined
    }
    if (token.startsWith(prefix)) {
      const value = token.slice(prefix.length)
      return value.length > 0 ? value : undefined
    }
  }
  return undefined
}

function pickDefined(source, keys) {
  const result = {}
  for (const key of keys) {
    const value = source?.[key]
    if (value !== undefined) result[key] = value
  }
  return result
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase()
  return Object.keys(headers).some((key) => key.toLowerCase() === lower)
}

function normalizeHost(value) {
  return String(value ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "")
}

function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(host) || LOOPBACK_IPV4.test(host)
}

function isValidPort(port) {
  if (typeof port !== "string" || !/^\d+$/.test(port)) return false
  const value = Number(port)
  return Number.isInteger(value) && value >= 1 && value <= 65535
}

function originFromParts(protocol, host, port, source) {
  const normalizedHost = normalizeHost(host)
  if (!isLoopbackHost(normalizedHost)) return undefined
  if (!isValidPort(String(port))) return undefined
  const displayHost = normalizedHost.includes(":") ? `[${normalizedHost}]` : normalizedHost
  return { origin: `${protocol}//${displayHost}:${port}`, host: normalizedHost, port: String(port), source }
}

// Accept a full URL string only when it is http(s) on loopback. Returns
// `{ origin, host, port, source }` or `undefined`. Never throws.
function originFromUrl(raw, source) {
  if (typeof raw !== "string" || raw.trim() === "") return undefined
  let url
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  return originFromParts(url.protocol, url.hostname, url.port, source)
}

// Resolve the local service registration file path (the file the server writes
// for its clients). Matches the official client default
// (`${XDG_STATE_HOME ?? ~/.local/state}/opencode/service.json`), with an explicit
// env override so a caller can point at a non-default registration.
export function serviceRegistrationPath({ env = {}, home } = {}) {
  try {
    for (const key of SERVICE_FILE_ENV_KEYS) {
      const value = env?.[key]
      if (typeof value === "string" && value.trim() !== "") return value
    }
    const stateHome = typeof env?.XDG_STATE_HOME === "string" && env.XDG_STATE_HOME.trim() !== ""
      ? env.XDG_STATE_HOME
      : join(homeRoot({ env, home }), ".local", "state")
    return join(stateHome, SERVICE_STATE_DIR, SERVICE_FILE_NAME)
  } catch {
    return undefined
  }
}

// Resolve the local service CONFIG file path, where the host persists the
// service password (the `password` field of the same `service.json` name).
// Matches the official default (`${XDG_CONFIG_HOME ?? ~/.config}/opencode/service.json`).
export function serviceConfigPath({ env = {}, home } = {}) {
  try {
    for (const key of SERVICE_CONFIG_ENV_KEYS) {
      const value = env?.[key]
      if (typeof value === "string" && value.trim() !== "") return value
    }
    const configHome = typeof env?.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim() !== ""
      ? env.XDG_CONFIG_HOME
      : join(homeRoot({ env, home }), ".config")
    return join(configHome, SERVICE_STATE_DIR, SERVICE_FILE_NAME)
  } catch {
    return undefined
  }
}

function readJsonObject(fsImpl, path) {
  if (typeof path !== "string") return undefined
  try {
    const text = fsImpl.readFileSync(path, "utf8")
    if (typeof text !== "string" || text.trim() === "") return undefined
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

// The host handoff is discoverable only when the host environment is available:
// an explicit `home` or the caller-provided env's HOME. Without one there is no
// host to discover, and a process (such as a test) must not read the
// developer's own files.
function discoverableHome({ env, home }) {
  if (typeof home === "string" && home.trim() !== "") return home
  const fromEnv = env?.HOME
  return typeof fromEnv === "string" && fromEnv.trim() !== "" ? fromEnv : undefined
}

// The home root for a default path: an explicit `home`, the caller-provided
// env's HOME, then the process home (the official default).
function homeRoot({ env, home }) {
  return discoverableHome({ env, home }) ?? homedir()
}

// Read the host's OWN local service handoff: the STATE registration (origin +
// pid; the file `opencode serve --service` writes and `@opencode/client` reads)
// merged with the CONFIG service file (where the host persists the password).
// Returns a loopback origin plus the service password, or `undefined`. Never
// throws: an unreadable, malformed, or non-loopback file fails closed, and an
// absent host environment (no HOME) yields `undefined` without touching disk.
// `pidMatches` is true only when the registration's `pid` equals the caller's
// own process id, which proves the descriptor describes this very process.
export function readServiceRegistration({ env = {}, home, processPid, fsImpl = fs } = {}) {
  try {
    const root = discoverableHome({ env, home })
    if (root === undefined) return undefined
    const paths = { env, home: root }
    const statePath = serviceRegistrationPath(paths)
    const stateInfo = readJsonObject(fsImpl, statePath)

    // No state registration: fall back to the config file alone (origin from its
    // own hostname/port, password from its own field; no pid to prove).
    if (!stateInfo) {
      const configPath = serviceConfigPath(paths)
      const configInfo = readJsonObject(fsImpl, configPath)
      if (!configInfo) return undefined
      const resolved = originFromParts("http:", configInfo.hostname ?? "127.0.0.1", configInfo.port, "process-registration")
      if (!resolved) return undefined
      const password = typeof configInfo.password === "string" && configInfo.password.length > 0 ? configInfo.password : undefined
      return { origin: resolved.origin, host: resolved.host, port: resolved.port, pid: undefined, pidMatches: false, password, version: undefined, path: configPath }
    }

    const resolved = originFromUrl(typeof stateInfo.url === "string" ? stateInfo.url : undefined, "process-registration")
    if (!resolved) return undefined
    const pid = Number.isInteger(stateInfo.pid) ? stateInfo.pid : undefined
    const pidMatches = pid !== undefined && Number.isInteger(processPid) && pid === processPid
    const statePassword = typeof stateInfo.password === "string" && stateInfo.password.length > 0 ? stateInfo.password : undefined
    // Only this process's own registration justifies reading the config file for
    // the persisted password; a foreign or stale registration never reaches for
    // it. The config password is accepted only when it describes the SAME origin
    // (no credential redirection) or carries no origin of its own.
    let password = statePassword
    if (password === undefined && pidMatches) {
      const configInfo = readJsonObject(fsImpl, serviceConfigPath(paths))
      const configResolved = configInfo
        ? originFromParts("http:", configInfo.hostname ?? "127.0.0.1", configInfo.port, "process-registration")
        : undefined
      const candidate = typeof configInfo?.password === "string" && configInfo.password.length > 0 ? configInfo.password : undefined
      if (candidate !== undefined && (!configResolved || configResolved.origin === resolved.origin)) password = candidate
    }
    return {
      origin: resolved.origin,
      host: resolved.host,
      port: resolved.port,
      pid,
      pidMatches,
      password,
      version: typeof stateInfo.version === "string" ? stateInfo.version : undefined,
      path: statePath,
    }
  } catch {
    return undefined
  }
}

// Build the Basic credential from the host registration's password. The
// username matches the official client (`opencode`).
export function registrationCredential(registration) {
  const password = registration?.password
  if (typeof password !== "string" || password.length === 0) return undefined
  return {
    username: SERVICE_USERNAME,
    password,
    authorization: `Basic ${Buffer.from(`${SERVICE_USERNAME}:${password}`).toString("base64")}`,
  }
}

// Resolve the loopback server origin from a serve argv. Returns `{ origin }`
// only when a valid port is present and the host is loopback. Any port is
// accepted, including 4096. Never throws.
export function parseServerOrigin(argv) {
  try {
    if (!Array.isArray(argv)) return { origin: undefined }
    const host = readFlag(argv, "--hostname") ?? "127.0.0.1"
    const port = readFlag(argv, "--port")
    const resolved = originFromParts("http:", host, port, "argv")
    if (!resolved) return { origin: undefined }
    return { origin: resolved.origin, host: resolved.host, port: resolved.port }
  } catch {
    return { origin: undefined }
  }
}

// Resolve the server origin candidate from host and process sources, in trust
// order: the host context, then the host's own local service registration, then
// this process's own argv, then an explicit environment origin.
// `parseServerOrigin(argv)` remains available for argv-only callers. Never
// throws; an unresolvable origin yields `{ origin: undefined }`.
export function resolveServerOrigin({ argv = [], env = {}, context = {}, registration } = {}) {
  try {
    const contextUrl = context?.serverUrl
    if (contextUrl !== undefined && contextUrl !== null) {
      const raw = typeof contextUrl === "string" ? contextUrl : contextUrl?.toString?.()
      const resolved = originFromUrl(raw, "context.serverUrl")
      if (resolved) {
        const synthetic =
          resolved.host === SYNTHETIC_FALLBACK_HOST && resolved.port === SYNTHETIC_FALLBACK_PORT
        if (!synthetic) return resolved
      }
    }
    // The host's own registration is what its clients use, so it outranks this
    // process's argv and the environment - but only when its `pid` is this very
    // process's own, so a stale or foreign registration can never shadow argv or
    // a host context. Trust is decided by `resolveTrustedOrigin`.
    if (registration?.origin && registration.pidMatches === true) {
      return { origin: registration.origin, host: registration.host, port: registration.port, source: "process-registration" }
    }
    const fromArgv = parseServerOrigin(argv)
    if (fromArgv.origin) return { ...fromArgv, source: "argv" }
    for (const key of ENV_ORIGIN_KEYS) {
      const resolved = originFromUrl(env?.[key], `env.${key}`)
      if (resolved) return resolved
    }
    return { origin: undefined }
  } catch {
    return { origin: undefined }
  }
}

// Prove a loopback origin is served by THIS process without sending anything:
// match the port's LISTEN inode in /proc/net/tcp against this process's own
// socket file descriptors. Returns true, false, or undefined when it cannot be
// determined (non-Linux, no /proc, port not listening).
export function socketOwnedBySelf(host, port, {
  netTcp = "/proc/net/tcp",
  netTcp6 = "/proc/net/tcp6",
  fdDir = "/proc/self/fd",
} = {}) {
  try {
    const portHex = Number(port).toString(16).toUpperCase().padStart(4, "0")
    const sources = String(host).includes(":") ? [netTcp6] : [netTcp, netTcp6]
    const inodes = []
    for (const source of sources) {
      let text
      try {
        text = fs.readFileSync(source, "utf8")
      } catch {
        continue
      }
      for (const line of text.split("\n").slice(1)) {
        const columns = line.trim().split(/\s+/)
        if (columns.length < 10) continue
        if (columns[3] !== "0A") continue
        if (columns[1].split(":")[1] !== portHex) continue
        inodes.push(columns[9])
      }
    }
    if (inodes.length === 0) return undefined
    for (const descriptor of fs.readdirSync(fdDir)) {
      let link
      try {
        link = fs.readlinkSync(`${fdDir}/${descriptor}`)
      } catch {
        continue
      }
      if (inodes.some((inode) => link === `socket:[${inode}]`)) return true
    }
    return false
  } catch {
    return undefined
  }
}

// Decide whether the resolved origin may receive the credential, using only
// pre-credential proofs. `trusted` is the gate: an untrusted origin is never
// contacted by `verifyIdentity` or `raw`.
export function resolveTrustedOrigin({ argv = [], env = {}, context = {}, registration } = {}, socketOwner = socketOwnedBySelf) {
  const candidate = resolveServerOrigin({ argv, env, context, registration })
  if (!candidate.origin) return { origin: undefined, trusted: false, anchor: undefined }

  const hostUrl = context?.serverUrl
  if (hostUrl !== undefined && hostUrl !== null) {
    const raw = typeof hostUrl === "string" ? hostUrl : hostUrl?.toString?.()
    const hostResolved = originFromUrl(raw, "context.serverUrl")
    const synthetic =
      hostResolved && hostResolved.host === SYNTHETIC_FALLBACK_HOST && hostResolved.port === SYNTHETIC_FALLBACK_PORT
    if (hostResolved && !synthetic && hostResolved.origin === candidate.origin) {
      return { ...candidate, trusted: true, anchor: "host-context" }
    }
  }

  // The host's own registration file (the same handoff its clients read) is
  // trusted only when its `pid` is this very process's, which proves the
  // descriptor is this process's own server.
  if (registration?.pidMatches && registration.origin === candidate.origin) {
    return { ...candidate, trusted: true, anchor: "process-registration" }
  }

  const argvResolved = parseServerOrigin(argv)
  if (argvResolved.origin && argvResolved.origin === candidate.origin) {
    return { ...candidate, trusted: true, anchor: "process-argv" }
  }

  if (socketOwner(candidate.host, candidate.port) === true) {
    return { ...candidate, trusted: true, anchor: "process-socket" }
  }

  return { ...candidate, trusted: false, anchor: undefined }
}

// Resolve the server credential from the V2 process's own launch environment.
// Both variable names are legitimate; the first non-empty wins and a present
// but empty value falls through. The password bytes are never trimmed.
export function resolveCredential(env = {}) {
  const read = (key) => (typeof env?.[key] === "string" && env[key].trim() !== "" ? env[key] : undefined)
  const password = read("OPENCODE_PASSWORD") ?? read("OPENCODE_SERVER_PASSWORD")
  if (password === undefined) return undefined
  const username = read("OPENCODE_SERVER_USERNAME") ?? "opencode"
  return {
    username,
    password,
    authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
  }
}

export function createServerApi({
  argv = process.argv,
  env = process.env,
  context,
  fetchImpl = globalThis.fetch,
  socketOwner = socketOwnedBySelf,
  registration,
  home,
  processPid = process.pid,
  fsImpl = fs,
} = {}) {
  // The registration is the host's own local service handoff. A caller may pass
  // one directly (tests); otherwise it is read from the default (or
  // env-overridden) path. `null` disables the read so a caller can prove the
  // env/argv-only behavior.
  const service =
    registration === undefined ? readServiceRegistration({ env, home, processPid, fsImpl }) : registration
  const resolution = resolveTrustedOrigin({ argv, env, context, registration: service }, socketOwner)
  const origin = resolution.origin
  const trusted = resolution.trusted === true
  const anchor = resolution.anchor
  // Credential priority: the process's own launch env, then the host
  // registration's password - but only when the resolved origin is that same
  // registration's origin, so the credential is never redirected elsewhere.
  const credential =
    resolveCredential(env) ??
    (service?.password !== undefined && service.origin === origin ? registrationCredential(service) : undefined)
  const authorization = credential?.authorization
  const hasFetch = typeof fetchImpl === "function"
  // The credential may be sent only to a trusted origin, and functional calls
  // only after identity is verified. Before either, nothing leaves the process.
  const canProbe = trusted && Boolean(origin) && typeof authorization === "string" && hasFetch
  let identityResult
  let identityChecked = false
  let verified = false

  async function parseBody(response) {
    if (typeof response?.text !== "function") return null
    let text
    try {
      text = await response.text()
    } catch {
      return null
    }
    if (typeof text !== "string" || text.trim() === "") return null
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  async function normalizeResponse(response, method, path) {
    const status = typeof response?.status === "number" ? response.status : 0
    if (status === 401 || status === 403) {
      return { ok: false, status, data: null, error: typedError("v2_http_auth", `OpenCode V2 server rejected the credentials (HTTP ${status}).`) }
    }
    if (status === 404) {
      return { ok: false, status, data: null, error: typedError("v2_http_not_found", `OpenCode V2 endpoint not found (HTTP 404): ${method} ${path}`) }
    }
    if (status < 200 || status >= 300) {
      return { ok: false, status, data: null, error: typedError("v2_http_error", `OpenCode V2 request failed (HTTP ${status}): ${method} ${path}`) }
    }
    return { ok: true, status, data: await parseBody(response), error: null }
  }

  // The actual credential-bearing fetch. It is called only by `verifyIdentity`
  // on a trusted origin, and by `raw` after identity has been verified.
  async function probe(method, path, init = {}) {
    const url = `${origin}${path}`
    const headers = { Authorization: authorization, Accept: "application/json" }
    if (init.headers) Object.assign(headers, init.headers)
    let body
    if (typeof init.body !== "undefined") {
      body = typeof init.body === "string" ? init.body : JSON.stringify(init.body)
      if (!hasHeader(headers, "content-type")) headers["Content-Type"] = "application/json"
    }
    const timeout = Number.isFinite(init.timeout) ? init.timeout : DEFAULT_TIMEOUT_MS
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    let response
    try {
      response = await fetchImpl(url, { method, headers, body, signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) {
        return {
          ok: false,
          status: null,
          data: null,
          error: typedError("v2_http_timeout", `OpenCode V2 request timed out after ${timeout}ms: ${method} ${path}`),
        }
      }
      return {
        ok: false,
        status: null,
        data: null,
        error: typedError("v2_http_error", `OpenCode V2 request failed: ${errorMessage(error)}`),
      }
    } finally {
      clearTimeout(timer)
    }
    return await normalizeResponse(response, method, path)
  }

  // Functional request. Refuses before identity is verified so no credential is
  // sent to an unverified origin, and refuses outright when the origin did not
  // pass a pre-credential trust anchor.
  async function raw(method, path, init = {}) {
    if (!trusted) {
      return {
        ok: false,
        status: null,
        data: null,
        error: typedError("v2_http_untrusted", "OpenCode V2 server API is unavailable: the resolved origin is not the V2 host's own server, this process's serve server, or a socket owned by this process."),
      }
    }
    if (!canProbe) {
      return {
        ok: false,
        status: null,
        data: null,
        error: typedError("v2_http_unavailable", "OpenCode V2 server API is unavailable: OPENCODE_PASSWORD or OPENCODE_SERVER_PASSWORD and a fetch implementation are required."),
      }
    }
    if (!verified) {
      return {
        ok: false,
        status: null,
        data: null,
        error: typedError("v2_http_unverified", "OpenCode V2 server identity has not been verified; refusing to send the credential."),
      }
    }
    return await probe(method, path, init)
  }

  // Confirm the server sees this session as the caller's own session. Fails
  // closed on mismatch, transport error and any non-2xx response.
  async function identityCheck(currentSessionID) {
    if (typeof currentSessionID !== "string" || currentSessionID.length === 0) {
      return { ok: false, reason: "Session identity check requires a session id." }
    }
    const result = await raw("GET", `/api/session/${encodeURIComponent(currentSessionID)}`)
    if (!result.ok) return { ok: false, reason: result.error.message }
    const reported = result.data?.data?.id ?? result.data?.id
    if (reported === currentSessionID) return { ok: true }
    return { ok: false, reason: `Session identity mismatch: expected "${currentSessionID}" but the server reported "${reported ?? "none"}".` }
  }

  // Prove the trusted origin is an OpenCode V2 server, not a foreign or legacy
  // one, by its own identity document. This is the only request sent before
  // verification, and it is sent only to an origin that passed a pre-credential
  // trust anchor. `GET /api/info` must answer 2xx with a version string, a
  // numeric pid and a url list; the check is shape-based, never keyed on the
  // port, so a legitimate V2 server on any port (including 4096) passes while a
  // V1 or unrelated loopback service fails. On success `verified` becomes true;
  // on any other outcome it stays false and every functional call refuses.
  async function verifyIdentity() {
    if (identityChecked) return identityResult
    identityChecked = true
    if (!trusted) {
      identityResult = { ok: false, anchor, reason: "Origin is not proven local (host context, this process's serve argv, or a socket owned by this process); refusing to send any credential." }
      return identityResult
    }
    if (!canProbe) {
      identityResult = { ok: false, anchor, reason: "A trusted loopback origin and OPENCODE_PASSWORD or OPENCODE_SERVER_PASSWORD are required." }
      return identityResult
    }
    const info = await probe("GET", "/api/info")
    if (!info.ok) {
      identityResult = { ok: false, anchor, reason: `OpenCode V2 identity probe failed: ${info.error.message}` }
      return identityResult
    }
    const document = info.data?.data ?? info.data
    const version = document?.version
    const pid = document?.pid
    const urls = document?.urls
    if (typeof version !== "string" || version.length === 0 || !Number.isInteger(pid) || !Array.isArray(urls)) {
      identityResult = { ok: false, anchor, reason: "The trusted origin answered but is not an OpenCode V2 server (/api/info identity shape mismatch)." }
      return identityResult
    }
    verified = true
    identityResult = { ok: true, anchor, info: document }
    return identityResult
  }

  async function getSessions(query = {}) {
    const search = new URLSearchParams()
    for (const key of SESSION_QUERY_KEYS) {
      const value = query?.[key]
      if (value === undefined || value === null) continue
      search.set(key, String(value))
    }
    const suffix = search.toString()
    return await raw("GET", `/api/session${suffix ? `?${suffix}` : ""}`, { timeout: SEARCH_TIMEOUT_MS })
  }

  async function getSessionContext(sessionID) {
    return await raw("GET", `/api/session/${encodeURIComponent(sessionID)}/context`, { timeout: SEARCH_TIMEOUT_MS })
  }

  async function getSessionExport(sessionID) {
    return await raw("GET", `/api/experimental/session/${encodeURIComponent(sessionID)}/export`, { timeout: SEARCH_TIMEOUT_MS })
  }

  async function createTerminal(sessionID, options = {}) {
    return await raw("POST", `/api/experimental/session/${encodeURIComponent(sessionID)}/terminal`, {
      body: pickDefined(options, TERMINAL_BODY_KEYS),
    })
  }

  async function listTerminals(sessionID) {
    return await raw("GET", `/api/experimental/session/${encodeURIComponent(sessionID)}/terminal`)
  }

  async function snapshotTerminal(ptyID) {
    return await raw("GET", `/api/experimental/persistent-pty/${encodeURIComponent(ptyID)}/snapshot`)
  }

  async function removeTerminal(ptyID) {
    return await raw("DELETE", `/api/experimental/persistent-pty/${encodeURIComponent(ptyID)}`)
  }

  async function shellOnce(options = {}) {
    return await raw("POST", "/api/shell", { body: pickDefined(options, SHELL_BODY_KEYS) })
  }

  return {
    origin,
    originSource: resolution.source,
    anchor,
    get trusted() {
      return trusted
    },
    get verified() {
      return verified
    },
    get available() {
      return canProbe && verified
    },
    identityCheck,
    verifyIdentity,
    getSessions,
    getSessionContext,
    getSessionExport,
    createTerminal,
    listTerminals,
    snapshotTerminal,
    removeTerminal,
    shellOnce,
    raw,
  }
}
