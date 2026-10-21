---
name: team-mode
description: Run and manage a Rigel V2 team: a lead plus coordinated member sessions created by team_create. Use when the user asks to build a team, run a team, work in parallel with several teammates, spawn coordinated agents, delegate a multi-part job across members, or use /team-mode. Also use before calling team_create, team_task_create, team_send_message, team_shutdown_request or team_delete, to get the exact argument contract. Do NOT use for a single delegated subtask, for a one-off research question, or for background work that needs no coordination.
---

# Team Mode Skill

Team Mode runs a **lead** plus **member sessions** that work as coordinated
sessions. The lead orchestrates; members execute; the runtime keeps the shared
state (members, tasks, messages, status).

This runtime has **exactly one create API**. There is no second shape to fall back
to, and no compatibility layer to an upstream one.

## The contract

```text
team_create({
  team_name: string,                     // required; the record key scoped to this project
                                         // (deprecated alias: `name` — same identifier)
  members: [{
    name: string,                        // required; unique inside the team
    agent?: string,                      //     exactly one of agent | category
    subagent_type?: string,              //     alias of agent (the rigel_task spelling)
    category?: string,                   //     exactly one of agent | category
    prompt?: string,                     // required per spawned member; its assignment
    model?: string,                      // optional model override
    sessionID?: string                   // adopt an EXISTING session instead of spawning
  }],
  worktree?: boolean                     // omitted = legacy default (per-member worktree
                                         //   when the project has a manager); false = shared tree
})
```

Rules the runtime enforces **before any side effect**:

- `team_name` is the canonical spelling, and is what `/team-mode` emits. `name` is
  still accepted as a **deprecated alias** for the same identifier: the pre-row-55
  contract read `input.team_name ?? input.name`. The two may be given together only
  when they name the same team; disagreeing values are rejected **before any side
  effect**.
- Exactly one of `agent` or `category` per member that must be spawned. Both, or
  neither, is an error. Members that adopt a `sessionID` are exempt.
- Every spawned member needs a non-empty `prompt`; that text starts the member's
  first turn.
- Member names are unique.
- At most 8 members.

### The upstream shape is NOT this API

`inline_spec`, `teamName`, `lead`, `leadAgentId`, `sessionGroups`, `loadSkills`,
`teamAllowedPaths` and `sessionPermission` belong to the upstream OmO tool tree
(`packages/omo-opencode/src/features/team-mode/tools/`), which the V2 native module
graph cannot reach. Passing one is rejected **by name** with an actionable message,
and nothing is created. Never mix the two shapes.

The lowercase `name` key is **not** that upstream `teamName`: it is this runtime's
own deprecated alias for `team_name`, and it is accepted. Upstream `teamName`
(camelCase) stays rejected.

## Why members are real sessions

Every member without a `sessionID` becomes a **real delegated child session**,
with `parentID` set to the lead. That is what makes Team Mode visible: pane
discovery is `session.created`-driven, so a member with a real session gets its own
tmux pane. A member recorded without a session is bookkeeping only and can never
show a pane.

Spawns are strictly **sequential**, and each member's `sessionID` is persisted
before the next spawn starts, so a crash leaves at most a `binding` record with
partial session ids — never a phantom active team. If a spawn fails, the create
rolls back: it terminates **only the sessions this create spawned** (an adopted
`sessionID` is never terminated, not even here), reclaims any worktrees, and then
drops the record — unless a spawned session could not be terminated, in which case
a recoverable `cleanup-failed` record is **kept** carrying the remaining owned
session ids, so a later `team_delete` can finish the teardown.

### Worktrees

`worktree` keeps the **legacy default**: omit it and the create provisions a
per-member git worktree whenever the project has a worktree manager, exactly as the
pre-row-55 direct tool did. Pass `worktree: false` to share one working tree — which
is what pane discovery needs, because panes match an exact `pane_current_path` — and
`worktree: true` to require worktrees. `/team-mode` never relies on that default: it
always emits an explicit boolean, and asks the user when the policy is not stated.

### Member panes

A member's pane is marked **persistent**: it is expected to sit idle between turns,
so the runtime does not recycle it on idle stability or on the hard pane age
timeout. It still closes when the session genuinely disappears, and on deletion.

## Lifecycle

1. **Create** — `team_create`. The team starts `binding` and becomes `active`.
2. **Assign work** — `team_task_create({ team_name, task })`, then
   `team_task_list({ team_name })` / `team_task_get` / `team_task_update`.
3. **Talk to members** — `team_send_message({ team_name, to, message })`. `to` is a
   member name or `"lead"`.
4. **Observe** — `team_status({ team_name })` returns members, messages and tasks.
   `team_list()` lists every known team.
5. **Wind down** — `team_shutdown_request({ team_name })`; a member approves with
   `team_approve_shutdown`, or the lead approves on their behalf. `team_reject_shutdown`
   cancels a pending request.
6. **Delete** — `team_delete({ team_name })`. Deletion terminates **only the sessions
   this team spawned** (that is what closes their panes) and **verifies** each close
   BEFORE any worktree is reclaimed: a member worktree is that session's working
   directory, so it is released only when the team can PROVE the session no longer
   uses it. A session adopted from elsewhere is **detached, never deleted** — and so
   is a record written before ownership existed — a session the team cannot PROVE it
   spawned is never deleted, and `sessionsDetached` reports it; its worktree is
   reclaimed only after that foreign session was moved out of it AND the move was
   verified, and otherwise the directory is preserved and the record is kept. The
   stored record is removed **last**. If an owned session cannot be terminated, the
   call keeps the record with retry state (`cleanupPending`), reports
   `sessionsFailed`, and returns `deleted: false` — call `team_delete` again to
   finish. `sessionsTerminated` lists **only proven** closes: a deletion that
   resolved but could not be *verified* is reported in `sessionsUnverified` with a
   warning, never presented as a verified close — and because the absence was never
   proven, its working directory is PRESERVED and the record is KEPT, so call
   `team_delete` again once the absence can be proven. A host that rejects deleting
   an already-gone session is not a failure either: when the presence probe proves
   the session is absent, the close is a verified deletion.

A startup reconciliation never strands a live member: a team record that still
**owns** a session — or that still keeps a working directory which could not be
released — is not reclaimed by the worktree sweep, even when it is stale: it is
kept as retry state for `team_delete`. On a non-git root, per-member
worktrees are impossible, so `team_create` fails loudly. That failure does not
authorise a policy change: switching `worktree: true` to `worktree: false` is the
user's decision, so report the failure and ask the user to confirm explicitly
before trying again.

## The `/team-mode` command

`/team-mode <objective>` is the visible front door. It is deterministic: it parses
the objective and then either asks or creates.

- If member roles, their categories, or the worktree policy are **missing**, it asks
  only those questions and **creates nothing**.
- If the definition is **complete**, it creates the team directly through the same
  `team_create` contract.
- `cancel` (or `stop`, `abort`, `quit`, `none`, `never mind`) creates nothing.
- An unknown category, a member count that contradicts the named roles, a team of
  one, duplicate names, or an upstream field is **rejected before any side effect**.

The explicit shape it recognizes:

```text
/team-mode <objective>. team: <team-name>. members: scout=quick "map the auth paths", builder=unspecified-low "write the missing tests". worktree: no
```

Unquoted roles still declare a member, but leave that member's assignment to the
objective text. `worktree: yes` opts into per-member worktrees; `worktree: no`
shares one tree.

## What good team work looks like

- Decide the roster from the actual work, and give each member a self-contained,
  verifiable assignment.
- Create the team once, then drive it with tasks and messages; do not re-create it
  to change the plan.
- Check `team_status` before assuming a member finished.
- Delete the team when the work is done, so member sessions and panes are released.
