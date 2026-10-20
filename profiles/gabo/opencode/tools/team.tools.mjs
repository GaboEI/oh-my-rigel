import { randomUUID } from "node:crypto"
import { DEFAULT_PROJECT_KEY, teamRecordKey, teamRecordsPrefix } from "../rigel-v2-team-project-scope.mjs"

const TEAM_TOOL_DESCRIPTIONS = Object.freeze({
  // The tool description is the only text the model is guaranteed to see, so the
  // canonical call shape and the upstream boundary are restated here as well as
  // in the `team-mode` skill.
  team_create: "Create a team run whose members work as coordinated sessions. Native contract: team_create({ team_name, members: [{ name, agent | category, prompt, model? }], worktree? }). Every member without an adopted sessionID gets a real delegated child session, which is what makes its tmux pane appear. `name` is accepted as a DEPRECATED alias of team_name. Omit `worktree` and the legacy default applies (a per-member worktree when the project has a worktree manager); pass worktree: false to share one working tree. On a NON-git root that default cannot provision: the call fails loudly and does NOT authorise a policy change - switching worktree: true to worktree: false is the user's decision, so report the failure and ask the user to confirm explicitly before trying again. This runtime does NOT accept the upstream OmO shape (inline_spec, teamName, lead, loadSkills); there is exactly one create API.",
  team_delete: "Delete a team and its recorded state, terminating the member sessions THIS team spawned (that is what closes their panes). A session adopted from elsewhere - including one in a record written before ownership existed - is detached, never deleted, and is reported in sessionsDetached. `sessionsTerminated` lists only VERIFIED closes, and sessionsUnverified reports a close whose proof was unavailable (sessionsUnverifiedReasons carries the exact cause). If an owned session cannot be terminated the record is KEPT with retry state and the call returns deleted: false - call it again to finish.",
  team_shutdown_request: "Request a coordinated shutdown of the team.",
  team_approve_shutdown: "Approve a pending team shutdown request.",
  team_reject_shutdown: "Reject a pending team shutdown request.",
  team_send_message: "Send a message to a team member or broadcast it to the team.",
  team_task_create: "Create a task inside a team task list.",
  team_task_list: "List the tasks of a team.",
  team_task_update: "Update a task in a team task list.",
  team_task_get: "Get the tasks of a team.",
  team_status: "Get the full status of a team: members, messages and tasks.",
  team_list: "List every team known to the runtime.",
})

const TEAM_TOOL_NAMES = Object.freeze([
  "team_create", "team_delete", "team_shutdown_request", "team_approve_shutdown",
  "team_reject_shutdown", "team_send_message", "team_task_create", "team_task_list",
  "team_task_update", "team_task_get", "team_status", "team_list",
])

// Each team is a storage record namespaced by the SESSION's project:
// `rigel-v2/team/<projectKey>/<name>`. The active scope (project key, repo root,
// worktree manager, reconciler) is resolved per tool call from the calling
// session's directory, so two repos served by one plugin instance never collide.

/**
 * Canonical native create contract.
 *
 * The upstream OmO family (`packages/omo-opencode/src/features/team-mode/tools/`)
 * is a DIFFERENT surface: it accepts `teamName`/`inline_spec`/`leadSessionId`,
 * returns JSON strings, and stores under `~/.omo/teams/`. It is unreachable from
 * this runtime (the native module graph may not import `packages/omo-opencode`),
 * so this surface deliberately accepts exactly one shape and rejects the
 * upstream one by name. A model that copies the upstream call gets an actionable
 * error instead of a silent partial create.
 *
 * `additionalProperties: false` is advertised below, but the schema is NOT the
 * gate: `inline_spec` once passed a permissive schema and only died at runtime.
 * Enforcement is the code-side key check in `assertTeamCreateInput`.
 *
 * `worktree` keeps the pre-row-55 default: OMITTING it provisions a per-member
 * worktree whenever the project has a worktree manager, exactly as the baseline
 * direct tool did, and `worktree: false` is the explicit bypass (one shared
 * working tree, which is what pane discovery requires, since panes match on an
 * exact `pane_current_path`). `/team-mode` never relies on that default: it always
 * emits an explicit boolean, so the user-facing shared-tree path is unaffected.
 */
const TEAM_CREATE_ALLOWED_KEYS = Object.freeze(["team_name", "name", "members", "worktree"])
const UPSTREAM_ONLY_FIELDS = Object.freeze([
  "inline_spec", "teamName", "lead", "leadAgentId", "sessionGroups",
  "teamAllowedPaths", "sessionPermission", "loadSkills",
])
const TEAM_CREATE_CALL = "team_create({ team_name, members: [{ name, agent | category, prompt, model? }], worktree? })"
const TEAM_CREATE_MAX_MEMBERS = 8

const TEAM_NAME_PROPERTY = Object.freeze({ type: "string", minLength: 1, description: "Team name: the storage record key scoped to this project." })

// DEPRECATED alias of TEAM_NAME_PROPERTY, kept because the pre-row-55 surface
// read the team identifier as `input.team_name ?? input.name`; dropping `name`
// broke that contract. `team_name` stays canonical (and is what /team-mode
// emits); `name` is admitted only as an already-supported input spelling.
const TEAM_NAME_ALIAS_PROPERTY = Object.freeze({ type: "string", minLength: 1, description: "Deprecated alias of team_name; the same team identifier. Prefer team_name." })

const TEAM_CREATE_MEMBER_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: Object.freeze({
    name: { type: "string", minLength: 1, description: "Member name, unique inside the team." },
    agent: { type: "string", minLength: 1, description: "Callable agent to delegate this member to. Exactly one of agent|category." },
    subagent_type: { type: "string", minLength: 1, description: "Alias of agent, matching the rigel_task argument name." },
    category: { type: "string", minLength: 1, description: "Execution category to delegate this member to. Exactly one of agent|category." },
    prompt: { type: "string", minLength: 1, description: "This member's assignment; it starts the member's first turn." },
    model: { type: "string", minLength: 1, description: "Optional model override for this member." },
    sessionID: { type: "string", minLength: 1, description: "Adopt an EXISTING session as this member (no spawn)." },
  }),
})

const TEAM_CREATE_INPUT = Object.freeze({
  type: "object",
  additionalProperties: false,
  // The team identifier is required, but it may arrive as the deprecated `name`
  // alias, so presence is enforced in `teamName()` instead of a schema `required`
  // entry: a tool-parameter root may not be an anyOf/oneOf union.
  required: ["members"],
  properties: Object.freeze({
    team_name: TEAM_NAME_PROPERTY,
    name: TEAM_NAME_ALIAS_PROPERTY,
    members: Object.freeze({ type: "array", minItems: 1, maxItems: TEAM_CREATE_MAX_MEMBERS, items: TEAM_CREATE_MEMBER_SCHEMA }),
    worktree: Object.freeze({ type: "boolean", description: "Per-member git worktree. OMIT to keep the legacy default (one worktree per member when the project has a worktree manager); false = one shared working tree (pane-visible); true = require per-member worktrees." }),
  }),
})

const TEAM_SEND_MESSAGE_INPUT = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: Object.freeze({
    team_name: TEAM_NAME_PROPERTY,
    name: TEAM_NAME_ALIAS_PROPERTY,
    to: { type: "string", description: "Recipient member name, or \"lead\"." },
    message: { type: "string", minLength: 1, description: "Message body." },
  }),
})

const TEAM_TASK_INPUT = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [],
  properties: Object.freeze({ team_name: TEAM_NAME_PROPERTY, name: TEAM_NAME_ALIAS_PROPERTY, task: Object.freeze({ type: "object", additionalProperties: true }) }),
})

const TEAM_NAME_ONLY_INPUT = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [],
  properties: Object.freeze({ team_name: TEAM_NAME_PROPERTY, name: TEAM_NAME_ALIAS_PROPERTY }),
})

const TEAM_LIST_INPUT = Object.freeze({ type: "object", additionalProperties: false, properties: Object.freeze({}) })

function assertTeamCreateInput(input) {
  const unknown = Object.keys(input ?? {}).filter((key) => !TEAM_CREATE_ALLOWED_KEYS.includes(key))
  if (unknown.length === 0) return
  const upstream = unknown.filter((key) => UPSTREAM_ONLY_FIELDS.includes(key))
  if (upstream.length > 0) {
    throw new Error(`team_create does not accept ${upstream.map((key) => `"${key}"`).join(", ")}: that is the upstream OmO contract (packages/omo-opencode .../team-mode/tools/lifecycle-create-tool.ts), which is not reachable from this runtime. Nothing was created. Call: ${TEAM_CREATE_CALL}`)
  }
  throw new Error(`team_create received unsupported field(s): ${unknown.join(", ")}. Supported: team_name (canonical), name (deprecated alias of team_name), worktree, members[].{name, agent, category, prompt, model, sessionID}. Call: ${TEAM_CREATE_CALL}`)
}

function teamName(input) {
  // Pre-row-55 the identifier was read as `input.team_name ?? input.name`;
  // `name` stays accepted as a DEPRECATED alias. Two disagreeing values are
  // ambiguous and are rejected before any side effect; identical values
  // normalize to the canonical `team_name`.
  const canonical = typeof input?.team_name === "string" ? input.team_name.trim() : ""
  const alias = typeof input?.name === "string" ? input.name.trim() : ""
  if (canonical && alias && canonical !== alias) {
    throw new Error(`team_name and its deprecated alias "name" disagree ("${canonical}" vs "${alias}"): pass a single team identifier. Nothing was done.`)
  }
  if (canonical) return canonical
  if (alias) return alias
  throw new Error(`team_name is required (the deprecated alias "name" is also accepted). Call: ${TEAM_CREATE_CALL}`)
}

function trimmedString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function normalizeMember(member) {
  if (typeof member === "string") {
    if (!member.trim()) throw new Error("member names must be non-empty strings")
    return { name: member.trim(), sessionID: undefined, status: "pending" }
  }
  const name = typeof member?.name === "string" ? member.name.trim() : ""
  if (!name) throw new Error("each member needs a non-empty name")
  const sessionID = trimmedString(member?.sessionID)
  // `subagent_type` is the rigel_task spelling of the same choice; exactly one of
  // agent|category selects the delegate, and the composition resolves it.
  const agent = trimmedString(member?.agent) ?? trimmedString(member?.subagent_type)
  const category = trimmedString(member?.category)
  const prompt = trimmedString(member?.prompt)
  const model = trimmedString(member?.model)
  return {
    name,
    sessionID,
    // Provenance (blocker 3): a member that ADOPTS an existing sessionID is not
    // owned by this team, so no team lifecycle call may terminate it. Only a
    // session this team spawned is stamped `owned: true`, at spawn time below.
    ...(sessionID ? { owned: false, provenance: "adopted" } : {}),
    ...(agent ? { agent } : {}),
    ...(category ? { category } : {}),
    ...(prompt ? { prompt } : {}),
    ...(model ? { model } : {}),
    status: "running",
  }
}

function normalizeMembers(input) {
  const raw = input?.members
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error("members must be an array")
  const seen = new Set()
  const members = []
  for (const entry of raw) {
    const member = normalizeMember(entry)
    if (seen.has(member.name)) throw new Error(`duplicate member name "${member.name}"`)
    seen.add(member.name)
    members.push(member)
  }
  return members
}

/**
 * A member that must be spawned needs one delegate choice and an assignment.
 * Checked BEFORE any side effect (no journal entry, no worktree, no record), so
 * an under-specified create leaves nothing behind and never spawns a stray
 * session. Members that adopt an existing `sessionID` are skipped.
 */
function assertSpawnableMembers(members) {
  for (const member of members) {
    if (member.sessionID) continue
    const hasAgent = typeof member.agent === "string" && member.agent.length > 0
    const hasCategory = typeof member.category === "string" && member.category.length > 0
    if (hasAgent && hasCategory) {
      throw new Error(`member "${member.name}" must set exactly one of agent|category, not both. Call: ${TEAM_CREATE_CALL}`)
    }
    if (!hasAgent && !hasCategory) {
      throw new Error(`member "${member.name}" needs exactly one of agent|category, plus a non-empty prompt describing its assignment. Ask the user which agent or category the member should be, then call: ${TEAM_CREATE_CALL}`)
    }
    if (typeof member.prompt !== "string" || !member.prompt) {
      throw new Error(`member "${member.name}" needs a non-empty prompt describing its assignment. Call: ${TEAM_CREATE_CALL}`)
    }
  }
}

function definition(name, execute, input) {
  return {
    name,
    options: { codemode: false },
    description: TEAM_TOOL_DESCRIPTIONS[name],
    input,
    execute,
  }
}

export { TEAM_TOOL_NAMES }

export function createTeamTools({
  storage,
  getSessionID = () => undefined,
  resolveScopeForSession,
  worktreeManager,
  worktreeReconciler,
  projectKey = DEFAULT_PROJECT_KEY,
  // Injected delegation seams. `startMemberSession` turns one member assignment
  // into a real delegated child session; `terminateMemberSession` deletes one,
  // idempotently. Both are composed in the runtime, so this file imports no host
  // module and stays unit-testable. When `startMemberSession` is absent the tool
  // degrades to record-only binding, which is what the pre-spawn behavior was.
  startMemberSession,
  terminateMemberSession,
  log = (line) => console.error(line),
} = {}) {
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") throw new Error("V2 storage is required for team tools")

  // Production resolves the scope from the calling session's project directory;
  // injected callers (tests, single-repo hosts) may pass a fixed manager/reconciler.
  const scopeFor = typeof resolveScopeForSession === "function"
    ? async (toolContext) => {
        const scope = await resolveScopeForSession(sidFor(toolContext))
        // Never provision or clean before the repo's initial reconciliation has
        // finished, so a create cannot be swept by the startup sweep.
        if (scope.ready) await scope.ready
        return {
          projectKey: scope.projectKey,
          repoRoot: scope.repoRoot,
          worktreeManager: scope.worktrees ?? scope.worktreeManager,
          worktreeReconciler: scope.reconciler ?? scope.worktreeReconciler,
        }
      }
    : async () => ({ projectKey, repoRoot: undefined, worktreeManager, worktreeReconciler })

  const keyFor = (scope, name) => teamRecordKey(scope.projectKey, name)
  const sidFor = (toolContext) => (typeof toolContext?.sessionID === "string" && toolContext.sessionID) || getSessionID()

  const sessionList = async (scope) => {
    if (typeof storage.scan !== "function") return []
    const result = await storage.scan({ prefix: teamRecordsPrefix(scope.projectKey) })
    return (result?.entries ?? []).map((entry) => entry.value).filter((value) => value && typeof value === "object")
  }
  const readTeam = async (key, name) => {
    const team = await storage.get(key)
    if (!team || typeof team !== "object") throw new Error(`Team "${name}" was not found`)
    return team
  }

  // Blocker 3 (ownership/provenance): only sessions THIS team spawned carry
  // `owned: true`, so only they may ever be terminated. An adopted sessionID
  // belongs to another owner, and a legacy record carries no provenance at all,
  // so neither can be deleted by a team lifecycle call.
  const ownedSessions = (members) => (members ?? []).filter((member) => member?.owned === true && typeof member?.sessionID === "string" && member.sessionID)
  // A session this team cannot PROVE it spawned is not owned: `owned: false`
  // adopted members AND pre-ownership legacy records (no `owned` field at all).
  // Both are detached and REPORTED, never terminated - an unprovable session is
  // never deleted, and it is never silently dropped from the result either.
  const adoptedSessions = (members) => (members ?? []).filter((member) => member?.owned !== true && typeof member?.sessionID === "string" && member.sessionID)

  // Idempotent, never throws: a host without a delete domain, or a session that
  // is already gone, must not fail the whole team lifecycle.
  const terminateSessions = async (members, reason, controlSessionID) => {
    const sessionIDs = (members ?? []).map((member) => member?.sessionID).filter((sessionID) => typeof sessionID === "string" && sessionID)
    if (sessionIDs.length === 0) return []
    if (typeof terminateMemberSession !== "function") {
      log(`[oh-my-rigel] team ${reason}: no member-session terminator is installed; ${sessionIDs.length} session(s) left running`)
      return sessionIDs.map((sessionID) => ({ sessionID, deleted: false, error: "no terminator installed" }))
    }
    const results = []
    for (const sessionID of sessionIDs) {
      try {
        // The caller's own session is provably alive, so the terminator can use it
        // to CALIBRATE its presence probe: on a host whose deleted-session answer
        // carries no not-found wording, that live control is the only thing that
        // distinguishes "the session is gone" from "the probe is broken".
        const result = await terminateMemberSession(sessionID, controlSessionID ? { controlSessionID } : undefined)
        // `unverified` is carried through so a caller can distinguish a proven
        // deletion from one whose presence probe was unavailable (teardown module).
        results.push({ sessionID, deleted: result?.deleted === true, unverified: result?.unverified === true, reason: result?.reason, error: result?.error })
      } catch (error) {
        results.push({ sessionID, deleted: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return results
  }

  // Blocker 2 (transactional create): reconcile the durable create journal after a
  // provisioning exception. `runPending` clears the entry on success and KEEPS it
  // with attempt state when the cleanup itself fails, so a kept entry is never
  // cleared here and a later reconciliation can still finish the job.
  const reconcileCreateJournal = async (scope, name, members, reason) => {
    if (scope.worktreeReconciler) {
      try {
        const report = await scope.worktreeReconciler.runPending({ teamName: name, members, reason })
        if (report?.cleaned) return "reconciled"
        const errors = Array.isArray(report?.report?.errors) ? report.report.errors.join("; ") : "cleanup reported pending"
        return `pending (${errors})`
      } catch (error) {
        return `unreconciled (${error instanceof Error ? error.message : String(error)})`
      }
    }
    if (scope.worktreeManager) {
      try {
        const report = await scope.worktreeManager.cleanup({ members: members ?? [] })
        const errors = Array.isArray(report?.errors) ? report.errors : []
        return errors.length > 0 ? `pending (${errors.join("; ")})` : "reconciled"
      } catch (error) {
        return `unreconciled (${error instanceof Error ? error.message : String(error)})`
      }
    }
    return "skipped (no worktree manager)"
  }

  async function createTeamRun(scope, name, input, toolContext) {
    const declared = normalizeMembers(input)
    // Blocker 1 (backward compatibility): the pre-row-55 tool provisioned a
    // per-member worktree whenever a worktree manager existed; `worktree` was not a
    // control at all. An opt-in default silently changed every legacy direct call
    // that omitted the key, so the LEGACY default is restored: OMIT `worktree` and
    // a manager means provision. `worktree: false` is the only bypass, and
    // /team-mode always emits an explicit boolean, so the shared-pane path is
    // unaffected.
    const wantsWorktrees = input?.worktree !== false && Boolean(scope.worktreeManager)
    const spawning = typeof startMemberSession === "function"
    // Fail before any side effect. Without a spawn seam this is record-only
    // binding, so members may legitimately carry nothing but a name.
    if (spawning) assertSpawnableMembers(declared)

    const leadSessionID = sidFor(toolContext)
    if (scope.worktreeReconciler) {
      try { await scope.worktreeReconciler.record({ teamName: name, members: [], reason: "create-in-progress" }) } catch (recordError) { log(`[oh-my-rigel] team worktree journal record failed: ${recordError instanceof Error ? recordError.message : String(recordError)}`) }
    }
    let provisioned = []
    if (wantsWorktrees) {
      try {
        provisioned = await scope.worktreeManager.provision({ teamName: name, members: declared })
      } catch (provisionError) {
        // Blocker 2: the journal entry is already written and no team record exists,
        // so it must be reconciled before the error escapes — otherwise a failed
        // create leaves a journal entry for a team that was never created.
        const journal = await reconcileCreateJournal(scope, name, declared, "provision-failed")
        const base = provisionError instanceof Error ? provisionError.message : String(provisionError)
        throw new Error(`${base}. Nothing was created; worktree journal ${journal}.`)
      }
    }
    const members = declared.map((member) => {
      const patch = provisioned.find((entry) => entry.name === member.name)
      return patch ? { ...member, worktreePath: patch.worktreePath, worktreeBranch: patch.worktreeBranch } : member
    })
    // Persisted BEFORE the first spawn: a crash then leaves at most a `binding`
    // record with partial session ids (reclaimed as stale), never a phantom
    // `active` team.
    const pending = { name, projectKey: scope.projectKey, repoRoot: scope.repoRoot, leaderSessionID: leadSessionID, status: "binding", bindingAt: Date.now(), ...(wantsWorktrees ? { worktree: true } : {}), members, messages: [], tasks: [] }
    await storage.set(keyFor(scope, name), pending)

    const createdSessionIDs = []
    try {
      // Sequential on purpose: a bounded, observable spawn order keeps the
      // member/session mapping deterministic and never fans out at the model.
      for (let index = 0; index < members.length; index += 1) {
        const member = members[index]
        if (!spawning || member.sessionID) continue
        const delegated = await startMemberSession(
          { name: member.name, agent: member.agent, category: member.category, prompt: member.prompt, model: member.model },
          { teamName: name, leadSessionID },
        )
        const sessionID = trimmedString(delegated?.sessionID)
        if (!sessionID) throw new Error(`member "${member.name}" was not given a session id by the delegation seam`)
        createdSessionIDs.push(sessionID)
        members[index] = {
          ...member,
          sessionID,
          // Blocker 3: this session was spawned BY THIS TEAM, so it is owned and may
          // be terminated. An adopted sessionID never receives this stamp.
          owned: true,
          provenance: "spawned",
          ...(trimmedString(delegated?.agent) ? { agent: trimmedString(delegated.agent) } : {}),
          ...(trimmedString(delegated?.model) ? { model: trimmedString(delegated.model) } : {}),
          status: "running",
        }
        // Durable per member, before the next spawn.
        await storage.set(keyFor(scope, name), { ...pending, members })
      }
      if (wantsWorktrees && scope.worktreeManager) await scope.worktreeManager.bindSessions({ members })
    } catch (error) {
      // Transactional rollback: terminate ONLY what THIS create spawned (blocker 3 —
      // an adopted session must never reach the terminator, not even in a rollback),
      // reclaim worktrees, then drop the record. A rollback that cannot prove a
      // spawned session gone KEEPS a recoverable record carrying the remaining owned
      // session ids (blocker 2) so a later team_delete can finish the teardown.
      const rolledBack = members.filter((member) => member.owned === true && createdSessionIDs.includes(member.sessionID))
      const terminated = await terminateSessions(rolledBack, "create-rollback", sidFor(toolContext))
      const failed = terminated.filter((entry) => !entry.deleted)
      let reclaimed = "skipped"
      if (wantsWorktrees) {
        try {
          if (scope.worktreeReconciler) {
            await scope.worktreeReconciler.runPending({ teamName: name, members, reason: "bind-failed" })
            reclaimed = "ok"
          } else if (scope.worktreeManager) {
            await scope.worktreeManager.cleanup({ members })
            reclaimed = "ok"
          }
        } catch (cleanupError) {
          reclaimed = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }
      }
      let retained = "dropped"
      if (failed.length > 0) {
        await storage.set(keyFor(scope, name), {
          ...pending,
          members,
          status: "cleanup-failed",
          cleanupFailedAt: Date.now(),
          cleanupPending: failed.map((entry) => entry.sessionID),
          cleanupErrors: failed.map((entry) => ({ sessionID: entry.sessionID, error: entry.error ?? "unknown" })),
        })
        retained = `kept (cleanup-failed; owned sessions pending: ${failed.map((entry) => entry.sessionID).join(", ")})`
      } else if (typeof storage.remove === "function") {
        await storage.remove(keyFor(scope, name))
      }
      const base = error instanceof Error ? error.message : String(error)
      const sessionReport = terminated.length === 0
        ? "none created"
        : terminated.map((entry) => `${entry.sessionID}=${entry.deleted ? "terminated" : `kept(${entry.error ?? "unknown"})`}`).join(", ")
      throw new Error(`${base}. Rolled back: sessions [${sessionReport}], worktrees ${reclaimed}, record ${retained}.`)
    }
    if (scope.worktreeReconciler) { try { await scope.worktreeReconciler.clear({ teamName: name }) } catch { /* journal cleared best-effort */ } }
    const team = { ...pending, members, status: "active" }
    await storage.set(keyFor(scope, name), team)
    return team
  }

  return {
    team_create: definition("team_create", async (input, toolContext) => {
      // Rejected before the scope resolves, so a malformed call cannot even reach
      // the repo scope (and therefore cannot provision anything).
      assertTeamCreateInput(input)
      const name = teamName(input)
      const declared = normalizeMembers(input)
      if (typeof startMemberSession === "function") assertSpawnableMembers(declared)
      const scope = await scopeFor(toolContext)
      if (await storage.get(keyFor(scope, name))) throw new Error(`Team "${name}" already exists`)
      scope.worktreeReconciler?.beginCreate(name)
      try {
        return await createTeamRun(scope, name, input, toolContext)
      } finally {
        scope.worktreeReconciler?.endCreate(name)
      }
    }, TEAM_CREATE_INPUT),
    team_delete: definition("team_delete", async (input, toolContext) => {
      const scope = await scopeFor(toolContext)
      const name = teamName(input)
      if (typeof storage.remove !== "function") throw new Error("V2 storage remove is unavailable")
      // A member pane closes ONLY on `session.deleted`, so the member-session
      // termination outcome IS the pane-cleanup outcome and must reach the
      // caller: reporting `deleted: true` while a member session survives leaves
      // a live pane behind with no signal anywhere the model can see.
      let sessionsTerminated = []
      let sessionsFailed = []
      let sessionsDetached = []
      let sessionsUnverified = []
      let sessionsUnverifiedReasons = []
      const team = await storage.get(keyFor(scope, name))
      if (team) {
        if (scope.worktreeReconciler) {
          await scope.worktreeReconciler.record({ teamName: name, members: team.members, reason: "delete" })
          await scope.worktreeReconciler.runPending({ teamName: name, members: team.members, reason: "delete" })
        } else if (scope.worktreeManager) {
          try { await scope.worktreeManager.cleanup({ members: team.members }) } catch (error) { log(`[oh-my-rigel] team worktree cleanup failed on delete: ${error instanceof Error ? error.message : String(error)}`) }
        }
        // Blocker 3: adopted sessions are DETACHED (the team stops referencing
        // them) and never terminated; only sessions this team spawned are owned.
        sessionsDetached = adoptedSessions(team.members).map((member) => member.sessionID)
        for (const sessionID of sessionsDetached) {
          log(`[oh-my-rigel] team "${name}": adopted session ${sessionID} detached (not owned; never deleted)`)
        }
        // Terminate owned members BEFORE dropping the record: `session.deleted` is
        // what closes each member pane, and the record must survive a partial
        // failure so a retry can finish the job.
        const terminated = await terminateSessions(ownedSessions(team.members), `delete ${name}`, sidFor(toolContext))
        // Honest seam (round-2 review R1): `sessionsTerminated` lists ONLY proven
        // closes. An unverified resolution is reported in `sessionsUnverified`
        // instead, so the returned `deleted: true` is never backed by a list that
        // mixes proven and unproven deletions. Unverified still counts as RESOLVED
        // (never as `sessionsFailed`), so it cannot wedge a record into retry
        // forever - the delete call did resolve, only its proof is missing.
        sessionsTerminated = terminated.filter((entry) => entry.deleted && !entry.unverified).map((entry) => entry.sessionID)
        sessionsFailed = terminated.filter((entry) => !entry.deleted).map((entry) => ({ sessionID: entry.sessionID, error: entry.error ?? "unknown" }))
        sessionsUnverified = terminated.filter((entry) => entry.deleted && entry.unverified).map((entry) => entry.sessionID)
        // Diagnostic seam (ROW55 retest 6): the previous contract dropped the
        // reason, so "no probe exists", "the probe failed" and "the host answered
        // something unrecognizable" were indistinguishable to the operator. The
        // IDs stay a plain string list for existing consumers; the cause travels
        // beside them.
        sessionsUnverifiedReasons = terminated
          .filter((entry) => entry.deleted && entry.unverified)
          .map((entry) => ({ sessionID: entry.sessionID, reason: entry.reason ?? entry.error ?? "unknown" }))
        for (const entry of sessionsFailed) {
          log(`[oh-my-rigel] team "${name}": member session ${entry.sessionID} was not terminated (${entry.error})`)
        }
      }
      if (sessionsFailed.length > 0) {
        // Blocker 2: a teardown that could not terminate an owned member session
        // must NOT drop the record or claim deletion. Keep it with retry state so
        // calling team_delete again can finish, and report `deleted: false`.
        await storage.set(keyFor(scope, name), {
          ...(team ?? { name, projectKey: scope.projectKey }),
          name,
          status: "cleanup-failed",
          deleteRequestedAt: Date.now(),
          cleanupFailedAt: Date.now(),
          cleanupPending: sessionsFailed.map((entry) => entry.sessionID),
          cleanupErrors: sessionsFailed,
        })
        return {
          name,
          deleted: false,
          retained: true,
          sessionsTerminated,
          sessionsFailed,
          sessionsDetached,
          sessionsUnverified,
          ...(sessionsUnverifiedReasons.length > 0 ? { sessionsUnverifiedReasons } : {}),
          warning: `team "${name}": ${sessionsFailed.length} owned member session(s) could not be terminated, so their panes may still be open. The team record was KEPT with retry state: call team_delete again to finish.`
        }
      }
      await storage.remove(keyFor(scope, name))
      const result = { name, deleted: true, sessionsTerminated, sessionsFailed, sessionsDetached, sessionsUnverified }
      if (sessionsUnverified.length > 0) {
        result.sessionsUnverifiedReasons = sessionsUnverifiedReasons
        result.warning = `team "${name}": ${sessionsUnverified.length} member session(s) were deleted but deletion could not be VERIFIED (the presence proof was unavailable or failed), so a pane may still be open. See sessionsUnverifiedReasons for the exact cause.`
      }
      return result
    }, TEAM_NAME_ONLY_INPUT),
    team_shutdown_request: definition("team_shutdown_request", async (input, toolContext) => {
      const scope = await scopeFor(toolContext)
      const name = teamName(input); const team = await readTeam(keyFor(scope, name), name)
      const next = { ...team, status: "shutdown-requested" }; await storage.set(keyFor(scope, name), next); return next
    }, TEAM_NAME_ONLY_INPUT),
    team_approve_shutdown: definition("team_approve_shutdown", async (input, toolContext) => {
      const scope = await scopeFor(toolContext)
      const name = teamName(input); const team = await readTeam(keyFor(scope, name), name)
      const next = { ...team, status: "shutdown-approved" }; await storage.set(keyFor(scope, name), next)
      if (scope.worktreeReconciler) {
        await scope.worktreeReconciler.record({ teamName: name, members: next.members, reason: "shutdown-approved" })
        void scope.worktreeReconciler.runPending({ teamName: name, members: next.members, reason: "shutdown-approved" })
      } else if (scope.worktreeManager) {
        scope.worktreeManager.cleanupNonBlocking({ members: next.members })
      }
      return next
    }, TEAM_NAME_ONLY_INPUT),
    team_reject_shutdown: definition("team_reject_shutdown", async (input, toolContext) => {
      const scope = await scopeFor(toolContext)
      const name = teamName(input); const team = await readTeam(keyFor(scope, name), name)
      const next = { ...team, status: "active" }; await storage.set(keyFor(scope, name), next); return next
    }, TEAM_NAME_ONLY_INPUT),
    team_send_message: definition("team_send_message", async (input, toolContext) => {
      const scope = await scopeFor(toolContext)
      const name = teamName(input); const team = await readTeam(keyFor(scope, name), name)
      const text = typeof input.message === "string" ? input.message : ""
      if (!text) throw new Error("message is required")
      const to = typeof input.to === "string" && input.to.trim() ? input.to.trim() : undefined
      if (to !== undefined && !(team.members ?? []).some((member) => member.name === to) && to !== "lead") {
        throw new Error(`member "${to}" is not part of team "${name}"`)
      }
      const message = { id: randomUUID(), from: sidFor(toolContext), to, text, read: false }
      const next = { ...team, messages: [...(team.messages ?? []), message] }; await storage.set(keyFor(scope, name), next)
      return { messageId: message.id, to: message.to, team: next }
    }, TEAM_SEND_MESSAGE_INPUT),
    team_task_create: definition("team_task_create", async (input, toolContext) => {
      const scope = await scopeFor(toolContext)
      const name = teamName(input); const team = await readTeam(keyFor(scope, name), name)
      const task = { id: randomUUID(), ...(input.task && typeof input.task === "object" ? input.task : {}), status: "open" }
      const next = { ...team, tasks: [...(team.tasks ?? []), task] }; await storage.set(keyFor(scope, name), next); return task
    }, TEAM_TASK_INPUT),
    team_task_list: definition("team_task_list", async (input, toolContext) => {
      const scope = await scopeFor(toolContext); const name = teamName(input)
      return (await readTeam(keyFor(scope, name), name)).tasks ?? []
    }, TEAM_NAME_ONLY_INPUT),
    team_task_update: definition("team_task_update", async (input, toolContext) => {
      const scope = await scopeFor(toolContext)
      const name = teamName(input); const team = await readTeam(keyFor(scope, name), name); const task = input.task
      if (!task || typeof task !== "object" || typeof task.id !== "string") throw new Error("task.id is required")
      const tasks = (team.tasks ?? []).map((entry) => entry.id === task.id ? { ...entry, ...task } : entry)
      const next = { ...team, tasks }; await storage.set(keyFor(scope, name), next); return tasks.find((entry) => entry.id === task.id)
    }, TEAM_TASK_INPUT),
    team_task_get: definition("team_task_get", async (input, toolContext) => {
      const scope = await scopeFor(toolContext); const name = teamName(input)
      return (await readTeam(keyFor(scope, name), name)).tasks ?? []
    }, TEAM_NAME_ONLY_INPUT),
    team_status: definition("team_status", async (input, toolContext) => {
      const scope = await scopeFor(toolContext); const name = teamName(input)
      return await readTeam(keyFor(scope, name), name)
    }, TEAM_NAME_ONLY_INPUT),
    team_list: definition("team_list", async (_input, toolContext) => {
      const scope = await scopeFor(toolContext)
      return await sessionList(scope)
    }, TEAM_LIST_INPUT),
  }
}
