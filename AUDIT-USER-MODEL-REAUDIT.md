# AUDIT-USER-MODEL-REAUDIT.md

Independent, no-code-change re-audit of the per-agent model configuration in Oh My Rigel V2 **after the P2/P3 cleanup**, performed from zero without trusting any prior audit.

- Worktree: `/home/gabodev/oh-my-rigel-worktrees/fix-v2-user-model-delegation`
- Branch: `fix/v2-user-model-delegation`; HEAD `404a6290134d1704bb44eff7c092c161770f49e2` (unchanged; no commit/push/PR)
- Baseline: `404a629`
- Contract: `CONTRACT-ADDENDUM-MODEL-FALLBACKS.md` (confirmed) + the re-audit prompt `model-reaudit-prompt.txt`
- Runtime path: `opencode-v2-lab.service` (isolated). V1 was never addressed, read, or written. No Docker. The main checkout and production secrets were not touched.
- Method: read `.omo/rules/protect-opencode-v1.md`, the contract, `HANDOFF.md`, `AUDIT-USER-MODEL-FINAL.md`, and `.omo/evidence/20261012-v2-user-model-cleanup/00-cleanup.md` in full; read the entire working-tree diff vs `404a629` hunk by hunk including `V2_MIGRATION_INVENTORY.md`, `migration-classifications/tools.mjs`, and the modified V1 protectors; read every changed source and test and the new `/rmo-models` module + test; re-ran the focused and full suites, `validate-profile`, the V1-protector and migration-inventory suites, and the read-only lab acceptance; independently reproduced the live-read path against the **real** tracked profile shape; verified the recorded live child sessions in the lab `session_v2` table and their dispatched models; audited the evidence bundle checksums and ran a secret scan; injected two mutations into a copy and restored them byte-identically; recomputed the V1 digest twice.
- No implementation file was edited. `git status` and `HEAD` are unchanged by this audit.

## Verdict: PASS

The implementation matches the confirmed contract, the declared seam is narrow and additive, every mandatory suite and gate passes with primary evidence, the previously defective evidence items (incomplete checksum file, volatile V1 digest) are corrected, the recorded live children are real and independently verifiable in the isolated lab database, the mutation controls prove the tests bite while restoring byte-identically, and V1 is intact with the lab restored. Only P2/P3 observations remain; none blocks the contract's PASS condition.

## Findings

### P0 (blocking): none

### P1 (blocking): none

### P2 (non-blocking, recommend addressing)

- **P2-1 — Ctrl+X M session-locality has no direct host-driven test (host-owned keybind).**
  The contract's "Session-local override" clause requires that a Ctrl+X M selection is session-scoped, does not rewrite `~/.omo/omo.jsonc`, does not affect other sessions, and that a new session returns to the JSON config. Ctrl+X M is a **host** keybind (`model.list`) that the host stores per session; the plugin's share of the contract is to stay read-only over `~/.omo/omo.jsonc` and to register **no** model when the JSON config is empty, so the host selection wins for that session. The strongest non-host-simulating evidence is present: the new focused test `#when the live config is read #then the runtime path never writes it` (bytes + mtime + directory listing unchanged), and my independent reproduction of it (`09-live-read-shape.txt`: `read-only: true true true`). A direct keybind test would exercise the host, not this change, so this is the correct ceiling. Not blocking.

### P3 (minor, cosmetic/hygiene)

- **P3-1 — Two residual stale comments in `rigel-v2-native-config.mjs` that the P3-2 cleanup missed.**
  `profiles/gabo/opencode/rigel-v2-native-config.mjs:868-869` still says the raw `agents` block is "carried so the generator can materialize the per-agent 'explicit model' overrides into the manifest" (the generator no longer does), and `:1032` says "the runtime never parses omo.jsonc itself" (the runtime now does, via `readLiveAgentOverridesSource`). The P3-2 cleanup corrected `migration-classifications/tools.mjs` + `V2_MIGRATION_INVENTORY.md` but not these comments. Documentation drift only; no code consumer; no behavior.
- **P3-2 — `VOLATILE_PROTECTED_FILES` narrows the V1 protector's detection surface.**
  `profiles/gabo/v1-protected-surfaces.mjs` now marks `.local/share/opencode/auth.json` and `mcp-auth.json` as `"volatile"`: their **presence/absence** is still reported (added/removed), but their **content** is no longer hashed. This makes the cross-run digest reproducible (verified `c52d3165…` twice — `07-v1-digest-stability.txt`) and stops false drift from V1's token-refresh churn, at the cost that a hypothetical content mutation of those two credential files would not be detected by the digest. The installer never writes them, V1 remained unchanged within the run (`run-lab-acceptance.sh` PASS), and a new unit test pins presence-tracking + stability. Accepted trade-off; residual detection gap noted.
- **P3-3 — Upgrades do not propagate tracked-profile changes to an existing `~/.omo/omo.jsonc`.**
  `persistEditableProfile` seeds the durable profile only when the file is absent (`createdProfile`); a reinstall/upgrade reads the user's existing file (via `--profile-root home`) and never overwrites it. This is the contract's no-overwrite requirement, but it also means new non-model tracked-profile defaults only reach a clean install. Documented behavior; acceptable per the contract's explicit "must not silently overwrite" rule.
- **P3-4 — `/rmo-models` `execute` performs no write; the atomic-write helpers are library surface.**
  The command injects a guided instruction and reads the config read-only. `commitModelsEdit` / `writeModelsConfigAtomic` are exported and unit-tested (including a rename-failure boundary that leaves the target unchanged and no temp file), but the runtime does not invoke them; the actual on-disk edit is performed by the active agent with its own tools following the injected workflow. The atomic guarantee therefore depends on the agent honoring the instruction. Command-level tests cover registration, all 12 agent types, `disabled_commands`, empty session, lifecycle-API trapping, and a source scan proving no `restart/stop/kill/spawn` call shape. Not a defect; a design boundary worth stating.

## Gate table

| # | Contract requirement / gate | Result | Primary evidence |
|---|---|---|---|
| 1 | Manifest seeds product defaults only at install; afterwards `~/.omo/omo.jsonc` is the sole source of truth | PASS | `extractAgentOverrides` removed from `build-target-agent-manifest.mjs` and `generate-v2-agents.mjs`; install seeds once (`seedAgentProductDefaults`, clean-install only); bootstrap test `seeds each agent's product-default model from the generated manifest` |
| 2 | After install the manifest is NOT consulted for models (no runtime reader) | PASS | `readNativeAgentOverrides` deleted; runtime uses `readLiveAgentOverridesSource`; `grep` shows zero code consumers of removed symbols; lab runtime manifests carry 0 `agentOverrides` (`02-git.../diff`, live check) |
| 3 | Full per-agent schema, ordered chains, variants, adjacent/unknown fields preserved | PASS | `normalizeAgentOverrideEntry` full shallow copy + `models[]` decomposition; verified end-to-end through the real live-read boundary (`17-field-preservation.txt`: `temperature/description/reasoning` survive, `models[0]`→`model`(+`variant`), rest→`fallback_models`) |
| 4 | Reinstall/upgrade never overwrites the user's choices | PASS | `persistEditableProfile` seeds only when file absent; bootstrap test `a later install preserves the user's live model selection`; profile file is in the lifecycle transaction (`transactionFiles` includes `omoProfileFile`, `omoPromptFile`) |
| 5 | Empty config inherits the OpenCode global | PASS | `chainFallback:false` yields no ref; `delete agent.model`; unit test `chainFallback:false leaves agent.model absent`; live Case A/C (`explore: <none: inherit>`; child on host global) |
| 6 | Ordered candidates attempted in order; exhaustion fails without manifest fallback | PASS | Reader decomposes `models[]`→`model`+`fallback_models`; `resolveEffectiveChain` consumes `fallback_models`; `resolveProactiveAgentModels` JSON-only branch; agent/explicit-chain/core tests |
| 7 | Ctrl+X M selection is session-local (plugin read-only; new session resets) | PASS (indirect) | Focused read-only test (bytes+mtime+dir unchanged) + my independent reproduction (`09-live-read-shape.txt`); empty config registers no model so the host selection wins. See P2-1 |
| 8 | Secondary agents use their JSON config + ordered fallback chain | PASS | Child receives JSON primary `Model.Ref` (sync `:1436`, background `:1460`) or omits it; `pinnedAgentModelRef` canonicalizes via `agentOverrideFor`; core test `forwards a pinned Model.Ref … omits it for an inherited agent model` |
| 9 | OpenAI-only agent (hephaestus) disappears when config is wrong/absent/non-OpenAI, without harming the app | PASS | `gateDefinition = { ...source, model: undefined }` + JSON-only candidate; `evaluateHephaestusGate` reads only `model` then definition (stripped); live D1 (anthropic→ABSENT)/D2 (openai→PRESENT); unit tests for GPT / non-GPT / no-model |
| 10 | `/rmo-models` is a command (not a skill), from every agent, guided, atomic, validating, preserving, cancel/no-op safe, never restarts/kills, shows only a supported reload | PASS | Registered via `ctx.command.transform`; `execute` only reads + injects via `context.session.prompt`; `MODELS_RELOAD_COMMANDS` = only `opencode reload` + `opencode service restart` (no `server reset`); lifecycle-trap test; all-12-agent-types test; `disabled_commands` honored; source scan for lifecycle call shapes |
| 11 | No regression in delegation, orchestration, routing, prompts, categories, permissions, continuity, background handoff, non-explicit selection, Sisyphus, unaffected agents | PASS | Full `bun test profiles/gabo` **2344/0** across 155 files; diff confined to the 17 listed files; categories/permissions/delegation/background-handoff/continuity/no-sisyphus-gpt/routing/prompts suites untouched and green |
| 12 | Sync + background delegation | PASS | Both call sites `model: category?.model ?? pinnedAgentModelRef(...)`; `modelKey: preSpawnModelKey(category, agent, agentOverrides)`; core test pins sync + background |
| 13 | Real child sessions (positive and negative) | PASS | Lab `session_v2` contains `ses_ed2f80381ffen4pbEe1Sx7ZEGI` (agent=explore, model=glm-5.3) and `ses_ed2f77956ffeOoeWBqRHQvvMkP` (agent=explore, model=null → dispatched `deepseek-v4.1-flash`), each with a real Sisyphus parent; assistant models re-read from `session_message`. `15-real-children.txt` |
| 14 | Focused suite (6 files) | PASS | `172 pass / 0 fail` (`01-focused-6.txt`) |
| 15 | Full suite `bun test profiles/gabo` | PASS | `2344 pass / 0 fail`, 155 files (`05-full-profiles-gabo.txt`) |
| 16 | `validate-profile` | PASS | `gabo profile validation passed` (`02-validate-profile.txt`) |
| 17 | V1 protected-surfaces suite | PASS | `11 pass / 0 fail` including the new volatile-stability test (`03-v1-protected-surfaces.txt`) |
| 18 | Migration inventory suite | PASS | `11 pass / 0 fail` (`04-migration-inventory.txt`) |
| 19 | Read-only lab acceptance; V1 intact; lab restored | PASS | `run-lab-acceptance.sh` **28/28 PASS**; `V1 config hash unchanged: PASS`; `V1 protected surfaces unchanged: PASS`; `goal invariant (internal): PASS`; unit active; live `~/.local/share/opencode-v2-lab/home/.omo/omo.jsonc` **absent** (`06`, `08`) |
| 20 | V1 digest reproducible across runs | PASS | `c52d31658177c21ddfbc53d5a5018dcca636a290e58c1a282e6b05b64e25f3b6` twice (`07`) |
| 21 | Evidence bundle checksums complete and valid | PASS | `.omo/evidence/20261012-v2-user-model-live/SHA256SUMS.txt` 13 entries incl `00-pre-v1-manifest.json`; `sha256sum -c` 13/13 OK (`13`) |
| 22 | No secrets in evidence | PASS | Targeted scan of baseline/matrix/live/cleanup/reaudit: no matches after benign filtering (`14`) |
| 23 | Mutation M1 (disable JSON-only short-circuit) fails the suite, restores byte-identically | PASS | 4 fail in agents suite; sha256 restored `63b5af1a…` (`10`) |
| 24 | Mutation M2 (flatten `normalizeAgentOverrideEntry`) fails the suite, restores byte-identically | PASS | 5 fail in config suite; sha256 restored `bf00b07a…` (`11`) |
| 25 | Audited revision unchanged (no audit mutation) | PASS | `git status` identical pre/post; `HEAD` `404a629…`; `git diff --stat 404a629` = 17 files, +857/−128 (`12`) |

## Cleanup-specific re-checks (introduced no observable change)

| Cleanup item | Result | Note |
|---|---|---|
| P3-1 `preSpawnModelKey` unused `manifestRef` removed | PASS | Signature now `(category, agent, agentOverrides)`; the only runtime call site passes 3 args; test updated; behavior unchanged (empty for an agent with no JSON model) |
| P3-2 stale prose in `migration-classifications/tools.mjs` + `V2_MIGRATION_INVENTORY.md` | PASS (residual) | The named `readNativeAgentOverrides` drift is gone and the ledger reports JSON-only + `resolveAuthoritativeAgentOverrides`/`readLiveAgentOverridesSource`; two other stale comments remain in `rigel-v2-native-config.mjs` (P3-1) |
| P3-3 checksum `00-pre-v1-manifest` | PASS | SHA256SUMS now 13 entries; all OK |
| P3-4 V1 comparison without volatile auth | PASS | Volatile auth presence-tracked, not content-hashed; digest stable twice; removal still detected by the new test |
| P3-5 two-step model assignment | PASS | Kept with an explanatory comment; `applyLegacyAgentDefinition`'s exported behavior (sets `agent.model`, derives the frontier permission) is unchanged |

## Independent verification performed by this audit

- Full diff vs `404a629` read hunk by hunk (17 files, +857/−128) plus both new `/rmo-models` files.
- Focused suite: `172 pass / 0 fail` across 6 files.
- Full suite: `2344 pass / 0 fail` across 155 files (33.2 s).
- `node profiles/gabo/validate-profile.mjs`: `gabo profile validation passed`.
- `run-lab-acceptance.sh` (read-only): `28/28 PASS`; V1 config hash + protected-surfaces digest unchanged within-run; goal invariant held.
- V1 protected digest recomputed twice: `c52d31658177c21ddfbc53d5a5018dcca636a290e58c1a282e6b05b64e25f3b6` (stable).
- Lab: `opencode-v2-lab.service` active; live `~/.local/share/opencode-v2-lab/home/.omo/omo.jsonc` absent; lab DB (`data/opencode/opencode.db`) is a separate inode from V1's DB and no bind mount exists (both on the same ext4 fs, no separate mount); lab `session_v2` max time `2026-10-11T22:14:55Z` = QA time.
- Real children re-read from `session_v2` + `session_message`: B → `glm-5.3`, C → `deepseek-v4.1-flash`.
- Live-read shape reproduced against the **real** `profiles/gabo/omo.jsonc` (placeholder resolved, seeded top-level `agents`): `state=loaded` with and without `OMO_PROFILE=gabo`; absent → `absent`; malformed → `error` (overrides undefined); read-only → bytes/mtime/dir unchanged.
- Field preservation through the real `resolveNativePluginConfig`→`readAgentOverridesFromConfig` boundary (`17`).
- Evidence bundle: `sha256sum -c` 13/13 OK; secret scan clean.
- Mutations M1/M2 with byte-identical restore and a post-restore sha256 match.

## Residual risks / limitations

- P2-1 (Ctrl+X M coverage) and the P3 items above.
- Model fallback on a live forced provider failure is exercised by unit tests of `resolveProactiveAgentModels` / `resolveEffectiveChain`, not by a live exhaustion run; a live exhaustion test would strengthen coverage but is not required by the contract, and the re-audit is read-only over the lab (no live child creation was performed by this audit — it verified the existing recorded real children).
- The install seeding writes the durable `~/.omo/omo.jsonc` in the target home; on a real install this is the user's home (intended) and it is transaction-tracked for byte-identical rollback (verified by the lifecycle/bootstrap contracts).

## Evidence index (local, gitignored, never committed)

Re-audit bundle `.omo/evidence/20261012-v2-user-model-reaudit/`:

| File | sha256 |
|---|---|
| `01-focused-6.txt` | `75c9cf6efe49a06f75e815fe8ee727e1498fb8fd1735931278baee1f8b3ead0b` |
| `02-validate-profile.txt` | `40f5d70946e9a6d59b78c08a45b2b894c0b08984eca61cf32fa567973c47ce24` |
| `03-v1-protected-surfaces.txt` | `8abd193b1570d59bd98e2c448180d4888c21683c7016d54dcccaa2846ee87ae8` |
| `04-migration-inventory.txt` | `2b4d27c751ad19a48a1c164b628c39a48301079b7bce33778a0a761e1ec08f0e` |
| `05-full-profiles-gabo.txt` | `ce32ad03c176532fb09e6f6e933265f3d44cf26a4ef6e58a5af71a212ecf696b` |
| `06-lab-acceptance.txt` | `30755a3078adcff768f13d3fbb34b9b49433e862a8550ed88fafee24cfe190e6` |
| `07-v1-digest-stability.txt` | `262bf0cacec7d59ef73c274d897989fa73e8cf2c34de47fccbc8f0951f50dca6` |
| `08-lab-state.txt` | `f8b043cd620da3f06eeba86fefae83f3ae99363a1d715b131901f70167e9fd45` |
| `09-live-read-shape.txt` | `2d28ff897984a2463e4ecddebdc62ee4be7c525dc1ac31c8e9d29907cdee7183` |
| `10-mutation-M1.txt` | `b8cc4ef31a52d11995a9257a03e8396449231b83b1f72abb4b1a1a5c7ddf8c42` |
| `11-mutation-M2.txt` | `d5d698f86f1bf381e1f4c8efdfe3b542fc9d79faa89cdd22ee38e66d3798f16f` |
| `12-tree-integrity.txt` | `1f16979f8398da892527a55868ae0e754e77c488393d7494ebb0c5abb8ee0eae` |
| `13-live-evidence-checksums.txt` | `597254423446d72cf92b73bb32b84044c986b257d4025eb0d6afd926bf3c74d4` |
| `14-secret-scan.txt` | `ed9d79f0e7bbb66eaa6c2cf7a18a457d0f65e93f185a8676375917eed53a4a9e` |
| `15-real-children.txt` | `633d0e1de2d4e9a1138b9ef40a82de4ffd82c1998330941cba995616eff7b709` |
| `16-isolation.txt` | `44fadbc58e26c21ae622c4a28ed2f9786ba33830196ae370febbe6ff13ed38ff` |
| `17-field-preservation.txt` | `09b844a1f32b422a1894dea06fdd75d97d2f2022221cfa06b85545c184cb86c2` |

## What was omitted

- The lab `OPENCODE_PASSWORD` (read by the existing `driver.mjs` from the lab `secret.env` for the Basic-auth header only; never printed or copied).
- Raw model responses and token/cost fields beyond the model identity needed for the gates.
- No V1 path, process, config, or database was read or written; no Docker was used; the main checkout was not touched; no commit/push/PR was performed.

## Closing

Verdict: **PASS**. No P0/P1 findings. The confirmed contract is satisfied end to end: the manifest seeds product defaults once and is never consulted for models again, `~/.omo/omo.jsonc` is the sole persistent source with full schema/chain/variant/adjacent-field preservation, reinstall never overwrites, an empty config inherits the global, the OpenAI-only agent disappears cleanly, `/rmo-models` is a safe additive command, delegation and background pass the resolved `Model.Ref`, real children are independently verifiable, and every mandatory suite and gate is green with reproducible, byte-identical-restored evidence while V1 stays intact and the lab is restored. The remaining items are P2/P3. No commit, push, or PR was performed.
