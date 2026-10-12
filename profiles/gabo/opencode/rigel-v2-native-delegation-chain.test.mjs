/**
 * Delegated-child START-MODEL contract for the named-agent (`subagent_type`)
 * route.
 *
 * PR #20 seeded a single per-agent `model` into the live `~/.omo/omo.jsonc` and
 * resolved it JSON-only, so a child was created pinned to that first model even
 * when its provider was not available in the host's inventory. On a host with no
 * authenticated integrations the child then ran with 0 tokens and failed, and
 * the reactive fallback never fired because the JSON carried no ordered chain.
 *
 * The fixed contract: a delegated child is created on the first reachable rung
 * of the agent's JSON ordered chain (`agents.<id>.model` + `.fallback_models`),
 * resolved against the live inventory. ONLY an absent or deliberately empty
 * agent entry inherits the OpenCode global; a configured but exhausted chain
 * keeps its head and fails as configured. The manifest is never consulted for
 * models. These run the real `plugin.setup` path with a disposable HOME so the
 * live override read is exercised end to end.
 */
import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import plugin from "./rigel-v2-native.mjs"

const realHome = process.env.HOME
let sandbox
let sandboxHome

beforeAll(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-delegation-chain-"))
  sandboxHome = path.join(sandbox, "home")
  fs.mkdirSync(sandboxHome, { recursive: true, mode: 0o700 })
  // The runtime reads the live `~/.omo/omo.jsonc`, so the whole file pins HOME
  // to the disposable sandbox.
  process.env.HOME = sandboxHome
})

afterAll(() => {
  process.env.HOME = realHome
  fs.rmSync(sandbox, { recursive: true, force: true })
})

function writeLiveConfig(agents) {
  const directory = path.join(sandboxHome, ".omo")
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(directory, "omo.jsonc"), `${JSON.stringify({ agents }, null, 2)}\n`, { mode: 0o600 })
}

// Deterministic event feed: the generator blocks until an event is pushed and
// signals consumption only AFTER the runtime finished handling it, so the test
// synchronizes on the loop advancing instead of a sleep. The abort signal ends
// the generator so `dispose()` never hangs.
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

/**
 * A minimal V2 setup context that records every `session.create` input and every
 * `session.switchModel` call. The inventory is the live model list the runtime
 * resolves the JSON chain against; `feed` lets a test drive a child failure.
 */
function delegationHarness(inventory, feed = createEventFeed()) {
  let definition
  const created = []
  const switched = []
  const context = {
    location: { directory: "/native-v2" },
    agent: {
      list: async () => ({ data: [{ id: "explore", name: "explore", mode: "subagent" }] }),
      transform: async () => ({ dispose() {} }),
      reload: async () => {},
    },
    model: { list: async () => ({ data: inventory }) },
    event: { subscribe: feed.subscribe },
    session: {
      hook: async () => ({ dispose() {} }),
      create: async (input) => { created.push(input); return { data: { id: "ses_child" } } },
      prompt: async () => ({ data: {} }),
      wait: async () => {},
      context: async () => [{ type: "assistant", content: [{ type: "text", text: "done" }] }],
      switchModel: async (input) => { switched.push(input); return { data: {} } },
    },
    tool: { transform: async (callback) => {
      callback({ add: (value) => { if (value?.name === "rigel_task") definition = value } })
      return { dispose() {} }
    } },
  }
  return { created, switched, feed, context, get definition() { return definition } }
}

// A head whose provider is NOT in the inventory. When a rung of the JSON chain
// IS available, the child must start there instead of on the unavailable head.
const KIMI_HEAD = { model: "kimi-for-coding/kimi-for-coding-highspeed", variant: "off" }
const OPENAI_FALLBACK = { providers: ["openai"], model: "gpt-6-luna-fast", variant: "low" }
const OPENAI_ROW = { providerID: "openai", id: "gpt-6-luna-fast", enabled: true }
// The host's only available provider, standing in for NLS1's global big-pickle.
const GLOBAL_ROW = { providerID: "opencode", id: "big-pickle", enabled: true }

test("a named-agent child starts on the first reachable JSON chain rung, not the unavailable head", async () => {
  writeLiveConfig({ explore: { ...KIMI_HEAD, fallback_models: [OPENAI_FALLBACK] } })
  const harness = delegationHarness([OPENAI_ROW])
  const dispose = await plugin.setup(harness.context)
  await harness.definition.execute({ subagent_type: "explore", prompt: "Work." }, { sessionID: "ses_parent" })

  expect(harness.created[0].model).toEqual({ providerID: "openai", id: "gpt-6-luna-fast", variant: "low" })
  await dispose()
})

test("a background named-agent child starts on the first reachable JSON chain rung", async () => {
  writeLiveConfig({ explore: { ...KIMI_HEAD, fallback_models: [OPENAI_FALLBACK] } })
  const harness = delegationHarness([OPENAI_ROW])
  const dispose = await plugin.setup(harness.context)
  await harness.definition.execute({ subagent_type: "explore", prompt: "Work.", run_in_background: true }, { sessionID: "ses_parent" })

  expect(harness.created[0].model).toEqual({ providerID: "openai", id: "gpt-6-luna-fast", variant: "low" })
  await dispose()
})

// Contract (negative): an EXHAUSTED explicit chain must NOT create a child on
// the global. The head's provider is absent from the inventory AND there is no
// reachable fallback, yet the child is created on the configured head so it fails
// AS CONFIGURED - it never silently runs on the OpenCode global.
test("an exhausted explicit chain does not create a child on the global; it keeps the configured head", async () => {
  writeLiveConfig({ explore: { ...KIMI_HEAD } })
  const harness = delegationHarness([GLOBAL_ROW])
  const dispose = await plugin.setup(harness.context)
  await harness.definition.execute({ subagent_type: "explore", prompt: "Work." }, { sessionID: "ses_parent" })

  expect(harness.created[0].model).toEqual({ providerID: "kimi-for-coding", id: "kimi-for-coding-highspeed", variant: "off" })
  expect(harness.created[0].model.id).not.toBe(GLOBAL_ROW.id)
  await dispose()
})

test("a background child on an exhausted explicit chain keeps the configured head (never the global)", async () => {
  writeLiveConfig({ explore: { ...KIMI_HEAD } })
  const harness = delegationHarness([GLOBAL_ROW])
  const dispose = await plugin.setup(harness.context)
  await harness.definition.execute({ subagent_type: "explore", prompt: "Work.", run_in_background: true }, { sessionID: "ses_parent" })

  expect(harness.created[0].model).toEqual({ providerID: "kimi-for-coding", id: "kimi-for-coding-highspeed", variant: "off" })
  await dispose()
})

test("a named-agent child with no JSON override inherits the global", async () => {
  writeLiveConfig({})
  const harness = delegationHarness([GLOBAL_ROW])
  const dispose = await plugin.setup(harness.context)
  await harness.definition.execute({ subagent_type: "explore", prompt: "Work." }, { sessionID: "ses_parent" })

  expect(Object.prototype.hasOwnProperty.call(harness.created[0], "model")).toBe(false)
  await dispose()
})

test("a named-agent child keeps an available pinned head", async () => {
  writeLiveConfig({ explore: { ...KIMI_HEAD, fallback_models: [OPENAI_FALLBACK] } })
  const harness = delegationHarness([
    { providerID: "kimi-for-coding", id: "kimi-for-coding-highspeed", enabled: true },
    OPENAI_ROW,
  ])
  const dispose = await plugin.setup(harness.context)
  await harness.definition.execute({ subagent_type: "explore", prompt: "Work." }, { sessionID: "ses_parent" })

  expect(harness.created[0].model).toEqual({ providerID: "kimi-for-coding", id: "kimi-for-coding-highspeed", variant: "off" })
  await dispose()
})

// MUTANT with a decoy manifest chain. The JSON is empty, but the runtime's REAL
// manifest still carries the canonical `explore` chain AND the inventory even
// SERVES that canonical head (kimi-for-coding-highspeed). If the runtime ever
// consulted the manifest record `chain` / `agentChain("explore")`, a child
// failure would seed that chain and `switchModel` onto the canonical rung. The
// JSON-only contract: the child is created WITHOUT a Model.Ref and no
// `switchModel` call is ever made.
test("empty JSON: no Model.Ref reaches session.create and switchModel is never called (decoy canonical chain ignored)", async () => {
  writeLiveConfig({})
  const harness = delegationHarness([
    { providerID: "kimi-for-coding", id: "kimi-for-coding-highspeed", enabled: true },
    GLOBAL_ROW,
  ])
  const dispose = await plugin.setup(harness.context)
  await harness.definition.execute({ subagent_type: "explore", prompt: "Work." }, { sessionID: "ses_parent" })

  expect(Object.prototype.hasOwnProperty.call(harness.created[0], "model")).toBe(false)

  const consumed = harness.feed.consumed()
  harness.feed.push({ type: "session.execution.failed", data: { sessionID: "ses_child" } })
  await Promise.race([consumed, new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000))])
  expect(harness.switched).toEqual([])
  await dispose()
})

// Control: the plugin reads `~/.omo/omo.jsonc` ONCE at setup, so an edit made
// after setup is NOT observed by the running process. The supported way to apply
// a change is a restart - the exact behavior `/rmo-models` must warn about. This
// is the real read path over a real file rewrite, not a mock.
test("control: an edit after setup is NOT observed until restart (no live reload)", async () => {
  writeLiveConfig({ explore: { model: "opencode/ling-3.1-flash-free" } })
  const harness = delegationHarness([
    { providerID: "opencode", id: "ling-3.1-flash-free", enabled: true },
    GLOBAL_ROW,
  ])
  const dispose = await plugin.setup(harness.context)

  // The user edits the JSON to a different model WITHOUT restarting.
  writeLiveConfig({ explore: { model: "opencode/nemotron-3-ultra-free" } })
  await harness.definition.execute({ subagent_type: "explore", prompt: "Work." }, { sessionID: "ses_parent" })

  // The running process still sees the setup-time model.
  expect(harness.created[0].model).toEqual({ providerID: "opencode", id: "ling-3.1-flash-free" })
  await dispose()
})
