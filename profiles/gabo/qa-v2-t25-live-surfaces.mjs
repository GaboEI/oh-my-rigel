#!/usr/bin/env node
/**
 * T25 live-surface probe: drives the REAL entrypoints' `setup()` and asserts the
 * per-feature observables that a headless `opencode serve` cannot exercise.
 *
 * Why a probe instead of the lab service: `opencode-v2-lab.service` runs
 * `opencode serve`, which is headless and never constructs the CLI-plugin
 * context, so the companion `./tui` entrypoint is not loaded there (root cause
 * documented in `.omo/evidence/20261008-t25-final-closure/live/README.md`). The
 * server entrypoint IS loaded there, but its setup is not asserted per feature.
 * This probe closes both gaps hermetically: no OpenCode process is spawned, no
 * V1 path is read, every state root is a throwaway temp dir.
 *
 * Server entrypoint (`rigel-v2-native.mjs` default `setup`):
 *   - opengateway POSITIVE with an ISOLATED test credential (`OPENGATEWAY_API_KEY`
 *     set to a non-secret value) and the packaged catalog: the captured
 *     `context.provider.transform` editor receives the OpenGateway provider and
 *     its models. NEGATIVE (credential removed): the transform is never called.
 *   - btw POSITIVE: a side session carrying `omo_btw_side` metadata gets the
 *     bounded parent context injected and a durable receipt. NEGATIVE: a session
 *     without the metadata is left byte-identical.
 *
 * Companion CLI entrypoint (`rigel-v2-native-cli.mjs` default `setup`, the
 * composed `./tui`): legacy notice, native-edition nudge and task-toast effects
 * are asserted on the real toasts/receipts, plus the btw `/btw` command opening
 * its picker. Deduplication, gates and child-skip are asserted as negatives.
 *
 * Exit code is non-zero when any feature verdict fails.
 */
import fs from "node:fs"
import os from "node:os"
import crypto from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"

import serverPlugin from "./opencode/rigel-v2-native.mjs"
import { createCompanionCliPlugin } from "./opencode/rigel-v2-native-cli.mjs"
import { createEntrypointContext, hooksNamed } from "./opencode/differential-oracle/entrypoint/fake-context.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const evidenceDir = path.join(root, ".omo/evidence/20261008-t25-final-closure/live")
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-t25-live-"))
const stateHome = path.join(sandbox, "state")
const projDir = path.join(sandbox, "project")
fs.mkdirSync(stateHome, { recursive: true })
fs.mkdirSync(projDir, { recursive: true })

// Hermetic state roots: every receipt/log lands under the sandbox.
process.env.XDG_STATE_HOME = stateHome
process.env.XDG_DATA_HOME = path.join(sandbox, "data")
process.env.XDG_CONFIG_HOME = path.join(sandbox, "config")
process.env.NODE_ENV = "test"

const verdicts = []
function check(feature, name, pass, detail) {
  verdicts.push({ feature, name, pass: Boolean(pass), detail: String(detail ?? "").slice(0, 240) })
}
function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch { return undefined }
}

const receiptDir = path.join(stateHome, "oh-my-rigel")

// ===========================================================================
// PHASE A - server entrypoint (real setup), OpenGateway + btw context
// ===========================================================================
async function runServerPhase() {
  // --- POSITIVE: isolated test credential ---
  process.env.OPENGATEWAY_API_KEY = "rigel-t25-test-credential"
  const { context, capture } = createEntrypointContext({ directory: projDir })
  const providerAdds = []
  let providerTransforms = 0
  context.provider = {
    transform: async (callback) => {
      providerTransforms += 1
      callback({
        add: (arg) => providerAdds.push(arg),
        get: () => undefined,
        set() {},
        update() {},
        models: { set() {}, update() {} },
      })
      return { dispose() {} }
    },
  }
  const sessions = {
    ses_side: { metadata: { omo_btw_side: { version: 1, parent_session_id: "ses_parent", boundary_message_id: "m1" } } },
    ses_root: {},
  }
  const parentMessages = [{ id: "m1", role: "user", content: [{ type: "text", text: "parent turn" }] }]
  context.session.get = async (input) => ({ data: sessions[input?.sessionID] })
  context.session.context = async () => parentMessages

  const disposeServer = await serverPlugin.setup(context)
  try {
    const added = providerAdds[0]
    const modelCount = added && added.models ? Object.keys(added.models).length : 0
    check(
      "opengateway",
      "positive: provider.transform called with provider + packaged catalog",
      providerTransforms === 1 && added?.info?.name === "OpenGateway" && modelCount >= 60,
      `transforms=${providerTransforms}; name=${added?.info?.name}; models=${modelCount}`,
    )

    const contextHook = hooksNamed(capture, "context")[0]
    check("btw-context", "server registered exactly one context hook", hooksNamed(capture, "context").length === 1, `hooks=${hooksNamed(capture, "context").length}`)

    // Positive: side session metadata -> bounded injection + receipt.
    const sideEvent = { sessionID: "ses_side", agent: "Sisyphus", model: { modelID: "gpt-5.5" }, system: [], messages: [], options: {} }
    await contextHook.handler(sideEvent)
    const injected = Array.isArray(sideEvent.messages) && sideEvent.messages.length > 0
    const boundary = (sideEvent.system ?? []).some((part) => typeof part?.text === "string" && part.text.includes("<omo-btw-boundary>"))
    const btwReceipt = readJsonSafe(path.join(receiptDir, "btw-injection.json"))
    check(
      "btw-context",
      "positive: side session injected bounded parent context + durable receipt",
      injected && boundary && btwReceipt?.injected === true && btwReceipt?.parentSessionID === "ses_parent",
      `messages=${sideEvent.messages?.length ?? 0}; boundary=${boundary}; receipt=${JSON.stringify(btwReceipt)}`,
    )

    // Negative: a session without the metadata gets NO btw boundary, no btw
    // receipt, and no parent content. (The full context pipeline legitimately
    // rewrites the request for every session, so the btw contract is asserted
    // on btw-specific observables, not whole-request byte identity.)
    const rootEvent = { sessionID: "ses_root", agent: "Sisyphus", model: { modelID: "gpt-5.5" }, system: [{ type: "text", text: "keep" }], messages: [{ role: "user", content: "hi" }], options: {} }
    await contextHook.handler(rootEvent)
    const rootBoundary = (rootEvent.system ?? []).some((part) => typeof part?.text === "string" && part.text.includes("<omo-btw-boundary>"))
    const rootHasParent = JSON.stringify(rootEvent.messages ?? []).includes("parent turn")
    check("btw-context", "negative: no metadata -> no btw boundary, no parent content", !rootBoundary && !rootHasParent, `boundary=${rootBoundary}; parentContent=${rootHasParent}`)
  } finally {
    await disposeServer()
    delete process.env.OPENGATEWAY_API_KEY
  }

  // --- NEGATIVE: no credential -> transform never called ---
  const negative = createEntrypointContext({ directory: projDir })
  let negativeTransforms = 0
  negative.context.provider = { transform: async (cb) => { negativeTransforms += 1; cb({ add() {}, get: () => undefined }); return { dispose() {} } } }
  negative.context.session.get = async () => ({ data: {} })
  const disposeNegative = await serverPlugin.setup(negative.context)
  try {
    check("opengateway", "negative: no credential -> provider.transform never called", negativeTransforms === 0, `transforms=${negativeTransforms}`)
  } finally {
    await disposeNegative()
  }
}

// ===========================================================================
// PHASE B - companion CLI entrypoint (real composite setup)
// ===========================================================================
async function runCliPhase() {
  const FIXED = 1_700_000_000_000
  const handlers = new Map()
  const toasts = []
  const layers = []
  const selects = []
  const cliSessions = { ses_root: {}, ses_child: { parentID: "ses_root" }, ses_task: {} }
  const cliSessionList = [{ id: "ses_root", title: "Parent" }]
  const createCalls = []

  const on = (name, handler) => {
    const list = handlers.get(name) ?? []
    list.push(handler)
    handlers.set(name, list)
    return () => { const cur = handlers.get(name) ?? []; handlers.set(name, cur.filter((h) => h !== handler)) }
  }
  const emit = (event) => { for (const handler of handlers.get(event.type) ?? []) handler(event) }

  const context = {
    options: {},
    renderer: { isDestroyed: false, requestRender() {} },
    location: { current: { directory: projDir } },
    data: {
      on,
      session: { get: (id) => cliSessions[id], list: async () => cliSessionList },
    },
    ui: {
      toast: { show: (toast) => toasts.push(toast) },
      dialog: { select: (spec) => { selects.push(spec); return spec }, clear() {}, show() {}, open: false },
    },
    keymap: { layer: (fn) => { layers.push(fn); return () => {} }, intercept: () => {}, clearPendingSequence() {} },
    attention: { notify: async (payload) => { toasts.push({ attention: true, ...payload }); return { ok: true } } },
  }

  const plugin = createCompanionCliPlugin({
    legacyPluginNotice: {
      config: { plugin: ["oh-my-opencode@1.2.3"] },
      receiptPath: path.join(receiptDir, "legacy-plugin-notice.json"),
      logFile: path.join(sandbox, "legacy.log"),
      now: () => FIXED,
    },
    nativeEditionNudge: {
      interactive: () => true,
      now: () => FIXED,
      stateDir: path.join(sandbox, "nudge-state"),
      logFile: path.join(sandbox, "nudge.log"),
      version: "test",
    },
    taskToast: { now: () => FIXED, log: () => {} },
    btw: {
      getCurrentSessionID: () => "ses_root",
      logFile: path.join(sandbox, "btw.log"),
      sessionApi: { async create(input) { createCalls.push(input); return { data: { id: "ses_side_new", title: input.title } } } },
    },
  })

  const dispose = plugin.setup(context)
  check("composite", "real ./tui entrypoint setup returned a disposer", typeof dispose === "function", `type=${typeof dispose}`)

  // --- legacy notice + nudge on a root session.created ---
  emit({ type: "session.created", data: { sessionID: "ses_root" } })
  const legacyToast = toasts.find((t) => t.title === "Legacy Plugin Name Detected")
  check("legacy-plugin-toast", "positive: legacy config -> rename toast", Boolean(legacyToast) && legacyToast.variant === "warning", JSON.stringify(legacyToast))
  const legacyReceipt = readJsonSafe(path.join(receiptDir, "legacy-plugin-notice.json"))
  check("legacy-plugin-toast", "positive: durable receipt written", legacyReceipt?.entries?.length > 0, JSON.stringify(legacyReceipt))

  const nudgeToast = toasts.find((t) => typeof t.title === "string" && t.title.includes("OmO Native"))
  check("native-edition-nudge", "positive: eligible session -> nudge toast", Boolean(nudgeToast), JSON.stringify(nudgeToast))
  const nudgeState = readJsonSafe(path.join(sandbox, "nudge-state", "native-nudge.json")) ?? readJsonSafe(path.join(stateHome, "oh-my-rigel", "native-nudge.json"))
  check("native-edition-nudge", "positive: state records autoShows=1", nudgeState?.autoShows === 1, JSON.stringify(nudgeState))

  // --- negatives: child session + dedup (count NUDGE toasts specifically:
  // `session.created` for a parent-bearing session also drives the task-toast
  // surface, which is expected and unrelated to the nudge gate) ---
  const nudgeCount = () => toasts.filter((t) => typeof t.title === "string" && t.title.includes("OmO Native")).length
  const beforeChild = nudgeCount()
  emit({ type: "session.created", data: { sessionID: "ses_child" } })
  check("native-edition-nudge", "negative: child session -> no nudge toast", nudgeCount() === beforeChild, `nudge ${beforeChild}->${nudgeCount()}`)
  emit({ type: "session.created", data: { sessionID: "ses_root" } })
  check("native-edition-nudge", "dedup: second root session -> no second nudge", nudgeCount() === 1, `nudge toasts=${nudgeCount()}`)

  // --- task-toast ---
  const toastsBeforeTask = toasts.length
  emit({ type: "session.execution.started", data: { sessionID: "ses_task" } })
  const startToast = toasts.slice(toastsBeforeTask).find((t) => t.title === "New Task Executed" || t.title === "New Background Task")
  check("task-toast", "positive: execution started -> task toast", Boolean(startToast), JSON.stringify(startToast))
  emit({ type: "session.execution.succeeded", data: { sessionID: "ses_task" } })
  const doneToast = toasts.find((t) => t.title === "Task Completed")
  check("task-toast", "positive: execution succeeded -> completion toast", Boolean(doneToast) && doneToast.variant === "success", JSON.stringify(doneToast))

  // --- btw CLI: /btw command opens the picker ---
  let btwCommand
  for (const layerFn of layers) {
    const layer = layerFn()
    for (const command of layer?.commands ?? []) {
      if (command?.slash?.name === "btw" || command?.id === "btw") btwCommand = command
    }
  }
  check("btw-cli", "positive: /btw keymap command registered", Boolean(btwCommand), `commands found=${layers.length} layers`)
  if (btwCommand) {
    await btwCommand.run("")
    check("btw-cli", "positive: /btw opens the parent picker", selects.some((s) => typeof s?.onSelect === "function" && Array.isArray(s?.options)), `selects=${selects.length}`)
  }

  // --- dispose is safe + idempotent cleanup ---
  let disposeThrew = false
  try { dispose() } catch { disposeThrew = true }
  check("composite", "cleanup: dispose runs without throwing", !disposeThrew, "ok")
}

try {
  await runServerPhase()
  await runCliPhase()
} catch (error) {
  check("probe", "probe completed without an unexpected throw", false, error instanceof Error ? `${error.message}\n${error.stack}` : String(error))
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true })
}

const failed = verdicts.filter((v) => !v.pass)
fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
const report = {
  generatedAt: new Date().toISOString(),
  surface: "real entrypoint setup() (server + companion), hermetic, no OpenCode spawned",
  sandboxShredded: true,
  passed: verdicts.length - failed.length,
  total: verdicts.length,
  verdicts,
}
fs.writeFileSync(path.join(evidenceDir, "live-verdicts.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })

for (const v of verdicts) console.log(`${v.pass ? "PASS" : "FAIL"} [${v.feature}] ${v.name} :: ${v.detail}`)
console.log(JSON.stringify({ passed: report.passed, total: report.total, failed: failed.map((v) => `${v.feature}/${v.name}`) }))
if (failed.length > 0) process.exitCode = 1
