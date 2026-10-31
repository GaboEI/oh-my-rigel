import { expect, test } from "bun:test"

// Owner contract for the planned pure permission module
// `rigel-v2-native-permissions.mjs` (Task 10 step 2). The module does not exist
// on the reproduction base, so every contract imports it lazily and fails on
// its own name until the owner lands; that is the intended reproduce-first RED.
//
// Expected values come from `.omo/plans/task-10-permissions.md` and the
// installed `@opencode-ai/sdk/v2/types` contract
// (`PermissionV2Rule = { action, resource, effect }`, `AgentV2Info.permissions`),
// never from the current `rigel-v2-native-agents.mjs` behavior:
//   - decision 3: write/apply_patch -> edit, bash -> shell, task -> subagent
//   - decision 6: `*` expands to the versioned real V2 action set, expanded
//     rules precede specific ones
//   - decision 7: an unknown V1 permission key aborts; there is no passthrough
//   - decision 2: baseline, then global overlay, then agent overlay; last wins
//   - decision 5: call_omo_agent / task_* / teammate / team_* / grep_app_* /
//     lsp_* / look_at / skill_mcp stay independently gateable by tool name
//
// Module contract (the seam the runtime will consume):
//   V2_PERMISSION_ACTIONS: readonly string[]
//   translateV1Permissions(permission) -> { rules: PermissionV2Rule[], toolGates }
//   mergePermissionRules(layers: PermissionV2Rule[][]) -> PermissionV2Rule[]
//   evaluateToolNameGate(toolGates, toolName) -> "allow" | "deny" | "ask" | undefined

async function load() {
  return import("./rigel-v2-native-permissions.mjs")
}

function canonical(rules) {
  return [...rules].sort((left, right) => (
    left.action.localeCompare(right.action) || left.resource.localeCompare(right.resource)
  ))
}

test("maps V1 write and apply_patch onto the native edit action", async () => {
  const { translateV1Permissions } = await load()
  const { rules } = translateV1Permissions({ write: "deny", apply_patch: "deny" })
  expect(rules).toEqual([{ action: "edit", resource: "*", effect: "deny" }])
  expect(rules.some((rule) => rule.action === "write" || rule.action === "apply_patch")).toBe(false)
})

test("accepts the V1 todoread permission the task system emits instead of aborting", async () => {
  const { translateV1Permissions } = await load()
  const { toolGates } = translateV1Permissions({ todowrite: "deny", todoread: "deny" })
  expect(toolGates).toContainEqual({ pattern: "todoread", effect: "deny" })
})

test("maps the remaining native V1 actions to their V2 action names", async () => {
  const { translateV1Permissions } = await load()
  const { rules } = translateV1Permissions({
    read: "allow", edit: "deny", bash: "ask", task: "allow", question: "deny", skill: "allow",
  })
  expect(canonical(rules)).toEqual(canonical([
    { action: "read", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "ask" },
    { action: "subagent", resource: "*", effect: "allow" },
    { action: "question", resource: "*", effect: "deny" },
    { action: "skill", resource: "*", effect: "allow" },
  ]))
})

test("exposes the versioned V2 action set and expands * without an opaque * rule", async () => {
  const { V2_PERMISSION_ACTIONS, translateV1Permissions } = await load()
  for (const action of ["read", "edit", "shell", "subagent", "question", "lsp", "skill"]) {
    expect(V2_PERMISSION_ACTIONS).toContain(action)
  }
  const { rules } = translateV1Permissions({ "*": "deny" })
  expect(rules.map((rule) => rule.action)).not.toContain("*")
  expect(new Set(rules.map((rule) => rule.action))).toEqual(new Set(V2_PERMISSION_ACTIONS))
  expect(rules.every((rule) => rule.resource === "*" && rule.effect === "deny")).toBe(true)
})

test("expands * so a read-only allowlist denies every other real V2 action", async () => {
  const { V2_PERMISSION_ACTIONS, translateV1Permissions } = await load()
  const { rules } = translateV1Permissions({ "*": "deny", read: "allow" })
  const effectByAction = new Map(rules.map((rule) => [rule.action, rule.effect]))
  for (const action of V2_PERMISSION_ACTIONS) {
    expect(effectByAction.get(action)).toBe(action === "read" ? "allow" : "deny")
  }
})

test("merges baseline, global overlay and agent overlay with the last declaration winning", async () => {
  const { mergePermissionRules } = await load()
  const baseline = [
    { action: "read", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "allow" },
  ]
  const globalOverlay = [{ action: "edit", resource: "*", effect: "deny" }]
  const agentOverlay = [
    { action: "edit", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "deny" },
  ]
  expect(canonical(mergePermissionRules([baseline, globalOverlay, agentOverlay]))).toEqual(canonical([
    { action: "read", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "deny" },
  ]))
})

test("lets a global overlay replace the baseline when no agent overlay contradicts it", async () => {
  const { mergePermissionRules } = await load()
  const baseline = [{ action: "edit", resource: "*", effect: "allow" }]
  const globalOverlay = [{ action: "edit", resource: "*", effect: "deny" }]
  expect(mergePermissionRules([baseline, globalOverlay])).toEqual([
    { action: "edit", resource: "*", effect: "deny" },
  ])
})

test("keeps V1-only tool families independently gateable by their real tool name", async () => {
  const { translateV1Permissions, evaluateToolNameGate } = await load()
  const { rules, toolGates } = translateV1Permissions({
    task: "allow",
    call_omo_agent: "deny",
    task_create: "deny",
    teammate: "deny",
    team_create: "deny",
    "grep_app_*": "deny",
    "lsp_*": "deny",
    look_at: "allow",
    skill_mcp: "deny",
  })
  // The native task rule must not swallow the independently gated families.
  expect(rules).toEqual(expect.arrayContaining([{ action: "subagent", resource: "*", effect: "allow" }]))
  const gateKeys = ["call_omo_agent", "task_create", "teammate", "team_create", "grep_app_*", "lsp_*", "look_at", "skill_mcp"]
  expect(rules.some((rule) => gateKeys.includes(rule.action))).toBe(false)
  const table = [
    ["call_omo_agent", "deny"],
    ["task_create", "deny"],
    ["task_list", "deny"],
    ["team_create", "deny"],
    ["team_delete", "deny"],
    ["grep_app_searchGitHub", "deny"],
    ["lsp_diagnostics", "deny"],
    ["look_at", "allow"],
    ["skill_mcp", "deny"],
  ]
  for (const [toolName, effect] of table) {
    expect(evaluateToolNameGate(toolGates, toolName)).toBe(effect)
  }
  expect(evaluateToolNameGate(toolGates, "task")).toBeUndefined()
})

test("maps legacy task permissions to the registered rigel_task tool under wildcard gates", async () => {
  const { translateV1Permissions, evaluateToolNameGate } = await load()

  // given a legacy task allow that overrides a deny-all wildcard
  const allowed = translateV1Permissions({ "*": "deny", task: "allow" })

  // when the V2 runtime checks its registered tool name
  expect(evaluateToolNameGate(allowed.toolGates, "rigel_task")).toBe("allow")
  expect(evaluateToolNameGate(allowed.toolGates, "task")).toBe("allow")

  // then the deny-all wildcard still denies an unrelated task-family tool
  const denied = translateV1Permissions({ "*": "deny" })
  expect(evaluateToolNameGate(denied.toolGates, "rigel_task")).toBe("deny")
})

test("global task toggle also governs Rigel's registered delegation tool", async () => {
  const { translateGlobalTools, evaluateToolNameGate } = await load()
  expect(evaluateToolNameGate(translateGlobalTools({ task: false }), "rigel_task")).toBe("deny")
  expect(evaluateToolNameGate(translateGlobalTools({ task: true }), "rigel_task")).toBe("allow")
})

test("fails closed on an unknown V1 permission key while accepting arbitrary resources", async () => {
  const { translateV1Permissions } = await load()
  expect(() => translateV1Permissions({ definitely_not_a_permission: "deny" })).toThrow()
  const { rules } = translateV1Permissions({ edit: { "src/gabo/**": "deny", "*": "allow" } })
  expect(rules).toEqual(expect.arrayContaining([
    { action: "edit", resource: "src/gabo/**", effect: "deny" },
    { action: "edit", resource: "*", effect: "allow" },
  ]))
})

// Task 10: the V1 `teammate` permission governs the whole V2 team_* family by
// tool name. It must not create an exact `teammate` tool gate (no V2 tool is
// named that) and must not collapse into the native `subagent` action.
test("gates the V1 teammate permission across the whole team_* tool family", async () => {
  const { translateV1Permissions, evaluateToolNameGate } = await load()
  const { rules, toolGates } = translateV1Permissions({ teammate: "deny" })
  expect(rules).toEqual([])
  expect(evaluateToolNameGate(toolGates, "team_create")).toBe("deny")
  expect(evaluateToolNameGate(toolGates, "team_delete")).toBe("deny")
  expect(evaluateToolNameGate(toolGates, "team_send_message")).toBe("deny")
  expect(evaluateToolNameGate(toolGates, "teammate")).toBeUndefined()
})

// Task 10 decision 8: the materialized `config.tools` metadata turns global
// boolean disables into tool-name gates for the V1-only families, including
// grep_app_*, the task/team families, the exact legacy Lsp* built-in names, and
// the exact call_omo_agent / look_at / skill_mcp / interactive_bash tools.
// T38: the OmO `lsp_*` MCP family is retained, so the PascalCase `Lsp*` built-in
// disables must not collapse onto it.
test("translates global config tools into tool-name gates for the V1-only families", async () => {
  const { translateGlobalTools, evaluateToolNameGate } = await load()
  const toolGates = translateGlobalTools({
    "grep_app_*": false,
    LspHover: false,
    LspCodeActions: false,
    LspCodeActionResolve: false,
    "task_*": false,
    teammate: false,
    look_at: false,
    call_omo_agent: false,
    skill_mcp: false,
    interactive_bash: false,
  })
  for (const toolName of [
    "grep_app_searchGitHub",
    "LspHover", "LspCodeActions", "LspCodeActionResolve",
    "task_create", "task_list",
    "team_create", "team_delete",
    "look_at", "call_omo_agent", "skill_mcp", "interactive_bash",
  ]) {
    expect(evaluateToolNameGate(toolGates, toolName)).toBe("deny")
  }
  // T38 regression: the retained OmO lsp_* MCP tools are NOT denied by the
  // PascalCase built-in disables; only an explicit `lsp_*` key denies them.
  expect(evaluateToolNameGate(toolGates, "lsp_diagnostics")).toBeUndefined()
  expect(evaluateToolNameGate(toolGates, "lsp_symbols")).toBeUndefined()
  expect(evaluateToolNameGate(translateGlobalTools({ "lsp_*": false }), "lsp_diagnostics")).toBe("deny")
  // The task_* family gate must not swallow the native `task` delegation tool.
  expect(evaluateToolNameGate(toolGates, "task")).toBeUndefined()
  expect(evaluateToolNameGate(toolGates, "read")).toBeUndefined()
  expect(evaluateToolNameGate(translateGlobalTools({ look_at: true }), "look_at")).toBe("allow")
  expect(() => translateGlobalTools("not-an-object")).toThrow()
})

// Task 10 decisions 5 and 9: deny is a thrown error before the executor, allow
// is a pass, ask is a hard block pending approval, and a governed call whose
// agent cannot be established fails closed while an ungoverned one passes.
test("treats deny as a thrown error, allow as a pass, and ask as blocked pending approval", async () => {
  const { createNativeToolPermissionGate, TOOL_PERMISSION_APPROVAL_REQUIRED } = await load()
  const deny = createNativeToolPermissionGate({ globalGates: [{ pattern: "look_at", effect: "deny" }] })
  await expect(deny.before({ tool: "look_at" })).rejects.toThrow(/denied/)
  const allow = createNativeToolPermissionGate({ globalGates: [{ pattern: "look_at", effect: "allow" }] })
  await expect(allow.before({ tool: "look_at" })).resolves.toBeUndefined()
  const ask = createNativeToolPermissionGate({ globalGates: [{ pattern: "call_omo_agent", effect: "ask" }] })
  await expect(ask.before({ tool: "call_omo_agent" })).rejects.toMatchObject({ code: TOOL_PERMISSION_APPROVAL_REQUIRED })
})

test("lets an agent allow override a global tools default-deny (V1 re-enable)", async () => {
  const { createNativeToolPermissionGate } = await load()
  const gate = createNativeToolPermissionGate({ globalGates: [{ pattern: "team_*", effect: "deny" }] })
  gate.registerAgent("Sisyphus", { toolGates: [{ pattern: "team_*", effect: "allow" }] })
  // V1 default-deny catalog plus per-agent re-enable: the agent allow wins.
  await expect(gate.before({ tool: "team_create", agent: "sisyphus" })).resolves.toBeUndefined()
  // An agent with no matching entry keeps the global default deny.
  await expect(gate.before({ tool: "team_create", agent: "someone-else" })).rejects.toThrow(/denied/)
  await expect(gate.before({ tool: "team_create" })).rejects.toThrow(/denied/)
})

test("applies an agent-specific effect over the global default", async () => {
  const { createNativeToolPermissionGate } = await load()
  const gate = createNativeToolPermissionGate({ globalGates: [{ pattern: "team_*", effect: "deny" }] })
  gate.registerAgent("Sisyphus", {
    toolGates: [{ pattern: "look_at", effect: "allow" }, { pattern: "call_omo_agent", effect: "deny" }],
  })
  await expect(gate.before({ tool: "look_at", agent: "sisyphus" })).resolves.toBeUndefined()
  await expect(gate.before({ tool: "call_omo_agent", agent: "sisyphus" })).rejects.toThrow(/denied/)
})

// Task 10 fix: a V1 tool wildcard (`*`) is a real tool-name gate, so an agent
// declared deny-all with `read: allow` denies every concrete tool name except
// read, including V1-only surfaces with no native action such as call_omo_agent.
test("expands a V1 tool wildcard so only explicit allows survive in the agent layer", async () => {
  const { translateV1Permissions, evaluateToolNameGate } = await load()
  const { toolGates } = translateV1Permissions({ "*": "deny", read: "allow" })
  expect(evaluateToolNameGate(toolGates, "read")).toBe("allow")
  expect(evaluateToolNameGate(toolGates, "call_omo_agent")).toBe("deny")
  expect(evaluateToolNameGate(toolGates, "future_non_native_tool")).toBe("deny")
  expect(evaluateToolNameGate(toolGates, "team_create")).toBe("deny")
})

test("resolves the agent through the injected session resolver when the event omits it", async () => {
  const { createNativeToolPermissionGate } = await load()
  const seen = []
  const gate = createNativeToolPermissionGate({
    resolveAgent: async ({ sessionID }) => {
      seen.push(sessionID)
      return sessionID === "ses_child" ? "Multimodal-Looker" : undefined
    },
  })
  gate.registerAgent("multimodal-looker", { toolGates: [{ pattern: "look_at", effect: "deny" }] })
  await expect(gate.before({ tool: "look_at", sessionID: "ses_child" })).rejects.toThrow(/denied/)
  await expect(gate.before({ tool: "look_at", sessionID: "ses_other" })).rejects.toThrow(/identity/)
  expect(seen).toEqual(["ses_child", "ses_other"])
})

test("fails closed only for a governed call whose agent identity cannot be established", async () => {
  const { createNativeToolPermissionGate } = await load()
  const gate = createNativeToolPermissionGate({ resolveAgent: async () => undefined })
  gate.registerAgent("multimodal-looker", { toolGates: [{ pattern: "look_at", effect: "deny" }] })
  await expect(gate.before({ tool: "look_at", sessionID: "ses_1" })).rejects.toThrow(/identity/)
  await expect(gate.before({ tool: "todo_write", sessionID: "ses_1" })).resolves.toBeUndefined()
})
