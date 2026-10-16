/**
 * Deterministic flow logic for Oh My Rigel's native OpenCode V2 runtime.
 *
 * This is the pure core behind the small T20 flow hooks. The thin binders that
 * wire these decisions into the V2 seams live in T13/T14/T15; this module owns
 * only the deterministic decision each binder delegates to, so the behavior can
 * be tested hermetically without a live runtime.
 *
 * Ported from the matching OmO revision (V1 owner cores):
 *   packages/omo-opencode/src/hooks/notepad-write-guard/index.ts
 *   packages/omo-opencode/src/hooks/question-label-truncator/hook.ts
 *   packages/omo-opencode/src/hooks/sisyphus-junior-notepad/{hook,constants}.ts
 *   packages/omo-opencode/src/hooks/todo-description-override/description.ts
 *   packages/omo-opencode/src/hooks/tool-pair-validator/tool-result-repair.ts
 *   packages/delegate-core/src/retry-{patterns,guidance}.ts
 *
 * The native V2 runtime cannot import TypeScript from `packages/`, so the logic
 * lives here as pure functions. `rigel-v2-flow-logic.test.mjs` imports the real
 * V1 owners and pins parity, so upstream drift fails the suite.
 *
 * Pure module: no imports, no runtime dependencies, no I/O.
 */

// ---------------------------------------------------------------------------
// 1. Notepad path resolution + block message (notepad-write-guard)
// ---------------------------------------------------------------------------

/** Notepad roots, normalized the way V1 `path.normalize` would on POSIX. */
export const NOTEPAD_ROOTS = [".sisyphus/notepads", ".omo/notepads"]

/**
 * Normalize a path the way V1 `path.normalize` does for the notepad check:
 * collapse repeated separators, resolve `.`/`..` segments, and use `/` as the
 * separator. Backslashes are treated as separators so a Windows-style path is
 * classified the same way.
 */
export function normalizeNotepadPath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return ""
  const unified = filePath.replaceAll("\\", "/")
  const isAbsolute = unified.startsWith("/")
  const segments = []
  for (const segment of unified.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop()
      } else if (!isAbsolute) {
        segments.push("..")
      }
      continue
    }
    segments.push(segment)
  }
  const joined = segments.join("/")
  if (isAbsolute) return `/${joined}`
  return joined.length === 0 ? "." : joined
}

function hasNotepadRoot(normalizedPath, notepadRoot) {
  return normalizedPath === notepadRoot
    || normalizedPath.startsWith(`${notepadRoot}/`)
    || normalizedPath.includes(`/${notepadRoot}/`)
}

/** True when the path is inside a notepad root (V1 `isNotepadPath`). */
export function isNotepadPath(filePath) {
  const normalizedPath = normalizeNotepadPath(filePath)
  if (normalizedPath.length === 0) return false
  return NOTEPAD_ROOTS.some((notepadRoot) => hasNotepadRoot(normalizedPath, notepadRoot))
}

/**
 * Read the file path from tool args, honoring the three keys V1 accepts in
 * order: `filePath`, `path`, `file_path`. Non-string values are ignored.
 */
export function resolveNotepadFilePath(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined
  const raw = args.filePath ?? args.path ?? args.file_path
  return typeof raw === "string" ? raw : undefined
}

/**
 * The exact V1 block message thrown when a `Write` targets a notepad path.
 * Byte-identical to `notepad-write-guard/index.ts`.
 */
export function notepadBlockMessage(filePath) {
  return `Refused: Write to ${filePath} is blocked because notepad files are append-only and Write would destroy history. Report the original Edit failure to the user and ask for guidance instead.`
}

/**
 * Decide whether a `Write` tool call must be blocked. Returns the exact block
 * message when the tool is `write` (case-insensitive) and the resolved path is a
 * notepad path; otherwise returns `null`.
 */
export function decideNotepadWriteBlock(tool, args) {
  if (typeof tool !== "string" || tool.toLowerCase() !== "write") return null
  const filePath = resolveNotepadFilePath(args)
  if (!filePath) return null
  if (!isNotepadPath(filePath)) return null
  return notepadBlockMessage(filePath)
}

// ---------------------------------------------------------------------------
// 2. Question-label truncate (question-label-truncator)
// ---------------------------------------------------------------------------

/** V1 `MAX_LABEL_LENGTH`. */
export const MAX_LABEL_LENGTH = 30

/** Truncate a label to `maxLength`, appending `...` when it overflows. */
export function truncateLabel(label, maxLength = MAX_LABEL_LENGTH) {
  if (typeof label !== "string") return label
  if (label.length <= maxLength) return label
  return label.substring(0, maxLength - 3) + "..."
}

/**
 * Return a new args object with every question option label truncated. When
 * `args.questions` is not an array the args are returned unchanged (V1
 * `truncateQuestionLabels` guard).
 */
export function truncateQuestionLabels(args) {
  if (!args || typeof args !== "object" || !Array.isArray(args.questions)) {
    return args
  }
  return {
    ...args,
    questions: args.questions.map((question) => ({
      ...question,
      options: Array.isArray(question?.options)
        ? question.options.map((option) => ({ ...option, label: truncateLabel(option?.label) }))
        : [],
    })),
  }
}

/**
 * Names the question tool is registered under. V1 matched `askuserquestion` /
 * `ask_user_question`; the V2 runtime registers the same surface as `question`
 * (verified live), so the truncation must match all three or the guard is a
 * silent no-op on the real tool.
 */
export const QUESTION_TOOL_NAMES = new Set(["askuserquestion", "ask_user_question", "question"])

/**
 * Decide whether a tool call is a question tool whose labels must be truncated.
 * Matches `askuserquestion` / `ask_user_question` / `question` (case-insensitive)
 * and requires `args.questions` to be an array. Returns the truncated args, or
 * `null` when no truncation applies.
 */
export function decideQuestionLabelTruncation(tool, args) {
  if (typeof tool !== "string") return null
  const toolName = tool.toLowerCase()
  if (!QUESTION_TOOL_NAMES.has(toolName)) return null
  if (!args || typeof args !== "object" || !Array.isArray(args.questions)) return null
  return truncateQuestionLabels(args)
}

// ---------------------------------------------------------------------------
// 3. Sisyphus-junior notepad directive decision
// ---------------------------------------------------------------------------

/** V1 `SYSTEM_DIRECTIVE_PREFIX` (shared/system-directive.ts). */
export const SYSTEM_DIRECTIVE_PREFIX = "[SYSTEM DIRECTIVE: OH-MY-OPENCODE"

/**
 * The exact V1 `NOTEPAD_DIRECTIVE` text (sisyphus-junior-notepad/constants.ts).
 * Ported byte-for-byte; the two em dashes are part of the V1 source and are
 * preserved so the injected directive matches V1 exactly.
 */
export const NOTEPAD_DIRECTIVE = `
<Work_Context>
## Notepad Location (for recording learnings)
NOTEPAD PATH: .omo/notepads/{plan-name}/
- learnings.md: Record patterns, conventions, successful approaches
- issues.md: Record problems, blockers, gotchas encountered
- decisions.md: Record architectural choices and rationales
- problems.md: Record unresolved issues, technical debt

You SHOULD append findings to notepad files after completing work.
Notepad files are auto-scaffolded by /ulw-execute. APPEND only - use the \`edit\` tool (match-and-insert after the last line) or \`bash\` \`>>\`. Never use the \`write\` tool (blocked by notepad-write-guard) and never overwrite.

## Plan Location (subagent: READ ONLY)
PLAN PATH: .omo/plans/{plan-name}.md

SUBAGENT PLAN RESTRICTION (applies to YOU, the delegated worker — NOT to the Orchestrator):
- You may READ the plan to understand your assigned tasks
- You may READ checkbox items to know what to work on
- You MUST NOT edit the plan file or mark checkboxes — that is the Orchestrator's job
- The Orchestrator (Atlas) updates checkboxes after verifying your completed work
</Work_Context>
`

/**
 * Decide whether to prepend the notepad directive to a `task` prompt.
 *
 * V1 `sisyphus-junior-notepad` fires only when: the tool is `task`, the caller
 * is the orchestrator (`atlas`), a prompt is present, and the prompt does not
 * already carry the system-directive prefix (double-injection guard).
 *
 * `isOrchestrator` is injected because the V1 check is async and session-backed;
 * the binder resolves it and passes the boolean here.
 *
 * Returns the directive-prefixed prompt, or `null` when no injection applies.
 */
export function decideJuniorNotepadInjection({ tool, isOrchestrator, prompt }) {
  if (typeof tool !== "string" || tool !== "task") return null
  if (isOrchestrator !== true) return null
  if (typeof prompt !== "string" || prompt.length === 0) return null
  if (prompt.includes(SYSTEM_DIRECTIVE_PREFIX)) return null
  return NOTEPAD_DIRECTIVE + prompt
}

// ---------------------------------------------------------------------------
// 4. Todo-description override text
// ---------------------------------------------------------------------------

/**
 * The exact V1 `TODOWRITE_DESCRIPTION` text
 * (todo-description-override/description.ts), ported byte-for-byte as a data
 * string. The binding is TBD in T15: the V2 editor is add-only, so this text is
 * carried as data rather than applied through `tool.transform`.
 */
export const TODOWRITE_DESCRIPTION = `Use this tool to create and manage a structured task list for tracking progress on multi-step work.

## OpenCode Schema Contract

The upstream OpenCode \`todowrite\` schema expects each todo item to include:

- \`content\`: string
- \`status\`: string, one of \`pending\`, \`in_progress\`, \`completed\`, \`cancelled\`
- \`priority\`: string, one of \`high\`, \`medium\`, \`low\`

\`priority\` is a string field. Never send numeric priorities such as \`0\`, \`1\`, \`2\`, or labels such as \`P0\`, \`P1\`, \`P2\`.

## Todo Format (MANDATORY)

Each todo title MUST encode four elements: WHERE, WHY, HOW, and EXPECTED RESULT.

Format: "[WHERE] [HOW] to [WHY] - expect [RESULT]"

GOOD:
- "src/utils/validation.ts: Add validateEmail() for input sanitization - returns boolean"
- "UserService.create(): Call validateEmail() before DB insert - rejects invalid emails with 400"
- "validation.test.ts: Add test for missing @ sign - expect validateEmail('foo') to return false"

BAD:
- "Implement email validation" (where? how? what result?)
- "Add dark mode" (feature, not a todo)
- "Fix auth" (what file? what changes? what's expected?)

## Granularity Rules

Each todo MUST be a single atomic action completable in 1-3 tool calls. If it needs more, split it.

**Size test**: Can you complete this todo by editing one file or running one command? If not, it's too big.

## Task Management
- One in_progress at a time. Complete it before starting the next.
- Mark completed immediately after finishing each item.
- Skip this tool for single trivial tasks (one-step, obvious action).`

// ---------------------------------------------------------------------------
// 5. Tool-pair repair (tool-pair-validator/tool-result-repair.ts)
// ---------------------------------------------------------------------------

/** V1 `INTERRUPTED_TOOL_ERROR`. */
export const INTERRUPTED_TOOL_ERROR = "[Tool execution was interrupted before it produced output]"

const TERMINAL_TOOL_STATUSES = new Set(["completed", "error"])

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** True when a tool status is terminal (`completed` / `error`). */
export function isTerminalToolStatus(status) {
  return TERMINAL_TOOL_STATUSES.has(status)
}

function readStartTime(state) {
  const time = isRecord(state.time) ? state.time : null
  const start = time?.start
  return typeof start === "number" ? start : undefined
}

/**
 * Settle one non-terminal tool part into a terminal error state, preserving its
 * input and start time. Returns true when the part was settled.
 *
 * Idempotent: a part already in a terminal state is left untouched, so a second
 * pass over the same message is a no-op.
 */
export function settleToolPart(part) {
  if (!isRecord(part)) return false
  const state = isRecord(part.state) ? part.state : null
  if (!state) return false
  if (isTerminalToolStatus(state.status)) return false

  const input = isRecord(state.input) ? state.input : {}
  const start = readStartTime(state)
  const end = typeof state.time?.end === "number" ? state.time.end : undefined

  state.status = "error"
  state.error = INTERRUPTED_TOOL_ERROR
  state.input = input
  state.time = start === undefined ? { start: end } : { start, end: end ?? start }
  delete state.raw

  return true
}

/**
 * Repair every non-terminal tool part in a message. Returns the list of
 * repaired call ids (empty when nothing needed repair). Idempotent: a message
 * whose parts are all terminal yields an empty list and is not mutated.
 */
export function repairToolParts(message) {
  if (!isRecord(message) || !Array.isArray(message.parts)) return []
  const repaired = []
  for (const part of message.parts) {
    if (!isRecord(part) || part.type !== "tool") continue
    const callID = typeof part.callID === "string" && part.callID.length > 0 ? part.callID : null
    if (!callID) continue
    if (settleToolPart(part)) repaired.push(callID)
  }
  return repaired
}

// ---------------------------------------------------------------------------
// 6. Delegate-retry glue (T3 verdict: operate on the error channel only)
// ---------------------------------------------------------------------------

/**
 * Extract the error text from a V2 post-tool event. Per the T3 verdict the
 * delegate-retry hook must trigger on the error channel (`status === "error"`
 * plus `event.error`), never on `taskResult.content`. Returns "" when the event
 * is not an error or carries no message.
 */
export function delegateErrorText(event) {
  if (!isRecord(event)) return ""
  const resultError = event.result?.error
  const resultErrorText =
    typeof resultError === "string"
      ? resultError
      : isRecord(resultError) && typeof resultError.message === "string"
        ? resultError.message
        : ""
  // Trigger on the explicit error status OR the real V2 failure form pinned live:
  // `event.result.error` carried with an empty content array and NO top-level
  // `status: "error"`. A successful delegation carries neither signal, so it can
  // never produce guidance.
  if (event.status !== "error" && resultErrorText.length === 0) return ""
  const parts = [
    typeof event.error === "string" ? event.error : "",
    isRecord(event.error) && typeof event.error.message === "string" ? event.error.message : "",
    resultErrorText,
    typeof event.result?.output === "string" ? event.result.output : "",
    typeof event.output === "string" ? event.output : "",
  ]
  return parts.filter(Boolean).join("\n")
}

/**
 * Decide the delegate-retry action for a post-tool event.
 *
 * Per the T3 verdict:
 *   - only the error channel triggers (`status === "error"` + `event.error`);
 *   - a V1 pattern match yields specific guidance via `buildRetryGuidance`;
 *   - no match yields a generic announce/recover notice;
 *   - `missing_run_in_background` is dropped (no V2 schema requirement).
 *
 * `detect` and `buildGuidance` are injected so the binder can pass the real V1
 * cores and the test can pin the exact branch. Returns `{ action, text }` where
 * `action` is `"none" | "guidance" | "announce"`.
 */
export function decideDelegateRetry(event, { detect, buildGuidance } = {}) {
  const text = delegateErrorText(event)
  if (text.length === 0) return { action: "none", text: "" }

  const detected = typeof detect === "function" ? detect(text) : null
  if (detected && detected.errorType !== "missing_run_in_background") {
    const guidance = typeof buildGuidance === "function" ? buildGuidance(detected) : ""
    return { action: "guidance", text: guidance }
  }

  return {
    action: "announce",
    text: "[task ERROR] The delegation failed. Correct the call and retry.",
  }
}
