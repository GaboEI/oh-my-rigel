/**
 * End-to-end contract for the install generation link.
 *
 * rigel-v2-user-install.mjs must produce a COMPLETE runtime agent manifest from
 * the normal install path: it spawns bun + build-target-agent-manifest.mjs with
 * the provisioned profile home, and materializeNativeRuntime copies the result
 * to <versionDir>/runtime/rigel-v2-native-agent-manifest.mjs.
 *
 * Two isolated shapes are driven, both with every state root inside a temp tree
 * (no real HOME/XDG, no network):
 *   1. explicit --state/--home/--config;
 *   2. NO --state, so stateRoot defaults UNDER the temp HOME
 *      (<home>/.local/share/oh-my-rigel). Before the builder staged the
 *      provisioned profile into its own sandbox, this second shape hit
 *      isolated-v2-env.mjs:72 ("refusing isolation inside the real home").
 *
 * Each asserts the PRODUCED runtime manifest carries the target's exact
 * 14-agent surface: the 11 orchestrated agents plus the demoted plan/build and
 * the independent Judge, with the repaired "Atlas - Plan Executor" present.
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

// The exact target manifest surface pinned to the read-only oracle.
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

// The normal operator route launches the installer with node; the generation
// point then spawns bun. Drive that same shape.
function runInstall(args, env) {
  return spawnSync("node", [installerPath, "install", "--version", "1", ...args, "--json"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 240_000,
  })
}

async function loadManifest(runtimeManifest) {
  return (await import(`${pathToFileURL(runtimeManifest).href}?t=${Date.now()}`)).default
}

function writeCleanConfig(configFile) {
  fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 })
  // A clean OpenCode config with NO model, so the plugin drops Atlas and the
  // builder's repair is what puts it back. A foreign plugin entry proves the
  // config merge is preserved.
  fs.writeFileSync(
    configFile,
    `${JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: ["rigel-foreign-plugin"] }, null, 2)}\n`,
    { mode: 0o600 },
  )
}

function expectCompleteManifest(manifest) {
  expect(Object.keys(manifest.agents)).toEqual(EXPECTED_AGENT_KEYS)
  expect(Object.prototype.hasOwnProperty.call(manifest.agents, "judge")).toBe(true)
  // The Judge ships with no default model (external BETA layer contract).
  expect(manifest.agents.judge.model).toBeUndefined()
  expect(manifest.agents["Atlas - Plan Executor"]).toBeDefined()
  expect(manifest.metadata.profile).toBe("gabo")
}

describe("rigel-v2-user-install runtime manifest with explicit --state", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-user-install-explicit-"))
  const home = path.join(base, "home")
  const configFile = path.join(base, "config", "opencode", "opencode.json")
  const stateRoot = path.join(base, "state")
  const runtimeManifest = path.join(stateRoot, "versions", "1", "runtime", "rigel-v2-native-agent-manifest.mjs")
  let install
  let manifest

  beforeAll(async () => {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
    writeCleanConfig(configFile)
    const env = {
      PATH: process.env.PATH,
      HOME: path.join(base, "installer-home"),
      XDG_CONFIG_HOME: path.join(base, "installer-xdg", "config"),
      XDG_DATA_HOME: path.join(base, "installer-xdg", "data"),
      XDG_STATE_HOME: path.join(base, "installer-xdg", "state"),
      XDG_CACHE_HOME: path.join(base, "installer-xdg", "cache"),
      OMO_DISABLE_PROCESS_CLEANUP: "1",
    }
    install = runInstall(["--home", home, "--config", configFile, "--state", stateRoot], env)
    if (install.status === 0) manifest = await loadManifest(runtimeManifest)
  }, 300_000)

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  describe("#given an isolated install with an explicit state root", () => {
    describe("#when the install command materializes the runtime", () => {
      test("#then the install succeeds and writes the runtime agent manifest", () => {
        expect(install.status, `install failed: ${install.stderr || install.stdout}`).toBe(0)
        expect(fs.existsSync(runtimeManifest)).toBe(true)
      })

      test("#then the produced runtime manifest carries the exact 14-agent surface including Judge and Atlas", () => {
        expectCompleteManifest(manifest)
      })

      test("#then the profile-derived metadata is present", () => {
        expect(manifest.metadata.global.disabled.agents).toContain("forja")
        expect(manifest.metadata.global.gates.hashline_edit).toBe(true)
      })

      test("#then every produced path stays inside the isolated temp tree", () => {
        expect(runtimeManifest.startsWith(base)).toBe(true)
        expect(manifest.metadata.global.repoRoot).toBe(repoRoot)
      })

      test("#then the installed runtime is self-sufficient: it owns the LSP dist and resolves it with a nonexistent repoRoot", async () => {
        // Residency audit: the deployment must carry the built LSP runtime (so a
        // valid install no longer depends on the transient source surviving) and
        // the deployed resolver must pick it up even when the manifest's repoRoot
        // points at a directory that no longer exists.
        const runtimeDir = path.join(stateRoot, "versions", "1", "runtime")
        const deploymentDist = path.join(runtimeDir, "packages", "lsp-daemon", "dist", "cli.js")
        expect(fs.existsSync(deploymentDist), "install did not stage the LSP daemon dist").toBe(true)

        const deployed = await import(
          `${pathToFileURL(path.join(runtimeDir, "rigel-v2-native-builtin-mcps.mjs")).href}?t=${Date.now()}`
        )
        const resolved = deployed.createLspMcpConfig({
          repoRoot: path.join(base, "deleted-source-root"),
          cwd: "/work",
          configDir: "/cfg",
        })
        expect(resolved.disabled).toBe(false)
        expect(resolved.command).toContain(deploymentDist)
      })
    })
  })
})

describe("rigel-v2-user-install runtime manifest with default state root under HOME", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-user-install-default-"))
  const home = path.join(base, "home")
  const configFile = path.join(base, "config", "opencode", "opencode.json")
  // resolvePaths derives stateRoot from XDG_DATA_HOME or <home>/.local/share.
  const stateRoot = path.join(home, ".local", "share", "oh-my-rigel")
  const runtimeManifest = path.join(stateRoot, "versions", "1", "runtime", "rigel-v2-native-agent-manifest.mjs")
  let install
  let manifest

  beforeAll(async () => {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    writeCleanConfig(configFile)
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: path.join(base, "config"),
      XDG_STATE_HOME: path.join(home, ".local", "state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      // XDG_DATA_HOME deliberately unset so stateRoot lands under HOME.
      OMO_DISABLE_PROCESS_CLEANUP: "1",
    }
    // Standard install: NO flags at all (not even --config). home defaults to
    // this temp HOME, configFile defaults to <XDG_CONFIG_HOME>/opencode/
    // opencode.json, and stateRoot defaults UNDER HOME
    // (<home>/.local/share/oh-my-rigel). Before the builder staged the
    // provisioned profile into its own sandbox, this shape hit
    // isolated-v2-env.mjs:72 ("refusing isolation inside the real home") and the
    // bare generator aborted on the missing Atlas agent.
    install = runInstall([], env)
    if (install.status === 0) manifest = await loadManifest(runtimeManifest)
  }, 300_000)

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  describe("#given an isolated install whose state root defaults under the temp HOME", () => {
    describe("#when the install command materializes the runtime", () => {
      test("#then the install succeeds with the state root under HOME", () => {
        expect(install.status, `install failed: ${install.stderr || install.stdout}`).toBe(0)
        expect(runtimeManifest.startsWith(home)).toBe(true)
        expect(fs.existsSync(runtimeManifest)).toBe(true)
      })

      test("#then the produced runtime manifest carries the exact 14-agent surface including Judge and Atlas", () => {
        expectCompleteManifest(manifest)
      })
    })
  })
})
