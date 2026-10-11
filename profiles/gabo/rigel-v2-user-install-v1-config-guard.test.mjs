/**
 * Contract for the installer's config-root acceptance on the PUBLISHED
 * env-variable route (`RIGEL_V2_HOME` / `RIGEL_V2_CONFIG` / `RIGEL_V2_USER_ROOT`,
 * then the normal installer).
 *
 * Boundary: the documented V1/V2 incompatibility (see .omo/rules/protect-opencode-v1.md).
 * An EXPLICITLY provided config (`--config` / `RIGEL_V2_CONFIG`) is the operator's
 * confirmation that this is the active V2 config, so it is accepted even under the
 * generic OpenCode config root that V2 shares. No V1 heuristic is applied on this
 * path. A DEFAULTED config path is never accepted, and home/state/XDG roots keep
 * the unconditional refusal.
 *
 * Positive: explicit config under the generic root -> install succeeds.
 * Negative: defaulted config under the generic root -> still refused.
 * Negative: an explicit state root under a V1 root -> still refused (protection retained).
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

function writeCleanConfig(configFile) {
  fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 })
  fs.writeFileSync(
    configFile,
    `${JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: ["rigel-foreign-plugin"] }, null, 2)}\n`,
    { mode: 0o600 },
  )
}

// Drives the installer exactly as the published route does: node + the three
// RIGEL_V2_* variables, nothing else.
function runRoute(env) {
  return spawnSync("node", [installerPath, "install", "--version", "1", "--json"], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH, OMO_DISABLE_PROCESS_CLEANUP: "1", ...env },
    encoding: "utf8",
    timeout: 240_000,
  })
}

function routeEnv(home, configFile, stateRoot) {
  return {
    HOME: home,
    RIGEL_V2_HOME: home,
    ...(configFile ? { RIGEL_V2_CONFIG: configFile } : {}),
    RIGEL_V2_USER_ROOT: stateRoot,
  }
}

function runtimeManifestAt(stateRoot) {
  return path.join(stateRoot, "versions", "1", "runtime", "rigel-v2-native-agent-manifest.mjs")
}

async function loadManifest(file) {
  return (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)).default
}

describe("installer config root: an explicit V2 config is accepted under the shared root", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-explicit-config-"))
  const home = path.join(base, "home")
  const configFile = path.join(home, ".config", "opencode", "opencode.json")
  const stateRoot = path.join(home, ".local", "share", "oh-my-rigel")
  const runtimeManifest = runtimeManifestAt(stateRoot)
  let install
  let manifest

  beforeAll(async () => {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    writeCleanConfig(configFile)
    install = runRoute(routeEnv(home, configFile, stateRoot))
    if (install.status === 0) manifest = await loadManifest(runtimeManifest)
  }, 300_000)

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  describe("#given the active V2 config on the shared OpenCode path", () => {
    describe("#when the installer runs with the explicit RIGEL_V2_CONFIG route", () => {
      test("#then the explicit config is accepted and the install succeeds", () => {
        expect(install.status, `install failed: ${install.stderr || install.stdout}`).toBe(0)
        expect(fs.existsSync(runtimeManifest)).toBe(true)
      })

      test("#then it records the explicit-config acceptance instead of a silent pass", () => {
        expect(install.stderr).toContain("accepting the explicitly-provided V2 config")
      })

      test("#then the produced runtime manifest carries the exact 14-agent surface", () => {
        expect(Object.keys(manifest.agents)).toEqual(EXPECTED_AGENT_KEYS)
        expect(manifest.agents.judge.model).toBeUndefined()
      })
    })
  })
})

describe("installer config root: retained refusals", () => {
  describe("#given no RIGEL_V2_CONFIG and the generic config path is DEFAULTED", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-defaulted-config-"))
    const home = path.join(base, "home")
    const configFile = path.join(home, ".config", "opencode", "opencode.json")
    const stateRoot = path.join(home, ".local", "share", "oh-my-rigel")
    let install

    beforeAll(() => {
      fs.mkdirSync(home, { recursive: true, mode: 0o700 })
      writeCleanConfig(configFile)
      install = runRoute(routeEnv(home, undefined, stateRoot))
    })

    afterAll(() => {
      fs.rmSync(base, { recursive: true, force: true })
    })

    describe("#when the installer runs without an explicit RIGEL_V2_CONFIG", () => {
      test("#then the generic config root is still refused: acceptance is not a path allowlist", () => {
        expect(install.status).not.toBe(0)
        expect(`${install.stderr}${install.stdout}`).toContain("configFile resolves under a V1 root")
        expect(fs.existsSync(runtimeManifestAt(stateRoot))).toBe(false)
      })
    })
  })

  describe("#given an explicit V2 config but a state root placed under a V1 root", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-state-under-v1-"))
    const home = path.join(base, "home")
    const configFile = path.join(home, ".config", "opencode", "opencode.json")
    // <home>/.local/share/opencode is a V1 data root; the state root must be refused.
    const stateRoot = path.join(home, ".local", "share", "opencode", "rigel")
    let install

    beforeAll(() => {
      fs.mkdirSync(home, { recursive: true, mode: 0o700 })
      writeCleanConfig(configFile)
      install = runRoute(routeEnv(home, configFile, stateRoot))
    })

    afterAll(() => {
      fs.rmSync(base, { recursive: true, force: true })
    })

    describe("#when the installer runs with the explicit RIGEL_V2_* route", () => {
      test("#then the state root is refused: home/state/XDG protection is retained", () => {
        expect(install.status).not.toBe(0)
        expect(`${install.stderr}${install.stdout}`).toContain("stateRoot resolves under a V1 root")
        expect(fs.existsSync(runtimeManifestAt(stateRoot))).toBe(false)
      })
    })
  })
})
