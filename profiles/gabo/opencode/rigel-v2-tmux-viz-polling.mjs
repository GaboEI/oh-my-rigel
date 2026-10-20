/**
 * Native V2 tmux visualization: polling (rewrite of V1
 * `features/tmux-subagent/polling-manager.ts`).
 *
 * Contract reproduced exactly:
 * - 2s background interval, re-entrancy guarded.
 * - Focused-pane activation: a placeholder pane is respawned with the real
 *   session command (`--server`/`--session`/directory) when it becomes the
 *   active pane, or within the 5s auto-activate grace after creation.
 * - Stability close: an `idle` session older than 10s with 3 consecutive
 *   unchanged activity polls and a confirming recheck is closed.
 * - Missing grace 30s, hard timeout 60min for never-activated panes.
 * - Activity version bumps on session output events for tracked sessions.
 */

import { buildReplaceArgs, buildAttachCommand } from "./rigel-v2-tmux-viz-layout.mjs"
import { resolveSessionStatus } from "./rigel-v2-tmux-viz-status.mjs"
import { V2_ACTIVITY_EVENT_TYPES, resolveV2EventSessionID } from "./rigel-v2-native-activity.mjs"

export const POLL_INTERVAL_BACKGROUND_MS = 2000
export const SESSION_TIMEOUT_MS = 60 * 60 * 1000
export const SESSION_MISSING_GRACE_MS = 30 * 1000
export const AUTO_ACTIVATE_GRACE_MS = 5 * 1000
export const MIN_STABILITY_TIME_MS = 10 * 1000
export const STABLE_POLLS_REQUIRED = 3

// V1 bumped the activity version on the `message.updated`/`message.part.*`/
// `message.removed` family. T36 live capture (v2.0.22) proves V2 emits none of
// those events: the activity stream is the `session.*` vocabulary. The general
// union includes assistant output (with streamed tool progress), inbound user
// messages, and transcript mutations (a message removal / revert), so a long
// running tool and a revert both reset the stability window as V1 did.
const ACTIVITY_EVENT_TYPES = new Set(V2_ACTIVITY_EVENT_TYPES)

export function createTmuxVizPolling({
  getTrackedSessions,
  closeSessionById,
  runner,
  serverUrl,
  directory,
  attachEnv = [],
  fetchSessionStatus,
  cmux = false,
  logger = console.error,
  intervalMs = POLL_INTERVAL_BACKGROUND_MS,
  timeouts = {},
  onPoll,
} = {}) {
  const limits = {
    sessionTimeout: SESSION_TIMEOUT_MS,
    missingGrace: SESSION_MISSING_GRACE_MS,
    autoActivateGrace: AUTO_ACTIVATE_GRACE_MS,
    minStability: MIN_STABILITY_TIME_MS,
    stablePolls: STABLE_POLLS_REQUIRED,
    ...timeouts,
  }
  let timer = null
  let pollingInFlight = false

  async function respawnAsAttach(tracked, now) {
    const attachCommand = buildAttachCommand({ serverUrl, sessionID: tracked.sessionID, directory })
    const args = buildReplaceArgs({ paneId: tracked.paneId, placeholderCommand: attachCommand, authEnv: attachEnv })
    const result = await runner.run(args)
    if (result.exitCode !== 0) {
      logger(`[oh-my-rigel] tmux-viz: attach respawn failed for ${tracked.sessionID}: ${result.stderr.trim().slice(0, 200)}`)
      return false
    }
    tracked.attachActivated = true
    tracked.attachActivatedAt = now
    tracked.stablePolls = 0
    return true
  }

  async function activateFocusedPanes(now) {
    for (const tracked of getTrackedSessions().values()) {
      if (tracked.attachActivated || tracked.cmux) continue
      if (cmux && tracked.isolated) continue
      const state = tracked.lastWindowState
      const pane = state?.agentPanes?.find((entry) => entry.paneId === tracked.paneId)
      const focused = Boolean(pane?.active)
      const withinGrace = tracked.createdAt != null && now - tracked.createdAt <= limits.autoActivateGrace
      const isolatedCanActivate = !tracked.isolated || (state?.windowActive === true && state?.sessionAttached === true)
      if ((focused || withinGrace) && isolatedCanActivate) {
        await respawnAsAttach(tracked, now)
      }
    }
  }

  async function pollSessions(now = Date.now()) {
    if (pollingInFlight) return
    pollingInFlight = true
    try {
      // Owner hook: the manager's pending-close retry runs once per pass,
      // before the decision loop, so a session whose close failed on an earlier
      // pass gets a bounded retry with a cooldown instead of leaking.
      if (typeof onPoll === "function") await onPoll(now)
      await activateFocusedPanes(now)
      // The host answers session status PER SESSION, so the seam is asked once per
      // tracked session. A session it cannot answer for reads as `null`: an
      // absent entry is not an idle signal, and (as before) it must never be
      // treated as a fresh sighting for the missing/idle stability logic.
      // THREE-STATE: `absent` (host answered, no status for this session) still
      // feeds the missing-grace safety net, but `unavailable` (the question could
      // not be asked) must never drive a status-derived close - that would tear
      // down a live pane on a transient host failure. Probed once per pass.
      let seamUnavailable = false
      for (const tracked of getTrackedSessions().values()) {
        if (tracked.closePending) continue
        let lookup = { kind: "unavailable" }
        if (!seamUnavailable) {
          lookup = await resolveSessionStatus(fetchSessionStatus, tracked.sessionID)
          if (lookup.kind === "unavailable") seamUnavailable = true
        }
        const unavailable = lookup.kind === "unavailable"
        const statusValue = lookup.kind === "value" ? lookup.status : null
        const age = now - (tracked.createdAt ?? now)
        const isTimedOut = !tracked.persistent && age > limits.sessionTimeout
        if (!tracked.attachActivated && !statusValue) {
          if (age > limits.sessionTimeout) {
            tracked.closePending = true
            logger(`[oh-my-rigel] tmux-viz: never-activated pane timed out (${Math.round(limits.sessionTimeout / 60000)}min): ${tracked.sessionID}`)
          }
          continue
        }
        if (unavailable) {
          // Age is a fact this process owns; status is the host's answer. Only the
          // hard age timeout survives an unanswerable seam.
          if (isTimedOut) {
            tracked.closePending = true
            logger(`[oh-my-rigel] tmux-viz: closing pane for ${tracked.sessionID} (stable=false, missing=false, timedOut=true)`)
          }
          continue
        }
        if (tracked.attachActivated && !statusValue && tracked.attachActivatedAt != null && now - tracked.attachActivatedAt <= 10_000) continue
        if (statusValue) tracked.lastSeenAt = now
        const missingTooLong = tracked.lastSeenAt != null && now - tracked.lastSeenAt > limits.missingGrace
        // A persistent session (a team member) closes only on session deletion or
        // a genuinely vanished session, never on idle stability or the hard age
        // timeout: it is EXPECTED to sit idle between turns.
        // Stability: consecutive idle ticks whose activity version never
        // changed. Any other status, or any activity bump, resets the run.
        if (statusValue === "idle") {
          if (tracked.stabilityVersion !== tracked.activityVersion) {
            tracked.stabilityVersion = tracked.activityVersion
            tracked.stablePolls = 1
          } else {
            tracked.stablePolls = (tracked.stablePolls ?? 0) + 1
          }
        } else {
          tracked.stabilityVersion = null
          tracked.stablePolls = 0
        }
        const stableFor = age
        const isStableIdle = !tracked.persistent && statusValue === "idle" && (tracked.stablePolls ?? 0) >= limits.stablePolls && stableFor >= limits.minStability
        if (isStableIdle || missingTooLong || isTimedOut) {
          tracked.closePending = true
          logger(`[oh-my-rigel] tmux-viz: closing pane for ${tracked.sessionID} (stable=${isStableIdle}, missing=${missingTooLong}, timedOut=${isTimedOut})`)
        }
      }
      for (const tracked of getTrackedSessions().values()) {
        if (tracked.closePending && !tracked.closeSent) {
          tracked.closeSent = true
          await closeSessionById(tracked.sessionID)
        }
      }
    } finally {
      pollingInFlight = false
    }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => { void pollSessions() }, intervalMs)
      if (typeof timer.unref === "function") timer.unref()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    handleEvent(event) {
      if (!ACTIVITY_EVENT_TYPES.has(event?.type)) return
      // V2 events carry the id under `data.sessionID`; an enriched event may
      // carry it at the top level. The shared resolver accepts both shapes.
      const sessionID = resolveV2EventSessionID(event)
      if (!sessionID) return
      const tracked = getTrackedSessions().get(sessionID)
      if (tracked) tracked.activityVersion = (tracked.activityVersion ?? 0) + 1
    },
    pollOnce: (now = Date.now()) => pollSessions(now),
  }
}
