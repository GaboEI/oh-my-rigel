import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

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
