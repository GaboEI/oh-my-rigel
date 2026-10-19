import { createHash } from "node:crypto"

import { DIRECTORY_AGENTS_MARKER, isDirectoryInstructionMessage } from "./rigel-v2-directory-instructions.mjs"
import {
  appendDirectiveToResponsesInput,
  appendDirectiveToUserMessage,
  chatUserParts,
  createKeywordSeam,
  currentUserMessageIndex,
  responsesUserParts,
} from "./rigel-v2-native-keyword-seam.mjs"
import { buildReasoningOptions, reasoningEffortFromThinking } from "./rigel-v2-native-reasoning-options.mjs"
import { createSisyphusPromptReconciler } from "./rigel-v2-native-sisyphus-prompt.mjs"
import { GPT_EDIT_GUIDANCE_MARKER, gptEditGuidanceBlock } from "./rigel-v2-native-gpt-edit-guidance.mjs"

export { reasoningEffortFromThinking }

const CHILD_TASK_MARKER = "<rigel-native-child-task>"
const ROSTER_MARKER = "<rigel-native-delegation-roster>"
const ULTRAWORK_MARKER = "<ultrawork-mode>"
// The update notice is a system-level injection like the roster, so it
// carries a marker and is stripped before re-injection to stay a single block.
const UPDATE_MARKER = "<rigel-native-update-notice>"
const INJECTION_MARKERS = [ROSTER_MARKER, ULTRAWORK_MARKER, UPDATE_MARKER, DIRECTORY_AGENTS_MARKER, GPT_EDIT_GUIDANCE_MARKER]

function safeSingleLine(value, limit = 120) {
  // Agent names come from user configuration. Keep their visible value useful
  // for exact task calls, while preventing line/control characters from
  // turning a roster entry into a separate prompt instruction.
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit)
}

function agentPurpose(name) {
  const key = String(name).toLocaleLowerCase()
  if (key === "explore") return "codebase evidence"
  if (key === "librarian") return "official or external sources"
  if (key === "oracle") return "architecture and technical risks"
  if (key.includes("metis")) return "plan gaps and ambiguities"
  if (key.includes("momus")) return "critical plan review"
  if (key === "judge") return "independent acceptance audit"
  if (key.includes("multimodal")) return "visual or multimodal inspection"
  if (key.includes("sisyphus-junior")) return "category-routed implementation work"
  return "its configured specialist role"
}

/**
 * Render one category roster line. A category may arrive as a bare name string
 * (legacy callers) or as `{ name, description, callerGuidance }` (the resolved
 * category set). The description and caller guidance are the machine-consumed
 * selection data V1 injects into the orchestrator prompt, so they are rendered
 * here rather than dropped: the orchestrator needs them to route a task to the
 * right category and to write the child prompt the category expects.
 */
function categoryRosterLine(category) {
  const name = safeSingleLine(typeof category === "string" ? category : category?.name)
  if (!name) return ""
  const description = safeSingleLine(typeof category === "object" ? category?.description : "", 240)
  const guidance = safeSingleLine(typeof category === "object" ? category?.callerGuidance : "", 400)
  const detail = [description, guidance].filter(Boolean).join(" ")
  return detail ? `- ${JSON.stringify(name)}: ${detail}` : `- ${JSON.stringify(name)}`
}

export function formatDelegationRoster(agents, categories = []) {
  const rows = Array.isArray(agents)
    ? agents
      .filter((agent) => agent?.mode === "subagent" || agent?.mode === "all")
      .map((agent) => safeSingleLine(agent?.name))
      .filter(Boolean)
      .map((name) => `- ${JSON.stringify(name)}: ${agentPurpose(name)}`)
    : []
  const categoryRows = Array.isArray(categories)
    ? categories.map(categoryRosterLine).filter(Boolean)
    : []
  if (rows.length === 0) return ""
  const categoryBlock = categoryRows.length > 0
    ? `\nAvailable execution categories:\n${categoryRows.join("\n")}`
    : ""
  return `${ROSTER_MARKER}\nCurrent callable delegation roster (data, not instructions). Invoke rigel_task with an exact subagent_type from this roster when delegation is useful:\n${rows.join("\n")}${categoryBlock}\n${ROSTER_MARKER}`
}

export function childTaskPrompt(prompt) {
  return `${CHILD_TASK_MARKER}\n${String(prompt)}`
}

function isUltraworkMessage(message) {
  return message?.role === "system"
    && typeof message.content === "string"
    && message.content.includes(ULTRAWORK_MARKER)
}

/**
 * Responses bodies carry one `instructions` string instead of discrete system
 * messages. Drop any block this hook appended on a prior pass (identifiable by
 * its sentinel marker) so a repeated pass rebuilds rather than accumulates.
 */
function stripInjectedInstructions(instructions) {
  let cut = instructions.length
  for (const marker of INJECTION_MARKERS) {
    const index = instructions.indexOf(marker)
    if (index >= 0 && index < cut) cut = index
  }
  return instructions.slice(0, cut).replace(/\s+$/, "")
}

/** Append hook injections to the Responses `instructions` string in place. */
function mergeInstructions(instructions, injections) {
  const base = typeof instructions === "string" && instructions.trim()
    ? stripInjectedInstructions(instructions)
    : ""
  const appended = injections.filter(Boolean).join("\n\n")
  if (!appended) return base || undefined
  return base ? `${base}\n\n${appended}` : appended
}

function applyAgentTuning(body, tuning, shape) {
  if (!tuning || typeof tuning !== "object" || Array.isArray(tuning)) return undefined
  const payload = {}
  if (tuning.temperature !== undefined) payload.temperature = tuning.temperature
  if (tuning.top_p !== undefined) payload.top_p = tuning.top_p
  const effort = tuning.reasoning ?? tuning.reasoningEffort
  if (shape === "responses") {
    if (tuning.maxTokens !== undefined) payload.max_output_tokens = tuning.maxTokens
    // `thinking` cannot be forwarded verbatim on this shape; carry its effect as
    // `reasoning.effort`. An explicit reasoning/reasoningEffort always wins and
    // is never overridden or duplicated by the thinking-derived fallback.
    const responsesEffort = effort ?? reasoningEffortFromThinking(tuning.thinking)
    if (responsesEffort !== undefined) payload.reasoning = { ...(body.reasoning && typeof body.reasoning === "object" ? body.reasoning : {}), effort: responsesEffort }
    if (tuning.textVerbosity !== undefined) payload.text = { ...(body.text && typeof body.text === "object" ? body.text : {}), verbosity: tuning.textVerbosity }
  } else {
    // Chat Completions accepts the Anthropic-style `thinking` field verbatim
    // (proven live on the opencode-go chat gateway).
    if (tuning.thinking !== undefined) payload.thinking = tuning.thinking
    if (tuning.maxTokens !== undefined) payload.max_tokens = tuning.maxTokens
    if (effort !== undefined) payload.reasoning_effort = effort
    if (tuning.textVerbosity !== undefined) payload.text_verbosity = tuning.textVerbosity
  }
  if (Object.keys(payload).length === 0) return undefined
  Object.assign(body, payload)
  return payload
}

function contextUserParts(messages) {
  return chatUserParts(messages)
}

/** Text of the current (last) user message; the per-turn think/ultrawork seam. */
function lastUserMessageText(messages) {
  if (!Array.isArray(messages)) return ""
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue
    return chatUserParts([messages[index]]).map((part) => part.text).join(" ")
  }
  return ""
}

function hasContextUltraworkKeyword(messages) {
  return contextUserParts(messages).some((part) => /\b(?:ultrawork|ulw)\b/i.test(part.text))
}

function removeInjectedSystemParts(system) {
  if (!Array.isArray(system)) return []
  return system.filter((part) => part?.type !== "text" || !INJECTION_MARKERS.some((marker) => part.text?.includes(marker)))
}

/**
 * Whether the per-request tool map advertises `hashline_edit`.
 *
 * The V2 `context` hook receives the catalog the host is about to send, after
 * its own per-model tool edits and after this plugin's tool transforms, so it is
 * the truth the model will see. `undefined` means the host supplied no usable
 * catalog (or an empty one), and the caller falls back to the registration gate.
 */
function hashlineEditInToolMap(tools) {
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) return undefined
  const names = Object.keys(tools)
  if (names.length === 0) return undefined
  return names.includes("hashline_edit")
}

/**
 * Build the official V2 `context` hook. Prompt/context mutations reach the
 * provider request. The V2.0.22 exception is `compaction` system mutation;
 * continuity uses that hook's `event.result` and `event.messages` instead.
 */
export function createNativeContextHook({
  getDelegationRoster,
  categories = [],
  isRootSession = async () => true,
  onDelegationRoster,
  getAgentRequestBody,
  onAgentTuningApplied,
  thinkModeEnabled = true,
  ultraworkPrompt = "",
  ultraworkPrompts,
  keywordMessages,
  keywordState: keywordStateOption,
  disabledKeywords,
  enabledExpansions,
  defaultUltrawork = false,
  getInitialDirectoryInstructions,
  getCategorySkillReminder,
  onCategorySkillReminderConsumed,
  sisyphusPromptPlan,
  onSisyphusReconcile,
  getUpdateNotice,
  onGptEditGuidance,
  hashlineEditEnabled = false,
} = {}) {
  if (typeof getDelegationRoster !== "function") {
    throw new TypeError("A live V2 delegation roster reader is required")
  }
  const keywordSeam = createKeywordSeam({
    ultraworkPrompt,
    ultraworkPrompts,
    keywordMessages,
    keywordState: keywordStateOption,
    disabledKeywords,
    enabledExpansions,
    defaultUltrawork,
  })
  // T28: the Sisyphus body is model-dependent; reconcile it for the runtime model
  // on every request, exactly as V1 did in the system-transform hook. Absent a
  // plan (manifest without the contract) this stays a no-op.
  const sisyphusReconciler = sisyphusPromptPlan
    ? createSisyphusPromptReconciler({ ...sisyphusPromptPlan, onReconcile: onSisyphusReconcile })
    : undefined
  return async (event) => {
    if (!event || typeof event !== "object") return
    const sessionID = typeof event.sessionID === "string" ? event.sessionID : undefined
    const agentName = typeof event.agent === "string" ? event.agent : undefined
    const modelID = typeof event.model?.modelID === "string"
      ? event.model.modelID
      : (typeof event.model?.id === "string" ? event.model.id : undefined)
    const tuning = typeof getAgentRequestBody === "function" ? getAgentRequestBody(agentName) : undefined
    const { options: reasoningOptions, source: reasoningSource } = buildReasoningOptions({
      tuning,
      currentTurnText: lastUserMessageText(event.messages),
      modelID,
      thinkModeEnabled,
    })
    if (Object.keys(reasoningOptions).length > 0) {
      Object.assign(event.options ?? (event.options = {}), reasoningOptions)
      onAgentTuningApplied?.({
        agent: agentName,
        providerID: event.model?.providerID ?? event.model?.provider,
        shape: "context",
        source: reasoningSource,
        payload: reasoningOptions,
      })
    }
    let agents
    try {
      agents = await getDelegationRoster()
    } catch {
      onDelegationRoster?.({ count: 0, available: false })
      return
    }
    if (!(await isRootSession(event, agents))) return
    const initialDirectoryGuidance = sessionID && typeof getInitialDirectoryInstructions === "function"
      ? getInitialDirectoryInstructions({ sessionID, agent: agentName })
      : ""
    const roster = formatDelegationRoster(agents, categories)
    onDelegationRoster?.({ count: Array.isArray(agents) ? agents.length : 0, available: Boolean(roster) })
    const categorySkillReminder = sessionID && typeof getCategorySkillReminder === "function"
      ? getCategorySkillReminder(sessionID)
      : ""
    const system = removeInjectedSystemParts(event.system)
    // T28: swap the baked Sisyphus body for the runtime model's body before the
    // roster/guidance parts are appended. The reconciler carries its own cache.
    if (sisyphusReconciler) sisyphusReconciler.reconcile(system, modelID, { agent: agentName })
    for (const text of [initialDirectoryGuidance, roster, categorySkillReminder]) {
      if (text) system.push({ type: "text", text })
    }
    // The update notice rides the same system channel as the roster, after
    // the root-session gate, so a delegated child never receives it (V1 parity).
    const updateNotice = typeof getUpdateNotice === "function" ? getUpdateNotice() : ""
    if (updateNotice) system.push({ type: "text", text: updateNotice })
    // Model-keyed file-edit guidance (V1 `gpt-apply-patch-guard`). The host
    // selects the editing toolset per model: for the GPT family it deletes
    // `edit`/`write` and keeps `patch`, and for every other model it deletes
    // `patch`. The block therefore names the tool the model actually has, which
    // is resolved from the host's own predicate rather than assumed. When the
    // request also advertises `hashline_edit` (or the registration gate is on
    // and the host does not expose a tool map), the block names it too: telling
    // a GPT model that `patch` is its only editor would be false in the shipped
    // profile and would steer it away from the hash-validated editing path.
    // Injected on the same root-session system channel as the notice,
    // marker-wrapped so a repeated pass rebuilds rather than accumulates.
    const hashlineInRequest = hashlineEditInToolMap(event.tools)
    const gptEditGuidance = gptEditGuidanceBlock(modelID, {
      // The per-request tool map wins when present; the registration gate is the
      // fallback for a host that does not expose one.
      hasHashlineEdit: hashlineInRequest ?? hashlineEditEnabled,
    })
    if (gptEditGuidance) {
      system.push({ type: "text", text: gptEditGuidance })
      // Observability seam: the block that was actually pushed is reported per
      // request as a hash plus a length, so an operator can prove the injection
      // happened without the guidance body (or any message text) leaving the
      // runtime. The callback is observation only: the pushed bytes are set
      // before it runs and are never read back from it.
      onGptEditGuidance?.({
        agent: agentName,
        providerID: event.model?.providerID ?? event.model?.provider,
        modelID,
        contentSha256: createHash("sha256").update(gptEditGuidance).digest("hex"),
        contentLength: gptEditGuidance.length,
      })
    }
    event.system = system
    if (!Array.isArray(event.messages)) return
    const { decision, directive } = keywordSeam.decide({
      parts: contextUserParts(event.messages),
      sessionID,
      agent: agentName,
      modelID,
    })
    const explicitConfirmed = keywordSeam.confirmExplicit({
      decision,
      body: { messages: event.messages },
      isChatShape: true,
    }) && hasContextUltraworkKeyword(event.messages)
    if (directive) {
      const userIndex = currentUserMessageIndex(event.messages)
      if (userIndex >= 0) appendDirectiveToUserMessage(event.messages[userIndex], directive)
      else event.system.push({ type: "text", text: directive })
    }
    keywordSeam.commit({
      decision,
      sessionID,
      shouldPersist: decision.explicitPersistence && explicitConfirmed && directive.length > 0,
    })
    if (categorySkillReminder) onCategorySkillReminderConsumed?.(sessionID)
  }
}

/** Build the official V2 `model.request` hook for headers and preflight fallback. */
export function createNativeModelRequestHook({ resolveModel, getHeaders } = {}) {
  return async (event) => {
    if (!event || typeof event !== "object") return
    const headers = typeof getHeaders === "function" ? await getHeaders(event) : undefined
    if (headers && typeof headers === "object") {
      Object.assign(event.headers ?? (event.headers = {}), headers)
    }
    const activeProviderID = typeof event.model?.providerID === "string" && event.model.providerID
      ? event.model.providerID
      : (typeof event.model?.provider === "string" ? event.model.provider : undefined)
    const modelID = typeof event.model?.modelID === "string"
      ? event.model.modelID
      : (typeof event.model?.id === "string" ? event.model.id : undefined)
    if (typeof resolveModel !== "function" || !activeProviderID || !modelID) return
    let resolved
    try {
      resolved = await resolveModel({
        sessionID: typeof event.sessionID === "string" ? event.sessionID : undefined,
        agent: event.agent,
        model: modelID,
        sameProviderAs: activeProviderID,
      })
    } catch (error) {
      console.error(`[oh-my-rigel] Native V2 model resolution failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (!resolved?.id || resolved.id === modelID) return
    event.model = {
      ...event.model,
      providerID: resolved.providerID ?? activeProviderID,
      modelID: resolved.id,
      id: resolved.id,
    }
    // Unit fixtures exercise the model-request hook with the former raw request
    // carrier. Production V2 supplies `event.model`; retain this adapter only
    // for that test shape while the runtime itself never registers fallback at
    // `http.request`.
    if (event.request instanceof Request) {
      try {
        const body = await event.request.clone().json()
        if (body && typeof body === "object") {
          body.model = resolved.id
          event.request = new Request(event.request, { body: JSON.stringify(body) })
        }
      } catch (error) {
        console.error(`[oh-my-rigel] Native V2 model request fixture adaptation failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

/**
 * Legacy request-body adapter retained for direct unit coverage of the prior
 * provider payload shapes. The native runtime uses `context` and
 * `model.request`; prompt/context mutations do reach the provider. Only
 * V2.0.22 compaction `event.system` mutation does not, and that path uses
 * `event.result` and `event.messages` instead.
 *
 * `resolveModel` is an optional async callback
 * `({ sessionID, agent, model, sameProviderAs })` returning a model ref
 * (`{ id }` at minimum) or undefined. `sameProviderAs` is the provider V2
 * already selected, derived from `input.model`; the resolver must only return a
 * model on that provider. The callback runs for every session, before the
 * root/child guard, so a delegated child whose primary model is unavailable
 * also falls back.
 *
 * Task 12: the same boundary runs the keyword decision (`decideKeywordInjection`)
 * and appends team/hyperplan/combo/ultrawork guidance to the current-turn user
 * content (T1 proved that target is honored). The session-scoped keyword state
 * is injected so the runtime can feed it `session.compacted` / `session.deleted`.
 */
export function createNativeRequestHook({
  getDelegationRoster,
  categories = [],
  isRootSession = async () => true,
  onDelegationRoster,
  resolveModel,
  getAgentRequestBody,
  onAgentTuningApplied,
  ultraworkPrompt = "",
  ultraworkPrompts,
  keywordMessages,
  keywordState: keywordStateOption,
  disabledKeywords,
  enabledExpansions,
  defaultUltrawork = false,
  getInitialDirectoryInstructions,
  getCategorySkillReminder,
  onCategorySkillReminderConsumed,
} = {}) {
  if (typeof getDelegationRoster !== "function") {
    throw new TypeError("A live V2 delegation roster reader is required")
  }
  // Task 12: the unbounded session Set is replaced by the V1 state port (cap
  // 256 FIFO, clear on session.deleted, restoration on compaction). The native
  // runtime also owns this instance and feeds it the event stream; the seam
  // binds the decision core and the current-turn injection target.
  const keywordSeam = createKeywordSeam({
    ultraworkPrompt,
    ultraworkPrompts,
    keywordMessages,
    keywordState: keywordStateOption,
    disabledKeywords,
    enabledExpansions,
    defaultUltrawork,
  })
  return async (input) => {
    // `http.request` is shared by primary, title, compaction, and child
    // requests. Its `kind` is not a stable primary-session discriminator in
    // V2.0.x, so session/agent ownership below is the authoritative guard.
    let body
    try { body = await input.request.clone().json() } catch { return }
    // Two provider body shapes reach this boundary. Chat Completions carries
    // `messages` (array of {role, content}); the OpenAI Responses API carries
    // `input` (array of typed items) plus a single `instructions` string. T1
    // proved the live V2 lab sends Chat Completions; the Responses branch is
    // kept working defensively so a Responses provider still gets the roster,
    // the model fallback, and the keyword directive.
    const isChatShape = Array.isArray(body?.messages)
    const isResponsesShape = !isChatShape && Array.isArray(body?.input)
    if (!isChatShape && !isResponsesShape) return
    const shape = isResponsesShape ? "responses" : "chat"
    const tuning = typeof getAgentRequestBody === "function" ? getAgentRequestBody(input.agent) : undefined
    const tuningPayload = applyAgentTuning(body, tuning, shape)
    if (tuningPayload) {
      input.request = new Request(input.request, { body: JSON.stringify(body) })
      onAgentTuningApplied?.({
        agent: input.agent,
        providerID: input.model?.providerID ?? input.model?.provider,
        shape,
        payload: tuningPayload,
      })
    }
    const sessionID = typeof input.sessionID === "string" ? input.sessionID : undefined
    // Proactive model fallback runs before the root/child guard. The payload
    // `model` is a bare id (no provider prefix) at this boundary, while
    // `input.model` is the V2 ref that names the provider V2 already selected.
    // Pass that provider so the resolver can only return a rung on the same
    // provider: rewriting `body.model` across providers would send the id down
    // the already-selected route (a misroute, not a fallback). When the active
    // provider is unknown, skip the walk entirely and leave `body.model` alone.
    const activeProviderID = typeof input.model?.providerID === "string" && input.model.providerID
      ? input.model.providerID
      : (typeof input.model?.provider === "string" && input.model.provider ? input.model.provider : undefined)
    if (typeof resolveModel === "function" && activeProviderID && typeof body.model === "string" && body.model.trim()) {
      let resolved
      try {
        resolved = await resolveModel({ sessionID, agent: input.agent, model: body.model, sameProviderAs: activeProviderID })
      } catch (error) {
        resolved = undefined
        console.error(`[oh-my-rigel] Native V2 model resolution failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (resolved && typeof resolved.id === "string" && resolved.id && resolved.id !== body.model) {
        body.model = resolved.id
        input.request = new Request(input.request, { body: JSON.stringify(body) })
      }
    }
    const initialDirectoryGuidance = sessionID && typeof getInitialDirectoryInstructions === "function"
      ? getInitialDirectoryInstructions({ sessionID, agent: input.agent })
      : ""
    let agents
    try { agents = await getDelegationRoster() } catch {
      onDelegationRoster?.({ count: 0, available: false })
      return
    }
    const isRoot = await isRootSession(input, agents)
    // Per-read directory context is appended to the read tool result by the
    // directory injector, not injected here; only the Hephaestus root-AGENTS
    // guidance remains a system-level injection.
    if (!isRoot) return
    const agentName = typeof input.agent === "string" ? input.agent : undefined
    const modelID = typeof body.model === "string" && body.model.trim()
      ? body.model
      : (typeof input.model?.modelID === "string" ? input.model.modelID : undefined)
    // T1 proved the honored injection target is the current-turn user content
    // (Chat Completions); the Responses shape mirrors it defensively.
    const keywordParts = isChatShape ? chatUserParts(body.messages) : responsesUserParts(body)
    const { decision, directive } = keywordSeam.decide({ parts: keywordParts, sessionID, agent: agentName, modelID })
    // The core owns the decision; this V1-pattern probe confirms the raw body
    // before a persistent ultrawork record is created, so `ultraworker` never
    // seeds one.
    const explicitConfirmed = keywordSeam.confirmExplicit({ decision, body, isChatShape })
    const roster = formatDelegationRoster(agents, categories)
    onDelegationRoster?.({ count: Array.isArray(agents) ? agents.length : 0, available: Boolean(roster) })
    const injections = []
    if (initialDirectoryGuidance) injections.push(initialDirectoryGuidance)
    if (roster) injections.push(roster)
    // V1's category-skill reminder is injected once per session at the system
    // boundary. It is consumed on the same pass so a repeated request never
    // duplicates it.
    const categorySkillReminder = sessionID && typeof getCategorySkillReminder === "function"
      ? getCategorySkillReminder(sessionID)
      : ""
    if (categorySkillReminder) injections.push(categorySkillReminder)
    if (isChatShape) {
      const messages = body.messages.filter((message) => !isRosterMessage(message) && !isUltraworkMessage(message) && !isDirectoryInstructionMessage(message))
      if (directive) {
        const userIndex = currentUserMessageIndex(messages)
        if (userIndex < 0 || !appendDirectiveToUserMessage(messages[userIndex], directive)) injections.push(directive)
      }
      if (injections.length > 0) {
        const insertionIndex = messages.findIndex((message) => message?.role !== "system")
        messages.splice(insertionIndex < 0 ? messages.length : insertionIndex, 0, ...injections.map((content) => ({ role: "system", content })))
      }
      body.messages = messages
    } else {
      // Responses: everything except a writable user input part is system-level
      // text and merges into `instructions`. `input` is only touched when the
      // keyword directive can be appended to its newest user item.
      const directiveApplied = directive ? appendDirectiveToResponsesInput(body, directive) : false
      if (directive && !directiveApplied) injections.push(directive)
      body.instructions = mergeInstructions(body.instructions, injections)
    }
    input.request = new Request(input.request, { body: JSON.stringify(body) })
    // V1 persists the explicit record only when guidance was durably added; the
    // marker also refreshes a live record after a compact replay.
    keywordSeam.commit({
      decision,
      sessionID,
      shouldPersist: decision.explicitPersistence && explicitConfirmed && directive.length > 0,
    })
    if (categorySkillReminder) onCategorySkillReminderConsumed?.(sessionID)
  }
}

function isRosterMessage(message) {
  return message?.role === "system"
    && typeof message.content === "string"
    && message.content.includes(ROSTER_MARKER)
}
