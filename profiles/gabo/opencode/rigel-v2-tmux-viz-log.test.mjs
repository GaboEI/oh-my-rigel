import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTmuxVizLogSink, resolveTmuxVizLogPath } from "./rigel-v2-tmux-viz-log.mjs"

/**
 * The visualization's diagnostics are a contract with the OPERATOR: a live run
 * that refuses to create panes must say why in a file. In the V2 service the
 * plugin console is a socket, so before this sink a degraded manager produced no
 * readable trace at all and retest 5 could not be diagnosed from the host log.
 */
const dirs = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "tmux-viz-log-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true })
})

describe("tmux-viz durable log", () => {
  test("the path follows the sibling state-log convention", () => {
    expect(resolveTmuxVizLogPath({ env: { XDG_STATE_HOME: "/state" } }))
      .toBe("/state/oh-my-rigel/tmux-viz.log")
    // An explicit file wins over the environment, which wins over the default.
    expect(resolveTmuxVizLogPath({ env: { XDG_STATE_HOME: "/state", RIGEL_TMUX_VIZ_LOG_FILE: "/x.log" } }))
      .toBe("/x.log")
    expect(resolveTmuxVizLogPath({ env: { XDG_STATE_HOME: "/state", RIGEL_TMUX_VIZ_LOG_FILE: "/x.log" }, logFile: "/y.log" }))
      .toBe("/y.log")
  })

  test("one JSON line per decision, with the scope and any detail", () => {
    const logFile = join(tempDir(), "nested", "tmux-viz.log")
    const log = createTmuxVizLogSink({ env: {}, logFile })
    log("spawned pane %77 for session ses_member")
    log("degraded for /p", { reason: "ambiguous caller pane" })

    const lines = readFileSync(logFile, "utf-8").trim().split("\n").map((line) => JSON.parse(line))
    expect(lines).toHaveLength(2)
    expect(lines[0].scope).toBe("tmux-viz")
    expect(lines[0].message).toContain("spawned pane %77")
    expect(lines[1].detail).toEqual({ reason: "ambiguous caller pane" })
    expect(typeof lines[0].at).toBe("string")
  })

  test("RIGEL_TMUX_VIZ_LOG=off writes nothing", () => {
    const logFile = join(tempDir(), "tmux-viz.log")
    const log = createTmuxVizLogSink({ env: { RIGEL_TMUX_VIZ_LOG: "off" }, logFile })
    log("must not be written")
    expect(existsSync(logFile)).toBe(false)
  })

  test("an unwritable log never throws into a spawn decision", () => {
    // A directory where a file is expected: every append fails.
    const logFile = tempDir()
    const log = createTmuxVizLogSink({ env: {}, logFile })
    expect(() => {
      log("first")
      log("second")
    }).not.toThrow()
  })
})
