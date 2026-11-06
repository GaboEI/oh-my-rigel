import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { resolveManifestOpenclaw } from "./build-target-agent-sandbox.mjs"

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(moduleDirectory, "../..")
const distIndex = path.join(repoRoot, "dist/index.js")
const selectionPath = path.join(moduleDirectory, "v2-agent-selection.json")
const judgePath = path.join(moduleDirectory, "opencode/agents/judge.v2.json")
const hasDist = fs.existsSync(distIndex)

function writeProfileConfig(root, config) {
  const configPath = path.join(root, ".omo", "omo.jsonc")
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(config))
}

describe("build-target-agent-manifest openclaw staging", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-target-manifest-openclaw-test-"))
  let buildTargetAgentManifest

  beforeAll(async () => {
    if (!hasDist) return
    ;({ buildTargetAgentManifest } = await import("./build-target-agent-manifest.mjs"))
  })

  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true })
  })

  test.skipIf(!hasDist)("treats a declaration outside the staged profile as manifest openclaw undeclared", async () => {
    // given
    const provisionedRoot = path.join(scratch, "outside-stage", "provisioned")
    const projectRoot = path.join(scratch, "outside-stage", "project")
    writeProfileConfig(provisionedRoot, {})
    writeProfileConfig(projectRoot, { openclaw: { enabled: false } })

    // when
    const built = await buildTargetAgentManifest({
      outputPath: path.join(scratch, "outside-stage", "manifest.mjs"),
      selectionPath,
      judgePath,
      profileRoot: provisionedRoot,
      directory: projectRoot,
      sandbox: path.join(scratch, "outside-stage", "sandbox"),
      keepSandbox: true,
    })

    // then
    expect(built.report.openclaw).toEqual({ state: "undeclared", reason: "outside-staged-layer" })
    expect(Object.hasOwn(built.manifest.metadata.global, "openclaw")).toBe(false)
  })

  test.skipIf(!hasDist)("reports manifest openclaw undeclared when only a non-gabo profile declares it", async () => {
    // given
    const provisionedRoot = path.join(scratch, "other-profile", "provisioned")
    writeProfileConfig(provisionedRoot, {
      profiles: {
        other: { "[opencode]": { openclaw: { enabled: false } } },
      },
    })

    // when
    const built = await buildTargetAgentManifest({
      outputPath: path.join(scratch, "other-profile", "manifest.mjs"),
      selectionPath,
      judgePath,
      profileRoot: provisionedRoot,
      sandbox: path.join(scratch, "other-profile", "sandbox"),
      keepSandbox: true,
    })

    // then
    expect(built.report.openclaw).toEqual({ state: "undeclared", reason: "non-gabo-profile" })
    expect(Object.hasOwn(built.manifest.metadata.global, "openclaw")).toBe(false)
  })
})

const openclawBlock = { channels: { a2a: { enabled: false } } }

/**
 * The live reader walks up from the directory under test until it reaches
 * `HOME`, so a fixture keeps its home OUTSIDE that directory: a home equal to
 * it is the chain's boundary and the project layer is never inspected.
 */
function fixtureEnv(root) {
  return { HOME: path.join(root, "home-elsewhere") }
}

function symlinkedStagedFixture(scratch, name) {
  const root = path.join(scratch, name)
  const realRoot = path.join(root, "real")
  const realHome = path.join(realRoot, "home")
  writeProfileConfig(realHome, { openclaw: openclawBlock })
  const linkRoot = path.join(root, "link")
  fs.symlinkSync(realRoot, linkRoot, "dir")
  return {
    root,
    realHome,
    sourcePath: path.join(realHome, ".omo", "omo.jsonc"),
    stagedConfigPath: path.join(linkRoot, "home", ".omo", "omo.jsonc"),
  }
}

describe("build-target-agent-manifest openclaw staged-layer containment", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-target-manifest-containment-test-"))

  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true })
  })

  test("#given the staged layer under a symlinked directory #when source.path is inside the real target #then the openclaw block is kept", () => {
    // given
    const fixture = symlinkedStagedFixture(scratch, "symlinked-stage")

    // when
    const resolved = resolveManifestOpenclaw({
      directory: fixture.realHome,
      env: fixtureEnv(fixture.root),
      pluginView: { openclaw: openclawBlock },
      stagedConfigPath: fixture.stagedConfigPath,
    })

    // then
    expect(resolved.report).toEqual({ state: "declared" })
    expect(resolved.config).toBe(openclawBlock)
  })

  test("#given source.path that does not exist #when resolveManifestOpenclaw runs #then it does not throw and applies the same containment rule", () => {
    // given
    const fixture = symlinkedStagedFixture(scratch, "vanished-source")
    // Readable when the chain loads it, gone by the time the comparison resolves
    // it: that race is what the fallback exists for.
    const fileSystem = {
      ...fs,
      realpathSync: (candidate) => {
        if (candidate === fixture.sourcePath) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${candidate}'`), { code: "ENOENT" })
        }
        return fs.realpathSync(candidate)
      },
    }

    // when
    const inside = resolveManifestOpenclaw({
      directory: fixture.realHome,
      env: fixtureEnv(fixture.root),
      pluginView: { openclaw: openclawBlock },
      stagedConfigPath: fixture.stagedConfigPath,
      fileSystem,
    })
    // The same rule in the negative direction, with a staged layer that is
    // genuinely absent instead of merely unreal: it too must not throw.
    const outside = resolveManifestOpenclaw({
      directory: fixture.realHome,
      env: fixtureEnv(fixture.root),
      pluginView: { openclaw: openclawBlock },
      stagedConfigPath: path.join(fixture.root, "absent", ".omo", "omo.jsonc"),
      fileSystem,
    })

    // then
    expect(inside.report).toEqual({ state: "declared" })
    expect(inside.config).toBe(openclawBlock)
    expect(outside.report).toEqual({ state: "undeclared", reason: "outside-staged-layer" })
  })
})
