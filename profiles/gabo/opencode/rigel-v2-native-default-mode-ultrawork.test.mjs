/**
 * Live `default_mode.ultrawork` resolver contract.
 *
 * `default_mode.ultrawork` is OmO's documented "start every conversation in
 * Ultrawork" setting. The install-time bake pins `modes.defaultUltrawork` false
 * (the manifest must never arm the mode on its own) and nothing re-read the live
 * `~/.omo/omo.jsonc` value, so the documented switch could not be turned on
 * without patching the runtime. `resolveNativeDefaultUltrawork` is that live
 * read: `true` only for a declared `true`, and OFF (reported, never silent) on an
 * absent, malformed, or unreadable declaration.
 *
 * The startup consumption of this value is owned by
 * `rigel-v2-native-default-mode-ultrawork-setup.test.mjs`; the
 * default-vs-explicit activation split is owned by `rigel-v2-keyword-core.test.mjs`
 * (pure decision) and `rigel-v2-native-prompt.test.mjs` (the seam).
 */
import { describe, expect, test } from "bun:test"
import { join, resolve as resolvePath } from "node:path"

import { resolveNativeDefaultUltrawork } from "./rigel-v2-native-config.mjs"

// The chain is resolved with the host `path` rules, so the fixture keys are built
// with the same `join` the resolver uses (a hard-coded POSIX prefix never matches
// on Windows).
const HOME = resolvePath("/home/rigeltest")
const PROJECT = join(HOME, "proj")
const USER_CONFIG = join(HOME, ".omo", "omo.jsonc")
const PROJECT_CONFIG = join(PROJECT, ".omo", "omo.jsonc")

function memoryFileSystem(files) {
  const entries = new Map(Object.entries(files))
  return {
    existsSync: (path) => entries.has(path),
    lstatSync: () => ({ isSymbolicLink: () => false }),
    readFileSync: (path) => {
      const value = entries.get(path)
      if (value === undefined) throw new Error(`ENOENT: ${path}`)
      return value
    },
    realpathSync: (path) => path,
  }
}

const UNREADABLE = {
  existsSync: () => {
    throw new Error("EACCES: cannot resolve the config chain")
  },
  lstatSync: () => ({ isSymbolicLink: () => false }),
  readFileSync: () => {
    throw new Error("EACCES")
  },
  realpathSync: (path) => path,
}

function declaring(block, path = PROJECT_CONFIG) {
  return memoryFileSystem({ [path]: JSON.stringify({ "[opencode]": block }) })
}

function resolveLive(fileSystem, env = { HOME }) {
  return resolveNativeDefaultUltrawork({ directory: PROJECT, env, fileSystem })
}

describe("#given the live profile block declares the default-mode switch", () => {
  test("#when ultrawork is true #then the switch resolves on through the [opencode] placement", () => {
    // given
    const fileSystem = declaring({ default_mode: { goal: false, ultrawork: true } })
    // when
    const resolution = resolveLive(fileSystem)
    // then
    expect(resolution.enabled).toBe(true)
    expect(resolution.state).toBe("declared")
    expect(resolution.diagnostics).toEqual([])
  })

  test("#when the selected profile declares it #then that placement is honored too", () => {
    // given: the shipped shape - `profiles.<p>.[opencode].default_mode`
    const fileSystem = memoryFileSystem({
      [USER_CONFIG]: JSON.stringify({
        profiles: { gabo: { "[opencode]": { default_mode: { goal: false, ultrawork: true } } } },
      }),
    })
    // when
    const resolution = resolveLive(fileSystem, { HOME, OMO_PROFILE: "gabo" })
    // then
    expect(resolution.enabled).toBe(true)
  })

  test("#when a nearer layer declares false #then the switch resolves off", () => {
    // given: the user layer turns it on, the project layer overrides it
    const fileSystem = memoryFileSystem({
      [USER_CONFIG]: JSON.stringify({ "[opencode]": { default_mode: { ultrawork: true } } }),
      [PROJECT_CONFIG]: JSON.stringify({ "[opencode]": { default_mode: { ultrawork: false } } }),
    })
    // when
    const resolution = resolveLive(fileSystem)
    // then
    expect(resolution.enabled).toBe(false)
    expect(resolution.state).toBe("declared")
  })
})

describe("#given the live chain does not declare the switch", () => {
  test("#when no config file exists #then the switch stays off and nothing is reported", () => {
    // given / when
    const resolution = resolveLive(memoryFileSystem({}))
    // then: the baked manifest pins it off, and absence must not revive it
    expect(resolution.enabled).toBe(false)
    expect(resolution.state).toBe("undeclared")
    expect(resolution.diagnostics).toEqual([])
  })

  test("#when the block declares only goal #then ultrawork keeps its documented false", () => {
    // given: a block that opts into the goal default mode only
    const fileSystem = declaring({ default_mode: { goal: true } })
    // when
    const resolution = resolveLive(fileSystem)
    // then
    expect(resolution.enabled).toBe(false)
    expect(resolution.diagnostics).toEqual([])
  })

  test("#when a layer declares it false #then the switch is off", () => {
    // given / when
    const resolution = resolveLive(declaring({ default_mode: { ultrawork: false } }))
    // then
    expect(resolution.enabled).toBe(false)
  })
})

describe("#given the live declaration cannot be confirmed", () => {
  test("#when the block is not an object #then the switch fails closed and says so", () => {
    // given
    const fileSystem = declaring({ default_mode: "on" })
    // when
    const resolution = resolveLive(fileSystem)
    // then
    expect(resolution.enabled).toBe(false)
    expect(resolution.diagnostics.some((line) => line.includes("fail-closed"))).toBe(true)
  })

  test("#when the authored boolean is not a boolean #then the switch fails closed", () => {
    // given
    const fileSystem = declaring({ default_mode: { ultrawork: "yes" } })
    // when
    const resolution = resolveLive(fileSystem)
    // then
    expect(resolution.enabled).toBe(false)
    expect(resolution.diagnostics.some((line) => line.includes("fail-closed"))).toBe(true)
  })

  test("#when a layer cannot be parsed #then the switch fails closed instead of guessing", () => {
    // given: the file may have enabled it, so the runtime cannot confirm the value
    const fileSystem = memoryFileSystem({ [PROJECT_CONFIG]: `{ "[opencode]": {` })
    // when
    const resolution = resolveLive(fileSystem)
    // then
    expect(resolution.enabled).toBe(false)
    expect(resolution.diagnostics.some((line) => line.includes("fail-closed"))).toBe(true)
  })

  test("#when the chain cannot be resolved at all #then the switch fails closed", () => {
    // given / when
    const resolution = resolveLive(UNREADABLE)
    // then
    expect(resolution.enabled).toBe(false)
    expect(resolution.diagnostics.length).toBeGreaterThan(0)
  })

  test("#when a nearer refused block sits over an earlier valid leaf #then the parser's own semantics hold", () => {
    // given: the parser drops a refused section, so the earlier block stays in
    // effect (`monitor`/`goal` behave identically). A refused block is therefore
    // unconfirmed ONLY when no valid leaf survives, and this case pins that it is
    // not reported as a failure while an earlier declaration answers the switch.
    const fileSystem = memoryFileSystem({
      [USER_CONFIG]: JSON.stringify({ "[opencode]": { default_mode: { ultrawork: true } } }),
      [PROJECT_CONFIG]: JSON.stringify({ "[opencode]": { default_mode: 7 } }),
    })
    // when
    const resolution = resolveLive(fileSystem)
    // then
    expect(resolution.enabled).toBe(true)
    expect(resolution.diagnostics).toEqual([])
  })
})
