#!/usr/bin/env node
/**
 * Materializes the native Rigel V2 runtime into a target directory and registers
 * it in an OpenCode V2 config. Shared by the laboratory activation wrapper
 * (`switch-live-plugin-to-native-v2.mjs`) and the user lifecycle installer
 * (`rigel-v2-user-install.mjs`), so a new runtime module can never be dropped by
 * a hand-maintained list and both routes deploy the same tree.
 *
 * It never launches OpenCode and never touches V1: the caller owns the isolated
 * HOME/XDG (or lab) paths.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { discoverRuntimeModules } from "./native-runtime-modules.mjs"
import { rewriteLegacyDelegationToolExamples } from "./opencode/rigel-v2-native-prompt-tools.mjs"
import { writeTextAtomic } from "./rigel-v2-lifecycle-transaction.mjs"
import { goalVendorDigestKey, materializeGoalVendor } from "./rigel-v2-goal-vendor.mjs"
import {
  goalEntryOptions,
  isGoalEngineEntry,
  materializeGoalEngineShim,
  materializeGoalTuiShim,
  registerGoalCliEntry,
  registerGoalServerEntry,
  resolveGoalOptions,
  serverPluginEntries,
} from "./rigel-v2-goal-registration.mjs"
import {
  parseJsonc,
  registerCompanionCliPlugin,
  resolveNotificationOptions,
  resolveProfileOpenCodeBlock,
} from "./notification-activation-config.mjs"

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

function codexPlugin(config) {
  return (config.plugins || []).find((value) => typeof value === "string" && value.startsWith("oc-codex-multi-auth")) || null
}

function underFamily(candidate, familyRoot) {
  if (typeof candidate !== "string" || typeof familyRoot !== "string" || familyRoot.length === 0) return false
  if (candidate === familyRoot) return true
  return candidate.startsWith(`${familyRoot}/`) || candidate.startsWith(`${familyRoot}\\`)
}

/**
 * Return a new `opencode.json` plugin array with exactly one Rigel-family runtime
 * entry, pointing at the active `runtimeDir`. Family identity is the stable
 * `familyRoot`, so a version transition replaces the previous version's entry
 * instead of appending a second one; foreign plugin entries keep their position.
 */
export function registerRuntimePluginEntry(plugins, { runtimeDir, familyRoot = runtimeDir }) {
  const isFamily = (entry) => typeof entry === "string" && (entry === runtimeDir || underFamily(entry, familyRoot))
  const next = []
  let placed = false
  for (const entry of plugins) {
    if (isFamily(entry)) {
      if (!placed) {
        next.push(runtimeDir)
        placed = true
      }
      continue
    }
    next.push(entry)
  }
  if (!placed) next.push(runtimeDir)
  return next
}

function sha(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex")
}

// Packages the deployed runtime resolves the LSP server from its OWN directory.
const LSP_STAGED_PACKAGES = [
  { name: "lsp-daemon", entries: ["package.json", "dist"] },
  { name: "lsp-tools-mcp", entries: ["package.json", "dist"] },
]

/**
 * Stage the BUILT LSP runtime into the deployment so it OWNS the LSP server and
 * never depends on the transient source checkout that generated the manifest.
 * Additive: an unbuilt source tree stages nothing, and the runtime then degrades
 * the LSP server instead of running an unresolvable `workspace:*` bootstrap.
 * Returns the staged relative paths (repository-style separators).
 */
export function stageLspRuntime({ sourceRoot, runtimeDir }) {
  const staged = []
  for (const { name, entries } of LSP_STAGED_PACKAGES) {
    const sourcePackage = path.join(sourceRoot, "packages", name)
    // A package with no built CLI is not a self-contained LSP runtime: stage
    // nothing for it so the runtime degrades instead of resolving a half tree.
    if (!fs.existsSync(path.join(sourcePackage, "dist", "cli.js"))) continue
    const destinationPackage = path.join(runtimeDir, "packages", name)
    for (const entry of entries) {
      const from = path.join(sourcePackage, entry)
      if (!fs.existsSync(from)) continue
      const to = path.join(destinationPackage, entry)
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 })
      fs.cpSync(from, to, { recursive: true })
      staged.push(path.relative(runtimeDir, to).split(path.sep).join("/"))
    }
  }
  return staged
}

/**
 * Stage the pinned, verified goal vendor into the deployment. Additive and fully
 * offline: it registers nothing, writes no `opencode.json` / `cli.json` key and
 * touches no live state. Nothing in the runtime references the materialized tree
 * yet, so the engine stays dark; the returned digest only records that the exact
 * vendored tree landed in the versioned deployment.
 */
export function stageGoalVendor({ sourceRoot, runtimeDir }) {
  return materializeGoalVendor({ sourceRoot, runtimeDir })
}

export function buildProtectedFingerprint(config) {
  return { obsidian: sha(config.mcp?.obsidian), codexPlugin: sha(codexPlugin(config)) }
}

export function resolveRuntimeNotificationOptions(profileFile, env = process.env) {
  let profileDocument = {}
  if (profileFile !== null && fs.existsSync(profileFile)) {
    profileDocument = parseJsonc(fs.readFileSync(profileFile, "utf8"))
  }
  const openCodeBlock = resolveProfileOpenCodeBlock(profileDocument, env.OMO_PROFILE)
  const enabledOverride = env.RIGEL_V2_NOTIFICATION_ENABLED === undefined
    ? undefined
    : env.RIGEL_V2_NOTIFICATION_ENABLED === "1"
  return resolveNotificationOptions({ profile: openCodeBlock, enabledOverride })
}

/**
 * The explicit user overrides for the community goal engine, read from the
 * Rigel-managed profile's `goal_engine` block. This is the normal, non-vendor
 * way to pass any supported engine option; absent means "Rigel defaults".
 */
export function resolveGoalOptionOverrides(profileFile, env = process.env) {
  let profileDocument = {}
  if (profileFile !== null && fs.existsSync(profileFile)) {
    profileDocument = parseJsonc(fs.readFileSync(profileFile, "utf8"))
  }
  const openCodeBlock = resolveProfileOpenCodeBlock(profileDocument, env.OMO_PROFILE)
  const record = openCodeBlock && typeof openCodeBlock === "object" ? openCodeBlock.goal_engine : undefined
  return record && typeof record === "object" && !Array.isArray(record) ? record : {}
}

export function materializeNativeRuntime({
  sourceRoot,
  runtimeSourceDir = path.join(sourceRoot, "profiles/gabo/opencode"),
  runtimeDir,
  familyRoot = null,
  agentManifestPath,
  configFile,
  profileFile = null,
  env = process.env,
}) {
  const runtimeModules = discoverRuntimeModules(runtimeSourceDir)
  fs.mkdirSync(path.join(runtimeDir, "prompts"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(runtimeDir, "tools"), { recursive: true, mode: 0o700 })
  for (const file of runtimeModules) {
    const destination = path.join(runtimeDir, file)
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
    fs.copyFileSync(path.join(runtimeSourceDir, file), destination)
  }
  fs.copyFileSync(path.join(runtimeSourceDir, "rigel-v2-native.mjs"), path.join(runtimeDir, "index.js"))
  const cliEntryName = "tui.js"
  fs.copyFileSync(path.join(runtimeSourceDir, "rigel-v2-native-cli.mjs"), path.join(runtimeDir, cliEntryName))

  const promptFiles = [
    ["ultrawork-default.md", "packages/prompts-core/prompts/ultrawork/default.md"],
    ["ultrawork-gpt.md", "packages/prompts-core/prompts/ultrawork/gpt.md"],
    ["ultrawork-gemini.md", "packages/prompts-core/prompts/ultrawork/gemini.md"],
    ["ultrawork-glm.md", "packages/prompts-core/prompts/ultrawork/glm.md"],
    ["ultrawork-planner.md", "packages/prompts-core/prompts/ultrawork/planner.md"],
    ["team.md", "packages/prompts-core/prompts/mode/team.md"],
    ["hyperplan.md", "packages/prompts-core/prompts/mode/hyperplan.md"],
  ]
  for (const [name, relative] of promptFiles) {
    const source = fs.readFileSync(path.join(sourceRoot, relative), "utf8")
    fs.writeFileSync(path.join(runtimeDir, "prompts", name), rewriteLegacyDelegationToolExamples(source), { mode: 0o600 })
  }
  const keywordConstants = fs.readFileSync(path.join(sourceRoot, "packages/omo-opencode/src/hooks/keyword-detector/constants.ts"), "utf8")
  const comboBanner = keywordConstants.match(/const HYPERPLAN_ULTRAWORK_BANNER = `([\s\S]*?)`/)?.[1]
  if (typeof comboBanner !== "string" || !comboBanner.trim()) {
    throw new Error("no se pudo extraer el banner hyperplan-ultrawork del detector V1")
  }
  fs.writeFileSync(path.join(runtimeDir, "prompts/ultrawork-combo-banner.md"), `${comboBanner}\n`, { mode: 0o600 })
  fs.copyFileSync(agentManifestPath, path.join(runtimeDir, "rigel-v2-native-agent-manifest.mjs"))
  const runtimeExports = { ".": "./index.js", "./tui": `./${cliEntryName}` }
  fs.writeFileSync(path.join(runtimeDir, "package.json"), `${JSON.stringify({ name: "rigel-v2-native", type: "module", exports: runtimeExports }, null, 2)}\n`, { mode: 0o600 })
  for (const file of ["index.js", cliEntryName, ...runtimeModules, "rigel-v2-native-agent-manifest.mjs", ...promptFiles.map(([name]) => `prompts/${name}`), "prompts/ultrawork-combo-banner.md"]) {
    const target = path.join(runtimeDir, file)
    if (fs.existsSync(target)) fs.chmodSync(target, 0o600)
  }

  // Stage the built LSP runtime under the deployment so the runtime resolves it
  // from its own directory instead of the transient source checkout.
  const stagedLsp = stageLspRuntime({ sourceRoot, runtimeDir })

  // Stage the pinned goal vendor (dark: nothing references it yet). The digest is
  // returned so the installer can record it inside `versionDigests`.
  const goalVendor = stageGoalVendor({ sourceRoot, runtimeDir })

  const before = readJson(configFile)
  const candidate = structuredClone(before)
  const plugins = serverPluginEntries(candidate)
  candidate.plugins = registerRuntimePluginEntry(plugins, { runtimeDir, familyRoot: familyRoot ?? runtimeDir })
  delete candidate.plugin

  // The vendored goal engine is registered exactly once: a server tuple in
  // `opencode.json` carrying the resolved Rigel-managed options, and a TUI
  // object in `cli.json`. An existing entry's options and the profile's
  // `goal_engine` block are honored as overrides, so a reinstall/update never
  // overwrites a user choice; the Rigel defaults fill the rest.
  const existingGoalOptions = goalEntryOptions(candidate.plugins.find(isGoalEngineEntry))
  const goalOverrides = { ...existingGoalOptions, ...resolveGoalOptionOverrides(profileFile, env) }
  const goalOptions = resolveGoalOptions({ overrides: goalOverrides })
  // The host resolves a `plugin` entry to an ENTRYPOINT; the vendored artifact
  // exports only `./server`/`./tui`, so pointing at it (file or dir) makes the
  // host skip it. A Rigel-owned shim with a `.` export re-exporting the vendored
  // server is what the host loads, exactly once.
  const goalShimDir = materializeGoalEngineShim({ runtimeDir, engineEntry: goalVendor.engineEntry })
  // The host resolves a `cli.json` `plugins` `{ package }` entry to a JS
  // entrypoint through the package's `.`/`./tui` export; the vendored TUI is
  // `src/tui.ts` with no `.`, so the same Rigel-owned shim pattern is required
  // for the community goal sidebar to render.
  const goalTuiShimDir = materializeGoalTuiShim({ runtimeDir, tuiEntry: goalVendor.tuiEntry })
  const serverConfig = registerGoalServerEntry(candidate, { engineEntry: goalShimDir, options: goalOptions })
  writeTextAtomic(configFile, `${JSON.stringify(serverConfig, null, 2)}\n`, { mode: 0o600 })

  const notificationOptions = resolveRuntimeNotificationOptions(profileFile, env)
  const cliConfigFile = path.join(path.dirname(configFile), "cli.json")
  const cliBefore = fs.existsSync(cliConfigFile) ? readJson(cliConfigFile) : { plugins: [] }
  const cliCompanion = registerCompanionCliPlugin(cliBefore, {
    runtimeDir,
    familyRoot: familyRoot ?? runtimeDir,
    options: notificationOptions,
  })
  const cliAfter = registerGoalCliEntry(cliCompanion, { tuiShimDir: goalTuiShimDir })
  writeTextAtomic(cliConfigFile, `${JSON.stringify(cliAfter, null, 2)}\n`, { mode: 0o600 })

  return { pluginEntry: runtimeDir, cliConfigFile, stagedLsp, goalVendor, goalOptions }
}
