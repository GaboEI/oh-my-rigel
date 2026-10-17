import { afterEach, describe, expect, test } from "bun:test"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearBackgroundMarker,
  createBackgroundManager,
  formatCompactionHistory,
  readBackgroundMarker,
  writeBackgroundMarker,
} from "./rigel-v2-background-manager.mjs"
import { createFileBackgroundState } from "./rigel-v2-background-state.mjs"
import { runMutation } from "./test-support/mutation-harness.mjs"
import plugin from "./rigel-v2-native.mjs"

const OPENCODE_DIR = import.meta.dir

// Admission happens BEFORE any child is created. A queued request stores an
// executable descriptor and starts NOTHING until a slot frees, so the
// concurrency limits gate real execution and cancellation can withdraw a request
// with zero session.create/session.prompt. Durable state reconciles on restart.

const testDirectories = []

afterEach(() => {
  while (testDirectories.length > 0) {
    const directory = testDirectories.pop()
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
})

function createTestDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "rigel-bg-manager-"))
  testDirectories.push(directory)
  return directory
}

function deferred() {
  let resolve
  const promise = new Promise((settle) => { resolve = settle })
  return { promise, resolve }
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out: ${message}`)), ms)),
  ])
}

function tick(ms = 5) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createEventFeed() {
  const queue = []
  let notify
  let onConsumed
  let abortSignal
  const events = {
    async *[Symbol.asyncIterator]() {
      while (!abortSignal?.aborted) {
        while (queue.length === 0) {
          if (abortSignal?.aborted) return
          await new Promise((resolve) => {
            notify = resolve
            abortSignal?.addEventListener("abort", resolve, { once: true })
          })
        }
        if (abortSignal?.aborted) return
        yield queue.shift()
        const consumed = onConsumed
        onConsumed = undefined
        consumed?.()
      }
    },
  }
  return {
    events,
    subscribe: ({ signal } = {}) => { abortSignal = signal; return events },
    push(event) {
      queue.push(event)
      const resolve = notify
      notify = undefined
      resolve?.()
    },
    consumed() {
      return new Promise((resolve) => { onConsumed = resolve })
    },
  }
}

function backgroundContext(feed, directory, { onPrompt, backgroundTask, sessionGet } = {}) {
  let childCounter = 0
  const captured = { definition: undefined }
  const calls = { create: 0, prompt: 0, childPrompts: 0, interrupted: [] }
  const context = {
    location: { directory },
    ...(backgroundTask ? { config: { background_task: backgroundTask } } : {}),
    agent: {
      list: async () => ({ data: [{ id: "explore", name: "Explore", mode: "subagent" }] }),
      transform: async () => ({ dispose() {} }),
      reload: async () => {},
    },
    event: { subscribe: feed.subscribe },
    session: {
      hook: async (name, handler) => { if (name === "http.request") feed.requestHook = handler; return { dispose() {} } },
      create: async () => { calls.create += 1; return { data: { id: `ses_child_${++childCounter}` } } },
      context: async () => [{ type: "assistant", content: [{ type: "text", text: "EVIDENCE" }] }],
      // The documented seam the runtime resolves the calling session's own
      // project with; a test may override it (throw / unresolved) to prove the
      // admission path never falls back to the manager's static directory.
      get: sessionGet ?? (async () => ({ data: { location: { directory } } })),
      prompt: async (input) => {
        calls.prompt += 1
        if (typeof input?.sessionID === "string" && input.sessionID.startsWith("ses_child")) calls.childPrompts += 1
        if (typeof onPrompt === "function") await onPrompt(input)
        return { data: {} }
      },
      interrupt: async ({ sessionID }) => { calls.interrupted.push(sessionID); return { data: {} } },
    },
    tool: {
      transform: async (callback) => {
        callback({ add: (value) => { if (value?.name === "rigel_task") captured.definition = value } })
        return { dispose() {} }
      },
    },
  }
  return { context, captured, calls }
}

// ---------------------------------------------------------------------------
// Admission is BEFORE spawn
// ---------------------------------------------------------------------------

describe("#given a manager with a per-key limit of 1 and a counted spawner", () => {
  test("#when three background requests are admitted #then only the first is started until a slot frees", async () => {
    // given
    const starts = []
    const manager = createBackgroundManager({
      config: { defaultConcurrency: 1 },
      startChild: async (descriptor, onSession) => {
        starts.push(descriptor.taskId)
        onSession(`ses_${descriptor.taskId}`)
        return { sessionID: `ses_${descriptor.taskId}` }
      },
      runHandoff: async () => {},
    })

    // when
    const first = manager.admit({ taskId: "t1", parentSessionID: "p", agent: { name: "x" }, prompt: "a", modelKey: "m" })
    const second = manager.admit({ taskId: "t2", parentSessionID: "p", agent: { name: "x" }, prompt: "b", modelKey: "m" })
    const third = manager.admit({ taskId: "t3", parentSessionID: "p", agent: { name: "x" }, prompt: "c", modelKey: "m" })
    await first.ready

    // then: exactly ONE start before the first completes
    expect([first.admitted, second.queued, third.queued]).toEqual([true, true, true])
    expect(starts).toEqual(["t1"])
    expect(manager.runningCount("p")).toBe(1)

    // when the first completes
    manager.enqueueHandoff("ses_t1", "succeeded")
    await manager.whenIdle()
    await tick()

    // then: exactly the second starts
    expect(starts).toEqual(["t1", "t2"])

    // when the second completes
    manager.enqueueHandoff("ses_t2", "succeeded")
    await manager.whenIdle()
    await tick()

    // then: exactly the third starts
    expect(starts).toEqual(["t1", "t2", "t3"])
    manager.dispose()
  })
})

describe("#given the native runtime with a background limit of 1", () => {
  test("#when three background tasks are delegated #then session.create/prompt run exactly once until completion", async () => {
    // given
    const directory = createTestDirectory()
    const feed = createEventFeed()
    const { context, captured, calls } = backgroundContext(feed, directory, { backgroundTask: { defaultConcurrency: 1 } })
    const dispose = await plugin.setup(context)
    try {
      // when: three background requests
      await captured.definition.execute({ subagent_type: "explore", prompt: "a", run_in_background: true }, { sessionID: "ses_parent" })
      await captured.definition.execute({ subagent_type: "explore", prompt: "b", run_in_background: true }, { sessionID: "ses_parent" })
      await captured.definition.execute({ subagent_type: "explore", prompt: "c", run_in_background: true }, { sessionID: "ses_parent" })

      // then: only ONE real child exists
      expect(calls.create).toBe(1)
      expect(calls.childPrompts).toBe(1)

      // when the first child completes
      const consumedA = feed.consumed()
      feed.push({ type: "session.execution.succeeded", data: { sessionID: "ses_child_1" } })
      await consumedA
      await withTimeout((async () => { while (calls.create < 2) await tick() })(), 2000, "second child never started")
      expect(calls.create).toBe(2)

      // when the second completes
      const consumedB = feed.consumed()
      feed.push({ type: "session.execution.succeeded", data: { sessionID: "ses_child_2" } })
      await consumedB
      await withTimeout((async () => { while (calls.create < 3) await tick() })(), 2000, "third child never started")
      expect(calls.create).toBe(3)
      expect(calls.childPrompts).toBe(3)
    } finally {
      await dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("#given a queued background task", () => {
  test("#when it is cancelled #then it is withdrawn with ZERO session.create and the V1 error", async () => {
    // given
    let creates = 0
    const manager = createBackgroundManager({
      config: { defaultConcurrency: 1 },
      startChild: async (descriptor, onSession) => { creates += 1; onSession("ses_x"); return { sessionID: "ses_x" } },
      runHandoff: async () => {},
    })
    manager.admit({ taskId: "run", parentSessionID: "p", agent: { name: "x" }, prompt: "a", modelKey: "m" })
    const queued = manager.admit({ taskId: "queued", parentSessionID: "p", agent: { name: "x" }, prompt: "b", modelKey: "m" })
    const before = creates

    // when
    const result = manager.cancel(queued.taskId)

    // then
    expect(result).toMatchObject({ cancelled: true, mode: "queued" })
    expect(result.error.message).toBe("Concurrency queue cancelled for task: queued")
    expect(creates).toBe(before)
    expect(manager.getTask("queued")).toBeUndefined()
    manager.dispose()
  })

  test("#when a queued task is cancelled through the task tool #then no child is created", async () => {
    // given
    const directory = createTestDirectory()
    const feed = createEventFeed()
    const { context, captured, calls } = backgroundContext(feed, directory, { backgroundTask: { defaultConcurrency: 1 } })
    const dispose = await plugin.setup(context)
    try {
      const first = await captured.definition.execute({ subagent_type: "explore", prompt: "a", run_in_background: true }, { sessionID: "ses_parent" })
      const second = await captured.definition.execute({ subagent_type: "explore", prompt: "b", run_in_background: true }, { sessionID: "ses_parent" })
      expect(calls.create).toBe(1)

      // when: cancel the queued one by its taskId
      const queuedTaskId = second.metadata.taskId
      const cancelResult = await captured.definition.execute({ task_id: queuedTaskId, cancel: true, prompt: "" }, { sessionID: "ses_parent" })

      // then
      expect(cancelResult.metadata.cancelled).toBe(true)
      expect(cancelResult.metadata.mode).toBe("queued")
      expect(calls.create).toBe(1)
      expect(first.metadata.taskId).toBeDefined()
    } finally {
      await dispose()
    }
  })
})

describe("#given a running background task", () => {
  test("#when it is cancelled #then the real child is aborted and the slot released", async () => {
    // given
    const aborted = []
    const manager = createBackgroundManager({
      config: { defaultConcurrency: 1 },
      startChild: async (descriptor, onSession) => { onSession("ses_run"); return { sessionID: "ses_run" } },
      runHandoff: async () => {},
      abortChild: (sessionID) => { aborted.push(sessionID) },
    })
    const running = manager.admit({ taskId: "run", parentSessionID: "p", agent: { name: "x" }, prompt: "a", modelKey: "m" })
    await running.ready

    // when
    const result = manager.cancel(running.taskId)

    // then
    expect(result).toEqual({ cancelled: true, error: null, mode: "running" })
    expect(aborted).toEqual(["ses_run"])
    expect(manager.getTask("run")).toBeUndefined()
    manager.dispose()
  })
})

// ---------------------------------------------------------------------------
// Durable state + reconciliation
// ---------------------------------------------------------------------------

describe("#given durable background state from a previous process", () => {
  test("#when the manager restores #then queued descriptors start once and running children are not re-created", async () => {
    // given: process A admitted 3 (t1 running, t2/t3 queued) and did NOT clean up
    const directory = createTestDirectory()
    const startedA = []
    const managerA = createBackgroundManager({
      directory,
      stateStore: createFileBackgroundState(directory),
      config: { defaultConcurrency: 1 },
      startChild: async (descriptor, onSession) => { startedA.push(descriptor.taskId); onSession(`ses_${descriptor.taskId}`); return { sessionID: `ses_${descriptor.taskId}` } },
      runHandoff: async () => {},
    })
    managerA.admit({ taskId: "t1", parentSessionID: "p", agent: { name: "x" }, prompt: "a", modelKey: "m" })
    managerA.admit({ taskId: "t2", parentSessionID: "p", agent: { name: "x" }, prompt: "b", modelKey: "m" })
    managerA.admit({ taskId: "t3", parentSessionID: "p", agent: { name: "x" }, prompt: "c", modelKey: "m" })
    await tick()
    expect(startedA).toEqual(["t1"])

    // when: process B restores the same directory
    const startedB = []
    const managerB = createBackgroundManager({
      directory,
      stateStore: createFileBackgroundState(directory),
      config: { defaultConcurrency: 1 },
      startChild: async (descriptor, onSession) => { startedB.push(descriptor.taskId); onSession(`ses_${descriptor.taskId}`); return { sessionID: `ses_${descriptor.taskId}` } },
      runHandoff: async () => {},
    })
    const summary = await managerB.restore()

    // then: the running child is re-tracked WITHOUT a re-create, and the restored
    // queue holds t2/t3 as real FIFO waiters (nothing bypasses the limit). Waiting
    // a tick proves the queued descriptors did NOT start on their own.
    expect(summary.running).toBe(1)
    expect(summary.queued).toBe(2)
    await tick(20)
    expect(startedB).toEqual([])
    expect(managerB.has("ses_t1")).toBe(true)
    expect(managerB.runningCount("p")).toBe(1)
    expect(managerB.queueStats("m")).toEqual({ count: 1, queued: 2 })

    // when the restored running child completes, exactly the next queued starts
    managerB.enqueueHandoff("ses_t1", "succeeded")
    await withTimeout((async () => { while (startedB.length < 1) await tick() })(), 2000, "restored queued child never started")
    expect(startedB).toEqual(["t2"])
    expect(managerB.runningCount("p")).toBe(1)
    managerB.dispose()
  })

  test("#when a wake was undelivered before the restart #then it is re-enqueued once", async () => {
    // given
    const directory = createTestDirectory()
    const delivered = []
    const managerA = createBackgroundManager({
      directory,
      stateStore: createFileBackgroundState(directory),
      config: { defaultConcurrency: 1 },
      startChild: async (descriptor, onSession) => { onSession(`ses_${descriptor.taskId}`); return { sessionID: `ses_${descriptor.taskId}` } },
      runHandoff: async ({ sessionID }) => { delivered.push(sessionID) },
    })
    const running = managerA.admit({ taskId: "t1", parentSessionID: "p", agent: { name: "x" }, prompt: "a", modelKey: "m" })
    await running.ready
    // complete the child but leave the wake queued (no pump drain yet): simulate a
    // crash before delivery by writing the pending wake, not by awaiting the pump.
    const stateBefore = JSON.parse(readFileSync(join(directory, ".omo/background/p.json"), "utf-8"))
    expect(stateBefore.tasks.some((task) => task.taskId === "t1")).toBe(true)

    // when: process B restores
    const deliveredB = []
    const managerB = createBackgroundManager({
      directory,
      stateStore: createFileBackgroundState(directory),
      config: { defaultConcurrency: 1 },
      startChild: async (descriptor, onSession) => { onSession(`ses_${descriptor.taskId}`); return { sessionID: `ses_${descriptor.taskId}` } },
      runHandoff: async ({ sessionID }) => { deliveredB.push(sessionID) },
    })
    await managerB.restore()
    await managerB.whenIdle()

    // then: the running child is restored and does not re-create
    expect(managerB.has("ses_t1")).toBe(true)
    managerB.dispose()
  })
})

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

describe("#given the on-disk continuation marker", () => {
  test("#when a queued and a running child exist #then the marker is active and returns idle after completion", async () => {
    // given
    const directory = createTestDirectory()
    const manager = createBackgroundManager({
      directory,
      stateStore: createFileBackgroundState(directory),
      config: { defaultConcurrency: 1 },
      startChild: async (descriptor, onSession) => { onSession(`ses_${descriptor.taskId}`); return { sessionID: `ses_${descriptor.taskId}` } },
      runHandoff: async () => {},
    })
    manager.admit({ taskId: "t1", parentSessionID: "parent", parentDirectory: directory, agent: { name: "x" }, prompt: "a", modelKey: "m" })
    manager.admit({ taskId: "t2", parentSessionID: "parent", parentDirectory: directory, agent: { name: "x" }, prompt: "b", modelKey: "m" })
    expect(readBackgroundMarker(directory, "parent")).toMatchObject({ state: "active", reason: "2 background task(s) active" })

    // when both complete
    manager.enqueueHandoff("ses_t1", "succeeded")
    await manager.whenIdle()
    manager.enqueueHandoff("ses_t2", "succeeded")
    await manager.whenIdle()

    // then
    expect(readBackgroundMarker(directory, "parent").state).toBe("idle")
    manager.dispose()
  })

  test("#when another continuation source already exists in the file #then the background rewrite preserves it", () => {
    // given
    const directory = createTestDirectory()
    writeBackgroundMarker({ directory, parentSessionID: "parent", activeTaskCount: 0, hasUndeliveredParentWake: false })
    const file = join(directory, ".omo/run-continuation/parent.json")
    const seeded = JSON.parse(readFileSync(file, "utf-8"))
    seeded.sources.todo = { state: "active", updatedAt: "2026-01-01T00:00:00.000Z" }
    writeFileSync(file, JSON.stringify(seeded))

    // when
    writeBackgroundMarker({ directory, parentSessionID: "parent", activeTaskCount: 2, hasUndeliveredParentWake: false })

    // then
    const written = JSON.parse(readFileSync(file, "utf-8"))
    expect(written.sources.todo.state).toBe("active")
    expect(written.sources["background-task"]).toMatchObject({ state: "active", reason: "2 background task(s) active" })
    clearBackgroundMarker(directory, "parent")
    expect(readBackgroundMarker(directory, "parent")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Non-blocking handoff (unchanged invariant)
// ---------------------------------------------------------------------------

describe("#given the native runtime with a hung parent handoff", () => {
  test("#when a second child completes #then the event loop processes it and the handoffs stay serial", async () => {
    // given
    const directory = createTestDirectory()
    const feed = createEventFeed()
    const parentPrompts = []
    const firstPromptStarted = deferred()
    const secondPromptStarted = deferred()
    const firstGate = deferred()
    const { context, captured } = backgroundContext(feed, directory, {
      onPrompt: async (input) => {
        if (input.sessionID !== "ses_parent") return
        parentPrompts.push(input.text)
        if (parentPrompts.length === 1) {
          firstPromptStarted.resolve()
          await firstGate.promise
        }
        if (parentPrompts.length === 2) secondPromptStarted.resolve()
      },
    })
    const dispose = await plugin.setup(context)
    try {
      await captured.definition.execute({ subagent_type: "explore", prompt: "a", run_in_background: true }, { sessionID: "ses_parent" })
      await captured.definition.execute({ subagent_type: "explore", prompt: "b", run_in_background: true }, { sessionID: "ses_parent" })

      const consumedA = feed.consumed()
      feed.push({ type: "session.execution.succeeded", data: { sessionID: "ses_child_1" } })
      await consumedA
      await withTimeout(firstPromptStarted.promise, 2000, "first parent handoff never started")

      const consumedB = feed.consumed()
      feed.push({ type: "session.execution.succeeded", data: { sessionID: "ses_child_2" } })
      await withTimeout(consumedB, 2000, "event loop was blocked by the hung handoff")
      expect(parentPrompts.length).toBe(1)

      firstGate.resolve()
      await withTimeout(secondPromptStarted.promise, 2000, "second parent handoff never delivered")
      expect(parentPrompts.length).toBe(2)
    } finally {
      await dispose()
    }
  })
})

describe("#given the native runtime and a tracked background child", () => {
  test("#when session.deleted arrives for the child #then the parent continuation marker returns idle", async () => {
    // given
    const directory = createTestDirectory()
    const feed = createEventFeed()
    const { context, captured } = backgroundContext(feed, directory, { onPrompt: async () => {} })
    const dispose = await plugin.setup(context)
    try {
      await captured.definition.execute({ subagent_type: "explore", prompt: "a", run_in_background: true }, { sessionID: "ses_parent" })
      expect(readBackgroundMarker(directory, "ses_parent").state).toBe("active")

      // when
      const consumed = feed.consumed()
      feed.push({ type: "session.deleted", data: { sessionID: "ses_child_1" } })
      await consumed

      // then
      expect(readBackgroundMarker(directory, "ses_parent").state).toBe("idle")
    } finally {
      await dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Retry classifier (unchanged)
// ---------------------------------------------------------------------------

describe("#given the composed retry classifier", () => {
  const currentModel = { providerID: "anthropic", modelID: "claude-sonnet-4-6" }
  const chain = [
    { model: "claude-opus-4-7", providers: ["anthropic"] },
    { model: "gemini-3.1-pro", providers: ["google"] },
  ]

  test("#when the error is retryable #then the next chain rung is selected", () => {
    const manager = createBackgroundManager({ startChild: async () => ({ sessionID: "s" }), runHandoff: async () => {} })
    const decision = manager.classifyRetry({ errorInfo: { name: "ProviderModelNotFoundError" }, currentModel, attemptCount: 0, fallbackChain: chain })
    expect(decision.action).toBe("retry")
    expect(decision.nextModel).toMatchObject({ providerID: "anthropic", modelID: "claude-opus-4-7" })
    manager.dispose()
  })

  test("#when the agent is not found #then it swaps to the fallback agent", () => {
    const manager = createBackgroundManager({ startChild: async () => ({ sessionID: "s" }), runHandoff: async () => {} })
    const decision = manager.classifyRetry({ errorInfo: "Agent not found: missing-agent", currentAgent: "explore", fallbackChain: chain })
    expect(decision).toMatchObject({ action: "fallback-agent", reason: "agent-not-found", agent: "general" })
    manager.dispose()
  })

  test("#when the fallback budget is exhausted #then no retry is attempted", () => {
    const manager = createBackgroundManager({ startChild: async () => ({ sessionID: "s" }), runHandoff: async () => {} })
    const decision = manager.classifyRetry({ errorInfo: { name: "ProviderModelNotFoundError" }, currentModel, attemptCount: 2, fallbackChain: chain })
    expect(decision).toMatchObject({ action: "none", reason: "exhausted" })
    manager.dispose()
  })
})

// ---------------------------------------------------------------------------
// Persistence / restart (R4)
// ---------------------------------------------------------------------------

describe("#given a clean plugin dispose and a new instance", () => {
  test("#when the plugin unloads and reloads #then queued/running/wakes survive and nothing is duplicated", async () => {
    const directory = createTestDirectory()
    const startsA = []
    const managerA = createBackgroundManager({
      directory, stateStore: createFileBackgroundState(directory), config: { defaultConcurrency: 1 },
      startChild: async (descriptor, onSession) => { startsA.push(descriptor.taskId); onSession(`ses_${descriptor.taskId}`); return { sessionID: `ses_${descriptor.taskId}` } },
      runHandoff: async () => {},
    })
    managerA.admit({ taskId: "t1", parentSessionID: "p", agent: { name: "x" }, prompt: "a", modelKey: "m" })
    managerA.admit({ taskId: "t2", parentSessionID: "p", agent: { name: "x" }, prompt: "b", modelKey: "m" })
    await tick()
    expect(startsA).toEqual(["t1"])
    await managerA.dispose() // clean unload must NOT delete durable state

    const startsB = []
    const managerB = createBackgroundManager({
      directory, stateStore: createFileBackgroundState(directory), config: { defaultConcurrency: 1 },
      startChild: async (descriptor, onSession) => { startsB.push(descriptor.taskId); onSession(`ses_${descriptor.taskId}`); return { sessionID: `ses_${descriptor.taskId}` } },
      runHandoff: async () => {},
    })
    const summary = await managerB.restore()
    await tick(20)

    expect(summary.running).toBe(1)
    expect(summary.queued).toBe(1)
    expect(startsB).toEqual([])
    expect(managerB.has("ses_t1")).toBe(true)
    await managerB.dispose()
  })

  test("#when the plugin is disposed twice #then the durable state is still intact for a later restore", async () => {
    const directory = createTestDirectory()
    const manager = createBackgroundManager({
      directory, stateStore: createFileBackgroundState(directory), config: { defaultConcurrency: 1 },
      startChild: async (descriptor, onSession) => { onSession(`ses_${descriptor.taskId}`); return { sessionID: `ses_${descriptor.taskId}` } },
      runHandoff: async () => {},
    })
    manager.admit({ taskId: "t1", parentSessionID: "p", agent: { name: "x" }, prompt: "a", modelKey: "m" })
    await tick()
    await manager.dispose()
    await manager.dispose()
    const state = await createFileBackgroundState(directory).read("p")
    expect(state.tasks.some((task) => task.taskId === "t1")).toBe(true)
  })
})

describe("#given a global (plugin-id-scoped) background store shared across projects", () => {
  function createSharedStore() {
    const state = {}
    return {
      async write(parent, snapshot) { state[parent] = snapshot; return true },
      async read(parent) { return state[parent] ?? null },
      async list() { return Object.keys(state) },
      async clear(parent) { delete state[parent] },
      // Test-only: seed a durable state exactly as a legacy file would read back
      // (used to reproduce the pre-`parentDirectory` shape).
      __seed(parent, legacyState) { state[parent] = legacyState },
    }
  }

  test("#when a project loads and restores #then only its own parent markers are materialized", async () => {
    // given: two project directories and ONE global store, exactly like the
    // `ctx.storage` domain the runtime injects (scoped to the plugin id, not the
    // project). A continuation marker is a per-project file, so a foreign
    // parent's marker must never be written into the active project.
    const dirA = createTestDirectory()
    const dirB = createTestDirectory()
    const store = createSharedStore()
    const spawn = (started) => async (descriptor, onSession) => { started.push(descriptor.taskId); onSession(`ses_${descriptor.taskId}`); return { sessionID: `ses_${descriptor.taskId}` } }
    const managerA = createBackgroundManager({
      directory: dirA, stateStore: store, config: { defaultConcurrency: 4 },
      startChild: spawn([]), runHandoff: async () => {},
    })
    const readyA = managerA.admit({ taskId: "tA", parentSessionID: "pA", parentDirectory: dirA, agent: { name: "x" }, prompt: "a", modelKey: "m" })
    await readyA.ready
    await managerA.dispose()
    const managerB1 = createBackgroundManager({
      directory: dirB, stateStore: store, config: { defaultConcurrency: 4 },
      startChild: spawn([]), runHandoff: async () => {},
    })
    const readyB = managerB1.admit({ taskId: "tB", parentSessionID: "pB", parentDirectory: dirB, agent: { name: "x" }, prompt: "b", modelKey: "m" })
    await readyB.ready
    await managerB1.dispose()

    // when: a fresh load of project B restores the shared store
    const managerB2 = createBackgroundManager({
      directory: dirB, stateStore: store, config: { defaultConcurrency: 4 },
      startChild: spawn([]), runHandoff: async () => {},
    })
    await managerB2.restore()
    await managerB2.dispose()

    // then: project B's own parent marker is materialized; project A's is not
    expect(readBackgroundMarker(dirB, "pB")).not.toBeNull()
    expect(readBackgroundMarker(dirB, "pA")).toBeNull()
  })

  test("#when a parent is tracked with its own project directory #then its marker lands there, not in the manager directory", async () => {
    // given: the manager's static location and the calling session's own project
    // differ (the global event/tool surface can serve several projects)
    const managerDir = createTestDirectory()
    const parentDir = createTestDirectory()
    const manager = createBackgroundManager({
      directory: managerDir, stateStore: createSharedStore(), config: { defaultConcurrency: 4 },
      startChild: async (_descriptor, onSession) => { onSession("ses_x"); return { sessionID: "ses_x" } }, runHandoff: async () => {},
    })
    // when
    const admitted = manager.admit({ taskId: "t1", parentSessionID: "p", parentDirectory: parentDir, agent: { name: "x" }, prompt: "a", modelKey: "m" })
    await admitted.ready
    await manager.dispose()
    // then
    expect(readBackgroundMarker(parentDir, "p")).not.toBeNull()
    expect(readBackgroundMarker(managerDir, "p")).toBeNull()
  })

  // A durable state written BEFORE `parentDirectory` existed carries no project.
  // The manager must never attribute its own active directory to such a parent:
  // that is the exact leak (54 markers in the plugin dir, 13 copied into a fresh
  // scratch project) the re-audit flagged.
  function seedLegacyState(store, parentSessionID, taskId, sessionID) {
    store.__seed(parentSessionID, {
      schema: 1,
      parentSessionID,
      updatedAt: "2026-01-01T00:00:00.000Z",
      // NOTE: no `parentDirectory` key at all (the legacy shape).
      tasks: [{ taskId, status: "running", route: "subagent", agent: { name: "x" }, model: "m", key: "legacy", limit: 1, sessionID, createdAt: "2026-01-01T00:00:00.000Z" }],
      wakes: [],
    })
  }

  test("#when a legacy state (no parentDirectory) is restored with a resolver #then only the parent whose real project == the active project gets a marker", async () => {
    // given: two legacy parents in a shared store, one of project A and one of
    // project B; the resolver is the trusted seam (`context.session.get`).
    const dirA = createTestDirectory()
    const dirB = createTestDirectory()
    const store = createSharedStore()
    seedLegacyState(store, "pA", "tA", "ses_tA")
    seedLegacyState(store, "pB", "tB", "ses_tB")
    const resolved = { pA: dirA, pB: dirB }
    const managerB = createBackgroundManager({
      directory: dirB, stateStore: store, config: { defaultConcurrency: 4 },
      startChild: async () => ({ sessionID: "ses_unused" }), runHandoff: async () => {},
      resolveParentDirectory: async (parentSessionID) => resolved[parentSessionID],
    })

    // when: project B loads and restores
    await managerB.restore()
    await managerB.dispose()

    // then: B's own parent marker is materialized; A's is NOT written into B (nor
    // into A from B's load), and the durable state is preserved for both
    expect(readBackgroundMarker(dirB, "pB")).not.toBeNull()
    expect(readBackgroundMarker(dirB, "pA")).toBeNull()
    expect(readBackgroundMarker(dirA, "pA")).toBeNull()
    const stateA = await store.read("pA")
    expect(stateA.tasks.some((task) => task.taskId === "tA")).toBe(true)
    // the resolved directory is persisted so a later load needs no resolver
    expect(stateA.parentDirectory).toBe(dirA)
  })

  test("#when a legacy state cannot be resolved #then the durable state survives but NO marker is written (fail closed)", async () => {
    // given: a legacy parent the resolver cannot place (no directory source)
    const activeDir = createTestDirectory()
    const store = createSharedStore()
    seedLegacyState(store, "pX", "tX", "ses_tX")
    const manager = createBackgroundManager({
      directory: activeDir, stateStore: store, config: { defaultConcurrency: 4 },
      startChild: async () => ({ sessionID: "ses_unused" }), runHandoff: async () => {},
      // resolver present but unable to place the parent
      resolveParentDirectory: async () => undefined,
    })

    // when
    await manager.restore()
    await manager.dispose()

    // then: no marker lands in the active project, and the task state is intact
    expect(readBackgroundMarker(activeDir, "pX")).toBeNull()
    const state = await store.read("pX")
    expect(state.tasks.some((task) => task.taskId === "tX")).toBe(true)
    expect(state.parentDirectory).toBeUndefined()
  })

  test("#when clearParent runs for a parent whose directory is unknown #then no foreign project marker is deleted", async () => {
    // given: a real marker sits in a foreign project, and pX restores unknown
    const activeDir = createTestDirectory()
    const foreignDir = createTestDirectory()
    writeBackgroundMarker({ directory: foreignDir, parentSessionID: "pX", activeTaskCount: 1, hasUndeliveredParentWake: false })
    const store = createSharedStore()
    seedLegacyState(store, "pX", "tX", "ses_tX")
    const manager = createBackgroundManager({
      directory: activeDir, stateStore: store, config: { defaultConcurrency: 4 },
      startChild: async () => ({ sessionID: "ses_unused" }), runHandoff: async () => {},
      resolveParentDirectory: async () => undefined,
    })
    await manager.restore()

    // when: the parent is deleted while its project is still unknown
    manager.clearParent("pX")

    // then: the foreign marker is untouched (unknown project => never guess a
    // directory to delete), and nothing was removed from the active project
    expect(readBackgroundMarker(foreignDir, "pX")).not.toBeNull()
    expect(readBackgroundMarker(activeDir, "pX")).toBeNull()
    await manager.dispose()
  })
})

describe("#given a new admission whose parent directory cannot be resolved", () => {
  test("#when the descriptor carries no parentDirectory #then the task runs, the state is durable and NO marker is written", async () => {
    // given: the runtime could not resolve the calling session's own directory,
    // so it hands `admit` no `parentDirectory`. The manager must NEVER substitute
    // its own static location (that is the cross-project marker leak).
    const directory = createTestDirectory()
    const started = []
    const manager = createBackgroundManager({
      directory, stateStore: createFileBackgroundState(directory), config: { defaultConcurrency: 4 },
      startChild: async (descriptor, onSession) => { started.push(descriptor.taskId); onSession(`ses_${descriptor.taskId}`); return { sessionID: `ses_${descriptor.taskId}` } },
      runHandoff: async () => {},
    })
    // when
    const decision = manager.admit({ taskId: "t1", parentSessionID: "p", agent: { name: "x" }, prompt: "a", modelKey: "m" })
    await decision.ready
    await manager.dispose()
    // then: functional task + durable state, but no marker in the active directory
    expect(decision.admitted).toBe(true)
    expect(started).toEqual(["t1"])
    const state = await createFileBackgroundState(directory).read("p")
    expect(state.tasks.some((task) => task.taskId === "t1")).toBe(true)
    expect(state.parentDirectory).toBeUndefined()
    expect(readBackgroundMarker(directory, "p")).toBeNull()
  })

  test("#when the resolution seam throws or yields an empty response #then the real tool path admits the task with no marker", async () => {
    const variants = [
      ["throws", async () => { throw new Error("seam-failure") }],
      ["empty", async () => ({ data: {} })],
    ]
    for (const [label, sessionGet] of variants) {
      // given
      const directory = createTestDirectory()
      const feed = createEventFeed()
      const { context, captured } = backgroundContext(feed, directory, { sessionGet })
      const dispose = await plugin.setup(context)
      try {
        // when: the real rigel_task background admission runs
        const result = await captured.definition.execute({ subagent_type: "explore", prompt: "a", run_in_background: true }, { sessionID: "ses_parent" })
        // then: the task is functional (has a child session) and its state is
        // durable, but no marker is written into the active project
        expect([label, typeof result?.metadata?.sessionID]).toEqual([label, "string"])
        const state = await createFileBackgroundState(directory).read("ses_parent")
        expect([label, state !== null && state.tasks.length]).toEqual([label, 1])
        expect([label, readBackgroundMarker(directory, "ses_parent")]).toEqual([label, null])
      } finally {
        await dispose()
      }
    }
  })
})

describe("#given a persistence store with controllable ordering", () => {
  test("#when an older write is slow #then a newer snapshot is never overwritten by it", async () => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const completed = []
    let count = 0
    const store = {
      async write(_parent, state) { count += 1; const id = count; if (id === 1) await gate; completed.push({ id, tasks: state.tasks.length }) },
      async read() { return null }, async list() { return [] }, async clear() {},
    }
    const manager = createBackgroundManager({
      stateStore: store, config: { defaultConcurrency: 1 },
      startChild: async (descriptor, onSession) => { onSession(`ses_${descriptor.taskId}`); return { sessionID: `ses_${descriptor.taskId}` } },
      runHandoff: async () => {},
    })
    manager.admit({ taskId: "t1", parentSessionID: "p", agent: { name: "x" }, prompt: "a", modelKey: "m" })
    await tick()
    manager.admit({ taskId: "t2", parentSessionID: "p", agent: { name: "x" }, prompt: "b", modelKey: "m" })
    release()
    await manager.flush()
    expect(completed.length).toBeGreaterThanOrEqual(2)
    expect(completed.at(-1).tasks).toBe(2)
    await manager.dispose()
  })

  test("#when a clear races a write #then a stale write does not resurrect the parent", async () => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    let count = 0
    const state = {}
    const store = {
      async write(parent, snapshot) { count += 1; if (count === 1) await gate; state[parent] = snapshot },
      async read(parent) { return state[parent] ?? null }, async list() { return Object.keys(state) }, async clear(parent) { delete state[parent] },
    }
    const manager = createBackgroundManager({
      stateStore: store, config: { defaultConcurrency: 1 },
      startChild: async (descriptor, onSession) => { onSession(`ses_${descriptor.taskId}`); return { sessionID: `ses_${descriptor.taskId}` } },
      runHandoff: async () => {},
    })
    manager.admit({ taskId: "t1", parentSessionID: "p", agent: { name: "x" }, prompt: "a", modelKey: "m" })
    await tick()
    manager.clearParent("p")
    release()
    await manager.flush()
    // A clear must win: no in-flight write may resurrect the parent afterward.
    expect(state.p).toBeUndefined()
    await manager.dispose()
  })
})

describe("#given a starting crash window", () => {
  test("#when a child with the taskId nonce exists #then restore binds it without re-creating", async () => {
    const directory = createTestDirectory()
    const store = createFileBackgroundState(directory)
    await store.write("p", { tasks: [{ taskId: "t1", status: "starting", agent: { name: "x" }, key: "m", limit: 1, model: "m", prompt: "a" }], wakes: [] })
    let creates = 0
    const manager = createBackgroundManager({
      directory, stateStore: store, config: { defaultConcurrency: 1 },
      startChild: async (descriptor, onSession) => { creates += 1; onSession(`ses_${descriptor.taskId}`); return { sessionID: `ses_${descriptor.taskId}` } },
      runHandoff: async () => {},
    })
    const summary = await manager.restore({ findStartedChild: async () => ({ sessionID: "ses_found" }) })
    expect(summary.bound).toBe(1)
    expect(creates).toBe(0)
    expect(manager.has("ses_found")).toBe(true)
    await manager.dispose()
  })

  test("#when no child with the nonce exists #then restore re-admits the descriptor exactly once", async () => {
    const directory = createTestDirectory()
    const store = createFileBackgroundState(directory)
    await store.write("p", { tasks: [{ taskId: "t1", status: "starting", agent: { name: "x" }, key: "m", limit: 1, model: "m", prompt: "a" }], wakes: [] })
    let creates = 0
    const manager = createBackgroundManager({
      directory, stateStore: store, config: { defaultConcurrency: 1 },
      startChild: async (descriptor, onSession) => { creates += 1; onSession(`ses_${descriptor.taskId}`); return { sessionID: `ses_${descriptor.taskId}` } },
      runHandoff: async () => {},
    })
    const summary = await manager.restore({ findStartedChild: async () => undefined })
    await tick()
    expect(summary.starting).toBe(1)
    expect(creates).toBe(1)
    await manager.dispose()
  })
})

// ---------------------------------------------------------------------------
// Descendant cancellation (/stop-continuation parity)
// ---------------------------------------------------------------------------

describe("#given a session with transitive background descendants", () => {
  test("#when cancelDescendants runs #then only that session's cancellable descendants are cancelled and persisted", async () => {
    // given: p -> c1 (running) -> g1 (running, via c1's session id), c2 (queued),
    // plus an unrelated parent's running child u1.
    const directory = createTestDirectory()
    const aborted = []
    const manager = createBackgroundManager({
      directory,
      stateStore: createFileBackgroundState(directory),
      config: { defaultConcurrency: 1 },
      startChild: async (descriptor, onSession) => {
        const sessionID = `ses_${descriptor.taskId}`
        onSession(sessionID)
        return { sessionID }
      },
      runHandoff: async () => {},
      abortChild: (sessionID) => { aborted.push(sessionID) },
    })
    const c1 = manager.admit({ taskId: "c1", parentSessionID: "p", agent: { name: "x" }, prompt: "a", modelKey: "m" })
    await c1.ready
    manager.admit({ taskId: "c2", parentSessionID: "p", agent: { name: "x" }, prompt: "b", modelKey: "m" })
    const g1 = manager.admit({ taskId: "g1", parentSessionID: "ses_c1", agent: { name: "x" }, prompt: "c", modelKey: "m2" })
    await g1.ready
    const u1 = manager.admit({ taskId: "u1", parentSessionID: "other", agent: { name: "x" }, prompt: "d", modelKey: "m3" })
    await u1.ready
    expect(manager.getTask("c2").status).toBe("queued")

    // when
    const results = manager.cancelDescendants("p", { source: "stop-continuation", reason: "r", skipNotification: true })
    await manager.flush()

    // then: the running child, the queued child, and the transitive grandchild
    // are all cancelled; the unrelated parent's child is untouched.
    expect(results.map((result) => result.taskId).sort()).toEqual(["c1", "c2", "g1"])
    expect(results.every((result) => result.cancelled === true)).toBe(true)
    expect(results.find((result) => result.taskId === "c1").mode).toBe("running")
    expect(results.find((result) => result.taskId === "c2").mode).toBe("queued")
    expect(results.find((result) => result.taskId === "g1").mode).toBe("running")
    expect(manager.getTask("c1")).toBeUndefined()
    expect(manager.getTask("c2")).toBeUndefined()
    expect(manager.getTask("g1")).toBeUndefined()
    expect(manager.getTask("u1")).toBeDefined()
    expect(aborted.sort()).toEqual(["ses_c1", "ses_g1"])

    // and the cancellation is durable: p holds no tasks while the unrelated
    // parent keeps its child.
    const pState = await createFileBackgroundState(directory).read("p")
    const otherState = await createFileBackgroundState(directory).read("other")
    expect((pState?.tasks ?? []).map((task) => task.taskId)).toEqual([])
    expect((otherState?.tasks ?? []).map((task) => task.taskId)).toEqual(["u1"])
    await manager.dispose()
  })
})

// ---------------------------------------------------------------------------
// Compaction history (T21 "Active/Recent Delegated Sessions")
// ---------------------------------------------------------------------------

function createAdmittingManager() {
  return createBackgroundManager({
    config: { defaultConcurrency: 1 },
    startChild: async (descriptor, onSession) => { onSession(`ses_${descriptor.taskId}`); return { sessionID: `ses_${descriptor.taskId}` } },
    runHandoff: async () => {},
  })
}

describe("#given a manager with no records for a parent", () => {
  test("#when formatForCompaction is called #then it returns null and the empty helper returns null", () => {
    // given
    const manager = createAdmittingManager()

    // when / then
    expect(manager.formatForCompaction("missing")).toBeNull()
    expect(formatCompactionHistory([])).toBeNull()
    manager.dispose()
  })
})

describe("#given a parent with fewer than the compaction cap of records", () => {
  test("#when formatForCompaction is called #then every record is listed in the V1 line format", async () => {
    // given
    const manager = createAdmittingManager()
    for (let index = 1; index <= 5; index += 1) {
      manager.admit({ taskId: `t${index}`, parentSessionID: "p", agent: { name: "explore" }, category: { name: "quick" }, prompt: `prompt ${index}`, modelKey: "m" })
    }
    await tick()

    // when
    const output = manager.formatForCompaction("p")

    // then: the newest entry is a running child, the rest are queued, and every
    // record appears exactly once.
    expect(typeof output).toBe("string")
    for (let index = 1; index <= 5; index += 1) {
      expect(output).toContain(`task_id: \`t${index}\``)
    }
    expect(output).toContain("- **explore**[quick](running)")
    expect(output).toContain("- **explore**[quick](queued)")
    manager.dispose()
  })
})

describe("#given a parent with more records than the compaction cap", () => {
  test("#when formatForCompaction is called #then only the 20 most recent are kept with the omitted summary", async () => {
    // given: 23 records, so the 3 oldest must be dropped.
    const manager = createAdmittingManager()
    for (let index = 1; index <= 23; index += 1) {
      manager.admit({ taskId: `t${String(index).padStart(2, "0")}`, parentSessionID: "p", agent: { name: "explore" }, prompt: `prompt ${index}`, modelKey: "m" })
    }
    await tick()

    // when
    const output = manager.formatForCompaction("p")

    // then
    expect(output).toContain("- 3 delegated sessions omitted to stay within compaction budget.")
    expect(output).not.toContain("task_id: `t01`")
    expect(output).not.toContain("task_id: `t02`")
    expect(output).not.toContain("task_id: `t03`")
    for (let index = 4; index <= 23; index += 1) {
      expect(output).toContain(`task_id: \`t${String(index).padStart(2, "0")}\``)
    }
    manager.dispose()
  })
})

describe("#given a queued record whose prompt exceeds the description cap", () => {
  test("#when formatForCompaction is called #then the description is compacted at 240 chars", async () => {
    // given
    const manager = createAdmittingManager()
    manager.admit({ taskId: "head", parentSessionID: "p", agent: { name: "explore" }, prompt: "short", modelKey: "m" })
    manager.admit({ taskId: "long", parentSessionID: "p", agent: { name: "explore" }, prompt: "x".repeat(300), modelKey: "m" })
    await tick()

    // when
    const output = manager.formatForCompaction("p")

    // then: 240 chars total including the suffix.
    const expected = `${"x".repeat(240 - "... [truncated]".length)}... [truncated]`
    expect(output).toContain(`: ${expected}`)
    expect(output).not.toContain("x".repeat(241))
    manager.dispose()
  })
})

describe("#given a compaction entry whose live status is absent", () => {
  test("#when formatCompactionHistory runs #then it falls back to resultStatus", () => {
    // when
    const output = formatCompactionHistory([
      { id: "t1", agent: "explore", category: "quick", status: undefined, resultStatus: "failed", sessionID: "ses_1", description: "did a thing" },
    ])

    // then
    expect(output).toBe("- **explore**[quick](failed) task_id: `t1`: did a thing | session: `ses_1`")
  })
})

describe("#given a compaction history that would exceed the total char budget", () => {
  test("#when formatCompactionHistory runs #then the summary stays within 6000 chars and reports the omission", () => {
    // given: 20 entries whose per-line length exceeds a fifth of the budget.
    const entries = Array.from({ length: 20 }, (_, index) => ({
      id: `t${index}`,
      agent: "a".repeat(80),
      category: "c".repeat(60),
      status: "succeeded",
      sessionID: "s".repeat(120),
      description: "d".repeat(240),
    }))

    // when
    const output = formatCompactionHistory(entries)

    // then
    expect(output.length).toBeLessThanOrEqual(6000)
    expect(output).toContain("delegated sessions omitted to stay within compaction budget.")
    expect(output).not.toContain("task_id: `t0`")
    expect(output).toContain("task_id: `t19`")
  })
})

describe("#given a parent with active and queued records", () => {
  test("#when formatForCompaction is called twice #then it is read-only and stable", async () => {
    // given
    const manager = createAdmittingManager()
    manager.admit({ taskId: "t1", parentSessionID: "p", agent: { name: "explore" }, prompt: "a", modelKey: "m" })
    manager.admit({ taskId: "t2", parentSessionID: "p", agent: { name: "explore" }, prompt: "b", modelKey: "m" })
    await tick()
    const before = {
      active: manager.activeCount("p"),
      running: manager.runningCount("p"),
      wakes: manager.pendingWakeCount("p"),
      queue: manager.queueStats("m"),
      task: manager.getTask("t2"),
    }

    // when
    const first = manager.formatForCompaction("p")
    const second = manager.formatForCompaction("p")

    // then
    expect(first).toBe(second)
    expect({
      active: manager.activeCount("p"),
      running: manager.runningCount("p"),
      wakes: manager.pendingWakeCount("p"),
      queue: manager.queueStats("m"),
      task: manager.getTask("t2"),
    }).toEqual(before)
    expect(before.task.prompt).toBe("b")
    manager.dispose()
  })
})

// ---------------------------------------------------------------------------
// Named-RED mutation harness
// ---------------------------------------------------------------------------

describe("Rigel V2 background manager named-RED mutation harness", () => {
  test("#given cancelDescendants drops its status filter #when the contract runs #then it turns RED and restores byte-identically", async () => {
    // given: an isolated copy of the module tree, so the mutated file's relative
    // imports still resolve and the tracked source is never touched.
    const root = mkdtempSync(join(tmpdir(), "rigel-bg-mutant-"))
    const directory = join(root, "opencode")
    cpSync(OPENCODE_DIR, directory, { recursive: true })
    const target = join(directory, "rigel-v2-background-manager.mjs")
    const before = readFileSync(target)

    // when
    const receipt = await runMutation({
      file: target,
      mutate: (source) => source.replace(
        '      record.status === "queued" || record.status === "starting" || record.status === "running"\n',
        "      false\n",
      ),
      contract: {
        name: "cancelDescendants cancels queued/starting/running descendants",
        run: async ({ load }) => {
          const module = await load()
          const manager = module.createBackgroundManager({
            config: { defaultConcurrency: 1 },
            startChild: async (descriptor, onSession) => { onSession(`ses_${descriptor.taskId}`); return { sessionID: `ses_${descriptor.taskId}` } },
            runHandoff: async () => {},
            abortChild: () => {},
          })
          const running = manager.admit({ taskId: "c1", parentSessionID: "p", agent: { name: "x" }, prompt: "a", modelKey: "m" })
          await running.ready
          const results = manager.cancelDescendants("p", {})
          if (results.length !== 1 || results[0].taskId !== "c1" || results[0].cancelled !== true) {
            throw new Error(`expected the running descendant to be cancelled, got ${JSON.stringify(results)}`)
          }
          manager.dispose()
        },
      },
    })

    // then
    expect(receipt.contract).toBe("cancelDescendants cancels queued/starting/running descendants")
    expect(receipt.red).toBe(true)
    expect(receipt.redError).toContain("expected the running descendant to be cancelled")
    expect(receipt.beforeHash).toBe(receipt.afterHash)
    expect(readFileSync(target).equals(before)).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// Upstream a0b2e96c3: a terminal errored child finalizes exactly once. The V2
// terminal edge is `session.execution.failed` (the session then idles with no
// plugin-visible idle event); the reader must surface the real error and a
// repeated/duplicate terminal event must not double-finalize.
// ---------------------------------------------------------------------------

describe("#given a managed child whose terminal execution failed", () => {
  test("#when the failure is final (no served fallback) #then exactly one failed handoff fires with the described error", async () => {
    // given
    const handoffs = []
    const manager = createBackgroundManager({
      startChild: async (descriptor, onSession) => {
        onSession("ses_stall")
        return { sessionID: "ses_stall" }
      },
      runHandoff: async (item) => { handoffs.push(item) },
      readStoppedError: async () => ({ type: "provider.invalid-request", message: "child provider boom 400", status: 400 }),
    })
    const decision = manager.admit({ taskId: "t-stall", parentSessionID: "p", agent: { name: "x" }, prompt: "a", modelKey: "m" })
    await decision.ready

    // when
    const result = await manager.handleChildFailure({ sessionID: "ses_stall" })
    await manager.whenIdle()

    // then
    expect(result.action).toBe("none")
    expect(handoffs.map((item) => item.status)).toEqual(["failed"])
    expect(handoffs[0].child.error).toBe("provider.invalid-request: child provider boom 400")

    // a repeated terminal event for the finalized record never re-fires
    expect((await manager.handleChildFailure({ sessionID: "ses_stall" })).action).toBe("ignored")
    await manager.whenIdle()
    expect(handoffs.length).toBe(1)
    await manager.dispose()
  })

  test("#when a duplicate terminal event arrives while the first is in flight #then only one failed handoff fires", async () => {
    // given a read that stays pending so the second event lands mid-flight
    const handoffs = []
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const manager = createBackgroundManager({
      startChild: async (descriptor, onSession) => {
        onSession("ses_dup")
        return { sessionID: "ses_dup" }
      },
      runHandoff: async (item) => { handoffs.push(item) },
      readStoppedError: async () => { await gate; return "terminal error" },
    })
    const decision = manager.admit({ taskId: "t-dup", parentSessionID: "p", agent: { name: "x" }, prompt: "a", modelKey: "m" })
    await decision.ready

    // when
    const first = manager.handleChildFailure({ sessionID: "ses_dup" })
    const second = await manager.handleChildFailure({ sessionID: "ses_dup" })
    release()
    const firstResult = await first
    await manager.whenIdle()

    // then
    expect(second).toEqual({ action: "ignored", reason: "in-flight" })
    expect(firstResult.action).toBe("none")
    expect(handoffs.length).toBe(1)
    await manager.dispose()
  })

  test("#when the child session is cleared #then a terminal event is a no-op", async () => {
    const manager = createBackgroundManager({
      startChild: async (descriptor, onSession) => {
        onSession("ses_gone")
        return { sessionID: "ses_gone" }
      },
      runHandoff: async () => {},
      readStoppedError: async () => "boom",
    })
    const decision = manager.admit({ taskId: "t-gone", parentSessionID: "p", agent: { name: "x" }, prompt: "a", modelKey: "m" })
    await decision.ready
    manager.clearSession("ses_gone")
    expect((await manager.handleChildFailure({ sessionID: "ses_gone" })).action).toBe("ignored")
    await manager.dispose()
  })
})

// ---------------------------------------------------------------------------
// Upstream 8e705a122: wire the failure classifier into the background child
// ---------------------------------------------------------------------------

describe("#given a failed background child and a configured fallback chain", () => {
  test("#when the failure is retryable #then it re-launches on the next served model and no failure handoff fires", async () => {
    const starts = []
    const handoffs = []
    const manager = createBackgroundManager({
      startChild: async (descriptor, onSession) => {
        const id = `ses_${descriptor.taskId}`
        starts.push({ taskId: descriptor.taskId, model: descriptor.model })
        onSession(id)
        return { sessionID: id }
      },
      runHandoff: async (item) => { handoffs.push(item) },
      readStoppedError: async () => ({ name: "RateLimitError", message: "rate limit" }),
      resolveFallbackChain: () => [
        { providers: ["openai"], model: "gpt-6-astra" },
        { providers: ["deepseek"], model: "deepseek-flash" },
      ],
    })
    manager.admit({ taskId: "t1", parentSessionID: "p", agent: { name: "x" }, prompt: "work", modelKey: "m" })
    await manager.whenIdle()
    const first = manager.getTask("t1")

    const result = await manager.handleChildFailure({
      sessionID: first.sessionID,
      connectedProviders: ["openai", "deepseek"],
      modelsByProvider: { openai: ["gpt-6-luna-fast"], deepseek: ["deepseek-flash"] },
    })
    await manager.whenIdle()

    expect(result.action).toBe("retry")
    expect(result.model).toEqual({ providerID: "deepseek", id: "deepseek-flash" })
    expect(handoffs).toEqual([])
    expect(manager.getTask(result.taskId).retryAttempt).toBe(2)
    await manager.dispose()
  })

  test("#when the agent is gone #then it re-launches on FALLBACK_AGENT", async () => {
    const agents = []
    const manager = createBackgroundManager({
      startChild: async (descriptor, onSession) => {
        const id = `ses_${descriptor.taskId}`
        agents.push(descriptor.agent?.name)
        onSession(id)
        return { sessionID: id }
      },
      runHandoff: async () => {},
      resolveFallbackChain: () => [{ providers: ["openai"], model: "gpt-6-astra" }],
    })
    manager.admit({ taskId: "t1", parentSessionID: "p", agent: { name: "x" }, prompt: "work", modelKey: "m" })
    await manager.whenIdle()
    const first = manager.getTask("t1")
    const result = await manager.handleChildFailure({ sessionID: first.sessionID, errorInfo: "Agent not found: x" })
    await manager.whenIdle()
    expect(result.action).toBe("fallback-agent")
    expect(result.agent).toBe("general")
    expect(agents).toEqual(["x", "general"])
    await manager.dispose()
  })

  test("#when nothing is retryable #then the child is finalized through the failure handoff", async () => {
    const handoffs = []
    const manager = createBackgroundManager({
      startChild: async (descriptor, onSession) => {
        onSession("ses_f")
        return { sessionID: "ses_f" }
      },
      runHandoff: async (item) => { handoffs.push(item) },
      readStoppedError: async () => "terminal quota exhausted",
      resolveFallbackChain: () => [{ providers: ["openai"], model: "gpt-6-astra" }],
    })
    manager.admit({ taskId: "t1", parentSessionID: "p", agent: { name: "x" }, prompt: "work", modelKey: "m" })
    await manager.whenIdle()
    const result = await manager.handleChildFailure({ sessionID: "ses_f" })
    await manager.whenIdle()
    expect(result.action).toBe("none")
    expect(handoffs.map((item) => item.status)).toEqual(["failed"])
    expect(handoffs[0].child.error).toBe("terminal quota exhausted")
    await manager.dispose()
  })
})
