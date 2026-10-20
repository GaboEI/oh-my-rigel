import { describe, expect, test } from "bun:test"
import { createTmuxVizPolling, STABLE_POLLS_REQUIRED, MIN_STABILITY_TIME_MS } from "./rigel-v2-tmux-viz-polling.mjs"

function harness({ tracked, status = null, runner, fetchSessionStatus, timeouts } = {}) {
  const sessions = new Map(tracked ?? [])
  const closes = []
  const logs = []
  let statuses = status
  const polling = createTmuxVizPolling({
    getTrackedSessions: () => sessions,
    closeSessionById: async (sessionID) => { closes.push(sessionID); sessions.delete(sessionID) },
    runner: runner ?? { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    serverUrl: "http://127.0.0.1:1",
    directory: "/work",
    fetchSessionStatus: fetchSessionStatus ?? (async () => statuses),
    logger: (line) => { logs.push(line) },
    timeouts,
  })
  return {
    sessions, closes, logs, polling,
    setStatus: (map) => { statuses = map },
  }
}

function trackedSession(overrides = {}) {
  return {
    sessionID: "ses_child",
    paneId: "%1",
    isolated: false,
    cmux: false,
    createdAt: Date.now(),
    activityVersion: 0,
    stablePolls: 0,
    persistent: false,
    closePending: false,
    attachActivated: true,
    lastSeenAt: Date.now(),
    ...overrides,
  }
}

describe("tmux-viz polling", () => {
  test("an idle session with unchanged activity over the stability window is closed", async () => {
    const created = Date.now() - MIN_STABILITY_TIME_MS - 1000
    const harness1 = harness({ tracked: [["ses_child", trackedSession({ createdAt: created, lastSeenAt: created })]] })
    harness1.setStatus(new Map([["ses_child", "idle"]]))
    // given: STABLE_POLLS_REQUIRED unchanged ticks...
    for (let index = 0; index < STABLE_POLLS_REQUIRED; index += 1) await harness1.polling.pollOnce(Date.now() + 1000 * (index + 1))
    // when: the confirming recheck still reports idle
    await harness1.polling.pollOnce(Date.now() + 10_000)
    // then
    expect(harness1.closes).toEqual(["ses_child"])
  })

  test("a session whose activity keeps changing is never stability-closed", async () => {
    const created = Date.now() - MIN_STABILITY_TIME_MS - 1000
    const harness1 = harness({ tracked: [["ses_child", trackedSession({ createdAt: created, lastSeenAt: created })]] })
    harness1.setStatus(new Map([["ses_child", "running"]]))
    for (let index = 0; index < STABLE_POLLS_REQUIRED + 2; index += 1) {
      harness1.sessions.get("ses_child").activityVersion += 1
      await harness1.polling.pollOnce(Date.now() + 1000 * (index + 1))
    }
    expect(harness1.closes).toEqual([])
  })

  test("V2 activity (output, tool progress, mutation) bumps the tracked session", () => {
    const harness1 = harness({ tracked: [["ses_child", trackedSession()]] })
    // given: assistant output in the raw (`data.sessionID`) and enriched shapes
    harness1.polling.handleEvent({ type: "session.text.delta", data: { sessionID: "ses_child" } })
    harness1.polling.handleEvent({ type: "session.step.started", sessionID: "ses_child" })
    // a long tool that streams progress must reset the stability window
    harness1.polling.handleEvent({ type: "session.tool.progress", data: { sessionID: "ses_child" } })
    // a message removal / revert is activity for the pane
    harness1.polling.handleEvent({ type: "session.revert.staged", data: { sessionID: "ses_child" } })
    harness1.polling.handleEvent({ type: "session.revert.cleared", sessionID: "ses_child" })
    expect(harness1.sessions.get("ses_child").activityVersion).toBe(5)
    // when: a non-activity edge, and the V1 names V2 never emits, arrive
    harness1.polling.handleEvent({ type: "session.idle", sessionID: "ses_child" })
    harness1.polling.handleEvent({ type: "message.updated", data: { sessionID: "ses_child" } })
    harness1.polling.handleEvent({ type: "message.removed", data: { sessionID: "ses_child" } })
    // then: none of them bump the activity version
    expect(harness1.sessions.get("ses_child").activityVersion).toBe(5)
  })

  test("a focused placeholder pane is respawned as attach within the auto-activate grace", async () => {
    const sessions = new Map([["ses_child", trackedSession({ attachActivated: false })]])
    const replacements = []
    const polling = createTmuxVizPolling({
      getTrackedSessions: () => sessions,
      closeSessionById: async () => {},
      runner: { run: async (args) => { replacements.push(args); return { exitCode: 0, stdout: "", stderr: "" } } },
      serverUrl: "http://127.0.0.1:1",
      directory: "/work",
      fetchSessionStatus: async () => new Map(),
      logger: () => {},
    })
    sessions.get("ses_child").lastWindowState = { agentPanes: [{ paneId: "%1", active: true }], windowActive: true, sessionAttached: true }
    await polling.pollOnce(Date.now())
    expect(replacements[0]).toContain("respawn-pane")
    expect(sessions.get("ses_child").attachActivated).toBe(true)
  })

  test("a never-activated placeholder past the session timeout is closed and logged", async () => {
    const now = 5_000_000
    const harness1 = harness({
      tracked: [["ses_child", trackedSession({ attachActivated: false, attachActivatedAt: null, createdAt: now - 61_000, lastSeenAt: null })]],
      timeouts: { sessionTimeout: 60_000 },
    })
    await harness1.polling.pollOnce(now)
    expect(harness1.closes).toEqual(["ses_child"])
    expect(harness1.logs).toEqual(["[oh-my-rigel] tmux-viz: never-activated pane timed out (1min): ses_child"])
  })

  test("an attached session whose status disappears past the missing grace is closed as missing", async () => {
    const t1 = 5_000_000
    const harness1 = harness({
      tracked: [["ses_child", trackedSession({ createdAt: t1 - 1_000, attachActivatedAt: t1 - 20_000, lastSeenAt: t1 - 999 })]],
      timeouts: { sessionTimeout: 60_000, missingGrace: 1_000 },
    })
    harness1.setStatus(new Map([["ses_child", "running"]]))
    await harness1.polling.pollOnce(t1)
    // still alive: a fresh sighting is not a disappearance
    expect(harness1.closes).toEqual([])
    harness1.setStatus(new Map())
    await harness1.polling.pollOnce(t1 + 1_001)
    expect(harness1.closes).toEqual(["ses_child"])
    expect(harness1.logs).toEqual(["[oh-my-rigel] tmux-viz: closing pane for ses_child (stable=false, missing=true, timedOut=false)"])
  })

  test("an attached session past the session timeout with a recent sighting is closed as timed out", async () => {
    const now = 5_000_000
    const harness1 = harness({
      tracked: [["ses_child", trackedSession({ createdAt: now - 60_001, attachActivatedAt: now - 11_000, lastSeenAt: now - 500 })]],
      timeouts: { sessionTimeout: 60_000, missingGrace: 1_000 },
    })
    await harness1.polling.pollOnce(now)
    expect(harness1.closes).toEqual(["ses_child"])
    expect(harness1.logs).toEqual(["[oh-my-rigel] tmux-viz: closing pane for ses_child (stable=false, missing=false, timedOut=true)"])
  })

  test("a persistent team-member session is never stability-closed", async () => {
    const now = 5_000_000
    const harness1 = harness({
      tracked: [["ses_child", trackedSession({ createdAt: now - MIN_STABILITY_TIME_MS - 1_000, lastSeenAt: now - 1_000, persistent: true })]],
    })
    harness1.setStatus(new Map([["ses_child", "idle"]]))
    // given: far more than the stability window elapses with no activity at all
    for (let index = 0; index < STABLE_POLLS_REQUIRED + 2; index += 1) await harness1.polling.pollOnce(now + 1_000 * (index + 1))
    // then: a teammate idles between turns by design, so its pane must survive
    expect(harness1.closes).toEqual([])
  })

  test("a persistent session is never closed by the hard age timeout", async () => {
    const now = 5_000_000
    const harness1 = harness({
      tracked: [["ses_child", trackedSession({ createdAt: now - 60_001, attachActivatedAt: now - 11_000, lastSeenAt: now - 500, persistent: true })]],
      timeouts: { sessionTimeout: 60_000, missingGrace: 1_000 },
    })
    harness1.setStatus(new Map([["ses_child", "running"]]))
    await harness1.polling.pollOnce(now)
    // same shape as the non-persistent timeout case above, which DOES close
    expect(harness1.closes).toEqual([])
  })

  test("a persistent session whose pane really vanished is still closed as missing", async () => {
    const t1 = 5_000_000
    const harness1 = harness({
      tracked: [["ses_child", trackedSession({ createdAt: t1 - 1_000, attachActivatedAt: t1 - 20_000, lastSeenAt: t1 - 999, persistent: true })]],
      timeouts: { sessionTimeout: 60_000, missingGrace: 1_000 },
    })
    harness1.setStatus(new Map([["ses_child", "running"]]))
    await harness1.polling.pollOnce(t1)
    expect(harness1.closes).toEqual([])
    harness1.setStatus(new Map())
    await harness1.polling.pollOnce(t1 + 1_001)
    // the safety net is retained: persistence is not a licence to leak panes
    expect(harness1.closes).toEqual(["ses_child"])
  })

  test("a poll re-entered while one is in flight is a no-op", async () => {
    let calls = 0
    let release
    const gate = new Promise((resolve) => { release = resolve })
    // given: one tracked session, so the per-session status read runs exactly once
    // per pass (the host has no aggregate read to count any more)
    const harness1 = harness({
      tracked: [["ses_child", trackedSession()]],
      fetchSessionStatus: async (id) => { calls += 1; await gate; return id === "ses_child" ? "running" : undefined },
    })
    const first = harness1.polling.pollOnce(5_000_000)
    const second = harness1.polling.pollOnce(5_000_000)
    release()
    await first
    await second
    expect(calls).toBe(1)
  })

  test("a focused placeholder whose attach respawn exits non-zero stays inactive and is not closed", async () => {
    const now = 5_000_000
    const harness1 = harness({
      tracked: [["ses_child", trackedSession({ attachActivated: false, attachActivatedAt: null, createdAt: now, lastSeenAt: null })]],
      runner: { run: async () => ({ exitCode: 1, stdout: "", stderr: "respawning failed" }) },
    })
    harness1.sessions.get("ses_child").lastWindowState = { agentPanes: [{ paneId: "%1", active: true }], windowActive: true, sessionAttached: true }
    await harness1.polling.pollOnce(now)
    expect(harness1.logs.some((line) => line.includes("attach respawn failed"))).toBe(true)
    expect(harness1.sessions.get("ses_child").attachActivated).toBe(false)
    expect(harness1.closes).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Per-session status seam (RETEST-4). The host answers `session.status(id)` one
// session at a time, so the polling pass must ask per tracked session; an
// argument-less aggregate read always came back empty, which silently killed
// `lastSeenAt` and every idle-stability decision.
// ---------------------------------------------------------------------------
describe("tmux-viz polling per-session status seam", () => {
  const t1 = 5_000_000

  function idleFixture() {
    return trackedSession({ createdAt: t1 - MIN_STABILITY_TIME_MS - 1_000, lastSeenAt: t1 - 20_000, attachActivated: true, attachActivatedAt: t1 - 20_000 })
  }

  test("a per-session idle status reaches idle stability", async () => {
    // given: the seam answers for THIS session only
    const tracked = idleFixture()
    const harness1 = harness({
      tracked: [["ses_child", tracked]],
      fetchSessionStatus: async (id) => (id === tracked.sessionID ? "idle" : undefined),
      timeouts: { stablePolls: 2, missingGrace: 30_000 },
    })
    // when: two passes observe the same session-level idle status
    await harness1.polling.pollOnce(t1)
    await harness1.polling.pollOnce(t1 + 1_000)
    // then: the stability window closes the pane, proving the status was SEEN
    expect(tracked.closePending).toBe(true)
    expect(harness1.closes).toEqual(["ses_child"])
  })

  test("an unanswerable seam never closes a pane on a stale sighting", async () => {
    // given: the same fixture behind a seam that reports nothing for it
    const tracked = idleFixture()
    const harness1 = harness({
      tracked: [["ses_child", tracked]],
      fetchSessionStatus: async () => {
        throw new Error("host unavailable")
      },
      timeouts: { stablePolls: 2, missingGrace: 1_000 },
    })
    // when
    await harness1.polling.pollOnce(t1)
    await harness1.polling.pollOnce(t1 + 1_000)
    // then: no status, no stability close - an absent entry is not an idle signal
    expect(tracked.closePending).toBeFalsy()
    expect(harness1.closes).toEqual([])
  })
})
