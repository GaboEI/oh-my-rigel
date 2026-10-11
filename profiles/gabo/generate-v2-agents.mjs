#!/usr/bin/env node
/**
 * Materializes selected OmO V1-generated agents as a data-only manifest for
 * the native V2 AgentEditor runtime. It never edits OpenCode configuration.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import legacyModule from "../../dist/index.js"
import { sortAgentsByCanonicalOrder } from "./opencode/rigel-v2-native-agent-order.mjs"
import { deriveNativeGates, deriveNativeMinOpenCodeVersion, resolveNativePluginConfig } from "./opencode/rigel-v2-native-config.mjs"
import { agentChain } from "./opencode/rigel-v2-native-model-chains.mjs"
import { SISYPHUS_AGENT_ID, SISYPHUS_PROMPT_IDENTITY_MODELS, applySisyphusFormatExampleFix, disposeBakeHooks, extractModelName, fixSisyphusAgentMap } from "./opencode/rigel-v2-native-sisyphus-prompt.mjs"

const args = process.argv.slice(2)
const take = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }
const inputPath = take("--input")
const outputPath = take("--output")
const directory = take("--directory") || process.cwd()
const selectionPath = take("--selection")
const judgePath = take("--judge")
const profileRoot = take("--profile-root")
// T38: the native runtime registers the retained builtin MCP servers (grep_app,
// lsp) through `context.mcp.transform`. The lsp server command must resolve
// `packages/lsp-daemon` in the source tree, which the deployed runtime (staged
// under the lab state root) cannot discover by walking its own directory, so the
// repo root and the MCP retention policy are materialized into the manifest.
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const sourceRoot = path.resolve(moduleDirectory, "../..")

// The native runtime compares the bundled OmO build version against the
// published package's npm dist-tags (V1 `getBundledVersion` parity). The
// deployed runtime is staged flat under the lab state root and carries no
// package.json of its own, so the version is materialized here for the runtime
// to read from the manifest. An unreadable source degrades to an absent field.
function readBundledVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"))
    return typeof pkg.version === "string" && pkg.version ? pkg.version : undefined
  } catch (error) {
    console.error(`Rigel native agent manifest: could not read bundled version: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}
const integrationManifest = JSON.parse(fs.readFileSync(path.join(moduleDirectory, "integration-manifest.json"), "utf8"))
const manifestMcpPolicy = integrationManifest?.mcpPolicy ?? {}
if (!inputPath || !outputPath) {
  console.error("Usage: OMO_PROFILE=gabo node generate-v2-agents.mjs --input <opencode.json> --output <rigel-agent-manifest.mjs> --selection <v2-agent-selection.json> --judge <judge.v2.json> [--directory <cwd>]")
  process.exit(2)
}
const rawConfig = JSON.parse(fs.readFileSync(inputPath, "utf8"))
const config = structuredClone(rawConfig)
const client = { app: { log: async () => undefined }, session: { messages: async () => ({ data: [] }) } }
const hooks = await legacyModule.server({ directory, client, serverUrl: new URL("http://127.0.0.1:4096") }, {})

// T28: re-run the *same* registration pipeline for a different model to obtain
// the Sisyphus body that registration would have baked for it. Only the model
// changes; directory, profile, roster and category resolution stay identical, so
// a variant body is comparable to the primary bake byte for byte.
async function bakeAgentPromptForModel(model, agentId) {
  const clone = structuredClone(rawConfig)
  clone.model = model
  const variantHooks = await legacyModule.server({ directory, client, serverUrl: new URL("http://127.0.0.1:4096") }, {})
  try {
    await variantHooks.config(clone)
    return clone.agent?.[agentId]?.prompt
  } finally {
    await disposeBakeHooks(variantHooks, `${agentId} on ${model}`)
  }
}

// Sisyphus is the only agent whose prompt is reconciled at runtime. Bake the
// exact reachable set (the agent's fallback chain plus the manifest model),
// keyed by the bare model name (the provider does not change the body; the exact
// model name does). Other agents are never baked or touched.
async function bakeSisyphusPromptVariants(agent) {
  if (!agent || typeof agent.prompt !== "string" || !agent.prompt) return undefined
  const configuredModel = typeof agent.model === "string" ? agent.model : ""
  const configuredName = extractModelName(configuredModel)
  const byModel = {}
  if (configuredName) byModel[configuredName] = applySisyphusFormatExampleFix(agent.prompt)
  for (const rung of agentChain(SISYPHUS_AGENT_ID) ?? []) {
    const name = typeof rung?.model === "string" ? rung.model : ""
    if (!name || byModel[name] !== undefined) continue
    const provider = Array.isArray(rung.providers) && typeof rung.providers[0] === "string" ? rung.providers[0] : undefined
    const baked = await bakeAgentPromptForModel(provider ? `${provider}/${name}` : name, SISYPHUS_AGENT_ID)
    if (typeof baked === "string" && baked) byModel[name] = applySisyphusFormatExampleFix(baked)
  }
  // Explicit prompt-identity variants (the gpt family, Astra included) share a
  // body skeleton but differ in the identity line, so bake each one. A runtime
  // selector for one of them then resolves to its body instead of reporting a
  // miss; an accidental selector (custom-gpt-6-astra) is not baked and stays a
  // reported miss.
  for (const name of SISYPHUS_PROMPT_IDENTITY_MODELS) {
    if (!name || byModel[name] !== undefined) continue
    const baked = await bakeAgentPromptForModel(`openai/${name}`, SISYPHUS_AGENT_ID)
    if (typeof baked === "string" && baked) byModel[name] = applySisyphusFormatExampleFix(baked)
  }
  return { bakedModel: configuredModel, bakedPrompt: applySisyphusFormatExampleFix(agent.prompt), promptByModel: byModel }
}

// Upstream 5a9bb74a4: an explicit user model on an agent (or a user
// `fallback_models` chain) must survive into the runtime so the built-in
// canonical chain is not attached. The user `agents` block is resolved from the
// omo.jsonc chain, which the V1 plugin config bake (`--input`) does NOT carry, so
// this is materialized separately and read back by
// `readNativeAgentOverrides(manifest)`.
function extractAgentOverrides(agents) {
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) return {}
  const overrides = {}
  for (const [id, value] of Object.entries(agents)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const entry = {}
    if (typeof value.model === "string" && value.model.trim()) entry.model = value.model.trim()
    if (typeof value.variant === "string" && value.variant) entry.variant = value.variant
    if (Array.isArray(value.fallback_models) && value.fallback_models.length > 0) entry.fallback_models = [...value.fallback_models]
    if (Object.keys(entry).length > 0) overrides[id] = entry
  }
  return overrides
}

try {
  await hooks.config(config)
  const allAgents = config.agent || {}
  // Resolve the user plugin view up front so a `disabled_agents` entry can drop
  // an agent from the manifest instead of failing generation. The V1 bake already
  // omits a disabled agent from `config.agent`; without this the strict selection
  // loop below would throw `OmO did not generate the required agent`.
  const pluginView = resolveNativePluginConfig({
    directory,
    ...(profileRoot ? { env: { ...process.env, HOME: profileRoot } } : {}),
  })
  const canonicalAgentKey = (id) => String(id ?? "").trim().toLocaleLowerCase().split(/\s+-\s+/)[0].trim()
  const disabledAgentKeys = new Set((pluginView.disabled?.agents ?? []).map((id) => canonicalAgentKey(id)))
  const selection = selectionPath ? JSON.parse(fs.readFileSync(selectionPath, "utf8")) : null
  const selected = {}
  for (const id of selection?.orchestratedAgentIds ?? Object.keys(allAgents)) {
    if (disabledAgentKeys.has(canonicalAgentKey(id))) continue
    if (!allAgents[id]) throw new Error(`OmO did not generate the required agent: ${id}`)
    selected[id] = allAgents[id]
  }
  for (const id of selection?.optionalAgentIds ?? []) {
    if (allAgents[id]) selected[id] = allAgents[id]
  }
  for (const id of selection?.demotedAgentIds ?? []) {
    if (allAgents[id]) selected[id] = allAgents[id]
  }
  for (const [id, mode] of Object.entries(selection?.nativeAgentModeOverrides ?? {})) {
    if (selected[id] && ["primary", "subagent", "all"].includes(mode)) {
      selected[id] = { ...selected[id], mode }
    }
  }
  const judge = judgePath ? JSON.parse(fs.readFileSync(judgePath, "utf8")) : null
  if (selection?.independentJudge?.id && !judge) throw new Error("Rigel Judge definition is required")
  if (judge) selected[selection?.independentJudge?.id ?? "judge"] = judge
  // Task 13 (Oh My Rigel Phase 2 migration): manifest order must be canonical
  // at the source. Core agents come first in Sisyphus -> Hephaestus ->
  // Prometheus -> Atlas order; every other key keeps its insertion order, so
  // the judge stays in the remainder tail. The canonical keys stay owned by
  // the shared order module, not hardcoded here.
  const orderedSelected = {}
  for (const { id } of sortAgentsByCanonicalOrder(Object.keys(selected).map((key) => ({ id: key, name: key })))) {
    orderedSelected[id] = selected[id]
  }
  // The manifest is the materialized artifact: the runtime reads gates and
  // categories from `metadata.global` and never parses `omo.jsonc` itself. The
  // materializer (this generator) owns that parse, using the parity-pinned
  // native resolver rather than the V1 plugin's internal config object.
  // `--profile-root` pins the user layer so resolution never depends on an
  // ambient HOME.
  // T28 / upstream 65f159da3: the plain-line format-example fix is applied here,
  // in the V2 bake, to the Sisyphus entry only. The V1 owners stay byte-identical
  // to HEAD, so the registered body and the reconciliation plan agree while no
  // other agent entry is touched.
  const fixedAgents = fixSisyphusAgentMap(orderedSelected)
  const sisyphusPrompt = await bakeSisyphusPromptVariants(fixedAgents[SISYPHUS_AGENT_ID])
  const gates = deriveNativeGates(pluginView)
  // A V1 tool default can carry a hard global disable for a family the native
  // profile explicitly enables (`task_*: false` is the default). The native gate
  // wins: an enabled family must not stay denied by a stale V1 tool default, or
  // the family registers but every call is rejected by the permission gate.
  const tools = { ...(config.tools ?? {}) }
  if (gates.task_system) tools["task_*"] = true
  if (gates.goal) tools["goal_*"] = true
   if (gates.monitor) tools["monitor_*"] = true
   if (gates.team_mode) tools["team_*"] = true
  if (gates.interactive_bash) tools["interactive_bash"] = true
  if (gates.hashline_edit) tools["hashline_edit"] = true
  const materialized = {
    defaultAgent: config.default_agent,
    agents: fixedAgents,
    metadata: {
      generatedBy: "Oh My Rigel V2 native runtime",
      profile: process.env.OMO_PROFILE || null,
      global: {
        tools,
        permission: { ...(config.permission ?? {}) },
        gates,
        maxTools: pluginView.experimental?.max_tools,
        // T34: the Rigel preemptive-compaction threshold override, materialized
        // so the runtime reads it from the manifest instead of parsing omo.jsonc.
        preemptiveCompactionThreshold: pluginView.experimental?.preemptive_compaction_threshold,
        // T28: the Sisyphus prompt reconciliation plan (`context` hook). Absent
        // when the agent is not selected, in which case the hook is a no-op.
        ...(sisyphusPrompt ? { sisyphusPrompt } : {}),
        // T38: V1 `experimental.truncate_all_tool_outputs`, materialized so the
        // runtime's tool-output truncator reads it from the manifest.
        truncateAllToolOutputs: pluginView.experimental?.truncate_all_tool_outputs === true,
        mcp: { disabled: [...(pluginView.disabled_mcps ?? [])], envAllowlist: [...(pluginView.mcp_env_allowlist ?? [])] },
        // T38: materialized MCP retention policy + repo root for the native
        // builtin-MCP registration (grep_app remote, lsp local).
        repoRoot: sourceRoot,
        mcpPolicy: {
          retained: [...(manifestMcpPolicy.omoBuiltinsRetained ?? [])],
          builtinsDisabled: [...(manifestMcpPolicy.omoBuiltinsDisabled ?? [])],
        },
        tmuxVisualization: pluginView.team_mode?.tmux_visualization === true,
        // V1 `minimum-opencode-version.ts` refuses an unsupported host. The
        // native runtime enforces the same floor from the materialized minimum
        // (derived from integration-manifest.json platform.opencode), read at
        // setup from `context.app.version`.
        minOpenCodeVersion: deriveNativeMinOpenCodeVersion(integrationManifest),
        // The bundled OmO build version the update check compares against
        // the published package's npm dist-tags.
        bundledVersion: readBundledVersion(),
        categories: { ...(pluginView.categories ?? {}) },
        // Upstream 5a9bb74a4: the user's per-agent explicit model / fallback_models,
        // materialized so the runtime suppresses the built-in chain without
        // parsing omo.jsonc itself. An empty block is the honest no-override case.
        agentOverrides: extractAgentOverrides(pluginView.agents),
        disabled: { ...(pluginView.disabled ?? {}) },
        // The resolved OpenClaw block is absent when no layer sets it. The
        // runtime's bidirectional surface reads it from the manifest, so the
        // runtime never parses omo.jsonc itself. An absent block stays absent and
        // the surface is a strict no-op.
        ...(pluginView.openclaw ? { openclaw: pluginView.openclaw } : {}),
        // The resolved monitor block (enabled + allowed_commands) is needed by
        // the monitor tools' permission check; the V2 setup context has no
        // `config`, so the manifest is the only honest source.
        monitor: pluginView.monitor,
      },
    },
    modes: { defaultUltrawork: selection?.nativeModes?.defaultUltrawork === true },
  }
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true })
  fs.writeFileSync(outputPath, `// Generated; do not edit.\nexport default ${JSON.stringify(materialized, null, 2)}\n`)
  console.log(JSON.stringify({ defaultAgent: materialized.defaultAgent, agentCount: Object.keys(selected).length, output: path.resolve(outputPath) }))
} finally {
  await hooks.dispose?.()
}
