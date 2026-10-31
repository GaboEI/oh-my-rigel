#!/usr/bin/env node
/**
 * Proves the full native V2 named-delegation loop in a disposable V2 server.
 * A local provider calls rigel_task; the server must run the named child and
 * continue the parent afterwards. No V1 configuration is read or modified.
 */
import childProcess from "node:child_process"
import { buildIsolatedV2Env } from "./isolated-v2-env.mjs"
import { discoverRuntimeModules } from "./native-runtime-modules.mjs"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const binary = process.env.RIGEL_OPENCODE_V2_BIN ?? path.join(os.homedir(), ".opencode/bin/opencode")
const evidenceDir = process.env.RIGEL_QA_EVIDENCE_DIR
  ? path.resolve(process.env.RIGEL_QA_EVIDENCE_DIR)
  : path.join(sourceRoot, ".omo/evidence/20261002-rigel-v2-native-delegation")
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-native-v2-delegation-"))
const configHome = path.join(temporary, "config")
const home = path.join(temporary, "home")
const runtime = path.join(temporary, "plugin")
const providerPort = 41234
const serverPort = 41235
const serverUrl = `http://127.0.0.1:${serverPort}`
const traceFile = path.join(temporary, "provider-trace.jsonl")
const serverPassword = "rigel-disposable-server-only"
const serverAuthorization = `Basic ${Buffer.from(`opencode:${serverPassword}`).toString("base64")}`
const backgroundMode = process.env.RIGEL_QA_BACKGROUND_MODE === "1"
const explicitUltraworker = process.env.RIGEL_QA_EXPLICIT_ULTRAWORKER === "1"
const resumeMode = process.env.RIGEL_QA_RESUME_TASK === "1"
const delegationAgent = process.env.RIGEL_QA_AGENT ?? "explore"
const delegationCategory = process.env.RIGEL_QA_CATEGORY
const taskArguments = process.env.RIGEL_QA_TASK_ARGUMENTS ?? JSON.stringify({
  ...(delegationCategory ? { category: delegationCategory } : { subagent_type: delegationAgent }),
  prompt: "Reply exactly SPECIALIST_EVIDENCE.",
  run_in_background: backgroundMode,
})
const defaultUltrawork = !explicitUltraworker

function writeEvidence(name, value) {
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(evidenceDir, name), value, { mode: 0o600 })
}

function copyRuntimeFile(name) {
  const destination = path.join(runtime, name === "rigel-v2-native.mjs" ? "index.js" : name)
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
  fs.copyFileSync(path.join(sourceRoot, "profiles/gabo/opencode", name), destination)
}

function waitFor(check, message, timeout = 12_000) {
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

async function json(url, init) {
  const response = await fetch(url, { ...init, headers: { authorization: serverAuthorization, ...init?.headers } })
  const body = await response.text()
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url} failed: ${response.status} ${body}`)
  return body ? JSON.parse(body) : {}
}

try {
  fs.mkdirSync(path.join(runtime, "prompts"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(configHome, "opencode"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  if (delegationCategory) {
    fs.mkdirSync(path.join(home, ".omo"), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(home, ".omo", "omo.jsonc"), `${JSON.stringify({
      categories: { [delegationCategory]: { description: "Disposable QA execution route.", model: "rigel-fixture/fixture" } },
    }, null, 2)}\n`, { mode: 0o600 })
  }
  copyRuntimeFile("rigel-v2-native.mjs")
  for (const name of discoverRuntimeModules(path.join(sourceRoot, "profiles/gabo/opencode"))) copyRuntimeFile(name)
  fs.copyFileSync(path.join(sourceRoot, "packages/prompts-core/prompts/ultrawork/default.md"), path.join(runtime, "prompts/ultrawork-default.md"))
  fs.writeFileSync(path.join(runtime, "rigel-v2-native-agent-manifest.mjs"), `export default ${JSON.stringify({
    defaultAgent: "Sisyphus - ultraworker",
    modes: { defaultUltrawork },
    agents: {
      "Sisyphus - ultraworker": { mode: "primary", name: "Sisyphus - ultraworker", model: "rigel-fixture/fixture", prompt: "Coordinate the request." },
      "Sisyphus-Junior": { mode: "subagent", name: "Sisyphus-Junior", model: "rigel-fixture/fixture", prompt: "Execute the task." },
      explore: { mode: "subagent", name: "explore", model: "rigel-fixture/fixture", prompt: "Explore evidence." },
      oracle: { mode: "subagent", name: "oracle", model: "rigel-fixture/fixture", prompt: "Give technical judgement." },
      librarian: { mode: "subagent", name: "librarian", model: "rigel-fixture/fixture", prompt: "Research sources." },
    },
  })}\n`, { mode: 0o600 })
  fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ type: "module" }) + "\n", { mode: 0o600 })
  fs.writeFileSync(path.join(configHome, "opencode/opencode.json"), JSON.stringify({
    provider: { "rigel-fixture": { name: "Rigel deterministic test provider", npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "rigel-fixture-no-secret" }, models: { fixture: { name: "Rigel fixture", tool_call: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 16384, output: 2048 } } } } },
    model: "rigel-fixture/fixture", plugin: [runtime], default_agent: "Sisyphus - ultraworker",
  }, null, 2) + "\n", { mode: 0o600 })
  const commonEnv = { ...buildIsolatedV2Env({ sandbox: temporary, home: home }), OPENCODE_SERVER_PASSWORD: serverPassword, RIGEL_NATIVE_ASSERT_TOOL_REGISTRATION: "1", RIGEL_FAKE_RESUME_TASK: resumeMode ? "1" : "0", RIGEL_FAKE_TASK_ARGUMENTS: taskArguments }
  const provider = childProcess.spawn(process.execPath, [path.join(sourceRoot, "profiles/gabo/fixtures/fake-openai-native-delegation.mjs")], { env: { ...commonEnv, RIGEL_FAKE_MODEL_PORT: String(providerPort), RIGEL_FAKE_MODEL_TRACE: traceFile }, stdio: ["ignore", "pipe", "pipe"] })
  const server = childProcess.spawn(binary, ["--print-logs", "--log-level", "debug", "serve", "--hostname", "127.0.0.1", "--port", String(serverPort)], { cwd: sourceRoot, env: commonEnv, stdio: ["ignore", "pipe", "pipe"] })
  const logs = []
  for (const stream of [provider.stderr, server.stdout, server.stderr]) stream?.on("data", (data) => logs.push(data.toString()))
  try {
    await waitFor(() => fetch(`${serverUrl}/api/session/active`, { headers: { authorization: serverAuthorization } }).then((response) => response.ok), "The disposable V2 server did not start")
    const created = await json(`${serverUrl}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "Sisyphus - ultraworker", location: { directory: sourceRoot } }) })
    const parentID = created.id ?? created.data?.id
    if (typeof parentID !== "string") throw new Error(`V2 did not return a parent session ID: ${JSON.stringify(created)}`)
    const userPrompt = explicitUltraworker
      ? "Ultrawork: delegate the requested research using rigel_task, then report completion."
      : "Delegate the requested research using rigel_task, then report completion."
    await json(`${serverUrl}/api/session/${parentID}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: userPrompt, resume: true }) })
    await waitFor(async () => {
      const trace = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : ""
      const rows = trace.trim().split("\n").filter(Boolean).map(JSON.parse)
      const isChild = (row) => row.messages?.some((message) => String(message.content).includes("<rigel-native-child-task>"))
      const hasRoster = (row) => row.messages?.some((message) => String(message.content).includes("<rigel-native-delegation-roster>"))
      const childCompleted = rows.some((row) => row.responseKind === "complete" && !hasRoster(row))
      const backgroundHandoff = rows.some((row) => row.messages?.some((message) => String(message.content).includes("<rigel-native-background-result>")))
      const routeRow = rows.find((row) => row.responseKind === "complete" && hasRoster(row))
      const categoryRegistered = !delegationCategory || (
        routeRow?.categoryEnum?.includes(delegationCategory)
        && String(routeRow?.taskDescription ?? "").includes(JSON.stringify(delegationCategory))
      )
      return rows.some(isChild) && childCompleted && Boolean(routeRow) && categoryRegistered && (!backgroundMode || backgroundHandoff)
    }, "The parent and child did not complete the delegation loop", 20_000)
    if (resumeMode) {
      await json(`${serverUrl}/api/session/${parentID}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Resume delegated task using rigel_task, then report completion.", resume: true }) })
      await waitFor(async () => {
        const trace = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : ""
        const rows = trace.trim().split("\n").filter(Boolean).map(JSON.parse)
        const resumeIndex = rows.findIndex((row) => row.responseKind === "resume")
        return resumeIndex >= 0
          && rows.slice(resumeIndex + 1).some((row) => row.responseKind === "child")
          && rows.filter((row) => row.responseKind === "complete" && row.messages?.some((message) => String(message.content).includes("<rigel-native-delegation-roster>"))).length >= 2
      }, "The existing child session was not resumed through rigel_task", 20_000)
    }
    const providerTrace = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : ""
    const transcript = logs.join("")
    writeEvidence("native-delegation.txt", transcript)
    writeEvidence("provider-trace.jsonl", providerTrace)
    const rows = providerTrace.trim().split("\n").filter(Boolean).map(JSON.parse)
    const runtimeLoaded = transcript.includes("Native OpenCode V2 runtime active")
    const invokedTask = transcript.includes("Native V2 task context: name=rigel_task")
    const expectedAgent = delegationCategory ? "Sisyphus-Junior" : delegationAgent
    const resolved = transcript.toLocaleLowerCase().includes(`native v2 agent resolved: requested=${expectedAgent.toLocaleLowerCase()}; canonical=${expectedAgent.toLocaleLowerCase()}`)
    const childRequest = rows.find((row) => row.messages?.some((message) => String(message.content).includes("<rigel-native-child-task>")))
    const hasRoster = (row) => row.messages?.some((message) => String(message.content).includes("<rigel-native-delegation-roster>"))
    const childRanWithoutRoster = Boolean(childRequest) && !hasRoster(childRequest)
    const hasUltrawork = (row) => row.messages?.some((message) => String(message.content).includes("<ultrawork-mode>"))
    const parentReceivedUltrawork = rows.some((row) => hasRoster(row) && hasUltrawork(row))
    const childDidNotReceiveUltrawork = Boolean(childRequest) && !hasUltrawork(childRequest)
    const parentRoster = rows.find((row) => hasRoster(row))?.messages?.find((message) => String(message.content).includes("<rigel-native-delegation-roster>"))?.content ?? ""
    const registeredSpecialistsVisible = ["explore", "oracle", "librarian"].every((name) => parentRoster.includes(name))
    const routeRow = rows.find((row) => row.responseKind === "complete" && hasRoster(row))
    const categoryRegistered = !delegationCategory || (
      routeRow?.categoryEnum?.includes(delegationCategory)
      && String(routeRow?.taskDescription ?? "").includes(JSON.stringify(delegationCategory))
    )
    const childCompleted = rows.some((row) => row.responseKind === "complete" && !hasRoster(row))
    const completed = rows.some((row) => row.responseKind === "complete" && hasRoster(row))
    const resumeIndex = rows.findIndex((row) => row.responseKind === "resume")
    const resumeRequested = resumeIndex >= 0
    const resumedChildRequest = resumeIndex >= 0 && rows.slice(resumeIndex + 1).some((row) => row.responseKind === "child")
    const toolResultText = rows.flatMap((row) => row.messages ?? [])
      .filter((message) => message.role === "tool")
      .map((message) => String(message.content ?? ""))
      .find((content) => content.includes("sessionID:"))
    const childID = toolResultText?.match(/sessionID: ([^;\s]+)/)?.[1]
    const childInfo = childID ? await json(`${serverUrl}/api/session/${childID}`, {}) : undefined
    const parentLinked = Boolean(childInfo?.parentID === parentID || childInfo?.data?.parentID === parentID)
    const backgroundHandoff = rows.some((row) => row.messages?.some((message) => String(message.content).includes("<rigel-native-background-result>") && String(message.content).includes("SELF_AUDIT_PASS")))
    const parentReceivedChildText = backgroundMode ? backgroundHandoff : Boolean(toolResultText?.includes("<rigel-native-child-result>"))
    const activation = explicitUltraworker ? "Explicit `Ultraworker` keyword" : "Default Ultrawork"
    const categorySchemaStatus = delegationCategory ? (categoryRegistered ? "yes" : "no") : "not applicable"
    const report = ["# Rigel V2 native delegation contract", "", "- Real isolated V2 server: yes.", `- Mode: ${backgroundMode ? "background handoff" : "foreground"}.`, `- Ultrawork activation: ${activation}.`, `- Native runtime loaded: ${runtimeLoaded ? "yes" : "no"}.`, `- ${activation} reached the root model request: ${parentReceivedUltrawork ? "yes" : "no"}.`, `- Default Ultrawork stayed out of the child: ${childDidNotReceiveUltrawork ? "yes" : "no"}.`, `- Agent manifest registered multiple specialists through agent.transform: ${registeredSpecialistsVisible ? "yes" : "no"}.`, `- Parent invoked rigel_task: ${invokedTask ? "yes" : "no"}.`, `- Selected route: ${delegationCategory ? `category ${delegationCategory}` : `specialist ${delegationAgent}`}.`, `- Selected category is visible in the actual tool schema: ${categorySchemaStatus}.`, `- Selected agent resolved: ${resolved ? "yes" : "no"}.`, `- Child is linked to its parent session: ${parentLinked ? "yes" : "no"}.`, `- Child ran without parent roster: ${childRanWithoutRoster ? "yes" : "no"}.`, `- Child completed: ${childCompleted ? "yes" : "no"}.`, `- Parent received the child's visible text: ${parentReceivedChildText ? "yes" : "no"}.`, `- Task resume requested: ${resumeMode ? "yes" : "not exercised"}.`, `- Existing child reused after resume: ${resumeMode ? (resumeRequested && resumedChildRequest > 0 ? "yes" : "no") : "not exercised"}.`, `- Parent completed after delegation: ${completed ? "yes" : "no"}.`].join("\n") + "\n"
    writeEvidence("validation.md", report)
    process.stdout.write(report)
    if (!runtimeLoaded || !parentReceivedUltrawork || !childDidNotReceiveUltrawork || !registeredSpecialistsVisible || !invokedTask || !resolved || !categoryRegistered || !parentLinked || !childRanWithoutRoster || !childCompleted || !parentReceivedChildText || (resumeMode && (!resumeRequested || resumedChildRequest === 0)) || !completed) process.exitCode = 1
  } catch (error) {
    writeEvidence("startup-failure.txt", logs.join(""))
    writeEvidence("provider-trace.jsonl", fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : "")
    throw error
  } finally {
    server.kill("SIGTERM")
    provider.kill("SIGTERM")
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}
