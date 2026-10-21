# Confirmed model-resolution contract

This document records the complete contract confirmed by the user. It supersedes every earlier model-resolution interpretation.

## Installation and source of truth

- Every agent receives an initial product-default model in the installation manifest.
- The manifest is used only during installation to seed those initial values into `~/.omo/omo.jsonc`.
- After seeding, the manifest is never consulted again, including on invalid models, provider failures, unavailable models, restart, or delegation.
- `~/.omo/omo.jsonc` is the sole persistent source of truth after installation.

## Persistent configuration and fallback

- Every agent may have one or multiple ordered model candidates in `~/.omo/omo.jsonc`, preserving the existing multi-model configuration facility.
- Candidates are attempted in the user's configured order. A failed or unavailable candidate advances to the next configured candidate.
- Exhausting the configured candidates fails that agent; it never falls back to the manifest.
- If the user intentionally leaves an agent's model configuration empty, that agent inherits OpenCode's current global model.
- Preserve the complete existing per-agent configuration schema, not only model identifiers: ordered secondary/fallback models, model variants such as strong, weak, default, and every other currently supported option must retain their present meaning and behavior.
- Do not delete, reinterpret, flatten, or silently discard existing or unknown supported fields while resolving models.
- A reinstall or upgrade must not silently overwrite an existing user's model choices, fallback chain, variants, or adjacent agent configuration.

## Session-local override

- A model selected by the user with Ctrl+X M has priority for that agent in that specific session.
- The selection is session-local: it does not rewrite `~/.omo/omo.jsonc` and does not change other sessions.
- A new session returns to the persistent JSON configuration unless the user selects another session-local model.
- Secondary agents that cannot receive Ctrl+X M continue to use their JSON configuration and its ordered fallback chain.

## Guided configuration command

- Add an OpenCode command named `/rmo-models`. It is a command, not a skill.
- The command must be usable from whichever agent is currently active and guide the user through inspecting and changing the existing per-agent configuration in `~/.omo/omo.jsonc`.
- It must support the complete existing configuration surface: primary model, ordered fallback candidates, variants, and every other currently supported per-agent option.
- It must preserve fields and agents the user did not ask to change, validate the resulting configuration, and present an exact change summary before completion.
- It must not restart OpenCode, stop the server, kill the current session, or execute any other destructive lifecycle action.
- At completion it must show the user the verified, currently supported command needed to restart/reload OpenCode so the changes take effect. Do not hard-code or claim `opencode server reset` until the actual installed CLI documents/supports that exact invocation.
- The user decides when to run the restart/reload command.

## OpenAI-only agent

- Resolve the real agent identifier by inspecting V1 and V2; do not assume its name without evidence.
- Preserve V1 behavior exactly: if the effective configuration for this OpenAI-only agent is wrong, nonexistent, or resolves to a non-OpenAI provider, the application remains healthy and the agent is not registered, so it disappears completely from the interface.
- The failure must not crash the application, emit a global failure, or alter any other agent, delegation, or orchestration behavior.
- The agent appears again when its effective configuration resolves to an acceptable OpenAI model.
- Characterize V1 and determine/test the interaction between this rule and the existing ordered candidate chain from real evidence; do not invent a new fallback semantic.

## Protected invariants and gates

- Delegation, orchestration, routing, prompts, categories, permissions, continuity, background handoff, and Sisyphus behavior are protected invariants.
- Establish baseline characterization and an explicit allowed behavioral diff before implementation.
- Cover installation seeding, post-install manifest irrelevance, JSON-only resolution, ordered candidates, empty configuration, Ctrl+X M session scope, new-session reset, secondary behavior, and OpenAI-only disappearance in sync and background paths where applicable.
- Add preservation tests for all existing model-chain, variant, and adjacent per-agent options, including upgrade/reinstall behavior.
- Add command-level tests for `/rmo-models`: availability from every agent type, guided edits, preservation of untouched fields, validation and change summary, cancellation/no-op safety, malformed input, atomic write behavior, and proof that it never terminates or restarts the active session.
- Use real child sessions for positive and negative evidence, restore all laboratory mutations byte-identically, and run focused plus complete suites.
- Do not commit, push, or open a PR until Codex completes a new independent audit.
