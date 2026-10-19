/**
 * Ordered native OpenCode V2 request steps for Oh My Rigel's runtime.
 *
 * Only image resizing operates on the provider HTTP request. Tool-pair repair
 * belongs to `context.messages` and stop-continuation belongs to `prompt`.
 *
 * Each step is a `{ name, run }` object. `run` receives one shared context
 * `{ body, shape, sessionID, stopState, input }` and mutates `body` in place.
 * `runRequestSteps` drives the list through the same failure-isolated runner the
 * tool hooks use (`runOrderedRules`), so one throwing step cannot abort the
 * rest of the pipeline.
 *
 * The steps are built on the T9 pure flow logic (`rigel-v2-flow-logic.mjs`),
 * the T7 stop-continuation pattern (`rigel-v2-keyword-core.mjs`), and the real
 * `read-image-resizer` core (`rigel-v2-native-image-resizer.mjs`). The
 * `todo-description-override` surface is implemented separately by
 * `rigel-v2-native-todo-description.mjs` (a real `todowrite` tool carrying the
 * V1 description into the model schema), not as a request step.
 *
 * Pure module: no I/O, no runtime dependencies, no handler registration.
 */

import { INTERRUPTED_TOOL_ERROR } from "./rigel-v2-flow-logic.mjs"
import { STOP_CONTINUATION_PATTERN } from "./rigel-v2-keyword-core.mjs"
import {
  ANTHROPIC_MAX_FILE_SIZE,
  calculateTargetDimensions,
  isResizerProvider,
  parseImageDimensions,
  resizeImageDataUrl,
  resolveResizerProviders,
} from "./rigel-v2-native-image-resizer.mjs"
import { runOrderedRules } from "./rigel-v2-native-hook-chain.mjs"

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

/** Resolve the provider body shape from the parsed body. */
export function resolveRequestShape(body) {
  if (Array.isArray(body?.messages)) return "chat"
  if (Array.isArray(body?.input)) return "responses"
  return undefined
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// 1. tool-pair-validator: repair unpaired tool calls in both provider shapes
// ---------------------------------------------------------------------------

/**
 * Repair unpaired tool calls in a Chat Completions `body.messages` array.
 *
 * A single assistant tool call is serialized as a `tool_calls[]` entry and its
 * result as a `role: "tool"` message carrying the matching `tool_call_id`. An
 * interrupted call reaches the provider as a `tool_calls[]` entry with no paired
 * result, which the provider rejects. The repair inserts the missing terminal
 * result carrying the T9 `INTERRUPTED_TOOL_ERROR` text, immediately after the
 * assistant message that declared the call.
 *
 * Idempotent: the inserted result pairs the call, so a second pass inserts
 * nothing. Returns the repaired call ids (empty when nothing needed repair).
 */
export function repairChatToolPairs(messages) {
  if (!Array.isArray(messages)) return []
  const paired = new Set()
  for (const message of messages) {
    if (message?.role === "tool" && typeof message.tool_call_id === "string") {
      paired.add(message.tool_call_id)
    }
  }
  const repaired = []
  const rebuilt = []
  for (const message of messages) {
    rebuilt.push(message)
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) continue
    for (const call of message.tool_calls) {
      const callID = typeof call?.id === "string" && call.id.length > 0 ? call.id : undefined
      if (!callID || paired.has(callID)) continue
      paired.add(callID)
      rebuilt.push({ role: "tool", tool_call_id: callID, content: INTERRUPTED_TOOL_ERROR })
      repaired.push(callID)
    }
  }
  if (repaired.length > 0) {
    messages.length = 0
    messages.push(...rebuilt)
  }
  return repaired
}

/**
 * Repair unpaired tool calls in an OpenAI Responses `body.input` array.
 *
 * A tool call is a `function_call` item and its result a `function_call_output`
 * item carrying the matching `call_id`. The repair inserts the missing terminal
 * output carrying the T9 `INTERRUPTED_TOOL_ERROR` text, immediately after the
 * `function_call` item. Idempotent for the same reason as the chat repair.
 */
export function repairResponsesToolPairs(input) {
  if (!Array.isArray(input)) return []
  const paired = new Set()
  for (const item of input) {
    if (item?.type === "function_call_output" && typeof item.call_id === "string") {
      paired.add(item.call_id)
    }
  }
  const repaired = []
  const rebuilt = []
  for (const item of input) {
    rebuilt.push(item)
    if (item?.type !== "function_call") continue
    const callID = typeof item.call_id === "string" && item.call_id.length > 0 ? item.call_id : undefined
    if (!callID || paired.has(callID)) continue
    paired.add(callID)
    rebuilt.push({ type: "function_call_output", call_id: callID, output: INTERRUPTED_TOOL_ERROR })
    repaired.push(callID)
  }
  if (repaired.length > 0) {
    input.length = 0
    input.push(...rebuilt)
  }
  return repaired
}

/** `context` step: repair unpaired tool calls in model-visible messages. */
export const toolPairValidatorStep = {
  name: "tool-pair-validator",
  run: ({ body, shape } = {}) => {
    const resolvedShape = shape ?? resolveRequestShape(body)
    if (resolvedShape === "chat") {
      return { shape: "chat", repaired: repairChatToolPairs(body?.messages) }
    }
    if (resolvedShape === "responses") {
      return { shape: "responses", repaired: repairResponsesToolPairs(body?.input) }
    }
    return { shape: undefined, repaired: [] }
  },
}

// ---------------------------------------------------------------------------
// 2. stop-continuation-guard: per-session stop state + continuation block
// ---------------------------------------------------------------------------

/**
 * The first line of the V2 goal continuation prompt
 * (`tools/goal.tools.mjs` `buildContinuationPrompt`). A continuation injection
 * is a user message carrying this marker; the stop guard strips it while the
 * session is stopped.
 */
export const CONTINUATION_PROMPT_MARKER = "Continue working toward the active thread goal."

/**
 * Per-session stop state. V2 has no `command.execute.before` seam (DEC-6), so
 * the stop command is observed at prompt admission and the state is exposed
 * for the runtime: `stop` marks a session stopped, `isStopped` is the guard the
 * continuation dispatcher reads, `clear` releases it (session.deleted), and
 * `clearAll` releases every stopped session (plugin dispose).
 *
 * `onStop` / `onClear` are optional transition callbacks. `onStop(sessionID)`
 * fires only on the not-stopped -> stopped edge (repeated `stop` calls are
 * idempotent); `onClear(sessionID)` fires only when the session actually was
 * stopped. Both are fire-and-forget: an async callback's rejection is swallowed
 * and a synchronously throwing callback never breaks the caller.
 */
export function createStopContinuationState({ onStop, onClear } = {}) {
  const stoppedSessions = new Set()
  const fire = (callback, sessionID) => {
    if (typeof callback !== "function") return
    try {
      const pending = callback(sessionID)
      if (pending && typeof pending.then === "function") pending.catch(() => {})
    } catch (error) {
      void error
    }
  }
  return {
    stop(sessionID) {
      if (typeof sessionID !== "string" || sessionID.length === 0) return
      if (stoppedSessions.has(sessionID)) return
      stoppedSessions.add(sessionID)
      fire(onStop, sessionID)
    },
    isStopped(sessionID) {
      return typeof sessionID === "string" && stoppedSessions.has(sessionID)
    },
    clear(sessionID) {
      if (typeof sessionID !== "string" || sessionID.length === 0) return
      if (!stoppedSessions.delete(sessionID)) return
      fire(onClear, sessionID)
    },
    clearAll() {
      stoppedSessions.clear()
    },
  }
}

function chatMessageText(message) {
  if (typeof message?.content === "string") return message.content
  if (Array.isArray(message?.content)) {
    return message.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join(" ")
  }
  return ""
}

function responsesItemText(item) {
  if (typeof item?.content === "string") return item.content
  if (Array.isArray(item?.content)) {
    return item.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join(" ")
  }
  if (typeof item?.output === "string") return item.output
  return ""
}

/** Text of the current turn's last user message, for the stop-command check. */
export function readCurrentTurnText(body, shape) {
  if (shape === "chat" && Array.isArray(body?.messages)) {
    for (let index = body.messages.length - 1; index >= 0; index -= 1) {
      const message = body.messages[index]
      if (message?.role === "user") return chatMessageText(message)
    }
    return ""
  }
  if (shape === "responses" && Array.isArray(body?.input)) {
    for (let index = body.input.length - 1; index >= 0; index -= 1) {
      const item = body.input[index]
      if (item?.type === "message" && item?.role === "user") return responsesItemText(item)
    }
    return ""
  }
  return ""
}

/** Remove every continuation injection from the body. Returns the count removed. */
export function stripContinuationInjection(body, shape) {
  if (shape === "chat" && Array.isArray(body?.messages)) {
    const kept = body.messages.filter((message) => !chatMessageText(message).includes(CONTINUATION_PROMPT_MARKER))
    const removed = body.messages.length - kept.length
    if (removed > 0) {
      body.messages.length = 0
      body.messages.push(...kept)
    }
    return removed
  }
  if (shape === "responses" && Array.isArray(body?.input)) {
    const kept = body.input.filter((item) => !responsesItemText(item).includes(CONTINUATION_PROMPT_MARKER))
    const removed = body.input.length - kept.length
    if (removed > 0) {
      body.input.length = 0
      body.input.push(...kept)
    }
    return removed
  }
  return 0
}

/**
 * `prompt` step: observe `/stop-continuation` on the admitted prompt and block
 * a continuation injection before it becomes a durable message.
 */
export const stopContinuationStep = {
  name: "stop-continuation-guard",
  run: ({ body, shape, sessionID, stopState } = {}) => {
    if (!stopState || typeof stopState.isStopped !== "function") {
      return { stopped: false, blocked: 0 }
    }
    const resolvedShape = shape ?? resolveRequestShape(body)
    if (STOP_CONTINUATION_PATTERN.test(readCurrentTurnText(body, resolvedShape))) {
      stopState.stop(sessionID)
    }
    if (!stopState.isStopped(sessionID)) {
      return { stopped: false, blocked: 0 }
    }
    return { stopped: true, blocked: stripContinuationInjection(body, resolvedShape) }
  },
}

export function applyPromptAdmission(event, stopState) {
  if (!event?.prompt || typeof event.prompt.text !== "string" || !stopState) {
    return { stopped: false, blocked: false }
  }
  const sessionID = typeof event.sessionID === "string" ? event.sessionID : undefined
  if (STOP_CONTINUATION_PATTERN.test(event.prompt.text)) stopState.stop(sessionID)
  if (!stopState.isStopped(sessionID) || !event.prompt.text.includes(CONTINUATION_PROMPT_MARKER)) {
    return { stopped: stopState.isStopped(sessionID), blocked: false }
  }
  event.prompt.text = event.prompt.text.replace(CONTINUATION_PROMPT_MARKER, "").trim()
  return { stopped: true, blocked: true }
}

// ---------------------------------------------------------------------------
// 3. image-resizer: real Bun.Image decode/resize/re-encode at the request body
// ---------------------------------------------------------------------------

const IMAGE_SKIP_MARKER = "[Image Resize Info]"

function dataUrlMime(dataUrl) {
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl)
  return match ? match[1].toLowerCase() : ""
}

function dataUrlBase64(dataUrl) {
  const comma = typeof dataUrl === "string" ? dataUrl.indexOf(",") : -1
  return comma >= 0 ? dataUrl.slice(comma + 1) : ""
}

/** V1 `formatResizeAppendix` text for the skip case (image removed). */
function formatImageSkipNote(skips) {
  const lines = [IMAGE_SKIP_MARKER]
  for (const skip of skips) {
    const dims = skip.dimensions ? `${skip.dimensions.width}x${skip.dimensions.height}` : "dimensions could not be parsed"
    lines.push(`- ${skip.label}: ${dims} (exceeds provider limits, image removed to prevent API error)`)
  }
  return lines.join("\n")
}

function stripImageSkipNote(messages) {
  if (!Array.isArray(messages)) return
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === "system" && typeof message.content === "string" && message.content.includes(IMAGE_SKIP_MARKER)) {
      messages.splice(index, 1)
    }
  }
}

function stripResponsesSkipNote(input) {
  if (!Array.isArray(input)) return
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index]
    if (item?.type !== "message" || item?.role !== "system" || !Array.isArray(item?.content)) continue
    if (item.content.some((part) => typeof part?.text === "string" && part.text.includes(IMAGE_SKIP_MARKER))) {
      input.splice(index, 1)
    }
  }
}

/**
 * `http.request` step: for providers in the resizer set, decode each outgoing
 * image part with `Bun.Image`, downscale it to the Anthropic long-edge cap, and
 * write the re-encoded data URL back into the body in place.
 *
 * Failure semantics mirror V1 `hooks/read-image-resizer/hook.ts`: an image that
 * REQUIRES a resize (long edge over the cap, or encoded size over the cap) but
 * whose resize fails or is unavailable is REMOVED from the payload (never passed
 * through oversized as-is, which would make the provider reject the request), a
 * model-visible `[Image Resize Info]` note records the removal, and an
 * observable log line is emitted. An image already within limits is left
 * untouched.
 *
 * The note is delivered on the honored surface per shape: a `role:"system"`
 * string message in `body.messages` (Chat), or a `message` item carrying an
 * `input_text` part in `body.input` (Responses). A plugin-created `instructions`
 * field is never used (T1, probe-decisions.md: it does not reach the model). Both
 * are idempotent: a prior note is stripped before a new one is appended.
 *
 * The V1 gate (`providerID === "anthropic"`) is the default set; `providers` or
 * `RIGEL_IMAGE_RESIZER_PROVIDERS` broaden it. `resize` and `log` are injectable
 * for tests. Never throws.
 */
export function createImageResizerStep({ providers, resize = resizeImageDataUrl, env = process.env, log = console, onOutcome } = {}) {
  // Observability seam: `onOutcome` reports the decision the step reached. It is
  // observation only and is therefore wrapped in its own try/catch: a receipt
  // callback that throws must never change the returned outcome, mutate the
  // body differently, or abort the request.
  const notifyOutcome = (outcome, providerID) => {
    if (typeof onOutcome !== "function") return
    try {
      onOutcome(outcome, { providerID })
    } catch (error) {
      log?.error?.(`[oh-my-rigel] image-resizer outcome callback failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {
    name: "image-resizer",
    run: async ({ body, shape, input } = {}) => {
      try {
        const allowed = providers ?? resolveResizerProviders(env)
        const providerID = input?.model?.providerID ?? input?.model?.provider
        if (!isResizerProvider(providerID, allowed)) {
          const skipped = { considered: 0, resized: 0, removed: 0, skipped: "provider" }
          notifyOutcome(skipped, providerID)
          return skipped
        }
        const resolvedShape = shape ?? resolveRequestShape(body)
        const outcome = { considered: 0, resized: 0, removed: 0, skips: [] }
        const handlePart = async (part, readUrl, writeUrl, remove, index) => {
          const url = readUrl(part)
          if (typeof url !== "string" || !url.startsWith("data:image/")) {
            return
          }
          outcome.considered += 1
          const mime = dataUrlMime(url)
          const dimensions = parseImageDimensions(url, mime)
          const target = dimensions ? calculateTargetDimensions(dimensions.width, dimensions.height) : null
          const approxBytes = Math.floor((dataUrlBase64(url).length * 3) / 4)
          const requiresResize = Boolean(target) || approxBytes > ANTHROPIC_MAX_FILE_SIZE
          if (!requiresResize) {
            return
          }
          const result = await resize(url, mime)
          if (result?.resized && typeof result.dataUrl === "string") {
            writeUrl(part, result.dataUrl)
            outcome.resized += 1
            return
          }
          remove()
          outcome.removed += 1
          outcome.skips.push({ label: `image-${index}`, dimensions, reason: result?.reason ?? "resize-failed" })
        }
        if (resolvedShape === "chat" && Array.isArray(body?.messages)) {
          let index = 0
          for (const message of body.messages) {
            if (!Array.isArray(message?.content)) continue
            for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex -= 1) {
              const part = message.content[partIndex]
              if (part?.type !== "image_url") continue
              await handlePart(
                part,
                (p) => p?.image_url?.url,
                (p, url) => { p.image_url.url = url },
                () => { message.content.splice(partIndex, 1) },
                index,
              )
              index += 1
            }
          }
        } else if (resolvedShape === "responses" && Array.isArray(body?.input)) {
          let index = 0
          // A Responses body carries image parts in two schema-valid places. A
          // bare top-level `input_image` item is NOT a valid Responses input (it
          // is not a member of the ResponseInputItem union), so it can never
          // appear; but `input_image` content parts are valid both in a
          // `message` item's `content[]` array AND in the `output[]` array of a
          // `function_call_output` / `custom_tool_call_output` item. Scan both.
          for (const item of body.input) {
            const containers = []
            if (item?.type === "message" && Array.isArray(item.content)) containers.push(item.content)
            if ((item?.type === "function_call_output" || item?.type === "custom_tool_call_output") && Array.isArray(item.output)) containers.push(item.output)
            for (const container of containers) {
              for (let partIndex = container.length - 1; partIndex >= 0; partIndex -= 1) {
                const part = container[partIndex]
                if (part?.type !== "input_image") continue
                await handlePart(
                  part,
                  (p) => (typeof p?.image_url === "string" ? p.image_url : p?.image_url?.url),
                  (p, url) => {
                    if (typeof p.image_url === "string") p.image_url = url
                    else p.image_url.url = url
                  },
                  () => { container.splice(partIndex, 1) },
                  index,
                )
                index += 1
              }
            }
          }
        }
        if (outcome.skips.length > 0) {
          const note = formatImageSkipNote(outcome.skips)
          if (resolvedShape === "chat" && Array.isArray(body?.messages)) {
            stripImageSkipNote(body.messages)
            body.messages.unshift({ role: "system", content: note })
          } else if (resolvedShape === "responses" && Array.isArray(body?.input)) {
            // Deliver the note on the model-honored Responses surface: an
            // additional `message` item in `body.input` carrying an `input_text`
            // part. A plugin-created `instructions` field does NOT reach the
            // model (T1, probe-decisions.md), so it is never used. Appended after
            // the existing items to keep chronology; idempotent (prior note
            // stripped first, no duplicates).
            stripResponsesSkipNote(body.input)
            body.input.push({ type: "message", role: "system", content: [{ type: "input_text", text: note }] })
          }
          const reasons = outcome.skips.map((skip) => skip.reason).join(",")
          log?.error?.(`[oh-my-rigel] image-resizer: removed ${outcome.removed} oversized image(s) after resize failure/unavailability (reasons=${reasons})`)
        }
        notifyOutcome(outcome, providerID)
        return outcome
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log?.error?.(`[oh-my-rigel] image-resizer step failed: ${message}`)
        return { considered: 0, resized: 0, removed: 0, skipped: "error", error: message }
      }
    },
  }
}

/** Module-level image-resizer step using the default provider set. */
export const imageResizerStep = createImageResizerStep()

// ---------------------------------------------------------------------------
// Ordered pipeline
// ---------------------------------------------------------------------------

/**
 * The ordered HTTP rewrite steps. Image resizing is the only native provider
 * transport mutation left at this boundary.
 */
export const requestSteps = Object.freeze([imageResizerStep])

/**
 * Run the ordered steps over one shared context with failure isolation. Returns
 * the `runOrderedRules` report `{ failures, executed }`; the step return values
 * are discarded, matching the V2 handler contract.
 */
export async function runRequestSteps(context, steps = requestSteps) {
  const results = []
  const recording = steps.map((step) => ({
    name: step.name,
    run: async (input) => {
      const result = await step.run(input)
      results.push({ name: step.name, result })
      return result
    },
  }))
  const report = await runOrderedRules(recording, context, { onError: context?.onError })
  return { ...report, results }
}

// ---------------------------------------------------------------------------
// todo-description-override is NOT a request step
// ---------------------------------------------------------------------------

/**
 * The `todo-description-override` surface is implemented by
 * `rigel-v2-native-todo-description.mjs`: it registers a real `todowrite` tool
 * carrying the exact V1 `TODOWRITE_DESCRIPTION` into the model's tool schema,
 * which is the V2 equivalent of the V1 `tool.definition` rewrite. It is not a
 * `http.request` body step and is therefore not in `requestSteps`.
 *
 * The earlier verdict that recorded this surface as "Incompatible (add-only
 * tool.transform)" was wrong: the V2 `tool.transform` editor exposes `update`
 * (and `get`/`list`/`namespace`/`remove`), and `todowrite` is not a V2-owned
 * builtin, so an `editor.add`/`editor.update` of that name is model-visible.
 */
