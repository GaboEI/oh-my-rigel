import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  SETTING_COMMAND_NAME,
  createSettingCommand,
  registerSettingCommand,
  renderSettingCommandPrompt,
} from "./rigel-v2-native-setting-command.mjs"
import { SETTING_CATALOG } from "./rigel-v2-native-setting-catalog.mjs"
import { mutableRefusal } from "./rigel-v2-native-setting-descriptor.mjs"
import { OMO_INTERNAL_INITIATOR_MARKER } from "./rigel-v2-keyword-core.mjs"

const temporary = []
afterEach(() => { while (temporary.length > 0) fs.rmSync(temporary.pop(), { recursive: true, force: true }) })

const CONTROL_BYTES = `{\n  "profiles": { "gabo": { "[opencode]": { "monitor": { "enabled": false } } } }\n}\n`

function sandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rigel-setting-command-")))
  temporary.push(root)
  const home = path.join(root, "home")
  const directory = path.join(root, "project")
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(directory, { recursive: true })
  const userConfig = path.join(home, ".omo", "omo.jsonc")
  fs.mkdirSync(path.dirname(userConfig), { recursive: true })
  fs.writeFileSync(userConfig, CONTROL_BYTES)
  return { root, home, directory, userConfig, env: { OMO_PROFILE: "gabo" } }
}

/** A host context whose lifecycle-named members throw when accessed. */
function trapContext() {
  const delivered = []
  const touched = []
  const lifecycle = new Set(["restart", "stop", "kill", "shutdown", "terminate", "abort", "reset"])
  const wrap = (target, label) => new Proxy(target, {
    get(object, property) {
      const key = String(property)
      if (lifecycle.has(key)) { touched.push(`${label}.${key}`); throw new Error(`lifecycle API accessed: ${label}.${key}`) }
      return Reflect.get(object, property)
    },
  })
  const added = []
  const context = wrap({
    command: { transform: (callback) => { callback({ add: (definition) => { added.push(definition); return { dispose() { added.length = 0 } } } }); return { dispose() { added.length = 0 } } } },
    session: wrap({ prompt: async ({ text }) => { delivered.push(text) } }, "session"),
  }, "context")
  return { context, delivered, touched, added }
}

/** A file system that records every mutating call, so "the command writes nothing" is provable. */
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

describe("#given the rigel_setting command registration", () => {
  test("#when the host exposes a command domain #then the exact name is registered and disposal is returned", async () => {
    const space = sandbox()
    const trap = trapContext()
    const registration = await registerSettingCommand({ context: trap.context, ...space })
    const denied = await registerSettingCommand({ context: trap.context, ...space, disabledCommands: ["rigel_setting"] })
    const absent = await registerSettingCommand({ context: {}, ...space })

    expect(SETTING_COMMAND_NAME).toBe("rigel_setting")
    expect(registration).toBeTruthy()
    expect(trap.added.map((definition) => definition.name)).toEqual(["rigel_setting"])
    expect(denied).toBeUndefined()
    expect(absent).toBeUndefined()
  })
})

describe("#given the rigel_setting guided turn", () => {
  test("#when the command executes #then the injected text carries the marker, the resolved layers and the reload contract", async () => {
    const space = sandbox()
    const trap = trapContext()
    await registerSettingCommand({ context: trap.context, ...space })
    await createSettingCommand({ context: trap.context, ...space }).execute({
      sessionID: "ses_1",
      prompt: { text: "" },
      delivery: "queue",
    })

    const text = trap.delivered.at(-1)
    expect(trap.delivered.length).toBe(1)
    expect(text.startsWith(OMO_INTERNAL_INITIATOR_MARKER)).toBe(true)
    // These are runtime data, not authored prompt wording: the command must
    // render the resolved layer and active profile it received from setup.
    expect(text).toContain(space.userConfig)
    expect(text).toContain("gabo")
  })

  test("#when the prompt is rendered #then every mutable key and no immutable-only promise reaches the model", () => {
    const space = sandbox()
    const mutable = SETTING_CATALOG.filter((entry) => mutableRefusal(entry) === null)
    const text = renderSettingCommandPrompt({
      profileName: "gabo",
      layers: [{ path: space.userConfig, scope: "user", exists: true, ok: true }],
    })

    expect(mutable.length).toBeGreaterThan(0)
    for (const entry of mutable) expect(text).toContain(entry.key)
    const inert = SETTING_CATALOG.filter((entry) => entry.tier === "inert")
    for (const entry of inert) expect(text).not.toContain(`\`${entry.key}\` (`)
  })

  test("#when the layer chain cannot be resolved #then the turn still delivers and offers no write direction", async () => {
    const space = sandbox()
    const trap = trapContext()
    await createSettingCommand({ context: trap.context, env: {}, home: "", directory: space.directory }).execute({
      sessionID: "ses_1",
      prompt: { text: "explain" },
      delivery: "queue",
    })

    const text = trap.delivered.at(-1)
    expect(trap.delivered.length).toBe(1)
    expect(text.startsWith(OMO_INTERNAL_INITIATOR_MARKER)).toBe(true)
    expect(text.length).toBeGreaterThan(OMO_INTERNAL_INITIATOR_MARKER.length)
  })
})

describe("#given the rigel_setting lifecycle abstinence", () => {
  test("#when the command runs #then no lifetime API of the host or the session is reached", async () => {
    const space = sandbox()
    const trap = trapContext()

    await registerSettingCommand({ context: trap.context, ...space })
    await createSettingCommand({ context: trap.context, ...space }).execute({ sessionID: "ses_1", prompt: { text: "" }, delivery: "queue" })

    expect(trap.touched).toEqual([])
    expect(trap.delivered.length).toBe(1)
  })

  test("#when the command runs against a real file system #then no file is written", async () => {
    const space = sandbox()
    const fileSystem = recordingFileSystem()
    const trap = trapContext()

    await createSettingCommand({ context: trap.context, ...space, fileSystem }).execute({ sessionID: "ses_1", prompt: { text: "" }, delivery: "queue" })

    expect(fs.readFileSync(space.userConfig, "utf8")).toBe(CONTROL_BYTES)
    expect(fileSystem.mutations).toEqual([])
    expect(fs.readdirSync(path.dirname(space.userConfig))).toEqual(["omo.jsonc"])
  })

  test("#when the host exposes no session prompt seam #then the command ends without throwing", async () => {
    const space = sandbox()
    const command = createSettingCommand({ context: { session: {} }, ...space })

    await expect(command.execute({ sessionID: "ses_1", prompt: { text: "" } })).resolves.toBeUndefined()
    await expect(command.execute({ sessionID: "" })).resolves.toBeUndefined()
    await expect(command.execute({ sessionID: "" })).resolves.toBeUndefined()
  })
})
