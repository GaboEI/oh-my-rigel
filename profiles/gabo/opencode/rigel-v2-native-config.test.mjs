/**
 * Owner tests for the native V2 configuration resolver.
 *
 * These pin the observable behavior Phase 3 gates depend on: which layer wins,
 * how disabled denylists union, how legacy keys migrate, how invalid values
 * degrade, and that pollution keys and unknown top-level keys never reach the
 * plugin view. A separate parity test pins the port against the real OmO loader.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildMcpPolicyEntry,
  deriveNativeGates,
  readAgentOverridesFromConfig,
  readLiveAgentOverridesSource,
  readNativeDisabled,
  readNativeGates,
  readNativeMcpBuiltinsPolicy,
  readNativeMcpPolicy,
  readNativePreemptiveThreshold,
  resolveNativePluginConfig,
} from "./rigel-v2-native-config.mjs"

const created = []

function makeFixture() {
  const home = mkdtempSync(join(tmpdir(), "rigel-native-config-"))
  const project = join(home, "project")
  mkdirSync(join(home, ".omo"), { recursive: true })
  mkdirSync(join(project, ".omo"), { recursive: true })
  created.push(home)
  const writeUser = (text) => writeFileSync(join(home, ".omo", "omo.jsonc"), text)
  const writeProject = (text) => writeFileSync(join(project, ".omo", "omo.jsonc"), text)
  const resolve = (env = {}) => resolveNativePluginConfig({
    directory: project,
    env: { HOME: home, USERPROFILE: home, ...env },
  })
  return { home, project, writeUser, writeProject, resolve }
}

afterEach(() => {
  while (created.length > 0) rmSync(created.pop(), { recursive: true, force: true })
})

describe("#given no configuration exists", () => {
  test("#when the view is resolved #then every gate is off and every denylist is empty", () => {
    // given
    const fixture = makeFixture()
    // when
    const view = fixture.resolve()
    // then
    // Parity with the real OmO loader: an absent key stays undefined; the
    // loader does not materialize schema defaults into the plugin view.
    expect(view.monitor).toBeUndefined()
    expect(view.goal).toBeUndefined()
    expect(view.experimental).toEqual({ task_system: false, preemptive_compaction: false, truncate_all_tool_outputs: false })
    expect(view.disabled).toEqual({ tools: [], agents: [], skills: [], hooks: [], commands: [] })
    expect(view.categories).toEqual({})
    expect(view.sources.every((source) => source.loaded === false)).toBe(true)
  })
})

describe("#given plugin keys at the top level of a layer", () => {
  test("#when the view is resolved #then unknown top-level keys are stripped like the real loader", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "monitor": { "enabled": true }, "goal": { "enabled": true } }`)
    // when
    const view = fixture.resolve()
    // then
    // The real loader strips plugin keys that sit at the top level of a layer
    // (they must live in the [opencode] block), so no gate is projected.
    expect(view.monitor).toBeUndefined()
    expect(view.goal).toBeUndefined()
  })
})

describe("#given plugin keys inside the [opencode] block", () => {
  test("#when the view is resolved #then every gate reflects the block", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{
      "[opencode]": {
        "monitor": { "enabled": true, "live_mode_enabled": true },
        "goal": { "enabled": true, "auto_start": true, "default_max_iterations": 7 },
        "experimental": { "task_system": true },
        "disabled_tools": ["todowrite"],
        "disabled_agents": ["oracle"],
        "disabled_skills": ["dev-browser"],
        "disabled_commands": ["handoff"],
      },
    }`)
    // when
    const view = fixture.resolve()
    // then
    expect(view.monitor.enabled).toBe(true)
    expect(view.monitor.live_mode_enabled).toBe(true)
    expect(view.goal).toEqual({ enabled: true, auto_start: true, default_max_iterations: 7 })
    expect(view.experimental.task_system).toBe(true)
    expect(view.disabled).toEqual({ tools: ["todowrite"], agents: ["oracle"], skills: ["dev-browser"], hooks: [], commands: ["handoff"] })
  })
})

describe("#given the same section in two layers", () => {
  test("#when the nearer project layer sets monitor #then the later view replaces the whole section", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "monitor": { "enabled": true, "live_mode_enabled": true } } }`)
    fixture.writeProject(`{ "[opencode]": { "monitor": { "enabled": false } } }`)
    // when
    const view = fixture.resolve()
    // then
    expect(view.monitor.enabled).toBe(false)
    expect(view.monitor.live_mode_enabled).toBe(false)
  })
})

describe("#given denylists in several layers", () => {
  test("#when the view is resolved #then the lists union in first-seen view order", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{
      "profiles": { "gabo": { "[opencode]": { "disabled_tools": ["t3"] } } },
      "[opencode]": { "disabled_tools": ["t1"] },
    }`)
    fixture.writeProject(`{ "[opencode]": { "disabled_tools": ["t1", "t2"], "disabled_agents": ["a1", "a2"] } }`)
    // when
    const view = fixture.resolve({ OMO_PROFILE: "gabo" })
    // then
    expect(view.disabled.tools).toEqual(["t1", "t2", "t3"])
    expect(view.disabled.agents).toEqual(["a1", "a2"])
  })
})

describe("#given a selected profile", () => {
  test("#when OMO_PROFILE names any existing profile #then only that profile's block applies", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{
      "profiles": {
        "gabo": { "[opencode]": { "monitor": { "enabled": true }, "goal": { "enabled": true } } },
        "other": { "[opencode]": { "monitor": { "enabled": true } } },
      },
    }`)
    // when
    const withoutProfile = fixture.resolve()
    const withGabo = fixture.resolve({ OMO_PROFILE: "gabo" })
    const withOther = fixture.resolve({ OMO_PROFILE: "other" })
    // then
    expect(withoutProfile.monitor).toBeUndefined()
    expect(withoutProfile.goal).toBeUndefined()
    expect(withGabo.monitor.enabled).toBe(true)
    expect(withGabo.goal.enabled).toBe(true)
    expect(withOther.monitor.enabled).toBe(true)
    expect(withOther.goal).toBeUndefined()
  })
})

describe("#given categories in several layers", () => {
  test("#when the view is resolved #then entries deep-merge and the legacy deep key is canonicalized", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{
      "categories": { "quick": { "model": "top-quick", "temperature": 0.3 }, "deep": { "model": "top-deep" } },
      "[opencode]": { "categories": { "quick": { "top_p": 0.9 } } },
    }`)
    fixture.writeProject(`{ "[opencode]": { "categories": { "quick": { "model": "project-quick" }, "newcat": { "description": "n" } } } }`)
    // when
    const view = fixture.resolve()
    // then
    expect(view.categories.quick).toEqual({ model: "project-quick", temperature: 0.3, top_p: 0.9 })
    expect(view.categories["deep-low"]).toEqual({ model: "top-deep" })
    expect(view.categories.deep).toBeUndefined()
    expect(view.categories.newcat).toEqual({ description: "n" })
  })
})

describe("#given a legacy ralph_loop block", () => {
  test("#when the view is resolved #then it migrates into goal and explicit goal wins", () => {
    // given
    const migrated = makeFixture()
    migrated.writeUser(`{ "[opencode]": { "ralph_loop": { "enabled": true, "default_max_iterations": 42 } } }`)
    const explicit = makeFixture()
    explicit.writeUser(`{
      "[opencode]": {
        "ralph_loop": { "enabled": true, "default_max_iterations": 42 },
        "goal": { "enabled": false, "default_max_iterations": 9 },
      },
    }`)
    // when
    const migratedView = migrated.resolve()
    const explicitView = explicit.resolve()
    // then
    expect(migratedView.goal).toEqual({ enabled: true, auto_start: false, default_max_iterations: 42 })
    expect(explicitView.goal).toEqual({ enabled: false, auto_start: false, default_max_iterations: 9 })
  })
})

describe("#given invalid values", () => {
  test("#when the view is resolved #then each bad leaf is dropped with a warning and the rest survives", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{
      "[opencode]": {
        "monitor": { "enabled": "yes", "max_runtime_ms": 5, "batch_max_lines": 12 },
        "experimental": { "task_system": "yes" },
        "disabled_tools": ["ok", 7],
        "categories": { "quick": { "model": 7, "temperature": 0.4 } },
      },
    }`)
    // when
    const view = fixture.resolve()
    // then
    expect(view.monitor.enabled).toBe(false)
    expect(view.monitor.max_runtime_ms).toBe(1800000)
    expect(view.monitor.batch_max_lines).toBe(12)
    expect(view.experimental.task_system).toBe(false)
    expect(view.disabled.tools).toEqual(["ok"])
    expect(view.categories.quick).toEqual({ temperature: 0.4 })
    expect(view.diagnostics.some((line) => line.includes("monitor.enabled"))).toBe(true)
    expect(view.diagnostics.some((line) => line.includes("categories.quick.model"))).toBe(true)
  })
})

describe("#given native team-mode fields", () => {
  test("#when the view is resolved #then max_members is clamped into the native tool ceiling while remaining fields are reported", () => {
    // given
    const fixture = makeFixture()
    const unhonored = {
      max_parallel_members: 4,
      max_messages_per_run: 100000,
      max_wall_clock_minutes: 1440,
      max_member_turns: 5000,
      base_dir: "/home/teams",
      message_payload_max_bytes: 32768,
      recipient_unread_max_bytes: 262144,
      mailbox_poll_interval_ms: 3000,
    }
    fixture.writeUser(JSON.stringify({
      "[opencode]": {
        team_mode: { enabled: true, tmux_visualization: false, max_members: 99, ...unhonored },
      },
    }))
    // when
    const view = fixture.resolve()
    // then
    expect(view.team_mode).toEqual({ enabled: true, tmux_visualization: false, max_members: 8 })
    for (const key of Object.keys(unhonored)) {
      expect(view.diagnostics.some((line) => line.includes(`team_mode.${key}`) && line.includes("not honored by native runtime"))).toBe(true)
    }
  })

  test("#given malformed max_members #when the view is resolved #then it is omitted so the native default ceiling applies", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(JSON.stringify({ "[opencode]": { team_mode: { enabled: true, max_members: "four" } } }))
    // when
    const view = fixture.resolve()
    // then
    expect(view.team_mode).toEqual({ enabled: true })
    expect(view.diagnostics.some((line) => line.includes("team_mode.max_members") && line.includes("invalid value"))).toBe(true)
  })
})

describe("#given a JSONC file", () => {
  test("#when the view is resolved #then comments and trailing commas are accepted", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{
      // the monitor gate
      "[opencode]": {
        /* inline */ "monitor": { "enabled": true, },
        "disabled_tools": ["a", "b",],
      },
    }`)
    // when
    const view = fixture.resolve()
    // then
    expect(view.monitor.enabled).toBe(true)
    expect(view.disabled.tools).toEqual(["a", "b"])
  })
})

describe("#given prototype-polluting keys", () => {
  test("#when the view is resolved #then unsafe keys never reach the object graph", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "__proto__": { "polluted": true }, "disabled_tools": ["safe"] } }`)
    // when
    fixture.resolve()
    // then
    expect({}.polluted).toBeUndefined()
  })
})

describe("#given a symlinked project .omo directory", () => {
  test("#when the view is resolved #then the project layer is refused and only the user layer loads", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "monitor": { "enabled": true } } }`)
    const realDir = mkdtempSync(join(tmpdir(), "rigel-native-config-real-"))
    created.push(realDir)
    writeFileSync(join(realDir, "omo.jsonc"), `{ "[opencode]": { "monitor": { "enabled": false } } }`)
    rmSync(join(fixture.project, ".omo"), { recursive: true, force: true })
    symlinkSync(realDir, join(fixture.project, ".omo"))
    // when
    const view = fixture.resolve()
    // then
    expect(view.monitor.enabled).toBe(true)
    const projectSources = view.sources.filter((source) => source.scope === "project")
    expect(projectSources.every((source) => source.loaded === false)).toBe(true)
  })
})

describe("#given an injected file system", () => {
  test("#when the view is resolved #then no real disk is read", () => {
    // given
    const files = new Map([
      ["/virtual/.omo/omo.jsonc", `{ "[opencode]": { "monitor": { "enabled": true }, "disabled_tools": ["x"] } }`],
    ])
    const fileSystem = {
      existsSync: (path) => files.has(path),
      readFileSync: (path) => {
        if (!files.has(path)) throw new Error(`ENOENT: ${path}`)
        return files.get(path)
      },
      lstatSync: () => ({ isSymbolicLink: () => false }),
      realpathSync: (path) => path,
    }
    // when
    const view = resolveNativePluginConfig({
      directory: "/virtual/project",
      env: { HOME: "/virtual", USERPROFILE: "/virtual" },
      fileSystem,
    })
    // then
    expect(view.monitor.enabled).toBe(true)
    expect(view.disabled.tools).toEqual(["x"])
    expect(view.sources.find((source) => source.scope === "user").loaded).toBe(true)
  })
})

describe("#given a resolved native plugin config view", () => {
  test("#when gates are derived #then they mirror the config keys except the quarantined goal", () => {
    // given
    const off = { monitor: undefined, goal: { enabled: false }, experimental: { task_system: false }, disabled: { tools: [] } }
    // when
    const offGates = deriveNativeGates(off)
    // then
    expect(offGates).toEqual({ monitor: false, goal: false, task_system: false, team_mode: false, interactive_bash: true, hashline_edit: false, preemptive_compaction: false })

    // given: `goal.enabled` is present and true, but the inherited Goal is
    // quarantined, so the derived gate is still false.
    const on = { monitor: { enabled: true }, goal: { enabled: true }, experimental: { task_system: true }, team_mode: { enabled: true }, disabled: { tools: [] } }
    // when
    const onGates = deriveNativeGates(on)
    // then
    expect(onGates).toEqual({ monitor: true, goal: false, task_system: true, team_mode: true, interactive_bash: true, hashline_edit: false, preemptive_compaction: false })

    // given
    const disabled = { monitor: { enabled: true }, goal: { enabled: true }, experimental: { task_system: true }, disabled: { tools: ["interactive_bash"] } }
    // when
    const disabledGates = deriveNativeGates(disabled)
    // then
    expect(disabledGates).toEqual({ monitor: true, goal: false, task_system: true, team_mode: false, interactive_bash: false, hashline_edit: false, preemptive_compaction: false })
  })

  test("#when goal.enabled is true or a manifest forces gates.goal #then the quarantine keeps both sides false", () => {
    // given: config enables the inherited Goal and a hand-edited manifest forces
    // the gate; the quarantine authority must neutralize both (N8 + N9).
    const view = { goal: { enabled: true }, disabled: { tools: [] } }
    const manipulatedManifest = { metadata: { global: { gates: { goal: true } } } }
    // when / then
    expect(deriveNativeGates(view).goal).toBe(false)
    expect(readNativeGates(manipulatedManifest).goal).toBe(false)
  })

  test("#when preemptive_compaction is set #then the gate is on and the threshold is projected", () => {
    // given
    const view = { monitor: undefined, goal: undefined, experimental: { task_system: false, preemptive_compaction: true, preemptive_compaction_threshold: 0.5 }, disabled: { tools: [] } }
    // when
    const gates = deriveNativeGates(view)
    // then
    expect(gates.preemptive_compaction).toBe(true)
    // Off unless explicitly true: the V1 default.
    expect(deriveNativeGates({ experimental: { preemptive_compaction: "yes" } }).preemptive_compaction).toBe(false)
  })

  test("#when the view is malformed #then every config gate degrades closed", () => {
    // given / when
    const gates = deriveNativeGates(undefined)
    // then
    expect(gates.monitor).toBe(false)
    expect(gates.goal).toBe(false)
    expect(gates.task_system).toBe(false)
  })
})

describe("#given a materialized manifest", () => {
  test("#when the disabled denylists are materialized #then readNativeDisabled returns normalized arrays", () => {
    // given
    const manifest = { metadata: { global: { disabled: { tools: ["x", 1], agents: [], skills: ["dev-browser", "ultimate-browsing"] } } } }
    // when
    const disabled = readNativeDisabled(manifest)
    // then
    expect(disabled.tools).toEqual(["x"])
    expect(disabled.skills).toEqual(["dev-browser", "ultimate-browsing"])
  })

  test("#when the manifest carries no denylists #then every list is empty", () => {
    // given / when / then
    expect(readNativeDisabled(undefined)).toEqual({ tools: [], agents: [], skills: [], hooks: [], commands: [] })
    expect(readNativeDisabled({ metadata: { global: {} } })).toEqual({ tools: [], agents: [], skills: [], hooks: [], commands: [] })
  })
})


describe("#given the T34 preemptive compaction gate", () => {
  test("#when the block sets the gate and threshold #then the view projects both", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{
      "[opencode]": {
        "experimental": { "preemptive_compaction": true, "preemptive_compaction_threshold": 0.9 },
      },
    }`)
    // when
    const view = fixture.resolve()
    // then
    expect(view.experimental.preemptive_compaction).toBe(true)
    expect(view.experimental.preemptive_compaction_threshold).toBe(0.9)
    expect(deriveNativeGates(view).preemptive_compaction).toBe(true)
  })

  test("#when the threshold is out of range #then it is dropped but the gate survives", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{
      "[opencode]": {
        "experimental": { "preemptive_compaction": true, "preemptive_compaction_threshold": 1.5 },
      },
    }`)
    // when
    const view = fixture.resolve()
    // then
    expect(view.experimental.preemptive_compaction).toBe(true)
    expect(view.experimental.preemptive_compaction_threshold).toBeUndefined()
  })

  test("#when the manifest materializes the gate #then readNativeGates and the threshold reader agree", () => {
    // given
    const manifest = { metadata: { global: { gates: { preemptive_compaction: true }, preemptiveCompactionThreshold: 0.42 } } }
    // when / then
    expect(readNativeGates(manifest).preemptive_compaction).toBe(true)
    expect(readNativePreemptiveThreshold(manifest)).toBe(0.42)
    // An absent or out-of-range threshold falls back to the V1 0.78 default.
    expect(readNativePreemptiveThreshold({ metadata: { global: {} } })).toBeUndefined()
    expect(readNativePreemptiveThreshold({ metadata: { global: { preemptiveCompactionThreshold: 2 } } })).toBeUndefined()
    expect(readNativeGates({ metadata: { global: { gates: {} } } }).preemptive_compaction).toBe(false)
  })
})

describe("#given the tier-2 MCP policy", () => {
  test("#when the manifest carries the mcp block #then readNativeMcpPolicy normalizes it", () => {
    // given
    const manifest = { metadata: { global: { mcp: { disabled: ["context7", 3], envAllowlist: ["QA_MCP_TOKEN"] } } } }
    // when
    const policy = readNativeMcpPolicy(manifest)
    // then
    expect(policy).toEqual({ disabled: ["context7"], envAllowlist: ["QA_MCP_TOKEN"] })
    expect(readNativeMcpPolicy(undefined)).toEqual({ disabled: [], envAllowlist: [] })
  })

  test("#when the manifest carries the builtins policy #then the bundled and external arrays and env keys normalize", () => {
    // given
    const manifest = {
      metadata: {
        global: {
          mcpPolicy: {
            retained: ["grep_app", "lsp", 7],
            builtinsDisabled: ["context7"],
            bundledLocal: ["ssh"],
            externalConnections: ["obsidian", 3],
            externalEnvKeys: { obsidian: "OBSIDIAN_API_KEY", bad: 9, empty: "" },
            externalEndpoints: { obsidian: "https://127.0.0.1:27124/mcp/", bad: 9 },
            bundledSupplyChain: { ssh: { package: "@hypnosis/ssh-mcp-server", version: "2.3.3" } },
          },
        },
      },
    }
    // when
    const policy = readNativeMcpBuiltinsPolicy(manifest)
    // then
    expect(policy).toEqual({
      retained: ["grep_app", "lsp"],
      builtinsDisabled: ["context7"],
      bundledLocal: ["ssh"],
      externalConnections: ["obsidian"],
      externalEnvKeys: { obsidian: "OBSIDIAN_API_KEY" },
      externalEndpoints: { obsidian: "https://127.0.0.1:27124/mcp/" },
      bundledSupplyChain: { ssh: { package: "@hypnosis/ssh-mcp-server", version: "2.3.3" } },
    })
    expect(readNativeMcpBuiltinsPolicy(undefined)).toEqual({
      retained: [],
      builtinsDisabled: [],
      bundledLocal: [],
      externalConnections: [],
      externalEnvKeys: {},
      externalEndpoints: {},
      bundledSupplyChain: {},
    })
  })

  test("#when the integration policy is materialized #then buildMcpPolicyEntry is the single writer", () => {
    expect(buildMcpPolicyEntry({
      omoBuiltinsRetained: ["grep_app"],
      omoBuiltinsDisabled: ["context7"],
      bundledLocal: ["ssh"],
      coreExternalConnections: ["obsidian"],
      externalEnvKeys: { obsidian: "OBSIDIAN_API_KEY" },
      externalEndpoints: { obsidian: "https://127.0.0.1:27124/mcp/" },
      bundledSupplyChain: { ssh: { version: "2.3.3" } },
    })).toEqual({
      retained: ["grep_app"],
      builtinsDisabled: ["context7"],
      bundledLocal: ["ssh"],
      externalConnections: ["obsidian"],
      externalEnvKeys: { obsidian: "OBSIDIAN_API_KEY" },
      externalEndpoints: { obsidian: "https://127.0.0.1:27124/mcp/" },
      bundledSupplyChain: { ssh: { version: "2.3.3" } },
    })
    expect(buildMcpPolicyEntry()).toEqual({ retained: [], builtinsDisabled: [], bundledLocal: [], externalConnections: [], externalEnvKeys: {}, externalEndpoints: {}, bundledSupplyChain: {} })
  })

  test("#when a project layer extends mcp_env_allowlist #then only the user layer allowlist survives", () => {
    // given
    const fs = require("node:fs")
    const os = require("node:os")
    const path = require("node:path")
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-allowlist-"))
    const project = path.join(home, "proj")
    fs.mkdirSync(path.join(project, ".omo"), { recursive: true })
    fs.mkdirSync(path.join(home, ".omo"), { recursive: true })
    fs.writeFileSync(path.join(home, ".omo", "omo.jsonc"), JSON.stringify({ mcp_env_allowlist: ["USER_VAR"] }))
    fs.writeFileSync(path.join(project, ".omo", "omo.jsonc"), JSON.stringify({ mcp_env_allowlist: ["PROJECT_VAR"], disabled_mcps: ["context7"] }))
    try {
      // when
      const view = resolveNativePluginConfig({ directory: project, env: { ...process.env, HOME: home }, fileSystem: { existsSync: (p) => fs.existsSync(p), readFileSync: (p) => fs.readFileSync(p, "utf8") } })
      // then: the user-only security rule holds; disabled_mcps unions normally
      expect(view.mcp_env_allowlist).toEqual(["USER_VAR"])
      expect(view.disabled_mcps).toEqual(["context7"])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

// The runtime's LIVE per-agent model source: the `agents.<id>` block read from
// the on-disk `~/.omo/omo.jsonc`. The reader preserves the FULL authored entry
// (no field flattening) and decomposes the canonical ordered `models[]` into
// `model` + `fallback_models`, with V1 `materializeAgentModelChains` parity.
describe("#given a user agents block", () => {
  test("#when it is read #then the full entry survives and models[] decomposes", () => {
    const read = readAgentOverridesFromConfig({
      oracle: { model: "deepseek/deepseek-v4-pro", variant: "max", fallback_models: ["openai/gpt-6-luna-fast"], description: "kept", temperature: 0.4 },
      sisyphus: { prompt_append: "file:///x.md" },
      atlas: { models: ["openai/gpt-6-luna-fast", "deepseek/deepseek-flash"] },
      "prometheus": { models: [{ model: "openai/gpt-6", variant: "high" }, "deepseek/deepseek-flash"] },
    })
    // adjacent + unknown supported fields survive
    expect(read.oracle).toEqual({
      model: "deepseek/deepseek-v4-pro",
      variant: "max",
      fallback_models: ["openai/gpt-6-luna-fast"],
      description: "kept",
      temperature: 0.4,
    })
    expect(read.sisyphus).toEqual({ prompt_append: "file:///x.md" })
    // models:[a,b] -> model:a + fallback_models:[b]
    expect(read.atlas).toEqual({ model: "openai/gpt-6-luna-fast", fallback_models: ["deepseek/deepseek-flash"] })
    // models[0] as an object contributes its model + variant; the rest fall back
    expect(read.prometheus).toEqual({ model: "openai/gpt-6", variant: "high", fallback_models: ["deepseek/deepseek-flash"] })
  })

  test("#when an explicit model is authored alongside models[] #then the explicit fields are never overwritten", () => {
    const read = readAgentOverridesFromConfig({
      oracle: { model: "authored/model", variant: "authored-variant", models: ["other/primary", "other/fallback"] },
    })
    expect(read.oracle.model).toBe("authored/model")
    expect(read.oracle.variant).toBe("authored-variant")
    expect(read.oracle.fallback_models).toEqual(["other/fallback"])
  })

  test("#when the block is absent or malformed #then it degrades to {} and never mutates its input", () => {
    expect(readAgentOverridesFromConfig(undefined)).toEqual({})
    expect(readAgentOverridesFromConfig([1, 2])).toEqual({})
    expect(readAgentOverridesFromConfig({ oracle: null, explore: "nope", "Atlas - Plan Executor": 7 })).toEqual({})
    const frozen = Object.freeze({
      oracle: Object.freeze({ model: "a/b", fallback_models: Object.freeze(["c/d"]) }),
      atlas: Object.freeze({ models: Object.freeze(["e/f", "g/h"]) }),
    })
    const read = readAgentOverridesFromConfig(frozen)
    expect(read.oracle).toEqual({ model: "a/b", fallback_models: ["c/d"] })
    // The returned arrays are copies, so a later mutation can never reach the source.
    expect(read.oracle.fallback_models).not.toBe(frozen.oracle.fallback_models)
    expect(read.atlas).toEqual({ model: "e/f", fallback_models: ["g/h"] })
    expect(read.atlas.fallback_models).not.toBe(frozen.atlas.models)
    // The input is untouched: `models` is still on the source and `fallback_models` was not added.
    expect(frozen.atlas.models).toEqual(["e/f", "g/h"])
    expect(Object.hasOwn(frozen.atlas, "model")).toBe(false)
  })
})

// R1 needs the live read to be a discriminated SOURCE, not a bare map: "absent"
// must fall back to the manifest, but a present file (even without a pin) is
// authoritative-complete, and an unreadable file is its own state so a corrupt
// file can never be mistaken for "the user removed the pin".
describe("#given the live on-disk OmO config", () => {
  const liveRead = (fixture) => readLiveAgentOverridesSource({ home: fixture.home, env: { HOME: fixture.home, USERPROFILE: fixture.home } })

  test("#when ~/.omo/omo.jsonc declares agents #then the source is loaded with those overrides", () => {
    const fixture = makeFixture()
    fixture.writeUser(JSON.stringify({ agents: { oracle: { model: "deepseek/deepseek-v4-pro" } } }))
    const source = liveRead(fixture)
    expect(source.state).toBe("loaded")
    expect(source.overrides).toEqual({ oracle: { model: "deepseek/deepseek-v4-pro" } })
  })

  test("#when the file exists without an agents block #then the source is loaded and authoritative with no overrides", () => {
    const fixture = makeFixture()
    fixture.writeUser(JSON.stringify({ monitor: { enabled: true } }))
    const source = liveRead(fixture)
    expect(source.state).toBe("loaded")
    expect(source.overrides).toEqual({})
  })

  test("#when a nested directory carries its own config #then the user layer still wins", () => {
    const fixture = makeFixture()
    fixture.writeUser(JSON.stringify({ agents: { oracle: { model: "user/model-a" } } }))
    fixture.writeProject(JSON.stringify({ agents: { oracle: { model: "project/model-b" } } }))
    // Anchoring at HOME keeps the read to the user layer; a sibling project
    // config must never shadow it at runtime.
    const source = liveRead(fixture)
    expect(source.state).toBe("loaded")
    expect(source.overrides).toEqual({ oracle: { model: "user/model-a" } })
  })

  test("#when no config exists #then the source is absent and names the path it looked for", () => {
    const fixture = makeFixture()
    const source = liveRead(fixture)
    expect(source.state).toBe("absent")
    expect(source.path.endsWith(".omo/omo.jsonc")).toBe(true)
  })

  test("#when the config is invalid JSON #then the source is an error, never a silent {}", () => {
    const fixture = makeFixture()
    fixture.writeUser("{ agents: { oracle: { model: \"deepseek/x\" } }, }")
    const source = liveRead(fixture)
    expect(source.state).toBe("error")
    expect(typeof source.reason).toBe("string")
    expect(source.overrides).toBeUndefined()
    expect(source.categories).toBeUndefined()
  })

  // Ctrl+X M is a host-owned keybind (`model.list`) whose selection is
  // session-local: the host stores it per session and it must never be written
  // back. The plugin's share of that contract is to stay READ-ONLY over
  // ~/.omo/omo.jsonc, so an empty JSON config registers no model and the host
  // selection wins for that session while a new session returns to the JSON
  // config. Prove the runtime read path performs no write at all: the bytes,
  // the mtime and the directory listing are unchanged after the read.
  test("#when the live config is read #then the runtime path never writes it (Ctrl+X M stays host-owned)", () => {
    const fixture = makeFixture()
    fixture.writeUser(JSON.stringify({ agents: { oracle: { model: "deepseek/deepseek-v4-pro" } } }))
    const file = join(fixture.home, ".omo", "omo.jsonc")
    const dir = join(fixture.home, ".omo")
    const beforeBytes = readFileSync(file)
    const beforeMtime = statSync(file).mtimeMs
    const beforeEntries = readdirSync(dir).sort()
    const source = liveRead(fixture)
    expect(source.state).toBe("loaded")
    expect(readFileSync(file).equals(beforeBytes)).toBe(true)
    expect(statSync(file).mtimeMs).toBe(beforeMtime)
    expect(readdirSync(dir).sort()).toEqual(beforeEntries)
  })

  // Category JSON routing: the live source must ALSO carry the `categories` block
  // (read through the one live-read authority), while the agent-override contract
  // stays byte-identical. A file with no `categories` key yields `{}` (built-ins
  // only), so absent/unconfigured categories keep their exact semantics.
  test("#when ~/.omo/omo.jsonc declares categories #then the source carries them and agent overrides stay exact", () => {
    const fixture = makeFixture()
    fixture.writeUser(JSON.stringify({
      agents: { oracle: { model: "deepseek/deepseek-v4-pro" } },
      categories: { quick: { model: "xiaomi/mimo-v2.6-pro" } },
    }))
    const source = liveRead(fixture)
    expect(source.state).toBe("loaded")
    expect(source.categories).toEqual({ quick: { model: "xiaomi/mimo-v2.6-pro" } })
    expect(source.overrides).toEqual({ oracle: { model: "deepseek/deepseek-v4-pro" } })
  })

  test("#when the file exists without a categories block #then categories are empty and agent overrides are unchanged", () => {
    const fixture = makeFixture()
    fixture.writeUser(JSON.stringify({ agents: { oracle: { model: "deepseek/deepseek-v4-pro" } } }))
    const source = liveRead(fixture)
    expect(source.state).toBe("loaded")
    expect(source.categories).toEqual({})
    expect(source.overrides).toEqual({ oracle: { model: "deepseek/deepseek-v4-pro" } })
  })

  test("#when no config exists #then the source is absent and carries no categories", () => {
    const fixture = makeFixture()
    const source = liveRead(fixture)
    expect(source.state).toBe("absent")
    expect(source.categories).toBeUndefined()
  })
})
