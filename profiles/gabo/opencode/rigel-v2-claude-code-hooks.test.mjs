import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createNativeContextCollector } from "./rigel-v2-context-collector.mjs"
import { createNativeClaudeCodeHooks } from "./rigel-v2-claude-code-hooks.mjs"

test("native Claude Code hooks dispatch every V2 lifecycle and register prompt output", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rigel-claude-hooks-"))
  const log = path.join(directory, "events.log")
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
  const hook = (event) => ({ hooks: [{ type: "command", command: `printf ${quote(event)} >> ${quote(log)}` }] })
  await fs.mkdir(path.join(directory, ".claude"), { recursive: true })
  await fs.writeFile(path.join(directory, ".claude", "settings.json"), JSON.stringify({ hooks: {
    UserPromptSubmit: [{ matcher: ".*", hooks: [{ type: "command", command: "grep -q '\"transcript\"' && printf prompt-context" }] }],
    PreToolUse: [hook("pre\n")], PostToolUse: [hook("post\n")], PreCompact: [hook("compact\n")],
    SessionStart: [hook("start\n")], Stop: [hook("stop\n")],
  } }))
  const handlers = {}
  const context = {
    location: { directory },
    session: {
      hook: async (name, handler) => { handlers[name] = handler; return { dispose() {} } },
      context: async () => [{ role: "user", content: "transcript" }],
      // The V2 event subscription is global: `session.created`/`session.idle`
      // arrive for every project's sessions. The instance's own sessions resolve
      // to its `directory`; any other session resolves elsewhere.
      get: async ({ sessionID }) => ({ data: { location: { directory: sessionID === "ses_root" ? directory : path.join(directory, "other-project") } } }),
    },
    tool: { hook: async (name, handler) => { handlers[`tool.${name}`] = handler; return { dispose() {} } } },
  }
  const collector = createNativeContextCollector()
  const runtime = createNativeClaudeCodeHooks({ context, collector, directory })
  const dispose = await runtime.install()
  await handlers.prompt({ sessionID: "ses_root", prompt: { text: "work" } })
  await handlers.compaction({ sessionID: "ses_root" })
  await handlers["tool.execute.before"]({ sessionID: "ses_root", tool: "read", input: { path: "file" } })
  await handlers["tool.execute.after"]({ sessionID: "ses_root", tool: "read", output: "ok" })
  await runtime.handleEvent({ type: "session.created", sessionID: "ses_root" })
  await runtime.handleEvent({ type: "session.idle", sessionID: "ses_root" })
  expect(collector.getPending("ses_root")).toMatchObject({ hasContent: true, merged: "prompt-context", entries: [expect.objectContaining({ source: "custom", priority: "high" })] })
  expect((await fs.readFile(log, "utf8")).trim().split("\n").sort()).toEqual(["compact", "post", "pre", "start", "stop"])
  await fs.mkdir(path.join(directory, ".opencode"), { recursive: true })
  await fs.writeFile(path.join(directory, ".opencode", "opencode-cc-plugin.json"), JSON.stringify({ disabledHooks: { PreToolUse: ["events.log"] } }))
  await handlers["tool.execute.before"]({ sessionID: "ses_root", tool: "read", input: { path: "disabled" } })
  expect((await fs.readFile(log, "utf8")).trim().split("\n").sort()).toEqual(["compact", "post", "pre", "start", "stop"])

  // negative: a session from ANOTHER project must not drive this project's
  // `.claude/settings.json` hooks, even though the event subscription is global.
  const beforeForeign = (await fs.readFile(log, "utf8")).trim()
  await runtime.handleEvent({ type: "session.created", sessionID: "ses_foreign" })
  await runtime.handleEvent({ type: "session.idle", sessionID: "ses_foreign" })
  expect((await fs.readFile(log, "utf8")).trim()).toBe(beforeForeign)

  dispose()
  await fs.rm(directory, { recursive: true, force: true })
})

test("native Claude Code hooks prove session membership through the seam and fail closed when it cannot", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rigel-claude-hooks-scope-"))
  const log = path.join(directory, "scope.log")
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
  const hook = (event) => ({ hooks: [{ type: "command", command: `printf ${quote(event)} >> ${quote(log)}` }] })
  await fs.mkdir(path.join(directory, ".claude"), { recursive: true })
  await fs.writeFile(path.join(directory, ".claude", "settings.json"), JSON.stringify({ hooks: {
    SessionStart: [hook("start\n")], Stop: [hook("stop\n")],
  } }))
  const lineCount = async () => {
    try { return (await fs.readFile(log, "utf8")).split("\n").filter((line) => line.length > 0).length } catch { return 0 }
  }
  const dispatch = async (sessionGet) => {
    const context = {
      location: { directory },
      session: { hook: async () => ({ dispose() {} }), context: async () => [], ...(sessionGet ? { get: sessionGet } : {}) },
      tool: { hook: async () => ({ dispose() {} }) },
    }
    const runtime = createNativeClaudeCodeHooks({ context, collector: createNativeContextCollector(), directory })
    await runtime.install()
    await runtime.handleEvent({ type: "session.created", sessionID: "ses_scope" })
    await runtime.handleEvent({ type: "session.idle", sessionID: "ses_scope" })
  }
  const own = async () => ({ data: { location: { directory } } })
  const foreign = async () => ({ data: { location: { directory: path.join(directory, "elsewhere") } } })
  const throwing = async () => { throw new Error("seam-failure") }
  const empty = async () => ({ data: {} })
  const cases = [
    ["own session fires", own, 2],
    ["foreign session does not fire", foreign, 0],
    ["throwing seam fails closed", throwing, 0],
    ["unresolved seam fails closed", empty, 0],
    ["absent seam keeps compatibility", undefined, 2],
  ]
  for (const [label, sessionGet, expectedDelta] of cases) {
    const before = await lineCount()
    await dispatch(sessionGet)
    const after = await lineCount()
    expect([label, after - before]).toEqual([label, expectedDelta])
  }
  // no session id: with the seam present membership cannot be proven -> closed
  const beforeNoId = await lineCount()
  const contextNoId = {
    location: { directory },
    session: { hook: async () => ({ dispose() {} }), context: async () => [], get: own },
    tool: { hook: async () => ({ dispose() {} }) },
  }
  const runtimeNoId = createNativeClaudeCodeHooks({ context: contextNoId, collector: createNativeContextCollector(), directory })
  await runtimeNoId.install()
  await runtimeNoId.handleEvent({ type: "session.created" })
  expect(await lineCount()).toBe(beforeNoId)
  await fs.rm(directory, { recursive: true, force: true })
})
