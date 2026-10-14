import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./rigel-v2-native.mjs"
import * as nativeRuntime from "./rigel-v2-native.mjs"
import nativeManifest from "./rigel-v2-native-agent-manifest.mjs"
import { registerNativeAgents, resolveProactiveAgentModels } from "./rigel-v2-native-agents.mjs"
import { resolveAuthoritativeAgentOverrides } from "./rigel-v2-native-explicit-chain.mjs"
import { readAgentOverridesFromConfig } from "./rigel-v2-native-config.mjs"
import { INTERRUPTED_TOOL_ERROR } from "./rigel-v2-flow-logic.mjs"
import { CONTINUATION_PROMPT_MARKER } from "./rigel-v2-native-request-steps.mjs"

// Deterministic event feed for the reactive-fallback tests. The generator
// blocks until an event is pushed, and signals consumption only AFTER the
// runtime finished processing it, so tests synchronize on the loop advancing
// instead of guessing with a sleep. The abort signal ends the generator so
// `dispose()` never hangs.
function createEventFeed() {
  const queue = []
  let notify
  let onConsumed
  let abortSignal
  const events = {
    async *[Symbol.asyncIterator]() {
      while (!abortSignal?.aborted) {
        while (queue.length === 0) {
          if (abortSignal?.aborted) return
          await new Promise((resolve) => {
            notify = resolve
            abortSignal?.addEventListener("abort", resolve, { once: true })
          })
        }
        if (abortSignal?.aborted) return
        yield queue.shift()
        const consumed = onConsumed
        onConsumed = undefined
        consumed?.()
      }
    },
  }
  return {
    events,
    requestHook: undefined,
    promptHook: undefined,
    subscribe: ({ signal } = {}) => { abortSignal = signal; return events },
    push(event) {
      queue.push(event)
      const resolve = notify
      notify = undefined
      resolve?.()
    },
    consumed() {
      return new Promise((resolve) => { onConsumed = resolve })
    },
  }
}

function reactiveFallbackContext(feed, { switchModel, models } = {}) {
  return {
    location: { directory: "/native-v2" },
    agent: {
      list: async () => ({ data: [{ id: "explore", name: "Explore", mode: "subagent" }] }),
      transform: async () => ({ dispose() {} }),
      reload: async () => {},
    },
    model: { list: async () => ({ data: models ?? [
      { providerID: "opencode-go", id: "qwen3.7-plus", enabled: true },
      { providerID: "openai", id: "gpt-6-luna-fast", enabled: true },
    ] }) },
    event: { subscribe: feed.subscribe },
    session: {
      hook: async (name, handler) => { if (name === "model.request") feed.requestHook = handler; if (name === "prompt") feed.promptHook = handler; return { dispose() {} } },
      create: async () => ({ data: { id: "ses_child" } }),
      prompt: async () => ({ data: {} }),
      ...(switchModel ? { switchModel } : {}),
    },
    tool: { transform: async (callback) => { callback({ add() {} }); return { dispose() {} } } },
  }
}

function childRequest() {
  return {
    sessionID: "ses_child",
    agent: "explore",
    model: { providerID: "opencode-go", modelID: "grok-4.7" },
    request: new Request("https://example.invalid/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "grok-4.7", messages: [{ role: "user", content: "work" }] }),
    }),
  }
}

// The runtime reads the LIVE `~/.omo/omo.jsonc` at plugin setup, so the model
// source for every reactive-fallback test is a disposable HOME. This also
// isolates the tests from the developer's real `~/.omo/omo.jsonc`: a test never
// depends on (or leaks into) a real per-agent configuration.
async function withLiveAgentConfig(agents, run) {
  const sandbox = mkdtempSync(join(tmpdir(), "rigel-live-agent-"))
  const home = join(sandbox, "home")
  mkdirSync(join(home, ".omo"), { recursive: true })
  writeFileSync(join(home, ".omo", "omo.jsonc"), `${JSON.stringify({ agents }, null, 2)}\n`)
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    return await run()
  } finally {
    process.env.HOME = previousHome
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// Same live-HOME sandbox as `withLiveAgentConfig`, but for a FULL `omo.jsonc`
// payload so the live `categories` block can be driven through the real setup
// boundary. `undefined` writes NO file, i.e. the `absent` state.
async function withLiveOmoConfig(config, run) {
  const sandbox = mkdtempSync(join(tmpdir(), "rigel-live-omo-"))
  const home = join(sandbox, "home")
  mkdirSync(join(home, ".omo"), { recursive: true })
  if (config !== undefined) writeFileSync(join(home, ".omo", "omo.jsonc"), `${JSON.stringify(config, null, 2)}\n`)
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    return await run()
  } finally {
    process.env.HOME = previousHome
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// Assert the real service HOME is never the developer's: process.env.HOME must
// be restored after every sandboxed test, so an interleaved test cannot read a
// leaked sandbox (or the real) config.
test("withLiveAgentConfig restores HOME (test isolation invariant)", async () => {
  const original = process.env.HOME
  await withLiveAgentConfig({ oracle: { model: "opencode/nemotron-3-ultra-free" } }, async () => {
    expect(process.env.HOME).not.toBe(original)
  })
  expect(process.env.HOME).toBe(original)
})

test("native runtime uses the V2 setup context, not context.client", async () => {
  let definition
  const calls = []
  const context = {
    location: { directory: "/native-v2" },
    agent: {
      list: async ({ location }) => {
        calls.push(["agents", location])
        return { data: [{ id: "explore", name: "Explore", mode: "subagent" }] }
      },
      transform: async (callback) => { callback({ update() {}, default() {} }); return { dispose() {} } },
      reload: async () => {},
    },
    session: {
      hook: async () => ({ dispose() {} }),
      create: async (input) => { calls.push(["create", input]); return { data: { id: "ses_native" } } },
      prompt: async (input) => { calls.push(["prompt", input]); return { data: {} } },
    },
    tool: { transform: async (callback) => {
      callback({ add: (value) => { if (value?.name === "rigel_task") definition = value } })
      return { dispose() {} }
    } },
  }
  const dispose = await plugin.setup(context)
  expect(definition.description).toContain("active V2 agent inventory")
  expect(definition.description).not.toContain("Available named specialists:")
  // Strict Responses-API tool-schema validation rejects a parameter whose root
  // is an anyOf/oneOf union ("rigel_task: tool parameter root must be an object
  // type"); the root must be a plain object schema. Live: grok-4.7/grok-4.6.
  expect(definition.input.type).toBe("object")
  expect(definition.input.anyOf).toBeUndefined()
  expect(definition.input.oneOf).toBeUndefined()
  // Background delegation now requires a parent session so admission can key and
  // track the queued/active child. Without one it is rejected before any create.
  await expect(definition.execute({ subagent_type: "explore", prompt: "Read only.", run_in_background: true }, {})).rejects.toThrow("requires a parent session")
  // inventory resolution is the only call so far; no child was created
  expect(calls.filter((call) => call[0] === "create")).toEqual([])
  const result = await definition.execute({ subagent_type: "explore", prompt: "Read only.", run_in_background: true }, { sessionID: "ses_parent" })
  expect(result.metadata).toMatchObject({ sessionID: "ses_native", agent: "Explore", background: true })
  expect(calls.slice(0, 3)).toEqual([
    ["agents", { directory: "/native-v2" }],
    ["agents", { directory: "/native-v2" }],
    ["create", { agent: "explore", location: { directory: "/native-v2" }, parentID: "ses_parent" }],
  ])
  expect(calls[3][0]).toBe("prompt")
  expect(calls[3][1].sessionID).toBe("ses_native")
  expect(calls[3][1].resume).toBe(true)
  // The child prompt carries the taskId nonce used to reconcile the starting
  // crash window without re-creating the child.
  expect(calls[3][1].text).toContain("<rigel-task-id>")
  expect(calls[3][1].text).toContain("Read only.")
  await dispose()
})

test("native runtime rejects coordinator delegation before any agent or session work", async () => {
  let definition
  const calls = []
  const context = {
    location: { directory: "/native-v2" },
    agent: {
      list: async ({ location }) => {
        calls.push(["agents", location])
        return { data: [{ id: "explore", name: "Explore", mode: "subagent" }] }
      },
      transform: async (callback) => { callback({ update() {}, default() {} }); return { dispose() {} } },
      reload: async () => {},
    },
    session: {
      hook: async () => ({ dispose() {} }),
      create: async (input) => { calls.push(["create", input]); return { data: { id: "ses_native" } } },
      prompt: async (input) => { calls.push(["prompt", input]); return { data: {} } },
    },
    tool: { transform: async (callback) => {
      callback({ add: (value) => { if (value?.name === "rigel_task") definition = value } })
      return { dispose() {} }
    } },
  }
  const dispose = await plugin.setup(context)
  await expect(definition.execute({ subagent_type: "Prometheus - Plan Builder", prompt: "Plan this.", run_in_background: true }, {})).rejects.toThrow("Cannot delegate to coordinator agent")
  expect(calls).toEqual([])
  await dispose()
})

test("native runtime wakes only the recorded parent when a background child succeeds", async () => {
  let definition
  let yieldEvent
  const prompts = []
  const events = {
    async *[Symbol.asyncIterator]() {
      yield await new Promise((resolve) => { yieldEvent = resolve })
    },
  }
  const context = {
    location: { directory: "/native-v2" },
    agent: {
      list: async () => ({ data: [{ id: "explore", name: "Explore", mode: "subagent" }] }),
      transform: async () => ({ dispose() {} }),
      reload: async () => {},
    },
    event: { subscribe: () => events },
    session: {
      hook: async () => ({ dispose() {} }),
      create: async () => ({ data: { id: "ses_child" } }),
      context: async () => [{ type: "assistant", content: [{ type: "text", text: "SPECIALIST_EVIDENCE" }] }],
      prompt: async (input) => { prompts.push(input); return { data: {} } },
    },
    tool: { transform: async (callback) => { callback({ add: (value) => { if (value?.name === "rigel_task") definition = value } }); return { dispose() {} } } },
  }
  const dispose = await plugin.setup(context)
  await definition.execute({ subagent_type: "explore", prompt: "Read only.", run_in_background: true }, { sessionID: "ses_parent" })
  yieldEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_child" } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(prompts).toContainEqual(expect.objectContaining({
    sessionID: "ses_parent",
    resume: true,
    text: expect.stringContaining("<rigel-native-background-result>"),
  }))
  expect(prompts.at(-1).text).toContain("SPECIALIST_EVIDENCE")
  await dispose()
})

test("native runtime resolves the next chain rung when the primary model is unavailable", async () => {
  let requestHook
  const context = {
    location: { directory: "/native-v2" },
    agent: {
      list: async () => ({ data: [{ id: "explore", name: "Explore", mode: "subagent" }] }),
      transform: async () => ({ dispose() {} }),
      reload: async () => {},
    },
    model: { list: async () => ({ data: [{ providerID: "opencode-go", id: "kimi-k3", enabled: true }] }) },
    session: {
    hook: async (name, handler) => { if (name === "model.request") requestHook = handler; return { dispose() {} } },
      create: async () => ({ data: { id: "ses_child" } }),
      prompt: async () => ({ data: {} }),
    },
    tool: { transform: async (callback) => { callback({ add() {} }); return { dispose() {} } } },
  }
  // JSON-only: the resolvable rung is the user's `fallback_models` rung, not a
  // built-in canonical chain.
  await withLiveAgentConfig({ sisyphus: { fallback_models: ["opencode-go/kimi-k3"] } }, async () => {
    const dispose = await plugin.setup(context)
    const input = {
      sessionID: "ses_root",
      agent: "Sisyphus - ultraworker",
      model: { providerID: "opencode-go", modelID: "missing-primary" },
      request: new Request("https://example.invalid/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "missing-primary", messages: [{ role: "user", content: "work" }] }),
      }),
    }
    await requestHook(input)
    expect((await input.request.clone().json()).model).toBe("kimi-k3")
    await dispose()
  })
})

test("native runtime keeps reactive fallback inside the provider V2 already selected", async () => {
  let requestHook
  let definition
  let yieldEvent
  const prompts = []
  const handoff = (() => {
    let resolve
    const promise = new Promise((settle) => { resolve = settle })
    return { promise, resolve }
  })()
  const events = {
    async *[Symbol.asyncIterator]() {
      yield await new Promise((resolve) => { yieldEvent = resolve })
    },
  }
  const context = {
    location: { directory: "/native-v2" },
    agent: {
      list: async () => ({ data: [{ id: "explore", name: "Explore", mode: "subagent" }] }),
      transform: async () => ({ dispose() {} }),
      reload: async () => {},
    },
    model: { list: async () => ({ data: [
      { providerID: "kimi-for-coding", id: "kimi-for-coding-highspeed", enabled: true },
      { providerID: "openai", id: "gpt-6-luna-fast", enabled: true },
    ] }) },
    event: { subscribe: () => events },
    session: {
    hook: async (name, handler) => { if (name === "model.request") requestHook = handler; return { dispose() {} } },
      create: async () => ({ data: { id: "ses_child" } }),
      prompt: async (input) => {
        prompts.push(input)
        if (typeof input.text === "string" && input.text.includes("<rigel-native-background-result>")) handoff.resolve(input)
        return { data: {} }
      },
    },
    tool: { transform: async (callback) => { callback({ add: (value) => { if (value?.name === "rigel_task") definition = value } }); return { dispose() {} } } },
  }
  // JSON-only: the user's chain is the only fallback the session walks, so a
  // cross-provider built-in rung (kimi) can never reach the openai route. Two
  // rungs keep the re-resolution headroom the single-rung bound would exhaust.
  await withLiveAgentConfig({ explore: { fallback_models: ["openai/gpt-6-luna-fast(low)", "openai/gpt-5.6-sol(low)"] } }, async () => {
    const dispose = await plugin.setup(context)
    await definition.execute({ subagent_type: "explore", prompt: "Read only.", run_in_background: true }, { sessionID: "ses_parent" })

    // V2 already selected openai.
    const request = () => ({
      sessionID: "ses_child",
      agent: "explore",
      model: { providerID: "openai", modelID: "kimi-for-coding-highspeed" },
      request: new Request("https://example.invalid/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "kimi-for-coding-highspeed", messages: [{ role: "user", content: "work" }] }),
      }),
    })

    const first = request()
    await requestHook(first)
    expect((await first.request.clone().json()).model).toBe("gpt-6-luna-fast")

    yieldEvent({ type: "session.execution.failed", data: { sessionID: "ses_child" } })
    const signal = await Promise.race([
      handoff.promise.then(() => "handoff"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000)),
    ])
    expect(signal).toBe("handoff")

    const second = request()
    await requestHook(second)
    const secondModel = (await second.request.clone().json()).model
    expect(secondModel).not.toBe("kimi-for-coding-highspeed")
    expect(secondModel).toBe("gpt-6-luna-fast")
    await dispose()
  })
})

test("native runtime applies a reactive fallback rung through session.switchModel", async () => {
  const switched = []
  const feed = createEventFeed()
  const context = reactiveFallbackContext(feed, {
    switchModel: async (input) => { switched.push(input); return { data: {} } },
  })
  await withLiveAgentConfig({ explore: { fallback_models: ["openai/gpt-6-luna-fast(low)"] } }, async () => {
    const dispose = await plugin.setup(context)
    expect(typeof feed.requestHook).toBe("function")

    const first = childRequest()
    await feed.requestHook(first)
    // JSON-only and the active provider is opencode-go: the user chain has no
    // opencode-go rung, so the pre-failure request is left untouched.
    expect((await first.request.clone().json()).model).toBe("grok-4.7")

    const consumed = feed.consumed()
    feed.push({ type: "session.execution.failed", data: { sessionID: "ses_child" } })
    await Promise.race([consumed, new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000))])
    // The reactive walk is cross-provider: the user's first reachable rung is
    // gpt-6-luna-fast on openai, so switchModel must carry that providerID.
    expect(switched).toEqual([
      { sessionID: "ses_child", model: { providerID: "openai", id: "gpt-6-luna-fast" } },
    ])
    await dispose()
  })
})

test("native runtime reactive fallback changes provider when the next chain rung requires it", async () => {
  const switched = []
  const feed = createEventFeed()
  const context = reactiveFallbackContext(feed, {
    // Only the openai rung is available; kimi (rung 1) and opencode-go rungs
    // are absent, so the reactive step must cross from opencode-go to openai.
    switchModel: async (input) => { switched.push(input); return { data: {} } },
    models: [{ providerID: "openai", id: "gpt-6-luna-fast", enabled: true }],
  })
  await withLiveAgentConfig({ explore: { fallback_models: ["openai/gpt-6-luna-fast(low)"] } }, async () => {
    const dispose = await plugin.setup(context)

    const first = childRequest()
    await feed.requestHook(first)
    // Same-provider guard at http.request: the user chain has no opencode-go
    // rung, so the late body rewrite leaves the payload alone.
    expect((await first.request.clone().json()).model).toBe("grok-4.7")

    const consumed = feed.consumed()
    feed.push({ type: "session.execution.failed", data: { sessionID: "ses_child" } })
    await Promise.race([consumed, new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000))])
    expect(switched).toEqual([
      { sessionID: "ses_child", model: { providerID: "openai", id: "gpt-6-luna-fast" } },
    ])
    await dispose()
  })
})

test("native runtime does not switch the model when no chain rung resolves", async () => {
  const switched = []
  const feed = createEventFeed()
  const context = reactiveFallbackContext(feed, {
    switchModel: async (input) => { switched.push(input); return { data: {} } },
    // Empty inventory: no rung of the explore chain is reachable.
    models: [],
  })
  // The user configured a chain, but the inventory is empty: no rung resolves,
  // so no switch happens and the request is left untouched.
  await withLiveAgentConfig({ explore: { fallback_models: ["deepseek/deepseek-flash"] } }, async () => {
    const dispose = await plugin.setup(context)

    const first = childRequest()
    await feed.requestHook(first)
    expect((await first.request.clone().json()).model).toBe("grok-4.7")

    const consumed = feed.consumed()
    feed.push({ type: "session.execution.failed", data: { sessionID: "ses_child" } })
    await Promise.race([consumed, new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000))])
    expect(switched).toEqual([])
    await dispose()
  })
})

test("native runtime seeds a category child so a pre-request failure still falls back", async () => {
  const switched = []
  const feed = createEventFeed()
  const context = {
    location: { directory: "/native-v2" },
    agent: {
      list: async () => ({ data: [{ id: "Sisyphus-Junior", name: "Sisyphus-Junior", mode: "subagent" }] }),
      transform: async () => ({ dispose() {} }),
      reload: async () => {},
    },
    // The category chain's first reachable rung is opencode-go/mimo-v2.6-pro;
    // the next reachable rung is openai/gpt-5.6-terra (cross-provider).
    model: { list: async () => ({ data: [
      { providerID: "opencode-go", id: "mimo-v2.6-pro", enabled: true },
      { providerID: "openai", id: "gpt-5.6-terra", enabled: true },
    ] }) },
    event: { subscribe: feed.subscribe },
    session: {
      hook: async (name, handler) => { if (name === "http.request") feed.requestHook = handler; return { dispose() {} } },
      create: async () => ({ data: { id: "ses_category_child" } }),
      prompt: async () => ({ data: {} }),
      wait: async () => {},
      context: async () => [{ type: "assistant", content: [{ type: "text", text: "done" }] }],
      switchModel: async (input) => { switched.push(input); return { data: {} } },
    },
    tool: { transform: async (callback) => {
      let definition
      callback({ add: (value) => { if (value?.name === "rigel_task") definition = value }, get: () => definition })
      if (definition) feed.definition = definition
      return { dispose() {} }
    } },
  }
  const dispose = await plugin.setup(context)
  await feed.definition.execute({ category: "unspecified-low", prompt: "Work." }, { sessionID: "ses_parent" })

  // The child never reached http.request; the failure arrives directly.
  const consumed = feed.consumed()
  feed.push({ type: "session.execution.failed", data: { sessionID: "ses_category_child" } })
  await Promise.race([consumed, new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000))])
  expect(switched).toEqual([
    { sessionID: "ses_category_child", model: { providerID: "openai", id: "gpt-5.6-terra" } },
  ])
  await dispose()
})

test("native runtime advances the tracked model across consecutive failures", async () => {
  const switched = []
  const feed = createEventFeed()
  // explore chain reachable rungs: opencode-go qwen3.7-plus, then opencode-go
  // minimax-m2.7. Two failures must switch qwen then minimax; a stalled walk
  // would switch qwen twice.
  const context = reactiveFallbackContext(feed, {
    switchModel: async (input) => { switched.push(input); return { data: {} } },
    models: [
      { providerID: "opencode-go", id: "qwen3.7-plus", enabled: true },
      { providerID: "opencode-go", id: "minimax-m2.7", enabled: true },
    ],
  })
  // JSON-only: the user's two-rung chain advances qwen -> minimax across the
  // two failures. A stalled walk would switch qwen twice.
  await withLiveAgentConfig({ explore: { fallback_models: ["opencode-go/qwen3.7-plus", "opencode-go/minimax-m2.7"] } }, async () => {
    const dispose = await plugin.setup(context)

    const first = childRequest()
    await feed.requestHook(first)
    expect((await first.request.clone().json()).model).toBe("qwen3.7-plus")

    const firstConsumed = feed.consumed()
    feed.push({ type: "session.execution.failed", data: { sessionID: "ses_child" } })
    await Promise.race([firstConsumed, new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000))])

    const secondConsumed = feed.consumed()
    feed.push({ type: "session.execution.failed", data: { sessionID: "ses_child" } })
    await Promise.race([secondConsumed, new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000))])

    expect(switched).toEqual([
      { sessionID: "ses_child", model: { providerID: "opencode-go", id: "qwen3.7-plus" } },
      { sessionID: "ses_child", model: { providerID: "opencode-go", id: "minimax-m2.7" } },
    ])
    await dispose()
  })
})

test("native runtime survives a reactive failure when session.switchModel is absent", async () => {
  const feed = createEventFeed()
  const context = reactiveFallbackContext(feed)
  // A reachable chain is configured, so the reactive path WOULD switch; with no
  // `switchModel` API present the walk must be a guarded no-op, not a crash.
  await withLiveAgentConfig({ explore: { fallback_models: ["openai/gpt-6-luna-fast(low)"] } }, async () => {
    const dispose = await plugin.setup(context)

    const first = childRequest()
    await feed.requestHook(first)

    const firstConsumed = feed.consumed()
    feed.push({ type: "session.execution.failed", data: { sessionID: "ses_child" } })
    await Promise.race([firstConsumed, new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000))])

    const secondConsumed = feed.consumed()
    feed.push({ type: "session.execution.failed", data: { sessionID: "ses_child" } })
    const second = await Promise.race([
      secondConsumed.then(() => "second"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000)),
    ])
    expect(second).toBe("second")
    await dispose()
  })
})

// Task 10: the runtime collects every agent's tool gates through
// `registerNativeAgents.onAgentPermissions`, merges the global gates first so
// an agent-specific gate wins, indexes each agent by manifest id and display
// name, and blocks a denied call in `execute.before` before the executor runs.
function permissionManifest() {
  return {
    agents: {
      sisyphus: { name: "Sisyphus - ultraworker", mode: "primary", permission: { teammate: "allow", task: "allow", call_omo_agent: "allow" } },
      librarian: { name: "librarian", mode: "subagent", permission: { "grep_app_*": "allow", task: "deny" } },
      "multimodal-looker": { name: "Multimodal-Looker", mode: "subagent", permission: { look_at: "deny" } },
    },
    metadata: {
      global: {
        tools: {
          "grep_app_*": false,
          "task_*": false,
          teammate: false,
          LspHover: false,
          LspCodeActions: false,
          LspCodeActionResolve: false,
          skill_mcp: false,
        },
      },
    },
  }
}

async function registerPermissionAgents(wiring, manifest) {
  const agentDomain = {
    transform: async (callback) => {
      callback({ update: (_id, apply) => apply({ request: { headers: {}, body: {} }, permissions: [] }), default() {} })
      return { dispose() {} }
    },
    reload: async () => {},
  }
  await registerNativeAgents(agentDomain, manifest, {
    onAgentPermissions: (id, permissions) => wiring.onAgentPermissions(id, permissions),
  })
}

test("native runtime permission wiring blocks a denied call before the executor runs", async () => {
  const manifest = permissionManifest()
  const wiring = nativeRuntime.createNativePermissionWiring({ manifest })
  await registerPermissionAgents(wiring, manifest)

  let executed = false
  const runTool = async (event) => { await wiring.before(event); executed = true }

  // Global grep_app_* deny with no agent override: the executor must not run.
  await expect(runTool({ tool: "grep_app_searchGitHub", agent: "Multimodal-Looker" })).rejects.toThrow(/denied/)
  expect(executed).toBe(false)

  // The agent look_at deny is reachable by manifest id and by display name.
  await expect(wiring.before({ tool: "look_at", agent: "multimodal-looker" })).rejects.toThrow(/denied/)
  await expect(wiring.before({ tool: "look_at", agent: "Multimodal-Looker" })).rejects.toThrow(/denied/)

  // The legacy Lsp* names are denied by the translated global tools.
  await expect(wiring.before({ tool: "LspCodeActions", agent: "Sisyphus - ultraworker" })).rejects.toThrow(/denied/)

  // T38: the retained OmO lsp_* MCP family is not swallowed by the PascalCase
  // Lsp* built-in disables; the lsp tools stay callable.
  await expect(wiring.before({ tool: "lsp_diagnostics", agent: "Sisyphus - ultraworker" })).resolves.toBeUndefined()

  // V1 precedence: an agent `permission` entry overrides the global `tools`
  // default. Sisyphus has teammate:allow, which re-enables the globally
  // default-denied team_* family for the lead.
  await expect(wiring.before({ tool: "team_create", agent: "Sisyphus - ultraworker" })).resolves.toBeUndefined()

  // T38 regression: the librarian's grep_app_* allow re-enables the globally
  // default-denied grep_app family (V1: only the librarian may search GitHub).
  await expect(wiring.before({ tool: "grep_app_searchGitHub", agent: "librarian" })).resolves.toBeUndefined()

  // An agent allow applies when global tools does not hard-disable the tool.
  await expect(wiring.before({ tool: "call_omo_agent", agent: "Sisyphus - ultraworker" })).resolves.toBeUndefined()

  // An agent with no override still receives the global team_* deny.
  await expect(wiring.before({ tool: "team_create", agent: "Multimodal-Looker" })).rejects.toThrow(/denied/)
})

test("native runtime wildcard agent permission denies every concrete tool name except its allows", async () => {
  const manifest = {
    agents: {
      "multimodal-looker": { name: "Multimodal-Looker", mode: "subagent", permission: { "*": "deny", read: "allow" } },
    },
  }
  const wiring = nativeRuntime.createNativePermissionWiring({ manifest })
  await registerPermissionAgents(wiring, manifest)

  await expect(wiring.before({ tool: "read", agent: "Multimodal-Looker" })).resolves.toBeUndefined()
  await expect(wiring.before({ tool: "call_omo_agent", agent: "multimodal-looker" })).rejects.toThrow(/denied/)
  await expect(wiring.before({ tool: "future_non_native_tool", agent: "Multimodal-Looker" })).rejects.toThrow(/denied/)
  await expect(wiring.before({ tool: "team_create", agent: "Multimodal-Looker" })).rejects.toThrow(/denied/)
})

test("native runtime agent allow overrides a global tools default-deny", async () => {
  const manifest = {
    agents: { sisyphus: { name: "Sisyphus - ultraworker", mode: "primary", permission: { "*": "allow" } } },
    metadata: { global: { tools: { call_omo_agent: false } } },
  }
  const wiring = nativeRuntime.createNativePermissionWiring({ manifest })
  await registerPermissionAgents(wiring, manifest)

  // The agent `*: allow` re-enables the globally default-denied call_omo_agent.
  await expect(wiring.before({ tool: "call_omo_agent", agent: "Sisyphus - ultraworker" })).resolves.toBeUndefined()
  await expect(wiring.before({ tool: "look_at", agent: "Sisyphus - ultraworker" })).resolves.toBeUndefined()
})

test("native runtime permission wiring resolves the agent from the session when the event omits it", async () => {
  const manifest = permissionManifest()
  const seen = []
  const wiring = nativeRuntime.createNativePermissionWiring({
    manifest,
    resolveAgent: async ({ sessionID }) => { seen.push(sessionID); return "Multimodal-Looker" },
  })
  await registerPermissionAgents(wiring, manifest)

  await expect(wiring.before({ tool: "look_at", sessionID: "ses_child" })).rejects.toThrow(/denied/)
  expect(seen).toEqual(["ses_child"])
})

test("native runtime session resolver reads the agent from the V2 session surface", async () => {
  const calls = []
  const resolver = nativeRuntime.createSessionAgentResolver({
    session: { get: async (input) => { calls.push(input); return { data: { agent: "Multimodal-Looker" } } } },
  })
  await expect(resolver({ sessionID: "ses_child" })).resolves.toBe("Multimodal-Looker")
  expect(calls).toEqual([{ sessionID: "ses_child" }])
})

test("native runtime session resolver falls back to the client session surface and tolerates its absence", async () => {
  const paths = []
  const resolver = nativeRuntime.createSessionAgentResolver({
    client: { session: { get: async (input) => { paths.push(input); return { data: { agent: "Explore" } } } } },
  })
  await expect(resolver({ sessionID: "ses_child" })).resolves.toBe("Explore")
  expect(paths).toEqual([{ path: { id: "ses_child" } }])
  await expect(nativeRuntime.createSessionAgentResolver({})({ sessionID: "ses_child" })).resolves.toBeUndefined()
  await expect(nativeRuntime.createSessionAgentResolver({})({})).resolves.toBeUndefined()
})

test("native runtime permission wiring blocks an ask pending approval instead of allowing it", async () => {
  const manifest = { agents: { prometheus: { name: "Prometheus - Planner", permission: { call_omo_agent: "ask" } } } }
  const wiring = nativeRuntime.createNativePermissionWiring({ manifest })
  await registerPermissionAgents(wiring, manifest)

  await expect(wiring.before({ tool: "call_omo_agent", agent: "prometheus" })).rejects.toThrow(/approval/)
})

test("native runtime permission wiring fails closed only for a governed call with no agent identity", async () => {
  const manifest = permissionManifest()
  const wiring = nativeRuntime.createNativePermissionWiring({ manifest, resolveAgent: async () => undefined })
  await registerPermissionAgents(wiring, manifest)

  await expect(wiring.before({ tool: "look_at", sessionID: "ses_1" })).rejects.toThrow(/identity/)
  await expect(wiring.before({ tool: "todo_write", sessionID: "ses_1" })).resolves.toBeUndefined()
})

// Task 11: the runtime composes two ordered tool-hook chains. The recording
// fake observes the registrations in order, and driving a chain returns the
// boundary report from `runOrderedRules`, so the observed hook and rule
// sequences are the real ones instead of a bare handler count.
function recordingHookContext(directory = "/native-v2") {
  const registrations = []
  const record = (name, handler) => {
    const registration = { name, handler, disposed: false, dispose() { registration.disposed = true } }
    registrations.push(registration)
    return registration
  }
  const context = {
    location: { directory },
    agent: {
      list: async () => ({ data: [] }),
      transform: async (callback) => { callback({ update() {}, default() {} }); return { dispose() {} } },
      reload: async () => {},
    },
    model: { list: async () => ({ data: [] }) },
    session: { hook: async (name, handler) => record(name, handler) },
    tool: {
      transform: async (callback) => { callback({ add() {} }); return { dispose() {} } },
      hook: async (name, handler) => record(name, handler),
    },
  }
  return { context, registrations }
}

test("native runtime applies per-turn think reasoning in its registered context hook and leaves the model variant untouched", async () => {
  const { context, registrations } = recordingHookContext()
  const dispose = await plugin.setup(context)
  try {
    const contextRegistration = registrations.find((registration) => registration.name === "context")
    expect(contextRegistration).toBeDefined()

    // A tuning-free agent isolates the think-keyword path from agent tuning.
    const thinking = {
      sessionID: "ses_think_wiring",
      agent: "Prometheus - Plan Builder",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5", variant: "high" },
      system: [],
      messages: [{ role: "user", content: "please think about this" }],
      options: {},
    }
    const modelBefore = structuredClone(thinking.model)
    await contextRegistration.handler(thinking)
    expect(thinking.options.reasoningEffort).toBe("high")
    // Variant routing owns the model ref; the reasoning application must not touch it.
    expect(thinking.model).toEqual(modelBefore)

    const plain = {
      sessionID: "ses_plain_wiring",
      agent: "Prometheus - Plan Builder",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
      system: [],
      messages: [{ role: "user", content: "hello there" }],
      options: {},
    }
    await contextRegistration.handler(plain)
    expect(plain.options.reasoningEffort).toBeUndefined()
  } finally {
    dispose()
  }
})

test("native runtime keeps preemptive compaction a no-op while its gate is off", async () => {
  // The tracked agent manifest is the empty placeholder, so every gate is off.
  // A host that exposes both transcript and compact services must still never
  // request a compaction: the T34 gate is the only switch.
  const { context, registrations } = recordingHookContext()
  const compactCalls = []
  context.session.context = async () => ([{
    id: "m1",
    type: "assistant",
    model: { providerID: "openai", id: "gpt-5" },
    tokens: { input: 999_999, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    content: [{ type: "text", text: "answer" }],
  }])
  context.session.compact = async (input) => { compactCalls.push(input) }
  // A resolvable model limit and a huge token footprint: gate off must still
  // never request a compaction, so the gate is the only switch under test.
  context.model.list = async () => ({ data: [{ providerID: "openai", id: "gpt-5", limit: { context: 1_000 } }] })
  const dispose = await plugin.setup(context)
  try {
    const contextRegistration = registrations.find((registration) => registration.name === "context")
    await contextRegistration.handler({
      sessionID: "ses_preemptive_off",
      agent: "Sisyphus - ultraworker",
      model: { providerID: "openai", modelID: "gpt-5" },
      system: [],
      messages: [{ role: "user", content: "go" }],
      options: {},
    })
    expect(compactCalls).toEqual([])
  } finally {
    await dispose()
  }
})

test("native runtime registers its ordered tool hook chain and disposes every registration", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "rigel-native-hook-order-"))
  try {
    const { context, registrations } = recordingHookContext(workspace)
    const dispose = await plugin.setup(context)

    // Observed from the recording tool.hook/session.hook fake: two
  // execute.after handlers (directory instructions, then the ordered result
  // chain), three execute.before handlers (the ordered write-guard chain,
  // the non-interactive env guard, the permission gate), prompt admission,
  // the claude-code compaction hook, model-visible context, semantic model
  // requests, the T21 compaction-context hook, and image transport.
    expect(registrations.map((registration) => registration.name)).toEqual([
      "execute.after",
      "execute.after",
    "execute.before",
    "execute.before",
    "execute.before",
    "prompt",
    "compaction",
    "execute.before",
    "execute.after",
      "prompt",
      "context",
      "model.request",
      "compaction",
      "http.request",
    ])

    // Driving the after chain returns the boundary report: every rule ran in
    // the declared order and none was isolated. The T14 flow rules are appended
    // after the eight built-in result transforms.
    const afterChain = registrations.filter((registration) => registration.name === "execute.after")
    const afterReport = await afterChain[1].handler({
      status: "completed",
      tool: "read",
      sessionID: "ses_order",
      input: { filePath: "notes.md" },
      result: { content: "file text" },
    })
    expect(afterReport.executed).toEqual([
      "hashline-read-enhancer",
      "tool-result-reminders",
      "category-skill-reminder",
      "recovery-reminder",
      "rules-injector",
      "comment-checker",
      "plan-format-validator",
      "webfetch-redirect-guard",
      "delegate-task-retry",
      "fsync-skip-warning",
      "empty-task-response-detector",
      "tool-output-truncator",
    ])
    expect(afterReport.failures).toEqual([])

    // The before chain preserves the declared native-rule order before the
    // T13 guard rules and the T14 fsync start rule.
    const beforeChain = registrations.filter((registration) => registration.name === "execute.before")
    const beforeReport = await beforeChain[0].handler({
      tool: "read",
      sessionID: "ses_order",
      id: "call_order",
      input: { filePath: "notes.md" },
    })
    expect(beforeReport.executed).toEqual([
      "prometheus-md-only",
      "write-existing-file-guard",
      "comment-checker",
      "webfetch-redirect-guard",
      "mcp-prefix-strip",
      "bash-null-byte-strip",
      "background-sleep-block",
      "notepad-write-guard",
      "question-label-truncator",
      "sisyphus-junior-notepad",
      "bash-file-read-guard",
      "fsync-skip-warning:record-start",
    ])
    expect(beforeReport.failures).toEqual([])

    await dispose()
    expect(registrations.every((registration) => registration.disposed)).toBe(true)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("native runtime wires per-turn think reasoning into the model-visible context without touching the model ref", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "rigel-native-think-"))
  try {
    const { context, registrations } = recordingHookContext(workspace)
    const dispose = await plugin.setup(context)
    try {
      const contextHandler = registrations.find((registration) => registration.name === "context")?.handler
      expect(typeof contextHandler).toBe("function")

      // A think keyword on the current turn raises the semantic reasoning option.
      const think = {
        sessionID: "ses_think",
        agent: "Auditor",
        model: { providerID: "openai", modelID: "gpt-6", variant: "low" },
        system: [],
        messages: [{ role: "user", content: "please think this through" }],
        options: {},
      }
      await contextHandler(think)
      expect(think.options.reasoningEffort).toBe("high")

      // Variant routing lives on the model ref, which this hook must never edit.
      expect(think.model).toEqual({ providerID: "openai", modelID: "gpt-6", variant: "low" })

      // A turn without the keyword carries no reasoning option.
      const control = {
        sessionID: "ses_plain",
        agent: "Auditor",
        model: { providerID: "openai", modelID: "gpt-6" },
        system: [],
        messages: [{ role: "user", content: "hello there" }],
        options: {},
      }
      await contextHandler(control)
      expect(control.options.reasoningEffort).toBeUndefined()
    } finally {
      await dispose()
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("native runtime isolates a throwing execute.before rule and keeps the chain running", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "rigel-native-hook-isolation-"))
  const existing = join(workspace, "existing.txt")
  writeFileSync(existing, "already here\n")
  try {
    const { context, registrations } = recordingHookContext(workspace)
    const dispose = await plugin.setup(context)
    const beforeChain = registrations.filter((registration) => registration.name === "execute.before")

    // The second rule, the write-existing-file guard, throws for a write to an
    // existing file. The chain must resolve anyway, record the failure, and
    // still run the comment-checker and webfetch rules declared after it, plus
    // every T13/T14 flow rule appended at the end.
    const report = await beforeChain[0].handler({
      tool: "write",
      sessionID: "ses_guard",
      id: "call_guard",
      input: { filePath: existing, content: "// a comment\nconst value = 1\n" },
    })

    expect(report.failures.map((failure) => failure.name)).toEqual(["write-existing-file-guard"])
    expect(report.failures[0].error).toBeInstanceOf(Error)
    expect(report.executed).toEqual([
      "prometheus-md-only",
      "comment-checker",
      "webfetch-redirect-guard",
      "mcp-prefix-strip",
      "bash-null-byte-strip",
      "background-sleep-block",
      "notepad-write-guard",
      "question-label-truncator",
      "sisyphus-junior-notepad",
      "bash-file-read-guard",
      "fsync-skip-warning:record-start",
    ])

    await dispose()
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("native runtime isolates a throwing flow rule and keeps the composed before chain running", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "rigel-native-flow-isolation-"))
  try {
    const { context, registrations } = recordingHookContext(workspace)
    const dispose = await plugin.setup(context)
    const beforeChain = registrations.filter((registration) => registration.name === "execute.before")

    // notepad-write-guard is the first T13 flow rule and throws for a write
    // into a notepad root. The four native rules before it already completed,
    // and every flow rule declared after it must still run.
    const report = await beforeChain[0].handler({
      tool: "write",
      sessionID: "ses_flow",
      id: "call_flow",
      input: { filePath: join(workspace, ".omo", "notepads", "plan.md"), content: "notes\n" },
    })

    expect(report.failures.map((failure) => failure.name)).toEqual(["notepad-write-guard"])
    expect(report.failures[0].error).toBeInstanceOf(Error)
    expect(report.executed).toEqual([
      "prometheus-md-only",
      "write-existing-file-guard",
      "comment-checker",
      "webfetch-redirect-guard",
      "mcp-prefix-strip",
      "bash-null-byte-strip",
      "background-sleep-block",
      "question-label-truncator",
      "sisyphus-junior-notepad",
      "bash-file-read-guard",
      "fsync-skip-warning:record-start",
    ])
    await dispose()
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("native runtime repairs tool pairs at the context seam and reserves HTTP for images", async () => {
  const { context, registrations } = recordingHookContext()
  const dispose = await plugin.setup(context)

  // Tool-pair repair is model-visible context. HTTP retains exactly one image
  // transport handler.
  const requestHandlers = registrations.filter((registration) => registration.name === "http.request")
  expect(requestHandlers).toHaveLength(1)
  const contextHandler = registrations.find((registration) => registration.name === "context").handler

  // Legacy Chat Completions shape remains supported (compatibility).
  const input = {
    sessionID: "ses_request",
    agent: "sisyphus",
    model: { providerID: "opencode-go", modelID: "gpt-6-luna-fast" },
    system: [],
    options: {},
    messages: [
      { role: "assistant", content: null, tool_calls: [{ id: "call_orphan", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "user", content: "work" },
    ],
  }
  await contextHandler(input)

  const repaired = input.messages.find((message) => message.role === "tool")
  expect(repaired).toMatchObject({ tool_call_id: "call_orphan", content: INTERRUPTED_TOOL_ERROR })

  // T27: the real V2 parts shape. An orphan tool-call gets a terminal tool-result
  // inserted; a signed reasoning block is left untouched (the V1 thinking-block
  // hook was removed, so the V2 provider transform owns reasoning); an unsupported
  // Anthropic model ending on an assistant tail gets a synthetic user recovery turn.
  const signed = { type: "reasoning", text: "plan", providerMetadata: { anthropic: { signature: "sig-plan" } } }
  const orphan = {
    sessionID: "ses_request_v2",
    agent: "Sisyphus",
    model: { providerID: "openai", modelID: "gpt-6" },
    system: [],
    options: {},
    messages: [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [signed, { type: "tool-call", id: "c1", name: "read", input: {} }] },
    ],
  }
  await contextHandler(orphan)

  const inserted = orphan.messages.find((message) => message.role === "tool")
  expect(inserted).toMatchObject({
    content: [{ type: "tool-result", id: "c1", name: "read", result: { type: "error", value: INTERRUPTED_TOOL_ERROR } }],
  })
  // Reasoning is untouched: no custom thinking effect is ported.
  expect(orphan.messages[1].content[0]).toBe(signed)

  const tail = {
    sessionID: "ses_request_tail",
    agent: "Sisyphus",
    model: { providerID: "anthropic", modelID: "claude-opus-4-8" },
    system: [],
    options: {},
    messages: [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "text", text: "partial" }] },
    ],
  }
  await contextHandler(tail)

  expect(tail.messages.at(-1)).toMatchObject({ role: "user", synthetic: true })
  expect(tail.messages.at(-1).content[0].text).toBe("[internal] Continue from the previous assistant state.")
  await dispose()
})

test("native runtime clears the stop-continuation state when the session is deleted", async () => {
  const feed = createEventFeed()
  const context = reactiveFallbackContext(feed)
  const dispose = await plugin.setup(context)

  const request = (text) => ({
    sessionID: "ses_child",
    prompt: { text },
  })

  const stopped = request(`/stop-continuation\n${CONTINUATION_PROMPT_MARKER}`)
  await feed.promptHook(stopped)
  expect(stopped.prompt.text).not.toContain(CONTINUATION_PROMPT_MARKER)

  const deleted = feed.consumed()
  feed.push({ type: "session.deleted", data: { sessionID: "ses_child" } })
  await deleted

  // The stop flag is gone, so a queued continuation is no longer stripped.
  const resumed = request(CONTINUATION_PROMPT_MARKER)
  await feed.promptHook(resumed)
  expect(resumed.prompt.text).toContain(CONTINUATION_PROMPT_MARKER)
  await dispose()
})

test("native runtime clears the flow state on dispose", async () => {
  const { context, registrations } = recordingHookContext()
  const dispose = await plugin.setup(context)
  const handler = registrations.filter((registration) => registration.name === "prompt").at(-1).handler

  const request = (text) => ({
    sessionID: "ses_dispose",
    prompt: { text },
  })

  const stopped = request(`/stop-continuation\n${CONTINUATION_PROMPT_MARKER}`)
  await handler(stopped)
  expect(stopped.prompt.text).not.toContain(CONTINUATION_PROMPT_MARKER)

  await dispose()

  // The disposed runtime holds no stopped session, so the queued continuation
  // survives the same handler.
  const resumed = request(CONTINUATION_PROMPT_MARKER)
  await handler(resumed)
  expect(resumed.prompt.text).toContain(CONTINUATION_PROMPT_MARKER)
})

test("native runtime clears a deleted session's background child so no wake is delivered", async () => {
  const prompts = []
  const feed = createEventFeed()
  let definition
  const context = {
    location: { directory: "/native-v2" },
    agent: {
      list: async () => ({ data: [{ id: "explore", name: "Explore", mode: "subagent" }] }),
      transform: async () => ({ dispose() {} }),
      reload: async () => {},
    },
    event: { subscribe: feed.subscribe },
    session: {
      hook: async (name, handler) => { if (name === "http.request") feed.requestHook = handler; return { dispose() {} } },
      create: async () => ({ data: { id: "ses_child" } }),
      context: async () => [{ type: "assistant", content: [{ type: "text", text: "EVIDENCE" }] }],
      prompt: async (input) => { prompts.push(input); return { data: {} } },
    },
    tool: { transform: async (callback) => { callback({ add: (value) => { if (value?.name === "rigel_task") definition = value } }); return { dispose() {} } } },
  }
  const dispose = await plugin.setup(context)
  await definition.execute({ subagent_type: "explore", prompt: "Read only.", run_in_background: true }, { sessionID: "ses_parent" })

  const deleted = feed.consumed()
  feed.push({ type: "session.deleted", data: { sessionID: "ses_child" } })
  await deleted

  // If the registry had not cleared the deleted session's background child,
  // this success would have prompted the parent with the child's result.
  const succeeded = feed.consumed()
  feed.push({ type: "session.execution.succeeded", data: { sessionID: "ses_child" } })
  await succeeded

  // The child's own task prompt is expected; the parent wake is not.
  expect(prompts.filter((input) => input.sessionID === "ses_parent")).toEqual([])
  await dispose()
})

test("native runtime cancels a stopped session's tracked descendant child on /stop-continuation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rigel-native-stop-bg-"))
  try {
    const feed = createEventFeed()
    const interrupted = []
    let childCounter = 0
    let definition
    const context = {
      location: { directory },
      agent: {
        list: async () => ({ data: [{ id: "explore", name: "Explore", mode: "subagent" }] }),
        transform: async () => ({ dispose() {} }),
        reload: async () => {},
      },
      event: { subscribe: feed.subscribe },
      session: {
        hook: async (name, handler) => { if (name === "prompt") feed.promptHook = handler; return { dispose() {} } },
        create: async () => ({ data: { id: `ses_child_${++childCounter}` } }),
        context: async () => [],
        prompt: async () => ({ data: {} }),
        interrupt: async ({ sessionID }) => { interrupted.push(sessionID); return { data: {} } },
      },
      tool: { transform: async (callback) => { callback({ add: (value) => { if (value?.name === "rigel_task") definition = value } }); return { dispose() {} } } },
    }
    const dispose = await plugin.setup(context)
    try {
      await definition.execute({ subagent_type: "explore", prompt: "Read only.", run_in_background: true }, { sessionID: "ses_parent" })
      expect(interrupted).toEqual([])

      // when: /stop-continuation reaches the parent session
      const request = {
        sessionID: "ses_parent",
        prompt: { text: "/stop-continuation" },
      }
      await feed.promptHook(request)

      // then: the tracked running child is aborted and the shared stop marker
      // records the stopped state.
      expect(interrupted).toEqual(["ses_child_1"])
      const marker = JSON.parse(readFileSync(join(directory, ".omo/run-continuation/ses_parent.json"), "utf-8"))
      expect(marker.sources.stop.state).toBe("stopped")
    } finally {
      await dispose()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

// Task 19: the hashline edit tool is registered only when the materialized
// `hashline_edit` gate is on. The runtime reads the manifest singleton at setup
// time, so the gated case turns the gate on for the duration of one setup and
// restores it; the negative control exercises the shipped default manifest,
// whose gate is absent.
function editorCaptureContext() {
  const added = []
  const context = {
    location: { directory: "/native-v2" },
    agent: {
      list: async () => ({ data: [] }),
      transform: async (callback) => { callback({ update() {}, default() {} }); return { dispose() {} } },
      reload: async () => {},
    },
    model: { list: async () => ({ data: [] }) },
    session: {
      hook: async () => ({ dispose() {} }),
      create: async () => ({ data: { id: "ses_native" } }),
      prompt: async () => ({ data: {} }),
    },
    tool: {
      transform: async (callback) => {
        callback({ add: (definition) => added.push(definition?.name), get: () => undefined })
        return { dispose() {} }
      },
    },
  }
  return { context, added }
}

// A fake V2 context for the /goal command tests: real storage-backed goal state
// plus a `session.prompt` that records the deliveries the host would render. The
// V2 host discards a command executor's return value, so these deliveries — not
// the return value — are the command's observable output.
function goalCommandHarness() {
  const storage = new Map()
  const commands = new Map()
  const deliveries = []
  const context = {
    ...editorCaptureContext().context,
    storage: {
      async get(key) { return storage.get(key) },
      async set(key, value) { storage.set(key, value) },
      async remove(key) { storage.delete(key) },
    },
    session: {
      hook: async () => ({ dispose() {} }),
      create: async () => ({ data: { id: "ses_native" } }),
      prompt: async (arg) => { deliveries.push(arg); return { data: {} } },
    },
    command: {
      transform: async (callback) => {
        callback({ add: (definition) => commands.set(definition.name, definition) })
        return { dispose() {} }
      },
    },
  }
  return { context, commands, deliveries }
}

test("native runtime registers hashline_edit when the manifest gate is on", async () => {
  // The generator replaces the manifest default export with the materialized
  // gates at installation time. Mutate the shared manifest object the runtime
  // reads, then restore it, so the gated registration runs against a real
  // setup instead of a fixture-only editor.
  const originalMetadata = nativeManifest.metadata
  nativeManifest.metadata = { global: { gates: { hashline_edit: true } } }
  try {
    const { context, added } = editorCaptureContext()
    const dispose = await plugin.setup(context)
    expect(added).toContain("hashline_edit")
    await dispose()
  } finally {
    if (originalMetadata === undefined) delete nativeManifest.metadata
    else nativeManifest.metadata = originalMetadata
  }
})

test("native runtime omits hashline_edit when the manifest gate is absent", async () => {
  const { context, added } = editorCaptureContext()
  const dispose = await plugin.setup(context)
  expect(added).toContain("rigel_task")
  expect(added).not.toContain("hashline_edit")
  await dispose()
})

// The inherited Goal is quarantined. Forcing the manifest gate on must still
// register NOTHING: no `/goal` command (N1), no legacy goal tool (N2), no goal
// store access (N5), and a clean dispose (N7). The vendored community engine
// owns `/goal` instead.
test("native runtime quarantines the inherited goal: forcing gates.goal registers no command, tool or store access", async () => {
  const originalMetadata = nativeManifest.metadata
  nativeManifest.metadata = { global: { gates: { goal: true } } }
  const commands = new Map()
  const added = []
  let goalStoreWrites = 0
  const context = {
    ...editorCaptureContext().context,
    storage: {
      async get() { return undefined },
      async set(key) { if (String(key).startsWith("rigel-v2/goal")) goalStoreWrites++; return undefined },
      async remove() { return undefined },
    },
    tool: {
      transform: async (callback) => {
        callback({ add: (definition) => added.push(definition?.name), get: () => undefined })
        return { dispose() {} }
      },
    },
    session: {
      hook: async () => ({ dispose() {} }),
      create: async () => ({ data: { id: "ses_native" } }),
      prompt: async () => ({ data: {} }),
    },
    command: {
      transform: async (callback) => {
        callback({ add: (definition) => commands.set(definition.name, definition) })
        return { dispose() {} }
      },
    },
  }
  try {
    const dispose = await plugin.setup(context)
    // N1: the legacy command never registers, even with the gate forced true.
    expect(commands.has("goal")).toBe(false)
    // N2: none of the legacy goal tools register.
    for (const name of ["create_goal", "update_goal", "get_goal"]) expect(added).not.toContain(name)
    // N5: the legacy goal store is never written.
    expect(goalStoreWrites).toBe(0)
    // N7: dispose is clean.
    await dispose()
  } finally {
    if (originalMetadata === undefined) delete nativeManifest.metadata
    else nativeManifest.metadata = originalMetadata
  }
})

test("native runtime registers the remaining builtin commands with the V1 templates", async () => {
  const commands = new Map()
  const prompts = []
  const context = {
    ...editorCaptureContext().context,
    session: {
      hook: async () => ({ dispose() {} }),
      create: async () => ({ data: { id: "ses_cmd" } }),
      prompt: async (input) => { prompts.push(input); return { data: {} } },
    },
    command: {
      transform: async (callback) => {
        callback({ add: (definition) => commands.set(definition.name, definition) })
        return { dispose() {} }
      },
    },
  }
  const dispose = await plugin.setup(context)
  try {
    for (const name of ["refactor", "remove-ai-slops", "handoff", "hyperplan"]) {
      expect(typeof commands.get(name)?.execute).toBe("function")
    }
    // Commands owned by another native surface are not duplicated here.
    expect(commands.has("stop-continuation")).toBe(false)
    expect(commands.has("goal")).toBe(false)
    // The command delivers the rendered V1 template into the session turn:
    // argument and session placeholders resolve; none survives literally.
    await commands.get("handoff").execute({ sessionID: "ses_cmd", prompt: { text: "continue the round" }, delivery: "queue" })
    expect(prompts).toHaveLength(1)
    expect(prompts[0].sessionID).toBe("ses_cmd")
    expect(prompts[0].delivery).toBe("queue")
    expect(prompts[0].text).toContain("continue the round")
    expect(prompts[0].text).toContain("ses_cmd")
    expect(prompts[0].text).not.toContain("$ARGUMENTS")
    expect(prompts[0].text).not.toContain("$SESSION_ID")
    expect(prompts[0].text).not.toContain("$TIMESTAMP")
    // An empty session never delivers.
    await commands.get("refactor").execute({ sessionID: "", prompt: { text: "x" } })
    expect(prompts).toHaveLength(1)
  } finally {
    await dispose()
  }
})

test("native runtime honors disabled_commands for the native builtin commands", async () => {
  const originalMetadata = nativeManifest.metadata
  nativeManifest.metadata = { global: { disabled: { commands: ["handoff"] } } }
  const commands = new Map()
  const context = {
    ...editorCaptureContext().context,
    session: {
      hook: async () => ({ dispose() {} }),
      create: async () => ({ data: { id: "ses_cmd" } }),
      prompt: async () => ({ data: {} }),
    },
    command: {
      transform: async (callback) => {
        callback({ add: (definition) => commands.set(definition.name, definition) })
        return { dispose() {} }
      },
    },
  }
  try {
    const dispose = await plugin.setup(context)
    expect(commands.has("handoff")).toBe(false)
    for (const name of ["refactor", "remove-ai-slops", "hyperplan"]) expect(commands.has(name)).toBe(true)
    await dispose()
  } finally {
    if (originalMetadata === undefined) delete nativeManifest.metadata
    else nativeManifest.metadata = originalMetadata
  }
})

test("native runtime selects the team-mode template from the team_mode gate", async () => {
  const originalMetadata = nativeManifest.metadata
  const capture = () => {
    const commands = new Map()
    const prompts = []
    const context = {
      ...editorCaptureContext().context,
      session: {
        hook: async () => ({ dispose() {} }),
        create: async () => ({ data: { id: "ses_cmd" } }),
        prompt: async (input) => { prompts.push(input); return { data: {} } },
      },
      command: {
        transform: async (callback) => {
          callback({ add: (definition) => commands.set(definition.name, definition) })
          return { dispose() {} }
        },
      },
    }
    return { commands, prompts, context }
  }
  try {
    nativeManifest.metadata = { global: { gates: { team_mode: false } } }
    const off = capture()
    const disposeOff = await plugin.setup(off.context)
    await off.commands.get("remove-ai-slops").execute({ sessionID: "ses_team", prompt: { text: "target" }, delivery: "queue" })
    await disposeOff()
    nativeManifest.metadata = { global: { gates: { team_mode: true } } }
    const on = capture()
    const disposeOn = await plugin.setup(on.context)
    await on.commands.get("remove-ai-slops").execute({ sessionID: "ses_team", prompt: { text: "target" }, delivery: "queue" })
    await disposeOn()
    expect(off.prompts[0].text).not.toContain("$ARGUMENTS")
    expect(on.prompts[0].text).not.toContain("$ARGUMENTS")
    // The team-mode addendum adds content; a wiring regression that ignores the
    // gate would deliver the identical base template.
    expect(on.prompts[0].text.length).toBeGreaterThan(off.prompts[0].text.length)
  } finally {
    if (originalMetadata === undefined) delete nativeManifest.metadata
    else nativeManifest.metadata = originalMetadata
  }
})

// Task 19: a real compaction clears the file-read-scoped context and writes an
// observable receipt under $XDG_STATE_HOME. The event feed resolves only after
// the runtime finished handling the pushed event, so awaiting it is the
// synchronization point.
test("native runtime records a context-cleared receipt on compaction", async () => {
  const previousStateHome = process.env.XDG_STATE_HOME
  const stateRoot = mkdtempSync(join(tmpdir(), "rigel-native-runtime-"))
  process.env.XDG_STATE_HOME = stateRoot
  try {
    const feed = createEventFeed()
    const context = reactiveFallbackContext(feed)
    const dispose = await plugin.setup(context)

    const consumed = feed.consumed()
    feed.push({ type: "session.compacted", data: { sessionID: "ses_compact" } })
    await consumed

    const receiptPath = join(stateRoot, "oh-my-rigel", "context-cleared-on-compaction.json")
    expect(existsSync(receiptPath)).toBe(true)
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({
      sessionID: "ses_compact",
      eventType: "session.compacted",
    })
    await dispose()
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previousStateHome
    rmSync(stateRoot, { recursive: true, force: true })
  }
})

// Task 19: the live V2 stream delivers compaction as `session.compaction.*`
// with the session id under `properties`, so the handler must accept that name
// and shape too, not only `session.compacted` with `data.sessionID`.
test("native runtime records the clear for the streamed compaction event name", async () => {
  const previousStateHome = process.env.XDG_STATE_HOME
  const stateRoot = mkdtempSync(join(tmpdir(), "rigel-native-runtime-compaction-stream-"))
  process.env.XDG_STATE_HOME = stateRoot
  try {
    const feed = createEventFeed()
    const context = reactiveFallbackContext(feed)
    const dispose = await plugin.setup(context)
    const consumed = feed.consumed()
    feed.push({ type: "session.compaction.started", properties: { sessionID: "ses_compact_stream" } })
    await consumed
    const receipt = JSON.parse(readFileSync(join(stateRoot, "oh-my-rigel", "context-cleared-on-compaction.json"), "utf8"))
    expect(receipt).toMatchObject({ sessionID: "ses_compact_stream", eventType: "session.compaction.started" })
    await dispose()
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previousStateHome
    rmSync(stateRoot, { recursive: true, force: true })
  }
})

test("native runtime reads keyword_detector disabled and enabled lists from the merged plugin config", () => {
  // given / when / then
  expect(nativeRuntime.readKeywordDetectorConfig({
    config: { keyword_detector: { disabled_keywords: ["team"], enabled_expansions: ["ultrawork", "hyperplan"] } },
  })).toEqual({ disabledKeywords: ["team"], enabledExpansions: ["ultrawork", "hyperplan"] })
  expect(nativeRuntime.readKeywordDetectorConfig({})).toEqual({})
  expect(nativeRuntime.readKeywordDetectorConfig({ config: { keyword_detector: Array.of("bad") } })).toEqual({})
  expect(nativeRuntime.readKeywordDetectorConfig({ config: { keyword_detector: { disabled_keywords: "team" } } }))
    .toEqual({ disabledKeywords: undefined, enabledExpansions: undefined })
})

// Upstream 5a9bb74a4: an explicit user model suppresses the built-in canonical
// chain. `resolveNativeModel` (model.request) and `seedChildFallback`
// (session.execution.failed) must honour that flag for a category child, so
// these tests drive both real seams instead of the pure decision helper alone.
function explicitCategoryRuntime({ config, createIds = ["ses_category_child"], directory = "/native-v2" }) {
  const switched = []
  const creates = []
  const feed = createEventFeed()
  let createIndex = 0
  const context = {
    location: { directory },
    config,
    agent: {
      list: async () => ({ data: [{ id: "Sisyphus-Junior", name: "Sisyphus-Junior", mode: "subagent" }] }),
      transform: async () => ({ dispose() {} }),
      reload: async () => {},
    },
    model: { list: async () => ({ data: [
      { providerID: "xiaomi", id: "mimo-v2.6-pro", enabled: true },
      { providerID: "xiaomi", id: "mimo-v2.6-flash", enabled: true },
      { providerID: "openai", id: "gpt-6-luna-fast", enabled: true },
      { providerID: "anthropic", id: "claude-opus-5-5", enabled: true },
      { providerID: "anthropic", id: "claude-opus-4-6", enabled: true },
    ] }) },
    event: { subscribe: feed.subscribe },
    session: {
      hook: async (name, handler) => { if (name === "model.request") feed.requestHook = handler; return { dispose() {} } },
      create: async (input) => { creates.push(input); return { data: { id: createIds[createIndex++] ?? createIds.at(-1) } } },
      prompt: async () => ({ data: {} }),
      wait: async () => {},
      context: async () => [{ type: "assistant", content: [{ type: "text", text: "done" }] }],
      switchModel: async (input) => { switched.push(input); return { data: {} } },
    },
    tool: { transform: async (callback) => {
      let definition
      callback({ add: (value) => { if (value?.name === "rigel_task") definition = value }, get: () => definition })
      if (definition) feed.definition = definition
      return { dispose() {} }
    } },
  }
  return { feed, switched, creates, context }
}

function categoryRequest(sessionID, providerID, modelID) {
  return {
    sessionID,
    agent: "Sisyphus-Junior",
    model: { providerID, modelID },
    request: new Request("https://example.invalid/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: modelID, messages: [{ role: "user", content: "work" }] }),
    }),
  }
}

function failAndConsume(feed, sessionID) {
  const consumed = feed.consumed()
  feed.push({ type: "session.execution.failed", data: { sessionID } })
  return consumed
}

test("native runtime suppresses the built-in chain for an explicit category child", async () => {
  const { feed, switched, context } = explicitCategoryRuntime({
    config: { categories: { quick: { model: "xiaomi/mimo-v2.6-pro" } } },
  })
  const dispose = await plugin.setup(context)
  // given: a category pinned to the user's model (no fallback_models)
  await feed.definition.execute({ category: "quick", prompt: "Work." }, { sessionID: "ses_parent" })

  // when: the child issues a model request on the provider V2 selected
  const request = categoryRequest("ses_category_child", "xiaomi", "mimo-v2.6-pro")
  await feed.requestHook(request)

  // then: the user's model is untouched; quick's built-in first rung
  // (gpt-6-luna-fast) and same-provider rung (mimo-v2.6-flash) are never attached
  expect((await request.request.clone().json()).model).toBe("mimo-v2.6-pro")
  // and: a pre-request failure has no built-in chain to walk
  await failAndConsume(feed, "ses_category_child")
  expect(switched).toEqual([])
  await dispose()
})

test("native runtime walks only the user fallback_models chain for an explicit category child", async () => {
  const { feed, switched, context } = explicitCategoryRuntime({
    config: { categories: { quick: { model: "xiaomi/mimo-v2.6-pro", fallback_models: ["xiaomi/mimo-v2.6-flash(low)"] } } },
  })
  const dispose = await plugin.setup(context)
  await feed.definition.execute({ category: "quick", prompt: "Work." }, { sessionID: "ses_parent" })

  // when: the pinned model fails, then: only the user's fallback_models rung is walked
  await failAndConsume(feed, "ses_category_child")
  expect(switched).toEqual([
    { sessionID: "ses_category_child", model: { providerID: "xiaomi", id: "mimo-v2.6-flash" } },
  ])
  await dispose()
})

test("native runtime keeps an explicit category child isolated from a non-explicit sibling", async () => {
  const { feed, switched, context } = explicitCategoryRuntime({
    config: { categories: { quick: { model: "xiaomi/mimo-v2.6-pro" } } },
    createIds: ["ses_explicit", "ses_implicit"],
  })
  const dispose = await plugin.setup(context)
  await feed.definition.execute({ category: "quick", prompt: "Work." }, { sessionID: "ses_parent" })
  await feed.definition.execute({ category: "writing", prompt: "Write." }, { sessionID: "ses_parent" })

  // when: the non-explicit sibling fails, then the explicit one fails
  await failAndConsume(feed, "ses_implicit")
  await failAndConsume(feed, "ses_explicit")

  // then: only the non-explicit sibling walks its built-in writing chain
  expect(switched).toEqual([
    { sessionID: "ses_implicit", model: { providerID: "anthropic", id: "claude-opus-4-6" } },
  ])
  await dispose()
})

test("native runtime keeps an explicit category child's chain across a resume", async () => {
  const { feed, switched, context } = explicitCategoryRuntime({
    config: { categories: { quick: { model: "xiaomi/mimo-v2.6-pro", fallback_models: ["xiaomi/mimo-v2.6-flash(low)"] } } },
  })
  const dispose = await plugin.setup(context)
  await feed.definition.execute({ category: "quick", prompt: "Work." }, { sessionID: "ses_parent" })
  // when: the same child session is resumed
  await feed.definition.execute({ task_id: "ses_category_child", prompt: "Again." }, { sessionID: "ses_parent" })

  // then: the explicit descriptor from creation still governs the chain
  await failAndConsume(feed, "ses_category_child")
  expect(switched).toEqual([
    { sessionID: "ses_category_child", model: { providerID: "xiaomi", id: "mimo-v2.6-flash" } },
  ])
  await dispose()
})

test("native runtime keys an admitted background child on the explicit category chain", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rigel-native-explicit-bg-"))
  try {
    const { feed, switched, context } = explicitCategoryRuntime({
      config: { categories: { quick: { model: "xiaomi/mimo-v2.6-pro", fallback_models: ["xiaomi/mimo-v2.6-flash(low)"] } } },
      createIds: ["ses_bg_child"],
      directory,
    })
    const dispose = await plugin.setup(context)
    // given: a background category delegation (admission before spawn)
    await feed.definition.execute({ category: "quick", prompt: "Work.", run_in_background: true }, { sessionID: "ses_parent" })

    // when: the admitted child fails, then: the explicit chain is attached
    await failAndConsume(feed, "ses_bg_child")
    expect(switched).toContainEqual({ sessionID: "ses_bg_child", model: { providerID: "xiaomi", id: "mimo-v2.6-flash" } })
    await dispose()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

// Category JSON routing: the live `~/.omo/omo.jsonc` `categories` block is the
// runtime source whenever the live file is loaded (it is authoritative over any
// context block). The POSITIVE below proves the live entry is consumed; the
// NEGATIVE CONTROLS prove an absent live file keeps the exact built-in semantics
// (the nine built-ins, unchanged) - the same set the context-only path produced.
test("native runtime consumes the live ~/.omo/omo.jsonc categories when the setup context has none", async () => {
  await withLiveOmoConfig({ categories: { quick: { model: "xiaomi/mimo-v2.6-pro" } } }, async () => {
    const { feed, switched, context } = explicitCategoryRuntime({})
    const dispose = await plugin.setup(context)
    await feed.definition.execute({ category: "quick", prompt: "Work." }, { sessionID: "ses_parent" })

    const request = categoryRequest("ses_category_child", "xiaomi", "mimo-v2.6-pro")
    await feed.requestHook(request)

    // the live-pinned user model is untouched and no built-in rung is attached
    expect((await request.request.clone().json()).model).toBe("mimo-v2.6-pro")
    await failAndConsume(feed, "ses_category_child")
    expect(switched).toEqual([])
    await dispose()
  })
})

test("native runtime keeps the exact built-in category set when the live config has no categories block", async () => {
  await withLiveOmoConfig({ agents: { oracle: { model: "openai/gpt-6-luna-fast" } } }, async () => {
    const { feed, context } = explicitCategoryRuntime({})
    const dispose = await plugin.setup(context)
    // a custom name is unknown because the live file declares no categories
    await expect(feed.definition.execute({ category: "my-lane", prompt: "x" }, { sessionID: "ses_parent" }))
      .rejects.toThrow('Unknown category: "my-lane". Available: artistry, deep-high, deep-low, quick, ultrabrain, unspecified-high, unspecified-low, visual-engineering, writing')
    await dispose()
  })
})

test("native runtime keeps the exact built-in category set when no live config exists", async () => {
  await withLiveOmoConfig(undefined, async () => {
    const { feed, context } = explicitCategoryRuntime({})
    const dispose = await plugin.setup(context)
    await expect(feed.definition.execute({ category: "my-lane", prompt: "x" }, { sessionID: "ses_parent" }))
      .rejects.toThrow('Unknown category: "my-lane". Available: artistry, deep-high, deep-low, quick, ultrabrain, unspecified-high, unspecified-low, visual-engineering, writing')
    await dispose()
  })
})

// The live `~/.omo/omo.jsonc` is the SINGLE runtime truth for categories. A
// host-provided `context.config.categories` block (present, but empty or a
// decoy) must NOT shadow it: otherwise quick falls to its built-in chain
// (opencode-go/minimax-m3 variant "max"), which the provider rejects with a
// no-route, and the Sisyphus-Junior child returns empty.
test("native runtime keeps the live ~/.omo/omo.jsonc category pin authoritative over an empty context block", async () => {
  await withLiveOmoConfig({ categories: { quick: { model: "xiaomi/mimo-v2.6-pro" } } }, async () => {
    const { feed, creates, context } = explicitCategoryRuntime({ config: { categories: {} } })
    const dispose = await plugin.setup(context)
    await feed.definition.execute({ category: "quick", prompt: "Work." }, { sessionID: "ses_parent" })

    // then: the live pin governs the child's start model, not the built-in chain
    expect(creates[0]?.model).toMatchObject({ providerID: "xiaomi", id: "mimo-v2.6-pro" })
    await dispose()
  })
})

// Upstream 5a9bb74a4: the pre-spawn admission key must reflect the model the
// child will actually start on. The model source is JSON-ONLY, so an agent with
// no JSON model yields no key (the manifest is never consulted for models).
test("native runtime keys the pre-spawn admission on the JSON agent model only", () => {
  const manifest = { agents: { oracle: { model: "openai/gpt-5.6-sol" } } }
  const overrides = { oracle: { model: "deepseek/deepseek-v4-pro", variant: "max" } }

  // given: no category, when: the user configured an agent model
  expect(nativeRuntime.preSpawnModelKey(undefined, { id: "oracle", name: "Oracle" }, overrides)).toBe("deepseek/deepseek-v4-pro")
  // and: an agent with no JSON override has no key (manifest model never consulted)
  expect(nativeRuntime.preSpawnModelKey(undefined, { id: "oracle", name: "Oracle" }, {})).toBe("")
  // and: a category route keys on the resolved category model
  expect(nativeRuntime.preSpawnModelKey({ model: { providerID: "xiaomi", id: "mimo-v2.6-pro" } }, { id: "sisyphus-junior", name: "Sisyphus-Junior" }, overrides)).toBe("xiaomi/mimo-v2.6-pro")
  // and: an unknown agent with no override yields no key
  expect(nativeRuntime.preSpawnModelKey(undefined, { id: "missing", name: "Missing" }, overrides)).toBe("")
})

// The single registration point reads the LIVE `~/.omo/omo.jsonc` override and
// hands the JSON-resolved refs to the proactive resolver with chainFallback
// disabled. The user's chosen model must reach the registered agent as a
// `Model.Ref`; the manifest is never consulted for models.
test("a live per-agent model override reaches the registered agent as a Model.Ref", () => {
  const manifest = { agents: { oracle: { name: "Oracle", mode: "subagent", model: "openai/gpt-5.6-sol", variant: "xhigh" } } }
  const agentOverrides = resolveAuthoritativeAgentOverrides({
    live: { state: "loaded", overrides: readAgentOverridesFromConfig({ oracle: { model: "deepseek/deepseek-v4-pro", variant: "max" } }) },
  })
  const explicit = nativeRuntime.buildExplicitAgentModels(agentOverrides)

  const resolved = resolveProactiveAgentModels(manifest.agents, undefined, explicit, { chainFallback: false })
  expect(resolved.get("oracle")).toEqual({ providerID: "deepseek", id: "deepseek-v4-pro", variant: "max" })
  expect(typeof resolved.get("oracle")).toBe("object")
})

// C3: an unserved configured head WITH a served user `fallback_models` rung must
// register the reachable rung - the SAME decision the delegated child makes at
// create time. The registration map must carry the user's ordered chain,
// otherwise the registered model stays the unserved head while the child runs
// the rung, and the two surfaces disagree.
test("a live agent override with a served fallback_models rung registers that rung", () => {
  const manifest = { agents: { "Sisyphus-Junior": { name: "Sisyphus-Junior", mode: "subagent" } } }
  const agentOverrides = resolveAuthoritativeAgentOverrides({
    live: { state: "loaded", overrides: readAgentOverridesFromConfig({
      "Sisyphus-Junior": { model: "kimi-for-coding/kimi-x", fallback_models: ["openai/gpt-6-luna-fast"] },
    }) },
  })
  const explicit = nativeRuntime.buildExplicitAgentModels(agentOverrides)
  const inventory = [{ providerID: "openai", id: "gpt-6-luna-fast", enabled: true }]

  const resolved = resolveProactiveAgentModels(manifest.agents, inventory, explicit, { chainFallback: false })
  expect(resolved.get("Sisyphus-Junior")).toEqual({ providerID: "openai", id: "gpt-6-luna-fast" })
})

test("a malformed live agent model yields no Model.Ref and never falls back to the manifest", () => {
  const manifest = { agents: { oracle: { name: "Oracle", mode: "subagent", model: "openai/gpt-5.6-sol", variant: "xhigh" } } }
  const agentOverrides = resolveAuthoritativeAgentOverrides({
    live: { state: "loaded", overrides: readAgentOverridesFromConfig({ oracle: { model: "not-a-provider-ref" } }) },
  })
  const explicit = nativeRuntime.buildExplicitAgentModels(agentOverrides)

  const resolved = resolveProactiveAgentModels(manifest.agents, undefined, explicit, { chainFallback: false })
  expect(resolved.get("oracle")).toBeUndefined()
})

// Regression for `NLS1_GATE_FAIL_SESSION_TOOLS`: with the monitor gate OFF and a
// setup context whose session domain cannot enumerate (the live host), the
// runtime must still build the HTTP server API from the host's own service
// handoff so `session_list`/`session_search` enumerate instead of returning the
// typed unavailable string. A revert of the `hasInProcessSessionEnumeration`
// gate (serverApi built only under `monitor === true`) fails this test.
test("native runtime builds the session HTTP authority with the monitor gate off and no in-process session.list", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "rigel-session-authority-"))
  const home = join(sandbox, "home")
  const origin = "http://127.0.0.1:49374"
  mkdirSync(join(home, ".local", "state", "opencode"), { recursive: true })
  mkdirSync(join(home, ".config", "opencode"), { recursive: true })
  writeFileSync(
    join(home, ".local", "state", "opencode", "service.json"),
    JSON.stringify({ url: origin, pid: process.pid, version: "2.0.27" }),
  )
  writeFileSync(
    join(home, ".config", "opencode", "service.json"),
    JSON.stringify({ hostname: "127.0.0.1", port: 49374, password: "svc-pw" }),
  )
  const jsonResponse = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  const previousHome = process.env.HOME
  const previousFetch = globalThis.fetch
  process.env.HOME = home
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (href.endsWith("/api/info")) return jsonResponse({ version: "2.0.27", pid: process.pid, urls: [origin] })
    if (href.endsWith("/context")) {
      return jsonResponse({ data: [{ id: "m1", role: "user", time: { created: 1 }, parts: [{ type: "text", text: "hello" }] }] })
    }
    if (href.includes("/api/session")) {
      return jsonResponse({ data: [{ id: "ses_live", directory: "/native-v2", time: { created: 1, updated: 2 } }] })
    }
    return jsonResponse({})
  }
  const tools = {}
  const context = {
    location: { directory: "/native-v2" },
    agent: {
      list: async () => ({ data: [] }),
      transform: async (callback) => { callback({ update() {}, default() {} }); return { dispose() {} } },
      reload: async () => {},
    },
    model: { list: async () => ({ data: [] }) },
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    session: {
      hook: async () => ({ dispose() {} }),
      create: async () => ({ data: { id: "ses_child" } }),
      prompt: async () => ({ data: {} }),
    },
    tool: {
      transform: async (callback) => {
        callback({ add: (value) => { if (value?.name) tools[value.name] = value } })
        return { dispose() {} }
      },
    },
  }
  try {
    const dispose = await plugin.setup(context)
    expect(tools.session_list).toBeDefined()
    expect(tools.monitor_start).toBeUndefined()
    const result = await tools.session_list.execute({})
    expect(result.content).toContain("ses_live")
    expect(result.content).not.toBe("Error: OpenCode V2 server API unavailable")
    await dispose()
  } finally {
    globalThis.fetch = previousFetch
    process.env.HOME = previousHome
    rmSync(sandbox, { recursive: true, force: true })
  }
})
