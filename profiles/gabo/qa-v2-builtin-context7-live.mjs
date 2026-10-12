#!/usr/bin/env node
/**
 * Live contract: EXACTLY ONE Context7 over the isolated V2 laboratory.
 *
 * Drives the authorized V2 laboratory (`opencode-v2-lab.service`) through the
 * single sanctioned refresh entrypoint (`apply-v2-runtime-service.sh`) and reads
 * the LIVE inventory from the host's own `/api/mcp`. Two scenarios plus the
 * remove/add transitions after a restart:
 *   - no external Context7  -> the OMO builtin is the single Context7 (count 1)
 *   - external Context7     -> the external wins, the builtin is omitted (count 1)
 *   - remove external       -> the builtin becomes the single Context7 (count 1)
 *   - add external again    -> the external wins again (count 1, never 2)
 * The runtime's own log line (`Native V2 builtin MCP inventory`) records the
 * policy decision (`planned`, the reliable signal) and `registered` (the names
 * set synchronously, which may be empty because the host applies the mcp
 * transform asynchronously). The origin of the single Context7 is proven by
 * ELIMINATION plus the contract: with the lab config declaring no context7, the
 * only code that can register it is the remote builtin
 * (`https://mcp.context7.com/mcp`). `/api/mcp` does NOT expose the server URL, so
 * the remote origin rests on that elimination, not on a live URL field.
 *
 * This file never launches OpenCode directly, never uses Docker and never
 * addresses V1. It restores the lab configuration and the operator profile on
 * exit. No credential is ever printed or written to evidence.
 *
 * Usage: node profiles/gabo/qa-v2-builtin-context7-live.mjs
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { renderCleanInstallProfile } from "./rigel-v2-clean-install-profile.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const labRoot = process.env.RIGEL_V2_LAB_ROOT || path.join(os.homedir(), ".local/share/opencode-v2-lab")
const labHome = process.env.RIGEL_V2_HOME || path.join(labRoot, "home")
const labConfig = path.join(labRoot, "config", "opencode", "opencode.json")
const secretFile = path.join(labRoot, "secret.env")
const service = process.env.RIGEL_V2_SERVICE || "opencode-v2-lab.service"
const baseUrl = process.env.RIGEL_V2_LAB_URL || "http://127.0.0.1:4097"
const evidenceDir = path.join(root, ".omo/evidence/20261012-rigel-v2-clean-install-seed")
const READY_MS = Number(process.env.RIGEL_BUILTIN_MCP_READY_TIMEOUT_MS || 120_000)

function skip(reason) {
  console.log(`Rigel V2 Context7 live: SKIP (${reason})`)
  process.exit(0)
}

function readPassword() {
  if (!fs.existsSync(secretFile)) return null
  const line = fs.readFileSync(secretFile, "utf8").split("\n").find((entry) => entry.startsWith("OPENCODE_PASSWORD="))
  return line ? line.slice("OPENCODE_PASSWORD=".length) : null
}

const password = readPassword()
if (!password) skip(`no lab credentials at ${secretFile}`)
if (!fs.existsSync(labConfig)) skip(`no lab config at ${labConfig}`)
const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

async function api(pathname) {
  try {
    const response = await fetch(baseUrl + pathname, { headers: { authorization: auth }, signal: AbortSignal.timeout(20_000) })
    const text = await response.text()
    return { status: response.status, json: text ? JSON.parse(text) : null }
  } catch (error) {
    return { status: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

async function waitForLabReady() {
  const deadline = Date.now() + READY_MS
  while (Date.now() < deadline) {
    const info = await api("/api/info")
    if (info.status === 200 && info.json?.version) return true
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  return false
}

async function waitForContext7() {
  // Wait for the live server to be CONNECTED (not merely listed), so the claim is
  // about a real, working Context7 and not a pending registration.
  const deadline = Date.now() + READY_MS
  let last = { count: 0, status: "absent" }
  while (Date.now() < deadline) {
    const mcp = await api("/api/mcp")
    const servers = Array.isArray(mcp.json?.data) ? mcp.json.data : []
    const context7 = servers.filter((entry) => entry.name === "context7")
    last = { count: context7.length, status: context7[0]?.status?.status ?? "absent" }
    if (last.count >= 1 && last.status === "connected") return last
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return last
}

function configHasContext7() {
  try {
    return Boolean(JSON.parse(fs.readFileSync(labConfig, "utf8")).mcp?.context7)
  } catch {
    return false
  }
}

function refresh(profileFile) {
  return spawnSync("bash", [path.join(root, "profiles/gabo/apply-v2-runtime-service.sh")], {
    cwd: root,
    env: { ...process.env, ...(profileFile ? { RIGEL_V2_PROFILE_FILE: profileFile } : {}) },
    encoding: "utf8",
    timeout: 600_000,
  })
}

function lastInventory() {
  const journal = spawnSync("journalctl", ["--user", "-u", service, "--since", "3 min ago"], { encoding: "utf8" })
  const lines = (journal.stdout || "").split("\n").filter((line) => line.includes("builtin MCP inventory"))
  return lines.length > 0 ? lines[lines.length - 1].replace(/^.*builtin MCP inventory: /, "") : ""
}

function writeConfig(parsed) {
  fs.writeFileSync(labConfig, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 })
}

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? "" : String(detail) })
}

const originalRaw = fs.readFileSync(labConfig, "utf8")
const original = JSON.parse(originalRaw)
const withoutExternal = structuredClone(original)
if (withoutExternal.mcp) delete withoutExternal.mcp.context7

const cleanProfile = path.join(os.tmpdir(), `rigel-clean-profile-${process.pid}.jsonc`)
const tracked = JSON.parse(fs.readFileSync(path.join(root, "profiles/gabo/omo.jsonc"), "utf8").replaceAll("__OMO_PROFILE_ROOT__", path.join(labHome, ".omo")))
fs.writeFileSync(cleanProfile, `${JSON.stringify(renderCleanInstallProfile(tracked), null, 2)}\n`)

try {
  // ---- Scenario 1: no external Context7 -> builtin is the single Context7 ----
  writeConfig(withoutExternal)
  const r1 = refresh(cleanProfile)
  check("refresh.noExternal.exitZero", r1.status === 0, r1.stderr?.slice(0, 160))
  await waitForLabReady()
  const s1 = await waitForContext7()
  // Origin proof by elimination: the lab config declares NO context7, so no local
  // server can exist; the only code that can register context7 is the builtin
  // (https://mcp.context7.com/mcp). A connected context7 here IS the remote builtin.
  check("noExternal.configDeclaresNoContext7", configHasContext7() === false, `configHasContext7=${configHasContext7()}`)
  check("noExternal.builtin.countOneConnected", s1.count === 1 && s1.status === "connected", `count=${s1.count} status=${s1.status}`)
  check("noExternal.builtin.planned", lastInventory().includes("planned=") && lastInventory().includes("context7"), lastInventory())

  // ---- Scenario 2: external Context7 -> external wins, builtin omitted ----
  writeConfig(original)
  const r2 = refresh(cleanProfile)
  check("external.refresh.exitZero", r2.status === 0, r2.stderr?.slice(0, 160))
  await waitForLabReady()
  const s2 = await waitForContext7()
  check("external.configDeclaresContext7", configHasContext7() === true, `configHasContext7=${configHasContext7()}`)
  check("external.context7.countOneConnected", s2.count === 1 && s2.status === "connected", `count=${s2.count} status=${s2.status}`)

  // ---- Transition: remove external again (restart) -> builtin is one ----
  writeConfig(withoutExternal)
  const r3 = refresh(cleanProfile)
  check("removeExternal.refresh.exitZero", r3.status === 0, r3.stderr?.slice(0, 160))
  await waitForLabReady()
  const s3 = await waitForContext7()
  check("removeExternal.context7.countOneConnected", s3.count === 1 && s3.status === "connected", `count=${s3.count} status=${s3.status}`)

  // ---- Transition: add external again (restart) -> external is one, never two ----
  writeConfig(original)
  const r4 = refresh(cleanProfile)
  check("addExternal.refresh.exitZero", r4.status === 0, r4.stderr?.slice(0, 160))
  await waitForLabReady()
  const s4 = await waitForContext7()
  check("addExternal.context7.countOneConnected", s4.count === 1 && s4.status === "connected", `count=${s4.count} status=${s4.status}`)
  check("noDuplicate.neverTwo", [s1.count, s2.count, s3.count, s4.count].every((count) => count === 1), JSON.stringify([s1.count, s2.count, s3.count, s4.count]))
} finally {
  // Restore the lab config byte-identically and refresh with the operator profile.
  fs.writeFileSync(labConfig, originalRaw, { mode: 0o600 })
  refresh(undefined)
  fs.rmSync(cleanProfile, { force: true })
}

const failed = checks.filter((entry) => !entry.pass).map((entry) => entry.name)
const report = {
  service,
  baseUrl,
  labRoot,
  spawnedOpenCode: false,
  dockerUsed: false,
  v1Addressed: false,
  checks,
  failed,
}
fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
fs.writeFileSync(path.join(evidenceDir, "builtin-context7-live.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify({ passed: checks.length - failed.length, total: checks.length, failed }, null, 2))
if (failed.length > 0) {
  console.error(`Rigel V2 Context7 live FAILED: ${failed.join(", ")}`)
  process.exitCode = 1
} else {
  console.log(`Rigel V2 Context7 live PASS (${checks.length} checks)`)
}
