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
import { writeTextAtomic } from "./rigel-v2-lifecycle-transaction.mjs"
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
    fs.writeFileSync(path.join(runtimeDir, "prompts", name), source.replace(/\btask\(/g, "rigel_task("), { mode: 0o600 })
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

  const before = readJson(configFile)
  const candidate = structuredClone(before)
  const plugins = Array.isArray(candidate.plugin) ? candidate.plugin : []
  candidate.plugin = registerRuntimePluginEntry(plugins, { runtimeDir, familyRoot: familyRoot ?? runtimeDir })
  writeTextAtomic(configFile, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 })

  const notificationOptions = resolveRuntimeNotificationOptions(profileFile, env)
  const cliConfigFile = path.join(path.dirname(configFile), "cli.json")
  const cliBefore = fs.existsSync(cliConfigFile) ? readJson(cliConfigFile) : { plugins: [] }
  const cliAfter = registerCompanionCliPlugin(cliBefore, {
    runtimeDir,
    familyRoot: familyRoot ?? runtimeDir,
    options: notificationOptions,
    notificationEnabled: notificationOptions.enabled,
  })
  writeTextAtomic(cliConfigFile, `${JSON.stringify(cliAfter, null, 2)}\n`, { mode: 0o600 })

  return { pluginEntry: runtimeDir, cliConfigFile, notificationEnabled: notificationOptions.enabled }
}
