/**
 * Per-member git worktrees for the native V2 team model.
 *
 * V1 owners ported (observable effects, not text):
 * - `packages/team-core/src/team-worktree/manager.ts`
 *     `createWorktree` runs `git worktree add` and `validateWorktreeSpec` guards
 *     the path; `isGitAvailable` gates the whole family.
 * - `packages/team-core/src/team-worktree/cleanup.ts`
 *     `removeWorktree` removes the directory + worktree, tolerates the
 *     "not a working tree" / "already removed" stderr, then prunes.
 * - `packages/omo-opencode/src/features/team-mode/team-runtime/create.ts`
 *     every member with a worktree path gets one; the member session runs with
 *     cwd = that path and the path is persisted in the team runtime state.
 * - `packages/omo-opencode/src/features/team-mode/team-runtime/delete-team.ts`
 *     `removeWorktrees` cleans every member worktree.
 *
 * V2 strategy chosen by the approved plan: run git through an injectable
 * runner. This gives the exact V1 parity of a per-member path AND a per-member
 * branch that cleanup can delete; `ctx.worktree` owns its own destination and
 * strategy and exposes no branch deletion, so it cannot express the exclusive
 * per-member branch the V1 effect requires.
 *
 * The module is pure: no host import, no global state, an injectable git runner
 * and an injectable wait, so both the retry path and the no-block cleanup path
 * are testable without a repository or timers.
 */

import { execFile } from "node:child_process"
import { rm, rmdir } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { encodeNameSegment } from "./rigel-v2-team-project-scope.mjs"

const execFileAsync = promisify(execFile)

export const TEAM_WORKTREE_BRANCH_PREFIX = "rigel-team/"
export const TEAM_WORKTREE_DIR_SEGMENT = path.join(".omo", "team-worktrees")
export const DEFAULT_REMOVE_RETRIES = 3

// Cleanup classifies git stderr, so it must not depend on host locale; V1 pinned
// LC_ALL=C for exactly this reason (team-core/team-worktree/cleanup.ts).
const GIT_ENV = { ...process.env, LC_ALL: "C" }

// Worktree directories and branch segments use the same reversible,
// collision-resistant name encoding as the storage keys, so two distinct team
// or member names never share a path or branch.
export { encodeNameSegment }

export function memberWorktreeBranch(teamName, memberName, prefix = TEAM_WORKTREE_BRANCH_PREFIX) {
  return `${prefix}${encodeNameSegment(teamName, "team name")}/${encodeNameSegment(memberName, "member name")}`
}

export function memberWorktreeDirectory({ repoRoot, teamName, memberName, baseDir }) {
  const root = baseDir ? path.resolve(baseDir) : path.join(repoRoot, TEAM_WORKTREE_DIR_SEGMENT)
  return path.join(root, encodeNameSegment(teamName, "team name"), encodeNameSegment(memberName, "member name"))
}

/**
 * Map a per-member worktree directory back to the repo root that owns the team.
 *
 * A member session whose directory is its own worktree resolves a DIFFERENT git
 * top level, so without this it would get a different project key: its panes
 * would fail caller-pane discovery AND its own `team_task_*`/`team_send_message`
 * calls would look in a namespace where its team does not exist.
 *
 * Lexical and pure on purpose (no git, no fs): it must be safe to call on every
 * `session.created` and inside scope resolution. Anything that is not under the
 * standard `<root>/.omo/team-worktrees/` segment is returned as `undefined`, so
 * the caller keeps its existing directory unchanged (this is why a team worktree
 * created with a custom `baseDir` stays pane-less: it cannot be mapped back).
 */
export function mapTeamWorktreeToRepoRoot(directory, { realpath = (value) => value } = {}) {
  if (typeof directory !== "string" || !directory) return undefined
  let normalized
  try { normalized = realpath(directory) } catch { normalized = directory }
  const marker = `${path.sep}${TEAM_WORKTREE_DIR_SEGMENT}${path.sep}`
  const index = normalized.lastIndexOf(marker)
  return index > 0 ? normalized.slice(0, index) : undefined
}

export function createGitWorktreeRunner({ exec = execFileAsync, env = GIT_ENV } = {}) {
  return async function runGit(args, options = {}) {
    try {
      const result = await exec("git", args, { cwd: options.cwd, env, maxBuffer: 8 * 1024 * 1024 })
      return {
        code: 0,
        stdout: typeof result?.stdout === "string" ? result.stdout : "",
        stderr: typeof result?.stderr === "string" ? result.stderr : "",
      }
    } catch (error) {
      return {
        code: typeof error?.code === "number" ? error.code : 1,
        stdout: typeof error?.stdout === "string" ? error.stdout : "",
        stderr: typeof error?.stderr === "string" ? error.stderr : String(error?.message ?? error),
      }
    }
  }
}

async function ensureGitRepository(repoRoot, runGit) {
  const result = await runGit(["-C", repoRoot, "rev-parse", "--is-inside-work-tree"])
  if (result.code !== 0 || result.stdout.trim() !== "true") {
    throw new Error(
      `team worktrees require a git repository at ${repoRoot}, so the team was NOT created. ` +
        `Do not switch the worktree policy on your own: worktree: false is a different policy, and choosing it is the user's decision, not yours. ` +
        `Report this failure and ask the user to confirm explicitly; create the team again only after they confirm.`,
    )
  }
}

/**
 * Parse `git worktree list --porcelain` into `{ directory, branch }` entries.
 * Only the fields this module needs are extracted; a bare worktree has no branch
 * line.
 */
export function parseWorktreeList(stdout) {
  const entries = []
  let current
  for (const line of String(stdout ?? "").split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current)
      current = { directory: line.slice("worktree ".length).trim(), branch: undefined }
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "")
    }
  }
  if (current) entries.push(current)
  return entries
}

/**
 * Safe removal order: `git worktree remove` FIRST (so git releases the
 * registration and the branch is never left locked), then the directory residue,
 * then the branch. Deleting the directory before git forgets the worktree leaves
 * a locked administrative entry and blocks the branch delete.
 */
async function removeOne(repoRoot, runGit, removeDir, directory, branch) {
  if (directory) {
    const removed = await runGit(["-C", repoRoot, "worktree", "remove", "--force", directory])
    if (removed.code !== 0 && !isToleratedRemoval(removed.stderr)) {
      return removed.stderr.trim() || "git worktree remove failed"
    }
    await removeDir(directory).catch(() => {})
  }
  if (branch) {
    const deleted = await runGit(["-C", repoRoot, "branch", "-D", branch])
    if (deleted.code !== 0 && !isToleratedBranchDelete(deleted.stderr)) {
      return deleted.stderr.trim() || "git branch -D failed"
    }
  }
  return undefined
}

const TOLERATED_REMOVAL = ["not a working tree", "not a worktree", "already removed", "no such file", "does not exist", "not registered"]
const TOLERATED_BRANCH = ["not found", "no such branch", "did not match any"]

function includesAny(haystack, needles) {
  const text = haystack.toLowerCase()
  return needles.some((needle) => text.includes(needle))
}

function isToleratedRemoval(stderr) {
  return includesAny(String(stderr ?? ""), TOLERATED_REMOVAL)
}

function isToleratedBranchDelete(stderr) {
  return includesAny(String(stderr ?? ""), TOLERATED_BRANCH)
}

async function rollbackCreated(repoRoot, runGit, removeDir, created, log) {
  for (const entry of [...created].reverse()) {
    const failure = await removeOne(repoRoot, runGit, removeDir, entry.worktreePath, entry.worktreeBranch)
    if (failure) log(`[oh-my-rigel] team worktree rollback failed for ${entry.name}: ${failure}`)
  }
  await runGit(["-C", repoRoot, "worktree", "prune"])
}

/**
 * Create one exclusive worktree per member. Two members that resolve to the
 * same directory (duplicate or colliding names) throw before any git command,
 * so a shared worktree can never be created.
 */
export async function createMemberWorktrees({
  repoRoot,
  teamName,
  members = [],
  baseDir,
  runGit,
  removeDir = (target) => rm(target, { recursive: true, force: true }),
  from,
  log = () => {},
} = {}) {
  if (!repoRoot) throw new Error("repoRoot is required to create team worktrees")
  if (typeof runGit !== "function") throw new Error("a git runner is required to create team worktrees")

  // Plan every directory first and reject a collision BEFORE any git call, so a
  // duplicate member can never create (and then roll back) a spurious worktree.
  const planned = members.map((member) => {
    const name = typeof member?.name === "string" ? member.name.trim() : ""
    if (!name) throw new Error("each team member needs a name before a worktree is created")
    return { name, directory: memberWorktreeDirectory({ repoRoot, teamName, memberName: name, baseDir }), branch: memberWorktreeBranch(teamName, name) }
  })
  const seen = new Set()
  for (const entry of planned) {
    if (seen.has(entry.directory)) throw new Error(`two team members resolved to the same worktree directory: ${entry.directory}`)
    seen.add(entry.directory)
  }

  await ensureGitRepository(repoRoot, runGit)

  const created = []
  try {
    for (const entry of planned) {
      const args = ["-C", repoRoot, "worktree", "add", "-b", entry.branch, entry.directory, ...(from ? [from] : [])]
      const result = await runGit(args)
      if (result.code !== 0) throw new Error(result.stderr.trim() || `git worktree add failed for ${entry.name}`)
      created.push({ name: entry.name, worktreePath: entry.directory, worktreeBranch: entry.branch })
      log(`[oh-my-rigel] team worktree created: team=${teamName}; member=${entry.name}; path=${entry.directory}; branch=${entry.branch}`)
    }
    return created
  } catch (error) {
    await rollbackCreated(repoRoot, runGit, removeDir, created, log)
    throw error
  }
}

/**
 * Remove every member worktree, its branch and prune. A failing step is retried
 * up to `maxRetries` with the injected `wait`; after the budget it is reported
 * in `errors` instead of throwing, so cleanup can never crash shutdown.
 */
export async function removeMemberWorktrees({
  repoRoot,
  members = [],
  runGit,
  removeDir = (target) => rm(target, { recursive: true, force: true }),
  removeEmptyDir = (target) => rmdir(target),
  maxRetries = DEFAULT_REMOVE_RETRIES,
  wait = async () => {},
  log = () => {},
} = {}) {
  const removed = []
  const errors = []
  if (!repoRoot) return { removed, errors: ["repoRoot is required to remove team worktrees"] }
  if (typeof runGit !== "function") return { removed, errors: ["a git runner is required to remove team worktrees"] }

  for (const member of members) {
    const directory = typeof member?.worktreePath === "string" ? member.worktreePath : undefined
    const branch = typeof member?.worktreeBranch === "string" ? member.worktreeBranch : undefined
    if (!directory && !branch) continue
    let attempt = 0
    for (;;) {
      attempt += 1
      const failure = await removeOne(repoRoot, runGit, removeDir, directory, branch)
      if (!failure) {
        removed.push(directory ?? branch)
        log(`[oh-my-rigel] team worktree removed: member=${member?.name ?? "?"}; path=${directory ?? "-"}; branch=${branch ?? "-"}`)
        break
      }
      if (attempt > maxRetries) {
        errors.push(`member=${member?.name ?? "?"}: ${failure}`)
        log(`[oh-my-rigel] team worktree removal exhausted retries for member=${member?.name ?? "?"}: ${failure}`)
        break
      }
      await wait(attempt)
    }
  }
  await runGit(["-C", repoRoot, "worktree", "prune"])
  // Remove the now-empty per-team directory so no residue survives cleanup. A
  // non-empty directory (another team, an error) is left untouched because
  // rmdir fails on it and the failure is ignored.
  const parents = new Set(members.map((member) => (typeof member?.worktreePath === "string" ? path.dirname(member.worktreePath) : undefined)).filter(Boolean))
  for (const parent of parents) await removeEmptyDir(parent).catch(() => {})
  return { removed, errors }
}

/**
 * Fire-and-forget cleanup for the shutdown/orphan paths: returns a promise the
 * caller MAY ignore; it is fully caught so it never surfaces as an unhandled
 * rejection and never blocks the caller.
 */
export function scheduleMemberWorktreeRemoval(input) {
  return removeMemberWorktrees(input)
    .then((report) => {
      if (report.errors.length > 0) {
        input?.log?.(`[oh-my-rigel] team worktree cleanup finished with errors: ${report.errors.join("; ")}`)
      }
      return report
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      input?.log?.(`[oh-my-rigel] team worktree cleanup failed: ${message}`)
      return { removed: [], errors: [message] }
    })
}

/**
 * Manager injected into `tools/team.tools.mjs` and the team event handlers.
 * `bindSessions` moves each member session into its worktree (V2
 * `session.move({directory})`), which is the native equivalent of V1 launching
 * the member with `cwd: worktreePath`.
 */
export function createTeamWorktreeManager({ repoRoot, baseDir, runGit, removeDir, removeEmptyDir, wait, log = () => {}, maxRetries, bindSession, branchPrefix = TEAM_WORKTREE_BRANCH_PREFIX } = {}) {
  if (!repoRoot || typeof runGit !== "function") {
    throw new Error("team worktree manager requires repoRoot and a git runner")
  }
  const common = {
    repoRoot,
    baseDir,
    runGit,
    removeDir: removeDir ?? ((target) => rm(target, { recursive: true, force: true })),
    removeEmptyDir: removeEmptyDir ?? ((target) => rmdir(target)),
    wait,
    maxRetries,
    log,
  }

  async function listTeamWorktrees() {
    const result = await runGit(["-C", repoRoot, "worktree", "list", "--porcelain"])
    if (result.code !== 0) return []
    return parseWorktreeList(result.stdout).filter((entry) => typeof entry.branch === "string" && entry.branch.startsWith(branchPrefix))
  }

  function resolveTeamDirectory(teamName) {
    return baseDir
      ? path.join(path.resolve(baseDir), encodeNameSegment(teamName, "team name"))
      : path.join(repoRoot, TEAM_WORKTREE_DIR_SEGMENT, encodeNameSegment(teamName, "team name"))
  }

  /**
   * Remove every `rigel-team/*` worktree whose directory is not in `referenced`
   * and not under a `protectedPrefixes` directory (a live create in progress).
   */
  async function sweepOrphans({ referenced = new Set(), protectedPrefixes = [] } = {}) {
    const removed = []
    const errors = []
    for (const entry of await listTeamWorktrees()) {
      if (referenced.has(entry.directory)) continue
      if (protectedPrefixes.some((prefix) => entry.directory === prefix || entry.directory.startsWith(`${prefix}${path.sep}`))) continue
      const failure = await removeOne(repoRoot, runGit, common.removeDir, entry.directory, entry.branch)
      if (failure) {
        errors.push(`${entry.directory}: ${failure}`)
      } else {
        removed.push(entry.directory)
        await common.removeEmptyDir(path.dirname(entry.directory)).catch(() => {})
        log(`[oh-my-rigel] team worktree orphan swept: path=${entry.directory}; branch=${entry.branch ?? "-"}`)
      }
    }
    await runGit(["-C", repoRoot, "worktree", "prune"])
    return { removed, errors }
  }

  // A member session is bound into its worktree BEFORE its first prompt, so a host
  // that cannot move a session must fail loudly here: a member that silently stayed
  // in the shared tree would run that whole turn in the wrong directory while the
  // team claims it is isolated.
  async function bindOne({ sessionID, directory }) {
    if (typeof bindSession !== "function") {
      throw new Error("team worktree manager cannot bind a member session into its worktree: this host exposes no session move")
    }
    await bindSession({ sessionID, directory })
  }

  return {
    async provision({ teamName, members }) {
      if (typeof teamName !== "string" || !teamName.trim()) throw new Error("team worktree manager needs a team name")
      return await createMemberWorktrees({ ...common, teamName, members })
    },
    async cleanup({ members }) {
      return await removeMemberWorktrees({ ...common, members: members ?? [] })
    },
    cleanupNonBlocking({ members }) {
      return scheduleMemberWorktreeRemoval({ ...common, members: members ?? [] })
    },
    listTeamWorktrees,
    resolveTeamDirectory,
    sweepOrphans,
    /**
     * Bind ONE member session into its worktree, before that member's first prompt.
     */
    async bindSession({ sessionID, directory }) {
      await bindOne({ sessionID, directory })
    },
    /**
     * STRICT: moves every member session into its worktree; if any bind fails it
     * throws after attempting all members, so the caller can roll the team create
     * back instead of persisting a team whose sessions are not bound.
     */
    async bindSessions({ members }) {
      const failures = []
      for (const member of members ?? []) {
        const sessionID = typeof member?.sessionID === "string" ? member.sessionID : undefined
        const directory = typeof member?.worktreePath === "string" ? member.worktreePath : undefined
        if (!sessionID || !directory) continue
        try {
          await bindOne({ sessionID, directory })
          log(`[oh-my-rigel] team member session bound to worktree: member=${member.name}; session=${sessionID}; path=${directory}`)
        } catch (error) {
          failures.push(`member=${member.name}: ${error instanceof Error ? error.message : String(error)}`)
          log(`[oh-my-rigel] team member session bind failed for ${member.name}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (failures.length > 0) {
        throw new Error(`team member session bind failed for ${failures.length} member(s): ${failures.join("; ")}`)
      }
    },
  }
}
