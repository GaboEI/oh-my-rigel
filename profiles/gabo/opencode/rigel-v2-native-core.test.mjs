import { describe, expect, test } from "bun:test"
import {
  delegateNamedAgent,
  completedChildText,
  resumeDelegatedSession,
  listCallableAgents,
  resolveNamedAgent,
  taskResult,
  isCoordinatorAgent,
  isDemotedPlanAgent,
  normalizeV2ToolResult,
  normalizeToolDefinition,
  backgroundHandoffPrompt,
} from "./rigel-v2-native-core.mjs"

describe("Rigel native OpenCode V2 delegation", () => {
  test("uses V2 location-scoped discovery and resolves a callable named agent", async () => {
    const calls = []
    const client = {
      agent: { list: async (input) => { calls.push(input); return { data: [
        { name: "Sisyphus - ultraworker", mode: "primary" },
        { id: "explore", name: "Explore", mode: "subagent" },
        { name: "oracle", mode: "subagent" },
        { name: "forja", mode: "subagent", hidden: true },
      ] } } },
    }
    const location = { directory: "/isolated/project" }
    const agents = await listCallableAgents(client, location)
    expect(calls).toEqual([{ location }])
    expect(agents.map((agent) => agent.name)).toEqual(["Explore", "oracle"])
    expect(resolveNamedAgent(agents, "explore")).toMatchObject({ id: "explore", name: "Explore" })
    expect(resolveNamedAgent(agents, "oracle")).toMatchObject({ name: "oracle", mode: "subagent" })
    expect(resolveNamedAgent([{ name: "Explore", mode: "subagent" }], "explore")).toMatchObject({ name: "Explore" })
  })

  test("uses V2's scoped app.agents surface when that is the plugin-host client", async () => {
    const calls = []
    const client = { app: { agents: async (input) => { calls.push(input); return { data: [{ name: "explore", mode: "subagent" }] } } } }
    const location = { directory: "/isolated/project" }
    expect(await listCallableAgents(client, location)).toMatchObject([{ name: "explore" }])
    expect(calls).toEqual([{ directory: "/isolated/project" }])
  })

  test("rejects hidden, primary, and unknown names with a usable inventory", async () => {
    const agents = [{ name: "explore", mode: "subagent", hidden: false }]
    expect(() => resolveNamedAgent(agents, "oracle")).toThrow('Unknown agent: "oracle". Available agents: explore')
    const callable = await listCallableAgents({
      agent: { list: async () => ({ data: [
        { id: "build", name: "build", mode: "subagent", hidden: true },
        { id: "plan", name: "plan", mode: "subagent", hidden: true },
        { id: "explore", name: "explore", mode: "subagent" },
      ] }) },
    }, { directory: "/isolated/project" })
    expect(callable.map((agent) => agent.id).sort()).toEqual(["explore", "plan"])
  })

  test("classifies coordinator agents and the demoted plan agent", () => {
    for (const name of ["Prometheus - Plan Builder", "prometheus", "  PROMETHEUS  "]) {
      expect(isCoordinatorAgent(name)).toBe(true)
    }
    for (const name of ["Atlas - Plan Executor", "atlas", "Sisyphus - ultraworker", "explore", "", undefined]) {
      expect(isCoordinatorAgent(name)).toBe(false)
    }
    expect(isDemotedPlanAgent({ name: "plan", mode: "subagent", hidden: true })).toBe(true)
    expect(isDemotedPlanAgent({ name: "plan", mode: "subagent", hidden: false })).toBe(false)
    expect(isDemotedPlanAgent({ name: "build", mode: "subagent", hidden: true })).toBe(false)
    expect(isDemotedPlanAgent({ name: "Prometheus - Plan Builder", mode: "primary", hidden: false })).toBe(false)
  })

  test("creates a parent-linked foreground child and returns its final text through V2 sessions", async () => {
    const calls = []
    const client = {
      session: {
        create: async (input) => { calls.push(["create", input]); return { data: { id: "ses_child" } } },
        prompt: async (input) => { calls.push(["prompt", input]); return { data: {} } },
        wait: async (input) => { calls.push(["wait", input]) },
        context: async (input) => { calls.push(["context", input]); return { data: [{ type: "assistant", content: [{ type: "reasoning", text: "private" }, { type: "text", text: "SPECIALIST_EVIDENCE" }] }] } },
      },
    }
    const delegated = await delegateNamedAgent({
      client,
      location: { directory: "/isolated/project" },
      agent: { id: "explore", name: "Explore", mode: "subagent" },
      prompt: "List root files only.",
      parentSessionID: "ses_parent",
    })
    expect(delegated).toEqual({ sessionID: "ses_child", agent: "Explore", background: false, result: "SPECIALIST_EVIDENCE" })
    expect(calls).toEqual([
      ["create", { agent: "explore", location: { directory: "/isolated/project" }, parentID: "ses_parent" }],
      ["prompt", { sessionID: "ses_child", text: "<rigel-native-child-task>\nList root files only.", resume: true }],
      ["wait", { sessionID: "ses_child" }],
      ["context", { sessionID: "ses_child" }],
    ])
    expect(taskResult(delegated)).toMatchObject({ content: expect.stringContaining("SPECIALIST_EVIDENCE"), metadata: { sessionID: "ses_child", agent: "Explore", background: false } })
  })

  // The team path binds a member into its worktree BETWEEN the session creation and
  // its first prompt, so the prompt must wait for that bind. A hook that is fired but
  // not awaited lets the first turn run in the wrong directory.
  test("#given a child hook that binds the session #when the child is delegated #then the prompt waits for the bind", async () => {
    const calls = []
    let releaseBind
    const bindReleased = new Promise((resolve) => { releaseBind = resolve })
    let bindStarted
    const bindStartedPromise = new Promise((resolve) => { bindStarted = resolve })
    const client = {
      session: {
        create: async () => { calls.push("create"); return { data: { id: "ses_child" } } },
        prompt: async () => { calls.push("prompt") },
      },
    }
    const delegation = delegateNamedAgent({
      client,
      location: { directory: "/isolated/project" },
      agent: { id: "explore", name: "Explore", mode: "subagent" },
      prompt: "Work.",
      background: true,
      onChildSession: async () => { calls.push("bind"); bindStarted(); await bindReleased },
    })
    // when: the bind is still in flight
    await bindStartedPromise
    // then: the prompt has NOT been sent yet
    expect(calls).toEqual(["create", "bind"])
    releaseBind()
    await delegation
    expect(calls).toEqual(["create", "bind", "prompt"])
  })

  // V2's session.create/model contract is a Model.Ref (`{ providerID, id }`), not
  // a raw `"provider/id"` string. A pinned agent model must be forwarded verbatim
  // as that object; an agent with no pinned model must omit the key so V2 inherits
  // the registered agent's model.
  test("forwards a pinned Model.Ref to session.create and omits it for an inherited agent model", async () => {
    const calls = []
    const client = { session: {
      create: async (input) => { calls.push(input); return { data: { id: "ses_child" } } },
      prompt: async () => ({ data: {} }),
    } }
    await delegateNamedAgent({
      client,
      location: { directory: "/isolated/project" },
      agent: { id: "sisyphus-junior", name: "Sisyphus-Junior", mode: "subagent" },
      prompt: "Work.",
      model: { providerID: "xiaomi", id: "mimo-v2.6-pro" },
      background: true,
    })
    expect(calls[0].model).toEqual({ providerID: "xiaomi", id: "mimo-v2.6-pro" })
    expect(typeof calls[0].model).toBe("object")

    const inheritedCalls = []
    await delegateNamedAgent({
      client: { session: { create: async (input) => { inheritedCalls.push(input); return { data: { id: "ses_two" } } }, prompt: async () => ({ data: {} }) } },
      location: { directory: "/isolated/project" },
      agent: { id: "explore", name: "Explore", mode: "subagent" },
      prompt: "Work.",
      background: true,
    })
    expect(Object.prototype.hasOwnProperty.call(inheritedCalls[0], "model")).toBe(false)
  })

  test("extracts only the completed child's visible text", () => {
    expect(completedChildText({ data: [
      { type: "assistant", content: [{ type: "text", text: "old" }] },
      { type: "assistant", content: [{ type: "reasoning", text: "do not expose" }, { type: "text", text: "final evidence" }] },
    ] })).toBe("final evidence")
  })

  test("resolves the demoted plan agent by its natural name and resumes a native V2 child session", async () => {
    const inventory = [
      { id: "Prometheus - Plan Builder", name: "Prometheus - Plan Builder", mode: "primary" },
      { id: "plan", name: "plan", mode: "subagent", hidden: true },
    ]
    const resolved = resolveNamedAgent(inventory, "plan")
    expect(resolved).toMatchObject({ id: "plan" })
    expect(resolved.name).not.toBe("Prometheus - Plan Builder")
    const calls = []
    const resumed = await resumeDelegatedSession({
      client: { session: {
        create: async () => { throw new Error("not used") },
        prompt: async (input) => { calls.push(["prompt", input]) },
        wait: async (input) => { calls.push(["wait", input]) },
        context: async (input) => { calls.push(["context", input]); return { data: [{ type: "assistant", content: [{ type: "text", text: "continued" }] }] } },
      } },
      sessionID: "ses_child",
      prompt: "continue the analysis",
    })
    expect(resumed).toEqual({ sessionID: "ses_child", agent: "resumed", background: false, result: "continued" })
    expect(calls).toEqual([
      ["prompt", { sessionID: "ses_child", text: "<rigel-native-child-task>\ncontinue the analysis", resume: true }],
      ["wait", { sessionID: "ses_child" }],
      ["context", { sessionID: "ses_child" }],
    ])
  })

  test("places a callable core-mode inventory at the canonical head regardless of host order", async () => {
    const inventory = [
      { id: "judge", name: "Judge", mode: "all" },
      { id: "atlas", name: "Atlas - Plan Executor", mode: "all" },
      { id: "explore", name: "Explore", mode: "subagent" },
      { id: "prometheus", name: "Prometheus - Plan Builder", mode: "all" },
      { id: "oracle", name: "oracle", mode: "subagent" },
      { id: "hephaestus", name: "Hephaestus - Deep Agent", mode: "all" },
      { id: "sisyphus", name: "Sisyphus - ultraworker", mode: "all" },
    ]
    const agents = await listCallableAgents(
      { agent: { list: async () => ({ data: inventory }) } },
      { directory: "/isolated/project" },
    )
    expect(agents.map((agent) => agent.name)).toEqual([
      "Sisyphus - ultraworker",
      "Hephaestus - Deep Agent",
      "Prometheus - Plan Builder",
      "Atlas - Plan Executor",
      "Judge",
      "Explore",
      "oracle",
    ])
  })
})

describe("Rigel native V2 tool result normalization", () => {
  test("wraps a V1-style string result as a content object", () => {
    expect(normalizeV2ToolResult("Session not found: ses_x")).toEqual({ content: "Session not found: ses_x" })
  })

  test("passes a content result through and preserves metadata", () => {
    const result = { content: "child done", metadata: { sessionID: "ses_child" } }
    expect(normalizeV2ToolResult(result)).toBe(result)
  })

  test("folds an output-only object into content and keeps metadata", () => {
    expect(normalizeV2ToolResult({ output: "ok", metadata: { a: 1 } })).toEqual({ content: "ok", metadata: { a: 1 } })
  })

  test("serializes a non-string object and stringifies a non-object primitive", () => {
    expect(normalizeV2ToolResult({ lines: [] })).toEqual({ content: '{"lines":[]}' })
    expect(normalizeV2ToolResult(undefined)).toEqual({ content: "undefined" })
  })

  test("wraps a tool definition's execute into the schema-less content shape", async () => {
    const definition = { description: "x", input: { type: "object" }, execute: async () => "table" }
    const wrapped = normalizeToolDefinition(definition)
    expect(wrapped.description).toBe("x")
    expect(await wrapped.execute({}, {})).toEqual({ content: "table" })
  })

  test("leaves a definition without execute untouched", () => {
    const definition = { description: "x" }
    expect(normalizeToolDefinition(definition)).toBe(definition)
  })
})

// A failed background handoff must name the agent and the cause. The parent
// consumed `agent: [object Object]` and a flag-only detail before, so it could
// not tell a provider error from an abort.
describe("backgroundHandoffPrompt", () => {
  test("renders the agent name and the failure cause for a failed handoff", () => {
    const text = backgroundHandoffPrompt({ sessionID: "ses_c", agent: { name: "Explore" }, status: "failed", error: "provider.invalid-request: boom" })
    expect(text).toContain("agent: Explore")
    expect(text).toContain("status: failed")
    expect(text).toContain("error: provider.invalid-request: boom")
    expect(text).toContain("<rigel-native-background-result>")
  })

  test("omits the cause for a non-failed handoff", () => {
    const text = backgroundHandoffPrompt({ sessionID: "ses_c", agent: "Explore", status: "succeeded", result: "done" })
    expect(text).toContain("status: succeeded")
    expect(text).not.toContain("error:")
  })
})
