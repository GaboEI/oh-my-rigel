# Gabo profile kit

This kit is a portable configuration template for Oh My Rigel, a community
fork of OmO adapted for the **OpenCode V2** runtime. It is inert until a
future installer copies its files into an **isolated** OpenCode/XDG environment
and activates `OMO_PROFILE=gabo`. It does not fork, pin, or distribute
OpenCode itself.

It contains no credentials, accounts, model catalog, SSH targets, database settings, or WatchdogVPN rules. Every machine-specific path is resolved through `$HOME` / `os.homedir()` or an env override (`RIGEL_OPENCODE_V2_BIN`, `RIGEL_V2_BINARY`), and profile validation scans all tracked artifacts for personal-path leaks.

## Layout

- `omo.jsonc` defines the OmO `gabo` profile: Tavily, one external Context7, internal Goal ownership, Sisyphus as the merged orchestrator, and canonical Playwright. The internal Goal is enabled by default (`goal.enabled: true`); the retired `@prevalentware/opencode-goal-plugin` and its state/cache must stay absent.
- `opencode/prompts/sisyphus-orchestration.md` adds the delegation and acceptance contract to upstream Sisyphus. `opencode/agents/judge.md` packages Gabo's independent Juez methodology, adapted to generic Rigel terminology and registered as the V2 `judge` agent from the native manifest. Momus is a distinct plan critic, never a Juez alias.
- `opencode/rigel-v2-native*.mjs` is the native OpenCode V2 runtime. It resolves agents and creates delegated sessions through V2 APIs directly; it does not execute OmO's V1 plugin hooks through a compatibility bridge. The retired bridge and legacy activation paths are quarantined under `attic/`, and profile validation fails if any active file references them.
- `attic/` holds the quarantined V1 bridge, dist/adapter activation switches, live-trial service wrappers, and the five bridge-based QA contracts. It is historical reference only: it is never built, activated, or counted by the acceptance suite.
- `skills/` bundles portable governance/support skills, the complete Obsidian writing/audit/CLI suite, `tui-design` with its references and starter templates, and `skill-creator` with its evaluation resources.
- `opencode/opencode.json` is a test template. The runner substitutes `__OMO_PLUGIN_ENTRY__` with the local plugin entrypoint; it bundles only the protective SSH MCP command. Docker remains an opt-in external MCP. It must never be copied unchanged to a user configuration.
- `integration-manifest.json` records the core per-machine connections (Context7, Playwright, and Obsidian), opt-in integrations (GitHub and Postgres), and the excluded/quarantined services.

## Validation

Run `node profiles/gabo/validate-profile.mjs`. It validates the static integration contract and rejects personal paths, secret markers, WatchdogVPN content, a duplicate OmO Context7, a competing OmO root goal, and a non-placeholder plugin path.

Run `bash profiles/gabo/run-v2-isolated.sh` to boot the host OpenCode **V2** binary (default `$HOME/.opencode/bin/opencode`, override with `RIGEL_V2_BINARY`) against a disposable Docker home and XDG tree. The runner copies only this kit, mounts the fork source read-only, starts an authenticated local server, verifies the V2 OpenAPI surface plus the selected profile and agent definitions, and removes the sandbox on exit. It does not mount or read the active OpenCode configuration.

Run `bash profiles/gabo/run-delegation-preflight.sh` to execute that isolated smoke plus focused tests of OmO's real delegated-session engine. It proves session creation, synchronous routing, continuation metadata, and child-session permission isolation; it deliberately does not use a model provider or account.

Run `bash profiles/gabo/run-session-authority-preflight.sh` to verify that the Gabo profile owns the Goal internally (external `@prevalentware/opencode-goal-plugin` absent) while retaining OmO's delegated-child continuation and Context Mode as the root context authority.

Run `bash profiles/gabo/run-mcp-policy-preflight.sh` to validate singleton ownership, the embedded protective SSH MCP, and the absence of credentials or duplicate external MCP declarations.

Run `bash profiles/gabo/run-all-isolated.sh` for the full non-account acceptance suite. See [UPSTREAM-MAINTENANCE.md](UPSTREAM-MAINTENANCE.md) for the isolated upstream-review and rollback procedure.

Run `bash profiles/gabo/run-lab-acceptance.sh` to validate the isolated V2 laboratory (`opencode-v2-lab.service`, roots under `~/.local/share/opencode-v2-lab`). It never launches OpenCode, never uses Docker, and never addresses V1: it checks the unit's isolation, the service binary and port, the lab API, that every config source resolves inside the lab (no V1 path), and read-only V1 integrity before/after. Add `--refresh` to rebuild the lab runtime first through `apply-v2-runtime-service.sh`.

For the parallel V2 laboratory, `bash profiles/gabo/apply-v2-runtime-service.sh` refreshes the native V2 runtime and its generated agent manifest through `opencode-v2-lab.service`. The runtime registers the manifest through `agent.transform` and `agent.reload`; it does not write agents into OpenCode's V1 configuration. The script never addresses `opencode-lan.service`.

## Activation for a future isolated test

The test runner creates a temporary home, copies `omo.jsonc` as `<temporary-home>/.omo/omo.jsonc`, copies the OpenCode template, substitutes the local plugin entrypoint, and sets `OMO_PROFILE=gabo`. It will never use Gabo's real configuration directory.
