/**
 * Live `default_mode.ultrawork` startup consumption.
 *
 * `resolveNativeDefaultUltrawork` (owned by
 * `rigel-v2-native-default-mode-ultrawork.test.mjs`) reads the live
 * `~/.omo/omo.jsonc`, but a resolver nothing calls at startup changes nothing.
 * These cases pin the real boundary: `plugin.setup` runs the live read and
 * forwards its report, so a declaration the chain could not confirm is visible in
 * startup stderr and a declared/absent `false` produces nothing. The assertion is
 * the diagnostic, never prompt text: the default-mode body is staged at install
 * time and is absent from a source checkout, so any content assertion here would
 * be vacuous.
 *
 * The default-vs-explicit activation split is owned by
 * `rigel-v2-keyword-core.test.mjs` (pure decision) and
 * `rigel-v2-native-prompt.test.mjs` (the seam).
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "./rigel-v2-native.mjs"

// The runtime reads the LIVE `~/.omo/omo.jsonc` at plugin setup, so every case
// below drives a disposable HOME/XDG tree. `XDG_STATE_HOME` is sandboxed too:
// setup writes durable receipts under it, and the real user state root must
// never be touched by a test.
async function withLiveOmoConfig(config, run) {
  const sandbox = mkdtempSync(join(tmpdir(), "rigel-default-mode-ultrawork-"))
  const home = join(sandbox, "home")
  mkdirSync(join(home, ".omo"), { recursive: true })
  writeFileSync(join(home, ".omo", "omo.jsonc"), `${JSON.stringify(config, null, 2)}\n`)
  const previous = {
    HOME: process.env.HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  }
  process.env.HOME = home
  process.env.XDG_STATE_HOME = join(sandbox, "state")
  process.env.XDG_CONFIG_HOME = join(sandbox, "config")
  process.env.XDG_DATA_HOME = join(sandbox, "data")
  process.env.XDG_CACHE_HOME = join(sandbox, "cache")
  try {
    return await run({ sandbox, home })
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(sandbox, { recursive: true, force: true })
  }
}

function setupHarness() {
  const context = {
    location: { directory: "/native-v2" },
    agent: {
      list: async () => ({ data: [{ id: "explore", name: "Explore", mode: "subagent", hidden: false }] }),
      transform: async (callback) => {
        callback({ update() {}, default() {} })
        return { dispose() {} }
      },
      reload: async () => {},
    },
    model: { list: async () => ({ data: [] }) },
    session: {
      hook: async () => ({ dispose() {} }),
      create: async () => ({ data: { id: "ses_native" } }),
      prompt: async () => ({ data: {} }),
    },
    tool: {
      hook: async () => ({ dispose() {} }),
      transform: async (callback) => {
        callback({ add() {}, get: () => undefined })
        return { dispose() {} }
      },
    },
  }
  return { context }
}

/**
 * Run the real `plugin.setup` and report what it logged. This is the only
 * startup-visible consequence of the live read: `resolveNativeDefaultUltrawork`
 * reports every declaration it could not confirm, and setup forwards those lines.
 */
async function setupLog(config) {
  return withLiveOmoConfig(config, async () => {
    const harness = setupHarness()
    const logged = []
    const originalError = console.error
    console.error = (line) => logged.push(String(line))
    let dispose
    try {
      dispose = await plugin.setup(harness.context)
    } finally {
      console.error = originalError
    }
    await dispose()
    return logged.filter((line) => line.includes("Native V2 default mode:"))
  })
}

test("#given the live default-mode declaration cannot be confirmed #when the runtime sets up #then setup reports the fail-closed read", async () => {
  // given / when
  const logged = await setupLog({ "[opencode]": { default_mode: "on" } })
  // then: this line can only exist because setup resolved the switch at startup
  expect(logged).toHaveLength(1)
  expect(logged[0]).toContain("Ultrawork stays off (fail-closed)")
})

test("#given the live config declares the switch false or not at all #when the runtime sets up #then setup reports nothing", async () => {
  // given / when
  const declaredFalse = await setupLog({ "[opencode]": { default_mode: { goal: false, ultrawork: false } } })
  const absent = await setupLog({ "[opencode]": { hashline_edit: false } })
  // then
  expect(declaredFalse).toEqual([])
  expect(absent).toEqual([])
})
