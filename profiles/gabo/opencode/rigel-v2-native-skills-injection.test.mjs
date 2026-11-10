import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import plugin from "./rigel-v2-native.mjs"

const temporaryRoots = []

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-skills-injection-"))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function writeSkill(baseDir, relativeDir, name, { frontmatter = "", body = "" } = {}) {
  const dir = path.join(baseDir, relativeDir)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "SKILL.md"), `${frontmatter ? `---\n${frontmatter}\n---\n` : ""}${body}\n`, "utf8")
}

function makeContext({ projectDir, home, prompts, tools, nativeSkills, mcpServers = [] }) {
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, "empty") }
  return {
    location: { directory: projectDir },
    options: { skillsHome: home, skillsEnv: env },
    agent: {
      list: async () => ({ data: [{ id: "explore", name: "explore", mode: "subagent" }] }),
      transform: async (callback) => { callback({ update() {}, default() {} }); return { dispose() {} } },
      reload: async () => {},
    },
    session: {
      hook: async () => ({ dispose() {} }),
      create: async () => ({ data: { id: "ses_child" } }),
      prompt: async (input) => { prompts.push(input); return { data: {} } },
      context: async () => [],
    },
    skill: {
      transform: async (callback) => { callback({ add: (info) => nativeSkills.push(info), list: () => [] }); return { dispose() {} } },
    },
    // Mirrors the V2 MCP surface `registerSkillMcpServers` writes into: an
    // embedded `mcp:` block from a SKILL.md lands here as a named server.
    mcp: {
      transform: async (callback) => {
        const servers = new Map()
        callback({
          get: (name) => servers.get(name),
          set: (name, config) => { servers.set(name, config); mcpServers.push(name) },
        })
        return { dispose() {} }
      },
    },
    tool: {
      transform: async (callback) => { callback({ add: (definition) => tools.push(definition) }); return { dispose() {} } },
    },
  }
}

describe("#given a delegated child that requests skills", () => {
  test("#when the skill resolves #then the child prompt carries the real body, not a textual pointer", async () => {
    const home = makeRoot()
    const projectDir = makeRoot()
    writeSkill(projectDir, ".agents/skills/injected-skill", "injected-skill", {
      frontmatter: "name: injected-skill\ndescription: Injected body",
      body: "REAL_SKILL_BODY_MARKER",
    })
    const prompts = []
    const tools = []
    const native = []
    const context = makeContext({ projectDir, home, prompts, tools, nativeSkills: native })
    const dispose = await plugin.setup(context)
    const task = tools.find((definition) => definition.name === "rigel_task")
    expect(task).toBeDefined()
    expect(tools.some((definition) => definition.name === "skill_mcp")).toBe(true)

    await task.execute({ subagent_type: "explore", prompt: "Read only.", load_skills: ["injected-skill"], run_in_background: true }, { sessionID: "ses_parent" })
    const childPrompt = prompts.find((entry) => typeof entry.text === "string" && entry.text.includes("Read only."))
    expect(childPrompt.text).toContain("<skill name=\"injected-skill\">")
    expect(childPrompt.text).toContain("REAL_SKILL_BODY_MARKER")
    expect(childPrompt.text).not.toContain("<rigel-requested-skills>")
    await dispose()
  })

  test("#when a requested name cannot be resolved #then the textual fallback survives instead of a silent drop", async () => {
    const home = makeRoot()
    const projectDir = makeRoot()
    const prompts = []
    const tools = []
    const context = makeContext({ projectDir, home, prompts, tools, nativeSkills: [] })
    // A discovered skill is required for the runtime to expose rigel_task with a non-empty registry; add one unrelated skill.
    writeSkill(projectDir, ".agents/skills/present", "present", { frontmatter: "name: present\ndescription: Present", body: "PRESENT_BODY" })
    const dispose = await plugin.setup(context)
    const task = tools.find((definition) => definition.name === "rigel_task")
    await task.execute({ subagent_type: "explore", prompt: "Read only.", load_skills: ["ghost"], run_in_background: true }, { sessionID: "ses_parent" })
    const childPrompt = prompts.find((entry) => typeof entry.text === "string" && entry.text.includes("Read only."))
    expect(childPrompt.text).toContain("<rigel-requested-skills>Before working, load these native skills if available: ghost</rigel-requested-skills>")
    await dispose()
  })

  test("#when a skill is restricted to another agent #then its body is withheld and the fallback names it", async () => {
    const home = makeRoot()
    const projectDir = makeRoot()
    writeSkill(projectDir, ".agents/skills/oracle-only", "oracle-only", {
      frontmatter: "name: oracle-only\ndescription: Oracle only\nagent: oracle",
      body: "ORACLE_SECRET_BODY",
    })
    const prompts = []
    const tools = []
    const context = makeContext({ projectDir, home, prompts, tools, nativeSkills: [] })
    const dispose = await plugin.setup(context)
    const task = tools.find((definition) => definition.name === "rigel_task")
    await task.execute({ subagent_type: "explore", prompt: "Read only.", load_skills: ["oracle-only"], run_in_background: true }, { sessionID: "ses_parent" })
    const childPrompt = prompts.find((entry) => typeof entry.text === "string" && entry.text.includes("Read only."))
    expect(childPrompt.text).not.toContain("ORACLE_SECRET_BODY")
    expect(childPrompt.text).toContain("oracle-only")
    await dispose()
  })
})

// The runtime resolves `disabled_skills` from the LIVE `~/.omo/omo.jsonc` at
// plugin setup, so each case below drives a disposable HOME/XDG tree and puts
// it back afterwards. The real user config must never be read or written by a
// test.
async function withLiveOmoConfig(config, run) {
  const sandbox = makeRoot()
  const home = path.join(sandbox, "home")
  const projectDir = path.join(sandbox, "project")
  fs.mkdirSync(path.join(home, ".omo"), { recursive: true })
  fs.mkdirSync(projectDir, { recursive: true })
  fs.writeFileSync(path.join(home, ".omo", "omo.jsonc"), `${JSON.stringify(config, null, 2)}\n`)
  const previous = {}
  for (const key of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) previous[key] = process.env[key]
  process.env.HOME = home
  process.env.XDG_STATE_HOME = path.join(sandbox, "state")
  process.env.XDG_CONFIG_HOME = path.join(sandbox, "config")
  process.env.XDG_DATA_HOME = path.join(sandbox, "data")
  process.env.XDG_CACHE_HOME = path.join(sandbox, "cache")
  try {
    return await run({ home, projectDir })
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function writeEmbeddedMcpSkills(projectDir, disabledName) {
  writeSkill(projectDir, ".agents/skills/alpha", "alpha", {
    frontmatter: "name: alpha\ndescription: Alpha\nmcp:\n  alpha-api:\n    type: http\n    url: https://alpha.example.com/mcp",
    body: "ALPHA_BODY",
  })
  writeSkill(projectDir, `.agents/skills/${disabledName}`, disabledName, {
    frontmatter: `name: ${disabledName}\ndescription: Disabled by the live config\nmcp:\n  ${disabledName}-api:\n    type: http\n    url: https://${disabledName}.example.com/mcp`,
    body: "LIVE_DISABLED_SECRET_BODY",
  })
}

describe("#given a live omo.jsonc that disables a discovered skill", () => {
  test("#when the runtime sets up #then the skill and its embedded MCP server never register", async () => {
    await withLiveOmoConfig({ "[opencode]": { disabled_skills: ["beta"] } }, async ({ home, projectDir }) => {
      writeEmbeddedMcpSkills(projectDir, "beta")
      const native = []
      const mcpServers = []
      const context = makeContext({ projectDir, home, prompts: [], tools: [], nativeSkills: native, mcpServers })
      const dispose = await plugin.setup(context)
      try {
        // the live deny is the only reason beta can be missing: the install-time
        // manifest baked an empty list
        expect(native.map((info) => info.name)).toEqual(["alpha"])
        // an embedded `mcp:` block is a side effect of registration, so it must
        // follow the same list instead of leaking a server for a disabled skill
        expect(mcpServers).toEqual(["alpha-api"])
      } finally {
        await dispose()
      }
    })
  })

  test("#when a delegated child requests the disabled skill #then its body is withheld and the fallback names it", async () => {
    await withLiveOmoConfig({ "[opencode]": { disabled_skills: ["beta"] } }, async ({ home, projectDir }) => {
      writeEmbeddedMcpSkills(projectDir, "beta")
      const prompts = []
      const tools = []
      const context = makeContext({ projectDir, home, prompts, tools, nativeSkills: [] })
      const dispose = await plugin.setup(context)
      try {
        const task = tools.find((definition) => definition.name === "rigel_task")
        await task.execute({ subagent_type: "explore", prompt: "Read only.", load_skills: ["beta"], run_in_background: true }, { sessionID: "ses_parent" })
        const childPrompt = prompts.find((entry) => typeof entry.text === "string" && entry.text.includes("Read only."))
        expect(childPrompt.text).not.toContain("LIVE_DISABLED_SECRET_BODY")
        // the fallback sentinel names the withheld skill, and it stays a sentinel:
        // no `<skill>` block is fabricated for a skill the live list denies
        const fallback = childPrompt.text.match(/<rigel-requested-skills>([\s\S]*?)<\/rigel-requested-skills>/)
        expect(fallback).not.toBeNull()
        expect(fallback[1]).toContain("beta")
        expect(fallback[1]).not.toContain("alpha")
        expect(childPrompt.text).not.toContain('<skill name="beta">')
        // a name the live list does not carry still injects, so the deny is not a
        // blanket injection failure
        await task.execute({ subagent_type: "explore", prompt: "Alpha only.", load_skills: ["alpha"], run_in_background: true }, { sessionID: "ses_parent" })
        const allowedPrompt = prompts.find((entry) => typeof entry.text === "string" && entry.text.includes("Alpha only."))
        expect(allowedPrompt.text).toContain("ALPHA_BODY")
      } finally {
        await dispose()
      }
    })
  })
})

describe("#given a live omo.jsonc with no disabled_skills declaration", () => {
  test("#when the runtime sets up #then registration, embedded MCPs and injection are unchanged", async () => {
    await withLiveOmoConfig({ "[opencode]": { hashline_edit: false } }, async ({ home, projectDir }) => {
      writeEmbeddedMcpSkills(projectDir, "beta")
      const native = []
      const mcpServers = []
      const prompts = []
      const tools = []
      const context = makeContext({ projectDir, home, prompts, tools, nativeSkills: native, mcpServers })
      const dispose = await plugin.setup(context)
      try {
        expect(native.map((info) => info.name).sort()).toEqual(["alpha", "beta"])
        expect(mcpServers.sort()).toEqual(["alpha-api", "beta-api"])
        const task = tools.find((definition) => definition.name === "rigel_task")
        await task.execute({ subagent_type: "explore", prompt: "Read only.", load_skills: ["beta"], run_in_background: true }, { sessionID: "ses_parent" })
        const childPrompt = prompts.find((entry) => typeof entry.text === "string" && entry.text.includes("Read only."))
        expect(childPrompt.text).toContain("LIVE_DISABLED_SECRET_BODY")
      } finally {
        await dispose()
      }
    })
  })
})
