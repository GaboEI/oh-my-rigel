/** The model-controlled arguments that must never determine a goal's limits. */
export const GOAL_BUDGET_FIELDS = Object.freeze(["token_budget", "max_auto_turns", "max_duration_seconds"])

/** The vendor goal tools that accept goal budget arguments before this guard hardens them. */
export const GOAL_BUDGET_TOOLS = Object.freeze(["create_goal", "set_goal", "replace_goal"])

/** The stable marker that lets every session payload receive this instruction at most once. */
export const BUDGET_GUARD_MARKER = "Rigel goal budget policy:"

/** The model-visible policy that makes configuration, rather than a tool call, own every goal limit. */
export const BUDGET_GUARD_INSTRUCTION = `${BUDGET_GUARD_MARKER} Never supply token_budget, max_auto_turns or max_duration_seconds; they are stripped before the engine sees them. A goal's limits are exactly what opencode.json configures for the goal engine; omitting a field means "no limit", which is the managed default. Pass only the objective; if the user wants a specific budget they must change opencode.json.`

/** The stable console prefix that identifies a rejected model-supplied goal budget. */
export const BUDGET_GUARD_LOG_PREFIX = "[rigel-goal-engine] "

/**
 * Emit a single safe operational notice for a discarded budget so operators can
 * see attempted policy bypasses without changing the successful tool result.
 */
export function defaultBudgetNotice({ tool, fields }) {
  if (typeof console?.warn !== "function") return
  console.warn(`${BUDGET_GUARD_LOG_PREFIX}discarded model-supplied goal budget on ${tool}: ${fields.join(", ")}; limits come from opencode.json`)
}

/**
 * Return whether a value can carry named tool arguments, excluding arrays so the
 * guard can copy and filter only JSON-object-shaped inputs without changing others.
 */
function isArgumentObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * Return a new arguments object with model-supplied budget keys removed, keeping
 * non-object inputs unchanged because vendor tools may rely on their original shape.
 */
export function stripGoalBudgetArgs(args) {
  if (!isArgumentObject(args)) return args
  const stripped = { ...args }
  for (const field of GOAL_BUDGET_FIELDS) delete stripped[field]
  return stripped
}

/**
 * List the model-supplied budget keys present on an argument object so callers
 * can observe stripped attempts without recording arbitrary tool arguments.
 */
export function presentBudgetFields(args) {
  if (!isArgumentObject(args)) return []
  return GOAL_BUDGET_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(args, field))
}

/**
 * Build a copy of a vendor goal tool that accepts legacy budget fields but strips
 * them before execution, so only plugin configuration can set a goal's limits.
 */
export function hardenGoalTool(definition, options = {}) {
  if (!definition || !GOAL_BUDGET_TOOLS.includes(definition.name)) return definition

  const input = definition.input
  const properties = isArgumentObject(input?.properties) ? { ...input.properties } : input?.properties
  if (isArgumentObject(properties)) {
    for (const field of GOAL_BUDGET_FIELDS) delete properties[field]
  }
  const required = Array.isArray(input?.required)
    ? input.required.filter((field) => !GOAL_BUDGET_FIELDS.includes(field))
    : input?.required
  const hardened = {
    ...definition,
    description: `${definition.description ?? ""}\n\nBudget parameters are not accepted from the model; limits come only from the plugin configuration.`,
    input: {
      ...input,
      properties,
      required,
      additionalProperties: true,
    },
  }

  if (typeof definition.execute !== "function") return hardened

  hardened.execute = async (args, toolContext) => {
    const fields = presentBudgetFields(args)
    const onStripped = typeof options.onStripped === "function" ? options.onStripped : defaultBudgetNotice
    if (fields.length > 0) {
      try {
        onStripped({ tool: definition.name, fields })
      } catch {
        // A logger must never prevent the goal engine from creating a goal.
      }
    }
    return definition.execute(stripGoalBudgetArgs(args), toolContext)
  }
  return hardened
}

/**
 * Create a tool editor facade whose add operation hardens vendor definitions
 * while retaining every other editor member through the original prototype.
 */
function withHardenAdd(draft, options) {
  const guardedDraft = Object.create(draft)
  guardedDraft.add = (definition) => draft.add(hardenGoalTool(definition, options))
  return guardedDraft
}

/**
 * Add the policy instruction after the vendor hook runs, once per system array,
 * so model context explains the enforced configuration-owned budget contract.
 */
function ensureInstruction(payload) {
  if (!Array.isArray(payload?.system)) return
  if (payload.system.some((part) => part?.type === "text" && typeof part.text === "string" && part.text.includes(BUDGET_GUARD_MARKER))) return
  payload.system.push({ type: "text", text: BUDGET_GUARD_INSTRUCTION })
}

/**
 * Clone the V2 context on top of its prototype and intercept only tool creation
 * and model-context hooks, leaving all unrelated vendor registrations intact.
 */
function guardedContext(context, options) {
  const guarded = Object.create(context)
  const originalTool = context.tool ?? {}
  const originalSession = context.session ?? {}
  const originalTransform = originalTool.transform
  const originalHook = originalSession.hook

  guarded.tool = {
    ...originalTool,
    ...(typeof originalTransform === "function"
      ? {
          transform: (callback) => originalTransform.call(originalTool, (draft) => callback(withHardenAdd(draft, options))),
        }
      : {}),
  }
  guarded.session = {
    ...originalSession,
    ...(typeof originalHook === "function"
      ? {
          hook: (name, callback) => originalHook.call(originalSession, name, (payload) => {
            const result = callback(payload)
            if (name !== "context" && name !== "compaction") return result
            if (result && typeof result.then === "function") {
              return result.then((value) => {
                ensureInstruction(payload)
                return value
              })
            }
            ensureInstruction(payload)
            return result
          }),
        }
      : {}),
  }
  return guarded
}

/**
 * Wrap a vendored goal plugin at the Rigel-owned shim seam, preserving its
 * identity and registrations while preventing model calls from choosing limits.
 */
export default function guardGoalEngine(vendor, options = {}) {
  if (!vendor || typeof vendor.setup !== "function") return vendor
  return {
    ...vendor,
    setup: (context) => vendor.setup(guardedContext(context, options)),
  }
}
