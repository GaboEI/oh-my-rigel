import { describe, expect, test } from "bun:test"

import * as env from "./rigel-v2-tmux-viz-env.mjs"

// Row 55, stage B. In the official topology the plugin runs INSIDE the
// `opencode serve --service` daemon, which has no `TMUX` and no `TMUX_PANE`,
// so environment-only detection can never find the pane to split from. The
// caller's pane must be discovered from the tmux server instead (a plain
// control-client query on the same socket, no PTY, no bridge).
//
// Fail-closed contract: exactly ONE candidate may match, otherwise the caller
// pane is unresolved and the visualization degrades. The code must never pick
// arbitrarily.

const DIR = "/home/rigeltest/proj"
const OTHER = "/home/rigeltest/other"

// #{pane_id} #{pane_dead} #{pane_current_command} #{pane_current_path} #{pane_title} #{@omo_subagent}
function pane({ paneId, dead = "0", command = "opencode", path = DIR, title = "OC | session", marker = "0" }) {
  return [paneId, dead, command, path, title, marker].join("\t")
}

function scriptedRunner(lines, { exitCode = 0, stderr = "" } = {}) {
  const calls = []
  return {
    calls,
    run: async (args) => {
      calls.push(args)
      return { exitCode, stdout: `${lines.join("\n")}\n`, stderr }
    },
  }
}

async function discover(lines, options = {}) {
  const runner = scriptedRunner(lines)
  const result = await env.discoverCallerPane({
    tmuxPath: "/usr/bin/tmux",
    directory: DIR,
    run: runner.run,
    realpath: (path) => path,
    ...options,
  })
  return { result, runner }
}

describe("caller pane discovery in a TMUX-less daemon", () => {
  test("#given row 55 is unfixed #when the runtime asks for discovery #then the discovery API exists", () => {
    expect(typeof env.discoverCallerPane).toBe("function")
  })

  test("#given exactly one opencode TUI pane in the caller directory #when discovered #then that pane is returned", async () => {
    const { result, runner } = await discover([
      pane({ paneId: "%0", command: "zsh", path: OTHER }),
      pane({ paneId: "%1" }),
      pane({ paneId: "%4", command: "zsh", path: DIR }),
    ])
    expect(result.paneId).toBe("%1")
    expect(result.reason).toBeNull()
    expect(result.candidateCount).toBe(1)
    expect(runner.calls).toHaveLength(1)
  })

  test("#given no pane matches the caller project #when discovered #then it fails closed instead of picking one", async () => {
    const { result } = await discover([
      pane({ paneId: "%0", command: "zsh", path: OTHER }),
      pane({ paneId: "%1" }),
      pane({ paneId: "%4", command: "zsh", path: DIR }),
    ].filter((line) => !line.includes("%1")))
    expect(result.paneId).toBeNull()
    expect(result.candidateCount).toBe(0)
    expect(result.reason).toMatch(/no caller pane/i)
  })

  test("#given two opencode panes share the caller directory #when discovered #then it fails closed as ambiguous", async () => {
    const { result } = await discover([
      pane({ paneId: "%1" }),
      pane({ paneId: "%2", title: "OC | second window" }),
    ])
    expect(result.paneId).toBeNull()
    expect(result.candidateCount).toBe(2)
    expect(result.reason).toMatch(/ambiguous/i)
  })

  test("#given the only match is a dead pane #when discovered #then it is not a candidate", async () => {
    const { result } = await discover([pane({ paneId: "%1", dead: "1" })])
    expect(result.paneId).toBeNull()
    expect(result.candidateCount).toBe(0)
  })

  test("#given the only match is one of our own member panes #when discovered #then it is excluded", async () => {
    const { result } = await discover([pane({ paneId: "%7", title: "omo-subagent-scout" })])
    expect(result.paneId).toBeNull()
    expect(result.candidateCount).toBe(0)
  })

  test("#given a member pane whose TUI overwrote its title #when discovered #then the durable marker still excludes it", async () => {
    const { result } = await discover([
      pane({ paneId: "%1" }),
      pane({ paneId: "%9", title: "opencode", marker: "1" }),
    ])
    expect(result.paneId).toBe("%1")
    expect(result.candidateCount).toBe(1)
  })

  test("#given a non-opencode process holds the caller directory #when discovered #then it is not the caller TUI", async () => {
    const { result } = await discover([pane({ paneId: "%9", command: "zsh" })])
    expect(result.paneId).toBeNull()
    expect(result.candidateCount).toBe(0)
  })

  test("#given a LOOKALIKE opencode-something process holds the caller directory #when discovered #then it is not the caller TUI", async () => {
    // A prefix match would treat these sibling tools as the caller and split from
    // them instead of the real TUI. Only the exact executable names qualify.
    for (const command of ["opencode-mcp", "opencode-debug", "opencodex", "opencode2", "notopencode"]) {
      const { result } = await discover([pane({ paneId: "%9", command })])
      expect(result.paneId).toBeNull()
      expect(result.candidateCount).toBe(0)
    }
  })

  test("#given the Windows executable name #when discovered #then it is recognised as the caller TUI", async () => {
    const { result } = await discover([pane({ paneId: "%4", command: "opencode.exe" })])
    expect(result.paneId).toBe("%4")
    expect(result.candidateCount).toBe(1)
  })

  test("#given the tmux query itself fails #when discovered #then it fails closed", async () => {
    const runner = scriptedRunner([], { exitCode: 1, stderr: "no server running" })
    const result = await env.discoverCallerPane({
      tmuxPath: "/usr/bin/tmux",
      directory: DIR,
      run: runner.run,
      realpath: (path) => path,
    })
    expect(result.paneId).toBeNull()
    expect(result.reason).toMatch(/tmux/i)
  })
})

describe("environment eligibility accepts a discovered caller pane", () => {
  const probes = { isFile: () => true, isExecutable: () => true, platform: "linux" }

  test("#given a daemon without TMUX but a discovered caller pane #when detected #then the feature is eligible", () => {
    const detected = env.detectTmuxVizEnvironment({ env: { PATH: "/usr/bin" }, discoveredPaneId: "%1", ...probes })
    expect(detected.insideTmux).toBe(true)
    expect(detected.sourcePaneId).toBe("%1")
    expect(detected.degradedReason).toBeNull()
  })

  test("#given discovery reports why it refused #when detected #then that reason is the degraded reason", () => {
    const detected = env.detectTmuxVizEnvironment({ env: { PATH: "/usr/bin" }, discoveredPaneId: null, discoveryReason: "ambiguous caller pane: 2 candidates", ...probes })
    expect(detected.sourcePaneId).toBeNull()
    expect(detected.degradedReason).toBe("ambiguous caller pane: 2 candidates")
  })

  // Row 55 live finding (NLS1): the daemon INHERITS `TMUX`/`TMUX_PANE` from
  // whichever TUI happened to spawn it, so the inherited pane can belong to a
  // DIFFERENT project. Letting it win over discovery opened one project's member
  // pane inside a sibling project's tmux session. Once discovery is attempted, its
  // result — including a refusal — is authoritative.
  test("#given an inherited TMUX_PANE and a discovered caller pane #when detected #then the DISCOVERED pane wins", () => {
    const detected = env.detectTmuxVizEnvironment({ env: { PATH: "/usr/bin", TMUX: "/tmp/tmux-1000/default,1,0", TMUX_PANE: "%3" }, discoveredPaneId: "%9", ...probes })
    expect(detected.sourcePaneId).toBe("%9")
    expect(detected.degradedReason).toBeNull()
  })

  test("#given an inherited TMUX_PANE and an attempted discovery that refused #when detected #then it fails closed instead of using the inherited pane", () => {
    const detected = env.detectTmuxVizEnvironment({
      env: { PATH: "/usr/bin", TMUX: "/tmp/tmux-1000/default,1,0", TMUX_PANE: "%3" },
      discoveredPaneId: null,
      discoveryReason: "ambiguous caller pane: 2 OpenCode TUI panes",
      ...probes,
    })
    expect(detected.sourcePaneId).toBeNull()
    expect(detected.degradedReason).toBe("ambiguous caller pane: 2 OpenCode TUI panes")
  })

  test("#given no discovery attempt at all #when detected #then the inherited pane is still the signal", () => {
    const detected = env.detectTmuxVizEnvironment({ env: { PATH: "/usr/bin", TMUX: "/tmp/tmux-1000/default,1,0", TMUX_PANE: "%3" }, ...probes })
    expect(detected.sourcePaneId).toBe("%3")
    expect(detected.degradedReason).toBeNull()
  })

  test("#given no discovery was attempted #when detected #then the original degraded reason is unchanged", () => {
    const detected = env.detectTmuxVizEnvironment({ env: { PATH: "/usr/bin" }, ...probes })
    expect(detected.degradedReason).toBe("not inside a tmux or cmux environment")
  })
})
