#!/usr/bin/env node
/**
 * T2.1 compaction experiment against the REAL OpenCode V2 binary in an
 * isolated sandbox. Two experiments run in one hermetic drive:
 *
 *   A) Does a `session.hook("compaction")` that mutates `event.messages`
 *      reach the real compaction provider request (strategy A1), or must
 *      Rigel continuity be injected at the `http.request` boundary (A2)?
 *      Prior evidence: mutating `event.system` does NOT reach the provider.
 *   B) Does V2 preserve agent / model / tools across a native compaction,
 *      or does Rigel need its own checkpoint?
 *
 * This is an EXPERIMENT, not a pass/fail gate: the drive must complete and a
 * verdict must be recorded, but the A1/A2/B outcomes are observations. Exit 0
 * when the drive completed, exit 1 only on drive failure. `--self-test` mode
 * validates pure logic only and never spawns OpenCode.
 *
 * Isolation boundary: `.omo/rules/protect-opencode-v1.md`. The sandbox comes
 * from `buildIsolatedV2Env`; every state root points inside the disposable
 * mkdtemp directory, never at the real user installation.
 */
import childProcess from "node:child_process"
import { buildIsolatedV2Env } from "./isolated-v2-env.mjs"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const binary = process.env.RIGEL_OPENCODE_V2_BIN ?? path.join(os.homedir(), ".opencode/bin/opencode")
const providerPort = 41374
const serverPort = 41375
const url = `http://127.0.0.1:${serverPort}`
const password = "rigel-v2-t21-compaction-experiment"
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
const evidence = path.join(root, ".omo/evidence/20261006-t21-compaction/experiment")

const MARKER = "RIGEL_T21_EVENT_MESSAGES_MARKER"
const COMPACTION_SUMMARY_PREFIXES = [
  "You MUST summarize",
  "Update the existing checkpoint",
  "The previous response did not fill",
]

// ---------------------------------------------------------------------------
// Pure helpers (unit-checked by --self-test, reused by the live verdicts).
// ---------------------------------------------------------------------------

function contentToText(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part
        if (part && typeof part === "object") return part.text || part.content || ""
        return ""
      })
      .join("")
  }
  if (content && typeof content === "object") return content.text || content.content || ""
  return ""
}

/**
 * Extracts the last user message text from either provider body shape: chat
 * (`messages[]`) or responses (`input[]` / string `input`). Returns "" when no
 * user message is present; never throws.
 */
function latestUserOf(body) {
  if (body && typeof body.input === "string") return body.input
  const items = Array.isArray(body && body.messages)
    ? body.messages
    : Array.isArray(body && body.input)
      ? body.input
      : []
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (!item || typeof item !== "object" || item.role !== "user") continue
    return contentToText(item.content)
  }
  return ""
}

function isCompactionSummaryText(text) {
  return typeof text === "string" && COMPACTION_SUMMARY_PREFIXES.some((prefix) => text.startsWith(prefix))
}

function countMatches(text, needle) {
  let count = 0
  let index = String(text).indexOf(needle)
  while (index !== -1) {
    count += 1
    index = String(text).indexOf(needle, index + needle.length)
  }
  return count
}

function parseTraceLine(line) {
  const trimmed = String(line ?? "").trim()
  if (trimmed.length === 0) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function traceEntries(traceText) {
  return String(traceText ?? "")
    .split("\n")
    .map(parseTraceLine)
    .filter(Boolean)
}

/**
 * Parses the JSON object attached to a log marker even when the log line has
 * a timestamp/level prefix and trailing text.
 */
function jsonAfterMarker(line, marker) {
  const at = String(line).indexOf(marker)
  if (at === -1) return null
  const rest = String(line).slice(at + marker.length)
  const start = rest.indexOf("{")
  const end = rest.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(rest.slice(start, end + 1))
  } catch {
    return null
  }
}

function computeHttpObservation(logText) {
  const observations = String(logText ?? "")
    .split("\n")
    .map((line) => jsonAfterMarker(line, "RIGEL_T21_HTTP_REQUEST="))
    .filter(Boolean)
  const keySet = new Set()
  for (const observation of observations) {
    if (!Array.isArray(observation.keys)) continue
    for (const key of observation.keys) keySet.add(key)
  }
  const kindSet = new Set()
  for (const observation of observations) {
    if (observation.kind === null || observation.kind === undefined) continue
    kindSet.add(observation.kind)
  }
  return {
    keys: [...keySet].sort(),
    kinds: [...kindSet].sort(),
    count: observations.length,
  }
}

/**
 * Experiment A1: a compaction request (latest user text starts with a
 * compaction summary prefix) whose serialized body carries the injected
 * marker. That would prove `event.messages` mutation reaches the provider.
 */
function computeA1(traceText) {
  return traceEntries(traceText).some(
    (entry) => isCompactionSummaryText(latestUserOf(entry)) && JSON.stringify(entry).includes(MARKER),
  )
}

/**
 * Experiment B: was the native `force_compact` tool present before and after
 * the compaction? Compares the last primary request before the first
 * compaction entry with the first primary request after it.
 */
function computeToolsSurvive(traceText) {
  const entries = traceEntries(traceText)
  const compactionIndex = entries.findIndex((entry) => entry.responseKind === "compaction")
  if (compactionIndex === -1) {
    return { survived: false, preHasTaskTool: null, postHasTaskTool: null, reason: "no-compaction-request" }
  }
  const isPrimary = (entry) => entry.responseKind === "complete" || entry.responseKind === "delegate"
  let pre = null
  for (let index = compactionIndex - 1; index >= 0; index -= 1) {
    if (isPrimary(entries[index])) {
      pre = entries[index]
      break
    }
  }
  let post = null
  for (let index = compactionIndex + 1; index < entries.length; index += 1) {
    if (isPrimary(entries[index])) {
      post = entries[index]
      break
    }
  }
  const preHasTaskTool = pre ? pre.hasTaskTool === true : null
  const postHasTaskTool = post ? post.hasTaskTool === true : null
  return {
    survived: preHasTaskTool === true && postHasTaskTool === true,
    preHasTaskTool,
    postHasTaskTool,
    reason: null,
  }
}

function readSessionIdentity(record) {
  const data = record && typeof record === "object" && record.data && typeof record.data === "object" ? record.data : {}
  const agent = record && typeof record === "object" ? (record.agent ?? data.agent ?? null) : null
  const modelRaw = record && typeof record === "object" ? (record.model ?? data.model ?? record.modelID ?? data.modelID ?? null) : null
  const model = modelRaw && typeof modelRaw === "object" ? (modelRaw.id ?? modelRaw.modelID ?? modelRaw.name ?? null) : modelRaw
  return { agent: agent ?? null, model: model ?? null }
}

function parseJsonText(text) {
  try {
    return JSON.parse(String(text))
  } catch {
    return null
  }
}

function computeVerdicts({ traceText, logText, sessionBeforeText, sessionAfterText }) {
  const trace = String(traceText ?? "")
  const log = String(logText ?? "")
  const http = computeHttpObservation(log)
  const tools = computeToolsSurvive(trace)
  const a1Propagates = computeA1(trace)
  return {
    experimentA: {
      a1Propagates,
      a2Required: !a1Propagates,
      httpKeys: http.keys,
      httpKinds: http.kinds,
      httpRequestObservations: http.count,
      compactionEventSeen: log.includes("RIGEL_T21_COMPACTION_EVENT="),
      messagesMutatedSeen: log.includes("RIGEL_T21_MESSAGES_MUTATED="),
      kindCompactionObserved: http.kinds.includes("compaction"),
      summaryRequestInTrace: trace.includes("You MUST summarize")
        || trace.includes("Update the existing checkpoint")
        || trace.includes("The previous response did not fill"),
    },
    experimentB: {
      sessionBefore: readSessionIdentity(parseJsonText(sessionBeforeText)),
      sessionAfter: readSessionIdentity(parseJsonText(sessionAfterText)),
      toolsSurvive: tools.survived,
      preHasTaskTool: tools.preHasTaskTool,
      postHasTaskTool: tools.postHasTaskTool,
      checkpointNeeded: !tools.survived,
      reason: tools.reason,
    },
  }
}

// ---------------------------------------------------------------------------
// Self-test fixtures (synthetic, no spawn).
// ---------------------------------------------------------------------------

function syntheticTrace({ marker, postHasTaskTool }) {
  const compactionMessages = marker
    ? [
        { role: "user", content: `${MARKER}: block` },
        { role: "user", content: "You MUST summarize the conversation to continue." },
      ]
    : [{ role: "user", content: "You MUST summarize the conversation to continue." }]
  return [
    JSON.stringify({ requestCount: 1, responseKind: "title", hasTaskTool: true, messages: [{ role: "system", content: "You are a title generator" }] }),
    JSON.stringify({ requestCount: 2, responseKind: "delegate", hasTaskTool: true, messages: [{ role: "user", content: "Prepare to compact." }] }),
    JSON.stringify({ requestCount: 3, responseKind: "compaction", hasTaskTool: true, messages: compactionMessages }),
    JSON.stringify({ requestCount: 4, responseKind: "complete", hasTaskTool: postHasTaskTool, messages: [{ role: "user", content: "Use force_compact now." }] }),
  ].join("\n")
}

const SYNTHETIC_TRACE_WITH_MARKER = syntheticTrace({ marker: true, postHasTaskTool: true })
const SYNTHETIC_TRACE_WITHOUT_MARKER = syntheticTrace({ marker: false, postHasTaskTool: true })
const SYNTHETIC_TRACE_TOOLS_LOST = syntheticTrace({ marker: true, postHasTaskTool: false })

const SYNTHETIC_LOG = [
  "2026-10-06T00:00:00Z ERROR RIGEL_T21_HTTP_REQUEST=" + JSON.stringify({ keys: ["agent", "kind", "request"], kind: "chat", agent: null, hasMarker: false, shape: "chat", latestUserText: "Prepare to compact." }),
  "2026-10-06T00:00:01Z ERROR RIGEL_T21_HTTP_REQUEST=" + JSON.stringify({ keys: ["kind", "request"], kind: "responses", agent: "Build", hasMarker: true, shape: "responses", latestUserText: "You MUST summarize the conversation." }),
].join("\n")

// ---------------------------------------------------------------------------
// Inline test plugin (registered at setup; mutated event.messages + observer).
// ---------------------------------------------------------------------------

const PLUGIN_SOURCE = `export default {
  id: "rigel-t21-compaction-experiment",
  setup: async (context) => {
    await context.tool.transform((editor) => editor.add({
      name: "force_compact",
      options: { codemode: false },
      description: "Test-only native V2 compaction trigger.",
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_input, toolContext) => {
        await context.session.compact({ sessionID: toolContext.sessionID })
        return { content: "compaction started" }
      },
    }))
    await context.session.hook("compaction", async (event) => {
      const last = Array.isArray(event.messages) && event.messages.length > 0 ? event.messages[event.messages.length - 1] : null
      console.error("RIGEL_T21_COMPACTION_EVENT=" + JSON.stringify({
        keys: Object.keys(event).sort(),
        messageSample: last ? JSON.stringify(last).slice(0, 800) : null,
      }))
      event.messages.push({ role: "user", content: [{ type: "text", text: "RIGEL_T21_EVENT_MESSAGES_MARKER: [SYSTEM DIRECTIVE: OH-MY-OPENCODE - COMPACTION CONTEXT] test block" }] })
      console.error("RIGEL_T21_MESSAGES_MUTATED=")
    })
    const latestUserOf = (body) => {
      if (body && typeof body.input === "string") return body.input
      const items = Array.isArray(body && body.messages) ? body.messages
        : Array.isArray(body && body.input) ? body.input
        : []
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index]
        if (!item || typeof item !== "object" || item.role !== "user") continue
        const content = item.content
        if (typeof content === "string") return content
        if (Array.isArray(content)) {
          return content.map((part) => {
            if (typeof part === "string") return part
            if (part && typeof part === "object") return part.text || part.content || ""
            return ""
          }).join("")
        }
        if (content && typeof content === "object") return content.text || content.content || ""
        return ""
      }
      return ""
    }
    await context.session.hook("http.request", async (input) => {
      try {
        const body = await input.request.clone().json()
        const text = JSON.stringify(body)
        console.error("RIGEL_T21_HTTP_REQUEST=" + JSON.stringify({
          keys: Object.keys(input).sort(),
          kind: input.kind ?? null,
          agent: input.agent ?? null,
          hasMarker: text.includes("RIGEL_T21_EVENT_MESSAGES_MARKER"),
          shape: Array.isArray(body && body.messages) ? "chat" : (Array.isArray(body && body.input) ? "responses" : "unknown"),
          latestUserText: latestUserOf(body).slice(0, 200),
        }))
      } catch { /* request body was absent, streaming, or not JSON */ }
    })
  },
}
`

// ---------------------------------------------------------------------------
// Live drive.
// ---------------------------------------------------------------------------

function save(name, value) {
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(evidence, name), value, { mode: 0o600 })
}

function waitFor(check, message, timeout = 15_000) {
  const deadline = Date.now() + timeout
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        if (await check()) return resolve()
      } catch {
        /* not ready yet */
      }
      if (Date.now() >= deadline) return reject(new Error(message))
      setTimeout(attempt, 100)
    }
    attempt()
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Deterministic idle wait documented by the V2 server API
 * (`POST /api/experimental/session/{sessionID}/wait`, "Wait for a session
 * agent loop to become idle"). Replaces fixed sleep-polling between drive
 * steps. When the running binary does not expose the experimental endpoint,
 * the drive falls back to the bounded condition waits already in place and the
 * fallback is recorded in the verdict evidence.
 */
async function waitIdle(sessionID, timeout = 20_000) {
  try {
    await fetch(`${url}/api/experimental/session/${sessionID}/wait`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(timeout),
    })
    return "wait-endpoint"
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") return "wait-endpoint-timeout"
    return "unavailable-fallback-polling"
  }
}

async function api(pathname, init = {}) {
  const response = await fetch(`${url}${pathname}`, { ...init, headers: { authorization, ...init.headers } })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${pathname}: ${response.status} ${text}`)
  return text ? JSON.parse(text) : {}
}

async function tryApi(pathname, init = {}) {
  try {
    return await api(pathname, init)
  } catch {
    return null
  }
}

async function run(temporary) {
  const configHome = path.join(temporary, "config")
  const home = path.join(temporary, "home")
  const plugin = path.join(temporary, "plugin")
  const project = path.join(temporary, "project")
  const traceFile = path.join(temporary, "provider-trace.jsonl")
  fs.mkdirSync(path.join(configHome, "opencode"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.mkdirSync(plugin, { recursive: true, mode: 0o700 })
  fs.mkdirSync(project, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(plugin, "package.json"), JSON.stringify({ type: "module" }) + "\n", { mode: 0o600 })
  fs.writeFileSync(path.join(plugin, "index.js"), PLUGIN_SOURCE, { mode: 0o600 })
  fs.writeFileSync(
    path.join(configHome, "opencode/opencode.json"),
    JSON.stringify(
      {
        provider: {
          "rigel-fixture": {
            name: "Rigel fixture",
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "fixture" },
            models: {
              fixture: {
                name: "Fixture",
                tool_call: true,
                modalities: { input: ["text"], output: ["text"] },
                limit: { context: 1000000, output: 512 },
              },
            },
          },
        },
        model: "rigel-fixture/fixture",
        plugin: [plugin],
        default_agent: "Build",
        agent: { Build: { mode: "primary", model: "rigel-fixture/fixture" } },
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  )

  const env = { ...buildIsolatedV2Env({ sandbox: temporary, home: home }), OPENCODE_SERVER_PASSWORD: password }
  const providerEnv = {
    ...env,
    RIGEL_FAKE_MODEL_PORT: String(providerPort),
    RIGEL_FAKE_MODEL_TRACE: traceFile,
    RIGEL_FAKE_TASK_NAME: "force_compact",
    RIGEL_FAKE_TASK_ARGUMENTS: "{}",
    RIGEL_FAKE_PARENT_REPLY: "WORK_DONE",
  }
  const provider = childProcess.spawn(process.execPath, [path.join(root, "profiles/gabo/fixtures/fake-openai-native-delegation.mjs")], {
    env: providerEnv,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const server = childProcess.spawn(
    binary,
    ["--print-logs", "--log-level", "debug", "serve", "--hostname", "127.0.0.1", "--port", String(serverPort)],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
  )
  const logs = []
  const waitIdleOutcomes = []
  for (const stream of [provider.stdout, provider.stderr, server.stdout, server.stderr]) {
    stream?.on("data", (data) => logs.push(data.toString()))
  }

  try {
    await waitFor(
      () => fetch(`${url}/api/session/active`, { headers: { authorization } }).then((response) => response.ok),
      "V2 server did not start",
    )
    const created = await api("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "Build", location: { directory: root } }),
    })
    const sessionID = created.id ?? created.data?.id
    if (typeof sessionID !== "string") throw new Error("V2 did not create a session")

    const sessionBefore = await tryApi(`/api/session/${sessionID}`)
    save("session-before.json", JSON.stringify(sessionBefore ?? {}, null, 2) + "\n")

    await api(`/api/session/${sessionID}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Prepare to compact.", resume: true }),
    })
    await waitFor(
      () => fs.existsSync(traceFile) && fs.readFileSync(traceFile, "utf8").includes("\"responseKind\":\"title\""),
      "V2 title request did not finish",
    )
    // Deterministic idle wait (documented `session.wait` endpoint) before the
    // nudge run, so the compaction executes at a settled step boundary.
    waitIdleOutcomes.push(await waitIdle(sessionID))
    // The delegate tool call runs `session.compact`, which only executes the
    // summary at the NEXT step boundary. Wait for the first run to finish
    // (fixture parent reply) before nudging a new one.
    await waitFor(
      () => fs.existsSync(traceFile) && countMatches(fs.readFileSync(traceFile, "utf8"), "\"responseKind\":\"complete\"") >= 1,
      "first V2 run did not finish",
      20_000,
    ).catch(() => { /* first-run completion absent; continue to the nudge */ })

    // A second run advances the session to the compaction step boundary, so
    // the summary request (if any) reaches the provider here.
    await api(`/api/session/${sessionID}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Continue now.", resume: true }),
    })
    // Deterministic idle wait for the nudge run before reading the evidence.
    waitIdleOutcomes.push(await waitIdle(sessionID))
    // Absence of the hook event is a valid experimental outcome (A1 cannot
    // work), not a drive failure, so the wait is bounded and tolerated.
    await waitFor(
      () => logs.join("").includes("RIGEL_T21_COMPACTION_EVENT="),
      "V2 compaction hook did not run",
      15_000,
    ).catch(() => { /* compaction event absent; recorded in the verdict */ })
    // Wait for the compaction summary signal: an http.request observation with
    // kind "compaction" or a provider trace entry whose latest user text
    // carries a summary prefix. Absence after 30s is itself the A1 verdict.
    await waitFor(
      () => {
        const logText = logs.join("")
        const traceText = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : ""
        return logText.includes("\"kind\":\"compaction\"") || traceText.includes("You MUST summarize")
          || traceText.includes("Update the existing checkpoint") || traceText.includes("The previous response did not fill")
      },
      "V2 compaction summary request did not reach the provider",
      30_000,
    ).catch(() => { /* summary request absent; recorded in the verdict */ })
    // Wait for the post-compaction primary request so toolsSurvive compares
    // real primary turns on both sides of the summary.
    await waitFor(
      () => fs.existsSync(traceFile) && countMatches(fs.readFileSync(traceFile, "utf8"), "\"responseKind\":\"complete\"") >= 2,
      "post-compaction run did not finish",
      20_000,
    ).catch(() => { /* post-compaction completion absent; recorded in the verdict */ })

    // Deterministic idle wait first; the bounded poll below stays as the
    // documented fallback when the experimental wait endpoint is unavailable.
    waitIdleOutcomes.push(await waitIdle(sessionID))
    let sessionAfter = null
    const pollDeadline = Date.now() + 10_000
    while (Date.now() < pollDeadline) {
      const record = await tryApi(`/api/session/${sessionID}`)
      if (record && typeof record === "object") {
        sessionAfter = record
        break
      }
      await sleep(500)
    }

    const traceText = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : ""
    const logText = logs.join("")
    const sessionAfterText = JSON.stringify(sessionAfter ?? {}, null, 2) + "\n"
    save("session-after.json", sessionAfterText)
    save("provider-trace.jsonl", traceText)
    save("server.txt", logText)

    const verdict = computeVerdicts({
      traceText,
      logText,
      sessionBeforeText: JSON.stringify(sessionBefore ?? {}, null, 2) + "\n",
      sessionAfterText,
    })
    verdict.drive = { waitIdleOutcomes: [...waitIdleOutcomes] }
    save("verdict.json", JSON.stringify(verdict, null, 2) + "\n")
    process.stdout.write("RIGEL_T21_VERDICT=" + JSON.stringify(verdict) + "\n")
    return 0
  } catch (error) {
    save("provider-trace.jsonl", fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : "")
    save("server.txt", logs.join(""))
    throw error
  } finally {
    server.kill("SIGTERM")
    provider.kill("SIGTERM")
  }
}

// ---------------------------------------------------------------------------
// Self-test: pure logic only, no spawn.
// ---------------------------------------------------------------------------

async function selfTest() {
  const results = []
  const check = (name, ok, detail = "") => results.push({ name, ok: Boolean(ok), detail })

  let pluginCompiles = false
  try {
    // A data-URL import validates the generated plugin ESM without spawning
    // OpenCode; the module top level only declares `export default`, no side
    // effects are executed.
    const module = await import("data:text/javascript," + encodeURIComponent(PLUGIN_SOURCE))
    pluginCompiles = Boolean(module?.default?.setup)
  } catch {
    pluginCompiles = false
  }
  check("inline plugin source compiles to an export default setup", pluginCompiles)

  check(
    "latestUserOf reads the last user message in chat shape",
    latestUserOf({ messages: [{ role: "system", content: "s" }, { role: "user", content: "hello" }, { role: "assistant", content: "a" }] }) === "hello",
  )
  check(
    "latestUserOf reads responses input parts",
    latestUserOf({ input: [{ role: "user", content: [{ type: "input_text", text: "hi there" }] }] }) === "hi there",
  )
  check("latestUserOf reads a string responses input", latestUserOf({ input: "plain input" }) === "plain input")
  check("latestUserOf returns empty with no user message", latestUserOf({ messages: [{ role: "system", content: "s" }] }) === "")
  check("latestUserOf tolerates null", latestUserOf(null) === "")

  check(
    "summary detection matches the three prefixes",
    isCompactionSummaryText("You MUST summarize the conversation") &&
      isCompactionSummaryText("Update the existing checkpoint now") &&
      isCompactionSummaryText("The previous response did not fill the checkpoint"),
  )
  check("summary detection rejects unrelated or null text", !isCompactionSummaryText("Prepare to compact.") && !isCompactionSummaryText(null))

  check("computeA1 is true when the compaction request carries the marker", computeA1(SYNTHETIC_TRACE_WITH_MARKER) === true)
  check("computeA1 is false when the compaction request lacks the marker", computeA1(SYNTHETIC_TRACE_WITHOUT_MARKER) === false)

  const http = computeHttpObservation(SYNTHETIC_LOG)
  check("computeHttpObservation unions and sorts keys", JSON.stringify(http.keys) === JSON.stringify(["agent", "kind", "request"]), JSON.stringify(http.keys))
  check("computeHttpObservation collects distinct kinds", JSON.stringify(http.kinds) === JSON.stringify(["chat", "responses"]), JSON.stringify(http.kinds))
  check("computeHttpObservation counts observations", http.count === 2)

  check(
    "readSessionIdentity reads nested data",
    JSON.stringify(readSessionIdentity({ data: { agent: "Build", model: "rigel-fixture/fixture" } })) ===
      JSON.stringify({ agent: "Build", model: "rigel-fixture/fixture" }),
  )
  check(
    "readSessionIdentity unwraps a model object",
    readSessionIdentity({ agent: "Build", model: { id: "rigel-fixture/fixture" } }).model === "rigel-fixture/fixture",
  )

  check("computeToolsSurvive is true when the tool survives compaction", computeToolsSurvive(SYNTHETIC_TRACE_WITH_MARKER).survived === true)
  check("computeToolsSurvive is false when the tool is lost", computeToolsSurvive(SYNTHETIC_TRACE_TOOLS_LOST).survived === false)

  const failed = results.filter((entry) => !entry.ok)
  for (const entry of results) {
    process.stdout.write(`${entry.ok ? "ok   " : "FAIL "}${entry.name}${entry.detail ? " :: " + entry.detail : ""}\n`)
  }
  if (failed.length > 0) {
    process.stderr.write(`RIGEL_T21_SELF_TEST=fail (${failed.length} check(s) failed)\n`)
    process.exit(1)
  }
  process.stdout.write("RIGEL_T21_SELF_TEST=pass\n")
  process.exit(0)
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest()
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-v2-t21-compaction-"))
  try {
    return await run(temporary)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

main()
  .then((code) => {
    if (typeof code === "number") process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write("RIGEL_T21_DRIVE_FAILED=" + (error && error.message ? error.message : String(error)) + "\n")
    process.exitCode = 1
  })
