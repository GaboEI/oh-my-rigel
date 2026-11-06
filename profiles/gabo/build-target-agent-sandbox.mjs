import fs from "node:fs"
import path from "node:path"
import { parseJsoncText, readLiveOpenclawSource } from "./opencode/rigel-v2-native-config.mjs"

/**
 * Copies only the provisioned profile files the plugin pipeline must read
 * (`<profileRoot>/.omo/omo.jsonc` and `<profileRoot>/.omo/opencode/prompts/**`)
 * into the sandbox home as real file copies. Nothing else from the provisioned
 * root is touched, and no symlink is ever created (copyFileSync writes content).
 */
export function stageProvisionedProfile(profileRoot, sandboxHome) {
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

function isPlainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function declaresOpenclaw(config) {
  return isPlainRecord(config) && Object.prototype.hasOwnProperty.call(config, "openclaw")
}

function hasNonGaboOpenclawDeclaration(stagedConfigPath) {
  const stagedConfig = parseJsoncText(fs.readFileSync(stagedConfigPath, "utf8"))
  const profiles = isPlainRecord(stagedConfig.profiles) ? stagedConfig.profiles : {}
  return Object.entries(profiles).some(([profile, profileConfig]) => {
    if (profile === "gabo" || !isPlainRecord(profileConfig)) return false
    return declaresOpenclaw(profileConfig) || declaresOpenclaw(profileConfig["[opencode]"])
  })
}

export function resolveManifestOpenclaw({ directory, env, pluginView, stagedConfigPath }) {
  const source = readLiveOpenclawSource({ directory, env })
  if (source.state === "declared" && path.resolve(source.path) !== stagedConfigPath) {
    console.error("Rigel target agent manifest: OPENCLAW_DECLARATION_OUTSIDE_STAGED_LAYER; treating manifest OpenClaw as undeclared")
    return { config: undefined, report: { state: "undeclared", reason: "outside-staged-layer" } }
  }
  if (source.state === "undeclared" && fs.existsSync(stagedConfigPath) && hasNonGaboOpenclawDeclaration(stagedConfigPath)) {
    console.error("Rigel target agent manifest: OPENCLAW_NON_GABO_PROFILE_DECLARATION; treating manifest OpenClaw as undeclared")
    return { config: undefined, report: { state: "undeclared", reason: "non-gabo-profile" } }
  }
  if (source.state === "declared" && pluginView.openclaw) {
    return { config: pluginView.openclaw, report: { state: "declared" } }
  }
  return { config: undefined, report: { state: "undeclared" } }
}
