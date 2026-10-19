/**
 * Wiring contract for the native V2 file-edit guidance (V1 `gpt-apply-patch-guard`).
 *
 * The pure selector is owned by `rigel-v2-native-gpt-edit-guidance.test.mjs`.
 * This file guards the real boundary: `createNativeContextHook` must inject the
 * guidance on the system channel for a GPT-family model and must NOT inject it
 * for a non-GPT model, and the injection must stay a single marker-wrapped block
 * across repeated passes.
 *
 * It also guards the `onGptEditGuidance` receipt: the callback fires once per
 * injection, carries the hash and length of exactly the block that was pushed,
 * never fires for a non-GPT model, and contributes no system bytes of its own.
 */
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"

import { createNativeContextHook } from "./rigel-v2-native-prompt.mjs"
import { GPT_EDIT_GUIDANCE_MARKER, GPT_PATCH_ONLY_GUIDANCE, gptEditGuidanceBlock } from "./rigel-v2-native-gpt-edit-guidance.mjs"

function buildHook(onGptEditGuidance) {
  return createNativeContextHook({
    getDelegationRoster: async () => [{ name: "Explore", mode: "subagent" }],
    categories: [],
    ...(onGptEditGuidance ? { onGptEditGuidance } : {}),
  })
}

function buildEvent(modelID, providerID = "openai") {
  return {
    sessionID: "ses_gpt_guidance",
    agent: "Sisyphus",
    model: { providerID, modelID },
    system: [{ type: "text", text: "base system" }],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: {},
    options: {},
  }
}

function guidanceParts(event) {
  return (event.system ?? []).filter((part) => typeof part?.text === "string" && part.text.includes(GPT_EDIT_GUIDANCE_MARKER))
}

function textParts(event) {
  return (event.system ?? []).filter((part) => part?.type === "text").map((part) => part.text)
}

// Provider-prefixed runtime ids, exactly as V2 hands them to the hook on
// `event.model`, so the receipt's echoed provider and model are pinned.
const GPT_RECEIPT_CASES = [
  { modelID: "openai/gpt-5.6-sol", providerID: "openai" },
  { modelID: "opencode-go/gpt-6-luna", providerID: "opencode-go" },
  { modelID: "openai/gpt-5-codex", providerID: "openai" },
]

// `o2` is the family-rule boundary: `o1`/`o3`/`o4` are GPT-family, `o2` is not.
const NON_GPT_MODELS = ["anthropic/claude-opus-5-5", "opencode-go/deepseek-v4.1-flash", "openai/o2"]

describe("#given the native V2 context hook", () => {
  describe("#when the runtime model is a GPT family model", () => {
    test("#then it injects exactly one marker-wrapped file-edit guidance block", async () => {
      const hook = buildHook()
      const event = buildEvent("openai/gpt-5.6-sol")
      await hook(event)
      const parts = guidanceParts(event)
      expect(parts.length).toBe(1)
      expect(parts[0].text).toContain(GPT_PATCH_ONLY_GUIDANCE)
    })

    test("#when the hook runs twice #then the guidance stays a single block", async () => {
      const hook = buildHook()
      const event = buildEvent("openai/gpt-5.6-sol")
      await hook(event)
      await hook(event)
      expect(guidanceParts(event).length).toBe(1)
    })
  })

  describe("#when the runtime model is not a GPT family model", () => {
    test("#then it injects no file-edit guidance", async () => {
      const hook = buildHook()
      const event = buildEvent("anthropic/claude-opus-5-5")
      await hook(event)
      expect(guidanceParts(event).length).toBe(0)
    })
  })

  describe("#when the injected guidance is reported for a receipt", () => {
    test("#then the report carries the hash and length of exactly the pushed block", async () => {
      for (const { modelID, providerID } of GPT_RECEIPT_CASES) {
        const expected = gptEditGuidanceBlock(modelID)
        const observed = []
        const event = buildEvent(modelID, providerID)
        await buildHook((report) => observed.push(report))(event)
        // Wrapped per case so a failure names the model that broke.
        expect({ modelID, reports: observed }).toEqual({
          modelID,
          reports: [{
            agent: "Sisyphus",
            providerID,
            modelID,
            contentSha256: createHash("sha256").update(expected).digest("hex"),
            contentLength: expected.length,
          }],
        })
        // The receipt describes the bytes the hook actually put on the system channel.
        expect(guidanceParts(event).map((part) => part.text)).toEqual([expected])
        // The receipt must never carry the guidance body or the user message.
        expect(JSON.stringify(observed)).not.toContain("hello")
      }
    })

    test("#when the model is not GPT #then nothing is reported", async () => {
      for (const modelID of NON_GPT_MODELS) {
        const observed = []
        const event = buildEvent(modelID)
        await buildHook((report) => observed.push(report))(event)
        expect({ modelID, reports: observed }).toEqual({ modelID, reports: [] })
      }
    })

    test("#then attaching the receipt callback leaves the injected system bytes identical", async () => {
      const { modelID, providerID } = GPT_RECEIPT_CASES[1]
      const withReceipt = buildEvent(modelID, providerID)
      const withoutReceipt = buildEvent(modelID, providerID)
      const reported = []
      // Observation only: the pushed bytes are set before the callback runs, so a
      // value it hands back must not change the system channel.
      await buildHook((report) => {
        reported.push(report)
        return "ignored by the injection site"
      })(withReceipt)
      await buildHook()(withoutReceipt)
      expect(reported.length).toBe(1)
      expect(textParts(withReceipt)).toEqual(textParts(withoutReceipt))
      expect(textParts(withoutReceipt)).toContain(gptEditGuidanceBlock(modelID))
      expect(guidanceParts(withReceipt).map((part) => part.text)).toEqual([gptEditGuidanceBlock(modelID)])
    })
  })
})
