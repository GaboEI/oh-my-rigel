/**
 * Hermetic tests for the Rigel native V2 flow logic.
 *
 * Every behavior is exercised positive AND negative. Where a V1 owner core
 * exists, the test imports the REAL V1 module and pins parity, so upstream drift
 * fails the suite instead of silently diverging. The tool-pair repair is proven
 * idempotent.
 */

import { describe, expect, test } from "bun:test"

import {
  MAX_LABEL_LENGTH,
  NOTEPAD_DIRECTIVE,
  SYSTEM_DIRECTIVE_PREFIX,
  TODOWRITE_DESCRIPTION,
  INTERRUPTED_TOOL_ERROR,
  decideDelegateRetry,
  decideJuniorNotepadInjection,
  decideNotepadWriteBlock,
  decideQuestionLabelTruncation,
  delegateErrorText,
  isNotepadPath,
  isTerminalToolStatus,
  normalizeNotepadPath,
  notepadBlockMessage,
  repairToolParts,
  resolveNotepadFilePath,
  settleToolPart,
  truncateLabel,
  truncateQuestionLabels,
} from "./rigel-v2-flow-logic.mjs"

import { NOTEPAD_DIRECTIVE as V1_NOTEPAD_DIRECTIVE } from "../../../packages/omo-opencode/src/hooks/sisyphus-junior-notepad/constants.ts"
import { TODOWRITE_DESCRIPTION as V1_TODOWRITE_DESCRIPTION } from "../../../packages/omo-opencode/src/hooks/todo-description-override/description.ts"
import { detectDelegateTaskError } from "../../../packages/delegate-core/src/retry-patterns.ts"
import { buildRetryGuidance } from "../../../packages/delegate-core/src/retry-guidance.ts"

// ---------------------------------------------------------------------------
// 1. Notepad path resolution + block message
// ---------------------------------------------------------------------------

describe("#given the notepad write guard", () => {
  describe("#when a Write targets a notepad path", () => {
    test("#then the exact V1 block message is returned", () => {
      // given
      const filePath = ".omo/notepads/plan/learnings.md"
      // when
      const message = decideNotepadWriteBlock("write", { filePath })
      // then
      expect(message).toBe(notepadBlockMessage(filePath))
      expect(message).toContain("append-only")
      expect(message).toContain("Report the original Edit failure")
    })

    test("#then both notepad roots are recognized", () => {
      // given / when / then
      expect(decideNotepadWriteBlock("write", { filePath: ".sisyphus/notepads/x.md" })).not.toBeNull()
      expect(decideNotepadWriteBlock("write", { filePath: ".omo/notepads/x.md" })).not.toBeNull()
    })

    test("#then a nested path under a root is recognized", () => {
      // given / when / then
      expect(isNotepadPath("project/.omo/notepads/plan/issues.md")).toBe(true)
      expect(isNotepadPath(".omo/notepads")).toBe(true)
    })

    test("#then the three accepted arg keys resolve in order", () => {
      // given / when / then
      expect(resolveNotepadFilePath({ filePath: "a" })).toBe("a")
      expect(resolveNotepadFilePath({ path: "b" })).toBe("b")
      expect(resolveNotepadFilePath({ file_path: "c" })).toBe("c")
      expect(resolveNotepadFilePath({ filePath: "a", path: "b" })).toBe("a")
    })
  })

  describe("#when the write is not a notepad path or not a Write", () => {
    test("#then a non-notepad path is not blocked", () => {
      // given / when / then
      expect(decideNotepadWriteBlock("write", { filePath: "src/index.ts" })).toBeNull()
      expect(isNotepadPath("src/notepads-other/x.md")).toBe(false)
    })

    test("#then a non-write tool is not blocked", () => {
      // given / when / then
      expect(decideNotepadWriteBlock("edit", { filePath: ".omo/notepads/x.md" })).toBeNull()
      expect(decideNotepadWriteBlock("read", { filePath: ".omo/notepads/x.md" })).toBeNull()
    })

    test("#then missing or non-string args are not blocked", () => {
      // given / when / then
      expect(decideNotepadWriteBlock("write", {})).toBeNull()
      expect(decideNotepadWriteBlock("write", { filePath: 42 })).toBeNull()
      expect(decideNotepadWriteBlock("write", null)).toBeNull()
    })
  })

  describe("#when normalizing paths", () => {
    test("#then repeated separators and dot segments collapse", () => {
      // given / when / then
      expect(normalizeNotepadPath(".omo//notepads/./x.md")).toBe(".omo/notepads/x.md")
      expect(normalizeNotepadPath("a/../.omo/notepads/x.md")).toBe(".omo/notepads/x.md")
      expect(normalizeNotepadPath("")).toBe("")
    })
  })
})

// ---------------------------------------------------------------------------
// 2. Question-label truncate
// ---------------------------------------------------------------------------

describe("#given the question-label truncator", () => {
  describe("#when a label exceeds the max length", () => {
    test("#then it is cut to 27 chars plus an ellipsis", () => {
      // given
      const long = "x".repeat(40)
      // when
      const truncated = truncateLabel(long)
      // then
      expect(MAX_LABEL_LENGTH).toBe(30)
      expect(truncated.length).toBe(30)
      expect(truncated.endsWith("...")).toBe(true)
      expect(truncated).toBe("x".repeat(27) + "...")
    })

    test("#then a label at exactly the max length is unchanged", () => {
      // given
      const exact = "y".repeat(30)
      // when / then
      expect(truncateLabel(exact)).toBe(exact)
    })
  })

  describe("#when a label is short", () => {
    test("#then it is returned unchanged", () => {
      // given / when / then
      expect(truncateLabel("short")).toBe("short")
      expect(truncateLabel("")).toBe("")
    })
  })

  describe("#when the tool is a question tool with questions", () => {
    test("#then every option label is truncated and other fields preserved", () => {
      // given
      const args = {
        questions: [
          {
            question: "Pick one",
            header: "H",
            options: [
              { label: "a".repeat(40), description: "keep me" },
              { label: "short" },
            ],
          },
        ],
      }
      // when
      const result = decideQuestionLabelTruncation("askuserquestion", args)
      // then
      expect(result).not.toBeNull()
      expect(result.questions[0].question).toBe("Pick one")
      expect(result.questions[0].options[0].description).toBe("keep me")
      expect(result.questions[0].options[0].label).toBe("a".repeat(27) + "...")
      expect(result.questions[0].options[1].label).toBe("short")
    })

    test("#then the snake_case tool name is also accepted", () => {
      // given / when / then
      expect(decideQuestionLabelTruncation("ask_user_question", { questions: [] })).not.toBeNull()
    })
  })

  describe("#when the tool is not a question tool or questions are absent", () => {
    test("#then a different tool is not truncated", () => {
      // given / when / then
      expect(decideQuestionLabelTruncation("bash", { questions: [] })).toBeNull()
    })

    test("#then missing questions is not truncated", () => {
      // given / when / then
      expect(decideQuestionLabelTruncation("askuserquestion", {})).toBeNull()
      expect(decideQuestionLabelTruncation("askuserquestion", { questions: "nope" })).toBeNull()
    })

    test("#then truncateQuestionLabels returns args unchanged when questions is not an array", () => {
      // given
      const args = { other: 1 }
      // when / then
      expect(truncateQuestionLabels(args)).toBe(args)
    })
  })
})

// ---------------------------------------------------------------------------
// 3. Sisyphus-junior notepad directive decision
// ---------------------------------------------------------------------------

describe("#given the sisyphus-junior notepad directive", () => {
  describe("#when the caller is the orchestrator and the prompt is clean", () => {
    test("#then the directive is prepended", () => {
      // given
      const prompt = "Do the work."
      // when
      const result = decideJuniorNotepadInjection({ tool: "task", isOrchestrator: true, prompt })
      // then
      expect(result).toBe(NOTEPAD_DIRECTIVE + prompt)
      expect(result.startsWith(NOTEPAD_DIRECTIVE)).toBe(true)
    })

    test("#then the ported directive is byte-identical to the V1 owner", () => {
      // given / when / then
      expect(NOTEPAD_DIRECTIVE).toBe(V1_NOTEPAD_DIRECTIVE)
    })
  })

  describe("#when the injection must be skipped", () => {
    test("#then a non-orchestrator caller is skipped", () => {
      // given / when / then
      expect(decideJuniorNotepadInjection({ tool: "task", isOrchestrator: false, prompt: "x" })).toBeNull()
    })

    test("#then a non-task tool is skipped", () => {
      // given / when / then
      expect(decideJuniorNotepadInjection({ tool: "bash", isOrchestrator: true, prompt: "x" })).toBeNull()
    })

    test("#then an empty prompt is skipped", () => {
      // given / when / then
      expect(decideJuniorNotepadInjection({ tool: "task", isOrchestrator: true, prompt: "" })).toBeNull()
      expect(decideJuniorNotepadInjection({ tool: "task", isOrchestrator: true })).toBeNull()
    })

    test("#then a prompt already carrying the system directive is skipped", () => {
      // given
      const prompt = `${SYSTEM_DIRECTIVE_PREFIX} - TODO CONTINUATION] do it`
      // when / then
      expect(decideJuniorNotepadInjection({ tool: "task", isOrchestrator: true, prompt })).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// 4. Todo-description override text
// ---------------------------------------------------------------------------

describe("#given the todo-description override text", () => {
  test("#when compared to the V1 owner #then it is byte-identical", () => {
    // given / when / then
    expect(TODOWRITE_DESCRIPTION).toBe(V1_TODOWRITE_DESCRIPTION)
  })

  test("#when inspected #then it carries the machine-consumed schema contract tokens", () => {
    // given / when / then
    expect(TODOWRITE_DESCRIPTION).toContain("`content`: string")
    expect(TODOWRITE_DESCRIPTION).toContain("`status`: string")
    expect(TODOWRITE_DESCRIPTION).toContain("`priority`: string")
  })
})

// ---------------------------------------------------------------------------
// 5. Tool-pair repair
// ---------------------------------------------------------------------------

function toolPart(callID, status, extra = {}) {
  return {
    type: "tool",
    callID,
    state: {
      status,
      input: { command: "ls" },
      time: { start: 1000 },
      ...extra,
    },
  }
}

describe("#given the tool-pair repair", () => {
  describe("#when a part is non-terminal", () => {
    test("#then it is settled to error with the exact message and input preserved", () => {
      // given
      const part = toolPart("call_1", "running")
      // when
      const repaired = repairToolParts({ parts: [part] })
      // then
      expect(repaired).toEqual(["call_1"])
      expect(part.state.status).toBe("error")
      expect(part.state.error).toBe(INTERRUPTED_TOOL_ERROR)
      expect(part.state.input).toEqual({ command: "ls" })
      expect(part.state.time.start).toBe(1000)
    })

    test("#then a pending part is also settled", () => {
      // given
      const part = toolPart("call_2", "pending")
      // when / then
      expect(repairToolParts({ parts: [part] })).toEqual(["call_2"])
      expect(part.state.status).toBe("error")
    })
  })

  describe("#when a part is already terminal", () => {
    test("#then completed and error parts are left untouched", () => {
      // given
      const completed = toolPart("call_3", "completed")
      const errored = toolPart("call_4", "error", { error: "original" })
      // when
      const repaired = repairToolParts({ parts: [completed, errored] })
      // then
      expect(repaired).toEqual([])
      expect(completed.state.status).toBe("completed")
      expect(errored.state.error).toBe("original")
    })
  })

  describe("#when repair runs twice", () => {
    test("#then the second pass is a no-op (idempotent)", () => {
      // given
      const part = toolPart("call_5", "running")
      const message = { parts: [part] }
      // when
      const first = repairToolParts(message)
      const snapshot = JSON.stringify(part)
      const second = repairToolParts(message)
      // then
      expect(first).toEqual(["call_5"])
      expect(second).toEqual([])
      expect(JSON.stringify(part)).toBe(snapshot)
    })
  })

  describe("#when the message has no repairable parts", () => {
    test("#then non-tool parts and missing call ids are skipped", () => {
      // given
      const message = { parts: [{ type: "text", text: "hi" }, { type: "tool", state: { status: "running" } }] }
      // when / then
      expect(repairToolParts(message)).toEqual([])
    })

    test("#then a non-object message yields an empty list", () => {
      // given / when / then
      expect(repairToolParts(null)).toEqual([])
      expect(repairToolParts({})).toEqual([])
    })
  })

  describe("#when checking terminal status", () => {
    test("#then only completed and error are terminal", () => {
      // given / when / then
      expect(isTerminalToolStatus("completed")).toBe(true)
      expect(isTerminalToolStatus("error")).toBe(true)
      expect(isTerminalToolStatus("running")).toBe(false)
      expect(isTerminalToolStatus("pending")).toBe(false)
    })
  })

  describe("#when settling a part without a state", () => {
    test("#then it is not settled", () => {
      // given / when / then
      expect(settleToolPart({ type: "tool", callID: "x" })).toBe(false)
      expect(settleToolPart(null)).toBe(false)
    })
  })
})

describe("#given the delegate-retry glue", () => {
  describe("#when the event is not an error", () => {
    test("#then no action is taken on a success event", () => {
      // given
      const event = { status: "completed", result: { content: "[ERROR] Unknown agent: x" } }
      // when
      const decision = decideDelegateRetry(event, { detect: detectDelegateTaskError, buildGuidance: buildRetryGuidance })
      // then
      expect(decision.action).toBe("none")
      expect(delegateErrorText(event)).toBe("")
    })

    test("#then a child-text pattern on a success result is never classified", () => {
      // given: the T3 false-positive case, on the content channel
      const event = { status: "completed", result: { content: '[ERROR] Unknown agent: "ghost". Available agents: explore' } }
      // when
      const decision = decideDelegateRetry(event, { detect: detectDelegateTaskError, buildGuidance: buildRetryGuidance })
      // then
      expect(decision.action).toBe("none")
    })
  })

  describe("#when the error channel carries a V1 pattern", () => {
    test("#then specific guidance is produced via buildRetryGuidance", () => {
      // given
      const event = { status: "error", error: '[ERROR] Unknown agent: "fake". Available agents: explore' }
      // when
      const decision = decideDelegateRetry(event, { detect: detectDelegateTaskError, buildGuidance: buildRetryGuidance })
      // then
      expect(decision.action).toBe("guidance")
      expect(decision.text).toContain("unknown_agent")
    })
  })

  describe("#when the error channel has no matching pattern", () => {
    test("#then a generic announce is produced", () => {
      // given: the real V2 coordinator rejection, which has no V1 pattern
      const event = { status: "error", error: 'Cannot delegate to coordinator agent "prometheus" via task.' }
      // when
      const decision = decideDelegateRetry(event, { detect: detectDelegateTaskError, buildGuidance: buildRetryGuidance })
      // then
      expect(decision.action).toBe("announce")
      expect(decision.text).toContain("retry")
    })
  })

  describe("#when the matched pattern is missing_run_in_background", () => {
    test("#then it is dropped and the generic announce is used", () => {
      // given
      const event = { status: "error", error: "[ERROR] run_in_background is required" }
      // when
      const decision = decideDelegateRetry(event, { detect: detectDelegateTaskError, buildGuidance: buildRetryGuidance })
      // then
      expect(decision.action).toBe("announce")
    })
  })

  describe("#when the error message lives on nested fields", () => {
    test("#then event.error.message and result.error are read", () => {
      // given / when / then
      expect(delegateErrorText({ status: "error", error: { message: "boom" } })).toBe("boom")
      expect(delegateErrorText({ status: "error", result: { error: "boom2" } })).toBe("boom2")
    })
  })
})

// P2a corrections: the real V2 failure/event forms the live probes pinned.
describe("#given the P2a flow-logic corrections", () => {
  describe("#when the real delegation failure form carries result.error with empty content", () => {
    test("#then it is treated as an error without a top-level status", () => {
      // given / when / then
      expect(delegateErrorText({ tool: "rigel_task", result: { error: "provider.no-route", content: [] } })).toContain("provider.no-route")
      expect(decideDelegateRetry({ result: { error: { message: "boom" }, content: [] } }).action).toBe("announce")
    })
  })

  describe("#when a delegation succeeded", () => {
    test("#then neither a completed status nor a text result yields guidance", () => {
      // given / when / then
      expect(delegateErrorText({ status: "completed", result: { content: [{ type: "text", text: "ok" }] } })).toBe("")
      expect(decideDelegateRetry({ status: "completed", result: { content: [{ type: "text", text: "ok" }] } }).action).toBe("none")
    })
  })

  describe("#when the V2 question tool is called", () => {
    test("#then its long labels are truncated like the V1 question tool", () => {
      // given / when / then
      const truncated = decideQuestionLabelTruncation("question", { questions: [{ options: [{ label: "z".repeat(31) }] }] })
      expect(truncated.questions[0].options[0].label.length).toBe(30)
      expect(decideQuestionLabelTruncation("bash", { questions: [] })).toBeNull()
    })
  })
})
