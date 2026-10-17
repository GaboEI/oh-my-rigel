/**
 * Native OpenCode V2 ports of three V1 tool guards (T38):
 *
 *   - bash-file-read-guard          (`tool.execute.before`)
 *     V1 `packages/omo-opencode/src/hooks/bash-file-read-guard.ts`: a simple
 *     `cat`/`head`/`tail` file read is answered with an advisory warning. V2's
 *     `execute.before` has no message channel (proven for the non-interactive
 *     guard), so the equivalent observable is to surface the same warning
 *     through the command's own output while the read still runs.
 *
 *   - empty-task-response-detector  (`tool.execute.after`)
 *     V1 `hooks/empty-task-response-detector.ts`: a completed delegation with an
 *     empty response is replaced with the V1 warning block. The native
 *     delegation tool is `rigel_task` (`RIGEL_NATIVE_TASK_NAME`), not V1 `task`.
 *
 *   - tool-output-truncator         (`tool.execute.after`)
 *     V1 `hooks/tool-output-truncator.ts`: grep/glob/lsp_diagnostics/
 *     interactive_bash/skill_mcp/webfetch output is truncated to a token budget
 *     (50k general, 10k webfetch); with `experimental.truncate_all_tool_outputs`
 *     every tool's output is truncated instead.
 *
 * Each export is a `{ name, run }` rule accepted by `runOrderedRules`
 * (`rigel-v2-native-hook-chain.mjs`), so a throwing rule is isolated.
 */

import { resolveDelegationToolName } from "./rigel-v2-native-flow-guards.mjs"

/** V1 `WARNING_MESSAGE` (`hooks/bash-file-read-guard.ts`). */
export const BASH_FILE_READ_WARNING =
  "Prefer the Read tool over `cat`/`head`/`tail` for reading file contents. The Read tool provides line numbers and hash anchors for precise editing."

/** V1 `EMPTY_RESPONSE_WARNING` (`hooks/empty-task-response-detector.ts`), byte-identical. */
export const EMPTY_TASK_RESPONSE_WARNING = `[Task Empty Response Warning]

Task invocation completed but returned no response. This indicates the agent either:
- Failed to execute properly
- Did not terminate correctly
- Returned an empty result

Note: The call has already completed - you are NOT waiting for a response. Proceed accordingly.`

// V1 `FILE_READ_PATTERNS` (`hooks/bash-file-read-guard.ts`), verbatim.
const FILE_READ_PATTERNS = [
  /^\s*cat\s+(?!-)[^\s|&;]+\s*$/,
  /^\s*head\s+(-n\s+\d+\s+)?(?!-)[^\s|&;]+\s*$/,
  /^\s*tail\s+(-n\s+\d+\s+)?(?!-)[^\s|&;]+\s*$/,
]

export function isSimpleFileReadCommand(command) {
  return typeof command === "string" && FILE_READ_PATTERNS.some((pattern) => pattern.test(command))
}

// V1 `TRUNCATABLE_TOOLS` (`hooks/tool-output-truncator.ts`), verbatim.
export const TRUNCATABLE_TOOLS = Object.freeze([
  "grep",
  "Grep",
  "safe_grep",
  "glob",
  "Glob",
  "safe_glob",
  "lsp_diagnostics",
  "interactive_bash",
  "Interactive_bash",
  "skill_mcp",
  "webfetch",
  "WebFetch",
])

export const DEFAULT_MAX_TOKENS = 50_000 // ~200k chars
export const WEBFETCH_MAX_TOKENS = 10_000 // ~40k chars - web pages need aggressive truncation
const CHARS_PER_TOKEN_ESTIMATE = 4
const PRESERVE_HEADER_LINES = 3

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function readInput(event) {
  return event?.input && typeof event.input === "object" && !Array.isArray(event.input) ? event.input : undefined
}

/** Extract the model-visible result text from the V2 `execute.after` event. */
export function resultText(event) {
  const content = event?.result?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n")
  if (typeof event?.result?.output === "string") return event.result.output
  if (typeof event?.output === "string") return event.output
  return ""
}

/** Replace the model-visible result text, preferring the `result.content` channel. */
function setResultText(event, text) {
  const content = event?.result?.content
  if (Array.isArray(content)) { event.result.content = [{ type: "text", text }]; return true }
  if (typeof content === "string") { event.result.content = text; return true }
  if (typeof event?.result?.output === "string") { event.result.output = text; return true }
  if (typeof event?.output === "string") { event.output = text; return true }
  return false
}

/**
 * `bash-file-read-guard` before rule.
 *
 * V2's `execute.before` cannot attach a message, so the V1 warning is surfaced
 * by prefixing the command with an `echo` of the exact V1 text to stderr, then
 * running the original read unchanged. V1 names the tool `bash`; the V2 host
 * catalog names it `shell`, and the native interactive shell is
 * `interactive_bash`, so all three are matched.
 */
export function createBashFileReadGuardRule() {
  return {
    name: "bash-file-read-guard",
    run(event) {
      const tool = String(event?.tool ?? "").toLowerCase()
      if (tool !== "bash" && tool !== "shell" && tool !== "interactive_bash") return false
      const input = readInput(event)
      if (!input || typeof input.command !== "string") return false
      if (!isSimpleFileReadCommand(input.command)) return false
      input.command = `printf '%s\\n' ${shellQuote(BASH_FILE_READ_WARNING)} >&2\n${input.command}`
      return true
    },
  }
}

/** `empty-task-response-detector` after rule. */
export function createEmptyTaskResponseRule({ taskToolName } = {}) {
  const delegationName = (typeof taskToolName === "string" && taskToolName.length > 0 ? taskToolName : resolveDelegationToolName()).toLowerCase()
  return {
    name: "empty-task-response-detector",
    run(event) {
      const tool = String(event?.tool ?? "").toLowerCase()
      if (tool !== "task" && tool !== delegationName) return false
      if (event?.status === "error") return false
      // `taskResult` wraps a foreground empty child in a non-empty lifecycle
      // text, so the emptiness must be read from the metadata signal as well as
      // from a literally empty result text.
      const empty = event?.result?.metadata?.childEmpty === true || resultText(event).trim() === ""
      if (!empty) return false
      return setResultText(event, EMPTY_TASK_RESPONSE_WARNING)
    },
  }
}

/** Inline port of the V1 token-limit truncator (4 chars/token, first 3 lines preserved). */
export function truncateToTokenLimit(output, maxTokens, preserveHeaderLines = PRESERVE_HEADER_LINES) {
  const estimateTokens = (text) => Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE)
  if (typeof output !== "string") return { result: String(output ?? ""), truncated: false }
  if (estimateTokens(output) <= maxTokens) return { result: output, truncated: false }

  const lines = output.split("\n")
  if (lines.length <= preserveHeaderLines) {
    const maxChars = maxTokens * CHARS_PER_TOKEN_ESTIMATE
    return { result: output.slice(0, maxChars) + "\n\n[Output truncated due to context window limit]", truncated: true }
  }

  const headerLines = lines.slice(0, preserveHeaderLines)
  const contentLines = lines.slice(preserveHeaderLines)
  const headerText = headerLines.join("\n")
  const availableTokens = maxTokens - estimateTokens(headerText) - 50
  if (availableTokens <= 0) {
    return { result: headerText + "\n\n[Content truncated due to context window limit]", truncated: true, removedCount: contentLines.length }
  }

  const resultLines = []
  let usedTokens = 0
  for (const line of contentLines) {
    const lineTokens = estimateTokens(`${line}\n`)
    if (usedTokens + lineTokens > availableTokens) break
    resultLines.push(line)
    usedTokens += lineTokens
  }
  const removedCount = contentLines.length - resultLines.length
  return {
    result: [...headerLines, ...resultLines].join("\n") + `\n\n[${removedCount} more lines truncated due to context window limit]`,
    truncated: true,
    removedCount,
  }
}

/** `tool-output-truncator` after rule, gated by `experimental.truncate_all_tool_outputs`. */
export function createToolOutputTruncatorRule({ truncateAll = false, defaultMaxTokens = DEFAULT_MAX_TOKENS, webfetchMaxTokens = WEBFETCH_MAX_TOKENS } = {}) {
  return {
    name: "tool-output-truncator",
    run(event) {
      const tool = event?.tool
      if (!truncateAll && !TRUNCATABLE_TOOLS.includes(tool)) return false
      const text = resultText(event)
      if (typeof text !== "string") return false
      const targetMaxTokens = (tool === "webfetch" || tool === "WebFetch") ? webfetchMaxTokens : defaultMaxTokens
      const { result, truncated } = truncateToTokenLimit(text, targetMaxTokens)
      if (!truncated) return false
      return setResultText(event, result)
    },
  }
}
