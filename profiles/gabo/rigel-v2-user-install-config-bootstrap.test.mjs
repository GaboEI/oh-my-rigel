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
