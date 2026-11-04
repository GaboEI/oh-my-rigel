---
alwaysApply: true
description: Mandatory V2 security boundary for Oh My Rigel work. Enforces sandboxed containment of every spawned process, proof before launch, one Rigel runtime per launch config, goal state inside its own state root, read-only treatment of the real user installation, reversible evidence, and fail-closed admission.
---

# Rigel V2 security boundary

This file keeps its historical filename, and a few modules keep a `V1`-prefixed identifier, because both are named after the real user installation they protect. No OpenCode V1 installation exists on the machines this project runs on. Every "protected surface" below means the real installation in use, whatever version it reports.

This is a mandatory boundary, not guidance. It overrides convenience, test shortcuts, inherited environment defaults, and any assumption that an operation is harmless.

The failure class is concrete: a probe that inherited the real `HOME` rewrote a shared goal-state file in place. The process already using that file could no longer decode it, and every prompt failed. Containment, not a second installation, was the missing control.

## 1. Contain every process

All Oh My Rigel development, experimentation, probes, QA, migrations, plugin loading, agent tests, server launches, and OpenCode subprocesses MUST run inside a disposable sandbox. Every spawned process gets a sandbox `HOME` plus `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME` that resolve inside that sandbox and nowhere else, and every state-bearing variable is stripped or rebuilt: the `XDG_`, `OPENCODE_`, `OMO_`, `SENPI_`, and `PI_` families, `OPENCODE_GOAL_STATE_PATH`, `RIGEL_V2_USER_ROOT`, and the agent-home selectors. Build that environment through `profiles/gabo/isolated-v2-env.mjs` instead of composing it by hand.

A V2 binary proves nothing. A process is safe only when its home, config, data, state, cache, plugin state, sockets, ports, and goal state all live inside the sandbox and cannot resolve to the real installation. If that cannot be proven before execution, do not run the command.

## 2. Prove isolation before launch

Run `profiles/gabo/isolation-proof.mjs` first and read its output. Do not launch until it reports `verdict=ISOLATED`, a clean `protected[...]` line for every root, `goal_state_is_production=false`, exactly one Rigel runtime in the launch config chain, and a goal state inside that runtime's own state root. A `verdict=UNSAFE` or any `REFUSED` line is a stop, not a warning.

## 3. One Rigel runtime per launch

Never hand the host a config chain that can load two Rigel runtimes. The host loads every declared plugin in one process, the first registration keeps the tool names and the prompt seams, and the newer runtime never executes, so the run proves nothing about the code it was meant to exercise. There is no safe partial mode: declare exactly one runtime, or stop.

## 4. Goal state stays inside its runtime

`OPENCODE_GOAL_STATE_PATH` must resolve inside the state root of the runtime the launch actually loads, normally `<stateRoot>/goal-state/goals.json`. Leave it unset when the runtime can derive its own root and let the runtime install its default. Never point it at the real user's goal file, and never let it escape the runtime's root: the plugin then fails closed, loads with zero registrations, and the session looks isolated while no tool exists. A mismatch is an environment defect to fix, never a result to record.

## 5. The real user installation is read-only

Nothing done for this repository may write, migrate, lock, truncate, replace, reload, restart, stop, or inspect through a mutating API anything that belongs to the real user installation. Treat these as read-only:

- `~/.config/opencode/**`
- `~/.local/share/opencode/**`
- `~/.local/share/opencode-goal-plugin/**`
- `~/.cache/opencode/**`
- the environment of the live `~/.opencode/bin/opencode` process, and the service that starts it
- any default `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, or `XDG_CACHE_HOME` that resolves to the user's real home directories

The list is not exhaustive. Any path, process, socket, port, database, or plugin state that might be shared with the real installation is protected.

## 6. Evidence stays reversible

Every change against a live surface carries all three:

1. A snapshot taken before the change.
2. A rollback verified after it.
3. A hash for every artifact you rely on.

Each change shows its own observables. An earlier run or a related test does not stand in for the behavior you just changed.

## 7. Fail closed

If any check is unknown, ambiguous, inherited, or unverified, STOP. Do not experiment first and inspect afterward. The safe outcome is an unexecuted test reported with its exact reason, never a guessed environment.

## 8. Cleanup stays inside the sandbox

Scope every stop, restart, kill, refresh, and removal to the sandbox this run created. Cleanup must be unable to signal, restart, refresh, or delete anything outside it, and must never sweep every process that shares a binary name.

## Forbidden actions

- Launching an OpenCode child process with `{ ...process.env }` unless every home, XDG, and state variable is overwritten with verified sandbox paths.
- Running OpenCode from a temporary working directory while keeping the real home or XDG roots. A work directory is not an isolation boundary.
- Loading experimental plugins against the real installation's plugin or goal state.
- Running a state migration, schema change, plugin startup, shutdown, or recovery against the real installation's data.
- Treating `--standalone`, a different working directory, a different port, or a different binary version as proof of isolation.
- Proceeding because a command looks read-only when plugin startup or shutdown can still mutate shared state.
- Changing a file outside the sandbox and planning to restore it later.

## When a boundary is at risk

If a command unexpectedly touches a protected path or a process outside the sandbox:

1. Stop the sandboxed work without signaling anything outside it.
2. Make no further writes.
3. Preserve evidence from the sandboxed side only.
4. Report the exact command, resolved paths, process identity, and possible impact immediately.
5. Do not attempt an unrequested repair or cleanup outside your own sandbox.

If a requested test seems to need the real installation, do not improvise and do not weaken this rule. Report the exact dependency and why the sandbox is insufficient.

No experiment, deadline, convenience, or validation claim justifies risking the real live installation.
