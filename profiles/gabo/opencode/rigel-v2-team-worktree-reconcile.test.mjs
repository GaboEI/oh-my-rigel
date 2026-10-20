import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { createTeamWorktreeReconciler } from "./rigel-v2-team-worktree-reconcile.mjs"
import { runMutation } from "./test-support/mutation-harness.mjs"

// Records are project-scoped; these tests use the default project key.
const PK = "p-default"
const TEAM_PREFIX = `rigel-v2/team/${PK}/`
const CLEANUP_JOURNAL_PREFIX = `rigel-v2/team-cleanup/${PK}/`

const temporary = []
afterEach(() => { while (temporary.length > 0) fs.rmSync(temporary.pop(), { recursive: true, force: true }) })
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-v2-team-reconcile-"))
  temporary.push(dir)
  return dir
}

const MODULE_SOURCE = fileURLToPath(new URL("./rigel-v2-team-worktree-reconcile.mjs", import.meta.url))
const SCOPE_SOURCE = fileURLToPath(new URL("./rigel-v2-team-project-scope.mjs", import.meta.url))

// The reconciler imports the scope module with a relative specifier; the
// mutation harness imports a copy, so the dependency must sit beside it.
function copyReconcilerWithDeps(dir) {
  const target = path.join(dir, "rigel-v2-team-worktree-reconcile.mjs")
  fs.copyFileSync(MODULE_SOURCE, target)
  fs.copyFileSync(SCOPE_SOURCE, path.join(dir, "rigel-v2-team-project-scope.mjs"))
  return target
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key) : undefined },
    async set(key, value) { map.set(key, value) },
    async remove(key) { map.delete(key) },
    async scan({ prefix = "" } = {}) { return { entries: [...map.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) } },
  }
}

// A worktree-manager stub whose cleanup result is scripted per call.
function scriptedWorktrees(cleanupResults = [], sweep = { removed: [], errors: [] }) {
  const calls = { cleanup: 0, sweep: 0 }
  let index = 0
  return {
    calls,
    async cleanup() {
      calls.cleanup += 1
      const next = cleanupResults[Math.min(index, cleanupResults.length - 1)] ?? { removed: [], errors: [] }
      index += 1
      return next
    },
    async sweepOrphans({ referenced }) { calls.sweep += 1; return { ...sweep, referenced } },
  }
}

const WORKTREE_MEMBER = { name: "scout", worktreePath: "/w/scout", worktreeBranch: "rigel-team/t/scout" }

describe("team worktree cleanup journal", () => {
  test("#given no pending cleanup #when reconcile runs #then it is a no-op that reports nothing to clean", async () => {
    const reconciler = createTeamWorktreeReconciler({ storage: memoryStorage(), worktrees: scriptedWorktrees() })
    const summary = await reconciler.reconcile()
    expect(summary.cleaned).toEqual([])
    expect(summary.pending).toEqual([])
  })

  test("#given a cleanup is recorded #when listing #then the pending entry is durable and clearable", async () => {
    const storage = memoryStorage()
    const reconciler = createTeamWorktreeReconciler({ storage, worktrees: scriptedWorktrees() })
    await reconciler.record({ teamName: "builders", members: [WORKTREE_MEMBER], reason: "shutdown-approved" })
    const pending = await reconciler.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ teamName: "builders", reason: "shutdown-approved" })
    await reconciler.clear({ teamName: "builders" })
    expect(await reconciler.listPending()).toHaveLength(0)
    expect(storage.map.has(`${CLEANUP_JOURNAL_PREFIX}builders`)).toBe(false)
  })

  test("#given a successful cleanup #when runPending finishes #then the journal entry is cleared", async () => {
    const storage = memoryStorage()
    const reconciler = createTeamWorktreeReconciler({ storage, worktrees: scriptedWorktrees([{ removed: ["/w/scout"], errors: [] }]) })
    await reconciler.record({ teamName: "builders", members: [WORKTREE_MEMBER], reason: "delete" })
    const result = await reconciler.runPending({ teamName: "builders", members: [WORKTREE_MEMBER] })
    expect(result.cleaned).toBe(true)
    expect(await reconciler.listPending()).toHaveLength(0)
  })

  test("#given a failed cleanup #when runPending finishes #then the entry stays pending with an attempt count", async () => {
    const storage = memoryStorage()
    const reconciler = createTeamWorktreeReconciler({ storage, worktrees: scriptedWorktrees([{ removed: [], errors: ["locked"] }]) })
    await reconciler.record({ teamName: "builders", members: [WORKTREE_MEMBER], reason: "delete" })
    const result = await reconciler.runPending({ teamName: "builders", members: [WORKTREE_MEMBER] })
    expect(result.cleaned).toBe(false)
    const [entry] = await reconciler.listPending()
    expect(entry.attempts).toBe(1)
    expect(entry.lastError).toContain("locked")
  })
})

describe("team worktree startup reconciliation", () => {
  test("#given a pending cleanup and a manager that fails once then recovers #when reconcile runs across a restart #then it retries until clean", async () => {
    // given: a journal entry persisted by a process that died mid-cleanup
    const storage = memoryStorage({ [`${CLEANUP_JOURNAL_PREFIX}builders`]: { teamName: "builders", members: [WORKTREE_MEMBER], reason: "shutdown-approved", attempts: 0 } })
    const worktrees = scriptedWorktrees([
      { removed: [], errors: ["process died"] },
      { removed: ["/w/scout"], errors: [] },
    ])
    // when: first boot (restart) cannot clean it yet
    const first = await createTeamWorktreeReconciler({ storage, worktrees }).reconcile()
    // then: still pending
    expect(first.pending).toEqual(["builders"])
    expect(await createTeamWorktreeReconciler({ storage, worktrees }).listPending()).toHaveLength(1)
    // when: next boot retries and succeeds
    const second = await createTeamWorktreeReconciler({ storage, worktrees }).reconcile()
    // then: cleaned and the journal entry is gone (zero residue)
    expect(second.cleaned).toEqual(["builders"])
    expect(await createTeamWorktreeReconciler({ storage, worktrees }).listPending()).toHaveLength(0)
  })

  test("#given a team left in binding after a crash #when reconcile runs #then its worktrees are cleaned and the failed record removed", async () => {
    const storage = memoryStorage({ [`${TEAM_PREFIX}half`]: { name: "half", status: "binding", members: [WORKTREE_MEMBER], messages: [], tasks: [] } })
    const reconciler = createTeamWorktreeReconciler({ storage, worktrees: scriptedWorktrees([{ removed: ["/w/scout"], errors: [] }]) })
    const summary = await reconciler.reconcile()
    expect(summary.cleaned).toEqual(["half"])
    expect(summary.removedTeams).toEqual(["half"])
    expect(storage.map.has(`${TEAM_PREFIX}half`)).toBe(false)
  })

  test("#given an orphaned team with worktrees #when reconcile runs #then the worktrees are reclaimed", async () => {
    const storage = memoryStorage({ [`${TEAM_PREFIX}lost`]: { name: "lost", status: "orphaned", members: [WORKTREE_MEMBER], messages: [], tasks: [] } })
    const worktrees = scriptedWorktrees([{ removed: ["/w/scout"], errors: [] }])
    const summary = await createTeamWorktreeReconciler({ storage, worktrees }).reconcile()
    expect(summary.cleaned).toEqual(["lost"])
    expect(worktrees.calls.cleanup).toBe(1)
  })

  test("#given an active team #when reconcile runs #then its worktrees and a stale journal entry are never swept", async () => {
    const storage = memoryStorage({
      [`${TEAM_PREFIX}live`]: { name: "live", status: "active", members: [WORKTREE_MEMBER], messages: [], tasks: [] },
      [`${CLEANUP_JOURNAL_PREFIX}live`]: { teamName: "live", members: [WORKTREE_MEMBER], reason: "stale", attempts: 0 },
    })
    const worktrees = scriptedWorktrees([{ removed: ["/w/scout"], errors: [] }])
    const summary = await createTeamWorktreeReconciler({ storage, worktrees }).reconcile()
    expect(worktrees.calls.cleanup).toBe(0)
    expect(summary.cleaned).toEqual([])
    expect(storage.map.has(`${CLEANUP_JOURNAL_PREFIX}live`)).toBe(false)
  })

  test("#given a crash-during-create orphan worktree #when reconcile runs #then worktrees no team references are swept", async () => {
    const storage = memoryStorage({ [`${TEAM_PREFIX}live`]: { name: "live", status: "active", members: [WORKTREE_MEMBER], messages: [], tasks: [] } })
    const swept = []
    const worktrees = { async cleanup() { return { removed: [], errors: [] } }, async sweepOrphans({ referenced }) { swept.push(referenced); return { removed: ["/w/orphan"], errors: [] } } }
    const summary = await createTeamWorktreeReconciler({ storage, worktrees }).reconcile()
    expect(summary.swept).toEqual(["/w/orphan"])
    expect(swept[0].has("/w/scout")).toBe(true)
    expect(swept[0].has("/w/orphan")).toBe(false)
  })

  test("#given a create in flight #when reconcile runs #then its live binding team is left untouched, and reclaimed once the guard is gone", async () => {
    // given: a binding team whose create is currently in flight
    const storage = memoryStorage({ [`${TEAM_PREFIX}live-create`]: { name: "live-create", status: "binding", members: [WORKTREE_MEMBER], messages: [], tasks: [] } })
    const worktrees = scriptedWorktrees([{ removed: ["/w/scout"], errors: [] }])
    const reconciler = createTeamWorktreeReconciler({ storage, worktrees })
    reconciler.beginCreate("live-create")
    // when
    const summary = await reconciler.reconcile()
    // then: untouched while in flight
    expect(worktrees.calls.cleanup).toBe(0)
    expect(summary.cleaned).toEqual([])
    expect(storage.map.has(`${TEAM_PREFIX}live-create`)).toBe(true)
    // when: the create ends (or its process dies and a fresh process reconciles)
    reconciler.endCreate("live-create")
    const after = await reconciler.reconcile()
    // then: the stale binding team is reclaimed and removed
    expect(after.cleaned).toEqual(["live-create"])
    expect(after.removedTeams).toEqual(["live-create"])
  })

  test("#given a binding team whose create is still fresh #when reconcile runs #then it waits, and reclaims it only once it is stale", async () => {
    const storage = memoryStorage({ [`${TEAM_PREFIX}f`]: { name: "f", status: "binding", bindingAt: 1_000, members: [WORKTREE_MEMBER], messages: [], tasks: [] } })
    let clock = 1_000
    const worktrees = scriptedWorktrees([{ removed: ["/w/scout"], errors: [] }])
    const reconciler = createTeamWorktreeReconciler({ storage, worktrees, now: () => clock, bindingStaleMs: 120_000 })
    const first = await reconciler.reconcile()
    expect(worktrees.calls.cleanup).toBe(0)
    expect(first.cleaned).toEqual([])
    clock = 200_000
    const second = await reconciler.reconcile()
    expect(second.cleaned).toEqual(["f"])
    expect(second.removedTeams).toEqual(["f"])
  })

  test("#given a fresh create-in-progress journal entry #when reconcile runs #then the orphan sweep protects that team directory", async () => {
    const storage = memoryStorage({ [`${CLEANUP_JOURNAL_PREFIX}newteam`]: { teamName: "newteam", members: [], reason: "create-in-progress", bindingAt: 5_000, attempts: 0 } })
    const seen = []
    const worktrees = {
      async cleanup() { return { removed: [], errors: [] } },
      async sweepOrphans({ protectedPrefixes }) { seen.push(protectedPrefixes); return { removed: [], errors: [] } },
      resolveTeamDirectory: (name) => `/repo/.omo/team-worktrees/${name}`,
    }
    await createTeamWorktreeReconciler({ storage, worktrees, now: () => 6_000, bindingStaleMs: 120_000 }).reconcile()
    expect(seen[0]).toEqual(["/repo/.omo/team-worktrees/newteam"])
  })
})

describe("team worktree cleanup journal named-RED mutations", () => {
  test("#given the real reconciler #when the durable record is skipped #then the journal-persistence contract turns RED and the source is restored", async () => {
    const target = copyReconcilerWithDeps(tempDir())
    const before = createHash("sha256").update(fs.readFileSync(target)).digest("hex")

    const receipt = await runMutation({
      file: target,
      mutate: (source) => source.replace("async function record({ teamName, members, reason, bindingAt }) {\n    if (typeof teamName", "async function record({ teamName, members, reason, bindingAt }) {\n    if (true) return\n    if (typeof teamName"),
      contract: {
        name: "a pending cleanup is journaled before any git work runs",
        run: async ({ load }) => {
          const module = await load()
          const storage = {
            map: new Map(),
            async get(k) { return this.map.get(k) },
            async set(k, v) { this.map.set(k, v) },
            async remove(k) { this.map.delete(k) },
            async scan({ prefix = "" } = {}) { return { entries: [...this.map.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ key: k, value: v })) } },
          }
          const reconciler = module.createTeamWorktreeReconciler({ storage, worktrees: { async cleanup() { return { removed: [], errors: [] } }, async sweepOrphans() { return { removed: [], errors: [] } } } })
          await reconciler.record({ teamName: "t", members: [{ name: "m", worktreePath: "/w" }] })
          const pending = await reconciler.listPending()
          if (pending.length !== 1) throw new Error("expected the pending cleanup to be journaled")
        },
      },
    })

    expect(receipt.red).toBe(true)
    expect(receipt.beforeHash).toBe(receipt.afterHash)
    expect(createHash("sha256").update(fs.readFileSync(target)).digest("hex")).toBe(before)
  })

  test("#given the real reconciler #when a failed cleanup is treated as success #then the retry contract turns RED and the source is restored", async () => {
    const target = copyReconcilerWithDeps(tempDir())

    const receipt = await runMutation({
      file: target,
      mutate: (source) => source.replace("if (report.errors.length === 0) {", "if (true) {"),
      contract: {
        name: "a failed cleanup stays pending for a later retry",
        run: async ({ load }) => {
          const module = await load()
          const storage = {
            map: new Map(),
            async get(k) { return this.map.get(k) },
            async set(k, v) { this.map.set(k, v) },
            async remove(k) { this.map.delete(k) },
            async scan({ prefix = "" } = {}) { return { entries: [...this.map.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ key: k, value: v })) } },
          }
          const reconciler = module.createTeamWorktreeReconciler({ storage, worktrees: { async cleanup() { return { removed: [], errors: ["locked"] } }, async sweepOrphans() { return { removed: [], errors: [] } } } })
          await reconciler.record({ teamName: "t", members: [{ name: "m", worktreePath: "/w" }] })
          await reconciler.runPending({ teamName: "t", members: [{ name: "m", worktreePath: "/w" }] })
          const pending = await reconciler.listPending()
          if (pending.length !== 1) throw new Error("expected the failed cleanup to stay pending")
        },
      },
    })

    expect(receipt.red).toBe(true)
    expect(receipt.beforeHash).toBe(receipt.afterHash)
  })
})

// Row 55 audit round 2, blocker 2: `team_delete` KEEPS a team record while an owned
// member session could not be terminated (and a create rollback keeps one too). That
// retry state is only useful if the startup sweep cannot reclaim it, so the status
// the team tools persist must stay outside both recovery sets. This guards the
// storage/architecture contract a later `team_delete` depends on.
describe("team worktree startup reconciliation: retained cleanup-failed retry state", () => {
  test("#given a team retained because an owned session could not be terminated #when reconcile runs #then the record and its retry state survive", async () => {
    // given: exactly the shape team_delete persists while sessionsFailed is non-empty
    const retained = {
      name: "stuck",
      projectKey: PK,
      status: "cleanup-failed",
      sessionsTerminated: [],
      cleanupPending: ["ses_scout"],
      cleanupErrors: [{ sessionID: "ses_scout", error: "no terminator installed" }],
      members: [{ name: "scout", sessionID: "ses_scout", owned: true, provenance: "spawned", status: "running" }],
    }
    const storage = memoryStorage({ [`${TEAM_PREFIX}stuck`]: retained })
    const worktrees = scriptedWorktrees()
    // when: a restart runs the startup sweep
    const summary = await createTeamWorktreeReconciler({ storage, worktrees }).reconcile()
    // then: reconcile neither reclaims nor alters the record, so a retry can still
    // finish. (Scope: the lead-orphan handler is a different writer and may flip the
    // status to `orphaned` - reconcilable but not removable - so no retry state is lost.)
    expect(summary.removedTeams).toEqual([])
    expect(summary.cleaned).toEqual([])
    expect(storage.map.get(`${TEAM_PREFIX}stuck`)).toEqual(retained)
  })

  test("#given a failed team with no worktrees #when reconcile runs #then it is reclaimed (control: the sweep really removes records)", async () => {
    // control: without this, the assertion above could pass because reconcile did nothing
    const storage = memoryStorage({ [`${TEAM_PREFIX}broken`]: { name: "broken", projectKey: PK, status: "failed", members: [] } })
    const summary = await createTeamWorktreeReconciler({ storage, worktrees: scriptedWorktrees() }).reconcile()
    expect(summary.removedTeams).toEqual(["broken"])
    expect(storage.map.has(`${TEAM_PREFIX}broken`)).toBe(false)
  })

// Round-2 review R4 (the crash window): a `binding` record can persist spawned
// `owned` session ids before the create finishes. If the process dies there, the
// startup sweep must NOT reclaim it - cleaning would delete the working directory
// of a session that is still alive, and removing the record would strand those
// persistent panes with no `team_delete` left to finish the teardown. Ownership is
// exactly what protects it: the same record WITHOUT an owned session is reclaimed.
describe("team worktree startup reconciliation: owned live sessions are never reclaimed", () => {
  const staleBinding = (members) => ({
    name: "crashed",
    projectKey: PK,
    status: "binding",
    bindingAt: 1, // long past the freshness window
    members,
  })

  test("#given a stale binding record that still owns a member session #when reconcile runs #then no worktree is cleaned and the record survives with retry state", async () => {
    // given: one owned, live member session (the crash window)
    const storage = memoryStorage({
      [`${TEAM_PREFIX}crashed`]: staleBinding([{ name: "scout", sessionID: "ses_scout", owned: true, provenance: "spawned", worktreePath: "/w/scout", worktreeBranch: "rigel-team/crashed/scout" }]),
    })
    const worktrees = scriptedWorktrees([{ removed: ["/w/scout"], errors: [] }])
    // when: a restart runs the startup sweep
    const summary = await createTeamWorktreeReconciler({ storage, worktrees }).reconcile()
    // then: no git cleanup ran on the live session's cwd, and the record kept its ids
    expect(worktrees.calls.cleanup).toBe(0)
    expect(summary.removedTeams).toEqual([])
    expect(summary.retained).toEqual(["crashed"])
    expect(storage.map.get(`${TEAM_PREFIX}crashed`)).toMatchObject({ status: "cleanup-failed", cleanupPending: ["ses_scout"], retainedBy: "reconcile:binding" })
  })

  test("#given the same stale binding with no owned session #when reconcile runs #then it is reclaimed (control: ownership is what protects it)", async () => {
    // control: without this the assertion above could pass because nothing was ever reclaimed
    const storage = memoryStorage({
      [`${TEAM_PREFIX}crashed`]: staleBinding([{ name: "scout", sessionID: "ses_scout", worktreePath: "/w/scout", worktreeBranch: "rigel-team/crashed/scout" }]),
    })
    const worktrees = scriptedWorktrees([{ removed: ["/w/scout"], errors: [] }])
    const summary = await createTeamWorktreeReconciler({ storage, worktrees }).reconcile()
    expect(worktrees.calls.cleanup).toBe(1)
    // NOTE: deliberately NO assertion on `summary.retained` here: a control must
    // hold on the pre-fix code too, otherwise it only proves the new summary key.
    expect(summary.removedTeams).toEqual(["crashed"])
    expect(storage.map.has(`${TEAM_PREFIX}crashed`)).toBe(false)
  })
})
})
