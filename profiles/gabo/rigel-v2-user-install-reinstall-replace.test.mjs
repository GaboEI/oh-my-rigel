/**
 * Regression contract for same-version reinstall cleanliness and its compensation.
 *
 * A reinstall of an already-installed version must REPLACE the runtime from clean
 * staging: a file a previous install wrote (for example a module retired by a
 * later revision) must not survive it. The replacement is transactional, so a
 * failure after the runtime is rebuilt restores the prior runtime byte-identically.
 *
 * Two isolated shapes drive the REAL installer (every state root inside a temp
 * tree, no real HOME/XDG, no network):
 *   1. positive: a pre-placed stale module disappears on reinstall while the
 *      runtime stays valid and the install state is coherent;
 *   2. negative: an injected failure after the rebuild restores the runtime byte
 *      for byte and leaves the install state unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(moduleDirectory, "../..")
const installerPath = path.join(repoRoot, "profiles/gabo/rigel-v2-user-install.mjs")

/** Deterministic digest of a directory tree (path + content), matching the installer's shape. */
function runtimeTreeDigest(dir) {
  const files = []
  const walk = (base, rel) => {
    for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(base, entry.name)
      const next = rel === "" ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(abs, next)
      else if (entry.isFile()) files.push(next)
    }
  }
  walk(dir, "")
  const digest = crypto.createHash("sha256")
  for (const file of files) {
    digest.update(file)
    digest.update("\0")
    digest.update(crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, file))).digest("hex"))
    digest.update("\n")
  }
  return digest.digest("hex")
}

function baseEnv(base, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: path.join(base, "installer-home"),
    XDG_CONFIG_HOME: path.join(base, "installer-xdg", "config"),
    XDG_DATA_HOME: path.join(base, "installer-xdg", "data"),
    XDG_STATE_HOME: path.join(base, "installer-xdg", "state"),
    XDG_CACHE_HOME: path.join(base, "installer-xdg", "cache"),
    OMO_DISABLE_PROCESS_CLEANUP: "1",
    ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
    ...extra,
  }
}

function runInstall({ home, configFile, stateRoot }, env) {
  return spawnSync(
    "node",
    [installerPath, "install", "--version", "1", "--home", home, "--config", configFile, "--state", stateRoot, "--json"],
    { cwd: repoRoot, env, encoding: "utf8", timeout: 300_000 },
  )
}

const STALE_MODULE = "rigel-v2-native-cli-sidebar.mjs"

describe("rigel-v2-user-install same-version reinstall replaces the runtime from clean staging", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-reinstall-replace-"))
  const home = path.join(base, "home")
  const configFile = path.join(base, "config", "opencode", "opencode.json")
  const stateRoot = path.join(base, "state")
  const versionDir = path.join(stateRoot, "versions", "1")
  const runtimeDir = path.join(versionDir, "runtime")

  beforeAll(() => {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(
      configFile,
      `${JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [] }, null, 2)}\n`,
      { mode: 0o600 },
    )
    const first = runInstall({ home, configFile, stateRoot }, baseEnv(base))
    expect(first.status, `initial install failed: ${first.stderr || first.stdout}`).toBe(0)
  }, 300_000)

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  describe("#given an installed runtime carrying a stale module from a previous install", () => {
    describe("#when the same version is reinstalled", () => {
      test("#then the stale module disappears and the valid runtime and state stay correct", () => {
        const stale = path.join(runtimeDir, STALE_MODULE)
        fs.writeFileSync(stale, "// stale module from a previous install\n", { mode: 0o600 })
        expect(fs.existsSync(stale)).toBe(true)

        const reinstall = runInstall({ home, configFile, stateRoot }, baseEnv(base))
        expect(reinstall.status, `reinstall failed: ${reinstall.stderr || reinstall.stdout}`).toBe(0)

        // The runtime was rebuilt from clean staging: the stale module is gone.
        expect(fs.existsSync(stale)).toBe(false)
        // The valid runtime and its manifest are still present and coherent.
        expect(fs.existsSync(path.join(runtimeDir, "tui.js"))).toBe(true)
        expect(fs.existsSync(path.join(runtimeDir, "index.js"))).toBe(true)
        expect(fs.existsSync(path.join(runtimeDir, "rigel-v2-native-agent-manifest.mjs"))).toBe(true)
        const emitted = JSON.parse(reinstall.stdout)
        expect(emitted.status.pass).toBe(true)
        const state = JSON.parse(fs.readFileSync(path.join(stateRoot, "install-state.json"), "utf8"))
        expect(state.version).toBe("1")
        expect(state.versionDigests["1"]).toMatch(/^[0-9a-f]{64}$/)
        // The aside copy is discarded on a successful commit.
        expect(fs.readdirSync(versionDir).some((name) => name.includes(".txn-"))).toBe(false)
      }, 300_000)
    })
  })

  describe("#given a reinstall that fails after the runtime rebuild", () => {
    describe("#when the lifecycle transaction rolls back", () => {
      test("#then the prior runtime is restored byte-identically and the install state is unchanged", () => {
        const stale = path.join(runtimeDir, STALE_MODULE)
        fs.writeFileSync(stale, "// stale module present before the failed reinstall\n", { mode: 0o600 })
        const digestBefore = runtimeTreeDigest(runtimeDir)
        const stateBefore = fs.readFileSync(path.join(stateRoot, "install-state.json"), "utf8")

        const failed = runInstall(
          { home, configFile, stateRoot },
          baseEnv(base, { RIGEL_V2_FAIL_AT: "install:after-runtime" }),
        )
        expect(failed.status, "the injected failure must make the install fail").not.toBe(0)

        // The runtime is restored byte-identically to the pre-failure tree: the
        // stale module it held is back and no half-materialised tree survives.
        expect(runtimeTreeDigest(runtimeDir)).toBe(digestBefore)
        expect(fs.existsSync(stale)).toBe(true)
        // The install state is untouched.
        expect(fs.readFileSync(path.join(stateRoot, "install-state.json"), "utf8")).toBe(stateBefore)
        // The aside copy is renamed back on rollback, so nothing is left behind.
        expect(fs.readdirSync(versionDir).some((name) => name.includes(".txn-"))).toBe(false)
      }, 300_000)
    })
  })
})
