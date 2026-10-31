/**
 * Hermetic contract for native OpenCode V2 message validation and repair.
 *
 * Covers the two effects the current V1 `plugin/messages-transform.ts` owner still
 * performs, ported to the V2 `context` hook message shape (`@opencode/ai`
 * `Message[]` with content parts): tool-pair validation/repair and the
 * assistant-prefill tail repair. Reasoning is NOT touched (the V1 thinking-block
 * hook was removed; the V2 provider transform owns reasoning). Every contract is
 * exercised positive AND negative, idempotency and byte-identical no-op are
 * pinned, and the tool-pair and prefill rules each carry a named RED mutation with
 * a byte-identical restore.
 */

import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"

import {
  ASSISTANT_PREFILL_RECOVERY_TEXT,
  hasInternalContinuationTrigger,
  repairAssistantPrefillTail,
  repairMessageToolPairs,
  shouldRepairAssistantPrefillForModel,
  validateAndRepairMessages,
} from "./rigel-v2-native-message-repair.mjs"
import { INTERRUPTED_TOOL_ERROR } from "./rigel-v2-flow-logic.mjs"
import { runMutation } from "./test-support/mutation-harness.mjs"

const OPENCODE_DIR = import.meta.dir
const TARGET = path.join(OPENCODE_DIR, "rigel-v2-native-message-repair.mjs")

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function toolCall(id, name = "read") {
  return { type: "tool-call", id, name, input: {} }
}

function toolResult(id, name = "read") {
  return { type: "tool-result", id, name, result: { type: "text", value: "ok" } }
}

function reasoning(text, signature) {
  return signature
    ? { type: "reasoning", text, providerMetadata: { anthropic: { signature } } }
    : { type: "reasoning", text }
}

// ---------------------------------------------------------------------------
// Tool-pair validation (V2 parts shape)
// ---------------------------------------------------------------------------

describe("#given the V2 tool-pair repair", () => {
  describe("#when an assistant tool-call has no matching tool-result", () => {
    test("#then a terminal error result is inserted on a tool message", () => {
      // given
      const messages = [
        { role: "assistant", content: [toolCall("c1", "bash")] },
        { role: "user", content: [{ type: "text", text: "next" }] },
      ]
      // when
      const repaired = repairMessageToolPairs(messages)
      // then
      expect(repaired).toEqual(["c1"])
      expect(messages).toHaveLength(3)
      expect(messages[1]).toEqual({
        role: "tool",
        content: [{ type: "tool-result", id: "c1", name: "bash", result: { type: "error", value: INTERRUPTED_TOOL_ERROR } }],
      })
    })
  })

  describe("#when the repair runs twice", () => {
    test("#then the second pass is a no-op and the array is byte-identical", () => {
      // given
      const messages = [{ role: "assistant", content: [toolCall("c1")] }]
      // when
      const first = repairMessageToolPairs(messages)
      const snapshot = sha256(messages)
      const second = repairMessageToolPairs(messages)
      // then
      expect(first).toEqual(["c1"])
      expect(second).toEqual([])
      expect(sha256(messages)).toBe(snapshot)
    })
  })

  describe("#when the tool call is already paired", () => {
    test("#then nothing is repaired and the array is byte-identical", () => {
      // given
      const messages = [
        { role: "assistant", content: [toolCall("c1")] },
        { role: "tool", content: [toolResult("c1")] },
      ]
      const before = sha256(messages)
      // when / then
      expect(repairMessageToolPairs(messages)).toEqual([])
      expect(sha256(messages)).toBe(before)
    })
  })

  describe("#when the array is a legacy Chat Completions shape", () => {
    test("#then the existing repair is delegated to", () => {
      // given
      const messages = [
        { role: "assistant", content: null, tool_calls: [{ id: "call_legacy", type: "function", function: { name: "read", arguments: "{}" } }] },
      ]
      // when
      const repaired = repairMessageToolPairs(messages)
      // then
      expect(repaired).toEqual(["call_legacy"])
      expect(messages[1]).toEqual({ role: "tool", tool_call_id: "call_legacy", content: INTERRUPTED_TOOL_ERROR })
    })
  })

  describe("#when the input is not an array", () => {
    test("#then the repair degrades to an empty list", () => {
      // given / when / then
      expect(repairMessageToolPairs(null)).toEqual([])
      expect(repairMessageToolPairs(undefined)).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// Provider-executed calls and ambiguous histories (PR5 row 25)
// ---------------------------------------------------------------------------

describe("#given provider-executed and ambiguous tool-call histories", () => {
  describe("#when an unpaired tool-call is provider-executed", () => {
    test("#then no synthetic local result is inserted and the history is byte-identical", () => {
      // given
      const messages = [
        { role: "user", content: [{ type: "text", text: "search" }] },
        { role: "assistant", content: [{ type: "tool-call", id: "cpe", name: "web_search", input: {}, providerExecuted: true }] },
      ]
      const before = sha256(messages)
      // when / then
      expect(repairMessageToolPairs(messages)).toEqual([])
      expect(sha256(messages)).toBe(before)
    })
  })

  describe("#when a provider-executed call is already paired", () => {
    test("#then the valid pair is left byte-identical", () => {
      // given
      const messages = [
        { role: "assistant", content: [{ type: "tool-call", id: "cpe", name: "web_search", input: {}, providerExecuted: true }] },
        { role: "tool", content: [toolResult("cpe")] },
      ]
      const before = sha256(messages)
      // when / then
      expect(repairMessageToolPairs(messages)).toEqual([])
      expect(sha256(messages)).toBe(before)
    })
  })

  describe("#when two assistant tool-calls share one ID and neither has a result", () => {
    test("#then the ambiguous pair is preserved byte-identically with no synthetic result", () => {
      // given
      const messages = [
        { role: "assistant", content: [toolCall("cdup", "read")] },
        { role: "assistant", content: [toolCall("cdup", "bash")] },
      ]
      const before = sha256(messages)
      // when / then
      expect(repairMessageToolPairs(messages)).toEqual([])
      expect(sha256(messages)).toBe(before)
    })
  })

  describe("#when a call has duplicate results", () => {
    test("#then the ambiguous history is preserved byte-identically", () => {
      // given
      const messages = [
        { role: "assistant", content: [toolCall("c1")] },
        { role: "tool", content: [toolResult("c1")] },
        { role: "tool", content: [toolResult("c1")] },
      ]
      const before = sha256(messages)
      // when / then
      expect(repairMessageToolPairs(messages)).toEqual([])
      expect(sha256(messages)).toBe(before)
    })
  })

  describe("#when a matching result precedes its call", () => {
    test("#then the ambiguous history is preserved byte-identically", () => {
      // given
      const messages = [
        { role: "tool", content: [toolResult("c1")] },
        { role: "assistant", content: [toolCall("c1")] },
      ]
      const before = sha256(messages)
      // when / then
      expect(repairMessageToolPairs(messages)).toEqual([])
      expect(sha256(messages)).toBe(before)
    })
  })

  describe("#when a matching result sits on a role other than tool", () => {
    test("#then the ambiguous history is preserved byte-identically", () => {
      // given
      const messages = [
        { role: "assistant", content: [toolCall("c1")] },
        { role: "user", content: [toolResult("c1")] },
      ]
      const before = sha256(messages)
      // when / then
      expect(repairMessageToolPairs(messages)).toEqual([])
      expect(sha256(messages)).toBe(before)
    })
  })
})

// ---------------------------------------------------------------------------
// Assistant-prefill tail repair
// ---------------------------------------------------------------------------

describe("#given the assistant-prefill tail repair", () => {
  describe("#when an unsupported Anthropic model ends on an assistant tail", () => {
    test("#then a synthetic user recovery turn is appended", () => {
      // given
      const messages = [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "text", text: "partial" }] },
      ]
      // when
      const repaired = repairAssistantPrefillTail(messages, { model: { providerID: "anthropic", modelID: "claude-opus-4-8" } })
      // then
      expect(repaired).toBe(true)
      expect(messages).toHaveLength(3)
      expect(messages[2].role).toBe("user")
      expect(messages[2].synthetic).toBe(true)
      expect(messages[2].content[0]).toMatchObject({ type: "text", text: ASSISTANT_PREFILL_RECOVERY_TEXT, synthetic: true })
    })
  })

  describe("#when the tail is a user message", () => {
    test("#then the history is left byte-identical", () => {
      // given
      const messages = [
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
        { role: "user", content: [{ type: "text", text: "next" }] },
      ]
      const before = sha256(messages)
      // when / then
      expect(repairAssistantPrefillTail(messages, { model: { providerID: "anthropic", modelID: "claude-opus-4-8" } })).toBe(false)
      expect(sha256(messages)).toBe(before)
    })
  })

  describe("#when the model accepts assistant prefill", () => {
    test("#then no recovery turn is appended", () => {
      // given
      const messages = [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "text", text: "partial" }] },
      ]
      // when / then
      expect(repairAssistantPrefillTail(messages, { model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } })).toBe(false)
      expect(messages).toHaveLength(2)
    })
  })

  describe("#when the last user turn is a compaction continuation", () => {
    test("#then the tail is repaired regardless of the model", () => {
      // given
      const messages = [
        { role: "user", content: [{ type: "text", text: "continue", metadata: { compaction_continue: true } }] },
        { role: "assistant", content: [{ type: "text", text: "resumed" }] },
      ]
      // when / then
      expect(hasInternalContinuationTrigger(messages)).toBe(true)
      expect(repairAssistantPrefillTail(messages, { model: { providerID: "openai", modelID: "gpt-6-luna" } })).toBe(true)
    })
  })

  describe("#when the model gate is evaluated", () => {
    test("#then only Anthropic-prefill-rejecting prefixes trip it", () => {
      // given / when / then
      expect(shouldRepairAssistantPrefillForModel({ providerID: "anthropic", modelID: "anthropic/claude-opus-4.8" })).toBe(true)
      expect(shouldRepairAssistantPrefillForModel({ providerID: "opencode-go", modelID: "claude-sonnet-4.6" })).toBe(true)
      expect(shouldRepairAssistantPrefillForModel({ providerID: "anthropic", modelID: "claude-sonnet-4-5" })).toBe(false)
      expect(shouldRepairAssistantPrefillForModel({ providerID: "openai", modelID: "claude-opus-4-8" })).toBe(false)
      expect(shouldRepairAssistantPrefillForModel(undefined)).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// Ordered pipeline, reasoning pass-through, and isolation
// ---------------------------------------------------------------------------

describe("#given the ordered pipeline", () => {
  describe("#when an orphan tool call is the only defect", () => {
    test("#then the tool pair is repaired and the report is non-empty", () => {
      // given
      const messages = [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [toolCall("c1")] },
      ]
      // when
      const report = validateAndRepairMessages(messages, { model: { providerID: "openai", modelID: "gpt-6" } })
      // then
      expect(report).toEqual({ toolPairs: ["c1"], prefill: false })
      expect(messages.at(-1).role).toBe("tool")
    })
  })

  describe("#when an assistant tail on a rejecting model is the only defect", () => {
    test("#then the prefill tail is repaired and the report is non-empty", () => {
      // given
      const messages = [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "text", text: "partial" }] },
      ]
      // when
      const report = validateAndRepairMessages(messages, { model: { providerID: "anthropic", modelID: "claude-opus-4-8" } })
      // then
      expect(report).toEqual({ toolPairs: [], prefill: true })
      expect(messages.at(-1).role).toBe("user")
    })
  })

  describe("#when a signed reasoning block is present", () => {
    test("#then reasoning is left byte-identical (no custom thinking effect)", () => {
      // given
      const messages = [
        { role: "assistant", content: [reasoning("plan", "sig-plan"), toolCall("c1")] },
        { role: "tool", content: [toolResult("c1")] },
        { role: "user", content: [{ type: "text", text: "next" }] },
      ]
      const before = sha256(messages)
      // when
      const report = validateAndRepairMessages(messages, { model: { providerID: "anthropic", modelID: "claude-opus-4-8" } })
      // then
      expect(report).toEqual({ toolPairs: [], prefill: false })
      expect(messages[0].content[0]).toEqual(reasoning("plan", "sig-plan"))
      expect(sha256(messages)).toBe(before)
    })
  })

  describe("#when nothing needs repair", () => {
    test("#then the whole history is byte-identical and the report is empty", () => {
      // given
      const messages = [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ]
      const before = sha256(messages)
      // when
      const report = validateAndRepairMessages(messages, { model: { providerID: "openai", modelID: "gpt-6" } })
      // then
      expect(report).toEqual({ toolPairs: [], prefill: false })
      expect(sha256(messages)).toBe(before)
    })
  })

  describe("#when the messages input is not an array", () => {
    test("#then the pipeline degrades to an empty report", () => {
      // given / when / then
      expect(validateAndRepairMessages(null)).toEqual({ toolPairs: [], prefill: false })
    })
  })
})

// ---------------------------------------------------------------------------
// Named RED mutations with byte-identical restore
// ---------------------------------------------------------------------------

describe("#given the tool-pair repair rule", () => {
  describe("#when the rebuilt array is no longer written back", () => {
    test("#then the named contract turns RED and the source is restored byte-identically", async () => {
      // when
      const receipt = await runMutation({
        file: TARGET,
        mutate: (source) => source.replace("    messages.push(...rebuilt)\n", "    void rebuilt\n"),
        contract: {
          name: "tool-pair repair inserts a terminal result for an orphan V2 tool-call",
          run: async ({ load }) => {
            const module = await load()
            const messages = [{ role: "assistant", content: [{ type: "tool-call", id: "c1", name: "read", input: {} }] }]
            module.repairMessageToolPairs(messages)
            const inserted = messages.some((message) => message?.role === "tool" && message.content?.[0]?.id === "c1")
            if (!inserted) throw new Error("expected a terminal tool-result for the orphan tool-call")
          },
        },
      })

      // then
      expect(receipt.contract).toBe("tool-pair repair inserts a terminal result for an orphan V2 tool-call")
      expect(receipt.red).toBe(true)
      expect(receipt.redError).toContain("expected a terminal tool-result")
      expect(receipt.beforeHash).toBe(receipt.afterHash)
    })
  })
})

describe("#given the assistant-prefill rule", () => {
  describe("#when the repair gate is short-circuited to false", () => {
    test("#then the named contract turns RED and the source is restored byte-identically", async () => {
      // when
      const receipt = await runMutation({
        file: TARGET,
        mutate: (source) => source.replace(
          "  const shouldRepair = hasInternalContinuationTrigger(messages) || shouldRepairAssistantPrefillForModel(model)\n",
          "  const shouldRepair = false\n",
        ),
        contract: {
          name: "assistant-prefill repair appends the synthetic recovery turn on a rejecting model",
          run: async ({ load }) => {
            const module = await load()
            const messages = [
              { role: "user", content: [{ type: "text", text: "go" }] },
              { role: "assistant", content: [{ type: "text", text: "partial" }] },
            ]
            const repaired = module.repairAssistantPrefillTail(messages, { model: { providerID: "anthropic", modelID: "claude-opus-4-8" } })
            if (!repaired || messages.at(-1)?.role !== "user") {
              throw new Error("expected a synthetic user recovery turn after the assistant tail")
            }
          },
        },
      })

      // then
      expect(receipt.contract).toBe("assistant-prefill repair appends the synthetic recovery turn on a rejecting model")
      expect(receipt.red).toBe(true)
      expect(receipt.redError).toContain("expected a synthetic user recovery turn")
      expect(receipt.beforeHash).toBe(receipt.afterHash)
    })
  })
})
