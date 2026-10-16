/**
 * `tool.execute.after` binders for the native OpenCode V2 runtime.
 *
 * This module exports thin rules over the T9 pure flow logic
 * (`./rigel-v2-flow-logic.mjs`). Each rule is a `{ name, run }` object, so the
 * runtime composes it with `runOrderedRules` (`./rigel-v2-native-hook-chain.mjs`)
 * and a throwing rule is isolated instead of aborting the rest of the chain.
 *
 * `delegate-task-retry` is the only rule bound here: the delegate-retry branch is
 * `decideDelegateRetry` and the V1 detector/guidance factory
 * (`./rigel-v2-delegate-retry-core.mjs`).
 *
 * The V1 `fsync-skip-warning` rule was RETIRED (P2b, row 37): the warning needs a
 * live producer of skipped-fsync reports (`recordSkip`), and the V2 runtime owns
 * no such producer — the file-write path belongs to the host. With no producer the
 * rule never fires, so it was removed from the composed chain; the catalogue claim
 * was withdrawn in the same change.
 *
 * read-image-resizer is deliberately NOT wired here. T10 recorded a NO-GO for the
 * `execute.after` seam: the real V2 payload carries no `provider`, no `model`, and
 * no `attachments`, and `result.content` is an array of `{ type, text }` parts with
 * no attachment URLs, so both the V1 provider gate and the in-place attachment
 * mutation are unreproducible at this boundary. The surface keeps only its tested
 * pure core (`rigel-v2-native-image-resizer.mjs`) and this module adds no rule,
 * mock, or stub for it.
 */

import { decideDelegateRetry } from "./rigel-v2-flow-logic.mjs"
import {
  buildRetryGuidance,
  detectDelegateTaskError,
} from "./rigel-v2-delegate-retry-core.mjs"

/**
 * Append text to whichever mutable result channel the after event exposes.
 * T1 proved `event.result.content` is a mutable array of `{ type, text }`
 * parts; a string channel is also honored so the binder degrades honestly on a
 * shape the probe did not pin. Returns true when the text landed.
 */
function appendResultText(event, text) {
  if (!event || typeof event !== "object") return false
  const content = event?.result?.content
  if (Array.isArray(content)) {
    content.push({ type: "text", text })
    return true
  }
  if (typeof content === "string") {
    event.result.content = content + text
    return true
  }
  if (typeof event.result?.output === "string") {
    event.result.output += text
    return true
  }
  if (typeof event.output === "string") {
    event.output += text
    return true
  }
  return false
}

/**
 * Delegate-retry rule per the T3 verdict (`oq5-decision.md`).
 *
 * Trigger surface is the ERROR CHANNEL only: `decideDelegateRetry` bails unless
 * `status === "error"` or the real V2 failure form (`result.error`) is present.
 * A success or a background spawn therefore never appends, which removes the V1
 * child-text false positive. A matching V1 pattern yields `buildRetryGuidance`;
 * an error with no match yields the T9 generic announce/recover notice.
 * `missing_run_in_background` is dropped by the glue.
 *
 * The detector and guidance are injectable so a test can pin either branch; the
 * defaults are the ported V1 cores.
 */
export function createDelegateTaskRetryRule({
  detect = detectDelegateTaskError,
  buildGuidance = buildRetryGuidance,
} = {}) {
  return {
    name: "delegate-task-retry",
    run(event) {
      const decision = decideDelegateRetry(event, { detect, buildGuidance })
      if (!decision || decision.action === "none" || !decision.text) return false
      return appendResultText(event, `\n${decision.text}`)
    },
  }
}

/**
 * `tool.execute.after` rules appended after the built-in result transforms.
 * Frozen and empty-safe: always an array, so the runtime can spread it even
 * when a future gate removes every rule.
 */
export const afterRules = Object.freeze([
  createDelegateTaskRetryRule(),
])
