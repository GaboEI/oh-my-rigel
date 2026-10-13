import { expect, test } from "bun:test"
import { callableAgents } from "./rigel-v2-native-core.mjs"
import { createKeywordState } from "./rigel-v2-keyword-state.mjs"
import { createNativeContextHook, createNativeModelRequestHook, createNativeRequestHook, formatDelegationRoster, reasoningEffortFromThinking } from "./rigel-v2-native-prompt.mjs"
import { createNativeContextCollector, createNativeContextMessageConsumer } from "./rigel-v2-context-collector.mjs"

test("context hook adds root roster to system and agent tuning to options", async () => {
  const hook = createNativeContextHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    getAgentRequestBody: () => ({ temperature: 0.1, maxTokens: 4096 }),
  })
  const event = {
    sessionID: "ses_root",
    agent: "Sisyphus - ultraworker",
    model: { providerID: "openai", modelID: "gpt-6" },
    system: [{ type: "text", text: "base" }],
    messages: [{ role: "user", content: "delegate this" }],
    options: {},
  }
  await hook(event)
  expect(event.system).toContainEqual(expect.objectContaining({ text: expect.stringContaining("<rigel-native-delegation-roster>") }))
  expect(event.options).toMatchObject({ temperature: 0.1, maxTokens: 4096 })
})

// Fase 6: the look_at child runs the same context hook; on a model the host pushes
// into adaptive thinking the forwarded agent temperature is invalid (provider 400),
// so the child session must not receive it.
test("context hook drops an adaptive-model temperature on a delegated child session", async () => {
  const hook = createNativeContextHook({
    getDelegationRoster: async () => [],
    getAgentRequestBody: () => ({ temperature: 0.1 }),
    isRootSession: async () => false,
  })
  const event = {
    sessionID: "ses_look_child",
    agent: "multimodal-looker",
    model: { providerID: "opencode-go", modelID: "claude-haiku-5-5" },
    system: [],
    messages: [{ role: "user", content: "Analyze this file/image and extract the requested information." }],
    options: {},
  }
  await hook(event)
  expect(event.options.temperature).toBeUndefined()
})

test("context collector orders, replaces, consumes, and injects only into the last real user message", async () => {
  const collector = createNativeContextCollector()
  collector.register("ses_root", { source: "custom", id: "shared", content: "old", priority: "low" })
  collector.register("ses_root", { source: "custom", id: "shared", content: "high", priority: "high" })
  collector.register("ses_root", { source: "rules-injector", id: "rule", content: "critical", priority: "critical" })
  const pending = collector.getPending("ses_root")
  expect(pending.merged).toBe("critical\n\n---\n\nhigh")
  const consume = createNativeContextMessageConsumer(collector)
  const event = {
    sessionID: "ses_root",
    messages: [
      { role: "user", content: "synthetic", synthetic: true },
      { role: "user", content: "real" },
    ],
  }
  expect(await consume(event)).toBe(true)
  expect(event.messages[0].content).toBe("synthetic")
  expect(event.messages[1].content).toBe("critical\n\n---\n\nhigh\n\n---\n\nreal")
  expect(collector.hasPending("ses_root")).toBe(false)
  collector.register("ses_root", { source: "custom", id: "no-text", content: "pending" })
  expect(await consume({ sessionID: "ses_root", messages: [{ role: "assistant", content: "no user" }] })).toBe(false)
  expect(collector.hasPending("ses_root")).toBe(true)
  expect(collector.consume("ses_root").hasContent).toBe(true)
})

test("model request hook applies internal initiator headers and same-provider fallback", async () => {
  const hook = createNativeModelRequestHook({
    getHeaders: () => ({ "x-initiator": "agent" }),
    resolveModel: async (input) => {
      expect(input).toEqual({ sessionID: "ses_root", agent: "explore", model: "primary", sameProviderAs: "openai" })
      return { providerID: "openai", id: "fallback" }
    },
  })
  const event = {
    sessionID: "ses_root",
    agent: "explore",
    model: { providerID: "openai", modelID: "primary" },
    headers: {},
  }
  await hook(event)
  expect(event.headers).toEqual({ "x-initiator": "agent" })
  expect(event.model).toMatchObject({ providerID: "openai", modelID: "fallback", id: "fallback" })
})

test("delegation roster renders each category's description and caller guidance", () => {
  const roster = formatDelegationRoster(
    [{ name: "explore", mode: "subagent" }],
    [
      { name: "quick", description: "Trivial tasks", callerGuidance: "<Caller_Warning>write explicit steps</Caller_Warning>" },
      { name: "my-lane", description: "Custom lane" },
    ],
  )
  expect(roster).toContain('"quick": Trivial tasks <Caller_Warning>write explicit steps</Caller_Warning>')
  expect(roster).toContain('"my-lane": Custom lane')
})

test("delegation roster still accepts bare category names", () => {
  const roster = formatDelegationRoster([{ name: "explore", mode: "subagent" }], ["quick"])
  expect(roster).toContain('- "quick"')
})

test("request-stage roster recovers from the startup two-agent race and replaces stale entries", async () => {
  let calls = 0
  const loadedAfterStartup = [
    "General", "Explore", "Sisyphus - ultraworker", "Prometheus - Plan Builder",
    "Atlas - Plan Executor", "explore", "librarian", "oracle", "Metis - Plan Consultant",
    "Momus - Plan Critic", "multimodal-looker", "Sisyphus-Junior", "judge", "forja",
    "researcher", "reviewer", "writer", "architect",
  ].map((name) => ({ name, mode: "subagent" }))
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => {
      calls += 1
      return calls === 1
        ? [{ name: "General", mode: "subagent" }, { name: "Explore", mode: "subagent" }]
        : loadedAfterStartup
    },
    categories: ["quick"],
  })
  const input = {
    kind: "primary",
    request: new Request("https://example.invalid/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [
        { role: "system", content: "ordinary system text" },
        { role: "user", content: "research this" },
      ] }),
    }),
  }
  await hook(input)
  let body = await input.request.clone().json()
  expect(body.messages).toHaveLength(3)
  expect(body.messages[0]).toEqual({ role: "system", content: "ordinary system text" })
  expect(body.messages[1].content).toContain('"General"')
  expect(body.messages[1].content).toContain('"Explore"')
  expect(body.messages[1].content).not.toContain('"librarian"')

  await hook(input)
  body = await input.request.clone().json()
  expect(body.messages).toHaveLength(3)
  expect(body.messages[1].content).toContain('"librarian"')
  expect(body.messages[1].content).toContain('"judge"')
  expect(body.messages[1].content).toContain('"architect"')
  expect((body.messages[1].content.match(/^-/gm) ?? [])).toHaveLength(19)
  expect(calls).toBe(2)
})

test("translates native agent request tuning into an OpenAI Responses payload; explicit reasoning wins over the thinking-derived effort and raw thinking is never emitted", async () => {
  const observed = []
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [],
    getAgentRequestBody: () => ({
      temperature: 0.1,
      top_p: 0.8,
      maxTokens: 64000,
      // budget 32000 would derive "high"; the explicit "low" must win and the
      // raw `thinking` key must not appear (the Responses body rejects it).
      thinking: { type: "enabled", budgetTokens: 32000 },
      reasoning: "low",
      textVerbosity: "low",
    }),
    onAgentTuningApplied: (event) => observed.push(event),
  })
  const input = {
    agent: "Sisyphus-Junior",
    model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
    request: new Request("https://example.invalid/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4.1-flash", input: [{ role: "user", content: "work" }] }),
    }),
  }
  await hook(input)
  const body = await input.request.clone().json()
  expect(body).toMatchObject({
    temperature: 0.1,
    top_p: 0.8,
    max_output_tokens: 64000,
    reasoning: { effort: "low" },
    text: { verbosity: "low" },
  })
  // The Responses body rejects `thinking` as an unknown parameter (live: gpt-6-luna,
  // muse-spark), so it must never be emitted on this shape.
  expect(body.thinking).toBeUndefined()
  expect(observed).toEqual([{
    agent: "Sisyphus-Junior",
    providerID: "opencode-go",
    shape: "responses",
    payload: {
      temperature: 0.1,
      top_p: 0.8,
      max_output_tokens: 64000,
      reasoning: { effort: "low" },
      text: { verbosity: "low" },
    },
  }])
})

test("derives the Responses reasoning effort from an enabled thinking budget when no explicit effort is given", async () => {
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [],
    getAgentRequestBody: () => ({ thinking: { type: "enabled", budgetTokens: 32000 } }),
  })
  const input = {
    agent: "Sisyphus - ultraworker",
    model: { providerID: "opencode-go", id: "gpt-6-luna" },
    request: new Request("https://example.invalid/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-luna", input: [{ role: "user", content: "work" }] }),
    }),
  }
  await hook(input)
  const body = await input.request.clone().json()
  // The thinking effect survives on the supported field; the raw key does not.
  expect(body.reasoning).toEqual({ effort: "high" })
  expect(body.thinking).toBeUndefined()
})

test("maps thinking budgets to Responses effort bands and adds nothing for disabled thinking", () => {
  expect(reasoningEffortFromThinking({ type: "enabled", budgetTokens: 32000 })).toBe("high")
  expect(reasoningEffortFromThinking({ type: "enabled", budgetTokens: 16000 })).toBe("medium")
  expect(reasoningEffortFromThinking({ type: "enabled", budgetTokens: 8000 })).toBe("low")
  expect(reasoningEffortFromThinking({ type: "enabled" })).toBe("high")
  expect(reasoningEffortFromThinking({ type: "disabled" })).toBeUndefined()
  expect(reasoningEffortFromThinking(undefined)).toBeUndefined()
})

test("translates legacy reasoningEffort, maxTokens, and the chat-only thinking field into a Chat provider payload", async () => {
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [],
    getAgentRequestBody: () => ({ reasoningEffort: "medium", maxTokens: 8192, thinking: { type: "enabled", budgetTokens: 16000 } }),
  })
  const input = {
    agent: "fixture",
    model: { providerID: "openai-compatible", id: "fixture" },
    request: new Request("https://example.invalid/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "work" }] }),
    }),
  }
  await hook(input)
  expect(await input.request.clone().json()).toMatchObject({
    max_tokens: 8192,
    reasoning_effort: "medium",
    thinking: { type: "enabled", budgetTokens: 16000 },
  })
})

test("request-stage roster is never injected into a child session", async () => {
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    isRootSession: async () => false,
  })
  const input = {
    kind: "primary",
    request: new Request("https://example.invalid/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "child work" }] }),
    }),
  }
  await hook(input)
  expect((await input.request.clone().json()).messages).toEqual([{ role: "user", content: "child work" }])
})

test("Ultrawork aliases activate a persistent root-only native prompt", async () => {
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    ultraworkPrompt: "<ultrawork-mode>ULTRAWORK MODE ENABLED!</ultrawork-mode>",
  })
  const input = {
    sessionID: "ses_root",
    request: new Request("https://example.invalid/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "ultrawork: investigate this" }] }),
    }),
  }
  await hook(input)
  let body = await input.request.clone().json()
  const firstUser = body.messages.find((message) => message.role === "user")
  expect(firstUser.content).toContain("ULTRAWORK MODE ENABLED!")

  input.request = new Request("https://example.invalid/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "continue" }] }),
  })
  await hook(input)
  body = await input.request.clone().json()
  // V1 replays a live record as the continuation marker, not the full guidance.
  const replayUser = body.messages.find((message) => message.role === "user")
  expect(replayUser.content).toContain("<ultrawork-mode>active</ultrawork-mode>")
  expect(replayUser.content).not.toContain("ULTRAWORK MODE ENABLED!")
})

test("default Ultrawork activates for roots and never leaks into children", async () => {
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    defaultUltrawork: true,
    ultraworkPrompt: "<ultrawork-mode>DEFAULT ULTRAWORK</ultrawork-mode>",
  })
  const root = { sessionID: "ses_root", request: new Request("https://example.invalid/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "ordinary work" }] }) }) }
  await hook(root)
  expect((await root.request.clone().json()).messages.some((message) => message.content?.includes("DEFAULT ULTRAWORK"))).toBe(true)

  const childHook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    defaultUltrawork: true,
    ultraworkPrompt: "<ultrawork-mode>DEFAULT ULTRAWORK</ultrawork-mode>",
    isRootSession: async () => false,
  })
  const child = { sessionID: "ses_child", request: new Request("https://example.invalid/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "child work" }] }) }) }
  await childHook(child)
  expect((await child.request.clone().json()).messages).toEqual([{ role: "user", content: "child work" }])
})

test("resolves a fallback model at the request boundary when the primary is unavailable", async () => {
  const seen = []
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    resolveModel: async (input) => {
      seen.push(input)
      return { providerID: "openai", id: "fallback-model" }
    },
  })
  const input = {
    sessionID: "ses_root",
    agent: "Sisyphus - ultraworker",
    model: { providerID: "openai", modelID: "primary-model" },
    request: new Request("https://example.invalid/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "primary-model", messages: [{ role: "user", content: "work" }] }),
    }),
  }
  await hook(input)
  const body = await input.request.clone().json()
  expect(body.model).toBe("fallback-model")
  expect(seen).toEqual([{ sessionID: "ses_root", agent: "Sisyphus - ultraworker", model: "primary-model", sameProviderAs: "openai" }])
  expect(body.messages.some((message) => message.content?.includes("<rigel-native-delegation-roster>"))).toBe(true)
})

test("keeps the payload model when the resolver returns the current model", async () => {
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    resolveModel: async () => ({ providerID: "openai", id: "primary-model" }),
  })
  const input = {
    sessionID: "ses_root",
    model: { providerID: "openai", modelID: "primary-model" },
    request: new Request("https://example.invalid/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "primary-model", messages: [{ role: "user", content: "work" }] }),
    }),
  }
  await hook(input)
  expect((await input.request.clone().json()).model).toBe("primary-model")
})

test("applies model fallback to a child session without injecting the roster", async () => {
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    isRootSession: async () => false,
    resolveModel: async () => ({ providerID: "openai", id: "child-fallback" }),
  })
  const input = {
    sessionID: "ses_child",
    agent: "explore",
    model: { providerID: "openai", modelID: "primary-model" },
    request: new Request("https://example.invalid/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "primary-model", messages: [{ role: "user", content: "child work" }] }),
    }),
  }
  await hook(input)
  const body = await input.request.clone().json()
  expect(body.model).toBe("child-fallback")
  expect(body.messages).toEqual([{ role: "user", content: "child work" }])
})

test("leaves the payload model untouched when the active provider is unknown", async () => {
  let calls = 0
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    resolveModel: async () => { calls += 1; return { providerID: "openai", id: "fallback-model" } },
  })
  const input = {
    sessionID: "ses_root",
    request: new Request("https://example.invalid/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "primary-model", messages: [{ role: "user", content: "work" }] }),
    }),
  }
  await hook(input)
  expect((await input.request.clone().json()).model).toBe("primary-model")
  expect(calls).toBe(0)
})

test("passes the V2 request provider to the resolver as sameProviderAs", async () => {
  const seen = []
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    resolveModel: async (input) => { seen.push(input); return undefined },
  })
  const input = {
    sessionID: "ses_root",
    agent: "explore",
    model: { providerID: "openai", modelID: "primary" },
    request: new Request("https://example.invalid/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "primary-model", messages: [{ role: "user", content: "work" }] }),
    }),
  }
  await hook(input)
  expect(seen).toEqual([{ sessionID: "ses_root", agent: "explore", model: "primary-model", sameProviderAs: "openai" }])
})

test("a resolver failure leaves the request body untouched", async () => {
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    resolveModel: async () => { throw new Error("inventory down") },
  })
  const input = {
    sessionID: "ses_root",
    model: { providerID: "openai", modelID: "primary-model" },
    request: new Request("https://example.invalid/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "primary-model", messages: [{ role: "user", content: "work" }] }),
    }),
  }
  await hook(input)
  expect((await input.request.clone().json()).model).toBe("primary-model")
})

// The live V2 lab sends the OpenAI Responses API shape: `input` (typed items)
// plus a single `instructions` string, and NO `messages` array. These tests pin
// that the hook no longer bails on the shape guard and that both the model
// fallback and the roster injection reach that body.
function responsesBody(overrides = {}) {
  return {
    model: "grok-4.7",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "research this" }] },
    ],
    instructions: "You are a helpful agent.",
    tools: [],
    store: false,
    prompt_cache_key: "ses_root",
    include: [],
    max_output_tokens: 4096,
    stream: true,
    ...overrides,
  }
}

test("rewrites the model for a Responses-shaped body and leaves input and instructions intact", async () => {
  const seen = []
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    resolveModel: async (input) => { seen.push(input); return { providerID: "opencode-go", id: "kimi-k3" } },
  })
  const original = responsesBody()
  const input = {
    sessionID: "ses_root",
    agent: "explore",
    model: { providerID: "opencode-go", modelID: "grok-4.7" },
    request: new Request("https://example.invalid/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(original),
    }),
  }
  await hook(input)
  const body = await input.request.clone().json()
  expect(body.model).toBe("kimi-k3")
  expect(seen).toEqual([{ sessionID: "ses_root", agent: "explore", model: "grok-4.7", sameProviderAs: "opencode-go" }])
  expect(body.input).toEqual(original.input)
  expect(body.instructions).toContain("You are a helpful agent.")
  expect(body.instructions).toContain("<rigel-native-delegation-roster>")
  expect(body.prompt_cache_key).toBe("ses_root")
  expect(body.max_output_tokens).toBe(4096)
})

test("keeps the Responses model when the resolver returns the current model", async () => {
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    resolveModel: async () => ({ providerID: "opencode-go", id: "grok-4.7" }),
  })
  const input = {
    sessionID: "ses_root",
    model: { providerID: "opencode-go", modelID: "grok-4.7" },
    request: new Request("https://example.invalid/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(responsesBody()),
    }),
  }
  await hook(input)
  expect((await input.request.clone().json()).model).toBe("grok-4.7")
})

test("does not inject the roster into a Responses-shaped child session", async () => {
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    isRootSession: async () => false,
  })
  const original = responsesBody()
  const input = {
    sessionID: "ses_child",
    request: new Request("https://example.invalid/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(original),
    }),
  }
  await hook(input)
  const body = await input.request.clone().json()
  expect(body.input).toEqual(original.input)
  expect(body.instructions).toBe("You are a helpful agent.")
})

test("does not inject root system guidance into a child session", async () => {
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    isRootSession: async () => false,
    ultraworkPrompt: "<ultrawork-mode>ULTRAWORK MODE ENABLED!</ultrawork-mode>",
  })
  const input = {
    sessionID: "ses_child",
    request: new Request("https://example.invalid/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(responsesBody()),
    }),
  }
  await hook(input)
  const body = await input.request.clone().json()
  // Per-read directory context lives in the tool result, so a child request is
  // left untouched by the root system-injection path.
  expect(body.instructions).toBe("You are a helpful agent.")
  expect(body.instructions).not.toContain("<ultrawork-mode>")
  expect(body.input).toHaveLength(1)
})

test("injects the Hephaestus root AGENTS.md guidance into a root session", async () => {
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    getInitialDirectoryInstructions: () => "<rigel-native-directory-agents>\nROOT_AGENTS\n<rigel-native-directory-agents>",
  })
  const input = {
    sessionID: "ses_hep",
    agent: "Hephaestus - Deep Agent",
    request: new Request("https://example.invalid/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(responsesBody()),
    }),
  }
  await hook(input)
  const body = await input.request.clone().json()
  expect(body.instructions).toContain("You are a helpful agent.")
  expect(body.instructions).toContain("ROOT_AGENTS")
})

test("Responses instructions do not accumulate across repeated passes", async () => {
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    ultraworkPrompt: "<ultrawork-mode>ULTRAWORK MODE ENABLED!</ultrawork-mode>",
  })
  const input = {
    sessionID: "ses_root",
    request: new Request("https://example.invalid/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(responsesBody({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ulw investigate" }] }] })),
    }),
  }
  await hook(input)
  const firstBody = await input.request.clone().json()
  const first = firstBody.instructions
  // The keyword directive rides the user input item; `instructions` stays
  // system-level and keeps the roster.
  expect(first).toContain("<rigel-native-delegation-roster>")
  expect(first).not.toContain("ULTRAWORK MODE ENABLED!")
  expect(firstBody.input[0].content[0].text).toContain("ULTRAWORK MODE ENABLED!")

  input.request = new Request("https://example.invalid/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(responsesBody({ instructions: first, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }] })),
  })
  await hook(input)
  const secondBody = await input.request.clone().json()
  const second = secondBody.instructions
  expect((second.match(/<rigel-native-delegation-roster>/g) ?? [])).toHaveLength(2)
  expect(second).toContain("You are a helpful agent.")
  expect(second).not.toContain("ULTRAWORK MODE ENABLED!")
  expect(secondBody.input[0].content[0].text).toContain("<ultrawork-mode>active</ultrawork-mode>")
})

test("renders the delegation roster with the canonical core head from a shuffled inventory", async () => {
  const inventory = [
    { id: "judge", name: "Judge", mode: "all" },
    { id: "atlas", name: "Atlas - Plan Executor", mode: "all" },
    { id: "explore", name: "Explore", mode: "subagent" },
    { id: "prometheus", name: "Prometheus - Plan Builder", mode: "all" },
    { id: "sisyphus", name: "Sisyphus - ultraworker", mode: "all" },
  ]
  const hook = createNativeRequestHook({ getDelegationRoster: async () => callableAgents({ data: inventory }) })
  const input = {
    kind: "primary",
    request: new Request("https://example.invalid/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "delegate this" }] }),
    }),
  }
  await hook(input)
  const content = (await input.request.clone().json()).messages
    .map((message) => message.content)
    .find((value) => typeof value === "string" && value.includes("<rigel-native-delegation-roster>"))
  const rows = [...content.matchAll(/^- "([^"]+)":/gm)].map((match) => match[1])
  expect(rows).toEqual([
    "Sisyphus - ultraworker",
    "Prometheus - Plan Builder",
    "Atlas - Plan Executor",
    "Judge",
    "Explore",
  ])
})

// Task 19: the category-skill reminder is injected once at the root system
// boundary and consumed on the same pass, so a repeated request never
// duplicates it and a child session never receives it.
test("category-skill reminder injects once for a root session and is consumed", async () => {
  let reminder = "[Category+Skill Reminder]\nLoad the obsidian skill before writing."
  const consumed = []
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    getCategorySkillReminder: () => reminder,
    onCategorySkillReminderConsumed: (sessionID) => consumed.push(sessionID),
  })
  const requestBody = () => new Request("https://example.invalid/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [
      { role: "system", content: "ordinary system text" },
      { role: "user", content: "work" },
    ] }),
  })

  const first = { sessionID: "ses_root", request: requestBody() }
  await hook(first)
  const firstBody = await first.request.clone().json()
  expect(firstBody.messages.some((message) => message.content?.includes("[Category+Skill Reminder]"))).toBe(true)
  expect(consumed).toEqual(["ses_root"])

  reminder = ""
  const second = { sessionID: "ses_root", request: requestBody() }
  await hook(second)
  const secondBody = await second.request.clone().json()
  expect(secondBody.messages.some((message) => message.content?.includes("[Category+Skill Reminder]"))).toBe(false)
  expect(consumed).toEqual(["ses_root"])
})

test("category-skill reminder is never injected into a child session", async () => {
  const consumed = []
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    getCategorySkillReminder: () => "[Category+Skill Reminder]\nchild must not see this",
    onCategorySkillReminderConsumed: (sessionID) => consumed.push(sessionID),
    isRootSession: async () => false,
  })
  const input = {
    sessionID: "ses_child",
    request: new Request("https://example.invalid/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "child work" }] }),
    }),
  }
  await hook(input)
  expect((await input.request.clone().json()).messages).toEqual([{ role: "user", content: "child work" }])
  expect(consumed).toEqual([])
})

// Task 12: the keyword seam. These tests pin the fixed V1 matcher, the
// current-turn user-content injection target, all four keyword types, config
// filters, model routing, and the capped state contract.
const T12_MESSAGES = Object.freeze({
  team: "TEAM MODE DIRECTIVE",
  hyperplan: "HYPERPLAN MODE DIRECTIVE",
  comboBanner: "COMBO BANNER",
})
const T12_ULTRAWORK = "<ultrawork-mode>ULTRAWORK MODE ENABLED!</ultrawork-mode>"

function keywordHook(overrides = {}) {
  return createNativeRequestHook({
    getDelegationRoster: async () => [],
    ultraworkPrompt: T12_ULTRAWORK,
    keywordMessages: T12_MESSAGES,
    ...overrides,
  })
}

function chatBody(messages, model) {
  return new Request("https://example.invalid/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...(model ? { model } : {}), messages }),
  })
}

function userContent(body) {
  return body.messages.find((message) => message.role === "user")?.content
}

test("the fixed V1 matcher never activates for ultraworker on the chat shape", async () => {
  // given
  const hook = keywordHook()
  const input = {
    sessionID: "ses_t12",
    agent: "Sisyphus - ultraworker",
    request: chatBody([{ role: "user", content: "Ultraworker: investigate this" }]),
  }

  // when
  await hook(input)

  // then
  expect((await input.request.clone().json()).messages).toEqual([{ role: "user", content: "Ultraworker: investigate this" }])
})

test("the fixed V1 matcher never activates for ultraworker on the Responses shape", async () => {
  // given
  const hook = keywordHook()
  const original = responsesBody({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Ultraworker: investigate" }] }] })
  const input = {
    sessionID: "ses_t12",
    request: new Request("https://example.invalid/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(original),
    }),
  }

  // when
  await hook(input)

  // then
  const body = await input.request.clone().json()
  expect(body.input).toEqual(original.input)
  expect(body.instructions).toBe("You are a helpful agent.")
})

test("an explicit ultrawork keyword appends the routed directive to the current user message", async () => {
  // given
  const hook = keywordHook()
  const input = {
    sessionID: "ses_t12",
    request: chatBody([{ role: "system", content: "sys" }, { role: "user", content: "please ulw this" }]),
  }

  // when
  await hook(input)

  // then
  const body = await input.request.clone().json()
  expect(body.messages[1]).toEqual({ role: "user", content: `please ulw this\n\n---\n\n${T12_ULTRAWORK}` })
})

test("team mode and hpp inject their mode directives into the user content", async () => {
  // given
  const teamHook = keywordHook()
  const teamInput = { sessionID: "ses_team", request: chatBody([{ role: "user", content: "use team mode" }]) }

  // when
  await teamHook(teamInput)

  // then
  expect(userContent(await teamInput.request.clone().json())).toBe(`use team mode\n\n---\n\n${T12_MESSAGES.team}`)

  // given
  const hyperHook = keywordHook()
  const hyperInput = { sessionID: "ses_hpp", request: chatBody([{ role: "user", content: "hpp" }]) }

  // when
  await hyperHook(hyperInput)

  // then
  expect(userContent(await hyperInput.request.clone().json())).toBe(`hpp\n\n---\n\n${T12_MESSAGES.hyperplan}`)
})

test("the hpp negative lookbehind rejects dotted file extensions", async () => {
  // given
  const hook = keywordHook()
  const input = { sessionID: "ses_t12", request: chatBody([{ role: "user", content: "open interface.hpp" }]) }

  // when
  await hook(input)

  // then
  expect(userContent(await input.request.clone().json())).toBe("open interface.hpp")
})

test("the combo suppresses standalones and injects the banner plus routed ultrawork", async () => {
  // given
  const hook = keywordHook()
  const input = { sessionID: "ses_t12", request: chatBody([{ role: "user", content: "hpp ulw" }]) }

  // when
  await hook(input)

  // then
  const content = userContent(await input.request.clone().json())
  expect(content).toContain("COMBO BANNER")
  expect(content).toContain(T12_ULTRAWORK)
  expect(content).not.toContain(T12_MESSAGES.hyperplan)
  expect((content.match(/ULTRAWORK MODE ENABLED!/g) ?? [])).toHaveLength(1)
})

test("the directive targets the newest user message and leaves earlier turns untouched", async () => {
  // given
  const hook = keywordHook()
  const input = {
    sessionID: "ses_t12",
    request: chatBody([
      { role: "user", content: "team mode earlier" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "now hpp" },
    ]),
  }

  // when
  await hook(input)

  // then
  const body = await input.request.clone().json()
  expect(body.messages[0]).toEqual({ role: "user", content: "team mode earlier" })
  expect(body.messages[2].content).toBe(`now hpp\n\n---\n\n${T12_MESSAGES.hyperplan}`)
})

test("disabled_keywords and enabled_expansions filter the decision", async () => {
  // given
  const disabled = keywordHook({ disabledKeywords: ["team"] })
  const disabledInput = { sessionID: "ses_dis", request: chatBody([{ role: "user", content: "ulw team mode" }]) }

  // when
  await disabled(disabledInput)

  // then
  const disabledContent = userContent(await disabledInput.request.clone().json())
  expect(disabledContent).toContain(T12_ULTRAWORK)
  expect(disabledContent).not.toContain(T12_MESSAGES.team)

  // given
  const enabled = keywordHook({ enabledExpansions: ["team"] })
  const enabledInput = { sessionID: "ses_en", request: chatBody([{ role: "user", content: "ulw team mode" }]) }

  // when
  await enabled(enabledInput)

  // then
  const enabledContent = userContent(await enabledInput.request.clone().json())
  expect(enabledContent).toContain(T12_MESSAGES.team)
  expect(enabledContent).not.toContain("ULTRAWORK MODE ENABLED!")

  // given
  const none = keywordHook({ enabledExpansions: [] })
  const noneInput = { sessionID: "ses_none", request: chatBody([{ role: "user", content: "ulw team mode" }]) }

  // when
  await none(noneInput)

  // then
  expect(userContent(await noneInput.request.clone().json())).toBe("ulw team mode")
})

test("ultrawork body routes by the V1 source and falls back to the default body", async () => {
  // given
  const hook = createNativeRequestHook({
    getDelegationRoster: async () => [],
    ultraworkPrompt: "FALLBACK BODY",
    ultraworkPrompts: { default: "DEFAULT ROUTED BODY", gpt: "GPT ROUTED BODY" },
    keywordMessages: T12_MESSAGES,
  })

  // when
  const gptInput = { sessionID: "ses_gpt", agent: "sisyphus", request: chatBody([{ role: "user", content: "ulw" }], "openai/gpt-5.2") }
  await hook(gptInput)

  // then
  expect(userContent(await gptInput.request.clone().json())).toContain("GPT ROUTED BODY")

  // when
  const defaultInput = { sessionID: "ses_def", agent: "sisyphus", request: chatBody([{ role: "user", content: "ulw" }], "anthropic/claude-opus-5") }
  await hook(defaultInput)

  // then
  expect(userContent(await defaultInput.request.clone().json())).toContain("DEFAULT ROUTED BODY")

  // when
  const geminiInput = { sessionID: "ses_gem", agent: "sisyphus", request: chatBody([{ role: "user", content: "ulw" }], "google/gemini-3-pro") }
  await hook(geminiInput)

  // then: a missing per-source body degrades to the caller's default body
  expect(userContent(await geminiInput.request.clone().json())).toContain("FALLBACK BODY")
})

test("planner agents never receive the ultrawork directive", async () => {
  // given
  const hook = keywordHook()
  const input = { sessionID: "ses_plan", agent: "Prometheus - Plan Builder", request: chatBody([{ role: "user", content: "ulw" }]) }

  // when
  await hook(input)

  // then
  expect(userContent(await input.request.clone().json())).toBe("ulw")
})

test("a live ultrawork record replays as the continuation marker", async () => {
  // given
  const state = createKeywordState()
  const hook = keywordHook({ keywordState: state })
  const activate = { sessionID: "ses_live", request: chatBody([{ role: "user", content: "ulw" }]) }
  await hook(activate)

  // when
  const replay = { sessionID: "ses_live", request: chatBody([{ role: "user", content: "continue" }]) }
  await hook(replay)

  // then
  expect(userContent(await replay.request.clone().json())).toContain("<ultrawork-mode>active</ultrawork-mode>")
})

test("compaction marks the record and the next request re-injects the full guidance", async () => {
  // given
  const state = createKeywordState()
  const hook = keywordHook({ keywordState: state })
  await hook({ sessionID: "ses_compact", request: chatBody([{ role: "user", content: "ulw" }]) })
  state.handleEvent({ type: "session.compacted", sessionID: "ses_compact" })

  // when
  const restored = { sessionID: "ses_compact", request: chatBody([{ role: "user", content: "continue" }]) }
  await hook(restored)

  // then
  const content = userContent(await restored.request.clone().json())
  expect(content).toContain(T12_ULTRAWORK)
  expect(content).not.toContain("<ultrawork-mode>active</ultrawork-mode>")
})

test("session.deleted clears the keyword record and the state cap evicts the oldest", async () => {
  // given
  const state = createKeywordState({ cap: 1 })
  const hook = keywordHook({ keywordState: state })
  await hook({ sessionID: "ses_a", request: chatBody([{ role: "user", content: "ulw" }]) })
  await hook({ sessionID: "ses_b", request: chatBody([{ role: "user", content: "ulw" }]) })

  // when: cap 1 evicted ses_a before ses_b's record was stored
  const evicted = { sessionID: "ses_a", request: chatBody([{ role: "user", content: "continue" }]) }
  await hook(evicted)

  // then
  expect(userContent(await evicted.request.clone().json())).toBe("continue")

  // when
  const live = { sessionID: "ses_b", request: chatBody([{ role: "user", content: "continue" }]) }
  await hook(live)

  // then
  expect(userContent(await live.request.clone().json())).toContain("<ultrawork-mode>active</ultrawork-mode>")

  // when: session.deleted clears both keyword stores
  state.handleEvent({ type: "session.deleted", sessionID: "ses_b" })
  const deleted = { sessionID: "ses_b", request: chatBody([{ role: "user", content: "continue again" }]) }
  await hook(deleted)

  // then
  expect(userContent(await deleted.request.clone().json())).toBe("continue again")
})

test("keyword directives never reach a child session", async () => {
  // given
  const hook = keywordHook({ isRootSession: async () => false })
  const input = { sessionID: "ses_child", request: chatBody([{ role: "user", content: "ulw" }]) }

  // when
  await hook(input)

  // then
  expect(userContent(await input.request.clone().json())).toBe("ulw")
})

test("the Responses shape appends the keyword directive to the newest user input item", async () => {
  // given
  const hook = keywordHook()
  const input = {
    sessionID: "ses_resp",
    request: new Request("https://example.invalid/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(responsesBody({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "team mode" }] }] })),
    }),
  }

  // when
  await hook(input)

  // then
  const body = await input.request.clone().json()
  expect(body.input[0].content[0].text).toBe(`team mode\n\n---\n\n${T12_MESSAGES.team}`)
  expect(body.instructions).toBe("You are a helpful agent.")
})

test("a re-processed body never duplicates the directive", async () => {
  // given
  const hook = keywordHook()
  const first = { sessionID: "ses_idem", request: chatBody([{ role: "user", content: "ulw" }]) }
  await hook(first)
  const firstBody = await first.request.clone().json()

  // when
  const second = { sessionID: "ses_idem", request: chatBody(firstBody.messages) }
  await hook(second)

  // then
  const content = userContent(await second.request.clone().json())
  expect((content.match(/ULTRAWORK MODE ENABLED!/g) ?? [])).toHaveLength(1)
})

test("context hook injects the update notice into the root system channel exactly once", async () => {
  // given
  const notice = "<rigel-native-update-notice>\nA newer version of oh-my-openagent is available: 2.0.0 (current: 1.0.0)."
  const hook = createNativeContextHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    getUpdateNotice: () => notice,
  })
  const makeEvent = () => ({
    sessionID: "ses_root",
    agent: "Sisyphus - ultraworker",
    model: { providerID: "openai", modelID: "gpt-6" },
    system: [{ type: "text", text: "base" }],
    messages: [{ role: "user", content: "hello" }],
    options: {},
  })

  // when: the notice is offered on two consecutive turns that share the system array
  const first = makeEvent()
  await hook(first)
  const second = makeEvent()
  second.system = first.system
  await hook(second)

  // then: the marker is stripped before re-injection, so exactly one block survives
  const markers = second.system.filter((part) => typeof part?.text === "string" && part.text.includes("<rigel-native-update-notice>"))
  expect(markers).toHaveLength(1)
})

test("context hook never injects the update notice into a delegated child session", async () => {
  // given
  const hook = createNativeContextHook({
    getDelegationRoster: async () => [{ name: "explore", mode: "subagent" }],
    isRootSession: () => false,
    getUpdateNotice: () => "<rigel-native-update-notice>\nnewer",
  })
  const event = {
    sessionID: "ses_child",
    agent: "explore",
    model: { providerID: "openai", modelID: "gpt-6" },
    system: [{ type: "text", text: "base" }],
    messages: [{ role: "user", content: "hi" }],
    options: {},
  }

  // when
  await hook(event)

  // then
  expect(event.system.some((part) => part?.text?.includes("<rigel-native-update-notice>"))).toBe(false)
})
