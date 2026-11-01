import { relative, resolve, isAbsolute } from "node:path"
import { patchToolArgs } from "./rigel-v2-native-tool-args.mjs"
import { resolveDelegationToolName } from "./rigel-v2-native-flow-guards.mjs"

/**
 * Native OpenCode V2 port of the V1 `prometheus-md-only` hook.
 *
 * Prometheus is a planning agent: it may only write `.omo/**\/*.md` plan files,
 * it must be reminded of the mandatory workflow on every plan write, and any
 * `task`/`call_omo_agent`/`rigel_task` prompt it issues carries a read-only
 * planning context so a delegated model cannot implement. This module is pure
 * (no filesystem access); the orchestrator injects the session-agent resolver.
 */

export const HOOK_NAME = "prometheus-md-only"

export const PROMETHEUS_AGENT = "prometheus"

export const ALLOWED_EXTENSIONS = [".md"]

export const PLANNING_CONTEXT_OPEN = `<planning-context source="prometheus-read-only">`
export const PLANNING_CONTEXT_CLOSE = `</planning-context>`

const TASK_TOOLS = new Set(["task", "call_omo_agent", "rigel_task"])
const BLOCKED_TOOLS = new Set(["write", "edit"])
const PLANS_SEGMENT = ".omo/plans/"

/**
 * XML-tag wrapper used to mark the planning-context boundary in prompts
 * forwarded to external LLMs via task(). This format intentionally avoids
 * the `[SYSTEM DIRECTIVE: ...]` bracket syntax that Azure OpenAI Prompt Shield
 * flags as indirect prompt injection in user-role content (#4036).
 */
export const PLANNING_CONSULT_WARNING = `

---

<planning-context source="prometheus-read-only">

You are being invoked by Prometheus - Plan Builder, a planning agent restricted to .omo/*.md plan files only.

**CRITICAL CONSTRAINTS:**
- DO NOT modify any files (no Write, Edit, or any file mutations)
- DO NOT execute commands that change system state
- DO NOT create, delete, or rename files
- ONLY provide analysis, recommendations, and information

**YOUR ROLE**: Provide consultation, research, and analysis to assist with planning.
Return your findings and recommendations. The actual implementation will be handled separately after planning is complete.

</planning-context>

---

`

/** Resolved once: the reminder must never name a tool the session does not expose. */
const DELEGATION_TOOL_NAME = resolveDelegationToolName()

/** `subagent_type`, not `agent` - the tool schema accepts only the former. */
function workflowCallRow(agentName) {
  const body = `- ${DELEGATION_TOOL_NAME}(subagent_type="${agentName}", ...)`
  return `│      │    ${body}${" ".repeat(Math.max(0, 58 - body.length))}│`
}

export const PROMETHEUS_WORKFLOW_REMINDER = `

---

[SYSTEM DIRECTIVE: OH-MY-OPENCODE - PROMETHEUS READ-ONLY]

## PROMETHEUS MANDATORY WORKFLOW REMINDER

**You are writing a work plan. STOP AND VERIFY you completed ALL steps:**

┌─────────────────────────────────────────────────────────────────────┐
│                     PROMETHEUS WORKFLOW                             │
├──────┬──────────────────────────────────────────────────────────────┤
│  1   │ INTERVIEW: Full consultation with user                       │
│      │    - Gather ALL requirements                                 │
│      │    - Clarify ambiguities                                     │
│      │    - Record decisions to .omo/drafts/                   │
├──────┼──────────────────────────────────────────────────────────────┤
│  2   │ METIS CONSULTATION: Pre-generation gap analysis              │
${workflowCallRow("Metis - Plan Consultant")}
│      │    - Identify missed questions, guardrails, assumptions      │
├──────┼──────────────────────────────────────────────────────────────┤
│  3   │ PLAN GENERATION: Write to .omo/plans/*.md               │
│      │    <- YOU ARE HERE                                           │
├──────┼──────────────────────────────────────────────────────────────┤
│  4   │ MOMUS REVIEW (if high accuracy requested)                    │
${workflowCallRow("Momus - Plan Critic")}
│      │    - Loop until OKAY verdict                                 │
├──────┼──────────────────────────────────────────────────────────────┤
│  5   │ SUMMARY: Present to user                                     │
│      │    - Key decisions made                                      │
│      │    - Scope IN/OUT                                            │
│      │    - Offer: "Start Work" vs "High Accuracy Review"           │
│      │    - Guide to /ulw-execute                                    │
└──────┴──────────────────────────────────────────────────────────────┘

**DID YOU COMPLETE STEPS 1-2 BEFORE WRITING THIS PLAN?**
**AFTER WRITING, WILL YOU DO STEPS 4-5?**

If you skipped steps, STOP NOW. Go back and complete them.

---

`

export function isPrometheusAgent(agentName) {
  return agentName?.toLowerCase().includes(PROMETHEUS_AGENT) ?? false
}

export function isPrometheusMdBlockedTool(tool) {
  return BLOCKED_TOOLS.has(String(tool).toLowerCase())
}

/**
 * Cross-platform path validator for Prometheus file writes (ported verbatim
 * from the V1 path-policy). Uses path.resolve/relative instead of string
 * matching to handle Windows separators, mixed separators, case-insensitive
 * directory/extension matching, workspace confinement, and nested project
 * paths.
 */
export function isAllowedFile(filePath, workspaceRoot) {
  const resolved = resolve(workspaceRoot, filePath)
  const rel = relative(workspaceRoot, resolved)

  if (rel.startsWith("..") || isAbsolute(rel)) {
    return false
  }

  if (!/(^|[/\\])\.omo([/\\]|$)/i.test(rel)) {
    return false
  }

  const hasAllowedExtension = ALLOWED_EXTENSIONS.some(
    ext => resolved.toLowerCase().endsWith(ext.toLowerCase())
  )
  if (!hasAllowedExtension) {
    return false
  }

  return true
}

/**
 * Build the native V2 Prometheus guard wired as one `tool.execute.before`
 * hook. `resolveAgent({ sessionID })` is supplied by the orchestrator
 * (`createSessionAgentResolver`); `directory` is the workspace root used for
 * path confinement.
 */
export function createNativePrometheusMdOnly({ resolveAgent, directory } = {}) {
  const workspace = directory ?? process.cwd()

  return {
    async before(event) {
      if (!event || typeof event !== "object") return

      const resolved = typeof resolveAgent === "function"
        ? await resolveAgent({ sessionID: event.sessionID })
        : undefined
      if (!isPrometheusAgent(resolved)) {
        return
      }

      const tool = String(event.tool)
      const args = event.args ?? event.input ?? {}

      if (TASK_TOOLS.has(tool)) {
        const prompt = args.prompt
        if (typeof prompt === "string" && prompt && !prompt.includes(PLANNING_CONTEXT_OPEN)) {
          patchToolArgs(event, (target) => { target.prompt = PLANNING_CONSULT_WARNING + prompt })
        }
        return
      }

      if (!isPrometheusMdBlockedTool(tool)) {
        return
      }

      const filePath = args.filePath ?? args.path ?? args.file
      if (typeof filePath !== "string" || !filePath) {
        return
      }

      if (!isAllowedFile(filePath, workspace)) {
        throw new Error(
          `[${HOOK_NAME}] Prometheus is a planning agent. File operations restricted to .omo/*.md plan files only. ` +
          `Do NOT route this change through a subagent either - delegated implementation is still implementation. ` +
          `Record the intended change as a todo in the plan; implementation starts only when the user runs /ulw-execute. ` +
          `Attempted to modify: ${filePath}.`
        )
      }

      const normalizedPath = filePath.toLowerCase().replace(/\\/g, "/")
      if (normalizedPath.includes(PLANS_SEGMENT) && typeof event.message === "string") {
        event.message = event.message + PROMETHEUS_WORKFLOW_REMINDER
      }
    },
  }
}
