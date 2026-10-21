# HANDOFF: user per-agent model selection reaches new delegations (Oh My Rigel V2)

- Worktree: `/home/gabodev/oh-my-rigel-worktrees/fix-v2-user-model-delegation`
- Branch: `fix/v2-user-model-delegation`
- Baseline: `404a629` (`origin/v2-mirror`, HEAD unchanged)
- Status: implemented, unit-tested, and demonstrated live on `opencode-v2-lab.service`. NOT committed, NOT pushed, no PR opened (no authorization).
- Bootstrap: `rigel-session-start` loaded; `protect-opencode-v1.md` read; runtime path is `opencode-v2-lab.service`; Docker not used; V1 not addressed.

## 1. Cause (what was actually broken)

The native V2 runtime resolves per-agent model overrides (`agentOverrides`) only from the **baked manifest** (`readNativeAgentOverrides(manifest)` at the single registration point, `profiles/gabo/opencode/rigel-v2-native.mjs`). That manifest is generated at refresh time from the **tracked** `profiles/gabo/omo.jsonc`, so a user edit to the live `~/.omo/omo.jsonc` never entered the registry: editing `agents.<id>.model` had no effect on a new delegation until a manifest rebuild (and the lab rebuild ignores the live file).

A second, non-obvious cause was found during the live gate (evidence: `01-context-probe.json`, `06/07/08`):

- The V2 plugin setup context exposes **no plugin `config`** (`hasConfig: false`, `configHasOmO: false`; domains are `agent, program, session, tool, event, storage, ...`). So the runtime's existing `context.config.*` reads are dead, and the on-disk `~/.omo/omo.jsonc` is the only live source.
- OpenCode V2 does **not** apply an agent's registered `Agent.Info.model` to a created session's request. With `explore` registered as `opencode-go/glm-5.3`, a delegated child still dispatched the OpenCode config default (`opencode-go/deepseek-v4.1-flash`). An explicit `Model.Ref` on `session.create`, by contrast, IS honoured. So a pinned model must be passed explicitly at the delegation or the child silently runs the host default.

## 2. Design (evidence-driven)

1. **Live read**: `readLiveAgentOverrides()` in `rigel-v2-native-config.mjs` resolves the live OmO config through the SAME authority the generator uses (`resolveNativePluginConfig`) and extracts the `agents` block. Resolution is anchored at the resolved `HOME` (mirroring the generator's `--directory <home>`). This keeps the read to the USER layer and stops the project-layer walk from escaping above the home: the host runs on Bun, where `os.userInfo().homedir` follows `$HOME`, so a session directory outside the home would otherwise load the real `~/.omo/omo.jsonc` as a project layer that wins.
2. **Merge**: `mergeAgentOverrides(base, live)` in `rigel-v2-native-explicit-chain.mjs` overlays the live overrides on the manifest's baked ones, keyed by canonical agent id, live wins per agent, inputs never mutated. The manifest stays the fallback.
3. **Single registration point**: `rigel-v2-native.mjs` computes `agentOverrides = mergeAgentOverrides(readNativeAgentOverrides(manifest), live)`; `buildExplicitAgentModels(agentOverrides)` feeds `resolveProactiveAgentModels` unchanged.
4. **Delegation pass**: `pinnedAgentModelRef(agentOverrides, agent)` returns the pinned agent's `Model.Ref` (or `undefined` for inheritance); both delegation sites pass `model: category?.model ?? pinnedAgentModelRef(...)` so a new child actually dispatches the chosen model. Never a raw string (`Model.Ref` or `undefined`).
5. **Clean install**: `rigel-v2-user-install.mjs` persists a durable, editable `<home>/.omo/omo.jsonc` (seeded once from the tracked profile with `__OMO_PROFILE_ROOT__` resolved, never overwriting an existing file) plus the Sisyphus prompt; the manifest builder now uses `<home>` as its profile root. Both files are tracked by the lifecycle transaction for a byte-identical rollback.

`registerNativeAgents` and `resolveProactiveAgentModels` are unchanged except that `modelRef` is now exported from `rigel-v2-native-agents.mjs` (the Model.Ref builder) for reuse.

## 3. Files changed (sha256 of final content)

| File | sha256 | Change |
|---|---|---|
| `profiles/gabo/opencode/rigel-v2-native-config.mjs` | `032cc4c7...` | `readAgentOverridesFromConfig`, `readLiveAgentOverrides`, `readNativeAgentOverrides` delegates |
| `profiles/gabo/opencode/rigel-v2-native-explicit-chain.mjs` | `4226ec27...` | `mergeAgentOverrides` (canonical keys, live wins, pure) |
| `profiles/gabo/opencode/rigel-v2-native-agents.mjs` | (export) | `modelRef` exported |
| `profiles/gabo/opencode/rigel-v2-native.mjs` | `c0adaa2e...` | live read + merge at the registration point; `buildExplicitAgentModels`; `pinnedAgentModelRef`; delegation pass |
| `profiles/gabo/rigel-v2-user-install.mjs` | `0ac0904f...` | persist editable `~/.omo/omo.jsonc` (+ prompt), transaction-tracked |
| `profiles/gabo/opencode/rigel-v2-native-config.test.mjs` | | reader + live-read + nested-dir isolation tests |
| `profiles/gabo/opencode/rigel-v2-native-explicit-chain.test.mjs` | | `mergeAgentOverrides` tests |
| `profiles/gabo/opencode/rigel-v2-native-runtime.test.mjs` | | live→Model.Ref, malformed fallback, `pinnedAgentModelRef` tests |
| `profiles/gabo/opencode/rigel-v2-native-core.test.mjs` | | `session.create` gets a Model.Ref / omits it for inheritance |
| `profiles/gabo/rigel-v2-user-install-config-bootstrap.test.mjs` | | clean install seeds `~/.omo/omo.jsonc`, preserves an edit |

`git diff --stat`: 10 files, +404 / -46. Full diff via `git diff` in the worktree.

## 4. Commands and results

- Focused tests (5 files): `bun test profiles/gabo/opencode/rigel-v2-native-{config,explicit-chain,agents,core,runtime}.test.mjs` -> `134 pass / 0 fail`.
- `node profiles/gabo/validate-profile.mjs` -> `gabo profile validation passed`.
- Relevant suite: `bun test profiles/gabo` -> `2304 pass / 0 fail` (154 files).
- Installer bootstrap tests: `bun test profiles/gabo/rigel-v2-user-install-{config-bootstrap,manifest}.test.mjs` -> green.
- Fault/mutation (`03-mutation.txt`): M1 invert merge order -> 3 fail; M2 `pinnedAgentModelRef` always undefined -> 1 fail; both restored byte-identically.

Evidence is under `.omo/evidence/20261011-v2-user-model-delegation/` (gitignored, never committed):

| File | sha256 | Content |
|---|---|---|
| `01-context-probe.json` | `4231cd2d...` | live setup-context probe: no `config` |
| `02-focused-tests.txt` | `3b11b1db...` | focused test run |
| `03-mutation.txt` | `ffa838e2...` | M1/M2 + byte-identical restore |
| `04-profile-suite.txt` | `da49a2ea...` | `bun test profiles/gabo` |
| `05-validate-profile.txt` | `2499a85e...` | validate-profile |
| `06-live-gate.txt` | `c8f4c72f...` | live pin -> registration (manifest fallback `{}`) |
| `07-live-delegation.txt` | `c9d9a842...` | pre-fix delegation (child = host default) |
| `08-live-delegation.txt` | `9ae9270e...` | post-fix delegation (child = chosen model) + negative control |

## 5. Live evidence (real gate on `opencode-v2-lab.service`)

Refresh only through `profiles/gabo/apply-v2-runtime-service.sh`; edit the lab live config at `$lab_home/.omo/omo.jsonc`; restart through `systemctl --user restart opencode-v2-lab.service` (no manifest rebake, so only the live read can supply the override). Manifest fallback was `agentOverrides = {}`.

Positive (live pin `explore = opencode-go/glm-5.3`):
- `GET /api/agent` -> `explore => {"id":"glm-5.3","providerID":"opencode-go"}`, while `librarian => qwen3.7-plus` and `oracle => gpt-5.6-sol` keep their fallback (isolating: the manifest had no override).
- Real delegation: parent (Sisyphus) called `rigel_task {subagent_type:"explore"}`; the child session is parent-linked, `agent:"explore"`, `model:{"id":"glm-5.3",...}`, and its assistant turn dispatched `{"id":"glm-5.3","providerID":"opencode-go"}`.

Negative control (live pin removed, restart):
- `explore` registered as its fallback `qwen3.7-plus`; the delegated child's model is absent and is NOT `glm-5.3`.

## 6. Limitations and residual risk

- The runtime live read is anchored at `HOME` (user layer only), matching the generator's `--directory <home>`. Project-level `.omo/omo.jsonc` layers are therefore not read at runtime. The runtime read no config at all before, so this is not a regression, but it is a deliberate scope choice.
- The install's manifest bake runs the V1 plugin pipeline with the provisioned profile as the directory, and OmO's config-migration engine appends a `_migrations` ledger to `~/.omo/omo.jsonc`. This is non-destructive (the user's edit survives; asserted in `rigel-v2-user-install-config-bootstrap.test.mjs`), but it means a reinstall rewrites the file rather than leaving it byte-identical.
- The host does not apply `Agent.Info.model` to a session request in this lab (the OpenCode config `model` default masks it). The fix passes the pinned `Model.Ref` explicitly at `session.create`, which the host honours. If a future host starts honouring `Agent.Info.model`, the explicit pass stays correct (it is the same value).
- Live QA ran exclusively through `opencode-v2-lab.service`; no Docker, no V1 access. Sessions created during QA were left in place (not deleted).

## 7. Git status

```
 M profiles/gabo/opencode/rigel-v2-native-agents.mjs
 M profiles/gabo/opencode/rigel-v2-native-config.mjs
 M profiles/gabo/opencode/rigel-v2-native-config.test.mjs
 M profiles/gabo/opencode/rigel-v2-native-core.test.mjs
 M profiles/gabo/opencode/rigel-v2-native-explicit-chain.mjs
 M profiles/gabo/opencode/rigel-v2-native-explicit-chain.test.mjs
 M profiles/gabo/opencode/rigel-v2-native-runtime.test.mjs
 M profiles/gabo/opencode/rigel-v2-native.mjs
 M profiles/gabo/rigel-v2-user-install-config-bootstrap.test.mjs
 M profiles/gabo/rigel-v2-user-install.mjs
```

Untracked by design: `HANDOFF.md` (this file), `.omo/evidence/**` (gitignored), `dist/`, `node_modules/`.

No commit, push, PR, or merge was performed.
