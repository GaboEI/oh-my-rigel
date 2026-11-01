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

function runCommand(command, args, env) {
  return spawnSync("node", [installerPath, command, ...args, "--json"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 240_000,
  })
}

// Forward the parent's temp root: the spawned installer and the sandboxed
// manifest builder it launches must not depend on an OS temp directory that can
// be quota-limited, and forwarding it keeps every produced path inside the same
// isolated temp tree the assertions check.
function withTemporaryRoot(env) {
  return process.env.TMPDIR === undefined ? env : { ...env, TMPDIR: process.env.TMPDIR }
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
      RIGEL_V2_SG_PROVISION: "0",
    }
    install = runInstall(["--home", home, "--config", configFile, "--state", stateRoot], withTemporaryRoot(env))
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

      test("#then every pre-existing install check stays green with the goal engine registered", () => {
        const emitted = JSON.parse(install.stdout)
        const checks = Object.fromEntries(emitted.status.checks.map((check) => [check.name, check.pass]))
        // The goal engine is its own family slot, so the runtime-family checks are
        // unchanged and still green.
        for (const name of [
          "runtime.materialized",
          "agentManifest.present",
          "config.singleRigelEntry",
          "cli.singleRigelEntry",
          "runtime.digestMatches",
        ]) {
          expect(checks[name], `${name} regressed with the goal engine registered`).toBe(true)
        }
        expect(emitted.status.pass).toBe(true)
      })

      test("#then the dark vendor is materialized in the versioned tree and its digest is recorded beside the runtime digest", () => {
        const state = JSON.parse(fs.readFileSync(path.join(stateRoot, "install-state.json"), "utf8"))
        const runtimeDir = path.join(stateRoot, "versions", "1", "runtime")
        const vendored = path.join(runtimeDir, "vendor", "opencode-goal-plugin")
        expect(fs.existsSync(path.join(vendored, "pin.json"))).toBe(true)
        expect(fs.existsSync(path.join(vendored, "node_modules", "@prevalentware", "opencode-goal-plugin", "dist", "server.js"))).toBe(true)
        expect(state.versionDigests["1"]).toMatch(/^[0-9a-f]{64}$/)
        expect(state.versionDigests["opencode-goal-plugin:1"]).toMatch(/^[0-9a-f]{64}$/)
        expect(state.versionDigests["opencode-goal-plugin:1"]).not.toBe(state.versionDigests["1"])
      })

      test("#then the goal engine is the sole owner: exactly one entry in each config, carrying the Rigel defaults", () => {
        const config = JSON.parse(fs.readFileSync(configFile, "utf8"))
        const goalServer = config.plugins.filter((entry) => Array.isArray(entry) && String(entry[0]).includes("rigel-goal-engine"))
        expect(goalServer).toHaveLength(1)
        expect(goalServer[0][1]).toEqual({
          auto_continue: true,
          defer_while_tasks_active: true,
          max_auto_turns: 1000,
          min_continue_interval_seconds: 3,
          max_prompt_failures: 3,
          no_progress_token_threshold: 50,
          max_no_progress_turns: 2,
          restricted_agents: [],
          allow_goal_execution_from_plan: false,
        })
        // The foreign plugin the clean config declared is preserved.
        expect(config.plugin).toBeUndefined()
        expect(config.plugins).toContain("rigel-foreign-plugin")
        expect(config.plugins.filter((entry) => entry === "-opencode.goal")).toHaveLength(1)
        const cli = JSON.parse(fs.readFileSync(path.join(path.dirname(configFile), "cli.json"), "utf8"))
        const goalCli = cli.plugins.filter((entry) => entry && typeof entry === "object" && String(entry.package).includes("rigel-goal-tui"))
        expect(goalCli).toHaveLength(1)
      })

      test("#then the goal checks are green and the state path is bound inside the state tree", () => {
        const emitted = JSON.parse(install.stdout)
        const checks = Object.fromEntries(emitted.status.checks.map((check) => [check.name, check.pass]))
        expect(checks["goal.singleServerEntry"]).toBe(true)
        expect(checks["goal.serverBuiltinDisabled"]).toBe(true)
        expect(checks["goal.singleCliEntry"]).toBe(true)
        expect(checks["goal.cliBuiltinDisabled"]).toBe(true)
        expect(checks["goal.statePathMatchesRoot"]).toBe(true)
        expect(emitted.status.pass).toBe(true)
        const state = JSON.parse(fs.readFileSync(path.join(stateRoot, "install-state.json"), "utf8"))
        expect(state.goalStatePath.startsWith(stateRoot)).toBe(true)
        expect(state.goalStatePath.endsWith(path.join("goal-state", "goals.json"))).toBe(true)
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
      RIGEL_V2_SG_PROVISION: "0",
    }
    // Standard install: NO flags at all (not even --config). home defaults to
    // this temp HOME, configFile defaults to <XDG_CONFIG_HOME>/opencode/
    // opencode.json, and stateRoot defaults UNDER HOME
    // (<home>/.local/share/oh-my-rigel). Before the builder staged the
    // provisioned profile into its own sandbox, this shape hit
    // isolated-v2-env.mjs:72 ("refusing isolation inside the real home") and the
    // bare generator aborted on the missing Atlas agent.
    install = runInstall([], withTemporaryRoot(env))
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

describe("rigel-v2-user-install goal lifecycle: absorb, idempotent reinstall, uninstall", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-user-install-goal-"))
  const home = path.join(base, "home")
  const configFile = path.join(base, "config", "opencode", "opencode.json")
  const stateRoot = path.join(base, "state")
  let env
  const readConfig = () => JSON.parse(fs.readFileSync(configFile, "utf8"))
  const goalEntries = (config) => config.plugins.filter((entry) => Array.isArray(entry) && String(entry[0]).includes("rigel-goal-engine"))

  beforeAll(() => {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 })
    // A pre-existing external goal install (the retired package) plus a foreign plugin.
    fs.writeFileSync(configFile, `${JSON.stringify({ plugin: ["rigel-foreign-plugin", ["@prevalentware/opencode-goal-plugin@latest", {}]] }, null, 2)}\n`, { mode: 0o600 })
    env = withTemporaryRoot({
      PATH: process.env.PATH,
      HOME: path.join(base, "installer-home"),
      XDG_CONFIG_HOME: path.join(base, "xdg", "config"),
      XDG_DATA_HOME: path.join(base, "xdg", "data"),
      XDG_STATE_HOME: path.join(base, "xdg", "state"),
      XDG_CACHE_HOME: path.join(base, "xdg", "cache"),
      OMO_DISABLE_PROCESS_CLEANUP: "1",
      RIGEL_V2_SG_PROVISION: "0",
    })
  }, 300_000)

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  describe("#given a pre-existing external goal install", () => {
    test("#when installed #then the external entry is absorbed into exactly one vendored engine", () => {
      const install = runCommand("install", ["--version", "1", "--home", home, "--config", configFile, "--state", stateRoot], env)
      expect(install.status, `install failed: ${install.stderr || install.stdout}`).toBe(0)
      const config = readConfig()
      expect(goalEntries(config)).toHaveLength(1)
      // The retired external specifier is gone; the foreign plugin is preserved.
      expect(config.plugins.some((entry) => Array.isArray(entry) && String(entry[0]).includes("@prevalentware/opencode-goal-plugin@"))).toBe(false)
      expect(config.plugins).toContain("rigel-foreign-plugin")
      expect(config.plugins.filter((entry) => entry === "-opencode.goal")).toHaveLength(1)
    }, 300_000)

    test("#when reinstalled #then the goal entry is replaced in place, never duplicated", () => {
      const install = runCommand("install", ["--version", "1", "--home", home, "--config", configFile, "--state", stateRoot], env)
      expect(install.status, `reinstall failed: ${install.stderr || install.stdout}`).toBe(0)
      expect(goalEntries(readConfig())).toHaveLength(1)
    }, 300_000)

    test("#when uninstalled #then the goal entries are removed from both configs and foreign plugins stay", () => {
      const uninstall = runCommand("uninstall", ["--home", home, "--config", configFile, "--state", stateRoot], env)
      expect(uninstall.status, `uninstall failed: ${uninstall.stderr || uninstall.stdout}`).toBe(0)
      const config = readConfig()
      expect(goalEntries(config)).toHaveLength(0)
      expect(config.plugins).toContain("rigel-foreign-plugin")
      expect(config.plugins).not.toContain("-opencode.goal")
      const cli = JSON.parse(fs.readFileSync(path.join(path.dirname(configFile), "cli.json"), "utf8"))
      expect(cli.plugins.filter((entry) => entry && typeof entry === "object" && String(entry.package).includes("rigel-goal-tui"))).toHaveLength(0)
    }, 300_000)
  })
})

describe("rigel-v2-user-install goal upgrade + rollback", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-user-install-upgrade-"))
  const home = path.join(base, "home")
  const configFile = path.join(base, "config", "opencode", "opencode.json")
  const stateRoot = path.join(base, "state")
  let env
  const readConfig = () => JSON.parse(fs.readFileSync(configFile, "utf8"))
  const goalEntries = (config) => config.plugins.filter((entry) => Array.isArray(entry) && String(entry[0]).includes("rigel-goal-engine"))

  beforeAll(() => {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(configFile, `${JSON.stringify({ plugin: ["rigel-foreign-plugin"] }, null, 2)}\n`, { mode: 0o600 })
    env = withTemporaryRoot({
      PATH: process.env.PATH,
      HOME: path.join(base, "installer-home"),
      XDG_CONFIG_HOME: path.join(base, "xdg", "config"),
      XDG_DATA_HOME: path.join(base, "xdg", "data"),
      XDG_STATE_HOME: path.join(base, "xdg", "state"),
      XDG_CACHE_HOME: path.join(base, "xdg", "cache"),
      OMO_DISABLE_PROCESS_CLEANUP: "1",
      RIGEL_V2_SG_PROVISION: "0",
    })
  }, 300_000)

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  describe("#given an installed goal engine", () => {
    test("#when upgraded #then exactly one goal entry survives, repointed at the new version", () => {
      expect(runCommand("install", ["--version", "1", "--home", home, "--config", configFile, "--state", stateRoot], env).status).toBe(0)
      const upgrade = runCommand("upgrade", ["--version", "2", "--home", home, "--config", configFile, "--state", stateRoot], env)
      expect(upgrade.status, `upgrade failed: ${upgrade.stderr || upgrade.stdout}`).toBe(0)
      const entries = goalEntries(readConfig())
      expect(entries).toHaveLength(1)
      expect(entries[0][0]).toContain("/versions/2/")
    }, 300_000)

    test("#when rolled back #then exactly one goal entry survives, repointed at the previous version and status is green", () => {
      const rollback = runCommand("rollback", ["--home", home, "--config", configFile, "--state", stateRoot], env)
      expect(rollback.status, `rollback failed: ${rollback.stderr || rollback.stdout}`).toBe(0)
      const entries = goalEntries(readConfig())
      expect(entries).toHaveLength(1)
      expect(entries[0][0]).toContain("/versions/1/")
      const emitted = JSON.parse(rollback.stdout)
      expect(emitted.status.pass).toBe(true)
    }, 300_000)
  })
})
