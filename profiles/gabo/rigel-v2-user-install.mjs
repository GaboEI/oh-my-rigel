#!/usr/bin/env node
/**
 * Rigel V2 user lifecycle: install, reinstall, upgrade, rollback, uninstall and
 * status for a real OpenCode V2 home, without the laboratory state shape.
 *
 * Every path is supplied explicitly (or derived from the isolated HOME/XDG) and
 * guarded against the V1 roots before any write, so this never reads or mutates
 * the user's production V1 installation. It does not launch OpenCode; the caller
 * launches the normal `opencode` command afterwards.
 *
 * Usage:
 *   node rigel-v2-user-install.mjs install   --version <v> [--runtime-source <dir>]
 *   node rigel-v2-user-install.mjs upgrade   --version <v> [--runtime-source <dir>]
 *   node rigel-v2-user-install.mjs rollback
 *   node rigel-v2-user-install.mjs uninstall
 *   node rigel-v2-user-install.mjs status
 * Common: --state <dir> --home <dir> --config <file> [--json]
 */
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import {
  materializeNativeRuntime,
  registerRuntimePluginEntry,
  resolveGoalOptionOverrides,
  resolveRuntimeNotificationOptions,
} from "./rigel-v2-runtime-materialize.mjs"
import { registerCompanionCliPlugin, removeRigelCliEntries } from "./notification-activation-config.mjs"
import { GOAL_VENDOR_ARTIFACT, goalVendorDigestKey, goalVendorTargetDir } from "./rigel-v2-goal-vendor.mjs"
import {
  GOAL_ENGINE_SHIM_DIRNAME,
  GOAL_TUI_SHIM_DIRNAME,
  adoptGoalState,
  assertGoalStatePathSafe,
  goalEntryOptions,
  isGoalEngineEntry,
  registerGoalCliEntry,
  registerGoalServerEntry,
  removeGoalEntries,
  resolveGoalOptions,
  resolveGoalStatePath,
} from "./rigel-v2-goal-registration.mjs"
import { renderCleanInstallProfile } from "./rigel-v2-clean-install-profile.mjs"
import {
  beginLifecycleTransaction,
  failAt,
  writeJsonAtomic,
  writeTextAtomic,
} from "./rigel-v2-lifecycle-transaction.mjs"
import { astGrepUserRuntimeDir } from "./rigel-v2-ast-grep-provision.mjs"

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const INSTALLER_PATH = fileURLToPath(import.meta.url)
const STATE_SCHEMA = 2

const V1_ROOTS = [
  path.join(os.homedir(), ".config", "opencode"),
  path.join(os.homedir(), ".local", "share", "opencode"),
  path.join(os.homedir(), ".local", "share", "opencode-goal-plugin"),
  path.join(os.homedir(), ".cache", "opencode"),
]

function canonicalize(target) {
  const resolved = path.resolve(target)
  const suffix = []
  let current = resolved
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) break
    suffix.unshift(path.basename(current))
    current = parent
  }
  let real
  try { real = fs.realpathSync(current) } catch { real = current }
  return suffix.length > 0 ? path.join(real, ...suffix) : real
}

function under(child, parent) {
  return child === parent || child.startsWith(`${parent}${path.sep}`)
}

function hashValue(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex")
}

function treeDigest(dir) {
  const files = []
  const walk = (base, rel) => {
    for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(base, entry.name)
      const next = rel === "" ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(abs, next)
      else if (entry.isFile()) files.push(next)
    }
  }
  walk(dir, "")
  const digest = crypto.createHash("sha256")
  for (const file of files) {
    digest.update(file)
    digest.update("\0")
    digest.update(crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, file))).digest("hex"))
    digest.update("\n")
  }
  return digest.digest("hex")
}

function parseArgs(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith("--")) continue
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next
      index += 1
    } else {
      flags[key] = true
    }
  }
  return flags
}

function fail(message) {
  console.error(`rigel-v2 install refused: ${message}`)
  process.exit(1)
}

function guardIsolation(paths, { configExplicit = false } = {}) {
  // The install's own roots plus the isolated XDG roots it hands to the skills
  // materializer. Ambient XDG variables are NOT guarded: explicit --config /
  // --state / --home flags override them and the spawned helper never sees them.
  const targets = { ...paths, ...isolatedXdgEnv(paths.home) }
  const v1Roots = V1_ROOTS.map(canonicalize)
  for (const [name, target] of Object.entries(targets)) {
    const canonical = canonicalize(target)
    for (const v1Root of v1Roots) {
      if (!under(canonical, v1Root)) continue
      // The documented V1/V2 incompatibility is the boundary: Rigel must not run
      // alongside an active V1. An EXPLICITLY provided config (`--config` /
      // `RIGEL_V2_CONFIG`) is the operator's confirmation that this is the active
      // V2 config, so it is accepted even under the generic OpenCode config root
      // that V2 shares. A DEFAULTED path is never accepted, and home/state/XDG
      // roots keep the unconditional refusal. No V1 heuristic is applied here.
      if (name === "configFile" && configExplicit) {
        process.stderr.write(`rigel-v2: accepting the explicitly-provided V2 config under the shared config root ${v1Root}\n`)
        continue
      }
      fail(`${name} resolves under a V1 root (${v1Root}): ${canonical}`)
    }
  }
}

/** Isolated XDG roots derived under `home`, so a spawned helper can never fall back to the real ones. */
function isolatedXdgEnv(home) {
  return {
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
  }
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")) }
function writeJson(file, value) { writeJsonAtomic(file, value) }

/** Resolve the Bun runtime the agent-manifest builder requires (BUN override, else PATH). */
function resolveBunBin() {
  const fromEnv = process.env.BUN
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim()
  return "bun"
}

/** The durable, editable OmO profile paths the native runtime reads LIVE. */
function editableProfilePaths(home) {
  const profileHome = path.join(home, ".omo")
  return {
    profileHome,
    profileFile: path.join(profileHome, "omo.jsonc"),
    promptFile: path.join(profileHome, "opencode", "prompts", "sisyphus-orchestration.md"),
  }
}

/**
 * Persist the durable, EDITABLE OmO config the native runtime reads LIVE for
 * per-agent model selection (`agents.<id>.model`). On a clean install it is
 * seeded from the tracked profile with `__OMO_PROFILE_ROOT__` resolved to the
 * profile home; an EXISTING file is NEVER overwritten, so a user edit survives
 * reinstall/upgrade. The companion Sisyphus prompt is seeded the same way when
 * absent. Both are staged into the manifest builder's sandbox and tracked by the
 * lifecycle transaction for a byte-identical rollback.
 *
 * `createdProfile` reports whether THIS call created the editable profile file,
 * which is the only case in which product-default models may be seeded into it.
 */
function persistEditableProfile(home, profileSource) {
  const { profileHome, profileFile, promptFile } = editableProfilePaths(home)
  const createdProfile = !fs.existsSync(profileFile)
  if (createdProfile) {
    writeTextAtomic(profileFile, fs.readFileSync(profileSource, "utf8").replaceAll("__OMO_PROFILE_ROOT__", profileHome))
  }
  if (!fs.existsSync(promptFile)) {
    fs.mkdirSync(path.dirname(promptFile), { recursive: true, mode: 0o700 })
    fs.copyFileSync(path.join(sourceRoot, "profiles/gabo/opencode/prompts/sisyphus-orchestration.md"), promptFile)
  }
  return { profileHome, profileFile, promptFile, createdProfile }
}

/**
 * Render the clean-install product defaults into the just-seeded editable
 * profile: Ultrawork off, and NO baked Context7 decision. Whether the builtin
 * Context7 is live is decided by the runtime on every setup (an external
 * Context7 in the user's OpenCode config wins by name collision; the builtin is
 * emitted when none exists). Runs BEFORE the manifest builder reads the profile.
 * Clean install only: an existing profile is never rewritten, so a user's own
 * `disabled_mcps` choice survives.
 */
function applyCleanInstallProfilePolicy(profileFile) {
  const profile = JSON.parse(fs.readFileSync(profileFile, "utf8"))
  writeTextAtomic(profileFile, `${JSON.stringify(renderCleanInstallProfile(profile), null, 2)}\n`)
}

/**
 * Read the `agents` block of a generated `agent-manifest.mjs` WITHOUT executing
 * it. The builder writes a single comment line followed by
 * `export default <json>`, so the JSON payload after the marker is parsed
 * directly; the installer never imports executable content it did not produce.
 */
function readManifestAgents(manifestFile) {
  const text = fs.readFileSync(manifestFile, "utf8")
  const marker = "export default "
  const start = text.indexOf(marker)
  if (start === -1) return {}
  const parsed = JSON.parse(text.slice(start + marker.length))
  const agents = parsed?.agents
  return agents && typeof agents === "object" && !Array.isArray(agents) ? agents : {}
}

/**
 * The ordered `fallback_models` for an agent: the manifest's canonical chain
 * WITHOUT its head (the head is seeded separately as `model`), preserving each
 * rung's providers, model and variant. Returns undefined when there is no tail.
 */
function seedFallbackModels(chain) {
  if (!Array.isArray(chain) || chain.length <= 1) return undefined
  const rungs = chain.slice(1)
    .map((rung) => {
      if (!rung || typeof rung !== "object" || Array.isArray(rung)) return undefined
      const model = typeof rung.model === "string" && rung.model ? rung.model : undefined
      if (!model) return undefined
      return {
        ...(Array.isArray(rung.providers) && rung.providers.length > 0 ? { providers: [...rung.providers] } : {}),
        model,
        ...(typeof rung.variant === "string" && rung.variant ? { variant: rung.variant } : {}),
      }
    })
    .filter(Boolean)
  return rungs.length > 0 ? rungs : undefined
}

/**
 * The head model to seed for an agent record: the manifest's own
 * `model`/`variant` when present, otherwise the first rung of the record's
 * canonical chain. The plugin emits records without a resolved model for
 * explicitly-gated coordinators (Prometheus); their chain head is the product
 * default. Returns undefined when neither source exists (plan/build/judge).
 */
function seedHeadModel(record) {
  if (typeof record.model === "string" && record.model) {
    return {
      model: record.model,
      variant: typeof record.variant === "string" && record.variant ? record.variant : undefined,
    }
  }
  const chain = record.chain
  if (!Array.isArray(chain) || chain.length === 0) return undefined
  const head = chain[0]
  if (!head || typeof head !== "object" || Array.isArray(head)) return undefined
  if (typeof head.model !== "string" || !head.model) return undefined
  const providers = Array.isArray(head.providers) ? head.providers : []
  const provider = providers.find((entry) => typeof entry === "string" && entry)
  return {
    model: provider ? `${provider}/${head.model}` : head.model,
    variant: typeof head.variant === "string" && head.variant ? head.variant : undefined,
  }
}

/**
 * Seed each agent's product-default model from the GENERATED manifest into the
 * freshly created editable profile (`<home>/.omo/omo.jsonc`), under top-level
 * `agents.<id>`: the head `model` + `variant`, plus the rest of the manifest's
 * ordered canonical chain as `fallback_models`. The runtime walks that JSON chain
 * in order when a model fails or is unavailable; the manifest is NEVER consulted
 * at runtime. Only a CLEAN install created the file, so an existing user file is
 * never rewritten; every other field and entry is preserved, and an agent with no
 * manifest model is left untouched. Written back atomically as pretty JSON.
 */
function seedAgentProductDefaults(profileFile, manifestAgents) {
  const profile = JSON.parse(fs.readFileSync(profileFile, "utf8"))
  const agents = profile.agents && typeof profile.agents === "object" && !Array.isArray(profile.agents) ? profile.agents : {}
  let seeded = 0
  for (const [id, record] of Object.entries(manifestAgents)) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue
    const head = seedHeadModel(record)
    if (!head) continue
    const existing = agents[id] && typeof agents[id] === "object" && !Array.isArray(agents[id]) ? agents[id] : {}
    const fallbackModels = seedFallbackModels(record.chain)
    agents[id] = {
      ...existing,
      model: head.model,
      ...(head.variant ? { variant: head.variant } : {}),
      ...(fallbackModels ? { fallback_models: fallbackModels } : {}),
    }
    seeded += 1
  }
  if (seeded === 0) return
  profile.agents = agents
  writeTextAtomic(profileFile, `${JSON.stringify(profile, null, 2)}\n`)
}

function generateAgentManifest({ versionDir, home, configFile }) {
  const output = path.join(versionDir, "agent-manifest.mjs")
  const selectionFile = path.join(sourceRoot, "profiles/gabo/v2-agent-selection.json")
  const judgeFile = path.join(sourceRoot, "profiles/gabo/opencode/agents/judge.v2.json")
  const profileSource = process.env.RIGEL_V2_PROFILE_FILE || path.join(sourceRoot, "profiles/gabo/omo.jsonc")
  const skills = spawnSync(process.execPath, [path.join(sourceRoot, "profiles/gabo/materialize-v2-skills.mjs")], {
    cwd: sourceRoot,
    env: { ...process.env, HOME: home, ...isolatedXdgEnv(home) },
    encoding: "utf8",
  })
  if (skills.status !== 0) throw new Error(`no se pudieron exponer las skills V2: ${skills.stderr || skills.stdout}`)
  // The native runtime reads this LIVE at setup, so it must be durable and
  // editable; it replaces the throwaway generator home the manifest used to bake
  // from. An existing user file is left untouched.
  const { profileFile, createdProfile } = persistEditableProfile(home, profileSource)
  const bunBin = resolveBunBin()
  // A clean host has no config yet; both the builder and the runtime
  // materialization must READ it, and the installer only ADDS the runtime entry
  // to whatever is there. Create an empty, valid config when the explicit path is
  // absent (its parent is created too); an existing config is left untouched, so
  // invalid JSON still fails where it is parsed. The surrounding transaction
  // restores the absent state on rollback.
  if (!fs.existsSync(configFile)) writeJsonAtomic(configFile, {})
  // CLEAN install only: render the product defaults (Ultrawork off; no baked
  // Context7 decision) into the just-seeded profile BEFORE the builder reads it.
  // Context7 exclusivity is decided LIVE by the runtime on every setup. An
  // existing profile is never rewritten (createdProfile is false on reinstall).
  if (createdProfile) applyCleanInstallProfilePolicy(profileFile)
  const generated = spawnSync(bunBin, [
    path.join(sourceRoot, "profiles/gabo/build-target-agent-manifest.mjs"),
    "--input", configFile, "--output", output,
    "--selection", selectionFile, "--judge", judgeFile,
    "--profile-root", home,
  ], {
    cwd: sourceRoot,
    env: { ...process.env, XDG_CONFIG_HOME: path.dirname(path.dirname(configFile)), OMO_PROFILE: "gabo", OMO_DISABLE_PROCESS_CLEANUP: "1" },
    encoding: "utf8",
  })
  if (generated.error) throw new Error(`la generación del manifiesto requiere bun en PATH (no se pudo ejecutar "${bunBin}"): ${generated.error.message}`)
  if (generated.status !== 0) throw new Error(`la generación del manifiesto falló: ${generated.stderr || generated.stdout}`)
  // CLEAN install only: seed each agent's product-default model from the
  // GENERATED manifest into the just-created editable profile. On
  // reinstall/upgrade the file already exists (`createdProfile` false) and is
  // left untouched, so a user edit is never overwritten. The profile file is in
  // the lifecycle transaction, so any later failure restores it byte-identically.
  if (createdProfile) seedAgentProductDefaults(profileFile, readManifestAgents(output))
  return output
}

/**
 * U3: provision the pinned ast-grep `sg` (0.43.0 + per-platform sha256) into
 * `<home>/.omo/runtime/ast-grep/<slug>`, best-effort. Runs under Bun because the
 * provisioning module imports `@oh-my-opencode/utils` lazily. A failed or
 * offline download is logged and never fails the install; the caller tracks the
 * runtime dir so a later failure removes it byte-identically. Opt out with
 * `RIGEL_V2_SG_PROVISION=0` (kept hermetic by the offline installer test lane).
 */
function provisionAstGrepSgBestEffort(home) {
  if (process.env.RIGEL_V2_SG_PROVISION === "0") return
  try {
    const result = spawnSync(resolveBunBin(), [path.join(sourceRoot, "profiles/gabo/rigel-v2-ast-grep-provision.mjs"), "--home", home, "--json"], {
      cwd: sourceRoot,
      env: { ...process.env, HOME: home, ...isolatedXdgEnv(home) },
      encoding: "utf8",
      timeout: 120_000,
    })
    if (result.error || result.status !== 0) {
      const detail = result.error?.message ?? String(result.stderr || result.stdout || "").trim()
      process.stderr.write(`rigel-v2: ast-grep sg provisioning skipped: ${detail}\n`)
    }
  } catch (error) {
    process.stderr.write(`rigel-v2: ast-grep sg provisioning skipped: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

/**
 * C4: snapshot `<home>/.agents/skills` before the skill materializer runs, so a
 * failed install can undo exactly the link mutations it made. Records, per entry,
 * whether it was a symlink and where it pointed; a non-symlink (a user directory
 * or file) is recorded so the restore never touches it.
 */
function snapshotDiscoveryRoot(dir) {
  const entries = new Map()
  if (!fs.existsSync(dir)) return { existed: false, entries }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    let target = null
    try { target = entry.isSymbolicLink() ? fs.readlinkSync(path.join(dir, entry.name)) : null } catch { target = null }
    entries.set(entry.name, { symlink: entry.isSymbolicLink(), target })
  }
  return { existed: true, entries }
}

/**
 * C4: undo the materializer's link mutations. A name that appeared during the run
 * is a Rigel-created link and is removed; a name whose symlink target changed is
 * re-pointed to its prior target. Only symlinks are touched - a user directory or
 * file, and a link that did not change, are never modified. If the discovery root
 * did not exist before, an empty root is removed.
 */
function restoreDiscoveryRoot(dir, before) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue
    const target = path.join(dir, entry.name)
    const prior = before.entries.get(entry.name)
    if (prior === undefined) {
      try { fs.rmSync(target, { force: true }) } catch { /* best-effort */ }
      continue
    }
    let current = null
    try { current = fs.readlinkSync(target) } catch { current = null }
    if (prior.symlink && prior.target !== null && prior.target !== current) {
      try { fs.rmSync(target, { force: true }) } catch { /* best-effort */ }
      try { fs.symlinkSync(prior.target, target, "dir") } catch { /* best-effort */ }
    }
  }
  if (!before.existed) {
    try { fs.rmdirSync(dir) } catch { /* not empty: a user entry appeared; leave it */ }
  }
}

/** The vendored engine's artifact root and the loader shim the host loads. */
function goalEnginePaths(runtimeDir) {
  const artifactRoot = path.join(goalVendorTargetDir(runtimeDir), "node_modules", ...GOAL_VENDOR_ARTIFACT.name.split("/"))
  // The host loads the shim directories (`.`/`./tui` entrypoints), not the
  // vendored files: the server shim for `opencode.json`, the TUI shim for
  // `cli.json`.
  return {
    artifactRoot,
    engineEntry: path.join(runtimeDir, GOAL_ENGINE_SHIM_DIRNAME),
    tuiEntry: path.join(runtimeDir, GOAL_TUI_SHIM_DIRNAME),
  }
}

function removeOurConfigEntries(configFile, stateRoot) {
  const canonicalState = canonicalize(stateRoot)
  const config = fs.existsSync(configFile) ? readJson(configFile) : {}
  if (Array.isArray(config.plugin)) {
    config.plugin = config.plugin.filter((entry) => !(typeof entry === "string" && under(canonicalize(entry), canonicalState)))
  }
  const cliConfigFile = path.join(path.dirname(configFile), "cli.json")
  const cli = fs.existsSync(cliConfigFile) ? readJson(cliConfigFile) : { plugins: [] }
  // The goal engine is its own slot: strip it from both configs regardless of the
  // runtime-family filter, which deliberately ignores it.
  const stripped = removeGoalEntries(config, cli)
  writeJsonAtomic(configFile, stripped.config)
  if (fs.existsSync(cliConfigFile)) {
    writeJsonAtomic(cliConfigFile, removeRigelCliEntries(stripped.cli, { familyRoot: stateRoot }))
  }
}

/**
 * Remove the Rigel-managed skill links and the skills manifest. Returns the
 * removed names plus the (target, source) pairs needed to recreate the links if
 * a surrounding transaction has to roll back.
 */
function removeManagedSkills(home) {
  const skillsStateFile = path.join(home, ".local", "share", "oh-my-rigel", "skills-v2.json")
  if (!fs.existsSync(skillsStateFile)) return { removed: [], restore: [] }
  const manifest = readJson(skillsStateFile)
  const discoveryRoot = manifest.discoveryRoot ?? path.join(home, ".agents", "skills")
  const removed = []
  const restore = []
  for (const entry of manifest.managed ?? []) {
    const target = path.join(discoveryRoot, entry.name)
    try {
      const stat = fs.lstatSync(target)
      if (stat.isSymbolicLink() && fs.realpathSync(target) === fs.realpathSync(entry.source)) {
        fs.unlinkSync(target)
        removed.push(entry.name)
        restore.push({ target, source: entry.source })
      }
    } catch { /* already gone or user-owned */ }
  }
  fs.rmSync(skillsStateFile, { force: true })
  return { removed, restore }
}

function restoreSkillLinks(restore) {
  for (const { target, source } of [...restore].reverse()) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
      fs.symlinkSync(source, target, "dir")
    } catch { /* best-effort restore */ }
  }
}

function writeLauncher(stateRoot, home, configFile) {
  const launcher = path.join(stateRoot, "bin", "rigel-v2")
  fs.mkdirSync(path.dirname(launcher), { recursive: true, mode: 0o700 })
  const script = `#!/usr/bin/env bash
set -euo pipefail
export HOME=${JSON.stringify(home)}
exec node ${JSON.stringify(INSTALLER_PATH)} "$@" --state ${JSON.stringify(stateRoot)} --home ${JSON.stringify(home)} --config ${JSON.stringify(configFile)}
`
  fs.writeFileSync(launcher, script, { mode: 0o700 })
  fs.chmodSync(launcher, 0o700)
  return launcher
}

function resolvePaths(flags) {
  const home = path.resolve(flags.home || process.env.RIGEL_V2_HOME || os.homedir())
  const stateRoot = path.resolve(flags.state || process.env.RIGEL_V2_USER_ROOT || path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "oh-my-rigel"))
  const configDir = process.env.XDG_CONFIG_HOME || path.join(home, ".config")
  const configFile = path.resolve(flags.config || process.env.RIGEL_V2_CONFIG || path.join(configDir, "opencode", "opencode.json"))
  return { home, stateRoot, configFile }
}

function installVersion({ paths, version, runtimeSource, previousState, migrating, txn }) {
  const versionDir = path.join(paths.stateRoot, "versions", version)
  fs.mkdirSync(versionDir, { recursive: true, mode: 0o700 })
  const runtimeDir = path.join(versionDir, "runtime")
  // A reinstall of the same version must materialise from CLEAN staging: move the
  // existing runtime tree aside (inside the transaction) so a module a previous
  // install wrote cannot survive a removal. The move is compensated, so any later
  // failure restores the prior runtime byte-identically; on success the aside copy
  // is discarded. A clean install (no prior runtime) tracks nothing here.
  txn?.trackCreatedDir(runtimeDir)
  txn?.trackReplacedDir(runtimeDir)
  // C4: snapshot the skill discovery root BEFORE the materializer runs, so a
  // failed install restores exactly the Rigel-owned links it created or
  // re-pointed. Only symlinks whose entry changed are touched; user content is
  // never removed.
  const skillsDir = path.join(paths.home, ".agents", "skills")
  const skillsBefore = snapshotDiscoveryRoot(skillsDir)
  txn?.trackRestore(() => restoreDiscoveryRoot(skillsDir, skillsBefore))
  const agentManifest = generateAgentManifest({ versionDir, home: paths.home, configFile: paths.configFile })
  // U3/C2: deliver the pinned ast-grep `sg` the newly delivered ast-grep skill
  // consumes. The runtime dir is SNAPSHOTTED before provisioning: a fresh install
  // removes it on rollback, and a reinstall/upgrade that refreshes an existing
  // tree restores the prior bytes byte-identically. Provisioning itself is
  // best-effort and never fails an offline install.
  const astGrepDir = astGrepUserRuntimeDir(paths.home)
  const astGrepExistedBefore = fs.existsSync(astGrepDir)
  txn?.trackSnapshotDir(astGrepDir)
  provisionAstGrepSgBestEffort(paths.home)
  txn?.failAt("provision:after-astgrep")
  const result = materializeNativeRuntime({
    sourceRoot,
    runtimeSourceDir: runtimeSource,
    runtimeDir,
    familyRoot: paths.stateRoot,
    agentManifestPath: agentManifest,
    configFile: paths.configFile,
    profileFile: process.env.RIGEL_V2_PROFILE_FILE || path.join(sourceRoot, "profiles/gabo/omo.jsonc"),
    env: process.env,
  })
  const runtimeDigest = treeDigest(path.join(versionDir, "runtime"))
  // The single effective state seam: OPENCODE_GOAL_STATE_PATH, always inside the
  // Rigel state tree. Adoption of a compatible EXTERNAL community state is
  // opt-in and by copy only (the source stays byte-identical); an incompatible,
  // modified, newer or V1 source fails closed and no external state is read
  // otherwise.
  const goalStatePath = resolveGoalStatePath(paths.stateRoot)
  const adoptFrom = process.env.RIGEL_V2_GOAL_ADOPT_FROM
  if (typeof adoptFrom === "string" && adoptFrom.trim() !== "") {
    adoptGoalState({
      sourcePath: adoptFrom,
      targetPath: goalStatePath,
      stateRoot: paths.stateRoot,
      expectedDigest: process.env.RIGEL_V2_GOAL_ADOPT_SHA256,
    })
  }
  // Additive: the version key keeps its exact meaning for `runtime.digestMatches`
  // and rollback, and the pinned goal vendor's materialized-tree digest is recorded
  // beside it under a namespaced key.
  const versionDigests = {
    ...(previousState?.versionDigests ?? {}),
    [version]: runtimeDigest,
    [goalVendorDigestKey(version)]: result.goalVendor.treeDigest,
  }
  const base = {
    schema: STATE_SCHEMA,
    version,
    previousVersion: migrating ? previousState?.version ?? null : null,
    home: paths.home,
    configFile: paths.configFile,
    stateRoot: paths.stateRoot,
    pluginEntry: result.pluginEntry,
    agentManifest,
    goalStatePath,
    goalOptions: result.goalOptions,
    installedAt: previousState?.installedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    versionDigests,
    migrationLog: previousState?.migrationLog ?? [],
    rollbackLog: previousState?.rollbackLog ?? [],
    // C5/M5: only an install that CREATED the ast-grep runtime dir owns it, so
    // uninstall removes it only when ownership is proven. A tree that already
    // existed (for example a user's pre-Rigel sg) is never claimed, and
    // ownership is carried across reinstall/upgrade.
    astGrepOwnedDir: astGrepExistedBefore ? (previousState?.astGrepOwnedDir ?? null) : astGrepDir,
  }
  if (migrating && previousState) {
    base.migrationLog = [...base.migrationLog, { from: previousState.version, to: version, at: base.updatedAt }]
  }
  return base
}

function statusOf(state, paths) {
  const checks = []
  const runtime = path.join(paths.stateRoot, "versions", state.version, "runtime")
  const canonicalState = canonicalize(paths.stateRoot)
  checks.push({ name: "runtime.materialized", pass: fs.existsSync(path.join(runtime, "index.js")) })
  checks.push({ name: "agentManifest.present", pass: fs.existsSync(state.agentManifest) })
  checks.push({ name: "state.pluginEntryMatchesVersion", pass: state.pluginEntry === runtime })

  // opencode.json: exactly one Rigel-family entry, and it is the active runtime.
  const config = fs.existsSync(paths.configFile) ? readJson(paths.configFile) : {}
  const configPlugins = Array.isArray(config.plugin) ? config.plugin : []
  const configFamily = configPlugins.filter((entry) => typeof entry === "string" && under(canonicalize(entry), canonicalState))
  checks.push({ name: "config.registersRuntime", pass: configPlugins.includes(state.pluginEntry) })
  checks.push({ name: "config.singleRigelEntry", pass: configFamily.length === 1 && configFamily[0] === state.pluginEntry })
  // The vendored goal engine is its own slot in the SAME array: exactly one.
  checks.push({ name: "goal.singleServerEntry", pass: configPlugins.filter(isGoalEngineEntry).length === 1 })

  // cli.json: exactly one Rigel-family companion entry pointing at the SAME
  // runtime as the server config, and the builtin-disable marker present iff the
  // notification surface is enabled. This is the skew the P2 REJECT proved: a
  // version transition used to leave both the old and new entries behind.
  const cliConfigFile = path.join(path.dirname(paths.configFile), "cli.json")
  const cli = fs.existsSync(cliConfigFile) ? readJson(cliConfigFile) : { plugins: [] }
  const cliPlugins = Array.isArray(cli.plugins) ? cli.plugins : []
  // The goal TUI entry lives under the state root too but belongs to the goal
  // slot, so it must not count as the runtime companion.
  const cliFamily = cliPlugins.filter((entry) => !isGoalEngineEntry(entry) && entry && typeof entry === "object" && typeof entry.package === "string" && under(canonicalize(entry.package), canonicalState))
  const markerCount = cliPlugins.filter((entry) => entry === "-opencode.notifications").length
  const notificationEnabled = cliFamily[0]?.options?.notification?.enabled === true
  checks.push({ name: "cli.singleRigelEntry", pass: cliFamily.length === 1 })
  checks.push({ name: "cli.runtimeMatchesConfig", pass: cliFamily.length === 1 && cliFamily[0].package === state.pluginEntry })
  checks.push({ name: "cli.disabledMarkerCorrect", pass: markerCount === (notificationEnabled ? 1 : 0) })
  checks.push({ name: "goal.singleCliEntry", pass: cliPlugins.filter(isGoalEngineEntry).length === 1 })

  const currentDigest = fs.existsSync(runtime) ? treeDigest(runtime) : null
  checks.push({ name: "runtime.digestMatches", pass: currentDigest !== null && currentDigest === state.versionDigests?.[state.version] })

  if (state.goalStatePath !== undefined) {
    let inside = false
    try {
      assertGoalStatePathSafe(state.goalStatePath, paths.stateRoot)
      inside = true
    } catch {
      inside = false
    }
    checks.push({ name: "goal.statePathInsideRoot", pass: inside })
  }
  return { version: state.version, previousVersion: state.previousVersion ?? null, checks, pass: checks.every((entry) => entry.pass) }
}

function emit(value, flags) {
  if (flags.json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  else process.stdout.write(`${JSON.stringify(value)}\n`)
  if (value.pass === false || value.ok === false) process.exitCode = 1
}

/** Run a lifecycle mutation inside a compensating transaction over config/cli/state. */
function lifecycle(files, run) {
  const txn = beginLifecycleTransaction({ files })
  try {
    const value = run(txn)
    txn.commit()
    return value
  } catch (error) {
    txn.rollback()
    console.error(`rigel-v2 install refused: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

function main() {
  const [command, ...rest] = process.argv.slice(2)
  const flags = parseArgs(rest)
  const paths = resolvePaths(flags)
  guardIsolation(
    { home: paths.home, stateRoot: paths.stateRoot, configFile: paths.configFile },
    {
      configExplicit:
        typeof flags.config === "string" ||
        (typeof process.env.RIGEL_V2_CONFIG === "string" && process.env.RIGEL_V2_CONFIG.trim() !== ""),
    },
  )
  const stateFile = path.join(paths.stateRoot, "install-state.json")
  const cliConfigFile = path.join(path.dirname(paths.configFile), "cli.json")
  const skillsStateFile = path.join(paths.home, ".local", "share", "oh-my-rigel", "skills-v2.json")
  // The durable editable OmO profile the runtime reads LIVE is part of the
  // transaction so a failed install/upgrade restores it byte-identically (and a
  // clean install's freshly seeded copy is removed on rollback).
  const { profileFile: omoProfileFile, promptFile: omoPromptFile } = editableProfilePaths(paths.home)
  // The adopted goal state is written by install/upgrade, so it belongs to the
  // same compensating transaction: a failure after adoption must restore a
  // pre-existing file byte-identically, or remove one that was absent. Without
  // this entry a failed install could overwrite a prior state or leave a new one.
  const transactionFiles = [paths.configFile, cliConfigFile, stateFile, skillsStateFile, omoProfileFile, omoPromptFile, resolveGoalStatePath(paths.stateRoot)]
  const profileFile = process.env.RIGEL_V2_PROFILE_FILE || path.join(sourceRoot, "profiles/gabo/omo.jsonc")
  const previousState = fs.existsSync(stateFile) ? readJson(stateFile) : null

  if (command === "install") {
    const version = String(flags.version || "1")
    lifecycle(transactionFiles, (txn) => {
      txn.trackCreatedDir(path.join(paths.stateRoot, "versions", version))
      const state = installVersion({ paths, version, runtimeSource: flags["runtime-source"], previousState, migrating: false, txn })
      txn.failAt("install:after-runtime")
      writeJson(stateFile, state)
      txn.failAt("install:after-state")
      const launcher = writeLauncher(paths.stateRoot, paths.home, paths.configFile)
      emit({ ok: true, command, version, pluginEntry: state.pluginEntry, launcher, status: statusOf(state, paths) }, flags)
    })
    return
  }

  if (command === "upgrade") {
    if (!previousState) fail("no hay una instalación Rigel V2 para actualizar; ejecute install primero")
    const version = String(flags.version || "")
    if (version === "" || version === previousState.version) fail(`upgrade requiere una versión distinta de la instalada (${previousState.version})`)
    lifecycle(transactionFiles, (txn) => {
      txn.trackCreatedDir(path.join(paths.stateRoot, "versions", version))
      const state = installVersion({ paths, version, runtimeSource: flags["runtime-source"], previousState, migrating: true, txn })
      txn.failAt("upgrade:after-runtime")
      writeJson(stateFile, state)
      txn.failAt("upgrade:after-state")
      emit({ ok: true, command, from: previousState.version, to: version, migrated: state.migrationLog.at(-1) ?? null, status: statusOf(state, paths) }, flags)
    })
    return
  }

  if (command === "rollback") {
    if (!previousState) fail("no hay una instalación Rigel V2 para revertir")
    const target = previousState.previousVersion
    if (!target) fail("no hay una versión previa registrada para revertir")
    const targetRuntime = path.join(paths.stateRoot, "versions", target, "runtime")
    if (!fs.existsSync(targetRuntime)) fail(`el runtime de la versión previa no existe: ${targetRuntime}`)
    const expected = previousState.versionDigests?.[target]
    const actual = treeDigest(targetRuntime)
    if (expected !== undefined && expected !== actual) fail(`el runtime de la versión previa no coincide byte a byte (${target})`)
    lifecycle(transactionFiles, (txn) => {
      const config = fs.existsSync(paths.configFile) ? readJson(paths.configFile) : {}
      config.plugin = registerRuntimePluginEntry(Array.isArray(config.plugin) ? config.plugin : [], { runtimeDir: targetRuntime, familyRoot: paths.stateRoot })
      const goalPaths = goalEnginePaths(targetRuntime)
      const goalOverrides = { ...goalEntryOptions((config.plugin ?? []).find(isGoalEngineEntry)), ...resolveGoalOptionOverrides(profileFile, process.env) }
      config.plugin = registerGoalServerEntry(config.plugin, { engineEntry: goalPaths.engineEntry, options: resolveGoalOptions({ overrides: goalOverrides }) })
      writeJson(paths.configFile, config)
      txn.failAt("rollback:after-config")
      const cliBefore = fs.existsSync(cliConfigFile) ? readJson(cliConfigFile) : { plugins: [] }
      const notificationOptions = resolveRuntimeNotificationOptions(profileFile, process.env)
      const cliCompanion = registerCompanionCliPlugin(cliBefore, {
        runtimeDir: targetRuntime,
        familyRoot: paths.stateRoot,
        options: notificationOptions,
        notificationEnabled: notificationOptions.enabled,
      })
      writeJson(cliConfigFile, registerGoalCliEntry(cliCompanion, { tuiShimDir: goalPaths.tuiEntry }))
      txn.failAt("rollback:after-cli")
      const state = {
        ...previousState,
        version: target,
        previousVersion: null,
        pluginEntry: targetRuntime,
        agentManifest: path.join(paths.stateRoot, "versions", target, "agent-manifest.mjs"),
        goalStatePath: resolveGoalStatePath(paths.stateRoot),
        updatedAt: new Date().toISOString(),
        rollbackLog: [...(previousState.rollbackLog ?? []), { from: previousState.version, to: target, byteIdentical: expected === actual, at: new Date().toISOString() }],
      }
      writeJson(stateFile, state)
      txn.failAt("rollback:after-state")
      emit({ ok: true, command, version: target, byteIdentical: expected === actual, status: statusOf(state, paths) }, flags)
    })
    return
  }

  if (command === "uninstall") {
    if (!previousState) fail("no hay una instalación Rigel V2 para desinstalar")
    lifecycle(transactionFiles, (txn) => {
      const staged = []
      let skillsRestore = []
      try {
        removeOurConfigEntries(paths.configFile, paths.stateRoot)
        txn.failAt("uninstall:after-config")
        for (const dir of ["versions", "bin"]) {
          const abs = path.join(paths.stateRoot, dir)
          if (fs.existsSync(abs)) {
            const backup = `${abs}.txn-${crypto.randomBytes(4).toString("hex")}`
            fs.renameSync(abs, backup)
            staged.push({ abs, backup })
          }
        }
        // C5/M5: remove the ast-grep runtime dir ONLY when this install recorded
        // ownership of it, so a user's pre-Rigel sg is never deleted. Staged with
        // versions/bin so a failed uninstall restores it byte-identically.
        const ownedSgDir = previousState?.astGrepOwnedDir
        const ownedSg = typeof ownedSgDir === "string" && ownedSgDir.length > 0 && fs.existsSync(ownedSgDir)
        if (ownedSg) {
          const backup = `${ownedSgDir}.txn-${crypto.randomBytes(4).toString("hex")}`
          fs.renameSync(ownedSgDir, backup)
          staged.push({ abs: ownedSgDir, backup })
        }
        txn.failAt("uninstall:after-versions")
        const skills = removeManagedSkills(paths.home)
        skillsRestore = skills.restore
        txn.failAt("uninstall:after-skills")
        fs.rmSync(stateFile, { force: true })
        txn.failAt("uninstall:after-state")
        for (const { backup } of staged) fs.rmSync(backup, { recursive: true, force: true })
        const remaining = fs.existsSync(paths.stateRoot) ? fs.readdirSync(paths.stateRoot).sort() : []
        const config = fs.existsSync(paths.configFile) ? readJson(paths.configFile) : {}
        emit({ ok: true, command, removed: ["versions", "bin", "install-state.json", ...(ownedSg ? ["ast-grep"] : [])], removedSkills: skills.removed, preserved: remaining, remainingPluginEntries: Array.isArray(config.plugin) ? config.plugin : [] }, flags)
      } catch (error) {
        for (const { abs, backup } of [...staged].reverse()) {
          try {
            fs.rmSync(abs, { recursive: true, force: true })
            fs.renameSync(backup, abs)
          } catch { /* best-effort restore */ }
        }
        restoreSkillLinks(skillsRestore)
        throw error
      }
    })
    return
  }

  if (command === "status") {
    if (!previousState) fail("no hay una instalación Rigel V2")
    emit({ ok: true, command, ...statusOf(previousState, paths) }, flags)
    return
  }

  fail(`comando desconocido: ${String(command)}`)
}

main()
