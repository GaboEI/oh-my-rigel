import { expect, test } from "bun:test"
// The runtime `.mjs` cannot import `packages/` TypeScript, so the predicate is
// re-expressed there; this import pins the re-expression to the real authority.
import { isClaudeFableOrMythosModel, isClaudeOpus47OrLaterModel } from "../../../packages/model-core/src/model-family-detectors.ts"
import {
  buildReasoningOptions,
  detectThinkKeyword,
  impliesAdaptiveThinking,
  isAlreadyHighVariant,
  normalizeReasoningLevel,
  reasoningEffortFromThinking,
  stripCodeText,
  thinkingBudgetForLevel,
} from "./rigel-v2-native-reasoning-options.mjs"

test("detectThinkKeyword matches English and multilingual words but ignores code", () => {
  expect(detectThinkKeyword("please think about this")).toBe(true)
  expect(detectThinkKeyword("ultrathink now")).toBe(true)
  expect(detectThinkKeyword("생각해줘")).toBe(true)
  expect(detectThinkKeyword("подумай внимательно")).toBe(true)
  expect(detectThinkKeyword("привет мир")).toBe(false)
  expect(detectThinkKeyword("думать над задачей")).toBe(true)
  expect(detectThinkKeyword("a thinker and a rethink")).toBe(false)
  expect(detectThinkKeyword("```\nthink\n```")).toBe(false)
  expect(detectThinkKeyword("use `think` here")).toBe(false)
  expect(detectThinkKeyword("no trigger word")).toBe(false)
})

test("stripCodeText removes fenced and inline code", () => {
  expect(stripCodeText("a ```x``` b `y` c")).toBe("a   b   c")
})

test("isAlreadyHighVariant detects the -high suffix with or without a provider prefix", () => {
  expect(isAlreadyHighVariant("gpt-5-1-codex-high")).toBe(true)
  expect(isAlreadyHighVariant("aws/anthropic/claude-opus-4-7-high")).toBe(true)
  expect(isAlreadyHighVariant("gpt-5-1-codex")).toBe(false)
  expect(isAlreadyHighVariant("opencode-go/deepseek-v4.1-flash")).toBe(false)
})

test("normalizeReasoningLevel maps none to off and rejects arbitrary names", () => {
  expect(normalizeReasoningLevel("none")).toBe("off")
  expect(normalizeReasoningLevel("HIGH")).toBe("high")
  expect(normalizeReasoningLevel("max")).toBe("max")
  expect(normalizeReasoningLevel("bogus")).toBeUndefined()
})

test("reasoningEffortFromThinking maps budget bands and ignores disabled thinking", () => {
  expect(reasoningEffortFromThinking({ type: "enabled", budgetTokens: 32000 })).toBe("high")
  expect(reasoningEffortFromThinking({ type: "enabled", budgetTokens: 16000 })).toBe("medium")
  expect(reasoningEffortFromThinking({ type: "enabled", budgetTokens: 8000 })).toBe("low")
  expect(reasoningEffortFromThinking({ type: "enabled" })).toBe("high")
  expect(reasoningEffortFromThinking({ type: "disabled" })).toBeUndefined()
  expect(reasoningEffortFromThinking(undefined)).toBeUndefined()
})

test("buildReasoningOptions carries agent tuning as camelCase V2 semantic options", () => {
  const { options, source } = buildReasoningOptions({
    tuning: { temperature: 0.1, top_p: 0.8, maxTokens: 64000, textVerbosity: "low" },
    currentTurnText: "plain turn",
    modelID: "opencode-go/deepseek-v4.1-flash",
  })
  expect(options).toEqual({ temperature: 0.1, topP: 0.8, maxTokens: 64000, textVerbosity: "low" })
  expect(source).toBeNull()
})

// Fase 6 (look_at/multimodal-looker): a forwarded agent temperature on a model
// the host forces into adaptive thinking is invalid (the provider answers 400
// "temperature may only be set to 1 when thinking is enabled or in adaptive
// mode"), so the child ends empty. The seam drops it on exactly the adaptive-only
// models: Anthropic Claude >= 5.1 (e.g. haiku-5-5) plus the model-core
// adaptive-only families the host rule does not reach (opus-4.7/4.8, opus-5,
// fable/mythos). The deepseek case above is the non-adaptive control.
test("buildReasoningOptions drops a temperature the host's adaptive-thinking models cannot honor", () => {
  const dropped = buildReasoningOptions({
    tuning: { temperature: 0.1, top_p: 0.8 },
    currentTurnText: "plain turn",
    modelID: "opencode-go/claude-haiku-5-5",
  })
  expect(Object.prototype.hasOwnProperty.call(dropped.options, "temperature")).toBe(false)
  expect(dropped.options).toEqual({ topP: 0.8 })

  // An Opus 4.x adaptive-only model outside the host numeric rule is also dropped.
  expect(buildReasoningOptions({ tuning: { temperature: 0.1 }, currentTurnText: "plain", modelID: "anthropic/claude-opus-4-8" }).options)
    .toEqual({})

  // Boundary: a bare major with no minor (5.0) is not adaptive-forced, so it keeps the temperature.
  expect(buildReasoningOptions({ tuning: { temperature: 0.1 }, currentTurnText: "plain", modelID: "claude-sonnet-5" }).options)
    .toEqual({ temperature: 0.1 })
  // Non-Claude model keeps it.
  expect(buildReasoningOptions({ tuning: { temperature: 0.1 }, currentTurnText: "plain", modelID: "gpt-6" }).options)
    .toEqual({ temperature: 0.1 })
})

// Owner table for the (model, adaptive-thinking) contract. TRUE = the host or the
// repo treat the model as adaptive-only, so a forwarded temperature is invalid and
// must be dropped; FALSE = the model accepts an explicit temperature.
test("impliesAdaptiveThinking: adaptive-only models are true (positive table)", () => {
  const adaptive = [
    // host numeric rule: Claude >= 5.1
    "claude-haiku-5-5",
    "opencode-go/claude-haiku-5-5",
    "claude-sonnet-5-5",
    "claude-opus-5-5",
    "anthropic.claude-opus-5-5",
    "claude-opus-5-5[1m]",
    // model-core adaptive-only families the host rule does not reach
    "claude-opus-4-7",
    "claude-opus-4-8",
    "anthropic/claude-opus-4.8",
    "claude-opus-5",
    "claude-opus-5[1m]",
    "claude-opus-5-0",
    "claude-fable-5",
    "anthropic/claude-fable-5[1m]",
    "claude-mythos-5",
    "anthropic/claude-mythos-preview",
  ]
  for (const id of adaptive) expect([id, impliesAdaptiveThinking(id)]).toEqual([id, true])
})

test("impliesAdaptiveThinking: temperature-capable models are false (negative table)", () => {
  const permissive = [
    "claude-sonnet-5",        // 5.0 boundary: the host rule needs minor >= 1
    "claude-opus-4-6",        // below the Opus 4.7 adaptive-only floor
    "claude-opus-4",
    "claude-3-5-sonnet",
    "anthropic/claude-sonnet-4-6",
    "gpt-6",
    "deepseek-v4.1-flash",
    "",
  ]
  for (const id of permissive) expect([id, impliesAdaptiveThinking(id)]).toEqual([id, false])
  expect(impliesAdaptiveThinking(undefined)).toBe(false)
  expect(impliesAdaptiveThinking(null)).toBe(false)
})

// Alignment: the runtime `.mjs` mirror must be true for EVERY id the model-core
// authority calls adaptive-only. `resolveCompatibleModelSettings` drops
// `temperature` for exactly `isClaudeOpus47OrLaterModel || isClaudeFableOrMythosModel`,
// so under-covering any of them is the R1 defect. The mirror may be true for more
// (the host rule adds Claude >= 5.1), never fewer.
test("impliesAdaptiveThinking covers every model-core adaptive-only family (alignment)", () => {
  const modelCoreAdaptiveOnly = (id) => isClaudeOpus47OrLaterModel(id) || isClaudeFableOrMythosModel(id)
  const ids = [
    "anthropic/claude-opus-4-7",
    "anthropic/claude-opus-4-8",
    "anthropic/claude-opus-4.8",
    "claude-opus-4-7",
    "claude-opus-5",
    "claude-opus-5-0",
    "claude-opus-5-5[1m]",
    "anthropic/claude-opus-5[1m]",
    "anthropic/claude-fable-5",
    "anthropic/claude-fable-5[1m]",
    "claude-fable-5",
    "anthropic.claude-fable-5",
    "anthropic/claude-mythos-5",
    "anthropic/claude-mythos-preview",
    "anthropic/claude-opus-4-6",
    "anthropic/claude-opus-4",
    "anthropic/claude-sonnet-4-6",
    "openai/gpt-5.5",
  ]
  for (const id of ids) {
    if (modelCoreAdaptiveOnly(id)) expect([id, impliesAdaptiveThinking(id)]).toEqual([id, true])
  }
  // The alignment is real, not incidental: the authority really does classify the
  // negative controls as temperature-capable, and both sides agree.
  expect(modelCoreAdaptiveOnly("anthropic/claude-opus-4-6")).toBe(false)
  expect(impliesAdaptiveThinking("anthropic/claude-opus-4-6")).toBe(false)
})

test("explicit agent reasoning wins over the think keyword and carries its thinking budget", () => {
  const { options, source } = buildReasoningOptions({
    tuning: { reasoning: "low", thinking: { type: "enabled", budgetTokens: 32000 } },
    currentTurnText: "please think hard",
    modelID: "gpt-5",
  })
  expect(options).toEqual({ reasoningEffort: "low", thinking: { type: "enabled", budgetTokens: 32000 } })
  expect(source).toBe("agent")
})

test("an enabled thinking budget becomes a reasoning level plus the Anthropic thinking carrier", () => {
  const { options, source } = buildReasoningOptions({
    tuning: { thinking: { type: "enabled", budgetTokens: 32000 } },
    currentTurnText: "plain",
    modelID: "gpt-5",
  })
  expect(options).toEqual({ reasoningEffort: "high", thinking: { type: "enabled", budgetTokens: 32000 } })
  expect(source).toBe("agent")
})

test("think keyword raises the reasoning level and the Anthropic thinking budget for the current turn", () => {
  const { options, source } = buildReasoningOptions({ currentTurnText: "please think", modelID: "gpt-5" })
  expect(options).toEqual({ reasoningEffort: "high", thinking: { type: "enabled", budgetTokens: 32000 } })
  expect(source).toBe("think")
})

test("thinkingBudgetForLevel maps levels to Anthropic thinking budgets and omits off", () => {
  expect(thinkingBudgetForLevel("high")).toBe(32000)
  expect(thinkingBudgetForLevel("medium")).toBe(16000)
  expect(thinkingBudgetForLevel("off")).toBeUndefined()
})

test("think keyword is suppressed for already-high models, disabled think-mode, and code blocks", () => {
  expect(buildReasoningOptions({ currentTurnText: "think", modelID: "gpt-5-high" }).options).toEqual({})
  expect(buildReasoningOptions({ currentTurnText: "think", modelID: "gpt-5", thinkModeEnabled: false }).options).toEqual({})
  expect(buildReasoningOptions({ currentTurnText: "```think```", modelID: "gpt-5" }).options).toEqual({})
})

test("reasoning options never carry a model variant key, so agent/category variant routing is untouched", () => {
  const { options } = buildReasoningOptions({ tuning: { reasoning: "high" }, currentTurnText: "please think", modelID: "gpt-5" })
  expect(Object.prototype.hasOwnProperty.call(options, "variant")).toBe(false)
})


