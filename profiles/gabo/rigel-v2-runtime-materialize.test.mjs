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

  test("#given a materialized runtime #when the config is produced #then exactly one plugin entry exists and no goal key is registered", () => {
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

    // then the vendor is present but nothing live was registered on its behalf:
    // the server config keeps exactly its two keys and a single family entry, and
    // neither config mentions the vendored engine or its upstream id.
    expect(result.goalVendor.treeDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(fs.existsSync(result.goalVendor.engineEntry)).toBe(true)
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"))
    expect(config.plugin).toEqual([runtimeDir])
    expect(Object.keys(config).sort()).toEqual(["$schema", "plugin"])
    expect(JSON.stringify(config)).not.toContain("opencode-goal-plugin")

    const cli = JSON.parse(fs.readFileSync(path.join(configDir, "cli.json"), "utf8"))
    expect(JSON.stringify(cli)).not.toContain("opencode-goal-plugin")
    expect(JSON.stringify(cli)).not.toContain("goal-mode")
  })
})
