#!/usr/bin/env node
/**
 * Category-delegation gate: native `rigel_task(category=...)` must route to the
 * EXACT provider+model the LIVE category config declares, in foreground and
 * background, and hand the child result back to the parent.
 *
 * For each scenario (category x foreground/background) a disposable, fully
 * isolated V2 server runs the runtime under test with a local fake provider that
 * calls `rigel_task(category=...)`. The child's EFFECTIVE model, read from the
 * provider trace, must be the declared model, and the parent must receive the
 * child result / background handoff.
 *
 * Preconditions are OBSERVED and reported, never assumed and never required:
 *   - Category config: a live user config (`~/.omo/omo.jsonc`) is used only when
 *     it exists AND declares the pin this gate asserts. Otherwise a fixture with
 *     the same shape is generated inside each sandbox, so the gate still proves
 *     the live-config authority on a host with no pre-existing user tree. Absence
 *     is recorded, never a failure and never a block.
 *   - Installed lab runtime: `RIGEL_QA_RUNTIME_DIR` is used per file when present;
 *     otherwise the worktree source is used and the effective source of every
 *     module is recorded in the provenance block.
 *   - OpenCode V2 binary: without a runnable binary no scenario can run, so the
 *     gate reports NOT_EXECUTABLE with that exact reason instead of a spurious
 *     FAIL.
 *
 * Exit codes: 0 PASS, 1 FAIL (a real assertion failed), 2 NOT_EXECUTABLE.
 *
 * Isolation: HOME/XDG/goal state live in a disposable sandbox (`buildIsolatedV2Env`).
 * A live user config is only READ and copied into the sandbox; no protected
 * surface is written or mutated.
 */
import childProcess from "node:child_process"
import crypto from "node:crypto"
import net from "node:net"
import { buildIsolatedV2Env } from "./isolated-v2-env.mjs"
import { discoverRuntimeModules } from "./native-runtime-modules.mjs"
import { stageWebFetchHtmlParser } from "./rigel-v2-runtime-materialize.mjs"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const binary = process.env.RIGEL_OPENCODE_V2_BIN ?? path.join(os.homedir(), ".opencode/bin/opencode")
const evidenceDir = path.join(sourceRoot, ".omo/evidence/20261012-fix-v2-category-json-routing")
const realUserConfig = path.join(os.homedir(), ".omo/omo.jsonc")

const CATEGORIES = ["visual-engineering", "ultrabrain", "deep-low", "writing"]
const MODES = ["foreground", "background"]
const EXPECTED_PROVIDER = "opencode-go"
const EXPECTED_MODEL = "deepseek-v4.1-flash"
const EXPECTED_PIN = `${EXPECTED_PROVIDER}/${EXPECTED_MODEL}`

// Startup observations, reported verbatim. A precondition is either USED,
// SKIPPED (with its reason) or MISSING; only MISSING blocks execution.
const preconditions = []

/** Category config shape the runtime resolves from the live user layer. */
function categoryFixture() {
  const categories = {}
  for (const name of CATEGORIES) categories[name] = { models: [EXPECTED_PIN] }
  return JSON.stringify({ categories }, null, 2) + "\n"
}

/**
 * Resolve the category config the scenarios assert against. A live config is
 * preferred so the gate tests real declarations; a config that does not carry
 * the pin under test proves nothing about routing, so it is recorded as skipped
 * instead of turning into a spurious failure.
 */
function resolveCategoriesConfig() {
  const requested = process.env.RIGEL_QA_CATEGORIES_CONFIG
  const candidates = []
  if (requested) candidates.push({ kind: "operator override", file: path.resolve(requested) })
  candidates.push({ kind: "live user config", file: realUserConfig })
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.file)) {
      preconditions.push(`category config (${candidate.kind}): SKIPPED, absent at ${candidate.file}`)
      continue
    }
    const text = fs.readFileSync(candidate.file, "utf8")
    if (!text.includes(EXPECTED_MODEL)) {
      preconditions.push(`category config (${candidate.kind}): SKIPPED, ${candidate.file} does not declare the ${EXPECTED_PIN} pin`)
      continue
    }
    preconditions.push(`category config (${candidate.kind}): USED, ${candidate.file} (read-only, copied into each sandbox)`)
    return { kind: candidate.kind, file: candidate.file, text }
  }
  preconditions.push(`category config (generated fixture): USED, in-sandbox \`categories\` pinning ${EXPECTED_PIN} for ${CATEGORIES.length} categories`)
  return { kind: "generated fixture", file: null, text: categoryFixture() }
}

function writeEvidence(name, value) {
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(evidenceDir, name), value, { mode: 0o600 })
}

function waitFor(check, message, timeout = 25_000) {
  const deadline = Date.now() + timeout
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try { if (await check()) return resolve() } catch { /* still starting */ }
      if (Date.now() >= deadline) return reject(new Error(message))
      setTimeout(attempt, 100)
    }
    attempt()
  })
}

// Deterministic port isolation: ask the OS for a currently-unused port instead
// of a fixed base. A fixed `portBase + n` collided when a prior child lingered
// in TIME_WAIT and produced `EADDRINUSE` (driver/isolation defect, not runtime).
function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

function waitExit(child, timeout = 5000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve()
    const timer = setTimeout(resolve, timeout)
    child.once("exit", () => { clearTimeout(timer); resolve() })
  })
}

async function json(url, authorization, init) {
  const response = await fetch(url, { ...init, headers: { authorization, ...init?.headers } })
  const body = await response.text()
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url} failed: ${response.status} ${body}`)
  return body ? JSON.parse(body) : {}
}

const RUNTIME_SOURCE_DIR = process.env.RIGEL_QA_RUNTIME_DIR ?? null
const LABEL = process.env.RIGEL_QA_LABEL ?? "postfix"
const usedSources = new Map()

/** A binary is runnable when a path candidate exists or a bare name is on PATH. */
function binaryAvailable(candidate) {
  if (candidate.includes(path.sep)) return fs.existsSync(candidate)
  return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).some((dir) => fs.existsSync(path.join(dir, candidate)))
}

const categoriesConfig = resolveCategoriesConfig()
preconditions.push(RUNTIME_SOURCE_DIR
  ? (fs.existsSync(RUNTIME_SOURCE_DIR)
    ? `installed lab runtime: USED, ${RUNTIME_SOURCE_DIR}`
    : `installed lab runtime: SKIPPED, absent at ${RUNTIME_SOURCE_DIR}; per-file fallback to the worktree source is recorded in provenance`)
  : "installed lab runtime: SKIPPED, RIGEL_QA_RUNTIME_DIR is not set; the worktree source is used and recorded in provenance")
const binaryRunnable = binaryAvailable(binary)
preconditions.push(binaryRunnable
  ? `opencode V2 binary: USED, ${binary}`
  : `opencode V2 binary: MISSING, ${binary}`)
// The copied runtime imports `htmlparser2` through the native WebFetch module, and
// the installer stages that closure next to the runtime. Without it the plugin
// fails to load, so its presence is a precondition, not a routing result.
const dependencyRoot = path.join(sourceRoot, "node_modules")
const dependenciesAvailable = fs.existsSync(path.join(dependencyRoot, "htmlparser2", "package.json"))
preconditions.push(dependenciesAvailable
  ? `runtime dependency closure: USED, ${dependencyRoot} (staged into every sandbox runtime)`
  : `runtime dependency closure: MISSING, ${path.join(dependencyRoot, "htmlparser2")}`)
const notExecutableReasons = []
if (!binaryRunnable) notExecutableReasons.push(`no runnable OpenCode V2 binary at ${binary}: no scenario can start a server. Set RIGEL_OPENCODE_V2_BIN to a V2 binary, or provide one at the default path`)
if (!dependenciesAvailable) notExecutableReasons.push(`the runtime's htmlparser2 closure is absent from ${dependencyRoot}, so a copied runtime cannot load. Install the workspace dependencies first (script/agent/setup.sh)`)
const notExecutableReason = notExecutableReasons.length > 0 ? `${notExecutableReasons.join(". ")}.` : null

// Resolve a runtime module from the installed runtime under test when
// RIGEL_QA_RUNTIME_DIR is set (so this gate proves the installed artifact, not a
// worktree stand-in), else from the worktree source. The exact source file used
// is recorded for provenance.
function runtimeSourceFile(name) {
  if (RUNTIME_SOURCE_DIR) {
    const installed = name === "rigel-v2-native.mjs" ? "index.js" : name
    const candidate = path.join(RUNTIME_SOURCE_DIR, installed)
    if (fs.existsSync(candidate)) return candidate
  }
  return path.join(sourceRoot, "profiles/gabo/opencode", name)
}

function copyRuntimeFile(runtime, name) {
  const destination = path.join(runtime, name === "rigel-v2-native.mjs" ? "index.js" : name)
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
  const source = runtimeSourceFile(name)
  fs.copyFileSync(source, destination)
  usedSources.set(name, source)
}

async function runScenario(category, mode) {
  const background = mode === "background"
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `rigel-cat-${category}-`))
  const configHome = path.join(temporary, "config")
  const home = path.join(temporary, "home")
  const runtime = path.join(temporary, "plugin")
  const providerPort = await getFreePort()
  const serverPort = await getFreePort()
  const serverUrl = `http://127.0.0.1:${serverPort}`
  const traceFile = path.join(temporary, "provider-trace.jsonl")
  const serverPassword = "rigel-disposable-server-only"
  const serverAuthorization = `Basic ${Buffer.from(`opencode:${serverPassword}`).toString("base64")}`

  fs.mkdirSync(path.join(runtime, "prompts"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(configHome, "opencode"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(home, ".omo"), { recursive: true, mode: 0o700 })
  // The resolved category config, written read-only into the sandbox (the source
  // file, when there is one, is never mutated).
  fs.writeFileSync(path.join(home, ".omo", "omo.jsonc"), categoriesConfig.text, { mode: 0o600 })
  copyRuntimeFile(runtime, "rigel-v2-native.mjs")
  for (const name of discoverRuntimeModules(path.join(sourceRoot, "profiles/gabo/opencode"))) copyRuntimeFile(runtime, name)
  // The materializer stages the native WebFetch parser closure next to the
  // runtime; a copied runtime without it cannot load (bare `htmlparser2` import),
  // so the sandbox gets the same closure or the gate is not testing a real runtime.
  if (dependenciesAvailable) stageWebFetchHtmlParser({ sourceRoot, runtimeDir: runtime })
  fs.copyFileSync(path.join(sourceRoot, "packages/prompts-core/prompts/ultrawork/default.md"), path.join(runtime, "prompts/ultrawork-default.md"))
  fs.writeFileSync(path.join(runtime, "rigel-v2-native-agent-manifest.mjs"), `export default ${JSON.stringify({
    defaultAgent: "Sisyphus - ultraworker",
    modes: { defaultUltrawork: false },
    agents: {
      "Sisyphus - ultraworker": { mode: "primary", name: "Sisyphus - ultraworker", model: "rigel-fixture/fixture", prompt: "Coordinate the request." },
      "Sisyphus-Junior": { mode: "subagent", name: "Sisyphus-Junior", model: "rigel-fixture/fixture", prompt: "Execute the task." },
      explore: { mode: "subagent", name: "explore", model: "rigel-fixture/fixture", prompt: "Explore evidence." },
    },
  })}\n`, { mode: 0o600 })
  fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ type: "module" }) + "\n", { mode: 0o600 })

  const fake = (models) => ({ name: "Rigel deterministic test provider", npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "rigel-fixture-no-secret" }, models })
  const modelDef = { name: "m", tool_call: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 16384, output: 2048 } }
  fs.writeFileSync(path.join(configHome, "opencode/opencode.json"), JSON.stringify({
    provider: {
      "rigel-fixture": fake({ fixture: modelDef }),
      [EXPECTED_PROVIDER]: fake({ [EXPECTED_MODEL]: modelDef }),
      // Built-in first rungs are ALSO available, so a pre-fix run (live
      // categories ignored) resolves the built-in chain instead of the pin.
      anthropic: fake({ "claude-fable-5-1": modelDef, "claude-opus-5-5": modelDef }),
      openai: fake({ "gpt-6-astra": modelDef, "gpt-6.1-sol": modelDef }),
    },
    model: "rigel-fixture/fixture", plugin: [runtime], default_agent: "Sisyphus - ultraworker",
  }, null, 2) + "\n", { mode: 0o600 })

  const commonEnv = {
    ...buildIsolatedV2Env({ sandbox: temporary, home }),
    OPENCODE_SERVER_PASSWORD: serverPassword,
    RIGEL_NATIVE_ASSERT_TOOL_REGISTRATION: "1",
    RIGEL_FAKE_TASK_ARGUMENTS: JSON.stringify({ category, prompt: "Reply exactly SPECIALIST_EVIDENCE.", run_in_background: background }),
  }
  const provider = childProcess.spawn(process.execPath, [path.join(sourceRoot, "profiles/gabo/fixtures/fake-openai-native-delegation.mjs")], { env: { ...commonEnv, RIGEL_FAKE_MODEL_PORT: String(providerPort), RIGEL_FAKE_MODEL_TRACE: traceFile }, stdio: ["ignore", "pipe", "pipe"] })
  const server = childProcess.spawn(binary, ["--print-logs", "--log-level", "debug", "serve", "--hostname", "127.0.0.1", "--port", String(serverPort)], { cwd: sourceRoot, env: commonEnv, stdio: ["ignore", "pipe", "pipe"] })
  provider.on("error", () => {})
  server.on("error", () => {})
  const logs = []
  for (const stream of [provider.stderr, server.stdout, server.stderr]) stream?.on("data", (data) => logs.push(data.toString()))

  try {
    await waitFor(() => fetch(`${serverUrl}/api/session/active`, { headers: { authorization: serverAuthorization } }).then((r) => r.ok), "disposable V2 server did not start")
    const created = await json(`${serverUrl}/api/session`, serverAuthorization, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "Sisyphus - ultraworker", location: { directory: sourceRoot } }) })
    const parentID = created.id ?? created.data?.id
    if (typeof parentID !== "string") throw new Error(`no parent session id: ${JSON.stringify(created)}`)
    await json(`${serverUrl}/api/session/${parentID}/prompt`, serverAuthorization, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `Delegate using rigel_task with category ${category}, then report completion.`, resume: true }) })
    const hasRoster = (row) => row.messages?.some((m) => String(m.content).includes("<rigel-native-delegation-roster>"))
    await waitFor(async () => {
      const rows = (fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : "").trim().split("\n").filter(Boolean).map(JSON.parse)
      const childRan = rows.some((r) => r.model === EXPECTED_MODEL)
      const parentDone = rows.some((r) => r.responseKind === "complete" && hasRoster(r))
      const handoff = rows.some((r) => r.messages?.some((m) => String(m.content).includes("<rigel-native-background-result>")))
      return childRan && parentDone && (!background || handoff)
    }, `${category}/${mode}: parent + child did not complete the delegation loop`)

    const trace = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : ""
    const rows = trace.trim().split("\n").filter(Boolean).map(JSON.parse)
    // The child's provider request carries only the model id (openai-compatible);
    // the provider is read from the child session's ModelRef, so BOTH are exact.
    const childRow = rows.find((r) => r.model === EXPECTED_MODEL)
    const childModel = childRow?.model ?? null
    const rosterRow = rows.find((r) => r.responseKind === "complete" && hasRoster(r))
    const handoffRow = rows.find((r) => r.messages?.some((m) => String(m.content).includes("<rigel-native-background-result>")))
    const toolResultText = rows.flatMap((r) => r.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content ?? "")).find((c) => c.includes("sessionID:"))
    const childID = toolResultText?.match(/sessionID:\s*([^;\s]+)/)?.[1]
    const childInfo = childID ? await json(`${serverUrl}/api/session/${childID}`, serverAuthorization, {}) : undefined
    const childModelRef = childInfo?.model ?? childInfo?.data?.model ?? null
    const childProvider = childModelRef?.providerID ?? childModelRef?.provider ?? null
    const childRefId = childModelRef?.id ?? childModelRef?.modelID ?? null
    const parentLinked = Boolean(childInfo?.parentID === parentID || childInfo?.data?.parentID === parentID)
    const parentReceived = background ? Boolean(handoffRow) : Boolean(toolResultText?.includes("<rigel-native-child-result>"))

    const ok = childModel === EXPECTED_MODEL           // exact id from the provider request
      && childRefId === EXPECTED_MODEL                 // exact id from the child session ModelRef
      && childProvider === EXPECTED_PROVIDER           // exact provider from the child session ModelRef
      && Boolean(rosterRow)
      && parentLinked
      && parentReceived
    return { category, mode, childModel, childProvider, childRefId, childInfoKeys: Object.keys(childInfo ?? {}), parentLinked, parentReceived, parentDone: Boolean(rosterRow), ok, childID: childID ?? null, trace, log: logs.join("") }
  } catch (error) {
    writeEvidence(`category-delegation-${LABEL}-${category}-${mode}-failure.txt`, logs.join("") + "\n----- trace -----\n" + (fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : ""))
    throw error
  } finally {
    server.kill("SIGTERM")
    provider.kill("SIGTERM")
    await Promise.all([waitExit(server), waitExit(provider)])
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

const only = process.env.RIGEL_QA_ONLY
const cats = only ? [only.split(":")[0]] : CATEGORIES
const modes = only ? [only.split(":")[1] ?? "foreground"] : MODES
const results = []
if (notExecutableReason === null) {
  for (const category of cats) {
    for (const mode of modes) {
      try {
        const result = await runScenario(category, mode)
        // Archive the RAW provider trace on PASS too (before the sandbox is removed),
        // so the childModel/provider is re-derivable from the artifact.
        writeEvidence(`category-delegation-${LABEL}-${category}-${mode}-trace.jsonl`, result.trace)
        writeEvidence(`category-delegation-${LABEL}-${category}-${mode}.txt`, `${JSON.stringify({ category: result.category, mode: result.mode, childModel: result.childModel, childProvider: result.childProvider, childRefId: result.childRefId, childID: result.childID, parentLinked: result.parentLinked, parentReceived: result.parentReceived, parentDone: result.parentDone, ok: result.ok }, null, 2)}\n${result.log}\n----- trace -----\n${result.trace}`)
        results.push(result)
        process.stdout.write(`category ${category}/${mode}: model=${result.childModel} parentLinked=${result.parentLinked} parentReceivedChild=${result.parentReceived} ok=${result.ok}\n`)
      } catch (error) {
        results.push({ category, mode, ok: false, error: error instanceof Error ? error.message : String(error) })
        writeEvidence(`category-delegation-${LABEL}-${category}-${mode}.txt`, `ERROR: ${error instanceof Error ? error.message : String(error)}\n`)
        process.stdout.write(`category ${category}/${mode}: FAIL ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
  }
}

const expected = EXPECTED_PIN
const totalScenarios = cats.length * modes.length
const allOk = notExecutableReason === null && results.length === totalScenarios && results.every((r) => r.ok)
const verdict = notExecutableReason === null ? (allOk ? "PASS" : "FAIL") : "NOT_EXECUTABLE"
const sha = (file) => (fs.existsSync(file) ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") : "missing")
const entrySource = usedSources.get("rigel-v2-native.mjs") ?? null
const configSource = usedSources.get("rigel-v2-native-config.mjs") ?? null
const worktreeEntry = path.join(sourceRoot, "profiles/gabo/opencode/rigel-v2-native.mjs")
const worktreeConfig = path.join(sourceRoot, "profiles/gabo/opencode/rigel-v2-native-config.mjs")
const entrySha = entrySource ? sha(entrySource) : "-"
const installedMatchesWorktree = entrySource ? entrySha === sha(worktreeEntry) : RUNTIME_SOURCE_DIR === null
// The effective runtime is read from the sources actually copied, not from the
// env var: a requested-but-absent installed runtime must not be reported as used.
const runtimeLabel = entrySource === null
  ? "(not resolved: no scenario ran)"
  : RUNTIME_SOURCE_DIR && path.resolve(entrySource).startsWith(path.resolve(RUNTIME_SOURCE_DIR) + path.sep)
    ? `INSTALLED lab runtime (${RUNTIME_SOURCE_DIR})`
    : `worktree source (${entrySource})`
const provenance = [
  `runtime source dir requested: ${RUNTIME_SOURCE_DIR ?? "(none)"}`,
  `effective runtime: ${runtimeLabel}`,
  `category config source: ${categoriesConfig.file ?? "(generated in-sandbox fixture)"} [${categoriesConfig.kind}]`,
  `tested entry source: ${entrySource ?? "(none)"} sha256=${entrySha}`,
  `tested config source: ${configSource ?? "(none)"} sha256=${configSource ? sha(configSource) : "-"}`,
  `worktree entry sha256=${sha(worktreeEntry)}`,
  `worktree config sha256=${sha(worktreeConfig)}`,
  `tested entry == worktree entry: ${installedMatchesWorktree}`,
  "preconditions:",
  ...preconditions.map((line) => `  ${line}`),
].join("\n")
const report = [
  `# Rigel category-delegation gate (${LABEL})`,
  "",
  `- Category config source: ${categoriesConfig.file ?? "(generated in-sandbox fixture)"} [${categoriesConfig.kind}]`,
  `- Expected effective child model (declared pin): ${expected}`,
  `- Provider of the gate: LOCAL deterministic fake (profiles/gabo/fixtures/fake-openai-native-delegation.mjs); NO real ${EXPECTED_PROVIDER} call and no account.`,
  `- This proves: category delegation selects/routes the EXACT declared provider+model (${expected}) in sync AND background, and the parent receives the child result / background handoff.`,
  `- This does NOT prove: that the real ${EXPECTED_PROVIDER} provider serves the pin (no live provider call).`,
  `- Verified runtime: ${runtimeLabel}`,
  `- Tested entry sha256: ${entrySha} (== worktree: ${installedMatchesWorktree})`,
  `- Assertions: childModel === "${EXPECTED_MODEL}" AND child ModelRef === ${expected} (exact provider+model, no substring).`,
  `- Preconditions (observed at startup):`,
  ...preconditions.map((line) => `  - ${line}`),
  notExecutableReason === null ? null : `- Not executable: ${notExecutableReason}`,
  verdict === "PASS"
    ? `- Per-scenario evidence: category-delegation-${LABEL}-<category>-<mode>-trace.jsonl (raw provider trace; childModel re-derivable).`
    : verdict === "FAIL"
      ? `- Per-scenario evidence on FAIL: category-delegation-${LABEL}-<category>-<mode>-failure.txt (provider trace + logs); NO -trace.jsonl is written for a failed scenario.`
      : null,
  `- Scenarios: ${results.length}/${totalScenarios}`,
  `- Verdict: ${verdict}`,
  "",
  ...(results.length > 0
    ? [
      "| category | mode | child model | parent linked | parent received child | ok |",
      "|---|---|---|---|---|---|",
      ...results.map((r) => `| ${r.category} | ${r.mode} | ${r.childModel ?? "-"} | ${r.parentLinked ?? false} | ${r.parentReceived ?? false} | ${r.ok ? "yes" : "no"} |`),
    ]
    : []),
  "",
].filter((line) => line !== null).join("\n") + "\n"
writeEvidence(`category-delegation-${LABEL}-gate.md`, report)
writeEvidence(`category-delegation-${LABEL}-runtime-provenance.txt`, provenance + "\n")
process.stdout.write(report)
process.stdout.write(provenance + "\n")
if (notExecutableReason !== null) process.exitCode = 2
else if (!allOk) process.exitCode = 1
