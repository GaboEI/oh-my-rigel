import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readJsoncValue } from "./rigel-v2-native-jsonc-edit.mjs"
import { SETTING_CATALOG } from "./rigel-v2-native-setting-catalog.mjs"
import { SETTING_SURFACE_ERRORS, mutableRefusal } from "./rigel-v2-native-setting-descriptor.mjs"
import { SETTING_TOOL_ACTIONS, SETTING_TOOL_NAME, createSettingTool, registerSettingTool } from "./rigel-v2-native-setting-tool.mjs"
import { SETTING_WRITE_ERRORS } from "./rigel-v2-native-setting-write.mjs"

const temporary = []
afterEach(() => { while (temporary.length > 0) fs.rmSync(temporary.pop(), { recursive: true, force: true }) })

const MONITOR_ENABLED = "[opencode].monitor.enabled"
const MONITOR_CAP = "[opencode].monitor.max_monitors_per_session"
const SHARED_SKILLS = "disabled_skills"
const USER_CONFIG_TEMPLATE = `{
  // authored comment that must survive
  "profiles": {
    "gabo": {
      "[opencode]": {
        "monitor": { "enabled": false }
      },
      "disabled_skills": ["alpha"]
    }
  }
}
`

/** A disposable home + project pair. Nothing outside the temp root is read or written. */
function sandbox(text = USER_CONFIG_TEMPLATE) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rigel-setting-tool-")))
  temporary.push(root)
  const home = path.join(root, "home")
  const directory = path.join(root, "project")
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(directory, { recursive: true })
  const userConfig = path.join(home, ".omo", "omo.jsonc")
  fs.mkdirSync(path.dirname(userConfig), { recursive: true })
  fs.writeFileSync(userConfig, text)
  return { root, home, directory, userConfig, env: { OMO_PROFILE: "gabo" } }
}

/**
 * A home with one project NESTED inside it, so the reader's upward layer walk
 * stops at the home boundary instead of climbing out of the sandbox. Two layers
 * is the smallest chain that can prove a union fold.
 */
function layeredSandbox({ userText, projectText }) {
  const space = sandbox(userText)
  const directory = path.join(space.home, "project")
  const projectConfig = path.join(directory, ".omo", "omo.jsonc")
  fs.mkdirSync(path.dirname(projectConfig), { recursive: true })
  fs.writeFileSync(projectConfig, projectText)
  return { ...space, directory, projectConfig }
}

/** Every mutating file-system call, in order, so "no write" is provable. */
function recordingFileSystem() {
  const mutations = []
  const record = (name, run) => (...args) => { mutations.push(name); return run(...args) }
  return {
    mutations,
    existsSync: fs.existsSync,
    lstatSync: fs.lstatSync,
    readFileSync: fs.readFileSync,
    realpathSync: fs.realpathSync,
    closeSync: fs.closeSync,
    mkdirSync: record("mkdirSync", fs.mkdirSync),
    openSync: record("openSync", fs.openSync),
    writeFileSync: record("writeFileSync", fs.writeFileSync),
    fsyncSync: record("fsyncSync", fs.fsyncSync),
    renameSync: record("renameSync", fs.renameSync),
    rmSync: record("rmSync", fs.rmSync),
  }
}

function toolFor(space, extra = {}) {
  return createSettingTool({
    env: space.env,
    home: space.home,
    directory: space.directory,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    ...extra,
  })
}

async function run(tool, input) {
  const result = await tool.execute(input)
  return { result, payload: JSON.parse(result.content) }
}

function backupFiles(space) {
  const dir = path.dirname(space.userConfig)
  return fs.readdirSync(dir).filter((name) => name.includes(".bak."))
}

describe("#given the rigel_setting tool contract", () => {
  test("#when the definition is inspected #then the name, actions and input schema match the surface", () => {
    const tool = toolFor(sandbox())

    expect(tool.name).toBe("rigel_setting")
    expect(SETTING_TOOL_NAME).toBe("rigel_setting")
    expect(SETTING_TOOL_ACTIONS).toEqual(["list", "get", "validate", "set", "add", "remove"])
    expect(tool.input.required).toEqual(["action"])
    expect(tool.input.properties.action.enum).toEqual(["list", "get", "validate", "set", "add", "remove"])
  })

  test("#when list runs #then the catalog totals and the mutable count come from the catalog metadata", async () => {
    const space = sandbox()
    const { payload } = await run(toolFor(space), { action: "list", limit: 5 })

    expect(payload.ok).toBe(true)
    expect(payload.counts.total).toBe(SETTING_CATALOG.length)
    expect(payload.counts.mutable).toBe(SETTING_CATALOG.filter((entry) => mutableRefusal(entry) === null).length)
    expect(payload.entries.length).toBe(5)
    expect(payload.entries.every((entry) => typeof entry.key === "string")).toBe(true)
  })

  test("#when list filters by tier and query #then only matching entries survive", async () => {
    const space = sandbox()
    const tool = toolFor(space)
    const engine = await run(tool, { action: "list", tier: "engine" })
    const query = await run(tool, { action: "list", query: "monitor" })

    expect(engine.payload.entries.length).toBeGreaterThan(0)
    expect(engine.payload.entries.every((entry) => entry.tier === "engine")).toBe(true)
    expect(query.payload.entries.length).toBeGreaterThan(0)
    expect(query.payload.entries.every((entry) => entry.key.toLowerCase().includes("monitor") || entry.note.toLowerCase().includes("monitor"))).toBe(true)
  })
})

describe("#given the rigel_setting tool read path", () => {
  test("#when get reads a harness key #then the effective value and the declaring layer are reported", async () => {
    const space = sandbox()
    const { payload } = await run(toolFor(space), { action: "get", key: MONITOR_ENABLED })

    expect(payload.ok).toBe(true)
    expect(payload.profileName).toBe("gabo")
    expect(payload.current).toEqual({ found: true, value: false, source: space.userConfig })
    expect(payload.setting.mutable).toBe(true)
    expect(payload.layers).toEqual([{ path: space.userConfig, scope: "user", exists: true, ok: true }])
  })

  test("#when get reads a shared root key #then the profile-root placement is folded", async () => {
    const space = sandbox()
    const { payload } = await run(toolFor(space), { action: "get", key: SHARED_SKILLS })

    expect(payload.ok).toBe(true)
    expect(payload.current.value).toEqual(["alpha"])
  })

  test("#when get reads an unknown or non-mutable key #then the entry explaining the refusal is returned", async () => {
    const space = sandbox()
    const tool = toolFor(space)
    const unknown = await run(tool, { action: "get", key: "[opencode].not_a_setting" })
    const inert = await run(tool, { action: "get", key: "[opencode].new_task_system_enabled" })
    const engine = await run(tool, { action: "get", key: "model_profile" })

    expect(unknown.payload.ok).toBe(false)
    expect(unknown.payload.error.code).toBe(SETTING_SURFACE_ERRORS.UNKNOWN_SETTING)
    expect(inert.payload.setting.mutable).toBe(false)
    expect(inert.payload.setting.refusal.code).toBe(SETTING_SURFACE_ERRORS.INERT)
    expect(engine.payload.setting.refusal.code).toBe(SETTING_SURFACE_ERRORS.ENGINE_OWNED)
  })
})

describe("#given a union denylist declared in several placements", () => {
  test("#when get folds a user and a project layer #then the merged unique list and every contributing source are reported", async () => {
    const space = layeredSandbox({
      userText: `{
  "[opencode]": { "disabled_tools": ["alpha"] },
  "profiles": { "gabo": { "[opencode]": { "disabled_tools": ["profile_only"] } } }
}`,
      projectText: `{
  "disabled_tools": ["gamma"],
  "[opencode]": { "disabled_tools": ["beta", "alpha"] }
}`
    })
    const { payload } = await run(toolFor(space), { action: "get", key: "[opencode].disabled_tools" })

    expect(payload.ok).toBe(true)
    expect(payload.current).toEqual({
      found: true,
      // Placement-major, layer-inner: the project ROOT list is folded first, then
      // the user harness block, then the nearer project block (its duplicate
      // `alpha` collapses), then the user profile block.
      value: ["gamma", "alpha", "beta", "profile_only"],
      source: space.userConfig,
      union: true,
      sources: [
        { path: space.projectConfig, at: "disabled_tools" },
        { path: space.userConfig, at: "[opencode].disabled_tools" },
        { path: space.projectConfig, at: "[opencode].disabled_tools" },
        { path: space.userConfig, at: "profiles.gabo.[opencode].disabled_tools" },
      ],
    })
  })

  test("#when a project layer declares the MCP env allowlist #then only the user declaration is effective", async () => {
    const space = layeredSandbox({
      userText: `{ "[opencode]": { "mcp_env_allowlist": ["HOME_TOKEN"] } }`,
      projectText: `{ "[opencode]": { "mcp_env_allowlist": ["PROJECT_TOKEN"] } }`,
    })
    const { payload } = await run(toolFor(space), { action: "get", key: "[opencode].mcp_env_allowlist" })

    expect(payload.current.value).toEqual(["HOME_TOKEN"])
    expect(payload.current.sources).toEqual([{ path: space.userConfig, at: "[opencode].mcp_env_allowlist" }])
  })

  test("#when the only declaration is an explicit empty list #then it reads as an authored release, not as undeclared", async () => {
    const space = sandbox(`{ "[opencode]": { "disabled_tools": [] } }`)
    const { payload } = await run(toolFor(space), { action: "get", key: "[opencode].disabled_tools" })

    expect(payload.current).toEqual({
      found: true,
      value: [],
      source: space.userConfig,
      union: true,
      sources: [{ path: space.userConfig, at: "[opencode].disabled_tools" }],
    })
  })
})

describe("#given the rigel_setting tool validate action", () => {
  test("#when a value matches the catalog metadata #then it validates and writes nothing on disk", async () => {
    const space = sandbox()
    const before = fs.readFileSync(space.userConfig, "utf8")
    const { payload } = await run(toolFor(space), { action: "validate", key: MONITOR_ENABLED, value: true })

    expect(payload.ok).toBe(true)
    expect(payload.valid).toBe(true)
    expect(fs.readFileSync(space.userConfig, "utf8")).toBe(before)
  })

  test("#when a value breaks the type or the range #then the writer's own code is reported", async () => {
    const space = sandbox()
    const tool = toolFor(space)
    const wrongType = await run(tool, { action: "validate", key: MONITOR_ENABLED, value: "yes" })
    const outOfRange = await run(tool, { action: "validate", key: MONITOR_CAP, value: 99 })

    expect(wrongType.payload.valid).toBe(false)
    expect(wrongType.payload.error.code).toBe(SETTING_WRITE_ERRORS.INVALID_VALUE)
    expect(outOfRange.payload.error.code).toBe(SETTING_WRITE_ERRORS.VALUE_OUT_OF_RANGE)
  })

  test("#when validate is asked about an inert key #then the tier refusal wins over value checking", async () => {
    const space = sandbox()
    const { payload } = await run(toolFor(space), { action: "validate", key: "[opencode].new_task_system_enabled", value: true })

    expect(payload.ok).toBe(false)
    expect(payload.error.code).toBe(SETTING_SURFACE_ERRORS.INERT)
  })
})

describe("#given the rigel_setting tool mutation path", () => {
  test("#when set is called without confirmation #then the exact change is previewed and nothing is written", async () => {
    const space = sandbox()
    const fileSystem = recordingFileSystem()
    const before = fs.readFileSync(space.userConfig, "utf8")
    const { payload } = await run(toolFor(space, { fileSystem }), { action: "set", key: MONITOR_ENABLED, value: true })

    expect(payload.ok).toBe(true)
    expect(payload.requiresConfirmation).toBe(true)
    expect(payload.changed).toBe(true)
    expect(payload.fullPath).toEqual(["profiles", "gabo", "[opencode]", "monitor", "enabled"])
    expect(payload.before).toBe(false)
    expect(payload.after).toBe(true)
    expect(fs.readFileSync(space.userConfig, "utf8")).toBe(before)
    expect(fileSystem.mutations).toEqual([])
    expect(backupFiles(space)).toEqual([])
  })

  test("#when set is confirmed #then the value is written, verified and a backup path is reported", async () => {
    const space = sandbox()
    const { payload } = await run(toolFor(space), { action: "set", key: MONITOR_ENABLED, value: true, confirm: true })

    expect(payload.ok).toBe(true)
    expect(payload.written).toBe(true)
    expect(payload.verified).toBe(true)
    expect(payload.requiresConfirmation).toBe(false)
    expect(typeof payload.backupPath).toBe("string")
    expect(fs.existsSync(payload.backupPath)).toBe(true)
    const text = fs.readFileSync(space.userConfig, "utf8")
    expect(text).toContain("// authored comment that must survive")
    expect(readJsoncValue(text, ["profiles", "gabo", "[opencode]", "monitor", "enabled"]).value).toBe(true)
  })

  test("#when the value already matches #then no backup is taken and nothing is written", async () => {
    const space = sandbox()
    const fileSystem = recordingFileSystem()
    const { payload } = await run(toolFor(space, { fileSystem }), { action: "set", key: MONITOR_ENABLED, value: false, confirm: true })

    expect(payload.ok).toBe(true)
    expect(payload.changed).toBe(false)
    expect(payload.written).toBe(false)
    expect(fileSystem.mutations).toEqual([])
    expect(backupFiles(space)).toEqual([])
  })

  test("#when a list item is added and removed #then the profile-root list changes and nothing else does", async () => {
    const space = sandbox()
    const tool = toolFor(space)
    const added = await run(tool, { action: "add", key: SHARED_SKILLS, value: "beta", confirm: true })
    const afterAdd = await run(tool, { action: "get", key: SHARED_SKILLS })
    const removed = await run(tool, { action: "remove", key: SHARED_SKILLS, value: "alpha", confirm: true })
    const afterRemove = await run(tool, { action: "get", key: SHARED_SKILLS })

    expect(added.payload.written).toBe(true)
    expect(added.payload.fullPath).toEqual(["profiles", "gabo", "disabled_skills"])
    expect(afterAdd.payload.current.value).toEqual(["alpha", "beta"])
    expect(removed.payload.written).toBe(true)
    expect(afterRemove.payload.current.value).toEqual(["beta"])
  })

  test("#when a list action targets a non-list key #then the writer refuses the operation", async () => {
    const space = sandbox()
    const { payload } = await run(toolFor(space), { action: "add", key: MONITOR_ENABLED, value: "x", confirm: true })

    expect(payload.ok).toBe(false)
    expect(payload.error.code).toBe(SETTING_WRITE_ERRORS.UNSUPPORTED_TYPE)
  })

  test("#when a scalar remove carries a value #then it is refused instead of silently deleting the key", async () => {
    const space = sandbox()
    const before = fs.readFileSync(space.userConfig, "utf8")
    const { payload } = await run(toolFor(space), { action: "remove", key: MONITOR_ENABLED, value: false, confirm: true })

    expect(payload.ok).toBe(false)
    expect(payload.error.code).toBe(SETTING_WRITE_ERRORS.INVALID_VALUE)
    expect(fs.readFileSync(space.userConfig, "utf8")).toBe(before)
  })

  test("#when a scalar remove is confirmed #then the key is deleted so the catalog default applies", async () => {
    const space = sandbox()
    const { payload } = await run(toolFor(space), { action: "remove", key: MONITOR_ENABLED, confirm: true })
    const current = await run(toolFor(space), { action: "get", key: MONITOR_ENABLED })

    expect(payload.ok).toBe(true)
    expect(payload.written).toBe(true)
    expect(current.payload.current.found).toBe(false)
  })
})

describe("#given the rigel_setting tool refusal policy", () => {
  test("#when an inert, engine-owned, container or unexpressable key is mutated #then it refuses before any write", async () => {
    const space = sandbox()
    const fileSystem = recordingFileSystem()
    const tool = toolFor(space, { fileSystem })
    const inert = await run(tool, { action: "set", key: "[opencode].new_task_system_enabled", value: true, confirm: true })
    const engine = await run(tool, { action: "set", key: "model_profile", value: "x", confirm: true })
    const container = await run(tool, { action: "set", key: "[opencode].categories", value: {}, confirm: true })
    const union = await run(tool, { action: "set", key: "[opencode].skills", value: {}, confirm: true })

    expect(inert.payload.error.code).toBe(SETTING_SURFACE_ERRORS.INERT)
    expect(engine.payload.error.code).toBe(SETTING_SURFACE_ERRORS.ENGINE_OWNED)
    expect(container.payload.error.code).toBe(SETTING_SURFACE_ERRORS.CONTAINER_NOT_MUTABLE)
    expect(union.payload.error.code).toBe(SETTING_SURFACE_ERRORS.UNSUPPORTED_TYPE)
    expect(fileSystem.mutations).toEqual([])
  })

  test("#when a team_mode limit the native validator drops is set #then it refuses before any write", async () => {
    const space = sandbox()
    const fileSystem = recordingFileSystem()
    const before = fs.readFileSync(space.userConfig, "utf8")
    const { payload } = await run(toolFor(space, { fileSystem }), {
      action: "set",
      key: "[opencode].team_mode.max_parallel_members",
      value: 6,
      confirm: true,
    })

    expect(payload.ok).toBe(false)
    expect(payload.error.code).toBe(SETTING_SURFACE_ERRORS.INERT)
    expect(fileSystem.mutations).toEqual([])
    expect(fs.readFileSync(space.userConfig, "utf8")).toBe(before)
  })

  test("#when the action is unknown #then a stable code is returned instead of a thrown error", async () => {
    const space = sandbox()
    const { payload } = await run(toolFor(space), { action: "toggle" })

    expect(payload.ok).toBe(false)
    expect(payload.error.code).toBe("SETTING_UNKNOWN_ACTION")
  })

  test("#when a project layer shadows the user placement #then the writer's ambiguity refusal reaches the caller", async () => {
    const space = sandbox()
    const shadow = path.join(space.directory, ".omo", "omo.jsonc")
    fs.mkdirSync(path.dirname(shadow), { recursive: true })
    fs.writeFileSync(shadow, `{\n  "profiles": { "gabo": { "[opencode]": { "monitor": { "enabled": true } } } }\n}\n`)
    const { payload } = await run(toolFor(space), { action: "set", key: MONITOR_ENABLED, value: true, confirm: true })

    expect(payload.ok).toBe(false)
    expect(payload.error.code).toBe(SETTING_WRITE_ERRORS.AMBIGUOUS_LAYER)
  })
})

describe("#given the rigel_setting tool registration gate", () => {
  test("#when the tool is registered #then disabled_tools removes the name and the JSON result carries metadata", async () => {
    const space = sandbox()
    const added = []
    const editor = { add: (definition) => { added.push(definition.name); return { dispose() {} } } }
    const registered = registerSettingTool(editor, { env: space.env, home: space.home, directory: space.directory })
    const denied = registerSettingTool(editor, { env: space.env, home: space.home, directory: space.directory, disabledTools: ["rigel_setting"] })
    const absent = registerSettingTool(undefined, {})
    const { result } = await run(toolFor(space), { action: "get", key: MONITOR_ENABLED })

    expect(registered).toBeTruthy()
    expect(added).toEqual(["rigel_setting"])
    expect(denied).toBeUndefined()
    expect(absent).toBeUndefined()
    expect(result.metadata).toEqual({ ok: true, action: "get", key: MONITOR_ENABLED })
  })
})
