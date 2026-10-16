/**
 * Hermetic tests for the native V2 `tool.execute.before` flow guard binders.
 *
 * Every rule is driven through a V2-shaped event `{ tool, sessionID, input }`
 * (T1: the caller is `event.agent`, the arguments are `event.input`). The
 * mutating rules are asserted by observing `event.input` after the run, which is
 * the behavior T1 proved propagates to the executing tool. Composition is
 * proven through the real `runOrderedRules` chain.
 */

import { describe, expect, test } from "bun:test"

import {
  DEFAULT_DELEGATION_TOOL_NAME,
  ORCHESTRATOR_AGENT,
  beforeRules,
  createSisyphusJuniorNotepadRule,
  notepadWriteGuard,
  questionLabelTruncator,
  resolveDelegationToolName,
  sisyphusJuniorNotepad,
} from "./rigel-v2-native-flow-guards.mjs"
import { NOTEPAD_DIRECTIVE, SYSTEM_DIRECTIVE_PREFIX, notepadBlockMessage } from "./rigel-v2-flow-logic.mjs"
import { runOrderedRules } from "./rigel-v2-native-hook-chain.mjs"

function beforeEvent(tool, input, extra = {}) {
  return { tool, sessionID: "ses_flow", input, ...extra }
}

function catchThrown(run) {
  try {
    run()
    return undefined
  } catch (error) {
    return error
  }
}

// ---------------------------------------------------------------------------
// 1. notepad-write-guard
// ---------------------------------------------------------------------------

describe("#given the notepad write guard binder", () => {
  describe("#when a write targets a notepad root", () => {
    test("#then it throws the exact V1 block message for the resolved path", () => {
      // given
      const filePath = ".omo/notepads/plan/learnings.md"
      // when
      const error = catchThrown(() => notepadWriteGuard.run(beforeEvent("write", { filePath })))
      // then
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toBe(notepadBlockMessage(filePath))
    })

    test("#then it resolves the path and file_path argument keys too", () => {
      // given / when / then
      expect(catchThrown(() => notepadWriteGuard.run(beforeEvent("write", { path: ".sisyphus/notepads/x/a.md" })))).toBeInstanceOf(Error)
      expect(catchThrown(() => notepadWriteGuard.run(beforeEvent("write", { file_path: ".omo/notepads/a.md" })))).toBeInstanceOf(Error)
    })

    test("#then the tool name match is case-insensitive", () => {
      // given / when / then
      expect(catchThrown(() => notepadWriteGuard.run(beforeEvent("Write", { filePath: ".omo/notepads/a.md" })))).toBeInstanceOf(Error)
    })
  })

  describe("#when the write is allowed", () => {
    test("#then a write outside every notepad root passes", () => {
      // given / when
      const error = catchThrown(() => notepadWriteGuard.run(beforeEvent("write", { filePath: "packages/omo-opencode/src/index.ts" })))
      // then
      expect(error).toBeUndefined()
    })

    test("#then a non-write tool onto a notepad path passes", () => {
      // given / when / then
      expect(catchThrown(() => notepadWriteGuard.run(beforeEvent("edit", { filePath: ".omo/notepads/a.md" })))).toBeUndefined()
    })

    test("#then a write with no path argument passes", () => {
      // given / when / then
      expect(catchThrown(() => notepadWriteGuard.run(beforeEvent("write", {})))).toBeUndefined()
    })
  })
})

// ---------------------------------------------------------------------------
// 2. question-label-truncator
// ---------------------------------------------------------------------------

describe("#given the question label truncator binder", () => {
  describe("#when a question option label exceeds the V1 maximum", () => {
    test("#then the label is mutated in place to 27 chars plus ellipsis", () => {
      // given
      const event = beforeEvent("askuserquestion", {
        questions: [{ question: "Pick", options: [{ label: "x".repeat(40), value: "v" }] }],
      })
      // when
      questionLabelTruncator.run(event)
      // then
      expect(event.input.questions[0].options[0].label).toBe(`${"x".repeat(27)}...`)
      expect(event.input.questions[0].options[0].value).toBe("v")
    })

    test("#then the ask_user_question alias is truncated the same way", () => {
      // given
      const event = beforeEvent("ask_user_question", { questions: [{ options: [{ label: "y".repeat(31) }] }] })
      // when
      questionLabelTruncator.run(event)
      // then
      expect(event.input.questions[0].options[0].label.length).toBe(30)
    })

    test("#then the real V2 `question` tool name is truncated the same way", () => {
      // given: the V2 runtime registers the question surface as `question`
      const event = beforeEvent("question", { questions: [{ options: [{ label: "q".repeat(31) }] }] })
      // when
      questionLabelTruncator.run(event)
      // then
      expect(event.input.questions[0].options[0].label.length).toBe(30)
    })
  })

  describe("#when truncation does not apply", () => {
    test("#then a label within the maximum keeps its value", () => {
      // given
      const event = beforeEvent("askuserquestion", { questions: [{ options: [{ label: "short" }] }] })
      // when
      questionLabelTruncator.run(event)
      // then
      expect(event.input.questions[0].options[0].label).toBe("short")
    })

    test("#then a non-question tool leaves the input untouched", () => {
      // given
      const event = beforeEvent("bash", { questions: [{ options: [{ label: "z".repeat(40) }] }] })
      // when
      questionLabelTruncator.run(event)
      // then
      expect(event.input.questions[0].options[0].label).toBe("z".repeat(40))
    })

    test("#then missing questions leaves the input untouched", () => {
      // given
      const event = beforeEvent("askuserquestion", { other: 1 })
      // when
      questionLabelTruncator.run(event)
      // then
      expect(event.input).toEqual({ other: 1 })
    })
  })
})

// ---------------------------------------------------------------------------
// 3. sisyphus-junior-notepad
// ---------------------------------------------------------------------------

describe("#given the sisyphus-junior notepad binder", () => {
  describe("#when the orchestrator delegates through the runtime task tool", () => {
    test("#then the notepad directive is prepended to the prompt in place", () => {
      // given
      const event = beforeEvent("rigel_task", { prompt: "Do the work." }, { agent: ORCHESTRATOR_AGENT })
      // when
      sisyphusJuniorNotepad.run(event)
      // then
      expect(event.input.prompt).toBe(NOTEPAD_DIRECTIVE + "Do the work.")
    })

    test("#then a canonicalized display name for the orchestrator still matches", () => {
      // given
      const event = beforeEvent("rigel_task", { prompt: "Run." }, { agent: "Atlas - Plan Executor" })
      // when
      sisyphusJuniorNotepad.run(event)
      // then
      expect(event.input.prompt.startsWith(NOTEPAD_DIRECTIVE)).toBe(true)
    })
  })

  describe("#when the injection must be skipped", () => {
    test("#then a non-orchestrator caller is left untouched", () => {
      // given
      const event = beforeEvent("rigel_task", { prompt: "Do it." }, { agent: "sisyphus" })
      // when
      sisyphusJuniorNotepad.run(event)
      // then
      expect(event.input.prompt).toBe("Do it.")
    })

    test("#then the V1 task name is not matched by the default runtime name", () => {
      // given
      const event = beforeEvent("task", { prompt: "Do it." }, { agent: ORCHESTRATOR_AGENT })
      // when
      sisyphusJuniorNotepad.run(event)
      // then
      expect(event.input.prompt).toBe("Do it.")
    })

    test("#then a prompt already carrying the system directive is skipped", () => {
      // given
      const prompt = `${SYSTEM_DIRECTIVE_PREFIX} - TODO CONTINUATION] go`
      const event = beforeEvent("rigel_task", { prompt }, { agent: ORCHESTRATOR_AGENT })
      // when
      sisyphusJuniorNotepad.run(event)
      // then
      expect(event.input.prompt).toBe(prompt)
    })

    test("#then an empty prompt and a missing input are skipped", () => {
      // given
      const empty = beforeEvent("rigel_task", { prompt: "" }, { agent: ORCHESTRATOR_AGENT })
      const missing = beforeEvent("rigel_task", undefined, { agent: ORCHESTRATOR_AGENT })
      // when / then
      expect(catchThrown(() => sisyphusJuniorNotepad.run(empty))).toBeUndefined()
      expect(empty.input.prompt).toBe("")
      expect(catchThrown(() => sisyphusJuniorNotepad.run(missing))).toBeUndefined()
    })
  })

  describe("#when RIGEL_NATIVE_TASK_NAME renames the runtime tool", () => {
    test("#then the injected name is matched and the default name is not", () => {
      // given
      const rule = createSisyphusJuniorNotepadRule({ taskToolName: "custom_task" })
      const renamed = beforeEvent("custom_task", { prompt: "Go." }, { agent: ORCHESTRATOR_AGENT })
      const defaultName = beforeEvent("rigel_task", { prompt: "Go." }, { agent: ORCHESTRATOR_AGENT })
      // when
      rule.run(renamed)
      rule.run(defaultName)
      // then
      expect(renamed.input.prompt).toBe(NOTEPAD_DIRECTIVE + "Go.")
      expect(defaultName.input.prompt).toBe("Go.")
    })

    test("#then resolveDelegationToolName reads the override and falls back", () => {
      // given / when / then
      expect(resolveDelegationToolName({})).toBe(DEFAULT_DELEGATION_TOOL_NAME)
      expect(resolveDelegationToolName({ RIGEL_NATIVE_TASK_NAME: "custom_task" })).toBe("custom_task")
      expect(resolveDelegationToolName({ RIGEL_NATIVE_TASK_NAME: "" })).toBe(DEFAULT_DELEGATION_TOOL_NAME)
    })
  })
})

// ---------------------------------------------------------------------------
// 4. Composition through runOrderedRules
// ---------------------------------------------------------------------------

describe("#given the exported beforeRules array", () => {
  test("#when inspected #then it carries the three named rules in declared order", () => {
    // given / when / then
    expect(Object.isFrozen(beforeRules)).toBe(true)
    expect(beforeRules.map((rule) => rule.name)).toEqual([
      "notepad-write-guard",
      "question-label-truncator",
      "sisyphus-junior-notepad",
    ])
  })

  test("#when the chain runs #then every rule executes and mutations persist", async () => {
    // given
    const event = beforeEvent("rigel_task", { prompt: "Work." }, { agent: ORCHESTRATOR_AGENT })
    // when
    const report = await runOrderedRules(beforeRules, event)
    // then
    expect(report.failures).toEqual([])
    expect(report.executed).toEqual([
      "notepad-write-guard",
      "question-label-truncator",
      "sisyphus-junior-notepad",
    ])
    expect(event.input.prompt.startsWith(NOTEPAD_DIRECTIVE)).toBe(true)
  })

  test("#when a blocked write throws #then the failure is isolated and later rules still run", async () => {
    // given
    const event = beforeEvent("write", { filePath: ".omo/notepads/x.md" })
    // when
    const report = await runOrderedRules(beforeRules, event)
    // then
    expect(report.failures.map((failure) => failure.name)).toEqual(["notepad-write-guard"])
    expect(report.executed).toEqual(["question-label-truncator", "sisyphus-junior-notepad"])
  })

  test("#when the chain is empty #then it resolves with an empty report", async () => {
    // given / when
    const report = await runOrderedRules([], beforeEvent("read", {}))
    // then
    expect(report).toEqual({ failures: [], executed: [] })
  })
})
