# AUDIT-USER-MODEL.md

Independent, no-code-change audit of per-agent model selection reaching new delegations.

- Worktree: `/home/gabodev/oh-my-rigel-worktrees/fix-v2-user-model-delegation`
- Branch: `fix/v2-user-model-delegation` (HEAD `404a6290134d1704bb44eff7c092c161770f49e2`, base `404a629`, uncommitted working tree)
- Contract: `.../omr-v2-maintenance-handoff/work/user-model-independent-audit-contract.md`
- Runtime path: `opencode-v2-lab.service` (isolated). V1 was never addressed. No Docker.
- Method: read `HANDOFF.md`, read the full working-tree diff vs `404a629`, read the changed sources and tests, run the suites, reproduce the mutations in a temp copy, drive the isolated lab read-only/reversibly, and inspect the lab's own SQLite session DB as primary evidence.
- No implementation file was edited. `git status` and `HEAD` are unchanged by this audit (same 10 modified files as the handoff).

## Verdict: NEEDS_CORRECTION

The **implementation is sound**: every functional gate below passed with primary evidence, including a freshly captured positive and negative real delegation on the lab. The blocker is the **delivered QA evidence**: `08-live-delegation.txt`'s negative control ends `child: {}`, which is not a valid acceptance artifact. Root cause is identified, and a valid negative capture is supplied by this audit. No implementation change is required; the correction is to the evidence package.

## Maintainer finding: cause of `08` `child: {}`

`08-live-delegation.txt` records the negative child as `ses_ed362894bffeukyazwPLx17wf`. That id resolves to **nothing**: `session_v2` has no such row and it has 0 messages (both `session_message` and `message`). The **real** negative child is `ses_ed362894bffeukyazwPLWx17wf` (one character longer). So the driver captured/looked up a truncated session id, the child lookup returned no record, and the extractor emitted `{}`. The artifact therefore proves nothing about the negative branch.

Primary evidence from the lab DB (`.omo/evidence/20261011-v2-user-model-audit/db-primary-evidence.json`), assistant-turn model per child:

| Case | Child session | assistant model |
|---|---|---|
| `07` pre-fix (pin registered, no explicit pass) | `ses_ed367e266ffecfYkN1gB04JUEn` | `opencode-go/deepseek-v4.1-flash` |
| `08` positive | `ses_ed36346b2ffePI42hbg999sIdL` | `opencode-go/glm-5.3` (variant `default`) |
| `08` negative, id **as recorded in evidence** | `ses_ed362894bffeukyazwPLx17wf` | session does not exist |
| `08` negative, **real** id | `ses_ed362894bffeukyazwPLWx17wf` | `opencode-go/deepseek-v4.1-flash` |
| Audit fresh negative (`neg-live.json`) | `ses_ed34e14c0ffenAPZ9aU54FYGXZ` | `opencode-go/deepseek-v4.1-flash` |
| Audit fresh positive (`pos-live.json`) | `ses_ed34d977cffeOrA3X35jVl5WSS` | `opencode-go/glm-5.3` (variant `default`) |

So the underlying property **does** hold (removing the pin yields a real child on the host default `deepseek-v4.1-flash`, never `glm-5.3`), but the delivered `08` artifact does not demonstrate it. The audit re-captured it with a real child and a self-consistent id.

Secondary evidence defects:
- `02-focused-tests.txt` reports `132 pass`; the final focused run is `134 pass` (stale capture). `HANDOFF.md` §4 already states 134, so the artifact lags the claim.
- The live-gate driver that produced `06/07/08` is not stored anywhere; the outputs are not reproducible from the artifact set (only the recorded text survives).

## Gate results

| # | Gate | Result | Evidence |
|---|---|---|---|
| 1 | Clean install creates an editable `~/.omo/omo.jsonc` | PASS | independent check `c1` (seeded, `__OMO_PROFILE_ROOT__` resolved, `profiles.gabo` present) + `rigel-v2-user-install-config-bootstrap.test.mjs` |
| 2 | Reinstall/upgrade does not overwrite user edits | PASS | independent check `c2` (`editPreserved: true`) + bootstrap test |
| 3 | Rollback restores byte-identically | PASS | independent check `A` (freshly seeded profile **removed** on failure) and `B` (pre-existing edit **byte-identical** after injected failure); transaction contract `74/74` |
| 4 | Live config wins over manifest per agent, no stale fallback leak | PASS (with residual risk) | `mergeAgentOverrides` replaces the whole per-agent entry (live wins); tests `mergeAgentOverrides replaces ... leaking no stale fallback`; live positive. See Residual risk R1 (pin **removal**). |
| 5 | Canonical / display keys | PASS | `normalizeAgentOverrideKey` (lowercase, strip ` - ...`) in merge + `agentOverrideFor`; tests collapse `"Hephaestus - Deep Agent"` and `hephaestus` |
| 6 | Invalid model never reaches the host as a raw string | PASS | `modelRef` returns `undefined` on a non `provider/id` string; `pinnedAgentModelRef` and `buildExplicitAgentModels` route through it; tests `a malformed live agent model falls back ... never a raw string` and `pinnedAgentModelRef ... malformed ... never becomes a raw string` |
| 7 | Explicit `Model.Ref` reaches BOTH delegation paths | PASS | `rigel-v2-native.mjs:1435` (sync) and `:1459` (background) both pass `category?.model ?? pinnedAgentModelRef(...)`; `rigel-v2-native-core.mjs:156-161` forwards `model` into `session.create`; core test asserts the object and the omitted-key case |
| 8 | Unpinned agent inherits | PASS | `pinnedAgentModelRef` returns `undefined`; `session.create` omits `model`; core test asserts `hasOwnProperty(model) === false` |
| 9 | Categories do not regress | PASS | `category?.model` keeps precedence unchanged; `parseModel` returns `{providerID,id,variant?}` (a `Model.Ref`, not a string); full suite green |
| 10 | Supported restart/reapply mechanism | PASS | `apply-v2-runtime-service.sh` refresh + `systemctl --user restart opencode-v2-lab.service`; exercised live (pin picked up after restart) |
| 11 | New real delegation uses the chosen model | PASS | `pos-live.json`: real `rigel_task` child `explore` dispatched `opencode-go/glm-5.3` |
| 12 | Negative control (real child, pin removed) does NOT use the chosen model | **FAIL as delivered; PASS when re-captured** | delivered `08` = `child: {}` (invalid); audit `neg-live.json` real child = `opencode-go/deepseek-v4.1-flash` |
| 13 | Focused suite / validate-profile / `profiles/gabo` / mutations reproducible | PASS | focused `134 pass / 0 fail`; `gabo profile validation passed`; `2304 pass / 0 fail` across 154 files; M1 (invert merge order) `3 fail`, M2 (`pinnedAgentModelRef` always `undefined`) `1 fail`, both restored byte-identically |
| 14 | Lab restored | PASS | service `active`; live `~/.omo/omo.jsonc` absent (no pin); `explore => qwen3.7-plus`; V1 config hash and protected-surface digest unchanged (`run-lab-acceptance.sh` 28/28) |

## Residual risks / limitations (not blocking)

- **R1 - stale pin on removal.** The manifest bakes `agentOverrides` at install time (`build-target-agent-manifest.mjs:296`). `mergeAgentOverrides` treats "live config does not mention an agent" as "keep the manifest value". A user who pins `agents.<id>.model`, installs, then later **removes** the pin and restarts (without reinstalling) keeps the stale manifest pin. Adding or changing a pin works (live wins); only removal lingers until a reinstall/rebake. This is not exercised in the lab because the lab's baked manifest fallback is `{}`; it is a real-install path. HANDOFF §6 does not call this out. Recommend documenting it, or making the live view authoritative-complete rather than a per-key overlay.
- **R2 - runtime read is user-layer only.** `readLiveAgentOverrides` anchors at `HOME`, so a project-layer `.omo/omo.jsonc` is not read at runtime. The runtime read no config at all before, so this is not a regression, but it is a deliberate scope choice (HANDOFF §6).
- **R3 - install rewrites the live file.** OmO's config-migration engine may append a `_migrations` ledger to `~/.omo/omo.jsonc` on read, so a reinstall is not byte-identical even though the user's edit survives (asserted). Documented.
- **R4 - host does not apply `Agent.Info.model`.** The fix passes the pinned `Model.Ref` explicitly because V2 ignores the registered agent model on a session request. Correct today; if the host later honours it, the explicit pass is still the same value.

## Required corrections

1. Replace the negative control in `08-live-delegation.txt` with a valid capture: a real child session, a session id that resolves, and the child assistant-turn model showing the host default and not the pin. This audit supplies one (`neg-live.json`, `db-primary-evidence.json`).
2. Reconcile `02-focused-tests.txt` (`132`) with the final count (`134`).
3. Persist the live-gate driver next to `06/07/08` so the gate is reproducible from the artifact set, or record the exact API calls used.
4. Optionally document R1 in `HANDOFF.md` §6.

## Lab restoration state (final)

- `opencode-v2-lab.service`: `active`.
- `~/.local/share/opencode-v2-lab/home/.omo/omo.jsonc`: absent (the test pin was written, used, and removed; the pre-existing `omo.jsonc.bak.2026-10-11T19-59-08-066Z` is untouched).
- `GET /api/agent` -> `explore => {"id":"qwen3.7-plus","providerID":"opencode-go"}` (back to the unpinned fallback).
- Sessions created by this audit's gate were left in place (lab only), matching the handoff's own convention.
- `run-lab-acceptance.sh` (read-only): 28/28 PASS, `V1 config hash unchanged: PASS`, `V1 protected surfaces unchanged: PASS`.

## Evidence index (local, gitignored, never committed)

Under `.omo/evidence/20261011-v2-user-model-audit/`:

| File | sha256 |
|---|---|
| `db-primary-evidence.json` | `1bf88d7623ec964a7704c6f1494107f47f0a96e57e4ac01829832988d611cc62` |
| `neg-live.json` | `cdf7cfac82df814e5ee5d351d12f5448fa6cb949149bae0f641e381280568e65` |
| `pos-live.json` | `fdf1f94137272a9b0a3bc02d6c98bda41b600c3ed5079c375c8df01a7c0c3028` |

Supporting evidence from the repo's own contracts (regenerated during this audit):

| File | sha256 |
|---|---|
| `.omo/evidence/20261011-rigel-lab-acceptance/lab-acceptance.txt` | `8dbf9bb39c1d48d8e9f848115d62b848f41557c18da7a8e31c123809d15f3924` |
| `.omo/evidence/20261011-rigel-lab-acceptance/api-config.json` | `c0d1bdc1ffaa6d2d9b455a85529e9671aa4355749f4b9b36579e3239ada87262` |
| `.omo/evidence/20261008-production-readiness/rotation5-transaction/transaction-contract.json` | `90e092aa60c75dd56272d18d6aea1b905510945a704efd3d0ed3b4eba91db348` |

Primary DB: `/home/gabodev/.local/share/opencode-v2-lab/data/opencode/opencode.db` (lab only, read-only via `bun:sqlite`).

## What was omitted

- The lab's `OPENCODE_PASSWORD` (read from `secret.env` for the Basic auth header only; never printed or copied).
- Raw model responses and token/cost fields beyond the model identity needed for the gate.
- No V1 path, process, config, or database was read or written.
