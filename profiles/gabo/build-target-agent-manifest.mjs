#!/usr/bin/env bun
/**
 * Builds a COMPLETE native agent manifest from the target sources only.
 *
 * The target generator (generate-v2-agents.mjs) requires every id in
 * v2-agent-selection.json's orchestratedAgentIds to be present in the plugin's
 * `config.agent` output and throws otherwise. On a clean install (no configured
 * model, no provider inventory) the plugin's `maybeCreateAtlasConfig` returns
 * undefined because `applyModelResolution` yields nothing, while every other
 * agent still resolves through its fallback chain head (general-agents.ts falls
 * back to `getFirstFallbackModel`; the Atlas wrapper does not). Atlas is
 * therefore dropped and the generator aborts.
 *
 * This builder runs the SAME plugin config pipeline (via dist/index.js) and,
 * for any orchestrated agent the plugin did not produce (currently only
 * "Atlas - Plan Executor"), reuses the plugin's OWN construction path: it
 * re-runs the pipeline with the agent's own fallback-chain head as the selected
 * model, so the plugin's `maybeCreateAtlasConfig` resolves and emits a record
 * shaped exactly like the other agents' records. The chain head comes from
 * AGENT_MODEL_REQUIREMENTS["atlas"] through the plugin's own
 * `getFirstFallbackModel`, so no agent model definition is altered.
 *
 * This is a manifest materializer only. It never edits runtime modules, the
 * installer, generate-v2-agents.mjs, or any agent source/model definition.
 *
 * Usage:
 *   bun profiles/gabo/build-target-agent-manifest.mjs \
 *     [--input <opencode.json>] --output <target-agent-manifest.mjs> \
 *     [--selection <v2-agent-selection.json>] [--judge <judge.v2.json>] \
 *     [--directory <cwd>] [--sandbox <dir>] [--keep-sandbox]
 *
 * The builder isolates itself by default: every state root (HOME, XDG_*,
 * goal-state) is redirected into a throwaway sandbox so the result never reads
 * or writes the user's real OpenCode V1 surfaces and is reproducible.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { AGENT_MODEL_REQUIREMENTS } from "../../packages/omo-opencode/src/shared/model-requirements.ts"
import { getFirstFallbackModel } from "../../packages/omo-opencode/src/agents/builtin-agents/model-resolution.ts"
import { getAgentConfigKey, getAgentDisplayName } from "../../packages/omo-opencode/src/shared/agent-display-names.ts"
import { sortAgentsByCanonicalOrder, canonicalAgentKey } from "./opencode/rigel-v2-native-agent-order.mjs"
import { agentChain } from "./opencode/rigel-v2-native-model-chains.mjs"
import {
  buildMcpPolicyEntry,
  deriveNativeGates,
  deriveNativeMinOpenCodeVersion,
  parseJsoncText,
  resolveNativePluginConfig,
} from "./opencode/rigel-v2-native-config.mjs"
import { stripLegacyGoalToolPermission } from "./opencode/rigel-v2-native-goal-quarantine.mjs"
import { rewriteLegacyDelegationToolExamples } from "./build/rigel-v2-native-prompt-tools.mjs"
import { readBundledVersion, runPluginConfig, withProcessEnv } from "./build-target-agent-plugin-config.mjs"
import { resolveManifestOpenclaw, stageProvisionedProfile } from "./build-target-agent-sandbox.mjs"
import { auditOpenclawSecretRefs } from "./opencode/rigel-v2-native-openclaw-secrets.mjs"
import { buildIsolatedV2Env } from "./isolated-v2-env.mjs"

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const sourceRoot = path.resolve(moduleDirectory, "../..")
const integrationManifest = JSON.parse(fs.readFileSync(path.join(moduleDirectory, "integration-manifest.json"), "utf8"))
const manifestMcpPolicy = integrationManifest?.mcpPolicy ?? {}

// Upstream 5a9bb74a4: an explicit user model on an agent (or a user
// `fallback_models` chain) is a RUNTIME concern: the runtime reads it from the
// live `~/.omo/omo.jsonc` directly. The manifest no longer bakes a personal
// `agentOverrides` map, so the manifest is never consulted for models.

/**
 * The only agents this builder can repair are those whose target source defines
 * a construction path but whose conditional factory can drop them. Today that
 * is Atlas alone. The chain-head model resolves through the plugin's own
 * `getFirstFallbackModel`, so the repaired record matches what the plugin would
 * have emitted had its wrapper fallen back like general-agents.ts.
 */
/**
 * Strip every `disabled_agents` declaration from the DISPOSABLE staged profile
 * copy, so the bake materializes a definition for every base agent.
 *
 * The four placements are the ones the OpenCode plugin view folds (layer root,
 * `[opencode]`, `profiles.<p>`, `profiles.<p>.[opencode]`). Deleting the key
 * rather than emptying it matters: the layer merge UNIONS these lists, so an
 * empty array in one placement could never mask a non-empty one in another.
 *
 * Returns whether the staged layer changed. An absent file (a build with no
 * `--profile-root`), a parse failure, or a layer with no declaration is a no-op:
 * nothing to neutralize means the bake already sees every definition.
 */
function neutralizeStagedDisabledAgents(stagedConfigPath) {
  if (!fs.existsSync(stagedConfigPath)) return false
  let layer
  try {
    layer = parseJsoncText(fs.readFileSync(stagedConfigPath, "utf8"))
  } catch {
    return false
  }
  if (!layer || typeof layer !== "object" || Array.isArray(layer)) return false
  const placements = [layer, layer["[opencode]"]]
  const profiles = layer.profiles && typeof layer.profiles === "object" && !Array.isArray(layer.profiles) ? layer.profiles : {}
  for (const profile of Object.values(profiles)) {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) continue
    placements.push(profile, profile["[opencode]"])
  }
  let changed = false
  for (const placement of placements) {
    if (!placement || typeof placement !== "object" || Array.isArray(placement)) continue
    if (!Object.prototype.hasOwnProperty.call(placement, "disabled_agents")) continue
    delete placement.disabled_agents
    changed = true
  }
  if (!changed) return false
  fs.writeFileSync(stagedConfigPath, `${JSON.stringify(layer, null, 2)}\n`)
  return true
}

function resolveRepairModel(configKey) {
  if (configKey !== "atlas") return undefined
  const requirement = AGENT_MODEL_REQUIREMENTS[configKey]
  const firstFallback = getFirstFallbackModel(requirement)
  return firstFallback?.model
}

/**
 * Builds the manifest object. Returns `{ manifest, report }`; when `outputPath`
 * is set the manifest is also written as a `export default { ... }` module.
 */
export async function buildTargetAgentManifest(options = {}) {
  const {
    inputPath,
    outputPath,
    selectionPath,
    judgePath,
    directory: directoryOption,
    sandbox: sandboxOption,
    profileRoot,
    keepSandbox = false,
  } = options

  // A provisioned profile home is the installer's freshly created generator
  // home. It is NOT used as HOME/sandbox directly (that would fail the isolation
  // guard whenever it sits under the real home). Instead a throwaway mkdtemp
  // sandbox is created outside the real home and the MINIMAL provisioned profile
  // (`.omo/omo.jsonc` + `.omo/opencode/prompts/**`) is copied into it as real
  // files, so the UNMODIFIED guard passes (HOME inside the sandbox) while the
  // plugin pipeline still reads `<home>/.omo/omo.jsonc` and its prompts. The
  // provisioned root is only read, never written or deleted.
  const provisionedRoot = profileRoot ? path.resolve(profileRoot) : undefined
  const sandbox = sandboxOption ? path.resolve(sandboxOption) : fs.mkdtempSync(path.join(os.tmpdir(), "rigel-target-agent-manifest-"))
  const ownsSandbox = sandboxOption === undefined
  fs.mkdirSync(sandbox, { recursive: true })
  const sandboxHome = path.join(sandbox, "home")
  fs.mkdirSync(sandboxHome, { recursive: true })
  if (provisionedRoot) stageProvisionedProfile(provisionedRoot, sandboxHome)
  const stagedConfigPath = path.join(sandboxHome, ".omo", "omo.jsonc")
  const isolatedEnv = buildIsolatedV2Env({
    sandbox,
    home: sandboxHome,
    ...(provisionedRoot ? { extra: { OMO_PROFILE: "gabo" } } : {}),
  })
  const directory = directoryOption ? path.resolve(directoryOption) : sandboxHome
  fs.mkdirSync(directory, { recursive: true })

  const rawConfig = inputPath ? JSON.parse(fs.readFileSync(inputPath, "utf8")) : {}

  try {
    return await withProcessEnv(isolatedEnv, async () => {
      // Resolve the INSTALL-TIME plugin view BEFORE the bake, because the bake is
      // about to be neutralized for `disabled_agents` (see below). This view is
      // the one the manifest records: `metadata.global.disabled.agents` must keep
      // naming the install-time denylist so the runtime filters the roster.
      const pluginView = resolveNativePluginConfig({ directory, env: isolatedEnv })
      const manifestOpenclaw = resolveManifestOpenclaw({ directory, env: isolatedEnv, pluginView, stagedConfigPath })
      // A disabled agent must still have a DEFINITION in the manifest, or removing
      // it from `disabled_agents` later could not register it without a
      // reinstall. The plugin pipeline returns NO record for a denied agent
      // (`createBuiltinAgents` drops it), so the bake reads a disposable copy of
      // the staged layer without the key. The staged file is throwaway; the user
      // profile is never touched, and `pluginView` above already recorded the
      // denylist the runtime enforces.
      neutralizeStagedDisabledAgents(stagedConfigPath)
      const primary = await runPluginConfig(rawConfig, directory)
      const primaryAgents = primary.agent || {}
      // Credential references are written to the manifest VERBATIM (the writer below
      // copies the block, and nothing here resolves it), which is what keeps a
      // secret out of the installed file. A plaintext token still works, but it is
      // the deprecated form, so it is reported ONCE for the whole run: naming the
      // key paths is enough, and the values are never read for the message.
      const openclawSecrets = auditOpenclawSecretRefs(manifestOpenclaw.config)
      if (openclawSecrets.plaintext.length > 0) {
        console.error(`Rigel target agent manifest: plaintext OpenClaw credential at ${openclawSecrets.plaintext.join(", ")} is deprecated; use "env:VAR" or { "env": "VAR" } so the manifest carries the reference`)
      }
      if (openclawSecrets.invalid.length > 0) {
        console.error(`Rigel target agent manifest: OpenClaw credential at ${openclawSecrets.invalid.join(", ")} is neither a plaintext token nor an "env:VAR" / { "env": "VAR" } reference; that surface stays disabled at runtime`)
      }
      const disabledAgentKeys = new Set((pluginView.disabled?.agents ?? []).map((id) => canonicalAgentKey(id)))
      const selection = selectionPath ? JSON.parse(fs.readFileSync(selectionPath, "utf8")) : null

      const repairedIds = []
      const unavailableDisabledIds = []
      const selected = {}
      for (const id of selection?.orchestratedAgentIds ?? Object.keys(primaryAgents)) {
        // Repair runs BEFORE the disabled classification: a disabled agent still
        // needs its definition, and the fallback repair is the ONLY path that can
        // produce one for an agent whose factory is conditional (Atlas). Skipping a
        // disabled id first made the definition permanent, so removing the name from
        // the live `disabled_agents` could never register it without a reinstall.
        // Only an id that stays missing AFTER the repair is unavailable, and only
        // when it is disabled, because a disabled agent with no definition is inert.
        let record = primaryAgents[id]
        if (!record) {
          // Repair: re-run the plugin's own pipeline with the agent's fallback
          // chain head selected, so `maybeCreateAtlasConfig` resolves and emits
          // a record shaped exactly like the other agents' records.
          const configKey = getAgentConfigKey(id)
          const repairModel = resolveRepairModel(configKey)
          if (repairModel) {
            const repaired = await runPluginConfig(rawConfig, directory, repairModel)
            record = repaired.agent?.[id] ?? repaired.agent?.[getAgentDisplayName(configKey)]
            if (record) repairedIds.push(id)
          }
        }
        if (!record) {
          if (disabledAgentKeys.has(canonicalAgentKey(id))) {
            unavailableDisabledIds.push(id)
            continue
          }
          throw new Error(`OmO did not generate the required agent: ${id}`)
        }
        selected[id] = record
      }
      for (const id of selection?.optionalAgentIds ?? []) {
        if (primaryAgents[id]) selected[id] = primaryAgents[id]
      }
      for (const id of selection?.demotedAgentIds ?? []) {
        if (primaryAgents[id]) selected[id] = primaryAgents[id]
      }
      for (const [id, mode] of Object.entries(selection?.nativeAgentModeOverrides ?? {})) {
        if (selected[id] && ["primary", "subagent", "all"].includes(mode)) {
          selected[id] = { ...selected[id], mode }
        }
      }
      const judge = judgePath ? JSON.parse(fs.readFileSync(judgePath, "utf8")) : null
      if (selection?.independentJudge?.id && !judge) throw new Error("Rigel Judge definition is required")
      if (judge) selected[selection?.independentJudge?.id ?? "judge"] = judge

      // Manifest order must be canonical at the source: core agents come first in
      // Sisyphus -> Hephaestus -> Prometheus -> Atlas order; every other key
      // keeps its insertion order, so the judge stays in the remainder tail.
      // SEED-ONLY: each record also carries its ordered canonical `chain` so the
      // installer can materialize the FULL fallback chain into the user's live
      // `~/.omo/omo.jsonc`. The runtime NEVER consults this field (it resolves
      // models from the live JSON); the manifest only seeds.
      const orderedSelected = {}
      for (const { id } of sortAgentsByCanonicalOrder(Object.keys(selected).map((key) => ({ id: key, name: key })))) {
        const chain = agentChain(id)
        const record = chain ? { ...selected[id], chain } : selected[id]
        orderedSelected[id] = typeof record?.prompt === "string"
          ? { ...record, prompt: rewriteLegacyDelegationToolExamples(record.prompt) }
          : record
      }

      const gates = deriveNativeGates(pluginView)
      // A V1 tool default can carry a hard global disable for a family the native
      // profile explicitly enables (`task_*: false` is the default). The native
      // gate wins.
      const tools = stripLegacyGoalToolPermission({ ...(primary.tools ?? {}) })
      if (gates.task_system) tools["task_*"] = true
      if (gates.goal) tools["goal_*"] = true
      if (gates.monitor) tools["monitor_*"] = true
      if (gates.team_mode) tools["team_*"] = true
      if (gates.interactive_bash) tools["interactive_bash"] = true
      if (gates.hashline_edit) tools["hashline_edit"] = true

      const manifest = {
        defaultAgent: primary.default_agent,
        agents: orderedSelected,
        metadata: {
          generatedBy: "Oh My Rigel V2 target agent manifest builder",
          profile: isolatedEnv.OMO_PROFILE || null,
          global: {
            tools,
            permission: { ...(primary.permission ?? {}) },
            gates,
            maxTools: pluginView.experimental?.max_tools,
            preemptiveCompactionThreshold: pluginView.experimental?.preemptive_compaction_threshold,
            truncateAllToolOutputs: pluginView.experimental?.truncate_all_tool_outputs === true,
            mcp: { disabled: [...(pluginView.disabled_mcps ?? [])], envAllowlist: [...(pluginView.mcp_env_allowlist ?? [])] },
            repoRoot: sourceRoot,
            mcpPolicy: buildMcpPolicyEntry(manifestMcpPolicy),
            tmuxVisualization: pluginView.team_mode?.tmux_visualization === true,
            minOpenCodeVersion: deriveNativeMinOpenCodeVersion(integrationManifest),
            bundledVersion: readBundledVersion(sourceRoot),
            categories: { ...(pluginView.categories ?? {}) },
            disabled: { ...(pluginView.disabled ?? {}) },
            ...(manifestOpenclaw.config ? { openclaw: manifestOpenclaw.config } : {}),
            monitor: pluginView.monitor,
            teamMode: pluginView.team_mode,
          },
        },
        modes: { defaultUltrawork: selection?.nativeModes?.defaultUltrawork === true },
      }

      if (outputPath) {
        fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true })
        fs.writeFileSync(outputPath, `// Generated by build-target-agent-manifest.mjs; do not edit.\nexport default ${JSON.stringify(manifest, null, 2)}\n`)
      }

      return {
        manifest,
        report: {
          output: outputPath ? path.resolve(outputPath) : null,
          agentCount: Object.keys(orderedSelected).length,
          agentIds: Object.keys(orderedSelected),
          repairedIds,
          disabledAgentIds: [...disabledAgentKeys],
          unavailableDisabledIds,
          sandbox,
          openclaw: manifestOpenclaw.report,
        },
      }
    })
  } finally {
    if (ownsSandbox && !keepSandbox) {
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  }
}

function parseArgs(argv) {
  const take = (flag) => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : undefined
  }
  return {
    inputPath: take("--input"),
    outputPath: take("--output"),
    selectionPath: take("--selection"),
    judgePath: take("--judge"),
    directory: take("--directory"),
    sandbox: take("--sandbox"),
    profileRoot: take("--profile-root"),
    keepSandbox: argv.includes("--keep-sandbox"),
  }
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2))
  if (!options.outputPath) {
    console.error("Usage: bun build-target-agent-manifest.mjs [--input <opencode.json>] --output <manifest.mjs> [--selection <v2-agent-selection.json>] [--judge <judge.v2.json>] [--directory <cwd>] [--profile-root <dir>] [--sandbox <dir>] [--keep-sandbox]")
    process.exit(2)
  }
  const { report } = await buildTargetAgentManifest(options)
  console.log(JSON.stringify(report))
}
