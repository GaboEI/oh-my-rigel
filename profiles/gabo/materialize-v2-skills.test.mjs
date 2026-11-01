/**
 * Owner contract for `materialize-v2-skills.mjs` (U4): the cross-harness shared
 * pool and explicitly project-aligned skills are linked into `~/.agents/skills`
 * only when their respective `skillPolicy` entries authorize them. User-owned
 * entries win, the legacy bridge keeps precedence, and every managed link is
 * recorded so the uninstall round-trip can remove it.
 *
 * Drives the REAL materializer in an isolated HOME; no network.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(moduleDirectory, "../..")
const materializer = path.join(repoRoot, "profiles/gabo/materialize-v2-skills.mjs")
const manifestFile = path.join(repoRoot, "profiles/gabo/integration-manifest.json")
const sharedSkillsDir = path.join(repoRoot, "packages/shared-skills/skills")
const projectSkillsDir = path.join(repoRoot, ".agents/skills")

// The exact `skillPolicy`-authorized intersection with the shared pool.
const AUTHORIZED_SHARED = [
  "debugging", "frontend", "git-master", "remove-ai-slops", "visual-qa",
  "review-work", "init-deep", "ulw-plan", "ulw-research", "ulw-execute",
  "ast-grep", "coding-agent-sessions", "data-scientist", "lsp-setup", "programming", "refactor",
]
const NOT_DELIVERED = ["browser", "ultimate-browsing"]
const RIGEL_KIT_COUNT = 15
const PROJECT_ALIGNED = ["hyperplan", "security-research"]
const EXPECTED_LINKED_COUNT = RIGEL_KIT_COUNT + AUTHORIZED_SHARED.length + PROJECT_ALIGNED.length

const roots = []
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-materialize-"))
  roots.push(home)
  return home
}
afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop(), { recursive: true, force: true })
})

function sourceFixture(home) {
  const root = path.join(home, "source")
  const fixtureMaterializer = path.join(root, "profiles/gabo/materialize-v2-skills.mjs")
  const fixtureManifest = path.join(root, "profiles/gabo/integration-manifest.json")
  const fixtureRigelSkills = path.join(root, "profiles/gabo/skills")
  const fixtureSharedSkills = path.join(root, "packages/shared-skills/skills")
  const fixtureProjectSkills = path.join(root, ".agents/skills")
  if (!fs.existsSync(fixtureMaterializer)) {
    fs.mkdirSync(path.dirname(fixtureMaterializer), { recursive: true })
    fs.copyFileSync(materializer, fixtureMaterializer)
    fs.copyFileSync(manifestFile, fixtureManifest)
    fs.symlinkSync(path.join(repoRoot, "profiles/gabo/skills"), fixtureRigelSkills, "dir")
    fs.mkdirSync(path.dirname(fixtureSharedSkills), { recursive: true })
    fs.symlinkSync(sharedSkillsDir, fixtureSharedSkills, "dir")
    fs.mkdirSync(fixtureProjectSkills, { recursive: true })
    for (const name of PROJECT_ALIGNED) {
      fs.symlinkSync(path.join(projectSkillsDir, name), path.join(fixtureProjectSkills, name), "dir")
    }
  }
  return { materializer: fixtureMaterializer, manifest: fixtureManifest, projectSkills: fixtureProjectSkills }
}

function runMaterialize(home) {
  const fixture = sourceFixture(home)
  const result = spawnSync(process.execPath, [fixture.materializer], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 60_000 })
  if (result.status !== 0) throw new Error(`materialize-v2-skills failed: ${result.stderr || result.stdout}`)
  return JSON.parse(result.stdout)
}
function skillsRoot(home) { return path.join(home, ".agents", "skills") }
function readState(home) { return JSON.parse(fs.readFileSync(path.join(home, ".local", "share", "oh-my-rigel", "skills-v2.json"), "utf8")) }
function resolvedTarget(home, name) {
  try { return fs.realpathSync(path.join(skillsRoot(home), name)) } catch { return null }
}

describe("#given the shared-pool skill delivery", () => {
  test("#when materialized #then authorized shared and project-aligned skills link while disabled shared skills stay out", () => {
    const home = makeHome()
    const out = runMaterialize(home)
    const state = readState(home)

    const sharedManaged = state.managed.filter((entry) => entry.kind === "shared").map((entry) => entry.name).sort()
    expect(sharedManaged).toEqual([...AUTHORIZED_SHARED].sort())
    const projectAlignedManaged = state.managed.filter((entry) => entry.kind === "project-aligned").map((entry) => entry.name).sort()
    expect(projectAlignedManaged).toEqual([...PROJECT_ALIGNED].sort())
    expect(out.linked).toHaveLength(EXPECTED_LINKED_COUNT)

    for (const name of AUTHORIZED_SHARED) {
      expect(resolvedTarget(home, name)).toBe(fs.realpathSync(path.join(sharedSkillsDir, name)))
    }
    for (const name of PROJECT_ALIGNED) {
      expect(resolvedTarget(home, name)).toBe(fs.realpathSync(path.join(projectSkillsDir, name)))
    }
    for (const name of NOT_DELIVERED) {
      expect(fs.existsSync(path.join(skillsRoot(home), name))).toBe(false)
    }
  })

  test("#given a project skill name that is not in the allowlist #when the materializer runs #then that skill is absent from the discovery root and from the managed list", () => {
    const home = makeHome()
    const fixture = sourceFixture(home)
    const name = "not-allowlisted-project-skill"
    const source = path.join(fixture.projectSkills, name)
    fs.mkdirSync(source, { recursive: true })
    fs.writeFileSync(path.join(source, "SKILL.md"), "---\nname: not-allowlisted-project-skill\ndescription: fixture-only project skill\n---\n\nbody\n")

    const out = runMaterialize(home)
    const state = readState(home)

    expect(fs.existsSync(path.join(skillsRoot(home), name))).toBe(false)
    expect(state.managed.some((entry) => entry.name === name)).toBe(false)
    expect(out.linked).not.toContain(name)
  })

  test("#given the allowlist is absent or malformed #when the materializer runs #then no project skill is delivered and the other three families are unchanged", () => {
    const policyCases = [
      { name: "absent", mutate: (manifest) => { delete manifest.skillPolicy.projectAligned }, shared: AUTHORIZED_SHARED },
      { name: "non-array", mutate: (manifest) => { manifest.skillPolicy.projectAligned = "hyperplan" }, shared: AUTHORIZED_SHARED },
      { name: "invalid manifest", raw: "{", shared: [] },
    ]

    for (const policyCase of policyCases) {
      const home = makeHome()
      const fixture = sourceFixture(home)
      if (policyCase.raw) {
        fs.writeFileSync(fixture.manifest, policyCase.raw)
      } else {
        const manifest = JSON.parse(fs.readFileSync(fixture.manifest, "utf8"))
        policyCase.mutate(manifest)
        fs.writeFileSync(fixture.manifest, `${JSON.stringify(manifest, null, 2)}\n`)
      }
      const legacyName = `legacy-${policyCase.name.replaceAll(" ", "-")}`
      const legacy = path.join(home, ".config/opencode/skills", legacyName)
      fs.mkdirSync(legacy, { recursive: true })
      fs.writeFileSync(path.join(legacy, "SKILL.md"), `---\nname: ${legacyName}\ndescription: legacy fixture\n---\n\nbody\n`)

      const out = runMaterialize(home)
      const state = readState(home)
      const shared = state.managed.filter((entry) => entry.kind === "shared").map((entry) => entry.name).sort()
      const legacyManaged = state.managed.filter((entry) => entry.kind === "legacy-bridge").map((entry) => entry.name)

      expect(state.managed.filter((entry) => entry.kind === "project-aligned")).toEqual([])
      expect(state.managed.filter((entry) => entry.kind === "rigel")).toHaveLength(RIGEL_KIT_COUNT)
      expect(shared).toEqual([...policyCase.shared].sort())
      expect(legacyManaged).toEqual([legacyName])
      expect(out.linked).toHaveLength(RIGEL_KIT_COUNT + policyCase.shared.length + 1)
    }
  })

  test("#when the user owns a shared name #then the user entry wins and is recorded preserved", () => {
    const home = makeHome()
    const userDir = path.join(skillsRoot(home), "debugging")
    fs.mkdirSync(userDir, { recursive: true })
    fs.writeFileSync(path.join(userDir, "SKILL.md"), "---\nname: debugging\ndescription: user-owned\n---\n\nuser body\n")

    runMaterialize(home)
    const state = readState(home)
    expect(state.preserved).toContain("debugging")
    expect(state.managed.some((entry) => entry.name === "debugging")).toBe(false)
    expect(fs.readFileSync(path.join(userDir, "SKILL.md"), "utf8")).toContain("user body")
  })

  test("#when the legacy bridge and the shared pool coexist #then precedence is legacy ahead of the pool", () => {
    const home = makeHome()
    const legacyDir = path.join(home, ".config", "opencode", "skills", "legacy-thing")
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(path.join(legacyDir, "SKILL.md"), "---\nname: legacy-thing\ndescription: legacy\n---\n\nbody\n")

    runMaterialize(home)
    const state = readState(home)
    const legacy = state.managed.find((entry) => entry.name === "legacy-thing")
    expect(legacy?.kind).toBe("legacy-bridge")
    expect(resolvedTarget(home, "legacy-thing")).toBe(fs.realpathSync(legacyDir))
    expect(state.managed.some((entry) => entry.kind === "shared")).toBe(true)
  })

  test("#given a legacy skill whose source entry is a symlink to a directory with SKILL.md #when the materializer runs #then that skill is delivered to the discovery root as a managed entry", () => {
    const home = makeHome()
    const name = "legacy-symlinked-thing"
    const source = path.join(home, "external-legacy-source", name)
    const legacyRoot = path.join(home, ".config", "opencode", "skills")
    const danglingName = "dangling-legacy-symlink"
    fs.mkdirSync(source, { recursive: true })
    fs.writeFileSync(path.join(source, "SKILL.md"), "---\nname: legacy-symlinked-thing\ndescription: linked legacy skill\n---\n\nlegacy body\n")
    fs.mkdirSync(legacyRoot, { recursive: true })
    fs.symlinkSync(source, path.join(legacyRoot, name), "dir")
    fs.symlinkSync(path.join(home, "missing-legacy-source"), path.join(legacyRoot, danglingName), "dir")

    const out = runMaterialize(home)
    const state = readState(home)
    const managed = state.managed.find((entry) => entry.name === name)

    expect(out.linked).toContain(name)
    expect(managed?.kind).toBe("legacy-bridge")
    expect(fs.readFileSync(path.join(skillsRoot(home), name, "SKILL.md"), "utf8")).toContain("legacy body")
    expect(out.linked).not.toContain(danglingName)
    expect(state.managed.some((entry) => entry.name === danglingName)).toBe(false)
    expect(state.preserved).not.toContain(danglingName)
  })

  test("#when re-run #then the managed set is stable and every managed link resolves to its recorded source", () => {
    const home = makeHome()
    runMaterialize(home)
    const first = readState(home)
    runMaterialize(home)
    const second = readState(home)

    const shape = (state) => state.managed.map((entry) => `${entry.kind}:${entry.name}`).sort()
    expect(shape(second)).toEqual(shape(first))
    for (const entry of second.managed) {
      expect(resolvedTarget(home, entry.name)).toBe(fs.realpathSync(entry.source))
    }
  })

  test("#when a managed link's source root moved #then Rigel relinks it and never rewrites a user entry", () => {
    const home = makeHome()
    // A prior Rigel install recorded a managed link at a source root that no longer exists.
    const name = "tui-design"
    const movedSource = path.join(home, "old-checkout", "profiles", "gabo", "skills", name)
    fs.mkdirSync(path.join(home, ".local", "share", "oh-my-rigel"), { recursive: true })
    fs.mkdirSync(skillsRoot(home), { recursive: true })
    fs.symlinkSync(movedSource, path.join(skillsRoot(home), name), "dir")
    fs.writeFileSync(
      path.join(home, ".local", "share", "oh-my-rigel", "skills-v2.json"),
      `${JSON.stringify({ generatedAt: "2026-10-15T00:00:00.000Z", discoveryRoot: skillsRoot(home), managed: [{ name, source: movedSource, kind: "rigel" }], preserved: [] }, null, 2)}\n`,
    )
    // A separate user-owned directory must never be touched by the relink pass.
    const userName = "juez-repo"
    const userDir = path.join(skillsRoot(home), userName)
    fs.mkdirSync(userDir, { recursive: true })
    fs.writeFileSync(path.join(userDir, "SKILL.md"), "user body\n")

    runMaterialize(home)
    const state = readState(home)

    const relinked = state.managed.find((entry) => entry.name === name)
    expect(relinked?.kind).toBe("rigel")
    expect(resolvedTarget(home, name)).toBe(fs.realpathSync(path.join(repoRoot, "profiles/gabo/skills", name)))

    expect(state.preserved).toContain(userName)
    expect(state.managed.some((entry) => entry.name === userName)).toBe(false)
    expect(fs.readFileSync(path.join(userDir, "SKILL.md"), "utf8")).toBe("user body\n")
  })
})
