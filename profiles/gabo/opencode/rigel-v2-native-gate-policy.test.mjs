import { describe, expect, test } from "bun:test"
import { join, resolve as resolvePath } from "node:path"

import * as config from "./rigel-v2-native-config.mjs"
import { buildConditionalToolDefinitions } from "./rigel-v2-native-conditional-tools.mjs"
import { TEAM_TOOL_NAMES } from "./tools/team.tools.mjs"
import { TASK_TOOL_NAMES } from "./tools/task.tools.mjs"

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

// The chain is resolved with the host `path` rules (the runtime uses `join` /
// `resolve`), so the fixture's keys are built the same way: a hard-coded
// `/home/rigeltest/.omo/omo.jsonc` never matches on Windows, where the runtime
// looks for `\home\rigeltest\.omo\omo.jsonc` and finds nothing.
const HOME = resolvePath("/home/rigeltest")
const PROJECT = join(HOME, "proj")
const USER_CONFIG = join(HOME, ".omo", "omo.jsonc")
const PROJECT_CONFIG = join(PROJECT, ".omo", "omo.jsonc")
const ENV = { HOME }
const GATE_KEYS = ["monitor", "goal", "task_system", "team_mode", "interactive_bash", "hashline_edit", "preemptive_compaction"]

function manifestWith(gates, profile) {
  return { metadata: { ...(profile === undefined ? {} : { profile }), global: { gates } } }
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

  test("#when the profile environment is absent but the manifest records the profile #then the profile's live gate still wins", () => {
    // given: a restart path lost OMO_PROFILE, while the installed manifest retains the selected profile.
    const manifest = manifestWith({ team_mode: false }, "gabo")
    const fileSystem = memoryFileSystem({
      [USER_CONFIG]: JSON.stringify({
        profiles: { gabo: { "[opencode]": { team_mode: { enabled: true } } } },
      }),
    })
    // when
    const resolution = resolve(manifest, fileSystem)
    // then
    expect(resolution.gates.team_mode).toBe(true)
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
    // given: `goal` is quarantined and `interactive_bash` depends on host
    // capability, so neither may be re-resolved from the chain.
    const manifest = manifestWith({ goal: true, interactive_bash: true })
    // when
    const resolution = resolve(manifest, UNRESOLVABLE)
    // then
    expect(resolution.gates.interactive_bash).toBe(true)
    expect(resolution.gates.goal).toBe(false)
    expect(resolution.gates.task_system).toBe(false)
    expect(resolution.gates.hashline_edit).toBe(false)
  })
})

describe("#given a gate the policy keeps BAKED", () => {
  test("#when the live chain declares the opposite #then the manifest value is used and no drift is reported", () => {
    // given: `goal` is quarantined and `interactive_bash` is host availability,
    // so neither may be re-resolved from the chain even when a layer writes it.
    const manifest = manifestWith({ goal: false, interactive_bash: true })
    const fileSystem = projectDeclaring({
      goal: { enabled: true },
      disabled_tools: ["interactive_bash"],
    })
    // when
    const resolution = resolve(manifest, fileSystem)
    // then
    expect(resolution.gates.goal).toBe(false)
    expect(resolution.gates.interactive_bash).toBe(true)
    expect(resolution.diagnostics).toEqual([])
  })
})

describe("#given the task_system gate resolves LIVE", () => {
  test("#when the project declares it on over a manifest that baked it off #then the live value wins and the drift is reported", () => {
    // given
    const manifest = manifestWith({ task_system: false })
    // when
    const resolution = resolve(manifest, projectDeclaring({ experimental: { task_system: true } }))
    // then
    expect(resolution.gates.task_system).toBe(true)
    expect(resolution.diagnostics).toHaveLength(1)
    expect(resolution.diagnostics[0]).toContain("task_system")
    expect(resolution.diagnostics[0]).toContain("drift")
  })

  test("#when the project declares it off over a manifest that baked it on #then the family turns off instead of staying stale", () => {
    // given: the reported defect class - the user disables the family and the
    // task tools stay registered from the install-time manifest
    const manifest = manifestWith({ task_system: true })
    // when
    const resolution = resolve(manifest, projectDeclaring({ experimental: { task_system: false } }))
    // then
    expect(resolution.gates.task_system).toBe(false)
    expect(resolution.diagnostics).toHaveLength(1)
    expect(resolution.diagnostics[0]).toContain("task_system")
  })

  test("#when no layer declares it #then the materialized manifest value is preserved in both directions", () => {
    // given
    const nothingDeclared = memoryFileSystem({})
    // when
    const on = resolve(manifestWith({ task_system: true }), nothingDeclared)
    const off = resolve(manifestWith({ task_system: false }), nothingDeclared)
    // then
    expect(on.gates.task_system).toBe(true)
    expect(off.gates.task_system).toBe(false)
    expect(on.diagnostics).toEqual([])
    expect(off.diagnostics).toEqual([])
  })

  test("#when the declared value is refused #then the gate fails closed instead of reviving the manifest", () => {
    // given: a manifest baked it ON, and the live value the user wrote is not a boolean
    const manifest = manifestWith({ task_system: true })
    // when
    const resolution = resolve(manifest, projectDeclaring({ experimental: { task_system: "yes" } }))
    // then
    expect(resolution.gates.task_system).toBe(false)
    expect(resolution.diagnostics).toHaveLength(1)
    expect(resolution.diagnostics[0]).toContain("failed closed")
  })

  test("#when a layer cannot be parsed #then the gate fails closed instead of reviving the manifest", () => {
    // given: the file may have declared the gate, so the runtime cannot confirm it
    const manifest = manifestWith({ task_system: true })
    const broken = memoryFileSystem({ [PROJECT_CONFIG]: `{ "[opencode]": {` })
    // when
    const resolution = resolve(manifest, broken)
    // then: a chain-wide failure is reported once PER LIVE GATE it could not
    // confirm, so the assertion is scoped to this gate instead of the total.
    expect(resolution.gates.task_system).toBe(false)
    const reported = resolution.diagnostics.filter((line) => line.includes("task_system"))
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain("failed closed")
  })
})

describe("#given the hashline_edit gate resolves LIVE", () => {
  test("#when the root key declares it on over a manifest that baked it off #then hashline turns on with a drift report", () => {
    // given
    const manifest = manifestWith({ hashline_edit: false })
    // when
    const resolution = resolve(manifest, projectDeclaring({ hashline_edit: true }))
    // then
    expect(resolution.gates.hashline_edit).toBe(true)
    expect(resolution.diagnostics).toHaveLength(1)
    expect(resolution.diagnostics[0]).toContain("hashline_edit")
    expect(resolution.diagnostics[0]).toContain("drift")
  })

  test("#when only the legacy experimental placement declares it #then it resolves the same gate", () => {
    // given: V1 migrated `experimental.hashline_edit` up to the root key, so an
    // older profile that kept the legacy placement must still be authoritative
    const manifest = manifestWith({ hashline_edit: false })
    // when
    const resolution = resolve(manifest, projectDeclaring({ experimental: { hashline_edit: true } }))
    // then
    expect(resolution.gates.hashline_edit).toBe(true)
    expect(resolution.diagnostics).toHaveLength(1)
    expect(resolution.diagnostics[0]).toContain("hashline_edit")
  })

  test("#when the root key declares it off over a manifest that baked it on #then hashline turns off", () => {
    // given
    const manifest = manifestWith({ hashline_edit: true })
    // when
    const resolution = resolve(manifest, projectDeclaring({ hashline_edit: false }))
    // then
    expect(resolution.gates.hashline_edit).toBe(false)
    expect(resolution.diagnostics).toHaveLength(1)
    expect(resolution.diagnostics[0]).toContain("hashline_edit")
  })

  test("#when no layer declares it #then the materialized manifest value is preserved", () => {
    // given
    const nothingDeclared = memoryFileSystem({})
    // when
    const on = resolve(manifestWith({ hashline_edit: true }), nothingDeclared)
    const off = resolve(manifestWith({ hashline_edit: false }), nothingDeclared)
    // then
    expect(on.gates.hashline_edit).toBe(true)
    expect(off.gates.hashline_edit).toBe(false)
    expect(on.diagnostics).toEqual([])
    expect(off.diagnostics).toEqual([])
  })

  test("#when the declared root value is refused #then the gate fails closed instead of reviving the manifest", () => {
    // given
    const manifest = manifestWith({ hashline_edit: true })
    // when
    const resolution = resolve(manifest, projectDeclaring({ hashline_edit: "yes" }))
    // then
    expect(resolution.gates.hashline_edit).toBe(false)
    expect(resolution.diagnostics).toHaveLength(1)
    expect(resolution.diagnostics[0]).toContain("failed closed")
  })

  test("#when the declared legacy value is refused #then the gate fails closed instead of reviving the manifest", () => {
    // given
    const manifest = manifestWith({ hashline_edit: true })
    // when
    const resolution = resolve(manifest, projectDeclaring({ experimental: { hashline_edit: "yes" } }))
    // then
    expect(resolution.gates.hashline_edit).toBe(false)
    expect(resolution.diagnostics).toHaveLength(1)
    expect(resolution.diagnostics[0]).toContain("failed closed")
  })

  test("#when a layer cannot be parsed #then the gate fails closed instead of reviving the manifest", () => {
    // given
    const manifest = manifestWith({ hashline_edit: true })
    const broken = memoryFileSystem({ [PROJECT_CONFIG]: `{ "[opencode]": {` })
    // when
    const resolution = resolve(manifest, broken)
    // then: a chain-wide failure is reported once PER LIVE GATE it could not
    // confirm, so the assertion is scoped to this gate instead of the total.
    expect(resolution.gates.hashline_edit).toBe(false)
    const reported = resolution.diagnostics.filter((line) => line.includes("hashline_edit"))
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain("failed closed")
  })
})

describe("#given the preemptive compaction gate resolves LIVE", () => {
  test("#when the project declares it on over a manifest that baked it off #then the live value wins and the drift is reported", () => {
    // given
    const manifest = manifestWith({ preemptive_compaction: false })
    // when
    const resolution = resolve(manifest, projectDeclaring({ experimental: { preemptive_compaction: true } }))
    // then
    expect(resolution.gates.preemptive_compaction).toBe(true)
    expect(resolution.diagnostics).toHaveLength(1)
    expect(resolution.diagnostics[0]).toContain("preemptive_compaction")
  })

  test("#when the project declares it off over a manifest that baked it on #then the gate turns off instead of staying stale", () => {
    // given
    const manifest = manifestWith({ preemptive_compaction: true })
    // when
    const resolution = resolve(manifest, projectDeclaring({ experimental: { preemptive_compaction: false } }))
    // then
    expect(resolution.gates.preemptive_compaction).toBe(false)
    expect(resolution.diagnostics).toHaveLength(1)
    expect(resolution.diagnostics[0]).toContain("false")
  })

  test("#when no layer declares it #then the materialized manifest value is preserved", () => {
    // given
    const nothingDeclared = memoryFileSystem({})
    // when
    const on = resolve(manifestWith({ preemptive_compaction: true }), nothingDeclared)
    const off = resolve(manifestWith({ preemptive_compaction: false }), nothingDeclared)
    // then
    expect(on.gates.preemptive_compaction).toBe(true)
    expect(off.gates.preemptive_compaction).toBe(false)
    expect(on.diagnostics).toEqual([])
  })

  test("#when the declared value is refused #then the gate fails closed instead of reviving the manifest", () => {
    // given: a manifest baked it ON, and the live value the user wrote is not a boolean
    const manifest = manifestWith({ preemptive_compaction: true })
    // when
    const resolution = resolve(manifest, projectDeclaring({ experimental: { preemptive_compaction: "yes" } }))
    // then
    expect(resolution.gates.preemptive_compaction).toBe(false)
    expect(resolution.diagnostics).toHaveLength(1)
    expect(resolution.diagnostics[0]).toContain("failed closed")
  })

  test("#when a layer cannot be parsed #then the gate fails closed instead of reviving the manifest", () => {
    // given: the file may have declared the gate, so the runtime cannot confirm it
    const manifest = manifestWith({ preemptive_compaction: true })
    const broken = memoryFileSystem({ [PROJECT_CONFIG]: `{ "[opencode]": {` })
    // when
    const resolution = resolve(manifest, broken)
    // then: a chain-wide failure is reported once PER LIVE GATE it could not
    // confirm, so the assertion is scoped to this gate instead of the total.
    expect(resolution.gates.preemptive_compaction).toBe(false)
    const reported = resolution.diagnostics.filter((line) => line.includes("preemptive_compaction"))
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain("failed closed")
  })
})

describe("#given the conditional tool surface", () => {
  const teamStorage = { get: async () => undefined, set: async () => {} }
  const taskStore = { readTask: async () => null, writeTask: async () => {}, listTasks: async () => [] }

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

  test("#when the live config disables task_system #then no task tool registers even though the manifest baked it on", () => {
    // given: the manifest is the stale install-time record; the live declaration wins
    const manifest = manifestWith({ task_system: true })
    const resolution = resolve(manifest, projectDeclaring({ experimental: { task_system: false } }))
    // when
    const { names } = buildConditionalToolDefinitions({ gates: resolution.gates, taskStore, goalStore: {}, teamStorage })
    // then
    for (const name of TASK_TOOL_NAMES) expect(names, name).not.toContain(name)
  })

  test("#when the live config enables task_system #then the task tools register without a reinstall", () => {
    // given
    const manifest = manifestWith({ task_system: false })
    const resolution = resolve(manifest, projectDeclaring({ experimental: { task_system: true } }))
    // when
    const { names } = buildConditionalToolDefinitions({ gates: resolution.gates, taskStore, goalStore: {}, teamStorage })
    // then
    for (const name of TASK_TOOL_NAMES) expect(names, name).toContain(name)
  })
})
