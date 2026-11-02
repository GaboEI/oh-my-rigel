import { afterEach, describe, expect, test } from "bun:test"
import { createTeamTools } from "./team.tools.mjs"
import { createGitWorktreeRunner, createTeamWorktreeManager } from "../rigel-v2-team-worktrees.mjs"
import { createMemberSessionTerminator } from "../rigel-v2-native-session-teardown.mjs"
import { createTeamWorktreeReconciler } from "../rigel-v2-team-worktree-reconcile.mjs"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

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

const noRemoveDir = async () => {}

function recordingRunner(handler) {
  const calls = []
  const runGit = async (args) => {
    calls.push(args.join(" "))
    if (handler) return handler(args)
    if (args.includes("--is-inside-work-tree")) return { code: 0, stdout: "true\n", stderr: "" }
    return { code: 0, stdout: "", stderr: "" }
  }
  return { calls, runGit }
}

function buildTools({ storage = memoryStorage(), runGit, bindSession, reconciler, setup } = {}) {
  const manager = createTeamWorktreeManager({ repoRoot: "/repo", runGit, removeDir: noRemoveDir, removeEmptyDir: async () => {}, bindSession })
  const spied = setup ? setup(manager) : manager
  const tools = createTeamTools({ storage, getSessionID: () => "lead-session", worktreeManager: spied, worktreeReconciler: reconciler })
  return { storage, tools, manager: spied }
}

function reconcilerStub() {
  const calls = []
  return {
    calls,
    async record({ teamName, reason }) { calls.push(["record", teamName, reason]) },
    async clear({ teamName }) { calls.push(["clear", teamName]) },
    async runPending({ teamName, reason }) { calls.push(["runPending", teamName, reason]); return { cleaned: true } },
    beginCreate() {},
    endCreate() {},
    async reconcile() { return {} },
  }
}

describe("native V2 team tools and per-member worktrees", () => {
  test("#given a team of two members #when team_create runs #then each member gets a distinct worktree recorded in the team and its session is bound", async () => {
    // given
    const { calls, runGit } = recordingRunner()
    const bound = []
    const { storage, tools } = buildTools({ runGit, bindSession: async ({ sessionID, directory }) => { bound.push({ sessionID, directory }) } })
    // when
    const team = await tools.team_create.execute({ team_name: "builders", members: [{ name: "scout", sessionID: "ses_1" }, { name: "digger", sessionID: "ses_2" }] })
    // then
    const paths = team.members.map((member) => member.worktreePath)
    expect(team.members.every((member) => typeof member.worktreePath === "string" && member.worktreePath.length > 0)).toBe(true)
    expect(new Set(paths).size).toBe(2)
    expect(team.members[0].worktreeBranch).toBe("rigel-team/builders/scout")
    expect(calls.filter((line) => line.includes("worktree add -b"))).toHaveLength(2)
    expect(bound).toHaveLength(2)
    const persisted = await storage.get("rigel-v2/team/p-default/builders")
    expect(persisted.members.map((member) => member.worktreePath)).toEqual(paths)
  })

  test("#given no worktree manager #when team_create runs #then the declared members are stored unchanged (no worktree side effect)", async () => {
    // given
    const storage = memoryStorage()
    const tools = createTeamTools({ storage, getSessionID: () => "lead-session" })
    // when
    const team = await tools.team_create.execute({ team_name: "plain", members: ["scout"] })
    // then
    expect(team.members[0].worktreePath).toBeUndefined()
  })

  test("#given a materialized max_members cap #when team_create receives more members than the cap #then its schema and executor reject the request before storage changes", async () => {
    // given
    const storage = memoryStorage()
    const tools = createTeamTools({ storage, getSessionID: () => "lead-session", teamMode: { max_members: 2 } })
    const input = {
      team_name: "capped",
      members: [{ name: "scout" }, { name: "builder" }, { name: "reviewer" }],
    }
    // when / then
    expect(tools.team_create.input.properties.members.maxItems).toBe(2)
    await expect(tools.team_create.execute(input)).rejects.toThrow("at most 2 members")
    expect(await storage.get("rigel-v2/team/p-default/capped")).toBeUndefined()
  })

  test("#given a malformed materialized max_members value #when team_create receives eight members #then the established ceiling remains usable", async () => {
    // given
    const storage = memoryStorage()
    const tools = createTeamTools({ storage, getSessionID: () => "lead-session", teamMode: { max_members: "four" } })
    const members = Array.from({ length: 8 }, (_, index) => ({ name: `member-${index}` }))
    // when
    const team = await tools.team_create.execute({ team_name: "default-cap", members })
    // then
    expect(tools.team_create.input.properties.members.maxItems).toBe(8)
    expect(team.members).toHaveLength(8)
  })

  test("#given worktree provisioning fails #when team_create runs #then it rejects and persists no team record", async () => {
    // given
    const { runGit } = recordingRunner((args) => {
      if (args.includes("--is-inside-work-tree")) return { code: 0, stdout: "true\n", stderr: "" }
      if (args.includes("add")) return { code: 128, stdout: "", stderr: "add failed" }
      return { code: 0, stdout: "", stderr: "" }
    })
    const { storage, tools } = buildTools({ runGit })
    // when / then
    await expect(tools.team_create.execute({ team_name: "broken", members: [{ name: "scout" }] })).rejects.toThrow("add failed")
    expect(await storage.get("rigel-v2/team/p-default/broken")).toBeUndefined()
  })

  test("#given an active team with worktrees #when team_delete runs #then every worktree and branch is removed and the record is dropped", async () => {
    // given
    const { calls, runGit } = recordingRunner()
    const { storage, tools } = buildTools({ runGit })
    await tools.team_create.execute({ team_name: "builders", members: [{ name: "scout" }, { name: "digger" }] })
    // when
    const result = await tools.team_delete.execute({ team_name: "builders" })
    // then
    expect(result).toEqual({ name: "builders", deleted: true, sessionsTerminated: [], sessionsFailed: [], sessionsDetached: [], sessionsUnverified: [] })
    expect(calls.filter((line) => line.includes("worktree remove --force"))).toHaveLength(2)
    expect(calls.filter((line) => line.includes("branch -D rigel-team/builders/"))).toHaveLength(2)
    expect(await storage.get("rigel-v2/team/p-default/builders")).toBeUndefined()
  })

  test("#given an active team with worktrees #when team_approve_shutdown runs #then it schedules non-blocking cleanup without waiting", async () => {
    // given
    const { runGit } = recordingRunner()
    let scheduled = 0
    const { tools } = buildTools({
      runGit,
      setup: (manager) => ({
        ...manager,
        cleanupNonBlocking: (args) => { scheduled += 1; return manager.cleanupNonBlocking(args) },
      }),
    })
    await tools.team_create.execute({ team_name: "builders", members: [{ name: "scout" }] })
    // when
    const next = await tools.team_approve_shutdown.execute({ team_name: "builders" })
    // then
    expect(next.status).toBe("shutdown-approved")
    expect(scheduled).toBe(1)
  })

  test("#given cleanup always fails #when team_approve_shutdown runs #then the shutdown still resolves (cleanup never blocks)", async () => {
    // given: creation succeeds, but every cleanup git call throws
    const runGit = async (args) => {
      if (args.includes("--is-inside-work-tree")) return { code: 0, stdout: "true\n", stderr: "" }
      if (args.includes("add")) return { code: 0, stdout: "", stderr: "" }
      throw new Error("git exploded")
    }
    const { tools } = buildTools({ runGit })
    await tools.team_create.execute({ team_name: "builders", members: [{ name: "scout" }] })
    // when
    const next = await tools.team_approve_shutdown.execute({ team_name: "builders" })
    // then
    expect(next.status).toBe("shutdown-approved")
  })

  test("#given a member session that cannot be bound #when team_create runs #then it rolls back transactionally: no team, worktrees reclaimed, journal recorded", async () => {
    // given
    const { calls, runGit } = recordingRunner()
    const reconciler = reconcilerStub()
    const { storage, tools } = buildTools({ runGit, reconciler, bindSession: async ({ sessionID }) => { if (sessionID === "ses_bad") throw new Error("move failed") } })
    // when / then
    await expect(tools.team_create.execute({ team_name: "builders", members: [{ name: "scout", sessionID: "ses_bad" }] })).rejects.toThrow("bind failed")
    expect(await storage.get("rigel-v2/team/p-default/builders")).toBeUndefined()
    expect(reconciler.calls).toContainEqual(["runPending", "builders", "bind-failed"])
  })

  test("#given a reconciler #when team_approve_shutdown runs #then the cleanup is journaled durably before it runs", async () => {
    // given
    const reconciler = reconcilerStub()
    const { tools } = buildTools({ runGit: recordingRunner().runGit, reconciler })
    await tools.team_create.execute({ team_name: "builders", members: [{ name: "scout" }] })
    // when
    await tools.team_approve_shutdown.execute({ team_name: "builders" })
    // then
    const recordIndex = reconciler.calls.findIndex((call) => call[0] === "record" && call[2] === "shutdown-approved")
    const runIndex = reconciler.calls.findIndex((call) => call[0] === "runPending")
    expect(recordIndex).toBeGreaterThanOrEqual(0)
    expect(runIndex).toBeGreaterThan(recordIndex)
  })

  test("#given a reconciler #when team_delete runs #then it journals and runs the cleanup then drops the record", async () => {
    // given
    const reconciler = reconcilerStub()
    const { storage, tools } = buildTools({ runGit: recordingRunner().runGit, reconciler })
    await tools.team_create.execute({ team_name: "builders", members: [{ name: "scout" }] })
    // when
    await tools.team_delete.execute({ team_name: "builders" })
    // then
    expect(reconciler.calls).toContainEqual(["record", "builders", "delete"])
    expect(reconciler.calls).toContainEqual(["runPending", "builders", "delete"])
    expect(await storage.get("rigel-v2/team/p-default/builders")).toBeUndefined()
  })
})

// Row 55: the live failure was a natural team request creating phantom members.
// A member only becomes a real pane-producing participant if team_create spawns a
// child session for it; a record with sessionID undefined can never open a pane.
describe("row 55: team_create must spawn real member sessions", () => {
  test("#given a natural team request #when team_create runs #then every member gets a real spawned session id", async () => {
    // given: the same DI seam the runtime injects for rigel_task-style delegation
    const storage = memoryStorage()
    const spawned = []
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead-session",
      startMemberSession: async (assignment, ctx) => {
        spawned.push({ name: assignment.name, agent: assignment.agent, parentSessionID: ctx.leadSessionID })
        return { sessionID: `ses_${assignment.name}` }
      },
    })
    // when
    const team = await tools.team_create.execute({
      team_name: "builders",
      members: [{ name: "scout", agent: "explore", prompt: "find the call sites" }],
    })
    // then: a real session id, not a phantom record
    expect(typeof team.members[0].sessionID).toBe("string")
    expect(team.members[0].sessionID).toBe("ses_scout")
    expect(spawned).toEqual([{ name: "scout", agent: "explore", parentSessionID: "lead-session" }])
    const persisted = await storage.get("rigel-v2/team/p-default/builders")
    expect(persisted.members[0].sessionID).toBe("ses_scout")
    expect(persisted.status).toBe("active")
  })

  test("#given an upstream-style inline_spec #when team_create runs #then it is rejected with actionable guidance", async () => {
    // given: the argument shape the model reaches for from upstream exposure
    const tools = createTeamTools({ storage: memoryStorage(), getSessionID: () => "lead-session" })
    // when / then: rejected by name, and the guidance names the canonical shape
    const error = await tools.team_create.execute({ inline_spec: { name: "x", members: [{ name: "a" }] } }).then(
      () => null,
      (thrown) => thrown,
    )
    expect(error).not.toBeNull()
    expect(String(error.message)).toContain("inline_spec")
    expect(String(error.message)).toContain("members")
  })

  test("#then team_create advertises a strict schema that rejects unknown keys", () => {
    // given
    const tools = createTeamTools({ storage: memoryStorage() })
    // then: additionalProperties true is what let inline_spec reach the runtime
    expect(tools.team_create.input.additionalProperties).toBe(false)
    expect(Object.keys(tools.team_create.input.properties)).toContain("members")
  })

  test("#given a member with no agent or category #when team_create runs #then it rejects before any side effect", async () => {
    // given
    const storage = memoryStorage()
    const tools = createTeamTools({ storage, getSessionID: () => "lead-session", startMemberSession: async () => ({ sessionID: "ses_x" }) })
    // when / then: actionable, and nothing was recorded
    await expect(tools.team_create.execute({ team_name: "t", members: [{ name: "scout", prompt: "a" }] })).rejects.toThrow(/exactly one of agent\|category/)
    expect(await storage.get("rigel-v2/team/p-default/t")).toBeUndefined()
  })

  test("#given a worktree manager and an OMITTED worktree #when team_create runs #then the legacy default still provisions per-member worktrees", async () => {
    // given: the baseline direct tool provisioned whenever a worktree manager
    // existed and `worktree` was not a control at all. An opt-in default silently
    // changed every legacy direct call that omitted the key.
    const { calls, runGit } = recordingRunner()
    const { tools } = buildTools({ runGit })
    // when
    const team = await tools.team_create.execute({ team_name: "legacydefault", members: [{ name: "scout" }] })
    // then: the baseline behavior, NOT a silent switch to a shared tree
    expect(calls.filter((line) => line.includes("worktree add -b"))).toHaveLength(1)
    expect(typeof team.members[0].worktreePath).toBe("string")
    expect(team.members[0].worktreePath).toContain("legacydefault")
  })

  test("#given worktree:false #when team_create runs #then the caller explicitly bypasses per-member worktrees for one shared tree", async () => {
    // given: the ONLY bypass, and what /team-mode emits for shared-pane runs
    const { calls, runGit } = recordingRunner()
    const { tools } = buildTools({ runGit })
    // when
    const team = await tools.team_create.execute({ team_name: "shared", worktree: false, members: [{ name: "scout" }] })
    // then
    expect(calls.filter((line) => line.includes("worktree add -b"))).toHaveLength(0)
    expect(team.members[0].worktreePath).toBeUndefined()
  })

  test("#given worktree:true and no worktree manager #when team_create runs #then it refuses instead of degrading to a shared tree", async () => {
    // given: the caller REQUIRES per-member worktrees and this project has no manager
    const storage = memoryStorage()
    const spawned = []
    const reconciler = reconcilerStub()
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead-session",
      worktreeReconciler: reconciler,
      startMemberSession: async (assignment) => { spawned.push(assignment.name); return { sessionID: `ses_${assignment.name}` } },
    })
    // when / then: a loud refusal, and nothing at all was created
    await expect(tools.team_create.execute({ team_name: "strict", worktree: true, members: [{ name: "scout", agent: "explore", prompt: "a" }] })).rejects.toThrow(/worktree/i)
    expect(spawned).toEqual([])
    expect(reconciler.calls).toEqual([])
    expect(await storage.get("rigel-v2/team/p-default/strict")).toBeUndefined()
  })

  test("#given a lead session in its own project directory #when team_create runs #then the member session is created in that directory", async () => {
    // given: the caller lives in a project directory that is NOT the plugin's own location
    const storage = memoryStorage()
    const seen = []
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead-session",
      resolveScopeForSession: async () => ({ projectKey: "p-default", repoRoot: "/repo", directory: "/repo/sub" }),
      startMemberSession: async (assignment, meta) => { seen.push(meta); return { sessionID: "ses_scout" } },
    })
    // when
    await tools.team_create.execute({ team_name: "t", members: [{ name: "scout", agent: "explore", prompt: "a" }] })
    // then: the child runs in the LEAD's tree, not in the plugin's static location
    expect(seen[0].location.directory).toBe("/repo/sub")
  })

  test("#given a team with per-member worktrees #when team_create runs #then the member is told its worktree and is NOT bound after the prompt", async () => {
    // given
    const { runGit } = recordingRunner()
    const storage = memoryStorage()
    const bound = []
    const seen = []
    const manager = createTeamWorktreeManager({ repoRoot: "/repo", runGit, removeDir: noRemoveDir, removeEmptyDir: async () => {}, bindSession: async ({ sessionID, directory }) => { bound.push({ sessionID, directory }) } })
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead-session",
      worktreeManager: manager,
      startMemberSession: async (assignment, meta) => { seen.push(meta); return { sessionID: "ses_scout" } },
    })
    // when
    await tools.team_create.execute({ team_name: "builders", members: [{ name: "scout", agent: "explore", prompt: "a" }] })
    // then: the seam is told where to bind the member BEFORE its first prompt, and the
    // tool does not bind it afterwards (a post-prompt bind is too late for that turn)
    expect(seen[0].worktreePath).toBe("/repo/.omo/team-worktrees/builders/scout")
    expect(typeof seen[0].bindSession).toBe("function")
    expect(bound).toEqual([])
  })

  test("#given a lead session in a workspace #when team_create runs #then the member is created in the lead's FULL location", async () => {
    // given: the lead's location carries a workspace, so the member must not fall back
    // to the default workspace of that directory
    const storage = memoryStorage()
    const seen = []
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead-session",
      resolveScopeForSession: async () => ({
        projectKey: "p-default",
        repoRoot: "/repo",
        directory: "/repo/sub",
        location: { directory: "/repo/sub", workspaceID: "ws-lead" },
      }),
      startMemberSession: async (assignment, meta) => { seen.push(meta); return { sessionID: "ses_scout" } },
    })
    // when
    await tools.team_create.execute({ team_name: "t", members: [{ name: "scout", agent: "explore", prompt: "a" }] })
    // then
    expect(seen[0].location).toEqual({ directory: "/repo/sub", workspaceID: "ws-lead" })
  })

  test("#given an adopted member and a spawned one #when team_create runs #then the adopted member is bound before any member is spawned", async () => {
    // given: the adopted session is ALIVE, so it must be in its worktree before the
    // team starts working (a bind after the first prompt leaves that window open)
    const { runGit } = recordingRunner()
    const storage = memoryStorage()
    const order = []
    const manager = createTeamWorktreeManager({
      repoRoot: "/repo",
      runGit,
      removeDir: noRemoveDir,
      removeEmptyDir: async () => {},
      bindSession: async ({ sessionID }) => { order.push(`bind:${sessionID}`) },
    })
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead-session",
      worktreeManager: manager,
      startMemberSession: async (assignment) => { order.push(`spawn:${assignment.name}`); return { sessionID: `ses_${assignment.name}` } },
    })
    // when
    await tools.team_create.execute({ team_name: "t", members: [
      { name: "guest", sessionID: "ses_foreign" },
      { name: "scout", agent: "explore", prompt: "a" },
    ] })
    // then
    expect(order[0]).toBe("bind:ses_foreign")
  })

  test("#given the second member cannot be spawned #when team_create runs #then the first member's session is terminated and no record survives", async () => {
    // given
    const storage = memoryStorage()
    const terminated = []
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead-session",
      startMemberSession: async (assignment) => {
        if (assignment.name === "digger") throw new Error("spawn exploded")
        return { sessionID: `ses_${assignment.name}` }
      },
      terminateMemberSession: async (sessionID) => { terminated.push(sessionID); return { sessionID, deleted: true } },
    })
    // when / then
    await expect(tools.team_create.execute({ team_name: "t", members: [
      { name: "scout", agent: "explore", prompt: "a" },
      { name: "digger", agent: "explore", prompt: "b" },
      // An ADOPTED member in the SAME create: it must never reach the terminator
      // during a rollback either (blocker 3: "including create rollback").
      { name: "guest", sessionID: "ses_foreign" },
    ] })).rejects.toThrow("spawn exploded")
    expect(terminated).toEqual(["ses_scout"])
    expect(await storage.get("rigel-v2/team/p-default/t")).toBeUndefined()
  })

  test("#given an active team with member sessions #when team_delete runs #then every member session is terminated before the record is dropped", async () => {
    // given
    const storage = memoryStorage()
    const terminated = []
    const controlOptions = []
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead-session",
      startMemberSession: async (assignment) => ({ sessionID: `ses_${assignment.name}` }),
      terminateMemberSession: async (sessionID, options) => { terminated.push(sessionID); controlOptions.push(options); return { sessionID, deleted: true } },
    })
    await tools.team_create.execute({ team_name: "t", members: [
      { name: "scout", agent: "explore", prompt: "a" },
      { name: "digger", agent: "explore", prompt: "b" },
    ] })
    // when
    await tools.team_delete.execute({ team_name: "t" })
    // then: session deletion is what closes the member panes
    expect(terminated).toEqual(["ses_scout", "ses_digger"])
    // The caller's own live session must reach the terminator: it is the ONLY thing
    // that calibrates a presence probe on a host whose absence answer is unworded.
    expect(controlOptions).toEqual([{ controlSessionID: "lead-session" }, { controlSessionID: "lead-session" }])
    expect(terminated).toEqual(["ses_scout", "ses_digger"])
    expect(await storage.get("rigel-v2/team/p-default/t")).toBeUndefined()
  })

  test("#given a teardown that cannot terminate an owned session #when team_delete runs #then the record is KEPT with retry state and deleted is false", async () => {
    // given: a spawn seam but no terminator, i.e. a host with no session delete
    const storage = memoryStorage()
    const tools = createTeamTools({ storage, getSessionID: () => "lead-session", startMemberSession: async (assignment) => ({ sessionID: `ses_${assignment.name}` }) })
    await tools.team_create.execute({ team_name: "t", members: [{ name: "scout", agent: "explore", prompt: "a" }] })
    // when
    const result = await tools.team_delete.execute({ team_name: "t" })
    // then: never `deleted: true` while an owned session survived - a live pane
    // must never be reported as closed
    expect(result).toMatchObject({ name: "t", deleted: false, retained: true })
    expect(result.sessionsTerminated).toEqual([])
    expect(result.sessionsFailed).toEqual([{ sessionID: "ses_scout", error: "no terminator installed" }])
    expect(result.warning).toContain("could not be terminated")
    // and the record survives with the remaining owned session ids for a retry
    expect(await storage.get("rigel-v2/team/p-default/t")).toMatchObject({ name: "t", status: "cleanup-failed", cleanupPending: ["ses_scout"] })
  })

  test("#given a retained cleanup failure #when the terminator becomes available and team_delete runs again #then the record is dropped and deleted is true", async () => {
    // given: the retry state the previous failure kept
    const storage = memoryStorage()
    const terminated = []
    let terminatorAvailable = false
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead-session",
      startMemberSession: async (assignment) => ({ sessionID: `ses_${assignment.name}` }),
      terminateMemberSession: async (sessionID) => {
        if (!terminatorAvailable) return { sessionID, deleted: false, error: "no terminator installed" }
        terminated.push(sessionID)
        return { sessionID, deleted: true }
      },
    })
    await tools.team_create.execute({ team_name: "t", members: [{ name: "scout", agent: "explore", prompt: "a" }] })
    expect((await tools.team_delete.execute({ team_name: "t" })).deleted).toBe(false)
    // when: the retry can terminate
    terminatorAvailable = true
    const retry = await tools.team_delete.execute({ team_name: "t" })
    // then
    expect(retry).toMatchObject({ name: "t", deleted: true, sessionsTerminated: ["ses_scout"] })
    expect(retry.retained).toBeUndefined()
    expect(terminated).toEqual(["ses_scout"])
    expect(await storage.get("rigel-v2/team/p-default/t")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Audit regression: the baseline read the team identifier as
// `input.team_name ?? input.name`. Row 55 made `team_name` canonical and
// dropped `name` entirely, which breaks that contract. The alias is restored as
// DEPRECATED: `team_name` stays canonical and is what /team-mode emits; the two
// may be combined only when they name the same team.
// ---------------------------------------------------------------------------
describe("row 55 audit: the deprecated `name` alias stays backward compatible", () => {
  test("#given only the legacy `name` key #when team_create runs #then the team is created under that identifier", async () => {
    // given
    const storage = memoryStorage()
    const spawned = []
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead-session",
      startMemberSession: async (assignment) => { spawned.push(assignment.name); return { sessionID: `ses_${assignment.name}` } },
    })
    // when
    const team = await tools.team_create.execute({ name: "legacy", members: [{ name: "scout", agent: "explore", prompt: "map it" }] })
    // then: the baseline behavior, including a real spawned member session
    expect(team.name).toBe("legacy")
    expect(spawned).toEqual(["scout"])
    expect(await storage.get("rigel-v2/team/p-default/legacy")).toMatchObject({ name: "legacy", status: "active" })
  })

  test("#given a legacy-named team #when lifecycle tools address it by `name` #then they operate on the same record", async () => {
    // given
    const storage = memoryStorage()
    const terminated = []
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead-session",
      startMemberSession: async (assignment) => ({ sessionID: `ses_${assignment.name}` }),
      terminateMemberSession: async (sessionID) => { terminated.push(sessionID); return { sessionID, deleted: true } },
    })
    await tools.team_create.execute({ name: "legacy", members: [{ name: "scout", agent: "explore", prompt: "map it" }] })
    // when
    const task = await tools.team_task_create.execute({ name: "legacy", task: { title: "audit" } })
    const status = await tools.team_status.execute({ name: "legacy" })
    const deleted = await tools.team_delete.execute({ name: "legacy" })
    // then
    expect(task.status).toBe("open")
    expect(status.tasks).toHaveLength(1)
    expect(deleted).toMatchObject({ name: "legacy", deleted: true })
    expect(terminated).toEqual(["ses_scout"])
    expect(await storage.get("rigel-v2/team/p-default/legacy")).toBeUndefined()
  })

  test("#given equal team_name and name #when team_create runs #then they normalize to the one identifier", async () => {
    // given
    const storage = memoryStorage()
    const tools = createTeamTools({ storage, getSessionID: () => "lead-session" })
    // when
    const team = await tools.team_create.execute({ team_name: "same", name: "same", members: ["scout"] })
    // then: accepted, and stored once under the canonical key
    expect(team.name).toBe("same")
    expect(await storage.get("rigel-v2/team/p-default/same")).toMatchObject({ name: "same" })
    expect(storage.map.size).toBe(1)
  })

  test("#given conflicting team_name and name #when team_create runs #then it rejects with zero side effects", async () => {
    // given: every seam that could produce an observable side effect is spanned
    const storage = memoryStorage()
    const { calls, runGit } = recordingRunner()
    const manager = createTeamWorktreeManager({ repoRoot: "/repo", runGit, removeDir: noRemoveDir, removeEmptyDir: async () => {} })
    const reconciler = reconcilerStub()
    const spawned = []
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead-session",
      worktreeManager: manager,
      worktreeReconciler: reconciler,
      startMemberSession: async (assignment) => { spawned.push(assignment.name); return { sessionID: `ses_${assignment.name}` } },
    })
    // when / then
    await expect(tools.team_create.execute({ team_name: "alpha", name: "beta", members: [{ name: "scout", agent: "explore", prompt: "map it" }] })).rejects.toThrow(/disagree/i)
    expect(spawned).toEqual([])
    expect(calls).toEqual([])
    expect(reconciler.calls).toEqual([])
    expect(storage.map.size).toBe(0)
  })

  test("#given conflicting aliases #when a lifecycle tool runs #then the existing team is untouched", async () => {
    // given
    const storage = memoryStorage()
    const terminated = []
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead-session",
      startMemberSession: async (assignment) => ({ sessionID: `ses_${assignment.name}` }),
      terminateMemberSession: async (sessionID) => { terminated.push(sessionID); return { sessionID, deleted: true } },
    })
    await tools.team_create.execute({ name: "legacy", members: [{ name: "scout", agent: "explore", prompt: "map it" }] })
    // when / then: rejected, and no member session was terminated
    await expect(tools.team_delete.execute({ team_name: "legacy", name: "legacy2" })).rejects.toThrow(/disagree/i)
    expect(terminated).toEqual([])
    expect(await storage.get("rigel-v2/team/p-default/legacy")).toMatchObject({ name: "legacy" })
  })
})

// ---------------------------------------------------------------------------
// Audit regression round 2, blockers 2 and 3 + reviewer note 5:
//   - cleanup is transactional: a create that cannot reclaim a spawned session
//     keeps a recoverable record; a delete that cannot terminate an owned session
//     keeps the record and reports deleted:false;
//   - session provenance is tracked: an ADOPTED sessionID is foreign, so it is
//     detached and never reaches the terminator (delete or create rollback);
//   - an unverifiable deletion is reported as unverified, never as a verified close.
// ---------------------------------------------------------------------------
describe("row 55 audit round 2: owned vs adopted sessions, transactional cleanup", () => {
  test("#given a member that ADOPTS an existing session #when team_delete runs #then it is detached and never reaches the terminator", async () => {
    // given
    const storage = memoryStorage()
    const terminated = []
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead-session",
      terminateMemberSession: async (sessionID) => { terminated.push(sessionID); return { sessionID, deleted: true } },
    })
    await tools.team_create.execute({ team_name: "t", members: [{ name: "scout", sessionID: "ses_foreign" }] })
    // when
    const result = await tools.team_delete.execute({ team_name: "t" })
    // then: a foreign session is never deleted, only detached
    expect(terminated).toEqual([])
    expect(result).toMatchObject({ name: "t", deleted: true, sessionsTerminated: [], sessionsDetached: ["ses_foreign"] })
    expect(await storage.get("rigel-v2/team/p-default/t")).toBeUndefined()
  })

  test("#given an adopted and a spawned member #when team_delete runs #then only the spawned session reaches the terminator", async () => {
    // given
    const storage = memoryStorage()
    const terminated = []
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead-session",
      startMemberSession: async (assignment) => ({ sessionID: `ses_${assignment.name}` }),
      terminateMemberSession: async (sessionID) => { terminated.push(sessionID); return { sessionID, deleted: true } },
    })
    await tools.team_create.execute({ team_name: "t", members: [
      { name: "scout", sessionID: "ses_foreign" },
      { name: "digger", agent: "explore", prompt: "b" },
    ] })
    // when
    const result = await tools.team_delete.execute({ team_name: "t" })
    // then
    expect(terminated).toEqual(["ses_digger"])
    expect(result.sessionsTerminated).toEqual(["ses_digger"])
    expect(result.sessionsDetached).toEqual(["ses_foreign"])
  })

  test("#given an owned member session that cannot be terminated #when team_delete runs #then the member worktree is NOT reclaimed and the record keeps its retry state", async () => {
    // given: a team with a per-member worktree whose member session survives the teardown
    const { calls, runGit } = recordingRunner()
    const storage = memoryStorage()
    const manager = createTeamWorktreeManager({ repoRoot: "/repo", runGit, removeDir: noRemoveDir, removeEmptyDir: async () => {} })
    const reconciler = createTeamWorktreeReconciler({ storage, worktrees: manager, projectKey: "p-default", repoRoot: "/repo" })
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead-session",
      worktreeManager: manager,
      worktreeReconciler: reconciler,
      startMemberSession: async (assignment) => ({ sessionID: `ses_${assignment.name}` }),
      terminateMemberSession: async (sessionID) => ({ sessionID, deleted: false, error: "presence probe unavailable" }),
    })
    await tools.team_create.execute({ team_name: "builders", members: [{ name: "scout", agent: "explore", prompt: "a" }] })
    // when
    const result = await tools.team_delete.execute({ team_name: "builders" })
    // then: the working directory of a session that is still alive is never reclaimed,
    // and the record survives with the retry state a second team_delete can finish
    expect(result).toMatchObject({ name: "builders", deleted: false, retained: true })
    expect(calls.filter((line) => line.includes("worktree remove --force"))).toHaveLength(0)
    expect(await storage.get("rigel-v2/team/p-default/builders")).toMatchObject({ status: "cleanup-failed", cleanupPending: ["ses_scout"] })
  })

  test("#given a spawn seam that reports a created child and then fails #when team_create rolls back #then that child reaches the terminator", async () => {
    // given: the seam created a child (its prompt failed), so the child EXISTS even
    // though the spawn itself threw and the caller never received its id
    const storage = memoryStorage()
    const terminated = []
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead-session",
      startMemberSession: async (assignment, meta) => {
        meta.onSessionCreated?.("ses_leaked")
        throw new Error("prompt failed")
      },
      terminateMemberSession: async (sessionID) => { terminated.push(sessionID); return { sessionID, deleted: true } },
    })
    // when / then: the child this create spawned is owned and is cleaned up
    await expect(tools.team_create.execute({ team_name: "t", members: [{ name: "scout", agent: "explore", prompt: "a" }] })).rejects.toThrow("prompt failed")
    expect(terminated).toEqual(["ses_leaked"])
  })

  test("#given a seam that reports the child it created and a later member that fails #when the create rolls back #then each created session is terminated exactly once", async () => {
    // given: the runtime reports every child it creates, and a LATER member fails, so
    // the first member's session is already alive when the rollback runs
    const storage = memoryStorage()
    const terminated = []
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead-session",
      startMemberSession: async (assignment, meta) => {
        if (assignment.name === "digger") throw new Error("spawn exploded")
        meta.onSessionCreated?.(`ses_${assignment.name}`)
        return { sessionID: `ses_${assignment.name}` }
      },
      terminateMemberSession: async (sessionID) => { terminated.push(sessionID); return { sessionID, deleted: true } },
    })
    // when
    await expect(tools.team_create.execute({ team_name: "t", members: [
      { name: "scout", agent: "explore", prompt: "a" },
      { name: "digger", agent: "explore", prompt: "b" },
    ] })).rejects.toThrow("spawn exploded")
    // then: the terminator is called ONCE per created session (a session reported at
    // creation AND returned by the seam is still ONE child)
    expect(terminated).toEqual(["ses_scout"])
  })

  test("#given a client fallback that left an earlier child behind #when team_create succeeds #then the leftover child is terminated", async () => {
    // given: the first attempt created a child whose prompt failed, the second one
    // produced the effective child
    const storage = memoryStorage()
    const terminated = []
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead-session",
      startMemberSession: async (assignment, meta) => {
        meta.onSessionCreated?.("ses_orphan")
        meta.onSessionCreated?.("ses_scout")
        return { sessionID: "ses_scout" }
      },
      terminateMemberSession: async (sessionID) => { terminated.push(sessionID); return { sessionID, deleted: true } },
    })
    // when
    const team = await tools.team_create.execute({ team_name: "t", members: [{ name: "scout", agent: "explore", prompt: "a" }] })
    // then: the member runs on the effective child, and the leftover is not left running
    expect(team.members[0].sessionID).toBe("ses_scout")
    expect(terminated).toEqual(["ses_orphan"])
  })

  test("#given an adopted session during a create rollback #when binding fails #then the adopted session never reaches the terminator", async () => {
    // given: a bind failure AFTER the record is written, on an ADOPTED member
    const { runGit } = recordingRunner()
    const storage = memoryStorage()
    const terminated = []
    const manager = createTeamWorktreeManager({
      repoRoot: "/repo",
      runGit,
      removeDir: noRemoveDir,
      removeEmptyDir: async () => {},
      bindSession: async ({ sessionID }) => { if (sessionID === "ses_foreign") throw new Error("move failed") },
    })
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead-session",
      worktreeManager: manager,
      terminateMemberSession: async (sessionID) => { terminated.push(sessionID); return { sessionID, deleted: true } },
    })
    // when / then
    await expect(tools.team_create.execute({ team_name: "t", members: [{ name: "scout", sessionID: "ses_foreign" }] })).rejects.toThrow("bind failed")
    expect(terminated).toEqual([])
    expect(await storage.get("rigel-v2/team/p-default/t")).toBeUndefined()
  })

  test("#given provisioning throws #when team_create runs #then the create journal is reconciled before the error escapes", async () => {
    // given: a create-in-progress journal entry that a provisioning failure would strand
    const { runGit } = recordingRunner((args) => {
      if (args.includes("--is-inside-work-tree")) return { code: 0, stdout: "true\n", stderr: "" }
      if (args.includes("add")) return { code: 128, stdout: "", stderr: "add failed" }
      return { code: 0, stdout: "", stderr: "" }
    })
    const reconciler = reconcilerStub()
    const storage = memoryStorage()
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead-session",
      worktreeManager: createTeamWorktreeManager({ repoRoot: "/repo", runGit, removeDir: noRemoveDir, removeEmptyDir: async () => {} }),
      worktreeReconciler: reconciler,
    })
    // when / then
    await expect(tools.team_create.execute({ team_name: "broken", members: [{ name: "scout" }] })).rejects.toThrow(/Nothing was created/)
    expect(reconciler.calls).toContainEqual(["runPending", "broken", "provision-failed"])
    expect(await storage.get("rigel-v2/team/p-default/broken")).toBeUndefined()
  })

  test("#given a rollback that cannot terminate a spawned session #when team_create fails #then a recoverable cleanup-failed record keeps the remaining owned session ids", async () => {
    // given: member two cannot spawn and member one cannot be terminated yet
    const storage = memoryStorage()
    const terminated = []
    let terminatorAvailable = false
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead-session",
      startMemberSession: async (assignment) => {
        if (assignment.name === "digger") throw new Error("spawn exploded")
        return { sessionID: `ses_${assignment.name}` }
      },
      terminateMemberSession: async (sessionID) => {
        if (!terminatorAvailable) return { sessionID, deleted: false, error: "presence probe unavailable" }
        terminated.push(sessionID)
        return { sessionID, deleted: true }
      },
    })
    // when
    await expect(tools.team_create.execute({ team_name: "t", members: [
      { name: "scout", agent: "explore", prompt: "a" },
      { name: "digger", agent: "explore", prompt: "b" },
    ] })).rejects.toThrow("spawn exploded")
    // then: the record is NOT dropped while an owned session could not be terminated
    const retained = await storage.get("rigel-v2/team/p-default/t")
    expect(retained).toMatchObject({ status: "cleanup-failed", cleanupPending: ["ses_scout"] })
    expect(retained.cleanupErrors).toEqual([{ sessionID: "ses_scout", error: "presence probe unavailable" }])
    // when: the terminator becomes available, so the kept record is actually recoverable
    terminatorAvailable = true
    const finished = await tools.team_delete.execute({ team_name: "t" })
    // then
    expect(finished).toMatchObject({ name: "t", deleted: true, sessionsTerminated: ["ses_scout"] })
    expect(terminated).toEqual(["ses_scout"])
    expect(await storage.get("rigel-v2/team/p-default/t")).toBeUndefined()
  })

  test("#given a deletion that could not be verified #when team_delete runs #then the result reports it and never claims a verified close", async () => {
    // given: the terminator deleted the session but could not prove it (note 5)
    const storage = memoryStorage()
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead-session",
      startMemberSession: async (assignment) => ({ sessionID: `ses_${assignment.name}` }),
      terminateMemberSession: async (sessionID) => ({ sessionID, deleted: true, unverified: true, verified: false, reason: "session.get({ sessionID }) failed (connect ECONNREFUSED 127.0.0.1:4096)", error: "presence probe unavailable" }),
    })
    await tools.team_create.execute({ team_name: "t", members: [{ name: "scout", agent: "explore", prompt: "a" }] })
    // when
    const result = await tools.team_delete.execute({ team_name: "t" })
    // then: the delete is reported, the verification gap is reported, and the team
    // is NOT falsely presented as a proven close
    expect(result).toMatchObject({ name: "t", deleted: false, retained: true, sessionsTerminated: [], sessionsFailed: [], sessionsUnverified: ["ses_scout"] })
    expect(result.sessionsUnverifiedReasons).toEqual([{ sessionID: "ses_scout", reason: "session.get({ sessionID }) failed (connect ECONNREFUSED 127.0.0.1:4096)" }])
    expect(result.warning).toContain("could not be VERIFIED")
    // An unproven close is not a proven absence, so it does not free the member's
    // working directory: the record is KEPT with the session pending, and a later
    // team_delete can prove the absence and finish the job (gate 2026-10-20, B1).
    expect(await storage.get("rigel-v2/team/p-default/t")).toMatchObject({ status: "cleanup-failed", cleanupPending: ["ses_scout"] })
  })

  test("#given a permission-refused presence probe #when team_delete runs #then the close is reported unverified, never terminated", async () => {
    // Final independent gate (ROW55): a 401/403 is an answered refusal, not an
    // absence. It must surface as a verification GAP, so no caller can read the
    // teardown as a proven close.
    const storage = memoryStorage()
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead-session",
      startMemberSession: async (assignment) => ({ sessionID: `ses_${assignment.name}` }),
      terminateMemberSession: async (sessionID) => ({
        sessionID,
        deleted: true,
        unverified: true,
        verified: false,
        reason: "session.get({ sessionID }) failed (Request failed with status 403)",
        error: "permission probe unavailable",
      }),
    })
    await tools.team_create.execute({ team_name: "t", members: [{ name: "scout", agent: "explore", prompt: "a" }] })
    // when
    const result = await tools.team_delete.execute({ team_name: "t" })
    // then
    expect(result).toMatchObject({ name: "t", deleted: false, retained: true, sessionsTerminated: [], sessionsFailed: [], sessionsUnverified: ["ses_scout"] })
    expect(result.sessionsUnverifiedReasons).toEqual([{ sessionID: "ses_scout", reason: "session.get({ sessionID }) failed (Request failed with status 403)" }])
    expect(result.warning).toContain("could not be VERIFIED")
    // A refusal is not an absence, so the working directory stays and the record
    // stays too (gate 2026-10-20, B1).
    expect(await storage.get("rigel-v2/team/p-default/t")).toMatchObject({ status: "cleanup-failed", cleanupPending: ["ses_scout"] })
  })

  test("#given an SDK-wrapped 403 from the REAL terminator #when team_delete runs #then the close is unverified and never listed as terminated", async () => {
    // Final gate round 2 (ROW55): the host stores the status at `cause.status`, so
    // the only honest proof of the reporting contract is the real seam end to end -
    // a mocked terminator result cannot show that a wrapped 403 stays unverified.
    const storage = memoryStorage()
    const terminateMemberSession = createMemberSessionTerminator({
      domains: {
        session: {
          async remove() {},
          async get(address) {
            if (!address?.sessionID) throw Object.assign(new Error('Missing key at ["sessionID"]'), { name: "SchemaError" })
            if (address.sessionID === "lead-session") return { id: "lead-session" }
            throw Object.assign(new Error("Request failed"), { cause: { status: 403 } })
          },
        },
      },
    })
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead-session",
      startMemberSession: async (assignment) => ({ sessionID: `ses_${assignment.name}` }),
      terminateMemberSession,
    })
    await tools.team_create.execute({ team_name: "t", members: [{ name: "scout", agent: "explore", prompt: "a" }] })
    // when
    const result = await tools.team_delete.execute({ team_name: "t" })
    // then
    expect(result).toMatchObject({ name: "t", deleted: false, retained: true, sessionsTerminated: [], sessionsFailed: [], sessionsUnverified: ["ses_scout"] })
    expect(result.warning).toContain("could not be VERIFIED")
    // The real seam proves the gap end to end: no working directory is released
    // and the record survives until the absence can be proven (gate 2026-10-20, B1).
    expect(await storage.get("rigel-v2/team/p-default/t")).toMatchObject({ status: "cleanup-failed", cleanupPending: ["ses_scout"] })
  })

  test("#given a non-git root and an OMITTED worktree #when team_create runs #then it fails loudly, routes the policy change to the user, and creates nothing", async () => {
    // Blocker 1 restores the LEGACY default: a manager exists for every scope, so an
    // OMITTED `worktree` in a non-git root provisions and `ensureGitRepository`
    // throws - exactly like the baseline tool. The failure must be loud, and it must
    // NOT hand the model a bypass: switching to `worktree: false` changes the policy
    // the user chose, so the message demands the user's explicit confirmation.
    const { runGit } = recordingRunner((args) => (args.includes("--is-inside-work-tree") ? { code: 128, stdout: "", stderr: "not a git repository" } : { code: 0, stdout: "", stderr: "" }))
    const storage = memoryStorage()
    const { tools } = buildTools({ storage, runGit })
    // when
    const error = await tools.team_create.execute({ team_name: "nongit", members: [{ name: "scout" }] }).catch((thrown) => thrown)
    // then
    expect(error.message).toContain("team worktrees require a git repository")
    expect(error.message).toMatch(/confirm/i)
    expect(error.message).toContain("Nothing was created; worktree journal")
    expect(await storage.get("rigel-v2/team/p-default/nongit")).toBeUndefined()
  })

  test("#given a record written before ownership existed #when team_delete runs #then its sessions are detached, never terminated", async () => {
    // Upgrading a pre-ownership record: `owned` is absent, so the team cannot PROVE
    // it spawned that session. Unprovable means NOT owned: detached and reported,
    // never deleted. This is a deliberate behavior change for old records.
    const storage = memoryStorage({
      "rigel-v2/team/p-default/legacy": { name: "legacy", projectKey: "p-default", status: "active", members: [{ name: "scout", sessionID: "ses_old", status: "running" }], messages: [], tasks: [] },
    })
    const terminated = []
    const tools = createTeamTools({ storage, getSessionID: () => "lead-session", terminateMemberSession: async (sessionID) => { terminated.push(sessionID); return { sessionID, deleted: true } } })
    // when
    const result = await tools.team_delete.execute({ team_name: "legacy" })
    // then: nothing is terminated, and the unprovable session is REPORTED as detached
    expect(terminated).toEqual([])
    expect(result).toEqual({ name: "legacy", deleted: true, sessionsTerminated: [], sessionsFailed: [], sessionsDetached: ["ses_old"], sessionsUnverified: [] })
    expect(await storage.get("rigel-v2/team/p-default/legacy")).toBeUndefined()
  })
})


// ---------------------------------------------------------------------------
// D5 follow-up (gate 2026-10-20): a member worktree is the WORKING DIRECTORY of a
// session, so it is reclaimed only when the team can PROVE that session no longer
// uses it. Two cases were missing that proof:
//   B1 - a close whose absence could not be VERIFIED (`deleted:true, unverified:true`)
//   B2 - an ADOPTED (foreign) session, which this team never terminates at all
// Driven over a REAL git worktree: the directory on disk is the observable.
// ---------------------------------------------------------------------------
describe("D5 follow-up: a working directory is only released when its session is proven gone, and an unproven close never counts as success (delete, create rollback AND multi-client leftovers)", () => {
  const temporary = []
  afterEach(() => { while (temporary.length > 0) fs.rmSync(temporary.pop(), { recursive: true, force: true }) })

  function realRepo() {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-team-d5-"))
    temporary.push(repo)
    execFileSync("git", ["init", "-q", repo])
    execFileSync("git", ["-C", repo, "-c", "user.email=qa@example.invalid", "-c", "user.name=qa", "commit", "-q", "--allow-empty", "-m", "init"])
    return repo
  }

  function realTeam({ repo, bindSession, terminateMemberSession, startMemberSession, sessionDirectory, scope }) {
    const storage = memoryStorage()
    const manager = createTeamWorktreeManager({ repoRoot: repo, runGit: createGitWorktreeRunner(), bindSession })
    const reconciler = createTeamWorktreeReconciler({ storage, worktrees: manager, projectKey: "p-default", repoRoot: repo })
    const tools = createTeamTools({
      storage,
      getSessionID: () => "lead-session",
      worktreeManager: manager,
      worktreeReconciler: reconciler,
      startMemberSession,
      terminateMemberSession,
      resolveScopeForSession: async () => (scope
        ? await scope({ repo, manager, reconciler })
        : { projectKey: "p-default", repoRoot: repo, directory: repo, worktrees: manager, reconciler, sessionDirectory }),
    })
    return { storage, tools, manager }
  }

  test("#given a member close with NO proof of absence #when team_delete runs #then the member worktree survives and the record is KEPT", async () => {
    // given: the delete resolved, but the presence probe was unavailable, so the
    // absence of the session was never proven
    const repo = realRepo()
    const terminated = []
    const { storage, tools } = realTeam({
      repo,
      bindSession: async () => {},
      startMemberSession: async (assignment) => ({ sessionID: `ses_${assignment.name}` }),
      terminateMemberSession: async (sessionID) => { terminated.push(sessionID); return { sessionID, deleted: true, unverified: true, reason: "presence probe unavailable" } },
    })
    await tools.team_create.execute({ team_name: "builders", worktree: true, members: [{ name: "scout", agent: "explore", prompt: "a" }] })
    const worktreePath = (await storage.get("rigel-v2/team/p-default/builders")).members[0].worktreePath
    expect(fs.existsSync(worktreePath)).toBe(true)
    // when
    const result = await tools.team_delete.execute({ team_name: "builders" })
    // then: an unproven close never frees a working directory, and the record stays
    // so that a later team_delete can finish the job once the absence is proven
    expect(result).toMatchObject({ name: "builders", deleted: false, retained: true })
    expect(result.sessionsUnverified).toEqual(["ses_scout"])
    expect(fs.existsSync(worktreePath)).toBe(true)
    expect(await storage.get("rigel-v2/team/p-default/builders")).toBeDefined()
    expect(terminated).toEqual(["ses_scout"])
  })

  test("#given an ADOPTED member that lives in its own worktree #when team_delete runs #then the foreign session is never terminated and its working directory survives", async () => {
    // given: a session this team does not own, sitting in the worktree the team
    // provisioned for it
    const repo = realRepo()
    const moves = []
    const directories = new Map()
    const terminated = []
    const { storage, tools } = realTeam({
      repo,
      bindSession: async ({ sessionID, directory }) => { moves.push({ sessionID, directory }); directories.set(sessionID, directory) },
      terminateMemberSession: async (sessionID) => { terminated.push(sessionID); return { sessionID, deleted: true } },
      sessionDirectory: async (sessionID) => directories.get(sessionID),
    })
    await tools.team_create.execute({ team_name: "t", worktree: true, members: [{ name: "scout", sessionID: "ses_foreign" }] })
    const worktreePath = (await storage.get("rigel-v2/team/p-default/t")).members[0].worktreePath
    expect(directories.get("ses_foreign")).toBe(worktreePath)
    moves.length = 0
    // when
    const result = await tools.team_delete.execute({ team_name: "t" })
    // then: a foreign session is never terminated, and the directory it works in
    // still exists afterwards - either because the session was moved out of it, or
    // because the tree that holds it was kept
    expect(terminated).toEqual([])
    expect(result.sessionsDetached).toEqual(["ses_foreign"])
    // the foreign session now works OUTSIDE the tree that was reclaimed, and that
    // directory exists
    expect(directories.get("ses_foreign")).not.toBe(worktreePath)
    expect(fs.existsSync(directories.get("ses_foreign"))).toBe(true)
  })

  test("#given an ADOPTED member whose session CANNOT be moved out of its worktree #when team_delete runs #then that worktree is preserved and the record is KEPT", async () => {
    // given: a host that refuses to move a session out of a team worktree, so the
    // foreign session keeps working in the tree the team provisioned
    const repo = realRepo()
    const moves = []
    const directories = new Map()
    const terminated = []
    const { storage, tools } = realTeam({
      repo,
      bindSession: async ({ sessionID, directory }) => {
        moves.push({ sessionID, directory })
        if (directory === repo) throw new Error("this host refuses to move a session out of its worktree")
        directories.set(sessionID, directory)
      },
      terminateMemberSession: async (sessionID) => { terminated.push(sessionID); return { sessionID, deleted: true } },
      sessionDirectory: async (sessionID) => directories.get(sessionID),
    })
    await tools.team_create.execute({ team_name: "t", worktree: true, members: [{ name: "scout", sessionID: "ses_foreign" }] })
    const worktreePath = (await storage.get("rigel-v2/team/p-default/t")).members[0].worktreePath
    moves.length = 0
    // when
    const result = await tools.team_delete.execute({ team_name: "t" })
    // then: the tree that holds the foreign session is NOT reclaimed, and the record
    // survives so the directory stays referenced and a later team_delete can finish
    expect(terminated).toEqual([])
    expect(result).toMatchObject({ name: "t", deleted: false, retained: true })
    expect(fs.existsSync(worktreePath)).toBe(true)
    expect(await storage.get("rigel-v2/team/p-default/t")).toBeDefined()
  })

  // The create ROLLBACK is the sibling teardown path, and the delta that binds a member
  // into its worktree before its first prompt (and an adopted one before the spawn loop)
  // makes that tree live DURING the rollback: reclaiming it there destroys the working
  // directory of a session that may still be alive.
  test("#given an ADOPTED member bound into its worktree #when the create rolls back #then that worktree is NOT reclaimed and the record is kept", async () => {
    // given: a team with a foreign session and a member whose spawn fails
    const repo = realRepo()
    const terminated = []
    const { storage, tools } = realTeam({
      repo,
      bindSession: async () => {},
      startMemberSession: async () => { throw new Error("spawn exploded") },
      terminateMemberSession: async (sessionID) => { terminated.push(sessionID); return { sessionID, deleted: true } },
    })
    // when
    await expect(tools.team_create.execute({ team_name: "t", worktree: true, members: [
      { name: "guest", sessionID: "ses_foreign" },
      { name: "scout", agent: "explore", prompt: "a" },
    ] })).rejects.toThrow("spawn exploded")
    // then: the foreign session is never terminated, and the tree this create bound it into
    // (its working directory) survives; the record stays so the directory keeps being
    // referenced and a later team_delete can finish the teardown
    const record = await storage.get("rigel-v2/team/p-default/t")
    const guest = record.members.find((member) => member.sessionID === "ses_foreign")
    const scout = record.members.find((member) => member.name === "scout")
    expect(terminated).toEqual([])
    expect(fs.existsSync(guest.worktreePath)).toBe(true)
    expect(record).toMatchObject({ status: "cleanup-failed" })
    expect(record.worktreesPreserved.map((entry) => entry.worktreePath)).toContain(guest.worktreePath)
    // and the tree of the member that never got a session IS reclaimed
    expect(fs.existsSync(scout.worktreePath)).toBe(false)
  })

  test("#given a spawned member whose close cannot be verified #when the create rolls back #then its worktree is preserved and the record keeps it pending", async () => {
    // given: the seam created and bound the member, then its prompt failed, and the
    // terminator resolved the close without being able to PROVE the absence
    const repo = realRepo()
    const { storage, tools } = realTeam({
      repo,
      bindSession: async () => {},
      startMemberSession: async (assignment, meta) => {
        meta.onSessionCreated?.("ses_spawned")
        // the runtime reports the child, BINDS it into its worktree, and only then the
        // prompt fails: the tree is that session's live working directory
        await meta.bindSession?.({ sessionID: "ses_spawned", directory: meta.worktreePath })
        throw new Error("prompt failed")
      },
      terminateMemberSession: async (sessionID) => ({ sessionID, deleted: true, unverified: true, reason: "presence probe unavailable" }),
    })
    // when
    await expect(tools.team_create.execute({ team_name: "t", worktree: true, members: [{ name: "scout", agent: "explore", prompt: "a" }] })).rejects.toThrow("prompt failed")
    // then: an unproven close frees nothing, and the record keeps the session pending so a
    // later team_delete can prove the absence and finish the job
    const record = await storage.get("rigel-v2/team/p-default/t")
    expect(fs.existsSync(record.members[0].worktreePath)).toBe(true)
    expect(record).toMatchObject({ status: "cleanup-failed", cleanupPending: ["ses_spawned"] })
  })

  test("#given a host that ACCEPTS the move but never moves the foreign session #when team_delete runs #then the move counts as unverified and the tree is preserved", async () => {
    // given: the relocation call RESOLVES, but the session keeps working in the tree
    const repo = realRepo()
    const directories = new Map()
    const terminated = []
    const { storage, tools } = realTeam({
      repo,
      bindSession: async ({ sessionID, directory }) => {
        // the create's bind moves the session INTO the tree; the relocation resolves
        // but leaves it exactly where it was
        if (directory !== repo) directories.set(sessionID, directory)
      },
      terminateMemberSession: async (sessionID) => { terminated.push(sessionID); return { sessionID, deleted: true } },
      sessionDirectory: async (sessionID) => directories.get(sessionID),
    })
    await tools.team_create.execute({ team_name: "t", worktree: true, members: [{ name: "scout", sessionID: "ses_foreign" }] })
    const worktreePath = (await storage.get("rigel-v2/team/p-default/t")).members[0].worktreePath
    // when
    const result = await tools.team_delete.execute({ team_name: "t" })
    // then: a move that cannot be SEEN is not a move: the tree that still holds the
    // foreign session is preserved and the delete is retained
    expect(terminated).toEqual([])
    expect(result).toMatchObject({ name: "t", deleted: false, retained: true })
    expect(fs.existsSync(worktreePath)).toBe(true)
    expect(result.worktreesPreserved.map((entry) => entry.reason).join(" ")).toContain("could not be verified")
  })

  test("#given a scope whose safe directory IS the member worktree #when team_delete runs #then that worktree is preserved instead of reclaimed", async () => {
    // given: the "safe" directory the foreign session would be moved into is the tree
    // itself, so moving it there would free nothing
    const repo = realRepo()
    let safeDirectory = repo
    const directories = new Map()
    const terminated = []
    const { storage, tools } = realTeam({
      repo,
      bindSession: async ({ sessionID, directory }) => { directories.set(sessionID, directory) },
      terminateMemberSession: async (sessionID) => { terminated.push(sessionID); return { sessionID, deleted: true } },
      scope: async ({ manager, reconciler }) => ({
        projectKey: "p-default",
        repoRoot: safeDirectory,
        directory: safeDirectory,
        worktrees: manager,
        reconciler,
        sessionDirectory: async (sessionID) => directories.get(sessionID),
      }),
    })
    await tools.team_create.execute({ team_name: "t", worktree: true, members: [{ name: "scout", sessionID: "ses_foreign" }] })
    const worktreePath = (await storage.get("rigel-v2/team/p-default/t")).members[0].worktreePath
    safeDirectory = worktreePath
    // when
    const result = await tools.team_delete.execute({ team_name: "t" })
    // then: the reclaim would have deleted the live foreign session's own working
    // directory, so the tree is preserved and the delete is retained
    expect(terminated).toEqual([])
    expect(result).toMatchObject({ name: "t", deleted: false, retained: true })
    expect(fs.existsSync(worktreePath)).toBe(true)
    expect(result.worktreesPreserved.map((entry) => entry.reason).join(" ")).toContain("inside the worktree")
  })

  // The record a rollback KEEPS promises a retry ("call team_delete again to finish").
  // This proves the promise end to end over real worktrees: the foreign session is moved
  // out (never terminated), its tree is reclaimed and the record finally goes away.
  test("#given a rollback that kept a foreign session's directory #when team_delete runs again #then it converges: the session is moved out, the tree reclaimed and the record dropped", async () => {
    // given: the rollback preserved the adopted member's tree and kept the record
    const repo = realRepo()
    const directories = new Map()
    const terminated = []
    const { storage, tools } = realTeam({
      repo,
      bindSession: async ({ sessionID, directory }) => { directories.set(sessionID, directory) },
      startMemberSession: async () => { throw new Error("spawn exploded") },
      terminateMemberSession: async (sessionID) => { terminated.push(sessionID); return { sessionID, deleted: true } },
      sessionDirectory: async (sessionID) => directories.get(sessionID),
    })
    await expect(tools.team_create.execute({ team_name: "t", worktree: true, members: [
      { name: "guest", sessionID: "ses_foreign" },
      { name: "scout", agent: "explore", prompt: "a" },
    ] })).rejects.toThrow("spawn exploded")
    const kept = await storage.get("rigel-v2/team/p-default/t")
    const guestPath = kept.members.find((member) => member.sessionID === "ses_foreign").worktreePath
    expect(fs.existsSync(guestPath)).toBe(true)
    // when: the team is really deleted
    const result = await tools.team_delete.execute({ team_name: "t" })
    // then: the foreign session was moved out and never terminated, the freed tree is
    // reclaimed and the record finally goes away
    expect(terminated).toEqual([])
    expect(result).toMatchObject({ name: "t", deleted: true })
    expect(directories.get("ses_foreign")).toBe(repo)
    expect(fs.existsSync(guestPath)).toBe(false)
    expect(await storage.get("rigel-v2/team/p-default/t")).toBeUndefined()
  })

  // TWO CLIENTS for the SAME member: the first one creates a child, binds it into the
  // member's worktree and its prompt fails (the ORPHAN); the second one produces the
  // effective child. The orphan's close resolves but its absence cannot be PROVEN.
  const twoClients = async (meta, { orphan = "ses_orphan", effective = "ses_effective" } = {}) => {
    meta.onSessionCreated?.(orphan)
    await meta.bindSession?.({ sessionID: orphan, directory: meta.worktreePath })
    meta.onSessionCreated?.(effective)
    await meta.bindSession?.({ sessionID: effective, directory: meta.worktreePath })
    return { sessionID: effective }
  }

  test("#given two clients whose ORPHAN closes without a proven absence #when team_create runs #then it does NOT become active: the orphan forces the rollback and stays pending", async () => {
    // given: the orphan's close resolved but its absence was never proven
    const repo = realRepo()
    const { storage, tools } = realTeam({
      repo,
      bindSession: async () => {},
      startMemberSession: async (assignment, meta) => twoClients(meta),
      terminateMemberSession: async (sessionID) => (sessionID === "ses_orphan"
        ? { sessionID, deleted: true, unverified: true, reason: "presence probe unavailable" }
        : { sessionID, deleted: true }),
    })
    // when
    const error = await tools.team_create.execute({ team_name: "t", worktree: true, members: [{ name: "scout", agent: "explore", prompt: "a" }] }).catch((thrown) => thrown)
    // then: the team did NOT go live with a possibly-live orphan, and the orphan is
    // kept as a durable pending session a later team_delete can finish
    expect(error).toBeInstanceOf(Error)
    const record = await storage.get("rigel-v2/team/p-default/t")
    expect(record).toMatchObject({ status: "cleanup-failed", cleanupPending: ["ses_orphan"] })
    expect(record.status).not.toBe("active")
  })

  test("#given two clients whose ORPHAN closes without a proven absence #when the create rolls back #then the worktree the orphan is bound to is NOT reclaimed", async () => {
    // given: the EFFECTIVE child closed with a PROVEN absence, the ORPHAN did not
    const repo = realRepo()
    const { storage, tools } = realTeam({
      repo,
      bindSession: async () => {},
      startMemberSession: async (assignment, meta) => twoClients(meta),
      terminateMemberSession: async (sessionID) => (sessionID === "ses_orphan"
        ? { sessionID, deleted: true, unverified: true, reason: "presence probe unavailable" }
        : { sessionID, deleted: true }),
    })
    // when
    await tools.team_create.execute({ team_name: "t", worktree: true, members: [{ name: "scout", agent: "explore", prompt: "a" }] }).catch(() => {})
    const record = await storage.get("rigel-v2/team/p-default/t")
    const worktreePath = record.members[0].worktreePath
    // then: the reclaim counts EVERY session bound into that tree, not only the
    // effective one: the orphan may still be working there
    expect(fs.existsSync(worktreePath)).toBe(true)
    expect(record).toMatchObject({ status: "cleanup-failed", cleanupPending: ["ses_orphan"] })
    expect(record.worktreesPreserved.map((entry) => entry.worktreePath)).toContain(worktreePath)
  })

  test("#given two clients whose sessions are BOTH proven gone #when another member fails to spawn #then the shared worktree IS reclaimed", async () => {
    // given: every session bound into the tree is provably gone, so nothing lives there
    const repo = realRepo()
    const boundDirectories = []
    const { storage, tools } = realTeam({
      repo,
      bindSession: async ({ directory }) => { boundDirectories.push(directory) },
      startMemberSession: async (assignment, meta) => {
        if (assignment.name === "digger") throw new Error("spawn exploded")
        return twoClients(meta)
      },
      terminateMemberSession: async (sessionID) => ({ sessionID, deleted: true }),
    })
    // when
    await tools.team_create.execute({ team_name: "t", worktree: true, members: [
      { name: "scout", agent: "explore", prompt: "a" },
      { name: "digger", agent: "explore", prompt: "b" },
    ] }).catch(() => {})
    // then: a tree whose sessions are ALL proven gone is reclaimed (no leak) and the
    // record is dropped, because nothing was left unresolved
    const worktreePath = boundDirectories[0]
    expect(typeof worktreePath).toBe("string")
    expect(fs.existsSync(worktreePath)).toBe(false)
    expect(await storage.get("rigel-v2/team/p-default/t")).toBeUndefined()
})

  // The record a rollback KEEPS promises a retry ("call team_delete again to finish").
  // That retry must reach the ORPHAN (it is ours and it still holds the tree) and must
  // NOT release the tree while its absence is unproven.
  test("#given a retained ORPHAN whose absence is unproven #when team_delete runs again #then its tree is NOT reclaimed and the record stays", async () => {
    const repo = realRepo()
    const { storage, tools } = realTeam({
      repo,
      bindSession: async () => {},
      startMemberSession: async (assignment, meta) => twoClients(meta),
      terminateMemberSession: async (sessionID) => (sessionID === "ses_orphan"
        ? { sessionID, deleted: true, unverified: true, reason: "presence probe unavailable" }
        : { sessionID, deleted: true }),
    })
    await tools.team_create.execute({ team_name: "t", worktree: true, members: [{ name: "scout", agent: "explore", prompt: "a" }] }).catch(() => {})
    const kept = await storage.get("rigel-v2/team/p-default/t")
    const worktreePath = kept.members[0].worktreePath
    expect(kept).toMatchObject({ status: "cleanup-failed", cleanupPending: ["ses_orphan"] })
    // when: the documented retry runs
    const retry = await tools.team_delete.execute({ team_name: "t" })
    // then: the orphan was re-terminated (it is ours), its tree was NOT released (the absence
    // is still unproven) and the record survives with it pending
    expect(retry).toMatchObject({ name: "t", deleted: false, retained: true })
    expect(retry.sessionsUnverified).toEqual(["ses_orphan"])
    expect(fs.existsSync(worktreePath)).toBe(true)
    const record = await storage.get("rigel-v2/team/p-default/t")
    expect(record).toMatchObject({ status: "cleanup-failed", cleanupPending: ["ses_orphan"] })
  })

  test("#given a retained ORPHAN whose absence can be proven #when team_delete runs again #then the retry reclaims the tree and drops the record", async () => {
    const repo = realRepo()
    let orphanProven = false
    const { storage, tools } = realTeam({
      repo,
      bindSession: async () => {},
      startMemberSession: async (assignment, meta) => twoClients(meta),
      terminateMemberSession: async (sessionID) => (sessionID === "ses_orphan" && !orphanProven
        ? { sessionID, deleted: true, unverified: true, reason: "presence probe unavailable" }
        : { sessionID, deleted: true }),
    })
    await tools.team_create.execute({ team_name: "t", worktree: true, members: [{ name: "scout", agent: "explore", prompt: "a" }] }).catch(() => {})
    const worktreePath = (await storage.get("rigel-v2/team/p-default/t")).members[0].worktreePath
    // when: the absence can finally be proven
    orphanProven = true
    const retry = await tools.team_delete.execute({ team_name: "t" })
    // then: the retry converges - the tree is released and the record is gone
    expect(retry).toMatchObject({ name: "t", deleted: true })
    expect(fs.existsSync(worktreePath)).toBe(false)
    expect(await storage.get("rigel-v2/team/p-default/t")).toBeUndefined()
  })




  test("#given a retained ORPHAN whose BIND failed #when team_delete runs again #then the retry reaches that orphan too", async () => {
    // given: the orphan's bind failed, so it never entered the member tree, but it is
    // still a child this create owns
    const repo = realRepo()
    const terminated = []
    let orphanProven = false
    const { storage, tools } = realTeam({
      repo,
      bindSession: async ({ sessionID }) => { if (sessionID === "ses_orphan") throw new Error("move refused") },
      startMemberSession: async (assignment, meta) => {
        // the orphan is reported and its bind FAILS, but the seam continues and returns
        // the effective child: the orphan is then OUR child that no longer lives in
        // the member tree, so only the roster can name it
        meta.onSessionCreated?.("ses_orphan")
        try { await meta.bindSession?.({ sessionID: "ses_orphan", directory: meta.worktreePath }) } catch { /* the move was refused */ }
        meta.onSessionCreated?.("ses_effective")
        await meta.bindSession?.({ sessionID: "ses_effective", directory: meta.worktreePath })
        return { sessionID: "ses_effective" }
      },
      terminateMemberSession: async (sessionID) => {
        terminated.push(sessionID)
        return sessionID === "ses_orphan" && !orphanProven
          ? { sessionID, deleted: true, unverified: true, reason: "presence probe unavailable" }
          : { sessionID, deleted: true }
      },
    })
    await tools.team_create.execute({ team_name: "t", worktree: true, members: [{ name: "scout", agent: "explore", prompt: "a" }] }).catch(() => {})
    const kept = await storage.get("rigel-v2/team/p-default/t")
    expect(kept).toMatchObject({ status: "cleanup-failed", cleanupPending: ["ses_orphan"] })
    // when: the documented retry runs
    const retry = await tools.team_delete.execute({ team_name: "t" })
    // then: the retry REACHES the orphan (it is ours even though it was never bound)
    expect(terminated).toContain("ses_orphan")
    expect(retry).toMatchObject({ name: "t", deleted: false, retained: true })
    expect(retry.sessionsUnverified).toEqual(["ses_orphan"])
    // and once its absence can be proven, the retry converges
    orphanProven = true
    const finished = await tools.team_delete.execute({ team_name: "t" })
    expect(finished).toMatchObject({ name: "t", deleted: true })
    expect(finished.sessionsTerminated).toContain("ses_orphan")
    expect(await storage.get("rigel-v2/team/p-default/t")).toBeUndefined()
  })

  test("#given a member that declares foreign session ids #when team_delete runs #then those ids are never terminated", async () => {
    // given: a caller tries to smuggle ids into the roster. The ownership of a session
    // is decided by THIS create, never by the caller, so the smuggled ids are dropped.
    const repo = realRepo()
    const terminated = []
    const { storage, tools } = realTeam({
      repo,
      bindSession: async () => {},
      startMemberSession: async (assignment) => ({ sessionID: `ses_${assignment.name}` }),
      terminateMemberSession: async (sessionID) => { terminated.push(sessionID); return { sessionID, deleted: true } },
    })
    await tools.team_create.execute({ team_name: "t", worktree: true, members: [
      { name: "scout", agent: "explore", prompt: "a", createdSessionIDs: ["ses_victim"], boundSessionIDs: ["ses_victim"] },
    ] })
    const record = await storage.get("rigel-v2/team/p-default/t")
    expect(record.members[0].createdSessionIDs).toBeUndefined()
    expect(record.members[0].boundSessionIDs).toBeUndefined()
    // when
    await tools.team_delete.execute({ team_name: "t" })
    // then: only the session this create spawned was terminated
    expect(terminated).toEqual(["ses_scout"])
    expect(terminated).not.toContain("ses_victim")
  })
})
