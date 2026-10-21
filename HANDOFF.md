# HANDOFF — Oh My Rigel V2 correction session (2026-10-16)

Factual handoff for context rotation. **No code or git changes were made in this step** (this file is untracked; not committed).

## Session outcome

- Branch: `correct/v2-fail-partial-20261016` (local worktree `/home/gabodev/oh-my-rigel-worktrees/omr-correction-fail-partial`).
- **One logical commit** `1c8d3cec5e5af3246b11d09938934d4b34843a60` — 20 files (`+481 / -752`); no `packages/**`, no markdown, no `.omo/**` evidence committed.
- **PR #40** (`https://github.com/GaboEI/oh-my-rigel/pull/40`) — base `v2-mirror`, head `1c8d3cec5`. **Approved and merged.**
- **Canonical merge:** `185e9080dcc11b32450517023dae364c6ea9a412` ("Merge PR #40 …"), parents `63ebc242d` + `1c8d3cec5`; the merge tree equals the committed tree; `63ebc242d..185e9080d` does not touch `packages/`.

## What landed (factual)

- **6 code corrections** (each with owner tests + a deployed-artifact smoke): write-existing-file guard actually blocks (30); notepad append-only guard blocks (32); plan-format validator uses the real `event.output` (34); question-label truncator accepts `question` (43); delegate-retry reads the real `result.error` form (74); legacy-plugin notice detects early at `setup` (61).
- **Dead rule retired:** the `fsync-skip-warning` rule (no live producer) was removed from the runtime and its catalog claim retired (`estado: desactivada`, `v2: no_migrada`) (37).
- **3 catalog claims corrected:** keyword `team mode` (not bare `team`) (50); panel visualization narrowed to a session already inside tmux (55); unstable-agent monitoring narrowed to real failures + idle-with-background (75). Claims only — no new machinery.
- **P3a — row 42 (`interactive_bash`): NO-GO, no code.** The native host PTY is not cleanly consumable from the plugin (`/api/pty` output path `connect-token` returns 403; no read/snapshot endpoint; output only via WebSocket with the raw service credential). No `node-pty`, no tmux bridge, no duplicated host fallback. Row 42 stays a documented seam gap.

## NLS1 canonical state (final)

- **Installed SHA: `185e9080dcc11b32450517023dae364c6ea9a412`.**
- Canonical source root: `/root/omr-s7-185e9080d` (git worktree of `/root/oh-my-rigel`, detached at `185e9080d`).
- Runtime: `/root/.local/share/oh-my-rigel/versions/1/runtime`; version dir digest `e2959a4aa2e6cbac7f3f4afe…` (deterministic — a repeated install from the same root reproduced this digest byte-identically).
- **HTTP 200 · MCP 4/4 connected (context7, grep_app, lsp, ssh) · PTY list empty · no candidate/scratch/PTYS residue.**
- Rollback proven: `rigel-nls1-rollback.sh` → `ROLLBACK_VERIFIED_BYTE_IDENTICAL` (restores the previous canonical `63ebc242d` runtime, digest `9b04b32c…`), then a clean reinstall of `185e9080d`.
- Deployed modules verified byte-for-byte against the `185e9080d` source (6/7; `rigel-v2-native.mjs` is bundled into `index.js`, which carries the change markers).

## Real pending items (not started; no invented credentials)

1. **15 BLOCKED** — the remaining blocked rows of the 81-row functional inventory. They need EXTERNAL, OPERATOR-PROVIDED dependencies (provider/credential/channel/component), not code. None may be unblocked by inventing a provider, model, CLI, MCP, credential, or substitute.
2. **2 without public activation** — rows 71 (`config migrate`) and 79 (`telemetry`): no public activation route; recorded only; product decision or claim correction, no forced route.
3. **13 PARTIAL, already classified** — the 13 partial rows were classified in P0 (`LIMITE-EVIDENCIA` / `NATIVO-*` / `CAPA-PROPIA-OBSERVADA`). No code pending; re-open only if a non-destructive trigger becomes inducible.
4. **Row 42 — NO-GO** — documented seam gap (above). Re-open only if the host exposes a client-usable PTY output path (a usable `connect-token` or a read/snapshot endpoint for `/api/pty`), or with an explicit operator instruction.

## Evidence + Obsidian (paths)

Local evidence (gitignored `.omo/evidence/`, never committed):
- `.omo/evidence/20261016-v2-blocked81-correction-plan/` — binding plan.
- `.omo/evidence/20261016-v2-correction-p0/` — P0 native/host verification.
- `.omo/evidence/20261016-v2-correction-p2a/` — 6 defects.
- `.omo/evidence/20261016-v2-correction-p2b/` — claims + dead-rule retirement.
- `.omo/evidence/20261016-v2-correction-p3a/` — row 42 NO-GO.
- `.omo/evidence/20261016-v2-correction-final-precommit/` — final pre-commit gate (includes `pr.patch`, `INTEGRATION.txt`).
- `.omo/evidence/20261016-v2-correction-s7-postmerge/` — S7 post-merge / second acceptance.

Obsidian notes (`mantenimiento/auditoria-web/`):
- `2026-10-16-plan-correccion-fail-partial.md` (plan index) and the phase notes: `-p0-correccion-native-first`, `-p2a-correccion-defectos-confirmados`, `-p2b-correccion-claims-retiro`, `-p3a-interactive-bash-pty-no-go`, `-final-precommit-p2a-p2b`, `-s7-postmerge-segunda-aceptacion`.

## Next gates (no new work authorized here)

- Any further change follows the same protocol: an explicit operator authorization per phase → a task-owned worktree → a plan on disk → evidence-bound local gates → an NLS1 candidate via the official route under snapshot with a byte-identical rollback → a single PR whose base is `v2-mirror` (never `dev`) with a merge commit.
- Do NOT invent providers, models, CLIs, MCPs, credentials, channels, or substitutes. If a row cannot be exercised on the live surface, report it blocked.
- The `dev` upstream is not the approved base; the approved base is `v2-mirror`.

## Environment

- Local worktree: `node_modules` installed (`bun install`); `.omo/**` gitignored. Tracked tree is clean at `1c8d3cec5`.
- NLS1: only live validation surface. The main clone `/root/oh-my-rigel` fetches `origin/v2-mirror`; deployed canonical roots are git worktrees.
