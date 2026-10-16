/**
 * Ordered, failure-isolated rule chain for the native OpenCode V2 tool hooks.
 *
 * The V2 runtime registers ONE handler per `tool.hook` event and V2 awaits that
 * handler serially. `rigel-v2-native.mjs` composes several rules inside each
 * handler: the `execute.after` block (hashline, reminders, category-skill
 * reminder, recovery, rules, comment-checker, plan-format validator, webfetch
 * guard) and the `execute.before` write-guard block (prometheus-md-only,
 * write-existing-file guard, comment-checker, webfetch guard). Before this
 * helper a single rule that threw aborted every later rule in the same event,
 * so one newly added throwing rule could silently disable the whole downstream
 * chain.
 *
 * `runOrderedRules` runs the rules in their declared order, catches a throwing
 * rule into a `{ name, error }` failure, and continues with the next rule. The
 * collected failures are returned at the boundary so the caller decides whether
 * a degraded chain should fail the event or merely be logged; the optional
 * `onError` callback observes each failure as it happens.
 *
 * A rule is either a bare function or a `{ name, run }` object. `run` receives
 * the same `input` the event carried. `name` is used verbatim in the recorded
 * failure; a rule without a name falls back to `rule[index]`. A rule that has
 * no callable function is itself recorded as a failure and does not stop the
 * chain.
 */

function ruleName(rule, index) {
  const declared = typeof rule === "function" ? rule.name : rule?.name
  return typeof declared === "string" && declared.length > 0 ? declared : `rule[${index}]`
}

/**
 * Run each rule in declared order, isolating any rule that throws.
 *
 * @param {ReadonlyArray<Function | { name?: string, run?: Function }>} rules
 * @param {unknown} input passed unchanged to every rule's run function
 * @param {{ onError?: (failure: { name: string, error: unknown }) => void }} [options]
 * @returns {Promise<{ failures: Array<{ name: string, error: unknown }>, executed: string[] }>}
 *   `executed` lists the rules that ran to completion, in order; `failures`
 *   lists every isolated rule with the value it threw.
 */
export async function runOrderedRules(rules, input, options = {}) {
  if (!Array.isArray(rules)) {
    throw new TypeError("runOrderedRules: rules must be an array")
  }
  const failures = []
  const executed = []
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index]
    const name = ruleName(rule, index)
    try {
      const run = typeof rule === "function" ? rule : rule?.run
      if (typeof run !== "function") {
        throw new TypeError(`rule "${name}" has no runnable function`)
      }
      await run(input)
      executed.push(name)
    } catch (error) {
      const failure = { name, error }
      failures.push(failure)
      if (typeof options.onError === "function") {
        try {
          options.onError(failure)
        } catch (observerError) {
          failures.push({ name: `${name}#onError`, error: observerError })
        }
      }
    }
  }
  return { failures, executed }
}

/**
 * Rule names whose contract is to DENY an action. `runOrderedRules` isolates a
 * throwing rule and keeps going, which is correct for annotating rules but
 * wrong for a guard: a block phrased as a rule throw would be recorded and
 * ignored, letting the tool run. `createBlockingBeforeRunner` runs the chain
 * exactly as before and then RE-ASSERTS a blocking failure at the hook
 * boundary, whose throw V2 treats as a denial (the same seam the permission
 * gate uses). The chain's own isolation is unchanged.
 */
export const BLOCKING_RULE_NAMES = new Set(["write-existing-file-guard", "notepad-write-guard"])

/**
 * Build the `tool.execute.before` handler that runs `rules` through the
 * isolating chain and re-throws the first blocking failure. A non-blocking rule
 * that throws is still isolated (the handler resolves), so the general
 * isolation contract is preserved.
 */
export function createBlockingRuleRunner({ blockingNames = BLOCKING_RULE_NAMES } = {}) {
  const names = blockingNames instanceof Set ? blockingNames : new Set(blockingNames)
  return async (rules, input, options = {}) => {
    const outcome = await runOrderedRules(rules, input, options)
    const blocked = outcome.failures.find((failure) => names.has(failure.name))
    if (blocked) throw blocked.error
    return outcome
  }
}
