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
// helper above is ported rather than imported. The repo root (needed to locate
// `packages/lsp-daemon` and `packages/lsp-tools-mcp`) is materialized into the
// agent manifest by the generator; the runtime never walks its own deployed
// directory looking for the source tree.

import { accessSync, constants, existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join, resolve } from "node:path"

export const GREP_APP_MCP_NAME = "grep_app"
export const LSP_MCP_NAME = "lsp"

const PACKAGE_REL = "packages/lsp-daemon"
const LSP_TOOLS_PACKAGE_REL = "packages/lsp-tools-mcp"
const DIST_CLI_REL = "dist/cli.js"
const SOURCE_CLI_REL = "src/cli.ts"
const PROJECT_LSP_CONFIGS = [".opencode/lsp.json", ".omo/lsp.json", ".omo/lsp-client.json"]
const DAEMON_PACKAGE_NAME = "@code-yeongyu/lsp-daemon"
const OMO_LSP_DAEMON_CLI = "OMO_LSP_DAEMON_CLI"
const OMO_LSP_DAEMON_VERSION = "OMO_LSP_DAEMON_VERSION"

// Verbatim from `packages/omo-opencode/src/mcp/lsp.ts` (LSP_BOOTSTRAP_SCRIPT).
const LSP_BOOTSTRAP_SCRIPT = [
  "const { existsSync } = require('node:fs')",
  "const { createRequire } = require('node:module')",
  "const { join } = require('node:path')",
  "const { spawnSync } = require('node:child_process')",
  "const root = process.argv[1]",
  "const npm = process.argv[2] || 'npm'",
  "const bun = process.argv[3] || 'bun'",
  `const toolsPackage = join(root, '${LSP_TOOLS_PACKAGE_REL}')`,
  `const daemonPackage = join(root, '${PACKAGE_REL}')`,
  "const toolsDist = join(toolsPackage, 'dist/cli.js')",
  "const daemonPackageJson = join(daemonPackage, 'package.json')",
  "const daemonSource = join(daemonPackage, 'src/cli.ts')",
  "const run = (command, args, stdio) => spawnSync(command, args, { cwd: root, env: process.env, stdio })",
  "const finish = (result) => { if (result.error) { console.error(result.error.message); process.exit(1) } process.exit(result.status ?? 1) }",
  "const runIfAvailable = (command, args) => { const result = run(command, args, 'inherit'); if (result.error) return false; finish(result); return true }",
  `const resolveDaemonCli = () => { try { return createRequire(daemonPackageJson).resolve('${DAEMON_PACKAGE_NAME}/cli') } catch (error) { if (error instanceof Error) return null; throw error } }`,
  "const daemonCli = existsSync(daemonPackageJson) ? resolveDaemonCli() : null",
  "if (daemonCli) finish(run(process.execPath, [daemonCli, 'mcp'], 'inherit'))",
  `if (existsSync(daemonSource) && existsSync(toolsDist)) { const pkg = require(daemonPackageJson); process.env.${OMO_LSP_DAEMON_CLI} = daemonSource; process.env.${OMO_LSP_DAEMON_VERSION} = pkg.version; runIfAvailable(bun, [daemonSource, 'mcp']) }`,
  "const steps = [[npm, ['--prefix', toolsPackage, 'install', '--no-package-lock', '--no-audit', '--no-fund']], [npm, ['--prefix', toolsPackage, 'run', 'build']], [npm, ['--prefix', daemonPackage, 'install', '--no-package-lock', '--no-audit', '--no-fund']], [npm, ['--prefix', daemonPackage, 'run', 'build']]]",
  "for (const [command, args] of steps) { const result = run(command, args, ['ignore', 'ignore', 'inherit']); if (result.error || result.status !== 0) finish(result) }",
  "finish(run(process.execPath, [resolveDaemonCli(), 'mcp'], 'inherit'))",
].join(";")

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

function findBootstrapRoot(candidates, pathExists) {
  return candidates.find((candidate) => pathExists(resolve(candidate.root, "package.json")))?.root ?? process.cwd()
}

function createBootstrapCandidate(root, pathExists, resolveExecutable) {
  const runtime = resolveJavaScriptRuntime(resolveExecutable)
  const bun = resolveExecutable("bun")
  const npm = resolveExecutable("npm")
  return {
    command: [runtime.command, "-e", LSP_BOOTSTRAP_SCRIPT, root, npm.command, bun.command],
    root,
    path: resolve(root, PACKAGE_REL, DIST_CLI_REL),
    exists: runtime.available && npm.available && pathExists(resolve(root, PACKAGE_REL, "package.json")),
    runtimeAvailable: runtime.available,
  }
}

// Port of `resolveLspCommand`, but anchored at the materialized repo root rather
// than `import.meta.url` (the deployed runtime does not live beside the source).
export function resolveLspCommand(options = {}) {
  const pathExists = options.exists ?? existsSync
  const resolveExecutable = options.resolveExecutable ?? ((name) => resolveRuntimeExecutable(name))
  const startDirectory = options.repoRoot ?? process.cwd()
  const candidates = createAncestorCliCandidates({
    startDirectory,
    packageRel: PACKAGE_REL,
    distCliRel: DIST_CLI_REL,
    sourceCliRel: SOURCE_CLI_REL,
    pathExists,
    resolveExecutable,
    isSourceCandidateAvailable: ({ root }) =>
      pathExists(resolve(root, LSP_TOOLS_PACKAGE_REL, DIST_CLI_REL)) && readDaemonPackageVersion(root, options.readFile) !== null,
  })
  const distCandidate = candidates.find((candidate) => hasCliSuffix(candidate.path, DIST_CLI_REL) && candidate.exists)
  if (distCandidate) return distCandidate
  const sourceCandidate = candidates.find((candidate) => hasCliSuffix(candidate.path, SOURCE_CLI_REL) && candidate.exists)
  if (sourceCandidate) return sourceCandidate
  return createBootstrapCandidate(findBootstrapRoot(candidates, pathExists), pathExists, resolveExecutable)
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
  return configs
}

// Register the retained builtin MCP servers through V2's native mcp surface.
// Existing host/config servers win on a name collision, matching V1 precedence.
export async function registerNativeBuiltinMcps(context, options = {}) {
  const registered = []
  const mcpDomain = context?.mcp
  if (!mcpDomain || typeof mcpDomain.transform !== "function") return { registered, planned: [], dispose: undefined }
  const configs = createBuiltinMcpConfigs(options)
  // `planned` is the policy decision (synchronously computed, and the reliable
  // value in the runtime log). `registered` is the set this call establishes
  // synchronously; it may be empty because the host applies the mcp transform
  // asynchronously, so the authoritative LIVE check is the host inventory
  // (/api/mcp). Both are names only, never credentials.
  const planned = Object.keys(configs)
  const registration = await mcpDomain.transform((collection) => {
    for (const [name, config] of Object.entries(configs)) {
      if (typeof collection?.get === "function" && collection.get(name)) continue
      if (typeof collection?.set !== "function") continue
      collection.set(name, config)
      registered.push(name)
    }
  })
  return { registered, planned, dispose: registration?.dispose }
}
