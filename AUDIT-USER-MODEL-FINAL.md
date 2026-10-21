# AUDIT-USER-MODEL-FINAL.md

Independent, no-code-change audit of the per-agent model configuration implementation in Oh My Rigel V2 after the redesign (Increments A/B/C).

- Worktree: `/home/gabodev/oh-my-rigel-worktrees/fix-v2-user-model-delegation`
- Branch: `fix/v2-user-model-delegation`, HEAD `404a6290134d1704bb44eff7c092c161770f49e2` (unchanged; no commit/push/PR)
- Baseline: `404a629`
- Contract: `CONTRACT-ADDENDUM-MODEL-FALLBACKS.md` (confirmed) + audit prompt `model-independent-audit-prompt.txt`
- Runtime path: `opencode-v2-lab.service` (isolated). V1 was never addressed, read, or written. No Docker.
- Method: read the contract and `HANDOFF.md` in full; read the entire working-tree diff vs `404a629` hunk by hunk; read every changed source and test; re-ran the focused and full suites and `validate-profile`; verified the evidence bundle checksums, secret-freeness, and child-session resolvability; re-ran the read-only lab acceptance and recomputed the V1 protected digest; injected two mutations into a copy and restored byte-identically; grepped for stale consumers of removed symbols.
- No implementation file was edited. The working tree (`git status`, `HEAD`) is unchanged by this audit.

## Verdict: PASS

The implementation matches the confirmed contract, the declared seam is narrow and additive (plus the one declared builder removal), all mandatory suites and gates pass with primary evidence, the previously defective negative control is now a real child session, the mutation controls are reproducible with byte-identical restore, and V1 is intact and the lab restored. Only P2/P3 observations remain; none blocks the contract's PASS condition.

## Findings

### P0 (blocking): none

### P1 (blocking): none

### P2 (non-blocking, recommend addressing)

- **P2-1 - Ctrl+X M session-locality has no direct test or live evidence.**
  The contract's "Session-local override" clause requires that a Ctrl+X M model selection is session-scoped, does not rewrite `~/.omo/omo.jsonc`, does not affect other sessions, and that a new session returns to the JSON config. The audit prompt lists "session override" as an item to audit. The plugin side of this clause is implemented and evidenced: the runtime is read-only over `~/.omo/omo.jsonc` (no writer exists on the runtime path), and an agent whose JSON config is empty registers with NO model so the host inherits the global/Ctrl+X M (unit tests `registerNativeAgents with chainFallback:false leaves agent.model absent ...` and `forwards a pinned Model.Ref ... omits it for an inherited agent model`; live Case A and Case C). Ctrl+X M itself is a host keybind (`model.list`), not a plugin surface, so a direct live test would exercise the host, not this change.
  Recommendation: record this scope explicitly in `HANDOFF.md` (host-owned; plugin reads-only, empty registers with no model), or add one focused assertion that the runtime path performs no write to `~/.omo/omo.jsonc`.

### P3 (minor, cosmetic/hygiene)

- **P3-1 - `preSpawnModelKey` keeps an unused parameter.** `profiles/gabo/opencode/rigel-v2-native.mjs:312` retains `manifestRef` for call-site compatibility (documented in the comment) but never reads it. Harmless; a cleanup candidate.
- **P3-2 - Stale prose names a removed function.** `profiles/gabo/migration-classifications/tools.mjs:20-21` still references `readNativeAgentOverrides`, which the change deletes. Documentation drift only; no code consumer.
- **P3-3 - Evidence checksum file is incomplete.** `.omo/evidence/20261012-v2-user-model-live/SHA256SUMS.txt` hashes 12 artifacts; `00-pre-v1-manifest.json` is present but not listed. All 12 listed entries verify OK.
- **P3-4 - The V1 protected-surfaces digest is not comparable across runs.** The digest covers V1's live files including `.local/share/opencode/auth.json`, so it drifts as the user uses V1 (recorded `7c890e7c...` at 01:16; recomputed `722f368f...` now, stable across two consecutive recomputes). The valid invariant is before/after equality inside one run, which the acceptance script reports as PASS. No V1 mutation is attributable to this change (see Verification).
- **P3-5 - Two-step model assignment in registration.** `applyLegacyAgentDefinition` still sets `agent.model` from the manifest definition (kept because the frontier permission is computed from it), and `registerNativeAgents` then `delete agent.model` when the JSON config carries no ref. The observable result is correct; the plan text ("stop assigning") is realized indirectly.

## Contract / gate / evidence table

| # | Contract requirement | Result | Evidence |
|---|---|---|---|
| 1 | Manifest seeds product defaults only at install; after that `~/.omo/omo.jsonc` is the sole source of truth | PASS | Diff removes `extractAgentOverrides` + the manifest `agentOverrides` map (`build-target-agent-manifest.mjs`, `generate-v2-agents.mjs`); runtime reads JSON only (`rigel-v2-native.mjs:409-454`, `resolveAuthoritativeAgentOverrides`); install seeds once (`rigel-v2-user-install-config-bootstrap.test.mjs`) |
| 2 | Changing/removing the manifest does not alter runtime model resolution | PASS | No manifest model read remains in the runtime (only `manifest.agents?.[id]?.name`); `resolveProactiveAgentModels(..., {chainFallback:false})` never consults `source.model` or the built-in chain; unit tests `JSON-only resolution: chainFallback:false ...` |
| 3 | Full per-agent schema, ordered chains, variants, and adjacent/unknown fields preserved | PASS | `normalizeAgentOverrideEntry` full-entry shallow copy + `models[]` decomposition; `canonicalizeAgentOverrides` spreads the full entry; tests `the full entry survives and models[] decomposes`, `explicit model ... never overwritten`, `degrades to {} and never mutates its input` |
| 4 | Reinstall/upgrade never overwrites the user's choices | PASS | `persistEditableProfile` seeds only when the file is absent (`createdProfile`); bootstrap test `a later install preserves the user's live model selection`; profile file is in the lifecycle transaction |
| 5 | Empty config inherits the OpenCode global | PASS | `chainFallback:false` yields no ref; `delete agent.model`; unit tests; live Case A and Case C (`explore: <none: inherit>`; real child on host global `opencode-go/deepseek-v4.1-flash`) |
| 6 | Ordered candidates attempted in order; exhaustion fails without manifest fallback | PASS | Reader decomposes `models[]` -> `model` + `fallback_models`; `resolveEffectiveChain` consumes `fallback_models` at the `http.request` boundary (`rigel-v2-native.mjs:609-618`); `resolveEffectiveChain` unit tests |
| 7 | Ctrl+X M selection is session-local (does not rewrite JSON; new session resets) | PASS (indirect) | Runtime has no JSON writer; empty config registers no model so the host Ctrl+X M wins; unit tests + live Case A/C. No direct keybind test. See P2-1 |
| 8 | Secondary agents use their JSON config and chain | PASS | Children receive the JSON primary `Model.Ref` (sync `:1436`, background `:1460`) or inherit; `resolveEffectiveChain` supplies the JSON fallback chain; core test `forwards a pinned Model.Ref ... omits it for an inherited agent model` |
| 9 | OpenAI-only agent (hephaestus) disappears when config is wrong/nonexistent/non-OpenAI, without harming the app | PASS | JSON-only gate candidate; `gateDefinition` clears the definition model; live Case D1 (anthropic -> ABSENT) and D2 (openai -> PRESENT); unit tests `registers Hephaestus only when its JSON ref is a supported GPT`, `drops ... not GPT`, `drops ... no model` |
| 10 | `/rmo-models` is a command (not a skill), usable from any agent, guided, atomic, validated, preserving, cancel/no-op safe, never restarts/kills, shows only a supported reload | PASS | Registered via `ctx.command.transform`; `execute` only reads and injects via `context.session.prompt`; `MODELS_RELOAD_COMMANDS` has only `opencode reload` + `opencode service restart` (no `server reset`); tests: all 12 agent types, disabled_commands, no-op on empty session, lifecycle trap, source scan for restart/stop/kill |
| 11 | No regression in delegation, orchestration, routing, prompts, categories, permissions, continuity, background handoff, non-explicit selection, Sisyphus, or unaffected agents | PASS | Full `bun test profiles/gabo` 2342/0 across 155 files; diff confined to the listed 13 files (+2 new); categories/permissions/delegation-core/background-handoff/continuity/no-sisyphus-gpt/routing/prompts suites untouched and green |

## Audit checklist results

| Checklist item | Result | Note |
|---|---|---|
| Diff hunk by hunk vs `404a629` | PASS | 13 modified + 2 new; every hunk classified as the declared seam or the declared builder removal |
| Baseline and allowed delta | PASS | Baseline `136/3` (documented, pre-existing RED); allowed delta matches HANDOFF items 1-5 |
| Architecture / seam | PASS | One new module family, additive wiring, delegation call sites unchanged by design (source swapped) |
| Focused + full suite | PASS | Focused 6 files 171/0; `bun test profiles/gabo` 2342/0; `validate-profile` passed |
| Sync and background delegation | PASS | Both sites pass `category?.model ?? pinnedAgentModelRef(...)`; background path pinned by the core test |
| Real child session | PASS | Live B child `ses_ed2f80381ffen4pbEe1Sx7ZEGI` (glm-5.3); live C child `ses_ed2f77956ffeOoeWBqRHQvvMkP` (host global); both resolve via API |
| JSON-only resolution | PASS | Manifest not consulted for models; no reader left |
| Chain and variants | PASS | Full entry + `models[]` decomposition; `fallback_models` consumed by the reactive chain |
| Empty / global | PASS | Live Case A/C |
| Session override | P2 | See P2-1 |
| OpenAI disappearance | PASS | Live D1/D2 |
| Reinstall / upgrade | PASS | Bootstrap test |
| Command | PASS | Command-level tests present and green |
| Negative controls | PASS | Live Case C real child; mutation M1/M2 |
| Fault/mutation + byte-identical restore | PASS | M1 -> 5 fail; M2 -> 1 fail; two mutated files restored byte-identically; re-run 171/0 |
| V1 intact | PASS | Acceptance 28/28; V1 config hash unchanged; protected surfaces unchanged within-run |
| Lab restored | PASS | Service active; live `~/.omo/omo.jsonc` absent |
| Evidence: no secrets, reproducible | PASS | No secret values; SHA256SUMS 12/12 OK; sanitized `driver.mjs`/`driver.sh` present |

## Independent verification performed by this audit

- `sha256sum -c SHA256SUMS.txt` (live evidence): 12/12 OK.
- Secret scan over baseline/matrix/live: only benign matches (`maxTokens`/`budgetTokens` in the agent dumps, the `OPENCODE_PASSWORD` variable name in `driver.mjs`, and V1 file-path names in the manifest). No credential values.
- Parsed `02/03/04-*-agent.json`: Case A and restored roster carry only `Title => deepseek-v4.1-flash`; Case B additionally carries `explore => glm-5.3`. Consistent with the settled roster.
- Focused suite: `171 pass / 0 fail` across 6 files (config, runtime, agents, explicit-chain, core, models-command).
- Full suite: `2342 pass / 0 fail` across 155 files (67.6s).
- `node profiles/gabo/validate-profile.mjs`: `gabo profile validation passed`.
- `bash profiles/gabo/run-lab-acceptance.sh` (read-only): `28 / 28 PASS`; `V1 config hash unchanged: PASS`; `V1 protected surfaces unchanged: PASS`; `goal invariant (internal): PASS`.
- `node profiles/gabo/v1-protected-surfaces.mjs --digest "$HOME"`: `722f368fa857c6ce18e30189e25c585b3df02bd22991b848ed3a871770ca6c79`, identical across two consecutive recomputes (stable within a window; cross-run drift explained by live V1 `auth.json`).
- Lab state: `opencode-v2-lab.service` active; `~/.local/share/opencode-v2-lab/home/.omo/omo.jsonc` absent.
- Mutation M1 (flatten `normalizeAgentOverrideEntry`): config suite -> `26 pass / 5 fail`.
- Mutation M2 (`pinnedAgentModelRef` always `undefined`): runtime suite -> `49 pass / 1 fail`.
- Restoration: mutated files byte-identical to their backups; focused re-run 171/0; `git diff --stat` unchanged (13 files, +785 / -119).
- Stale-consumer grep: `readNativeAgentOverrides` / `extractAgentOverrides` / `mergeAgentOverrides` have no code consumers (only P3-2 prose); `agentOverrides` in `packages/omo-codex/**` is an unrelated Map.

## Residual risks / limitations

- P2-1 (Ctrl+X M coverage) and the P3 items above.
- Model fallback on provider failure is exercised by unit tests of `resolveEffectiveChain`/`resolveFallbackModel`, not by a live forced-failure run; a live exhaustion test would strengthen coverage but is not required by the contract.
- The install seeding writes the durable `~/.omo/omo.jsonc` in the target home; on a real install this is the user's home (intended), and it is transaction-tracked for byte-identical rollback (bootstrap + transaction contracts green).

## Evidence index (local, gitignored, never committed)

Verified live bundle (`.omo/evidence/20261012-v2-user-model-live/`, `sha256sum -c` 12/12 OK):

| File | sha256 |
|---|---|
| `00-pre-state.txt` | `ac76c6dd0c45b04f1f185ede88df73085b6c2f4e78640d5b430f5f8cd66db11e` |
| `01-refresh.txt` | `8b156941cec20bf94104c20bcf239f008f00757cdfa291575963392551c401b4` |
| `02-caseA-agent.json` | `10ad8712e828185bd507620455534c9f077e2029b49c92d5b535e5e83542e11f` |
| `03-caseB-pinned-agent.json` | `6a9e5e35872402be82c94ecea938cb565f210b7b841adbb58c7121ff2987f118` |
| `04-caseA-restored-agent.json` | `10ad8712e828185bd507620455534c9f077e2029b49c92d5b535e5e83542e11f` |
| `05-caseA-restored-roster.txt` | `4b9d7e034a0466517e80fa08735e7972de91214c7b97b3d6b24abe804830fca9` |
| `06-lab-acceptance.txt` | `ca3ea10f5cd89c28c32ca07001e6e390363516f481c489d6bac7b3ceb6ca99d6` |
| `09-post-v1-manifest.json` | `b0dbafbebe86a3e1cac77ccd0f5022ab835c74f73bf8fb2496adfc5159bb4ca6` |
| `driver.mjs` | `60f07272414a75ffd3c156ab6e35d76525d12d16ebb79dcb5d79dc2842a62e71` |
| `driver.sh` | `f2a737a3570d7a9dc5c53057abfbb45dc9de986e23426b2ae9d6837254b347e6` |
| `lab-live-matrix.txt` | `a8cfd3fcc8d71070c2ddc025bf855c4d0156f0c068d699f7a8b3b1dce64ee70b` |
| `lab-restore.txt` | `46eadb21b0bee28a72e4e6506a7f9b9155f69400913b721e8c9495d18dae6893` |
| `00-pre-v1-manifest.json` (not in SHA256SUMS; P3-3) | n/a in bundle |

Supporting bundles:

| File | sha256 |
|---|---|
| `.omo/evidence/20261012-v2-user-model-baseline/00-baseline-git-and-hashes.txt` | `b299e0a7811bb0396fbaf412e4308c73527f7e18c18610e2e5b7f331363b18f6` |
| `.omo/evidence/20261012-v2-user-model-baseline/01-baseline-focused-tests.txt` | `12a9cdead1aae4724bd4fc7818974af47d44c0b01b5b2765b331c14376374a72` |
| `.omo/evidence/20261012-v2-user-model-baseline/02-baseline-validate.txt` | `40f5d70946e9a6d59b78c08a45b2b894c0b08984eca61cf32fa567973c47ce24` |
| `.omo/evidence/20261012-v2-user-model-baseline/03-diff-classification.md` | `68bda15b567bad1b50f6584589a2596af82c4b68ca4f4d64412e150336018bd1` |
| `.omo/evidence/20261012-v2-user-model-matrix/00-pre-post-and-controls.md` | `e6d263d78bad24eb8e3a5f865b8f5e428967b2f68355a4a94ebac8ec6e6ecdfe` |
| `.omo/evidence/20261012-rigel-lab-acceptance/lab-acceptance.txt` | `4482ef8cd30ff87a4378846d57cb566be45ace040a36b0a90b319c0054e818af` |
| `.omo/evidence/20261012-rigel-lab-acceptance/api-config.json` | `c0d1bdc1ffaa6d2d9b455a85529e9671aa4355749f4b9b36579e3239ada87262` |

New (untracked) runtime artifacts reviewed:

| File | sha256 |
|---|---|
| `profiles/gabo/opencode/rigel-v2-native-models-command.mjs` | `75247dfd0f6de3b1e441d29d89a903f43a5e5a347dd138b85f8401f374c9eb39` |
| `profiles/gabo/opencode/rigel-v2-native-models-command.test.mjs` | `9f85992e5b2e11197f3bb1834838033bb2033f160c31365cd808aa0e3e27a8c9` |

## What was omitted

- The lab `OPENCODE_PASSWORD` (read by `driver.mjs` from the lab `secret.env` for the Basic-auth header only; never printed or copied).
- Raw model responses and token/cost fields beyond the model identity needed for the gates.
- No V1 path, process, config, or database was read or written; no Docker was used; the main checkout was not touched.

## Closing

Verdict: **PASS**. No P0/P1 findings. All mandatory suites and gates pass with primary evidence, the negative control is a real child session, the mutation controls prove the tests bite while restoring byte-identically, and V1 is intact with the lab restored. The remaining items are P2/P3. No commit, push, or PR was performed.
