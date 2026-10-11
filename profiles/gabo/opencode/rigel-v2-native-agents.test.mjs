import { expect, test } from "bun:test"
import { agentRequestBodyFromDefinition, applyLegacyAgentDefinition, nativePermissionRules, registerNativeAgents, resolveProactiveAgentModels } from "./rigel-v2-native-agents.mjs"

test("converts V1 agent fields to native V2 Agent.Info fields", () => {
  const agent = { request: { headers: {}, body: {} }, permissions: [] }
  applyLegacyAgentDefinition(agent, "judge", {
    name: "Judge", mode: "primary", prompt: "Audit.", model: "openai/gpt-test", variant: "high",
    permission: { read: "allow", edit: "deny", task: "ask", bash: { "*": "ask" } },
  })
  expect(agent).toMatchObject({
    name: "Judge", mode: "primary", hidden: false, system: "Audit.",
    model: { providerID: "openai", id: "gpt-test", variant: "high" },
  })
  expect(agent.permissions).toEqual([
    { action: "read", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "ask" },
    { action: "shell", resource: "*", effect: "ask" },
  ])
})

test("does not invent permission rules from malformed legacy input", () => {
  expect(nativePermissionRules({ edit: { "*": "deny", nope: 42 }, bad: null })).toEqual([
    { action: "edit", resource: "*", effect: "deny" },
  ])
})

test("maps canonical manifest tuning fields into the native AgentV2Info request body", () => {
  expect(agentRequestBodyFromDefinition({
    temperature: 0.2,
    top_p: 0.85,
    maxTokens: 64000,
    thinking: { type: "enabled", budgetTokens: 32000 },
    reasoning: "high",
    textVerbosity: "low",
  })).toEqual({
    temperature: 0.2,
    top_p: 0.85,
    maxTokens: 64000,
    thinking: { type: "enabled", budgetTokens: 32000 },
    reasoning: "high",
    textVerbosity: "low",
  })
})

test("maps the legacy reasoningEffort alias when reasoning is absent", () => {
  expect(agentRequestBodyFromDefinition({ reasoningEffort: "medium" })).toEqual({ reasoningEffort: "medium" })
})

test("rejects simultaneous reasoning aliases instead of discarding one", () => {
  expect(() => agentRequestBodyFromDefinition({ reasoning: "high", reasoningEffort: "medium" }))
    .toThrow("Conflicting native agent tuning fields: reasoning and reasoningEffort")
})

test("rejects malformed manifest tuning instead of dropping it silently", () => {
  expect(() => agentRequestBodyFromDefinition({ maxTokens: "64000" })).toThrow("maxTokens")
  expect(() => agentRequestBodyFromDefinition({ textVerbosity: "verbose" })).toThrow("textVerbosity")
})

test("proactive resolution starts an agent on the first available chain rung before reload", () => {
  // `explore`'s canonical chain is kimi, then openai gpt-6-luna-fast. The
  // kimi provider is absent from the inventory, so the pre-selection resolver
  // must pick the openai rung, not the manifest's raw model.
  const manifest = {
    agents: {
      explore: { name: "Explore", mode: "subagent", model: "kimi-for-coding/kimi-for-coding-highspeed", variant: "off" },
    },
  }
  const inventory = [{ providerID: "openai", id: "gpt-6-luna-fast", enabled: true }]
  const resolved = resolveProactiveAgentModels(manifest.agents, inventory)
  expect(resolved.get("explore")).toEqual({ providerID: "openai", id: "gpt-6-luna-fast", variant: "low" })
})

test("proactive resolution prefers an earlier canonical rung over an available manifest rung", () => {
  const manifest = {
    agents: {
      explore: { name: "Explore", mode: "subagent", model: "openai/gpt-6-luna-fast", variant: "low" },
    },
  }
  const inventory = [
    { providerID: "kimi-for-coding", id: "kimi-for-coding-highspeed", enabled: true },
    { providerID: "openai", id: "gpt-6-luna-fast", enabled: true },
  ]
  const resolved = resolveProactiveAgentModels(manifest.agents, inventory)
  expect(resolved.get("explore")).toEqual({ providerID: "kimi-for-coding", id: "kimi-for-coding-highspeed", variant: "off" })
})

test("proactive resolution falls back to the manifest model when the inventory is unavailable", () => {
  const manifest = {
    agents: {
      explore: { name: "Explore", mode: "subagent", model: "kimi-for-coding/kimi-for-coding-highspeed", variant: "off" },
    },
  }
  const resolved = resolveProactiveAgentModels(manifest.agents, undefined)
  expect(resolved.get("explore")).toEqual({ providerID: "kimi-for-coding", id: "kimi-for-coding-highspeed", variant: "off" })
})

// Upstream 5a9bb74a4: an explicit user model must survive the proactive pass.
test("proactive resolution keeps an explicit user model instead of overwriting it with a chain rung", () => {
  const manifest = {
    agents: {
      oracle: { name: "Oracle", mode: "subagent", model: "openai/gpt-5.6-sol", variant: "xhigh" },
    },
  }
  const inventory = [{ providerID: "anthropic", id: "claude-opus-5-5", enabled: true }]
  const explicit = new Map([["oracle", { model: "deepseek/deepseek-v4-pro", variant: "max" }]])
  const resolved = resolveProactiveAgentModels(manifest.agents, inventory, explicit)
  expect(resolved.get("oracle")).toEqual({ providerID: "deepseek", id: "deepseek-v4-pro", variant: "max" })
})

test("proactive resolution still walks the chain for an agent with no explicit model", () => {
  const manifest = {
    agents: {
      oracle: { name: "Oracle", mode: "subagent", model: "openai/gpt-5.6-sol", variant: "xhigh" },
    },
  }
  const inventory = [{ providerID: "anthropic", id: "claude-opus-5-5", enabled: true }]
  const resolved = resolveProactiveAgentModels(manifest.agents, inventory)
  expect(resolved.get("oracle")).toEqual({ providerID: "anthropic", id: "claude-opus-5-5", variant: "max" })
})

test("a disabled agent (V1 disabled_agents) is never registered", async () => {
  const updated = []
  const editor = {
    update(id, callback) {
      const agent = { request: { headers: {}, body: {} }, permissions: [] }
      callback(agent)
      updated.push(id)
    },
    default() {},
  }
  const agentDomain = {
    transform: async (callback) => { callback(editor); return { dispose() {} } },
    reload: async () => {},
  }
  const manifest = {
    agents: {
      "Hephaestus - Deep Agent": { name: "Hephaestus - Deep Agent", mode: "subagent", model: "openai/gpt-6-sol", variant: "medium" },
      oracle: { name: "Oracle", mode: "subagent", model: "openai/gpt-5.6-sol", variant: "xhigh" },
    },
  }
  const registered = await registerNativeAgents(agentDomain, manifest, { disabledAgents: ["hephaestus"] })
  expect(registered).toEqual(["oracle"])
  expect(updated).toEqual(["oracle"])
})

test("an explicit user model keyed by base id applies to the display-named manifest entry", () => {
  const manifest = {
    agents: {
      "Hephaestus - Deep Agent": { name: "Hephaestus - Deep Agent", mode: "subagent", model: "openai/gpt-6-sol", variant: "medium" },
    },
  }
  const explicit = new Map([["hephaestus", { model: "rigel-nsg/gpt-4o" }]])
  const resolved = resolveProactiveAgentModels(manifest.agents, [{ providerID: "openai", id: "gpt-6-sol", enabled: true }], explicit)
  expect(resolved.get("Hephaestus - Deep Agent")).toEqual({ providerID: "rigel-nsg", id: "gpt-4o" })
})

test("registerNativeAgents applies the proactive model before agent.reload", async () => {
  const timeline = []
  const applied = {}
  const editor = {
    update(id, callback) {
      const agent = { request: { headers: {}, body: {} }, permissions: [] }
      callback(agent)
      applied[id] = agent.model
    },
    default() {},
  }
  const agentDomain = {
    transform: async (callback) => { timeline.push("transform"); callback(editor); return { dispose() {} } },
    reload: async () => { timeline.push("reload") },
  }
  const manifest = {
    defaultAgent: "explore",
    agents: {
      explore: { name: "Explore", mode: "subagent", model: "kimi-for-coding/kimi-for-coding-highspeed", variant: "off" },
    },
  }
  const registered = await registerNativeAgents(agentDomain, manifest, {
    listModels: async () => [{ providerID: "openai", id: "gpt-6-luna-fast", enabled: true }],
  })
  expect(registered).toEqual(["explore"])
  // The model is the resolved rung, and it lands before reload runs.
  expect(applied.explore).toEqual({ providerID: "openai", id: "gpt-6-luna-fast", variant: "low" })
  expect(timeline).toEqual(["transform", "reload"])
})

test("registerNativeAgents keeps manifest models when the inventory read fails", async () => {
  const applied = {}
  const editor = {
    update(id, callback) {
      const agent = { request: { headers: {}, body: {} }, permissions: [] }
      callback(agent)
      applied[id] = agent.model
    },
    default() {},
  }
  const agentDomain = {
    transform: async (callback) => { callback(editor); return { dispose() {} } },
    reload: async () => {},
  }
  const manifest = {
    agents: { explore: { name: "Explore", mode: "subagent", model: "kimi-for-coding/kimi-for-coding-highspeed", variant: "off" } },
  }
  await registerNativeAgents(agentDomain, manifest, {
    listModels: async () => { throw new Error("inventory down") },
  })
  expect(applied.explore).toEqual({ providerID: "kimi-for-coding", id: "kimi-for-coding-highspeed", variant: "off" })
})

function createHephaestusHarness() {
  const applied = {}
  const editor = {
    update(id, callback) {
      const agent = { request: { headers: {}, body: {} }, permissions: [] }
      callback(agent)
      applied[id] = agent.model
    },
    default() {},
  }
  const agentDomain = {
    transform: async (callback) => { callback(editor); return { dispose() {} } },
    reload: async () => {},
  }
  return { applied, agentDomain }
}

// The Hephaestus registration gate is a roster contract: when it blocks, the
// agent must be absent from the registered roster and from editor.update, not
// merely logged. A permissive gate would register an agent V2 rejects at
// session start; a provider gate that ignores the first-run equivalent would
// drop the agent on machines without a readable inventory.
test("registerNativeAgents registers a Hephaestus whose resolved model is a supported GPT", async () => {
  const { applied, agentDomain } = createHephaestusHarness()
  const manifest = {
    agents: {
      "Hephaestus - Deep Agent": { name: "Hephaestus - Deep Agent", mode: "primary", model: "openai/gpt-6-sol", variant: "medium" },
      explore: { name: "Explore", mode: "subagent", model: "kimi-for-coding/kimi-for-coding-highspeed", variant: "off" },
    },
  }
  const registered = await registerNativeAgents(agentDomain, manifest, {
    listModels: async () => [{ providerID: "openai", id: "gpt-6-sol", enabled: true }],
  })
  expect(registered).toEqual(["Hephaestus - Deep Agent", "explore"])
  expect(applied["Hephaestus - Deep Agent"]).toEqual({ providerID: "openai", id: "gpt-6-sol", variant: "medium" })
})

test("registerNativeAgents leaves a Hephaestus whose model is not GPT out of the roster", async () => {
  const { applied, agentDomain } = createHephaestusHarness()
  const manifest = {
    agents: {
      "Hephaestus - Deep Agent": { name: "Hephaestus - Deep Agent", mode: "primary", model: "openai/kimi-k3" },
      explore: { name: "Explore", mode: "subagent", model: "kimi-for-coding/kimi-for-coding-highspeed", variant: "off" },
    },
  }
  const registered = await registerNativeAgents(agentDomain, manifest, {
    listModels: async () => [{ providerID: "openai", id: "kimi-k3", enabled: true }],
  })
  expect(registered).toEqual(["explore"])
  expect(applied["Hephaestus - Deep Agent"]).toBeUndefined()
})

test("registerNativeAgents skips Hephaestus when no required provider is connected", async () => {
  const { applied, agentDomain } = createHephaestusHarness()
  const manifest = {
    agents: {
      "Hephaestus - Deep Agent": { name: "Hephaestus - Deep Agent", mode: "primary", model: "openai/gpt-6-sol", variant: "medium" },
    },
  }
  const registered = await registerNativeAgents(agentDomain, manifest, {
    listModels: async () => [{ providerID: "opencode-go", id: "qwen3.7-plus", enabled: true }],
  })
  expect(registered).toEqual([])
  expect(applied["Hephaestus - Deep Agent"]).toBeUndefined()
})

test("registerNativeAgents keeps the V1 first-run equivalent when the inventory is unavailable", async () => {
  // V1 registers Hephaestus on a first run with no provider caches; the V2
  // equivalent is an inventory read failure: the provider check is skipped and
  // the supported-model gate alone decides.
  const { applied, agentDomain } = createHephaestusHarness()
  const manifest = {
    agents: {
      "Hephaestus - Deep Agent": { name: "Hephaestus - Deep Agent", mode: "primary", model: "openai/gpt-6-sol", variant: "medium" },
    },
  }
  const registered = await registerNativeAgents(agentDomain, manifest, {
    listModels: async () => { throw new Error("inventory down") },
  })
  expect(registered).toEqual(["Hephaestus - Deep Agent"])
  expect(applied["Hephaestus - Deep Agent"]).toEqual({ providerID: "openai", id: "gpt-6-sol", variant: "medium" })
})

test("registerNativeAgents still applies the model gate without an inventory", async () => {
  const { applied, agentDomain } = createHephaestusHarness()
  const manifest = {
    agents: {
      "Hephaestus - Deep Agent": { name: "Hephaestus - Deep Agent", mode: "primary", model: "opencode-go/kimi-k3" },
    },
  }
  const registered = await registerNativeAgents(agentDomain, manifest, {
    listModels: async () => { throw new Error("inventory down") },
  })
  expect(registered).toEqual([])
  expect(applied["Hephaestus - Deep Agent"]).toBeUndefined()
})

test("registerNativeAgents exposes acceptance tuning from the applied AgentV2Info request bodies", async () => {
  const requests = new Map()
  const editor = {
    update(_id, callback) {
      callback({ request: { settings: {}, headers: {}, body: {} }, permissions: [] })
    },
    default() {},
  }
  const agentDomain = {
    transform: async (callback) => { callback(editor); return { dispose() {} } },
    reload: async () => {},
  }
  await registerNativeAgents(agentDomain, {
    agents: {
      "Sisyphus-Junior": { name: "Sisyphus-Junior", maxTokens: 64000 },
      "Atlas - Plan Executor": { name: "Atlas - Plan Executor", temperature: 0.1 },
    },
  }, {
    onAgentRequest: (id, body) => requests.set(id, body),
  })
  expect(requests.get("Sisyphus-Junior")).toMatchObject({ maxTokens: 64000 })
  expect(requests.get("Atlas - Plan Executor")).toMatchObject({ temperature: 0.1 })
})

test("preserves the V2 baseline permission rules and overrides only the declared action", () => {
  // Plan decision 2: manifest rules merge onto the V2 baseline by action +
  // resource, last declaration wins. The editor callback receives an agent
  // whose `permissions` already carry that baseline, so applyLegacyAgentDefinition
  // must not wipe it.
  const agent = {
    request: { headers: {}, body: {} },
    permissions: [
      { action: "read", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "allow" },
      { action: "subagent", resource: "*", effect: "allow" },
    ],
  }
  applyLegacyAgentDefinition(agent, "judge", { name: "Judge", permission: { edit: "deny" } })
  const forAction = (action) => agent.permissions.filter((rule) => rule.action === action && rule.resource === "*")
  expect(forAction("read")).toEqual([{ action: "read", resource: "*", effect: "allow" }])
  expect(forAction("shell")).toEqual([{ action: "shell", resource: "*", effect: "allow" }])
  expect(forAction("subagent")).toEqual([{ action: "subagent", resource: "*", effect: "allow" }])
  expect(forAction("edit")).toEqual([{ action: "edit", resource: "*", effect: "deny" }])
})

test("expands the V1 read-only wildcard so every non-read V2 action is denied", () => {
  // Plan decision 6: `*` never reaches AgentV2Info as an opaque action. The
  // multimodal-looker allowlist (`*: deny`, `read: allow`) must deny the whole
  // real V2 set and then allow read.
  const agent = { request: { headers: {}, body: {} }, permissions: [] }
  applyLegacyAgentDefinition(agent, "multimodal-looker", {
    name: "Multimodal-Looker", permission: { "*": "deny", read: "allow" },
  })
  expect(agent.permissions.map((rule) => rule.action)).not.toContain("*")
  expect(agent.permissions.filter((rule) => rule.action === "read")).toEqual([
    { action: "read", resource: "*", effect: "allow" },
  ])
  for (const action of ["edit", "shell", "subagent", "question", "lsp", "skill"]) {
    expect(agent.permissions).toContainEqual({ action, resource: "*", effect: "deny" })
  }
  expect(agent.permissions.filter((rule) => rule.action !== "read").every((rule) => rule.effect === "deny")).toBe(true)
})

test("denies grep and glob for frontier models while leaving standard models unchanged", () => {
  const frontier = { request: { headers: {}, body: {} }, permissions: [] }
  const standard = { request: { headers: {}, body: {} }, permissions: [] }
  applyLegacyAgentDefinition(frontier, "frontier", {
    name: "Frontier",
    model: "openai/gpt-5.6-terra",
  })
  applyLegacyAgentDefinition(standard, "standard", {
    name: "Standard",
    model: "kimi/k2",
  })
  expect(frontier.permissions).toContainEqual({ action: "grep", resource: "*", effect: "deny" })
  expect(frontier.permissions).toContainEqual({ action: "glob", resource: "*", effect: "deny" })
  expect(standard.permissions).not.toContainEqual({ action: "grep", resource: "*", effect: "deny" })
  expect(standard.permissions).not.toContainEqual({ action: "glob", resource: "*", effect: "deny" })
})

test("registerNativeAgents registers canonical core agents first from a shuffled manifest", async () => {
  const updateOrder = []
  const editor = {
    update(id, callback) {
      callback({ request: { headers: {}, body: {} }, permissions: [] })
      updateOrder.push(id)
    },
    default() {},
  }
  const agentDomain = {
    transform: async (callback) => { callback(editor); return { dispose() {} } },
    reload: async () => {},
  }
  // Manifest insertion order is deliberately not canonical: core agents are
  // scattered among secondaries so a host-order pass-through cannot pass.
  const manifest = {
    agents: {
      judge: { name: "Judge", mode: "primary", model: "kimi-for-coding/kimi-for-coding-highspeed" },
      "Atlas - Plan Executor": { name: "Atlas - Plan Executor", mode: "primary", model: "kimi-for-coding/kimi-for-coding-highspeed" },
      explore: { name: "Explore", mode: "subagent", model: "kimi-for-coding/kimi-for-coding-highspeed" },
      "Prometheus - Plan Builder": { name: "Prometheus - Plan Builder", mode: "all", model: "kimi-for-coding/kimi-for-coding-highspeed" },
      "Hephaestus - Deep Agent": { name: "Hephaestus - Deep Agent", mode: "primary", model: "openai/gpt-6-sol", variant: "medium" },
      "Sisyphus - ultraworker": { name: "Sisyphus - ultraworker", mode: "primary", model: "kimi-for-coding/kimi-for-coding-highspeed" },
    },
  }
  const registered = await registerNativeAgents(agentDomain, manifest)
  expect(registered).toEqual([
    "Sisyphus - ultraworker",
    "Hephaestus - Deep Agent",
    "Prometheus - Plan Builder",
    "Atlas - Plan Executor",
    "judge",
    "explore",
  ])
  expect(updateOrder).toEqual(registered)
})
