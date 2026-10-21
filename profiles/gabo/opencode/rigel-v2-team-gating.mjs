/**
 * Native V2 team gating and context injectors (correction H2; V1 parity:
 * `hooks/team-tool-gating/hook.ts`, `hooks/team-mailbox-injector/hook.ts`,
 * `hooks/team-mode-status-injector/hook.ts`), operating on the native team
 * storage model written by `tools/team.tools.mjs`.
 *
 * Teams are namespaced per project (`rigel-v2/team/<projectKey>/<name>`). The
 * gating scans the project namespaces and matches by the CALLING session: a
 * session participates in exactly one team, so a tool call binds to that team's
 * record and never to a same-named team in another project.
 *
 * Gating policy (tool.execute.before rule, team_mode gate):
 * - `team_create`: denied when the calling session is already a participant of
 *   any team.
 * - `team_delete` / `team_shutdown_request`: lead of the named team only.
 * - `team_approve_shutdown` / `team_reject_shutdown`: participant of the named team.
 * - `team_list`: open.
 * - universal tools: any participant of the named team.
 * A denial throws, which blocks the tool call in the V2 execute.before chain.
 */

import { TEAM_RECORD_ROOT } from "./rigel-v2-team-project-scope.mjs"

async function scanTeamEntries(storage) {
  if (!storage || typeof storage.scan !== "function") return []
  const result = await storage.scan({ prefix: TEAM_RECORD_ROOT })
  return (result?.entries ?? [])
    .filter((entry) => entry && typeof entry.key === "string" && entry.value && typeof entry.value === "object")
    .map((entry) => ({ key: entry.key, team: entry.value }))
}

function participantOf(team, sessionID) {
  if (team.leaderSessionID === sessionID) return "lead"
  if ((team.members ?? []).some((member) => member?.sessionID === sessionID)) return "member"
  return undefined
}

export function resolveNativeTeamParticipant(team, sessionID) {
  return participantOf(team, sessionID) ?? "neither"
}

/**
 * Resolve, from the DURABLE team records, whether a session is a member of a team.
 *
 * A member session's pane has to outlive its idle turns, and that decision is taken
 * by whichever process ends up owning the pane. The daemon that spawned the member
 * and the TUI that draws it are SEPARATE plugin instances, so a per-instance set
 * answers only for the process that happened to create the member. The team record is
 * the shared fact both of them can read.
 *
 * A source that cannot be READ is NOT the same answer as "not a member": the caller
 * must be able to tell "this session is not a member" from "I could not find out", or a
 * member's pane would be closed like an ordinary child's. A storage that exposes no
 * scan surface at all is a missing source (the caller keeps its own fallback); a scan
 * that FAILS is reported to the caller.
 */
export function createTeamMemberSessionResolver({ storage } = {}) {
  return async (sessionID) => {
    if (typeof sessionID !== "string" || sessionID.length === 0) return false
    if (!storage || typeof storage.scan !== "function") return false
    const entries = await scanTeamEntries(storage)
    return entries.some((entry) => (entry.team.members ?? []).some((member) => member?.sessionID === sessionID))
  }
}

function isRealUserMessage(message) {
  return message?.role === "user" && message.synthetic !== true && message.internal !== true
}

function prependToLastUserMessage(event, block) {
  if (!Array.isArray(event?.messages)) return false
  const message = [...event.messages].reverse().find(isRealUserMessage)
  if (!message) return false
  const separator = "\n\n---\n\n"
  if (typeof message.content === "string") {
    message.content = `${block}${separator}${message.content}`
    return true
  }
  if (!Array.isArray(message.content)) return false
  const text = message.content.find((part) => part?.type === "text" && typeof part.text === "string")
  if (!text) return false
  text.text = `${block}${separator}${text.text}`
  return true
}

export function createNativeTeamGatingRule({ storage } = {}) {
  if (!storage || typeof storage.get !== "function") {
    throw new Error("V2 storage is required for native team gating")
  }
  return {
    name: "team-tool-gating",
    async run(event) {
      const toolName = typeof event?.tool === "string" ? event.tool : ""
      if (!toolName.startsWith("team_")) return
      const sessionID = event?.sessionID
      const entries = await scanTeamEntries(storage)

      if (toolName === "team_create") {
        const participation = entries.find((entry) => participantOf(entry.team, sessionID) !== undefined)
        if (participation) throw new Error(`team_create denied: session is already a participant of team ${participation.team.name}`)
        return
      }

      const requested = event?.input?.team_name ?? event?.input?.name
      const named = entries.filter((entry) => entry.team.name === requested)
      const participant = named.find((entry) => participantOf(entry.team, sessionID) !== undefined)

      if (toolName === "team_delete" || toolName === "team_shutdown_request") {
        if (!named.some((entry) => participantOf(entry.team, sessionID) === "lead")) {
          throw new Error(`${toolName} is lead-only`)
        }
        return
      }

      if (toolName === "team_approve_shutdown" || toolName === "team_reject_shutdown") {
        if (!participant) {
          throw new Error(`${toolName}: caller must be a participant of team ${requested ?? "(unknown)"}`)
        }
        return
      }

      if (toolName === "team_list") return

      if (!participant) {
        throw new Error(`${toolName} requires participation in team ${requested ?? "(unknown)"}`)
      }
    },
  }
}

export function createNativeTeamMailboxInjector({ storage } = {}) {
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") {
    throw new Error("V2 storage is required for native team mailbox injection")
  }
  return async (event) => {
    if (!Array.isArray(event?.messages) || typeof event.sessionID !== "string") return
    for (const { key, team } of await scanTeamEntries(storage)) {
      const member = (team.members ?? []).find((entry) => entry?.sessionID === event.sessionID)
      if (!member) continue
      const unread = (team.messages ?? []).filter((message) => message?.to === member.name && message.read === false)
      if (unread.length === 0) continue
      const block = `<team-mailbox team="${team.name}">\n${unread.map((message) => `- from ${message.from ?? "unknown"}: ${message.text}`).join("\n")}\n</team-mailbox>`
      if (prependToLastUserMessage(event, block)) {
        await storage.set(key, {
          ...team,
          messages: (team.messages ?? []).map((message) => message?.to === member.name && message.read === false ? { ...message, read: true } : message),
        })
      }
      return
    }
  }
}

export function createNativeTeamStatusInjector({ storage } = {}) {
  if (!storage || typeof storage.scan !== "function") {
    throw new Error("V2 storage is required for native team status injection")
  }
  return async (event) => {
    if (!Array.isArray(event?.messages) || typeof event.sessionID !== "string") return
    for (const { team } of await scanTeamEntries(storage)) {
      if (participantOf(team, event.sessionID) === undefined) continue
      const members = (team.members ?? [])
        .map((member) => `- ${member.name}: ${member.status}${member.error ? ` (${member.error})` : ""}`)
        .join("\n")
      const block = `<team-status team="${team.name}" status="${team.status}">\n${members || "(no members)"}\n</team-status>`
      prependToLastUserMessage(event, block)
      return
    }
  }
}
