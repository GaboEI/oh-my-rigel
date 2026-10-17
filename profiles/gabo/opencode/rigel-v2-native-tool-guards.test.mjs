import { describe, expect, test } from "bun:test"
import {
  BASH_FILE_READ_WARNING,
  DEFAULT_MAX_TOKENS,
  EMPTY_TASK_RESPONSE_WARNING,
  TRUNCATABLE_TOOLS,
  WEBFETCH_MAX_TOKENS,
  createBashFileReadGuardRule,
  createEmptyTaskResponseRule,
  createToolOutputTruncatorRule,
  isSimpleFileReadCommand,
  resultText,
  truncateToTokenLimit,
} from "./rigel-v2-native-tool-guards.mjs"
import { taskResult } from "./rigel-v2-native-core.mjs"

const estimateTokens = (text) => Math.ceil(text.length / 4)

describe("bash-file-read-guard (before)", () => {
  const rule = createBashFileReadGuardRule()

  test("a simple cat/head/tail read is surfaced with the exact V1 warning while the read is preserved", () => {
    // given
    const event = { tool: "bash", input: { command: "cat notes.txt" } }
    // when
    const applied = rule.run(event)
    // then
    expect(applied).toBe(true)
    expect(event.input.command).toContain(BASH_FILE_READ_WARNING)
    expect(event.input.command).toContain("cat notes.txt")
    expect(event.input.command.startsWith("printf ")).toBe(true)

    const headEvent = { tool: "shell", input: { command: "head -n 5 app.log" } }
    expect(rule.run(headEvent)).toBe(true)
    expect(headEvent.input.command).toContain(BASH_FILE_READ_WARNING)
    expect(headEvent.input.command).toContain("head -n 5 app.log")

    const tailEvent = { tool: "interactive_bash", input: { command: "tail -n 20 out.txt" } }
    expect(rule.run(tailEvent)).toBe(true)
    expect(tailEvent.input.command).toContain("tail -n 20 out.txt")
  })

  test("non-matching commands, flags, and missing input are byte-identical no-ops", () => {
    const piped = { tool: "bash", input: { command: "cat notes.txt | grep x" } }
    const flagged = { tool: "bash", input: { command: "cat -n notes.txt" } }
    const headDash = { tool: "bash", input: { command: "head -20 notes.txt" } }
    const otherTool = { tool: "read", input: { command: "cat notes.txt" } }
    const noCommand = { tool: "bash", input: {} }
    for (const event of [piped, flagged, headDash, otherTool, noCommand]) {
      const before = JSON.stringify(event)
      expect(rule.run(event)).toBe(false)
      expect(JSON.stringify(event)).toBe(before)
    }
    expect(isSimpleFileReadCommand("cat notes.txt")).toBe(true)
    expect(isSimpleFileReadCommand("cat notes.txt | grep x")).toBe(false)
  })
})

describe("empty-task-response-detector (after)", () => {
  const rule = createEmptyTaskResponseRule({ taskToolName: "rigel_task" })

  test("an empty native delegation result is replaced with the exact V1 warning", () => {
    // given
    const event = { tool: "rigel_task", status: "completed", result: { content: [] } }
    // when
    const applied = rule.run(event)
    // then
    expect(applied).toBe(true)
    expect(event.result.content).toEqual([{ type: "text", text: EMPTY_TASK_RESPONSE_WARNING }])
    expect(EMPTY_TASK_RESPONSE_WARNING.startsWith("[Task Empty Response Warning]")).toBe(true)
  })

  test("the V1 task name with an empty string result is also caught", () => {
    const event = { tool: "task", status: "completed", result: { content: "" } }
    expect(rule.run(event)).toBe(true)
    expect(event.result.content).toBe(EMPTY_TASK_RESPONSE_WARNING)
  })

  test("the real rigel_task result for a foreground empty child reaches the warning", () => {
    // given: the exact object the runtime hands the host for a foreground child
    // that returned no text, produced by the real `taskResult` (not a hand-built
    // shape). The lifecycle wrapper makes `content` non-empty, so a text-only
    // detector can never fire; the empty-child signal must travel in metadata.
    const event = { tool: "rigel_task", status: "completed", result: taskResult({ sessionID: "ses_child", agent: "explore", background: false, result: undefined }) }
    // when
    const applied = rule.run(event)
    // then
    expect(applied).toBe(true)
    expect(event.result.content).toBe(EMPTY_TASK_RESPONSE_WARNING)
  })

  test("non-empty results, error outcomes, and other tools are untouched", () => {
    const nonEmpty = { tool: "rigel_task", status: "completed", result: { content: [{ type: "text", text: "done" }] } }
    const errored = { tool: "rigel_task", status: "error", result: { content: [] } }
    const otherTool = { tool: "read", status: "completed", result: { content: [] } }
    for (const event of [nonEmpty, errored, otherTool]) {
      const before = JSON.stringify(event)
      expect(rule.run(event)).toBe(false)
      expect(JSON.stringify(event)).toBe(before)
    }
  })
})

describe("tool-output-truncator (after)", () => {
  const bigText = (lines) => Array.from({ length: lines }, (_value, index) => `line-${index}-${"a".repeat(990)}`).join("\n")

  test("a webfetch result over 10k tokens is truncated at the webfetch budget", () => {
    // given
    const original = bigText(100) // ~100k chars -> ~25k tokens
    const event = { tool: "webfetch", status: "completed", result: { content: original } }
    // when
    const applied = createToolOutputTruncatorRule().run(event)
    // then
    expect(applied).toBe(true)
    const truncated = resultText(event)
    expect(truncated.length).toBeLessThan(original.length)
    expect(estimateTokens(truncated)).toBeLessThanOrEqual(WEBFETCH_MAX_TOKENS + 50)
    expect(truncated).toContain("truncated due to context window limit")
  })

  test("a grep result over 50k tokens is truncated at the default budget", () => {
    // given
    const original = bigText(300) // ~300k chars -> ~75k tokens
    const event = { tool: "grep", status: "completed", result: { content: original } }
    // when
    expect(createToolOutputTruncatorRule().run(event)).toBe(true)
    // then
    expect(resultText(event).length).toBeLessThan(original.length)
    expect(estimateTokens(resultText(event))).toBeLessThanOrEqual(DEFAULT_MAX_TOKENS + 50)
  })

  test("output under the budget is untouched and a non-listed tool is a no-op when the gate is off", () => {
    const small = { tool: "grep", status: "completed", result: { content: "short output" } }
    expect(createToolOutputTruncatorRule().run(small)).toBe(false)
    expect(resultText(small)).toBe("short output")

    const read = { tool: "read", status: "completed", result: { content: bigText(300) } }
    const before = JSON.stringify(read)
    expect(createToolOutputTruncatorRule().run(read)).toBe(false)
    expect(JSON.stringify(read)).toBe(before)
  })

  test("the truncate-all gate extends truncation to a non-listed tool", () => {
    const read = { tool: "read", status: "completed", result: { content: bigText(300) } }
    expect(createToolOutputTruncatorRule({ truncateAll: true }).run(read)).toBe(true)
    expect(resultText(read).length).toBeLessThan(bigText(300).length)
  })

  test("the V1 truncatable-tool contract is preserved", () => {
    expect(TRUNCATABLE_TOOLS).toEqual([
      "grep", "Grep", "safe_grep", "glob", "Glob", "safe_glob",
      "lsp_diagnostics", "interactive_bash", "Interactive_bash", "skill_mcp", "webfetch", "WebFetch",
    ])
    const flat = truncateToTokenLimit("x".repeat(400), 50)
    expect(flat.truncated).toBe(true)
    expect(flat.result).toContain("truncated due to context window limit")
  })
})
