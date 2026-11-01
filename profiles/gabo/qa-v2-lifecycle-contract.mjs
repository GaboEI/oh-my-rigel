#!/usr/bin/env node
/**
 * A03 / A04 / A06 scoped lifecycle contract.
 *
 * A03 clean install + A04 reinstall/rollback/uninstall run against a DISPOSABLE
 * temp lab built from zero (fresh HOME/XDG, no seeding from the real lab) using
 * the exact installer components `apply-v2-runtime-service.sh` invokes. A06
 * restart-with-recovery runs against the real authorized lab
 * (`opencode-v2-lab.service`, refreshed only through that same script): it
 * creates a session through the lab API, refreshes (stop+start), and proves the
 * session survives.
 *
 * Isolation: no Docker, no `--standalone`, no direct OpenCode spawn, no V1 access.
 * A created lab session is deleted in `finally` even when an assertion throws.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { buildProtectedManifest, diffProtectedManifests } from "./v1-protected-surfaces.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const labRoot = process.env.RIGEL_V2_LAB_ROOT || path.join(os.homedir(), ".local", "share", "opencode-v2-lab")
const secretFile = path.join(labRoot, "secret.env")
const evidenceDir = path.join(root, ".omo/evidence/20261008-production-readiness/rotation3-f1f2f0")
const checks = []
const created = []
let probeSessionId = null

/** One plugin specifier: bare string, legacy `[spec, options]` tuple, or native `{package, options}` object. */
function pluginSpec(entry) {
  if (typeof entry === "string") return entry
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0]
  if (entry && typeof entry === "object" && typeof entry.package === "string") return entry.package
  return undefined
}
/**
 * Effective server plugin specifiers of a config document. The installer writes
 * the native `plugins` key and drops `plugin`, so reading `plugin` alone sees
 * nothing after the first install. Order mirrors the host normalizer: legacy
 * entries first, then native ones.
 */
function configPluginSpecs(config) {
  const legacy = Array.isArray(config?.plugin) ? config.plugin : []
  const native = Array.isArray(config?.plugins) ? config.plugins : []
  return [...legacy, ...native].map(pluginSpec).filter((spec) => typeof spec === "string")
}

function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? "" : String(detail) })
}
function runNode(script, env) {
  return spawnSync(process.execPath, [path.join(root, "profiles", "gabo", script)], { cwd: root, env, encoding: "utf8", timeout: 180_000 })
}
function sha(file) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") } catch { return null }
}
function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !["generatedAt", "nativeV2ActivatedAt", "activatedAt"].includes(key)).map(([key, item]) => [key, stripVolatile(item)]))
  }
  return value
}
function readPassword() {
  const match = /^OPENCODE_PASSWORD=(.*)$/m.exec(fs.readFileSync(secretFile, "utf8"))
  return match ? match[1] : ""
}
async function labApi(route, options = {}) {
  const auth = Buffer.from(`opencode:${readPassword()}`).toString("base64")
  const response = await fetch(`http://127.0.0.1:4097${route}`, { ...options, headers: { authorization: `Basic ${auth}`, "content-type": "application/json", ...(options.headers ?? {}) } })
  const text = await response.text()
  let json
  try { json = JSON.parse(text) } catch { json = null }
  return { status: response.status, json, text }
}
async function waitForLabReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const info = await labApi("/api/info")
      if (info.status === 200) return true
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

const v1Config = path.join(os.homedir(), ".config", "opencode", "opencode.json")
const v1Before = { config: sha(v1Config), protected: buildProtectedManifest(os.homedir()) }

try {
  // ---------------------------------------------------------------- A03 / A04
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-lifecycle-"))
  created.push(temp)
  const tmpLab = path.join(temp, "lab")
  const tmpHome = path.join(tmpLab, "home")
  const tmpConfig = path.join(tmpLab, "config", "opencode", "opencode.json")
  fs.mkdirSync(path.dirname(tmpConfig), { recursive: true, mode: 0o700 })
  fs.mkdirSync(tmpHome, { recursive: true, mode: 0o700 })
  // From-zero: a minimal but valid V2 config, NOT seeded from the real lab.
  fs.writeFileSync(tmpConfig, `${JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "rigel-fixture/fixture", plugin: [] }, null, 2)}\n`, { mode: 0o600 })
  const tmpEnv = { ...process.env, RIGEL_V2_LAB_ROOT: tmpLab, RIGEL_V2_HOME: tmpHome, RIGEL_V2_CONFIG: tmpConfig }

  const install = () => [
    runNode("apply-v2-agent-layer.mjs", tmpEnv),
    runNode("switch-live-plugin-to-native-v2.mjs", tmpEnv),
    runNode("materialize-v2-cli.mjs", tmpEnv),
  ]
  const first = install()
  check("A03.install.componentsExitZero", first.every((result) => result.status === 0), first.map((result) => result.status).join(","))
  const stateFile = path.join(tmpLab, "rigel", "active-trial.json")
  const runtimeDir = path.join(tmpLab, "rigel", "runtime", "rigel-v2-native")
  const configAfter = JSON.parse(fs.readFileSync(tmpConfig, "utf8"))
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"))
  check("A03.config.generatedWithRuntime", configPluginSpecs(configAfter).includes(runtimeDir), JSON.stringify(configAfter.plugins))
  check("A03.state.scopedToTempLab", state.configFile === tmpConfig && state.labRoot === tmpLab && state.pluginEntry === runtimeDir, `${state.labRoot} / ${state.pluginEntry}`)
  check("A03.runtime.materialized", fs.existsSync(path.join(runtimeDir, "index.js")))
  const launcher = path.join(tmpLab, "rigel", "bin", "rigel-v2")
  check("A03.cli.launcherInstalled", fs.existsSync(launcher) && (fs.statSync(launcher).mode & 0o111) !== 0, launcher)
  check("A03.isolation.notUnderV1", !tmpLab.startsWith(path.join(os.homedir(), ".config")) && !tmpLab.startsWith(path.join(os.homedir(), ".local", "share", "opencode")))

  // A04 idempotent reinstall: state stable modulo timestamps.
  const stateBeforeRepeat = JSON.stringify(stripVolatile(state))
  const second = install()
  check("A04.reinstall.exitZero", second.every((result) => result.status === 0), second.map((result) => result.status).join(","))
  const stateAfterRepeat = JSON.stringify(stripVolatile(JSON.parse(fs.readFileSync(stateFile, "utf8"))))
  check("A04.reinstall.idempotentState", stateBeforeRepeat === stateAfterRepeat)

  // A04 rollback: a mutated runtime file is restored by the next refresh.
  const indexFile = path.join(runtimeDir, "index.js")
  const pristine = sha(indexFile)
  fs.appendFileSync(indexFile, "\n// rollback-probe\n")
  check("A04.rollback.mutationDetected", sha(indexFile) !== pristine)
  install()
  check("A04.rollback.restoredByteIdentical", sha(indexFile) === pristine, `${String(pristine).slice(0, 16)} -> ${String(sha(indexFile)).slice(0, 16)}`)

  // A04 scoped uninstall on the DISPOSABLE lab only (never the real lab).
  const uninstall = spawnSync(launcher, ["uninstall", "--platform=opencode", "--json"], { encoding: "utf8", timeout: 120_000 })
  let uninstallPayload = null
  try { uninstallPayload = JSON.parse(uninstall.stdout) } catch { /* reported below */ }
  const configAfterUninstall = JSON.parse(fs.readFileSync(tmpConfig, "utf8"))
  check("A04.uninstall.refusesNothingWrong", uninstall.status === 0 && uninstallPayload?.ok === true, uninstall.stderr || uninstall.stdout.slice(0, 120))
  check("A04.uninstall.runtimeRemoved", !fs.existsSync(runtimeDir))
  check("A04.uninstall.configUnregistered", !configPluginSpecs(configAfterUninstall).includes(runtimeDir), JSON.stringify(configAfterUninstall.plugins))
  check("A04.uninstall.neverTouchesV1", !configPluginSpecs(configAfterUninstall).some((entry) => entry.startsWith(path.join(os.homedir(), ".local", "share", "opencode"))))
  const reinstall = install()
  check("A04.uninstall.reinstallWorks", reinstall.every((result) => result.status === 0) && fs.existsSync(runtimeDir))

  // --------------------------------------------------------------------- A06
  const refresh = spawnSync("bash", [path.join(root, "profiles", "gabo", "apply-v2-runtime-service.sh")], { cwd: root, env: process.env, encoding: "utf8", timeout: 180_000 })
  check("A06.refresh.exitZero", refresh.status === 0, refresh.stderr?.slice(0, 160))
  check("A06.refresh.labApiReady", await waitForLabReady())

  const title = `rigel-a06-recovery-${Date.now()}`
  const create = await labApi("/api/session", { method: "POST", body: JSON.stringify({ title }) })
  probeSessionId = create.json?.data?.id ?? null
  check("A06.session.created", create.status === 200 && typeof probeSessionId === "string" && probeSessionId.startsWith("ses_"), `status=${create.status} id=${probeSessionId}`)
  if (probeSessionId === null) throw new Error("lab session create returned no data.id")

  const beforeRestart = await labApi(`/api/session/${probeSessionId}`)
  check("A06.session.readBeforeRestart", beforeRestart.status === 200 && beforeRestart.json?.data?.title === title, `status=${beforeRestart.status} title=${beforeRestart.json?.data?.title}`)

  const restart = spawnSync("bash", [path.join(root, "profiles", "gabo", "apply-v2-runtime-service.sh")], { cwd: root, env: process.env, encoding: "utf8", timeout: 180_000 })
  check("A06.restart.exitZero", restart.status === 0, restart.stderr?.slice(0, 160))
  check("A06.restart.labApiReady", await waitForLabReady())

  const afterRestart = await labApi(`/api/session/${probeSessionId}`)
  check("A06.recovery.sessionSurvivedRestart", afterRestart.status === 200 && afterRestart.json?.data?.id === probeSessionId, `status=${afterRestart.status}`)

  const deleted = await labApi(`/api/session/${probeSessionId}`, { method: "DELETE" })
  check("A06.session.deleted", deleted.status === 204 || deleted.status === 200, `status=${deleted.status}`)
  const gone = await labApi(`/api/session/${probeSessionId}`)
  check("A06.session.cleanupVerified", gone.status === 404, `status=${gone.status}`)
  probeSessionId = null
} finally {
  // Fail-safe cleanup: remove the probe session even when an assertion threw above.
  if (probeSessionId) {
    try {
      await labApi(`/api/session/${probeSessionId}`, { method: "DELETE" })
      const residue = await labApi(`/api/session/${probeSessionId}`)
      check("A06.session.cleanupOnFailure", residue.status === 404, `status=${residue.status}`)
    } catch (error) {
      check("A06.session.cleanupOnFailure", false, String(error))
    }
    probeSessionId = null
  }
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true })
}

const v1After = { config: sha(v1Config), protected: buildProtectedManifest(os.homedir()) }
const protectedDiff = diffProtectedManifests(v1Before.protected, v1After.protected)
const v1Clean = v1Before.config === v1After.config && protectedDiff.added.length === 0 && protectedDiff.removed.length === 0 && protectedDiff.changed.length === 0
check("v1.untouched", v1Clean, JSON.stringify(protectedDiff))

const failed = checks.filter((entry) => !entry.pass)
fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
fs.writeFileSync(path.join(evidenceDir, "lifecycle-contract.json"), `${JSON.stringify({ spawnedOpenCode: false, dockerUsed: false, standaloneUsed: false, checks, failed: failed.map((entry) => entry.name) }, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify({ passed: checks.length - failed.length, total: checks.length, failed: failed.map((entry) => entry.name) }, null, 2))
if (failed.length > 0) process.exitCode = 1
