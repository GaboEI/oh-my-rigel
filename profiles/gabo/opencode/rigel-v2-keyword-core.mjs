/**
 * Pure keyword decision core for Oh My Rigel's native OpenCode V2 runtime.
 *
 * This module is the exact decision port of the V1 keyword-detector hook
 * (`packages/omo-opencode/src/hooks/keyword-detector/`): same regexes, same
 * filter order, same allow/deny intersection rules, same source routing. It
 * owns NO state and performs NO I/O: the caller passes the resolved agent,
 * model, prompt parts, config, the current session's persisted ultrawork
 * record, and the V1 message bodies (as `messageTexts`); it receives back the
 * decision (which keyword types fire, the joined guidance, toast flags, and the
 * state transitions the binding should apply).
 *
 * `rigel-v2-native-prompt.mjs` (T12) binds this core to the verified V2
 * http.request seam: T1 proved the injection target is
 * `body.messages[role=user].content` (honored), so a `parts`-shaped array is
 * reconstructed from those user messages before the call.
 *
 * Pipeline (V1 hook.ts order):
 *   synthetic/internal-only -> system directive -> slash command
 *   -> non-OMO agent -> removeSystemReminders -> detect (removeCodeBlocks,
 *   disabled/allowlist, combo intersection) -> explicit/replay/compact state
 *   -> combo suppresses standalones -> planner drop -> subagent return
 *   -> non-main keeps ultrawork+combo -> already-injected -> emit.
 */

export const ULTRAWORK_PATTERN = /\b(ultrawork|ulw)\b/i
export const TEAM_PATTERN = /\bteam[\s_-]?mode\b/i
export const HYPERPLAN_PATTERN = /\bhyperplan\b|(?<![\w.])hpp\b/i
// Strict adjacency, both word orders.
export const HYPERPLAN_ULTRAWORK_PATTERN =
  /\b(?:hpp|hyperplan)\s+(?:ulw|ultrawork)\b|\b(?:ulw|ultrawork)\s+(?:hpp|hyperplan)\b/i
export const CODE_BLOCK_PATTERN = /```[\s\S]*?```/g
export const INLINE_CODE_PATTERN = /`[^`]+`/g
export const SLASH_COMMAND_LEAD_PATTERN = /^\s*\/[a-zA-Z][\w-]*(?:\s|$)/
export const STOP_CONTINUATION_PATTERN = /^\s*\/stop-continuation(?:\s|$)/i
export const SYSTEM_DIRECTIVE_PREFIX = "[SYSTEM DIRECTIVE: OH-MY-OPENCODE"
const SYSTEM_DIRECTIVE_LEADING_KEYWORD_PATTERN = /^\s*(?:ultrawork|ulw)\s+/i
export const OMO_INTERNAL_INITIATOR_MARKER = "<!-- OMO_INTERNAL_INITIATOR -->"
const INTERNAL_INITIATOR_MARKER_DETECT_PATTERN = /<!--\s*OMO_INTERNAL_INITIATOR\s*-->/
const RIGEL_INJECTED_USER_REPORT_PATTERN = /^\s*<rigel-native-(?:background-result|child-task)\b/i

export const KEYWORD_TYPES = Object.freeze(["ultrawork", "team", "hyperplan", "hyperplan-ultrawork"])

const KEYWORD_DETECTORS = Object.freeze([
  { type: "ultrawork", pattern: ULTRAWORK_PATTERN },
  { type: "team", pattern: TEAM_PATTERN },
  { type: "hyperplan", pattern: HYPERPLAN_PATTERN },
  { type: "hyperplan-ultrawork", pattern: HYPERPLAN_ULTRAWORK_PATTERN },
])

export function removeCodeBlocks(text) {
  return String(text).replace(CODE_BLOCK_PATTERN, "").replace(INLINE_CODE_PATTERN, "")
}

function isTextPartLike(part) {
  return part?.type === "text" && typeof part?.text === "string"
}

function isSyntheticOrInternalTextPart(part) {
  return isTextPartLike(part)
    && (part.synthetic === true
      || INTERNAL_INITIATOR_MARKER_DETECT_PATTERN.test(part.text)
      || RIGEL_INJECTED_USER_REPORT_PATTERN.test(part.text))
}

export function isRealUserTextPart(part) {
  return isTextPartLike(part) && !isSyntheticOrInternalTextPart(part)
}

export function isSyntheticOrInternalOnlyTextParts(parts) {
  const textParts = (Array.isArray(parts) ? parts : []).filter(isTextPartLike)
  return textParts.length > 0 && textParts.every(isSyntheticOrInternalTextPart)
}

export function extractPromptText(parts) {
  return (Array.isArray(parts) ? parts : [])
    .filter(isRealUserTextPart)
    .map((part) => part.text || "")
    .join(" ")
}

export function isSystemDirective(text) {
  const trimmed = String(text).trimStart()
  if (trimmed.startsWith(SYSTEM_DIRECTIVE_PREFIX)) return true
  const withoutLeadingKeyword = trimmed.replace(SYSTEM_DIRECTIVE_LEADING_KEYWORD_PATTERN, "")
  return withoutLeadingKeyword.startsWith(SYSTEM_DIRECTIVE_PREFIX)
}

export function removeSystemReminders(text) {
  return String(text).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim()
}

export function looksLikeSlashCommand(text) {
  return SLASH_COMMAND_LEAD_PATTERN.test(String(text))
}

export function isPlannerAgent(agentName) {
  if (typeof agentName !== "string" || agentName.length === 0) return false
  const lowerName = agentName.toLowerCase()
  if (lowerName.includes("prometheus") || lowerName.includes("planner")) return true
  return /\bplan\b/.test(lowerName.replace(/[_-]+/g, " "))
}

export function isNonOmoAgent(agentName) {
  if (typeof agentName !== "string" || agentName.length === 0) return false
  const lowerName = agentName.toLowerCase()
  return lowerName.includes("builder") || lowerName === "plan"
}

function extractModelName(model) {
  return model.includes("/") ? (model.split("/").pop() ?? model) : model
}

export function isGptModel(model) {
  return typeof model === "string" && extractModelName(model).toLowerCase().includes("gpt")
}

export function isGlmModel(model) {
  return typeof model === "string" && extractModelName(model).toLowerCase().includes("glm")
}

export function isGeminiModel(model) {
  if (typeof model !== "string") return false
  if (model.startsWith("google/") || model.startsWith("google-vertex/")) return true
  if (model.startsWith("github-copilot/") && extractModelName(model).toLowerCase().startsWith("gemini")) return true
  return extractModelName(model).toLowerCase().startsWith("gemini-")
}

export function getUltraworkSource(agentName, modelID) {
  if (isPlannerAgent(agentName)) return "planner"
  if (modelID && isGptModel(modelID)) return "gpt"
  if (modelID && isGeminiModel(modelID)) return "gemini"
  if (modelID && isGlmModel(modelID)) return "glm"
  return "default"
}

/**
 * Mirror of V1 `detectKeywordsWithType` minus message resolution: returns the
 * matched types in `KEYWORD_DETECTORS` order after code-block removal, the
 * disabled set, the allowlist, and the combo intersection rule.
 */
export function detectKeywordTypes(text, { disabledKeywords, enabledExpansions } = {}) {
  const textWithoutCode = removeCodeBlocks(text)
  const disabled = new Set(Array.isArray(disabledKeywords) ? disabledKeywords : [])
  // Intersection rule: the combo requires BOTH base keywords enabled.
  if (disabled.has("ultrawork") || disabled.has("hyperplan")) disabled.add("hyperplan-ultrawork")
  // V1 truthiness: an explicitly empty array is truthy, so it allows none.
  const allowlist = enabledExpansions ? new Set(enabledExpansions) : null
  return KEYWORD_DETECTORS
    .filter(({ type, pattern }) => pattern.test(textWithoutCode)
      && (!allowlist || allowlist.has(type))
      && !disabled.has(type))
    .map(({ type }) => type)
}

function suppressComboStandalones(types) {
  if (!types.includes("hyperplan-ultrawork")) return types
  return types.filter((type) => type !== "ultrawork" && type !== "hyperplan")
}

function decision(fields = {}) {
  return Object.freeze({
    action: "ignore",
    reason: "unset",
    promptSource: "default",
    types: Object.freeze([]),
    allMessages: "",
    explicitUltrawork: false,
    replayUltrawork: false,
    compactUltrawork: false,
    requiresFullGuidance: false,
    continuationMarker: false,
    toast: Object.freeze({ ultrawork: false, hyperplan: false, hyperplanUltrawork: false }),
    rememberDefaultMode: false,
    explicitPersistence: false,
    clearExplicit: false,
    ...fields,
    types: Object.freeze([...(fields.types ?? [])]),
    toast: Object.freeze({
      ultrawork: fields.toast?.ultrawork === true,
      hyperplan: fields.toast?.hyperplan === true,
      hyperplanUltrawork: fields.toast?.hyperplanUltrawork === true,
    }),
  })
}

/**
 * The single pure decision function.
 *
 * @param {{
 *   parts?: ReadonlyArray<{ type?: string, text?: string, synthetic?: boolean }>,
 *   agent?: string,
 *   modelID?: string,
 *   disabledKeywords?: ReadonlyArray<string>,
 *   enabledExpansions?: ReadonlyArray<string>,
 *   messageTexts?: Record<string, string>,
 *   activeUltrawork?: { source: string, needsRestoration?: boolean },
 *   isSubagentSession?: boolean,
 *   isNonMainSession?: boolean,
 *   defaultUltrawork?: boolean,
 *   defaultModeInjected?: boolean,
 * }} input
 * @returns {Readonly<object>} decision; `action` is `"ignore"`, `"inject"`, or
 *   `"default-mode"` (V1's default-ultrawork toast + remember path).
 */
export function decideKeywordInjection(input = {}) {
  const partList = Array.isArray(input.parts) ? input.parts : []
  const agent = typeof input.agent === "string" ? input.agent : undefined
  const modelID = typeof input.modelID === "string" ? input.modelID : undefined
  const texts = input.messageTexts && typeof input.messageTexts === "object" ? input.messageTexts : {}
  const promptSource = getUltraworkSource(agent, modelID)
  const messageFor = (type) => (typeof texts[type] === "string" ? texts[type] : "")

  if (isSyntheticOrInternalOnlyTextParts(partList)) {
    return decision({ promptSource, reason: "synthetic-internal-only" })
  }
  const promptText = extractPromptText(partList.filter(isRealUserTextPart))
  if (isSystemDirective(promptText)) {
    return decision({ promptSource, reason: "system-directive" })
  }
  if (looksLikeSlashCommand(promptText)) {
    return decision({
      promptSource,
      reason: "slash-command",
      // V1 clears the persisted explicit-ultrawork record on /stop-continuation
      // only; the default-mode set is untouched here.
      clearExplicit: STOP_CONTINUATION_PATTERN.test(promptText),
    })
  }
  if (isNonOmoAgent(agent)) {
    return decision({ promptSource, reason: "non-omo-agent" })
  }

  const cleanText = removeSystemReminders(promptText)
  const detectedTypes = detectKeywordTypes(cleanText, {
    disabledKeywords: input.disabledKeywords,
    enabledExpansions: input.enabledExpansions,
  })
  const explicitUltrawork = detectedTypes.includes("ultrawork") || detectedTypes.includes("hyperplan-ultrawork")
  const activeUltrawork = input.activeUltrawork && typeof input.activeUltrawork === "object"
    ? input.activeUltrawork
    : undefined
  const replayUltrawork = !explicitUltrawork && activeUltrawork !== undefined
  const compactUltrawork = activeUltrawork !== undefined
    && activeUltrawork.needsRestoration !== true
    && activeUltrawork.source === promptSource

  let types = [...detectedTypes]
  if (replayUltrawork) types.push("ultrawork")
  types = suppressComboStandalones(types)
  if (isPlannerAgent(agent)) {
    types = types.filter((type) => type !== "ultrawork" && type !== "hyperplan" && type !== "hyperplan-ultrawork")
  }

  if (input.isSubagentSession === true) {
    return decision({ promptSource, reason: "subagent-session" })
  }
  if (types.length === 0) {
    if (input.defaultUltrawork === true && input.isNonMainSession !== true && input.defaultModeInjected !== true) {
      return decision({
        promptSource,
        action: "default-mode",
        reason: "default-mode-activated",
        rememberDefaultMode: true,
      })
    }
    return decision({ promptSource, reason: "no-keywords" })
  }
  if (input.isNonMainSession === true) {
    types = types.filter((type) => type === "ultrawork" || type === "hyperplan-ultrawork")
    if (types.length === 0) return decision({ promptSource, reason: "non-main-filtered" })
  }
  types = types.filter((type) => {
    const message = messageFor(type)
    return message.length === 0 || !cleanText.includes(message.trim())
  })
  if (types.length === 0) return decision({ promptSource, reason: "already-injected" })

  const hasUltrawork = types.includes("ultrawork")
  const hasHyperplan = types.includes("hyperplan")
  const hasHyperplanUltrawork = types.includes("hyperplan-ultrawork")
  const allMessages = types
    .filter((type) => !(compactUltrawork && type === "ultrawork"))
    .map(messageFor)
    .join("\n\n")
  const requiresFullGuidance = (hasUltrawork || hasHyperplanUltrawork)
    && !compactUltrawork
    && allMessages.length > 0
  return decision({
    promptSource,
    action: "inject",
    reason: "detected",
    types,
    allMessages,
    explicitUltrawork,
    replayUltrawork,
    compactUltrawork,
    requiresFullGuidance,
    // V1 pushes an `<ultrawork-mode>active</ultrawork-mode>` marker part instead
    // of the full guidance when a compacted session replays ultrawork.
    continuationMarker: hasUltrawork && compactUltrawork,
    toast: {
      ultrawork: hasUltrawork && explicitUltrawork,
      hyperplan: hasHyperplan,
      hyperplanUltrawork: hasHyperplanUltrawork,
    },
    // V1 base condition for persisting the explicit session record; the binding
    // must additionally require durable guidance when `requiresFullGuidance`.
    explicitPersistence: (explicitUltrawork || replayUltrawork) && (hasUltrawork || hasHyperplanUltrawork),
  })
}
