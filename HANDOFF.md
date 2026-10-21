# HANDOFF — user per-agent model selection (Oh My Rigel V2) — REDESIGN IN PROGRESS

**Status: REDESIGN.** The confirmed contract is `CONTRACT-ADDENDUM-MODEL-FALLBACKS.md`. An ABSOLUTE USER VETO
requires the change to be ADDITIVE and isolated behind the narrowest seam: do not alter/refactor/regress any
behavior that works today; declare the only allowed behavior delta; add negative controls + pre/post comparison;
prefer new isolated modules/command wiring over modifying proven paths. Implementation proceeds incrementally
ONLY where isolation is proven. No commit/push/PR until an independent Codex audit.

## Increments (progress)

- **Increment A — `/rmo-models` command (DONE, isolated).** New `profiles/gabo/opencode/rigel-v2-native-models-command.mjs`
  (node builtins only; no parent imports; no restart/stop/kill APIs) + `rigel-v2-native-models-command.test.mjs`
  (25 pass / 0 fail) + additive wiring in `rigel-v2-native.mjs` (import L85, `registerModelsCommand` L1917).
  Displays the VERIFIED `opencode reload` / `opencode service restart`; never `opencode server reset`.
- **Increment B — install product-default seeding (DONE, additive).** `rigel-v2-user-install.mjs` seeds each
  agent's manifest product-default `model`/`variant` into a freshly created `~/.omo/omo.jsonc` (clean install
  only; never rewrites an existing file); `rigel-v2-user-install-config-bootstrap.test.mjs` extended
  (9 pass / 0 fail). validate-profile passed.
- **Increment C — runtime JSON-only resolution (DONE, narrow seam).** `agentOverrides` source is now JSON-only
  (`resolveAuthoritativeAgentOverrides({ live })`; the manifest is never consulted for models). Delegation call
  sites unchanged (`pinnedAgentModelRef(agentOverrides, agent)` now correct because the source is JSON-only).
  Added an additive `chainFallback` option to `resolveProactiveAgentModels`/`registerNativeAgents` (default true
  preserves prior behavior; the runtime passes `false` → empty JSON = no model = inherit global). Hephaestus gate
  keys on the JSON-resolved ref only (the manifest definition model is stripped on the JSON-only path). The reader
  now preserves the full per-agent entry and decomposes `models[]` (V1 parity). Both builders dropped the
  `agentOverrides` field. The 3 stale `mergeAgentOverrides` tests were rewritten. Evidence:
  `.omo/evidence/20261012-v2-user-model-matrix/00-pre-post-and-controls.md`.
  - Focused 5 files: PRE `136 pass / 3 fail` → POST `146 pass / 0 fail`.
  - Full `bun test profiles/gabo`: **2342 pass / 0 fail** across 155 files; `validate-profile` passed.
  - Negative control: only the model-seam test files + the new command test changed; every other suite
    (categories, permissions, delegation-core, background-handoff, continuity, no-sisyphus-gpt, routing, prompts)
    is untouched and green.
- **Live lab QA — DONE, ALL PASS** (`opencode-v2-lab.service`, real child sessions read from the lab DB):
  - Case A (no live `omo.jsonc`): every agent registers with NO model → inherits the global.
  - Case B (pin `explore=opencode-go/glm-5.3`): roster shows the pin; real child `ses_ed2f80381ffen4pbEe1Sx7ZEGI`
    dispatched `glm-5.3`. PASS.
  - Case C (pin removed): roster `<none: inherit>`; real child `ses_ed2f77956ffeOoeWBqRHQvvMkP` dispatched the host
    global `deepseek-v4.1-flash`, NOT the pin. PASS.
  - Case D1 (`hephaestus=anthropic/claude-opus-5-5`): hephaestus ABSENT. D2 (`hephaestus=openai/gpt-6-sol`): PRESENT. PASS.
  - Restore: live `omo.jsonc` deleted, service active; `run-lab-acceptance.sh` **28/28 PASS**, V1 config hash +
    protected-surfaces digest unchanged, 0 drift. PASS.
  - Evidence: `.omo/evidence/20261012-v2-user-model-live/` (matrix, real child ids resolvable via API — no
    `child: {}`, reproducible sanitized `driver.mjs`/`driver.sh`, SHA256SUMS). Lab mutations byte-identically restored.

## Final working-tree state

- 13 modified files, `+785 / −119`; 2 new runtime files (`rigel-v2-native-models-command.mjs` + test) + docs.
  HEAD `404a629` unchanged; no commit/push/PR.
- Suites: focused `146/0`; full `bun test profiles/gabo` `2342/0`; `validate-profile` passed.
- Lab: `opencode-v2-lab.service` active; live `~/.local/share/opencode-v2-lab/home/.omo/omo.jsonc` absent (restored).

## Post-audit cleanup (P2/P3) — DONE

`AUDIT-USER-MODEL-FINAL.md` returned PASS with only P2/P3 items. All were addressed without changing the accepted
contract or observable runtime behavior (evidence: `.omo/evidence/20261012-v2-user-model-cleanup/00-cleanup.md`):

- **P2-1 Ctrl+X M** — added a focused read-only test: the runtime read path leaves `~/.omo/omo.jsonc` bytes, mtime
  and directory listing unchanged (no writer on the runtime path). Ctrl+X M is host-owned (`model.list`,
  session-local); the plugin only stays read-only and registers no model for an empty config, so the host selection
  wins for that session. No host control is fabricated.
- **P3-1** — removed the unused `manifestRef` parameter from `preSpawnModelKey`; call site + tests updated;
  behavior unchanged.
- **P3-2** — corrected the stale `migration-classifications/tools.mjs` `call-omo-agent` prose (no longer names the
  removed `readNativeAgentOverrides`); regenerated `V2_MIGRATION_INVENTORY.md` (1-line diff).
- **P3-3** — regenerated `.omo/evidence/20261012-v2-user-model-live/SHA256SUMS.txt` to 13 entries including
  `00-pre-v1-manifest.json`; `sha256sum -c` all OK; no secrets.
- **P3-4** — volatile V1 credential files (`auth.json`, `mcp-auth.json`) are still classified protected (presence
  tracked) but no longer content-hashed, so the digest is reproducible across runs (verified `c52d3165…` twice);
  removal is still detected.
- **P3-5** — kept the two-step model assignment: collapsing it would change `applyLegacyAgentDefinition`'s exported
  behavior for direct callers (it sets `agent.model` and derives the frontier permission from it); justified in a
  code comment. Byte-for-byte equivalence did not hold, so it was not simplified.

Cleanup gates: focused 6 `172/0`; `v1-protected-surfaces` `11/0`; `migration-inventory` `11/0`; full
`bun test profiles/gabo` **2344/0** across 155 files; `validate-profile` passed; `run-lab-acceptance.sh` passed
(V1 intact; lab restored — service active, live `omo.jsonc` absent).

## STOPPED — awaiting a fresh independent re-audit

All gates are complete and green. Per the contract, STOP here for a fresh independent re-audit before any
commit/push/PR. Nothing further will be changed.

## Diff classification (uncommitted tree vs baseline 404a629)

Full hunk-by-hunk map: `.omo/evidence/20261012-v2-user-model-baseline/03-diff-classification.md`.
Baseline git/hashes: `.omo/evidence/20261012-v2-user-model-baseline/00-baseline-git-and-hashes.txt`.
Baseline tests: `01-baseline-focused-tests.txt` (`136 pass / 3 fail`), `02-baseline-validate.txt` (passed).

Summary: **[KEEP]** compatible additions — `modelRef` export; the live JSON reader; `pinnedAgentModelRef`
explicit delegation pass; install `persistEditableProfile` + transaction; the core `session.create` Model.Ref
test; the install-bootstrap test. **[SUPERSEDED]** to replace/revert narrowly — the flattening
`normalizeAgentOverrideEntry` + manifest `readNativeAgentOverrides`; `resolveAuthoritativeAgentOverrides`'s
manifest fallback; `buildExplicitAgentModels` chain-walk; the 3 RED `mergeAgentOverrides` tests.
**[TEST]** to rewrite — config/explicit-chain/runtime test rows to the confirmed JSON-only semantics.

## Verified restart/reload command (for `/rmo-models`)

Local CLI `opencode v2.0.26` + official docs: **`opencode reload`** (reload config without restarting the
server) and **`opencode service restart`** (restart the background server) are VERIFIED. **`opencode server
reset` is NOT a subcommand** — must never be printed. Because `~/.omo/omo.jsonc` is consumed by the plugin at
plugin-init, a full `opencode service restart` is the guaranteed mechanism; `/rmo-models` will display the
verified command and never restart/kill anything itself.

## Allowed behavior delta (declared — the ONLY permitted observable change)

1. Install seeds per-agent product defaults into `~/.omo/omo.jsonc` (clean install; never overwrites).
2. Runtime resolves per-agent models from `~/.omo/omo.jsonc` ONLY (manifest not consulted for models);
   ordered candidates honored; empty → inherit the OpenCode global.
3. Delegation passes the resolved primary `Model.Ref` to children (sync + background) when configured; omits
   it when empty.
4. `hephaestus` registration gate keyed on the JSON effective config (disappears cleanly on non-OpenAI/empty).
5. New `/rmo-models` command (guided, atomic, validating, non-destructive).
Everything else — delegation mechanics, orchestration, routing, prompts, categories, permissions, continuity,
background handoff, Sisyphus, and every unaffected agent — must be observationally identical.

---

## Prior status (superseded): implementation HALTED pending the confirmed replacement decision table

- Worktree: `/home/gabodev/oh-my-rigel-worktrees/fix-v2-user-model-delegation`
- Branch: `fix/v2-user-model-delegation`
- HEAD / base: `404a6290134d1704bb44eff7c092c161770f49e2` (unchanged; no commit)
- Bootstrap: `rigel-session-start` loaded; `.omo/rules/protect-opencode-v1.md` read. Runtime path is `opencode-v2-lab.service`. No Docker. V1 was never addressed.
- This session edited **no implementation file**. It only read sources/tests/evidence, wrote `.omo/plans/user-model-matrix-correction.md`, and wrote this handoff.

## Why we stopped

`CONTRACT-ADDENDUM-MODEL-FALLBACKS.md` was re-read and is now marked **SUPERSEDED — do not implement.** Its rule set (the secondary valid+available pin gate and the per-group fallbacks) is declared a misunderstanding and invalid. The prior `user-model-correction-contract.md` semantics were already annulled. **No implementation change was made against the addendum.**

The addendum's "current clarification pending final confirmation" (NOT final, NOT implemented):

1. The manifest is used **only once**, at initial installation, to inject initial model values into `~/.omo/omo.jsonc`.
2. After installation the manifest is **never consulted again**, including when a configured model fails.
3. `~/.omo/omo.jsonc` is the **sole persistent source of truth**.
4. An agent whose entry is left empty (no configured model) **inherits the current OpenCode global model**, including the model selected interactively with **Ctrl+X M**.
5. **Stop implementation** until Codex records the user's confirmed complete decision table.
6. Do not commit, push, or open a PR.

The Oracle design session (for the now-superseded 3-group matrix) was **cancelled**; its transcript and my extracted summary are void pending the replacement contract. Do not implement them.

## Factual current state of the worktree

- **10 modified files, uncommitted** (`git diff --stat`: +518 / −46):
  `rigel-v2-native-agents.mjs`, `rigel-v2-native-config.mjs`, `rigel-v2-native-config.test.mjs`,
  `rigel-v2-native-core.test.mjs`, `rigel-v2-native-explicit-chain.mjs`,
  `rigel-v2-native-explicit-chain.test.mjs`, `rigel-v2-native-runtime.test.mjs`,
  `rigel-v2-native.mjs`, `rigel-v2-user-install-config-bootstrap.test.mjs`, `rigel-v2-user-install.mjs`.
- **The focused suite is RED: `136 pass / 3 fail`.** All 3 failures are in
  `profiles/gabo/opencode/rigel-v2-native-runtime.test.mjs` and are
  `ReferenceError: mergeAgentOverrides is not defined` — the tests reference a function removed by an
  in-progress refactor to `resolveAuthoritativeAgentOverrides`. This is the tree as inherited this
  session; it is a pre-existing defect in the working tree, not a regression introduced here.
- `node profiles/gabo/validate-profile.mjs` → **`gabo profile validation passed`**.
- **No mutation testing was run** this session (instructed not to).
- Untracked: `HANDOFF.md` (this file), `HANDOFF.prior-superseded.md` (verbatim prior handoff, preserved),
  `AUDIT-USER-MODEL.md`, `CONTRACT-ADDENDUM-MODEL-FALLBACKS.md`.
- New this session: `.omo/plans/user-model-matrix-correction.md` — the design for the **superseded**
  3-group matrix. Preserved for history; **do not implement**.

## What was attempted earlier (history, retained)

1. `user-model-correction-contract.md` — R1 stale-pin fix (live `~/.omo/omo.jsonc` authoritative over
   the baked manifest). Implemented in the uncommitted diff above.
2. `user-model-independent-audit-contract.md` → `AUDIT-USER-MODEL.md` returned **NEEDS_CORRECTION**:
   implementation judged sound, but the evidence package was defective (the `08` negative control
   ends `child: {}` because the recorded child id `ses_ed362894bffeukyazwPLx17wf` is truncated; the
   real child is `ses_ed362894bffeukyazwPLWx17wf`; `02-focused-tests.txt` reported a stale `132`).
3. `user-model-matrix-correction-contract.md` — the 3-group matrix. **Design only; superseded before
   implementation.**
4. `CONTRACT-ADDENDUM-MODEL-FALLBACKS.md` — pending clarification; **now SUPERSEDED**.

## Evidence inventory (local, gitignored, preserved — never committed)

`.omo/evidence/20261011-v2-user-model-delegation/`

| File | sha256 |
|---|---|
| `01-context-probe.json` | `4231cd2d43a27e04eaafb0fb1847e8d0d70742b97a6e3fe1ac4c3f68b49bc131` |
| `02-focused-tests.txt` | `3b11b1db089b4301a4fda07e0a1688162c39bd852c5bb06b063615960cb389e4` |
| `03-mutation.txt` | `ffa838e26efc68d800b5965ad8283392643b4033c16b5bd5e4505e9eb8f1a884` |
| `04-profile-suite.txt` | `da49a2ea3eaec166f69cf7535da94f7b936abd9cc8787fb11c16acb743d17603` |
| `05-validate-profile.txt` | `2499a85e513c646c75e334f63bbd2576f6d038b8b61430cb93817d72129830c1` |
| `06-live-gate.txt` | `c8f4c72febcd749c4de8301d759aa8b2db50fae5cf7d5a11aaf9e770e604e19f` |
| `07-live-delegation.txt` | `c9d9a84291b5aaeeb0546b3a456c9b7c172d634b949db8d1e3a5e15e66383f49` |
| `08-live-delegation.txt` | `9ae9270e2a807c8c2b7720ea327e693a577ed029cd6bb7a248590e8a29243544` |

`.omo/evidence/20261011-v2-user-model-audit/` (this audit supplied a valid negative child)

| File | sha256 |
|---|---|
| `db-primary-evidence.json` | `1bf88d7623ec964a7704c6f1494107f47f0a96e57e4ac01829832988d611cc62` |
| `neg-live.json` | `cdf7cfac82df814e5ee5d351d12f5448fa6cb949149bae0f641e381280568e65` |
| `pos-live.json` | `fdf1f94137272a9b0a3bc02d6c98bda41b600c3ed5079c375c8df01a7c0c3028` |

`.omo/evidence/20261011-rigel-lab-acceptance/`

| File | sha256 |
|---|---|
| `api-config.json` | `c0d1bdc1ffaa6d2d9b455a85529e9671aa4355749f4b9b36579e3239ada87262` |
| `lab-acceptance.txt` | `8dbf9bb39c1d48d8e9f848115d62b848f41557c18da7a8e31c123809d15f3924` |

## Lab / V1 state (read-only)

- `opencode-v2-lab.service`: **active**.
- Lab live config `~/.local/share/opencode-v2-lab/home/.omo/omo.jsonc`: **absent** (no pin; the test pin
  written during the earlier live gate was removed).
- V1 protected-surfaces digest (`v1-protected-surfaces.mjs --digest "$HOME"`):
  `7a8bbf98ae8751e7c8337249266d444967c90d371127b8d0f688e1ff38e6b771`. V1 was not addressed or modified.

## Do next (on the replacement contract only)

1. Wait for Codex to record the user's **confirmed complete decision table**.
2. Do not implement the superseded matrix or addendum.
3. When the replacement arrives: implement in this worktree, add/extend the owner tests, run the
   focused + profile suites and `validate-profile`, then live QA on `opencode-v2-lab.service`
   (restore the lab; confirm V1 untouched), and update this handoff. Still **no commit/push/PR** unless
   explicitly authorized.
