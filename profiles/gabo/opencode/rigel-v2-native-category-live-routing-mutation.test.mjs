/**
 * Named-RED mutation tests for the category JSON routing seam
 * (fix/v2-category-json-routing).
 *
 * The seam is exactly two touch points, so the mutation coverage is exactly two
 * contracts:
 *   1. `rigel-v2-native-config.mjs` `readLiveAgentOverridesSource` exposes the
 *      live `categories` block on the loaded source;
 *   2. `rigel-v2-native.mjs` sources `userCategories` from that live block.
 * Each mutation must turn its NAMED contract RED while the same contract is
 * GREEN pre-mutation, and the harness restores the bytes sha256-identically.
 */
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runMutation } from "./test-support/mutation-harness.mjs"

const OPENCODE_DIR = import.meta.dir
const CONFIG_FILE = join(OPENCODE_DIR, "rigel-v2-native-config.mjs")
const RUNTIME_FILE = join(OPENCODE_DIR, "rigel-v2-native.mjs")

const created = []

function makeHome(config) {
  const sandbox = mkdtempSync(join(tmpdir(), "rigel-mutation-category-"))
  const home = join(sandbox, "home")
  mkdirSync(join(home, ".omo"), { recursive: true })
  if (config !== undefined) writeFileSync(join(home, ".omo", "omo.jsonc"), `${JSON.stringify(config, null, 2)}\n`)
  created.push(sandbox)
  return home
}

afterEach(() => {
  while (created.length > 0) rmSync(created.pop(), { recursive: true, force: true })
})

// Deterministic, abort-bounded event feed (same contract as the runtime suite).
function createEventFeed() {
  const queue = []
  let notify
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
      }
    },
  }
  return { events, subscribe: ({ signal } = {}) => { abortSignal = signal; return events }, push() {} }
}

function harnessContext() {
  const feed = createEventFeed()
  const sessions = []
  let definition
  const context = {
    location: { directory: "/native-v2" },
    agent: {
      list: async () => ({ data: [{ id: "Sisyphus-Junior", name: "Sisyphus-Junior", mode: "subagent" }] }),
      transform: async () => ({ dispose() {} }),
      reload: async () => {},
    },
    model: { list: async () => ({ data: [
      { providerID: "xiaomi", id: "mimo-v2.6-pro", enabled: true },
      { providerID: "openai", id: "gpt-6-luna-fast", enabled: true },
    ] }) },
    event: { subscribe: feed.subscribe },
    session: {
      hook: async () => ({ dispose() {} }),
      create: async (input) => { sessions.push(input); return { data: { id: "ses_child" } } },
      prompt: async () => ({ data: {} }),
      wait: async () => {},
      context: async () => [{ type: "assistant", content: [{ type: "text", text: "done" }] }],
    },
    tool: { transform: async (callback) => {
      callback({ add: (value) => { if (value?.name === "rigel_task") definition = value }, get: () => definition })
      return { dispose() {} }
    } },
  }
  return { sessions, get definition() { return definition }, context }
}

// (1) The config source must carry the live `categories` block.
const sourceCarriesLiveCategories = {
  name: "readLiveAgentOverridesSource carries the live ~/.omo/omo.jsonc categories",
  run: async ({ load }) => {
    const module = await load()
    const home = makeHome({ categories: { quick: { model: "xiaomi/mimo-v2.6-pro" } } })
    const source = module.readLiveAgentOverridesSource({ home, env: { HOME: home, USERPROFILE: home } })
    if (source.state !== "loaded") throw new Error(`expected state loaded, got ${source.state}`)
    if (source.categories?.quick?.model !== "xiaomi/mimo-v2.6-pro") {
      throw new Error(`expected the live categories block to be carried, got ${JSON.stringify(source.categories)}`)
    }
  },
}

// (2) The runtime must source category delegation from that live block.
const runtimeConsumesLiveCategories = {
  name: "runtime sources category delegation from the live ~/.omo/omo.jsonc categories",
  run: async ({ load }) => {
    const module = await load()
    const home = makeHome({ categories: { quick: { model: "xiaomi/mimo-v2.6-pro" } } })
    const previousHome = process.env.HOME
    process.env.HOME = home
    try {
      const harness = harnessContext()
      const dispose = await module.default.setup(harness.context)
      await harness.definition.execute({ category: "quick", prompt: "Work." }, { sessionID: "ses_parent" })
      const model = harness.sessions[0]?.model
      if (model?.providerID !== "xiaomi" || model?.id !== "mimo-v2.6-pro") {
        throw new Error(`expected the live-pinned child model xiaomi/mimo-v2.6-pro, got ${JSON.stringify(model)}`)
      }
      await dispose()
    } finally {
      process.env.HOME = previousHome
    }
  },
}

test("mutation: dropping the live categories field turns the config contract red", async () => {
  const before = readFileSync(CONFIG_FILE)
  const receipt = await runMutation({
    file: CONFIG_FILE,
    mutate: (source) => source.replace(", categories: view?.categories }", " }"),
    contract: sourceCarriesLiveCategories,
  })
  expect(receipt.contract).toBe(sourceCarriesLiveCategories.name)
  expect(receipt.red).toBe(true)
  expect(receipt.redError).toContain("expected the live categories block to be carried")
  expect(receipt.beforeHash).toBe(receipt.afterHash)
  expect(readFileSync(CONFIG_FILE).equals(before)).toBe(true)
})

test("mutation: dropping the live categories fallback turns the runtime contract red", async () => {
  const before = readFileSync(RUNTIME_FILE)
  const receipt = await runMutation({
    file: RUNTIME_FILE,
    mutate: (source) =>
      source.replace(
        `    const userCategories = readUserCategories(context)
      ?? (liveOverridesSource.state === "loaded" ? liveOverridesSource.categories : undefined)
`,
        `    const userCategories = readUserCategories(context)
`,
      ),
    contract: runtimeConsumesLiveCategories,
  })
  expect(receipt.contract).toBe(runtimeConsumesLiveCategories.name)
  expect(receipt.red).toBe(true)
  expect(receipt.redError).toContain("expected the live-pinned child model")
  expect(receipt.beforeHash).toBe(receipt.afterHash)
  expect(readFileSync(RUNTIME_FILE).equals(before)).toBe(true)
})
