---
name: rigel-session-start
description: Mandatory session bootstrap for any work in the Oh My Rigel repository, including requests that mention Oh My Rigel, Rigel, profiles/gabo, OpenCode V2, or the installed V2 surface. Invoke before commands, edits, tests, planning, or resumed work so the agent loads the permanent V2 security boundary before acting.
---

# Rigel session start

Use this skill before taking any project action. It applies again after context compaction, a long pause, or a resumed session when the mandatory rules may no longer be present in working context.

## Mandatory reading order

From the repository root, read `.omo/rules/protect-opencode-v1.md` completely. It is the single tracked boundary file, and its filename is historical: the boundary it states is the V2 one. If you cannot read it, say so in one line and keep working under the root `AGENTS.md` boundary. An unreadable file is a checkout problem to report, never a reason to stop the session.

Also read these operator-local files when they exist, because they may carry per-operator instructions:

1. `AGENTS.rigel.md`
2. `.omo/rules/rigel.md`

Both are operator-local and gitignored by design, so their absence is normal and is NOT a blocker: the binding boundary is fully carried by `protect-opencode-v1.md` and the root `AGENTS.md`. Do not stop, and do not report a missing path, merely because an operator-local file is absent, and never invent or recreate one.

Also obey the root `AGENTS.md` and every more-specific `AGENTS.md` governing files in scope. If the task will launch, test, configure, refresh, or inspect an OpenCode runtime, read `profiles/gabo/README.md` before acting.

Do not delegate this reading. Do not rely on a summary from another agent or an earlier session.

## Mandatory V1 -> V2 migration reading (binding)

Any work that designs, implements, or audits a V1 -> V2 migration surface MUST read the official OpenCode V2 guides before designing, implementing, or auditing, in this order:

1. https://opencode.ai/v2/docs/migrate-v1/
2. https://opencode.ai/v2/docs/build/plugins/migrate-v1
3. When the surface requires it, the plugin context API and the server API:
   - https://opencode.ai/v2/docs/build/plugins
   - https://opencode.ai/v2/docs/api

These are permanent mandatory reading, not one-task evidence. Do not delegate them.

Rules that bind every migration decision:

- The official documentation PRECEDES inferences, decompilation, or an earlier session's assumptions. When the docs contradict a prior inference, the docs win and the migration inventory/ledger must be updated to record the correction.
- Live tests resolve real divergences: where the documentation is silent or ambiguous, an authorized live test on the installed V2 surface is the arbiter, not a guess.
- Every decision must map: V1 behavior -> official V2 API -> strategy -> observable test.
- Do not blind-replace a proven surface, and do not keep duplicated logic when an official V2 surface provides complete equivalence; verify equivalence before either choice.

This subsection adds a reading requirement only. It does not delete, weaken, or reorder the files above, and it does not relax the V2 boundary below.

## Binding boundary

Treat `.omo/rules/protect-opencode-v1.md` as an absolute safety constraint. Its filename is historical; the boundary it states is the one that applies:

- Every OpenCode process you spawn gets a disposable sandbox with its own `HOME` and XDG roots, built through `profiles/gabo/isolated-v2-env.mjs` instead of composed by hand.
- `profiles/gabo/isolation-proof.mjs` must report `verdict=ISOLATED` before you launch anything. `verdict=UNSAFE` or any `REFUSED` line is a stop, not a warning.
- Exactly one Rigel runtime per launch config. Two declared runtimes mean the first one silently keeps the tool names and the run proves nothing about the code it was meant to exercise.
- `OPENCODE_GOAL_STATE_PATH` resolves inside the state root of the runtime the launch actually loads, never at the real installation's goal file.
- The real user installation is read-only: no writes, migrations, locks, reloads, restarts, or mutating inspection.
- Every live change carries a snapshot taken before it, a verified rollback after it, and a hash for each artifact you rely on.
- Cleanup is scoped to the sandbox the run created, and never sweeps every process that shares a binary name.
- If isolation or compatibility is ambiguous, stop before execution and explain the exact uncertainty to Gabo.

This skill provides no authorization to repair, restart, or inspect the real installation through a mutating interface. A separate, explicit, task-specific instruction from Gabo is required for any operation against it.

## Live validation: validate hard, leave nothing behind

Live validation runs against a V2 user surface that `profiles/gabo/rigel-v2-user-install.mjs`
installs inside the sandbox the boundary above requires, named explicitly on every invocation
(`--home <sandbox-home> --state <sandbox-home>/oh-my-rigel --config
<sandbox-home>/.config/opencode/opencode.json`), and driven the way a real user drives it. On that
sandboxed surface you have standing authorization for the full operating loop, without asking per
action: install, uninstall, reinstall, run real sessions with real agents, break things, fix them,
make local commits, and take the technical decisions the work needs. A live run costs provider
budget, so spend it on observables rather than on blind endurance runs.

That authorization ends at the sandbox. It never covers the host or the real user installation: no
writes, reloads, restarts, stops, or service restarts against either, and no machine reboot. If the
sandbox is saturated or wedged, discard it and build a fresh one inside the boundary's own cleanup
scope. A restart or reboot that would reach anything outside the sandbox is not authorized by this
skill and needs a separate, explicit, task-specific instruction from Gabo.

The single condition on that authorization is that the validated surface is not a landfill. It
exists to be used and validated thoroughly, not to accumulate:

- A snapshot is a rollback point for the CURRENT operation, not a history. Taking a new one supersedes
  the previous: delete the old one in the same breath. If you validate at 14:00 and then validate
  something else at 15:00, the 14:00 snapshot is garbage. The 15:00 one is the only one that can
  still restore you. A chain of dated copies is not extra safety, it is unexamined clutter.
- Keep ONE evidence set per change you actually validated, and keep it on the development host under
  `.omo/evidence/`. Evidence is a small text record, not a state archive: no tarballs of the whole
  install, no mirrored copy on the validated machine, no second directory.
- Clean up what you created once the change is validated or abandoned: version directories from
  failed installs, temporary checkouts, test sandboxes, orphaned worktrees, probe files, model or
  package caches you triggered.
- Deleting gigabytes a run produced is part of finishing the job, not optional housekeeping.

A validation that leaves the environment heavier than it found it is an incomplete validation.

## Continue the task

After loading the rules, continue the user's requested Oh My Rigel work without asking for ritual confirmation. State briefly that `rigel-session-start` was loaded and name the installed V2 surface you will validate against before the first runtime experiment. Then continue; do not stop to negotiate which environment to use.

For OpenCode QA, invoke the repository's `opencode-qa` skill as required by `AGENTS.md`; this bootstrap remains active alongside it.
