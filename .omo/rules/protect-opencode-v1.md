---
alwaysApply: true
description: Absolute isolation boundary protecting the user's production OpenCode V1 from all Oh My Rigel V2 development and experimentation.
---

# OpenCode V1 is untouchable

This is a mandatory safety boundary, not guidance. It overrides convenience, test shortcuts, inherited environment defaults, and an agent's assumption that an operation is harmless.

## Non-negotiable rule

All Oh My Rigel development, experimentation, probes, QA, migrations, plugin loading, agent tests, server launches, and OpenCode subprocesses MUST run exclusively inside the approved isolated OpenCode V2 environment.

For this project, Docker and every container-based runner are explicitly prohibited. Do not propose Docker, request permission to use Docker, fall back to Docker, or treat a container as the solution to an isolation problem. This prohibition remains in force until Gabo explicitly changes this rule.

OpenCode V1 is the user's production installation. Nothing performed for this repository may read, write, migrate, lock, truncate, replace, reload, restart, stop, inspect through a mutating API, or otherwise influence V1 state or processes.

Using a V2 binary does not prove isolation. A process is considered V2-safe only when its complete configuration, data, state, cache, home, plugin state, sockets, ports, and service identity are isolated from V1. If that isolation cannot be positively proven before execution, do not run the command.

## Protected V1 surfaces

Treat the following as production V1 and read-only unless Gabo gives an explicit, task-specific instruction to repair V1 itself:

- `~/.config/opencode/**`
- `~/.local/share/opencode/**`
- `~/.local/share/opencode-goal-plugin/**`
- `~/.cache/opencode/**`
- the live `~/.opencode/bin/opencode` process environment
- `opencode-lan.service` and every process, socket, port, database, plugin, or child process belonging to V1
- any default `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, or `XDG_CACHE_HOME` that resolves to the user's real home directories

Do not interpret this list as exhaustive. Any path or process that might be shared with V1 is protected.

## The only permitted live validation surface

Live validation for Oh My Rigel V2 happens only on **NLS1**: the real, installed Rigel V2 user
surface, deployed by a normal install (`profiles/gabo/rigel-v2-user-install.mjs`) and driven the way
a real user would drive it. There is no second approved live path.

Every live gate obeys all of the following:

1. A snapshot is taken **before** the change.
2. A rollback is **verified** after it.
3. The isolated V2 laboratory is **not** a live path: `opencode-v2-lab.service` is prohibited, and it
   may not be used as a live gate, as a substitute for NLS1, or as grounds for accepting a change.
4. Historical laboratory evidence may be kept as technical support, but it is never conclusive.
5. Repeating an old laboratory test does not replace a live demonstration: each change must show its
   own relevant observables on NLS1.

Docker and every container-based runner are prohibited for this project: do not propose Docker, ask
for permission to use it, fall back to it, or treat a container as the solution to an isolation
problem. `profiles/gabo/run-v2-isolated.sh`, the other container-based runners and
`profiles/gabo/apply-v2-runtime-service.sh` are historical or otherwise inapplicable to this rule;
Gabo may change this only with an explicit instruction.

Do not replace the NLS1 path with a direct `opencode run`, `opencode serve`, `opencode --standalone`,
a Node contract that spawns OpenCode as a subprocess, or any manually constructed process
environment. A test that cannot run on NLS1 must remain unexecuted and be reported as blocked: the
agent must not invent an alternative runner.

Before any OpenCode process is launched for an isolated probe, prove all of the following:

1. `HOME` is a disposable or dedicated V2 home, not the user's real home.
2. `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME` point only to the isolated V2 sandbox.
3. Goal/plugin state cannot resolve to `~/.local/share/opencode-goal-plugin` from the real home. Set `OPENCODE_GOAL_STATE_PATH` inside the sandbox when the goal plugin is present.
4. The process cannot address the V1 service, database, socket, port, configuration, cache, or plugin directories.
5. Cleanup is scoped to the V2 sandbox and cannot kill, restart, refresh, or remove V1 resources.

If any check is unknown, ambiguous, inherited, or unverified, STOP. Do not experiment first and inspect afterward.

## Forbidden actions

The following are prohibited even for a quick probe:

- Running Docker, Docker Compose, a containerized OpenCode runner, or any script that launches or requires a container.
- Offering Docker as a decision for Gabo, or proposing any runner or laboratory in place of NLS1, when the NLS1 surface already exists.
- Modifying a test merely to route it through Docker or another newly invented isolation mechanism.
- Launching an OpenCode child process with `{ ...process.env }` unless every home/XDG/state variable is overwritten with verified V2 sandbox paths.
- Running OpenCode from `/tmp` while retaining the real home or XDG directories. A temporary working directory is not isolation.
- Loading experimental plugins against the user's global OpenCode plugin or goal state.
- Testing state migrations, schema changes, plugin startup, shutdown, or recovery against V1 data.
- Changing a V1 file and planning to restore it later.
- Restarting or signaling every OpenCode process indiscriminately.
- Treating `--standalone`, a different working directory, a different port, or the V2 binary version as sufficient proof of isolation.
- Proceeding because a command is read-only when plugin startup or shutdown can still mutate shared state.

## Incident that created this rule

On 2026-10-03, an agent created a probe under `/tmp/opencode/probe` and launched another OpenCode process with the existing environment. The temporary working directory was isolated, but the process's data environment was not. It inherited the user's real home and global OpenCode state.

During that probe, shared goal state at `~/.local/share/opencode-goal-plugin/goals.json` changed from schema version 1 to schema version 2. The already-running V1 process still had a plugin implementation that accepted only schema version 1. Every subsequent prompt failed with:

```text
StateDecodeError
Expected 1, actual 2
```

The visible symptom was `Failed to send prompt` followed by `Unexpected server error`.

The repair was deliberately minimal and reversible:

1. Preserve a byte-identical backup of the damaged goal-state file.
2. Change only the top-level schema marker from version 2 back to version 1.
3. Verify that the objective, progress, session identifier, and all other state remained identical.
4. Leave the OpenCode session database untouched.

The production session recovered, but the incident was preventable. The mistake was not the probe's code; it was spawning a supposedly isolated OpenCode process without isolating every persistent state root.

## Required response to a boundary risk

If a requested test appears to require V1 access, do not improvise and do not weaken this rule. Report the exact dependency, explain why the approved V2 sandbox is insufficient, and wait for Gabo's explicit direction.

If a requested test appears to require Docker or any path other than NLS1, do not present alternative execution schemes. Stop before launching anything, report the exact incompatibility, and wait. The correct failure mode is a transparent blocked test, never a new container, subprocess, service, sandbox, or laboratory.

If any command unexpectedly touches a protected path or V1 process:

1. Stop the V2 experiment without signaling V1.
2. Make no further writes.
3. Preserve evidence from the isolated side only.
4. Report the exact command, resolved paths, process identity, and possible impact immediately.
5. Do not attempt an unrequested repair or cleanup against V1.

No experiment, deadline, convenience, or validation claim justifies risking V1. V1 must remain operational and unchanged at all times.
