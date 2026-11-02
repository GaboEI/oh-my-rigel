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
import pluginModule from "../../dist/index.js"
import { AGENT_MODEL_REQUIREMENTS } from "../../packages/omo-opencode/src/shared/model-requirements.ts"
import { getFirstFallbackModel } from "../../packages/omo-opencode/src/agents/builtin-agents/model-resolution.ts"
import { getAgentConfigKey, getAgentDisplayName } from "../../packages/omo-opencode/src/shared/agent-display-names.ts"
import { sortAgentsByCanonicalOrder, canonicalAgentKey } from "./opencode/rigel-v2-native-agent-order.mjs"
import { agentChain } from "./opencode/rigel-v2-native-model-chains.mjs"
import {
  buildMcpPolicyEntry,
  deriveNativeGates,
  deriveNativeMinOpenCodeVersion,
  resolveNativePluginConfig,
} from "./opencode/rigel-v2-native-config.mjs"
import { stripLegacyGoalToolPermission } from "./opencode/rigel-v2-native-goal-quarantine.mjs"
import { rewriteLegacyDelegationToolExamples } from "./opencode/rigel-v2-native-prompt-tools.mjs"
import { buildIsolatedV2Env } from "./isolated-v2-env.mjs"

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const sourceRoot = path.resolve(moduleDirectory, "../..")
const integrationManifest = JSON.parse(fs.readFileSync(path.join(moduleDirectory, "integration-manifest.json"), "utf8"))
const manifestMcpPolicy = integrationManifest?.mcpPolicy ?? {}

// The native runtime compares the bundled OmO build version against the
// published package's npm dist-tags. The deployed runtime carries no
// package.json of its own, so the version is materialized here to be read from
// the manifest. An unreadable source degrades to an absent field.
function readBundledVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"))
    return typeof pkg.version === "string" && pkg.version ? pkg.version : undefined
  } catch (error) {
    console.error(`Rigel target agent manifest: could not read bundled version: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

// Upstream 5a9bb74a4: an explicit user model on an agent (or a user
// `fallback_models` chain) is a RUNTIME concern: the runtime reads it from the
// live `~/.omo/omo.jsonc` directly. The manifest no longer bakes a personal
// `agentOverrides` map, so the manifest is never consulted for models.

/**
 * Copies only the provisioned profile files the plugin pipeline must read
 * (`<profileRoot>/.omo/omo.jsonc` and `<profileRoot>/.omo/opencode/prompts/**`)
 * into the sandbox home as real file copies. Nothing else from the provisioned
 * root is touched, and no symlink is ever created (copyFileSync writes content).
 */
function stageProvisionedProfile(profileRoot, sandboxHome) {
  const omoSource = path.join(profileRoot, ".omo", "omo.jsonc")
  if (!fs.existsSync(omoSource)) {
    throw new Error(`provisioned profile home is missing .omo/omo.jsonc: ${profileRoot}`)
  }
  const omoDestination = path.join(sandboxHome, ".omo", "omo.jsonc")
  fs.mkdirSync(path.dirname(omoDestination), { recursive: true })
  fs.copyFileSync(omoSource, omoDestination)

  const promptsSource = path.join(profileRoot, ".omo", "opencode", "prompts")
  if (fs.existsSync(promptsSource)) {
    copyDirectory(promptsSource, path.join(sandboxHome, ".omo", "opencode", "prompts"))
  }
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name)
    const destinationPath = path.join(destination, entry.name)
    if (entry.isDirectory()) copyDirectory(sourcePath, destinationPath)
    else if (entry.isFile()) fs.copyFileSync(sourcePath, destinationPath)
  }
}

/**
 * The only agents this builder can repair are those whose target source defines
 * a construction path but whose conditional factory can drop them. Today that
 * is Atlas alone. The chain-head model resolves through the plugin's own
 * `getFirstFallbackModel`, so the repaired record matches what the plugin would
 * have emitted had its wrapper fallen back like general-agents.ts.
 */
function resolveRepairModel(configKey) {
  if (configKey !== "atlas") return undefined
  const requirement = AGENT_MODEL_REQUIREMENTS[configKey]
  const firstFallback = getFirstFallbackModel(requirement)
  return firstFallback?.model
}

const client = { app: { log: async () => undefined }, session: { messages: async () => ({ data: [] }) } }
const serverUrl = new URL("http://127.0.0.1:4096")

// Swaps the whole process environment for a run so the plugin pipeline resolves
// every state root inside the isolated sandbox, then restores it. Nothing else
// in the process observes the sandbox.
async function withProcessEnv(env, run) {
  const saved = { ...process.env }
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  try {
    return await run()
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, saved)
  }
}

async function runPluginConfig(rawConfig, directory, model) {
  const clone = structuredClone(rawConfig)
  if (model) clone.model = model
  const hooks = await pluginModule.server({ directory, client, serverUrl }, {})
  try {
    await hooks.config(clone)
  } finally {
    await hooks.dispose?.()
  }
  return clone
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
      const primary = await runPluginConfig(rawConfig, directory)
      const primaryAgents = primary.agent || {}

      // Resolve the user plugin view so a `disabled_agents` entry can drop an
      // agent from the manifest instead of failing generation, matching the
      // target generator.
      const pluginView = resolveNativePluginConfig({ directory, env: isolatedEnv })
      const disabledAgentKeys = new Set((pluginView.disabled?.agents ?? []).map((id) => canonicalAgentKey(id)))
      const selection = selectionPath ? JSON.parse(fs.readFileSync(selectionPath, "utf8")) : null

      const repairedIds = []
      const selected = {}
      for (const id of selection?.orchestratedAgentIds ?? Object.keys(primaryAgents)) {
        if (disabledAgentKeys.has(canonicalAgentKey(id))) continue
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
        if (!record) throw new Error(`OmO did not generate the required agent: ${id}`)
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
            bundledVersion: readBundledVersion(),
            categories: { ...(pluginView.categories ?? {}) },
            disabled: { ...(pluginView.disabled ?? {}) },
            ...(pluginView.openclaw ? { openclaw: pluginView.openclaw } : {}),
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
          sandbox,
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
