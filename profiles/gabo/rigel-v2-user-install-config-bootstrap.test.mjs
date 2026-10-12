/**
 * Contract for the config bootstrap on the PUBLISHED env-variable route.
 *
 * A fresh host has no config yet. Both agent-manifest generation and runtime
 * materialization must READ the config, so when the explicitly provided config
 * path is ABSENT the installer creates its parent and an empty valid config `{}`
 * before generating the manifest. An existing config is never reset; it only
 * receives the Rigel runtime entry, and invalid existing JSON still fails where
 * it is parsed.
 *
 * Positive: absent explicit config -> config created + runtime manifest produced.
 * Preservation: existing valid config -> its content is kept, runtime entry added.
 * Negative: invalid existing JSON -> install fails, the file stays byte-identical.
 *
 * Hermetic: every HOME/state root inside a temp tree; no real HOME, no network.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(moduleDirectory, "../..")
const installerPath = path.join(repoRoot, "profiles/gabo/rigel-v2-user-install.mjs")

const EXPECTED_AGENT_KEYS = [
  "Sisyphus - ultraworker",
  "Hephaestus - Deep Agent",
  "Prometheus - Plan Builder",
  "Atlas - Plan Executor",
  "explore",
  "librarian",
  "Metis - Plan Consultant",
  "Momus - Plan Critic",
  "multimodal-looker",
  "oracle",
  "Sisyphus-Junior",
  "plan",
  "build",
  "judge",
]

function runRoute(home, configFile, stateRoot) {
  return spawnSync("node", [installerPath, "install", "--version", "1", "--json"], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      RIGEL_V2_HOME: home,
      RIGEL_V2_CONFIG: configFile,
      RIGEL_V2_USER_ROOT: stateRoot,
      OMO_DISABLE_PROCESS_CLEANUP: "1",
    },
    encoding: "utf8",
    timeout: 240_000,
  })
}

function runtimeDirAt(stateRoot) {
  return path.join(stateRoot, "versions", "1", "runtime")
}

function runtimeManifestAt(stateRoot) {
  return path.join(runtimeDirAt(stateRoot), "rigel-v2-native-agent-manifest.mjs")
}

async function loadManifest(file) {
  return (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)).default
}

describe("installer config bootstrap: absent explicit config", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-absent-config-"))
  const home = path.join(base, "home")
  // The whole config directory is absent on a fresh host.
  const configFile = path.join(home, ".config", "opencode", "opencode.json")
  const stateRoot = path.join(home, ".local", "share", "oh-my-rigel")
  let install
  let manifest
  let config

  beforeAll(async () => {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    install = runRoute(home, configFile, stateRoot)
    if (install.status === 0) {
      config = JSON.parse(fs.readFileSync(configFile, "utf8"))
      manifest = await loadManifest(runtimeManifestAt(stateRoot))
    }
  }, 300_000)

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  describe("#given no config exists at the explicit path", () => {
    describe("#when the installer runs the published route", () => {
      test("#then it creates a valid config and installs without error", () => {
        expect(install.status, `install failed: ${install.stderr || install.stdout}`).toBe(0)
        expect(fs.existsSync(configFile)).toBe(true)
        expect(Array.isArray(config.plugin)).toBe(true)
        expect(config.plugin).toContain(runtimeDirAt(stateRoot))
      })

      test("#then the runtime manifest and runtime tree are produced", () => {
        expect(fs.existsSync(runtimeManifestAt(stateRoot))).toBe(true)
        expect(fs.existsSync(path.join(runtimeDirAt(stateRoot), "index.js"))).toBe(true)
      })

      test("#then the produced runtime manifest carries the exact 14-agent surface", () => {
        expect(Object.keys(manifest.agents)).toEqual(EXPECTED_AGENT_KEYS)
        expect(manifest.agents.judge.model).toBeUndefined()
      })
    })
  })
})

describe("installer config bootstrap: existing config is preserved", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-existing-config-"))
  const home = path.join(base, "home")
  const configFile = path.join(home, ".config", "opencode", "opencode.json")
  const stateRoot = path.join(home, ".local", "share", "oh-my-rigel")
  const original = { $schema: "https://opencode.ai/config.json", plugin: ["rigel-foreign-plugin"], theme: "custom" }
  let install
  let config

  beforeAll(() => {
    fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(configFile, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 })
    install = runRoute(home, configFile, stateRoot)
    if (install.status === 0) config = JSON.parse(fs.readFileSync(configFile, "utf8"))
  }, 300_000)

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  describe("#given a valid config already exists at the explicit path", () => {
    describe("#when the installer registers the runtime", () => {
      test("#then the install succeeds and the runtime entry is added", () => {
        expect(install.status, `install failed: ${install.stderr || install.stdout}`).toBe(0)
        expect(config.plugin).toContain(runtimeDirAt(stateRoot))
      })

      test("#then the pre-existing content is preserved, not reset", () => {
        expect(config.$schema).toBe(original.$schema)
        expect(config.theme).toBe("custom")
        expect(config.plugin).toContain("rigel-foreign-plugin")
      })
    })
  })
})

describe("installer config bootstrap: invalid existing config still fails", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-invalid-config-"))
  const home = path.join(base, "home")
  const configFile = path.join(home, ".config", "opencode", "opencode.json")
  const stateRoot = path.join(home, ".local", "share", "oh-my-rigel")
  const invalid = "{ \"plugin\": [ /* not valid json */\n"
  let install
  let bytesAfter

  beforeAll(() => {
    fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(configFile, invalid, { mode: 0o600 })
    install = runRoute(home, configFile, stateRoot)
    bytesAfter = fs.readFileSync(configFile)
  }, 300_000)

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  describe("#given the explicit config exists but is not valid JSON", () => {
    describe("#when the installer runs the published route", () => {
      test("#then the install fails and the file is left byte-identical", () => {
        expect(install.status).not.toBe(0)
        expect(bytesAfter.toString("utf8")).toBe(invalid)
        expect(fs.existsSync(runtimeManifestAt(stateRoot))).toBe(false)
      })
    })
  })
})

describe("installer editable OmO profile: seeded on clean install, never overwritten", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-editable-profile-"))
  const home = path.join(base, "home")
  const configFile = path.join(home, ".config", "opencode", "opencode.json")
  const stateRoot = path.join(home, ".local", "share", "oh-my-rigel")
  // The durable config the native runtime reads LIVE for `agents.<id>.model`.
  const profileFile = path.join(home, ".omo", "omo.jsonc")
  const edited = `${JSON.stringify({ agents: { oracle: { model: "opencode-go/deepseek-v4-pro" } } }, null, 2)}\n`
  let seeded
  let afterEdit
  let firstInstall
  let secondInstall

  beforeAll(() => {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    firstInstall = runRoute(home, configFile, stateRoot)
    if (firstInstall.status === 0 && fs.existsSync(profileFile)) {
      seeded = fs.readFileSync(profileFile, "utf8")
      // Simulate the operator editing `agents.<id>.model` in the live config.
      fs.writeFileSync(profileFile, edited, { mode: 0o600 })
    }
    secondInstall = runRoute(home, configFile, stateRoot)
    if (secondInstall.status === 0 && fs.existsSync(profileFile)) {
      afterEdit = fs.readFileSync(profileFile, "utf8")
    }
  }, 300_000)

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  describe("#given a clean install with no OmO profile yet", () => {
    describe("#when the installer materializes the config", () => {
      test("#then it seeds a durable editable ~/.omo/omo.jsonc with every machine token resolved", () => {
        expect(firstInstall.status, `install failed: ${firstInstall.stderr || firstInstall.stdout}`).toBe(0)
        expect(fs.existsSync(profileFile)).toBe(true)
        expect(typeof seeded).toBe("string")
        // The profile-root placeholder must be resolved, or the runtime/loader
        // would try to open the literal `__OMO_PROFILE_ROOT__/...` prompt path.
        expect(seeded.includes("__OMO_PROFILE_ROOT__")).toBe(false)
        expect(JSON.parse(seeded).profiles.gabo).toBeDefined()
      })

      test("#then it seeds each agent's product-default model from the generated manifest", () => {
        const seededProfile = JSON.parse(seeded)
        // A known orchestrated agent present in the manifest carries its
        // product-default model under top-level `agents.<id>`.
        expect(typeof seededProfile.agents?.oracle?.model).toBe("string")
        expect(seededProfile.agents.oracle.model.length).toBeGreaterThan(0)
        expect(typeof seededProfile.agents?.explore?.model).toBe("string")
        // The FULL ordered chain is seeded, not just the head: the remaining
        // canonical rungs land in `fallback_models`, each keeping its providers,
        // model and variant, so the runtime can walk them in order when the head
        // model is unavailable. The manifest is never consulted for models.
        expect(Array.isArray(seededProfile.agents.oracle.fallback_models)).toBe(true)
        expect(seededProfile.agents.oracle.fallback_models.length).toBeGreaterThan(0)
        expect(seededProfile.agents.oracle.fallback_models[0]).toMatchObject({ model: expect.any(String) })
        expect(Array.isArray(seededProfile.agents.oracle.fallback_models[0].providers)).toBe(true)
        // The tracked profile's non-model content is preserved, not replaced.
        expect(seededProfile.profiles.gabo).toBeDefined()
        // The Judge ships with no manifest model, so it is never seeded.
        expect(seededProfile.agents?.judge).toBeUndefined()
      })

      test("#then a later install preserves the user's live model selection", () => {
        expect(secondInstall.status, `install failed: ${secondInstall.stderr || secondInstall.stdout}`).toBe(0)
        expect(typeof afterEdit).toBe("string")
        // The installer seeds the file once and never resets it. The OmO config
        // migration engine may append its own `_migrations` ledger while the
        // profile is read, but it must never clobber the operator's edit.
        expect(JSON.parse(afterEdit).agents.oracle.model).toBe("opencode-go/deepseek-v4-pro")
        // Product defaults (the head model AND its fallback chain) are seeded ONCE
        // on the clean install; a reinstall must not inject the manifest's other
        // agent models or fallback rungs into an existing file.
        expect(JSON.parse(afterEdit).agents.oracle.fallback_models).toBeUndefined()
        // Product defaults are seeded ONCE on the clean install; a reinstall
        // must not inject the manifest's other agent models into the existing
        // file. `explore` is absent from the operator's edit and stays absent.
        expect(JSON.parse(afterEdit).agents.explore).toBeUndefined()
      })
    })
  })
})
