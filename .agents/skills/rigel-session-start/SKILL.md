---
name: rigel-session-start
description: Mandatory session bootstrap for any work in the Oh My Rigel repository, including requests that mention Oh My Rigel, Rigel, profiles/gabo, OpenCode V2, or the V2 laboratory. Invoke before commands, edits, tests, planning, or resumed work so the agent loads the permanent V1-protection and V2-isolation rules.
---

# Rigel session start

Use this skill before taking any project action. It applies again after context compaction, a long pause, or a resumed session when the mandatory rules may no longer be present in working context.

## Mandatory reading order

From the repository root, read `.omo/rules/protect-opencode-v1.md` completely. It is the single tracked, binding boundary file and MUST be present: if it is missing or unreadable, stop project work and report the missing path.

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
- Live tests resolve real divergences: where the documentation is silent or ambiguous, an authorized live test on NLS1 is the arbiter, not a guess.
- Every decision must map: V1 behavior -> official V2 API -> strategy -> observable test.
- Do not blind-replace a proven surface, and do not keep duplicated logic when an official V2 surface provides complete equivalence; verify equivalence before either choice.

This subsection adds a reading requirement only. It does not delete, weaken, or reorder the files above, and it does not relax the V1 boundary below.

## Binding boundary

Treat `.omo/rules/protect-opencode-v1.md` as an absolute safety constraint:

- V1 is production and must remain operational and unchanged.
- Docker and every container-based runner are prohibited for this project.
- All live validation runs only on NLS1, with a prior snapshot and a verified rollback. The isolated laboratory (`opencode-v2-lab.service`) is prohibited: it is not a live path and may not be used as a gate or as a substitute for NLS1.
- A temporary working directory, `--standalone`, a different port, or a V2 binary does not establish isolation.
- Never launch OpenCode until the complete `HOME`, XDG, goal-state, process, service, socket, port, plugin, and database separation required by the rule has been positively verified.
- Never invent a container, runner, subprocess, service, or fallback when NLS1 cannot execute a test.
- If isolation or compatibility is ambiguous, stop before execution and explain the exact uncertainty to Gabo.

This skill provides no authorization to repair, restart, inspect through a mutating interface, or otherwise touch V1. A separate, explicit, task-specific instruction from Gabo is required for any V1 operation.

## Continue the task

After loading the rules, continue the user's requested Oh My Rigel work without asking for ritual confirmation. State briefly that `rigel-session-start` was loaded and identify NLS1 as the only live validation surface before the first runtime experiment. Do not ask Gabo to choose Docker, a laboratory, or another runner.

For OpenCode QA, invoke the repository's `opencode-qa` skill as required by `AGENTS.md`; this bootstrap remains active alongside it.
