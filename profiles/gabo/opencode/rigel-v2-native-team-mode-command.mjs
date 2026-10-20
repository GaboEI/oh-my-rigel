// Native OpenCode V2 `/team-mode` command: the visible front door for a team run.
//
// The command is DETERMINISTIC. It parses the objective argument into an explicit
// team spec and then either:
//   - asks the few questions whose answers are still missing, creating NOTHING, or
//   - creates the team through the SAME `team_create` definition the agent calls,
//     so there is exactly one create contract in the runtime.
//
// It exists because a natural-language team request otherwise drifts to the
// upstream OmO contract (`inline_spec`, `teamName`, `lead`, `loadSkills`), which
// this runtime rejects by name. Stating one canonical contract up front is
// cheaper than rejecting the wrong one after the fact.
//
// Self-contained on purpose: imports only Node built-ins and sibling `./` modules
// that the discovery walker can follow.
import categoryManifest from "./rigel-v2-category-manifest.mjs"

const COMMAND_NAME = "team-mode"

/** The categories this runtime routes. Single source of truth: the category manifest. */
export const TEAM_MODE_CATEGORIES = Object.freeze(Object.keys(categoryManifest?.categories ?? {}))

/** The canonical create contract, restated wherever the command speaks to a model. */
export const TEAM_MODE_CREATE_CALL = "team_create({ team_name, members: [{ name, agent | category, prompt, model? }], worktree? })"

/** Upstream-only fields: naming one is a hard error, never a silent partial create. */
const UPSTREAM_ONLY_FIELDS = Object.freeze(["inline_spec", "teamName", "lead", "leadAgentId", "loadSkills", "sessionGroups"])

/** Identifiers that are never ordinary English, so a bare mention is unambiguous. */
const UNAMBIGUOUS_UPSTREAM_FIELDS = Object.freeze(["inline_spec", "teamName", "leadAgentId", "loadSkills", "sessionGroups"])

/**
 * Which upstream fields the objective names. `lead` is a plain English word, so it
 * only counts when it is used as a KEY ("lead:") or quoted; otherwise "lead the
 * audit" would be rejected as a contract violation.
 */
function upstreamFieldsIn(text) {
  return UPSTREAM_ONLY_FIELDS.filter((field) => (
    UNAMBIGUOUS_UPSTREAM_FIELDS.includes(field)
      ? new RegExp(`\\b${field}\\b`).test(text)
      : new RegExp(`"${field}"|\\b${field}\\s*[:=]`).test(text)
  ))
}

const MAX_MEMBERS = 8
const MIN_MEMBERS = 2

/** A lone word that means "forget it" rather than an objective. */
const CANCEL_INPUTS = Object.freeze(["cancel", "stop", "abort", "quit", "none", "never mind", "nevermind"])

/** Introduces the explicit member list. `team:` is deliberately absent: it names the team. */
const MEMBER_LIST_INTRO = /(?:^|[\s(])(?:members?|membership|roles?|teammates?)\s*[:=]\s*/i
const MEMBER_COUNT = /(?:^|\s)(\d{1,3})\s*(?:members?|teammates?|workers?|agents?)\b/i
const TEAM_NAME_DECLARATION = /\b(?:team_name|team\s+name|name|team)\s*[:=]\s*"?([\p{L}\p{N}][\p{L}\p{N} _-]*?)"?\s*(?=[,;.]|$)/iu

const FALLBACK_ASSIGNMENT = "Carry out the work for this role and report the outcome back to the lead."

const WORKTREE_QUESTIONS = "Should each member get its own git worktree, or share one working tree? (Shared is the default and is what keeps member panes visible.)"

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function slugify(value) {
  const slug = String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
  return slug || undefined
}

/**
 * The list runs to the end of its line or sentence, or up to the NEXT declaration:
 * `members: a=quick, b=low worktree: no` must not read `worktree` as a role.
 */
const MEMBER_LIST_BOUNDARY = /\n|[.!?](?:\s|$)|\b(?:worktrees?|team_name|team\s+name)\s*[:=]/i

function memberListSegment(text, fromIndex) {
  const rest = text.slice(fromIndex)
  const boundary = rest.search(MEMBER_LIST_BOUNDARY)
  return (boundary === -1 ? rest : rest.slice(0, boundary)).trim()
}

/**
 * One `name=category` / `name: category` / `name (category)` entry, with an
 * optional quoted per-member assignment. An entry with no separator is read as a
 * role whose CATEGORY is still missing, which is an answer to ask for rather than
 * an error to reject.
 */
function parseMemberEntry(raw) {
  let entry = String(raw ?? "").trim()
  if (!entry) return null
  let prompt
  const quoted = entry.match(/"([^"]+)"|'([^']+)'/)
  if (quoted) {
    prompt = (quoted[1] ?? quoted[2] ?? "").trim() || undefined
    entry = `${entry.slice(0, quoted.index)} ${entry.slice(quoted.index + quoted[0].length)}`.trim()
  }
  const match = entry.match(/^([\p{L}\p{N}][\p{L}\p{N} _-]*?)\s*(?:=\s*|\s*\(\s*|\s*:\s*)([a-z][a-z-]*)\s*\)?$/u)
  if (!match) return { name: entry.replace(/[,\s]+$/g, ""), category: undefined, prompt }
  return { name: match[1].trim().replace(/[,\s]+$/g, ""), category: match[2].trim().toLowerCase(), prompt }
}

function detectWorktreePolicy(text) {
  const explicit = text.match(/\bworktrees?\s*[:=]\s*(yes|true|on|no|false|off)\b/i)
  if (explicit) return /^(?:yes|true|on)$/i.test(explicit[1])
  if (/\bshared\s+(?:working\s+)?tree\b/i.test(text)) return false
  if (/\b(?:no|without)\s+worktrees?\b/i.test(text)) return false
  if (/\b(?:separate|own|per-member|individual)\s+worktrees?\b/i.test(text)) return true
  if (/\bworktrees?\b/i.test(text)) return true
  return undefined
}

function detectTeamName(text) {
  const match = text.match(TEAM_NAME_DECLARATION)
  return match ? slugify(match[1]) : undefined
}

/** Everything that is not a declaration: what the team is actually for. */
function residualObjective(text, consumed = []) {
  let rest = text
  for (const fragment of consumed) if (fragment) rest = rest.replace(fragment, " ")
  rest = rest.replace(MEMBER_COUNT, " ").replace(/\bworktrees?\s*[:=]\s*(?:yes|true|on|no|false|off)\b/gi, " ")
  return rest.replace(/\s+/g, " ").replace(/^[\s,;.]+|[\s,;.]+$/g, "").trim()
}

function closersFor(missing) {
  const questions = []
  for (const field of missing) {
    if (field === "roles") questions.push("Who are the members, and what is each one responsible for?")
    else if (field === "categories") questions.push("Which execution category should each member use?")
    else if (field === "members") questions.push(`How many members should the team have (${MIN_MEMBERS}-${MAX_MEMBERS})?`)
    else if (field === "worktree") questions.push(WORKTREE_QUESTIONS)
  }
  return questions
}

/**
 * Decide what `/team-mode <objective>` should do. Pure and deterministic.
 *
 * Returns one of:
 *   { kind: "cancel" }                                  - the user backed out; create NOTHING
 *   { kind: "ask", missing, questions, roles, worktree } - answers still missing; create NOTHING
 *   { kind: "malformed", reason }                        - reject with guidance; create NOTHING
 *   { kind: "create", spec }                             - decision-complete; spec is a valid
 *                                                          `team_create` argument object
 */
export function decideTeamModeAction({ objective, knownCategories = TEAM_MODE_CATEGORIES } = {}) {
  const text = typeof objective === "string" ? objective.trim() : ""
  const validCategories = new Set(Array.isArray(knownCategories) ? knownCategories : TEAM_MODE_CATEGORIES)

  if (text === "") {
    const missing = ["roles", "categories", "worktree"]
    return { kind: "ask", missing, questions: closersFor(missing), roles: [], worktree: undefined, objective: text }
  }

  if (CANCEL_INPUTS.includes(text.toLowerCase())) return { kind: "cancel", objective: text }

  // Naming an upstream field is the exact mistake this command exists to stop.
  const upstream = upstreamFieldsIn(text)
  if (upstream.length > 0) {
    return {
      kind: "malformed",
      reason: `${upstream.map((field) => `"${field}"`).join(", ")} is the upstream OmO contract, which this runtime does not accept. Nothing was created.`,
      objective: text,
    }
  }

  const intro = text.match(MEMBER_LIST_INTRO)
  let segment = ""
  const roles = intro
    ? memberListSegment(text, intro.index + intro[0].length)
      .split(/\s*[,;]\s*|\s+and\s+/i)
      .map(parseMemberEntry)
      .filter(Boolean)
    : []
  if (intro) segment = memberListSegment(text, intro.index + intro[0].length)

  const countMatch = text.match(MEMBER_COUNT)
  const declaredCount = countMatch ? Number(countMatch[1]) : undefined

  if (declaredCount !== undefined && (declaredCount < MIN_MEMBERS || declaredCount > MAX_MEMBERS)) {
    return {
      kind: "malformed",
      reason: `A team has between ${MIN_MEMBERS} and ${MAX_MEMBERS} members; ${declaredCount} cannot be created. Nothing was created.`,
      objective: text,
    }
  }

  const unknownCategory = roles.find((role) => role.category && !validCategories.has(role.category))
  if (unknownCategory) {
    return {
      kind: "malformed",
      reason: `Member "${unknownCategory.name}" asks for category "${unknownCategory.category}", which this runtime does not route. Nothing was created.`,
      validCategories: [...validCategories],
      objective: text,
    }
  }

  if (declaredCount !== undefined && roles.length > 0 && declaredCount !== roles.length) {
    return {
      kind: "malformed",
      reason: `The objective declares ${declaredCount} members but names ${roles.length} (${roles.map((role) => role.name).join(", ")}). Nothing was created.`,
      objective: text,
    }
  }

  const duplicate = roles.find((role, index) => roles.findIndex((other) => other.name === role.name) !== index)
  if (duplicate) {
    return {
      kind: "malformed",
      reason: `Member name "${duplicate.name}" appears twice; every member name must be unique. Nothing was created.`,
      objective: text,
    }
  }

  const worktree = detectWorktreePolicy(text)
  const missing = []
  if (roles.length === 0) missing.push("roles")
  if (roles.some((role) => !role.category)) missing.push("categories")
  if (worktree === undefined) missing.push("worktree")

  if (missing.length > 0) {
    return { kind: "ask", missing, questions: closersFor(missing), roles, worktree, objective: text }
  }

  const consumed = [intro?.[0], segment, text.match(TEAM_NAME_DECLARATION)?.[0], text.match(MEMBER_COUNT)?.[0]]
  const residual = residualObjective(text, consumed)
  const assignment = residual || FALLBACK_ASSIGNMENT
  return {
    kind: "create",
    objective: text,
    spec: {
      team_name: detectTeamName(text) ?? slugify(residual.split(/\s+/).slice(0, 3).join(" ")) ?? COMMAND_NAME,
      members: roles.map((role) => ({
        name: role.name,
        category: role.category,
        prompt: role.prompt ?? assignment,
      })),
      worktree,
    },
  }
}

/**
 * A raw top-level `/team-mode <objective>` prompt. The host does not always
 * resolve a typed slash into the command executor (a literal TUI paste reaches
 * the prompt seam as text), so the same parser owns both entry points. Returns
 * the objective, or `null` when the text is not this command.
 */
export function parseTeamModeInvocation(text) {
  const match = /^\s*\/team-mode(?:\s+([\s\S]*))?$/i.exec(String(text ?? ""))
  return match ? (match[1] ?? "").trim() : null
}

function contractLines() {
  return [
    `Canonical contract (the ONLY create API): ${TEAM_MODE_CREATE_CALL}`,
    `Valid categories: ${TEAM_MODE_CATEGORIES.join(", ")}.`,
    "Never call the upstream shape (`inline_spec`, `teamName`, `lead`, `loadSkills`): it is not reachable here and is rejected by name.",
    "Every member gets a real delegated child session; that is what makes its tmux pane appear.",
  ]
}

/**
 * The instruction the command injects into the session turn. It always states the
 * canonical contract and the outcome of the deterministic decision, so the agent
 * never has to guess the create shape or whether a team was already created.
 */
export function renderTeamModeCommandPrompt({ decision, objective = "", report, createTeamAvailable = true } = {}) {
  const lines = ["You are handling the `/team-mode` command. Team Mode starts a coordinated team run."]
  if (objective.trim()) lines.push("", `The user's objective: ${objective.trim()}`)
  lines.push("", ...contractLines(), "")

  if (decision?.kind === "cancel") {
    lines.push("The user cancelled. NO team was created and no member session was started.", "Do not create anything. Acknowledge the cancellation and stop.")
    return lines.join("\n")
  }

  if (decision?.kind === "malformed") {
    lines.push(`The request was rejected before any side effect: ${decision.reason}`)
    if (Array.isArray(decision.validCategories) && decision.validCategories.length > 0) {
      lines.push(`Categories this runtime routes: ${decision.validCategories.join(", ")}.`)
    }
    lines.push("NOTHING was created and no member session was started.", "Explain the problem to the user and ask for the corrected team definition. Do not retry the rejected shape.")
    return lines.join("\n")
  }

  if (decision?.kind === "ask") {
    lines.push(
      `The team definition is still incomplete (missing: ${decision.missing.join(", ")}).`,
      "NOTHING was created and no member session was started.",
      "Ask ONLY these questions, briefly, in one message, then stop and wait for the answers:",
      ...decision.questions.map((question, index) => `${index + 1}. ${question}`),
      "",
      "Do not create the team, do not spawn anything, and do not invent the missing answers yourself. Once the answers arrive, call the canonical contract above directly.",
    )
    return lines.join("\n")
  }

  if (decision?.kind === "create") {
    if (report?.created === true) {
      lines.push(
        `The team was CREATED through the canonical contract: ${JSON.stringify(decision.spec)}`,
        `Runtime result: ${typeof report.result === "string" ? report.result : JSON.stringify(report.result)}`,
        "",
        "Continue the lifecycle with the team tools: `team_task_create` for the work, `team_send_message` to reach members, `team_status` to observe, and `team_delete` when the work is done so member panes close.",
      )
      return lines.join("\n")
    }
    if (report?.created === false) {
      lines.push(
        `Creating the team FAILED: ${report.error}`,
        "Report that failure to the user verbatim, then stop: do not create the team again in this turn, and do not silently rewrite the spec to make it pass.",
        "If the failure is about the worktree policy (for example the project is not a git repository), do NOT switch worktree: true to worktree: false on your own. That policy is the user's choice, not yours: ask the user to confirm the change explicitly, and create the team again only AFTER they confirm.",
      )
      return lines.join("\n")
    }
    lines.push(
      `The definition is decision-complete. Create it now with EXACTLY this call: ${TEAM_MODE_CREATE_CALL} and these arguments: ${JSON.stringify(decision.spec)}`,
      createTeamAvailable
        ? "Do not ask further questions first."
        : "The team tool is not registered in this session, so report that Team Mode is unavailable instead of substituting another mechanism.",
    )
    return lines.join("\n")
  }

  lines.push("No decision could be made. Nothing was created. Ask the user for the team definition.")
  return lines.join("\n")
}

/**
 * The ONE executable decision: parse/decide, perform the only side effect on the
 * decision-complete branch, and render the exact turn text. Both the visible
 * command executor and the prompt seam call this, so there is no second create
 * contract and no path where the model has to decide to call `team_create`.
 */
export async function evaluateTeamModeInvocation({ objective, createTeam, knownCategories = TEAM_MODE_CATEGORIES, sessionID } = {}) {
  const text = typeof objective === "string" ? objective.trim() : ""
  const decision = decideTeamModeAction({ objective: text, knownCategories })

  let report
  if (decision.kind === "create" && typeof createTeam === "function") {
    try {
      report = { created: true, result: await createTeam(decision.spec, { sessionID }) }
    } catch (error) {
      report = { created: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  return {
    decision,
    report,
    text: renderTeamModeCommandPrompt({
      decision,
      objective: text,
      report,
      createTeamAvailable: typeof createTeam === "function",
    }),
  }
}

/**
 * The prompt-seam handler for `/team-mode`. `resolveCreateTeam` is read at call
 * time because the `team_create` definition is registered after the prompt hook,
 * and it returns the CALLABLE port: the same one the command executor receives.
 */
export function createTeamModePromptHandler({ resolveCreateTeam, knownCategories = TEAM_MODE_CATEGORIES } = {}) {
  return async ({ args, sessionID } = {}) => {
    const createTeam = typeof resolveCreateTeam === "function" ? resolveCreateTeam() : undefined
    const { text } = await evaluateTeamModeInvocation({
      objective: typeof args === "string" ? args : "",
      createTeam,
      knownCategories,
      sessionID,
    })
    return text
  }
}

/**
 * Adapt a registered `team_create` tool definition into the callable create port.
 * Both the visible command and the prompt seam derive their port here, so the
 * runtime has exactly one create contract. A definition without `execute` (gate
 * off, or the definition not registered yet) yields no port at all.
 */
export function teamCreatePortFromTool(tool) {
  return typeof tool?.execute === "function" ? (spec, toolContext) => tool.execute(spec, toolContext) : undefined
}

/**
 * Build the `/team-mode` command definition. `execute` decides deterministically;
 * only the decision-complete branch performs a side effect, and it does so through
 * the injected `createTeam` port (the real `team_create` definition). The ask,
 * cancel and malformed branches create nothing at all.
 */
export function createTeamModeCommand({ context, createTeam, knownCategories = TEAM_MODE_CATEGORIES } = {}) {
  return {
    name: COMMAND_NAME,
    description: "Start a team run: /team-mode <objective>. Asks only for the member roles, categories or worktree policy that the objective leaves out, and creates the team directly once they are all specified.",
    execute: async ({ sessionID, prompt, delivery } = {}) => {
      if (typeof sessionID !== "string" || sessionID.length === 0) return
      if (typeof context?.session?.prompt !== "function") return
      const base = prompt !== null && typeof prompt === "object" ? prompt : {}
      const rawText = typeof prompt === "string" ? prompt : typeof prompt?.text === "string" ? prompt.text : ""
      // The host may pass the arguments alone or the whole visible slash text.
      const objective = parseTeamModeInvocation(rawText) ?? rawText
      const { text } = await evaluateTeamModeInvocation({ objective, createTeam, knownCategories, sessionID })
      await context.session.prompt({ ...base, sessionID, text, delivery })
    },
  }
}

/**
 * Register the command when the host exposes a command domain and the name is not
 * denied by the materialized `disabled_commands` gate. Returns the host
 * registration (with `dispose`), or `undefined` so the caller can dispose uniformly.
 */
export async function registerTeamModeCommand(options = {}) {
  const { context } = options
  if (typeof context?.command?.transform !== "function") return undefined
  const disabled = new Set(Array.isArray(options.disabledCommands) ? options.disabledCommands : [])
  if (disabled.has(COMMAND_NAME)) return undefined
  return context.command.transform((editor) => editor.add(createTeamModeCommand(options)))
}

export { COMMAND_NAME as TEAM_MODE_COMMAND_NAME, MAX_MEMBERS as TEAM_MODE_MAX_MEMBERS }
