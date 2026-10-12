import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  MODELS_RELOAD_COMMANDS,
  applyModelsEdit,
  commitModelsEdit,
  createModelsCommand,
  readModelsConfig,
  registerModelsCommand,
  renderModelsCommandPrompt,
  summarizeModelChanges,
  validateModelsConfig,
  writeModelsConfigAtomic,
} from "./rigel-v2-native-models-command.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULE_SOURCE = fs.readFileSync(path.join(HERE, "rigel-v2-native-models-command.mjs"), "utf8")

// Every agent the active turn may run under. `/rmo-models` registers once,
// globally, and must behave identically no matter which of these is active.
const AGENT_TYPES = Object.freeze([
  "sisyphus", "hephaestus", "prometheus", "atlas", "judge", "plan", "build",
  "oracle", "explore", "librarian", "momus", "multimodal-looker",
])

const temporary = []
afterEach(() => { while (temporary.length > 0) fs.rmSync(temporary.pop(), { recursive: true, force: true }) })

function workspace(prefix = "rigel-models-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporary.push(root)
  return root
}

/** A read-only in-memory fileSystem so no test ever reads the real home. */
function memoryReadFs(files = {}) {
  const map = new Map(Object.entries(files))
  return {
    map,
    existsSync: (file) => map.has(file),
    readFileSync: (file) => {
      if (!map.has(file)) throw new Error(`ENOENT: ${file}`)
      return map.get(file)
    },
  }
}

/** Records any write primitive, so "no write happened" is observable. */
function forbiddenWriteFs() {
  const calls = []
  const record = (name) => (...args) => { calls.push(name); throw new Error(`unexpected write: ${name}(${args.length})`) }
  return {
    calls,
    mkdirSync: record("mkdirSync"),
    openSync: record("openSync"),
    writeFileSync: record("writeFileSync"),
    fsyncSync: record("fsyncSync"),
    closeSync: record("closeSync"),
    renameSync: record("renameSync"),
    rmSync: record("rmSync"),
  }
}

/** A context whose lifecycle-named members throw when accessed. */
function trapContext() {
  const delivered = []
  const touched = []
  const lifecycle = new Set(["restart", "stop", "kill", "shutdown", "terminate", "abort", "reset"])
  const wrap = (target, label) => new Proxy(target, {
    get(obj, prop) {
      const key = String(prop)
      if (lifecycle.has(key)) { touched.push(`${label}.${key}`); throw new Error(`lifecycle API accessed: ${label}.${key}`) }
      return Reflect.get(obj, prop)
    },
  })
  const context = wrap({
    command: { transform: (callback) => { callback({ add: () => {} }); return { dispose() {} } } },
    session: wrap({ prompt: async ({ text }) => { delivered.push(text) } }, "session"),
  }, "context")
  return { context, delivered, touched }
}

describe("rmo-models reload contract", () => {
  test("carries only the two verified reload commands and never the nonexistent reset", () => {
    // given the verified OpenCode v2.0.26 reload surface
    // when read from the exported contract
    // then only the two real commands are present
    expect(MODELS_RELOAD_COMMANDS.reload).toBe("opencode reload")
    expect(MODELS_RELOAD_COMMANDS.serviceRestart).toBe("opencode service restart")
    expect(JSON.stringify(MODELS_RELOAD_COMMANDS)).not.toContain("opencode server reset")
    expect(JSON.stringify(MODELS_RELOAD_COMMANDS)).not.toContain("server reset")
  })
})

describe("rmo-models guided prompt", () => {
  test("embeds the current agents block and ends with the verified reload commands", () => {
    // given a loaded config with one pinned agent
    const read = { ok: true, exists: true, agents: { sisyphus: { model: "anthropic/claude-opus-4-6" } } }

    // when the command prompt is rendered
    const text = renderModelsCommandPrompt({ path: "/home/user/.omo/omo.jsonc", read, userText: "sisyphus" })

    // then the current state and both verified commands are machine-visible, and no reset is present
    expect(text).toContain('"anthropic/claude-opus-4-6"')
    expect(text).toContain("/home/user/.omo/omo.jsonc")
    expect(text).toContain(MODELS_RELOAD_COMMANDS.reload)
    expect(text).toContain(MODELS_RELOAD_COMMANDS.serviceRestart)
    expect(text).not.toContain("server reset")
  })

  test("a malformed read is reported as uneditable instead of throwing", () => {
    // given an unreadable config state
    const read = { ok: false, exists: true, agents: null, reason: "Unexpected token" }

    // when the prompt is rendered
    const text = renderModelsCommandPrompt({ path: "/home/user/.omo/omo.jsonc", read })

    // then it says so and still shows the reload commands
    expect(text).toContain("Unexpected token")
    expect(text).toContain(MODELS_RELOAD_COMMANDS.serviceRestart)
  })
})

describe("rmo-models config read", () => {
  test("parses JSONC comments and trailing commas and preserves every field un-narrowed", () => {
    // given a JSONC file with comments, a trailing comma, and an unknown field
    const file = "/home/user/.omo/omo.jsonc"
    const text = `{
  // pin the orchestrator
  "agents": {
    "sisyphus": { "model": "anthropic/claude-opus-4-6", "custom_extension": { "a": 1 }, },
  },
}`
    const fsImpl = memoryReadFs({ [file]: text })

    // when read
    const result = readModelsConfig(fsImpl, file)

    // then every field survives verbatim
    expect(result.ok).toBe(true)
    expect(result.exists).toBe(true)
    expect(result.agents.sisyphus.model).toBe("anthropic/claude-opus-4-6")
    expect(result.agents.sisyphus.custom_extension).toEqual({ a: 1 })
  })

  test("a missing file is an explicit no-op state, not an error", () => {
    // given no file exists
    // when read
    const result = readModelsConfig(memoryReadFs(), "/home/user/.omo/omo.jsonc")
    // then it is reported as absent with an empty agents block
    expect(result.ok).toBe(true)
    expect(result.exists).toBe(false)
    expect(result.agents).toEqual({})
  })

  test("malformed JSONC returns ok:false without throwing", () => {
    // given a broken file
    const file = "/home/user/.omo/omo.jsonc"
    // when read
    const result = readModelsConfig(memoryReadFs({ [file]: "{ not json" }), file)
    // then it degrades to a reason instead of an exception
    expect(result.ok).toBe(false)
    expect(typeof result.reason).toBe("string")
  })
})

describe("rmo-models validation", () => {
  test("a well-formed block with an extension field validates with a warning only", () => {
    // given valid model fields plus one unrecognized field
    const agents = { sisyphus: { model: "anthropic/claude-opus-4-6", models: ["a/b", { model: "c/d" }], custom_extension: true } }
    // when validated
    const result = validateModelsConfig(agents)
    // then it is ok with a warning naming the extra field
    expect(result.ok).toBe(true)
    expect(result.warnings).toContainEqual(expect.objectContaining({ agent: "sisyphus", field: "custom_extension" }))
  })

  test("type violations on known fields are errors", () => {
    // given a bad model, bad fallback chain, and an out-of-range temperature
    const agents = { sisyphus: { model: 42, fallback_models: [123], temperature: 5 } }
    // when validated
    const result = validateModelsConfig(agents)
    // then every violation is an error
    expect(result.ok).toBe(false)
    expect(result.errors.map((entry) => entry.field).sort()).toEqual(["fallback_models", "model", "temperature"])
  })

  test("a non-object agents block is rejected", () => {
    // given a non-object
    // when validated
    const result = validateModelsConfig(null)
    // then it fails closed
    expect(result.ok).toBe(false)
  })
})

describe("rmo-models change summary", () => {
  test("reports the exact per-agent before/after fields that change", () => {
    // given a before and after with a changed field, an added agent, and a removed field
    const before = { sisyphus: { model: "anthropic/claude-opus-4-6", variant: "high" }, hephaestus: { model: "gpt-5" } }
    const after = { sisyphus: { model: "anthropic/claude-sonnet-4-6" }, hephaestus: { model: "gpt-5" }, atlas: { model: "x/y" } }

    // when summarized
    const changes = summarizeModelChanges(before, after)

    // then the list is exact, ordered, and complete
    expect(changes).toEqual([
      { agent: "atlas", field: "model", kind: "added", before: undefined, after: "x/y" },
      { agent: "sisyphus", field: "model", kind: "changed", before: "anthropic/claude-opus-4-6", after: "anthropic/claude-sonnet-4-6" },
      { agent: "sisyphus", field: "variant", kind: "removed", before: "high", after: undefined },
    ])
  })

  test("an identical block yields no changes", () => {
    // given the same block on both sides
    const block = { sisyphus: { model: "a/b" } }
    // when summarized
    // then nothing changed
    expect(summarizeModelChanges(block, structuredClone(block))).toEqual([])
  })
})

describe("rmo-models edit application", () => {
  test("changes only the named field and preserves every other agent and field", () => {
    // given a config with two agents and extra fields
    const source = JSON.stringify({ agents: { sisyphus: { model: "old/model", variant: "high" }, hephaestus: { model: "gpt-5", temperature: 0.3 } } })

    // when only sisyphus.model is edited
    const result = applyModelsEdit(source, { agents: { sisyphus: { model: "new/model" } } })

    // then everything else survives
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.agents.sisyphus.model).toBe("new/model")
    expect(result.agents.sisyphus.variant).toBe("high")
    expect(result.agents.hephaestus).toEqual({ model: "gpt-5", temperature: 0.3 })
  })

  test("adds and removes whole agents, replacing an array field wholesale", () => {
    // given a config with an existing chain
    const source = JSON.stringify({ agents: { sisyphus: { models: ["a/b"] }, oracle: { model: "o/r" } } })

    // when an agent is added, another removed, and the chain replaced
    const result = applyModelsEdit(source, { agents: { sisyphus: { models: ["c/d", "e/f"] }, oracle: null, atlas: { model: "x/y" } } })

    // then the array is replaced and the removed agent is gone
    expect(result.agents.sisyphus.models).toEqual(["c/d", "e/f"])
    expect(result.agents.oracle).toBeUndefined()
    expect(result.agents.atlas).toEqual({ model: "x/y" })
  })

  test("an empty or identity edit is a no-op that returns the original text", () => {
    // given a source and an empty edit
    const source = JSON.stringify({ agents: { sisyphus: { model: "a/b" } } })
    // when applied
    const empty = applyModelsEdit(source, { agents: {} })
    const identity = applyModelsEdit(source, { agents: { sisyphus: { model: "a/b" } } })
    // then neither changes and both keep the original bytes
    expect(empty.changed).toBe(false)
    expect(empty.text).toBe(source)
    expect(identity.changed).toBe(false)
    expect(identity.text).toBe(source)
  })

  test("a malformed source is returned unchanged with ok:false and no throw", () => {
    // given broken text
    // when applied
    const result = applyModelsEdit("{ broken", { agents: { sisyphus: { model: "a/b" } } })
    // then it fails cleanly with the source preserved
    expect(result.ok).toBe(false)
    expect(result.text).toBe("{ broken")
  })
})

describe("rmo-models commit safety", () => {
  test("a cancel or no-op performs no write at all", () => {
    // given a write-forbidding fileSystem and an edit that changes nothing
    const source = JSON.stringify({ agents: { sisyphus: { model: "a/b" } } })
    const writeFs = forbiddenWriteFs()

    // when committed with an empty edit
    const result = commitModelsEdit({ fileSystem: writeFs, filePath: "/tmp/never", currentText: source, edit: { agents: {} } })

    // then nothing was written
    expect(result.written).toBe(false)
    expect(writeFs.calls).toEqual([])
  })

  test("a malformed source is a no-write, no-throw failure", () => {
    // given broken text and a write-forbidding fileSystem
    const writeFs = forbiddenWriteFs()
    // when committed
    const result = commitModelsEdit({ fileSystem: writeFs, filePath: "/tmp/never", currentText: "{ broken", edit: { agents: { a: { model: "x/y" } } } })
    // then it reports failure without touching the disk
    expect(result.ok).toBe(false)
    expect(result.written).toBe(false)
    expect(writeFs.calls).toEqual([])
  })

  test("a real edit writes atomically and keeps untouched files intact", () => {
    // given a temp config file with another agent present
    const root = workspace()
    const file = path.join(root, "omo.jsonc")
    fs.writeFileSync(file, JSON.stringify({ agents: { hephaestus: { model: "gpt-5" } } }))

    // when a new agent is committed
    const result = commitModelsEdit({ fileSystem: fs, filePath: file, currentText: fs.readFileSync(file, "utf8"), edit: { agents: { sisyphus: { model: "a/b" } } } })

    // then the new field landed and the untouched agent survived
    expect(result.written).toBe(true)
    const written = JSON.parse(fs.readFileSync(file, "utf8"))
    expect(written.agents.sisyphus.model).toBe("a/b")
    expect(written.agents.hephaestus.model).toBe("gpt-5")
  })
})

describe("rmo-models atomic write", () => {
  test("replaces the target with the complete content", () => {
    // given a target with old content
    const root = workspace()
    const file = path.join(root, "omo.jsonc")
    fs.writeFileSync(file, "old")
    const next = `${JSON.stringify({ agents: { sisyphus: { model: "a/b" } } }, null, 2)}\n`

    // when written atomically
    writeModelsConfigAtomic(file, next, { fileSystem: fs })

    // then the target holds the full new content
    expect(fs.readFileSync(file, "utf8")).toBe(next)
  })

  test("a failed rename leaves the target unchanged and no temp file behind", () => {
    // given an existing target and a fileSystem whose rename always fails
    const root = workspace()
    const file = path.join(root, "omo.jsonc")
    fs.writeFileSync(file, "original")
    const failingFs = {
      mkdirSync: fs.mkdirSync,
      openSync: fs.openSync,
      writeFileSync: fs.writeFileSync,
      fsyncSync: fs.fsyncSync,
      closeSync: fs.closeSync,
      rmSync: fs.rmSync,
      renameSync: () => { throw new Error("rename failed") },
    }

    // when the atomic write fails at the rename boundary
    expect(() => writeModelsConfigAtomic(file, "next", { fileSystem: failingFs })).toThrow("rename failed")

    // then the original is intact and no partial temp file survives
    expect(fs.readFileSync(file, "utf8")).toBe("original")
    const leftovers = fs.readdirSync(root).filter((name) => name.includes(".tmp-"))
    expect(leftovers).toEqual([])
  })
})

describe("rmo-models command execution", () => {
  test("is usable from every agent type and delivers the guided turn each time", async () => {
    // given a command built over a read-only in-memory config
    const delivered = []
    const context = { session: { prompt: async ({ text }) => { delivered.push(text) } } }
    const command = createModelsCommand({
      context,
      fileSystem: memoryReadFs({ "/home/user/.omo/omo.jsonc": JSON.stringify({ agents: { sisyphus: { model: "a/b" } } }) }),
      modelsPath: "/home/user/.omo/omo.jsonc",
    })

    // when invoked once from each agent type
    for (const agent of AGENT_TYPES) {
      await command.execute({ sessionID: "ses_1", prompt: { text: agent, agent }, delivery: "queue" })
    }

    // then every active agent got the same guided turn
    expect(delivered.length).toBe(AGENT_TYPES.length)
    for (const text of delivered) expect(text).toContain(MODELS_RELOAD_COMMANDS.serviceRestart)
  })

  test("an empty session id is ignored without touching the session", async () => {
    // given a recording context
    const delivered = []
    const context = { session: { prompt: async ({ text }) => { delivered.push(text) } } }
    const command = createModelsCommand({ context, fileSystem: memoryReadFs(), modelsPath: "/home/user/.omo/omo.jsonc" })

    // when invoked without a session id
    await command.execute({ sessionID: "", prompt: { text: "x" } })

    // then nothing is delivered
    expect(delivered).toEqual([])
  })

  test("registration honors disabled_commands and no-ops without a command domain", async () => {
    // given a host with a command domain
    let added
    const context = { command: { transform: (callback) => { callback({ add: (definition) => { added = definition } }); return { dispose() {} } } } }

    // when registered, then denied, then registered without a domain
    const registration = await registerModelsCommand({ context, fileSystem: memoryReadFs() })
    const denied = await registerModelsCommand({ context, fileSystem: memoryReadFs(), disabledCommands: ["rmo-models"] })
    const absent = await registerModelsCommand({ context: {}, fileSystem: memoryReadFs() })

    // then only the eligible registration lands, under the expected name
    expect(registration).toBeTruthy()
    expect(added?.name).toBe("rmo-models")
    expect(denied).toBeUndefined()
    expect(absent).toBeUndefined()
  })

  test("never terminates, restarts, or touches a lifecycle API of the active session", async () => {
    // given a context whose lifecycle-named members throw on access
    const trap = trapContext()

    // when the command is registered and executed
    await registerModelsCommand({ context: trap.context, fileSystem: memoryReadFs() })
    const command = createModelsCommand({ context: trap.context, fileSystem: memoryReadFs(), modelsPath: "/home/user/.omo/omo.jsonc" })
    await command.execute({ sessionID: "ses_1", prompt: { text: "sisyphus" }, delivery: "queue" })

    // then the only session surface used is prompt, and no lifecycle member was reached
    expect(trap.touched).toEqual([])
    expect(trap.delivered.length).toBe(1)
  })

  test("the module source references no restart/stop/kill lifecycle API", () => {
    // given the module source
    // when scanned for a lifecycle-invoking call shape
    const lifecycleCall = /\bprocess\.kill\b|\bchild_process\b|\bspawnSync\b|\bspawn\s*\(|\bexecSync\b|\bexec\s*\(|\b(?:restart|stop|shutdown|terminate|kill)\s*\(/i
    // then none is present (the reload commands are strings, never calls)
    expect(lifecycleCall.test(MODULE_SOURCE)).toBe(false)
  })
})
