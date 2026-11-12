/**
 * Owner tests for the native V2 configuration resolver.
 *
 * These pin the observable behavior Phase 3 gates depend on: which layer wins,
 * how disabled denylists union, how legacy keys migrate, how invalid values
 * degrade, and that pollution keys and unknown top-level keys never reach the
 * plugin view. The declaration-presence section pins the separate contract that
 * answers "did a layer author this key?" without reading a materialized default.
 * A separate parity test pins the port against the real OmO loader.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  NATIVE_DISABLED_LIST_POLICY,
  NATIVE_MONITOR_DEFAULTS,
  NATIVE_PREEMPTIVE_COMPACTION_THRESHOLD_DEFAULT,
  buildMcpPolicyEntry,
  deriveNativeGates,
  readAgentOverridesFromConfig,
  readLiveAgentOverridesSource,
  readNativeDisabled,
  readNativeGates,
  readNativeMcpBuiltinsPolicy,
  readNativeMcpPolicy,
  readNativePreemptiveThreshold,
  resolveNativeDisabledLists,
  resolveNativeMcpEnvAllowlist,
  resolveNativePluginConfig,
  resolveNativePreemptiveThreshold,
} from "./rigel-v2-native-config.mjs"
import { PREEMPTIVE_COMPACTION_THRESHOLD } from "./rigel-v2-native-preemptive-compaction.mjs"

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

describe("#given a layer that declares the shared telemetry key", () => {
  test("#when it is true, false or absent #then the plugin view never carries a telemetry key", () => {
    // given
    const layers = [`{ "telemetry": true }`, `{ "telemetry": { "enabled": false } }`, `{}`]
    for (const layer of layers) {
      const fixture = makeFixture()
      fixture.writeUser(layer)
      // when
      const view = fixture.resolve()
      // then
      // The native V2 runtime records nothing: the shared key stays a silently
      // accepted layer key that the resolver never projects into the view, so no
      // gate can ever be built from it.
      expect([layer, "telemetry" in view]).toEqual([layer, false])
      expect([layer, Object.keys(view).includes("telemetry")]).toEqual([layer, false])
    }
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

describe("#given OpenClaw configuration placements", () => {
  test("#when root, profile, and [opencode] blocks are valid #then each resolves without diagnostics", () => {
    const fixture = makeFixture()
    fixture.writeUser(`{
      "openclaw": { "enabled": true, "gateways": {}, "hooks": {} },
      "profiles": { "gabo": { "openclaw": { "enabled": false, "gateways": {}, "hooks": {} } } },
      "[opencode]": { "openclaw": { "enabled": true, "gateways": {}, "hooks": {} } }
    }`)

    const root = fixture.resolve()
    const profile = fixture.resolve({ OMO_PROFILE: "gabo" })

    expect(root.openclaw).toEqual({ enabled: true, gateways: {}, hooks: {} })
    expect(profile.openclaw).toEqual({ enabled: false, gateways: {}, hooks: {} })
    expect(root.diagnostics).toEqual([])
    expect(profile.diagnostics).toEqual([])
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
    // Presence names the legacy key the file wrote; the synthesized `goal` is a
    // migration product, never a declaration the file made.
    expect(migratedView.declarations.ralph_loop.state).toBe("declared")
    expect(migratedView.declarations.goal.state).toBe("undeclared")
    expect(explicitView.declarations.goal.state).toBe("declared")
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
    expect(declaredState(view, "monitor.enabled")).toBe("declared")
    expect(declaredState(view, "disabled_tools")).toBe("declared")
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
    // given: the injected file system is keyed by the paths the resolver itself
    // computes (`path.resolve` / `join` over the injected HOME), so the fixture
    // matches on every host instead of only where `/` is the separator.
    const virtualHome = resolve("/virtual")
    const files = new Map([
      [join(virtualHome, ".omo", "omo.jsonc"), `{ "[opencode]": { "monitor": { "enabled": true }, "disabled_tools": ["x"] } }`],
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
      directory: join(virtualHome, "project"),
      env: { HOME: virtualHome, USERPROFILE: virtualHome },
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

describe("#given the T34 threshold resolves from the live chain", () => {
  const manifestWith = (threshold) => ({
    metadata: { global: threshold === undefined ? {} : { preemptiveCompactionThreshold: threshold } },
  })
  const resolveThreshold = (fixture, manifest) => resolveNativePreemptiveThreshold({
    manifest,
    directory: fixture.project,
    env: { HOME: fixture.home, USERPROFILE: fixture.home },
  })

  test("#when no layer declares it #then the installed manifest value is kept and no default is invented", () => {
    // given
    const fixture = makeFixture()
    // when
    const baked = resolveThreshold(fixture, manifestWith(0.42))
    const absent = resolveThreshold(fixture, manifestWith(undefined))
    // then
    expect(baked.state).toBe("undeclared")
    expect(baked.value).toBe(0.42)
    expect(baked.diagnostics).toEqual([])
    // Neither source carries one: the documented V1 default applies.
    expect(absent.state).toBe("undeclared")
    expect(absent.value).toBe(NATIVE_PREEMPTIVE_COMPACTION_THRESHOLD_DEFAULT)
  })

  test("#when a layer declares a valid threshold #then it wins and only a disagreement is reported", () => {
    // given
    const fixture = makeFixture()
    fixture.writeProject(`{ "[opencode]": { "experimental": { "preemptive_compaction_threshold": 0.5 } } }`)
    // when
    const drift = resolveThreshold(fixture, manifestWith(0.42))
    const agree = resolveThreshold(fixture, manifestWith(0.5))
    // then
    expect(drift.state).toBe("declared")
    expect(drift.value).toBe(0.5)
    expect(drift.diagnostics).toHaveLength(1)
    expect(drift.diagnostics[0]).toContain("0.5")
    expect(drift.diagnostics[0]).toContain("0.42")
    expect(agree.value).toBe(0.5)
    expect(agree.diagnostics).toEqual([])
  })

  test("#when the boundary is declared #then 1 is accepted while 0 and above 1 fall closed", () => {
    // given
    const fixture = makeFixture()
    // when / then
    fixture.writeUser(`{ "[opencode]": { "experimental": { "preemptive_compaction_threshold": 1 } } }`)
    expect(resolveThreshold(fixture, manifestWith(0.42))).toMatchObject({ state: "declared", value: 1 })

    fixture.writeUser(`{ "[opencode]": { "experimental": { "preemptive_compaction_threshold": 0 } } }`)
    const zero = resolveThreshold(fixture, manifestWith(0.42))
    expect(zero.state).toBe("error")
    expect(zero.value).toBe(NATIVE_PREEMPTIVE_COMPACTION_THRESHOLD_DEFAULT)
    expect(zero.diagnostics).toHaveLength(1)

    fixture.writeUser(`{ "[opencode]": { "experimental": { "preemptive_compaction_threshold": 1.5 } } }`)
    const above = resolveThreshold(fixture, manifestWith(0.42))
    expect(above.state).toBe("error")
    expect(above.value).toBe(NATIVE_PREEMPTIVE_COMPACTION_THRESHOLD_DEFAULT)
  })

  test("#when a layer cannot be parsed #then the threshold fails closed instead of using the manifest", () => {
    // given
    const fixture = makeFixture()
    fixture.writeProject(`{ "[opencode]": { "experimental": { `)
    // when
    const resolution = resolveThreshold(fixture, manifestWith(0.42))
    // then
    expect(resolution.state).toBe("error")
    expect(resolution.value).toBe(NATIVE_PREEMPTIVE_COMPACTION_THRESHOLD_DEFAULT)
    expect(resolution.diagnostics).toHaveLength(1)
    expect(resolution.diagnostics[0]).toContain("0.78")
  })

  test("#then the duplicated default stays equal to the runtime constant", () => {
    // The config module cannot import the pure compaction port, so the two copies
    // of the V1 threshold are pinned equal here instead of drifting apart.
    expect(NATIVE_PREEMPTIVE_COMPACTION_THRESHOLD_DEFAULT).toBe(PREEMPTIVE_COMPACTION_THRESHOLD)
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
      // The project placement is refused by SCOPE, so it is not a declaration.
      expect(view.declarations.mcp_env_allowlist.state).toBe("declared")
      expect(view.declarations.mcp_env_allowlist.sources).toHaveLength(1)
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
    expect(source.path.endsWith(join(".omo", "omo.jsonc"))).toBe(true)
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

  test("#when the config is invalid JSON #then the reported reason names the class and never the source text", () => {
    // given a malformed line whose value looks like a credential. The parser names the
    // text it choked on, and this reason is printed by the runtime at startup, so any
    // fragment of the value here would reach stderr (Contrato S4.3, identity only).
    const fixture = makeFixture()
    const marker = "syntheticfixturemarkernotasecret"
    fixture.writeUser(`{ "agents": { "oracle": { "model": ${marker} } } }`)
    // when
    const source = liveRead(fixture)
    // then
    expect(source.state).toBe("error")
    expect(source.reason).toBeString()
    expect(source.reason).not.toContain(marker.slice(0, 10))
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

// --- Phase 1: declaration-presence contract ---
// A resolved value cannot express "the user wrote `false`": the projection fills
// absent collections with `[]`/`{}` and the section validators materialize their
// schema defaults. `declarations` is the per-key presence record a later live
// authority reads INSTEAD of the value, so these cases pin the tri-state and the
// two error classes (a refused value vs an unreadable file).
const declaredState = (view, key) => view.declarations[key]?.state

describe("#given no layer authors a tracked key", () => {
  test("#when the view is resolved #then every tracked key is undeclared and no load failure is reported", () => {
    // given
    const fixture = makeFixture()
    // when
    const view = fixture.resolve()
    // then
    for (const key of [
      "monitor", "monitor.enabled", "goal.enabled", "experimental.task_system",
      "team_mode.enabled", "team_mode.tmux_visualization", "hashline_edit",
      "openclaw", "agents", "categories", "disabled_tools", "mcp_env_allowlist",
    ]) {
      expect(declaredState(view, key)).toBe("undeclared")
    }
    expect(view.loadFailures).toEqual([])
  })
})

describe("#given explicit false, zero, empty list and empty object", () => {
  test("#when the view is resolved #then each is declared while the value stays the authored one", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{
      "[opencode]": {
        "monitor": { "enabled": false },
        "experimental": { "task_system": false },
        "team_mode": { "enabled": false, "tmux_visualization": false },
        "disabled_tools": [],
      },
      "categories": { "quick": { "temperature": 0 } },
      "openclaw": {},
      "mcp_env_allowlist": [],
    }`)
    // when
    const view = fixture.resolve()
    // then: no default is mistaken for a declaration and no declaration is
    // mistaken for absence, which is the whole point of the contract.
    expect(view.monitor.enabled).toBe(false)
    expect(view.experimental.task_system).toBe(false)
    expect(view.team_mode).toEqual({ enabled: false, tmux_visualization: false })
    expect(view.disabled.tools).toEqual([])
    expect(view.categories).toEqual({ quick: { temperature: 0 } })
    expect(view.openclaw).toEqual({})
    expect(view.mcp_env_allowlist).toEqual([])
    for (const key of [
      "monitor.enabled", "experimental.task_system", "team_mode.enabled",
      "team_mode.tmux_visualization", "disabled_tools",
      "categories.quick.temperature", "openclaw", "mcp_env_allowlist",
    ]) {
      expect(declaredState(view, key)).toBe("declared")
    }
  })
})

describe("#given a declared section that omits a leaf", () => {
  test("#when the section is authored #then the block is declared and the omitted leaf is not", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "monitor": { "live_mode_enabled": true } } }`)
    // when
    const view = fixture.resolve()
    // then: the materialized `enabled: false` is a view default, never a declaration.
    expect(view.monitor.enabled).toBe(false)
    expect(declaredState(view, "monitor")).toBe("declared")
    expect(declaredState(view, "monitor.live_mode_enabled")).toBe("declared")
    expect(declaredState(view, "monitor.enabled")).toBe("undeclared")
  })
})

describe("#given an authored value the schema refuses", () => {
  test("#when leaves and blocks are invalid #then presence is error while the safe value survives", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{
      "[opencode]": {
        "monitor": { "enabled": "yes" },
        "team_mode": { "enabled": "yes", "tmux_visualization": "yes" },
        "categories": { "quick": { "model": 7 } },
        "disabled_tools": "nope",
      },
      "openclaw": 7,
      "mcp_env_allowlist": "nope",
    }`)
    // when
    const view = fixture.resolve()
    // then: the block survives with its documented safe value, the refused leaves
    // do not, and the refusal is reported instead of collapsing into undeclared.
    expect(view.monitor).toEqual({ ...NATIVE_MONITOR_DEFAULTS })
    expect(view.team_mode).toEqual({})
    expect(view.categories).toEqual({ quick: {} })
    expect(view.disabled.tools).toEqual([])
    expect(view.openclaw).toBeUndefined()
    expect(view.mcp_env_allowlist).toEqual([])
    expect(declaredState(view, "monitor")).toBe("declared")
    expect(declaredState(view, "monitor.enabled")).toBe("error")
    expect(declaredState(view, "team_mode.enabled")).toBe("error")
    expect(declaredState(view, "team_mode.tmux_visualization")).toBe("error")
    expect(declaredState(view, "categories.quick.model")).toBe("error")
    expect(declaredState(view, "disabled_tools")).toBe("error")
    expect(declaredState(view, "openclaw")).toBe("error")
    expect(declaredState(view, "mcp_env_allowlist")).toBe("error")
    expect(view.declarations["monitor.enabled"].sources).toHaveLength(1)
    expect(view.declarations["monitor.enabled"].sources[0].at).toBe("[opencode].monitor.enabled")
  })
})

describe("#given a legacy ralph_loop block the schema refuses", () => {
  test("#when the block is not an object #then presence is error and the parser stays silent", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "ralph_loop": 7 } }`)
    // when
    const view = fixture.resolve()
    // then: `declared` means the authored value SURVIVED validation. The legacy
    // block is still dropped without a diagnostic, but presence must not report
    // a refusal as a declaration a later authority could trust.
    expect(view.goal).toBeUndefined()
    expect(declaredState(view, "ralph_loop")).toBe("error")
    expect(declaredState(view, "goal")).toBe("undeclared")
    expect(view.diagnostics).toEqual([])
  })
})

describe("#given a refused section above an accepted one", () => {
  test("#when the nearer layer's section is not an object #then the accepted declaration and value survive", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "monitor": { "enabled": true } } }`)
    fixture.writeProject(`{ "[opencode]": { "monitor": 7 } }`)
    // when
    const view = fixture.resolve()
    // then: the parser drops the refused section, so the earlier one is still the
    // resolved value AND still the declaration that owns it.
    expect(view.monitor.enabled).toBe(true)
    expect(declaredState(view, "monitor")).toBe("declared")
    expect(declaredState(view, "monitor.enabled")).toBe("declared")
    expect(view.diagnostics.some((line) => line.includes("monitor ignored (invalid value)"))).toBe(true)
  })
})

describe("#given a later layer that re-declares a section", () => {
  test("#when the nearer section omits a leaf #then that leaf's declaration is reset and the default returns", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "monitor": { "enabled": true, "live_mode_enabled": true } } }`)
    fixture.writeProject(`{ "[opencode]": { "monitor": { "live_mode_enabled": true } } }`)
    // when
    const view = fixture.resolve()
    // then: the whole-section replacement drops the earlier leaf, so only the
    // leaf the nearer section repeats stays declared.
    expect(view.monitor.enabled).toBe(false)
    expect(declaredState(view, "monitor.live_mode_enabled")).toBe("declared")
    expect(declaredState(view, "monitor.enabled")).toBe("undeclared")
  })
})

describe("#given union and merge keys authored in several layers", () => {
  test("#when the view is resolved #then presence is declared with every authoring source", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{
      "[opencode]": { "disabled_tools": ["t1"] },
      "categories": { "quick": { "model": "top-quick" } },
    }`)
    fixture.writeProject(`{
      "[opencode]": { "disabled_tools": ["t2"], "categories": { "quick": { "top_p": 0.5 } } },
    }`)
    // when
    const view = fixture.resolve()
    // then
    expect(view.disabled.tools).toEqual(["t1", "t2"])
    expect(view.categories.quick).toEqual({ model: "top-quick", top_p: 0.5 })
    expect(declaredState(view, "disabled_tools")).toBe("declared")
    expect(view.declarations.disabled_tools.sources).toHaveLength(2)
    expect(declaredState(view, "categories.quick")).toBe("declared")
    expect(view.declarations["categories.quick"].sources).toHaveLength(2)
  })
})

describe("#given a key declared inside the selected profile", () => {
  test("#when the view is resolved #then the source names the file and the exact placement", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "profiles": { "gabo": { "[opencode]": { "team_mode": { "tmux_visualization": true } } } } }`)
    // when
    const view = fixture.resolve({ OMO_PROFILE: "gabo" })
    // then
    expect(view.team_mode.tmux_visualization).toBe(true)
    expect(view.declarations["team_mode.tmux_visualization"]).toEqual({
      state: "declared",
      sources: [{
        path: join(fixture.home, ".omo", "omo.jsonc"),
        at: "profiles.gabo.[opencode].team_mode.tmux_visualization",
      }],
    })
  })
})

describe("#given an unreadable layer", () => {
  test("#when the only file is broken JSONC #then the failure is reported and nothing is declared", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "monitor": { "enabled": true } }`)
    // when
    const view = fixture.resolve()
    // then: the broken file is NOT read as "no layer declared anything", so no
    // sensitive surface may treat the undeclared records as authoritative.
    expect(view.monitor).toBeUndefined()
    expect(view.loadFailures).toHaveLength(1)
    expect(view.loadFailures[0].scope).toBe("user")
    expect(view.loadFailures[0].reason).toBe("invalid JSON")
    expect(Object.values(view.declarations).every((entry) => entry.state === "undeclared")).toBe(true)
    expect(view.diagnostics.some((line) => line.includes("invalid JSON"))).toBe(true)
  })

  test("#when a project layer is broken beside a valid user layer #then the user declaration survives and the failure is still reported", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "monitor": { "enabled": true } } }`)
    fixture.writeProject(`{ "[opencode]": `)
    // when
    const view = fixture.resolve()
    // then
    expect(view.monitor.enabled).toBe(true)
    expect(declaredState(view, "monitor.enabled")).toBe("declared")
    expect(view.loadFailures).toHaveLength(1)
    expect(view.loadFailures[0].scope).toBe("project")
  })

  test("#when the file parses to a non-object root #then the structural failure carries its own reason", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`null`)
    // when
    const view = fixture.resolve()
    // then: a parse that succeeds but yields no object is a DIFFERENT failure
    // class from broken JSON, and neither is "the chain declared nothing", so a
    // reader can tell a syntax failure from a structural one.
    expect(view.loadFailures).toHaveLength(1)
    expect(view.loadFailures[0]).toMatchObject({ scope: "user", reason: "layer root is not an object" })
    expect(view.sources.find((source) => source.scope === "user").loaded).toBe(false)
    expect(view.monitor).toBeUndefined()
    expect(declaredState(view, "monitor.enabled")).toBe("undeclared")
    expect(view.diagnostics.some((line) => line.includes("layer ignored (not an object)"))).toBe(true)
  })
})

// --- Phase 4: live authority for the `disabled_*` denylists ---
// A denylist is a PROTECTION, so its fail-closed direction is the opposite of a
// boolean gate's: an unconfirmed read must KEEP the installed list instead of
// dropping it. These cases pin that direction, the explicit-empty reactivation,
// the layer/placement fold, and the two lists the parser used to lose.
const DISABLED_LIST_BAKED = Object.freeze({
  tools: ["baked_tool"],
  agents: ["baked_agent"],
  skills: ["baked_skill"],
  hooks: ["think-mode"],
  commands: ["baked_command"],
})

function disabledManifest(disabled = DISABLED_LIST_BAKED, mcps = ["context7"]) {
  return { metadata: { global: { disabled: { ...disabled }, mcp: { disabled: [...mcps] } } } }
}

function resolveLists(fixture, manifest, env = {}) {
  return resolveNativeDisabledLists({
    manifest,
    directory: fixture.project,
    env: { HOME: fixture.home, USERPROFILE: fixture.home, ...env },
  })
}

describe("#given no layer authors a disabled denylist", () => {
  test("#when the lists are resolved #then every installed denylist is preserved silently", () => {
    // given
    const fixture = makeFixture()
    // when
    const resolved = resolveLists(fixture, disabledManifest())
    // then
    expect(resolved.lists.tools).toEqual(["baked_tool"])
    expect(resolved.lists.agents).toEqual(["baked_agent"])
    expect(resolved.lists.skills).toEqual(["baked_skill"])
    expect(resolved.lists.hooks).toEqual(["think-mode"])
    expect(resolved.lists.commands).toEqual(["baked_command"])
    expect(resolved.lists.mcps).toEqual(["context7"])
    expect(resolved.diagnostics).toEqual([])
  })
})

describe("#given a live declaration replaces an installed denylist", () => {
  test("#when the declaration is non-empty #then the live list wins and the drift is reported once", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "disabled_agents": ["oracle", "momus"] } }`)
    // when
    const resolved = resolveLists(fixture, disabledManifest())
    // then
    expect(resolved.lists.agents).toEqual(["oracle", "momus"])
    // The lists the live chain did not declare keep the installed value.
    expect(resolved.lists.tools).toEqual(["baked_tool"])
    expect(resolved.diagnostics).toHaveLength(1)
    expect(resolved.diagnostics[0]).toContain("disabled_agents")
    expect(resolved.diagnostics[0]).toContain("Reinstall to resync the manifest")
  })

  test("#when the declaration is an explicit empty list #then every installed entry is released", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "disabled_agents": [] } }`)
    // when
    const resolved = resolveLists(fixture, disabledManifest())
    // then: an authored `[]` is a declaration, never absence. This is the
    // reactivate-without-reinstalling contract.
    expect(resolved.lists.agents).toEqual([])
    expect(resolved.diagnostics).toHaveLength(1)
    expect(resolved.diagnostics[0]).toContain("Reinstall to resync the manifest")
  })
})

describe("#given an unconfirmed declaration", () => {
  test("#when the value is refused by the schema #then the installed denylist is kept instead of dropped", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "disabled_agents": "oracle" } }`)
    // when
    const resolved = resolveLists(fixture, disabledManifest())
    // then: a refusal must never be read as "the user disabled nothing", so the
    // protection survives and the failure is named.
    expect(resolved.lists.agents).toEqual(["baked_agent"])
    expect(resolved.diagnostics.some((line) => line.includes("disabled_agents") && line.includes("kept the installed denylist"))).toBe(true)
  })

  test("#when a layer cannot be parsed #then every live list keeps its installed value and reports once", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "disabled_agents": [] }`)
    // when
    const resolved = resolveLists(fixture, disabledManifest())
    // then
    expect(resolved.lists).toEqual({ ...DISABLED_LIST_BAKED, mcps: ["context7"] })
    for (const name of ["tools", "agents", "skills", "hooks", "commands"]) {
      expect(resolved.diagnostics.some((line) => line.includes(name) && line.includes("kept the installed denylist"))).toBe(true)
    }
  })
})

// A parse failure in ONE layer says nothing about the layers that were read: the
// denies they confirmed are still real protections. "Keep the installed
// denylist" is a FLOOR, never a ceiling, so a confirmed deny has to be unioned
// onto it. Dropping it released a protection because of an unrelated failure:
// with an installed list of `[]`, a user `disabled_mcps: ["context7"]` beside a
// broken project layer enforced nothing at all.
describe("#given a confirmed deny beside a layer that cannot be parsed", () => {
  test("#when a USER denies an MCP and the project layer is broken #then the confirmed deny survives", () => {
    // given: the user layer is readable and the installed manifest denies
    // nothing, so keeping only the installed denylist would enforce NO deny.
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "disabled_mcps": ["context7"] } }`)
    fixture.writeProject(`{ "[opencode]": `)
    // when
    const resolved = resolveLists(fixture, mcpManifest({ disabled: [] }))
    // then: the deny a readable layer confirmed outlives the unrelated failure
    expect(resolved.lists.mcps).toEqual(["context7"])
    expect(resolved.diagnostics.some((line) => line.includes("disabled_mcps") && line.includes("context7"))).toBe(true)
  })

  test("#when a USER deny sits beside a broken project layer and an installed deny #then both apply", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "disabled_mcps": ["ssh"] } }`)
    fixture.writeProject(`{ "[opencode]": `)
    // when
    const resolved = resolveLists(fixture, mcpManifest())
    // then: union, never replacement: the installed deny is the floor
    expect(resolved.lists.mcps).toEqual(["context7", "ssh"])
  })

  test("#when a plain denylist is confirmed beside a broken layer #then it is unioned onto the installed list", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "disabled_agents": ["oracle"] } }`)
    fixture.writeProject(`{ "[opencode]": `)
    // when
    const resolved = resolveLists(fixture, disabledManifest())
    // then
    expect(resolved.lists.agents).toEqual(["baked_agent", "oracle"])
    // A list no readable layer declared still keeps its installed value.
    expect(resolved.lists.skills).toEqual(["baked_skill"])
    expect(resolved.lists.commands).toEqual(["baked_command"])
  })

  test("#when the installed denylists are empty #then only the confirmed deny applies", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "disabled_agents": ["oracle"], "disabled_mcps": ["ssh"] } }`)
    fixture.writeProject(`not json`)
    // when
    const resolved = resolveLists(fixture, disabledManifest({}, []))
    // then: nothing is invented for the lists no layer declared
    expect(resolved.lists).toEqual({ tools: [], agents: ["oracle"], skills: [], hooks: [], commands: [], mcps: ["ssh"] })
  })

  test("#when the USER releases an installed deny and another layer is broken #then the release is not honored", () => {
    // given: a release is the only path that drops a protection, so it stays
    // unconfirmed while a layer the chain could not read might contradict it
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "disabled_agents": [], "disabled_mcps": [] } }`)
    fixture.writeProject(`{ "[opencode]": `)
    // when
    const resolved = resolveLists(fixture, disabledManifest())
    // then
    expect(resolved.lists.agents).toEqual(["baked_agent"])
    expect(resolved.lists.mcps).toEqual(["context7"])
  })
})

describe("#given the user and project layers both declare a denylist", () => {
  test("#when the view is resolved #then the lists union across layers and placements", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{
      "[opencode]": { "disabled_tools": ["t1"] },
      "profiles": { "gabo": { "[opencode]": { "disabled_tools": ["t2"] } } },
    }`)
    fixture.writeProject(`{ "[opencode]": { "disabled_tools": ["t3"] } }`)
    // when
    const resolved = resolveLists(fixture, disabledManifest(), { OMO_PROFILE: "gabo" })
    // then: the fold is placement-major (root, then [opencode], then
    // profiles.<p>.[opencode]) and unions inside each placement.
    expect(resolved.lists.tools).toEqual(["t1", "t3", "t2"])
  })
})

describe("#given a disabled_hooks declaration in the [opencode] block", () => {
  test("#when the view is resolved #then the list survives the parser and the resolver reads it live", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "disabled_hooks": ["think-mode"] } }`)
    // when
    const view = fixture.resolve()
    const resolved = resolveLists(fixture, disabledManifest())
    // then: `disabled_hooks` is a plugin key with a real runtime consumer
    // (think-mode), so dropping it from the view silently re-enabled the hook.
    expect(view.disabled.hooks).toEqual(["think-mode"])
    expect(declaredState(view, "disabled_hooks")).toBe("declared")
    expect(resolved.lists.hooks).toEqual(["think-mode"])
  })
})

// --- Phase 5: live authority for MCP blocking ---
// `disabled_mcps` is the ONE denylist with a SCOPE contract: a user declaration
// is the baseline (including the explicit empty release), a project layer may
// only ADD a deny, and an unconfirmed read keeps every installed deny.
// `mcp_env_allowlist` is a GRANT list, so its fail-closed direction is the
// opposite of a denylist's: an unconfirmed read grants NOTHING.
const MCP_BAKED_DISABLED = Object.freeze(["context7"])
const MCP_BAKED_ALLOWLIST = Object.freeze(["BAKED_VAR"])

function mcpManifest({ disabled = MCP_BAKED_DISABLED, envAllowlist = MCP_BAKED_ALLOWLIST } = {}) {
  return { metadata: { global: { mcp: { disabled: [...disabled], envAllowlist: [...envAllowlist] } } } }
}

function resolveAllowlist(fixture, manifest, env = {}) {
  return resolveNativeMcpEnvAllowlist({
    manifest,
    directory: fixture.project,
    env: { HOME: fixture.home, USERPROFILE: fixture.home, ...env },
  })
}

describe("#given a live disabled_mcps declaration", () => {
  test("#when no layer authors the key #then the installed deny is preserved silently", () => {
    // given
    const fixture = makeFixture()
    // when
    const resolved = resolveLists(fixture, mcpManifest())
    // then: the MCP kill switch is live now, with its own scope rule, but an
    // untouched install behaves exactly as the baked one did.
    expect(NATIVE_DISABLED_LIST_POLICY.mcps).toBe("live-harden-only")
    expect(resolved.lists.mcps).toEqual(["context7"])
    expect(resolved.diagnostics).toEqual([])
  })

  test("#when a USER layer declares a list #then it replaces the installed deny", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "disabled_mcps": ["ssh"] } }`)
    // when
    const resolved = resolveLists(fixture, mcpManifest())
    // then
    expect(resolved.lists.mcps).toEqual(["ssh"])
    expect(resolved.diagnostics).toHaveLength(1)
    expect(resolved.diagnostics[0]).toContain("disabled_mcps")
    expect(resolved.diagnostics[0]).toContain("Reinstall to resync the manifest")
  })

  test("#when the USER declares an explicit empty list #then every installed deny is released", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "disabled_mcps": [] } }`)
    // when
    const resolved = resolveLists(fixture, mcpManifest())
    // then: the user is the only scope allowed to release a protection
    expect(resolved.lists.mcps).toEqual([])
  })

  test("#when only a PROJECT layer declares a list #then it hardens the installed deny", () => {
    // given
    const fixture = makeFixture()
    fixture.writeProject(`{ "[opencode]": { "disabled_mcps": ["ssh"] } }`)
    // when
    const resolved = resolveLists(fixture, mcpManifest())
    // then: a project may add a deny, and it can never release the installed one
    expect(resolved.lists.mcps).toEqual(["context7", "ssh"])
  })

  test("#when a PROJECT layer declares an empty list #then the installed and user denies survive", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "disabled_mcps": ["context7"] } }`)
    fixture.writeProject(`{ "[opencode]": { "disabled_mcps": [] } }`)
    // when
    const resolved = resolveLists(fixture, mcpManifest())
    // then: `[]` from a project is "this project adds no deny", never a release
    expect(resolved.lists.mcps).toEqual(["context7"])
  })

  test("#when a PROJECT adds a deny beside a USER declaration #then both are enforced", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "disabled_mcps": ["ssh"] } }`)
    fixture.writeProject(`{ "[opencode]": { "disabled_mcps": ["obsidian"] } }`)
    // when
    const resolved = resolveLists(fixture, mcpManifest())
    // then: the user list is the baseline and the project entry hardens it
    expect(resolved.lists.mcps).toEqual(["ssh", "obsidian"])
  })

  test("#when the USER declares through the profile block the shipped profile uses #then the release is honored", () => {
    // given: `profiles.<p>.[opencode]` is where the shipped profile declares the
    // key, so a release there MUST count as a user declaration
    const fixture = makeFixture()
    fixture.writeUser(`{ "profiles": { "gabo": { "[opencode]": { "disabled_mcps": [] } } } }`)
    // when
    const resolved = resolveLists(fixture, mcpManifest(), { OMO_PROFILE: "gabo" })
    // then
    expect(resolved.lists.mcps).toEqual([])
    expect(resolved.diagnostics.some((line) => line.includes("disabled_mcps"))).toBe(true)
  })

  test("#when the USER releases everything and a PROJECT adds a deny #then the project deny still applies", () => {    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "disabled_mcps": [] } }`)
    fixture.writeProject(`{ "[opencode]": { "disabled_mcps": ["ssh"] } }`)
    // when
    const resolved = resolveLists(fixture, mcpManifest())
    // then
    expect(resolved.lists.mcps).toEqual(["ssh"])
  })
})

describe("#given an unconfirmed disabled_mcps declaration", () => {
  test("#when a USER value is refused by the schema #then the installed deny is kept", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "disabled_mcps": "ssh" } }`)
    // when
    const resolved = resolveLists(fixture, mcpManifest())
    // then: an unconfirmed deny must keep denying, never release the protection
    expect(resolved.lists.mcps).toEqual(["context7"])
    expect(resolved.diagnostics.some((line) => line.includes("disabled_mcps") && line.includes("kept the installed denylist"))).toBe(true)
  })

  test("#when a PROJECT value is refused by the schema #then the installed deny is kept and the refusal is named", () => {
    // given
    const fixture = makeFixture()
    fixture.writeProject(`{ "[opencode]": { "disabled_mcps": 7 } }`)
    // when
    const resolved = resolveLists(fixture, mcpManifest())
    // then
    expect(resolved.lists.mcps).toEqual(["context7"])
    expect(resolved.diagnostics.some((line) => line.includes("project") && line.includes("refused by the schema"))).toBe(true)
  })

  test("#when the layer cannot be parsed #then the installed deny is kept", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "disabled_mcps": [] }`)
    // when
    const resolved = resolveLists(fixture, mcpManifest())
    // then
    expect(resolved.lists.mcps).toEqual(["context7"])
    expect(resolved.diagnostics.some((line) => line.includes("disabled_mcps") && line.includes("kept the installed denylist"))).toBe(true)
  })
})

describe("#given the user-only mcp_env_allowlist", () => {
  test("#when a USER layer declares a list #then the live user list is authoritative", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "mcp_env_allowlist": ["USER_VAR"] } }`)
    // when
    const resolved = resolveAllowlist(fixture, mcpManifest())
    // then
    expect(resolved.state).toBe("declared")
    expect(resolved.allowlist).toEqual(["USER_VAR"])
    expect(resolved.diagnostics).toHaveLength(1)
    expect(resolved.diagnostics[0]).toContain("mcp_env_allowlist")
  })

  test("#when the USER declares an explicit empty list #then no reference may expand", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "mcp_env_allowlist": [] }`)
    // when
    const resolved = resolveAllowlist(fixture, mcpManifest())
    // then: `[]` is a declaration, never absence
    expect(resolved.allowlist).toEqual([])
  })

  test("#when no layer declares it #then the installed allowlist is kept", () => {
    // given
    const fixture = makeFixture()
    // when
    const resolved = resolveAllowlist(fixture, mcpManifest())
    // then: an install that never edited anything behaves exactly as before
    expect(resolved.state).toBe("undeclared")
    expect(resolved.allowlist).toEqual(["BAKED_VAR"])
    expect(resolved.diagnostics).toEqual([])
  })

  test("#when a USER value is refused by the schema #then the allowlist fails closed to empty", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "mcp_env_allowlist": "USER_VAR" } }`)
    // when
    const resolved = resolveAllowlist(fixture, mcpManifest())
    // then: a grant list that cannot be confirmed grants nothing. `.mcp.json` can
    // live in a project directory, so resurrecting the installed grants here is
    // exactly the leak the allowlist exists to stop.
    expect(resolved.state).toBe("error")
    expect(resolved.allowlist).toEqual([])
    expect(resolved.diagnostics.some((line) => line.includes("mcp_env_allowlist") && line.includes("fail-closed"))).toBe(true)
  })

  test("#when a layer cannot be parsed #then the allowlist fails closed to empty", () => {
    // given
    const fixture = makeFixture()
    fixture.writeUser(`{ "mcp_env_allowlist": ["USER_VAR"] `)
    // when
    const resolved = resolveAllowlist(fixture, mcpManifest())
    // then
    expect(resolved.state).toBe("error")
    expect(resolved.allowlist).toEqual([])
    expect(resolved.diagnostics.some((line) => line.includes("fail-closed"))).toBe(true)
  })

  test("#when only a PROJECT layer declares it #then the installed allowlist is kept and no grant is added", () => {
    // given
    const fixture = makeFixture()
    fixture.writeProject(`{ "[opencode]": { "mcp_env_allowlist": ["PROJECT_VAR"] } }`)
    // when
    const resolved = resolveAllowlist(fixture, mcpManifest())
    // then: the fold refuses a project placement by SCOPE, so it is not a
    // declaration and it can never extend the grant set.
    expect(resolved.state).toBe("undeclared")
    expect(resolved.allowlist).toEqual(["BAKED_VAR"])
  })
})
