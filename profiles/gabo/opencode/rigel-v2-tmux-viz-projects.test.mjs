import { describe, expect, test } from "bun:test"

import * as registryModule from "./rigel-v2-tmux-viz-projects.mjs"

// Row 55 re-audit. One V2 plugin instance can serve SEVERAL projects while
// `context.location.directory` stays the instance's STATIC location. Resolving
// the public gate once at setup therefore froze every project in the daemon to
// the first project's value: a project declaring
// `team_mode.tmux_visualization = true` got nothing.
//
// Contract proven here: the gate, the caller pane and the pane working directory
// are resolved PER PROJECT; one project's value can never leak into another's;
// a project whose gate is off constructs nothing at all; and an unresolvable or
// throwing chain fails closed for that project only.

const MANIFEST = { metadata: { global: { tmuxVisualization: false } } }
const ENV = {}
const PROJECT_A = "/home/rigeltest/proj-a"
const PROJECT_B = "/home/rigeltest/proj-b"
const PROJECT_OFF = "/home/rigeltest/proj-off"

function build(options = {}) {
  const created = []
  const discoveredFor = []
  const refusedGates = new Set(options.refuseGatesFor ?? [])
  const gateValues = options.gateValues ?? { [PROJECT_A]: true, [PROJECT_B]: true, [PROJECT_OFF]: false }
  const registry = registryModule.createTmuxVizProjectRegistry({
    manifest: MANIFEST,
    env: ENV,
    teamModeEnabled: options.teamModeEnabled ?? true,
    resolveGate: ({ directory }) => {
      if (refusedGates.has(directory)) throw new Error(`unreadable chain for ${directory}`)
      return gateValues[directory] === true
    },
    discoverPane: async (directory) => {
      discoveredFor.push(directory)
      if (options.discoverThrowsFor === directory) throw new Error("tmux exploded")
      return options.panes?.[directory] ?? { paneId: null, reason: `no caller pane in ${directory}` }
    },
    createManager: ({ directory, discoveredPaneId, discoveryReason }) => {
      const manager = {
        directory,
        discoveredPaneId,
        discoveryReason,
        enabled: options.managerEnabled?.[directory] ?? true,
        degradedReason: options.managerEnabled?.[directory] === false ? "degraded in test" : null,
        cleaned: false,
        async cleanup() {
          manager.cleaned = true
        },
      }
      created.push(manager)
      return manager
    },
    normalizeDirectory: (directory) => directory,
    logger: () => {},
  })
  return { registry, created, discoveredFor }
}

describe("per-project tmux-visualization registry", () => {
  test("#given two projects in one plugin instance with OPPOSITE values #when both are resolved #then only the declaring project gets a manager", async () => {
    const { registry, created } = build({ gateValues: { [PROJECT_A]: true, [PROJECT_OFF]: false } })
    const a = await registry.ensure(PROJECT_A)
    const off = await registry.ensure(PROJECT_OFF)
    expect(a).not.toBeNull()
    expect(off).toBeNull()
    expect(created).toHaveLength(1)
    expect(created[0].directory).toBe(PROJECT_A)
    expect(registry.refusalReason(PROJECT_OFF)).toBe("tmux_visualization is off for this project")
  })

  test("#given the first project resolved ON #when a second project also declares ON #then it gets its OWN manager, not the first project's", async () => {
    const { registry, created } = build()
    const a = await registry.ensure(PROJECT_A)
    const b = await registry.ensure(PROJECT_B)
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a).not.toBe(b)
    expect(created.map((manager) => manager.directory)).toEqual([PROJECT_A, PROJECT_B])
    expect(registry.size).toBe(2)
  })

  test("#given the first project resolved OFF #when a second project declares ON #then the first project does not freeze the second", async () => {
    const { registry, created } = build({ gateValues: { [PROJECT_A]: false, [PROJECT_B]: true } })
    expect(await registry.ensure(PROJECT_A)).toBeNull()
    const b = await registry.ensure(PROJECT_B)
    expect(b).not.toBeNull()
    expect(b.directory).toBe(PROJECT_B)
    expect(created).toHaveLength(1)
  })

  test("#given the gate is off for a project #when resolved #then nothing is constructed for it (no side effect, no default change)", async () => {
    const { registry, created, discoveredFor } = build({ gateValues: { [PROJECT_OFF]: false } })
    expect(await registry.ensure(PROJECT_OFF)).toBeNull()
    expect(created).toHaveLength(0)
    expect(discoveredFor).toHaveLength(0)
  })

  test("#given the install-level team-mode gate is off #when any project is resolved #then nothing is constructed", async () => {
    const { registry, created } = build({ teamModeEnabled: false })
    expect(await registry.ensure(PROJECT_A)).toBeNull()
    expect(await registry.ensure(PROJECT_B)).toBeNull()
    expect(created).toHaveLength(0)
    expect(registry.size).toBe(0)
  })

  test("#given each project has its own caller pane #when resolved #then each manager receives ITS project's pane", async () => {
    const panes = { [PROJECT_A]: { paneId: "%7", reason: null }, [PROJECT_B]: { paneId: "%9", reason: null } }
    const { registry } = build({ panes })
    const a = await registry.ensure(PROJECT_A)
    const b = await registry.ensure(PROJECT_B)
    expect(a.discoveredPaneId).toBe("%7")
    expect(b.discoveredPaneId).toBe("%9")
    expect(a.directory).not.toBe(b.directory)
  })

  test("#given a project has no caller pane #when resolved #then the manager still exists and records the reason (fail closed, not silent)", async () => {
    const { registry } = build({ panes: {} })
    const a = await registry.ensure(PROJECT_A)
    expect(a).not.toBeNull()
    expect(a.discoveredPaneId).toBeNull()
    expect(a.discoveryReason).toBe(`no caller pane in ${PROJECT_A}`)
  })

  test("#given discovery throws for one project #when resolved #then only that project degrades and the reason is kept", async () => {
    const { registry } = build({ discoverThrowsFor: PROJECT_A })
    const a = await registry.ensure(PROJECT_A)
    expect(a).not.toBeNull()
    expect(a.discoveredPaneId).toBeNull()
    expect(a.discoveryReason).toContain("tmux exploded")
  })

  test("#given an unreadable config chain for one project #when resolved #then it fails closed for THAT project only", async () => {
    const { registry, created } = build({ refuseGatesFor: [PROJECT_A] })
    expect(await registry.ensure(PROJECT_A)).toBeNull()
    const b = await registry.ensure(PROJECT_B)
    expect(b).not.toBeNull()
    expect(created.map((manager) => manager.directory)).toEqual([PROJECT_B])
    expect(registry.refusalReason(PROJECT_A)).toContain("gate resolution failed")
  })

  test("#given no project directory #when resolved #then nothing is assumed and nothing is constructed", async () => {
    const { registry, created } = build()
    expect(await registry.ensure(undefined)).toBeNull()
    expect(await registry.ensure("")).toBeNull()
    expect(created).toHaveLength(0)
  })

  test("#given the same project is resolved repeatedly #when resolved #then the SAME manager is returned (one pane set)", async () => {
    const { registry, created, discoveredFor } = build()
    const first = await registry.ensure(PROJECT_A)
    const second = await registry.ensure(PROJECT_A)
    expect(first).toBe(second)
    expect(created).toHaveLength(1)
    expect(discoveredFor).toEqual([PROJECT_A])
  })

  test("#given a project was refused #when it is resolved again #then it is not re-probed and other projects are unaffected", async () => {
    const { registry, discoveredFor } = build({ gateValues: { [PROJECT_A]: true, [PROJECT_OFF]: false } })
    await registry.ensure(PROJECT_OFF)
    await registry.ensure(PROJECT_OFF)
    const a = await registry.ensure(PROJECT_A)
    expect(a).not.toBeNull()
    expect(discoveredFor).toEqual([PROJECT_A])
  })

  test("#given several managers #when cleaned up #then every manager is closed and the registry is empty", async () => {
    const { registry, created } = build()
    await registry.ensure(PROJECT_A)
    await registry.ensure(PROJECT_B)
    expect(registry.size).toBe(2)
    await registry.cleanup()
    expect(created.every((manager) => manager.cleaned)).toBe(true)
    expect(registry.size).toBe(0)
    expect(registry.all()).toEqual([])
  })
})


// Row 55 NLS1 regression. The live daemon emits
// `{ type: "session.created", properties: { sessionID, info: Session } }` and
// `Session.directory` is a TOP-LEVEL field. Reading an invented
// `info.location.directory` resolved no project, so no manager was created and
// no pane ever appeared — while every fixture that fed the invented shape
// passed. These cases pin the authoritative shape so that cannot recur.
describe("resolveChildProjectDirectory", () => {
  const resolve = () => registryModule.resolveChildProjectDirectory

  test("#given the authoritative V2 properties.info payload #then the top-level directory is used", () => {
    const session = { id: "ses_child", directory: PROJECT_A, parentID: "ses_parent", title: "t", projectID: "p" }
    expect(resolve()(session)).toBe(PROJECT_A)
  })

  test("#given both the authoritative directory and a legacy location #then the authoritative one wins", () => {
    const session = { id: "ses_child", directory: PROJECT_A, location: { directory: PROJECT_B } }
    expect(resolve()(session)).toBe(PROJECT_A)
  })

  test("#given an older host that nests location.directory #then it is still honored", () => {
    expect(resolve()({ id: "ses_child", location: { directory: PROJECT_B } })).toBe(PROJECT_B)
  })

  test("#given an SDK-style data envelope #then its directory is honored", () => {
    expect(resolve()({ id: "ses_child", data: { directory: PROJECT_OFF } })).toBe(PROJECT_OFF)
  })

  test("#given no resolvable directory #then nothing is assumed", () => {
    expect(resolve()({ id: "ses_child", parentID: "ses_parent" })).toBeUndefined()
    expect(resolve()({ id: "ses_child", directory: "" })).toBeUndefined()
    expect(resolve()(undefined)).toBeUndefined()
    expect(resolve()(null)).toBeUndefined()
    expect(resolve()("not-an-object")).toBeUndefined()
  })
})

// The LIVE daemon shape, captured on NLS1 (OpenCode 2.0.32): `properties` is
// EMPTY and the payload is in `data`. `properties.info` is null at runtime even
// though the SDK typings describe it, so the resolver must read `data`.
describe("resolveChildSessionInfo (live V2 daemon shape)", () => {
  const resolve = () => registryModule.resolveChildSessionInfo

  test("#given the live properties-empty data payload #then id, parent and directory resolve", () => {
    const event = {
      type: "session.created",
      properties: {},
      data: {
        sessionID: "ses_child",
        projectID: "prj_1",
        location: { directory: PROJECT_A },
        subpath: null,
        parentID: "ses_parent",
        slug: "s",
        agent: "explore",
        model: { id: "m", providerID: "p" },
        version: "2.0.32",
      },
    }
    expect(resolve()(event)).toEqual({ id: "ses_child", parentID: "ses_parent", directory: PROJECT_A, title: undefined })
  })

  test("#given the live root-session payload with no parentID #then parentID is absent", () => {
    const event = { type: "session.created", properties: {}, data: { sessionID: "ses_root", location: { directory: PROJECT_B } } }
    expect(resolve()(event)?.parentID).toBeUndefined()
    expect(resolve()(event)?.directory).toBe(PROJECT_B)
  })

  test("#given the SDK-typed properties.info payload #then it still wins", () => {
    const event = { type: "session.created", properties: { sessionID: "ses_child", info: { id: "ses_child", parentID: "ses_parent", directory: PROJECT_OFF } }, data: { sessionID: "ses_child", location: { directory: PROJECT_A }, parentID: "ses_parent" } }
    expect(resolve()(event)?.directory).toBe(PROJECT_OFF)
  })

  test("#given a payload with no session identity #then nothing resolves", () => {
    expect(resolve()({ type: "session.created", properties: {}, data: {} })).toBeUndefined()
    expect(resolve()({ type: "session.created", properties: {} })).toBeUndefined()
    expect(resolve()(undefined)).toBeUndefined()
  })
})