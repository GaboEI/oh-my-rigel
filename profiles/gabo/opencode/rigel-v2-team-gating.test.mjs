import { describe, expect, test } from "bun:test"
import {
  createNativeTeamGatingRule,
  createNativeTeamMailboxInjector,
  createNativeTeamStatusInjector,
  createTeamMemberSessionResolver,
  resolveNativeTeamParticipant,
} from "./rigel-v2-team-gating.mjs"

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key) : undefined },
    async set(key, value) { map.set(key, value) },
    async scan({ prefix = "" } = {}) {
      return { entries: [...map.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }
    },
  }
}

const TEAM = {
  name: "builders",
  leaderSessionID: "lead-session",
  status: "active",
  members: [
    { name: "scout", sessionID: "member-scout", status: "running" },
    { name: "digger", sessionID: "member-digger", status: "errored", error: "provider down" },
  ],
  messages: [
    { id: "m1", from: "lead-session", to: "scout", text: "please start", read: false },
    { id: "m2", from: "member-digger", to: "scout", text: "found a bug", read: false },
    { id: "m3", from: "lead-session", to: "digger", text: "old news", read: true },
  ],
}

function seededStorage() {
  return memoryStorage({ "rigel-v2/team/p-default/builders": structuredClone(TEAM) })
}

function toolEvent(tool, sessionID, input = {}) {
  return {
    tool,
    sessionID,
    input,
    messages: [{ role: "user", content: "current user turn" }],
  }
}

async function expectDeny(rule, event, fragment) {
  await expect(rule.run(event)).rejects.toThrow(fragment)
}

describe("native team gating", () => {
  test("participant roles resolve from the native team record", () => {
    expect(resolveNativeTeamParticipant(TEAM, "lead-session")).toBe("lead")
    expect(resolveNativeTeamParticipant(TEAM, "member-scout")).toBe("member")
    expect(resolveNativeTeamParticipant(TEAM, "outsider")).toBe("neither")
  })

  test("team membership resolves from the DURABLE record, not from one process's memory", async () => {
    // given: the record the team tools wrote, read by a process that never spawned it
    const isTeamMemberSession = createTeamMemberSessionResolver({ storage: seededStorage() })
    // when / then
    expect(await isTeamMemberSession("member-scout")).toBe(true)
    expect(await isTeamMemberSession("outsider")).toBe(false)
  })

  test("a storage without the scan surface degrades to 'not a member' instead of failing", async () => {
    const isTeamMemberSession = createTeamMemberSessionResolver({ storage: { get: async () => undefined } })
    expect(await isTeamMemberSession("member-scout")).toBe(false)
  })

  test("#given a storage whose scan fails #when the membership is resolved #then the failure is reported instead of answering 'not a member'", async () => {
    // given: the durable source cannot be read
    const isTeamMemberSession = createTeamMemberSessionResolver({
      storage: { scan: async () => { throw new Error("storage offline") } },
    })
    // when / then: an unreadable source must NOT be reported as "not a member", or a
    // member's pane would be closed like an ordinary child's
    await expect(isTeamMemberSession("member-scout")).rejects.toThrow("storage offline")
  })

  test("team_create is denied for any existing participant and open for outsiders", async () => {
    const rule = createNativeTeamGatingRule({ storage: seededStorage() })
    await expectDeny(rule, toolEvent("team_create", "lead-session"), "already a participant")
    await expectDeny(rule, toolEvent("team_create", "member-scout"), "already a participant")
    await rule.run(toolEvent("team_create", "outsider"))
  })

  test("team_delete and team_shutdown_request are lead-only for the named team", async () => {
    const rule = createNativeTeamGatingRule({ storage: seededStorage() })
    await rule.run(toolEvent("team_delete", "lead-session", { team_name: "builders" }))
    await expectDeny(rule, toolEvent("team_delete", "member-scout", { team_name: "builders" }), "lead-only")
    await expectDeny(rule, toolEvent("team_shutdown_request", "outsider", { team_name: "builders" }), "lead-only")
    await expectDeny(rule, toolEvent("team_delete", "lead-session", { team_name: "ghost" }), "lead-only")
  })

  test("shutdown approval requires participation, universal tools require the named team, team_list is open", async () => {
    const rule = createNativeTeamGatingRule({ storage: seededStorage() })
    await rule.run(toolEvent("team_approve_shutdown", "member-digger", { team_name: "builders" }))
    await expectDeny(rule, toolEvent("team_approve_shutdown", "outsider", { team_name: "builders" }), "participant")
    await rule.run(toolEvent("team_send_message", "member-scout", { team_name: "builders", message: "hi" }))
    await rule.run(toolEvent("team_status", "lead-session", { team_name: "builders" }))
    await expectDeny(rule, toolEvent("team_send_message", "outsider", { team_name: "builders" }), "requires participation")
    await expectDeny(rule, toolEvent("team_send_message", "member-scout", { team_name: "ghost" }), "requires participation")
    await rule.run(toolEvent("team_list", "outsider"))
  })

  test("non-team tools and disabled-gate usage never reach the rule", async () => {
    const rule = createNativeTeamGatingRule({ storage: seededStorage() })
    await rule.run(toolEvent("bash", "outsider", { command: "ls" }))
    await rule.run(toolEvent("read", "outsider"))
  })
})

describe("native team mailbox injector", () => {
  test("unread routed messages are prepended to the last real user turn and marked read", async () => {
    // given
    const storage = seededStorage()
    const inject = createNativeTeamMailboxInjector({ storage })
    const event = toolEvent("bash", "member-scout")
    // when
    await inject(event)
    // then
    expect(event.messages[0].content).toContain("<team-mailbox team=\"builders\">")
    expect(event.messages[0].content).toContain("please start")
    expect(event.messages[0].content).toContain("found a bug")
    const team = await storage.get("rigel-v2/team/p-default/builders")
    expect(team.messages.every((message) => message.read === true)).toBe(true)
  })

  test("already-read messages are not re-injected and non-participants are untouched", async () => {
    const storage = seededStorage()
    const inject = createNativeTeamMailboxInjector({ storage })
    const leadTurn = toolEvent("bash", "lead-session")
    await inject(leadTurn)
    expect(leadTurn.messages[0].content).toBe("current user turn")
    // first member pass injects and acks; a second pass is a no-op
    const scoutTurn = toolEvent("bash", "member-scout")
    await inject(scoutTurn)
    expect(scoutTurn.messages[0].content).toContain("<team-mailbox")
    const scoutTurn2 = toolEvent("bash", "member-scout")
    await inject(scoutTurn2)
    expect(scoutTurn2.messages[0].content).toBe("current user turn")
  })
})

describe("native team status injector", () => {
  test("participants receive the team status and member states; outsiders get nothing", async () => {
    // given
    const inject = createNativeTeamStatusInjector({ storage: seededStorage() })
    const leadTurn = toolEvent("bash", "lead-session")
    const outsiderTurn = toolEvent("bash", "outsider")
    // when
    await inject(leadTurn)
    await inject(outsiderTurn)
    // then
    expect(leadTurn.messages[0].content).toContain("<team-status team=\"builders\" status=\"active\">")
    expect(leadTurn.messages[0].content).toContain("- digger: errored (provider down)")
    expect(outsiderTurn.messages[0].content).toBe("current user turn")
  })
})
