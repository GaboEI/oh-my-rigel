import { existsSync, readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = dirname(fileURLToPath(import.meta.url))
const readJson = (relativePath) => JSON.parse(readFileSync(join(root, relativePath), "utf8"))
const fail = (message) => {
  console.error(`gabo profile validation failed: ${message}`)
  process.exit(1)
}

const omo = readJson("omo.jsonc")
const manifest = readJson("integration-manifest.json")
const opencode = readJson("opencode/opencode.json")
const profile = omo.profiles?.gabo?.["[opencode]"]

if (!profile) fail("profiles.gabo.[opencode] is required")
if (profile.agent_definitions?.length) fail("the V2 profile must not add a second legacy Juez definition")
if (profile.agents?.sisyphus?.prompt_append !== "file://__OMO_PROFILE_ROOT__/opencode/prompts/sisyphus-orchestration.md") fail("Sisyphus must receive its orchestration contract")
const sisyphusNote = readFileSync(join(root, "opencode/prompts/sisyphus-orchestration.md"), "utf8")
if (!sisyphusNote.includes("additive profile note") || !sisyphusNote.includes("Preserve OmO's upstream identity")) fail("Sisyphus must preserve upstream orchestration")
if (/\bsubagent\b|\btask\b|Use explore|routing discipline/i.test(sisyphusNote)) fail("Sisyphus profile note must not redefine OmO delegation")
if (profile.agents?.juez) fail("the V2 profile must not configure the retired juez alias")
if (profile.websearch?.provider !== "tavily") fail("websearch must use Tavily")
if (!profile.disabled_mcps?.includes("context7")) fail("OmO Context7 must be disabled")
if (profile.browser_automation_engine?.provider !== "playwright") fail("Playwright must be canonical")
if (profile.default_mode?.ultrawork !== true) fail("Ultrawork must be enabled by default through OmO's native setting")
if (profile.goal?.enabled !== true) fail("OmO root Goal must be enabled for internal ownership")
if (profile.disabled_hooks?.includes("goal")) fail("OmO goal hook must be enabled for internal ownership")
// T21 (2026-10-06): compaction-context-injector is implemented natively and is
// always-on like V1, so it must no longer sit in disabled_hooks. T22 (2026-10-06)
// graduates compaction-todo-preserver and todo-continuation-enforcer natively, so
// the todo preserver must not stay disabled either.
if (profile.disabled_hooks?.includes("compaction-context-injector")) fail("OmO compaction-context-injector is migrated natively (T21) and must not stay disabled")
if (profile.disabled_hooks?.includes("compaction-todo-preserver")) fail("OmO compaction-todo-preserver is migrated natively (T22) and must not stay disabled")
// T34 (2026-10-06): preemptive compaction is a default-off experimental gate
// (V1 parity). The tracked profile must keep it off; QA enables it through
// RIGEL_V2_PROFILE_FILE so the shipped gate can never turn itself on.
if (profile.experimental?.preemptive_compaction === true) fail("preemptive compaction is a default-off experimental gate (T34) and must not be enabled in the tracked profile")
if (!profile.disabled_skills?.includes("dev-browser") || !profile.disabled_skills?.includes("ultimate-browsing")) fail("conflicting browser skills must be disabled")
if (manifest.rootAuthorities?.orchestrator !== "sisyphus" || manifest.rootAuthorities?.orchestrationContract !== "sisyphus") fail("Sisyphus must own the merged orchestration contract")
if (manifest.rootAuthorities?.acceptance !== "judge") fail("Judge must be the acceptance authority")
const v2Selection = readJson("v2-agent-selection.json")
if (!v2Selection.orchestratedAgentIds?.includes("Hephaestus - Deep Agent") || v2Selection.excludedOmOAgentIds?.includes("Hephaestus - Deep Agent")) fail("Hephaestus must be in the V2 roster; its provider/model gate lives in the native runtime, not in profile exclusion")
const coordinatorModeOverrides = v2Selection.nativeAgentModeOverrides ?? {}
if (coordinatorModeOverrides["Prometheus - Plan Builder"] || coordinatorModeOverrides["Atlas - Plan Executor"]) fail("coordinators must keep their upstream primary mode; the translated Ultrawork flow delegates planning to the demoted plan agent")
// S1: Sisyphus-Junior must be promoted to "all" (primary + subagent) so a direct
// @Sisyphus-Junior mention selects the agent in-session, and it must be the ONLY
// agent the profile re-modes. Every other agent keeps its upstream mode, so the
// primary roster stays exactly the declared coordinators.
for (const overriddenAgentId of Object.keys(coordinatorModeOverrides)) {
  if (overriddenAgentId !== "Sisyphus-Junior") fail(`the only sanctioned native agent mode override is Sisyphus-Junior; found "${overriddenAgentId}"`)
}
if (coordinatorModeOverrides["Sisyphus-Junior"] !== "all") fail('Sisyphus-Junior must be promoted through nativeAgentModeOverrides with mode "all" so @Sisyphus-Junior is invocable in-session')
if (!(v2Selection.demotedAgentIds ?? []).includes("plan") || !(v2Selection.demotedAgentIds ?? []).includes("build")) fail("the demoted plan and build agents must be carried in demotedAgentIds")
const judge = v2Selection.independentJudge
if (judge?.id !== "judge" || judge.removeRigelLegacyAlias !== "juez") fail("Judge must use the canonical id and retire the duplicate Rigel alias")
if (judge?.source !== "opencode/agents/judge.md" || judge.legacyExternalDefinitionPath !== ".config/opencode/agents/judge.md") fail("Judge must be packaged as a Rigel V2 source and migrate the former local definition")
const juezV2Path = join(root, judge.definition ?? "")
if (!existsSync(juezV2Path)) fail("Juez must have a portable static V2 definition")
const juezV2 = JSON.parse(readFileSync(juezV2Path, "utf8"))
if (juezV2.mode !== "primary" || juezV2.permission?.edit !== "deny" || juezV2.permission?.task !== "ask") fail("Juez V2 definition must remain independent and non-executing")
const judgeSource = join(root, judge.source)
if (!existsSync(judgeSource) || /WatchdogVPN|\bForja\b|\/home\/gabodev/i.test(readFileSync(judgeSource, "utf8"))) fail("Judge source must preserve the generic audit system without project-specific rules")
if (!v2Selection.orchestratedAgentIds?.includes("Momus - Plan Critic") || v2Selection.orchestratedAgentIds.includes("judge") || v2Selection.orchestratedAgentIds.includes("juez")) fail("Momus must remain a plan critic and must not replace Judge")
if (!manifest.requiredPlugins?.includes("oc-codex-multi-auth")) fail("oc-codex-multi-auth is required")
if (manifest.mcpPolicy?.websearch !== "tavily") fail("MCP policy must preserve Tavily as the websearch provider")
if (!manifest.mcpPolicy?.omoBuiltinsRetained?.includes("grep_app") || !manifest.mcpPolicy?.omoBuiltinsRetained?.includes("lsp") || !manifest.mcpPolicy?.omoBuiltinsRetained?.includes("context7")) fail("OmO grep_app, LSP and the dynamic Context7 builtin must remain retained")
for (const mcp of ["ssh"]) {
  if (!manifest.mcpPolicy?.bundledLocal?.includes(mcp) || opencode.mcp?.[mcp]?.type !== "local" || opencode.mcp[mcp].enabled !== true) fail(`${mcp} must remain a bundled enabled local MCP`)
}
for (const mcp of ["context7", "playwright", "obsidian"]) {
  if (!manifest.mcpPolicy?.coreExternalConnections?.includes(mcp)) fail(`${mcp} must remain a core per-machine connection`)
}
if (!manifest.mcpPolicy?.optIn?.includes("docker") || !manifest.mcpPolicy?.optIn?.includes("github") || !manifest.mcpPolicy?.optIn?.includes("postgres")) fail("Docker, GitHub, and Postgres must remain opt-in MCPs")
if (!manifest.mcpPolicy?.optInSecurity?.includes("tide") || !manifest.mcpPolicy?.excluded?.includes("openrouter")) fail("Tide must remain optional security tooling and OpenRouter excluded")
for (const mcp of ["context7", "playwright", "obsidian", "docker", "github", "postgres", "tide", "openrouter"]) {
  if (mcp in (opencode.mcp ?? {})) fail(`${mcp} must not be embedded in the portable profile`)
}
for (const skill of ["prompt-master", "juez-tester", "juez-repo"]) {
  if (!manifest.skillPolicy?.gaboCore?.includes(skill)) fail(`${skill} must remain a core Gabo skill`)
}
for (const skill of manifest.skillPolicy?.bundled ?? []) {
  const skillPath = join(root, "skills", skill, "SKILL.md")
  if (!existsSync(skillPath) || !readFileSync(skillPath, "utf8").startsWith(`---\nname: ${skill}`)) fail(`${skill} must have a valid bundled SKILL.md`)
}
if (!existsSync(join(root, "skills", "obsidian-second-brain-audit", "scripts", "audit_vault.py"))) fail("obsidian-second-brain-audit must retain its audit script")
for (const resource of [
  ["tui-design", "references", "design-principles.md"],
  ["tui-design", "templates", "bubbletea-starter", "main.go"],
  ["skill-creator", "agents", "grader.md"],
  ["skill-creator", "references", "schemas.md"],
]) {
  if (!existsSync(join(root, "skills", ...resource))) fail(`${resource[0]} must retain its portable resources`)
}
for (const skill of ["dev-browser", "ultimate-browsing"]) {
  if (!manifest.skillPolicy?.omoDisabled?.includes(skill)) fail(`${skill} must remain disabled in the Gabo profile`)
}
if (opencode.default_agent !== "sisyphus") fail("Sisyphus must be the default agent")
if (opencode.plugin?.length !== 1 || !opencode.plugin[0].includes("__OMO_PLUGIN_ENTRY__")) fail("plugin entry must remain an explicit test-time placeholder")
for (const file of [
  "opencode/rigel-v2-native.mjs",
  "opencode/rigel-v2-native-core.mjs",
  "opencode/rigel-v2-native-prompt.mjs",
  "opencode/rigel-v2-native-agents.mjs",
  "opencode/rigel-v2-native-permissions.mjs",
  "opencode/rigel-v2-native-agent-manifest.mjs",
  "opencode/rigel-v2-native-categories.mjs",
  "opencode/rigel-v2-category-manifest.mjs",
  "isolated-v2-env.mjs",
  "switch-live-plugin-to-native-v2.mjs",
]) {
  if (!existsSync(join(root, file))) fail(`native V2 runtime artifact missing: ${file}`)
}
const nativeEntrypoint = readFileSync(join(root, "opencode/rigel-v2-native.mjs"), "utf8")
if (/legacyModule|omo-v2-adapter/i.test(nativeEntrypoint)) fail("native V2 entrypoint must not load the V1 bridge")
if (!nativeEntrypoint.includes("registerNativeAgents")) fail("native V2 entrypoint must register the generated agent manifest")
// Tool-name permission gate: the entrypoint must consume the permission
// authority (V2-only families have no native action, so a name gate is the only
// real enforcement) and must throw it from `execute.before` before the executor.
const permissionAuthority = readFileSync(join(root, "opencode/rigel-v2-native-permissions.mjs"), "utf8")
if (!permissionAuthority.includes("Unknown V1 permission key")) fail("permission authority must reject unknown V1 keys instead of a silent passthrough")
for (const marker of ["createNativePermissionWiring", "createNativeToolPermissionGate", "translateGlobalTools", "permissionWiring.before"]) {
  if (!nativeEntrypoint.includes(marker)) fail(`native V2 entrypoint must wire the permission gate: missing ${marker}`)
}

// Single-runtime invariant: no active (non-attic) profile file may load the
// quarantined V1 bridge. generate-v2-agents.mjs is exempt: it is a build-time
// dependency (the V1 plugin dist feeds agent manifest generation) tracked as
// technical debt until Fase 2 replaces generation; it never runs at runtime.
const bridgeImport = /omo-v2-adapter|legacyModule|switch-live-plugin-to-(?:dist|v2-adapter)/
const buildTimeGenerationExempt = new Set(["generate-v2-agents.mjs", "validate-profile.mjs"])
for (const dir of ["opencode", "qa", "."]) {
  const scanRoot = join(root, dir)
  const entries = existsSync(scanRoot) ? readdirSync(scanRoot, { withFileTypes: true }) : []
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(mjs|sh)$/.test(entry.name)) continue
    if (buildTimeGenerationExempt.has(entry.name)) continue
    if (bridgeImport.test(readFileSync(join(scanRoot, entry.name), "utf8"))) fail(`active file ${dir}/${entry.name} must not reference the quarantined V1 bridge`)
  }
}
const atticMarkers = ["opencode/omo-v2-adapter.mjs", "switch-live-plugin-to-native-v2.mjs"]
if (!existsSync(join(root, "attic", atticMarkers[0]))) fail("quarantined V1 bridge must remain under profiles/gabo/attic for history")
const activation = readFileSync(join(root, "apply-v2-runtime-service.sh"), "utf8")
if (!activation.includes("switch-live-plugin-to-native-v2.mjs") || activation.includes("switch-live-plugin-to-v2-adapter.mjs")) fail("runtime activation must select the native V2 entrypoint")
if (!activation.includes("opencode-v2-lab.service") || /systemctl\s+(?:--user\s+)?(?:start|stop|restart)\s+opencode-lan\.service/.test(activation)) fail("native activation must address only the isolated V2 service")
const agentMaterialization = readFileSync(join(root, "apply-v2-agent-layer.mjs"), "utf8")
if (!agentMaterialization.includes("rigel-v2-agent-manifest.mjs") || !agentMaterialization.includes("materialize-v2-skills.mjs") || /writeFileSync\(configFile/.test(agentMaterialization)) fail("agent materialization must refresh V2 skills and generate a runtime manifest without editing OpenCode config")
if (!agentMaterialization.includes("opencode-v2-lab") || agentMaterialization.includes('path.join(home, ".config/opencode/opencode.json")')) fail("agent materialization must default to the isolated V2 configuration")

// Personal-path scan: every tracked artifact under profiles/gabo (attic is
// historical and exempt) must be machine-independent. The same walk rejects the
// retired h-before-o identity so no active file can reintroduce the obsolete
// compatibility name. The pattern is written with character classes so this
// file does not itself contain the literal it forbids.
const retiredIdentity = /[hH][oO][-_ ][mM][yY][-_ ][rR][iI][gG][eE][lL]/
function walkPersonalPaths(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "attic") continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) { walkPersonalPaths(path); continue }
    if (!/\.(mjs|sh|md|json|jsonc)$/.test(entry.name)) continue
    const text = readFileSync(path, "utf8")
    if (/\/home\/gabodev/.test(text)) fail(`personal path leaked into ${path.replace(root, "profiles/gabo")}`)
    if (retiredIdentity.test(text)) fail(`retired identity leaked into ${path.replace(root, "profiles/gabo")}`)
  }
}
walkPersonalPaths(root)

const profileSerialized = JSON.stringify({ omo, opencode })
if (/WatchdogVPN|\/home\/gabodev|TAVILY_API_KEY|OPENAI_API_KEY|CODEX_AUTH/i.test(profileSerialized)) fail("profile contains a project rule, personal path, or secret marker")
if (!manifest.nonGoals?.includes("copy WatchdogVPN skills or commands")) fail("WatchdogVPN exclusion must remain explicit")

// Native V2 origin invariant: the runtime must derive the server origin from
// the V2 setup context, an explicit environment origin, or this process's own
// serve argv. A hardcoded loopback base URL or the literal lab port 4097 is a
// regression. Port 4096 is a legitimate V2 default and is deliberately allowed:
// identity is proven against the server (GET /api/info), never by refusing a
// port number.
const hardcodedOrigin = /https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+/
const isDocumentationUrlExample = (line, matchIndex) => {
  const marker = line.indexOf("description:")
  if (marker === -1 || matchIndex < marker) return false
  // Inside the quoted description value when an odd number of quotes precedes the match.
  let quotes = 0
  for (let i = marker; i < matchIndex; i++) if (line[i] === '"') quotes++
  return quotes % 2 === 1
}
const scanForHardcodedOrigin = (relativePath) => {
  const lines = readFileSync(join(root, relativePath), "utf8").split("\n")
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const match = hardcodedOrigin.exec(line)
    if (match && !isDocumentationUrlExample(line, match.index)) {
      fail(`${relativePath} must derive its origin from process.argv, not hardcode a loopback base URL: "${match[0]}" at line ${index + 1}`)
    }
    if (line.includes("4097")) {
      fail(`${relativePath} must not hardcode the V2 lab port 4097 at line ${index + 1}: "${line.trim()}"`)
    }
  }
}
for (const relativeDir of ["opencode", "opencode/tools"]) {
  const scanDir = join(root, relativeDir)
  if (!existsSync(scanDir)) continue
  const entries = readdirSync(scanDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".mjs") || entry.name.endsWith(".test.mjs")) continue
    scanForHardcodedOrigin(`${relativeDir}/${entry.name}`)
  }
}

console.log("gabo profile validation passed")
