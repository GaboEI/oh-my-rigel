#!/usr/bin/env node
/**
 * Runs the native Rigel V2 staging pipeline in a disposable lab and proves it
 * cannot mutate the user's V1 configuration. No OpenCode service is started.
 */
import assert from "node:assert/strict"
import { buildIsolatedV2Env } from "./isolated-v2-env.mjs"
import childProcess from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const v1Config = path.join(os.homedir(), ".config/opencode/opencode.json")
const v2Config = path.join(os.homedir(), ".local/share/opencode-v2-lab/config/opencode/opencode.json")
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-v2-lab-install-"))
const labRoot = path.join(temporary, "lab")
const labConfig = path.join(labRoot, "config/opencode/opencode.json")
const home = path.join(labRoot, "home")
const evidenceDir = path.join(root, ".omo/evidence/20261002-rigel-v2-lab-install-contract")

/** One plugin specifier: bare string, legacy `[spec, options]` tuple, or native `{package, options}` object. */
function pluginSpec(entry) {
  if (typeof entry === "string") return entry
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0]
  if (entry && typeof entry === "object" && typeof entry.package === "string") return entry.package
  return undefined
}
/**
 * Effective server plugin specifiers of a config document. The installer writes
 * the native `plugins` key and drops `plugin`, so reading `plugin` alone sees
 * nothing after the first install. Order mirrors the host normalizer: legacy
 * entries first, then native ones.
 */
function configPluginSpecs(config) {
  const legacy = Array.isArray(config?.plugin) ? config.plugin : []
  const native = Array.isArray(config?.plugins) ? config.plugins : []
  return [...legacy, ...native].map(pluginSpec).filter((spec) => typeof spec === "string")
}

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

function run(script, env) {
  const result = childProcess.spawnSync(process.execPath, [path.join(root, "profiles/gabo", script)], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 60_000,
  })
  assert.equal(result.status, 0, `${script} failed:\n${result.stderr || result.stdout}`)
}

try {
  assert.ok(fs.existsSync(v1Config), "V1 configuration is required for the immutability assertion")
  assert.ok(fs.existsSync(v2Config), "V2 lab configuration is required as the disposable fixture source")
  const v1Before = hashFile(v1Config)
  fs.mkdirSync(path.dirname(labConfig), { recursive: true, mode: 0o700 })
  fs.copyFileSync(v2Config, labConfig)
  const beforeConfig = JSON.parse(fs.readFileSync(labConfig, "utf8"))
  const env = {
    ...buildIsolatedV2Env({ sandbox: labRoot, home }),
    RIGEL_V2_LAB_ROOT: labRoot,
    RIGEL_V2_HOME: home,
    RIGEL_V2_CONFIG: labConfig,
  }

  run("apply-v2-agent-layer.mjs", env)
  run("switch-live-plugin-to-native-v2.mjs", env)

  const stateFile = path.join(labRoot, "rigel/active-trial.json")
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"))
  const manifestFile = path.join(labRoot, "rigel/runtime/rigel-v2-agent-manifest.mjs")
  const manifest = await import(`${pathToFileURL(manifestFile).href}?contract=${Date.now()}`)
  const afterConfig = JSON.parse(fs.readFileSync(labConfig, "utf8"))
  const runtime = path.join(labRoot, "rigel/runtime/rigel-v2-native")

  assert.equal(hashFile(v1Config), v1Before, "V1 configuration changed during a V2-only staging run")
  assert.deepEqual(afterConfig.agent, beforeConfig.agent, "native agents leaked into V2 static config instead of the runtime manifest")
  assert.ok(configPluginSpecs(afterConfig).includes(runtime), "V2 config did not receive the native runtime entry")
  assert.equal(state.configFile, labConfig)
  assert.equal(state.labRoot, labRoot)
  assert.equal(state.pluginEntry, runtime)
  const agents = manifest.default?.agents
  assert.ok(agents?.oracle, "native manifest lacks oracle")
  assert.ok(agents?.judge, "native manifest lacks the independent judge")
  assert.equal(agents?.["Prometheus - Plan Builder"]?.mode, "primary", "coordinators must keep their upstream primary mode; planning delegates to the demoted plan agent")
  assert.equal(agents?.["Atlas - Plan Executor"]?.mode, "primary", "coordinators must keep their upstream primary mode; planning delegates to the demoted plan agent")
  assert.equal(manifest.default?.modes?.defaultUltrawork, false, "native manifest must not arm Ultrawork by default; it activates only on an explicit ulw/ultrawork request")
  assert.ok(fs.existsSync(path.join(runtime, "index.js")), "native runtime was not materialized")
  const stagedUltrawork = fs.readFileSync(path.join(runtime, "prompts/ultrawork-default.md"), "utf8")
  assert.ok(stagedUltrawork.includes("rigel_task("), "staged Ultrawork prompt did not translate V1 task calls")
  assert.ok(!/(?<!rigel_)\btask\(/.test(stagedUltrawork), "staged Ultrawork prompt still contains a V1 task call")
  assert.ok(fs.existsSync(path.join(home, ".agents/skills")), "V2 personal skills were not materialized")
  assert.ok(!fs.existsSync(path.join(home, ".omo")), "temporary generator profile leaked into the V2 lab home")

  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  const report = [
    "# Rigel V2 lab install contract",
    "",
    "- Native manifest generation: passed.",
    "- Native runtime staging: passed.",
    "- V2-only plugin registration: passed.",
    "- V1 configuration hash unchanged: passed.",
    "- V2 static agent config unchanged: passed (agents remain native runtime registrations).",
    "- Personal V2 skills materialized: passed.",
  ].join("\n") + "\n"
  fs.writeFileSync(path.join(evidenceDir, "validation.md"), report, { mode: 0o600 })
  process.stdout.write(report)
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}
