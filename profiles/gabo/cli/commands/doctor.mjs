// Rigel V2 CLI `doctor`.
//
// Real 4-category diagnostics (SYSTEM / CONFIG / TOOLS / MODELS) ported from the
// V1 doctor's observable output shapes, but owned entirely by this fork. Every
// check is pure over the injected `io`: it reads only the isolated V2 lab config
// and cache through io.env / io.home, never a V1 path, and never launches
// OpenCode. Nothing here imports `packages/omo-opencode/src` (V1).
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { compareNativeVersions, deriveNativeMinOpenCodeVersion } from "../../opencode/rigel-v2-native-config.mjs"
import { parseJsonc } from "../../notification-activation-config.mjs"
import { parseArgs, writeJson } from "../rigel-v2-cli-io.mjs"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")
const TARGET = "opencode"

function repoRoot(io) {
  return io.env.RIGEL_V2_REPO_ROOT ?? REPO_ROOT
}

function labRoot(io) {
  return io.env.RIGEL_V2_LAB_ROOT ?? path.join(io.home, ".local", "share", "opencode-v2-lab")
}

function configFile(io) {
  return io.env.RIGEL_V2_CONFIG ?? path.join(labRoot(io), "config", "opencode", "opencode.json")
}

function binaryPath(io) {
  return io.env.RIGEL_OPENCODE_V2_BIN ?? path.join(io.home, ".opencode", "bin", "opencode")
}

function cacheFile(io) {
  return path.join(io.env.XDG_CACHE_HOME ?? path.join(io.home, ".cache"), "opencode", "models.json")
}

function readText(file) {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

function readJsonVersion(file) {
  try {
    const document = JSON.parse(readText(file) ?? "")
    return typeof document.version === "string" ? document.version : undefined
  } catch {
    return undefined
  }
}

function loadConfig(io) {
  const file = configFile(io)
  if (!existsSync(file)) return { path: file, exists: false, document: null, error: null }
  try {
    return { path: file, exists: true, document: parseJsonc(readText(file) ?? ""), error: null }
  } catch (error) {
    return { path: file, exists: true, document: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function entrySource(entry) {
  if (typeof entry === "string") return entry
  if (entry && typeof entry === "object") {
    for (const key of ["package", "path", "entry", "name"]) {
      if (typeof entry[key] === "string") return entry[key]
    }
  }
  return ""
}

function isRuntimeEntry(entry) {
  return entrySource(entry).includes("rigel-v2-native")
}

function loadedRuntimeVersion(entry) {
  const source = entrySource(entry).replace(/^file:\/\//, "")
  if (!source) return undefined
  const dir = /\.(mjs|js|cjs)$/.test(source) ? path.dirname(source) : source
  return readJsonVersion(path.join(dir, "package.json"))
}

function minimumVersion(io) {
  try {
    const manifest = JSON.parse(readText(path.join(repoRoot(io), "profiles", "gabo", "integration-manifest.json")) ?? "")
    return deriveNativeMinOpenCodeVersion(manifest)
  } catch {
    return undefined
  }
}

function statusOf(issues) {
  if (issues.some((issue) => issue.severity === "error")) return "fail"
  if (issues.some((issue) => issue.severity === "warning")) return "warn"
  return "pass"
}

function agentOverrides(document) {
  const overrides = []
  for (const key of ["agent", "agents"]) {
    const agents = document?.[key]
    if (!agents || typeof agents !== "object" || Array.isArray(agents)) continue
    for (const [name, value] of Object.entries(agents)) {
      if (value && typeof value === "object" && typeof value.model === "string") overrides.push({ name, model: value.model })
    }
  }
  return overrides
}

function providerModels(document) {
  const providers = document?.provider
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return []
  const ids = []
  for (const provider of Object.values(providers)) {
    if (!provider || typeof provider !== "object") continue
    if (typeof provider.model === "string") ids.push(provider.model)
    if (provider.models && typeof provider.models === "object") ids.push(...Object.keys(provider.models))
  }
  return ids
}

async function checkSystem(io, directory) {
  const details = []
  const issues = []
  const bin = binaryPath(io)
  details.push(`binary: ${bin}`)
  let hostVersion
  try {
    const result = io.spawn(bin, ["--version"], { cwd: directory, encoding: "utf8" })
    const status = typeof result?.status === "number" ? result.status : 1
    const output = `${result?.stdout ?? ""}${result?.stderr ?? ""}`.trim()
    if (result?.error || status !== 0) throw new Error(output || `exit ${status}`)
    hostVersion = output.match(/(\d+\.\d+(?:\.\d+)*)/)?.[1]
  } catch (error) {
    issues.push({
      title: "OpenCode V2 binary not found",
      description: `Could not run ${bin} --version: ${error instanceof Error ? error.message : String(error)}`,
      fix: "Install OpenCode V2 or set RIGEL_OPENCODE_V2_BIN",
      severity: "error",
    })
  }
  const minimum = minimumVersion(io)
  if (hostVersion) details.push(`version: ${hostVersion}`)
  if (minimum) details.push(`required: >= ${minimum}`)
  if (hostVersion && minimum && compareNativeVersions(hostVersion, minimum) < 0) {
    issues.push({ title: "OpenCode version below minimum", description: `Detected ${hostVersion}; required >= ${minimum}.`, fix: "Update OpenCode V2", severity: "warning" })
  }
  const config = loadConfig(io)
  const plugins = Array.isArray(config.document?.plugin) ? config.document.plugin : []
  const entry = plugins.find(isRuntimeEntry)
  if (!entry) {
    issues.push({
      title: "Rigel runtime plugin is not registered",
      description: `The lab config ${config.path} does not register the Rigel V2 runtime.`,
      fix: "Run: rigel-v2 install --platform opencode",
      severity: "error",
    })
  } else {
    const loaded = loadedRuntimeVersion(entry)
    const expected = readJsonVersion(path.join(repoRoot(io), "package.json"))
    if (loaded) details.push(`loaded version: ${loaded}`)
    if (expected) details.push(`repo version: ${expected}`)
    if (loaded && expected && loaded !== expected) {
      issues.push({ title: "Loaded runtime version mismatch", description: `Registered runtime is ${loaded}; repo package.json is ${expected}.`, fix: "Run: rigel-v2 install --platform opencode", severity: "warning" })
    }
  }
  const status = statusOf(issues)
  return { name: "SYSTEM", status, message: status === "pass" ? "System checks passed" : `${issues.length} system issue(s) detected`, details, issues }
}

async function checkConfig(io) {
  const config = loadConfig(io)
  if (!config.exists) {
    return {
      name: "CONFIG",
      status: "warn",
      message: `No lab config found at ${config.path}`,
      details: [`source: ${config.path}`],
      issues: [{ title: "Configuration missing", description: "The active Rigel V2 lab config does not exist.", fix: "Run: rigel-v2 install --platform opencode", severity: "warning" }],
    }
  }
  if (config.error) {
    return {
      name: "CONFIG",
      status: "fail",
      message: "Configuration invalid",
      details: [`source: ${config.path}`],
      issues: [{ title: "Configuration parse error", description: config.error, fix: "Fix the JSONC syntax in the lab config", severity: "error" }],
    }
  }
  const document = config.document ?? {}
  const sources = Array.isArray(document.plugin) ? document.plugin.length : 0
  const overrides = agentOverrides(document)
  return {
    name: "CONFIG",
    status: "pass",
    message: `Configuration valid (${sources} source(s), ${overrides.length} override(s))`,
    details: [`source: ${config.path}`, `plugin sources: ${sources}`, `agent overrides: ${overrides.length}`, `model overrides: ${overrides.length}`],
    issues: [],
  }
}

function probeBinary(io, bin, directory) {
  try {
    const result = io.spawn(bin, ["--version"], { cwd: directory, encoding: "utf8" })
    return !result?.error && typeof result?.status === "number" && result.status === 0
  } catch {
    return false
  }
}

async function checkTools(io, directory) {
  const details = []
  const issues = []
  for (const [bin, label] of [["sg", "AST-Grep"], ["comment-checker", "comment-checker"], ["gh", "GitHub CLI"]]) {
    const present = probeBinary(io, bin, directory)
    details.push(`${label}: ${present ? "present" : "missing"}`)
    if (!present) issues.push({ title: `${label} not found`, description: `${bin} is not available on PATH.`, severity: "warning" })
  }
  const config = loadConfig(io)
  const mcp = config.document?.mcp && typeof config.document.mcp === "object" && !Array.isArray(config.document.mcp) ? Object.keys(config.document.mcp) : []
  details.push(`MCP servers: ${mcp.length > 0 ? mcp.join(", ") : "none"}`)
  const status = statusOf(issues) === "fail" ? "warn" : statusOf(issues)
  return { name: "TOOLS", status, message: status === "pass" ? "All tools checks passed" : `${issues.length} tool warning(s)`, details, issues }
}

async function checkModels(io) {
  const details = []
  const issues = []
  const config = loadConfig(io)
  const document = config.document ?? {}
  const overrides = agentOverrides(document)
  for (const override of overrides.filter((entry) => !entry.model.includes("/"))) {
    issues.push({ title: `Invalid model override: ${override.name}`, description: `Override '${override.model}' must be in provider/model format.`, severity: "warning" })
  }
  const models = providerModels(document)
  const providers = document.provider && typeof document.provider === "object" && !Array.isArray(document.provider) ? Object.keys(document.provider).length : 0
  let cached = 0
  const file = cacheFile(io)
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readText(file) ?? "")
      cached = Array.isArray(parsed) ? parsed.length : parsed && typeof parsed === "object" ? Object.keys(parsed).length : 0
      details.push(`models cache: ${file} (${cached} models)`)
    } catch {
      details.push(`models cache: unreadable (${file})`)
    }
  } else {
    details.push(`models cache: missing (${file})`)
    issues.push({ title: "Model cache not found", description: "The lab model cache is missing, so model availability cannot be validated.", fix: "Run: rigel-v2 refresh-model-capabilities", severity: "warning" })
  }
  details.push(`config providers: ${providers}`, `config models: ${models.length}`, `agent model overrides: ${overrides.length}`)
  return { name: "MODELS", status: statusOf(issues), message: `${models.length + cached} models, ${overrides.length} override(s)`, details, issues }
}

async function runChecks(io, directory) {
  const started = Date.now()
  const results = await Promise.all([
    checkSystem(io, directory),
    checkConfig(io),
    checkTools(io, directory),
    checkModels(io),
  ])
  const duration = Date.now() - started
  const summary = {
    total: results.length,
    passed: results.filter((result) => result.status === "pass").length,
    failed: results.filter((result) => result.status === "fail").length,
    warnings: results.filter((result) => result.status === "warn").length,
    skipped: results.filter((result) => result.status === "skip").length,
    duration,
  }
  const exitCode = results.some((result) => result.status === "fail") ? 1 : 0
  return { results, summary, exitCode }
}

function writeStatus(io, results) {
  for (const result of results) io.stdout.write(`${result.name.padEnd(7)} ${result.status.padEnd(4)} ${result.message}\n`)
}

function writeVerbose(io, results) {
  for (const result of results) {
    io.stdout.write(`${result.name}: ${result.status} - ${result.message}\n`)
    for (const detail of result.details ?? []) io.stdout.write(`  - ${detail}\n`)
    for (const issue of result.issues ?? []) io.stdout.write(`  ! [${issue.severity}] ${issue.title}: ${issue.description}${issue.fix ? ` (fix: ${issue.fix})` : ""}\n`)
  }
}

function writeDefault(io, results, exitCode) {
  io.stdout.write("Rigel V2 doctor\n")
  for (const result of results) io.stdout.write(`${result.name}: ${result.status} - ${result.message}\n`)
  const issues = results.flatMap((result) => (result.issues ?? []).map((issue) => ({ category: result.name, ...issue })))
  if (issues.length > 0) {
    io.stdout.write("\nIssues:\n")
    for (const issue of issues) {
      io.stdout.write(`- [${issue.severity}] ${issue.category}/${issue.title}: ${issue.description}\n`)
      if (issue.fix) io.stdout.write(`  fix: ${issue.fix}\n`)
    }
  }
  if (exitCode === 0) io.stdout.write("Rigel V2 doctor: OK\n")
}

export const doctorCommand = {
  name: "doctor",
  summary: "Run 4-category Rigel V2 health diagnostics",
  usage: "rigel-v2 doctor [--json] [--status] [--verbose] [--directory <p>]",
  async run(argv, io) {
    const { options } = parseArgs(argv)
    const directory = options.directory !== undefined ? String(options.directory) : io.cwd
    const report = await runChecks(io, directory)
    if (options.json === true) {
      writeJson(io, { results: report.results, summary: report.summary, exitCode: report.exitCode, target: TARGET })
      return report.exitCode
    }
    if (options.status === true) {
      writeStatus(io, report.results)
      return report.exitCode
    }
    if (options.verbose === true) {
      writeVerbose(io, report.results)
      return report.exitCode
    }
    writeDefault(io, report.results, report.exitCode)
    return report.exitCode
  },
}
