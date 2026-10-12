import {
  delegateNamedAgent,
  delegateNamedAgentFromClients,
  listCallableAgentsFromClients,
  resolveNamedAgent,
  taskResult,
  resumeDelegatedSession,
  resumeDelegatedSessionFromClients,
  completedChildText,
  backgroundHandoffPrompt,
  isCoordinatorAgent,
  normalizeToolDefinition,
} from "./rigel-v2-native-core.mjs"
import {
  categoryTaskPrompt,
  listV2ModelsFromClients,
  mergeCategories,
  resolveCategoryFromClients,
} from "./rigel-v2-native-categories.mjs"
import { agentOverrideFor, resolveAgentDelegationModel, resolveAuthoritativeAgentOverrides, resolveEffectiveChain } from "./rigel-v2-native-explicit-chain.mjs"
import { createNativeNoSisyphusGptEnforcement } from "./rigel-v2-native-no-sisyphus-gpt.mjs"
import { isHephaestusAgentId } from "./rigel-v2-native-hephaestus.mjs"
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { createNativeContextHook, createNativeModelRequestHook } from "./rigel-v2-native-prompt.mjs"
import { readSisyphusPromptPlan, SISYPHUS_PROMPT_RECEIPT } from "./rigel-v2-native-sisyphus-prompt.mjs"
import { resolveFallbackModel } from "./rigel-v2-native-model-chains.mjs"
import { createDirectoryInstructionStore } from "./rigel-v2-directory-instructions.mjs"
import { createNativeToolResultReminders } from "./rigel-v2-native-reminders.mjs"
import { applyNativeRecoveryReminder } from "./rigel-v2-native-recovery.mjs"
import { createNativeRulesInjector } from "./rigel-v2-native-rules.mjs"
import { createNativeWriteExistingFileGuard } from "./rigel-v2-native-write-guard.mjs"
import { createNativeNonInteractiveEnvGuard } from "./rigel-v2-native-noninteractive.mjs"
import { createNativeCommentChecker } from "./rigel-v2-native-comment-checker.mjs"
import { createNativeWebFetchRedirectGuard } from "./rigel-v2-native-webfetch-redirect-guard.mjs"
import { createNativePlanFormatValidator } from "./rigel-v2-native-plan-format-validator.mjs"
import { createNativePrometheusMdOnly } from "./rigel-v2-native-prometheus-md-only.mjs"
import manifest from "./rigel-v2-native-agent-manifest.mjs"
import { checkNativeHostVersion, readLiveAgentOverridesSource, readNativeBundledVersion, readNativeDisabled, readNativeGates, readNativeMaxTools, readNativeMcpBuiltinsPolicy, readNativeMcpPolicy, readNativeOpenclaw, readNativePreemptiveThreshold, readNativeRepoRoot, readNativeTruncateAllToolOutputs } from "./rigel-v2-native-config.mjs"
import { registerNativeAgents } from "./rigel-v2-native-agents.mjs"
import { createNativeToolPermissionGate, translateGlobalTools } from "./rigel-v2-native-permissions.mjs"
import { createRuntimeHostSkillSource, registerNativeSkills, selectSkillsForChild, formatSkillInjection } from "./rigel-v2-native-skills.mjs"
import { createSkillMcpManager, createSkillMcpToolDefinition, registerSkillMcpServers } from "./rigel-v2-native-skill-mcp.mjs"
import { createSlashcommandTool } from "./tools/slashcommand.tools.mjs"
import { createGlobGrepTools } from "./tools/glob-grep.tools.mjs"
import { createNativeToolFamilies } from "./rigel-v2-native-tools.mjs"
import { registerConditionalNativeTools } from "./rigel-v2-native-conditional-tools.mjs"
import { formatGoalResponse, parseGoalCommand } from "./tools/goal.tools.mjs"
import { createV2SessionTodoStore, createTaskTodoSync } from "./tools/session-todo-store.mjs"
import { clearTodoPending, resolveBridgeStateRoot, wrapTodoStoreWithPending } from "./rigel-v2-native-todo-pending.mjs"
import { registerNativeTodoTool } from "./rigel-v2-native-todo-description.mjs"
import { createNativeUpdateChecker } from "./rigel-v2-native-update-checker.mjs"
import { createNativeUpdateState } from "./rigel-v2-native-update-state.mjs"
import { createServerApi } from "./rigel-v2-native-http.mjs"
import { createOpenGatewayProviderTransform } from "./rigel-v2-native-opengateway.mjs"
import { createBtwContextInjector, resolveBtwReceiptPath, writeBtwInjectionReceipt } from "./rigel-v2-native-btw-context.mjs"
import { createHashlineEditTool, createHashlineReadEnhancer } from "./rigel-v2-native-hashline.mjs"
import { createNativeCategorySkillReminder } from "./rigel-v2-native-category-skill-reminder.mjs"
import { createPersistentTerminalPort } from "./tools/terminal-driver.mjs"
import { runOrderedRules } from "./rigel-v2-native-hook-chain.mjs"
import { createSessionStateRegistry } from "./rigel-v2-native-session-state.mjs"
import { createKeywordState } from "./rigel-v2-keyword-state.mjs"
import { createBackgroundManager } from "./rigel-v2-background-manager.mjs"
import { getStoppedSessionErrorInfo } from "./rigel-v2-background-stopped.mjs"
import { writeStopMarker } from "./rigel-v2-background-marker.mjs"
import { createFileBackgroundState, createStorageBackgroundState } from "./rigel-v2-background-state.mjs"
// T17: single flow-rule import point. `createFlowRules` rebuilds the ordered
// before/after/request collections over the runtime's ONE fsync tracker; the
// state factories come from their binder modules.
import { createFlowRules } from "./rigel-v2-native-flow-rules.mjs"
import { createNativeCompactionContextHook, isCompactionSummaryRequest } from "./rigel-v2-native-compaction-context.mjs"
import { createNativeCompactionTodoPreserver } from "./rigel-v2-native-compaction-todo-preserver.mjs"
import { createNativePreemptiveCompaction, createNativeCompactionIncidentRegistry, readAssistantUsage, resolveNativeContextLimit, PREEMPTIVE_COMPACTION_THRESHOLD } from "./rigel-v2-native-preemptive-compaction.mjs"
import { createFsyncSkipWarningState } from "./rigel-v2-native-flow-after.mjs"
import { applyPromptAdmission, createStopContinuationState, resolveRequestShape, runRequestSteps } from "./rigel-v2-native-request-steps.mjs"
import { validateAndRepairMessages } from "./rigel-v2-native-message-repair.mjs"
import { createNativeAutoSlashCommandHook } from "./rigel-v2-auto-slash-command-bridge.mjs"
import { OMO_INTERNAL_INITIATOR_MARKER } from "./rigel-v2-keyword-core.mjs"
import { createNativeContextCollector, createNativeContextMessageConsumer } from "./rigel-v2-context-collector.mjs"
import { createNativeClaudeCodeHooks } from "./rigel-v2-claude-code-hooks.mjs"
import { createUlwExecuteCommand } from "./rigel-v2-ulw-execute.mjs"
import { registerBuiltinCommands } from "./rigel-v2-native-builtin-commands.mjs"
import { registerMcpOAuthCommand } from "./rigel-v2-native-mcp-oauth-command.mjs"
import { registerModelsCommand } from "./rigel-v2-native-models-command.mjs"
import { createNativeContextLimitRecovery, createNativeIdleContinuations, createNativeIdleGate } from "./rigel-v2-native-phase4-events.mjs"
import { createNativeTeamEventHandlers } from "./rigel-v2-team-events.mjs"
import { createNativeOpenclaw } from "./rigel-v2-native-openclaw.mjs"
import { createNativeTeamGatingRule, createNativeTeamMailboxInjector, createNativeTeamStatusInjector } from "./rigel-v2-team-gating.mjs"
import { createGitWorktreeRunner } from "./rigel-v2-team-worktrees.mjs"
import { createTeamScopeRegistry } from "./rigel-v2-team-scope-registry.mjs"
import { createNativeMonitorStatusInjector } from "./rigel-v2-monitor-status.mjs"
import { registerClaudeCodeMcps } from "./rigel-v2-claude-code-mcp.mjs"
import { registerNativeBuiltinMcps, resolveOpenCodeConfigDir } from "./rigel-v2-native-builtin-mcps.mjs"
import { createNativeToolBeforeRules } from "./rigel-v2-native-tool-before.mjs"
import { createTmuxVizManager } from "./rigel-v2-tmux-viz-manager.mjs"
import { readNativeTmuxVisualization } from "./rigel-v2-native-config.mjs"
// Todo-continuation enforcer. The state port owns the per-session
// progress/stagnation/cooldown bookkeeping, the gate is the pure decision
// predicate, and the prompt module builds the V1 continuation directive whose
// sentinel the V1 runtime recognizes.
import { createNativeTodoContinuationEnforcer } from "./rigel-v2-native-todo-continuation.mjs"
import { createTodoContinuationQa } from "./rigel-v2-native-todo-continuation-qa.mjs"

/**
 * Read the user's category overrides from the V2 setup context. V2 exposes the
 * merged plugin configuration on `context.config`; the shape is the same
 * `pluginConfig.categories` V1 reads (`packages/omo-opencode/src/plugin-handlers/agent-config-assembly.ts`).
 * A missing or malformed value degrades to no overrides so setup never fails
 * closed on a config read.
 */
export function readUserCategories(context) {
  const config = context?.config
  const categories = config?.categories
  if (!categories || typeof categories !== "object" || Array.isArray(categories)) return undefined
  return categories
}

/**
 * Build the `explicitAgentModels` map `resolveProactiveAgentModels` consumes from
 * the merged per-agent override map. Only an explicit `model` marks an agent as
 * pinned (`variant` rides along). A malformed model is still passed through: the
 * resolver runs it through the `Model.Ref` builder and falls back when it cannot
 * form one, so a raw model string never reaches a registered agent.
 */
export function buildExplicitAgentModels(agentOverrides) {
  return new Map(
    Object.entries(agentOverrides ?? {})
      .filter(([, override]) => typeof override?.model === "string" && override.model)
      .map(([id, override]) => [id, { model: override.model, variant: override.variant }]),
  )
}

/**
 * Read the user's keyword-detector overrides from the same merged plugin
 * config. The V1 hook reads `keyword_detector.disabled_keywords` and
 * `keyword_detector.enabled_expansions`; a missing or malformed value degrades
 * to no override so a config read never fails setup closed.
 */
export function readKeywordDetectorConfig(context) {
  const config = context?.config?.keyword_detector
  if (!config || typeof config !== "object" || Array.isArray(config)) return {}
  return {
    disabledKeywords: Array.isArray(config.disabled_keywords) ? config.disabled_keywords : undefined,
    enabledExpansions: Array.isArray(config.enabled_expansions) ? config.enabled_expansions : undefined,
  }
}

/**
 * Build the category roster the orchestrator prompt receives. Each entry
 * carries the name plus the description and caller guidance the resolved
 * category owns, so the roster is selection data rather than a names-only list.
 * The built-in manifest supplies the text; a user override replaces it.
 */
export function buildCategoryRoster(userCategories) {
  const enabled = mergeCategories(userCategories)
  const descriptions = manifest.descriptions ?? {}
  const guidance = manifest.guidance ?? {}
  return Object.entries(enabled).map(([name]) => ({
    name,
    description: userCategories?.[name]?.description ?? descriptions[name],
    callerGuidance: userCategories?.[name]?.caller_guidance ?? guidance[name],
  }))
}

/**
 * Skill-injection integration point for delegated children.
 *
 * The real resolver is Task 14 (`rigel-v2-native-skills.mjs`), which discovers
 * SKILL.md bodies and matches them by name. Resolved skills are injected as
 * `<skill name="...">` blocks via the module's own formatter; names that do not
 * resolve (unknown, disabled, or restricted to another agent) keep the textual
 * fallback notice so the gap is visible and the child can still try to load
 * them itself.
 *
 * `resolveSkill` is `(name) => Promise<{ name, body } | undefined>`.
 */
export async function applyRequestedSkills(prompt, requestedSkills, { resolveSkill } = {}) {
  if (!Array.isArray(requestedSkills) || requestedSkills.length === 0) return prompt
  if (typeof resolveSkill !== "function") {
    // No resolver available: never fake an injected skill, but do not drop the
    // request either. Emit the textual fallback for the whole set.
    const notice = `<rigel-requested-skills>Before working, load these native skills if available: ${requestedSkills.join(", ")}</rigel-requested-skills>`
    return `${prompt}\n\n${notice}`
  }
  const injected = []
  const missing = []
  for (const name of requestedSkills) {
    try {
      const result = await resolveSkill(name)
      if (result && typeof result.body === "string" && result.body.trim()) {
        injected.push({ name: result.name ?? name, body: result.body })
      } else {
        missing.push(name)
      }
    } catch (error) {
      missing.push(name)
      console.error(`[oh-my-rigel] Native V2 skill resolution failed: skill=${name}; ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (missing.length > 0) {
    console.error(`[oh-my-rigel] Native V2 skill injection incomplete; unresolved skills: ${missing.join(", ")}`)
  }
  const injection = formatSkillInjection({ injected, missing })
  return injection ? `${prompt}\n\n${injection}` : prompt
}

function writeStateReceipt(fileName, event) {
  const stateRoot = process.env.XDG_STATE_HOME
  if (!stateRoot) return
  const directory = path.join(stateRoot, "oh-my-rigel")
  const receipt = path.join(directory, fileName)
  const temporary = `${receipt}.${process.pid}.${randomUUID()}.tmp`
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    fs.writeFileSync(temporary, `${JSON.stringify({ recordedAt: new Date().toISOString(), ...event }, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temporary, receipt)
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }) } catch (cleanupError) {
      console.error(`[oh-my-rigel] Could not remove incomplete native V2 receipt: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
    }
    console.error(`[oh-my-rigel] Could not record native V2 receipt ${fileName}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function recordAgentTuning(event) {
  writeStateReceipt("agent-tuning-applied.json", event)
}

function recordConditionalToolRegistration(event) {
  writeStateReceipt("conditional-tools-registered.json", event)
}

function recordNativeToolFamilies(event) {
  writeStateReceipt("native-tool-families-registered.json", event)
}

/**
 * Report one isolated rule failure at a tool-hook boundary. `runOrderedRules`
 * records the failure whether or not this callback runs; the callback exists so
 * a degraded chain is visible in the runtime log instead of being swallowed
 * while the rules after the failure still run.
 */
function reportRuleFailure(phase, failure) {
  const message = failure?.error instanceof Error ? failure.error.message : String(failure?.error)
  console.error(`[oh-my-rigel] Native V2 ${phase} rule failed; chain continues: rule=${failure?.name}; ${message}`)
}

export function createTaskPresentation() {
  return `Spawn one delegated task through the OpenCode V2 agent runtime.

⚠️ CRITICAL: provide exactly one of category, subagent_type, or task_id. A task_id resumes a prior Rigel child.

Use subagent_type for a named specialist when its role matches a discrete research, consultation, review, or audit need. Use category for an execution worker with a category-selected model. The main agent chooses the appropriate route based on the active V2 agent inventory; this tool does not impose a routing policy.

By default this is foreground work: it waits and returns the child's final text, so use it when the result is needed for the next decision. Set run_in_background=true for independent work: it returns immediately, then native V2 event delivery wakes the parent with the child's final result. Prompts must state the child task, scope, constraints, and expected evidence clearly.`
}

// V2 accepts a JSON Schema/Standard Schema/Effect codec. A raw V1 Zod shape
// becomes `unknown` to the model, which silently produces V1 argument names.
const taskInput = {
  type: "object",
  properties: {
    subagent_type: { type: "string", description: "Exact callable agent name; omit when category or task_id is supplied." },
    category: { type: "string", description: "OmO category; omit when subagent_type or task_id is supplied." },
    task_id: { type: "string", description: "Existing Rigel child session ID to continue; omit for a new child." },
    description: { type: "string", description: "Short task description." },
    prompt: { type: "string", description: "Full task for the child agent." },
    run_in_background: { type: "boolean", description: "Set true only for independent work. Default false waits and returns the child result." },
    cancel: { type: "boolean", description: "Set true with task_id to cancel a queued or running background child instead of delegating. A queued cancel removes it before any child session is created." },
    load_skills: { type: "array", items: { type: "string" }, description: "Skills the child should load before working." },
  },
  required: ["prompt"],
  additionalProperties: false,
}

/** Build the `provider/id` admission key from a model ref object or string. */
function modelKeyString(value) {
  if (typeof value === "string") return value
  if (value && typeof value === "object") {
    const provider = value.providerID ?? value.provider
    const id = value.id ?? value.modelID
    if (typeof provider === "string" && typeof id === "string") return `${provider}/${id}`
    if (typeof id === "string") return id
  }
  return ""
}

/**
 * The honest pre-spawn admission key: the category's resolved model when the
 * category route is taken, else the user's explicit JSON agent model when one is
 * configured. Both are known BEFORE any child session exists, so the child is
 * admitted under its real bucket and is never re-keyed after spawn. An agent
 * with no JSON model yields no key: the manifest is never consulted for models.
 * Exported so the runtime tests pin the derivation without booting the setup
 * closure.
 */
export function preSpawnModelKey(category, agent, agentOverrides) {
  if (category?.model) return modelKeyString(category.model)
  const override = agentOverrideFor(agentOverrides, agent?.id ?? agent?.name)
  if (typeof override?.model === "string" && override.model) return modelKeyString(override.model)
  return ""
}

/** The tool result for a background request that was queued instead of started. */
function queuedTaskResult(decision, agentName) {
  return {
    content: `The background task was queued (taskId: ${decision.taskId}; key: ${decision.key}; limit: ${decision.limit}) and will start when a concurrency slot frees. It has NOT been created yet.`,
    metadata: { taskId: decision.taskId, queued: true, key: decision.key, limit: decision.limit, agent: agentName },
  }
}

function readSessionAgent(result) {
  const agent = result?.data?.agent ?? result?.agent
  if (typeof agent !== "string") return undefined
  const trimmed = agent.trim()
  return trimmed ? trimmed : undefined
}

async function lookupSessionAgent(call, sessionID) {
  try {
    return readSessionAgent(await call())
  } catch (error) {
    console.error(`[oh-my-rigel] Native V2 session agent lookup failed: session=${sessionID}; ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/**
 * Resolve the agent that owns a V2 session, for the tool-name permission gate
 * when `tool.execute.before` carries no `agent`. Uses the V2 session surface
 * first and the compatible client surface second; an absent or failing lookup
 * returns `undefined` so the gate can decide whether to fail closed.
 */
export function createSessionAgentResolver(context) {
  return async ({ sessionID } = {}) => {
    if (typeof sessionID !== "string" || !sessionID) return undefined
    if (typeof context?.session?.get === "function") {
      const fromSession = await lookupSessionAgent(() => context.session.get({ sessionID }), sessionID)
      if (fromSession) return fromSession
    }
    if (typeof context?.client?.session?.get === "function") {
      return lookupSessionAgent(() => context.client.session.get({ path: { id: sessionID } }), sessionID)
    }
    return undefined
  }
}

/**
 * Build the tool-name permission gate the runtime wires as one
 * `tool.execute.before` hook. It merges the materialized global
 * `manifest.metadata.global.tools` gates before each agent's gates (so an
 * agent-specific declaration wins) and indexes every agent under both its
 * manifest id and its display name.
 *
 * Exported so the runtime tests can drive the real collection and decision path
 * with a fixture manifest instead of mutating the generated manifest module.
 */
export function createNativePermissionWiring({ manifest: agentManifest, resolveAgent } = {}) {
  const globalGates = translateGlobalTools(agentManifest?.metadata?.global?.tools)
  const agents = agentManifest && typeof agentManifest.agents === "object" && agentManifest.agents !== null ? agentManifest.agents : {}
  const gate = createNativeToolPermissionGate({ globalGates, resolveAgent })
  return {
    globalGates,
    onAgentPermissions(id, permissions) {
      if (typeof id !== "string" || !id) return
      gate.registerAgent(id, permissions)
      const name = agents[id]?.name
      if (typeof name === "string" && name && name !== id) gate.registerAgent(name, permissions)
    },
    before(event) {
      return gate.before(event)
    },
  }
}

export default {
  id: "oh-my-rigel",
  setup: async (context) => {
    const location = context?.location ?? { directory: process.cwd() }
    // Host-version floor (V1 `minimum-opencode-version.ts` parity): refuse a host
    // below the minimum materialized into the manifest. An absent
    // `context.app.version` degrades to no check instead of failing a host that
    // does not publish its identity.
    const hostVersionCheck = checkNativeHostVersion(manifest, context?.app?.version)
    if (!hostVersionCheck.ok) {
      throw new Error(hostVersionCheck.message)
    }
    if (typeof context?.tool?.transform !== "function") {
      throw new Error("OpenCode V2 tool.transform is unavailable")
    }
    const agentRequestBodies = new Map()
    // User category overrides come from the merged plugin config V2 exposes on
    // the setup context. They are read once and threaded through both the
    // execution-time resolver and the orchestrator roster so a user category is
    // selectable and routable exactly like a built-in.
    const userCategories = readUserCategories(context)
    // JSON-ONLY model source: the user's per-agent overrides (explicit model /
    // ordered candidates / fallback_models) come ONLY from the LIVE
    // `~/.omo/omo.jsonc` (resolved through the same authority the generator
    // uses, anchored at HOME). The manifest is never consulted for models, so a
    // removed pin cannot be revived and an agent with no JSON model inherits the
    // OpenCode global. An unreadable live file fails safe to no overrides. V2's
    // setup context exposes no plugin `config`, so the on-disk config is the only
    // live source. An unexpected throw in the read itself is treated as the same
    // fail-safe (`error`).
    let liveOverridesSource
    try {
      liveOverridesSource = readLiveAgentOverridesSource({ home: process.env.HOME, env: process.env })
    } catch (error) {
      console.error(`[oh-my-rigel] Native V2 live agent override read failed; ignoring pins (fail-safe, no manifest revival): ${error instanceof Error ? error.message : String(error)}`)
      liveOverridesSource = { state: "error" }
    }
    if (liveOverridesSource.state === "error") {
      console.error(`[oh-my-rigel] Native V2 live config unreadable (${liveOverridesSource.reason ?? "unknown"}); per-agent model pins ignored until it parses (no stale-pin revival)`)
    }
    const agentOverrides = resolveAuthoritativeAgentOverrides({ live: liveOverridesSource })
    const sessionAgentResolver = createSessionAgentResolver(context)
    const permissionWiring = createNativePermissionWiring({
      manifest,
      resolveAgent: sessionAgentResolver,
    })
    const registeredAgents = await registerNativeAgents(context.agent, manifest, {
      // JSON-only registration: an agent with a JSON model registers that ref;
      // an agent with no JSON model registers with NO model (inherits the
      // OpenCode global). No canonical-chain substitution.
      chainFallback: false,
      listModels: () => listV2ModelsFromClients([context, context?.client], location),
      // The user's pinned agent models, read from the LIVE `~/.omo/omo.jsonc`
      // only. The proactive resolver keeps that model instead of overwriting it.
      explicitAgentModels: buildExplicitAgentModels(agentOverrides),
      // V1 `disabled_agents`: a disabled agent is never registered, so a switch
      // onto it is impossible.
      disabledAgents: readNativeDisabled(manifest).agents,
      onAgentRequest: (id, body) => {
        agentRequestBodies.set(id.toLocaleLowerCase(), body)
        const name = manifest.agents?.[id]?.name
        if (typeof name === "string") agentRequestBodies.set(name.toLocaleLowerCase(), body)
      },
      // The permission gate consumes each agent's translated tool-name gates
      // here, so the `execute.before` hook below governs the real roster.
      onAgentPermissions: (id, permissions) => permissionWiring.onAgentPermissions(id, permissions),
    })
    // Upstream 5fd04b590: redirect a Sisyphus session on an unsupported GPT model
    // to Hephaestus, or keep Sisyphus with a distinct notice when Hephaestus is
    // not in the REGISTERED roster. The redirect uses the V2 switchAgent seam and
    // an observable attention notice plus a durable receipt (never prompt-only).
    const noSisyphusGpt = createNativeNoSisyphusGptEnforcement({
      switchAgent: (args) => context?.session?.switchAgent?.(args),
      resolveSession: async (sessionID) => {
        try {
          const session = await context?.session?.get?.({ sessionID })
          const data = session?.data ?? session ?? {}
          const agent = typeof data.agent === "string" ? data.agent : undefined
          const modelID = typeof data.model?.modelID === "string" ? data.model.modelID
            : (typeof data.model?.id === "string" ? data.model.id : (typeof data.model === "string" ? data.model : undefined))
          return { agent, modelID }
        } catch (error) {
          console.error(`[oh-my-rigel] no-sisyphus-gpt: session resolve failed: ${error instanceof Error ? error.message : String(error)}`)
          return undefined
        }
      },
      notify: (payload) => {
        try {
          return context?.attention?.notify?.(payload)
        } catch (error) {
          console.error(`[oh-my-rigel] no-sisyphus-gpt: attention notify failed: ${error instanceof Error ? error.message : String(error)}`)
          return undefined
        }
      },
      hephaestusTarget: () => registeredAgents.find((id) => isHephaestusAgentId(id)),
      log: (message, detail) => {
        console.error(`[oh-my-rigel] ${message}${detail ? ` ${JSON.stringify(detail)}` : ""}`)
        writeStateReceipt("no-sisyphus-gpt.json", { message, ...detail })
      },
    })
    // Native skill surface (Task 14). Discovered skills are registered into
    // V2's own skill registry (`context.skill.transform`), and their embedded
    // MCP servers into V2's MCP registry (`context.mcp.transform`). The same
    // discovered list feeds real body injection for delegated children and the
    // per-session `skill_mcp` manager. When the host lacks a domain (older lab
    // build or a test fixture), the family degrades to an empty, inert set
    // instead of throwing during setup.
    const skillRegistry = typeof context?.skill?.transform === "function"
      ? await registerNativeSkills(context, {
        directory: location.directory,
        // Test seam: a fixture may point discovery at a disposable home/XDG pair
        // so the host's real skill inventory is never read.
        home: context?.options?.skillsHome,
        env: context?.options?.skillsEnv,
      })
      : { skills: [], registered: [], dispose: undefined }
    // Runtime host-skill source (V1 runtime-skill-resolver parity): skills that
    // other plugins add through config hooks are merged at skill_mcp call
    // time from the host's merged catalog (`ctx.skill.list()`), cached
    // single-flight, with the on-disk set as the failure fallback.
    const resolveRuntimeSkills = createRuntimeHostSkillSource({
      context,
      baseSkills: skillRegistry.skills,
      disabledSkills: readNativeDisabled(manifest).skills,
    })
    const skillMcpManager = createSkillMcpManager()
    const skillMcpRegistration = await registerSkillMcpServers(context, skillRegistry.skills)
    // Tier-2 Claude Code MCP loader (correction H5): project/user .mcp.json
    // declarations through ctx.mcp.transform, with the V1 env-allowlist rule.
    const claudeMcpRegistration = await registerClaudeCodeMcps(context, {
      directory: location.directory,
      home: context?.options?.skillsHome,
      claudeConfigDir: context?.options?.skillsEnv?.CLAUDE_CONFIG_DIR,
      disabledMcps: readNativeMcpPolicy(manifest).disabled,
      allowlist: readNativeMcpPolicy(manifest).envAllowlist,
    })
    // Tier-1 OmO builtin MCP servers (T38). The V2 host has no LSP tools and no
    // grep_app server (official migrate-v1: V2 "does not run language servers,
    // expose LSP tools, or produce LSP diagnostics"), so the retained builtins
    // are registered natively through `context.mcp.transform` exactly as V1
    // registered them through the plugin config. A missing LSP runtime degrades
    // to a disabled server instead of a broken one.
    const builtinMcpRegistration = await registerNativeBuiltinMcps(context, {
      cwd: location.directory,
      repoRoot: readNativeRepoRoot(manifest),
      configDir: resolveOpenCodeConfigDir(),
      disabledMcps: readNativeMcpPolicy(manifest).disabled,
      retained: readNativeMcpBuiltinsPolicy(manifest).retained,
      env: process.env,
    })
    // V1 `features/opengateway-provider`: when an OpenGateway credential is
    // present (env `OPENGATEWAY_API_KEY` or the isolated auth store), register
    // the provider and the packaged catalog through the V2 provider transform.
    // Absent credential is a byte-identical no-op: `install` returns before the
    // transform runs. Never throws into setup.
    const openGateway = createOpenGatewayProviderTransform({
      log: (message) => console.error(`[oh-my-rigel] ${message}`),
    })
    try {
      await openGateway.install(context)
    } catch (error) {
      console.error(`[oh-my-rigel] OpenGateway provider install failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    // Real skill-body injection for delegated children: resolve each requested
    // name through the discovered registry and inject the body. Disabled or
    // target-restricted names resolve to nothing and are reported, never faked.
    const resolveSkillForChild = async (name) => {
      const selected = selectSkillsForChild(skillRegistry.skills, [name])
      const match = selected.injected?.[0]
      return match ? { name: match.name, body: match.body } : undefined
    }
    const readPromptFile = (name) => {
      const file = new URL(`./prompts/${name}`, import.meta.url)
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
    }
    const ultraworkPrompt = readPromptFile("ultrawork-default.md")
    if (manifest.modes?.defaultUltrawork === true && !ultraworkPrompt.trim()) {
      throw new Error("Rigel V2 default Ultrawork is enabled but its native prompt is missing")
    }
    // Task 12: keyword-detector seams. Ultrawork bodies route by the V1 source
    // (planner/gpt/gemini/glm/default); team, hyperplan, and the combo banner
    // are the V1 mode prompts. A missing staged file degrades to the default
    // ultrawork body or to no directive, never to a fabricated one.
    const ultraworkPrompts = {
      default: ultraworkPrompt,
      gpt: readPromptFile("ultrawork-gpt.md"),
      gemini: readPromptFile("ultrawork-gemini.md"),
      glm: readPromptFile("ultrawork-glm.md"),
      planner: readPromptFile("ultrawork-planner.md"),
    }
    const keywordMessages = {
      team: readPromptFile("team.md"),
      hyperplan: readPromptFile("hyperplan.md"),
      comboBanner: readPromptFile("ultrawork-combo-banner.md"),
    }
    const keywordState = createKeywordState()
    const keywordConfig = readKeywordDetectorConfig(context)
    // V2 owns `task` after plugin transforms complete, so registering that
    // name here creates an editor entry the model never receives. A distinct
    // name is required for a real, callable Rigel delegation surface.
    const taskName = process.env.RIGEL_NATIVE_TASK_NAME || "rigel_task"
    const childSessionIDs = new Set()
    // Proactive/reactive model fallback state. Keyed by session so a failing
    // child never poisons its parent's chain, and bounded by the chain length.
    const categoryChildSessions = new Map()
    const sessionFallback = new Map()
    let inventoryFailureLogged = false
    const readAvailableModels = async () => {
      try {
        return await listV2ModelsFromClients([context, context?.client], location)
      } catch (error) {
        if (!inventoryFailureLogged) {
          inventoryFailureLogged = true
          console.error(`[oh-my-rigel] Native V2 model inventory unavailable; model fallback disabled: ${error instanceof Error ? error.message : String(error)}`)
        }
        return undefined
      }
    }
    // The model a DELEGATED CHILD starts on. A category delegation uses the
    // category's already inventory-resolved model. A named-agent delegation walks
    // the agent's JSON ordered chain (`agents.<id>.model` + `.fallback_models`)
    // against the live inventory and starts on the first reachable rung. Only an
    // ABSENT or deliberately EMPTY agent entry inherits the OpenCode global; a
    // configured but unreachable chain keeps its head and fails AS CONFIGURED,
    // never silently on the global. The manifest is never consulted for models.
    const resolveDelegationModel = async (category, agent) => {
      if (category?.model) return category.model
      const override = agentOverrideFor(agentOverrides, agent?.id ?? agent?.name)
      return resolveAgentDelegationModel(override, await readAvailableModels())
    }
    // Upstream 5a9bb74a4: the EFFECTIVE chain for a session. An explicit user
    // model (category or agent) yields ONLY the user's `fallback_models` (empty
    // when none), never the built-in canonical chain. A configured
    // `fallback_models` replaces the built-in chain even without a pinned model.
    const explicitChainFor = (sessionID, agent) => resolveEffectiveChain({
      descriptor: categoryChildSessions.get(sessionID),
      agent,
      userCategories,
      agentOverrides,
    })
    const resolveNativeModel = async ({ sessionID, agent, model, sameProviderAs }) => {
      if (!sessionID || typeof model !== "string" || !model.trim()) return undefined
      const chain = explicitChainFor(sessionID, agent)
      if (!Array.isArray(chain) || chain.length === 0) return undefined
      const state = sessionFallback.get(sessionID) ?? { chain, failedModels: new Set(), attempts: 0 }
      state.chain = chain
      state.model = model
      state.agent = agent
      // Remember the provider V2 selected for this session so the reactive path
      // (which has no request ref of its own) can stay on it too.
      if (typeof sameProviderAs === "string" && sameProviderAs) state.providerID = sameProviderAs
      sessionFallback.set(sessionID, state)
      // Bounded attempts: once the chain is exhausted, stop rewriting.
      if (state.attempts >= chain.length) return undefined
      // A reactive failure already selected the next step; honour it directly
      // so the rewrite does not depend on the model V2 happens to resend.
      if (state.nextModel?.id && !state.failedModels.has(state.nextModel.id)) {
        const next = state.nextModel
        state.nextModel = undefined
        if (next.id !== model) {
          console.error(`[oh-my-rigel] Native V2 model fallback (reactive step): session=${sessionID}; agent=${agent ?? "unknown"}; from=${model}; to=${next.id}; attempts=${state.attempts}/${chain.length}`)
        }
        return next
      }
      const availableModels = await readAvailableModels()
      if (!availableModels) return undefined
      const resolved = resolveFallbackModel({ chain, availableModels, currentModel: model, failedModels: state.failedModels, sameProviderAs })
      if (resolved?.id && resolved.id !== model) {
        console.error(`[oh-my-rigel] Native V2 model fallback: session=${sessionID}; agent=${agent ?? "unknown"}; from=${model}; to=${resolved.id}; attempts=${state.attempts}/${chain.length}`)
      }
      return resolved
    }
    const applyReactiveFallback = async (sessionID) => {
      const state = sessionFallback.get(sessionID)
      if (!state) return
      const chain = Array.isArray(state.chain) ? state.chain : []
      if (state.attempts >= chain.length) return
      if (typeof state.model === "string" && state.model) state.failedModels.add(state.model)
      state.attempts += 1
      // A user `fallback_models` chain does NOT include the running model, so the
      // first failure must be allowed to walk rung 0 (V1 walks
      // `configuredFallbackChain` from index 0). Built-in chains include the
      // primary as rung 0, which the resolver skips as a no-op, so allowing the
      // full chain length changes nothing there.
      if (state.attempts > chain.length) {
        console.error(`[oh-my-rigel] Native V2 model fallback exhausted: session=${sessionID}; attempts=${state.attempts}/${chain.length}; last=${state.model ?? "unknown"}`)
        return
      }
      const availableModels = await readAvailableModels()
      // Reactive resolution walks the FULL chain and may change provider: unlike
      // `http.request` (post-selection, same-provider guard only), `switchModel`
      // is a pre-selection boundary that accepts a `providerID`, so picking a
      // rung on another provider is a real fallback here, not a misroute.
      // `sameProviderAs` is deliberately omitted for this path.
      const next = availableModels
        ? resolveFallbackModel({ chain, availableModels, currentModel: state.model, failedModels: state.failedModels })
        : undefined
      state.nextModel = next
      console.error(`[oh-my-rigel] Native V2 reactive model fallback: session=${sessionID}; failed=${state.model ?? "unknown"}; attempts=${state.attempts}/${chain.length}; next=${next?.id ?? "none"}`)
      // V2 ignores the `http.request` `body.model` rewrite (proven live), so the
      // resolved rung only takes effect through the pre-selection model boundary.
      // Switch the session model to the resolved rung, carrying its own
      // providerID so a cross-provider fallback is honoured; the next request
      // then runs the fallback. Guarded so an absent API or a provider
      // rejection never tears down the event subscription.
      if (next?.id && typeof context?.session?.switchModel === "function") {
        try {
          await context.session.switchModel({
            sessionID,
            model: {
              ...(next.providerID ? { providerID: next.providerID } : {}),
              id: next.id,
            },
          })
          // Advance the tracked model to the rung we just switched to. Without
          // this the next failure would re-add the stale model and resolve the
          // same rung again, so the walk would stall instead of advancing.
          // The new model is NOT marked failed here: it becomes the running
          // model, and the next failure marks it before the following walk.
          state.model = next.id
          if (typeof next.providerID === "string" && next.providerID) state.providerID = next.providerID
        } catch (error) {
          console.error(`[oh-my-rigel] Native V2 switchModel failed: session=${sessionID}; model=${next.id}; ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    // Seed a delegated child's fallback state at creation time, so a failure
    // that happens BEFORE `http.request` (an unavailable model or variant
    // rejected at V2 model resolution) still has a chain to walk. Without this,
    // `session.execution.failed` would arrive for an untracked session and the
    // reactive fallback could not act.
    const seedChildFallback = (sessionID, { agent, model } = {}) => {
      if (typeof sessionID !== "string" || !sessionID) return
      const chain = explicitChainFor(sessionID, agent)
      if (!Array.isArray(chain) || chain.length === 0) return
      const state = sessionFallback.get(sessionID) ?? { chain, failedModels: new Set(), attempts: 0 }
      state.chain = chain
      if (typeof model?.id === "string" && model.id) state.model = model.id
      if (typeof agent === "string" && agent) state.agent = agent
      if (typeof model?.providerID === "string" && model.providerID) state.providerID = model.providerID
      sessionFallback.set(sessionID, state)
    }
    const directoryInstructions = createDirectoryInstructionStore({ directory: location.directory })
    const reminders = createNativeToolResultReminders({ storage: context?.storage })
    // Task 19: hydration reads the session transcript to suppress a rule whose
    // emitted marker is still present, so a lost in-memory cache does not
    // re-inject it. An absent session context degrades to an empty transcript.
    const rules = createNativeRulesInjector({
      directory: location.directory,
      getSessionMessages: (sessionID) => (typeof context?.session?.context === "function"
        ? context.session.context({ sessionID })
        : Promise.resolve([])),
    })
    // Task 19: hashline is gated by the materialized `hashline_edit` gate. When
    // on, the read enhancer tags V2 read output with LINE#ID and an equivalent
    // `hashline_edit` tool validates the anchor hash before writing.
    const nativeGates = readNativeGates(manifest)
    // The auto-update-checker effect. V1 checked the published plugin's npm
    // dist-tags once per startup and toasted a newer version. The native runtime
    // fetches the same registry at most once per day, caches the result in
    // `ctx.storage` and injects a system notice through the `context` hook. It is
    // started here but never awaited (non-blocking), never installs anything, and
    // degrades to silence with an observable log plus a durable receipt when the
    // network fails or no version is resolvable.
    const updateState = createNativeUpdateState({
      storage: context?.storage,
      // QA seam only: a distinct storage key per scenario lets the live lab
      // exercise the newer/equal/failure paths without fighting the daily cache.
      key: process.env.RIGEL_UPDATE_STATE_KEY || "status",
      onError: (error) => console.error(`[oh-my-rigel] update-check storage: ${error instanceof Error ? error.message : String(error)}`),
    })
    const updateChecker = createNativeUpdateChecker({
      state: updateState,
      fetchImpl: typeof fetch === "function" ? fetch : undefined,
      registryUrl: process.env.RIGEL_UPDATE_REGISTRY_URL
        || `https://registry.npmjs.org/-/package/${process.env.RIGEL_UPDATE_PACKAGE || "oh-my-openagent"}/dist-tags`,
      packageName: process.env.RIGEL_UPDATE_PACKAGE || "oh-my-openagent",
      currentVersion: process.env.RIGEL_UPDATE_CURRENT_VERSION || readNativeBundledVersion(manifest),
      onReceipt: (event) => writeStateReceipt("update-check.json", event),
      logger: (message) => console.error(`[oh-my-rigel] ${message}`),
    })
    void updateChecker.refresh().catch((error) => {
      console.error(`[oh-my-rigel] update check failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    const hashlineEnabled = nativeGates.hashline_edit === true
    const hashline = hashlineEnabled ? createHashlineReadEnhancer() : undefined
    const hashlineEditTool = hashlineEnabled ? createHashlineEditTool({ directory: location.directory }) : undefined
    // The bidirectional OpenClaw composition owns the outbound dispatch
    // (invoked from the shared event loop below, never a second subscription) and
    // the inbound reply listener (started here, stopped on dispose). The config is
    // the manifest-materialized `openclaw` block; absent or disabled means a
    // strict no-op with no listener, no dispatch and no network. `ready` is
    // awaited so a configured listener is running before the first event, and a
    // start failure degrades to disabled instead of failing setup.
    const openclaw = createNativeOpenclaw({
      context,
      config: readNativeOpenclaw(manifest),
      // V1 parity: a `session.created` for a delegated child is not a wake. The
      // runtime already tracks delegated children in `childSessionIDs`, the same
      // set the delegation roster uses as `isRootSession`.
      isSubagentSession: (sessionID) => childSessionIDs.has(sessionID),
      log: (line) => console.error(line),
    })
    try {
      await openclaw.ready
    } catch (error) {
      console.error(`[oh-my-rigel] Native V2 openclaw listener start failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    // Task 19: category-skill reminder. The formatter is built once from the
    // discovered skill registry; `scope` maps to the formatter's `location` so
    // builtin skills are classified as builtin and the rest as user skills.
    const categorySkillReminder = createNativeCategorySkillReminder({
      getSkills: () => skillRegistry.skills.map((skill) => ({ name: skill.name, location: skill.scope })),
      getAgent: async ({ sessionID, agent }) => (await sessionAgentResolver({ sessionID })) ?? agent,
    })
    const writeGuard = createNativeWriteExistingFileGuard({ directory: location.directory })
    const nonInteractiveEnv = createNativeNonInteractiveEnvGuard()
    const commentChecker = createNativeCommentChecker()
    const webFetchGuard = createNativeWebFetchRedirectGuard()
    const planFormatValidator = createNativePlanFormatValidator({ directory: location.directory })
    const prometheusMdOnly = createNativePrometheusMdOnly({ resolveAgent: sessionAgentResolver, directory: location.directory })
    // T17: the flow pipelines (T13-T15 binders) share the one fsync tracker
    // created once here and never per request or per session; it is the single
    // tracker the before start rule records into and the after warning rule
    // drains from. `createFlowRules` rebuilds the ordered collections over it.
    const fsyncSkipState = createFsyncSkipWarningState()
    const flowRules = createFlowRules({ fsyncSkipState, truncateAllToolOutputs: readNativeTruncateAllToolOutputs(manifest) })
    // Team mode (Phase-4 Ola 6): when the materialized `team_mode` gate is on
    // and the V2 storage domain exists, the four native team event handlers
    // (idle wake hint, member status, member error, lead orphan) join the same
    // shared event loop instead of opening a second subscription. Handlers are
    // error-isolated inside the module, so one failure never aborts the loop.
    // Per-member worktrees. One manager built from the project canonical root is
    // shared by the team tools (create/delete/approved shutdown) and the
    // lead-orphan handler. `session.move` is the native equivalent of V1
    // launching a member with cwd=its worktree.
    // Per-repo team scope registry: teams, the cleanup journal and worktrees are
    // keyed by the SESSION's repo (resolved per tool call and per event), so one
    // plugin instance serving several repos never collides or cross-cleans.
    const teamScopeRegistry = nativeGates.team_mode === true && typeof context?.storage?.set === "function"
      ? createTeamScopeRegistry({
          storage: context.storage,
          runGit: createGitWorktreeRunner(),
          log: (line) => console.error(line),
          bindSession: typeof context?.session?.move === "function"
            ? async ({ sessionID, directory }) => { await context.session.move({ sessionID, directory, delivery: "queue" }) }
            : undefined,
        })
      : undefined
    const teamEventHandlers = nativeGates.team_mode === true && typeof context?.storage?.set === "function"
      ? createNativeTeamEventHandlers({ storage: context.storage, session: context.session, scopeRegistry: teamScopeRegistry })
      : []
    // Gating and injectors scan the project namespaces and act only on the team
    // the calling session belongs to.
    const teamGatingRule = teamEventHandlers.length > 0
      ? createNativeTeamGatingRule({ storage: context.storage })
      : undefined
    const teamMailboxInjector = teamEventHandlers.length > 0
      ? createNativeTeamMailboxInjector({ storage: context.storage })
      : undefined
    const teamStatusInjector = teamEventHandlers.length > 0
      ? createNativeTeamStatusInjector({ storage: context.storage })
      : undefined
    // tmux visualization (rewritten feature, gated on team_mode.tmux_visualization):
    // one agent pane per delegated session. Degraded environments (no tmux,
    // not inside tmux) are logged once and the manager stays inert.
    let tmuxVizManager
    if (nativeGates.team_mode === true && readNativeTmuxVisualization(manifest)) {
      tmuxVizManager = createTmuxVizManager({
        config: context?.config?.team_mode ?? {},
        env: context?.options?.tmuxVizEnv ?? process.env,
        serverUrl: typeof context?.serverUrl === "string" ? context.serverUrl : undefined,
        directory: location.directory,
        fetchSessionStatus: async () => {
          if (typeof context?.session?.status !== "function") return null
          const response = await context.session.status()
          const rows = response?.data ?? response
          const map = new Map()
          for (const row of Array.isArray(rows) ? rows : []) {
            if (row?.sessionID) map.set(row.sessionID, row.status ?? row.type)
          }
          return map
        },
      })
      if (!tmuxVizManager.enabled) {
        console.error(`[oh-my-rigel] tmux-viz degraded: ${tmuxVizManager.degradedReason}`)
      }
    }
    const abortBackgroundHandoffs = new AbortController()
    // The background manager owns the tracked background children, the FIFO
    // admission queue (T2 key/limit), the retry classifier, the on-disk
    // continuation marker, and the NON-BLOCKING completion handoff. `runHandoff`
    // is the only effect; the manager schedules it behind a microtask, so the V2
    // event loop that observed a child completion never awaits a slow parent
    // prompt (the head-of-line block the inline `await` used to cause).
    const backgroundManager = createBackgroundManager({
      directory: location.directory,
      config: context?.config?.background_task,
      abortSignal: abortBackgroundHandoffs.signal,
      // Durable background state goes through the official V2 `ctx.storage`
      // surface (JSON, scoped to the plugin id) when the host exposes it; a
      // file-backed store keeps local tests and storage-less hosts working.
      stateStore: context?.storage && typeof context.storage.get === "function"
        ? createStorageBackgroundState({ storage: context.storage })
        : createFileBackgroundState(location.directory),
      // Admission-before-spawn: the manager decides whether a request may spend a
      // concurrency slot and only then calls this to create/prompt the child. A
      // queued request is never created; it starts here when a slot frees.
      startChild: async (descriptor, onSession) => {
        const clients = [context, context.client].filter(Boolean)
        const run = async (client) => {
          if (descriptor.route === "resume" && typeof descriptor.sessionID === "string") {
            const resumed = await resumeDelegatedSession({ client, sessionID: descriptor.sessionID, prompt: `<rigel-task-id>${descriptor.taskId}</rigel-task-id>\n\n${descriptor.prompt}`, background: true })
            onSession(resumed.sessionID)
            return { sessionID: resumed.sessionID }
          }
          const delegated = await delegateNamedAgent({
            client,
            location,
            agent: descriptor.agent,
            prompt: `<rigel-task-id>${descriptor.taskId}</rigel-task-id>\n\n${descriptor.prompt}`,
            background: true,
            model: descriptor.modelRef,
            parentSessionID: descriptor.parentSessionID,
            onChildSession: (sessionID, child) => {
              onSession(sessionID, child?.model)
              childSessionIDs.add(sessionID)
              if (descriptor.category) {
                categoryChildSessions.set(sessionID, {
                  name: descriptor.category.name,
                  explicit: descriptor.category.explicit,
                  chain: descriptor.category.fallbackChain,
                })
              }
              seedChildFallback(sessionID, child)
            },
          })
          return { sessionID: delegated.sessionID }
        }
        const diagnostics = []
        for (const client of clients) {
          try {
            return await run(client)
          } catch (error) {
            diagnostics.push(error instanceof Error ? error.message : String(error))
          }
        }
        throw new Error(`OpenCode V2 background child could not be created: ${diagnostics.join("; ")}`)
      },
      abortChild: (sessionID) => {
        if (typeof context?.session?.interrupt === "function") return context.session.interrupt({ sessionID })
        if (typeof context?.session?.abort === "function") return context.session.abort({ sessionID })
        return undefined
      },
      // Upstream a0b2e96c3: the manager's event-driven errored-idle check reads
      // the child transcript through the same V2 surface the rules injector uses.
      // An absent session context degrades to "no error" (never a false finalize).
      readStoppedError: async (sessionID) => {
        if (typeof context?.session?.context !== "function") return undefined
        const raw = await context.session.context({ sessionID })
        const messages = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : [])
        return getStoppedSessionErrorInfo(messages)
      },
      // Upstream 8e705a122: the retry walker must know the child's fallback chain
      // (explicit user chain or the built-in one) to pick the next served model.
      resolveFallbackChain: (record) => explicitChainFor(record.sessionID, record.agent?.name ?? record.agent),
      runHandoff: async ({ sessionID, status, child }) => {
        let result = ""
        if (status === "succeeded" && typeof context?.session?.context === "function") {
          result = completedChildText(await context.session.context({ sessionID }))
        }
        await context.session.prompt({
          sessionID: child.parentSessionID,
          text: backgroundHandoffPrompt({ sessionID, agent: child.agent, status, result, error: child.error }),
          resume: true,
        })
        console.error(`[oh-my-rigel] Native V2 background handoff: child=${sessionID}; parent=${child.parentSessionID}; status=${status}${child.error ? `; error=${String(child.error).slice(0, 200)}` : ""}`)
      },
      onError: (error, info) => {
        console.error(`[oh-my-rigel] Native V2 background handoff failed: child=${info?.sessionID ?? "unknown"}; ${error instanceof Error ? error.message : String(error)}`)
      },
    })
    // T34: one shared pending-compaction incident per session, consumed by both
    // the reactive context-limit recovery and the preemptive trigger, so a
    // session never holds two admitted `session.compact` requests at once.
    const compactionIncident = createNativeCompactionIncidentRegistry()
    const contextLimitRecovery = createNativeContextLimitRecovery({ session: context.session, incident: compactionIncident })
    const idleGate = createNativeIdleGate()
    const idleContinuations = createNativeIdleContinuations({
      session: context.session,
      backgroundManager,
      resolveAgent: sessionAgentResolver,
    })
    // T20 phase-4 parity: `stopContinuationState` now closes over the background
    // manager, so the FIRST `/stop-continuation` for a session cancels its
    // tracked queued/starting/running descendant children (without clearing the
    // parent's durable state) and writes the shared `sources.stop` marker
    // `stopped`; releasing the stop (clear) writes `idle`. The transition guard
    // lives in `createStopContinuationState`, so repeated stops and non-stopped
    // clears never re-fire. `clearAll` on dispose stays a pure in-memory release.
    let goalController
    const stopContinuationState = createStopContinuationState({
      onStop: async (sessionID) => {
        // A manual stop drops pending todo-continuation countdowns so a stopped
        // session cannot be woken by the enforcer. `onStop` fires only on the
        // not-stopped -> stopped edge.
        todoContinuation.cancelAllCountdowns()
        backgroundManager.cancelDescendants(sessionID, {
          source: "stop-continuation",
          reason: "Continuation stopped via /stop-continuation",
          skipNotification: true,
        })
        writeStopMarker(location.directory, sessionID, "stopped")
        await goalController?.clearGoal(sessionID)
      },
      onClear: (sessionID) => {
        writeStopMarker(location.directory, sessionID, "idle")
      },
    })
    // DEC-8: one dispose fan-out owns the session-scoped cleanup that the
    // `session.deleted` handler used to hand-list. Each store registers here
    // where it exists, so a new stateful surface cannot be forgotten, and a
    // throwing clear is isolated instead of aborting the rest of teardown.
    // The registry is deliberately dumb: it runs registered clears, nothing
    // else. `directoryInstructions` and `categorySkillReminder` each own a
    // per-session Map documented as cleared on session deletion, so they
    // register here; omitting them leaked one entry per deleted session for the
    // whole plugin lifetime. The raw `sessionFallback`, `categoryChildSessions`,
    // `backgroundManager` and `childSessionIDs` collections are wrapped in the
    // store shape the fan-out expects.
    const sessionState = createSessionStateRegistry()
    sessionState.registerStore(reminders)
    sessionState.registerStore(rules)
    sessionState.registerStore(writeGuard)
    sessionState.registerStore(commentChecker)
    sessionState.registerStore(webFetchGuard)
    sessionState.registerStore(directoryInstructions)
    sessionState.registerStore(categorySkillReminder)
    sessionState.registerStore({ clear: (sessionID) => { sessionFallback.delete(sessionID) } })
    sessionState.registerStore({ clear: (sessionID) => { categoryChildSessions.delete(sessionID) } })
    sessionState.registerStore({ clear: (sessionID) => { backgroundManager.clearSession(sessionID) } })
    sessionState.registerStore({ clear: (sessionID) => { childSessionIDs.delete(sessionID) } })
    sessionState.registerStore({ clear: (sessionID) => skillMcpManager.disconnectSession(sessionID) })
    sessionState.registerStore({ clear: (sessionID) => contextLimitRecovery.clear(sessionID) })
    sessionState.registerStore({ clear: (sessionID) => idleGate.clear(sessionID) })
    sessionState.registerStore({ clear: (sessionID) => idleContinuations.clear(sessionID) })
    // T17: a deleted session releases its stop-continuation flag and any
    // pending fsync window. The fsync tracker is one runtime-wide correlation
    // map keyed by call id, so `clear()` drops the pending starts and skips
    // with the session whose deletion is being fanned out.
    sessionState.registerStore({
      clear: (sessionID) => {
        stopContinuationState.clear(sessionID)
        fsyncSkipState.clear()
        // A deleted session drops both compaction snapshots too, matching
        // the V1 preserver's `session.idle` / `session.deleted` cleanup. The
        // preserver is created below; the closure reads it at dispose time.
        compactionTodoPreserver.forget?.(sessionID)
        // And its todo-continuation bookkeeping, so a deleted session cannot
        // leave a stale cooldown/stagnation state behind.
        todoContinuation.clear(sessionID)
      },
    })
    // Session/todo surface (Fase 3 T5b). V2 has no native session-todo API, so
    // the runtime owns a per-session registry over `ctx.storage`: the task tools
    // write it through `syncTodos`, and the session_* tools read real todos from
    // it. An absent storage domain degrades to no registry (readTodos undefined)
    // rather than a fabricated empty constant.
    const sessionTodoStore = context?.storage
      && typeof context.storage.get === "function"
      && typeof context.storage.set === "function"
      ? createV2SessionTodoStore({ storage: context.storage })
      : undefined
    // The companion CLI plugin cannot read this server-process store, so the
    // owner mirrors each write to a per-session pending file under the shared
    // XDG state root (V2-native equivalent of V1's continuation `todo` source).
    // The CLI reads that file for the `skipIfIncompleteTodos` gate; the store's
    // own behavior is unchanged.
    const todoBridgeStateRoot = resolveBridgeStateRoot(process.env)
    const bridgedTodoStore = wrapTodoStoreWithPending(sessionTodoStore, { stateRoot: todoBridgeStateRoot })
    const readTodos = bridgedTodoStore ? (sessionID) => bridgedTodoStore.readTodos(sessionID) : undefined
    const taskTodoSync = bridgedTodoStore ? createTaskTodoSync({ store: bridgedTodoStore }) : undefined
    // A deleted session drops its pending-todo bridge file too.
    sessionState.registerStore({ clear: (sessionID) => clearTodoPending({ stateRoot: todoBridgeStateRoot, sessionID }) })
    // The compaction todo-preserver keeps detailed todos alive across a
    // context-window compaction. It snapshots the registry before the summary
    // request (capture), restores the snapshot once the summary lands
    // (restore), and blocks a late all-Atlas-bootstrap `todowrite` from erasing
    // the restored work (beforeTodoWrite). With no storage domain the store is
    // absent; the preserver degrades to a no-op surface rather than failing.
    const compactionTodoPreserver = createNativeCompactionTodoPreserver({ store: bridgedTodoStore })
    // Todo-continuation enforcer: reads the real session todos, transcript and
    // owning agent, then injects the V1 continuation directive on an accepted
    // idle edge. Every blocker (pending/unanswered question, last-assistant
    // abort, compaction guard, skip agent, background work, manual stop) is
    // resolved from a real V2 surface, and the progress/stagnation/failure
    // bookkeeping is consumed from the state store and updated on injection.
    const getSessionMessages = typeof context?.session?.context === "function"
      ? (sessionID) => context.session.context({ sessionID })
      : undefined
    // T34: preemptive compaction (V1 `experimental.preemptive_compaction`, off by
    // default). The trigger reads the session's provider-reported token usage
    // from the transcript (`ctx.session.context`, the V1 `message.updated` info
    // equivalent), resolves the model's real context window from the V2 model
    // inventory, and asks the host to compact through `ctx.session.compact`
    // before the window overflows. A gate-off runtime never builds it, so the
    // path is a verifiable no-op.
    const modelContextLimits = new Map()
    const readModelContextLimit = async ({ providerID, modelID }) => {
      if (typeof providerID !== "string" || typeof modelID !== "string" || !providerID || !modelID) return undefined
      const key = `${providerID}/${modelID}`
      if (modelContextLimits.has(key)) return modelContextLimits.get(key)
      const models = await readAvailableModels()
      if (Array.isArray(models)) {
        for (const row of models) {
          const rowProvider = row?.providerID ?? row?.provider
          const rowModel = row?.id ?? row?.modelID
          const limit = row?.limit?.context
          if (typeof rowProvider === "string" && typeof rowModel === "string" && typeof limit === "number" && limit > 0) {
            modelContextLimits.set(`${rowProvider}/${rowModel}`, limit)
          }
        }
      }
      return modelContextLimits.get(key)
    }
    const preemptiveCompaction = nativeGates.preemptive_compaction === true
      && typeof context?.session?.compact === "function"
      && typeof getSessionMessages === "function"
      ? createNativePreemptiveCompaction({
        threshold: readNativePreemptiveThreshold(manifest) ?? PREEMPTIVE_COMPACTION_THRESHOLD,
        readUsage: async (sessionID) => readAssistantUsage(await getSessionMessages(sessionID)),
        resolveContextLimit: async ({ providerID, modelID }) => {
          try {
            const modelContextLimit = await readModelContextLimit({ providerID, modelID })
            return resolveNativeContextLimit({ providerID, modelID, modelContextLimit, env: process.env })
          } catch (error) {
            console.error(`[oh-my-rigel] Native V2 preemptive compaction limit resolution failed: ${error instanceof Error ? error.message : String(error)}`)
            return null
          }
        },
        requestCompact: ({ sessionID }) => context.session.compact({ sessionID }),
        incident: compactionIncident,
        log: (message) => console.error(message),
        onDecision: (event) => writeStateReceipt("preemptive-compaction.json", event),
      })
      : undefined
    if (preemptiveCompaction) {
      // `clear` also releases the shared incident for the session.
      sessionState.registerStore({ clear: (sessionID) => preemptiveCompaction.clear(sessionID) })
    }
    // V1's countdown existed to render a TUI toast; the headless V2 runtime has
    // no such surface, so it injects immediately by default. The countdown and
    // inFlight machinery stays owned and cancellable by the enforcer, and
    // RIGEL_TODO_CONTINUATION_COUNTDOWN_MS arms a delayed injection window.
    const configuredCountdownMs = Number(process.env.RIGEL_TODO_CONTINUATION_COUNTDOWN_MS)
    // Default-off QA seam: inert unless a control file exists under the
    // runtime's own state root. It is the only way to drive the failure/cooldown
    // gate from the lab, because the V2 host accepts an internal prompt at
    // enqueue and reports provider/model/session failures later as
    // `session.error` instead of rejecting `dispatch`.
    const todoContinuationQa = createTodoContinuationQa()
    const todoContinuation = createNativeTodoContinuationEnforcer({
      readTodos,
      getMessages: getSessionMessages,
      resolveAgent: sessionAgentResolver,
      backgroundManager,
      isContinuationStopped: (sessionID) => stopContinuationState.isStopped?.(sessionID) ?? false,
      dispatch: todoContinuationQa.wrapDispatch(({ sessionID, text }) => context.session.prompt({ sessionID, text, resume: true })),
      countdownMs: Number.isFinite(configuredCountdownMs) && configuredCountdownMs >= 0 ? configuredCountdownMs : 0,
      onError: (message) => console.error(message),
    })
    // Task 15: the monitor registry is created inside `tool.transform` (it needs
    // the V2 pty/storage/event domains) and disposed on teardown. It is `let`
    // because the transform callback runs after this declaration.
    let nativeToolRegistry
    let claudeCodeHooks
    // Tool names registered by the main tool.transform (session/look_at/monitor
    // families), captured for the max_tools total-surface cap.
    let coreFamilyToolNames = []
    // (`session.compacted`, and the streamed `session.compaction.*` /
    // `session.next.compaction.*` families). Any of them clears the
    // file-read-scoped context so the next read re-injects.
    const compactionEventTypes = new Set([
      "session.compacted",
      "session.compaction.started",
      "session.compaction.ended",
      "session.next.compaction.started",
      "session.next.compaction.ended",
    ])
    const eventSubscription = typeof context?.event?.subscribe === "function"
      ? (async () => {
        try {
          for await (const event of context.event.subscribe({ signal: abortBackgroundHandoffs.signal })) {
            const sessionID = event?.sessionID ?? event?.data?.sessionID ?? event?.data?.session?.id ?? event?.properties?.sessionID
            await claudeCodeHooks?.handleEvent?.({ ...event, sessionID })
            await contextLimitRecovery.handle({ ...event, sessionID })
            // OpenClaw outbound rides the SAME shared subscription. V2's
            // session-start and session-end raw events map to the V1 hook keys;
            // the stop edge is the normalized idle below (`session.idle` is not
            // emitted by the headless server, so it is derived from
            // `session.execution.succeeded` / `session.status`). The dispatch is
            // fire-and-forget so a slow gateway can never head-of-line block the
            // loop, and a failure is isolated here instead of aborting the
            // subscription.
            if (openclaw?.enabled && (event.type === "session.created" || event.type === "session.deleted")) {
              void openclaw.handleEvent({ ...event, sessionID }).catch((error) => {
                console.error(`[oh-my-rigel] Native V2 openclaw dispatch failed: ${error instanceof Error ? error.message : String(error)}`)
              })
            }
            // Observe abort / token-limit / unrecoverable errors, compaction
            // epochs and message activity so the continuation skip gates reflect
            // real session state instead of constants.
            todoContinuation.onEvent(event)
            // Event-driven wake retry. A parent-prompt failure leaves the wake
            // pending; the next event re-queues it, so no timer or poller is
            // needed. A no-op when nothing is pending.
            backgroundManager.retryPendingWakes()
            if (event.type === "session.deleted" && typeof sessionID === "string") {
              // DEC-8: one fan-out, so `backgroundChildren` and
              // `childSessionIDs` are cleared together with the stores and can
              // no longer be omitted from a hand-maintained list. A throwing
              // clear is isolated by the registry and never stops the rest.
              await sessionState.disposeSession(sessionID)
              noSisyphusGpt.clear(sessionID)
              // A deleted session may be a PARENT; its queued descriptors have no
              // session id, so they must be withdrawn before any creation and its
              // running children aborted.
              backgroundManager.clearParent(sessionID)
            }
            // Task 12: the keyword state follows the V1 event contract inside
            // this same loop. A real compaction flags the explicit ultrawork
            // record for restoration on the next request; deleting a session
            // clears both keyword stores. `handleEvent` ignores every other
            // type, so no second subscription is needed.
            if (typeof sessionID === "string") {
              if (event.type === "session.next.compaction.started") keywordState.markNeedsRestoration(sessionID)
              else keywordState.handleEvent({ type: event.type, sessionID })
              const idle = idleGate.accept({ ...event, sessionID })
              if (idle) {
                // The V1 "stop" wake fires on the accepted idle edge. The
                // edge is already normalized to `session.idle` by the gate, which
                // is the hook key the OpenClaw map expects.
                if (openclaw?.enabled) {
                  void openclaw.handleEvent({ ...idle, sessionID, projectPath: event.projectPath }).catch((error) => {
                    console.error(`[oh-my-rigel] Native V2 openclaw idle dispatch failed: ${error instanceof Error ? error.message : String(error)}`)
                  })
                }
                await idleContinuations.handle(idle)
                // Upstream a0b2e96c3's terminal-errored finalization is owned by
                // the `session.execution.failed` handler below (`handleChildFailure`):
                // a terminal errored child never emits an accepted idle edge
                // (V2 emits `execution.failed`, then idles the session internally
                // with no plugin-visible idle event), so there is nothing to check
                // here. Adding an errored-idle check on this edge would be a
                // fictional no-op and a latent double-finalize.
                // The todo-continuation enforcer rides the SAME accepted idle
                // edge, after the background hint. The cooldown and the rest of
                // the gate make a duplicate idle a no-op.
                const decision = await todoContinuation.handleIdle(sessionID)
                todoContinuationQa.observeAfterIdle({ sessionID, decision, state: todoContinuation.getState(sessionID) })
              }
            }
            // Once a compaction lands, restore the pre-compaction detailed
            // todos the summary dropped. Idempotent, so a repeated event (the V2
            // stream may deliver `session.compacted` and `session.compaction.ended`
            // for one compaction) is harmless.
            if (typeof sessionID === "string" && (event.type === "session.compacted" || event.type === "session.compaction.ended")) {
              try {
                await compactionTodoPreserver.restore(sessionID)
              } catch (error) {
                console.error(`[oh-my-rigel] Native V2 compaction todo restore failed: ${error instanceof Error ? error.message : String(error)}`)
              }
              // T34: a landed compaction ends its incident and re-arms the
              // preemptive trigger, and (V1 parity) arms the post-compaction
              // degradation monitor for the fresh epoch.
              preemptiveCompaction?.onCompacted(sessionID)
            }
            // Task 19: a real V2 compaction clears the file-read-scoped rule and
            // directory context, so the next read re-injects instead of relying
            // on a pre-compaction cache. A receipt records the clear observably.
            if (typeof sessionID === "string" && compactionEventTypes.has(event.type)) {
              rules.clear(sessionID)
              directoryInstructions.clear(sessionID)
              writeStateReceipt("context-cleared-on-compaction.json", { sessionID, eventType: event.type })
            }
            // Reactive fallback: a failed execution marks the last-sent model
            // failed for that session, so the next request resolves the next
            // reachable rung. Independent of the background-handoff wake.
            if (typeof sessionID === "string" && (event.type === "session.execution.failed" || event.type === "session.error")) {
              await applyReactiveFallback(sessionID)
            }
            // Task 15: a monitor's PTY exit is observed here so its record
            // transitions to `exited` without polling. The registry is created
            // later in `tool.transform`; guard for the pre-registration window.
            if (nativeToolRegistry && typeof nativeToolRegistry.handleEvent === "function") {
              await nativeToolRegistry.handleEvent(event)
            }
            // T17: flow event handlers land in this same loop. No binder
            // contributes one today, so the frozen array is empty and the loop
            // is inert; a future handler is awaited here instead of opening a
            // second subscription.
            for (const handler of flowRules.eventHandlers) {
              if (typeof handler === "function") await handler(event)
            }
            // Team event handlers (idle wake hint / member status / member
            // error / lead orphan). Empty unless the team_mode gate is on.
            for (const handler of teamEventHandlers) {
              if (typeof handler === "function") await handler(event)
            }
            // tmux visualization: pane activity, child-session spawn and cleanup.
            tmuxVizManager?.onEvent(event)
            if (event.type === "session.created") await tmuxVizManager?.onSessionCreated(event)
            if (event.type === "session.deleted" && typeof sessionID === "string") await tmuxVizManager?.onSessionDeleted({ sessionID })
            if (typeof sessionID !== "string" || !backgroundManager.has(sessionID)) continue
            if (event.type === "session.execution.failed") {
              // Upstream 8e705a122: classify the child failure before finalizing.
              // A retryable failure re-launches on the next model a connected
              // provider actually serves; an unserved chain finalizes as failed.
              const rows = await readAvailableModels()
              const modelsByProvider = rows ? {} : undefined
              for (const row of rows ?? []) {
                const providerID = row.providerID ?? row.provider
                const id = row.id ?? row.modelID
                if (typeof providerID === "string" && typeof id === "string") {
                  if (!modelsByProvider[providerID]) modelsByProvider[providerID] = []
                  modelsByProvider[providerID].push(id)
                }
              }
              await backgroundManager.handleChildFailure({
                sessionID,
                connectedProviders: modelsByProvider ? Object.keys(modelsByProvider) : undefined,
                modelsByProvider,
              })
              continue
            }
            const status = event.type === "session.execution.succeeded" ? "succeeded"
              : event.type === "session.execution.interrupted" ? "interrupted"
                : undefined
            // ENQUEUE, never await: one slow handoff must not block the next
            // event (compaction, reactive fallback, monitor) from being handled.
            if (status) backgroundManager.enqueueHandoff(sessionID, status)
          }
        } catch (error) {
          if (!abortBackgroundHandoffs.signal.aborted) {
            console.error(`[oh-my-rigel] Native V2 background event subscription failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      })()
      : undefined
    // The monitor engine runs a real V2 persistent terminal served over the
    // host HTTP API. Build the identity-gated server API and verify it once; only
    // a verified API is handed to the tool families, so a non-serve context keeps
    // today's behavior byte-identical. The probe sends nothing unless the origin
    // is this host's own server and a server credential is present (fails closed).
    // Build and verify the server transport ONLY when the monitor gate is on:
    // the persistent-terminal transport is the monitor family's only consumer,
    // so a gate-off context must not probe. A verified API is the only one
    // handed to the aggregator; an unverified or absent one leaves the monitor
    // family inert without changing any other surface.
    const serverApi = nativeGates.monitor === true
      ? createServerApi({ argv: process.argv, env: process.env, context })
      : undefined
    if (serverApi) {
      try {
        await serverApi.verifyIdentity()
      } catch (error) {
        console.error(`[oh-my-rigel] Native V2 server API identity probe failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const toolServerApi = serverApi?.available ? serverApi : undefined

    const registration = await context.tool.transform((editor) => {
      const before = editor.get?.(taskName)
      // Register the skill MCP tool before the delegation tool so a single
      // editor.add capture (used by the runtime tests) still resolves to
      // `rigel_task`. Only expose it once a skill was discovered; a host with
      // no skill MCP server has nothing for it to call.
      if (skillRegistry.skills.length > 0) {
        editor.add(createSkillMcpToolDefinition({
          manager: skillMcpManager,
          getSkills: async () => await resolveRuntimeSkills(),
        }))
      }
      editor.add({
        name: taskName,
        options: { codemode: false },
        description: createTaskPresentation(),
        input: taskInput,
        execute: async (input, toolContext) => {
          console.error(`[oh-my-rigel] Native V2 task context: name=${taskName}; setup=${Object.keys(context ?? {}).sort().join(",")}; tool=${Object.keys(toolContext ?? {}).sort().join(",")}`)
          if (isCoordinatorAgent(input.subagent_type)) {
            throw new Error(`Cannot delegate to coordinator agent "${String(input.subagent_type).trim()}" via task. Coordinator agents (prometheus) own the orchestration loop and must not be used as subagent targets - doing so creates duplicate coordinators and conflicting team state. Select a worker agent (e.g., sisyphus-junior via category, hephaestus, oracle) instead.`)
          }
          // In the V2 setup() API, the context itself is the typed service
          // surface. Tool execution receives only turn metadata, not a second
          // API client. Do not assume the V1 `context.client` shape.
          const clients = [context, context.client, toolContext?.client]
          // Cancellation runs before any skill work or spawn: a queued cancel
          // withdraws the descriptor with ZERO session.create / session.prompt.
          if (input.cancel === true && typeof input.task_id === "string" && input.task_id.trim()) {
            const target = input.task_id.trim()
            const result = backgroundManager.cancel(target)
            return {
              content: result.cancelled
                ? `Cancelled background task ${target} (mode: ${result.mode}).`
                : `No background task matched ${target} (mode: ${result.mode}).`,
              metadata: { taskId: target, cancelled: result.cancelled, mode: result.mode },
            }
          }
          const requestedSkills = Array.isArray(input.load_skills)
            ? input.load_skills.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim())
            : []
          // Inject the real skill bodies each requested name resolves to.
          // Unknown or disabled names are reported, never silently rewritten
          // into a fake "loaded" notice.
          const prompt = await applyRequestedSkills(input.prompt, requestedSkills, { resolveSkill: resolveSkillForChild })
          const isBackground = input.run_in_background === true
          const parentSessionID = toolContext?.sessionID
          if (input.task_id) {
            if (!isBackground) {
              const resumed = await resumeDelegatedSessionFromClients({ clients, sessionID: input.task_id, prompt, background: false })
              return taskResult(resumed)
            }
            const decision = backgroundManager.admit({
              parentSessionID,
              route: "resume",
              resumeSessionID: input.task_id,
              agent: { name: "resumed" },
              prompt,
              modelKey: "",
              loadSkills: requestedSkills,
            })
            if (decision.queued) return queuedTaskResult(decision, "resumed")
            if (!decision.admitted) {
              throw new Error(`A background task requires a parent session; none was available (${decision.reason ?? "unknown"}).`)
            }
            const started = await decision.ready
            if (!started?.sessionID) {
              throw new Error("The background child was admitted but did not start.")
            }
            return taskResult({ sessionID: started.sessionID, agent: "resumed", background: true, taskId: decision.taskId })
          }
          const agents = await listCallableAgentsFromClients(clients, location)
          const category = input.category
            ? await resolveCategoryFromClients(clients, location, input.category, { userCategories })
            : undefined
          const agent = category
            ? resolveNamedAgent(agents, "Sisyphus-Junior")
            : resolveNamedAgent(agents, input.subagent_type)
          const effectivePrompt = category ? categoryTaskPrompt(prompt, category) : prompt
          if (!isBackground) {
            const delegated = await delegateNamedAgentFromClients({
              clients,
              location,
              agent,
              prompt: effectivePrompt,
              background: false,
              model: await resolveDelegationModel(category, agent),
              parentSessionID,
              onChildSession: (sessionID, child) => {
                childSessionIDs.add(sessionID)
                if (category) {
                  categoryChildSessions.set(sessionID, {
                    name: category.name,
                    explicit: category.explicit,
                    chain: category.fallbackChain,
                  })
                }
                seedChildFallback(sessionID, child)
              },
            })
            return taskResult(delegated)
          }
          // Background: admit BEFORE any create/prompt. A queued request keeps an
          // executable descriptor and starts NOTHING until a slot frees.
          const decision = backgroundManager.admit({
            parentSessionID,
            route: category ? "category" : "subagent",
            agent,
            category,
            subagentType: input.subagent_type,
            model: await resolveDelegationModel(category, agent),
            modelKey: preSpawnModelKey(category, agent, agentOverrides),
            prompt: effectivePrompt,
            loadSkills: requestedSkills,
          })
          if (decision.queued) return queuedTaskResult(decision, agent.name)
          if (!decision.admitted) {
            throw new Error(`A background task requires a parent session; none was available (${decision.reason ?? "unknown"}).`)
          }
          const started = await decision.ready
          if (!started?.sessionID) {
            throw new Error("The background child was admitted but did not start.")
          }
          return taskResult({ sessionID: started.sessionID, agent: agent.name, background: true, taskId: decision.taskId })
        },
      })
      if (process.env.RIGEL_NATIVE_ASSERT_TOOL_REGISTRATION === "1") {
        const after = editor.get?.(taskName)
        console.error(`[oh-my-rigel] Native V2 task registration probe: name=${taskName}; editor=${Object.keys(editor ?? {}).sort().join(",")}; before=${Boolean(before)}; after=${Boolean(after)}`)
      }
      // Task 15: register the session, look_at, and (gate-permitting) monitor
      // families through the F2 aggregator. The aggregator reads the manifest's
      // materialized gates via the config adapter, so a disabled family adds no
      // tool name to the editor.
      const families = createNativeToolFamilies({
        clients: [context, context.client],
        location,
        manifest,
        context,
        pluginConfig: context?.config,
        // The per-session todo registry this runtime owns (Fase 3 T5b). Without
        // it `session_info`/`session_read` can only report an empty list while
        // the task tools silently wrote nothing a session could read back.
        readTodos,
        // Only a verified server API reaches the aggregator, which hands it
        // to the monitor terminal port and nothing else. Undefined when the host
        // exposes no verified loopback server, so the monitor family stays inert.
        serverApi: toolServerApi,
      })
      nativeToolRegistry = families.registry
      coreFamilyToolNames = Object.keys(families.tools)
      for (const [name, definition] of Object.entries(families.tools)) {
        // Every family tool returns a V1-style value (the monitor and session
        // tools return strings). The V2 host requires a result object, so the
        // family tools go through the same registration-seam normalizer the
        // conditional tools and `hashline_edit` use; without it a string return
        // crashes the host (`"output" in s` on a primitive).
        editor.add({ name, options: { codemode: false }, ...normalizeToolDefinition(definition) })
      }
      if (hashlineEditTool) {
        editor.add({ name: "hashline_edit", options: { codemode: false }, ...normalizeToolDefinition(hashlineEditTool) })
      }
      // Register the working `todo-description-override`
      // `todowrite` tool whose description is the exact V1 TODOWRITE_DESCRIPTION,
      // so the model receives the V1 todo-format contract in its tool schema. This
      // is the V2 equivalent of V1's `tool.definition` rewrite; the override is
      // applied at definition-build (only to definitions the runtime owns) and the
      // tool is backed by the runtime's own per-session todo store. Registered in
      // this single transform callback so it lands in the same tool set as the
      // others, and it never mutates a host-owned tool.
      registerNativeTodoTool(editor, {
        store: bridgedTodoStore,
        // The same preserver that restored the snapshot also guards the
        // next `todowrite`, so a late all-bootstrap write cannot erase the
        // restored detailed todos.
        beforeWrite: (sessionID, todos) => compactionTodoPreserver.beforeTodoWrite(sessionID, todos),
      })
      // slashcommand (Ola 6): the model-facing command discovery. V2 owns the
      // command catalog, so the native tool reads ctx.command.list() instead of
      // walking project directories like V1.
      if (typeof context?.command?.list === "function") {
        editor.add(createSlashcommandTool({ listCommands: () => context.command.list() }))
      }
      // V1-parity `glob`/`grep`. The host builtins diverge from the V1 owner
      // contract (`packages/omo-opencode/src/tools/{glob,grep}`): hidden default,
      // follow and depth, output modes, per-file limits and the result format all
      // differ. The runtime registers native ports under the same names, so a
      // later registration overrides the host tool with V1-exact behavior for the
      // same observable call, with no extra options required from the model.
      for (const definition of createGlobGrepTools({ directory: location.directory })) {
        editor.add(definition)
      }
    })
    // Ordered rule chains for the two V2 tool hooks. Each built-in rule keeps
    // the exact position it had as an inline await, and the flow binders
    // (T13/T14) are appended after every built-in rule. The declared order is
    // frozen in `rigel-v2-native-flow-rules.mjs`: guards then the fsync start
    // rule on the before chain, and the delegate-retry then fsync warning rules
    // on the after chain. `runOrderedRules` isolates a throwing rule: the
    // failure is recorded and reported by `reportRuleFailure`, and every rule
    // after it still runs.
    const nativeAfterRules = [
      { name: "hashline-read-enhancer", run: (event) => hashline?.after(event) },
      { name: "tool-result-reminders", run: (event) => reminders.after(event) },
      { name: "category-skill-reminder", run: (event) => categorySkillReminder.after(event) },
      { name: "recovery-reminder", run: (event) => applyNativeRecoveryReminder(event) },
      { name: "rules-injector", run: (event) => rules.after(event) },
      { name: "comment-checker", run: (event) => commentChecker.after(event) },
      { name: "plan-format-validator", run: (event) => planFormatValidator.after(event) },
      { name: "webfetch-redirect-guard", run: (event) => webFetchGuard.after(event) },
      ...flowRules.afterRules,
    ]
    const nativeBeforeRules = [
      { name: "prometheus-md-only", run: (event) => prometheusMdOnly.before(event) },
      { name: "write-existing-file-guard", run: (event) => writeGuard.before(event) },
      { name: "comment-checker", run: (event) => commentChecker.before(event) },
      { name: "webfetch-redirect-guard", run: (event) => webFetchGuard.before(event) },
      ...createNativeToolBeforeRules({ backgroundManager }),
      ...flowRules.beforeRules,
      ...(teamGatingRule ? [teamGatingRule] : []),
    ]
    const directoryReadRegistration = typeof context?.tool?.hook === "function"
      ? await context.tool.hook("execute.after", async (input) => {
        directoryInstructions.after(input)
      })
      : undefined
    const remindersRegistration = typeof context?.tool?.hook === "function"
      ? await context.tool.hook("execute.after", async (input) => {
        return runOrderedRules(nativeAfterRules, input, { onError: (failure) => reportRuleFailure("execute.after", failure) })
      })
      : undefined
    const writeGuardRegistration = typeof context?.tool?.hook === "function"
      ? await context.tool.hook("execute.before", async (input) => {
        return runOrderedRules(nativeBeforeRules, input, { onError: (failure) => reportRuleFailure("execute.before", failure) })
      })
      : undefined
    const nonInteractiveRegistration = typeof context?.tool?.hook === "function"
      ? await context.tool.hook("execute.before", async (input) => nonInteractiveEnv.before(input))
      : undefined
    // One tool-name permission gate: global `config.tools` gates first, then the
    // per-agent gates collected above, so the last matching gate wins. Deny and
    // ask throw here, before V2 invokes the tool executor.
    const permissionRegistration = typeof context?.tool?.hook === "function"
      ? await context.tool.hook("execute.before", async (input) => permissionWiring.before(input))
      : undefined
    const nativeContextPipeline = createNativeContextHook({
      // Read on every provider request. This uses exactly the inventory that
      // task() resolves at execution time, not a startup-time copy.
      getDelegationRoster: () => listCallableAgentsFromClients(
        [context, context?.client],
        context.location,
      ),
      categories: buildCategoryRoster(userCategories),
      resolveModel: resolveNativeModel,
      getAgentRequestBody: (agent) => agentRequestBodies.get(String(agent ?? "").toLocaleLowerCase()),
      // Mirror the V1 `disabled_hooks` gate for think-mode (default on).
      thinkModeEnabled: !readNativeDisabled(manifest).hooks.includes("think-mode"),
      onAgentTuningApplied: (event) => {
        recordAgentTuning(event)
      },
      ultraworkPrompt,
      ultraworkPrompts,
      keywordMessages,
      keywordState,
      disabledKeywords: keywordConfig.disabledKeywords,
      enabledExpansions: keywordConfig.enabledExpansions,
      defaultUltrawork: manifest.modes?.defaultUltrawork === true,
      getInitialDirectoryInstructions: ({ agent }) => /\bhephaestus\b/i.test(String(agent ?? ""))
        ? directoryInstructions.rootAgentsGuidance()
        : "",
      // Every child created through this runtime is marked before prompting.
      // The active callable roster is a second guard: a subagent request is
      // never allowed to receive the parent's delegation menu.
      isRootSession: (input, agents) => !childSessionIDs.has(input.sessionID)
        && !agents.some((agent) => agent.name.toLocaleLowerCase() === String(input.agent ?? "").toLocaleLowerCase()),
      getCategorySkillReminder: (sessionID) => (sessionID ? categorySkillReminder.pending(sessionID) : ""),
      onCategorySkillReminderConsumed: (sessionID) => { categorySkillReminder.consume(sessionID) },
      // T28: reconcile the Sisyphus prompt for the runtime model on the context
      // hook. The plan is materialized by the generator; the receipt makes a
      // swap (or an un-baked model) observable instead of silent.
      sisyphusPromptPlan: readSisyphusPromptPlan(manifest),
      onSisyphusReconcile: (event) => writeStateReceipt(SISYPHUS_PROMPT_RECEIPT, event),
      // The update notice is injected into `event.system` on the root
      // session only, after the roster, so it never reaches a delegated child.
      getUpdateNotice: () => updateChecker.getNotice(),
    })
    const contextCollector = createNativeContextCollector()
    const consumePendingContext = createNativeContextMessageConsumer(contextCollector)
    claudeCodeHooks = createNativeClaudeCodeHooks({ context, collector: contextCollector, directory: location.directory })
    const disposeClaudeCodeHooks = await claudeCodeHooks.install()
    const nativeModelRequestPipeline = createNativeModelRequestHook({
      resolveModel: resolveNativeModel,
      getHeaders: (event) => {
        const message = event?.message
        const text = typeof message?.text === "string"
          ? message.text
          : (typeof message?.content === "string" ? message.content : "")
        return message?.role === "user" && text.includes(OMO_INTERNAL_INITIATOR_MARKER)
          ? { "x-initiator": "agent" }
          : undefined
      },
    })
    // Prompt admission owns embedded slash-command expansion. Top-level slash
    // commands are expanded by the host before this hook is needed.
    const autoSlashCommand = createNativeAutoSlashCommandHook({
      skills: skillRegistry.skills,
      listCommands: () => context?.command?.list?.(),
    })
    const autoSlashCommandRegistration = typeof context?.session?.hook === "function"
      ? await context.session.hook("prompt", async (event) => {
        try {
          applyPromptAdmission(event, stopContinuationState)
          await autoSlashCommand.before(event)
          // Upstream 5fd04b590: this boundary runs BEFORE the turn's request is
          // built, so a Sisyphus session on an unsupported GPT model is switched
          // to Hephaestus for THIS turn (the provider payload uses Hephaestus).
          await noSisyphusGpt.handlePrompt(event?.sessionID)
        } catch (error) {
          console.error(`[oh-my-rigel] Native V2 prompt hook failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
      : undefined
    // The monitor-status injector consumes the registry built inside
    // `tool.transform` (hence the getter, read at event time, never captured by
    // value). It is created only under the `monitor.enabled` gate, so a gate-off
    // runtime never touches the hook; it also no-ops on an undefined registry
    // (gate off or no verified server).
    const monitorStatusInjector = nativeGates.monitor === true
      ? createNativeMonitorStatusInjector({ getRegistry: () => nativeToolRegistry })
      : undefined
    // V1 `features/btw-side`: a side session carries the `omo_btw_side` metadata
    // and this injector adds its bounded parent context to the outgoing request.
    // A session without the metadata is left byte-identical. It is composed into
    // the main context hook (below) so the runtime keeps ONE `context`
    // registration, which the model-visible context seam owns.
    const btwContextInjector = createBtwContextInjector({
      readSession: async (sessionID) => {
        if (typeof context?.session?.get === "function") {
          const result = await context.session.get({ sessionID })
          return result?.data ?? result
        }
        return undefined
      },
      readParentMessages: async (parentSessionID) => {
        if (typeof context?.session?.context === "function") {
          return await context.session.context({ sessionID: parentSessionID })
        }
        return []
      },
      writeReceipt: (receipt) => writeBtwInjectionReceipt(
        resolveBtwReceiptPath(),
        receipt,
        (entry) => console.error(`[oh-my-rigel] btw-context ${JSON.stringify(entry)}`),
      ),
      log: (entry) => console.error(`[oh-my-rigel] btw-context ${JSON.stringify(entry)}`),
    })
    const contextRegistration = await context.session.hook("context", async (event) => {
      // T27: tool-pair validation and assistant-prefill tail repair on the
      // model-visible messages. Reasoning is owned by the V2 provider transform
      // (the V1 thinking-block hook was removed); a valid history is left
      // byte-identical. A repair is reported observably (counts only, no message
      // content) instead of being silently ignored.
      const repair = validateAndRepairMessages(event.messages, { model: event?.model })
      if (repair.toolPairs.length > 0 || repair.prefill) {
        // Observable, counts only (no message content): a log line plus a durable
        // state receipt, so a repair is never silently ignored.
        console.error(`[oh-my-rigel] native context message repair: toolPairs=${repair.toolPairs.length} prefill=${repair.prefill ? 1 : 0}`)
        writeStateReceipt("message-repair.json", { sessionID: event?.sessionID, toolPairs: repair.toolPairs.length, prefill: repair.prefill })
      }
      await consumePendingContext(event)
      await nativeContextPipeline(event)
      await teamMailboxInjector?.(event)
      await teamStatusInjector?.(event)
      await monitorStatusInjector?.(event)
      // V1 `features/btw-side`: bounded parent-context injection for a side
      // session; a no-op for any session without the btw metadata.
      await btwContextInjector(event)
      // T34: observe the outgoing agent-loop request for the preemptive
      // threshold. Isolated so a trigger failure never tears down the hook.
      if (preemptiveCompaction) {
        try {
          await preemptiveCompaction.observe({ sessionID: event?.sessionID, model: event?.model })
        } catch (error) {
          console.error(`[oh-my-rigel] Native V2 preemptive compaction observe failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })
    const modelRequestRegistration = await context.session.hook("model.request", nativeModelRequestPipeline)
    // T21: the compaction context rides on the summary request. The live
    // experiment proved `event.messages` mutations in the `compaction` hook DO
    // reach the provider (marked block captured in the outgoing summary body),
    // so the V1 `output.context` effect is carried by this hook. Content must
    // be V2 message parts; a string content crashes
    // `SessionCompaction.compact` in `SessionModelRequest.prepare`.
    const nativeCompactionContextHook = createNativeCompactionContextHook({
      getHistory: (sessionID) => {
        try {
          return backgroundManager.formatForCompaction(sessionID)
        } catch (error) {
          console.error(`[oh-my-rigel] Native V2 compaction history read failed: ${error instanceof Error ? error.message : String(error)}`)
          return undefined
        }
      },
      // Carry the still-incomplete todos into the compaction summary so the
      // post-compaction session is oriented without a restart. The store owns a
      // tolerant read; a read failure degrades to an empty list rather than
      // dropping the whole context block.
      getTodos: async (sessionID) => {
        try {
          return readTodos ? await readTodos(sessionID) : []
        } catch (error) {
          console.error(`[oh-my-rigel] Native V2 compaction todo read failed: ${error instanceof Error ? error.message : String(error)}`)
          return []
        }
      },
    })
    const compactionContextRegistration = typeof context?.session?.hook === "function"
      ? await context.session.hook("compaction", async (event) => {
        // Snapshot the detailed todos BEFORE the summary request runs, so a
        // compaction that comes back empty (or with only the two Atlas bootstrap
        // entries) can be repaired by the post-compaction restore. Then inject
        // the compaction context exactly as before.
        if (typeof event?.sessionID === "string") {
          try {
            await compactionTodoPreserver.capture(event.sessionID)
          } catch (error) {
            console.error(`[oh-my-rigel] Native V2 compaction todo capture failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        return nativeCompactionContextHook(event)
      })
      : undefined
    // Native HTTP is reserved for the image transport mutation. Context,
    // admission, semantic options, headers, and fallback all use V2 hooks.
    const imageRequestRegistration = await context.session.hook("http.request", async (input) => {
      let body
      try { body = await input.request.clone().json() } catch { return }
      const shape = resolveRequestShape(body)
      if (shape) {
        // T21 refinement: the V2 event stream is volatile by contract (a slow
        // consumer overflows and events during disconnection are missed), so
        // the keyword restoration flag gets a redundant trigger from the
        // summary request itself. Non-compaction requests never mark anything.
        if (typeof input.sessionID === "string") {
          try {
            if (isCompactionSummaryRequest({ body, kind: input.kind })) keywordState.markNeedsRestoration(input.sessionID)
          } catch (error) {
            console.error(`[oh-my-rigel] Native V2 compaction restoration trigger failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        await runRequestSteps({
          body,
          shape,
          sessionID: input.sessionID,
          input,
          onError: (failure) => reportRuleFailure("http.request", failure),
        }, flowRules.requestSteps)
        input.request = new Request(input.request, { body: JSON.stringify(body) })
      }
    })
    console.error(`[oh-my-rigel] Native OpenCode V2 runtime active: named delegation enabled; registeredAgents=${registeredAgents.join(",")}; agentDomain=${Object.keys(context.agent ?? {}).sort().join(",")}; sessionDomain=${Object.keys(context.session ?? {}).sort().join(",")}`)
    // Conditional native tool families (interactive_bash / task_* / goal_*).
    // Gates come from the materialized manifest; a disabled family is never
    // registered.
    // max_tools trimming: the names the core transform registered (session/look_at/
    // monitor families, rigel_task, skill_mcp, hashline_edit, todowrite) count
    // toward the cap, so the conditional families trim against the real total.
    const coreToolNames = [
      ...(skillRegistry.skills.length > 0 ? ["skill_mcp"] : []),
      taskName,
      ...(hashlineEditTool ? ["hashline_edit"] : []),
      "todowrite",
      ...(typeof context?.command?.list === "function" ? ["slashcommand"] : []),
      ...coreFamilyToolNames,
    ]
    const conditionalTools = await registerConditionalNativeTools({
      context,
      manifest,
      directory: location.directory,
      // The task tools mirror every write into the same per-session registry the
      // session tools read, so a created/updated task becomes a visible todo.
      syncTodos: taskTodoSync?.syncTodos,
      maxTools: readNativeMaxTools(manifest),
      existingToolNames: coreToolNames,
      teamScopeRegistry,
    })
    goalController = conditionalTools.goalController
    let goalCommandRegistration
    if (goalController && typeof context?.command?.transform === "function") {
      goalCommandRegistration = await context.command.transform((editor) => editor.add({
        name: "goal",
        description: "Set, pause, resume, clear, or show the current session goal.",
        execute: async ({ sessionID, prompt, delivery }) => {
          void delivery
          if (typeof sessionID !== "string" || !sessionID) return formatGoalResponse(null)
          // The V2 command executor receives a PromptInput object, not a raw
          // string; the slash-command arguments live on `text`.
          const goalText = typeof prompt === "string" ? prompt : prompt?.text ?? ""
          const parsed = parseGoalCommand(goalText)
          switch (parsed.kind) {
            case "setObjective":
              return formatGoalResponse(await goalController.setGoal(sessionID, parsed.objective))
            case "setStatus":
              return formatGoalResponse(parsed.status === "paused"
                ? await goalController.pauseGoal(sessionID)
                : await goalController.resumeGoal(sessionID))
            case "clear":
              await goalController.clearGoal(sessionID)
              return formatGoalResponse(null)
            case "show":
              return formatGoalResponse(await goalController.getGoal(sessionID))
          }
        },
      }))
    }
    let ulwExecuteCommandRegistration
    if (typeof context?.command?.transform === "function") {
      ulwExecuteCommandRegistration = await context.command.transform((editor) => editor.add(
        createUlwExecuteCommand({
          context,
          directory: location.directory,
          registeredAgents,
          stopContinuationState,
        }),
      ))
    }
    // T35: the remaining V1 builtin commands (refactor, remove-ai-slops,
    // handoff, hyperplan). Their V1 `<command-instruction>` bodies are generated
    // from the owner into a manifest and delivered into the session turn by the
    // command executor. `goal` and `ulw-execute` are registered above and
    // `stop-continuation` is owned by the prompt seam, so they are not repeated
    // here. `disabled_commands` is honored from the materialized manifest.
    let builtinCommandsRegistration
    if (typeof context?.command?.transform === "function") {
      builtinCommandsRegistration = await registerBuiltinCommands({
        context,
        teamModeEnabled: nativeGates.team_mode === true,
        disabledCommands: readNativeDisabled(manifest).commands,
      })
    }
    // The V1 `cli/mcp-oauth` effect as a native command. The interactive
    // login reuses the skill-MCP OAuth provider and localhost callback and
    // persists through `ctx.storage`; the command is gated by the same
    // `disabled_commands` denylist as the other native commands.
    let mcpOAuthCommandRegistration
    if (typeof context?.command?.transform === "function") {
      mcpOAuthCommandRegistration = await registerMcpOAuthCommand({
        context,
        storage: context?.storage,
        disabledCommands: readNativeDisabled(manifest).commands,
      })
    }
    // The `/rmo-models` guided command: inspect and change the per-agent model
    // configuration in `~/.omo/omo.jsonc`. Additive and non-destructive: it only
    // injects a guided turn and never restarts, stops, or kills the server or the
    // active session. Gated by the same `disabled_commands` denylist.
    let modelsCommandRegistration
    if (typeof context?.command?.transform === "function") {
      modelsCommandRegistration = await registerModelsCommand({
        context,
        disabledCommands: readNativeDisabled(manifest).commands,
      })
    }
    // Reconcile durable background state from a previous process: re-admit
    // queued descriptors (they never started), re-track running children WITHOUT
    // re-creating them, and re-queue undelivered wakes. A fresh manager (tests,
    // no directory) has no state files and this is a no-op.
    try {
      await backgroundManager.restore({
        // Reconcile the `starting` crash window: a child created but not yet
        // persisted as running carries the taskId nonce in its first prompt, so
        // it can be found and bound WITHOUT re-creating it. If no child exists,
        // restore re-admits the descriptor once.
        findStartedChild: async (task) => {
          if (typeof context?.session?.list !== "function" || typeof context?.session?.context !== "function") return undefined
          try {
            const list = await context.session.list({ parentID: task.parentSessionID })
            const sessions = Array.isArray(list?.data) ? list.data : Array.isArray(list) ? list : []
            for (const session of sessions) {
              const sessionID = session?.id ?? session?.sessionID
              if (typeof sessionID !== "string" || sessionID.length === 0) continue
              const transcript = await context.session.context({ sessionID })
              if (JSON.stringify(transcript).includes(`<rigel-task-id>${task.taskId}</rigel-task-id>`)) return { sessionID }
            }
          } catch {
            return undefined
          }
          return undefined
        },
      })
    } catch (error) {
      console.error(`[oh-my-rigel] Native V2 background restore failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return async () => {
      abortBackgroundHandoffs.abort()
      // The abort signal disposes the background manager; call it explicitly so
      // teardown does not depend on the listener side effect.
      await backgroundManager.dispose()
      // Stop the OpenClaw reply listener so no poll or request outlives the
      // plugin. A no-op when the surface was disabled or never started.
      await openclaw.dispose()
      directoryInstructions.clearAll()
      categorySkillReminder.clearAll()
      keywordState.clearAll()
      // T17: release both flow states. `clearAll` drops every stopped session
      // and `clear()` empties the fsync tracker's start map and skip window.
      stopContinuationState.clearAll()
      fsyncSkipState.clear()
      // DEC-8: the registry owns every store registered at setup, so teardown
      // cannot miss one. Stores with `clearAll` are cleared once; clear-only
      // stores are cleared for every session the registry saw (via
      // session.deleted or an explicit register).
      await sessionState.clearAll()
      await skillMcpManager.disconnectAll()
      // Stop any live monitor PTY before the plugin tears down, so no watcher
      // process outlives the session.
      if (typeof nativeToolRegistry?.shutdown === "function") {
        try { await nativeToolRegistry.shutdown() } catch (error) {
          console.error(`[oh-my-rigel] Native V2 monitor shutdown failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      await conditionalTools?.dispose?.()
      await goalCommandRegistration?.dispose?.()
      await ulwExecuteCommandRegistration?.dispose?.()
      await builtinCommandsRegistration?.dispose?.()
      await mcpOAuthCommandRegistration?.dispose?.()
      await modelsCommandRegistration?.dispose?.()
      autoSlashCommand.clear()
      disposeClaudeCodeHooks()
      await Promise.all([registration?.dispose?.(), directoryReadRegistration?.dispose?.(), remindersRegistration?.dispose?.(), writeGuardRegistration?.dispose?.(), nonInteractiveRegistration?.dispose?.(), permissionRegistration?.dispose?.(), autoSlashCommandRegistration?.dispose?.(), contextRegistration?.dispose?.(), modelRequestRegistration?.dispose?.(), compactionContextRegistration?.dispose?.(), imageRequestRegistration?.dispose?.(), skillRegistry?.dispose?.(), skillMcpRegistration?.dispose?.(), builtinMcpRegistration?.dispose?.(), claudeMcpRegistration?.dispose?.(), eventSubscription, tmuxVizManager?.cleanup?.()])
    }
  },
}
