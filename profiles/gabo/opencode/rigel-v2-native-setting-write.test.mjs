import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readJsoncValue } from "./rigel-v2-native-jsonc-edit.mjs"
import {
  SETTING_WRITE_ERRORS,
  applySettingEdit,
  planSettingEdit,
  previewSettingEdit,
  resolveSettingDescriptor,
  validateSettingValue,
} from "./rigel-v2-native-setting-write.mjs"
import {
  chooseSettingWriteTarget,
  resolveActiveProfile,
  resolveSettingPaths,
  settingPlacement,
} from "./rigel-v2-native-setting-targets.mjs"

const temporary = []
afterEach(() => { while (temporary.length > 0) fs.rmSync(temporary.pop(), { recursive: true, force: true }) })

const GOAL_ENABLED = Object.freeze({ key: "goal.enabled", type: "boolean" })
const GOAL_ITERATIONS = Object.freeze({ path: ["goal", "default_max_iterations"], type: "integer", minimum: 1, maximum: 100 })
const DISABLED_AGENTS = Object.freeze({ path: ["disabled_agents"], type: "string-list" })
const PROVIDER = Object.freeze({ path: ["websearch", "provider"], type: "enum", values: ["tavily", "exa"] })

/** A disposable home + project pair; nothing outside the temp root is read or written. */
function sandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rigel-setting-")))
  temporary.push(root)
  const home = path.join(root, "home")
  const directory = path.join(root, "project")
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(directory, { recursive: true })
  return { root, home, directory, userConfig: path.join(home, ".omo", "omo.jsonc"), env: { OMO_PROFILE: "gabo" } }
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

function projectConfig(space, text) {
  return writeFile(path.join(space.directory, ".omo", "omo.jsonc"), text)
}

/** Every mutating file-system call, in order, so "no write" is provable. */
function mutatingFileSystem() {
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

/** A real file system whose target read is corrupted after the write lands. */
function tamperingFileSystem(targetPath, transform) {
  let tampered = false
  return {
    existsSync: fs.existsSync,
    lstatSync: fs.lstatSync,
    realpathSync: fs.realpathSync,
    closeSync: fs.closeSync,
    mkdirSync: fs.mkdirSync,
    openSync: fs.openSync,
    writeFileSync: fs.writeFileSync,
    fsyncSync: fs.fsyncSync,
    rmSync: fs.rmSync,
    renameSync: (from, to) => {
      fs.renameSync(from, to)
      if (to === targetPath) tampered = true
    },
    readFileSync: (file, encoding) => {
      const text = fs.readFileSync(file, encoding)
      return tampered && file === targetPath ? transform(text) : text
    },
  }
}

/**
 * A real file system whose committed value is corrupted after the write lands
 * AND whose restore write then fails, so the rollback itself cannot land.
 */
function failedRestoreFileSystem(targetPath, transform) {
  let committed = false
  let targetRenames = 0
  return {
    existsSync: fs.existsSync,
    lstatSync: fs.lstatSync,
    realpathSync: fs.realpathSync,
    closeSync: fs.closeSync,
    mkdirSync: fs.mkdirSync,
    openSync: fs.openSync,
    writeFileSync: fs.writeFileSync,
    fsyncSync: fs.fsyncSync,
    rmSync: fs.rmSync,
    renameSync: (from, to) => {
      if (to !== targetPath) return fs.renameSync(from, to)
      targetRenames += 1
      if (targetRenames > 1) throw new Error("restore rename failed")
      fs.renameSync(from, to)
      committed = true
    },
    readFileSync: (file, encoding) => {
      const text = fs.readFileSync(file, encoding)
      return committed && file === targetPath ? transform(text) : text
    },
  }
}

/**
 * A real file system whose commit is unparseable on read AND whose restore
 * removal fails, so a created config cannot be taken back.
 */
function failedRemoveFileSystem(targetPath) {
  let committed = false
  return {
    existsSync: fs.existsSync,
    lstatSync: fs.lstatSync,
    realpathSync: fs.realpathSync,
    closeSync: fs.closeSync,
    mkdirSync: fs.mkdirSync,
    openSync: fs.openSync,
    writeFileSync: fs.writeFileSync,
    fsyncSync: fs.fsyncSync,
    renameSync: (from, to) => {
      fs.renameSync(from, to)
      if (to === targetPath) committed = true
    },
    rmSync: (file, options) => {
      if (file === targetPath) throw new Error("restore remove failed")
      return fs.rmSync(file, options)
    },
    readFileSync: (file, encoding) => {
      const text = fs.readFileSync(file, encoding)
      return committed && file === targetPath ? "{ broken" : text
    },
  }
}

function failureOf(run) {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

describe("setting profile and layer resolution", () => {
  test("#given OMO_PROFILE #when resolving #then the profile and the user config path match the native reader", () => {
    // given
    const space = sandbox()

    // when
    const paths = resolveSettingPaths({ env: space.env, home: space.home, directory: space.directory, fileSystem: fs })

    // then
    expect(paths.profileName).toBe("gabo")
    expect(paths.userPath).toBe(space.userConfig)
    expect(paths.projectPaths).toEqual([])
    expect(paths.layers.map((layer) => layer.scope)).toEqual(["user"])
  })

  test("#given OPENCODE_CONFIG_DIR #when resolving #then the reader's exact tail rule is honored", () => {
    expect(resolveActiveProfile({ env: { OPENCODE_CONFIG_DIR: "/opt/profiles/atlas" } })).toBe("atlas")
    expect(resolveActiveProfile({ env: { OPENCODE_CONFIG_DIR: "/opt/profiles/atlas/" } })).toBe("atlas")
    // the reader matches the END of the path, so a trailing segment wins over it
    expect(resolveActiveProfile({ env: { OPENCODE_CONFIG_DIR: "/opt/profiles/atlas/opencode" } })).toBeUndefined()
  })

  test("#given only the manifest #when resolving #then metadata.profile is the fallback", () => {
    expect(resolveActiveProfile({ env: {}, manifest: { metadata: { profile: "hephaestus" } } })).toBe("hephaestus")
    expect(resolveActiveProfile({ env: {} })).toBeUndefined()
  })

  test("#given nested project configs #when resolving #then the project layers are returned farthest first", () => {
    // given
    const space = sandbox()
    const inner = path.join(space.directory, "nested")
    fs.mkdirSync(inner, { recursive: true })
    const outerConfig = projectConfig(space, '{\n  "goal": { "enabled": true }\n}\n')
    const innerConfig = writeFile(path.join(inner, ".omo", "omo.jsonc"), '{\n  "goal": { "enabled": false }\n}\n')

    // when
    const paths = resolveSettingPaths({ env: space.env, home: space.home, directory: inner, fileSystem: fs })

    // then
    expect(paths.projectPaths).toEqual([outerConfig, innerConfig])
    expect(paths.layers.map((layer) => layer.scope)).toEqual(["user", "project", "project"])
  })

  test("#given a symlinked project .omo directory #when resolving #then that layer is skipped like the reader skips it", () => {
    // given
    const space = sandbox()
    const elsewhere = path.join(space.root, "elsewhere")
    fs.mkdirSync(elsewhere)
    fs.writeFileSync(path.join(elsewhere, "omo.jsonc"), '{\n  "goal": { "enabled": true }\n}\n')
    fs.symlinkSync(elsewhere, path.join(space.directory, ".omo"))

    // when
    const paths = resolveSettingPaths({ env: space.env, home: space.home, directory: space.directory, fileSystem: fs })

    // then
    expect(paths.projectPaths).toEqual([])
  })

  test("#given no home or no directory #when resolving #then the request is refused instead of defaulting to the real machine", () => {
    const space = sandbox()
    const missingHome = failureOf(() => resolveSettingPaths({ env: {}, directory: space.directory, fileSystem: fs }))
    const missingDirectory = failureOf(() => resolveSettingPaths({ env: space.env, home: space.home, fileSystem: fs }))

    expect(missingHome?.code).toBe(SETTING_WRITE_ERRORS.MISSING_HOME)
    expect(missingDirectory?.code).toBe(SETTING_WRITE_ERRORS.MISSING_DIRECTORY)
  })

  test("#given an active profile #when the placement is computed #then it is the reader's highest-precedence placement", () => {
    expect(settingPlacement("gabo")).toEqual(["profiles", "gabo", "[opencode]"])
    expect(settingPlacement(undefined)).toEqual(["[opencode]"])
  })
})

describe("setting write placement", () => {
  test("#given an active profile and an existing user config #when a boolean is set #then it lands in profiles.<active>.[opencode]", () => {
    // given
    const space = sandbox()
    writeFile(space.userConfig, '{\n  "$schema": "https://example/schema.json",\n  "profiles": {\n    "gabo": {\n      "[opencode]": { "disabled_agents": ["forja"] }\n    }\n  }\n}\n')

    // when
    const result = applySettingEdit({
      env: space.env,
      home: space.home,
      directory: space.directory,
      fileSystem: fs,
      setting: GOAL_ENABLED,
      operation: "set",
      value: true,
      confirm: true,
    })

    // then
    expect(result).toMatchObject({ changed: true, written: true, verified: true, placement: ["profiles", "gabo", "[opencode]"] })
    const written = JSON.parse(fs.readFileSync(space.userConfig, "utf8"))
    expect(written.$schema).toBe("https://example/schema.json")
    expect(written.profiles.gabo["[opencode]"].disabled_agents).toEqual(["forja"])
    expect(written.profiles.gabo["[opencode]"].goal.enabled).toBe(true)
  })

  test("#given no active profile #when a value is set #then the user [opencode] block is the target", () => {
    // given
    const space = sandbox()
    writeFile(space.userConfig, "{\n}\n")

    // when
    const result = applySettingEdit({ env: {}, home: space.home, directory: space.directory, fileSystem: fs, setting: GOAL_ENABLED, value: true, confirm: true })

    // then
    expect(result.placement).toEqual(["[opencode]"])
    expect(JSON.parse(fs.readFileSync(space.userConfig, "utf8"))["[opencode]"].goal.enabled).toBe(true)
  })

  test("#given a missing user config #when a value is set #then the file is created at mode 0600 with the full chain", () => {
    // given
    const space = sandbox()

    // when
    applySettingEdit({ env: space.env, home: space.home, directory: space.directory, fileSystem: fs, setting: GOAL_ENABLED, value: true, confirm: true })

    // then
    if (process.platform !== "win32") expect(fs.statSync(space.userConfig).mode & 0o777).toBe(0o600)
    expect(JSON.parse(fs.readFileSync(space.userConfig, "utf8"))).toEqual({ profiles: { gabo: { "[opencode]": { goal: { enabled: true } } } } })
  })

  test("#given a project layer declaring the same setting #when the write is requested #then it refuses instead of writing a shadowed value", () => {
    // given
    const space = sandbox()
    writeFile(space.userConfig, "{\n}\n")
    const shadow = projectConfig(space, '{\n  "profiles": {\n    "gabo": {\n      "[opencode]": {\n        "goal": { "enabled": false }\n      }\n    }\n  }\n}\n')
    const userBytesBefore = fs.readFileSync(space.userConfig, "utf8")

    // when
    const error = failureOf(() => applySettingEdit({ env: space.env, home: space.home, directory: space.directory, fileSystem: fs, setting: GOAL_ENABLED, value: true, confirm: true }))

    // then
    expect(error?.code).toBe(SETTING_WRITE_ERRORS.AMBIGUOUS_LAYER)
    expect(error?.details.conflicts).toEqual([shadow])
    expect(fs.readFileSync(space.userConfig, "utf8")).toBe(userBytesBefore)
  })

  test("#given a malformed project layer #when the write is requested #then it fails closed rather than assuming no shadow", () => {
    // given
    const space = sandbox()
    writeFile(space.userConfig, "{\n}\n")
    projectConfig(space, '{ "profiles": ')

    // when
    const error = failureOf(() => applySettingEdit({ env: space.env, home: space.home, directory: space.directory, fileSystem: fs, setting: GOAL_ENABLED, value: true, confirm: true }))

    // then
    expect(error?.code).toBe(SETTING_WRITE_ERRORS.PROJECT_LAYER_UNREADABLE)
  })

  test("#given a malformed user config #when the write is requested #then the bytes are untouched and the failure is reported", () => {
    // given
    const space = sandbox()
    writeFile(space.userConfig, '{ "profiles": ')
    const before = fs.readFileSync(space.userConfig, "utf8")

    // when
    const error = failureOf(() => applySettingEdit({ env: space.env, home: space.home, directory: space.directory, fileSystem: fs, setting: GOAL_ENABLED, value: true, confirm: true }))

    // then
    expect(error?.code).toBe(SETTING_WRITE_ERRORS.TARGET_UNPARSEABLE)
    expect(fs.readFileSync(space.userConfig, "utf8")).toBe(before)
  })

  test("#given a profiles value that is not an object #when the write is requested #then it refuses instead of destroying it", () => {
    // given
    const space = sandbox()
    writeFile(space.userConfig, '{\n  "profiles": ["legacy"]\n}\n')
    const before = fs.readFileSync(space.userConfig, "utf8")

    // when
    const error = failureOf(() => applySettingEdit({ env: space.env, home: space.home, directory: space.directory, fileSystem: fs, setting: GOAL_ENABLED, value: true, confirm: true }))

    // then
    expect(error?.code).toBe(SETTING_WRITE_ERRORS.TARGET_SHAPE_CONFLICT)
    expect(fs.readFileSync(space.userConfig, "utf8")).toBe(before)
  })

  test("#given a symlinked user config #when a real change is requested #then the write is refused and the link target is untouched", () => {
    // given
    const space = sandbox()
    const elsewhere = path.join(space.root, "dotfiles-omo.jsonc")
    fs.writeFileSync(elsewhere, '{\n  "profiles": {\n    "gabo": {\n      "[opencode]": {\n        "goal": { "enabled": false }\n      }\n    }\n  }\n}\n')
    fs.mkdirSync(path.dirname(space.userConfig), { recursive: true })
    fs.symlinkSync(elsewhere, space.userConfig)
    const before = fs.readFileSync(elsewhere, "utf8")

    // when
    const error = failureOf(() => applySettingEdit({ env: space.env, home: space.home, directory: space.directory, fileSystem: fs, setting: GOAL_ENABLED, value: true, confirm: true }))

    // then
    expect(error?.code).toBe("JSONC_SYMLINK_TARGET")
    expect(fs.readFileSync(elsewhere, "utf8")).toBe(before)
    expect(fs.readdirSync(path.dirname(space.userConfig))).toEqual(["omo.jsonc"])
  })

  test("#given only ~/.omo/omo.json exists #when resolving #then the json file is the target, exactly as the reader loads it", () => {
    // given
    const space = sandbox()
    const jsonPath = path.join(space.home, ".omo", "omo.json")
    writeFile(jsonPath, '{\n  "profiles": {\n    "gabo": {\n      "[opencode]": {\n        "goal": { "enabled": false }\n      }\n    }\n  }\n}\n')

    // when
    const paths = resolveSettingPaths({ env: space.env, home: space.home, directory: space.directory, fileSystem: fs })
    const result = applySettingEdit({ env: space.env, home: space.home, directory: space.directory, fileSystem: fs, setting: GOAL_ENABLED, value: true, confirm: true })

    // then
    expect(paths.userPath).toBe(jsonPath)
    expect(result.path).toBe(jsonPath)
    expect(JSON.parse(fs.readFileSync(jsonPath, "utf8")).profiles.gabo["[opencode]"].goal.enabled).toBe(true)
    expect(fs.existsSync(space.userConfig)).toBe(false)
  })

  test("#given a project layer that only declares another placement #when choosing the target #then the user [opencode] placement is used", () => {
    // given
    const space = sandbox()
    const other = projectConfig(space, '{\n  "profiles": {\n    "gabo": { "disabled_skills": ["dev-browser"] }\n  }\n}\n')
    const layers = [{ path: space.userConfig, scope: "user", ok: true, exists: true, text: "{\n}\n" }, {
      path: other,
      scope: "project",
      ok: true,
      exists: true,
      text: fs.readFileSync(other, "utf8"),
    }]

    // when
    const target = chooseSettingWriteTarget({ layers, profileName: "gabo", settingPath: ["goal", "enabled"] })

    // then
    expect(target.path).toBe(space.userConfig)
    expect(target.placement).toEqual(["profiles", "gabo", "[opencode]"])
  })
})

describe("setting edit validation", () => {
  test("#given a boolean setting #when a string is supplied #then the value is refused with a code", () => {
    const error = failureOf(() => validateSettingValue(GOAL_ENABLED, "true"))
    expect(error?.code).toBe(SETTING_WRITE_ERRORS.INVALID_VALUE)
  })

  test("#given a bounded integer #when an out-of-range number is supplied #then the range is enforced", () => {
    expect(validateSettingValue(GOAL_ITERATIONS, 10)).toBe(10)
    expect(failureOf(() => validateSettingValue(GOAL_ITERATIONS, 500))?.code).toBe(SETTING_WRITE_ERRORS.VALUE_OUT_OF_RANGE)
    expect(failureOf(() => validateSettingValue(GOAL_ITERATIONS, 10.5))?.code).toBe(SETTING_WRITE_ERRORS.INVALID_VALUE)
  })

  test("#given an enum setting #when an unknown member is supplied #then it is refused", () => {
    expect(failureOf(() => validateSettingValue(PROVIDER, "brave"))?.code).toBe(SETTING_WRITE_ERRORS.INVALID_VALUE)
    expect(validateSettingValue(PROVIDER, "exa")).toBe("exa")
  })

  test("#given a list setting #when a non-array is supplied #then it is refused", () => {
    expect(failureOf(() => validateSettingValue(DISABLED_AGENTS, "forja"))?.code).toBe(SETTING_WRITE_ERRORS.INVALID_VALUE)
    expect(validateSettingValue(DISABLED_AGENTS, ["forja"])).toEqual(["forja"])
  })

  test("#given no descriptor #when a value is validated #then the setting is unknown", () => {
    expect(failureOf(() => validateSettingValue(undefined, true))?.code).toBe(SETTING_WRITE_ERRORS.UNKNOWN_SETTING)
  })

  test("#given a catalog #when a descriptor is resolved #then map, record, and provider shapes all work", () => {
    const descriptor = { key: "goal.enabled", type: "boolean" }
    expect(resolveSettingDescriptor(new Map([["goal.enabled", descriptor]]), "goal.enabled")).toBe(descriptor)
    expect(resolveSettingDescriptor({ "goal.enabled": descriptor }, "goal.enabled")).toBe(descriptor)
    expect(resolveSettingDescriptor({ getSetting: () => descriptor }, "goal.enabled")).toBe(descriptor)
    expect(resolveSettingDescriptor(undefined, "goal.enabled")).toBeUndefined()
  })

  test("#given a scalar setting #when add or remove is requested #then the operation is refused", () => {
    // given
    const space = sandbox()
    writeFile(space.userConfig, "{\n}\n")

    // when
    const error = failureOf(() => planSettingEdit({ descriptor: GOAL_ENABLED, operation: "add", value: true, text: "{\n}\n", prefix: ["[opencode]"] }))

    // then
    expect(error?.code).toBe(SETTING_WRITE_ERRORS.UNSUPPORTED_TYPE)
    expect(space.userConfig.length).toBeGreaterThan(0)
  })
})

describe("setting write idempotency and confirmation", () => {
  test("#given the same value already effective #when set again #then nothing is written and no backup is made", () => {
    // given
    const space = sandbox()
    writeFile(space.userConfig, '{\n  "profiles": {\n    "gabo": {\n      "[opencode]": {\n        "goal": { "enabled": true }\n      }\n    }\n  }\n}\n')
    const fileSystem = mutatingFileSystem()

    // when
    const result = applySettingEdit({ env: space.env, home: space.home, directory: space.directory, fileSystem, setting: GOAL_ENABLED, value: true, confirm: true })

    // then
    expect(result).toMatchObject({ changed: false, written: false, backupPath: null })
    expect(fileSystem.mutations).toEqual([])
    expect(fs.readdirSync(path.dirname(space.userConfig))).toEqual(["omo.jsonc"])
  })

  test("#given an already-listed entry #when added again #then the list is untouched and zero writes happen", () => {
    // given
    const space = sandbox()
    writeFile(space.userConfig, '{\n  "profiles": {\n    "gabo": {\n      "[opencode]": { "disabled_agents": ["forja"] }\n    }\n  }\n}\n')
    const fileSystem = mutatingFileSystem()

    // when
    const result = applySettingEdit({ env: space.env, home: space.home, directory: space.directory, fileSystem, setting: DISABLED_AGENTS, operation: "add", value: "forja", confirm: true })

    // then
    expect(result.changed).toBe(false)
    expect(fileSystem.mutations).toEqual([])
  })

  test("#given an absent list entry #when removed #then the list is untouched and zero writes happen", () => {
    // given
    const space = sandbox()
    writeFile(space.userConfig, '{\n  "profiles": {\n    "gabo": {\n      "[opencode]": { "disabled_agents": ["forja"] }\n    }\n  }\n}\n')
    const fileSystem = mutatingFileSystem()

    // when
    const result = applySettingEdit({ env: space.env, home: space.home, directory: space.directory, fileSystem, setting: DISABLED_AGENTS, operation: "remove", value: "oracle", confirm: true })

    // then
    expect(result.changed).toBe(false)
    expect(fileSystem.mutations).toEqual([])
  })

  test("#given no explicit confirmation #when a real change is requested #then it refuses before touching the file", () => {
    // given
    const space = sandbox()
    writeFile(space.userConfig, "{\n}\n")
    const fileSystem = mutatingFileSystem()

    // when
    const error = failureOf(() => applySettingEdit({ env: space.env, home: space.home, directory: space.directory, fileSystem, setting: GOAL_ENABLED, value: true }))

    // then
    expect(error?.code).toBe(SETTING_WRITE_ERRORS.CONFIRMATION_REQUIRED)
    expect(fileSystem.mutations).toEqual([])
  })

  test("#given a preview #when requested #then it reports the exact before/after without writing anything", () => {
    // given
    const space = sandbox()
    const original = '{\n  "[opencode]": { "goal": { "enabled": false } }\n}\n'
    writeFile(space.userConfig, original)
    const fileSystem = mutatingFileSystem()

    // when
    const preview = previewSettingEdit({ env: {}, home: space.home, directory: space.directory, fileSystem, setting: GOAL_ENABLED, value: true })

    // then
    expect(preview).toMatchObject({ changed: true, before: false, after: true })
    expect(fileSystem.mutations).toEqual([])
    expect(fs.readFileSync(space.userConfig, "utf8")).toBe(original)
  })
})

describe("setting write commit, backup, and rollback", () => {
  test("#given a real change #when committed #then a 0600 backup holds the previous bytes", () => {
    // given
    const space = sandbox()
    const original = '{\n  "profiles": {\n    "gabo": {\n      "[opencode]": {\n        "goal": { "enabled": false }\n      }\n    }\n  }\n}\n'
    writeFile(space.userConfig, original)

    // when
    const result = applySettingEdit({ env: space.env, home: space.home, directory: space.directory, fileSystem: fs, setting: GOAL_ENABLED, value: true, confirm: true, now: () => new Date("2026-01-02T03:04:05.678Z") })

    // then
    expect(result.backupPath).toBe(`${space.userConfig}.bak.2026-01-02T03-04-05-678Z`)
    expect(fs.readFileSync(result.backupPath, "utf8")).toBe(original)
    if (process.platform !== "win32") expect(fs.statSync(result.backupPath).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(space.userConfig, "utf8")).toContain('"enabled": true')
  })

  test("#given a config with comments, a BOM, and CRLF #when a value is set #then the author's envelope survives", () => {
    // given
    const space = sandbox()
    const original = '\ufeff{\r\n  // user notes\r\n  "profiles": {\r\n    "gabo": {\r\n      "[opencode]": {\r\n        "goal": { "enabled": false }\r\n      }\r\n    }\r\n  }\r\n}\r\n'
    writeFile(space.userConfig, original)

    // when
    applySettingEdit({ env: space.env, home: space.home, directory: space.directory, fileSystem: fs, setting: GOAL_ENABLED, value: true, confirm: true })

    // then
    const text = fs.readFileSync(space.userConfig, "utf8")
    expect(text.charCodeAt(0)).toBe(0xfeff)
    expect(text).toContain("// user notes")
    expect(text.includes("\n") && !text.replace(/\r\n/g, "").includes("\n")).toBe(true)
    expect(readJsoncValue(text, ["profiles", "gabo", "[opencode]", "goal", "enabled"]).value).toBe(true)
  })

  test("#given an atomic write failure #when committed #then the target is untouched and no backup is left behind", () => {
    // given
    const space = sandbox()
    const original = '{\n  "profiles": {\n    "gabo": {\n      "[opencode]": {\n        "goal": { "enabled": false }\n      }\n    }\n  }\n}\n'
    writeFile(space.userConfig, original)
    const failing = {
      existsSync: fs.existsSync,
      lstatSync: fs.lstatSync,
      readFileSync: fs.readFileSync,
      realpathSync: fs.realpathSync,
      closeSync: fs.closeSync,
      mkdirSync: fs.mkdirSync,
      openSync: fs.openSync,
      writeFileSync: fs.writeFileSync,
      fsyncSync: fs.fsyncSync,
      rmSync: fs.rmSync,
      renameSync: () => { throw new Error("rename failed") },
    }

    // when
    const error = failureOf(() => applySettingEdit({ env: space.env, home: space.home, directory: space.directory, fileSystem: failing, setting: GOAL_ENABLED, value: true, confirm: true }))

    // then
    expect(error?.code).toBe("JSONC_WRITE_FAILED")
    expect(fs.readFileSync(space.userConfig, "utf8")).toBe(original)
    expect(fs.readdirSync(path.dirname(space.userConfig))).toEqual(["omo.jsonc"])
  })

  test("#given a write the file system corrupts #when verified #then the previous bytes are restored and the backup removed", () => {
    // given
    const space = sandbox()
    const original = '{\n  "profiles": {\n    "gabo": {\n      "[opencode]": {\n        "goal": { "enabled": false }\n      }\n    }\n  }\n}\n'
    writeFile(space.userConfig, original)
    const tampering = tamperingFileSystem(space.userConfig, (text) => text.replace('"enabled": true', '"enabled": false'))

    // when
    const error = failureOf(() => applySettingEdit({ env: space.env, home: space.home, directory: space.directory, fileSystem: tampering, setting: GOAL_ENABLED, value: true, confirm: true }))

    // then
    expect(error?.code).toBe(SETTING_WRITE_ERRORS.VERIFY_FAILED)
    expect(error?.details.rolledBack).toBe(true)
    expect(fs.readFileSync(space.userConfig, "utf8")).toBe(original)
    expect(fs.readdirSync(path.dirname(space.userConfig))).toEqual(["omo.jsonc"])
  })

  test("#given a restore that cannot land #when verification fails #then the backup is kept and the modified state is reported", () => {
    // given
    const space = sandbox()
    const original = '{\n  "profiles": {\n    "gabo": {\n      "[opencode]": {\n        "goal": { "enabled": false }\n      }\n    }\n  }\n}\n'
    writeFile(space.userConfig, original)
    const failing = failedRestoreFileSystem(space.userConfig, (text) => text.replace('"enabled": true', '"enabled": false'))

    // when
    const error = failureOf(() => applySettingEdit({ env: space.env, home: space.home, directory: space.directory, fileSystem: failing, setting: GOAL_ENABLED, value: true, confirm: true, now: () => new Date("2026-01-02T03:04:05.678Z") }))

    // then
    expect(error?.code).toBe(SETTING_WRITE_ERRORS.ROLLBACK_FAILED)
    expect(error?.details.rolledBack).toBe(false)
    expect(error?.details.configModified).toBe(true)
    expect(error?.details.backupPath).toBe(`${space.userConfig}.bak.2026-01-02T03-04-05-678Z`)
    expect(fs.readFileSync(error.details.backupPath, "utf8")).toBe(original)
    expect(fs.readFileSync(space.userConfig, "utf8")).toContain('"enabled": true')
    expect(error?.cause?.code).toBe(SETTING_WRITE_ERRORS.ROLLBACK_FAILED)
    expect(fs.readdirSync(path.dirname(space.userConfig)).sort()).toEqual(["omo.jsonc", "omo.jsonc.bak.2026-01-02T03-04-05-678Z"])
  })

  test("#given a created config whose restore remove fails #when verification fails #then no backup exists and the stray file is reported", () => {
    // given
    const space = sandbox()
    const failing = failedRemoveFileSystem(space.userConfig)

    // when
    const error = failureOf(() => applySettingEdit({ env: space.env, home: space.home, directory: space.directory, fileSystem: failing, setting: GOAL_ENABLED, value: true, confirm: true }))

    // then
    expect(error?.code).toBe(SETTING_WRITE_ERRORS.ROLLBACK_FAILED)
    expect(error?.details.rolledBack).toBe(false)
    expect(error?.details.configModified).toBe(true)
    expect(error?.details.backupPath).toBeNull()
    expect(fs.readFileSync(space.userConfig, "utf8")).toContain('"enabled": true')
    expect(fs.readdirSync(path.dirname(space.userConfig))).toEqual(["omo.jsonc"])
  })

  test("#given a created config the file system corrupts #when verified #then the created file is removed", () => {
    // given
    const space = sandbox()
    const tampering = tamperingFileSystem(space.userConfig, () => "{ broken")

    // when
    const error = failureOf(() => applySettingEdit({ env: space.env, home: space.home, directory: space.directory, fileSystem: tampering, setting: GOAL_ENABLED, value: true, confirm: true }))

    // then
    expect(error?.code).toBe(SETTING_WRITE_ERRORS.VERIFY_FAILED)
    expect(fs.existsSync(space.userConfig)).toBe(false)
  })

  test("#given a list setting #when an entry is added and then removed #then the list grows and shrinks around the entry", () => {
    // given
    const space = sandbox()
    writeFile(space.userConfig, '{\n  "profiles": {\n    "gabo": {\n      "[opencode]": { "disabled_agents": ["forja"] }\n    }\n  }\n}\n')
    const options = { env: space.env, home: space.home, directory: space.directory, fileSystem: fs, setting: DISABLED_AGENTS, confirm: true }

    // when
    applySettingEdit({ ...options, operation: "add", value: "prometheus" })
    const afterAdd = JSON.parse(fs.readFileSync(space.userConfig, "utf8")).profiles.gabo["[opencode]"].disabled_agents
    applySettingEdit({ ...options, operation: "remove", value: "forja" })
    const afterRemove = JSON.parse(fs.readFileSync(space.userConfig, "utf8")).profiles.gabo["[opencode]"].disabled_agents

    // then
    expect(afterAdd).toEqual(["forja", "prometheus"])
    expect(afterRemove).toEqual(["prometheus"])
  })

  test("#given a config without the list #when an entry is added #then the list is created, verified, and written", () => {
    // given
    const space = sandbox()
    writeFile(space.userConfig, '{\n  "profiles": {\n    "gabo": {}\n  }\n}\n')

    // when
    const result = applySettingEdit({ env: space.env, home: space.home, directory: space.directory, fileSystem: fs, setting: DISABLED_AGENTS, operation: "add", value: "forja", confirm: true })

    // then
    expect(result).toMatchObject({ changed: true, written: true, verified: true, after: ["forja"] })
    expect(result.before).toBeUndefined()
    expect(JSON.parse(fs.readFileSync(space.userConfig, "utf8")).profiles.gabo["[opencode]"].disabled_agents).toEqual(["forja"])
  })

  test("#given a scalar removal #when committed #then the key is deleted and the default is reported as the effective value", () => {
    // given
    const space = sandbox()
    writeFile(space.userConfig, '{\n  "profiles": {\n    "gabo": {\n      "[opencode]": {\n        "goal": { "enabled": true, "auto_start": false }\n      }\n    }\n  }\n}\n')

    // when
    const result = applySettingEdit({
      env: space.env,
      home: space.home,
      directory: space.directory,
      fileSystem: fs,
      setting: { path: ["goal", "auto_start"], type: "boolean", default: true },
      operation: "remove",
      confirm: true,
    })

    // then
    expect(result).toMatchObject({ changed: true, written: true, after: true })
    expect(JSON.parse(fs.readFileSync(space.userConfig, "utf8")).profiles.gabo["[opencode]"].goal).toEqual({ enabled: true })
  })
})
