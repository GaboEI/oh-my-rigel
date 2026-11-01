import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  SCOPE_PRIORITY,
  collectDisabledSkillAliases,
  createRuntimeHostSkillSource,
  discoverSkills,
  findPartialSkillMatches,
  formatSkillInjection,
  getAgentConfigKey,
  isSkillAllowedForTargetAgent,
  matchSkillByName,
  parseFrontmatter,
  readRuntimeHostSkills,
  registerNativeSkills,
  selectSkillsForChild,
} from "./rigel-v2-native-skills.mjs"

const temporaryRoots = []

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-skills-"))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function writeSkill(baseDir, relativeDir, name, { frontmatter = "", body = "" } = {}) {
  const dir = path.join(baseDir, relativeDir)
  fs.mkdirSync(dir, { recursive: true })
  const fm = frontmatter ? `---\n${frontmatter}\n---\n` : ""
  fs.writeFileSync(path.join(dir, "SKILL.md"), `${fm}${body}\n`, "utf8")
  return dir
}

describe("#given a SKILL.md frontmatter payload", () => {
  test("#when parsed #then scalar, inline-array, metadata, and nested mcp fields are all read", () => {
    const content = [
      "---",
      "name: demo",
      "description: A demo skill",
      "agent: oracle",
      "allowed-tools: [Read, Write]",
      "metadata:",
      "  category: test",
      "mcp:",
      "  memory:",
      "    command: npx",
      "    args: [-y, server]",
      "    env:",
      "      MODE: strict",
      "---",
      "",
      "Body line one.",
    ].join("\n")
    const { data, body } = parseFrontmatter(content)
    expect(data.name).toBe("demo")
    expect(data.description).toBe("A demo skill")
    expect(data.agent).toBe("oracle")
    expect(data["allowed-tools"]).toEqual(["Read", "Write"])
    expect(data.metadata).toEqual({ category: "test" })
    expect(data.mcp.memory.command).toBe("npx")
    expect(data.mcp.memory.args).toEqual(["-y", "server"])
    expect(data.mcp.memory.env).toEqual({ MODE: "strict" })
    expect(body.trim()).toBe("Body line one.")
  })

  test("#when there is no frontmatter #then the whole document is the body", () => {
    const { data, body, hadFrontmatter } = parseFrontmatter("just text")
    expect(hadFrontmatter).toBe(false)
    expect(data).toEqual({})
    expect(body).toBe("just text")
  })
})

describe("#given skills in multiple scope directories", () => {
  test("#when the same name exists in project and user scope #then the higher scope priority wins", () => {
    const root = makeRoot()
    const home = makeRoot()
    const projectDir = path.join(root, "work")
    writeSkill(projectDir, ".agents/skills/shared", "shared", { frontmatter: "name: shared\ndescription: project copy", body: "PROJECT_BODY" })
    writeSkill(home, ".claude/skills/shared", "shared", { frontmatter: "name: shared\ndescription: user copy", body: "USER_BODY" })
    const skills = discoverSkills({ directory: projectDir, home, env: { HOME: home, XDG_CONFIG_HOME: path.join(home, "empty") } })
    const winner = matchSkillByName(skills, "shared")
    expect(winner.scope).toBe("project")
    expect(winner.rawBody).toBe("PROJECT_BODY")
    expect(SCOPE_PRIORITY.project).toBeGreaterThan(SCOPE_PRIORITY.user)
  })

  test("#when two nested skills share a short name #then an ambiguous short name refuses to resolve but an exact name does", () => {
    const skills = [
      { name: "alpha/thing", rawBody: "A", resolvedBody: "A", scope: "project" },
      { name: "beta/thing", rawBody: "B", resolvedBody: "B", scope: "project" },
    ]
    expect(matchSkillByName(skills, "thing")).toBeUndefined()
    expect(matchSkillByName(skills, "beta/thing").rawBody).toBe("B")
    expect(matchSkillByName(skills, "/alpha/thing").rawBody).toBe("A")
  })

  test("#given a project-scoped skill and a user-wide skill #when discovery starts inside, below, and outside the project #then project scope follows the ancestor path while user scope remains available", () => {
    const root = makeRoot()
    const project = path.join(root, "project")
    const descendant = path.join(project, "sub", "dir")
    const outside = path.join(root, "outside")
    const home = path.join(root, "home")
    const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, "empty") }
    fs.mkdirSync(descendant, { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    writeSkill(project, ".agents/skills/project-only", "project-only", { frontmatter: "name: project-only", body: "PROJECT_ONLY" })
    writeSkill(home, ".agents/skills/user-wide", "user-wide", { frontmatter: "name: user-wide", body: "USER_WIDE" })

    const namesAtProject = discoverSkills({ directory: project, home, env, config: {} }).map((skill) => skill.name)
    const namesAtDescendant = discoverSkills({ directory: descendant, home, env, config: {} }).map((skill) => skill.name)
    const namesOutsideProject = discoverSkills({ directory: outside, home, env, config: {} }).map((skill) => skill.name)

    expect(namesAtProject).toEqual(expect.arrayContaining(["project-only", "user-wide"]))
    expect(namesAtDescendant).toContain("project-only")
    expect(namesOutsideProject).not.toContain("project-only")
    expect(namesOutsideProject).toContain("user-wide")
  })

  test("#given a configured skills.paths directory outside the standard roots #when discovery runs #then that directory's skills are discovered", () => {
    const root = makeRoot()
    const configured = path.join(root, "configured-skills")
    const home = makeRoot()
    writeSkill(configured, "from-paths", "configured-paths", { frontmatter: "name: configured-paths", body: "PATHS_BODY" })
    const skills = discoverSkills({
      directory: root,
      home,
      env: { HOME: home, XDG_CONFIG_HOME: path.join(home, "empty") },
      config: { skills: { paths: ["configured-skills"] } },
    })
    expect(matchSkillByName(skills, "configured-paths")).toMatchObject({ scope: "config", rawBody: "PATHS_BODY" })
  })

  test("#given the legacy skills.sources key #when discovery runs #then it is still honored", () => {
    const root = makeRoot()
    const configured = path.join(root, "legacy-skills")
    const home = makeRoot()
    writeSkill(configured, "from-sources", "configured-sources", { frontmatter: "name: configured-sources", body: "SOURCES_BODY" })
    const skills = discoverSkills({
      directory: root,
      home,
      env: { HOME: home, XDG_CONFIG_HOME: path.join(home, "empty") },
      config: { skills: { sources: [{ path: "legacy-skills" }] } },
    })
    expect(matchSkillByName(skills, "configured-sources")).toMatchObject({ scope: "config", rawBody: "SOURCES_BODY" })
  })

  test("#given both keys pointing at the same directory #when discovery runs #then the skill is discovered exactly once", () => {
    const root = makeRoot()
    const configured = path.join(root, "shared-skills")
    const home = makeRoot()
    writeSkill(configured, "shared", "shared-configured", { frontmatter: "name: shared-configured", body: "SHARED_BODY" })
    const skills = discoverSkills({
      directory: root,
      home,
      env: { HOME: home, XDG_CONFIG_HOME: path.join(home, "empty") },
      config: { skills: { paths: ["shared-skills"], sources: [{ path: "shared-skills" }] } },
    })
    expect(skills.filter((skill) => skill.name === "shared-configured")).toHaveLength(1)
  })
})

describe("#given agent-restricted and disabled skills", () => {
  test("#when the target agent matches #then the skill is allowed; otherwise it is not", () => {
    expect(getAgentConfigKey("Sisyphus - ultraworker")).toBe("sisyphus")
    expect(getAgentConfigKey("oracle")).toBe("oracle")
    const skill = { name: "s", agent: "oracle" }
    expect(isSkillAllowedForTargetAgent(skill, "oracle")).toBe(true)
    expect(isSkillAllowedForTargetAgent(skill, "Sisyphus - ultraworker")).toBe(false)
    expect(isSkillAllowedForTargetAgent(skill, undefined)).toBe(false)
    expect(isSkillAllowedForTargetAgent({ name: "open" }, undefined)).toBe(true)
  })

  test("#when disabled_skills and skills.disable both name a skill #then aliases are collected case-insensitively", () => {
    const disabled = collectDisabledSkillAliases({ disabled_skills: ["Foo"], skills: { disable: ["bar"], baz: false } })
    expect(disabled.has("foo")).toBe(true)
    expect(disabled.has("bar")).toBe(true)
    expect(disabled.has("baz")).toBe(true)
  })
})

describe("#given requested skills for a delegated child", () => {
  test("#when a name resolves #then the real body is injected and a missing name keeps the textual fallback", () => {
    const skills = [
      { name: "review-work", rawBody: "REAL_REVIEW_BODY", scope: "project", agent: undefined },
      { name: "oracle-only", rawBody: "ORACLE_BODY", scope: "project", agent: "oracle" },
    ]
    const resolved = selectSkillsForChild(skills, ["review-work", "ghost", "oracle-only"], { targetAgent: "explore" })
    expect(resolved.injected).toEqual([{ name: "review-work", body: "REAL_REVIEW_BODY" }])
    expect(resolved.missing).toEqual(["ghost", "oracle-only"])
    const injected = formatSkillInjection(resolved)
    expect(injected).toContain("<skill name=\"review-work\">")
    expect(injected).toContain("REAL_REVIEW_BODY")
    expect(injected).toContain("<rigel-requested-skills>Before working, load these native skills if available: ghost, oracle-only</rigel-requested-skills>")
  })

  test("#when a name is disabled #then it is reported missing instead of injected", () => {
    const skills = [{ name: "blocked", rawBody: "SECRET", scope: "project" }]
    const resolved = selectSkillsForChild(skills, ["blocked"], { disabledSkills: new Set(["blocked"]) })
    expect(resolved.injected).toEqual([])
    expect(resolved.missing).toEqual(["blocked"])
  })

  test("#when the same name exists at two scopes #then the discovered winner's body wins the collision", () => {
    const root = makeRoot()
    const home = makeRoot()
    const projectDir = path.join(root, "work")
    writeSkill(projectDir, ".agents/skills/collision", "collision", { frontmatter: "name: collision\ndescription: project", body: "PROJECT_WINS" })
    writeSkill(home, ".claude/skills/collision", "collision", { frontmatter: "name: collision\ndescription: user", body: "USER_LOSES" })
    const skills = discoverSkills({ directory: projectDir, home, env: { HOME: home, XDG_CONFIG_HOME: path.join(home, "empty") } })
    const resolved = selectSkillsForChild(skills, ["collision"], { targetAgent: "explore" })
    expect(resolved.injected[0].body).toBe("PROJECT_WINS")
  })

  test("#when partial matches exist #then they are offered for the error path", () => {
    const skills = [{ name: "review-work" }, { name: "review-tests" }]
    expect(findPartialSkillMatches(skills, "review")).toEqual(["review-work", "review-tests"])
  })
})

describe("#given the V2 native skill surface", () => {
  test("#when registering #then each discovered skill becomes an embedded SkillV2Info and host names are preserved", async () => {
    const root = makeRoot()
    const home = makeRoot()
    const projectDir = path.join(root, "work")
    writeSkill(projectDir, ".agents/skills/alpha", "alpha", { frontmatter: "name: alpha\ndescription: Alpha skill", body: "ALPHA_BODY" })
    writeSkill(projectDir, ".agents/skills/host-skill", "host-skill", { frontmatter: "name: host-skill\ndescription: Host", body: "HOST_BODY" })
    const added = []
    const hostNames = [{ name: "host-skill" }]
    const context = {
      location: { directory: projectDir },
      skill: { transform: async (callback) => { callback({ add: (info) => added.push(info), list: () => hostNames }); return { dispose() {} } } },
      options: { skillsHome: home, skillsEnv: { HOME: home, XDG_CONFIG_HOME: path.join(home, "empty") } },
    }
    const registry = await registerNativeSkills(context, { directory: projectDir, home, env: { HOME: home, XDG_CONFIG_HOME: path.join(home, "empty") } })
    expect(registry.skills.map((skill) => skill.name).sort()).toEqual(["alpha", "host-skill"])
    expect(added).toEqual([{ id: "alpha", name: "alpha", description: "Alpha skill", path: path.join(projectDir, ".agents/skills/alpha", "SKILL.md"), content: "ALPHA_BODY" }])
    expect(registry.registered).toEqual(["alpha"])
  })

  test("#when disabledSkills names a discovered skill #then it is excluded from the native registry", async () => {
    const root = makeRoot()
    const home = makeRoot()
    const projectDir = path.join(root, "work")
    writeSkill(projectDir, ".agents/skills/alpha", "alpha", { frontmatter: "name: alpha\ndescription: Alpha skill", body: "ALPHA_BODY" })
    writeSkill(projectDir, ".agents/skills/beta", "beta", { frontmatter: "name: beta\ndescription: Beta skill", body: "BETA_BODY" })
    const added = []
    const context = {
      location: { directory: projectDir },
      skill: { transform: async (callback) => { callback({ add: (info) => added.push(info), list: () => [] }); return { dispose() {} } } },
      options: { skillsHome: home, skillsEnv: { HOME: home, XDG_CONFIG_HOME: path.join(home, "empty") } },
    }
    const registry = await registerNativeSkills(context, {
      directory: projectDir,
      home,
      env: { HOME: home, XDG_CONFIG_HOME: path.join(home, "empty") },
      disabledSkills: new Set(["beta"]),
    })
    expect(registry.skills.map((skill) => skill.name)).toEqual(["alpha"])
    expect(added.map((info) => info.name)).toEqual(["alpha"])
  })

  test("#when the host exposes source() instead of add() #then registration still lands as an embedded source", async () => {
    const root = makeRoot()
    const projectDir = path.join(root, "work")
    writeSkill(projectDir, ".agents/skills/beta", "beta", { frontmatter: "name: beta\ndescription: Beta", body: "BETA_BODY" })
    const sources = []
    const context = {
      location: { directory: projectDir },
      skill: { transform: async (callback) => { callback({ source: (source) => sources.push(source), list: () => [] }); return { dispose() {} } } },
      options: { skillsHome: root, skillsEnv: { HOME: root, XDG_CONFIG_HOME: path.join(root, "empty") } },
    }
    await registerNativeSkills(context, { directory: projectDir, home: root, env: { HOME: root, XDG_CONFIG_HOME: path.join(root, "empty") } })
    expect(sources).toEqual([{ type: "embedded", skill: { id: "beta", name: "beta", description: "Beta", path: path.join(projectDir, ".agents/skills/beta", "SKILL.md"), content: "BETA_BODY" } }])
  })
})

describe("#given the runtime host-skill source", () => {
  test("#when the host catalog lists a skill added by another plugin #then it is merged after the base skills with parsed frontmatter", async () => {
    // given
    const root = makeRoot()
    const projectDir = path.join(root, "work")
    const base = writeSkill(projectDir, ".agents/skills/alpha", "alpha", { frontmatter: "name: alpha\ndescription: Alpha skill", body: "ALPHA_BODY" })
    // another plugin added this skill through a config hook: it exists on disk
    // but under a directory our discovery never walks
    const external = writeSkill(root, "external-skills/omega", "omega", { frontmatter: "name: omega\ndescription: Omega skill\nmcp:\n  omega-api:\n    type: http\n    url: https://omega.example.com", body: "OMEGA_BODY" })
    const context = { skill: { list: async () => [
      { id: "alpha", name: "alpha", path: path.join(base, "SKILL.md") },
      { id: "omega", name: "omega", path: path.join(external, "SKILL.md") },
    ] } }
    const baseSkills = discoverSkills({ directory: projectDir, home: root, env: { HOME: root, XDG_CONFIG_HOME: path.join(root, "empty") } })
    const resolveSkills = createRuntimeHostSkillSource({ context, baseSkills })
    // when
    const merged = await resolveSkills()
    // then
    expect(merged.map((skill) => skill.name)).toEqual(["alpha", "omega"])
    expect(merged[1].scope).toBe("runtime-host")
    expect(merged[1].mcpConfig?.["omega-api"]).toMatchObject({ url: "https://omega.example.com" })
  })

  test("#when the host catalog repeats a base name #then the on-disk base skill keeps precedence", async () => {
    // given
    const root = makeRoot()
    const projectDir = path.join(root, "work")
    const base = writeSkill(projectDir, ".agents/skills/alpha", "alpha", { frontmatter: "name: alpha\ndescription: Alpha skill", body: "ALPHA_BODY" })
    const context = { skill: { list: async () => [{ id: "alpha", name: "alpha", content: "HOST_COPY" }] } }
    const resolveSkills = createRuntimeHostSkillSource({ context, baseSkills: discoverSkills({ directory: projectDir, home: root, env: { HOME: root, XDG_CONFIG_HOME: path.join(root, "empty") } }) })
    // when
    const merged = await resolveSkills()
    // then
    expect(merged).toHaveLength(1)
    expect(merged[0].rawBody).toBe("ALPHA_BODY")
    void base
  })

  test("#when a host skill is disabled or pathless #then inline content is used and disabled names are dropped", async () => {
    // given
    const context = { skill: { list: async () => [
      { id: "inline", name: "inline", description: "Inline skill", content: "INLINE_BODY" },
      { id: "gone", name: "gone", content: "SHOULD_NOT_LOAD" },
    ] } }
    const resolveSkills = createRuntimeHostSkillSource({ context, baseSkills: [], disabledSkills: new Set(["gone"]) })
    // when
    const merged = await resolveSkills()
    // then
    expect(merged.map((skill) => skill.name)).toEqual(["inline"])
    expect(merged[0].rawBody).toBe("INLINE_BODY")
  })

  test("#when the host list is absent or the read fails #then the base skills are returned unchanged", async () => {
    // given: no skill domain at all
    const fallback = createRuntimeHostSkillSource({ context: {}, baseSkills: [{ name: "alpha" }] })
    // when
    expect(await fallback()).toEqual([{ name: "alpha" }])
    // given: the domain throws
    const failing = createRuntimeHostSkillSource({ context: { skill: { list: async () => { throw new Error("catalog gone") } } }, baseSkills: [{ name: "alpha" }] })
    // then
    expect(await failing()).toEqual([{ name: "alpha" }])
  })

  test("#when readRuntimeHostSkills runs without a list domain #then it reports undefined so callers fall back", async () => {
    expect(await readRuntimeHostSkills({})).toBeUndefined()
  })
})

describe("#given skills whose on-disk discovery order the filesystem controls", () => {
  test("#when two same-scope skills are discovered #then registration lists them in code-unit name order", async () => {
    // given - same scope (project); .claude/skills is scanned before .agents/skills,
    // so the raw discovery order is zeta, alpha (not name order)
    const root = makeRoot()
    const projectDir = path.join(root, "work")
    writeSkill(projectDir, ".claude/skills/zeta", "zeta", { frontmatter: "name: zeta\ndescription: Zeta", body: "ZETA" })
    writeSkill(projectDir, ".agents/skills/alpha", "alpha", { frontmatter: "name: alpha\ndescription: Alpha", body: "ALPHA" })
    const env = { HOME: root, XDG_CONFIG_HOME: path.join(root, "empty") }
    const added = []
    const context = {
      location: { directory: projectDir },
      skill: { transform: async (callback) => { callback({ add: (info) => added.push(info), list: () => [] }); return { dispose() {} } } },
      options: { skillsHome: root, skillsEnv: env },
    }

    // when
    const registry = await registerNativeSkills(context, { directory: projectDir, home: root, env })

    // then - deterministic order, independent of which directory was scanned first
    expect(added.map((info) => info.name)).toEqual(["alpha", "zeta"])
    expect(registry.registered).toEqual(["alpha", "zeta"])
  })

  test("#when a higher-scope skill sorts last by name #then scope priority still dominates the name tie-break", async () => {
    // given - opencode-project (priority 6) name zzz vs project (priority 5) name aaa
    const root = makeRoot()
    const projectDir = path.join(root, "work")
    writeSkill(projectDir, ".opencode/skills/zzz", "zzz", { frontmatter: "name: zzz\ndescription: Zzz", body: "ZZZ" })
    writeSkill(projectDir, ".agents/skills/aaa", "aaa", { frontmatter: "name: aaa\ndescription: Aaa", body: "AAA" })
    const env = { HOME: root, XDG_CONFIG_HOME: path.join(root, "empty") }
    const added = []
    const context = {
      location: { directory: projectDir },
      skill: { transform: async (callback) => { callback({ add: (info) => added.push(info), list: () => [] }); return { dispose() {} } } },
      options: { skillsHome: root, skillsEnv: env },
    }

    // when
    await registerNativeSkills(context, { directory: projectDir, home: root, env })

    // then - a pure name sort would have produced [aaa, zzz]
    expect(added.map((info) => info.name)).toEqual(["zzz", "aaa"])
  })
})
