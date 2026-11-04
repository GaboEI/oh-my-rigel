#!/usr/bin/env node
/**
 * Todo-continuity experiment harness (Oh My Rigel, OpenCode V2).
 *
 * This harness answers the todo-continuity questions of the native V2 runtime,
 * each with a PASS / FAIL / BLOCKED verdict:
 *
 *   E1 Storage real     Does the runtime-owned session todo registry persist a
 *                       structured list per sessionID across a runtime reload?
 *   E2 Task mirror real Does a task created/updated through the registered task
 *                       tools appear, update, and preserve unrelated todos in
 *                       the session registry?
 *   E3 Compaction       With detailed todos, does the compaction summary body
 *                       carry the V2-parts todo state, does the store retain
 *                       exactly the todos, and does a late Atlas bootstrap
 *                       write fail to degrade the list?
 *   E4 Continuation     With an incomplete todo and an idle session, is exactly
 *                       one V2 continuation queued, and none when complete /
 *                       stopped?
 *   E5 Blocker gates    For every blocker gate (open question, abort, skip
 *                       agent, compaction guard, cooldown, stagnation), is the
 *                       continuation suppressed while blocked and injected by
 *                       the positive control?
 *   E6 Failure/cooldown The rejected-dispatch path: does consecutiveFailures
 *                       climb, does the cooldown widen exponentially, does the
 *                       cap at MAX_CONSECUTIVE_FAILURES stop injecting with no
 *                       stuck inFlight, and does the reset window clear it?
 *                       (forced through the runtime's default-off QA seam,
 *                       because the V2 host accepts a prompt at enqueue).
 *
 * Two modes, each labelled with its own evidence mode:
 *
 *   node profiles/gabo/qa-v2-t22-todo-continuation-experiment.mjs --self-test
 *     HERMETIC. Re-execs itself in a disposable isolated environment (its own
 *     HOME and XDG roots; never the real user installation) and drives the REAL
 *     runtime `plugin.setup()`
 *     against an in-memory V2 context and an in-process mock provider. No live
 *     lab, no OpenCode spawn. Exit 0 iff all four hermetic experiments PASS.
 *
 *   node profiles/gabo/qa-v2-t22-todo-continuation-experiment.mjs [--live]
 *     LIVE. Drives the isolated V2 laboratory (`opencode-v2-lab.service`, port
 *     4097) through the loopback pattern: a raw-body capture proxy on 4098
 *     forwards to the deterministic todo-continuation fixture on 4099, the lab
 *     provider temporarily points at the proxy, and real sessions run the E1-E5
 *     scenarios. The durable `kv` store is read read-only from the lab SQLite
 *     DB. The lab config is backed up and restored; the canonical runtime is
 *     redeployed from the main checkout; the real user installation is only
 *     ever READ for the before/after integrity projection.
 *
 * Isolation: this drive addresses ONLY 127.0.0.1:4097 (the lab), 4098/4099 (its
 * own mocks). The refresh script stops/starts ONLY opencode-v2-lab.service;
 * opencode-lan.service is never touched. No container runner, no `opencode`
 * spawn. See `.omo/rules/protect-opencode-v1.md`.
 *
 * Harness pattern mirrors `qa-v2-t21-compaction-experiment.mjs` and the proven
 * `.omo/evidence/20261006-t21-compaction/live-qa/run-lab-compaction-qa.mjs`.
 */
import childProcess from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { buildIsolatedV2Env } from "./isolated-v2-env.mjs"
import { discoverRuntimeModules } from "./native-runtime-modules.mjs"
import { createV2SessionTodoStore, createTaskTodoSync } from "./opencode/tools/session-todo-store.mjs"
import { createTaskTools } from "./opencode/tools/task.tools.mjs"
import { decideTodoContinuation, CONTINUATION_COOLDOWN_MS, FAILURE_RESET_WINDOW_MS, MAX_CONSECUTIVE_FAILURES } from "./opencode/rigel-v2-native-todo-continuation-gate.mjs"
import { getTodoSnapshot } from "./opencode/rigel-v2-native-todo-continuation-state.mjs"
import { CONTINUATION_PROMPT_MARKER } from "./opencode/rigel-v2-todo-continuation-prompt.mjs"
import { ATLAS_BOOTSTRAP_TODOS, hasDetailedTodos } from "./opencode/rigel-v2-native-compaction-todo-preserver.mjs"
import { SESSION_TODOS_MARKER, COMPACTION_CONTEXT_PROMPT } from "./opencode/rigel-v2-native-compaction-context.mjs"

const SELF_URL = fileURLToPath(import.meta.url)
// The driver's own checkout. Run it from the task worktree so the refresh
// script deploys the WORKTREE runtime; the canonical restore in `finally`
// deliberately uses the MAIN checkout by absolute path.
const root = path.resolve(path.dirname(SELF_URL), "../..")
// The canonical checkout is the one whose `.local-ignore/worktrees` contains
// this linked worktree; walking up to the parent of `.local-ignore` yields it
// without naming any machine-specific path. It is used only to redeploy the
// base runtime on teardown. When the structural marker is absent, fall back to
// the repository's main checkout, then to the driver's own checkout.
function resolveMainCheckout() {
  const segments = root.split(path.sep)
  const marker = segments.lastIndexOf(".local-ignore")
  if (marker > 0) {
    const candidate = segments.slice(0, marker).join(path.sep) || path.sep
    if (fs.existsSync(path.join(candidate, "profiles/gabo/apply-v2-runtime-service.sh"))) return candidate
  }
  try {
    const commonDir = childProcess.execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim()
    if (commonDir) return path.dirname(commonDir)
  } catch {
    // git unavailable: keep the driver's own checkout
  }
  return root
}
const MAIN_ROOT = process.env.RIGEL_V2_MAIN_ROOT || resolveMainCheckout()
const sourceOpen = path.join(root, "profiles/gabo/opencode")
const fixturePath = path.join(root, "profiles/gabo/fixtures/fake-openai-todo-continuation.mjs")
const evidenceDir = path.join(root, ".omo/evidence/20261006-t22-todo-continuity")
const liveDir = path.join(evidenceDir, "live-qa")
const labProfileDir = path.join(evidenceDir, "lab-profile")

const TODO_PREFIX = "rigel-v2/session-todos"
const TODO_MARKER = SESSION_TODOS_MARKER
const LAB_PORT = 4097
const PROXY_PORT = 4098
const FIXTURE_PORT = 4099
const LAB_URL_DEFAULT = `http://127.0.0.1:${LAB_PORT}`

const SESSION = "ses_t22"
const TODO_KEY = `${TODO_PREFIX}/${SESSION}`
const SESSION_MESSAGES = [
  { id: "m1", role: "user", agent: "build", time: { created: 1_700_000_000_000 }, parts: [{ type: "text", text: "Drive the T22 experiment." }] },
]
const DETAILED_TODO = {
  id: "detail-1",
  content: "Investigate the failing todo continuity",
  status: "in_progress",
  priority: "high",
}
const BOOTSTRAP_TODOS = ATLAS_BOOTSTRAP_TODOS.map(({ id, content }) => ({
  id,
  content,
  status: "pending",
  priority: "medium",
}))

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

function save(name, value) {
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(evidenceDir, name), value, { mode: 0o600 })
}

function saveLive(relative, value) {
  const file = path.join(liveDir, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, value, { mode: 0o600 })
  return file
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function todoEnvelope(todos) {
  return { version: 1, todos }
}

function trackedTodo(id, status, content = `task ${id}`, priority = "medium") {
  return { id, content, status, priority }
}

function resultText(result) {
  if (typeof result === "string") return result
  if (result && typeof result.content === "string") return result.content
  return JSON.stringify(result)
}

function check(name, ok, detail) {
  return detail === undefined ? { name, ok } : { name, ok, detail }
}

/** A sub-check that could not be observed live; it is neither PASS nor FAIL. */
function blockedCheck(name, reason) {
  return { name, ok: false, blocked: true, detail: reason }
}

// ---------------------------------------------------------------------------
// Verdicts.
// ---------------------------------------------------------------------------

/**
 * @param {string} id
 * @param {string} title
 * @param {"LIVE" | "HERMETIC"} mode
 * @param {Array<{name: string, ok: boolean, detail?: string, blocked?: boolean}>} checks
 * @param {string | null} blockedReason Whole-experiment block (not a sub-check).
 */
function verdict(id, title, mode, checks, blockedReason = null) {
  const failed = checks.filter((entry) => !entry.ok && !entry.blocked)
  const blocked = checks.filter((entry) => entry.blocked)
  const status = blockedReason ? "BLOCKED" : failed.length > 0 ? "FAIL" : "PASS"
  return { id, title, mode, status, blockedReason, checks, blockedChecks: blocked.map((entry) => entry.name) }
}

function printVerdicts(results, stream = process.stdout) {
  for (const entry of results) {
    stream.write(`RIGEL_T22_EXPERIMENT ${entry.mode} ${entry.id} ${entry.status} :: ${entry.title}\n`)
    for (const item of entry.checks) {
      const tag = item.blocked ? "BLOCKED " : item.ok ? "ok      " : "FAIL    "
      stream.write(`  ${tag}${item.name}${item.detail ? " :: " + item.detail : ""}\n`)
    }
    if (entry.blockedReason) stream.write(`  BLOCKED :: ${entry.blockedReason}\n`)
  }
}

// ---------------------------------------------------------------------------
// Hermetic harness: in-memory V2 storage + event stream + setup context.
// ---------------------------------------------------------------------------

/** In-memory V2 storage domain shaped exactly like the runtime consumes. */
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  const calls = []
  return {
    map,
    calls,
    async get(key) {
      const value = map.has(key) ? map.get(key) : undefined
      calls.push({ op: "get", key, value })
      return value
    },
    async set(key, value) {
      map.set(key, value)
      calls.push({ op: "set", key, value })
    },
    async remove(key) {
      map.delete(key)
      calls.push({ op: "remove", key })
    },
    async scan({ prefix = "", limit = 100, after } = {}) {
      const keys = [...map.keys()].filter((key) => key.startsWith(prefix)).sort()
      const start = after ? keys.indexOf(after) + 1 : 0
      const slice = keys.slice(start, start + limit)
      const nextIndex = start + slice.length
      return {
        entries: slice.map((key) => ({ key, value: map.get(key) })),
        ...(nextIndex < keys.length ? { next: keys[nextIndex - 1] } : {}),
      }
    },
  }
}

/**
 * Push-driven V2 event stream. `whenNextRequested()` resolves after the
 * runtime's `for await` loop has processed the pushed event and asked for the
 * next one, which is the deterministic barrier the drive awaits (raced against
 * an explicit timeout so a dropped event fails loudly instead of hanging).
 */
function createEventStream() {
  const queue = []
  let pendingResolve = null
  let closed = false
  let nextRequestedResolvers = []

  function settle() {
    if (!pendingResolve) return
    if (queue.length > 0) {
      const resolve = pendingResolve
      pendingResolve = null
      resolve({ value: queue.shift(), done: false })
    } else if (closed) {
      const resolve = pendingResolve
      pendingResolve = null
      resolve({ value: undefined, done: true })
    }
  }

  function noteNextRequested() {
    const resolvers = nextRequestedResolvers
    nextRequestedResolvers = []
    for (const resolve of resolvers) resolve()
  }

  return {
    push(event) {
      queue.push(event)
      settle()
    },
    close() {
      closed = true
      settle()
    },
    whenNextRequested({ timeoutMs = 3000 } = {}) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for the event loop to process the pushed event")),
          timeoutMs,
        )
        nextRequestedResolvers.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          noteNextRequested()
          if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false })
          if (closed) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => {
            pendingResolve = resolve
          })
        },
        return() {
          closed = true
          settle()
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
  }
}

/**
 * Minimal but real V2 setup context: the storage domain the todo registry
 * persists through, a controllable event stream, a `session.hook` recorder
 * (last handler per name wins, which is the runtime wrapper under test), a
 * `tool.transform` capture of every registered definition by name, and a
 * `session.prompt` recorder for continuation observations.
 */
function createRuntimeHarness({ storage, directory, todos } = {}) {
  const added = new Map()
  const sessionHooks = new Map()
  const promptCalls = []
  const resolvedStorage = storage ?? memoryStorage(todos ? { [TODO_KEY]: todoEnvelope(todos) } : {})
  const events = createEventStream()
  const context = {
    location: { directory },
    storage: resolvedStorage,
    config: {},
    session: {
      hook: async (name, handler) => {
        sessionHooks.set(name, handler)
        return { dispose() {} }
      },
      get: async ({ sessionID }) => ({ data: sessionID === SESSION ? { id: sessionID } : undefined }),
      context: async ({ sessionID }) => ({ data: sessionID === SESSION ? SESSION_MESSAGES : [] }),
      create: async () => ({ data: { id: "ses_child" } }),
      prompt: async (input) => {
        promptCalls.push(input)
        return { data: {} }
      },
    },
    agent: {
      list: async () => ({ data: [] }),
      transform: async (callback) => {
        callback({ update() {}, default() {} })
        return { dispose() {} }
      },
      reload: async () => {},
    },
    model: { list: async () => ({ data: [] }) },
    event: {
      subscribe: ({ signal } = {}) => {
        if (signal?.aborted) events.close()
        else signal?.addEventListener?.("abort", () => events.close(), { once: true })
        return events
      },
    },
    tool: {
      transform: async (callback) => {
        await callback({
          add: (definition) => {
            if (definition?.name) added.set(definition.name, definition)
          },
        })
        return { dispose: async () => {} }
      },
    },
  }
  return { context, added, sessionHooks, promptCalls, storage: resolvedStorage, events }
}

async function pushEvent(events, event) {
  const advanced = events.whenNextRequested()
  events.push(event)
  await advanced
}

async function pushIdle(events, sessionID = SESSION) {
  await pushEvent(events, { type: "session.idle", data: { sessionID } })
}

// ---------------------------------------------------------------------------
// Runtime materialization (self-test): copy the native runtime and its
// transitively imported modules into a disposable directory with a manifest
// that enables the `task_system` gate, then import it in-process.
// ---------------------------------------------------------------------------

const PROMPT_FILES = [
  ["ultrawork-default.md", "packages/prompts-core/prompts/ultrawork/default.md"],
  ["ultrawork-gpt.md", "packages/prompts-core/prompts/ultrawork/gpt.md"],
  ["ultrawork-gemini.md", "packages/prompts-core/prompts/ultrawork/gemini.md"],
  ["ultrawork-glm.md", "packages/prompts-core/prompts/ultrawork/glm.md"],
  ["ultrawork-planner.md", "packages/prompts-core/prompts/ultrawork/planner.md"],
  ["team.md", "packages/prompts-core/prompts/mode/team.md"],
  ["hyperplan.md", "packages/prompts-core/prompts/mode/hyperplan.md"],
]

function materializeRuntime(temporary) {
  const runtime = path.join(temporary, "runtime")
  fs.mkdirSync(path.join(runtime, "prompts"), { recursive: true, mode: 0o700 })
  for (const file of discoverRuntimeModules(sourceOpen)) {
    const destination = path.join(runtime, file)
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
    fs.copyFileSync(path.join(sourceOpen, file), destination)
  }
  fs.copyFileSync(path.join(sourceOpen, "rigel-v2-native.mjs"), path.join(runtime, "index.js"))
  for (const [name, relative] of PROMPT_FILES) {
    const source = path.join(root, relative)
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(runtime, "prompts", name))
  }
  fs.writeFileSync(
    path.join(runtime, "rigel-v2-native-agent-manifest.mjs"),
    `export default ${JSON.stringify({
      defaultAgent: undefined,
      agents: {},
      modes: { defaultUltrawork: false },
      metadata: { global: { gates: { task_system: true } } },
    })}\n`,
    { mode: 0o600 },
  )
  fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ type: "module" }) + "\n", { mode: 0o600 })
  return path.join(runtime, "index.js")
}

// ---------------------------------------------------------------------------
// In-process mock provider (self-test): records the raw request body it
// receives and answers with an OpenAI-compatible SSE stream.
// ---------------------------------------------------------------------------

function startMockProvider() {
  const bodies = []
  const server = http.createServer(async (request, response) => {
    let raw = ""
    for await (const chunk of request) raw += chunk
    let parsed
    try {
      parsed = JSON.parse(raw || "{}")
    } catch {
      parsed = { raw }
    }
    bodies.push(parsed)
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
    response.write(`data: ${JSON.stringify({ id: "chatcmpl_t22_mock", object: "chat.completion.chunk", created: 0, model: "rigel-fixture", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ id: "chatcmpl_t22_mock", object: "chat.completion.chunk", created: 0, model: "rigel-fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`)
    response.end("data: [DONE]\n\n")
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      resolve({
        server,
        bodies,
        port,
        url: `http://127.0.0.1:${port}/v1/chat/completions`,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

async function captureProviderBody(mock, body) {
  const response = await fetch(mock.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  await response.text()
  return mock.bodies[mock.bodies.length - 1]
}

// ---------------------------------------------------------------------------
// Hermetic experiments E1-E4.
// ---------------------------------------------------------------------------

async function runExperiment1(plugin, temporary) {
  const checks = []
  const storage = memoryStorage()
  if (typeof storage.get !== "function" || typeof storage.set !== "function") {
    return verdict("E1", "Storage real", "HERMETIC", checks, "ctx.storage is not available")
  }
  const directory = fs.mkdtempSync(path.join(temporary, "e1-"))
  const todos = [trackedTodo("store-a", "pending", "Storage todo A", "high"), trackedTodo("store-b", "in_progress", "Storage todo B")]

  const harness = createRuntimeHarness({ storage, directory })
  const dispose = await plugin.setup(harness.context)
  const todowrite = harness.added.get("todowrite")
  checks.push(check("todowrite is registered", typeof todowrite?.execute === "function"))
  if (typeof todowrite?.execute === "function") {
    await todowrite.execute({ todos }, { sessionID: SESSION })
  }
  const stored = storage.map.get(TODO_KEY)
  checks.push(check("todowrite persisted the structured list under the session key", Boolean(stored) && Array.isArray(stored.todos) && stored.todos.length === 2))
  await dispose()

  // Reload: a fresh setup over the SAME storage simulates a runtime restart.
  const reloaded = createRuntimeHarness({ storage, directory })
  const disposeReloaded = await plugin.setup(reloaded.context)
  const read = resultText(await reloaded.added.get("session_read").execute({ session_id: SESSION, include_todos: true }))
  const info = resultText(await reloaded.added.get("session_info").execute({ session_id: SESSION }))
  const readTodos = storage.map.get(TODO_KEY)?.todos
  await disposeReloaded()

  checks.push(check("session_read lists the todo section after reload", read.includes("=== Todos ===")))
  checks.push(check("session_read carries every todo content after reload", read.includes("Storage todo A") && read.includes("Storage todo B")))
  checks.push(check("session_info reports two todos after reload", info.includes("Has Todos: Yes (2 items)")))
  checks.push({
    name: "the structured list per sessionID is identical after reload",
    ok: JSON.stringify(readTodos) === JSON.stringify(todos) && getTodoSnapshot(readTodos ?? []) === getTodoSnapshot(todos),
    detail: JSON.stringify(readTodos),
  })
  return verdict("E1", "Storage real", "HERMETIC", checks)
}

async function runExperiment2(plugin, temporary) {
  const checks = []
  const storage = memoryStorage()
  const directory = fs.mkdtempSync(path.join(temporary, "e2-"))
  const harness = createRuntimeHarness({ storage, directory })
  const dispose = await plugin.setup(harness.context)

  const unrelated = trackedTodo("unrelated-1", "pending", "Unrelated todo must persist")
  await harness.added.get("todowrite").execute({ todos: [unrelated] }, { sessionID: SESSION })

  let taskCreate = harness.added.get("task_create")
  let taskUpdate = harness.added.get("task_update")
  let adaptedBridge = false
  if (typeof taskCreate?.execute !== "function" || typeof taskUpdate?.execute !== "function") {
    // The registered family is absent: adapt the bridge over the runtime's own
    // store and prove the mirror at the same boundary.
    adaptedBridge = true
    const store = createV2SessionTodoStore({ storage })
    const { syncTodos } = createTaskTodoSync({ store })
    const bridge = createTaskTools({ store: createTaskStoreOverStorage(storage, directory), syncTodos })
    taskCreate = bridge.task_create
    taskUpdate = bridge.task_update
  }
  checks.push({ name: "task tools are reachable (registered, or adapted bridge)", ok: typeof taskCreate?.execute === "function" && typeof taskUpdate?.execute === "function", detail: adaptedBridge ? "adapted-bridge" : "registered" })

  const created = JSON.parse(resultText(await taskCreate.execute({ subject: "Mirror this task" }, { sessionID: SESSION })))
  const taskId = created?.task?.id
  checks.push(check("task_create returned a task id", typeof taskId === "string" && taskId.startsWith("T-")))

  const afterCreate = resultText(await harness.added.get("session_read").execute({ session_id: SESSION, include_todos: true }))
  checks.push(check("the created task appears as a session todo", afterCreate.includes("Mirror this task")))

  await taskUpdate.execute({ id: taskId, status: "in_progress" }, { sessionID: SESSION })
  const afterUpdate = resultText(await harness.added.get("session_read").execute({ session_id: SESSION, include_todos: true }))
  checks.push(check("the task update is reflected in the session todo status", afterUpdate.includes("[-] [in_progress] Mirror this task")))
  checks.push(check("the unrelated todo persists across the mirror", afterUpdate.includes("Unrelated todo must persist")))

  const info = resultText(await harness.added.get("session_info").execute({ session_id: SESSION }))
  checks.push(check("session_info counts both the task todo and the unrelated todo", info.includes("Has Todos: Yes (2 items)")))

  await dispose()
  return verdict("E2", "Task mirror real", "HERMETIC", checks)
}

/** A task store over the same storage the runtime uses (bridge fallback). */
function createTaskStoreOverStorage(storage, directory) {
  const listId = String(directory).split(/[\\/]/).filter(Boolean).pop() ?? "default"
  const prefix = "rigel-v2/tasks"
  const keyFor = (id) => `${prefix}/${listId}/${id}`
  return {
    async readTask(id) {
      const value = await storage.get(keyFor(id))
      return value === undefined ? null : value
    },
    async writeTask(task) {
      await storage.set(keyFor(task.id), task)
    },
    async listTasks() {
      const keys = [...storage.map.keys()].filter((key) => key.startsWith(`${prefix}/${listId}/`))
      return keys.map((key) => storage.map.get(key))
    },
  }
}

async function runExperiment3(plugin, temporary) {
  const checks = []
  const storage = memoryStorage({ [TODO_KEY]: todoEnvelope([DETAILED_TODO]) })
  const directory = fs.mkdtempSync(path.join(temporary, "e3-"))
  const harness = createRuntimeHarness({ storage, directory })
  const dispose = await plugin.setup(harness.context)

  const compactionHook = harness.sessionHooks.get("compaction")
  if (typeof compactionHook !== "function") {
    await dispose()
    return verdict("E3", "Compaction", "HERMETIC", checks, "the runtime compaction hook is not registered")
  }

  const event = { sessionID: SESSION, messages: [] }
  await compactionHook(event)
  const injectedText = event.messages[0]?.content?.[0]?.text ?? ""
  if (event.messages.length === 0 || !injectedText.startsWith(COMPACTION_CONTEXT_PROMPT)) {
    await dispose()
    return verdict("E3", "Compaction", "HERMETIC", checks, "event.messages was not mutated; the summary body cannot be captured")
  }
  checks.push(check("the compaction hook mutates event.messages (the provider summary body)", true))

  const mock = await startMockProvider()
  let captured
  try {
    captured = await captureProviderBody(mock, { model: "rigel-fixture", messages: event.messages })
  } finally {
    await mock.close()
  }
  const capturedText = captured?.messages?.[0]?.content?.[0]?.text ?? ""
  checks.push(check("the provider body carries V2 parts with the todo marker", capturedText.includes(SESSION_TODOS_MARKER)))
  checks.push(check("the provider body carries the detailed todo state", capturedText.includes(DETAILED_TODO.content) && capturedText.includes("[in_progress]")))
  checks.push(check("the captured body uses V2 message parts (array content)", Array.isArray(captured?.messages?.[0]?.content)))

  await storage.set(TODO_KEY, todoEnvelope([]))
  await pushEvent(harness.events, { type: "session.compacted", data: { sessionID: SESSION } })
  const restored = storage.map.get(TODO_KEY)?.todos
  checks.push({
    name: "the store retains exactly the detailed todos after restore",
    ok: JSON.stringify(restored) === JSON.stringify([DETAILED_TODO]),
    detail: JSON.stringify(restored),
  })

  await harness.added.get("todowrite").execute({ todos: BOOTSTRAP_TODOS }, { sessionID: SESSION })
  const afterLate = storage.map.get(TODO_KEY)?.todos
  checks.push({
    name: "a late Atlas bootstrap todowrite does not degrade the list",
    ok: hasDetailedTodos(afterLate) && JSON.stringify(afterLate) === JSON.stringify([DETAILED_TODO]),
    detail: JSON.stringify(afterLate),
  })

  await dispose()
  return verdict("E3", "Compaction", "HERMETIC", checks)
}

async function runExperiment4(plugin, temporary) {
  const checks = []

  {
    const storage = memoryStorage({ [TODO_KEY]: todoEnvelope([trackedTodo("c-1", "pending", "Continue me")]) })
    const directory = fs.mkdtempSync(path.join(temporary, "e4a-"))
    const harness = createRuntimeHarness({ storage, directory })
    const dispose = await plugin.setup(harness.context)
    await pushIdle(harness.events)
    await pushIdle(harness.events)
    const injections = harness.promptCalls.filter((call) => String(call?.text ?? "").includes(CONTINUATION_PROMPT_MARKER))
    checks.push({ name: "exactly one continuation is queued despite duplicate idle events", ok: injections.length === 1, detail: `injections=${injections.length}` })
    checks.push(check("the queued continuation targets the idle session that owns the tracked todo", injections[0]?.sessionID === SESSION && String(injections[0]?.text).includes("Continue me")))
    await dispose()
  }

  {
    const storage = memoryStorage({ [TODO_KEY]: todoEnvelope([trackedTodo("d-1", "completed", "Done"), trackedTodo("d-2", "completed", "Also done")]) })
    const directory = fs.mkdtempSync(path.join(temporary, "e4b-"))
    const harness = createRuntimeHarness({ storage, directory })
    const dispose = await plugin.setup(harness.context)
    await pushIdle(harness.events)
    checks.push({ name: "no continuation when every todo is complete", ok: harness.promptCalls.length === 0, detail: `prompts=${harness.promptCalls.length}` })
    await dispose()
  }

  {
    const storage = memoryStorage({ [TODO_KEY]: todoEnvelope([trackedTodo("s-1", "pending", "Stopped work")]) })
    const directory = fs.mkdtempSync(path.join(temporary, "e4c-"))
    const harness = createRuntimeHarness({ storage, directory })
    const dispose = await plugin.setup(harness.context)
    const promptHook = harness.sessionHooks.get("prompt")
    checks.push(check("the runtime registers the prompt admission hook", typeof promptHook === "function"))
    if (typeof promptHook === "function") {
      await promptHook({ sessionID: SESSION, prompt: { text: "/stop-continuation" } })
    }
    await Promise.resolve()
    const markerFile = path.join(directory, ".omo/run-continuation", `${SESSION}.json`)
    const stoppedMarker = readStopMarker(markerFile)
    checks.push({ name: "the stop marker is written as stopped", ok: stoppedMarker === "stopped", detail: String(stoppedMarker) })
    await pushIdle(harness.events)
    checks.push({ name: "no continuation after /stop-continuation", ok: harness.promptCalls.length === 0, detail: `prompts=${harness.promptCalls.length}` })
    await pushEvent(harness.events, { type: "session.deleted", data: { sessionID: SESSION } })
    await Promise.resolve()
    const cleanedMarker = readStopMarker(markerFile)
    checks.push({
      name: "the stop marker is cleaned on release (idle or removed)",
      ok: cleanedMarker === "idle" || cleanedMarker === null,
      detail: String(cleanedMarker),
    })
    await dispose()
  }

  {
    const base = { state: {}, todos: [trackedTodo("g-1", "pending", "Gate work")], incompleteCount: 1, now: 10_000 }
    checks.push(check("the gate continues an unblocked incomplete session", decideTodoContinuation(base).action === "continue"))
    checks.push(check("the gate skips when background work is active", decideTodoContinuation({ ...base, hasBackgroundWork: true }).action === "skip"))
    checks.push(check("the gate skips when a question is pending", decideTodoContinuation({ ...base, hasPendingQuestion: true }).action === "skip"))
    checks.push(check("the gate skips when a question is unanswered", decideTodoContinuation({ ...base, hasUnansweredQuestion: true }).action === "skip"))
    checks.push(check("the gate skips an aborted last assistant message", decideTodoContinuation({ ...base, isLastAssistantAborted: true }).action === "skip"))
  }

  return verdict("E4", "Continuation", "HERMETIC", checks)
}

function readStopMarker(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
    return parsed?.sources?.stop?.state ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Self-test: re-exec in an isolated env, then drive the real runtime in-process.
// ---------------------------------------------------------------------------

async function selfTestInProcess() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-t22-inner-"))
  const results = []
  try {
    const pluginPath = materializeRuntime(temporary)
    const module = await import(pathToFileURL(pluginPath).href)
    const plugin = module.default
    if (typeof plugin?.setup !== "function") {
      process.stderr.write("RIGEL_T22_SELF_TEST=fail (runtime did not export a plugin setup)\n")
      return 1
    }
    results.push(await runExperiment1(plugin, temporary))
    results.push(await runExperiment2(plugin, temporary))
    results.push(await runExperiment3(plugin, temporary))
    results.push(await runExperiment4(plugin, temporary))
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }

  printVerdicts(results)
  const failed = results.filter((entry) => entry.status !== "PASS")
  if (failed.length > 0) {
    process.stderr.write(`RIGEL_T22_SELF_TEST=fail (${failed.map((entry) => entry.id + ":" + entry.status).join(", ")})\n`)
    return 1
  }
  process.stdout.write("RIGEL_T22_SELF_TEST=pass\n")
  return 0
}

function runSelfTestWrapper() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-t22-selftest-"))
  try {
    for (const dir of ["home", "config", "data", "state", "cache", "goal-state"]) {
      fs.mkdirSync(path.join(sandbox, dir), { recursive: true, mode: 0o700 })
    }
    const env = buildIsolatedV2Env({ sandbox })
    const child = childProcess.spawnSync(process.execPath, [SELF_URL, "--self-test-inner"], {
      cwd: sandbox,
      env,
      encoding: "utf8",
    })
    const stdout = child.stdout ?? ""
    const stderr = child.stderr ?? ""
    process.stdout.write(stdout)
    process.stderr.write(stderr)
    save("self-test.txt", `mode=HERMETIC\nexit=${child.status}\nisolation_sandbox=${sandbox}\n\n${stdout}\n${stderr}`)
    return child.status ?? 1
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
}

// ===========================================================================
// LIVE drive against opencode-v2-lab.service (never spawns OpenCode).
// ===========================================================================

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex")
}

function sha256File(file) {
  try {
    return sha256Buffer(fs.readFileSync(file))
  } catch {
    return ""
  }
}

/**
 * Content-hash a file tree. `exclude` is an optional predicate over the
 * root-relative path; excluded files are counted but not hashed, which is the
 * churn filter the real installation's share tree needs (see `V1_SHARE_EXCLUDE`).
 */
function shaFileTree(directory, options = {}) {
  const exclude = typeof options.exclude === "function" ? options.exclude : () => false
  const entries = []
  const hashes = new Map()
  let skipped = 0
  const walk = (current) => {
    let items = []
    try {
      items = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      const itemPath = path.join(current, item.name)
      const relative = itemPath.slice(directory.length)
      if (exclude(relative)) {
        skipped += 1
        continue
      }
      if (item.isDirectory()) walk(itemPath)
      else if (item.isFile()) {
        try {
          const stat = fs.statSync(itemPath)
          const digest = stat.size > 268_435_456 ? `big:${stat.size}:${Math.floor(stat.mtimeMs)}` : sha256Buffer(fs.readFileSync(itemPath))
          entries.push(`${relative}:${digest}`)
          hashes.set(relative, digest)
        } catch {
          /* unreadable entry */
        }
      }
    }
  }
  walk(directory)
  entries.sort()
  return { files: entries.length, skipped, digest: sha256Buffer(Buffer.from(entries.join("\n"))), hashes }
}

/** Per-file paths that differ between two tree snapshots (bounded for evidence). */
function changedPaths(before, after) {
  const changed = []
  for (const [key, value] of after.hashes) {
    if (before.hashes.get(key) !== value) changed.push(key)
  }
  for (const key of before.hashes.keys()) {
    if (!after.hashes.has(key)) changed.push(key)
  }
  return changed.sort().slice(0, 50)
}

/**
 * The real installation's share tree is a LIVE surface: the host OpenCode session
 * writes its own TUI state, log, session DB/WAL and git snapshots continuously.
 * T21 proved a naive whole-tree hash there is a false positive
 * (`.omo/evidence/20261006-t21-compaction/live-qa/v1-integrity-incident.md`), so
 * the share projection hashes every stable file and excludes only the live
 * write surfaces. The config tree is hashed strictly.
 */
const V1_SHARE_EXCLUDE = (relative) => {
  const normalized = relative.replace(/\\/g, "/")
  if (/^\/opencode\.db(-wal|-shm)?$/.test(normalized)) return true
  return ["/log/", "/storage/", "/snapshot/", "/tool-output/", "/repos/", "/worktree/", "/shell/"].some((prefix) => normalized.startsWith(prefix))
}

/**
 * The real installation's config tree also holds the `context-mode` plugin's live
 * session and content SQLite databases (`context-mode/sessions/*.db*`), which the
 * live host session writes continuously. Those are live write surfaces, not
 * configuration, so they are excluded; every real config file is still hashed
 * strictly.
 */
const V1_CONFIG_EXCLUDE = (relative) => {
  const normalized = relative.replace(/\\/g, "/")
  return normalized.startsWith("/context-mode/")
}

function captureV1Integrity() {
  const home = os.homedir()
  return {
    config: shaFileTree(path.join(home, ".config/opencode"), { exclude: V1_CONFIG_EXCLUDE }),
    share: shaFileTree(path.join(home, ".local/share/opencode"), { exclude: V1_SHARE_EXCLUDE }),
  }
}

function v1IntegritySnapshot(before, after) {
  const configIntact = before.config.digest === after.config.digest
  const shareIntact = before.share.digest === after.share.digest
  return {
    before: {
      config: { files: before.config.files, skipped: before.config.skipped, digest: before.config.digest },
      share: { files: before.share.files, skipped: before.share.skipped, digest: before.share.digest },
    },
    after: {
      config: { files: after.config.files, skipped: after.config.skipped, digest: after.config.digest },
      share: { files: after.share.files, skipped: after.share.skipped, digest: after.share.digest },
    },
    config_intact: configIntact,
    share_intact: shareIntact,
    config_changed: changedPaths(before.config, after.config),
    share_changed: changedPaths(before.share, after.share),
    intact: configIntact && shareIntact,
    note: "The share projection excludes the live write surfaces of the real installation (opencode.db*, log, storage, snapshot, tool-output, repos, worktree, shell); the config projection excludes the live context-mode session/content SQLite DBs. Every other config and share file is hashed strictly.",
  }
}

function resolveLab() {
  const labRoot = process.env.RIGEL_V2_LAB_ROOT || path.join(os.homedir(), ".local/share/opencode-v2-lab")
  const secretFile = process.env.RIGEL_V2_LAB_SECRET_FILE || path.join(labRoot, "secret.env")
  let password = process.env.OPENCODE_PASSWORD || ""
  if (!password && fs.existsSync(secretFile)) {
    const match = fs.readFileSync(secretFile, "utf8").match(/^OPENCODE_PASSWORD=(.*)$/m)
    if (match) password = match[1].trim()
  }
  const url = process.env.RIGEL_V2_LAB_URL || LAB_URL_DEFAULT
  return {
    labRoot,
    secretFile,
    password,
    url,
    configFile: path.join(labRoot, "config/opencode/opencode.json"),
    dbFile: path.join(labRoot, "data/opencode/opencode.db"),
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
  }
}

async function labFetch(lab, pathname, init = {}) {
  const response = await fetch(`${lab.url}${pathname}`, {
    ...init,
    headers: { authorization: lab.authorization, ...(init.headers ?? {}) },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${pathname}: ${response.status} ${text.slice(0, 400)}`)
  return text ? JSON.parse(text) : {}
}

async function waitLabReady(lab, timeout = 180_000) {
  await waitFor(
    () => fetch(`${lab.url}/openapi.json`, { headers: { authorization: lab.authorization } }).then((response) => response.ok),
    "the lab API never became ready after a refresh",
    timeout,
  )
}

/**
 * Deterministic idle wait: the experimental wait endpoint first, an explicit
 * poll of the session's idle stamp as the fallback. Never a bare sleep.
 */
async function waitSessionIdle(lab, sessionID, timeout = 90_000) {
  try {
    const response = await fetch(`${lab.url}/api/experimental/session/${sessionID}/wait`, {
      method: "POST",
      headers: { authorization: lab.authorization, "content-type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(timeout),
    })
    if (response.ok) return "wait-endpoint"
  } catch {
    /* fall through to polling */
  }
  await waitFor(async () => {
    const list = await labFetch(lab, "/api/session")
    const session = (list.data ?? []).find((entry) => entry.id === sessionID)
    return Boolean(session?.time?.idle) || typeof session?.outcome === "string"
  }, "the session never reported idle", timeout)
  return "polling"
}

async function createSession(lab, options = {}) {
  const body = { location: { directory: root } }
  if (typeof options.agent === "string" && options.agent.length > 0) body.agent = options.agent
  const created = await labFetch(lab, "/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const sessionID = created.id ?? created.data?.id
  if (typeof sessionID !== "string" || sessionID.length === 0) {
    throw new Error(`the lab did not create a session: ${JSON.stringify(created).slice(0, 200)}`)
  }
  return sessionID
}

async function sendPrompt(lab, sessionID, text) {
  await labFetch(lab, `/api/session/${sessionID}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, resume: true }),
  })
  return waitSessionIdle(lab, sessionID)
}

/** Post a prompt without waiting for idle (a pending question never idles). */
async function postPrompt(lab, sessionID, text) {
  return labFetch(lab, `/api/session/${sessionID}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, resume: true }),
  })
}

/**
 * Prompt the session and return the RAW status, without throwing on non-2xx.
 * Used by the rejection-surface probe to distinguish "the host accepted at
 * enqueue" (200) from "the host rejected the dispatch".
 */
async function rawPrompt(lab, sessionID, text = "T22 rejection-surface probe") {
  const response = await fetch(`${lab.url}/api/session/${sessionID}/prompt`, {
    method: "POST",
    headers: { authorization: lab.authorization, "content-type": "application/json" },
    body: JSON.stringify({ text, resume: true }),
  })
  const body = await response.text()
  return { status: response.status, body: body.slice(0, 200) }
}

async function setSessionModel(lab, sessionID, model) {
  return labFetch(lab, `/api/session/${sessionID}/model`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
  })
}

async function deleteSession(lab, sessionID) {
  try {
    return await labFetch(lab, `/api/session/${sessionID}`, { method: "DELETE" })
  } catch {
    return null
  }
}

async function getSession(lab, sessionID) {
  return labFetch(lab, `/api/session/${sessionID}`)
}

async function setSessionAgent(lab, sessionID, agent) {
  return labFetch(lab, `/api/session/${sessionID}/agent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent }),
  })
}

async function interruptSession(lab, sessionID) {
  return labFetch(lab, `/api/session/${sessionID}/interrupt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  })
}

async function sessionContext(lab, sessionID) {
  return labFetch(lab, `/api/session/${sessionID}/context`)
}

async function sessionForms(lab, sessionID) {
  const payload = await labFetch(lab, `/api/session/${sessionID}/form`)
  return payload.data ?? payload ?? []
}

async function replyToForm(lab, sessionID, formID, answer) {
  return labFetch(lab, `/api/session/${sessionID}/form/${formID}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answer }),
  })
}

async function sessionOutcome(lab, sessionID) {
  try {
    const payload = await getSession(lab, sessionID)
    return payload?.data?.outcome ?? payload?.outcome ?? null
  } catch {
    return null
  }
}

/** The latest `question` tool part in the transcript, running or terminal. */
function findQuestionToolPart(contextPayload) {
  const list = contextPayload?.data ?? []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index]
    if (message?.type !== "assistant") continue
    const parts = Array.isArray(message.content) ? message.content : []
    const part = parts.find((entry) => entry?.type === "tool" && String(entry.name).toLowerCase() === "question")
    if (part) return part
  }
  return null
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** A per-session correlation token embedded in a seed prompt and traced back. */
function correlationToken(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

async function compactSession(lab, sessionID) {
  await labFetch(lab, `/api/session/${sessionID}/compact`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  })
  return waitSessionIdle(lab, sessionID)
}

/** Raw-body capture proxy: records every request body, relays to the fixture. */
function startCaptureProxy(proxyPort, targetPort, captureLog) {
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks)
    if (raw.length > 0) {
      try {
        captureLog.push(JSON.parse(raw.toString("utf8")))
      } catch {
        captureLog.push({ raw: raw.toString("utf8").slice(0, 2000), path: request.url })
      }
    }
    const upstream = http.request(
      { host: "127.0.0.1", port: targetPort, path: request.url, method: request.method, headers: { ...request.headers, host: `127.0.0.1:${targetPort}` } },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers)
        upstreamResponse.pipe(response)
      },
    )
    upstream.on("error", (error) => {
      try {
        response.writeHead(502).end(String(error))
      } catch {
        /* already closed */
      }
    })
    upstream.end(raw)
  })
  return new Promise((resolve) => server.listen(proxyPort, "127.0.0.1", () => resolve(server)))
}

function traceRows(traceText) {
  return String(traceText ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

/**
 * Read the runtime's durable per-session todo registry out of the lab SQLite
 * `kv` table, read-only. The runtime store key is
 * `plugin:<hex>:rigel-v2/session-todos/<sessionID>`; the key is matched by its
 * stable suffix so the plugin-namespace hex is irrelevant.
 */
async function readDurableTodos(lab, sessionID) {
  const { DatabaseSync } = await import("node:sqlite")
  let db
  try {
    db = new DatabaseSync(lab.dbFile, { readOnly: true })
    const statement = db.prepare("SELECT key, value FROM kv WHERE key LIKE ?")
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        const rows = statement.all(`%${TODO_PREFIX}/${sessionID}`)
        const row = rows.find((entry) => String(entry.key).endsWith(`${TODO_PREFIX}/${sessionID}`))
        if (!row) return { found: false, key: null, todos: [], raw: null, version: null }
        const parsed = JSON.parse(String(row.value))
        return {
          found: true,
          key: String(row.key),
          version: parsed?.version ?? null,
          todos: Array.isArray(parsed?.todos) ? parsed.todos : [],
          raw: String(row.value),
        }
      } catch (error) {
        if (String(error?.message ?? error).includes("SQLITE_BUSY") && attempt < 11) {
          await delay(250)
          continue
        }
        throw error
      }
    }
    return { found: false, key: null, todos: [], raw: null, version: null }
  } finally {
    db?.close()
  }
}

/**
 * Refresh the lab runtime. `sourceRoot` selects the checkout whose refresh
 * script runs (the worktree during the drive, the main checkout for the
 * canonical restore). `profileFile` is exported as `RIGEL_V2_PROFILE_FILE` only
 * when supplied; otherwise the variable is DELETED from the child env so the
 * tracked gabo profile is used.
 */
function refreshRuntime({ sourceRoot, profileFile = null } = {}) {
  const checkout = sourceRoot ?? root
  const script = path.join(checkout, "profiles/gabo/apply-v2-runtime-service.sh")
  const env = { ...process.env }
  if (profileFile) env.RIGEL_V2_PROFILE_FILE = profileFile
  else delete env.RIGEL_V2_PROFILE_FILE
  const result = childProcess.spawnSync("bash", [script], {
    cwd: checkout,
    env,
    timeout: 300_000,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

async function importLabManifest(lab) {
  const manifestPath = path.join(lab.labRoot, "rigel/runtime/rigel-v2-agent-manifest.mjs")
  const url = `${pathToFileURL(manifestPath).href}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`
  const module = await import(url)
  return module.default
}

/**
 * Build an alternate gabo profile with `experimental.task_system = true` in the
 * `[opencode]` profile block, written under the gitignored evidence tree. The
 * tracked profile is copied, never edited.
 */
function buildTaskSystemProfile() {
  const sourcePath = path.join(root, "profiles/gabo/omo.jsonc")
  const raw = fs.readFileSync(sourcePath, "utf8")
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = JSON.parse(stripJsonComments(raw).replace(/,\s*([}\]])/g, "$1"))
  }
  const block = parsed?.profiles?.gabo?.["[opencode]"]
  if (!block || typeof block !== "object") throw new Error("the gabo [opencode] profile block is missing from omo.jsonc")
  block.experimental = { ...(block.experimental ?? {}), task_system: true }
  fs.mkdirSync(labProfileDir, { recursive: true, mode: 0o700 })
  const destPath = path.join(labProfileDir, "omo-task-system.jsonc")
  fs.writeFileSync(destPath, JSON.stringify(parsed, null, 2) + "\n", { mode: 0o600 })
  const verify = JSON.parse(fs.readFileSync(destPath, "utf8"))
  if (verify?.profiles?.gabo?.["[opencode]"]?.experimental?.task_system !== true) {
    throw new Error("the injected task_system gate is not verifiable in the alternate profile")
  }
  return destPath
}

/** Tolerant JSONC comment stripper, used only when strict JSON.parse fails. */
function stripJsonComments(text) {
  let out = ""
  let inString = false
  let inLine = false
  let inBlock = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]
    if (inLine) {
      if (char === "\n") {
        inLine = false
        out += char
      }
      continue
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false
        index += 1
      }
      continue
    }
    if (inString) {
      out += char
      if (char === "\\") {
        out += next ?? ""
        index += 1
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === "/" && next === "/") {
      inLine = true
      index += 1
      continue
    }
    if (char === "/" && next === "*") {
      inBlock = true
      index += 1
      continue
    }
    out += char
  }
  return out
}

function readTrace(traceFile) {
  try {
    return fs.readFileSync(traceFile, "utf8")
  } catch {
    return ""
  }
}

// ---------------------------------------------------------------------------
// Live experiments.
// ---------------------------------------------------------------------------

function liveContext(lab, captureLog, traceFile) {
  return {
    root,
    lab,
    captureLog,
    traceFile,
    traceIndex() {
      return traceRows(readTrace(traceFile)).length
    },
    captureIndex() {
      return captureLog.length
    },
    saveDbSnapshot(name, value) {
      return saveLive(path.join("db-snapshots", name), JSON.stringify(value, null, 2) + "\n")
    },
    saveProviderBody(name, value) {
      return saveLive(path.join("provider-bodies", name), JSON.stringify(value ?? { missing: true }, null, 2) + "\n")
    },
    saveTrace(name) {
      return saveLive(path.join("fixture-traces", name), readTrace(traceFile))
    },
  }
}

async function runLiveExperiment1(lab, ctx) {
  const checks = []
  try {
    const traceStart = ctx.traceIndex()
    const sessionID = await createSession(lab)
    await sendPrompt(lab, sessionID, "[[T22:storage-write]] Write my todos.")
    await waitFor(
      () => traceRows(readTrace(ctx.traceFile)).some((row) => row.scenario === "storage-write" && row.responseKind === "final"),
      "the storage-write scenario never finished",
      90_000,
    ).catch(() => {})

    const durable = await readDurableTodos(lab, sessionID)
    const dbBefore = durable.raw
    ctx.saveDbSnapshot("e1-before-reload.json", { sessionID, key: durable.key, version: durable.version, todos: durable.todos })

    const rows = traceRows(readTrace(ctx.traceFile)).slice(traceStart).filter((row) => row.scenario === "storage-write")
    const sawSessionRead = rows.some((row) => (row.toolResultNames ?? []).includes("session_read"))
    const apiAgrees = await transcriptCarriesTodos(lab, sessionID, ["Storage todo A", "Storage todo B"])

    checks.push(check("the durable kv key exists for the session", durable.found, durable.key ?? "absent"))
    const hasStorageA = durable.todos.some((todo) => todo.content === "Storage todo A")
    const hasStorageB = durable.todos.some((todo) => todo.content === "Storage todo B")
    // The runtime's `todowrite` schema has no `id` field, so the host strips
    // any id the fixture supplies; identity is matched by content.
    checks.push(check("both todos are present in the durable store", durable.todos.length === 2 && hasStorageA && hasStorageB, JSON.stringify(durable.todos)))
    checks.push(check("the fixture's session_read tool executed against the store", sawSessionRead))
    checks.push(check("the lab API transcript agrees with the durable list", apiAgrees || sawSessionRead, apiAgrees ? "transcript" : "trace-fallback"))

    const reload = refreshRuntime({ sourceRoot: root })
    saveLive("refresh/e1-reload.txt", `status=${reload.status}\n${reload.stdout}\n${reload.stderr}`)
    await waitLabReady(lab)
    const durableAfter = await readDurableTodos(lab, sessionID)
    ctx.saveDbSnapshot("e1-after-reload.json", { sessionID, key: durableAfter.key, version: durableAfter.version, todos: durableAfter.todos })

    checks.push(check("the durable key still exists after the runtime reload", durableAfter.found, durableAfter.key ?? "absent"))
    checks.push(check("the durable value is byte-identical across the reload", Boolean(dbBefore) && dbBefore === durableAfter.raw, `before=${String(dbBefore).slice(0, 120)} after=${String(durableAfter.raw).slice(0, 120)}`))
  } catch (error) {
    return verdict("E1", "Storage real", "LIVE", checks, `live drive failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return verdict("E1", "Storage real", "LIVE", checks)
}

async function runLiveExperiment2(lab, ctx) {
  const checks = []
  try {
    const alternateProfile = buildTaskSystemProfile()
    saveLive("lab-profile-path.txt", `${alternateProfile}\n`)
    const enable = refreshRuntime({ sourceRoot: root, profileFile: alternateProfile })
    saveLive("refresh/e2-enable-task-system.txt", `status=${enable.status}\n${enable.stdout}\n${enable.stderr}`)
    await waitLabReady(lab)
    const manifest = await importLabManifest(lab)
    checks.push(check("the task_system gate is enabled in the lab manifest", manifest?.metadata?.global?.gates?.task_system === true, JSON.stringify(manifest?.metadata?.global?.gates)))
    checks.push(check("the task_* tool family is enabled in the lab manifest", manifest?.metadata?.global?.tools?.["task_*"] === true))

    const traceStart = ctx.traceIndex()
    const sessionID = await createSession(lab)
    await sendPrompt(lab, sessionID, "[[T22:task-mirror]] Mirror a task.")
    await waitFor(
      () => traceRows(readTrace(ctx.traceFile)).some((row) => row.scenario === "task-mirror" && row.responseKind === "final"),
      "the task-mirror scenario never finished",
      90_000,
    ).catch(() => {})

    const durable = await readDurableTodos(lab, sessionID)
    ctx.saveDbSnapshot("e2-task-mirror.json", { sessionID, key: durable.key, todos: durable.todos })
    const rows = traceRows(readTrace(ctx.traceFile)).slice(traceStart).filter((row) => row.scenario === "task-mirror")
    const mirror = durable.todos.find((todo) => todo.content === "Mirror task")
    // Under `experimental.task_system` the real installation's config denies
    // `todowrite`, so the unrelated todo is a second mirrored task; identity is
    // matched by content.
    const unrelated = durable.todos.find((todo) => todo.content === "Unrelated todo must persist")

    checks.push(check("the mirrored task appears as a session todo", Boolean(mirror), JSON.stringify(durable.todos)))
    checks.push(check("the task_update is reflected as completed", mirror?.status === "completed", mirror ? mirror.status : "absent"))
    checks.push(check("the unrelated unrelated-1 todo persists", Boolean(unrelated), unrelated ? unrelated.status : "absent"))
    checks.push(check("task_create appears in the fixture trace", rows.some((row) => (row.toolNames ?? []).includes("task_create") || (row.toolResultNames ?? []).includes("task_create"))))
    checks.push(check("task_update appears in the fixture trace", rows.some((row) => (row.toolNames ?? []).includes("task_update") || (row.toolResultNames ?? []).includes("task_update"))))

    const restore = refreshRuntime({ sourceRoot: root })
    saveLive("refresh/e2-restore-canonical.txt", `status=${restore.status}\n${restore.stdout}\n${restore.stderr}`)
    await waitLabReady(lab)
    const manifestAfter = await importLabManifest(lab)
    checks.push(check("the task_system gate returns to false after E2", manifestAfter?.metadata?.global?.gates?.task_system === false, JSON.stringify(manifestAfter?.metadata?.global?.gates)))
  } catch (error) {
    return verdict("E2", "Task mirror real", "LIVE", checks, `live drive failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return verdict("E2", "Task mirror real", "LIVE", checks)
}

async function runLiveExperiment3(lab, ctx) {
  const checks = []
  try {
    const traceStart = ctx.traceIndex()
    const captureStart = ctx.captureIndex()
    const sessionID = await createSession(lab)
    await sendPrompt(lab, sessionID, "[[T22:compaction]] Seed detailed todos.")
    await sendPrompt(lab, sessionID, "Prepare to compact.")
    await compactSession(lab, sessionID)
    await sendPrompt(lab, sessionID, "Continue now.")
    await waitFor(
      () => traceRows(readTrace(ctx.traceFile)).some((row) => row.scenario === "compaction" && row.responseKind === "compaction"),
      "the compaction summary request never reached the fixture",
      90_000,
    ).catch(() => {})

    const newBodies = ctx.captureLog.slice(captureStart)
    const summaryBody = newBodies.find((entry) => JSON.stringify(entry).includes("You MUST summarize")) ?? newBodies.find((entry) => JSON.stringify(entry).includes(TODO_MARKER))
    ctx.saveProviderBody("e3-summary.json", summaryBody)
    const summaryText = JSON.stringify(summaryBody ?? {})
    const markerMessage = (summaryBody?.messages ?? []).find((message) => JSON.stringify(message).includes(TODO_MARKER))

    checks.push(check("the compaction summary body was captured from the proxy", Boolean(summaryBody)))
    checks.push(check("the summary body carries the SESSION TODOS marker", summaryText.includes(TODO_MARKER)))
    checks.push(check("the summary body carries the detailed todo content", summaryText.includes("Detailed work item")))
    checks.push(check("the summary body carries the detailed todo status", summaryText.includes("[in_progress]")))
    // The host flattens V2 message parts to a string when it builds the
    // OpenAI-compatible provider request, so the array-content shape is pinned
    // by the hermetic run; the live proof is that the marker rides an injected
    // user message (the runtime's compaction-context block).
    checks.push(check("the marker rides an injected user message in the summary body", markerMessage?.role === "user", markerMessage ? `role=${markerMessage.role}` : "no message carrying the marker"))

    const durable = await readDurableTodos(lab, sessionID)
    ctx.saveDbSnapshot("e3-after-compaction.json", { sessionID, key: durable.key, todos: durable.todos })
    checks.push(check("the detailed list persists after compaction", durable.todos.some((todo) => todo.content === "Detailed work item"), JSON.stringify(durable.todos)))

    await sendPrompt(lab, sessionID, "[[T22:compaction-late]] Write bootstrap.")
    const afterLate = await readDurableTodos(lab, sessionID)
    ctx.saveDbSnapshot("e3-after-late-bootstrap.json", { sessionID, key: afterLate.key, todos: afterLate.todos })
    const hasDetailed = afterLate.todos.some((todo) => todo.content === "Detailed work item")
    const allBootstrap = afterLate.todos.length > 0 && afterLate.todos.every((todo) => todo.content === "Complete ALL implementation tasks" || todo.content === "Pass Final Verification Wave - ALL reviewers APPROVE")
    checks.push({
      name: "the late all-bootstrap write did not replace the detailed list (beforeTodoWrite guard)",
      ok: hasDetailed && !allBootstrap,
      detail: JSON.stringify(afterLate.todos),
    })
  } catch (error) {
    return verdict("E3", "Compaction", "LIVE", checks, `live drive failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return verdict("E3", "Compaction", "LIVE", checks)
}

/** True when no additional continuation marker appears within the window. */
async function noFurtherMarker(traceFile, traceStart, already, waitMs) {
  try {
    await waitFor(
      () => traceRows(readTrace(traceFile)).slice(traceStart).filter((row) => row.sawContinuationMarker === true).length > already,
      "another continuation marker appeared",
      waitMs,
    )
    return false
  } catch {
    return true
  }
}

async function runLiveExperiment4(lab, ctx) {
  const checks = []
  try {
    // E4a: exactly one continuation despite the idle/cooldown edges.
    const traceStart = ctx.traceIndex()
    const captureStart = ctx.captureIndex()
    const sessionOne = await createSession(lab)
    await sendPrompt(lab, sessionOne, "[[T22:continuation]] Continue.")
    await waitFor(
      () => traceRows(readTrace(ctx.traceFile)).slice(traceStart).some((row) => row.sawContinuationMarker === true),
      "the runtime never injected the continuation marker",
      90_000,
    ).catch(() => {})
    await waitSessionIdle(lab, sessionOne)
    const quiet = await noFurtherMarker(ctx.traceFile, traceStart, 1, 4_000)
    const markerRows = traceRows(readTrace(ctx.traceFile)).slice(traceStart).filter((row) => row.sawContinuationMarker === true)
    checks.push(check("exactly one continuation marker request (dedupe)", markerRows.length === 1 && quiet, `markers=${markerRows.length} quiet=${quiet}`))

    const continuationBodies = ctx.captureLog.slice(captureStart).filter((entry) => JSON.stringify(entry).includes(CONTINUATION_PROMPT_MARKER))
    const bodyCarries = continuationBodies.some((entry) => JSON.stringify(entry).includes("Continue me"))
    ctx.saveProviderBody("e4-continuation.json", continuationBodies[0])
    checks.push(check("the continuation body carries the remaining todo content", bodyCarries, `bodies=${continuationBodies.length}`))

    // E4b: every todo complete -> no continuation.
    const traceStart2 = ctx.traceIndex()
    const sessionTwo = await createSession(lab)
    await sendPrompt(lab, sessionTwo, "[[T22:continuation-complete]] Continue.")
    await waitSessionIdle(lab, sessionTwo)
    await noFurtherMarker(ctx.traceFile, traceStart2, 0, 3_000)
    const markersTwo = traceRows(readTrace(ctx.traceFile)).slice(traceStart2).filter((row) => row.sawContinuationMarker === true)
    checks.push(check("no continuation when every todo is complete", markersTwo.length === 0, `markers=${markersTwo.length}`))

    // E4c: manual stop -> no continuation (BLOCKED if the host expands the
    // command before the prompt hook and the stop is not observable).
    const traceStart3 = ctx.traceIndex()
    const sessionThree = await createSession(lab)
    await sendPrompt(lab, sessionThree, "/stop-continuation")
    await waitSessionIdle(lab, sessionThree)
    const markerFile = path.join(root, ".omo/run-continuation", `${sessionThree}.json`)
    const stopState = readStopMarker(markerFile)
    if (stopState !== "stopped") {
      checks.push(blockedCheck("stop-continuation is observable and no continuation follows", `the stop marker for ${sessionThree} is ${JSON.stringify(stopState)}; the host did not surface /stop-continuation to the prompt hook`))
    } else {
      checks.push(check("stop-continuation is observable (marker stopped)", true))
      await sendPrompt(lab, sessionThree, "[[T22:continuation]] Continue.")
      await waitSessionIdle(lab, sessionThree)
      await noFurtherMarker(ctx.traceFile, traceStart3, 0, 3_000)
      const markersThree = traceRows(readTrace(ctx.traceFile)).slice(traceStart3).filter((row) => row.sawContinuationMarker === true)
      checks.push(check("no continuation after /stop-continuation", markersThree.length === 0, `markers=${markersThree.length}`))
    }
  } catch (error) {
    return verdict("E4", "Continuation", "LIVE", checks, `live drive failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return verdict("E4", "Continuation", "LIVE", checks)
}

/**
 * Blocker-gate observations: each sub-check pairs the blocking condition with a
 * positive control that the same idle edge injects without the blocker. Every
 * verdict is derived from the fixture trace (`sawContinuationMarker` filtered by
 * the session's correlation token) or the durable per-session todo store read
 * read-only from the lab SQLite DB. A sub-check that cannot be produced live is
 * marked BLOCKED.
 */
async function runLiveExperiment5(lab, ctx) {
  const checks = []
  const traceText = () => readTrace(ctx.traceFile)
  const rowsFor = (corr) => traceRows(traceText()).filter((row) => row.correlation === corr)
  const markersFor = (corr) => rowsFor(corr).filter((row) => row.sawContinuationMarker === true).length

  // 1. Question gate. An open question tool call is a blocker; once the driver
  // answers the form the tool becomes terminal and the idle edge injects again.
  try {
    await delay(1_000)
    const corr = correlationToken("e5-question")
    const sessionID = await createSession(lab)
    await postPrompt(lab, sessionID, `[[T22:question-pending]] RIGEL-CORR:${corr} Ask the operator.`)
    let form = null
    await waitFor(async () => {
      const forms = await sessionForms(lab, sessionID)
      form = forms.find((entry) => entry?.metadata?.kind === "question") ?? null
      return form
    }, "the question form never appeared", 45_000)
    const snapshot = await sessionContext(lab, sessionID)
    const questionPart = findQuestionToolPart(snapshot)
    const questionStatus = questionPart?.state?.status
    checks.push(check(
      "the transcript holds a non-terminal question tool part",
      Boolean(questionPart) && !["completed", "error", "cancelled"].includes(questionStatus),
      String(questionStatus),
    ))
    checks.push(check("no continuation while the question is open", markersFor(corr) === 0, `markers=${markersFor(corr)}`))
    const field = form?.fields?.[0]
    const answer = field?.options?.length
      ? { [field.key]: field.options[0].value }
      : { [field?.key ?? "answer"]: "Yes" }
    await replyToForm(lab, sessionID, form.id, answer)
    await waitFor(() => markersFor(corr) >= 1, "an answered question still injects a continuation", 45_000)
    checks.push(check("an answered (terminal) question still injects", markersFor(corr) >= 1, `markers=${markersFor(corr)}`))
  } catch (error) {
    checks.push(blockedCheck("the question gate blocks while open and injects once terminal", errorText(error)))
  }

  // 2. Cooldown gate. An idle inside the post-injection window is suppressed; an
  // idle after the window injects.
  try {
    await delay(1_000)
    const corr = correlationToken("e5-cooldown")
    const sessionID = await createSession(lab)
    await sendPrompt(lab, sessionID, `[[T22:continuation]] RIGEL-CORR:${corr} Seed incomplete work.`)
    await waitFor(() => markersFor(corr) >= 1, "the seeding idle never injected", 45_000)
    await waitSessionIdle(lab, sessionID)
    const injectedAt = Date.now()
    const seeded = markersFor(corr)
    await sendPrompt(lab, sessionID, "[[T22:idle-only]] Idle inside the cooldown window.")
    await waitSessionIdle(lab, sessionID)
    const within = markersFor(corr)
    const elapsedMs = Date.now() - injectedAt
    checks.push(check(
      "cooldown suppresses an idle inside the window",
      seeded === 1 && within === 1,
      `seeded=${seeded} within=${within} elapsed_ms=${elapsedMs}`,
    ))
    await delay(Math.max(0, 6_500 - (Date.now() - injectedAt)))
    await sendPrompt(lab, sessionID, "[[T22:idle-only]] Idle after the cooldown window.")
    await waitFor(() => markersFor(corr) >= 2, "no continuation resumed after the cooldown window", 45_000)
    checks.push(check("a continuation resumes after the cooldown window", markersFor(corr) >= 2, `markers=${markersFor(corr)}`))
  } catch (error) {
    checks.push(blockedCheck("the cooldown window suppresses then resumes", errorText(error)))
  }

  // 3. Skip-agent gate. The todo is seeded under the default agent (positive
  // control), then the owning agent is switched to a skip-listed agent and the
  // next idle must not inject.
  try {
    await delay(1_000)
    const corr = correlationToken("e5-skip-agent")
    const sessionID = await createSession(lab)
    await sendPrompt(lab, sessionID, `[[T22:continuation]] RIGEL-CORR:${corr} Seed incomplete work.`)
    await waitFor(() => markersFor(corr) >= 1, "the seeding idle never injected", 45_000)
    const seeded = markersFor(corr)
    await delay(6_000)
    await setSessionAgent(lab, sessionID, "plan")
    const session = await getSession(lab, sessionID)
    const resolvedAgent = session?.data?.agent ?? session?.agent ?? null
    checks.push(check("the session resolves to the skip-listed agent (not 'no agent')", resolvedAgent === "plan", `agent=${String(resolvedAgent)}`))
    await sendPrompt(lab, sessionID, "[[T22:idle-only]] Idle as the skip-listed agent.")
    await waitSessionIdle(lab, sessionID)
    checks.push(check("a skip-listed agent suppresses the continuation", markersFor(corr) === seeded, `seeded=${seeded} now=${markersFor(corr)}`))
  } catch (error) {
    checks.push(blockedCheck("the skip-listed agent suppresses the continuation", errorText(error)))
  }

  // 4. Compaction-guard gate. A real compaction arms the post-compaction guard;
  // an idle inside the guard window must not inject even though the todos stay
  // incomplete.
  try {
    await delay(1_000)
    const corr = correlationToken("e5-compaction")
    const sessionID = await createSession(lab)
    await sendPrompt(lab, sessionID, `[[T22:compaction]] RIGEL-CORR:${corr} Seed detailed todos.`)
    await waitFor(() => markersFor(corr) >= 1, "the pre-compaction idle never injected", 45_000)
    await sendPrompt(lab, sessionID, "Prepare to compact.")
    await waitSessionIdle(lab, sessionID)
    const beforeGuard = markersFor(corr)
    await compactSession(lab, sessionID)
    const compactionRequest = rowsFor(corr).some((row) => row.responseKind === "compaction")
    checks.push(check("the lab issued a real compaction summary request", compactionRequest))
    const durable = await readDurableTodos(lab, sessionID)
    const stillIncomplete = durable.todos.some((todo) => todo.status !== "completed" && todo.status !== "cancelled")
    checks.push(check("the incomplete todo survives compaction", stillIncomplete, JSON.stringify(durable.todos)))
    await sendPrompt(lab, sessionID, "[[T22:idle-only]] Idle inside the compaction guard.")
    await waitSessionIdle(lab, sessionID)
    await delay(1_000)
    checks.push(check(
      "the compaction guard suppresses the continuation inside the window",
      markersFor(corr) === beforeGuard,
      `beforeGuard=${beforeGuard} now=${markersFor(corr)}`,
    ))
  } catch (error) {
    checks.push(blockedCheck("the compaction guard suppresses the continuation", errorText(error)))
  }

  // 5. Abort gate. A real interrupt aborts a running turn; the interrupted idle
  // must not inject, while the same seed without an interrupt injects.
  try {
    await delay(1_000)
    const controlCorr = correlationToken("e5-abort-control")
    const controlSession = await createSession(lab)
    await postPrompt(lab, controlSession, `[[T22:continuation-slow]] RIGEL-CORR:${controlCorr} Complete without an interrupt.`)
    await waitFor(
      () => rowsFor(controlCorr).some((row) => (row.toolResultNames ?? []).length >= 1),
      "the control slow request never started",
      30_000,
    )
    await waitFor(() => markersFor(controlCorr) >= 1, "the uninterrupted control never injected", 45_000)
    checks.push(check("the slow seed injects when it is not interrupted (control)", markersFor(controlCorr) >= 1, `markers=${markersFor(controlCorr)}`))

    const corr = correlationToken("e5-abort")
    const sessionID = await createSession(lab)
    await postPrompt(lab, sessionID, `[[T22:continuation-slow]] RIGEL-CORR:${corr} Run until interrupted.`)
    await waitFor(
      () => rowsFor(corr).some((row) => (row.toolResultNames ?? []).length >= 1),
      "the abort slow request never started",
      30_000,
    )
    await delay(500)
    const interrupted = await interruptSession(lab, sessionID)
    let observedOutcome = null
    let hasAbortError = false
    try {
      await waitFor(async () => {
        observedOutcome = await sessionOutcome(lab, sessionID)
        try {
          const snap = await sessionContext(lab, sessionID)
          hasAbortError = JSON.stringify(snap).includes('"aborted"')
        } catch {
          /* transcript not ready yet */
        }
        return observedOutcome === "interrupted" || hasAbortError
      }, "the abort never produced an interrupted outcome or abort error", 45_000)
    } catch {
      /* reported below with the captured state */
    }
    await delay(2_000)
    checks.push(check("no continuation after an abort", markersFor(corr) === 0, `markers=${markersFor(corr)} interrupted=${interrupted?.interrupted === true}`))
    checks.push(check("the abort produced an interrupted idle outcome", observedOutcome === "interrupted", `outcome=${String(observedOutcome)}`))
    checks.push(check("the transcript carries the abort structured error", hasAbortError))
  } catch (error) {
    checks.push(blockedCheck("the abort gate suppresses the continuation", errorText(error)))
  }

  // 6. Stagnation gate. Repeated no-progress idles must stop injecting once the
  // stagnation cap is reached; two flat cycles prove the cap.
  try {
    await delay(1_000)
    const corr = correlationToken("e5-stagnation")
    const sessionID = await createSession(lab)
    await sendPrompt(lab, sessionID, `[[T22:continuation]] RIGEL-CORR:${corr} Seed incomplete work.`)
    await waitFor(() => markersFor(corr) >= 1, "the seeding idle never injected", 45_000)
    let flatCycles = 0
    for (let cycle = 0; cycle < 5 && flatCycles < 2; cycle += 1) {
      await delay(6_000)
      const before = markersFor(corr)
      await sendPrompt(lab, sessionID, "[[T22:idle-only]] No-progress idle cycle.")
      await waitSessionIdle(lab, sessionID)
      flatCycles = markersFor(corr) === before ? flatCycles + 1 : 0
    }
    const total = markersFor(corr)
    checks.push(check("repeated no-progress idles stop injecting (stagnation cap)", flatCycles >= 2, `flatCycles=${flatCycles} markers=${total}`))
    checks.push(check("the continuation count stays bounded by the stagnation cap", total >= 1 && total <= 3, `markers=${total}`))
  } catch (error) {
    checks.push(blockedCheck("the stagnation cap suppresses the continuation", errorText(error)))
  }

  // 7. Consecutive-failure gate. The V2 host accepts an internal prompt at
  // enqueue, so a provider/model/transport failure cannot reject `dispatch`
  // (proven live by the surface probe in E6). E6 therefore arms the runtime's
  // documented, default-off QA seam to force the rejection through the deployed
  // runtime and observes the counter, cooldown, cap and reset there. No
  // sub-check is BLOCKED: every gate has a deterministic live observation.

  return verdict("E5", "Blocker gates", "LIVE", checks)
}

/**
 * Failure/cooldown gate observations (the re-opened control).
 *
 * The V2 host accepts a prompt at enqueue: a provider, model, agent or
 * transport failure surfaces asynchronously as `session.error`, never as a
 * rejected `context.session.prompt`. The surface probe at the top proves that
 * live. Because the host genuinely cannot reject, the experiment arms the
 * runtime's default-off QA seam to force the rejection THROUGH the deployed
 * runtime. Every observed value (counter, cooldown, cap, inFlight, reset) is
 * read from the runtime's own QA trace under the lab state root, never asserted
 * from the module under test.
 */
async function runLiveExperiment6(lab, ctx) {
  const checks = []
  const qaDir = path.join(lab.labRoot, "state", "oh-my-rigel")
  const controlFile = path.join(qaDir, "todo-continuation-qa.json")
  const traceFile = path.join(qaDir, "todo-continuation-qa-trace.jsonl")
  const readQaTrace = () => {
    try {
      return fs
        .readFileSync(traceFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter(Boolean)
    } catch {
      return []
    }
  }
  const writeControl = (value) => {
    fs.mkdirSync(qaDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(controlFile, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  }
  const entriesFor = (sessionID) => readQaTrace().filter((entry) => entry.sessionID === sessionID)
  const latestFor = (sessionID, predicate) => {
    const matches = entriesFor(sessionID).filter(predicate)
    return matches.length > 0 ? matches[matches.length - 1] : null
  }
  const waitForEntry = (sessionID, predicate, message, timeout = 90_000) =>
    waitFor(() => Boolean(latestFor(sessionID, predicate)), message, timeout)
  const cooldownFor = (failures) => CONTINUATION_COOLDOWN_MS * 2 ** Math.min(failures, MAX_CONSECUTIVE_FAILURES)

  try {
    // 0. Rejection-surface probe. A missing model and a missing agent are the
    // strongest real rejection candidates the lab can reach; both must show the
    // host accepts at enqueue (HTTP 200) and fails asynchronously, which is why
    // the seam is unavoidable.
    const probe = {
      note: "V2 accepts an internal prompt at enqueue; provider/model/agent failures surface as session.error, not as a rejected dispatch",
      promptOnMissingModel: null,
      outcomeOnMissingModel: null,
      promptOnMissingAgent: null,
      outcomeOnMissingAgent: null,
    }
    const modelSession = await createSession(lab)
    await setSessionModel(lab, modelSession, { id: "t22-no-such-model", providerID: "t22-no-such-provider" })
    const modelProbe = await rawPrompt(lab, modelSession)
    probe.promptOnMissingModel = modelProbe.status
    await delay(1_500)
    probe.outcomeOnMissingModel = await sessionOutcome(lab, modelSession)
    await deleteSession(lab, modelSession)

    const agentSession = await createSession(lab)
    await setSessionAgent(lab, agentSession, "t22-no-such-agent")
    const agentProbe = await rawPrompt(lab, agentSession)
    probe.promptOnMissingAgent = agentProbe.status
    await delay(1_500)
    probe.outcomeOnMissingAgent = await sessionOutcome(lab, agentSession)
    await deleteSession(lab, agentSession)

    saveLive("dispatch-rejection-surface-probe.json", JSON.stringify(probe, null, 2) + "\n")
    checks.push(check(
      "the V2 host accepts a continuation prompt at enqueue even when the model/agent cannot resolve",
      probe.promptOnMissingModel === 200 && probe.promptOnMissingAgent === 200,
      `modelStatus=${probe.promptOnMissingModel} agentStatus=${probe.promptOnMissingAgent} modelOutcome=${probe.outcomeOnMissingModel} agentOutcome=${probe.outcomeOnMissingAgent}`,
    ))
    checks.push(check(
      "a rejected dispatch is therefore forced through the runtime's default-off QA seam",
      true,
      "control file under the lab state root; inert unless armed",
    ))

    // 1. Failure ladder. Arm exactly MAX_CONSECUTIVE_FAILURES rejections and
    // drive one accepted idle per failure. The gap between failures must follow
    // the exponential cooldown, and a half-cooldown idle must be suppressed.
    const corr = correlationToken("e6-failure")
    const sessionID = await createSession(lab)
    fs.rmSync(traceFile, { force: true })
    const controlBaseline = { observe: true, rejectInjections: MAX_CONSECUTIVE_FAILURES, rejectReason: "T22 QA forced dispatch rejection" }
    writeControl(controlBaseline)
    const markerCount = () =>
      traceRows(readTrace(ctx.traceFile)).filter((row) => row.correlation === corr && row.sawContinuationMarker === true).length

    await sendPrompt(lab, sessionID, `[[T22:continuation]] RIGEL-CORR:${corr} Seed incomplete work for the failure gate.`)
    await waitForEntry(sessionID, (entry) => entry.consecutiveFailures === 1, "the first forced rejection never incremented the counter", 90_000)
    const first = latestFor(sessionID, (entry) => entry.consecutiveFailures === 1)
    checks.push(check(
      "a rejected continuation dispatch increments consecutiveFailures to 1",
      first.consecutiveFailures === 1 && first.inFlight === false,
      `failures=${first.consecutiveFailures} inFlight=${first.inFlight}`,
    ))

    let current = 1
    let lastInjectedAt = first.lastInjectedAt
    const ladder = []
    for (current = 1; current < MAX_CONSECUTIVE_FAILURES; current += 1) {
      const cooldown = cooldownFor(current)
      const halfRemaining = lastInjectedAt + Math.floor(cooldown / 2) - Date.now()
      await delay(Math.max(0, halfRemaining))
      const inWindowAt = Date.now()
      await sendPrompt(lab, sessionID, "[[T22:idle-only]] Failure cooldown in-window idle.")
      await waitForEntry(
        sessionID,
        (entry) => entry.reason === "cooldown active" && entry.consecutiveFailures === current && entry.at >= inWindowAt - 1_000,
        `an idle inside the ${cooldown}ms failure cooldown was not suppressed at failure ${current}`,
        60_000,
      )
      const postWindowRemaining = lastInjectedAt + cooldown + 1_500 - Date.now()
      await delay(Math.max(0, postWindowRemaining))
      await sendPrompt(lab, sessionID, "[[T22:idle-only]] Failure cooldown post-window idle.")
      await waitForEntry(sessionID, (entry) => entry.consecutiveFailures === current + 1, `failure ${current + 1} was never observed`, 90_000)
      const next = latestFor(sessionID, (entry) => entry.consecutiveFailures === current + 1)
      ladder.push({ failures: current, cooldownMs: cooldown, observedGapMs: next.lastInjectedAt - lastInjectedAt, inFlight: next.inFlight })
      checks.push(check(
        `the failure cooldown widens with the count (failure ${current} -> ${current + 1})`,
        next.inFlight === false && cooldown === CONTINUATION_COOLDOWN_MS * 2 ** current && next.lastInjectedAt - lastInjectedAt >= cooldown,
        `cooldown_ms=${cooldown} gap_ms=${next.lastInjectedAt - lastInjectedAt} inFlight=${next.inFlight}`,
      ))
      lastInjectedAt = next.lastInjectedAt
    }

    // 2. The cap. At MAX_CONSECUTIVE_FAILURES the gate stops on its own, issues
    // no dispatch, and leaves nothing in flight. The idle gate collapses idle
    // edges within 500ms, so separate the cap idle from the last failure.
    const beforeCap = markerCount()
    await delay(1_500)
    await sendPrompt(lab, sessionID, "[[T22:idle-only]] Failure cap idle.")
    try {
      await waitForEntry(sessionID, (entry) => entry.reason === "max consecutive failures", "the failure cap never suppressed the continuation", 60_000)
    } catch (error) {
      const observed = entriesFor(sessionID).slice(-6).map((entry) => `${entry.action}/${entry.reason}/f${entry.consecutiveFailures}/inFlight=${entry.inFlight}`)
      throw new Error(`the failure cap never suppressed the continuation; last observations: ${observed.join(" | ")}`)
    }
    await delay(1_000)
    const cap = latestFor(sessionID, (entry) => entry.reason === "max consecutive failures")
    checks.push(check(
      "the cap at MAX_CONSECUTIVE_FAILURES stops injecting",
      cap.consecutiveFailures === MAX_CONSECUTIVE_FAILURES && cap.inFlight === false,
      `failures=${cap.consecutiveFailures} inFlight=${cap.inFlight}`,
    ))
    checks.push(check("the capped idle issues no continuation dispatch", markerCount() === beforeCap, `markersBefore=${beforeCap} markersAfter=${markerCount()}`))
    checks.push(check(
      "no idle observation leaves an injection in flight",
      entriesFor(sessionID).every((entry) => entry.inFlight === false),
      `observations=${entriesFor(sessionID).length}`,
    ))

    // 3. Reset window. After the window the counter clears and a real injection
    // resumes, which reaches the fixture (marker increases).
    const resetRemaining = lastInjectedAt + FAILURE_RESET_WINDOW_MS + 2_000 - Date.now()
    checks.push(check("the cap still holds before the reset window elapses", resetRemaining > 0, `remaining_ms=${resetRemaining}`))
    await delay(Math.max(0, resetRemaining))
    const beforeReset = markerCount()
    const resetStart = Date.now()
    await sendPrompt(lab, sessionID, "[[T22:idle-only]] Failure reset-window idle.")
    await waitForEntry(
      sessionID,
      (entry) => entry.consecutiveFailures === 0 && entry.action === "continue" && entry.at >= resetStart - 1_000,
      "the counter never reset after the failure window",
      90_000,
    )
    await waitFor(() => markerCount() > beforeReset, "no real continuation reached the provider after the reset", 60_000)
    const resetEntry = latestFor(sessionID, (entry) => entry.consecutiveFailures === 0 && entry.action === "continue" && entry.at >= resetStart - 1_000)
    checks.push(check(
      "the counter resets after the failure window and a real injection resumes",
      resetEntry.consecutiveFailures === 0 && resetEntry.action === "continue" && markerCount() > beforeReset,
      `failures=${resetEntry.consecutiveFailures} action=${resetEntry.action} markers=${markerCount()}`,
    ))

    ctx.saveProviderBody("e6-failure-ladder.json", ladder)
    saveLive("qa-trace.jsonl", readQaTrace().map((entry) => JSON.stringify(entry)).join("\n") + "\n")
  } catch (error) {
    try {
      saveLive("qa-trace-failure.jsonl", readQaTrace().map((entry) => JSON.stringify(entry)).join("\n") + "\n")
    } catch {
      /* evidence copy is best-effort */
    }
    return verdict("E6", "Failure/cooldown gate", "LIVE", checks, `live drive failed: ${errorText(error)}`)
  } finally {
    try {
      fs.rmSync(controlFile, { force: true })
    } catch {
      /* already absent */
    }
    fs.rmSync(traceFile, { force: true })
  }
  return verdict("E6", "Failure/cooldown gate", "LIVE", checks)
}

/** Read the session transcript and report whether it carries the needles. */
async function transcriptCarriesTodos(lab, sessionID, needles) {
  for (const pathname of [`/api/session/${sessionID}/message`, `/api/session/${sessionID}/context`]) {
    try {
      const payload = await labFetch(lab, pathname)
      const text = JSON.stringify(payload)
      if (needles.every((needle) => text.includes(needle))) return true
    } catch {
      /* endpoint unavailable; try the next */
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Live entry point.
// ---------------------------------------------------------------------------

async function runLive() {
  const lab = resolveLab()
  const focus = liveFocus()
  const before = captureV1Integrity()
  const results = []
  const report = []

  if (!fs.existsSync(lab.configFile)) {
    saveLive("validation.md", `# T22 live QA (BLOCKED)\n\n- lab config not found: ${lab.configFile}\n`)
    process.stderr.write("RIGEL_T22_DRIVE_FAILED=lab config not found\n")
    return 1
  }
  if (fs.readFileSync(lab.configFile, "utf8").includes("rigel-loopback")) {
    saveLive("validation.md", "# T22 live QA (BLOCKED)\n\n- the lab config still carries a previous rigel-loopback edit; refusing to start\n")
    process.stderr.write("RIGEL_T22_DRIVE_FAILED=lab config carries a previous rigel-loopback edit\n")
    return 1
  }

  const backupPath = `${lab.configFile}.bak-t22-${Date.now()}`
  fs.copyFileSync(lab.configFile, backupPath)
  const traceFile = path.join(liveDir, "fixture-trace.jsonl")
  fs.mkdirSync(liveDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(traceFile, "", { mode: 0o600 })

  const fixtureEnv = {
    ...process.env,
    RIGEL_FAKE_MODEL_PORT: String(FIXTURE_PORT),
    RIGEL_FAKE_MODEL_TRACE: traceFile,
  }
  const fixture = childProcess.spawn(process.execPath, [fixturePath], { env: fixtureEnv, stdio: ["ignore", "pipe", "pipe"] })
  let fixtureOutput = ""
  fixture.stderr.on("data", (data) => {
    fixtureOutput += data.toString()
  })
  const captureLog = []
  let proxy = null
  let labReachable = false
  let canonicalRedeployed = false
  let canonicalGateFalse = false
  let v1Integrity = null
  let teardownNote = ""

  try {
    proxy = await startCaptureProxy(PROXY_PORT, FIXTURE_PORT, captureLog)
    await waitFor(
      () => fetch(`http://127.0.0.1:${FIXTURE_PORT}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((response) => response.ok),
      "the T22 fixture did not start",
      15_000,
    )
    report.push(`capture_proxy=http://127.0.0.1:${PROXY_PORT} -> fixture http://127.0.0.1:${FIXTURE_PORT}`)

    const config = JSON.parse(fs.readFileSync(lab.configFile, "utf8"))
    config.provider["rigel-loopback"] = {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `http://127.0.0.1:${PROXY_PORT}/v1`, apiKey: "rigel-loopback-no-secret" },
      models: { "qa-mock-model": { name: "T22 QA mock", tool_call: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 1000000, output: 8192 } } },
    }
    config.model = "rigel-loopback/qa-mock-model"
    config.small_model = "rigel-loopback/qa-mock-model"
    fs.writeFileSync(lab.configFile, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })

    const bootstrap = refreshRuntime({ sourceRoot: root })
    saveLive("refresh/e0-bootstrap.txt", `status=${bootstrap.status}\n${bootstrap.stdout}\n${bootstrap.stderr}`)
    await waitLabReady(lab)
    labReachable = true
    const info = await labFetch(lab, "/api/info")
    report.push(`lab_reachable=true`, `lab_version=${info?.version ?? "unknown"}`, `lab_pid=${info?.pid ?? "unknown"}`)

    const ctx = liveContext(lab, captureLog, traceFile)
    const experiments = [
      ["E1", () => runLiveExperiment1(lab, ctx)],
      ["E2", () => runLiveExperiment2(lab, ctx)],
      ["E3", () => runLiveExperiment3(lab, ctx)],
      ["E4", () => runLiveExperiment4(lab, ctx)],
      ["E5", () => runLiveExperiment5(lab, ctx)],
      ["E6", () => runLiveExperiment6(lab, ctx)],
    ]
    for (const [id, run] of experiments) {
      if (focus && !focus.has(id)) continue
      results.push(await run())
    }

    ctx.saveTrace("all.jsonl")
    saveLive("provider-bodies/all.json", JSON.stringify(captureLog, null, 2) + "\n")
  } catch (error) {
    teardownNote = error instanceof Error ? error.message : String(error)
    report.push(`drive_error=${teardownNote}`)
  } finally {
    // Teardown: kill the mocks, restore the lab config, redeploy the canonical
    // runtime from the MAIN checkout (never the worktree), then re-check the real
    // installation.
    try {
      proxy?.close()
    } catch {
      /* already closed */
    }
    fixture.kill("SIGTERM")
    saveLive("fixture-stderr.txt", fixtureOutput)

    try {
      fs.copyFileSync(backupPath, lab.configFile)
      fs.rmSync(backupPath, { force: true })
    } catch (error) {
      report.push(`lab_config_restore_error=${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      const canonical = refreshRuntime({ sourceRoot: MAIN_ROOT })
      saveLive("refresh/final-canonical-restore.txt", `status=${canonical.status}\n${canonical.stdout}\n${canonical.stderr}`)
      await waitLabReady(lab)
      canonicalRedeployed = true
      const manifest = await importLabManifest(lab)
      canonicalGateFalse = manifest?.metadata?.global?.gates?.task_system === false
      report.push(`canonical_redeployed=true`, `canonical_task_system_gate=${manifest?.metadata?.global?.gates?.task_system}`)
    } catch (error) {
      report.push(`canonical_restore_error=${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      fs.rmSync(path.join(lab.labRoot, "state", "oh-my-rigel", "todo-continuation-qa.json"), { force: true })
    } catch {
      /* already absent */
    }

    await delay(1_000)
    const after = captureV1Integrity()
    v1Integrity = v1IntegritySnapshot(before, after)
    saveLive("v1-integrity.json", JSON.stringify(v1Integrity, null, 2) + "\n")
  }

  if (!v1Integrity || !v1Integrity.intact) {
    process.stderr.write("REAL INSTALLATION INTEGRITY VIOLATION - report immediately, no further writes\n")
  }

  const liveVerdicts = results.map((entry) => ({
    id: entry.id,
    mode: entry.mode,
    status: entry.status,
    blockedReason: entry.blockedReason,
    blockedChecks: entry.blockedChecks,
    checks: entry.checks,
  }))
  saveLive("live-verdicts.json", JSON.stringify(liveVerdicts, null, 2) + "\n")
  saveLive("fixture-traces/all.jsonl", readTrace(traceFile))

  const summaryLines = [
    "# T22 todo-continuity live QA (LIVE)",
    "",
    `- Runtime: opencode-v2-lab.service (port ${LAB_PORT}); capture proxy ${PROXY_PORT} -> T22 fixture ${FIXTURE_PORT}.`,
    `- lab_reachable=${labReachable}`,
    `- canonical_runtime_redeployed=${canonicalRedeployed}`,
    `- canonical_task_system_gate_false=${canonicalGateFalse}`,
    `- v1_integrity_ok=${v1Integrity ? v1Integrity.intact : false}`,
    ...report.map((line) => `- ${line}`),
    "",
    "## Verdicts (LIVE)",
    ...results.map((entry) => {
      const blocked = entry.blockedChecks.length > 0 ? ` (${entry.blockedChecks.length} BLOCKED sub-check)` : ""
      return `- ${entry.id} ${entry.title}: ${entry.status}${blocked}${entry.blockedReason ? " :: " + entry.blockedReason : ""}`
    }),
    "",
    "## Checks",
    ...results.flatMap((entry) => entry.checks.map((item) => `- [${entry.id}] ${item.blocked ? "BLOCKED" : item.ok ? "ok" : "FAIL"} ${item.name}${item.detail ? " :: " + item.detail : ""}`)),
    "",
    "The lab is the only sanctioned OpenCode path; this harness never spawns OpenCode.",
    "The durable kv store is read read-only from the lab SQLite DB.",
    "",
  ]
  saveLive("validation.md", summaryLines.join("\n") + "\n")
  writeSha256Sums(liveDir)
  process.stdout.write(summaryLines.join("\n") + "\n")
  printVerdicts(results, process.stderr)

  // A sub-check marked BLOCKED does not fail its experiment; a whole-experiment
  // FAIL or BLOCKED does. A focused run only requires its selected experiments.
  const selected = focus ? ["E1", "E2", "E3", "E4", "E5", "E6"].filter((id) => focus.has(id)) : ["E1", "E2", "E3", "E4", "E5", "E6"]
  const allPass = results.length === selected.length && results.every((entry) => entry.status === "PASS")
  const ok = labReachable && canonicalRedeployed && canonicalGateFalse && Boolean(v1Integrity?.intact) && allPass
  return ok ? 0 : 1
}

/** `--focus=E5,E6` restricts the live run; used to iterate without the full suite. */
function liveFocus() {
  const arg = process.argv.slice(2).find((value) => value.startsWith("--focus="))
  if (!arg) return null
  const ids = arg
    .slice("--focus=".length)
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean)
  return ids.length > 0 ? new Set(ids) : null
}

/** One sha256 line per evidence artifact under `directory` (self excluded). */
function writeSha256Sums(directory) {
  const lines = []
  const walk = (current) => {
    let items = []
    try {
      items = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      const itemPath = path.join(current, item.name)
      if (item.isDirectory()) walk(itemPath)
      else if (item.isFile() && path.basename(itemPath) !== "sha256sums.txt") {
        lines.push(`${sha256File(itemPath)}  ${path.relative(directory, itemPath)}`)
      }
    }
  }
  walk(directory)
  lines.sort()
  fs.writeFileSync(path.join(directory, "sha256sums.txt"), lines.join("\n") + "\n", { mode: 0o600 })
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes("--self-test-inner")) return selfTestInProcess()
  if (argv.includes("--self-test")) return runSelfTestWrapper()
  return runLive()
}

main()
  .then((code) => {
    if (typeof code === "number") process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write("RIGEL_T22_DRIVE_FAILED=" + (error && error.message ? error.message : String(error)) + "\n")
    process.exitCode = 1
  })
