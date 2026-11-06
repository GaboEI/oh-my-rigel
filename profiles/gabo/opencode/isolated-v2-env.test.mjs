import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { assertIsolatedV2Env, buildIsolatedV2Env, PROTECTED_V1_ROOTS } from "../isolated-v2-env.mjs"

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-isolation-"))
  fs.mkdirSync(path.join(root, "home"), { recursive: true })
  return root
}

describe("isolated V2 environment guard", () => {
  test("every state root lands inside the disposable sandbox", () => {
    const root = sandbox()
    const env = buildIsolatedV2Env({ sandbox: root })
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "OPENCODE_GOAL_STATE_PATH"]) {
      expect(path.resolve(env[key]).startsWith(root)).toBe(true)
    }
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("inherited V1-pointing state variables are replaced, never inherited", () => {
    const root = sandbox()
    const previous = process.env.OPENCODE_GOAL_STATE_PATH
    process.env.OPENCODE_GOAL_STATE_PATH = path.join(os.homedir(), ".local/share/opencode-goal-plugin/goals.json")
    try {
      const env = buildIsolatedV2Env({ sandbox: root })
      expect(env.OPENCODE_GOAL_STATE_PATH.startsWith(root)).toBe(true)
      expect(env.OPENCODE_GOAL_STATE_PATH).not.toContain(".local/share/opencode-goal-plugin")
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_GOAL_STATE_PATH
      else process.env.OPENCODE_GOAL_STATE_PATH = previous
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("assertion rejects a goal state pointed at production V1", () => {
    const root = sandbox()
    const env = buildIsolatedV2Env({ sandbox: root })
    env.OPENCODE_GOAL_STATE_PATH = path.join(os.homedir(), ".local/share/opencode-goal-plugin/goals.json")
    expect(() => assertIsolatedV2Env(env, { sandbox: root })).toThrow(/isolation violation/)
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("assertion rejects any path escaping the sandbox", () => {
    const root = sandbox()
    const env = buildIsolatedV2Env({ sandbox: root })
    env.XDG_DATA_HOME = path.join(os.homedir(), ".local/share/opencode")
    expect(() => assertIsolatedV2Env(env, { sandbox: root })).toThrow(/isolation violation/)
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("production surfaces stay listed as protected", () => {
    expect(PROTECTED_V1_ROOTS.some((entry) => entry.endsWith("opencode-goal-plugin"))).toBe(true)
    expect(PROTECTED_V1_ROOTS.every((entry) => entry.startsWith(os.homedir()))).toBe(true)
  })

  test("inherited OPENCODE_* state variables pointing at the real home are stripped", () => {
    const root = sandbox()
    const previous = process.env.OPENCODE_MULTI_AUTH_STORE_DIR
    process.env.OPENCODE_MULTI_AUTH_STORE_DIR = path.join(os.homedir(), ".config/opencode-multi-auth")
    try {
      const env = buildIsolatedV2Env({ sandbox: root })
      expect(env.OPENCODE_MULTI_AUTH_STORE_DIR).toBeUndefined()
      expect(env.__rigelStrippedEnvKeys).toContain("OPENCODE_MULTI_AUTH_STORE_DIR")
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_MULTI_AUTH_STORE_DIR
      else process.env.OPENCODE_MULTI_AUTH_STORE_DIR = previous
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("PATH is inherited even though it contains home directories", () => {
    const root = sandbox()
    const env = buildIsolatedV2Env({ sandbox: root })
    // Windows keeps the inherited casing of the variable name (`Path`), while
    // the OS treats it case-insensitively; both spellings name the same PATH.
    const inherited = env.PATH ?? env.Path
    const launched = process.env.PATH ?? process.env.Path
    expect(inherited).toBe(launched)
    fs.rmSync(root, { recursive: true, force: true })
  })
})
