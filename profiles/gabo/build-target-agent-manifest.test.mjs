/**
 * Contract for build-target-agent-manifest.mjs.
 *
 * The target generator aborts when any id in v2-agent-selection.json's
 * orchestratedAgentIds is absent from the plugin output. On a clean install the
 * plugin drops "Atlas - Plan Executor" (its conditional factory returns
 * undefined when model resolution yields nothing, while every other agent still
 * falls back to its chain head). This contract proves the builder materializes
 * ALL orchestrated agents, that the repaired Atlas record resolves through the
 * target's own atlas fallback chain head, that the Judge layer is preserved from
 * the target judge.v2.json through the generator's independentJudge path, and
 * that no agent source is touched.
 *
 * The builder imports dist/index.js, so the suite is skipped when the plugin
 * bundle has not been built (mirrors the dist-bundle contract tests).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(moduleDirectory, "../..")
const distIndex = path.join(repoRoot, "dist/index.js")
const agentsDirectory = path.join(repoRoot, "packages/omo-opencode/src/agents")
const selectionPath = path.join(moduleDirectory, "v2-agent-selection.json")
const judgePath = path.join(moduleDirectory, "opencode/agents/judge.v2.json")
const hasDist = fs.existsSync(distIndex)

const ATLAS_ID = "Atlas - Plan Executor"
const JUDGE_ID = "judge"

// The exact expected roster: the 11 orchestratedAgentIds in canonical order,
// plus the demoted plan/build and the independent Judge. This is the target
// manifest's 14-key surface, pinned to the read-only oracle.
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

// A content digest of every file under packages/omo-opencode/src/agents/ so the
// contract can prove the builder never mutates an agent definition.
function digestAgentsDirectory(root) {
  const records = []
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(absolute)
      } else if (entry.isFile()) {
        const digest = createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")
        records.push(`${path.relative(root, absolute)}:${digest}`)
      }
    }
  }
  walk(root)
  return records.join("\n")
}

describe("build-target-agent-manifest", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-target-manifest-test-"))
  let manifest
  let manifestWithoutOverride
  let report
  let expectedAtlasModel
  let beforeAgentsDigest
  let afterAgentsDigest
  let selection
  let judgeDefinition

  beforeAll(async () => {
    if (!hasDist) return
    selection = JSON.parse(fs.readFileSync(selectionPath, "utf8"))
    judgeDefinition = JSON.parse(fs.readFileSync(judgePath, "utf8"))
    const [{ buildTargetAgentManifest }, modelRequirements, modelResolution] = await Promise.all([
      import("./build-target-agent-manifest.mjs"),
      import("../../packages/omo-opencode/src/shared/model-requirements.ts"),
      import("../../packages/omo-opencode/src/agents/builtin-agents/model-resolution.ts"),
    ])
    expectedAtlasModel = modelResolution.getFirstFallbackModel(modelRequirements.AGENT_MODEL_REQUIREMENTS.atlas)?.model
    beforeAgentsDigest = digestAgentsDirectory(agentsDirectory)
    const built = await buildTargetAgentManifest({
      outputPath: path.join(scratch, "target-agent-manifest.mjs"),
      selectionPath,
      judgePath,
      sandbox: path.join(scratch, "isolation"),
      keepSandbox: true,
    })
    manifest = built.manifest
    report = built.report
    // The Sisyphus-Junior `all` promotion is the `nativeAgentModeOverrides`
    // entry in the real selection. Build a second manifest from a selection copy
    // WITHOUT that override so the contract below can prove the override changes
    // ONLY Sisyphus-Junior's mode (never the roster, the permissions, or another
    // agent's record).
    const withoutOverrideSelection = { ...selection }
    delete withoutOverrideSelection.nativeAgentModeOverrides
    const withoutOverrideSelectionPath = path.join(scratch, "v2-agent-selection-without-mode-override.json")
    fs.writeFileSync(withoutOverrideSelectionPath, JSON.stringify(withoutOverrideSelection, null, 2))
    const builtWithoutOverride = await buildTargetAgentManifest({
      outputPath: path.join(scratch, "target-agent-manifest-without-mode-override.mjs"),
      selectionPath: withoutOverrideSelectionPath,
      judgePath,
      sandbox: path.join(scratch, "isolation-without-mode-override"),
      keepSandbox: true,
    })
    manifestWithoutOverride = builtWithoutOverride.manifest
    afterAgentsDigest = digestAgentsDirectory(agentsDirectory)
  }, 180_000)

  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true })
  })

  describe("#given the target v2-agent-selection and a clean install", () => {
    describe("#when the builder materializes the target agent manifest", () => {
      test.skipIf(!hasDist)("#then the exact 14-key roster is emitted, including Atlas - Plan Executor", () => {
        for (const id of selection.orchestratedAgentIds) {
          expect(manifest.agents[id], `missing orchestrated agent: ${id}`).toBeDefined()
        }
        expect(manifest.agents[ATLAS_ID]).toBeDefined()
        expect(manifest.agents[ATLAS_ID].mode).toBe("primary")
        // The exact emitted surface: 11 orchestrated + demoted plan/build + Judge.
        expect(Object.keys(manifest.agents)).toEqual(EXPECTED_AGENT_KEYS)
        // The clean install really did drop Atlas from the raw plugin output, so
        // the presence above is the builder's repair and nothing else.
        expect(report.repairedIds).toContain(ATLAS_ID)
      })

      test.skipIf(!hasDist)("#then Sisyphus-Junior is promoted to mode all, and only its mode changes", () => {
        expect(manifest.agents["Sisyphus-Junior"].mode).toBe("all")
        // The override is what promotes it: without the override in the
        // selection the same build leaves the agent on the subagent default.
        expect(manifestWithoutOverride.agents["Sisyphus-Junior"].mode).toBe("subagent")
        // The roster is identical, and the only differing record field across the
        // two manifests is Sisyphus-Junior's mode: the override never adds or
        // drops an agent, never edits a permission rule, and never touches another
        // agent's record.
        expect(Object.keys(manifest.agents)).toEqual(EXPECTED_AGENT_KEYS)
        expect(Object.keys(manifestWithoutOverride.agents)).toEqual(EXPECTED_AGENT_KEYS)
        const changedRecords = []
        for (const id of EXPECTED_AGENT_KEYS) {
          const withOverride = manifest.agents[id]
          const without = manifestWithoutOverride.agents[id]
          const fields = new Set([...Object.keys(withOverride), ...Object.keys(without)])
          const differing = [...fields].filter((field) => JSON.stringify(withOverride[field]) !== JSON.stringify(without[field]))
          if (differing.length > 0) changedRecords.push({ id, differing })
        }
        expect(changedRecords).toEqual([{ id: "Sisyphus-Junior", differing: ["mode"] }])
      })

      test.skipIf(!hasDist)("#then the coordinators keep their upstream primary mode", () => {
        expect(manifest.agents["Prometheus - Plan Builder"].mode).toBe("primary")
        expect(manifest.agents[ATLAS_ID].mode).toBe("primary")
        expect(manifestWithoutOverride.agents["Prometheus - Plan Builder"].mode).toBe("primary")
        expect(manifestWithoutOverride.agents[ATLAS_ID].mode).toBe("primary")
      })

      test.skipIf(!hasDist)("#then the Judge is emitted from the target judge.v2.json definition", () => {
        expect(manifest.agents[JUDGE_ID]).toBeDefined()
        expect(manifest.agents[JUDGE_ID]).toEqual(judgeDefinition)
        // The Judge is emitted verbatim from judge.v2.json, which defines no model.
        expect(manifest.agents[JUDGE_ID].model).toBeUndefined()
      })

      test.skipIf(!hasDist)("#then the rebuilt Atlas model equals the target atlas fallback chain head", () => {
        expect(expectedAtlasModel).toBeDefined()
        expect(manifest.agents[ATLAS_ID].model).toBe(expectedAtlasModel)
      })

      test.skipIf(!hasDist)("#then no file under packages/omo-opencode/src/agents/ is modified", () => {
        expect(afterAgentsDigest).toBe(beforeAgentsDigest)
      })

      test.skipIf(!hasDist)("#then the manifest keeps the target generator module shape", () => {
        expect(Object.keys(manifest).sort()).toEqual(["agents", "defaultAgent", "metadata", "modes"])
        expect(manifest.defaultAgent).toBe("Sisyphus - ultraworker")
        expect(manifest.modes).toEqual({ defaultUltrawork: false })
        expect(manifest.metadata.global.gates).toBeDefined()
        expect(manifest.metadata.global.categories).toBeDefined()
      })
    })
  })
})
