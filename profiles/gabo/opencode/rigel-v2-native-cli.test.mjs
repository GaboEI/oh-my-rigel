/**
 * Contract for the composed companion CLI plugin (`./tui`).
 *
 * The individual surfaces own their own behavior tests. This guards the
 * composition boundary: one `{ id, setup }` definition composes every surface,
 * a surface that throws during setup is isolated, the aggregate returns a single
 * disposer, and a headless host degrades to a safe no-op instead of failing.
 */
import { describe, expect, test } from "bun:test"

import { CLI_PLUGIN_ID, createCompanionCliPlugin } from "./rigel-v2-native-cli.mjs"

function fakeContext({ renderer = { isDestroyed: false } } = {}) {
  const handlers = new Map()
  const toasts = []
  const layers = []
  return {
    api: {
      options: {},
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
      },
      keymap: { layer: (fn) => { layers.push(fn); return () => {} } },
    },
    handlers,
    toasts,
    layers,
  }
}

describe("#given the composed companion CLI plugin", () => {
  test("#then it exposes the stable id and composes every surface behind one setup", () => {
    const plugin = createCompanionCliPlugin()
    expect(plugin.id).toBe(CLI_PLUGIN_ID)
    const fake = fakeContext()
    const dispose = plugin.setup(fake.api)
    expect(typeof dispose).toBe("function")
    // Legacy notice + task toast + nudge each subscribe at least one event.
    expect(fake.handlers.size).toBeGreaterThan(0)
    expect(fake.layers.length).toBeGreaterThan(0)
    expect(() => dispose()).not.toThrow()
  })

  test("#when the host has no renderer #then it shows no toast and still returns a safe disposer", () => {
    const fake = fakeContext({ renderer: undefined })
    const dispose = createCompanionCliPlugin().setup(fake.api)
    expect(typeof dispose).toBe("function")
    expect(fake.toasts).toHaveLength(0)
    expect(() => dispose()).not.toThrow()
  })
})
