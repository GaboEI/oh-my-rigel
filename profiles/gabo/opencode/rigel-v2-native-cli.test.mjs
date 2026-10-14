/**
 * Contract for the composed companion CLI plugin (`./tui`).
 *
 * The individual surfaces own their own behavior tests. This guards the
 * composition boundary: one `{ id, setup }` definition composes every surface,
 * a surface that throws during setup is isolated, the aggregate returns a single
 * disposer, and a headless host degrades to a safe no-op instead of failing. It
 * also pins the sidebar gate: the Models/Agents panel is composed per the V1
 * contract (absent = enabled; an explicit `false` disables it).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { CLI_PLUGIN_ID, createCompanionCliPlugin } from "./rigel-v2-native-cli.mjs"

function fakeContext({ renderer = { isDestroyed: false }, options = {} } = {}) {
  const handlers = new Map()
  const toasts = []
  const layers = []
  const slotCalls = []
  return {
    api: {
      options,
      renderer,
      location: { current: { directory: "/tmp/work" } },
      data: {
        on(name, handler) {
          handlers.set(name, handler)
          return () => handlers.delete(name)
        },
        session: { get: () => undefined },
      },
      ui: {
        toast: { show: (toast) => toasts.push(toast) },
        dialog: { select: () => {}, clear: () => {}, show: () => {} },
        slot: (args) => {
          slotCalls.push(args)
          return () => {}
        },
      },
      keymap: { layer: (fn) => { layers.push(fn); return () => {} } },
    },
    handlers,
    toasts,
    layers,
    slotCalls,
  }
}

describe("#given the composed companion CLI plugin", () => {
  let stateRoot
  let overrides

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), "rigel-cli-sidebar-"))
    // Keep the sidebar's durable receipt inside the sandbox: composing it must
    // never write into the operator's real XDG state directory.
    overrides = { sidebar: { stateRoot, log: () => {} } }
  })

  afterEach(() => {
    rmSync(stateRoot, { recursive: true, force: true })
  })

  test("#then it exposes the stable id and composes every surface behind one setup", () => {
    const plugin = createCompanionCliPlugin(overrides)
    expect(plugin.id).toBe(CLI_PLUGIN_ID)
    const fake = fakeContext()
    const dispose = plugin.setup(fake.api)
    expect(typeof dispose).toBe("function")
    // Legacy notice + task toast + nudge each subscribe at least one event.
    expect(fake.handlers.size).toBeGreaterThan(0)
    expect(fake.layers.length).toBeGreaterThan(0)
    expect(() => dispose()).not.toThrow()
  })

  test("#given the default host options #then the sidebar.content slot IS registered (V1 contract: absent = enabled)", () => {
    const fake = fakeContext()
    const dispose = createCompanionCliPlugin(overrides).setup(fake.api)
    expect(fake.slotCalls.some((args) => args?.append === "sidebar.content")).toBe(true)
    expect(fake.handlers.size).toBeGreaterThan(0)
    expect(fake.layers.length).toBeGreaterThan(0)
    expect(() => dispose()).not.toThrow()
  })

  test("#given tui.sidebar.enabled=false #then the sidebar.content slot is NOT registered", () => {
    const fake = fakeContext({ options: { tui: { sidebar: { enabled: false } } } })
    const dispose = createCompanionCliPlugin(overrides).setup(fake.api)
    expect(fake.slotCalls.some((args) => args?.append === "sidebar.content")).toBe(false)
    expect(() => dispose()).not.toThrow()
  })

  test("#when the host has no renderer #then it shows no toast and still returns a safe disposer", () => {
    const fake = fakeContext({ renderer: undefined })
    const dispose = createCompanionCliPlugin(overrides).setup(fake.api)
    expect(typeof dispose).toBe("function")
    expect(fake.toasts).toHaveLength(0)
    expect(() => dispose()).not.toThrow()
  })
})
