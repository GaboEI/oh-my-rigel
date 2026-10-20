import { describe, expect, test } from "bun:test"
import { createTmuxVizManager } from "./rigel-v2-tmux-viz-manager.mjs"
import { createTmuxVizProjectRegistry, resolveChildSessionInfo } from "./rigel-v2-tmux-viz-projects.mjs"
import { discoverCallerPane } from "./rigel-v2-tmux-viz-env.mjs"

/**
 * Live activation, reproduced exactly.
 *
 * Retest 5 (sandbox /tmp/omr-row55-retest5-XelpfV, OpenCode 2.0.32) created two
 * real running child sessions and then did nothing at all: no pane, no
 * `spawned pane` line, no `deferred spawn` line, not even the one-time
 * `session status domain=` line. The plugin was healthy, the gate resolved
 * `tmux_visualization = true`, and the readiness seam was the hardened one.
 *
 * The cause was one step earlier. Caller-pane discovery enumerates EVERY pane on
 * the tmux server and accepts exactly one OpenCode TUI pane per project
 * directory. That run had two: `%19` left over from retest 4 and `%26` for
 * retest 5, both `cmd=opencode` in the same project directory. Discovery refused
 * to guess, `detectTmuxVizEnvironment` therefore produced a `degradedReason`,
 * `enabled` became false, and `onSessionCreated` returned at its first line.
 *
 * The service process itself carried `TMUX_PANE=%26` - the inherited pane of the
 * TUI that started it, which is authoritative for THIS project and is already
 * one of the validated candidates. Ignoring it turned a decidable situation into
 * a silent dead feature.
 *
 * These tests drive the REAL chain the host drives: the host's own
 * `session.created` payload shape -> `resolveChildSessionInfo` -> the project
 * registry -> the real manager -> `split-window`. The manager is never handed a
 * pane id directly, which is exactly the shortcut that let the unit replay pass
 * while the live run stayed dark.
 */

// Neutral fixture path: `validate-profile.mjs` rejects personal paths and project
// names in shipped sources, and the directory identity is irrelevant here.
const PROJECT_DIR = "/work/project-alpha"
const STALE_PANE = "%19"
const OWN_PANE = "%26"
const MEMBER_SESSION = "ses_row55_live_activation_member"
const LEAD_SESSION = "ses_row55_live_activation_lead"

/** The live V2 payload: `properties` is EMPTY, the identity lives in `data`. */
const HOST_EVENT = Object.freeze({
  type: "session.created",
  properties: {},
  data: Object.freeze({
    sessionID: MEMBER_SESSION,
    projectID: "prj_live",
    location: Object.freeze({ directory: PROJECT_DIR }),
    subpath: "",
    parentID: LEAD_SESSION,
    slug: "calm-nebula",
    title: "analyst",
    agent: "Sisyphus-Junior",
  }),
})

/** Two TUI panes in one project directory, exactly as `list-panes -a` returned. */
const DISCOVERY_LISTING = [
  `${STALE_PANE}\t0\topencode\t${PROJECT_DIR}\tretest4\t`,
  `${OWN_PANE}\t0\topencode\t${PROJECT_DIR}\tretest5\t`,
  "",
].join("\n")

function createRunner() {
  const calls = []
  // `respond` is SYNCHRONOUS on purpose: the manager's runner reads
  // `child.exitCode`/`stdout`/`stderr` as promises straight off the object the
  // spawn function returns. Returning a promise of that object makes every field
  // undefined and every tmux query look like a failure ("window state
  // unavailable").
  const respond = (args) => {
    if (args[0] === "list-panes" && args.includes("-a")) {
      return { exitCode: 0, stdout: DISCOVERY_LISTING, stderr: "" }
    }
    // Window state for the caller pane: 220x55 with a single pane (retest 4's
    // measured window), so the spawn decision is "split", never "defer". The
    // record must describe the SOURCE pane (%26): the layout code looks it up by
    // id and finds no main pane otherwise ("window state unavailable").
    if (args[0] === "list-panes") {
      return { exitCode: 0, stdout: `${OWN_PANE}\t200\t55\t0\t0\t1\t220\t55\t1\t1\t\n`, stderr: "" }
    }
    if (args[0] === "split-window") return { exitCode: 0, stdout: "%77\n", stderr: "" }
    return { exitCode: 0, stdout: "", stderr: "" }
  }
  const run = async (args) => {
    calls.push(args.join(" "))
    return respond(args)
  }
  return { calls, run, respond }
}

function createSpawnProbe(runner) {
  const spawnCalls = []
  return {
    spawnCalls,
    spawnImpl: (args) => {
      spawnCalls.push(args.join(" "))
      const result = runner.respond(args)
      return {
        exitCode: Promise.resolve(result.exitCode),
        stdout: Promise.resolve(result.stdout),
        stderr: Promise.resolve(result.stderr),
      }
    },
  }
}

function buildRegistry({ tmuxEnv, discoveryPreferredPaneId }) {
  const runner = createRunner()
  const probe = createSpawnProbe(runner)
  const logs = []
  const registry = createTmuxVizProjectRegistry({
    manifest: { metadata: { global: { tmuxVisualization: true } } },
    env: tmuxEnv,
    teamModeEnabled: true,
    resolveGate: () => true,
    logger: (message) => logs.push(message),
    discoverPane: (directory) =>
      discoverCallerPane({
        tmuxPath: "tmux",
        directory,
        run: runner.run,
        preferredPaneId: discoveryPreferredPaneId,
      }),
    createManager: ({ directory, discoveredPaneId, discoveryReason }) =>
      createTmuxVizManager({
        config: { layout: "main-vertical", isolation: "inline" },
        env: tmuxEnv,
        serverUrl: "http://127.0.0.1:1",
        directory,
        discoveredPaneId,
        discoveryReason,
        fetchSessionStatus: async () => ({ kind: "value", status: "running" }),
        isPersistentSession: () => true,
        spawnImpl: probe.spawnImpl,
        sleep: async () => {},
        healthMarker: {},
        logger: (message) => logs.push(message),
      }),
    normalizeDirectory: (value) => value,
  })
  return { registry, runner, probe, logs }
}

describe("live activation: two TUI panes in one project (retest 5)", () => {
  test("the host payload is enough to identify the child and its project", () => {
    const info = resolveChildSessionInfo(HOST_EVENT)
    expect(info).toEqual({
      id: MEMBER_SESSION,
      parentID: LEAD_SESSION,
      directory: PROJECT_DIR,
      title: "analyst",
    })
  })

  test("the inherited TMUX_PANE is accepted when it is a validated candidate", async () => {
    const discovery = await discoverCallerPane({
      tmuxPath: "tmux",
      directory: PROJECT_DIR,
      run: createRunner().run,
      preferredPaneId: OWN_PANE,
    })
    expect(discovery.paneId).toBe(OWN_PANE)
    expect(discovery.candidateCount).toBe(2)
    expect(discovery.reason).toBeNull()
  })

  test("WITHOUT an inherited pane the ambiguity still fails closed", async () => {
    const discovery = await discoverCallerPane({
      tmuxPath: "tmux",
      directory: PROJECT_DIR,
      run: createRunner().run,
    })
    expect(discovery.paneId).toBeNull()
    expect(discovery.reason).toContain("ambiguous caller pane")

    const { registry, probe, logs } = buildRegistry({
      tmuxEnv: { PATH: process.env.PATH, TMUX: "/tmp/tmux-1000/default,1,0" },
      discoveryPreferredPaneId: undefined,
    })
    const manager = await registry.ensure(PROJECT_DIR)
    expect(manager).not.toBeNull()
    expect(manager.enabled).toBe(false)
    await manager.onSessionCreated(HOST_EVENT, resolveChildSessionInfo(HOST_EVENT))
    expect(probe.spawnCalls.filter((call) => call.startsWith("split-window"))).toHaveLength(0)
    // Fail-closed must never be SILENT again: the refusal is what retest 5 needed
    // to see and could not, because it went to a console nobody reads.
    expect(logs.join("\n")).toContain("degraded for")
    expect(logs.join("\n")).toContain("ambiguous caller pane")
    await registry.cleanup()
  })

  test("retest 5 end to end: the member pane is really split from the caller's own pane", async () => {
    const { registry, probe, logs } = buildRegistry({
      tmuxEnv: { PATH: process.env.PATH, TMUX: "/tmp/tmux-1000/default,1,0", TMUX_PANE: OWN_PANE },
      discoveryPreferredPaneId: OWN_PANE,
    })
    const manager = await registry.ensure(PROJECT_DIR)
    expect(manager).not.toBeNull()
    expect(manager.enabled).toBe(true)
    expect(manager.degradedReason).toBeNull()

    await manager.onSessionCreated(HOST_EVENT, resolveChildSessionInfo(HOST_EVENT))

    const splits = probe.spawnCalls.filter((call) => call.startsWith("split-window"))
    expect(splits).toHaveLength(1)
    // The split must target THIS instance's pane, never the stale sibling.
    expect(splits[0]).toContain(OWN_PANE)
    expect(splits[0]).not.toContain(STALE_PANE)
    expect(manager.getTrackedPaneId(MEMBER_SESSION)).toBe("%77")
    // The line a live operator needs in order to see the feature working.
    expect(logs.join("\n")).toContain("spawned pane %77")
    await registry.cleanup()
  })
})
