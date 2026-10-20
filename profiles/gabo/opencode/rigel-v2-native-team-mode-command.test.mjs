import { describe, expect, test } from "bun:test"
import { createTeamTools } from "./tools/team.tools.mjs"
import {
  createTeamModeCommand,
  decideTeamModeAction,
  registerTeamModeCommand,
  TEAM_MODE_COMMAND_NAME,
} from "./rigel-v2-native-team-mode-command.mjs"

// The objective that leaves NOTHING to ask: an explicit team name, two roles with
// their categories, a per-member assignment, and a worktree policy.
const COMPLETE_OBJECTIVE = 'team: auth-audit. audit the auth module. members: scout=quick "map the auth paths", builder=unspecified-low "write the missing tests". worktree: no'

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key) : undefined },
    async set(key, value) { map.set(key, value) },
    async remove(key) { map.delete(key) },
    async scan({ prefix = "" } = {}) {
      return { entries: [...map.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }
    },
  }
}

function fakeContext() {
  const prompts = []
  const added = []
  return {
    prompts,
    added,
    context: {
      session: { prompt: async (args) => { prompts.push(args) } },
      command: {
        transform: async (mutator) => {
          const editor = { add: (definition) => { added.push(definition); return definition } }
          mutator(editor)
          return { dispose() {} }
        },
      },
    },
  }
}

/**
 * A command wired to the REAL `team_create` definition, with a recording spawn
 * seam, so "created" and "created nothing" are asserted against durable state and
 * real member spawns rather than against the command's own wording.
 */
function buildHarness({ createTeam } = {}) {
  const storage = memoryStorage()
  const spawns = []
  const tools = createTeamTools({
    storage,
    getSessionID: () => "lead-session",
    startMemberSession: async (member, meta) => {
      spawns.push({ ...member, teamName: meta.teamName, leadSessionID: meta.leadSessionID })
      return { sessionID: `ses_member_${spawns.length}` }
    },
  })
  const calls = []
  const port = createTeam ?? (async (spec, ctx) => {
    calls.push(spec)
    return tools.team_create.execute(spec, ctx)
  })
  const { context, prompts, added } = fakeContext()
  const command = createTeamModeCommand({ context, createTeam: port })
  return { storage, spawns, tools, calls, context, prompts, added, command }
}

async function runCommand(harness, objective) {
  await harness.command.execute({ sessionID: "lead-session", prompt: { text: objective } })
  return harness.prompts[0]?.text ?? ""
}

describe("native V2 /team-mode decision", () => {
  test("#given an objective naming roles, categories, assignment and worktree policy #when the decision runs #then it is decision-complete with the canonical spec", () => {
    // when
    const decision = decideTeamModeAction({ objective: COMPLETE_OBJECTIVE })
    // then: exactly the documented contract keys, nothing else
    expect(decision.kind).toBe("create")
    expect(decision.spec.team_name).toBe("auth-audit")
    expect(decision.spec.worktree).toBe(false)
    expect(Object.keys(decision.spec).sort()).toEqual(["members", "team_name", "worktree"])
    expect(decision.spec.members).toEqual([
      { name: "scout", category: "quick", prompt: "map the auth paths" },
      { name: "builder", category: "unspecified-low", prompt: "write the missing tests" },
    ])
  })

  test("#given roles whose categories are unspecified #when the decision runs #then it asks for them and produces no spec", () => {
    const decision = decideTeamModeAction({ objective: "members: scout, builder" })
    expect(decision.kind).toBe("ask")
    expect(decision.missing).toContain("categories")
    expect(decision.questions.length).toBeGreaterThan(0)
    expect(decision.spec).toBeUndefined()
  })

  test("#given a complete role list but no worktree policy #when the decision runs #then worktrees are the only question", () => {
    const decision = decideTeamModeAction({ objective: "members: scout=quick, builder=unspecified-low" })
    expect(decision.kind).toBe("ask")
    expect(decision.missing).toEqual(["worktree"])
    expect(decision.questions).toHaveLength(1)
  })

  test("#given no objective #when the decision runs #then it asks for the whole team definition", () => {
    const decision = decideTeamModeAction({ objective: "   " })
    expect(decision.kind).toBe("ask")
    expect(decision.missing).toEqual(["roles", "categories", "worktree"])
  })

  test("#given a cancel word #when the decision runs #then it cancels instead of asking", () => {
    expect(decideTeamModeAction({ objective: "cancel" }).kind).toBe("cancel")
    expect(decideTeamModeAction({ objective: "Never mind" }).kind).toBe("cancel")
  })

  test("#given a category this runtime does not route #when the decision runs #then it is malformed and names the category", () => {
    const decision = decideTeamModeAction({ objective: "members: scout=telepathy, builder=quick. worktree: no" })
    expect(decision.kind).toBe("malformed")
    expect(decision.reason).toContain("telepathy")
    expect(decision.validCategories).toContain("quick")
  })

  test("#given the upstream inline_spec shape #when the decision runs #then it is rejected by name", () => {
    const decision = decideTeamModeAction({ objective: 'inline_spec: {"members": []}. worktree: no' })
    expect(decision.kind).toBe("malformed")
    expect(decision.reason).toContain("inline_spec")
  })

  test("#given the word 'lead' used as ordinary English #when the decision runs #then it is not mistaken for the upstream field", () => {
    // negative control: this must NOT be a contract violation
    const decision = decideTeamModeAction({ objective: "lead the audit. members: scout=quick, builder=unspecified-low. worktree: no" })
    expect(decision.kind).toBe("create")
    expect(decision.spec.members).toHaveLength(2)
  })

  test("#given a declared member count that disagrees with the named roles #when the decision runs #then it is malformed", () => {
    const decision = decideTeamModeAction({ objective: "3 members: scout=quick, builder=unspecified-low. worktree: no" })
    expect(decision.kind).toBe("malformed")
    expect(decision.reason).toContain("3 members")
  })

  test("#given a single-member team #when the decision runs #then it is malformed because a team needs at least two", () => {
    const decision = decideTeamModeAction({ objective: "1 member: solo=quick. worktree: no" })
    expect(decision.kind).toBe("malformed")
    expect(decision.reason).toContain("between 2 and 8")
  })

  test("#given duplicate member names #when the decision runs #then it is malformed", () => {
    const decision = decideTeamModeAction({ objective: "members: scout=quick, scout=writing. worktree: no" })
    expect(decision.kind).toBe("malformed")
    expect(decision.reason).toContain("scout")
  })
})

describe("native V2 /team-mode command execution", () => {
  test("#given a decision-complete objective #when the command executes #then it spawns every member and persists one active team", async () => {
    // given
    const harness = buildHarness()
    // when
    const injected = await runCommand(harness, COMPLETE_OBJECTIVE)
    // then: two REAL member sessions through the production spawn seam
    expect(harness.spawns.map((spawn) => spawn.name)).toEqual(["scout", "builder"])
    expect(harness.spawns.map((spawn) => spawn.prompt)).toEqual(["map the auth paths", "write the missing tests"])
    expect(harness.spawns.every((spawn) => spawn.leadSessionID === "lead-session")).toBe(true)
    // and the durable record is active with both members bound to their sessions
    const team = await harness.storage.get("rigel-v2/team/p-default/auth-audit")
    expect(team.status).toBe("active")
    expect(team.members.map((member) => member.sessionID)).toEqual(["ses_member_1", "ses_member_2"])
    // and the injected turn carries the created outcome so the agent continues the lifecycle
    expect(injected).toContain(JSON.stringify({ team_name: "auth-audit", members: harness.spawns.map((spawn) => ({ name: spawn.name, category: spawn.category, prompt: spawn.prompt })), worktree: false }))
  })

  test("#given an incomplete objective #when the command executes #then it creates nothing at all", async () => {
    const harness = buildHarness()
    await runCommand(harness, "members: scout, builder")
    // the whole create path is untouched: no port call, no spawn, no record
    expect(harness.calls).toHaveLength(0)
    expect(harness.spawns).toHaveLength(0)
    expect(harness.storage.map.size).toBe(0)
  })

  test("#given a malformed objective #when the command executes #then it creates nothing at all", async () => {
    const harness = buildHarness()
    await runCommand(harness, "members: scout=telepathy, builder=quick. worktree: no")
    expect(harness.calls).toHaveLength(0)
    expect(harness.spawns).toHaveLength(0)
    expect(harness.storage.map.size).toBe(0)
  })

  test("#given a cancelled request #when the command executes #then it creates nothing at all", async () => {
    const harness = buildHarness()
    await runCommand(harness, "cancel")
    expect(harness.calls).toHaveLength(0)
    expect(harness.spawns).toHaveLength(0)
    expect(harness.storage.map.size).toBe(0)
  })

  test("#given the create port fails #when the command executes #then the failure is reported and nothing is spawned", async () => {
    const harness = buildHarness({ createTeam: async () => { throw new Error("storage is read-only") } })
    const injected = await runCommand(harness, COMPLETE_OBJECTIVE)
    expect(injected).toContain("storage is read-only")
    expect(harness.spawns).toHaveLength(0)
    expect(harness.storage.map.size).toBe(0)
  })

  test("#given no create port is wired #when the command executes #then the exact canonical payload is injected for the agent to call", async () => {
    const { context, prompts } = fakeContext()
    const command = createTeamModeCommand({ context })
    await command.execute({ sessionID: "lead-session", prompt: { text: COMPLETE_OBJECTIVE } })
    // the machine-readable payload the model must call with is present verbatim
    expect(prompts[0].text).toContain(JSON.stringify({
      team_name: "auth-audit",
      members: [
        { name: "scout", category: "quick", prompt: "map the auth paths" },
        { name: "builder", category: "unspecified-low", prompt: "write the missing tests" },
      ],
      worktree: false,
    }))
  })
})

describe("native V2 /team-mode registration", () => {
  test("#given a command domain that denies the name #when registration runs #then the command stays unregistered", async () => {
    const { context, added } = fakeContext()
    const registration = await registerTeamModeCommand({ context, disabledCommands: [TEAM_MODE_COMMAND_NAME] })
    expect(registration).toBeUndefined()
    expect(added).toHaveLength(0)
  })

  test("#given an enabled command domain #when registration runs #then the visible /team-mode command is added", async () => {
    const { context, added } = fakeContext()
    const registration = await registerTeamModeCommand({ context, disabledCommands: ["rmo-models"] })
    expect(added.map((definition) => definition.name)).toEqual([TEAM_MODE_COMMAND_NAME])
    expect(typeof registration?.dispose).toBe("function")
  })

  test("#given a host with no command domain #when registration runs #then it degrades to undefined", async () => {
    expect(await registerTeamModeCommand({ context: {} })).toBeUndefined()
  })
})
