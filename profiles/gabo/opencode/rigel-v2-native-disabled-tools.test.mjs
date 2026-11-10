/**
 * Live `disabled_tools` authority (Codex finding).
 *
 * `resolveNativeDisabledLists` has reported a LIVE `tools` denylist since phase
 * 4, but nothing consumed it: registration used the baked manifest and the
 * permission wiring derived only from the installed manifest, so a tool added to
 * `disabled_tools` AFTER install stayed listed and callable. These cases pin the
 * two surfaces that now consume the live list — registration (V1
 * `filterDisabledTools` parity: the tool never reaches the host registry) and
 * execution (the `tool.execute.before` gate refuses the name ahead of every
 * permission layer) — and the baked behavior when no live declaration exists.
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin, { createDisabledToolEditor, createNativePermissionWiring } from "./rigel-v2-native.mjs"
import {
  TOOL_DISABLED_BY_CONFIG,
  createDisabledToolSet,
  createNativeToolPermissionGate,
} from "./rigel-v2-native-permissions.mjs"
import { buildConditionalToolDefinitions } from "./rigel-v2-native-conditional-tools.mjs"

async function captureError(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("expected the call to be refused")
}

describe("#given a declared disabled_tools list", () => {
  test("#when it is normalized #then only exact non-blank names survive", () => {
    // given
    const declared = ["interactive_bash", "  todowrite  ", "", 7, null, "   "]
    // when
    const set = createDisabledToolSet(declared)
    // then
    expect([...set]).toEqual(["interactive_bash", "todowrite"])
    // An absent or malformed record disables nothing, so a caller can never crash
    // on it: the resolver already fail-closed to the installed list upstream.
    expect(createDisabledToolSet(undefined).size).toBe(0)
    expect(createDisabledToolSet("interactive_bash").size).toBe(0)
  })
})

describe("#given a tool only the LIVE denylist disables", () => {
  test("#when the agent and the global tools record both allow it #then the config deny still wins", async () => {
    // given: both permission layers say allow, which is exactly the state a
    // live-only disable creates over an install-time manifest
    const gate = createNativeToolPermissionGate({
      globalGates: [{ pattern: "interactive_bash", effect: "allow" }],
      disabledTools: ["interactive_bash"],
    })
    gate.registerAgent("sisyphus", {
      toolGates: [{ pattern: "interactive_bash", effect: "allow" }, { pattern: "*", effect: "allow" }],
    })
    // when
    const denied = await captureError(gate.before({ tool: "interactive_bash", agent: "sisyphus" }))
    // then
    expect(denied.code).toBe(TOOL_DISABLED_BY_CONFIG)
    expect(denied.message).toContain("tool=interactive_bash")
    // A name the list does not carry is unaffected by it.
    await expect(gate.before({ tool: "todowrite", agent: "sisyphus" })).resolves.toBeUndefined()
  })

  test("#when the call carries no agent identity #then the deny is reported as disabled, not as unresolved identity", async () => {
    // given
    const gate = createNativeToolPermissionGate({ globalGates: [{ pattern: "read", effect: "allow" }], disabledTools: ["read"] })
    // when
    const denied = await captureError(gate.before({ tool: "read", sessionID: "ses_1" }))
    // then
    expect(denied.code).toBe(TOOL_DISABLED_BY_CONFIG)
  })

  test("#when a wildcard entry is declared #then it disables no concrete tool", async () => {
    // given V1 `filterDisabledTools` matches exact names only
    const gate = createNativeToolPermissionGate({ disabledTools: ["task_*"] })
    // when / then
    await expect(gate.before({ tool: "task_create", agent: "sisyphus" })).resolves.toBeUndefined()
  })
})

describe("#given the runtime permission wiring", () => {
  test("#when it is built from the live denylist #then the disabled tool is refused for the agent that allows it", async () => {
    // given a manifest that still allows the tool (the install-time bake)
    const manifest = {
      agents: { sisyphus: { name: "Sisyphus", mode: "primary", permission: { interactive_bash: "allow" } } },
      metadata: { global: { tools: { interactive_bash: true } } },
    }
    // when
    const wiring = createNativePermissionWiring({ manifest, disabledTools: ["interactive_bash"] })
    wiring.onAgentPermissions("sisyphus", { toolGates: [{ pattern: "interactive_bash", effect: "allow" }] })
    // then
    expect(wiring.disabledTools).toEqual(["interactive_bash"])
    const denied = await captureError(wiring.before({ tool: "interactive_bash", agent: "sisyphus" }))
    expect(denied.code).toBe(TOOL_DISABLED_BY_CONFIG)
    await expect(wiring.before({ tool: "read", agent: "sisyphus" })).resolves.toBeUndefined()
  })

  test("#when no live denylist is supplied #then the wiring behaves exactly as the baked manifest says", async () => {
    // given
    const manifest = {
      agents: { sisyphus: { name: "Sisyphus", mode: "primary", permission: { interactive_bash: "allow" } } },
    }
    // when
    const wiring = createNativePermissionWiring({ manifest })
    wiring.onAgentPermissions("sisyphus", { toolGates: [{ pattern: "interactive_bash", effect: "allow" }] })
    // then
    expect(wiring.disabledTools).toEqual([])
    await expect(wiring.before({ tool: "interactive_bash", agent: "sisyphus" })).resolves.toBeUndefined()
  })
})

describe("#given a host tool editor", () => {
  test("#when a disabled name reaches it #then nothing is registered and every other member still works", () => {
    // given
    const added = []
    const hostEditor = {
      add: (definition) => added.push(definition.name),
      get: () => undefined,
      list: () => ["host-tool"],
    }
    // when
    const editor = createDisabledToolEditor(hostEditor, createDisabledToolSet(["rigel_task"]))
    editor.add({ name: "rigel_task" })
    editor.add({ name: "todowrite" })
    // then
    expect(added).toEqual(["todowrite"])
    // the untouched members stay bound to the real editor (the host seam must not
    // lose `get`/`list`/`remove` just because the denylist is active)
    expect(editor.get("rigel_task")).toBeUndefined()
    expect(editor.list()).toEqual(["host-tool"])
    // and an empty denylist returns the host editor itself, so a runtime with no
    // disabled tools is byte-for-byte the previous behavior
    expect(createDisabledToolEditor(hostEditor, createDisabledToolSet([]))).toBe(hostEditor)
  })
})

describe("#given interactive_bash is permitted by its BAKED gate", () => {
  test("#when the live denylist names it #then the family is not offered and the denylist is the reported reason", () => {
    // given: the gate stays baked (host availability), so registration is the
    // only surface a live `disabled_tools` edit can reach
    const unavailable = []
    // when
    const result = buildConditionalToolDefinitions({
      gates: { interactive_bash: true },
      terminalFactory: () => ({}),
      disabledTools: ["interactive_bash"],
      onUnavailable: (family, reason) => unavailable.push([family, reason]),
    })
    // then
    expect(result.names).not.toContain("interactive_bash")
    expect(result.definitions.interactive_bash).toBeUndefined()
    expect(unavailable).toEqual([["interactive_bash", "it is listed in the live disabled_tools denylist"]])
  })

  test("#when no live denylist exists #then the family registers from the baked gate as before", () => {
    // given / when
    const result = buildConditionalToolDefinitions({ gates: { interactive_bash: true }, terminalFactory: () => ({}) })
    // then
    expect(result.names).toEqual(["interactive_bash"])
  })
})

// The runtime reads the LIVE `~/.omo/omo.jsonc` at plugin setup, so every case
// below drives a disposable HOME/XDG tree. `XDG_STATE_HOME` is sandboxed too:
// setup writes durable receipts under it, and the real user state root must
// never be touched by a test.
async function withLiveOmoConfig(config, run) {
  const sandbox = mkdtempSync(join(tmpdir(), "rigel-live-disabled-tools-"))
  const home = join(sandbox, "home")
  mkdirSync(join(home, ".omo"), { recursive: true })
  writeFileSync(join(home, ".omo", "omo.jsonc"), `${JSON.stringify(config, null, 2)}\n`)
  const previous = {
    HOME: process.env.HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  }
  process.env.HOME = home
  process.env.XDG_STATE_HOME = join(sandbox, "state")
  process.env.XDG_CONFIG_HOME = join(sandbox, "config")
  process.env.XDG_DATA_HOME = join(sandbox, "data")
  process.env.XDG_CACHE_HOME = join(sandbox, "cache")
  try {
    return await run({ sandbox, home })
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(sandbox, { recursive: true, force: true })
  }
}

function setupHarness() {
  const added = []
  const beforeHandlers = []
  const context = {
    location: { directory: "/native-v2" },
    agent: {
      list: async () => ({ data: [] }),
      transform: async (callback) => { callback({ update() {}, default() {} }); return { dispose() {} } },
      reload: async () => {},
    },
    model: { list: async () => ({ data: [] }) },
    session: {
      hook: async () => ({ dispose() {} }),
      create: async () => ({ data: { id: "ses_native" } }),
      prompt: async () => ({ data: {} }),
    },
    tool: {
      hook: async (name, handler) => {
        if (name === "execute.before") beforeHandlers.push(handler)
        return { dispose() {} }
      },
      transform: async (callback) => {
        callback({ add: (definition) => added.push(definition?.name), get: () => undefined })
        return { dispose() {} }
      },
    },
  }
  return { context, added, beforeHandlers }
}

// The setup registers several `execute.before` hooks (rule chain, non-interactive
// guard, the permission gate, the Claude Code bridge), so the denylist is proven
// by the CODES the whole live chain raises rather than by one handler's position.
async function beforeHookCodes(handlers, event) {
  const codes = []
  for (const handler of handlers) {
    try {
      await handler(event)
    } catch (error) {
      codes.push(error?.code)
    }
  }
  return codes
}

test("#given a live omo.jsonc that disables a supported tool the shipped manifest does not #when the runtime sets up #then the tool never registers and its call is refused", async () => {
  // given: the source manifest carries an EMPTY baked denylist, so a refusal here
  // can only come from the live chain
  await withLiveOmoConfig({ "[opencode]": { disabled_tools: ["rigel_task"] } }, async () => {
    const harness = setupHarness()
    // when
    const dispose = await plugin.setup(harness.context)
    try {
      // then: the disabled tool is absent from the host registry...
      expect(harness.added).not.toContain("rigel_task")
      // ...while the tools the live list does not name still register, so the
      // filter is not a blanket registration failure
      expect(harness.added).toContain("todowrite")
      expect(harness.added.length).toBeGreaterThan(1)
      // and the same live list is the execution gate the setup wired: the live
      // before-chain refuses the disabled name...
      expect(harness.beforeHandlers.length).toBeGreaterThan(0)
      const deniedCodes = await beforeHookCodes(harness.beforeHandlers, { tool: "rigel_task", agent: "sisyphus" })
      expect(deniedCodes).toContain(TOOL_DISABLED_BY_CONFIG)
      // ...while a tool the list does not carry passes it.
      const allowedCodes = await beforeHookCodes(harness.beforeHandlers, { tool: "todowrite", agent: "sisyphus" })
      expect(allowedCodes).not.toContain(TOOL_DISABLED_BY_CONFIG)
    } finally {
      await dispose()
    }
  })
})

test("#given the live omo.jsonc declares no disabled_tools #when the runtime sets up #then the baked behavior is preserved", async () => {
  // given / when
  await withLiveOmoConfig({ "[opencode]": { hashline_edit: false } }, async () => {
    const harness = setupHarness()
    const dispose = await plugin.setup(harness.context)
    try {
      // then
      expect(harness.added).toContain("rigel_task")
      const codes = await beforeHookCodes(harness.beforeHandlers, { tool: "rigel_task", agent: "sisyphus" })
      expect(codes).not.toContain(TOOL_DISABLED_BY_CONFIG)
    } finally {
      await dispose()
    }
  })
})
