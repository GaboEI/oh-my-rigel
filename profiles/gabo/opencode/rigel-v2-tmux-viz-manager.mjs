/**
 * Native V2 tmux visualization manager (rewrite of V1
 * `features/tmux-subagent/manager.ts`).
 *
 * Owns the lifecycle of one agent pane per delegated session:
 * - `onSessionCreated`: gate -> readiness wait (10s) -> spawn (split of the
 *   source pane, or an isolated window/session container) -> track -> poll.
 *   Failures re-queue the session in a deferred queue (cap 20, TTL 5min) and
 *   close any pane created by the failed attempt.
 * - `onSessionDeleted`: close the tracked pane (C-c then kill-pane, tolerant
 *   of an already-gone pane) with bounded retries.
 * - `onEvent`: message activity feeds the polling stability checks.
 * - `cleanup()`: close everything and tear down an isolated session.
 * - One-shot zombie sweep on the first session.created.
 *
 * Every degraded decision is logged with its exact reason.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"

import { detectTmuxVizEnvironment } from "./rigel-v2-tmux-viz-env.mjs"
import { resolveSessionStatus } from "./rigel-v2-tmux-viz-status.mjs"
import { createTmuxVizRunner, createServerHealthProbe } from "./rigel-v2-tmux-viz-runner.mjs"
import { queryWindowState } from "./rigel-v2-tmux-viz-pane-state.mjs"
import {
  buildPlaceholderCommand, buildSpawnArgs, buildReplaceArgs, buildTitleArgs, buildPaneMarkerArgs,
  buildApplyLayoutArgs, buildResizeArgs, decideSpawnActions, computeMainPaneWidth,
} from "./rigel-v2-tmux-viz-layout.mjs"
import { createTmuxVizPolling, POLL_INTERVAL_BACKGROUND_MS } from "./rigel-v2-tmux-viz-polling.mjs"
import { closeTmuxPane, sweepStaleTmuxResources, MAX_CLOSE_RETRY_COUNT, CLOSE_RETRY_COOLDOWN_MS } from "./rigel-v2-tmux-viz-cleanup.mjs"

// PROCESS-WIDE claim: module scope, therefore shared by every manager instance in
// this process. The V2 host instantiates the plugin more than once against the
// SAME global event stream (observed live on NLS1: one `session.created` produced
// TWO panes attached to the same child session id, and every event arrived twice).
// `sessions`/`pendingSessions` below are instance-local, so without this claim each
// instance spawns its own pane for the same child. Exactly one instance owns a
// session's pane; the claim is released on a hard spawn failure, on session
// deletion, and on cleanup so nothing leaks.
const claimedSessions = new Set()

// The duplication above is CROSS-PROCESS: the daemon and the TUI each load the
// plugin, and a module-scope Set cannot span them. The tmux server is the shared
// authority, but the durable pane marker carries no session identity, so a claim
// file is the atomic cross-process primitive. A session's claim is a numbered
// epoch (`<hash>.claim.<n>`), and BOTH first acquisition and stale takeover are a
// single atomic `open(..., "wx")` (O_CREAT|O_EXCL) of ONE epoch name: every
// contender computes the same next epoch and races for that exact name, so exactly
// one wins and the rest re-read the by-then-live winner. No contender ever
// overwrites or deletes another claim, which is what makes the takeover path as
// atomic as the fresh path.
//
// Staleness is decided by LIVENESS, not age: a holder whose pid is still alive is
// never displaced, so a live owner waiting out the deferred queue keeps its pane.
// A holder that is provably gone is advanced past at once, which makes crash
// recovery immediate.
// The claim directory is PER USER and PRIVATE. `os.tmpdir()` itself is shared
// and world-writable, so the per-user subdirectory is created 0o700 and every
// write is gated behind `isPrivateClaimDir`: a pre-created symlink, a foreign
// owner, or a group/other-accessible directory is refused rather than followed,
// so the cross-process arbiter cannot be steered from outside (H2).
// XDG_RUNTIME_DIR is deliberately NOT the base: the daemon and the TUI resolve
// it independently, and a disagreement would split the arbiter across two
// directories. TMPDIR + uid gives one directory per user in both processes.
function claimUserScope() {
  const uid = typeof process.getuid === "function" ? process.getuid() : null
  if (uid !== null) return String(uid)
  try {
    return createHash("sha256").update(String(os.userInfo().username)).digest("hex").slice(0, 16)
  } catch {
    return "unknown"
  }
}

function defaultClaimDir() {
  return path.join(os.tmpdir(), `rigel-tmux-viz-claims-${claimUserScope()}`)
}

// Upper bound on how long a claim file with NO parsable record is trusted before
// it may be advanced past. It is only the fallback for an unreadable file: a claim
// with a readable record is judged by liveness. Kept above DEFERRED_SESSION_TTL_MS
// (5 min) so a legitimate owner waiting out the deferred queue cannot be mistaken
// for stale.
export const CLAIM_STALE_MS = 30 * 60 * 1000

// `os.tmpdir()` is not private on every host and is shared between users, so the
// claim directory is an operational knob as well as the isolation seam the
// cross-process tests use.
export function claimDir() {
  const override = process.env.RIGEL_TMUX_VIZ_CLAIM_DIR
  return typeof override === "string" && override.length > 0 ? override : defaultClaimDir()
}

// Ownership/type/mode gate for the claim directory. `lstat` (never `stat`) so a
// symlink is SEEN as a symlink instead of followed to its target; a foreign
// owner, a non-directory, or a group/other-accessible directory is refused. The
// owner rule is testable in isolation: `uid` overrides the expected uid.
export function isPrivateClaimDir(dir, { uid } = {}) {
  let stats
  try {
    stats = fs.lstatSync(dir)
  } catch {
    return false
  }
  if (stats.isSymbolicLink()) return false
  if (!stats.isDirectory()) return false
  if ((stats.mode & 0o077) !== 0) return false
  const expectedUid = uid === undefined && typeof process.getuid === "function" ? process.getuid() : uid
  if (typeof expectedUid === "number" && stats.uid !== expectedUid) return false
  return true
}

function claimHash(sessionID) {
  return createHash("sha256").update(String(sessionID)).digest("hex")
}

// Deterministic, escape-proof filename: hashing removes any path separator,
// traversal segment or NUL a crafted session id could carry, so an id like
// `../../evil` can never write outside the claim directory. The raw session id is
// kept INSIDE the file for auditability, never in the path.
export function claimFileName(sessionID, epoch = 0) {
  return `${claimHash(sessionID)}.claim.${epoch}`
}

export function claimPath(sessionID, epoch = 0) {
  return path.join(claimDir(), claimFileName(sessionID, epoch))
}

function readClaimRecord(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
    if (parsed && typeof parsed === "object") return parsed
  } catch {
    // Missing or unreadable: treated as an unknown/absent holder below.
  }
  return null
}

// `kill(pid, 0)` performs the existence+permission check without signalling.
// ESRCH means the process is gone; EPERM means it exists but is not ours, which
// still counts as ALIVE.
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}

// A file with no readable record may be a writer caught mid-create; it is only
// displaced once it is clearly old. A vanished file reads as aged so the caller
// retries the exclusive create.
function isAged(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs > CLAIM_STALE_MS
  } catch {
    return true
  }
}

// Every epoch ever created for the session, read from the directory. Epoch names
// are the arbiter's memory, but only the HIGHEST is load-bearing: a fresh epoch
// is only ever created as `max + 1` and reclamation keeps the highest while
// dropping the lower tombstones. A contender whose directory snapshot predates
// an advance can still compute a reclaimed name, which `isHoleCreate` rejects.
function epochsForHash(hash) {
  const prefix = `${hash}.claim.`
  let names
  try {
    names = fs.readdirSync(claimDir())
  } catch {
    return []
  }
  const epochs = []
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const suffix = name.slice(prefix.length)
    if (/^\d+$/.test(suffix)) epochs.push(Number(suffix))
  }
  return epochs
}

function claimEpochs(sessionID) {
  return epochsForHash(claimHash(sessionID))
}

// A create that lands strictly BELOW an existing epoch is a hole: the directory
// already held a higher epoch, so the contender published a name that had been
// passed (its snapshot predated the advance). Claiming it would give two live
// owners, so it must be rejected. Pure, so the guard is unit-testable.
export function isHoleCreate(epochs, createdEpoch) {
  return epochs.some((epoch) => epoch > createdEpoch)
}

// Reclaim every epoch below the highest for this session. A release tombstones
// its epoch in place, so without reclamation each release leaves one permanent
// file and the directory grows without bound. The HIGHEST epoch is never
// removed: lowering `max(epochs)` is exactly the reuse window that lets a
// stale-snapshot contender publish an already-used name, so a session keeps
// exactly one file instead of one per release.
function reclaimReleasedEpochs(sessionID) {
  const epochs = claimEpochs(sessionID)
  if (epochs.length <= 1) return
  const highest = Math.max(...epochs)
  for (const epoch of epochs) {
    if (epoch === highest) continue
    try {
      fs.unlinkSync(path.join(claimDir(), claimFileName(sessionID, epoch)))
    } catch {
      // best-effort: a concurrent claim/release may already have removed it
    }
  }
}

// Atomic create-if-absent: `wx` = O_CREAT|O_EXCL, so it fails with EEXIST when the
// name is taken. This is the sole arbiter on both the fresh and the takeover path.
function publishExclusive(file, payload) {
  try {
    fs.writeFileSync(file, payload, { flag: "wx", mode: 0o600 })
    return true
  } catch {
    return false
  }
}

// Atomic in-place record replacement: write a sibling temp file, then rename it
// over the target. Used to TOMBSTONE a claim instead of unlinking it. Removing
// an epoch file would lower `max(epochs)`, letting a contender that holds a stale
// directory snapshot publish a name that was already used - exactly the
// double-owner race the epoch arbiter exists to prevent.
function writeClaimRecordAtomic(file, record) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, file)
    return true
  } catch {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // the temp file is best-effort cleanup only; the target is untouched
    }
    return false
  }
}

// Verifiable ownership: this process must read back its own token and pid.
function ownsClaim({ file, token }) {
  const record = readClaimRecord(file)
  return record?.token === token && record?.pid === process.pid
}

/**
 * Claim `sessionID` for this process. Returns an owned claim handle
 * (`{ file, token }`) or null when another LIVE process owns it. The fresh path
 * and the stale-takeover path both reduce to one atomic exclusive create, so
 * exactly one contender wins in each.
 */
export function claimOnDisk(sessionID) {
  if (typeof sessionID !== "string" || sessionID.length === 0) return null
  let dir
  try {
    dir = claimDir()
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    return null
  }
  // A pre-created symlink or a foreign/world-writable directory is refused
  // rather than followed: the arbiter must not be steerable from outside.
  if (!isPrivateClaimDir(dir)) return null
  const token = randomBytes(16).toString("hex")
  const payload = `${JSON.stringify({ sessionID, pid: process.pid, token, at: Date.now() })}\n`
  for (let attempt = 0; attempt < 8; attempt++) {
    const epochs = claimEpochs(sessionID)
    const current = epochs.length > 0 ? Math.max(...epochs) : -1
    if (current >= 0) {
      const record = readClaimRecord(path.join(dir, claimFileName(sessionID, current)))
      // A live owner is never displaced, however old its claim file is.
      if (record && isProcessAlive(record.pid)) return null
      // No readable record: only advance past it once it is clearly old.
      if (!record && !isAged(path.join(dir, claimFileName(sessionID, current)))) return null
    }
    // The next epoch is the arbiter. Of every contender that judged the current
    // claim stale, exactly one creates this name; the losers fall through and
    // re-evaluate, seeing the winner's now-live claim and retiring.
    const createdEpoch = current + 1
    const file = path.join(dir, claimFileName(sessionID, createdEpoch))
    if (!publishExclusive(file, payload)) continue
    // A stale-snapshot create can land below the current max when reclamation
    // dropped the epochs in between (a hole). If a higher epoch now exists the
    // directory advanced past us between the read and the exclusive create, so
    // this name lost the real arbitration: tombstone it and retry, or two
    // processes would end up owning the session.
    if (isHoleCreate(claimEpochs(sessionID), createdEpoch)) {
      writeClaimRecordAtomic(file, { sessionID, pid: 0, token, released: true, releasedAt: Date.now() })
      continue
    }
    const claim = { file, token }
    if (!ownsClaim(claim)) {
      // We created this name exclusively, so the file can only be ours; tombstone
      // it rather than leave a live-pid claim that would wedge the session.
      writeClaimRecordAtomic(file, { sessionID, pid: 0, token, released: true, releasedAt: Date.now() })
      return null
    }
    // Bounded reclamation: keep only this (highest) epoch; every lower name is
    // definitively dead, so the directory cannot grow one file per release.
    reclaimReleasedEpochs(sessionID)
    return claim
  }
  return null
}

/**
 * Release a claim this process owns. The epoch file is TOMBSTONED in place with a
 * non-live record instead of being removed: epoch names are the arbiter's memory,
 * and deleting one would lower `max(epochs)`, letting a contender that holds a
 * stale snapshot re-publish an already-used name so two processes both own the
 * session. Another owner's claim is never touched.
 */
export function releaseOnDisk(claim) {
  const file = claim?.file
  if (typeof file !== "string") return
  const record = readClaimRecord(file)
  // Missing or unreadable: ownership cannot be verified, so leave it alone.
  if (!record) return
  // Another process advanced past this claim: its token differs, so tombstoning
  // it would free a live session's claim and let a duplicate pane spawn.
  if (claim.token != null && record.token !== claim.token) return
  writeClaimRecordAtomic(file, { ...record, pid: 0, released: true, releasedAt: Date.now() })
}

export const MAX_DEFERRED_QUEUE_SIZE = 20
export const DEFERRED_SESSION_TTL_MS = 5 * 60 * 1000
export const SESSION_READY_POLL_MS = 500
export const SESSION_READY_TIMEOUT_MS = 10 * 1000
const ATTACHABLE_STATUSES = new Set(["idle", "running", "busy", "retry"])

export function createTmuxVizManager({
  config = {},
  env = process.env,
  serverUrl,
  directory = process.cwd(),
  discoveredPaneId = null,
  discoveryReason = null,
  attachEnv = [],
  fetchSessionStatus,
  shouldSkipSession = () => false,
  // Team members are long-lived by design: a teammate goes idle after every
  // turn, so the idle-stability close would drop its pane seconds after
  // creation. Persistence is a per-session property, default off, so ordinary
  // delegated children keep their existing close behavior byte for byte.
  isPersistentSession = () => false,
  // The DURABLE source of that answer. It is consulted BEFORE the pane claim, so
  // the claim and the pane agree on ONE answer, and a process that did not spawn the
  // member (the TUI that draws the pane) can still know it is one. A failing resolver
  // degrades to the synchronous answer instead of taking the claim on stale knowledge.
  resolvePersistentSession = undefined,
  managerPid = process.pid,
  healthMarker = globalThis,
  logger = console.error,
  spawnImpl,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // The readiness deadline is read through this seam so a test can drive the
  // whole 10s window with a fake clock instead of really waiting it out.
  // Production defaults to the wall clock; every other timestamp in this file
  // keeps reading `Date.now()` directly.
  now = () => Date.now(),
} = {}) {
  const environment = detectTmuxVizEnvironment({ env, discoveredPaneId, discoveryReason })
  const resolved = {
    layout: config.layout ?? "main-vertical",
    mainPaneSize: config.main_pane_size ?? 60,
    mainPaneMinWidth: config.main_pane_min_width ?? 120,
    agentPaneMinWidth: config.agent_pane_min_width ?? 40,
    isolation: config.isolation ?? "inline",
  }
  const enabled = environment.degradedReason === null
  const health = createServerHealthProbe({ marker: healthMarker })
  // V1 parity: the plugin instance knows the server it lives in, so the
  // health probe can trust the in-process marker instead of probing itself.
  if (serverUrl) health.markServerRunningInProcess()
  const runner = enabled ? createTmuxVizRunner({ tmuxPath: environment.tmuxPath, spawnImpl }) : null
  const sessions = new Map()
  const pendingSessions = new Set()
  const claimedByThisManager = new Set()
  const claimFiles = new Map()

  function releaseClaim(sessionID) {
    claimedSessions.delete(sessionID)
    claimedByThisManager.delete(sessionID)
    releaseOnDisk(claimFiles.get(sessionID))
    claimFiles.delete(sessionID)
  }
  const deferredSessions = []
  const spawnQueue = []
  let drainRunning = false
  let deferredLoop = null
  let sweptOnce = false
  let deferredLoopStopped = false

  const log = (line) => logger(`[oh-my-rigel] tmux-viz: ${line}`)

  // One answer, resolved once: the local fact when THIS process spawned the member,
  // the durable source otherwise. A durable source that cannot be read leaves the answer
  // UNKNOWN (undefined): "I could not find out" is not "not a member", and a pane claimed
  // on ignorance would later be closed like an ordinary child's.
  async function resolvePersistence(sessionID) {
    if (isPersistentSession(sessionID) === true) return true
    if (typeof resolvePersistentSession !== "function") return false
    try {
      return (await resolvePersistentSession(sessionID)) === true
    } catch (error) {
      log(`persistent-session resolution failed for ${sessionID}: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  async function applyLayoutEnforcement() {
    await runner.run(buildApplyLayoutArgs(resolved.layout, resolved.mainPaneSize))
    const state = await queryWindowState({ runner, sourcePaneId: environment.sourcePaneId })
    if (!state) return
    const width = computeMainPaneWidth({
      windowWidth: state.windowWidth,
      mainPaneSize: resolved.mainPaneSize,
      mainPaneMinWidth: resolved.mainPaneMinWidth,
      agentPaneMinWidth: resolved.agentPaneMinWidth,
    })
    await runner.run(buildResizeArgs(state.mainPane.paneId, width))
  }

  async function executeActions(actions) {
    let spawnedPaneId = null
    for (const action of actions) {
      if (action.kind === "close") {
        await closeTmuxPane({ runner, paneId: action.paneId, sleep })
        continue
      }
      if (action.kind === "replace") {
        await runner.run(buildReplaceArgs({ paneId: action.paneId, placeholderCommand: buildPlaceholderCommand("replaced") }))
        await runner.run(buildTitleArgs(action.paneId, "replaced"))
        await runner.run(buildPaneMarkerArgs(action.paneId))
        continue
      }
      const spawnArgs = buildSpawnArgs({
        direction: action.direction,
        targetPaneId: action.targetPaneId,
        placeholderCommand: buildPlaceholderCommand("agent"),
      })
      const result = await runner.run(spawnArgs)
      if (result.exitCode !== 0) return { spawnedPaneId, ok: false, error: result.stderr.trim().slice(0, 200) }
      spawnedPaneId = result.stdout.trim().split("\n").at(-1)
      await runner.run(buildTitleArgs(spawnedPaneId, "agent"))
      await runner.run(buildPaneMarkerArgs(spawnedPaneId))
    }
    return { spawnedPaneId, ok: true, error: null }
  }

  async function spawnInline(description, sessionID) {
    const state = await queryWindowState({ runner, sourcePaneId: environment.sourcePaneId })
    if (!state) return { ok: false, error: "window state unavailable" }
    const decision = decideSpawnActions({ windowState: state, layout: resolved.layout, mainPaneSize: resolved.mainPaneSize, mainPaneMinWidth: resolved.mainPaneMinWidth, agentPaneMinWidth: resolved.agentPaneMinWidth, sourcePaneId: environment.sourcePaneId })
    if (!decision.canSpawn) return { ok: false, error: decision.reason, deferred: true }
    const execution = await executeActions(decision.actions)
    if (!execution.ok) return { ok: false, error: execution.error }
    await runner.run(buildTitleArgs(execution.spawnedPaneId, description))
    await runner.run(buildPaneMarkerArgs(execution.spawnedPaneId))
    await applyLayoutEnforcement()
    log(`spawned pane ${execution.spawnedPaneId} for session ${sessionID} (inline split)`)
    return { ok: true, paneId: execution.spawnedPaneId }
  }

  async function spawnIsolatedContainer(description) {
    const placeholder = buildPlaceholderCommand(description)
    if (resolved.isolation === "window") {
      const result = await runner.run(["new-window", "-d", "-n", "omo-agents", "-P", "-F", "#{pane_id}", placeholder])
      if (result.exitCode !== 0) return { ok: false, error: result.stderr.trim().slice(0, 200) }
      return { ok: true, paneId: result.stdout.trim().split("\n").at(-1), isolated: true }
    }
    const sessionName = `omo-agents-${managerPid}`
    const result = await runner.run(["new-session", "-d", "-s", sessionName, "-P", "-F", "#{pane_id}", placeholder])
    if (result.exitCode !== 0) return { ok: false, error: result.stderr.trim().slice(0, 200) }
    return { ok: true, paneId: result.stdout.trim().split("\n").at(-1), isolated: true }
  }

  async function waitForSessionReady(sessionID) {
    const deadline = now() + SESSION_READY_TIMEOUT_MS
    let observed = false
    while (now() < deadline) {
      const lookup = await resolveSessionStatus(fetchSessionStatus, sessionID)
      // Only a status the seam actually produced for THIS session counts as
      // observability. A non-null container is not: the host has no aggregate
      // status call, so an argument-less read answers with an empty container
      // that is not a signal at all. Treating that container as probed is what
      // burned the whole readiness budget on every member and deferred the
      // spawn forever with no pane.
      if (lookup.kind === "value") {
        observed = true
        if (ATTACHABLE_STATUSES.has(lookup.status)) return true
        await sleep(SESSION_READY_POLL_MS)
        continue
      }
      // Nothing to observe means no signal will arrive inside this window, so
      // stop spending the readiness budget instead of polling an absent seam.
      break
    }
    // The host may expose no per-session status seam at all (observed live on
    // NLS1, OpenCode 2.0.32: `context.session.status` is not a function), or the
    // seam exists but reports nothing for this session. Blocking on an
    // unobservable signal defers the spawn forever, which is precisely how a
    // working feature looked broken. When nothing was observed we attach instead:
    // the session already exists (the creation event delivered it) and the pane
    // targets it by id. An OBSERVED but not-attachable status still defers.
    if (!observed) {
      log("session status seam is not observable for this session; attaching without a readiness confirmation")
      return true
    }
    // An OBSERVED status that never became attachable is a real signal: defer.
    return false
  }

  async function spawnPendingSession({ sessionID, description, persistent }) {
    const serverAlive = await health.isServerRunning(serverUrl)
    if (!serverAlive) return { ok: false, error: "opencode server is not reachable", deferred: true }
    const ready = await waitForSessionReady(sessionID)
    if (!ready) return { ok: false, error: "session did not reach an attachable status within 10s", deferred: true }
    const result = resolved.isolation === "inline"
      ? await spawnInline(description, sessionID)
      : await spawnIsolatedContainer(description)
    if (!result.ok) return result
    sessions.set(sessionID, {
      sessionID,
      paneId: result.paneId,
      isolated: Boolean(result.isolated),
      cmux: environment.cmux,
      createdAt: Date.now(),
      persistent: persistent === true,
      activityVersion: 0,
      stablePolls: 0,
      attachActivated: environment.cmux && !result.isolated,
      // Pending-close retry/cooldown state (V1 `TrackedSession` parity):
      // a failed close leaves the session tracked so a later polling pass
      // retries it, and after MAX_CLOSE_RETRY_COUNT failures a cooldown is
      // stamped instead of leaking the pane for the session lifetime.
      closePending: false,
      closeSent: false,
      closeRetryCount: 0,
      closeRetryCooldownUntil: undefined,
    })
    polling.start()
    return { ok: true, paneId: result.paneId }
  }

  function queueDeferred(entry, reason) {
    if (deferredSessions.length >= MAX_DEFERRED_QUEUE_SIZE) {
      log(`deferred queue is full (${MAX_DEFERRED_QUEUE_SIZE}); dropping session ${entry.sessionID}`)
      return
    }
    deferredSessions.push({ ...entry, queuedAt: now(), reason })
  }

  async function drainSpawnQueue() {
    if (drainRunning) return
    drainRunning = true
    try {
      while (spawnQueue.length > 0) {
        const entry = spawnQueue.shift()
        if (!entry) continue
        let result
        try {
          result = await spawnPendingSession(entry)
        } catch (error) {
          // A throwing spawn is an UNKNOWN outcome, never a lost queue entry.
          // The readiness path awaits the host, so a transient host failure
          // surfaces here; before this guard the exception escaped into the
          // host's event handler and the entry vanished with its claim held.
          const message = error instanceof Error ? error.message : String(error)
          if (!entry.throwLogged) {
            entry.throwLogged = true
            log(`spawn threw for ${entry.sessionID}: ${message}`)
          }
          queueDeferred(entry, message)
          continue
        }
        if (!result.ok) {
          if (result.paneId) await closeTmuxPane({ runner, paneId: result.paneId, sleep })
          if (result.deferred) {
            // A deferred spawn MUST be observable. Silence here is exactly what
            // made a never-attachable session look identical to a working
            // feature: the entry re-queues forever with no signal. Logged once
            // per session so a wedged attachment is diagnosable.
            if (!entry.deferLogged) {
              entry.deferLogged = true
              log(`deferred spawn for ${entry.sessionID}: ${result.error}`)
            }
            queueDeferred(entry, result.error)
          } else {
            log(`spawn failed for ${entry.sessionID}: ${result.error}`)
            releaseClaim(entry.sessionID)
          }
        }
      }
    } finally {
      drainRunning = false
    }
  }

  function pruneExpiredDeferred(currentTime) {
    while (deferredSessions.length > 0 && currentTime - deferredSessions[0].queuedAt > DEFERRED_SESSION_TTL_MS) {
      const expired = deferredSessions.shift()
      if (!expired) continue
      // Dropping an entry silently left its claim held for the rest of the
      // process, so every later attempt for that session looked "already
      // claimed" and the failure was invisible. Expiry is a DECISION, not a
      // silent drop: release the claim, then say so. Releasing before the line
      // is written makes "claim released" proof the on-disk claim is already
      // gone rather than a promise about to be kept.
      releaseClaim(expired.sessionID)
      log(`deferred spawn expired for ${expired.sessionID} after ${Math.round(DEFERRED_SESSION_TTL_MS / 60000)}min; claim released`)
    }
  }

  function startDeferredLoop() {
    if (deferredLoop || deferredLoopStopped) return
    deferredLoop = setInterval(() => {
      pruneExpiredDeferred(now())
      const entry = deferredSessions.shift()
      if (entry) spawnQueue.push(entry)
      void drainSpawnQueue()
    }, POLL_INTERVAL_BACKGROUND_MS)
    if (typeof deferredLoop.unref === "function") deferredLoop.unref()
  }

  // Pending-close retry/cooldown, ported from V1 `retryPendingCloses`
  // (`features/tmux-subagent/manager.ts:511-582`). A failed close keeps the
  // session tracked with `closePending=true`; each polling pass retries once,
  // incrementing `closeRetryCount`; after MAX_CLOSE_RETRY_COUNT failures the
  // session is stamped with `closeRetryCooldownUntil` instead of leaking the
  // pane. Once the cooldown elapses, the retry state resets so polling can
  // re-attempt. No timer is used: the cooldown is a timestamp compared on the
  // next pass, so a wedged pane cannot hang the process.
  async function retryPendingCloses(now = Date.now()) {
    for (const tracked of [...sessions.values()]) {
      if (!tracked.closePending || !sessions.has(tracked.sessionID)) continue
      const retryCount = tracked.closeRetryCount ?? 0
      if (retryCount >= MAX_CLOSE_RETRY_COUNT) {
        if (tracked.closeRetryCooldownUntil != null && now >= tracked.closeRetryCooldownUntil) {
          tracked.closeRetryCount = 0
          tracked.closePending = false
          tracked.closeSent = false
          tracked.closeRetryCooldownUntil = undefined
          log(`close-retry cooldown elapsed for ${tracked.sessionID}; retry state reset for a fresh attempt`)
        }
        continue
      }
      const result = await closeTmuxPane({ runner, paneId: tracked.paneId, sleep })
      if (result.closed) {
        sessions.delete(tracked.sessionID)
        log(`retried close succeeded for ${tracked.sessionID}`)
        continue
      }
      const nextRetryCount = retryCount + 1
      tracked.closeRetryCount = nextRetryCount
      if (nextRetryCount >= MAX_CLOSE_RETRY_COUNT) {
        tracked.closeRetryCooldownUntil = now + CLOSE_RETRY_COOLDOWN_MS
        log(`close retries exhausted for ${tracked.sessionID}; cooldown ${CLOSE_RETRY_COOLDOWN_MS / 60000}min armed`)
      } else {
        log(`retried close failed for ${tracked.sessionID}: ${result.reason} (retry ${nextRetryCount}/${MAX_CLOSE_RETRY_COUNT})`)
      }
    }
  }

  const polling = createTmuxVizPolling({
    getTrackedSessions: () => sessions,
    closeSessionById: async (sessionID) => {
      // The polling pass already set `closeSent` before this call: this is the
      // first close attempt for a session polling decided to close. A failure
      // leaves the session tracked as pending; `retryPendingCloses` (the
      // `onPoll` callback) handles every subsequent attempt with retry/cooldown.
      const tracked = sessions.get(sessionID)
      if (!tracked) return
      const result = await closeTmuxPane({ runner, paneId: tracked.paneId, sleep })
      if (result.closed) {
        sessions.delete(sessionID)
        return
      }
      tracked.closePending = true
      log(`close failed for ${sessionID}: ${result.reason}; pending retry`)
    },
    onPoll: (now) => retryPendingCloses(now),
    // The persistence of a member pane is re-resolved from the shared/durable state
    // right before a close is decided: the durable record can land AFTER the pane was
    // claimed, and a member must never be closed like an ordinary child. An answer that
    // could not be resolved also spares the pane (the status seam's own rule).
    resolvePersistentSession: async (sessionID) => (await resolvePersistence(sessionID)) !== false,
    runner: enabled ? runner : createTmuxVizRunner({ tmuxPath: "/nonexistent-tmux-viz", spawnImpl: () => ({ exitCode: Promise.resolve(1), stdout: Promise.resolve(""), stderr: Promise.resolve("") }) }),
    serverUrl,
    directory,
    attachEnv,
    fetchSessionStatus,
    cmux: environment.cmux,
    logger,
  })

  return {
    enabled,
    degradedReason: environment.degradedReason,
    environment,
    retryPendingCloses,
    getTrackedPaneId(sessionID) { return sessions.get(sessionID)?.paneId ?? null },
    async onSessionCreated(event, resolvedInfo) {
      if (!enabled) return
      if (event?.type !== "session.created") return
      // The live V2 daemon (NLS1, 2.0.32) delivers the payload in `event.data`
      // with an EMPTY `properties`, so the SDK-typed `properties.info` is null at
      // runtime. `native.mjs` normalizes the event and passes it in; the inline
      // fallbacks keep this entry point usable on its own.
      const info = resolvedInfo ?? event?.properties?.info ?? event?.data
      const sessionID = info?.id ?? info?.sessionID
      if (typeof sessionID !== "string" || !info?.parentID) return
      if (pendingSessions.has(sessionID) || sessions.has(sessionID)) return
      if (claimedSessions.has(sessionID)) return
      // Whether this session is a TEAM MEMBER decides if its pane survives the
      // member's idle turns, and it is resolved BEFORE the pane claim: a claim taken
      // on stale knowledge lets a member pane be closed like an ordinary child's, and
      // the process that wins the claim is not necessarily the one that spawned it.
      const persistent = await resolvePersistence(sessionID)
      if (persistent === undefined) {
        // The membership of this session could not be resolved, so the claim is NOT
        // taken: a pane claimed on ignorance would be closed like an ordinary child's,
        // and another instance (whose durable source works) may own it instead.
        log(`not claiming a pane for ${sessionID}: team membership could not be resolved`)
        return
      }
      if (claimedSessions.has(sessionID)) return
      claimedSessions.add(sessionID)
      claimedByThisManager.add(sessionID)
      const claim = claimOnDisk(sessionID)
      if (!claim) {
        // Another PROCESS owns this pane: the TUI loads the plugin too, so a
        // same-process claim is not enough.
        claimedSessions.delete(sessionID)
        claimedByThisManager.delete(sessionID)
        return
      }
      claimFiles.set(sessionID, claim)
      // Every early return below must RELEASE the claim, otherwise a session that
      // can never be spawned would hold the claim (and the on-disk file) forever.
      if (!environment.sourcePaneId && resolved.isolation === "inline") {
        releaseClaim(sessionID)
        return
      }
      if (shouldSkipSession(sessionID)) {
        releaseClaim(sessionID)
        return
      }
      if (!sweptOnce) {
        sweptOnce = true
        try {
          const killed = await sweepStaleTmuxResources({ runner, managerPid, isServerAlive: (url) => url === serverUrl })
          if (killed.sessions.length > 0 || killed.panes.length > 0) log(`zombie sweep: ${JSON.stringify(killed)}`)
        } catch (error) {
          log(`zombie sweep failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      pendingSessions.add(sessionID)
      spawnQueue.push({ sessionID, description: String(info.title ?? sessionID).slice(0, 20), persistent })
      startDeferredLoop()
      await drainSpawnQueue().catch((error) => log(`spawn queue drain failed: ${error instanceof Error ? error.message : String(error)}`))
      pendingSessions.delete(sessionID)
    },
    async onSessionDeleted({ sessionID } = {}) {
      if (!enabled || typeof sessionID !== "string") return
      const tracked = sessions.get(sessionID)
      if (!tracked) {
        // The session is gone: drop any claim this process still holds so a
        // deleted session never blocks a future spawn.
        releaseClaim(sessionID)
        return
      }
      const result = await closeTmuxPane({ runner, paneId: tracked.paneId, sleep })
      if (!result.closed) {
        // Keep the session tracked; `closeSent` blocks the polling one-shot so
        // the pending-close retry (with cooldown) owns every later attempt.
        tracked.closePending = true
        tracked.closeSent = true
        log(`close failed for ${sessionID}: ${result.reason}; pending retry`)
        return
      }
      sessions.delete(sessionID)
      releaseClaim(sessionID)
      if (tracked.isolated && resolved.isolation === "session") {
        await runner.run(["kill-session", "-t", `omo-agents-${managerPid}`])
      }
    },
    onEvent(event) { polling.handleEvent(event) },
    async cleanup() {
      if (!enabled) return
      deferredLoopStopped = true
      if (deferredLoop) clearInterval(deferredLoop)
      polling.stop()
      for (const tracked of [...sessions.values()]) {
        await closeTmuxPane({ runner, paneId: tracked.paneId, sleep })
        sessions.delete(tracked.sessionID)
      }
      if (resolved.isolation === "session" && sessions.size === 0) {
        await runner.run(["kill-session", "-t", `omo-agents-${managerPid}`])
      }
      for (const sessionID of [...claimedByThisManager]) releaseClaim(sessionID)
      claimedByThisManager.clear()
    },
  }
}
