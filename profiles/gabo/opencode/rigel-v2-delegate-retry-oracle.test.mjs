/**
 * OQ-5 oracle: is the `rigel_task` result text sufficient for
 * `delegate-task-retry`'s recoverable-error detection?
 *
 * V1 owner cores are imported directly (plain TS, no IO):
 *   packages/delegate-core/src/retry-patterns.ts  -> detectDelegateTaskError
 *   packages/delegate-core/src/retry-guidance.ts  -> buildRetryGuidance
 *
 * The `rigel_task` result shape is produced by the REAL `taskResult` export, not
 * a re-implementation, so the assertions run against the exact bytes the V2
 * runtime hands the model (and, at the `tool.execute.after` seam, the hook).
 *
 * The V2 host surfaces a thrown tool error as `status: "error"` with the message
 * on `event.error` / `event.result.error` (documented in
 * rigel-v2-native-recovery.mjs `recoveryText`). A real host/argument failure is
 * therefore exercised here as the exact message string, since T3 is hermetic and
 * must not drive V2 live.
 */

import { describe, expect, test } from "bun:test"

import { detectDelegateTaskError } from "../../../packages/delegate-core/src/retry-patterns.ts"
import { buildRetryGuidance } from "../../../packages/delegate-core/src/retry-guidance.ts"
import { taskResult } from "./rigel-v2-native-core.mjs"

const CHILD_SESSION = "ses_rigelchild0000000000000001"
const CHILD_AGENT = "explore"

function foregroundChild(result) {
  return taskResult({ sessionID: CHILD_SESSION, agent: CHILD_AGENT, background: false, result })
}

function backgroundChild() {
  return taskResult({ sessionID: CHILD_SESSION, agent: CHILD_AGENT, background: true })
}

// Exact message thrown from rigel-v2-native.mjs when the target is a coordinator.
const V2_COORDINATOR_REJECTION =
  'Cannot delegate to coordinator agent "prometheus" via task. Coordinator agents (prometheus) own the orchestration loop and must not be used as subagent targets - doing so creates duplicate coordinators and conflicting team state. Select a worker agent (e.g., sisyphus-junior via category, hephaestus, oracle) instead.'

describe("#given the real rigel_task taskResult shapes", () => {
  describe("#when a foreground child completed with text", () => {
    test("#then the child text is embedded and no delegate invocation error is classified", () => {
      // given
      const childText = "Found 3 files matching the pattern."
      // when
      const completed = foregroundChild(childText)
      const detected = detectDelegateTaskError(completed.content)
      // then
      expect(completed.metadata).toMatchObject({
        sessionID: CHILD_SESSION,
        agent: CHILD_AGENT,
        background: false,
      })
      expect(completed.content).toContain(childText)
      expect(detected).toBeNull()
    })
  })

  describe("#when a foreground child failed and returned an error-looking text", () => {
    test("#then an unknown error sentence is not classified (no pattern match)", () => {
      // given
      const childText = "[ERROR] provider 500 from upstream"
      // when
      const failed = foregroundChild(childText)
      const detected = detectDelegateTaskError(failed.content)
      // then
      expect(failed.content).toContain("provider 500")
      expect(detected).toBeNull()
    })

    test("#then child text that happens to contain a known pattern is misclassified as a delegate-call error", () => {
      // given: the wrapper is transparent, so a child's own text crosses the gate
      const childText = '[ERROR] Unknown agent: "ghost". Available agents: explore'
      // when
      const spoofed = foregroundChild(childText)
      const detected = detectDelegateTaskError(spoofed.content)
      // then
      expect(detected?.errorType).toBe("unknown_agent")
    })
  })

  describe("#when the delegation is background", () => {
    test("#then the spawn receipt carries no recoverable-error signal", () => {
      // given / when
      const spawned = backgroundChild()
      const detected = detectDelegateTaskError(spawned.content)
      // then
      expect(spawned.metadata).toMatchObject({ background: true })
      expect(detected).toBeNull()
    })
  })
})

describe("#given a foreground child that returned no text", () => {
  describe("#when taskResult shapes the completed delegation", () => {
    test("#then it exposes the empty-child signal the after-hook detector needs", () => {
      // given / when: the wrapper keeps a non-empty lifecycle text, so the
      // detector cannot infer emptiness from `content`; the signal is metadata.
      const empty = foregroundChild("")
      // then
      expect(empty.metadata.childEmpty).toBe(true)
      expect(empty.content).toContain("(The child returned no text.)")
    })

    test("#then a child with text and a background spawn are not flagged empty", () => {
      // given / when
      const withText = foregroundChild("Found 3 files matching the pattern.")
      const spawned = backgroundChild()
      // then
      expect(withText.metadata.childEmpty).toBe(false)
      expect(spawned.metadata.childEmpty).toBe(false)
    })
  })
})

describe("#given the real V2 coordinator rejection thrown from rigel_task.execute", () => {
  describe("#when the thrown message is fed to the detector as the tool error", () => {
    test("#then it is not detectable, with or without an [ERROR] prefix", () => {
      // given / when
      const bare = detectDelegateTaskError(V2_COORDINATOR_REJECTION)
      const prefixed = detectDelegateTaskError(`[ERROR] ${V2_COORDINATOR_REJECTION}`)
      // then
      expect(bare).toBeNull()
      expect(prefixed).toBeNull()
    })

    test("#then the V1 pattern set has no entry for the primary-agent phrasing either", () => {
      // given: the pattern string is "Cannot call primary agent", the emitted text is different
      const emitted = 'Cannot delegate to primary agent "prometheus" via task. Select that agent directly instead.'
      // when
      const detected = detectDelegateTaskError(`[ERROR] ${emitted}`)
      // then
      expect(detected).toBeNull()
    })
  })
})

describe("#given the detector's gate tokens on synthetic host/argument failures", () => {
  describe("#when the message is the exact V1 'Invalid arguments' text for a missing route", () => {
    test("#then it classifies as missing_category_or_agent", () => {
      // given
      const output = "Invalid arguments: Must provide either category or subagent_type."
      // when
      const detected = detectDelegateTaskError(output)
      // then
      expect(detected?.errorType).toBe("missing_category_or_agent")
    })
  })

  describe("#when the message is the exact V1 'Invalid arguments' text for load_skills=null", () => {
    test("#then it classifies as missing_load_skills", () => {
      // given
      const output = "Invalid arguments: load_skills=null is not allowed. Pass [] if no skills needed."
      // when
      const detected = detectDelegateTaskError(output)
      // then
      expect(detected?.errorType).toBe("missing_load_skills")
    })
  })

  describe("#when a bracketed [ERROR] message names a known pattern", () => {
    test("#then unknown_category, unknown_agent, and unknown_skills classify", () => {
      // given
      const samples = [
        ['[ERROR] Unknown category: "invalid-cat". Available: quick, deep-low', "unknown_category"],
        ['[ERROR] Unknown agent: "fake-agent". Available agents: explore, oracle', "unknown_agent"],
        ["[ERROR] Skills not found: nope. Available: git-master", "unknown_skills"],
      ]
      // when / then
      for (const [output, expectedType] of samples) {
        expect(detectDelegateTaskError(output)?.errorType).toBe(expectedType)
      }
    })

    test("#then the mutual-exclusion text classifies before the generic route pattern", () => {
      // given
      const output = "[ERROR] Invalid arguments: Provide EITHER category OR subagent_type, not both."
      // when
      const detected = detectDelegateTaskError(output)
      // then
      expect(detected?.errorType).toBe("mutual_exclusion")
    })
  })
})

describe("#given the raw V1 emitted error strings with no gate token", () => {
  describe("#when the detector receives them verbatim", () => {
    test("#then every one is blocked by the gate and returns null", () => {
      // given: these are the strings the V1 resolvers emit; only the host's
      // thrown '[ERROR]'/'Invalid arguments' framing makes them visible
      const samples = [
        'Unknown category: "invalid-cat". Available: quick, deep-low',
        'Unknown agent: "fake-agent". Available agents: explore, oracle',
        "Skills not found: nope. Available: git-master",
        'Cannot delegate to primary agent "prometheus" via task. Select that agent directly instead.',
      ]
      // when / then
      for (const output of samples) {
        expect(detectDelegateTaskError(output)).toBeNull()
      }
    })
  })
})

describe("#given a detected recoverable error", () => {
  describe("#when guidance is built from the detection result", () => {
    test("#then the errorType propagates into the corrective text", () => {
      // given
      const output = "[ERROR] Unknown category: \"invalid-cat\". Available: quick"
      const detected = detectDelegateTaskError(output)
      // when
      const guidance = buildRetryGuidance(detected)
      // then
      expect(guidance).toContain(detected.errorType)
    })

    test("#then an unknown errorType yields a non-empty fallback distinct from a known one", () => {
      // given
      const unknown = { errorType: "not_a_known_type", originalOutput: "" }
      const known = detectDelegateTaskError("[ERROR] Unknown agent: \"x\". Available agents: explore")
      // when
      const unknownGuidance = buildRetryGuidance(unknown)
      const knownGuidance = buildRetryGuidance(known)
      // then
      expect(unknownGuidance.length).toBeGreaterThan(0)
      expect(unknownGuidance).not.toBe(knownGuidance)
    })
  })
})
