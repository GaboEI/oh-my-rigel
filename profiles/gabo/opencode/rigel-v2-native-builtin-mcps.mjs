// Native OpenCode V2 port of OmO's tier-1 builtin MCP surface.
//
// V1 owners:
//   packages/omo-opencode/src/mcp/index.ts             createBuiltinMcps policy
//   packages/omo-opencode/src/mcp/grep-app.ts          grep_app remote definition
//   packages/omo-opencode/src/mcp/lsp.ts               lsp local server resolution
//   packages/omo-opencode/src/mcp/cli-suffix.ts        hasCliSuffix
//   packages/omo-opencode/src/mcp/runtime-executable.ts resolveRuntimeExecutable
//   packages/omo-opencode/src/mcp/shared/ancestor-cli-resolver.ts
//   packages/utils/src/runtime/which.ts                bunWhich
//
// The official V2 migration guide states that V2 "accepts and preserves `lsp`
// configuration, but it does not run language servers, expose LSP tools, or
// produce LSP diagnostics". The V2 host therefore has NO LSP tools, and the V1
// `lsp` builtin MCP must be registered natively through `context.mcp.transform`
// exactly as V1 registered it through the plugin config. `grep_app` is likewise
// absent from the host and is registered as the same remote server. `context7`
// is registered as the official remote server under an exclusive policy: the
// profile's live `disabled_mcps` (seeded from the user's OpenCode config) and a
// host name collision both suppress the builtin, so exactly one Context7 is ever
// live. `websearch` is host-provided in V2 (`context.websearch`).
//
// The deployed runtime cannot import TypeScript from `packages/`, so every
// helper above is ported rather than imported. The LSP CLI is resolved from the
// deployment's OWN directory first (a valid install stages the built `packages/lsp-*`
// under it), then from the repo root materialized into the agent manifest; a root
// without a usable CLI degrades to a disabled server instead of an unresolvable
// bootstrap.

import { accessSync, constants, existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const GREP_APP_MCP_NAME = "grep_app"
export const LSP_MCP_NAME = "lsp"
export const SSH_MCP_NAME = "ssh"
export const OBSIDIAN_MCP_NAME = "obsidian"
// The bundled SSH command, VERSION-PINNED for supply-chain reproducibility. The
// pinned version, license, and npm integrity are recorded in the profile
// integration-manifest (mcpPolicy.bundledSupplyChain.ssh) and asserted by
// validate-profile, so a drift is caught. Offline limit: `npx` still resolves the
// pinned tarball FROM the npm registry and caches it, so the FIRST use needs
// network; this is pinned-reproducible, NOT offline-reproducible, and must not be
// described as reproducible without that caveat. The server is keyless; the
// Obsidian key AND endpoint are read from the live environment / the materialized
// policy and never persisted, so no loopback origin is hardcoded here.
export const SSH_MCP_COMMAND = ["npx", "-y", "@hypnosis/ssh-mcp-server@2.3.3"]

const PACKAGE_REL = "packages/lsp-daemon"
const LSP_TOOLS_PACKAGE_REL = "packages/lsp-tools-mcp"
const DIST_CLI_REL = "dist/cli.js"
const SOURCE_CLI_REL = "src/cli.ts"
const PROJECT_LSP_CONFIGS = [".opencode/lsp.json", ".omo/lsp.json", ".omo/lsp-client.json"]
const OMO_LSP_DAEMON_CLI = "OMO_LSP_DAEMON_CLI"
const OMO_LSP_DAEMON_VERSION = "OMO_LSP_DAEMON_VERSION"

// The deployment's own directory. A valid install stages the built LSP runtime
// under `<runtimeDir>/packages/lsp-*`, so the CLI is resolved from here first and
// the install never depends on the transient source root that produced it.
function defaultSelfRoot() {
  return dirname(fileURLToPath(import.meta.url))
}

export function normalizeCliPath(candidatePath) {
  return String(candidatePath).replaceAll("\\", "/")
}

export function hasCliSuffix(candidatePath, suffix) {
  return normalizeCliPath(candidatePath).endsWith(normalizeCliPath(suffix))
}

function isUnsafeCommandName(commandName) {
  if (typeof commandName !== "string" || commandName.length === 0) return true
  if (commandName.includes("/") || commandName.includes("\\")) return true
  if (commandName === "." || commandName === ".." || commandName.includes("..")) return true
  if (/^[a-zA-Z]:/.test(commandName)) return true
  if (commandName.includes("\0")) return true
  return false
}

function isExecutable(filePath) {
  try {
    accessSync(filePath, process.platform === "win32" ? constants.F_OK : constants.X_OK)
    return true
  } catch (error) {
    if (!(error instanceof Error) && Object.prototype.toString.call(error) !== "[object Error]") throw error
    return false
  }
}

function getWindowsCandidates(commandName) {
  if (process.platform !== "win32") return [commandName]
  if (/\.[^\\/]+$/.test(commandName)) return [commandName]
  return [commandName, `${commandName}.exe`, `${commandName}.cmd`, `${commandName}.bat`, `${commandName}.com`]
}

// Port of `bunWhich`: prefer the host runtime's resolver, then a PATH scan.
export function whichExecutable(commandName, env = process.env) {
  if (isUnsafeCommandName(commandName)) return null
  const runtime = globalThis
  const candidateNames = getWindowsCandidates(commandName)
  for (const candidateName of candidateNames) {
    const resolvedPath = runtime.Bun?.which?.(candidateName) ?? null
    if (resolvedPath !== null) return resolvedPath
  }
  const pathValue = process.platform === "win32" ? env.Path ?? env.PATH : env.PATH
  if (!pathValue) return null
  const pathEntries = pathValue.split(delimiter).filter((entry) => entry.length > 0)
  for (const pathEntry of pathEntries) {
    for (const candidateName of candidateNames) {
      const candidatePath = join(pathEntry, candidateName)
      if (isExecutable(candidatePath)) return candidatePath
    }
  }
  return null
}

// Port of `resolveRuntimeExecutable`. `node` resolves to the running Node
// executable when the process itself is Node; otherwise the PATH is searched.
export function resolveRuntimeExecutable(commandName, options = {}) {
  if (isUnsafeCommandName(commandName)) return { command: commandName, available: false }
  const execPath = options.execPath ?? process.execPath
  const execBase = String(execPath).replaceAll("\\", "/").split("/").pop()?.toLowerCase()
  if (commandName === "node" && (execBase === "node" || execBase === "node.exe")) {
    return { command: execPath, available: true }
  }
  const resolved = (options.which ?? whichExecutable)(commandName)
  if (resolved) return { command: resolved, available: true }
  return { command: commandName, available: false }
}

export function resolveJavaScriptRuntime(resolveExecutable) {
  const node = resolveExecutable("node")
  return node.available ? node : resolveExecutable("bun")
}

// Port of `createAncestorCliCandidates`: walk from `startDirectory` upward,
// emitting a dist candidate and a source candidate per directory.
export function createAncestorCliCandidates(options) {
  const candidates = []
  const seenPaths = new Set()
  let currentDirectory = resolve(options.startDirectory)
  for (;;) {
    const distCliPath = resolve(currentDirectory, options.packageRel, options.distCliRel)
    if (!seenPaths.has(distCliPath)) {
      const runtime = resolveJavaScriptRuntime(options.resolveExecutable)
      seenPaths.add(distCliPath)
      candidates.push({
        command: [runtime.command, distCliPath, "mcp"],
        root: currentDirectory,
        path: distCliPath,
        exists: runtime.available && options.pathExists(distCliPath),
        runtimeAvailable: runtime.available,
      })
    }
    const sourceCliPath = resolve(currentDirectory, options.packageRel, options.sourceCliRel)
    if (!seenPaths.has(sourceCliPath)) {
      const runtime = options.resolveExecutable("bun")
      const sourceAvailable = options.isSourceCandidateAvailable?.({ root: currentDirectory, sourcePath: sourceCliPath, pathExists: options.pathExists }) ?? true
      seenPaths.add(sourceCliPath)
      candidates.push({
        command: [runtime.command, sourceCliPath, "mcp"],
        root: currentDirectory,
        path: sourceCliPath,
        exists: runtime.available && options.pathExists(sourceCliPath) && sourceAvailable,
        runtimeAvailable: runtime.available,
      })
    }
    const parentDirectory = resolve(currentDirectory, "..")
    if (parentDirectory === currentDirectory) return candidates
    currentDirectory = parentDirectory
  }
}

function readDaemonPackageVersion(root, readFile = (file) => readFileSync(file, "utf-8")) {
  try {
    const packageJson = JSON.parse(readFile(resolve(root, PACKAGE_REL, "package.json")))
    return typeof packageJson?.version === "string" && packageJson.version.length > 0 ? packageJson.version : null
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return null
  }
}

function createDisabledCandidate() {
  return { command: [], root: "", path: "", exists: false, runtimeAvailable: false }
}

function collectCandidates(roots, options, pathExists, resolveExecutable) {
  const candidates = []
  const seen = new Set()
  for (const root of roots) {
    for (const candidate of createAncestorCliCandidates({
      startDirectory: root,
      packageRel: PACKAGE_REL,
      distCliRel: DIST_CLI_REL,
      sourceCliRel: SOURCE_CLI_REL,
      pathExists,
      resolveExecutable,
      isSourceCandidateAvailable: ({ root: candidateRoot }) =>
        pathExists(resolve(candidateRoot, LSP_TOOLS_PACKAGE_REL, DIST_CLI_REL)) &&
        readDaemonPackageVersion(candidateRoot, options.readFile) !== null,
    })) {
      if (seen.has(candidate.path)) continue
      seen.add(candidate.path)
      candidates.push(candidate)
    }
  }
  return candidates
}

// Resolve the LSP CLI from a SELF-CONTAINED source first (the deployment's own
// directory, which the install owns and which persists) and only then from the
// materialized repo root (dev/lab checkouts). A root without a usable CLI yields
// a DISABLED server: the runtime never emits the old npm bootstrap, which the
// repo's `workspace:*` dependencies make unresolvable, and never depends on a
// transient source root surviving.
export function resolveLspCommand(options = {}) {
  const pathExists = options.exists ?? existsSync
  const resolveExecutable = options.resolveExecutable ?? ((name) => resolveRuntimeExecutable(name))
  const roots = [options.selfRoot ?? defaultSelfRoot(), options.repoRoot].filter(
    (root) => typeof root === "string" && root.length > 0,
  )
  if (roots.length === 0) roots.push(process.cwd())
  const candidates = collectCandidates(roots, options, pathExists, resolveExecutable)
  const distCandidate = candidates.find((candidate) => hasCliSuffix(candidate.path, DIST_CLI_REL) && candidate.exists)
  if (distCandidate) return distCandidate
  const sourceCandidate = candidates.find((candidate) => hasCliSuffix(candidate.path, SOURCE_CLI_REL) && candidate.exists)
  if (sourceCandidate) return sourceCandidate
  return createDisabledCandidate()
}

// Port of `getOpenCodeConfigDir({ binary: "opencode" })`: the CLI branch only.
// In the isolated lab this resolves to the lab's OPENCODE_CONFIG_DIR or
// XDG_CONFIG_HOME/opencode, never V1's `~/.config/opencode`.
export function resolveOpenCodeConfigDir(env = process.env) {
  const custom = env.OPENCODE_CONFIG_DIR?.trim()
  if (custom) return resolve(custom)
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config")
  return resolve(join(xdg, "opencode"))
}

// Port of `createLspMcpConfig`, translated to the V2 `local` shape. V1's
// `enabled` becomes V2's inverse `disabled`.
export function createLspMcpConfig(options = {}) {
  const resolvedCommand = resolveLspCommand(options)
  const cwd = resolve(options.cwd ?? process.cwd())
  const configDir = options.configDir ?? resolveOpenCodeConfigDir(options.env ?? process.env)
  const sourceVersion = hasCliSuffix(resolvedCommand.path, SOURCE_CLI_REL) ? readDaemonPackageVersion(resolvedCommand.root, options.readFile) : null
  return {
    type: "local",
    command: resolvedCommand.command,
    disabled: !resolvedCommand.exists,
    cwd,
    environment: {
      LSP_TOOLS_MCP_CWD: cwd,
      LSP_TOOLS_MCP_PROJECT_CONFIG: PROJECT_LSP_CONFIGS.map((configPath) => resolve(cwd, configPath)).join(delimiter),
      LSP_TOOLS_MCP_USER_CONFIG: resolve(configDir, "lsp.json"),
      LSP_TOOLS_MCP_INSTALL_DECISIONS: resolve(configDir, "lsp-install-decisions.json"),
      ...(sourceVersion ? { [OMO_LSP_DAEMON_CLI]: resolvedCommand.path, [OMO_LSP_DAEMON_VERSION]: sourceVersion } : {}),
    },
  }
}

export const GREP_APP_MCP = { type: "remote", url: "https://mcp.grep.app", disabled: false, oauth: false }

export const CONTEXT7_MCP_NAME = "context7"

// Port of `normalizeContext7ApiKey` from `packages/omo-opencode/src/mcp/context7.ts`.
// The key is optional: an absent, empty, or placeholder value is treated as no
// key at all, so the builtin works anonymously without emitting a fake header.
export function normalizeContext7ApiKey(value) {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (trimmed === "") return null
  const normalized = trimmed.toLowerCase().replace(/[<>"'`]/g, "").replace(/[\s_-]+/g, " ")
  if (normalized.length === 0 || normalized === "your api key") return null
  return trimmed
}

// Port of `createContext7Config`: the official tier-1 Context7 remote server.
// The optional API key is read from the LIVE environment and passed as a bearer
// header; it is never logged, returned, or persisted, so the inventory can name
// the server without exposing the credential.
export function createContext7McpConfig(env = process.env) {
  const apiKey = normalizeContext7ApiKey(env?.CONTEXT7_API_KEY)
  return {
    type: "remote",
    url: "https://mcp.context7.com/mcp",
    disabled: false,
    oauth: false,
    ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
  }
}

// The Obsidian key is optional in the same sense as the Context7 key: absent,
// empty, or placeholder values are treated as "not configured", so no server is
// emitted and no fake header is produced.
export function normalizeObsidianApiKey(value) {
  return normalizeContext7ApiKey(value)
}

function obsidianKeyName(options = {}) {
  const envKeys = options.externalEnvKeys && typeof options.externalEnvKeys === "object" ? options.externalEnvKeys : {}
  const name = envKeys[OBSIDIAN_MCP_NAME]
  return typeof name === "string" && name ? name : "OBSIDIAN_API_KEY"
}

// The bundled protective SSH MCP: a real local stdio server, keyless. It reads
// the operator's own OpenSSH configuration; `SSH_PROFILES_FILE` is an optional
// external profiles path (a path, never a secret) passed through only when set.
export function createSshMcpConfig(options = {}) {
  const env = options.env ?? process.env
  const profilesFile = typeof env?.SSH_PROFILES_FILE === "string" && env.SSH_PROFILES_FILE.trim() !== ""
    ? env.SSH_PROFILES_FILE.trim()
    : null
  return {
    type: "local",
    command: [...SSH_MCP_COMMAND],
    disabled: false,
    ...(profilesFile ? { environment: { SSH_PROFILES_FILE: profilesFile } } : {}),
  }
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim()
  }
  return null
}

// Loopback hosts the Obsidian Local REST API may bind to. A bare hostname here is
// NOT an origin URL, so the profile origin rule (which rejects hardcoded loopback
// base URLs) does not apply to this allowlist.
const OBSIDIAN_LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

// Fail-closed endpoint validation: the Bearer key is only ever sent to an allowed
// LOCAL endpoint. Rejects any non-loopback origin, any embedded userinfo, and any
// query or fragment, so a misconfigured or hostile OBSIDIAN_API_URL can never
// exfiltrate the key to a remote host.
export function isAllowedObsidianEndpoint(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") return false
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
  if (parsed.username || parsed.password) return false
  if (parsed.search || parsed.hash) return false
  return OBSIDIAN_LOOPBACK_HOSTS.has(parsed.hostname)
}

function resolveObsidianUrl(options = {}) {
  const env = options.env ?? process.env
  return firstNonEmptyString(env?.OBSIDIAN_API_URL, options.obsidianUrl)
}

// The Obsidian MCP: a real remote (Streamable HTTP) server at the Local REST API
// endpoint. Returns a config ONLY when the key is configured AND the endpoint
// passes the fail-closed loopback check; otherwise returns null so the caller
// emits no server and never sends the key. The key lives only in the Authorization
// header, is read from the live environment, and is never persisted or logged.
export function createObsidianMcpConfig(options = {}) {
  const env = options.env ?? process.env
  const apiKey = normalizeObsidianApiKey(env?.[obsidianKeyName(options)])
  if (!apiKey) return null
  const url = resolveObsidianUrl(options)
  if (!url || !isAllowedObsidianEndpoint(url)) return null
  return {
    type: "remote",
    url,
    disabled: false,
    oauth: false,
    headers: { Authorization: `Bearer ${apiKey}` },
  }
}

// Secret-free, actionable fix for an expected external connection that is not
// live. Never contains the key value: it interpolates the descriptor name and the
// (possibly default) endpoint only, so the operator gets an exact command to run.
function obsidianGuidanceFix(options = {}, apiKeyPresent, endpoint) {
  const keyName = obsidianKeyName(options)
  const urlToken = endpoint ?? "<obsidian-local-rest-api-endpoint>"
  if (!apiKeyPresent) {
    return `export ${keyName}=<obsidian-local-rest-api-key> && export OBSIDIAN_API_URL=${urlToken} then restart (Obsidian Local REST API plugin MCP >= 4.0.0, loopback endpoint only; for the HTTPS endpoint trust the plugin CA, or enable the non-encrypted HTTP server and point OBSIDIAN_API_URL at its http loopback endpoint)`
  }
  return `OBSIDIAN_API_URL must be a loopback http(s) endpoint with no credentials, query, or fragment; set OBSIDIAN_API_URL=${urlToken} (or unset it to use the default) then restart`
}

// Typed guidance for an external connection that is expected but not yet
// configured. Names, reasons, and a secret-free, actionable fix only, never a
// thrown error: the caller logs it and the server is simply absent.
export function collectBuiltinMcpGuidance(options = {}) {
  const disabled = new Set(Array.isArray(options.disabledMcps) ? options.disabledMcps : [])
  const externalConnections = Array.isArray(options.externalConnections) ? options.externalConnections : []
  const env = options.env ?? process.env
  const guidance = []
  if (externalConnections.includes(OBSIDIAN_MCP_NAME) && !disabled.has(OBSIDIAN_MCP_NAME) && !createObsidianMcpConfig(options)) {
    const apiKey = normalizeObsidianApiKey(env?.[obsidianKeyName(options)])
    const url = resolveObsidianUrl(options)
    if (!apiKey) {
      guidance.push({ name: OBSIDIAN_MCP_NAME, reason: "missing-env", fix: obsidianGuidanceFix(options, false, url) })
    } else {
      guidance.push({ name: OBSIDIAN_MCP_NAME, reason: "untrusted-endpoint", fix: obsidianGuidanceFix(options, true, url) })
    }
  }
  return guidance
}

// Port of the `createBuiltinMcps` policy for the OmO builtins the profile
// retains (`mcpPolicy.omoBuiltinsRetained`). `websearch` is host-provided in V2.
// Context7 ownership is the RUNTIME's: the installer NEVER seeds `context7` into
// `disabled_mcps`, so the builtin is emitted unless the profile explicitly
// disables it (an existing user `disabled_mcps` choice) or the host already
// exposes a `context7` server (name collision preserved), keeping exactly one
// Context7 live across restarts.
export function createBuiltinMcpConfigs(options = {}) {
  const disabled = new Set(Array.isArray(options.disabledMcps) ? options.disabledMcps : [])
  const retained = Array.isArray(options.retained) ? options.retained : [GREP_APP_MCP_NAME, LSP_MCP_NAME, CONTEXT7_MCP_NAME]
  const configs = {}
  if (retained.includes(GREP_APP_MCP_NAME) && !disabled.has(GREP_APP_MCP_NAME)) {
    configs[GREP_APP_MCP_NAME] = { ...GREP_APP_MCP }
  }
  if (retained.includes(LSP_MCP_NAME) && !disabled.has(LSP_MCP_NAME)) {
    configs[LSP_MCP_NAME] = createLspMcpConfig(options)
  }
  if (retained.includes(CONTEXT7_MCP_NAME) && !disabled.has(CONTEXT7_MCP_NAME)) {
    configs[CONTEXT7_MCP_NAME] = createContext7McpConfig(options.env ?? process.env)
  }
  // The bundled SSH server and the external Obsidian connection are gated on
  // their own policy arrays (materialized from `bundledLocal` and
  // `coreExternalConnections`), so the three retained builtins above are left
  // byte-identical. Obsidian is emitted only when its key is configured.
  const bundledLocal = Array.isArray(options.bundledLocal) ? options.bundledLocal : []
  const externalConnections = Array.isArray(options.externalConnections) ? options.externalConnections : []
  if (bundledLocal.includes(SSH_MCP_NAME) && !disabled.has(SSH_MCP_NAME)) {
    configs[SSH_MCP_NAME] = createSshMcpConfig(options)
  }
  if (externalConnections.includes(OBSIDIAN_MCP_NAME) && !disabled.has(OBSIDIAN_MCP_NAME)) {
    const obsidian = createObsidianMcpConfig(options)
    if (obsidian) configs[OBSIDIAN_MCP_NAME] = obsidian
  }
  return configs
}

// Register the retained builtin MCP servers through V2's native mcp surface.
// Existing host/config servers win on a name collision, matching V1 precedence.
export async function registerNativeBuiltinMcps(context, options = {}) {
  const registered = []
  const mcpDomain = context?.mcp
  const guided = collectBuiltinMcpGuidance(options)
  if (!mcpDomain || typeof mcpDomain.transform !== "function") return { registered, planned: [], guided, dispose: undefined }
  const configs = createBuiltinMcpConfigs(options)
  // `planned` is the policy decision (synchronously computed, and the reliable
  // value in the runtime log). `registered` is the set this call establishes
  // synchronously; it may be empty because the host applies the mcp transform
  // asynchronously, so the authoritative LIVE check is the host inventory
  // (/api/mcp). `guided` lists expected external connections not yet configured.
  // All three are names only, never credentials.
  const planned = Object.keys(configs)
  const registration = await mcpDomain.transform((collection) => {
    for (const [name, config] of Object.entries(configs)) {
      if (typeof collection?.get === "function" && collection.get(name)) continue
      if (typeof collection?.set !== "function") continue
      collection.set(name, config)
      registered.push(name)
    }
  })
  return { registered, planned, guided, dispose: registration?.dispose }
}
