import { describe, expect, test } from "bun:test"
import { detectTmuxVizEnvironment } from "./rigel-v2-tmux-viz-env.mjs"

const PROBES = { isFile: () => true, isExecutable: () => true }

describe("tmux-viz environment eligibility", () => {
  // These fixtures describe a POSIX host (a `:`-delimited PATH and `/usr/bin/tmux`),
  // so the resolution is asked for the POSIX rules on every host. The Windows
  // rules (`;` delimiter, PATHEXT probing) are exercised by the platform itself.
  test("resolves the tmux binary, the source pane and cmux from the environment", () => {
    const env = detectTmuxVizEnvironment({ platform: "linux", env: { PATH: "/usr/bin", TMUX: "/tmp/tmux-0", TMUX_PANE: "%3", CMUX_SOCKET_PATH: "/tmp/cmux.sock" }, ...PROBES })
    expect(env.tmuxPath).toBe("/usr/bin/tmux")
    expect(env.insideTmux).toBe(true)
    expect(env.cmux).toBe(true)
    expect(env.paneCompatible).toBe(true)
    expect(env.sourcePaneId).toBe("%3")
    expect(env.degradedReason).toBeNull()
  })

  test("a missing binary degrades with an explicit reason, never silently", () => {
    const env = detectTmuxVizEnvironment({ env: { PATH: "/nonexistent", TMUX: "/tmp/tmux-0", TMUX_PANE: "%3" }, isFile: () => false, isExecutable: () => false })
    expect(env.tmuxPath).toBeNull()
    expect(env.degradedReason).toBe("tmux binary not found on PATH")
  })

  test("a tmux binary without a tmux session degrades on the missing source pane", () => {
    const env = detectTmuxVizEnvironment({ env: { PATH: "/usr/bin" }, ...PROBES })
    expect(env.degradedReason).toBe("not inside a tmux or cmux environment")
    const env2 = detectTmuxVizEnvironment({ env: { PATH: "/usr/bin", TMUX: "/tmp/tmux-0" }, ...PROBES })
    expect(env2.degradedReason).toBe("TMUX_PANE is not set: no source pane to split from")
  })

  test("scans every PATH entry and skips non-executable candidates", () => {
const seen = []
    const env = detectTmuxVizEnvironment({
      platform: "linux",
env: { PATH: "/a:/b:/usr/bin" },
      isFile: (candidate) => { seen.push(candidate); return candidate === "/usr/bin/tmux" },
      isExecutable: (candidate) => candidate === "/usr/bin/tmux",
    })
    expect(env.tmuxPath).toBe("/usr/bin/tmux")
    expect(seen).toContain("/a/tmux")
    expect(seen).toContain("/b/tmux")
  })
})
