import { describe, expect, test } from "bun:test"

import * as config from "./rigel-v2-native-config.mjs"
import { buildConditionalToolDefinitions } from "./rigel-v2-native-conditional-tools.mjs"
import { TEAM_TOOL_NAMES } from "./tools/team.tools.mjs"

// The gates are materialized into the agent manifest at INSTALL time, so a
// runtime that reads only the manifest answers an edited `~/.omo/omo.jsonc` with
// the stale install-time value and says nothing about it: disabling `team_mode`
// left the `team_*` tools registered with no error, no notice and no way to tell
// the edit had been discarded.
//
// Contract: the gate record resolves under an EXPLICIT LIVE/BAKED policy, a gate
// the live chain declares wins over the baked manifest, a disagreement is
// reported, an undeclared key keeps the manifest value, and an unreadable chain
// FAILS CLOSED (never "undeclared", never a manifest revival).

function memoryFileSystem(files) {
  const entries = new Map(Object.entries(files))
  return {
    existsSync: (path) => entries.has(path),
    lstatSync: () => ({ isSymbolicLink: () => false }),
    readFileSync: (path) => {
      const value = entries.get(path)
      if (value === undefined) throw new Error(`ENOENT: ${path}`)
      return value
    },
    realpathSync: (path) => path,
  }
}

const HOME = "/home/rigeltest"
const PROJECT = `${HOME}/proj`
const USER_CONFIG = `${HOME}/.omo/omo.jsonc`
const PROJECT_CONFIG = `${PROJECT}/.omo/omo.jsonc`
const ENV = { HOME }
const GATE_KEYS = ["monitor", "goal", "task_system", "team_mode", "interactive_bash", "hashline_edit", "preemptive_compaction"]

function manifestWith(gates) {
  return { metadata: { global: { gates } } }
}

function resolve(manifest, fileSystem) {
  return config.resolveNativeGates({ manifest, directory: PROJECT, env: ENV, fileSystem })
}

function projectDeclaring(block, path = PROJECT_CONFIG) {
  return memoryFileSystem({ [path]: JSON.stringify({ "[opencode]": block }) })
}

const UNRESOLVABLE = {
  existsSync: () => {
    throw new Error("EACCES: cannot resolve the config chain")
  },
  lstatSync: () => ({ isSymbolicLink: () => false }),
  readFileSync: () => {
    throw new Error("EACCES")
  },
  realpathSync: (path) => path,
}

describe("#given the gate policy", () => {
  test("#when the policy is read #then every known gate has one explicit LIVE or BAKED decision", () => {
    // given
    const policy = config.NATIVE_GATE_POLICY
    // when
    const decided = Object.keys(policy)
    // then: a gate added to the reader without a policy decision would silently
    // inherit "baked" behavior, so the policy must cover the gate surface exactly.
    expect(decided.sort()).toEqual([...GATE_KEYS].sort())
    for (const gate of GATE_KEYS) expect(["live", "baked"]).toContain(policy[gate])
  })
})

describe("#given a LIVE gate declared by the live config chain", () => {
  test("#when the project layer declares true and the manifest baked false #then the live value wins and the drift is reported", () => {
    // given
    const manifest = manifestWith({ team_mode: false })
    // when
    const resolution = resolve(manifest, projectDeclaring({ team_mode: { enabled: true } }))
    // then
    expect(resolution.gates.team_mode).toBe(true)
    expect(resolution.diagnostics).toHaveLength(1)
    expect(resolution.diagnostics[0]).toContain("team_mode")
    expect(resolution.diagnostics[0]).toContain("true")
    expect(resolution.diagnostics[0]).toContain("false")
  })

  test("#when the project layer disables a gate the manifest baked on #then the family turns off instead of staying stale", () => {
    // given: the reported defect - the user disables team_mode and the tools stay
    const manifest = manifestWith({ team_mode: true })
    // when
    const resolution = resolve(manifest, projectDeclaring({ team_mode: { enabled: false } }))
    // then
    expect(resolution.gates.team_mode).toBe(false)
    expect(resolution.diagnostics).toHaveLength(1)
    expect(resolution.diagnostics[0]).toContain("team_mode")
  })

  test("#when the user layer declares the gate #then it is honored as well as the project layer", () => {
    // given
    const fileSystem = projectDeclaring({ team_mode: { enabled: true } }, USER_CONFIG)
    // when
    const resolution = resolve(manifestWith({ team_mode: false }), fileSystem)
    // then
    expect(resolution.gates.team_mode).toBe(true)
  })

  test("#when the live value agrees with the baked manifest #then nothing is reported", () => {
    // given
    const manifest = manifestWith({ team_mode: true })
    // when
    const resolution = resolve(manifest, projectDeclaring({ team_mode: { enabled: true } }))
    // then
    expect(resolution.gates.team_mode).toBe(true)
    expect(resolution.diagnostics).toEqual([])
  })

  test("#when the monitor family is declared #then the block itself is the declaration", () => {
    // given: `validateMonitor` materializes `enabled: false`, so a block that
    // exists without `enabled` declares the family and reads the documented false.
    const manifest = manifestWith({ monitor: true })
    // when
    const resolution = resolve(manifest, projectDeclaring({ monitor: { max_runtime_ms: 60000 } }))
    // then
    expect(resolution.gates.monitor).toBe(false)
    expect(resolution.diagnostics).toHaveLength(1)
    expect(resolution.diagnostics[0]).toContain("monitor")
  })
})

describe("#given a LIVE gate no layer declares", () => {
  test("#when resolved #then the materialized manifest value is preserved and nothing is invented", () => {
    // given
    const nothingDeclared = memoryFileSystem({})
    // when
    const on = resolve(manifestWith({ team_mode: true, monitor: true }), nothingDeclared)
    const off = resolve(manifestWith({ team_mode: false, monitor: false }), nothingDeclared)
    // then
    expect(on.gates.team_mode).toBe(true)
    expect(on.gates.monitor).toBe(true)
    expect(off.gates.team_mode).toBe(false)
    expect(off.gates.monitor).toBe(false)
    expect(on.diagnostics).toEqual([])
    expect(off.diagnostics).toEqual([])
  })

  test("#when the live reader is asked #then the undeclared gates are absent from the live record rather than guessed", () => {
    // given
    const fileSystem = projectDeclaring({ team_mode: { enabled: true } })
    // when
    const live = config.readLiveGatesSource({ directory: PROJECT, env: ENV, fileSystem })
    // then
    expect(live.state).toBe("resolved")
    expect(live.gates.team_mode).toBe(true)
    expect("monitor" in live.gates).toBe(false)
  })
})

describe("#given the live chain cannot be resolved at all", () => {
  test("#when resolved #then the state is error, not undeclared, and the manifest cannot revive a LIVE gate", () => {
    // given
    const manifest = manifestWith({ team_mode: true, monitor: true })
    // when
    const live = config.readLiveGatesSource({ directory: PROJECT, env: ENV, fileSystem: UNRESOLVABLE })
    const resolution = resolve(manifest, UNRESOLVABLE)
    // then
    expect(live.state).toBe("error")
    expect(config.readLiveGatesSource({ directory: PROJECT, env: ENV, fileSystem: memoryFileSystem({}) }).state).toBe("resolved")
    expect(resolution.gates.team_mode).toBe(false)
    expect(resolution.gates.monitor).toBe(false)
    expect(resolution.diagnostics).toHaveLength(1)
    expect(resolution.diagnostics[0]).toContain("unreadable")
  })

  test("#when resolved #then a BAKED gate keeps its manifest value because it never reads the chain", () => {
    // given
    const manifest = manifestWith({ interactive_bash: true, hashline_edit: true, task_system: true })
    // when
    const resolution = resolve(manifest, UNRESOLVABLE)
    // then
    expect(resolution.gates.interactive_bash).toBe(true)
    expect(resolution.gates.hashline_edit).toBe(true)
    expect(resolution.gates.task_system).toBe(true)
  })
})

describe("#given a gate the policy keeps BAKED", () => {
  test("#when the live chain declares the opposite #then the manifest value is used and no drift is reported", () => {
    // given: `goal` is quarantined, `interactive_bash` depends on host capability,
    // and the rest have a materialized default the live view cannot distinguish
    // from absence, so none of them may be re-resolved from the chain yet.
    const manifest = manifestWith({ goal: false, interactive_bash: true, task_system: false, hashline_edit: false, preemptive_compaction: false })
    const fileSystem = projectDeclaring({
      goal: { enabled: true },
      disabled_tools: ["interactive_bash"],
      experimental: { task_system: true, hashline_edit: true, preemptive_compaction: true },
      hashline_edit: true,
    })
    // when
    const resolution = resolve(manifest, fileSystem)
    // then
    expect(resolution.gates.goal).toBe(false)
    expect(resolution.gates.interactive_bash).toBe(true)
    expect(resolution.gates.task_system).toBe(false)
    expect(resolution.gates.hashline_edit).toBe(false)
    expect(resolution.gates.preemptive_compaction).toBe(false)
    expect(resolution.diagnostics).toEqual([])
  })
})

describe("#given the conditional tool surface", () => {
  const teamStorage = { get: async () => undefined, set: async () => {} }

  test("#when the live config disables team_mode #then no team tool registers even though the manifest baked it on", () => {
    // given
    const manifest = manifestWith({ team_mode: true })
    const resolution = resolve(manifest, projectDeclaring({ team_mode: { enabled: false } }))
    // when
    const { names } = buildConditionalToolDefinitions({ gates: resolution.gates, taskStore: {}, goalStore: {}, teamStorage })
    // then
    for (const name of TEAM_TOOL_NAMES) expect(names, name).not.toContain(name)
  })

  test("#when the live config enables team_mode #then the team tools register", () => {
    // given
    const manifest = manifestWith({ team_mode: false })
    const resolution = resolve(manifest, projectDeclaring({ team_mode: { enabled: true } }))
    // when
    const { names } = buildConditionalToolDefinitions({ gates: resolution.gates, taskStore: {}, goalStore: {}, teamStorage })
    // then
    for (const name of TEAM_TOOL_NAMES) expect(names, name).toContain(name)
  })
})
