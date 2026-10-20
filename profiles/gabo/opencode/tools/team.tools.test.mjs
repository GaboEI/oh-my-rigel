import { describe, expect, test } from "bun:test"
import { createTeamTools } from "./team.tools.mjs"
import { createTeamWorktreeManager } from "../rigel-v2-team-worktrees.mjs"
import { createMemberSessionTerminator } from "../rigel-v2-native-session-teardown.mjs"

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
    expect(result).toMatchObject({ name: "t", deleted: true, sessionsTerminated: [], sessionsFailed: [], sessionsUnverified: ["ses_scout"] })
    expect(result.sessionsUnverifiedReasons).toEqual([{ sessionID: "ses_scout", reason: "session.get({ sessionID }) failed (connect ECONNREFUSED 127.0.0.1:4096)" }])
    expect(result.warning).toContain("could not be VERIFIED")
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
    expect(result).toMatchObject({ name: "t", deleted: true, sessionsTerminated: [], sessionsFailed: [], sessionsUnverified: ["ses_scout"] })
    expect(result.sessionsUnverifiedReasons).toEqual([{ sessionID: "ses_scout", reason: "session.get({ sessionID }) failed (Request failed with status 403)" }])
    expect(result.warning).toContain("could not be VERIFIED")
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
    expect(result).toMatchObject({ name: "t", deleted: true, sessionsTerminated: [], sessionsFailed: [], sessionsUnverified: ["ses_scout"] })
    expect(result.warning).toContain("could not be VERIFIED")
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
