/**
 * Durable cleanup journal and startup reconciliation for team worktrees,
 * scoped to one project.
 *
 * The cleanup a shutdown or an orphan triggers is git work the caller cannot
 * await (a dying process must not block on it). If the process dies mid-cleanup
 * the worktrees and branches would leak. This module makes that cleanup
 * crash-safe AND project-scoped:
 *
 * 1. every cleanup path records a PENDING entry under the project's journal
 *    namespace (`rigel-v2/team-cleanup/<projectKey>/<name>`) BEFORE any git work
 *    starts (durable across process death);
 * 2. a successful cleanup clears the entry; a failed one keeps it with an
 *    attempt count and the last error;
 * 3. `reconcile()` reads ONLY the active project's teams and journal: it
 *    re-attempts pending entries, cleans the project's `orphaned` /
 *    `shutdown-approved` / stale `binding` / `failed` teams, and sweeps
 *    `rigel-team/*` worktrees of the active repo that no project team
 *    references (the crash-during-create window).
 *
 * Two guards keep a LIVE create safe from a concurrent reconcile (another
 * session's setup, possibly another plugin instance): an in-process in-flight
 * set, and a durable freshness window (`bindingAt`, `bindingStaleMs`). A crashed
 * create ages out and is reclaimed on a later boot.
 *
 * A third guard protects the other direction: a team record that still OWNS a
 * member session is never reclaimed, only converted into the retry state an
 * explicit `team_delete` finishes. Cleaning it would delete the worktree of a
 * session that is still alive, and removing it would strand that session's
 * persistent pane with nothing left to finish the teardown.
 *
 * Legacy records written before scoping are migrated ONLY when their member
 * worktree paths prove they belong to this repo; a record owned by another repo
 * is never adopted or deleted. The module is storage-injected and pure, so the
 * journal, retry, crash/restart and cross-project isolation are all testable
 * hermetically.
 */

import {
  CLEANUP_RECORD_ROOT,
  DEFAULT_PROJECT_KEY,
  TEAM_RECORD_ROOT,
  cleanupRecordKey,
  cleanupRecordsPrefix,
  isLegacyCleanupKey,
  isLegacyTeamKey,
  isOwnedByRepo,
  teamRecordKey,
  teamRecordsPrefix,
} from "./rigel-v2-team-project-scope.mjs"

export const CLEANUP_JOURNAL_PREFIX = CLEANUP_RECORD_ROOT
export const CREATE_IN_PROGRESS_REASON = "create-in-progress"
export const DEFAULT_BINDING_STALE_MS = 120_000
const RECONCILABLE_TEAM_STATUSES = new Set(["orphaned", "shutdown-approved", "binding", "failed"])
const REMOVABLE_FAILED_STATUSES = new Set(["binding", "failed"])

async function scanEntries(storage, prefix) {
  if (!storage || typeof storage.scan !== "function") return []
  const result = await storage.scan({ prefix })
  return (result?.entries ?? [])
    .filter((entry) => entry && typeof entry.key === "string" && entry.value && typeof entry.value === "object")
    .map((entry) => ({ key: entry.key, value: entry.value }))
}

export function createTeamWorktreeReconciler({ storage, worktrees, projectKey = DEFAULT_PROJECT_KEY, repoRoot, log = () => {}, now = () => Date.now(), bindingStaleMs = DEFAULT_BINDING_STALE_MS } = {}) {
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") {
    throw new Error("team worktree reconciler requires V2 storage")
  }
  if (!worktrees || typeof worktrees.cleanup !== "function") {
    throw new Error("team worktree reconciler requires a worktree manager")
  }

  const teamKeyFor = (name) => teamRecordKey(projectKey, name)
  const journalKeyFor = (name) => cleanupRecordKey(projectKey, name)
  const inFlight = new Set()
  const isFresh = (bindingAt) => typeof bindingAt === "number" && now() - bindingAt < bindingStaleMs

  async function record({ teamName, members, reason, bindingAt }) {
    if (typeof teamName !== "string" || !teamName.trim()) return
    await storage.set(journalKeyFor(teamName), {
      teamName,
      projectKey,
      members: members ?? [],
      reason: reason ?? "cleanup",
      attempts: 0,
      bindingAt: typeof bindingAt === "number" ? bindingAt : now(),
      recordedAt: now(),
    })
  }

  async function clear({ teamName }) {
    if (typeof storage.remove === "function") await storage.remove(journalKeyFor(teamName))
  }

  async function listPending() {
    return (await scanEntries(storage, cleanupRecordsPrefix(projectKey))).map((entry) => entry.value)
  }

  async function listTeams() {
    return (await scanEntries(storage, teamRecordsPrefix(projectKey))).map((entry) => entry.value)
  }

  /**
   * Adopt legacy (unscoped) records ONLY when this repo provably owns them.
   * Never touches a record owned by another repo.
   */
  async function migrateLegacyOwnedRecords() {
    const migrated = []
    if (!repoRoot || typeof storage.scan !== "function") return migrated
    for (const { key, value } of await scanEntries(storage, TEAM_RECORD_ROOT)) {
      if (!isLegacyTeamKey(key) || !isOwnedByRepo(value.members, repoRoot)) continue
      const scoped = teamKeyFor(value.name ?? key.slice(TEAM_RECORD_ROOT.length))
      if (await storage.get(scoped)) continue
      await storage.set(scoped, { ...value, projectKey })
      if (typeof storage.remove === "function") await storage.remove(key)
      migrated.push(value.name)
    }
    for (const { key, value } of await scanEntries(storage, CLEANUP_RECORD_ROOT)) {
      if (!isLegacyCleanupKey(key) || !isOwnedByRepo(value.members, repoRoot)) continue
      const scoped = journalKeyFor(value.teamName ?? key.slice(CLEANUP_RECORD_ROOT.length))
      if (await storage.get(scoped)) continue
      await storage.set(scoped, { ...value, projectKey })
      if (typeof storage.remove === "function") await storage.remove(key)
      migrated.push(value.teamName)
    }
    return migrated
  }

  /**
   * Attempt one pending cleanup. Success clears the journal entry; failure keeps
   * it with an updated attempt count so a later reconciliation (or boot) retries.
   * Never throws: a cleanup failure is data, not an exception.
   */
  async function runPending({ teamName, members, reason = "cleanup" }) {
    let report
    try {
      report = await worktrees.cleanup({ members: members ?? [] })
    } catch (error) {
      report = { removed: [], errors: [error instanceof Error ? error.message : String(error)] }
    }
    if (report.errors.length === 0) {
      await clear({ teamName })
      return { teamName, cleaned: true, report }
    }
    const existing = (await storage.get(journalKeyFor(teamName))) ?? {}
    await storage.set(journalKeyFor(teamName), {
      ...existing,
      teamName,
      projectKey,
      members: members ?? existing.members ?? [],
      reason,
      attempts: (existing.attempts ?? 0) + 1,
      lastError: report.errors.join("; "),
      bindingAt: typeof existing.bindingAt === "number" ? existing.bindingAt : now(),
    })
    log(`[oh-my-rigel] team worktree cleanup still pending: project=${projectKey}; team=${teamName}; errors=${report.errors.join("; ")}`)
    return { teamName, cleaned: false, report }
  }

  async function reconcile() {
    const migrated = await migrateLegacyOwnedRecords()
    const teams = await listTeams()
    const pending = await listPending()
    const byName = new Map(teams.map((team) => [team.name, team]))
    const summary = { cleaned: [], pending: [], removedTeams: [], retained: [], swept: [], migrated, errors: [] }

    const protectedNames = new Set(inFlight)
    for (const entry of pending) {
      if (entry.reason === CREATE_IN_PROGRESS_REASON && isFresh(entry.bindingAt)) protectedNames.add(entry.teamName)
    }

    // 1. Every recorded pending cleanup, retried until it actually succeeds.
    for (const entry of pending) {
      if (inFlight.has(entry.teamName)) continue
      if (entry.reason === CREATE_IN_PROGRESS_REASON && isFresh(entry.bindingAt)) continue
      const team = byName.get(entry.teamName)
      if (team && team.status === "active") {
        await clear({ teamName: entry.teamName })
        continue
      }
      const result = await runPending({ teamName: entry.teamName, members: entry.members, reason: entry.reason })
      if (result.cleaned) summary.cleaned.push(entry.teamName)
      else summary.pending.push(entry.teamName)
    }

    // 2. Teams left in a state whose resources must be reclaimed.
    for (const team of teams) {
      if (!RECONCILABLE_TEAM_STATUSES.has(team.status)) continue
      if (inFlight.has(team.name)) continue
      if (team.status === "binding" && isFresh(team.bindingAt)) continue
      // Round-2 review R4 (crash window): a record that still OWNS a member
      // session must never be reclaimed by the startup sweep. Cleaning it would
      // delete the working directory of a session that is still alive, and
      // removing it (`binding`/`failed` are removable) would strand that session's
      // persistent pane with no `team_delete` left to finish the teardown - losing
      // exactly the `remaining owned session ids` a recoverable record must keep.
      // It is rewritten to the same retry state a failed delete keeps, which is in
      // neither recovery set, so only an explicit `team_delete` can clear it.
      const ownedLive = (team.members ?? []).filter((member) => member?.owned === true && typeof member?.sessionID === "string" && member.sessionID.length > 0)
      if (ownedLive.length > 0) {
        if (typeof storage.set === "function") {
          await storage.set(teamKeyFor(team.name), {
            ...team,
            status: "cleanup-failed",
            cleanupPending: ownedLive.map((member) => member.sessionID),
            cleanupFailedAt: now(),
            retainedBy: `reconcile:${team.status}`,
          })
        }
        summary.retained.push(team.name)
        log(`[oh-my-rigel] team ${team.name} still owns ${ownedLive.length} live session(s); retained for team_delete instead of reclaimed`)
        continue
      }
      const members = (team.members ?? []).filter((member) => member?.worktreePath || member?.worktreeBranch)
      if (members.length === 0) {
        if (REMOVABLE_FAILED_STATUSES.has(team.status) && typeof storage.remove === "function") {
          await storage.remove(teamKeyFor(team.name))
          summary.removedTeams.push(team.name)
        }
        continue
      }
      const result = await runPending({ teamName: team.name, members, reason: `reconcile:${team.status}` })
      if (result.cleaned) {
        summary.cleaned.push(team.name)
        await clear({ teamName: team.name })
        if (REMOVABLE_FAILED_STATUSES.has(team.status) && typeof storage.remove === "function") {
          await storage.remove(teamKeyFor(team.name))
          summary.removedTeams.push(team.name)
        }
      } else {
        summary.pending.push(team.name)
      }
    }

    // 3. Sweep `rigel-team/*` worktrees of THIS repo that no project team
    // references and no fresh create protects.
    if (typeof worktrees.sweepOrphans === "function") {
      const referenced = new Set()
      for (const team of teams) {
        for (const member of team.members ?? []) {
          if (typeof member?.worktreePath === "string") referenced.add(member.worktreePath)
        }
      }
      try {
        const protectedPrefixes = [...protectedNames]
          .map((name) => (typeof worktrees.resolveTeamDirectory === "function" ? worktrees.resolveTeamDirectory(name) : undefined))
          .filter(Boolean)
        const sweep = await worktrees.sweepOrphans({ referenced, protectedPrefixes })
        summary.swept.push(...sweep.removed)
        summary.errors.push(...sweep.errors)
      } catch (error) {
        summary.errors.push(error instanceof Error ? error.message : String(error))
      }
    }

    log(`[oh-my-rigel] team worktree reconciliation: project=${projectKey}; cleaned=${summary.cleaned.length}; pending=${summary.pending.length}; swept=${summary.swept.length}; migrated=${summary.migrated.length}`)
    return summary
  }

  return {
    record,
    clear,
    listPending,
    listTeams,
    runPending,
    reconcile,
    migrateLegacyOwnedRecords,
    beginCreate(teamName) { if (typeof teamName === "string" && teamName) inFlight.add(teamName) },
    endCreate(teamName) { if (typeof teamName === "string") inFlight.delete(teamName) },
  }
}
