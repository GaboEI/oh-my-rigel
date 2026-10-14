/**
 * Fase 3 gate audit (plan F1/F3).
 *
 * Guards the defect where `metadata.global.gates` was never materialized by the
 * manifest generator, so every conditional family (monitor / task_system / goal
 * / interactive_bash) stayed unregistered in production while fixture-only tests
 * passed. This proves the materializer output and the runtime gate reader share
 * one shape, and that the materialized shape actually drives registration.
 */
import { describe, expect, test } from "bun:test"
import { deriveNativeGates, readNativeGates } from "./rigel-v2-native-config.mjs"
import { buildConditionalToolDefinitions } from "./rigel-v2-native-conditional-tools.mjs"
import { createNativeToolFamilies } from "./rigel-v2-native-tools.mjs"
import { TASK_TOOL_NAMES } from "./tools/task.tools.mjs"
import { GOAL_TOOL_NAMES } from "./tools/goal.tools.mjs"

const GATE_OFF = { interactive_bash: false, task_system: false, goal: false, monitor: false, hashline_edit: false, preemptive_compaction: false }

function materialize(view) {
  return { metadata: { global: { gates: deriveNativeGates(view) } } }
}

function fakeContext() {
  return {
    session: {
      list: async () => ({ data: [] }),
      get: async () => ({ data: undefined }),
      messages: async () => ({ data: [] }),
      create: async () => ({ data: { id: "ses_child" } }),
      prompt: async () => ({ data: {} }),
      wait: async () => {},
      context: async () => ({ data: [] }),
    },
    pty: { create: async () => ({ data: { id: "pty_1" } }), remove: async () => {}, snapshot: async () => ({ data: { text: "" } }) },
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, scan: async () => [] },
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
  }
}

describe("#given the manifest materializer and the runtime gate reader", () => {
  test("#when a config view is materialized #then readNativeGates returns exactly the derived gates", () => {
    // given
    const views = [
      { disabled: { tools: [] } },
      { monitor: { enabled: true }, goal: { enabled: true }, experimental: { task_system: true }, disabled: { tools: [] } },
      { monitor: { enabled: true }, disabled: { tools: ["interactive_bash"] } },
    ]
    for (const view of views) {
      // when
      const derived = deriveNativeGates(view)
      const read = readNativeGates(materialize(view))
      // then
      expect(read).toEqual(derived)
    }
  })

  test("#when a materialized gates-on manifest is read #then every gated family registers except the quarantined goal", () => {
    // given: the view enables the inherited Goal, but the quarantine keeps its
    // gate false, so the legacy goal tools must not register (N2).
    const manifest = materialize({ monitor: { enabled: true }, goal: { enabled: true }, experimental: { task_system: true }, disabled: { tools: [] } })
    const gates = readNativeGates(manifest)
    const taskStore = { readTask: async () => null, writeTask: async () => {}, listTasks: async () => [] }
    const goalStore = { readGoal: async () => null, writeGoal: async () => {}, createGoal: async () => {}, updateGoal: async () => null, clearGoal: async () => false }
    // when
    const conditional = buildConditionalToolDefinitions({ gates, taskStore, goalStore, tmuxPath: "/usr/bin/tmux", ptyRunner: { run: async () => {} } })
    const families = createNativeToolFamilies({ clients: [fakeContext()], location: { directory: "/work" }, manifest, context: fakeContext(), pluginConfig: { monitor: { enabled: true } }, serverApi: { available: true, origin: "http://127.0.0.1:1" } })
    // then
    expect(gates.goal).toBe(false)
    expect(conditional.names.sort()).toEqual([...TASK_TOOL_NAMES, "interactive_bash"].sort())
    for (const name of GOAL_TOOL_NAMES) expect(conditional.names, name).not.toContain(name)
    for (const name of ["monitor_start", "monitor_stop", "monitor_list", "monitor_output"]) {
      expect(families.tools[name], name).toBeDefined()
    }
  })

  test("#when the default profile is materialized #then config-gated families stay absent", () => {
    // given: the gabo profile is all-off; with no tmux path the interactive_bash family cannot register
    const manifest = materialize({ disabled: { tools: [] } })
    // when
    const gates = readNativeGates(manifest)
    const conditional = buildConditionalToolDefinitions({ gates, taskStore: {}, goalStore: {} })
    const families = createNativeToolFamilies({ clients: [fakeContext()], location: { directory: "/work" }, manifest, context: fakeContext(), pluginConfig: {} })
    // then
    expect(gates).toEqual({ ...GATE_OFF, team_mode: false, interactive_bash: true })
    expect(conditional.names).toEqual([])
    expect(families.tools.monitor_start).toBeUndefined()
  })

  test("#when an unknown or malformed gate appears #then only known explicit-true gates resolve", () => {
    // given / when
    const gates = readNativeGates({ metadata: { global: { gates: { unknown_gate: true, goal: "yes" } } } })
    // then
    expect(gates.goal).toBe(false)
    expect("unknown_gate" in gates).toBe(false)
  })
})
