import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import {
  createMemberWorktrees,
  createTeamWorktreeManager,
  encodeNameSegment,
  memberWorktreeBranch,
  memberWorktreeDirectory,
  removeMemberWorktrees,
  scheduleMemberWorktreeRemoval,
} from "./rigel-v2-team-worktrees.mjs"
import { runMutation } from "./test-support/mutation-harness.mjs"

const temporary = []
afterEach(() => { while (temporary.length > 0) fs.rmSync(temporary.pop(), { recursive: true, force: true }) })

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-v2-team-worktrees-"))
  temporary.push(dir)
  return dir
}

const MODULE_SOURCE = fileURLToPath(new URL("./rigel-v2-team-worktrees.mjs", import.meta.url))
const SCOPE_SOURCE = fileURLToPath(new URL("./rigel-v2-team-project-scope.mjs", import.meta.url))

// The worktrees module imports the scope module; the mutation harness imports a
// copy, so the dependency must sit beside it.
function copyWorktreesWithDeps(dir) {
  const target = path.join(dir, "rigel-v2-team-worktrees.mjs")
  fs.copyFileSync(MODULE_SOURCE, target)
  fs.copyFileSync(SCOPE_SOURCE, path.join(dir, "rigel-v2-team-project-scope.mjs"))
  return target
}

// A git runner stub. `ok` answers the repo probe; every other call succeeds with
// empty output unless the test overrides `handler`.
function recordingRunner(handler) {
  const calls = []
  const runGit = async (args, options) => {
    calls.push({ args, options })
    if (handler) return handler(args, options)
    if (args.includes("--is-inside-work-tree")) return { code: 0, stdout: "true\n", stderr: "" }
    return { code: 0, stdout: "", stderr: "" }
  }
  return { calls, runGit }
}

const noRemoveDir = async () => {}

describe("Rigel native V2 team worktree naming", () => {
  test("#given special or Unicode names #when encoding #then the segment is Git-safe, injective and reversible", () => {
    expect(() => encodeNameSegment("")).toThrow("non-empty")
    expect(encodeNameSegment("scout 2")).toBe("scout%202")
    expect(encodeNameSegment("foo bar")).not.toBe(encodeNameSegment("foo-bar"))
    expect(encodeNameSegment("a@b")).not.toBe(encodeNameSegment("a:b"))
    expect(encodeNameSegment("caf\u00e9")).toBe("caf%C3%A9")
    expect(decodeURIComponent(encodeNameSegment("a/b:c d.\u00e9"))).toBe("a/b:c d.\u00e9")
  })

  test("#given colliding-looking member names #when resolving worktrees #then they never share a path or branch", () => {
    const base = { repoRoot: "/repo", teamName: "t" }
    expect(memberWorktreeDirectory({ ...base, memberName: "foo bar" })).not.toBe(memberWorktreeDirectory({ ...base, memberName: "foo-bar" }))
    expect(memberWorktreeBranch("t", "foo bar")).not.toBe(memberWorktreeBranch("t", "foo-bar"))
    expect(memberWorktreeBranch("foo bar", "m")).not.toBe(memberWorktreeBranch("foo-bar", "m"))
  })

  test("#given two members #when resolving their worktrees #then each gets a distinct directory and branch", () => {
    const base = { repoRoot: "/repo", teamName: "builders" }
    const first = memberWorktreeDirectory({ ...base, memberName: "scout" })
    const second = memberWorktreeDirectory({ ...base, memberName: "digger" })
    expect(first).not.toBe(second)
    expect(memberWorktreeBranch("builders", "scout")).not.toBe(memberWorktreeBranch("builders", "digger"))
    expect(first.startsWith(path.join("/repo", ".omo", "team-worktrees", "builders"))).toBe(true)
  })

  test("#given two different teams #when resolving a member worktree #then their bases differ (no cross-team sharing)", () => {
    const scout = (team) => memberWorktreeDirectory({ repoRoot: "/repo", teamName: team, memberName: "member" })
    expect(scout("alpha")).not.toBe(scout("beta"))
  })
})

describe("Rigel native V2 team worktree creation", () => {
  test("#given two members #when creating worktrees #then one exclusive worktree and branch is created per member", async () => {
    // given
    const { calls, runGit } = recordingRunner()
    // when
    const created = await createMemberWorktrees({ repoRoot: "/repo", teamName: "builders", members: [{ name: "scout" }, { name: "digger" }], runGit, removeDir: noRemoveDir })
    // then
    expect(created.map((entry) => entry.name)).toEqual(["scout", "digger"])
    expect(new Set(created.map((entry) => entry.worktreePath)).size).toBe(2)
    const adds = calls.filter((call) => call.args.includes("add"))
    expect(adds).toHaveLength(2)
    for (const call of adds) expect(call.args).toContain("-b")
    expect(created[0].worktreeBranch).toBe("rigel-team/builders/scout")
  })

  test("#given duplicate member names #when creating worktrees #then it throws before any git add (no shared worktree)", async () => {
    // given
    const { calls, runGit } = recordingRunner()
    // when / then
    await expect(createMemberWorktrees({ repoRoot: "/repo", teamName: "builders", members: [{ name: "dup" }, { name: "dup" }], runGit, removeDir: noRemoveDir })).rejects.toThrow("same worktree directory")
    expect(calls.some((call) => call.args.includes("add"))).toBe(false)
  })

  test("#given a git add failure on the second member #when creating worktrees #then the first is rolled back and the error propagates", async () => {
    // given
    let adds = 0
    const { calls, runGit } = recordingRunner((args) => {
      if (args.includes("--is-inside-work-tree")) return { code: 0, stdout: "true\n", stderr: "" }
      if (args.includes("add")) {
        adds += 1
        return adds === 1 ? { code: 0, stdout: "", stderr: "" } : { code: 128, stdout: "", stderr: "boom" }
      }
      return { code: 0, stdout: "", stderr: "" }
    })
    // when / then
    await expect(createMemberWorktrees({ repoRoot: "/repo", teamName: "builders", members: [{ name: "scout" }, { name: "digger" }], runGit, removeDir: noRemoveDir })).rejects.toThrow("boom")
    expect(calls.some((call) => call.args.includes("remove"))).toBe(true)
  })

  test("#given a directory that is not a git repository #when creating worktrees #then it throws loudly", async () => {
    const { runGit } = recordingRunner(() => ({ code: 128, stdout: "", stderr: "not a repo" }))
    await expect(createMemberWorktrees({ repoRoot: "/tmp/x", teamName: "t", members: [{ name: "a" }], runGit, removeDir: noRemoveDir })).rejects.toThrow("require a git repository")
  })
})

describe("Rigel native V2 team worktree cleanup", () => {
  test("#given a member worktree #when removing #then the worktree and its branch are removed and pruned", async () => {
    // given
    const { calls, runGit } = recordingRunner()
    // when
    const report = await removeMemberWorktrees({ repoRoot: "/repo", members: [{ name: "scout", worktreePath: "/repo/.omo/team-worktrees/b/scout", worktreeBranch: "rigel-team/b/scout" }], runGit, removeDir: noRemoveDir })
    // then
    expect(report.errors).toEqual([])
    expect(report.removed).toHaveLength(1)
    const flat = calls.map((call) => call.args.join(" "))
    expect(flat.some((line) => line.includes("worktree remove --force"))).toBe(true)
    expect(flat.some((line) => line.includes("branch -D rigel-team/b/scout"))).toBe(true)
    expect(flat.some((line) => line.includes("worktree prune"))).toBe(true)
  })

  test("#given the per-team directory is empty after cleanup #when removing #then the empty directory is reclaimed", async () => {
    // given
    const emptied = []
    const { runGit } = recordingRunner()
    // when
    await removeMemberWorktrees({ repoRoot: "/repo", members: [{ name: "scout", worktreePath: "/repo/.omo/team-worktrees/b/scout", worktreeBranch: "rigel-team/b/scout" }], runGit, removeDir: noRemoveDir, removeEmptyDir: async (target) => { emptied.push(target) } })
    // then
    expect(emptied).toEqual(["/repo/.omo/team-worktrees/b"])
  })

  test("#given a worktree with residue #when removing #then git forgets the worktree before the residue and the branch", async () => {
    const order = []
    const { runGit } = recordingRunner((args) => {
      if (args.includes("remove")) order.push("worktree-remove")
      else if (args.includes("branch")) order.push("branch-delete")
      return { code: 0, stdout: "", stderr: "" }
    })
    await removeMemberWorktrees({ repoRoot: "/repo", members: [{ name: "s", worktreePath: "/x", worktreeBranch: "rigel-team/t/s" }], runGit, removeDir: async () => { order.push("rm-residue") }, removeEmptyDir: async () => {} })
    expect(order).toEqual(["worktree-remove", "rm-residue", "branch-delete"])
  })

  test("#given a worktree git cannot yet forget #when removing #then the branch is NOT deleted before git releases it (a retry can still clean)", async () => {
    const calls = []
    const { runGit } = recordingRunner((args) => {
      calls.push(args.join(" "))
      if (args.includes("remove")) return { code: 128, stdout: "", stderr: "worktree busy" }
      return { code: 0, stdout: "", stderr: "" }
    })
    const report = await removeMemberWorktrees({ repoRoot: "/repo", members: [{ name: "s", worktreePath: "/x", worktreeBranch: "rigel-team/t/s" }], runGit, removeDir: noRemoveDir, removeEmptyDir: async () => {}, maxRetries: 0 })
    expect(report.errors).toHaveLength(1)
    expect(calls.some((line) => line.includes("branch -D"))).toBe(false)
  })

  test("#given an already-removed worktree #when removing #then the tolerated git error does not become a failure", async () => {
    const { runGit } = recordingRunner((args) => {
      if (args.includes("remove")) return { code: 128, stdout: "", stderr: "fatal: '/x' is not a working tree" }
      return { code: 0, stdout: "", stderr: "" }
    })
    const report = await removeMemberWorktrees({ repoRoot: "/repo", members: [{ name: "scout", worktreePath: "/x", worktreeBranch: "rigel-team/b/scout" }], runGit, removeDir: noRemoveDir })
    expect(report.errors).toEqual([])
    expect(report.removed).toHaveLength(1)
  })

  test("#given a transient removal failure #when removing #then it retries and succeeds", async () => {
    // given
    let removeAttempts = 0
    const waits = []
    const { runGit } = recordingRunner((args) => {
      if (args.includes("remove")) {
        removeAttempts += 1
        return removeAttempts === 1 ? { code: 128, stdout: "", stderr: "index.lock busy" } : { code: 0, stdout: "", stderr: "" }
      }
      return { code: 0, stdout: "", stderr: "" }
    })
    // when
    const report = await removeMemberWorktrees({ repoRoot: "/repo", members: [{ name: "scout", worktreePath: "/x", worktreeBranch: "rigel-team/b/scout" }], runGit, removeDir: noRemoveDir, maxRetries: 2, wait: async (attempt) => { waits.push(attempt) } })
    // then
    expect(removeAttempts).toBe(2)
    expect(waits).toEqual([1])
    expect(report.errors).toEqual([])
    expect(report.removed).toHaveLength(1)
  })

  test("#given a persistent removal failure #when removing #then the retry budget is exhausted and the error is reported (not thrown)", async () => {
    const { runGit } = recordingRunner((args) => (args.includes("remove") ? { code: 128, stdout: "", stderr: "locked forever" } : { code: 0, stdout: "", stderr: "" }))
    const report = await removeMemberWorktrees({ repoRoot: "/repo", members: [{ name: "scout", worktreePath: "/x", worktreeBranch: "rigel-team/b/scout" }], runGit, removeDir: noRemoveDir, maxRetries: 2, wait: async () => {} })
    expect(report.removed).toEqual([])
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0]).toContain("locked forever")
  })

  test("#given cleanup that always fails #when scheduled #then the promise resolves and never rejects (shutdown never blocks)", async () => {
    const logs = []
    const runGit = async () => { throw new Error("git exploded") }
    const report = await scheduleMemberWorktreeRemoval({ repoRoot: "/repo", members: [{ name: "scout", worktreePath: "/x", worktreeBranch: "rigel-team/b/scout" }], runGit, removeDir: noRemoveDir, log: (line) => logs.push(line) })
    expect(report.errors).toHaveLength(1)
    expect(logs).toHaveLength(1)
  })
})

describe("Rigel native V2 team worktree manager", () => {
  test("#given members with sessions #when binding #then each session is moved into its worktree", async () => {
    // given
    const bound = []
    const { runGit } = recordingRunner()
    const manager = createTeamWorktreeManager({ repoRoot: "/repo", runGit, removeDir: noRemoveDir, bindSession: async ({ sessionID, directory }) => { bound.push({ sessionID, directory }) } })
    // when
    await manager.bindSessions({ members: [{ name: "scout", sessionID: "ses_1", worktreePath: "/w/scout" }, { name: "digger", sessionID: "ses_2", worktreePath: "/w/digger" }] })
    // then
    expect(bound).toEqual([{ sessionID: "ses_1", directory: "/w/scout" }, { sessionID: "ses_2", directory: "/w/digger" }])
  })

  test("#given a failing session bind #when binding #then it throws (strict) and the other members are still attempted", async () => {
    const logs = []
    const bound = []
    const { runGit } = recordingRunner()
    const manager = createTeamWorktreeManager({
      repoRoot: "/repo",
      runGit,
      removeDir: noRemoveDir,
      log: (line) => logs.push(line),
      bindSession: async ({ sessionID }) => {
        if (sessionID === "ses_bad") throw new Error("move failed")
        bound.push(sessionID)
      },
    })
    await expect(manager.bindSessions({ members: [{ name: "bad", sessionID: "ses_bad", worktreePath: "/w/bad" }, { name: "good", sessionID: "ses_good", worktreePath: "/w/good" }] })).rejects.toThrow("bind failed")
    expect(bound).toEqual(["ses_good"])
    expect(logs.some((line) => line.includes("bind failed") && line.includes("bad"))).toBe(true)
  })

  test("#given a host that cannot move a session #when binding a member #then the bind fails loudly instead of leaving the member in the shared tree", async () => {
    // given: a manager built without the session-move seam (a host that cannot bind)
    const { runGit } = recordingRunner()
    const manager = createTeamWorktreeManager({ repoRoot: "/repo", runGit, removeDir: noRemoveDir, removeEmptyDir: async () => {} })
    // when / then: a member whose first turn would run in the shared tree must NOT be
    // reported as bound, so the create fails instead of pretending the team is isolated
    await expect(manager.bindSessions({ members: [{ name: "scout", sessionID: "ses_1", worktreePath: "/w/scout" }] })).rejects.toThrow("cannot bind a member session")
    // and: the per-session bind the team tool uses before the first prompt refuses too
    await expect(manager.bindSession({ sessionID: "ses_1", directory: "/w/scout" })).rejects.toThrow("cannot bind a member session")
  })

  test("#given an orphan rigel-team worktree #when sweeping with the live paths referenced #then only the unreferenced worktree is removed", async () => {
    const removed = []
    const { runGit } = recordingRunner((args) => {
      if (args[2] === "worktree" && args[3] === "list") {
        return { code: 0, stdout: "worktree /repo/.omo/team-worktrees/t/a\nbranch refs/heads/rigel-team/t/a\n\nworktree /repo/.omo/team-worktrees/t/b\nbranch refs/heads/rigel-team/t/b\n\nworktree /repo\nbranch refs/heads/main\n", stderr: "" }
      }
      if (args.includes("remove")) removed.push(args[args.length - 1])
      return { code: 0, stdout: "", stderr: "" }
    })
    const manager = createTeamWorktreeManager({ repoRoot: "/repo", runGit, removeDir: noRemoveDir, removeEmptyDir: async () => {} })
    const result = await manager.sweepOrphans({ referenced: new Set(["/repo/.omo/team-worktrees/t/a"]) })
    expect(result.removed).toEqual(["/repo/.omo/team-worktrees/t/b"])
    expect(removed).toEqual(["/repo/.omo/team-worktrees/t/b"])
  })

  test("#given a manager built without an explicit removeDir #when sweeping an orphan #then the branch is still deleted and the empty team dir reclaimed", async () => {
    const calls = []
    const emptied = []
    const runGit = async (args) => {
      calls.push(args.join(" "))
      if (args[2] === "worktree" && args[3] === "list") return { code: 0, stdout: "worktree /repo/.omo/team-worktrees/o/x\nbranch refs/heads/rigel-team/o/x\n", stderr: "" }
      return { code: 0, stdout: "", stderr: "" }
    }
    const manager = createTeamWorktreeManager({ repoRoot: "/repo", runGit, removeEmptyDir: async (target) => { emptied.push(target) } })
    const result = await manager.sweepOrphans({ referenced: new Set() })
    expect(result.errors).toEqual([])
    expect(result.removed).toEqual(["/repo/.omo/team-worktrees/o/x"])
    expect(calls.some((line) => line.includes("branch -D rigel-team/o/x"))).toBe(true)
    expect(emptied).toEqual(["/repo/.omo/team-worktrees/o"])
  })

  test("#given a live create in flight #when sweeping #then worktrees under its team directory are protected and only the orphan is removed", async () => {
    const runGit = async (args) => {
      if (args[2] === "worktree" && args[3] === "list") return { code: 0, stdout: "worktree /repo/.omo/team-worktrees/live/a\nbranch refs/heads/rigel-team/live/a\n\nworktree /repo/.omo/team-worktrees/orphan/b\nbranch refs/heads/rigel-team/orphan/b\n", stderr: "" }
      return { code: 0, stdout: "", stderr: "" }
    }
    const manager = createTeamWorktreeManager({ repoRoot: "/repo", runGit, removeDir: noRemoveDir, removeEmptyDir: async () => {} })
    const result = await manager.sweepOrphans({ referenced: new Set(), protectedPrefixes: ["/repo/.omo/team-worktrees/live"] })
    expect(result.removed).toEqual(["/repo/.omo/team-worktrees/orphan/b"])
  })

  test("#given a manager without repoRoot #when constructed #then it fails loudly", () => {
    expect(() => createTeamWorktreeManager({ runGit: async () => ({ code: 0, stdout: "", stderr: "" }) })).toThrow("requires repoRoot")
  })
})

describe("Rigel native V2 team worktree named-RED mutations", () => {
  test("#given the real module #when the duplicate-directory guard is removed #then the exclusivity contract turns RED and the source is restored byte-identically", async () => {
    const target = copyWorktreesWithDeps(tempDir())
    const sourceHash = createHash("sha256").update(fs.readFileSync(target)).digest("hex")

    const receipt = await runMutation({
      file: target,
      mutate: (source) => source.replace("if (seen.has(entry.directory)) throw new Error(", "if (false) throw new Error("),
      contract: {
        name: "two members never share a worktree directory",
        run: async ({ load }) => {
          const module = await load()
          const runGit = async (args) => (args.includes("--is-inside-work-tree") ? { code: 0, stdout: "true\n", stderr: "" } : { code: 0, stdout: "", stderr: "" })
          let threw = false
          try {
            await module.createMemberWorktrees({ repoRoot: "/repo", teamName: "t", members: [{ name: "dup" }, { name: "dup" }], runGit, removeDir: async () => {} })
          } catch {
            threw = true
          }
          if (!threw) throw new Error("expected duplicate members to be rejected before any worktree is shared")
        },
      },
    })

    expect(receipt.red).toBe(true)
    expect(receipt.beforeHash).toBe(receipt.afterHash)
    const restoredHash = createHash("sha256").update(fs.readFileSync(target)).digest("hex")
    expect(restoredHash).toBe(sourceHash)
    expect(createHash("sha256").update(fs.readFileSync(MODULE_SOURCE)).digest("hex")).toBe(sourceHash)
  })

  test("#given the real module #when branch deletion is skipped #then the branch-cleanup contract turns RED and the source is restored", async () => {
    const target = copyWorktreesWithDeps(tempDir())

    const receipt = await runMutation({
      file: target,
      mutate: (source) => source.replace('const deleted = await runGit(["-C", repoRoot, "branch", "-D", branch])', 'const deleted = { code: 0, stdout: "", stderr: "" }'),
      contract: {
        name: "cleanup deletes the member branch",
        run: async ({ load }) => {
          const module = await load()
          const calls = []
          const runGit = async (args) => { calls.push(args.join(" ")); return { code: 0, stdout: "", stderr: "" } }
          await module.removeMemberWorktrees({ repoRoot: "/repo", members: [{ name: "s", worktreePath: "/x", worktreeBranch: "rigel-team/t/s" }], runGit, removeDir: async () => {} })
          if (!calls.some((line) => line.includes("branch -D rigel-team/t/s"))) throw new Error("expected the member branch to be deleted")
        },
      },
    })

    expect(receipt.red).toBe(true)
    expect(receipt.beforeHash).toBe(receipt.afterHash)
  })

  test("#given the real module #when the retry budget is disabled #then the retry contract turns RED and the source is restored", async () => {
    const target = copyWorktreesWithDeps(tempDir())

    const receipt = await runMutation({
      file: target,
      mutate: (source) => source.replace("if (attempt > maxRetries) {", "if (attempt > 0) {"),
      contract: {
        name: "a transient removal failure is retried",
        run: async ({ load }) => {
          const module = await load()
          let attempts = 0
          const runGit = async (args) => {
            if (args.includes("remove")) {
              attempts += 1
              return attempts === 1 ? { code: 128, stdout: "", stderr: "busy" } : { code: 0, stdout: "", stderr: "" }
            }
            return { code: 0, stdout: "", stderr: "" }
          }
          const report = await module.removeMemberWorktrees({ repoRoot: "/repo", members: [{ name: "s", worktreePath: "/x" }], runGit, removeDir: async () => {}, maxRetries: 2, wait: async () => {} })
          if (report.errors.length !== 0 || report.removed.length !== 1) throw new Error(`expected a retried success, got ${JSON.stringify(report)}`)
        },
      },
    })

    expect(receipt.red).toBe(true)
    expect(receipt.beforeHash).toBe(receipt.afterHash)
  })

  test("#given the real module #when the default residue remover is dropped #then the orphan-sweep contract turns RED and the source is restored", async () => {
    const target = copyWorktreesWithDeps(tempDir())

    const receipt = await runMutation({
      file: target,
      mutate: (source) => source.replace("removeDir: removeDir ?? ((target) => rm(target, { recursive: true, force: true })),", "removeDir,"),
      contract: {
        name: "an orphan sweep deletes the branch even when no explicit remover is injected",
        run: async ({ load }) => {
          const module = await load()
          const calls = []
          const runGit = async (args) => {
            calls.push(args.join(" "))
            if (args[2] === "worktree" && args[3] === "list") return { code: 0, stdout: "worktree /repo/.omo/team-worktrees/o/x\nbranch refs/heads/rigel-team/o/x\n", stderr: "" }
            return { code: 0, stdout: "", stderr: "" }
          }
          const manager = module.createTeamWorktreeManager({ repoRoot: "/repo", runGit, removeEmptyDir: async () => {} })
          await manager.sweepOrphans({ referenced: new Set() })
          if (!calls.some((line) => line.includes("branch -D rigel-team/o/x"))) throw new Error("expected the orphan branch to be deleted")
        },
      },
    })

    expect(receipt.red).toBe(true)
    expect(receipt.beforeHash).toBe(receipt.afterHash)
  })
})
