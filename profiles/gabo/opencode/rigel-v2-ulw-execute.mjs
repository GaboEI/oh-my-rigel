import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { reconcileStaleWorks } from "./rigel-v2-ulw-execute-boulder.mjs"
import { discoverPlans, findRecentSessionPlanPath, getPlanName, selectPlanByName } from "./rigel-v2-ulw-execute-plan.mjs"
import { createPrDeliveryBlock, detectWorktree } from "./rigel-v2-ulw-execute-worktree.mjs"
import { canonicalAgentKey } from "./rigel-v2-native-agent-order.mjs"

export const ULW_EXECUTE_MARKER = "<!-- omo-ulw-execute-context -->"
const TEMPLATE_MARKER = "You are starting an Atlas work session."
const NOTE_FILES = ["learnings.md", "decisions.md", "issues.md", "problems.md"]

function normalizedSessionID(sessionID) {
  return sessionID.startsWith("opencode:") ? sessionID : `opencode:${sessionID}`
}

function resolveRegisteredAgent(registeredAgents) {
  const find = (key) => registeredAgents.find((item) => canonicalAgentKey(item) === key) ?? null
  return find("atlas") ?? find("sisyphus")
}

function boulderPath(directory) {
  return join(directory, ".omo", "boulder.json")
}

export function parseUlwExecuteRequest(text) {
  const worktree = text.match(/--worktree(?:\s+(\S+))?/)?.[1] ?? null
  const makePr = /--make-pr\b/.test(text)
  const ship = /--ship\b/.test(text)
  const name = text.replace(/--worktree(?:\s+\S+)?|--make-pr\b|--ship\b|\b(?:ultrawork|ulw)\b/gi, "").trim()
  return { planName: name || null, worktree, makePr, ship }
}

export function substituteSessionContextPlaceholders(text, sessionID, timestamp) {
  const start = text.indexOf("<session-context>")
  const end = start < 0 ? -1 : text.indexOf("</session-context>", start)
  if (!text.includes(TEMPLATE_MARKER) || start < 0 || end < 0) return text
  const bodyStart = start + "<session-context>".length
  return `${text.slice(0, bodyStart)}${text.slice(bodyStart, end).replace(/\$SESSION_ID|\$TIMESTAMP/g, (token) => token === "$SESSION_ID" ? sessionID : timestamp)}${text.slice(end)}`
}

export function ensureNotepadScaffold({ directory, name }) {
  const target = join(directory, ".omo", "notepads", name)
  mkdirSync(target, { recursive: true })
  for (const file of NOTE_FILES) {
    try {
      writeFileSync(join(target, file), `# ${basename(file, ".md")} - ${name}\n\n---\n`, { flag: "wx" })
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
    }
  }
}

function readState(directory) {
  try { return JSON.parse(readFileSync(boulderPath(directory), "utf8")) } catch (error) {
    if (!(error instanceof Error)) throw error
    return null
  }
}

export function createBoulderState({ planPath, sessionID, agent, worktreePath, now }) {
  const session = normalizedSessionID(sessionID)
  const started = now.toISOString()
  const workID = `${getPlanName(planPath)}-${started.replace(/[^0-9]/g, "").slice(-8)}`
  const work = { work_id: workID, active_plan: planPath, plan_name: getPlanName(planPath), status: "active", started_at: started, updated_at: started, session_ids: [session], session_origins: { [session]: "direct" }, agent, ...(worktreePath ? { worktree_path: worktreePath } : {}), task_sessions: {} }
  return { schema_version: 2, active_work_id: workID, works: { [workID]: work }, ...work }
}

function writeState(directory, state) {
  mkdirSync(join(directory, ".omo"), { recursive: true })
  writeFileSync(boulderPath(directory), `${JSON.stringify(state, null, 2)}\n`)
}

function resumeState(directory, state, sessionID) {
  const session = normalizedSessionID(sessionID)
  const work = state?.works?.[state.active_work_id]
  if (!work || !["active", "paused"].includes(work.status)) return null
  work.session_ids ??= []
  if (!work.session_ids.includes(session)) work.session_ids.push(session)
  work.session_origins ??= {}
  work.session_origins[session] ??= "direct"
  work.status = "active"
  delete work.stale_since
  Object.assign(state, work, { works: { ...state.works, [work.work_id]: work } })
  writeState(directory, state)
  ensureNotepadScaffold({ directory, name: work.plan_name })
  return work
}

export function createUlwExecuteCommand({ context, directory, registeredAgents = [], stopContinuationState, now = () => new Date() }) {
  return {
    name: "ulw-execute",
    description: "Start or resume an Atlas work session from an Ultralwork plan.",
    execute: async ({ sessionID, prompt }) => {
      if (typeof sessionID !== "string" || !sessionID) return
      stopContinuationState?.clear(sessionID)
      const text = typeof prompt === "string" ? prompt : prompt?.text ?? ""
      if (typeof context.session.context === "function") {
        const existing = await context.session.context({ sessionID })
        if (JSON.stringify(existing).includes(ULW_EXECUTE_MARKER)) return
      }
      const input = parseUlwExecuteRequest(text)
      const agent = resolveRegisteredAgent(registeredAgents)
      if (!agent) {
        return context.session.prompt({ sessionID, text: `${TEMPLATE_MARKER}\n${ULW_EXECUTE_MARKER}\nNo registered Atlas or Sisyphus agent was found.` })
      }
      await context.session.switchAgent?.({ sessionID, agent })
      const worktree = detectWorktree(directory, input.worktree)
      let state = readState(directory)
      state = reconcileStaleWorks(state, now())
      if (state) writeState(directory, state)
      let work = resumeState(directory, state, sessionID)
      if (!work) {
        const available = discoverPlans(directory)
        const history = typeof context.session.context === "function" ? await context.session.context({ sessionID }) : []
        const preferred = input.planName ? null : findRecentSessionPlanPath(history, available)
        const selected = preferred ?? selectPlanByName(available, input.planName)
        if (!selected) {
          return context.session.prompt({ sessionID, text: `${TEMPLATE_MARKER}\n${ULW_EXECUTE_MARKER}\nNo unambiguous plan was found.${worktree.block}` })
        }
        state = createBoulderState({ planPath: selected, sessionID, agent, worktreePath: worktree.path, now: now() })
        writeState(directory, state)
        work = state.works[state.active_work_id]
        ensureNotepadScaffold({ directory, name: work.plan_name })
      }
      const timestamp = now().toISOString()
      const template = `${TEMPLATE_MARKER}\n<session-context>\nSession ID: $SESSION_ID\nStarted: $TIMESTAMP\n</session-context>`
      const delivery = `${substituteSessionContextPlaceholders(template, sessionID, timestamp)}\n${ULW_EXECUTE_MARKER}\nPlan: ${work.active_plan}\nAgent: ${agent}${worktree.block}${createPrDeliveryBlock(input, worktree.path)}`
      return context.session.prompt({ sessionID, text: delivery, resume: true })
    },
  }
}
