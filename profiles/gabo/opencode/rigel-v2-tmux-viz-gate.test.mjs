import { describe, expect, test } from "bun:test"

import * as config from "./rigel-v2-native-config.mjs"

// Row 55, stage A. The tmux-visualization gate is materialized into the agent
// manifest at INSTALL time from the install-time user layer only, so a public
// PROJECT layer (`.omo/omo.jsonc`) can never enable it: the feature is
// unreachable in the official topology even when the documented public config
// asks for it. The runtime must therefore resolve the gate from the live
// user+project chain, WITHOUT inventing a value and WITHOUT changing the
// documented default (`false`).
//
// Contract: project layer wins over the baked manifest; an undeclared key
// keeps the materialized manifest value (never a synthesized `true`); an
// unreadable chain fails back to the manifest instead of guessing.

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

const HOME = "/home/rigeltest"
const PROJECT = `${HOME}/proj`
const USER_CONFIG = `${HOME}/.omo/omo.jsonc`
const PROJECT_CONFIG = `${PROJECT}/.omo/omo.jsonc`
const ENV = { HOME }

function declaring(files) {
  return memoryFileSystem(files)
}

function projectDeclaring(value) {
  return declaring({ [PROJECT_CONFIG]: JSON.stringify({ "[opencode]": { team_mode: { tmux_visualization: value } } }) })
}

function manifestWith(value) {
  return { metadata: { global: { tmuxVisualization: value } } }
}

function resolve(manifest, fileSystem) {
  return config.resolveNativeTmuxVisualization({ manifest, directory: PROJECT, env: ENV, fileSystem })
}

describe("tmux-visualization gate resolves from the live config chain", () => {
  test("#given row 55 is unfixed #when the runtime asks for the live gate reader #then the reader exists", () => {
    expect(typeof config.readLiveTmuxVisualizationSource).toBe("function")
    expect(typeof config.resolveNativeTmuxVisualization).toBe("function")
  })

  test("#given a project layer declaring true and a manifest baked false #when resolved #then the project layer wins", () => {
    expect(resolve(manifestWith(false), projectDeclaring(true))).toBe(true)
  })

  test("#given a project layer declaring false and a manifest baked true #when resolved #then the project layer wins", () => {
    expect(resolve(manifestWith(true), projectDeclaring(false))).toBe(false)
  })

  test("#given a user layer declaring true #when resolved #then it is honored as well", () => {
    const fileSystem = declaring({ [USER_CONFIG]: JSON.stringify({ "[opencode]": { team_mode: { tmux_visualization: true } } }) })
    expect(resolve(manifestWith(false), fileSystem)).toBe(true)
  })

  test("#given no layer declares the key #when resolved #then the materialized manifest value is preserved and nothing is invented", () => {
    const nothing = declaring({})
    expect(resolve(manifestWith(true), nothing)).toBe(true)
    expect(resolve(manifestWith(false), nothing)).toBe(false)
    expect(resolve({}, nothing)).toBe(false)
  })

  test("#given a file that exists but cannot be parsed #when resolved #then the loader absorbs it as undeclared and the manifest is honored", () => {
    const broken = {
      existsSync: () => true,
      lstatSync: () => ({ isSymbolicLink: () => false }),
      readFileSync: () => {
        throw new Error("EIO")
      },
      realpathSync: (path) => path,
    }
    // The loader catches the per-file read error and keeps going, so this is an
    // UNDECLARED chain - distinct from an unresolvable `error` chain below.
    expect(config.readLiveTmuxVisualizationSource({ directory: PROJECT, env: ENV, fileSystem: broken }).state).toBe("undeclared")
    expect(resolve(manifestWith(false), broken)).toBe(false)
    expect(resolve(manifestWith(true), broken)).toBe(true)
  })

  test("#given the live chain cannot be resolved at all #when resolved #then it fails closed even when the manifest baked the gate on", () => {
    const unresolvable = {
      existsSync: () => {
        throw new Error("EACCES: cannot resolve the config chain")
      },
      lstatSync: () => ({ isSymbolicLink: () => false }),
      readFileSync: () => {
        throw new Error("EACCES")
      },
      realpathSync: (path) => path,
    }
    // The reader classifies a chain it cannot resolve as `error`, not `undeclared`.
    expect(config.readLiveTmuxVisualizationSource({ directory: PROJECT, env: ENV, fileSystem: unresolvable }).state).toBe("error")
    // A manifest baked ON must NOT re-enable the gate from an unreadable chain:
    // an error fails closed instead of falling back to the install-time value.
    expect(resolve(manifestWith(true), unresolvable)).toBe(false)
    expect(resolve(manifestWith(false), unresolvable)).toBe(false)
  })

  test("#given nothing declares the key #when the live reader is asked #then it reports undeclared rather than a value", () => {
    const state = config.readLiveTmuxVisualizationSource({ directory: PROJECT, env: ENV, fileSystem: declaring({}) })
    expect(state.state).toBe("undeclared")
  })

  test("#given a project layer declares the key #when the live reader is asked #then it reports the declared value", () => {
    const state = config.readLiveTmuxVisualizationSource({ directory: PROJECT, env: ENV, fileSystem: projectDeclaring(true) })
    expect(state.state).toBe("declared")
    expect(state.value).toBe(true)
  })
})
