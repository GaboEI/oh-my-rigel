import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createTmuxVizManager,
  claimDir,
  claimFileName,
  claimOnDisk,
  claimPath,
  isHoleCreate,
  isPrivateClaimDir,
  releaseOnDisk,
  CLAIM_STALE_MS,
} from "./rigel-v2-tmux-viz-manager.mjs"
import { MAX_CLOSE_RETRY_COUNT, CLOSE_RETRY_COOLDOWN_MS } from "./rigel-v2-tmux-viz-cleanup.mjs"

function memoryEnv({ withTmux = true } = {}) {
  return withTmux
    ? { PATH: process.env.PATH, TMUX: "/tmp/tmux-qa", TMUX_PANE: "%0" }
    : { PATH: process.env.PATH }
}

function managerOverrides({ spawnScript, withTmux = true, isolation = "inline", serverAlive = true } = {}) {
  const healthMarker = {}
  const spawnCalls = []
  return {
    config: { layout: "main-vertical", isolation },
    env: memoryEnv({ withTmux }),
    serverUrl: serverAlive ? "http://127.0.0.1:1" : undefined,
    directory: "/work",
    fetchSessionStatus: async () => new Map([["ses_child", "running"]]),
    spawnImpl: (args) => {
      spawnCalls.push(args.join(" "))
      if (args[0] === "list-panes") return { exitCode: Promise.resolve(0), stdout: Promise.resolve("%0\t200\t40\t0\t0\t1\t200\t40\t1\t1\t\n"), stderr: Promise.resolve("") }
      if (args[0] === "split-window") return { exitCode: Promise.resolve(0), stdout: Promise.resolve("%9\n"), stderr: Promise.resolve("") }
      return { exitCode: Promise.resolve(0), stdout: Promise.resolve(""), stderr: Promise.resolve("") }
    },
    sleep: async () => {},
    healthMarker,
    spawnCalls,
  }
}

const CHILD_EVENT = { type: "session.created", properties: { info: { id: "ses_child", parentID: "ses_parent", title: "scout" } } }

describe("tmux-viz manager", () => {
  test("with tmux available it splits the source pane, tracks the session and titles the pane", async () => {
    const overrides = managerOverrides()
    const manager = createTmuxVizManager(overrides)
    expect(manager.enabled).toBe(true)
    // when
    await manager.onSessionCreated(CHILD_EVENT)
    // then
    expect(overrides.spawnCalls.some((call) => call.includes("split-window"))).toBe(true)
    expect(overrides.spawnCalls.some((call) => call.includes("select-pane -t %9 -T omo-subagent-"))).toBe(true)
    expect(manager.getTrackedPaneId("ses_child")).toBe("%9")
    await manager.cleanup()
  })

  test("top-level sessions, duplicates and team members never spawn a pane", async () => {
    const overrides = managerOverrides()
    const manager = createTmuxVizManager({ ...overrides, shouldSkipSession: (id) => id === "ses_member" })
    await manager.onSessionCreated({ type: "session.created", properties: { info: { id: "ses_top", title: "lead" } } })
    await manager.onSessionCreated(CHILD_EVENT)
    await manager.onSessionCreated(CHILD_EVENT)
    await manager.onSessionCreated({ type: "session.created", properties: { info: { id: "ses_member", parentID: "p", title: "m" } } })
    expect(overrides.spawnCalls.some((call) => call.includes("split-window"))).toBe(true)
    expect(manager.getTrackedPaneId("ses_member")).toBeNull()
    expect(overrides.spawnCalls.filter((call) => call.includes("split-window"))).toHaveLength(1)
    await manager.cleanup()
  })

  test("without tmux the manager degrades explicitly and never runs tmux", async () => {
    const overrides = managerOverrides({ withTmux: false })
    const manager = createTmuxVizManager(overrides)
    expect(manager.enabled).toBe(false)
    expect(manager.degradedReason).toBe("not inside a tmux or cmux environment")
    await manager.onSessionCreated(CHILD_EVENT)
    expect(overrides.spawnCalls).toEqual([])
    await manager.cleanup()
  })

  test("session.deleted closes the tracked pane with C-c then kill-pane", async () => {
    const overrides = managerOverrides()
    const manager = createTmuxVizManager(overrides)
    await manager.onSessionCreated(CHILD_EVENT)
    await manager.onSessionDeleted({ sessionID: "ses_child" })
    expect(overrides.spawnCalls.some((call) => call.includes("send-keys -t %9 C-c"))).toBe(true)
    expect(overrides.spawnCalls.some((call) => call.includes("kill-pane -t %9"))).toBe(true)
    expect(manager.getTrackedPaneId("ses_child")).toBeNull()
  })

  test("an unreachable opencode server defers the spawn instead of failing silently", async () => {
    const overrides = managerOverrides({ serverAlive: false })
    overrides.spawnImpl = (args) => {
      if (args[0] === "list-panes") return { exitCode: Promise.resolve(0), stdout: Promise.resolve("%0\t200\t40\t0\t0\t1\t200\t40\t1\t1\t\n"), stderr: Promise.resolve("") }
      return { exitCode: Promise.resolve(0), stdout: Promise.resolve("%9\n"), stderr: Promise.resolve("") }
    }
    const manager = createTmuxVizManager(overrides)
    await manager.onSessionCreated(CHILD_EVENT)
    expect(overrides.spawnCalls.some((call) => call.includes("split-window"))).toBe(false)
    expect(manager.getTrackedPaneId("ses_child")).toBeNull()
    await manager.cleanup()
  })
})

describe("tmux-viz manager pending close retry and cooldown", () => {
  function retryOverrides() {
    const logs = []
    const spawnCalls = []
    const state = { failKill: true }
    const overrides = {
      config: { layout: "main-vertical", isolation: "inline" },
      env: memoryEnv({ withTmux: true }),
      serverUrl: "http://127.0.0.1:1",
      directory: "/work",
      fetchSessionStatus: async () => new Map([["ses_child", "running"]]),
      spawnImpl: (args) => {
        spawnCalls.push(args.join(" "))
        if (args[0] === "list-panes") return { exitCode: Promise.resolve(0), stdout: Promise.resolve("%0\t200\t40\t0\t0\t1\t200\t40\t1\t1\t\n"), stderr: Promise.resolve("") }
        if (args[0] === "split-window") return { exitCode: Promise.resolve(0), stdout: Promise.resolve("%9\n"), stderr: Promise.resolve("") }
        if (args[0] === "kill-pane") {
          return state.failKill
            ? { exitCode: Promise.resolve(1), stdout: Promise.resolve(""), stderr: Promise.resolve("server exited abruptly") }
            : { exitCode: Promise.resolve(0), stdout: Promise.resolve(""), stderr: Promise.resolve("") }
        }
        return { exitCode: Promise.resolve(0), stdout: Promise.resolve(""), stderr: Promise.resolve("") }
      },
      sleep: async () => {},
      healthMarker: {},
      logger: (line) => logs.push(line),
    }
    const killCount = () => spawnCalls.filter((call) => call.startsWith("kill-pane")).length
    return { overrides, state, logs, killCount }
  }

  test("a failed delete close stays pending and a later retry removes the tracked pane", async () => {
    // given: a session whose pane close fails on deletion
    const { overrides, state, logs } = retryOverrides()
    const manager = createTmuxVizManager(overrides)
    await manager.onSessionCreated(CHILD_EVENT)
    // when
    await manager.onSessionDeleted({ sessionID: "ses_child" })
    // then: still tracked, marked pending
    expect(manager.getTrackedPaneId("ses_child")).toBe("%9")
    expect(logs.some((line) => line.includes("pending retry"))).toBe(true)
    // when: the pane becomes closable and a retry pass runs
    state.failKill = false
    await manager.retryPendingCloses(Date.now())
    // then
    expect(manager.getTrackedPaneId("ses_child")).toBeNull()
    expect(logs.some((line) => line.includes("retried close succeeded"))).toBe(true)
    await manager.cleanup()
  })

  test("repeated retry failures arm the cooldown and keep the session tracked", async () => {
    // given
    const { overrides, logs } = retryOverrides()
    const manager = createTmuxVizManager(overrides)
    await manager.onSessionCreated(CHILD_EVENT)
    await manager.onSessionDeleted({ sessionID: "ses_child" })
    const base = 1_000_000
    // when: MAX_CLOSE_RETRY_COUNT retry passes all fail
    for (let index = 0; index < MAX_CLOSE_RETRY_COUNT; index += 1) {
      await manager.retryPendingCloses(base + index * 1000)
    }
    // then: the pane is still tracked and the cooldown was armed
    expect(manager.getTrackedPaneId("ses_child")).toBe("%9")
    expect(logs.some((line) => line.includes(`cooldown ${CLOSE_RETRY_COOLDOWN_MS / 60000}min armed`))).toBe(true)
    await manager.cleanup()
  })

  test("the cooldown blocks retries until it elapses and then resets the retry state", async () => {
    // given: a session whose retries exhausted and armed the cooldown
    const { overrides, logs, killCount } = retryOverrides()
    const manager = createTmuxVizManager(overrides)
    await manager.onSessionCreated(CHILD_EVENT)
    await manager.onSessionDeleted({ sessionID: "ses_child" })
    const base = 2_000_000
    for (let index = 0; index < MAX_CLOSE_RETRY_COUNT; index += 1) {
      await manager.retryPendingCloses(base + index * 1000)
    }
    const armingPass = base + (MAX_CLOSE_RETRY_COUNT - 1) * 1000
    const cooldownUntil = armingPass + CLOSE_RETRY_COOLDOWN_MS
    const afterArming = killCount()
    // when: a pass runs before the cooldown elapses
    await manager.retryPendingCloses(cooldownUntil - 1)
    // then: no further close attempt
    expect(killCount()).toBe(afterArming)
    // when: the cooldown elapses
    await manager.retryPendingCloses(cooldownUntil)
    // then: the reset is logged, the session stays tracked but unwedged
    expect(logs.some((line) => line.includes("cooldown elapsed"))).toBe(true)
    expect(manager.getTrackedPaneId("ses_child")).toBe("%9")
    await manager.cleanup()
  })
})


// ---------------------------------------------------------------------------
// Cross-process claim contract.
//
// The daemon and the TUI each load the plugin, so the claim that stops a duplicate
// pane must exclude across SEPARATE processes - on the fresh path AND on the stale
// takeover path. These tests spawn real child processes and release them from a
// shared barrier so the race is genuine, not coincidental. The claim directory is
// redirected per test, so nothing here touches the shared tmpdir.
// ---------------------------------------------------------------------------
describe("tmux-viz cross-process claim", () => {
  const MANAGER_URL = new URL("./rigel-v2-tmux-viz-manager.mjs", import.meta.url).href
  let claimRoot
  let previousRoot

  beforeEach(() => {
    claimRoot = mkdtempSync(join(tmpdir(), "rigel-viz-claim-"))
    previousRoot = process.env.RIGEL_TMUX_VIZ_CLAIM_DIR
    process.env.RIGEL_TMUX_VIZ_CLAIM_DIR = claimRoot
  })

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.RIGEL_TMUX_VIZ_CLAIM_DIR
    else process.env.RIGEL_TMUX_VIZ_CLAIM_DIR = previousRoot
    rmSync(claimRoot, { recursive: true, force: true })
  })

  // Each child loads the real manager, announces readiness, then spins on a
  // shared "go" file, so every racer calls claimOnDisk at the same instant. The
  // holder then STAYS ALIVE until released: a claim whose owner is still running
  // must not be reclaimed, and a winner that exited would legitimately look stale.
  function raceClaim({ sessionID, count }) {
    const root = mkdtempSync(join(tmpdir(), "rigel-viz-race-"))
    const script = join(root, "claim.mjs")
    writeFileSync(script, [
      "import fs from \"node:fs\"",
      "const [managerUrl, sessionID, readyFile, goFile, resultFile, exitFile] = process.argv.slice(2)",
      "const { claimOnDisk } = await import(managerUrl)",
      "fs.writeFileSync(readyFile, \"1\")",
      "while (!fs.existsSync(goFile)) {}",
      "const claim = claimOnDisk(sessionID)",
      "fs.writeFileSync(resultFile + \".tmp\", claim ? `1:${claim.file}` : \"0\")",
      "fs.renameSync(resultFile + \".tmp\", resultFile)",
      "while (!fs.existsSync(exitFile)) {}",
    ].join("\n"))
    const goFile = join(root, "go")
    const readyFiles = []
    const resultFiles = []
    const exitFiles = []
    const children = []
    for (let index = 0; index < count; index += 1) {
      const readyFile = join(root, `ready-${index}`)
      const resultFile = join(root, `result-${index}`)
      const exitFile = join(root, `exit-${index}`)
      readyFiles.push(readyFile)
      resultFiles.push(resultFile)
      exitFiles.push(exitFile)
      children.push(new Promise((resolve) => {
        const child = spawn(process.execPath, [script, MANAGER_URL, sessionID, readyFile, goFile, resultFile, exitFile], {
          env: { ...process.env, RIGEL_TMUX_VIZ_CLAIM_DIR: claimRoot },
          stdio: ["ignore", "ignore", "ignore"],
        })
        child.on("exit", () => resolve())
      }))
    }
    // Barrier: no racer is released until every one is loaded and waiting. Spin
    // with an explicit deadline so a stuck child fails loudly instead of hanging.
    waitForSteps(readyFiles, `claim race children were not ready in time for ${sessionID}`)
    writeFileSync(goFile, "1")
    // Collect every verdict while the winners are still alive holding their claim.
    waitForSteps(resultFiles, `claim race children produced no verdict in time for ${sessionID}`)
    const results = resultFiles.map((file) => readFileSync(file, "utf8").trim())
    for (const file of exitFiles) writeFileSync(file, "1")
    return Promise.all(children).then(() => results).finally(() => rmSync(root, { recursive: true, force: true }))
  }

  function waitForSteps(files, message) {
    const deadline = Date.now() + 20000
    while (!files.every((file) => existsSync(file))) {
      if (Date.now() > deadline) throw new Error(message)
    }
  }

  // A pid that is provably dead: the child was reaped and the kernel no longer
  // resolves it. A just-reaped pid can be recycled by an unrelated process, which
  // would make the seeded claim read as LIVE, so re-check and retry.
  async function deadPid() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const pid = await new Promise((resolve) => {
        const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" })
        child.on("exit", () => resolve(child.pid))
      })
      let alive = true
      try {
        process.kill(pid, 0)
      } catch (error) {
        alive = error?.code !== "ESRCH"
      }
      if (!alive) return pid
    }
    throw new Error("could not obtain a provably dead pid")
  }

  function seedClaim(sessionID, record, ageMs) {
    const file = claimPath(sessionID)
    mkdirSync(claimRoot, { recursive: true })
    writeFileSync(file, `${JSON.stringify(record)}\n`)
    const past = new Date(Date.now() - ageMs)
    utimesSync(file, past, past)
    return file
  }

  function winners(results) {
    return results.filter((result) => result.startsWith("1")).map((result) => result.slice(2))
  }

  // Every entry the contenders leave behind must be a well-formed epoch claim file.
  // A released epoch keeps the same name (tombstoned in place), so it matches too.
  function assertOnlyClaims() {
    const names = readdirSync(claimRoot)
    expect(names.every((name) => /^[0-9a-f]{64}\.claim\.\d+$/.test(name))).toBe(true)
    return names
  }

  test("#given an unclaimed session #when eight separate processes race #then exactly one wins", async () => {
    const results = await raceClaim({ sessionID: "ses_fresh_race", count: 8 })
    expect(winners(results)).toHaveLength(1)
    expect(results.filter((result) => result === "0")).toHaveLength(7)
    assertOnlyClaims()
  }, 30000)

  test("#given a stale claim from a dead holder #when separate processes race #then exactly one wins every round", async () => {
    const dead = await deadPid()
    // A single round only exposes the pre-fix takeover when two racers stat
    // before either writes, so repeat: every round must elect exactly one owner.
    for (let round = 0; round < 8; round += 1) {
      const sessionID = `ses_stale_race_${round}`
      const token = `dead-holder-${round}`
      seedClaim(sessionID, { sessionID, pid: dead, token, at: 0 }, CLAIM_STALE_MS + 60000)
      const results = await raceClaim({ sessionID, count: 8 })
      const winnerFiles = winners(results)
      expect(winnerFiles).toHaveLength(1)
      expect(results.filter((result) => result === "0")).toHaveLength(7)
      // The survivor owns the claim file and stamped it with its own live pid.
      const record = JSON.parse(readFileSync(winnerFiles[0], "utf8"))
      expect(record.pid).not.toBe(dead)
      expect(record.token).not.toBe(token)
    }
    assertOnlyClaims()
  }, 30000)

  test("#given a claim whose owner is still alive #when others try to take it #then the live owner is not displaced", async () => {
    const sessionID = "ses_live_owner"
    // The running test process is the live owner and its claim file is OLD: age
    // alone must never dispossess it.
    const file = seedClaim(sessionID, { sessionID, pid: process.pid, token: "live-owner-token", at: 0 }, CLAIM_STALE_MS + 60000)
    const results = await raceClaim({ sessionID, count: 3 })
    expect(results).toEqual(["0", "0", "0"])
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, "utf8")).token).toBe("live-owner-token")
    expect(claimOnDisk(sessionID)).toBeNull()
    expect(readdirSync(claimRoot)).toEqual([claimFileName(sessionID)])
  }, 30000)

  test("#given a hostile session id #when a real process claims it #then the file stays inside the claim directory", async () => {
    const hostile = "../../escape/../../evil"
    expect(claimDir()).toBe(claimRoot)
    const derived = claimPath(hostile)
    expect(derived.startsWith(claimRoot)).toBe(true)
    expect(derived).toBe(join(claimRoot, claimFileName(hostile)))
    expect(claimFileName(hostile)).toMatch(/^[0-9a-f]{64}\.claim\.\d+$/)
    const results = await raceClaim({ sessionID: hostile, count: 1 })
    const [file] = winners(results)
    expect(file.startsWith(claimRoot)).toBe(true)
    expect(existsSync(file)).toBe(true)
    expect(readdirSync(claimRoot)).toEqual([claimFileName(hostile)])
    // The raw, unvalidated id is kept for audit but never used as a path.
    expect(JSON.parse(readFileSync(file, "utf8")).sessionID).toBe(hostile)
  }, 30000)

  test("#given an acquired claim #when it is released #then no live claim remains", () => {
    const claim = claimOnDisk("ses_cleanup")
    expect(claim).not.toBeNull()
    releaseOnDisk(claim)
    // The epoch file is tombstoned in place rather than removed: it stays as an
    // inert, non-live residue, so no owner holds the session.
    const record = JSON.parse(readFileSync(claim.file, "utf8"))
    expect(record.released).toBe(true)
    expect(record.pid).toBe(0)
    expect(claimOnDisk("ses_cleanup")).not.toBeNull()
  })

  test("#given a claim another owner holds #when a stale handle is released #then the live claim survives", () => {
    const claim = claimOnDisk("ses_owner_check")
    expect(claim).not.toBeNull()
    releaseOnDisk({ file: claim.file, token: "a-previous-owner" })
    // A foreign handle must not tombstone the live owner's record.
    const live = JSON.parse(readFileSync(claim.file, "utf8"))
    expect(live.pid).toBe(process.pid)
    releaseOnDisk(claim)
    const released = JSON.parse(readFileSync(claim.file, "utf8"))
    expect(released.released).toBe(true)
    expect(released.pid).toBe(0)
  })

  // The anti-reuse invariant: an epoch name must never be deleted or reissued.
  // Removing the HIGHEST name lowers `max(epochs)`, so a contender holding a
  // stale directory snapshot could publish the freed name while another process
  // publishes the next one - two live owners, two panes. B1 bounds growth by
  // reclaiming the LOWER tombstones only: the max keeps advancing (a name is
  // never reused) while the directory holds exactly one file instead of one per
  // release. Fails if releaseOnDisk unlinks the highest epoch, or if a reclaim
  // ever drops the floor.
  test("#given repeated claim/release #when the session is reclaimed #then epochs advance and only the highest tombstone survives", () => {
    const sessionID = "ses_no_reuse"
    const rounds = 25
    const epochs = []
    for (let round = 0; round < rounds; round += 1) {
      const claim = claimOnDisk(sessionID)
      expect(claim).not.toBeNull()
      const epoch = Number(claim.file.slice(claim.file.lastIndexOf(".") + 1))
      epochs.push(epoch)
      releaseOnDisk(claim)
      // Released in place: the name still exists as a non-live tombstone...
      expect(existsSync(claim.file)).toBe(true)
      expect(JSON.parse(readFileSync(claim.file, "utf8")).pid).toBe(0)
      // ...but reclamation keeps growth flat: only the current highest survives.
      expect(readdirSync(claimRoot)).toEqual([claimFileName(sessionID, epoch)])
    }
    // Names strictly advance and are never reused (0..rounds-1, each exactly once).
    expect(epochs).toEqual(Array.from({ length: rounds }, (_, index) => index))
  })

  // B1: the hole guard rejects a create that lands BELOW an existing epoch.
  // Reclamation drops lower tombstones, so a contender whose directory snapshot
  // predates the advance can compute a name that was already passed and whose
  // file is now gone - `publishExclusive` would SUCCEED on it. Accepting that
  // name would hand the session to a second live owner. Pure and deterministic,
  // so it owns the guard directly while the race below owns the end-to-end path.
  test("#given an epoch above the created one #when the hole guard checks the create #then it is rejected", () => {
    // A create below an existing epoch is a hole: two live owners if accepted.
    expect(isHoleCreate([2, 9], 6)).toBe(true)
    expect(isHoleCreate([9], 6)).toBe(true)
    // A create at or above the current max is the legitimate next slot.
    expect(isHoleCreate([6], 6)).toBe(false)
    expect(isHoleCreate([0, 1, 2], 2)).toBe(false)
    expect(isHoleCreate([], 0)).toBe(false)
  })

  // B1 race: K processes hammer claim/release over ONE session at once. With
  // reclamation dropping lower epochs, the reuse window stays closed only if no
  // two processes can EVER win the same epoch. Uniqueness of every won epoch is
  // the no-double-owner contract; the trailing claim then proves the directory
  // is bounded, not growing one tombstone per release.
  test("#given one session #when many processes claim and release across cycles #then no epoch is won twice and reclamation bounds the directory", async () => {
    const sessionID = "ses_reclaim_race"
    const winLogs = await raceClaimRelease({ sessionID, count: 6, cycles: 12 })
    const wonEpochs = []
    for (const log of winLogs) {
      let previous = -1
      for (const line of log.split("\n")) {
        const match = /^win (\d+) (\d+)$/.exec(line.trim())
        if (!match) continue
        const epoch = Number(match[1])
        // A single process only ever moves forward.
        expect(epoch).toBeGreaterThan(previous)
        previous = epoch
        wonEpochs.push(epoch)
      }
    }
    expect(wonEpochs.length).toBeGreaterThan(0)
    // No epoch was ever won by two processes: the double-owner invariant.
    expect(new Set(wonEpochs).size).toBe(wonEpochs.length)
    // A trailing claim collapses any leftover hole tombstones to one file, so the
    // directory cannot grow without bound no matter how long the race ran.
    const finalClaim = claimOnDisk(sessionID)
    expect(finalClaim).not.toBeNull()
    const finalEpoch = Number(finalClaim.file.slice(finalClaim.file.lastIndexOf(".") + 1))
    expect(readdirSync(claimRoot)).toEqual([claimFileName(sessionID, finalEpoch)])
  }, 30000)

  function raceClaimRelease({ sessionID, count, cycles }) {
    const root = mkdtempSync(join(tmpdir(), "rigel-viz-reclaim-"))
    const script = join(root, "reclaim.mjs")
    writeFileSync(script, [
      "import fs from \"node:fs\"",
      "const [managerUrl, sessionID, cycles, readyFile, goFile, logFile] = process.argv.slice(2)",
      "const { claimOnDisk, releaseOnDisk } = await import(managerUrl)",
      "fs.writeFileSync(readyFile, \"1\")",
      "while (!fs.existsSync(goFile)) {}",
      "const lines = []",
      "for (let index = 0; index < Number(cycles); index += 1) {",
      "  const claim = claimOnDisk(sessionID)",
      "  if (claim) {",
      "    const epoch = Number(claim.file.slice(claim.file.lastIndexOf(\".\") + 1))",
      "    lines.push(\"win \" + epoch + \" \" + process.pid)",
      "    releaseOnDisk(claim)",
      "  } else {",
      "    lines.push(\"lose\")",
      "  }",
      "}",
      "fs.writeFileSync(logFile, lines.join(\"\\n\"))",
    ].join("\n"))
    const goFile = join(root, "go")
    const readyFiles = []
    const logFiles = []
    const children = []
    for (let index = 0; index < count; index += 1) {
      const readyFile = join(root, `ready-${index}`)
      const logFile = join(root, `log-${index}`)
      readyFiles.push(readyFile)
      logFiles.push(logFile)
      children.push(new Promise((resolve) => {
        const child = spawn(process.execPath, [script, MANAGER_URL, sessionID, String(cycles), readyFile, goFile, logFile], {
          env: { ...process.env, RIGEL_TMUX_VIZ_CLAIM_DIR: claimRoot },
          stdio: ["ignore", "ignore", "ignore"],
        })
        child.on("exit", () => resolve())
      }))
    }
    waitForSteps(readyFiles, `reclaim race children were not ready in time for ${sessionID}`)
    writeFileSync(goFile, "1")
    return Promise.all(children)
      .then(() => logFiles.map((file) => readFileSync(file, "utf8")))
      .finally(() => rmSync(root, { recursive: true, force: true }))
  }
})

// ---------------------------------------------------------------------------
// B2: the claim directory is per-user and must be genuinely private. It lives
// under TMPDIR (shared, world-writable), so a pre-created symlink, a foreign
// owner, or a group/other-accessible directory could steer the cross-process
// arbiter. The directory is created 0o700 and every write is gated behind an
// lstat owner/type/mode check that rejects a symlink instead of following it.
// ---------------------------------------------------------------------------
describe("tmux-viz claim directory hardening", () => {
  let sandbox
  let previousRoot

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "rigel-viz-hardening-"))
    previousRoot = process.env.RIGEL_TMUX_VIZ_CLAIM_DIR
  })

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.RIGEL_TMUX_VIZ_CLAIM_DIR
    else process.env.RIGEL_TMUX_VIZ_CLAIM_DIR = previousRoot
    rmSync(sandbox, { recursive: true, force: true })
  })

  test("#given no override #when the default claim dir is resolved #then it is UID-scoped under the system tmp, not the shared name", () => {
    delete process.env.RIGEL_TMUX_VIZ_CLAIM_DIR
    const dir = claimDir()
    expect(dir.startsWith(join(tmpdir(), "rigel-tmux-viz-claims-"))).toBe(true)
    // The old predictable, cross-user name is gone: the directory is per-uid.
    expect(dir).not.toBe(join(tmpdir(), "rigel-tmux-viz-claims"))
    if (typeof process.getuid === "function") {
      expect(dir).toBe(join(tmpdir(), `rigel-tmux-viz-claims-${process.getuid()}`))
    }
  })

  test("#given a directory that is not private #when the guard inspects it #then it is refused", () => {
    const open = join(sandbox, "open")
    mkdirSync(open, { mode: 0o700 })
    chmodSync(open, 0o777)
    expect(isPrivateClaimDir(open)).toBe(false)

    const file = join(sandbox, "not-a-dir")
    writeFileSync(file, "x")
    expect(isPrivateClaimDir(file)).toBe(false)

    const target = join(sandbox, "target")
    mkdirSync(target, { mode: 0o700 })
    const link = join(sandbox, "link")
    symlinkSync(target, link)
    // stat() would follow the link to a private dir; lstat() sees the symlink.
    expect(isPrivateClaimDir(link)).toBe(false)
  })

  test("#given a foreign owner #when the guard checks the expected uid #then it is refused", () => {
    const dir = join(sandbox, "owned")
    mkdirSync(dir, { mode: 0o700 })
    const { uid } = lstatSync(dir)
    expect(isPrivateClaimDir(dir, { uid })).toBe(true)
    expect(isPrivateClaimDir(dir, { uid: uid + 1 })).toBe(false)
  })

  test("#given a symlinked claim dir #when a process claims #then it refuses and never writes through the link", () => {
    const target = join(sandbox, "real-target")
    mkdirSync(target, { mode: 0o700 })
    const link = join(sandbox, "claim-link")
    symlinkSync(target, link)
    process.env.RIGEL_TMUX_VIZ_CLAIM_DIR = link
    expect(claimOnDisk("ses_symlink")).toBeNull()
    // Nothing was written into the link target: the arbiter was not steered.
    expect(readdirSync(target)).toEqual([])
  })

  test("#given a world-accessible claim dir #when a process claims #then it refuses and writes nothing", () => {
    const open = join(sandbox, "world-open")
    mkdirSync(open, { mode: 0o700 })
    chmodSync(open, 0o777)
    process.env.RIGEL_TMUX_VIZ_CLAIM_DIR = open
    expect(claimOnDisk("ses_open")).toBeNull()
    expect(readdirSync(open)).toEqual([])
  })

  test("#given the claim dir path is a regular file #when a process claims #then it refuses", () => {
    const file = join(sandbox, "claim-file")
    writeFileSync(file, "not a directory")
    process.env.RIGEL_TMUX_VIZ_CLAIM_DIR = file
    expect(claimOnDisk("ses_file")).toBeNull()
  })

  test("#given a private 0o700 claim dir #when a process claims #then it succeeds normally", () => {
    const dir = join(sandbox, "private")
    mkdirSync(dir, { mode: 0o700 })
    process.env.RIGEL_TMUX_VIZ_CLAIM_DIR = dir
    const claim = claimOnDisk("ses_private")
    expect(claim).not.toBeNull()
    expect(claim.file.startsWith(dir)).toBe(true)
    releaseOnDisk(claim)
  })
})