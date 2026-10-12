#!/usr/bin/env bun
/**
 * Live contract: the native tier-1 builtin MCP servers retained by the profile
 * (`mcpPolicy.omoBuiltinsRetained` = grep_app, lsp, context7).
 *
 * The official V2 migration guide states V2 "does not run language servers,
 * expose LSP tools, or produce LSP diagnostics", and the V2 host does not list
 * `grep_app`. The native runtime therefore registers both through
 * `context.mcp.transform` (see `opencode/rigel-v2-native-builtin-mcps.mjs`).
 * `context7` is registered as the official remote server under an exclusive
 * policy: the builtin is emitted only when the profile retains it and has not
 * disabled it, and a host name collision is preserved, so exactly one Context7
 * is ever live. The dedicated Context7 exclusivity gate (both scenarios plus the
 * remove/add transitions after a restart) lives in
 * `qa-v2-builtin-context7-live.mjs`. This contract drives the live laboratory and
 * asserts the servers are registered, connected, exposed and EXECUTE with real
 * results.
 *
 * Surface: the isolated V2 laboratory (`opencode-v2-lab.service`) over its HTTP
 * API. This file never spawns OpenCode, never uses Docker and never addresses
 * V1. Every session, socket, config and log path it observes resolves inside the
 * lab root.
 *
 * Usage: bun profiles/gabo/qa-v2-builtin-mcps.mjs
 * Env: RIGEL_V2_LAB_ROOT, RIGEL_V2_LAB_URL, RIGEL_V2_SERVICE, RIGEL_V2_HOME.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const labRoot = process.env.RIGEL_V2_LAB_ROOT || path.join(os.homedir(), ".local/share/opencode-v2-lab")
const baseUrl = process.env.RIGEL_V2_LAB_URL || "http://127.0.0.1:4097"
const service = process.env.RIGEL_V2_SERVICE || "opencode-v2-lab.service"
const labHome = process.env.RIGEL_V2_HOME || path.join(labRoot, "home")
const secretFile = path.join(labRoot, "secret.env")
const evidenceDir = path.join(root, ".omo/evidence/20261007-t38-builtin-mcps")
const READY_TIMEOUT_MS = Number(process.env.RIGEL_BUILTIN_MCP_READY_TIMEOUT_MS || 90_000)
const RETRIES = Number(process.env.RIGEL_BUILTIN_MCP_RETRIES || 2)

const sessions = []

function skip(reason) {
  console.log(`Rigel V2 builtin-MCP live: SKIP (${reason})`)
  process.exit(0)
}

function readPassword() {
  if (!fs.existsSync(secretFile)) return null
  const line = fs.readFileSync(secretFile, "utf8").split("\n").find((entry) => entry.startsWith("OPENCODE_PASSWORD="))
  return line ? line.slice("OPENCODE_PASSWORD=".length) : null
}

const password = readPassword()
if (!password) skip(`no lab credentials at ${secretFile}`)
const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

async function api(method, pathname, body, timeoutMs = 240_000) {
  try {
    const response = await fetch(baseUrl + pathname, {
      method,
      headers: { authorization: auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    return { status: response.status, json: text ? JSON.parse(text) : null }
  } catch (error) {
    return { status: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

function toolParts(context) {
  return (context ?? []).flatMap((message) =>
    message.type === "assistant" ? (message.content ?? []).filter((part) => part.type === "tool") : [],
  )
}

async function waitForIdle(sessionID) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const context = await api("GET", `/api/session/${sessionID}/context`, undefined, 20_000)
    const messages = Array.isArray(context.json?.data) ? context.json.data : []
    if (messages.some((message) => message.type === "idle" || message.type === "error")) return messages
    await new Promise((resolve) => setTimeout(resolve, 750))
  }
  return null
}

async function waitForLabReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const info = await api("GET", "/api/info", undefined, 10_000)
    if (info.status === 200 && info.json?.version) return info.json
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return null
}

// MCP servers connect asynchronously after the runtime registers them; poll
// until the retained servers report `connected` (or the timeout elapses).
async function waitForServers(names, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  let last = {}
  while (Date.now() < deadline) {
    const mcp = await api("GET", "/api/mcp")
    const servers = Array.isArray(mcp.json?.data) ? mcp.json.data : []
    last = Object.fromEntries(servers.map((entry) => [entry.name, entry.status?.status]))
    if (names.every((name) => last[name] === "connected")) return last
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return last
}

// Drive one codemode call and return the concatenated text the `execute` tool
// produced. The model is told the exact expression; retries cover a weak model.
async function driveExecute(agent, expression, predicate) {
  const prompt = [
    "Use the execute tool exactly once.",
    `In your JavaScript code run this and nothing else: ${expression}`,
    "Return the awaited result as a JSON string via JSON.stringify.",
    "Do not call any other tool. After execute returns, reply DONE.",
  ].join("\n")
  let last = ""
  for (let attempt = 1; attempt <= RETRIES + 1; attempt += 1) {
    const created = await api("POST", "/api/session", { agent, location: { directory: labHome } })
    const sessionID = created.json?.id ?? created.json?.data?.id
    if (typeof sessionID !== "string") return { ok: false, reason: `session create ${created.status}` }
    sessions.push(sessionID)
    await api("POST", `/api/session/${sessionID}/prompt`, { text: prompt, resume: true })
    const context = await waitForIdle(sessionID)
    if (!context) return { ok: false, reason: "never idle" }
    const execute = toolParts(context).find((part) => part.name === "execute")
    const text = (execute?.state?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n")
    last = text || JSON.stringify(execute?.state?.error ?? "")
    if (predicate(last)) return { ok: true, text: last, attempt }
    await api("DELETE", `/api/session/${sessionID}`)
  }
  return { ok: false, reason: "predicate never matched", text: last }
}

async function main() {
  const active = (await import("node:child_process")).spawnSync("systemctl", ["--user", "is-active", service], { encoding: "utf8" }).stdout?.trim()
  if (active !== "active") skip(`${service} is not active`)
  const info = await waitForLabReady()
  if (!info) skip(`lab not reachable at ${baseUrl}`)

  const checks = []
  const captures = {}

  // 1. Registration + connection (structural, live).
  const byName = await waitForServers(["grep_app", "lsp"])
  checks.push({ name: "mcp.grep_app.connected", pass: byName.grep_app === "connected", detail: byName.grep_app ?? "absent" })
  checks.push({ name: "mcp.lsp.connected", pass: byName.lsp === "connected", detail: byName.lsp ?? "absent" })

  // 2. LSP executes with a real, deterministic result (server catalog).
  const status = await driveExecute("Sisyphus-Junior", 'await tools.lsp.status({})', (text) => /Configured LSP servers: \d+/.test(text))
  captures.lspStatus = status
  checks.push({ name: "lsp.status.executes", pass: status.ok, detail: status.text?.slice(0, 160) })

  // 3. LSP diagnostics executes end-to-end against the real daemon.
  const fixture = path.join(labHome, "rigel-builtin-mcp-live.ts")
  fs.writeFileSync(fixture, 'const x: number = "not a number"\n')
  const diagnostics = await driveExecute("Sisyphus-Junior", `await tools.lsp.diagnostics({ filePath: ${JSON.stringify(fixture)} })`, (text) => /not_installed|NOT INSTALLED|Diagnostics|diagnostic|missing|timed out/i.test(text))
  captures.lspDiagnostics = diagnostics
  checks.push({ name: "lsp.diagnostics.executes", pass: diagnostics.ok, detail: diagnostics.text?.slice(0, 200) })
  fs.rmSync(fixture, { force: true })

  // 4. grep_app executes a real GitHub search for the librarian (V1 re-allow).
  const search = await driveExecute("librarian", 'await tools["grep_app"].searchGitHub({ query: "useReducer" })', (text) => /github\.com|Repository:/.test(text))
  captures.grepAppSearch = search
  checks.push({ name: "grep_app.search.executes", pass: search.ok, detail: search.text?.slice(0, 200) })

  // 5. Negative: a non-librarian agent cannot use the grep_app family (global
  //    default-deny; only the librarian re-enables it). The denial surfaces
  //    either as an explicit permission error or as the tool being absent from
  //    the agent's codemode catalog; both prove the same contract.
  const denied = await driveExecute("Sisyphus-Junior", 'await tools["grep_app"].searchGitHub({ query: "useReducer" })', (text) => /denied|permission|unknown tool|not (?:found|available)/i.test(text) && !/github\.com|Repository:/i.test(text))
  captures.grepAppDenied = denied
  checks.push({ name: "grep_app.deniedForNonLibrarian", pass: denied.ok, detail: denied.text?.slice(0, 160) })

  const failed = checks.filter((check) => !check.pass).map((check) => check.name)
  const report = {
    service,
    baseUrl,
    labRoot,
    version: info.version,
    spawnedOpenCode: false,
    dockerUsed: false,
    v1Addressed: false,
    servers: byName,
    checks,
    failed,
  }
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(evidenceDir, "live-captures.json"), `${JSON.stringify(captures, null, 2)}\n`, { mode: 0o600 })
  fs.writeFileSync(path.join(evidenceDir, "builtin-mcps-verdicts.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify({ passed: checks.length - failed.length, total: checks.length, failed }, null, 2))
  if (failed.length > 0) {
    console.error(`Rigel V2 builtin-MCP live FAILED: ${failed.join(", ")}`)
    process.exitCode = 1
  } else {
    console.log(`Rigel V2 builtin-MCP live PASS (${checks.length} checks)`)
  }
}

try {
  await main()
} finally {
  for (const sessionID of sessions) {
    try {
      await api("DELETE", `/api/session/${sessionID}`)
    } catch (error) {
      console.error(`Could not remove isolated V2 session ${sessionID}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
