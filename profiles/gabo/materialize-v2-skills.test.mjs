/**
 * Owner contract for `materialize-v2-skills.mjs` (U4): the cross-harness shared
 * pool is linked into `~/.agents/skills` for exactly the `skillPolicy`-authorized
 * names (omoAdopt + omoAdapt + omoProgressive), so the OmO skills the profile
 * confirms reach the live inventory while `browser`/`ultimate-browsing` stay out.
 * User-owned entries win, the legacy bridge keeps precedence, and every managed
 * link is recorded so the uninstall round-trip can remove it.
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
const sharedSkillsDir = path.join(repoRoot, "packages/shared-skills/skills")

// The exact `skillPolicy`-authorized intersection with the shared pool.
const AUTHORIZED_SHARED = [
  "debugging", "frontend", "git-master", "remove-ai-slops", "visual-qa",
  "review-work", "init-deep", "ulw-plan", "ulw-research", "ulw-execute",
  "ast-grep", "coding-agent-sessions", "data-scientist", "lsp-setup", "programming", "refactor",
]
const NOT_DELIVERED = ["browser", "ultimate-browsing"]
const RIGEL_KIT_COUNT = 14

const roots = []
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-materialize-"))
  roots.push(home)
  return home
}
afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop(), { recursive: true, force: true })
})

function runMaterialize(home) {
  const result = spawnSync(process.execPath, [materializer], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 60_000 })
  if (result.status !== 0) throw new Error(`materialize-v2-skills failed: ${result.stderr || result.stdout}`)
  return JSON.parse(result.stdout)
}
function skillsRoot(home) { return path.join(home, ".agents", "skills") }
function readState(home) { return JSON.parse(fs.readFileSync(path.join(home, ".local", "share", "oh-my-rigel", "skills-v2.json"), "utf8")) }
function resolvedTarget(home, name) {
  try { return fs.realpathSync(path.join(skillsRoot(home), name)) } catch { return null }
}

describe("#given the shared-pool skill delivery", () => {
  test("#when materialized #then exactly the 16 authorized shared skills link and browser/ultimate-browsing stay out", () => {
    const home = makeHome()
    const out = runMaterialize(home)
    const state = readState(home)

    const sharedManaged = state.managed.filter((entry) => entry.kind === "shared").map((entry) => entry.name).sort()
    expect(sharedManaged).toEqual([...AUTHORIZED_SHARED].sort())
    expect(out.linked).toHaveLength(RIGEL_KIT_COUNT + AUTHORIZED_SHARED.length)

    for (const name of AUTHORIZED_SHARED) {
      expect(resolvedTarget(home, name)).toBe(fs.realpathSync(path.join(sharedSkillsDir, name)))
    }
    for (const name of NOT_DELIVERED) {
      expect(fs.existsSync(path.join(skillsRoot(home), name))).toBe(false)
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
})
