/**
 * Flow-rule registry for the native OpenCode V2 runtime.
 *
 * This module is the single wiring point for the ported OmO flow surfaces. The
 * runtime consumes exactly four ordered collections and nothing else:
 *
 * - `beforeRules`: `tool.execute.before` rules appended after the built-in
 *   write-guard rules. A rule is a `{ name, run }` object; `run` receives the
 *   V2 event object.
 * - `afterRules`: `tool.execute.after` rules appended after the built-in result
 *   transforms.
 * - `requestSteps`: ordered `http.request` rewrite steps composed into the one
 *   existing request hook.
 * - `eventHandlers`: durable V2 event handlers the runtime event loop awaits.
 *
 * Declared order (frozen; the runtime appends, never reorders):
 *
 * before (after the runtime's prometheus-md-only, write-existing-file-guard,
 * comment-checker and webfetch-redirect-guard rules):
 *   1. notepad-write-guard            (throws; re-asserted by the blocking runner)
 *   2. question-label-truncator
 *   3. sisyphus-junior-notepad
 *   4. bash-file-read-guard
 *
 * after (after the runtime's hashline/reminders/category-skill/recovery/rules/
 * comment-checker/plan-format/webfetch result transforms):
 *   1. delegate-task-retry
 *   2. empty-task-response-detector
 *   3. tool-output-truncator
 *
 * request (inside the single `session.hook("http.request")` pipeline, before
 * the keyword/roster seam reads the body):
 *   1. tool-pair-validator
 *   2. stop-continuation-guard
 *
 * `eventHandlers` is empty: no binder contributes an event-driven handler. The
 * background manager is driven imperatively by the runtime's existing event
 * loop, and the keyword/compaction state is fed by that same loop, so the array
 * stays a frozen empty extension point rather than a second subscription.
 */

import { beforeRules as flowGuardBeforeRules } from "./rigel-v2-native-flow-guards.mjs"
import {
  afterRules as flowAfterResultRules,
  createDelegateTaskRetryRule,
} from "./rigel-v2-native-flow-after.mjs"
import { requestSteps as nativeRequestSteps } from "./rigel-v2-native-request-steps.mjs"
import {
  createBashFileReadGuardRule,
  createEmptyTaskResponseRule,
  createToolOutputTruncatorRule,
} from "./rigel-v2-native-tool-guards.mjs"

/**
 * Build the four ordered collections. The declared order matches the module
 * exports below; the runtime calls this once in setup.
 */
export function createFlowRules({ truncateAllToolOutputs = false, taskToolName } = {}) {
  return Object.freeze({
    beforeRules: Object.freeze([...flowGuardBeforeRules, createBashFileReadGuardRule()]),
    afterRules: Object.freeze([
      createDelegateTaskRetryRule(),
      createEmptyTaskResponseRule({ taskToolName }),
      createToolOutputTruncatorRule({ truncateAll: truncateAllToolOutputs }),
    ]),
    requestSteps: nativeRequestSteps,
    eventHandlers: Object.freeze([]),
  })
}

/** `tool.execute.before` rules, appended after the built-in write guards. */
export const beforeRules = Object.freeze([...flowGuardBeforeRules, createBashFileReadGuardRule()])

/** `tool.execute.after` rules, appended after the built-in result transforms. */
export const afterRules = Object.freeze([...flowAfterResultRules, createEmptyTaskResponseRule(), createToolOutputTruncatorRule()])

/** Ordered `http.request` rewrite steps, composed into the single request hook. */
export const requestSteps = nativeRequestSteps

/** Durable V2 event handlers keyed by event type (empty extension point). */
export const eventHandlers = Object.freeze([])
