/**
 * Pure authority that translates the V1 permission vocabulary into the V2
 * AgentV2Info permission contract, the independent tool-name gates, and the
 * merge order the native runtime consumes.
 *
 * Contract source: `.omo/plans/task-10-permissions.md` decisions 2 through 7 and
 * the installed `@opencode-ai/sdk/v2/types` contract
 * (`PermissionV2Rule = { action, resource, effect }`, `AgentV2Info.permissions`,
 * `PermissionConfig`). Pure data in, pure data out: no state, no I/O. The one
 * import is the canonical agent-id normalizer, so the live task-system authority
 * below classifies agents exactly like agent registration does.
 */

import { canonicalAgentKey } from "./rigel-v2-native-agent-order.mjs"

/**
 * The concrete V2 action vocabulary this runtime version pins. `*` expands to
 * exactly these actions, so a deny-all wildcard denies every action V2 can
 * evaluate. Names come from the installed `PermissionConfig` vocabulary; the
 * plan renames `bash` -> `shell`, `task` -> `subagent`, and
 * `write`/`apply_patch` -> `edit`.
 */
export const V2_PERMISSION_ACTIONS = Object.freeze([
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "shell",
  "subagent",
  "external_directory",
  "todowrite",
  "question",
  "webfetch",
  "websearch",
  "lsp",
  "skill",
  "doom_loop",
])

const PERMISSION_EFFECTS = new Set(["allow", "deny", "ask"])

// V1 permission keys that own a native V2 action domain, including the plan's
// renames. `interactive_bash` keeps a native shell rule and a tool-name gate.
const NATIVE_ACTION_BY_KEY = Object.freeze({
  read: "read",
  edit: "edit",
  write: "edit",
  apply_patch: "edit",
  bash: "shell",
  interactive_bash: "shell",
  task: "subagent",
  question: "question",
  skill: "skill",
  lsp: "lsp",
  glob: "glob",
  grep: "grep",
  list: "list",
  external_directory: "external_directory",
  todowrite: "todowrite",
  webfetch: "webfetch",
  websearch: "websearch",
  doom_loop: "doom_loop",
})

// V1-only surfaces with no native V2 action domain are governed by their real
// tool name instead of collapsing into `subagent` or another shared action.
// `teammate` is deliberately absent: it gates the whole `team_*` family, not a
// single tool name. `question` is included because the V2 host owns the
// `question` tool and Rigel does not re-register it: the translated `question`
// permission must still gate the host tool by name, or a denied agent could
// ask anyway.
const EXACT_GATE_BY_KEY = Object.freeze({
  call_omo_agent: "call_omo_agent",
  look_at: "look_at",
  skill_mcp: "skill_mcp",
  interactive_bash: "interactive_bash",
  question: "question",
  // `todowrite` keeps its native action rule AND a real tool-name gate: V2
  // publishes no builtin `todowrite`, so the runtime registers its own tool of
  // that name, and the host rule alone would not stop it. The V1 task-system
  // deny must govern the tool the agent can actually call.
  todowrite: "todowrite",
  // V1 emits `todoread` (alongside `todowrite`) whenever the task system is
  // enabled (tool-config-handler.ts). V2 has no `todoread` tool, so the exact
  // tool-name gate is harmless, but it must be accepted or agent registration
  // throws and the whole plugin is disabled.
  todoread: "todoread",
})

const FAMILY_GATE_RULES = Object.freeze([
  { pattern: "task_*", test: /^task_(create|get|list|update)$/ },
  { pattern: "team_*", test: /^team_/ },
  { pattern: "team_*", test: /^teammate$/ },
  { pattern: "grep_app_*", test: /^grep_app_/ },
  { pattern: "lsp_*", test: /^lsp_/ },
  { pattern: "Lsp*", test: /^Lsp/ },
])

const GATE_PATTERN_KEYS = Object.freeze(["task_*", "team_*", "grep_app_*", "lsp_*", "Lsp*"])

// Concrete V2 tool names (or families) a native V2 action must also govern by
// tool name, but only when the agent declares a V1 `*` wildcard. The wildcard
// denies every real tool name, so a specific native permission such as
// `read: allow` has to re-assert its own tool to win back.
const NATIVE_ACTION_TOOL_PATTERNS = Object.freeze({
  read: ["read"],
  edit: ["edit"],
  shell: ["shell"],
  subagent: ["task", "rigel_task"],
  question: ["question"],
  skill: ["skill"],
  lsp: ["lsp_*", "Lsp*"],
  glob: ["glob"],
  grep: ["grep"],
  list: ["list"],
  webfetch: ["webfetch"],
  websearch: ["websearch"],
  todowrite: ["todowrite"],
  external_directory: ["external_directory"],
  doom_loop: ["doom_loop"],
})

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function normalizeEffect(effect, source) {
  if (typeof effect !== "string" || !PERMISSION_EFFECTS.has(effect)) {
    throw new TypeError(`Invalid V1 permission effect for ${source}: ${String(effect)}`)
  }
  return effect
}

function classifyKey(key) {
  const nativeAction = NATIVE_ACTION_BY_KEY[key]
  let gate = GATE_PATTERN_KEYS.includes(key) ? key : EXACT_GATE_BY_KEY[key]
  if (!gate) gate = FAMILY_GATE_RULES.find((rule) => rule.test.test(key))?.pattern
  if (!nativeAction && !gate) throw new TypeError(`Unknown V1 permission key: ${key}`)
  return { nativeAction, gate }
}

/**
 * Translate one V1 permission object into V2 rules and tool-name gates.
 * Returns `{ rules, toolGates }`; both are plain arrays, rules deduplicated by
 * semantic action + resource with the last declaration winning.
 */
export function translateV1Permissions(permission) {
  if (permission === undefined || permission === null) return { rules: [], toolGates: [] }
  if (!isPlainObject(permission)) throw new TypeError("V1 permission must be a plain object")

  const rules = new Map()
  const gates = new Map()
  const addRule = (action, resource, effect, source) => {
    rules.set(`${action}\u0000${resource}`, { action, resource, effect: normalizeEffect(effect, source) })
  }
  const addGate = (pattern, effect, source) => {
    gates.set(pattern, { pattern, effect: normalizeEffect(effect, source) })
  }
  const applyValue = (nativeAction, gate, value, key) => {
    const stringValue = typeof value === "string"
    const mapValue = isPlainObject(value)
    if (!stringValue && !mapValue) throw new TypeError(`Invalid V1 permission value for ${key}`)
    if (nativeAction) {
      if (stringValue) addRule(nativeAction, "*", value, key)
      else for (const [resource, effect] of Object.entries(value)) addRule(nativeAction, resource, effect, `${key}.${resource}`)
    }
    if (gate) {
      if (stringValue) addGate(gate, value, key)
      else for (const [resource, effect] of Object.entries(value)) addGate(resource, effect, `${key}.${resource}`)
    }
  }

  // `*` expands first so a later specific key always overrides it (decision 6).
  // A string wildcard is also a real tool-name gate: V1 `*` denies every tool,
  // including V1-only surfaces with no native action, so an agent such as
  // multimodal-looker (`*: deny`, `read: allow`) must deny every concrete tool
  // name except the ones it explicitly allows.
  let wildcardToolGate = false
  if (Object.prototype.hasOwnProperty.call(permission, "*")) {
    const wildcard = permission["*"]
    if (typeof wildcard === "string") {
      for (const action of V2_PERMISSION_ACTIONS) addRule(action, "*", wildcard, "*")
      addGate("*", wildcard, "*")
      wildcardToolGate = true
    } else if (isPlainObject(wildcard)) {
      for (const [resource, effect] of Object.entries(wildcard)) {
        for (const action of V2_PERMISSION_ACTIONS) addRule(action, resource, effect, `*.${resource}`)
      }
    } else {
      throw new TypeError("Invalid V1 permission value for *")
    }
  }

  for (const [key, value] of Object.entries(permission)) {
    if (key === "*") continue
    const { nativeAction, gate } = classifyKey(key)
    applyValue(nativeAction, gate, value, key)
    // Under a tool wildcard, a specific native permission must re-assert its own
    // tool name, otherwise the wildcard would deny its native tool too.
    if (wildcardToolGate && nativeAction && typeof value === "string") {
      for (const pattern of NATIVE_ACTION_TOOL_PATTERNS[nativeAction] ?? []) addGate(pattern, value, key)
    }
  }

  return { rules: [...rules.values()], toolGates: [...gates.values()] }
}

/**
 * Merge ordered rule layers (baseline, global overlay, agent overlay). Layers
 * later in the array win; duplicates by action + resource collapse in place.
 */
export function mergePermissionRules(layers) {
  if (layers === undefined || layers === null) return []
  if (!Array.isArray(layers)) throw new TypeError("Permission layers must be an array")
  const merged = new Map()
  for (const layer of layers) {
    if (layer === undefined || layer === null) continue
    if (!Array.isArray(layer)) throw new TypeError("Each permission layer must be an array")
    for (const rule of layer) {
      if (!isPlainObject(rule) || typeof rule.action !== "string" || typeof rule.resource !== "string") {
        throw new TypeError("Invalid V2 permission rule")
      }
      merged.set(`${rule.action}\u0000${rule.resource}`, {
        action: rule.action,
        resource: rule.resource,
        effect: normalizeEffect(rule.effect, `${rule.action}/${rule.resource}`),
      })
    }
  }
  return [...merged.values()]
}

function matchesGatePattern(pattern, toolName) {
  if (pattern === toolName) return true
  const star = pattern.indexOf("*")
  if (star === -1) return false
  return toolName.startsWith(pattern.slice(0, star)) && toolName.endsWith(pattern.slice(star + 1))
}

/**
 * Resolve the effect a tool-name gate assigns to a concrete V2 tool call.
 * Returns `"allow" | "deny" | "ask"`, or `undefined` when no gate governs it.
 * The last matching gate wins, so a later exact gate overrides a family gate.
 */
export function evaluateToolNameGate(toolGates, toolName) {
  if (!Array.isArray(toolGates) || typeof toolName !== "string") return undefined
  let effect
  for (const gate of toolGates) {
    if (gate && typeof gate.pattern === "string" && matchesGatePattern(gate.pattern, toolName)) {
      effect = gate.effect
    }
  }
  return effect
}

/**
 * Map a global `config.tools` key onto the tool-name gate pattern(s) it owns.
 * V1-only families collapse to one family pattern. The three legacy OpenCode
 * built-in LSP tools (`LspHover`, `LspCodeActions`, `LspCodeActionResolve`) are
 * exact PascalCase names that V1 disabled to avoid clashing with OmO's own
 * `lsp_*` MCP tools; they must NOT collapse onto `lsp_*`, or the migration would
 * globally deny the entire retained LSP surface (a capability V1 kept enabled).
 * A `lsp` / `lsp_*` key is the family the OmO lsp MCP tools belong to.
 */
function globalToolGatePatterns(key) {
  if (key === "task") return ["task", "rigel_task"]
  if (key.startsWith("grep_app_")) return ["grep_app_*"]
  if (key.startsWith("task_")) return ["task_*"]
  if (key === "teammate" || key.startsWith("team_")) return ["team_*"]
  if (key === "lsp" || key.startsWith("lsp_")) return ["lsp_*"]
  return [key]
}

/**
 * Translate the materialized global `config.tools` metadata (a boolean-record
 * of tool disables/enables) into tool-name gates. A `false` becomes a deny
 * gate; a `true` becomes an allow gate only where it was explicitly declared.
 * Non-boolean entries are ignored, matching the V2 config contract.
 */
export function translateGlobalTools(tools) {
  if (tools === undefined || tools === null) return []
  if (!isPlainObject(tools)) throw new TypeError("Global tools must be a plain object")
  const gates = new Map()
  for (const [key, value] of Object.entries(tools)) {
    if (typeof value !== "boolean") continue
    const effect = value ? "allow" : "deny"
    for (const pattern of globalToolGatePatterns(key)) gates.set(pattern, { pattern, effect })
  }
  return [...gates.values()]
}

/**
 * Canonical ids of the agents V1 `applyToolConfig` grants task-system tools to:
 * `atlas`, `sisyphus`, `prometheus` and `sisyphus-junior` receive
 * `"task_*": "allow"`, while Hephaestus receives only the `task` delegation
 * grant and takes the task tools from the global allow. All five receive the
 * `todowrite` / `todoread` deny while the task system is enabled, because the
 * task list replaces the todo list for the agents that own it.
 */
const TASK_SYSTEM_TOOL_AGENT_IDS = Object.freeze(["atlas", "sisyphus", "prometheus", "sisyphus-junior"])
const TASK_SYSTEM_PERMISSION_AGENT_IDS = new Set([...TASK_SYSTEM_TOOL_AGENT_IDS, "hephaestus"])

/**
 * Rebuild the V1 permission object a task-owning agent carries under the LIVE
 * `experimental.task_system` gate.
 *
 * The install-time bake applied V1 `applyToolConfig`'s overlay with the gate as
 * it stood then, so the manifest can hold a `task_*: allow` and a
 * `todowrite` / `todoread` deny the live config no longer wants, and miss the
 * ones it does. Only the shapes V1 provably injected are dropped, so an agent
 * declaration of any other shape (`ask`, `allow`, a resource map) survives
 * untouched:
 *
 * - `task_*: allow` on the four task-tool owners is unconditional in V1, so it
 *   is always a generated entry.
 * - the `todowrite` / `todoread` denies are written only while the BAKED gate
 *   was on. A manifest baked OFF that carries the same deny is declaring it
 *   itself, so `bakedTaskSystemEnabled` must be `true` before that deny is
 *   removed; deleting it on a value match alone drops a user restriction the
 *   bake never injected.
 *
 * `undefined` for either gate means the caller has no value for it: without a
 * live value the permission is returned unchanged, and without a baked value
 * no entry is treated as generated and removed toward a guess.
 */
export function applyLiveTaskSystemPermission(id, permission, taskSystemEnabled, bakedTaskSystemEnabled) {
  if (typeof taskSystemEnabled !== "boolean") return permission
  if (!isPlainObject(permission)) return permission
  const key = canonicalAgentKey(id)
  if (!TASK_SYSTEM_PERMISSION_AGENT_IDS.has(key)) return permission
  const next = { ...permission }
  // Drop the install-time overlay first so ONE path owns both directions.
  if (TASK_SYSTEM_TOOL_AGENT_IDS.includes(key) && next["task_*"] === "allow") delete next["task_*"]
  if (bakedTaskSystemEnabled === true) {
    if (next.todowrite === "deny") delete next.todowrite
    if (next.todoread === "deny") delete next.todoread
  }
  if (!taskSystemEnabled) return next
  if (TASK_SYSTEM_TOOL_AGENT_IDS.includes(key)) next["task_*"] = "allow"
  next.todowrite = "deny"
  next.todoread = "deny"
  return next
}

/**
 * Rebuild the V1 global `config.tools` record for the LIVE
 * `experimental.task_system` gate.
 *
 * V1 writes `task_*: false` unconditionally and adds `todowrite` / `todoread`
 * `false` only while the task system is enabled; the manifest generator then
 * flips `task_*` to `true` when the install-time gate was on, so the global
 * allow IS the gate. Flipping the gate after install otherwise leaves a stale
 * allow (or a stale deny) that disagrees with the tools the runtime registers.
 *
 * The todo disables are the BAKED gate's overlay, so `bakedTaskSystemEnabled`
 * must be `true` before one is removed: with a manifest baked OFF an identical
 * `false` is the user's own global disable and survives. `task_*` is always
 * V1-written, so it follows the live gate in both directions, and a
 * user-declared `todowrite: true` is preserved either way.
 */
export function applyLiveTaskSystemGlobalTools(tools, taskSystemEnabled, bakedTaskSystemEnabled) {
  if (typeof taskSystemEnabled !== "boolean") return tools
  if (!isPlainObject(tools)) return tools
  const next = { ...tools }
  next["task_*"] = taskSystemEnabled
  if (taskSystemEnabled) {
    next.todowrite = false
    next.todoread = false
    return next
  }
  if (bakedTaskSystemEnabled === true) {
    if (next.todowrite === false) delete next.todowrite
    if (next.todoread === false) delete next.todoread
  }
  return next
}

/**
 * Canonical ids V1 `applyToolConfig` writes its generated `question` decision onto.
 *
 * `atlas` is deliberately absent: V1 never wrote `question` there, so an identical
 * deny on any other agent is the user's own declaration and is never touched.
 */
const QUESTION_OVERLAY_AGENT_IDS = Object.freeze(["sisyphus", "hephaestus", "prometheus"])

/**
 * Rebuild the `question` permission an ask-surface agent carries under the LIVE
 * `disabled_tools` denylist.
 *
 * V1 `applyToolConfig` writes `question: "deny"` on Sisyphus, Hephaestus and
 * Prometheus while the INSTALL-time `disabled_tools` named `question`, so the
 * manifest can hold a deny the user no longer wants. The live denylist cannot
 * remove it: that path is an exact-name registration/execution removal for tools
 * THIS runtime registers, while `question` belongs to the host and is governed
 * here as an agent permission. Without this the documented `disabled_tools: []`
 * release would need a reinstall, which is the defect.
 *
 * The recorded proof that the entry was GENERATED is the bake's own denylist
 * (`bakedDisabledTools`): V1 wrote the deny only while `question` was on it. A
 * manifest whose bake never named `question` turned the entry off for another
 * reason (a bake-time CLI run, an inline host permission), and a shape other than
 * the exact `"deny"` string V1 wrote is a user declaration; both are returned
 * unchanged. An explicit user deny also still wins through the global permission
 * overlay, which this never touches, and a live list that still names `question`
 * (or no live list at all) keeps the deny.
 */
export function applyLiveDisabledToolPermission(id, permission, { liveDisabledTools, bakedDisabledTools } = {}) {
  if (!isPlainObject(permission)) return permission
  if (!QUESTION_OVERLAY_AGENT_IDS.includes(canonicalAgentKey(id))) return permission
  if (permission.question !== "deny") return permission
  if (!Array.isArray(bakedDisabledTools) || !bakedDisabledTools.includes("question")) return permission
  if (!Array.isArray(liveDisabledTools) || liveDisabledTools.includes("question")) return permission
  const next = { ...permission }
  delete next.question
  return next
}

export const TOOL_PERMISSION_DENIED = "RIGEL_TOOL_PERMISSION_DENIED"
export const TOOL_PERMISSION_APPROVAL_REQUIRED = "RIGEL_TOOL_PERMISSION_APPROVAL_REQUIRED"
export const TOOL_PERMISSION_IDENTITY_UNRESOLVED = "RIGEL_TOOL_PERMISSION_IDENTITY_UNRESOLVED"
// A `disabled_tools` entry is a CONFIGURATION deny, not an agent permission: it
// carries its own code so an operator can tell a live `omo.jsonc` denylist from
// an agent `permission` decision.
export const TOOL_DISABLED_BY_CONFIG = "RIGEL_TOOL_DISABLED_BY_CONFIG"

export function frontierToolSchemaPermission(model) {
  const id = typeof model === "string" ? model : model?.id
  const normalized = String(id ?? "").toLowerCase()
  if (/^(?:gpt-(?:5\.[56]|6(?:\.|$))|claude-opus-4-[7-9])/.test(normalized)) {
    return { grep: "deny", glob: "deny" }
  }
  return {}
}

function permissionError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function normalizeAgentKey(value) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.toLocaleLowerCase() : undefined
}

function matchesAnyPattern(patterns, toolName) {
  for (const pattern of patterns) if (matchesGatePattern(pattern, toolName)) return true
  return false
}

/**
 * Normalize a `disabled_tools` list into the exact tool names the runtime
 * refuses.
 *
 * V1 parity (`shared/disabled-tools.ts`): the denylist is matched by EXACT
 * name. It has no wildcard semantics, so `task_*` disables nothing, and it is a
 * hard removal rather than a permission default, so nothing can re-enable it.
 * Non-string and blank entries are ignored, and an absent or malformed list
 * yields an empty set so a caller can never crash on a config record.
 */
export function createDisabledToolSet(disabledTools) {
  const set = new Set()
  if (!Array.isArray(disabledTools)) return set
  for (const entry of disabledTools) {
    if (typeof entry !== "string") continue
    const name = entry.trim()
    if (name) set.add(name)
  }
  return set
}

/**
 * The real V2 tool-name permission gate consumed by the runtime
 * `tool.execute.before` hook. `before(event)` throws before the executor for a
 * denied call and for an `ask` that still needs approval, returns for an
 * allowed or ungoverned call, and fails closed only when a governed call
 * cannot be tied to an agent identity (event.agent absent and the injected
 * session resolver cannot answer).
 *
 * `disabledTools` is the LIVE `disabled_tools` denylist and is evaluated
 * BEFORE any permission layer. V1 removes a disabled tool from the registry, so
 * no agent declaration and no global `config.tools` default could ever reach
 * it; evaluating the denylist first reproduces that ordering, which is why an
 * agent `allow` cannot win a disabled name back.
 */
export function createNativeToolPermissionGate({ globalGates = [], resolveAgent, disabledTools } = {}) {
  if (globalGates !== undefined && !Array.isArray(globalGates)) {
    throw new TypeError("Global tool gates must be an array")
  }
  const globalList = Array.isArray(globalGates) ? globalGates : []
  const disabledToolSet = createDisabledToolSet(disabledTools)
  const agentGatesByKey = new Map()
  const governedPatterns = new Set(globalList.map((gate) => gate && typeof gate.pattern === "string" ? gate.pattern : undefined).filter(Boolean))

  const registerAgent = (id, permissions) => {
    const key = normalizeAgentKey(id)
    if (!key) return
    const toolGates = Array.isArray(permissions?.toolGates) ? permissions.toolGates : []
    agentGatesByKey.set(key, toolGates)
    for (const gate of toolGates) {
      if (gate && typeof gate.pattern === "string") governedPatterns.add(gate.pattern)
    }
  }

  const resolveAgentKey = async (event) => {
    const inline = normalizeAgentKey(event?.agent)
    if (inline) return inline
    if (typeof resolveAgent !== "function") return undefined
    const sessionID = event?.sessionID
    if (typeof sessionID !== "string" || !sessionID) return undefined
    return normalizeAgentKey(await resolveAgent({ sessionID, toolName: event?.tool }))
  }

  return {
    registerAgent,
    async before(event) {
      const toolName = typeof event?.tool === "string" ? event.tool : undefined
      if (!toolName) return
      if (disabledToolSet.has(toolName)) {
        throw permissionError(TOOL_DISABLED_BY_CONFIG, `Rigel tool disabled by config: tool=${toolName}`)
      }
      const agentKey = await resolveAgentKey(event)
      // V1 precedence: an agent `permission` entry overrides the global `tools`
      // default. The global map is a default-deny catalog that specific agents
      // re-enable (librarian `grep_app_*: allow`; lead/executor `task_*` and
      // `teammate` allow), and an agent deny/ask also wins over a global allow.
      // Only when the agent has no matching entry does the global default apply.
      const globalEffect = evaluateToolNameGate(globalList, toolName)
      const agentEffect = agentKey ? evaluateToolNameGate(agentGatesByKey.get(agentKey) ?? [], toolName) : undefined
      const effect = agentEffect !== undefined ? agentEffect : globalEffect
      if (effect === "deny") throw permissionError(TOOL_PERMISSION_DENIED, `Rigel tool permission denied: tool=${toolName}${agentKey ? `; agent=${agentKey}` : ""}`)
      if (effect === "ask") throw permissionError(TOOL_PERMISSION_APPROVAL_REQUIRED, `Rigel tool permission requires approval: tool=${toolName}${agentKey ? `; agent=${agentKey}` : ""}`)
      if (effect === "allow") return
      if (agentKey) return
      if (matchesAnyPattern(governedPatterns, toolName)) {
        throw permissionError(TOOL_PERMISSION_IDENTITY_UNRESOLVED, `Rigel tool permission cannot establish agent identity for governed tool=${toolName}`)
      }
    },
  }
}
