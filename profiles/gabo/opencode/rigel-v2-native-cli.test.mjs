/**
 * Contract for the composed companion CLI plugin (`./tui`).
 *
 * The individual surfaces own their own behavior tests. This guards the
 * composition boundary: one `{ id, setup }` definition composes every surface,
 * a surface that throws during setup is isolated, the aggregate returns a single
 * disposer, and a headless host degrades to a safe no-op instead of failing.
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { CLI_PLUGIN_ID, createCompanionCliPlugin, readDefaultModel } from "./rigel-v2-native-cli.mjs"

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
    // Legacy notice and task toast each subscribe at least one event.
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

  test("#given an opencode.json whose $schema URL contains // plus a // comment line #then the inherited default model resolves", () => {
    const home = mkdtempSync(join(tmpdir(), "rigel-default-model-"))
    try {
      mkdirSync(join(home, ".config", "opencode"), { recursive: true })
      writeFileSync(
        join(home, ".config", "opencode", "opencode.json"),
        [
          "{",
          '  "$schema": "https://opencode.ai/config.json",',
          "  // the model Judge inherits because it is not an omo.jsonc agent",
          '  "model": "opencode-go/deepseek-v4.1-flash"',
          "}",
          "",
        ].join("\n"),
      )

      expect(readDefaultModel({ home, env: {} })).toBe("opencode-go/deepseek-v4.1-flash")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("#given XDG_CONFIG_HOME #when the default model is read #then it resolves from $XDG_CONFIG_HOME/opencode", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "rigel-xdg-default-model-"))
    try {
      const configHome = join(sandbox, "config")
      mkdirSync(join(configHome, "opencode"), { recursive: true })
      writeFileSync(join(configHome, "opencode", "opencode.json"), JSON.stringify({ model: "opencode-go/xdg-default" }, null, 2))

      expect(readDefaultModel({ home: join(sandbox, "home"), env: { XDG_CONFIG_HOME: configHome } })).toBe(
        "opencode-go/xdg-default",
      )
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test("#given no XDG_CONFIG_HOME #when the default model is read #then the home config directory still resolves", () => {
    const home = mkdtempSync(join(tmpdir(), "rigel-home-default-model-"))
    try {
      mkdirSync(join(home, ".config", "opencode"), { recursive: true })
      writeFileSync(
        join(home, ".config", "opencode", "opencode.jsonc"),
        JSON.stringify({ model: "opencode-go/home-default" }, null, 2),
      )

      expect(readDefaultModel({ home, env: {} })).toBe("opencode-go/home-default")
      expect(readDefaultModel({ home, env: { XDG_CONFIG_HOME: "  " } })).toBe("opencode-go/home-default")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
