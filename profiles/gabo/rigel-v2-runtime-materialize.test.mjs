import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { materializeNativeRuntime, stageGoalVendor, stageLspRuntime } from "./rigel-v2-runtime-materialize.mjs"
import { digestOfDirectory } from "./goal-vendor-tarball.mjs"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
// The goal vendor materializes ~40 MB of extracted closure, which the OS temp
// directory cannot hold under the per-user quota this repository is developed
// with; the large-vendor cases use the gitignored `.omo/` root instead.
const largeRoot = fs.mkdtempSync(path.join(repoRoot, ".omo", "tmp-materialize-vendor-"))

const temporaryRoots = [largeRoot]
function temporaryRoot(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporaryRoots.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryRoots.splice(1)) fs.rmSync(directory, { recursive: true, force: true })
})

afterAll(() => {
  fs.rmSync(largeRoot, { recursive: true, force: true })
})

function writePackage(root, name, { built = false } = {}) {
  const directory = path.join(root, "packages", name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, version: "0.1.0" }))
  if (built) {
    fs.mkdirSync(path.join(directory, "dist"), { recursive: true })
    fs.writeFileSync(path.join(directory, "dist", "cli.js"), "#!/usr/bin/env node\n")
  }
}

describe("stageLspRuntime", () => {
  test("#given a built source #when staging #then the LSP package.json and dist land in the deployment", () => {
    // given
    const sourceRoot = temporaryRoot("rigel-lsp-stage-src-")
    const runtimeDir = temporaryRoot("rigel-lsp-stage-runtime-")
    writePackage(sourceRoot, "lsp-daemon", { built: true })
    writePackage(sourceRoot, "lsp-tools-mcp", { built: true })

    // when
    const staged = stageLspRuntime({ sourceRoot, runtimeDir })

    // then the deployment OWNS the LSP runtime, so a valid install no longer
    // depends on the transient source checkout surviving.
    expect(staged.sort()).toEqual([
      "packages/lsp-daemon/dist",
      "packages/lsp-daemon/package.json",
      "packages/lsp-tools-mcp/dist",
      "packages/lsp-tools-mcp/package.json",
    ])
    for (const relative of staged) expect(fs.existsSync(path.join(runtimeDir, relative))).toBe(true)
    expect(
      fs.readFileSync(path.join(runtimeDir, "packages/lsp-daemon/dist/cli.js"), "utf8"),
    ).toContain("node")
  })

  test("#given an unbuilt source #when staging #then nothing is staged and no error is thrown", () => {
    // given a source tree whose LSP packages were never built
    const sourceRoot = temporaryRoot("rigel-lsp-stage-unbuilt-src-")
    const runtimeDir = temporaryRoot("rigel-lsp-stage-unbuilt-runtime-")
    writePackage(sourceRoot, "lsp-daemon", { built: false })
    writePackage(sourceRoot, "lsp-tools-mcp", { built: false })

    // when
    const staged = stageLspRuntime({ sourceRoot, runtimeDir })

    // then the runtime has no self-contained dist, so it degrades to a disabled
    // server instead of depending on a transient source root.
    expect(staged).toEqual([])
    expect(fs.existsSync(path.join(runtimeDir, "packages"))).toBe(false)
  })

  test("#given a source without any LSP package #when staging #then nothing is staged and no error is thrown", () => {
    // given
    const sourceRoot = temporaryRoot("rigel-lsp-stage-none-src-")
    const runtimeDir = temporaryRoot("rigel-lsp-stage-none-runtime-")

    // when / then
    expect(stageLspRuntime({ sourceRoot, runtimeDir })).toEqual([])
  })
})

describe("stageGoalVendor", () => {
  test("#given the pinned vendor #when staging #then the engine lands in the deployment without any config registration", () => {
    // given a deployment directory that has no config at all
    const runtimeDir = path.join(largeRoot, "runtime-dark")
    fs.mkdirSync(runtimeDir, { recursive: true })

    // when
    const staged = stageGoalVendor({ sourceRoot: repoRoot, runtimeDir })

    // then the tree is present and digestible, and the dark stage wrote no config:
    // no opencode.json, no cli.json, no goal key.
    expect(fs.existsSync(staged.engineEntry)).toBe(true)
    expect(fs.existsSync(staged.tuiEntry)).toBe(true)
    expect(staged.treeDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(fs.existsSync(path.join(runtimeDir, "opencode.json"))).toBe(false)
    expect(fs.existsSync(path.join(runtimeDir, "cli.json"))).toBe(false)
  })

  test("#given a deployment target #when staging #then nothing is written outside the target directory", () => {
    // given an empty parent that holds only the deployment directory
    const parent = path.join(largeRoot, "isolation-parent")
    const runtimeDir = path.join(parent, "runtime")
    fs.mkdirSync(runtimeDir, { recursive: true })
    const sourceBefore = digestOfDirectory(path.join(repoRoot, "profiles/gabo/vendor/opencode-goal-plugin"))

    // when
    stageGoalVendor({ sourceRoot: repoRoot, runtimeDir })

    // then the stage created exactly one entry (the vendor) and left the vendored
    // source tree untouched: PR A cannot dirty a surface it does not own.
    expect(fs.readdirSync(parent).sort()).toEqual(["runtime"])
    expect(fs.readdirSync(runtimeDir).sort()).toEqual(["vendor"])
    expect(digestOfDirectory(path.join(repoRoot, "profiles/gabo/vendor/opencode-goal-plugin"))).toBe(sourceBefore)
  })

  test("#given a materialized runtime #when the config is produced #then exactly one runtime entry and exactly one goal entry are registered", () => {
    // given a real source root and an empty target config
    const runtimeDir = path.join(largeRoot, "runtime-config")
    const configDir = path.join(largeRoot, "config", "opencode")
    fs.mkdirSync(configDir, { recursive: true })
    const configFile = path.join(configDir, "opencode.json")
    fs.writeFileSync(configFile, `${JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [] }, null, 2)}\n`)
    const agentManifestPath = path.join(largeRoot, "agent-manifest.mjs")
    fs.writeFileSync(agentManifestPath, "export default {}\n")

    // when
    const result = materializeNativeRuntime({ sourceRoot: repoRoot, runtimeDir, agentManifestPath, configFile })

    // then the engine is registered exactly once: one runtime string entry and
    // one goal tuple carrying the Rigel-managed default options.
    for (const prompt of [
      "ultrawork-default.md",
      "ultrawork-gpt.md",
      "ultrawork-gemini.md",
      "ultrawork-glm.md",
      "ultrawork-planner.md",
      "team.md",
      "hyperplan.md",
    ]) {
      const stagedPrompt = fs.readFileSync(path.join(runtimeDir, "prompts", prompt), "utf8")
      expect(stagedPrompt, prompt).not.toMatch(/(?<!rigel_)\btask\(/)
      expect(stagedPrompt, prompt).not.toContain("call_omo_agent(")
    }
    expect(result.goalVendor.treeDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(fs.existsSync(result.goalVendor.engineEntry)).toBe(true)
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"))
    expect(config.plugin.filter((entry) => entry === runtimeDir)).toHaveLength(1)
    const goalEntries = config.plugin.filter((entry) => Array.isArray(entry))
    expect(goalEntries).toHaveLength(1)
    // The host loads a directory entrypoint, so the entry points at the Rigel-owned
    // shim whose `.` export re-exports the vendored server.
    const shimDir = path.join(runtimeDir, "rigel-goal-engine")
    expect(goalEntries[0][0]).toBe(shimDir)
    expect(fs.existsSync(path.join(shimDir, "server.js"))).toBe(true)
    expect(fs.readFileSync(path.join(shimDir, "server.js"), "utf8")).toContain(result.goalVendor.engineEntry)
    expect(result.goalOptions).toEqual({
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
    expect(goalEntries[0][1]).toEqual(result.goalOptions)
    expect("default_token_budget" in result.goalOptions).toBe(false)
    expect("max_goal_duration_seconds" in result.goalOptions).toBe(false)

    const cli = JSON.parse(fs.readFileSync(path.join(configDir, "cli.json"), "utf8"))
    const goalCli = cli.plugins.filter((entry) => entry && typeof entry === "object" && String(entry.package).includes("rigel-goal-tui"))
    expect(goalCli).toHaveLength(1)
  })

  test("#given a reinstall over an existing goal entry #when the config is produced #then the entry is replaced in place, never duplicated", () => {
    // given
    const runtimeDir = path.join(largeRoot, "runtime-reinstall")
    const configDir = path.join(largeRoot, "config-reinstall", "opencode")
    fs.mkdirSync(configDir, { recursive: true })
    const configFile = path.join(configDir, "opencode.json")
    fs.writeFileSync(configFile, `${JSON.stringify({ plugin: [] }, null, 2)}\n`)
    const agentManifestPath = path.join(largeRoot, "agent-manifest-reinstall.mjs")
    fs.writeFileSync(agentManifestPath, "export default {}\n")

    // when installed twice
    materializeNativeRuntime({ sourceRoot: repoRoot, runtimeDir, agentManifestPath, configFile })
    materializeNativeRuntime({ sourceRoot: repoRoot, runtimeDir, agentManifestPath, configFile })

    // then exactly one runtime entry and one goal entry survive (C3)
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"))
    expect(config.plugin.filter((entry) => entry === runtimeDir)).toHaveLength(1)
    expect(config.plugin.filter((entry) => Array.isArray(entry))).toHaveLength(1)
    const cli = JSON.parse(fs.readFileSync(path.join(configDir, "cli.json"), "utf8"))
    const goalCli = cli.plugins.filter((entry) => entry && typeof entry === "object" && String(entry.package).includes("rigel-goal-tui"))
    expect(goalCli).toHaveLength(1)
  })
})
