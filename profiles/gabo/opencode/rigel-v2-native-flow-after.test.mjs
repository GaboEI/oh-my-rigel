/**
 * Hermetic tests for the native V2 `tool.execute.after` binders.
 *
 * Every behavior is exercised positive AND negative. The delegate-retry
 * detector/guidance port is compared against the REAL V1 cores
 * (`packages/delegate-core/src/retry-{patterns,guidance}.ts`) so upstream drift
 * fails the suite. The fsync cases use explicit numeric timestamps, so the
 * before/after watermark is deterministic and no wall clock is involved.
 */

import { describe, expect, test } from "bun:test"

import {
  afterRules,
  createDelegateTaskRetryRule,
} from "./rigel-v2-native-flow-after.mjs"
import {
  buildRetryGuidance as portedBuildRetryGuidance,
  detectDelegateTaskError as portedDetectDelegateTaskError,
} from "./rigel-v2-delegate-retry-core.mjs"
import { detectDelegateTaskError as v1DetectDelegateTaskError } from "../../../packages/delegate-core/src/retry-patterns.ts"
import { buildRetryGuidance as v1BuildRetryGuidance } from "../../../packages/delegate-core/src/retry-guidance.ts"

// ---------------------------------------------------------------------------
// 0. V1 differential parity for the ported detector + guidance
// ---------------------------------------------------------------------------

describe("#given the ported delegate-retry core", () => {
  describe("#when the detector runs over a V1 corpus", () => {
    test("#then it classifies identically to the real V1 core", () => {
      // given
      const corpus = [
        '[ERROR] Unknown category: "invalid-cat". Available: quick, deep-low',
        '[ERROR] Unknown agent: "fake-agent". Available agents: explore, oracle',
        "[ERROR] Skills not found: nope. Available: git-master",
        "[ERROR] Invalid arguments: Provide EITHER category OR subagent_type, not both.",
        "Invalid arguments: Must provide either category or subagent_type.",
        "Invalid arguments: load_skills=null is not allowed. Pass [] if no skills needed.",
        "[ERROR] Agent name cannot be empty",
        "[ERROR] Cannot call primary agent \"x\"",
        "[ERROR] provider 500 from upstream",
        'Unknown category: "x". Available: quick',
        "all good, nothing to see",
      ]
      // when / then
      for (const output of corpus) {
        const ours = portedDetectDelegateTaskError(output)
        const v1 = v1DetectDelegateTaskError(output)
        expect(ours?.errorType ?? null).toBe(v1?.errorType ?? null)
      }
    })

    test("#then a non-string input degrades to null instead of throwing", () => {
      // given / when / then
      expect(portedDetectDelegateTaskError(undefined)).toBeNull()
      expect(portedDetectDelegateTaskError(null)).toBeNull()
    })
  })

  describe("#when guidance is built for every detected class", () => {
    test("#then the text is byte-identical to the real V1 core", () => {
      // given
      const corpus = [
        '[ERROR] Unknown category: "invalid-cat". Available: quick, deep-low',
        '[ERROR] Unknown agent: "fake-agent". Available agents: explore, oracle',
        "[ERROR] Skills not found: nope. Available: git-master",
      ]
      // when / then
      for (const output of corpus) {
        const detected = v1DetectDelegateTaskError(output)
        expect(portedBuildRetryGuidance(detected)).toBe(v1BuildRetryGuidance(detected))
      }
    })

    test("#then an unknown errorType falls back to the same V1 string", () => {
      // given
      const unknown = { errorType: "not_a_known_type", originalOutput: "" }
      // when / then
      expect(portedBuildRetryGuidance(unknown)).toBe(v1BuildRetryGuidance(unknown))
    })
  })
})

// ---------------------------------------------------------------------------
// 1. delegate-task-retry: error channel only
// ---------------------------------------------------------------------------

function taskErrorEvent(errorText) {
  return { id: "call-1", tool: "rigel_task", status: "error", error: errorText, result: { content: [] } }
}

describe("#given the delegate-task-retry after rule", () => {
  describe("#when the error channel fires with a V1-detectable pattern", () => {
    test("#then the V1-specific guidance is appended to the mutable content", () => {
      // given
      const errorText = '[ERROR] Unknown category: "invalid-cat". Available: quick, deep-low'
      const event = taskErrorEvent(errorText)
      // when
      const appended = createDelegateTaskRetryRule().run(event)
      // then
      const expected = `\n${v1BuildRetryGuidance(v1DetectDelegateTaskError(errorText))}`
      expect(appended).toBe(true)
      expect(event.result.content).toHaveLength(1)
      expect(event.result.content[0].type).toBe("text")
      expect(event.result.content[0].text).toBe(expected)
      expect(event.result.content[0].text).toContain("[task CALL FAILED")
      expect(event.result.content[0].text).toContain("unknown_category")
    })

    test("#then the exported afterRules default wires the same behavior", () => {
      // given
      const event = taskErrorEvent("[ERROR] Unknown agent: \"ghost\". Available agents: explore")
      // when
      const appended = afterRules[0].run(event)
      // then
      expect(appended).toBe(true)
      expect(event.result.content[0].text).toContain("unknown_agent")
    })
  })

  describe("#when a success or background spawn completes", () => {
    test("#then nothing is appended for a completed tool call", () => {
      // given
      const event = { id: "call-2", tool: "rigel_task", status: "completed", result: { content: [{ type: "text", text: "done" }] } }
      // when
      const appended = afterRules[0].run(event)
      // then
      expect(appended).toBe(false)
      expect(event.result.content).toHaveLength(1)
    })

    test("#then nothing is appended for a background spawn receipt", () => {
      // given
      const event = {
        id: "call-3",
        tool: "rigel_task",
        status: "completed",
        result: { content: [{ type: "text", text: "The subagent is working in the background. sessionID: ses_x" }] },
      }
      // when
      const appended = createDelegateTaskRetryRule().run(event)
      // then
      expect(appended).toBe(false)
      expect(event.result.content).toHaveLength(1)
    })
  })

  describe("#when the error channel fires without a V1 pattern match", () => {
    test("#then the generic announce/recover notice is appended, not specific guidance", () => {
      // given
      const event = taskErrorEvent("[ERROR] provider 500 from upstream")
      // when
      const appended = createDelegateTaskRetryRule().run(event)
      // then
      expect(appended).toBe(true)
      expect(event.result.content[0].text).toContain("Correct the call and retry")
      expect(event.result.content[0].text).not.toContain("[task CALL FAILED")
    })

    test("#then a coordinator rejection with no gate token also announces generically", () => {
      // given
      const event = taskErrorEvent('Cannot delegate to coordinator agent "prometheus" via task.')
      // when
      const appended = createDelegateTaskRetryRule().run(event)
      // then
      expect(appended).toBe(true)
      expect(event.result.content[0].text).toContain("Correct the call and retry")
    })

    test("#then a missing_run_in_background match is dropped to the generic notice", () => {
      // given
      const event = taskErrorEvent("[ERROR] run_in_background is required")
      // when
      const appended = createDelegateTaskRetryRule().run(event)
      // then
      expect(appended).toBe(true)
      expect(event.result.content[0].text).not.toContain("[task CALL FAILED")
    })
  })
})

// ---------------------------------------------------------------------------
// 2. read-image-resizer: NO-GO, explicitly not wired
// ---------------------------------------------------------------------------

describe("#given the read-image-resizer T10 NO-GO verdict", () => {
  describe("#when the after rule set is inspected", () => {
    test("#then no resizer rule, mock, or stub is present", () => {
      // given / when
      const names = afterRules.map((rule) => rule.name)
      const resizerNames = names.filter((name) => /resiz|image/i.test(name))
      // then
      expect(Array.isArray(afterRules)).toBe(true)
      expect(resizerNames).toEqual([])
      expect(names).toEqual(["delegate-task-retry"])
    })
  })
})
