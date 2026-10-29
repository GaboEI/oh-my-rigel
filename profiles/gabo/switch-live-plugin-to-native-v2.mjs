#!/usr/bin/env node
/** Activate the native Rigel V2 runtime for the isolated laboratory trial. */
import os from "node:os"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { buildProtectedFingerprint, materializeNativeRuntime } from "./rigel-v2-runtime-materialize.mjs"

const labRoot = process.env.RIGEL_V2_LAB_ROOT || path.join(os.homedir(), ".local/share/opencode-v2-lab")
const home = process.env.RIGEL_V2_HOME || path.join(labRoot, "home")
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const stateRoot = path.join(labRoot, "rigel")
const stateFile = path.join(stateRoot, "active-trial.json")
const configFile = process.env.RIGEL_V2_CONFIG || path.join(labRoot, "config/opencode/opencode.json")
const runtime = path.join(stateRoot, "runtime/rigel-v2-native")
const agentManifest = path.join(stateRoot, "runtime/rigel-v2-agent-manifest.mjs")

function fail(message) { console.error(`Rigel native V2 activation refused: ${message}`); process.exit(1) }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")) }

if (!fs.existsSync(stateFile)) fail("no hay una prueba Rigel activa")
if (!fs.existsSync(configFile)) fail("no existe la configuración OpenCode activa")
const state = readJson(stateFile)
const before = readJson(configFile)
const beforeFingerprint = buildProtectedFingerprint(before)
const protectedFingerprint = state.protectedFingerprint ?? beforeFingerprint
if (beforeFingerprint.obsidian !== protectedFingerprint.obsidian || beforeFingerprint.codexPlugin !== protectedFingerprint.codexPlugin) {
  fail("un componente protegido no coincide con su huella congelada")
}
if (!fs.existsSync(agentManifest)) fail("no existe el manifiesto nativo de agentes; genéralo antes de activar el runtime")

const result = materializeNativeRuntime({
  sourceRoot,
  runtimeDir: runtime,
  familyRoot: stateRoot,
  agentManifestPath: agentManifest,
  configFile,
  profileFile: process.env.RIGEL_V2_PROFILE_FILE || path.join(sourceRoot, "profiles/gabo/omo.jsonc"),
  env: process.env,
})

const afterFingerprint = buildProtectedFingerprint(readJson(configFile))
if (afterFingerprint.obsidian !== beforeFingerprint.obsidian || afterFingerprint.codexPlugin !== beforeFingerprint.codexPlugin) {
  fail("la activación alteraría un componente protegido")
}
state.pluginEntry = result.pluginEntry
state.protectedFingerprint = protectedFingerprint
state.nativeV2ActivatedAt = new Date().toISOString()
fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })

console.log("Rigel native OpenCode V2 runtime registered.")
console.log(`Rigel companion CLI surfaces registered in ${result.cliConfigFile} (session notification is host-owned; the builtin notifier is left untouched).`)
