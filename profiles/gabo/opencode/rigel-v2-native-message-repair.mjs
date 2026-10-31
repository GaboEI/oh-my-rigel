/**
 * Native OpenCode V2 message validation and repair on the `context` hook.
 *
 * V1 `plugin/messages-transform.ts` ran on `experimental.chat.messages.transform`
 * (mapped to `ctx.session.hook("context", ...)` in V2, whose `event.messages` is an
 * array of `@opencode/ai` `Message`: `{ role, content: ContentPart[] }`, where a
 * tool call is a `{ type: "tool-call", id, name, input }` part and its result a
 * `{ type: "tool-result", id, name, result }` part on a `tool` message).
 *
 * Scope decision (T27, audited): the V1 proactive thinking-block validator was
 * reduced to a no-op in 733f141bb and deleted in 9a16b54e4. The current V1 owner
 * therefore has NO outgoing thinking-block effect, and the V2 provider transform
 * owns reasoning normalization (`@opencode/ai` anthropic-messages.js:790-816).
 * T27 does NOT restore the removed historical behavior. Only the two effects the
 * current V1 owner still performs are ported here: tool-pair validation/repair
 * and the assistant-prefill tail repair. Reasoning is left untouched.
 *
 * Precedence mirrors V1: validation runs before repair, and the assistant-prefill
 * tail repair runs last. A valid history is left byte-identical. The returned
 * report is non-empty only when a repair happened, so the runtime can make it
 * observable instead of silently ignoring it.
 *
 * Pure module: no I/O, no runtime dependencies, no handler registration.
 */

import { INTERRUPTED_TOOL_ERROR } from "./rigel-v2-flow-logic.mjs"
import { repairChatToolPairs } from "./rigel-v2-native-request-steps.mjs"

/** V1 `ASSISTANT_PREFILL_RECOVERY_TEXT` (messages-transform.ts:8). */
export const ASSISTANT_PREFILL_RECOVERY_TEXT = "[internal] Continue from the previous assistant state."

/** V1 `ASSISTANT_PREFILL_UNSUPPORTED_PROVIDERS` (messages-transform.ts:9-19). */
export const ASSISTANT_PREFILL_UNSUPPORTED_PROVIDERS = new Set([
  "anthropic",
  "aws-bedrock-anthropic",
  "github-copilot",
  "github-copilot-enterprise",
  "google-vertex-anthropic",
  "opencode",
  "opencode-go",
  "opencode-zen-proxy",
  "vercel",
])

/** V1 `ASSISTANT_PREFILL_UNSUPPORTED_MODEL_PREFIXES` (messages-transform.ts:20-24). */
export const ASSISTANT_PREFILL_UNSUPPORTED_MODEL_PREFIXES = [
  "claude-opus-4",
  "claude-sonnet-4-6",
  "claude-mythos",
]

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function contentOf(message) {
  return Array.isArray(message?.content) ? message.content : []
}

// ---------------------------------------------------------------------------
// Tool-pair validation and repair (V2 parts shape)
// ---------------------------------------------------------------------------

function toolCallID(part) {
  if (part?.type !== "tool-call") return undefined
  return typeof part.id === "string" && part.id.length > 0 ? part.id : undefined
}

function toolResultID(part) {
  if (part?.type !== "tool-result") return undefined
  return typeof part.id === "string" && part.id.length > 0 ? part.id : undefined
}

/**
 * Repair unpaired V2 `tool-call` parts by appending the missing terminal
 * `tool-result` on a following `tool` message, carrying the T9 interrupted text.
 *
 * The current V1 owner (`hooks/tool-pair-validator`) has no standalone tool-result
 * message to insert; it settles an unpaired OpenCode tool PART into a terminal
 * `error` state so the single part serializes as both `tool_use` and `tool_result`.
 * The V2 `Message[]` shape has no part state, so the V2-native equivalent of
 * "settle to terminal" is the explicit terminal `tool-result` message inserted
 * here. A legacy Chat Completions-shaped array (top-level `tool_calls`) is
 * delegated to the existing `repairChatToolPairs`, so the surface keeps one
 * implementation per shape instead of a duplicate. Idempotent: the inserted result
 * pairs the call, so a second pass inserts nothing. Returns the repaired call ids.
 *
 * PR5 row 25 ownership rules: a `providerExecuted: true` call is executed by the
 * provider/host, which owns its lifecycle, so it never receives a synthetic local
 * result. Ambiguous histories are preserved byte-identically and left unrepaired:
 * a call ID that appears on more than one `tool-call` part, duplicate results, a
 * result that precedes its call, or a result on a role other than `tool` (any
 * tool-result part anywhere pairs the ID, so none of these get a synthetic insert).
 */
export function repairMessageToolPairs(messages) {
  if (!Array.isArray(messages)) return []
  if (messages.some((message) => Array.isArray(message?.tool_calls))) {
    return repairChatToolPairs(messages)
  }
  const paired = new Set()
  for (const message of messages) {
    for (const part of contentOf(message)) {
      const id = toolResultID(part)
      if (id) paired.add(id)
    }
  }
  const callCounts = new Map()
  for (const message of messages) {
    for (const part of contentOf(message)) {
      const callID = toolCallID(part)
      if (callID) callCounts.set(callID, (callCounts.get(callID) ?? 0) + 1)
    }
  }
  const repaired = []
  const rebuilt = []
  for (const message of messages) {
    rebuilt.push(message)
    if (message?.role !== "assistant") continue
    for (const part of contentOf(message)) {
      const callID = toolCallID(part)
      if (!callID || paired.has(callID)) continue
      if (part.providerExecuted === true) continue
      if (callCounts.get(callID) !== 1) continue
      paired.add(callID)
      rebuilt.push({
        role: "tool",
        content: [{ type: "tool-result", id: callID, name: part.name, result: { type: "error", value: INTERRUPTED_TOOL_ERROR } }],
      })
      repaired.push(callID)
    }
  }
  if (repaired.length > 0) {
    messages.length = 0
    messages.push(...rebuilt)
  }
  return repaired
}

// ---------------------------------------------------------------------------
// Assistant-prefill tail repair
// ---------------------------------------------------------------------------

function normalizeModelID(modelID) {
  return modelID.replace(/\.(\d+)/g, "-$1")
}

function readModelIdentifier(model) {
  if (!isRecord(model)) return undefined
  const providerID = typeof model.providerID === "string" ? model.providerID : (typeof model.provider === "string" ? model.provider : undefined)
  const modelID = typeof model.modelID === "string" ? model.modelID : (typeof model.id === "string" ? model.id : undefined)
  return providerID && modelID ? { providerID, modelID } : undefined
}

function normalizeAssistantPrefillModelID(modelID) {
  const normalized = normalizeModelID(modelID.toLowerCase())
  return normalized.split(/[/.~:@]+/).find((segment) => segment.startsWith("claude-")) ?? normalized
}

function hasAnthropicModelNamespace(modelID) {
  return /(?:^|[/.~:@])anthropic(?:$|[/.~:@])/.test(normalizeModelID(modelID.toLowerCase()))
}

function providerCanExposeUnsupportedAssistantPrefill(providerID, modelID) {
  return ASSISTANT_PREFILL_UNSUPPORTED_PROVIDERS.has(providerID) || hasAnthropicModelNamespace(modelID)
}

/** V1 `shouldRepairAssistantPrefillForModel` (messages-transform.ts:145-157). */
export function shouldRepairAssistantPrefillForModel(model) {
  const identifier = readModelIdentifier(model)
  if (!identifier) return false
  if (!providerCanExposeUnsupportedAssistantPrefill(identifier.providerID.toLowerCase(), identifier.modelID)) return false
  const modelID = normalizeAssistantPrefillModelID(identifier.modelID)
  return ASSISTANT_PREFILL_UNSUPPORTED_MODEL_PREFIXES.some((prefix) => modelID.startsWith(prefix))
}

/**
 * V1 `hasInternalContinuationTrigger` (messages-transform.ts:159-170): the last
 * user turn carries a synthetic compaction-continuation part. The V2 runtime does
 * not emit `metadata.compaction_continue` today, so this predicate is inert unless
 * a producer appears; it is kept for parity with the V1 owner.
 */
export function hasInternalContinuationTrigger(messages) {
  if (!Array.isArray(messages)) return false
  let lastUser
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUser = messages[index]
      break
    }
  }
  if (!lastUser) return false
  return contentOf(lastUser).some((part) => isRecord(part?.metadata) && part.metadata.compaction_continue === true)
}

/**
 * Append a synthetic user recovery turn after an assistant tail that the target
 * model cannot accept as a prefill. Mirrors V1 `ensureUserTurnAfterAssistantTail`
 * and `createAssistantPrefillRecoveryMessage` on the V2 message shape. The
 * synthetic flag is the same one the runtime's context collector honors, so the
 * recovery turn never receives injected context. Returns true when a turn was
 * appended.
 */
export function repairAssistantPrefillTail(messages, { model } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return false
  const last = messages.at(-1)
  if (last?.role !== "assistant") return false

  const shouldRepair = hasInternalContinuationTrigger(messages) || shouldRepairAssistantPrefillForModel(model)
  if (!shouldRepair) return false

  messages.push({
    role: "user",
    synthetic: true,
    metadata: { prefill_recovery: true },
    content: [{ type: "text", text: ASSISTANT_PREFILL_RECOVERY_TEXT, synthetic: true }],
  })
  return true
}

// ---------------------------------------------------------------------------
// Ordered pipeline
// ---------------------------------------------------------------------------

/**
 * Validate tool pairs first, then repair the assistant-prefill tail. A valid
 * history is left byte-identical; reasoning is never touched. `model` is the
 * session model ref from the V2 `context` event (`{ providerID, modelID }`).
 * The report is non-empty only when a repair happened.
 */
export function validateAndRepairMessages(messages, { model } = {}) {
  if (!Array.isArray(messages)) return { toolPairs: [], prefill: false }
  const toolPairs = repairMessageToolPairs(messages)
  const prefill = repairAssistantPrefillTail(messages, { model })
  return { toolPairs, prefill }
}
