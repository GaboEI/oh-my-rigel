/**
 * U3 installer wiring: the install transaction provisions the pinned ast-grep
 * `sg` into `<home>/.omo/runtime/ast-grep/<slug>` (best-effort), and tracks the
 * runtime dir so an injected failure removes it byte-identically.
 *
 * A crafted local zip stands in for the pinned release asset through
 * `RIGEL_V2_SG_ASSET_FILE`/`RIGEL_V2_SG_ASSET_SHA256`, so the whole gate is
 * offline. Each case drives the REAL installer in an isolated HOME/XDG tree.
 */
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { findSgBinarySync } from "@oh-my-opencode/utils"
import { astGrepUserRuntimeDir } from "./rigel-v2-ast-grep-provision.mjs"

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(moduleDirectory, "../..")
const installerPath = path.join(repoRoot, "profiles/gabo/rigel-v2-user-install.mjs")
const SG_BINARY_NAME = process.platform === "win32" ? "sg.exe" : "sg"
const ZIP_ENTRY_NAME = process.platform === "win32" ? "ast-grep.exe" : "ast-grep"
const SG_SCRIPT = "#!/bin/sh\necho \"ast-grep 0.43.0\"\n"

/** Minimal single-entry STORE zip (method 0); the provisioner verifies sha256, not CRC. */
function storeZip(entryName, entryText) {
  const name = Buffer.from(entryName, "utf8")
  const data = Buffer.from(entryText, "utf8")
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(name.length, 26)
  const cdOffset = 30 + name.length + data.length
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(name.length, 28)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(46 + name.length, 12)
  eocd.writeUInt32LE(cdOffset, 16)
  return Buffer.concat([local, name, data, central, name, eocd])
}

function makeBase() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-sg-install-"))
  fs.mkdirSync(path.join(base, "home"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(base, "xdg", "config", "opencode"), { recursive: true, mode: 0o700 })
  fs.writeFileSync(
    path.join(base, "xdg", "config", "opencode", "opencode.json"),
    `${JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [] }, null, 2)}\n`,
    { mode: 0o600 },
  )
  return base
}

function fixtureAsset(base, tag = "base") {
  const scriptText = tag === "base" ? SG_SCRIPT : `#!/bin/sh\necho "ast-grep 0.43.0"\n# ${tag}\n`
  const zip = storeZip(ZIP_ENTRY_NAME, scriptText)
  const file = path.join(base, `sg-asset-${tag}.zip`)
  fs.writeFileSync(file, zip)
  return { file, scriptText, sha256: crypto.createHash("sha256").update(zip).digest("hex") }
}

function installEnv(base, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: path.join(base, "home"),
    XDG_CONFIG_HOME: path.join(base, "xdg", "config"),
    XDG_DATA_HOME: path.join(base, "xdg", "data"),
    XDG_STATE_HOME: path.join(base, "xdg", "state"),
    XDG_CACHE_HOME: path.join(base, "xdg", "cache"),
    OMO_DISABLE_PROCESS_CLEANUP: "1",
    ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
    ...extra,
  }
}

function runInstall(base, extra = {}) {
  const home = path.join(base, "home")
  const configFile = path.join(base, "xdg", "config", "opencode", "opencode.json")
  const stateRoot = path.join(base, "state")
  const result = spawnSync(
    "node",
    [installerPath, "install", "--version", "1", "--home", home, "--config", configFile, "--state", stateRoot, "--json"],
    { cwd: repoRoot, env: installEnv(base, extra), encoding: "utf8", timeout: 300_000 },
  )
  return { result, home }
}

function runUninstall(base, extra = {}) {
  const home = path.join(base, "home")
  const configFile = path.join(base, "xdg", "config", "opencode", "opencode.json")
  const stateRoot = path.join(base, "state")
  return spawnSync(
    "node",
    [installerPath, "uninstall", "--home", home, "--config", configFile, "--state", stateRoot, "--json"],
    { cwd: repoRoot, env: installEnv(base, extra), encoding: "utf8", timeout: 300_000 },
  )
}

// The fixture cannot execute on a host whose platform differs from the forced
// linux target (Windows has no `/bin/sh`); inject the probe there only. The
// resolver is made hermetic: only the provisioned path, no PATH/real-home.
function resolveProvisioned(home) {
  const runtimeDir = astGrepUserRuntimeDir(home)
  const binaryPath = path.resolve(path.join(runtimeDir, SG_BINARY_NAME))
  return findSgBinarySync({
    runtimeDir,
    homeDir: path.join(home, ".empty-home"),
    env: {},
    which: () => null,
    fileExists: (candidate) => path.resolve(candidate) === binaryPath && fs.existsSync(candidate),
    ...(process.platform === "win32" ? { runVersionProbeSync: () => "ast-grep 0.43.0" } : {}),
  })
}

function withBase(run) {
  const base = makeBase()
  try {
    return run(base)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
}

describe("#given an install that provisions the pinned ast-grep sg", () => {
  test("#when the pinned asset is present #then sg resolves under <home>/.omo/runtime/ast-grep/<slug>", () => {
    withBase((base) => {
      const asset = fixtureAsset(base)
      const { result, home } = runInstall(base, { RIGEL_V2_SG_ASSET_FILE: asset.file, RIGEL_V2_SG_ASSET_SHA256: asset.sha256 })
      expect(result.status, result.stderr || result.stdout).toBe(0)
      expect(resolveProvisioned(home)).toBe(path.join(astGrepUserRuntimeDir(home), SG_BINARY_NAME))
    })
  })

  test("#when the asset checksum is rejected #then the install still succeeds and no sg is left", () => {
    withBase((base) => {
      const asset = fixtureAsset(base)
      const { result, home } = runInstall(base, { RIGEL_V2_SG_ASSET_FILE: asset.file, RIGEL_V2_SG_ASSET_SHA256: "0".repeat(64) })
      expect(result.status, result.stderr || result.stdout).toBe(0)
      expect(resolveProvisioned(home)).toBeNull()
      expect(fs.existsSync(path.join(astGrepUserRuntimeDir(home), SG_BINARY_NAME))).toBe(false)
    })
  })

  test("#when a later transaction step fails #then the provisioned ast-grep dir is removed byte-identically", () => {
    withBase((base) => {
      const asset = fixtureAsset(base)
      const { result, home } = runInstall(base, {
        RIGEL_V2_SG_ASSET_FILE: asset.file,
        RIGEL_V2_SG_ASSET_SHA256: asset.sha256,
        RIGEL_V2_FAIL_AT: "provision:after-astgrep",
      })
      expect(result.status).not.toBe(0)
      expect(fs.existsSync(astGrepUserRuntimeDir(home))).toBe(false)
    })
  })

  test("#when a reinstall refreshes an existing sg and then fails #then the prior binary is restored byte-identically", () => {
    withBase((base) => {
      const first = fixtureAsset(base, "first")
      const installed = runInstall(base, { RIGEL_V2_SG_ASSET_FILE: first.file, RIGEL_V2_SG_ASSET_SHA256: first.sha256 })
      expect(installed.result.status, installed.result.stderr || installed.result.stdout).toBe(0)
      const binary = path.join(astGrepUserRuntimeDir(installed.home), SG_BINARY_NAME)
      const bytesA = fs.readFileSync(binary)
      expect(bytesA.toString("utf8")).toBe(first.scriptText)

      // A second install refreshes the same-version sg, then a later step fails:
      // the transaction must restore the FIRST bytes byte-identically.
      const second = fixtureAsset(base, "second")
      const refreshed = runInstall(base, {
        RIGEL_V2_SG_ASSET_FILE: second.file,
        RIGEL_V2_SG_ASSET_SHA256: second.sha256,
        RIGEL_V2_FAIL_AT: "provision:after-astgrep",
      })
      expect(refreshed.result.status).not.toBe(0)
      expect(fs.readFileSync(binary).equals(bytesA)).toBe(true)
      expect(fs.statSync(binary).mode & 0o111).not.toBe(0)
    })
  })

  test("#when this install provisioned sg #then uninstall removes it and a failed uninstall restores it", () => {
    withBase((base) => {
      const asset = fixtureAsset(base)
      const installed = runInstall(base, { RIGEL_V2_SG_ASSET_FILE: asset.file, RIGEL_V2_SG_ASSET_SHA256: asset.sha256 })
      expect(installed.result.status, installed.result.stderr || installed.result.stdout).toBe(0)
      const sgDir = astGrepUserRuntimeDir(installed.home)
      const binary = path.join(sgDir, SG_BINARY_NAME)
      expect(fs.existsSync(binary)).toBe(true)
      const bytes = fs.readFileSync(binary)

      const failed = runUninstall(base, { RIGEL_V2_FAIL_AT: "uninstall:after-versions" })
      expect(failed.status).not.toBe(0)
      expect(fs.readFileSync(binary).equals(bytes)).toBe(true)

      const ok = runUninstall(base)
      expect(ok.status, ok.stderr || ok.stdout).toBe(0)
      expect(fs.existsSync(sgDir)).toBe(false)
    })
  })

  test("#when the ast-grep runtime already existed before install #then uninstall never claims or removes it", () => {
    withBase((base) => {
      const home = path.join(base, "home")
      const sgDir = astGrepUserRuntimeDir(home)
      fs.mkdirSync(sgDir, { recursive: true, mode: 0o700 })
      const userBinary = path.join(sgDir, SG_BINARY_NAME)
      fs.writeFileSync(userBinary, "user-owned sg\n", { mode: 0o755 })

      const installed = runInstall(base, { RIGEL_V2_SG_PROVISION: "0" })
      expect(installed.result.status, installed.result.stderr || installed.result.stdout).toBe(0)
      const state = JSON.parse(fs.readFileSync(path.join(base, "state", "install-state.json"), "utf8"))
      expect(state.astGrepOwnedDir ?? null).toBe(null)

      const ok = runUninstall(base)
      expect(ok.status, ok.stderr || ok.stdout).toBe(0)
      expect(fs.existsSync(userBinary)).toBe(true)
    })
  })
})

describe("#given an install that fails after the skill materializer", () => {
  test("#when it fails #then Rigel-created skill links are removed and user content is untouched", () => {
    withBase((base) => {
      const home = path.join(base, "home")
      // A user-owned skill present before the install must survive the rollback.
      const userDir = path.join(home, ".agents", "skills", "user-thing")
      fs.mkdirSync(userDir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(userDir, "SKILL.md"), "user body\n")

      const asset = fixtureAsset(base)
      const { result } = runInstall(base, {
        RIGEL_V2_SG_ASSET_FILE: asset.file,
        RIGEL_V2_SG_ASSET_SHA256: asset.sha256,
        RIGEL_V2_FAIL_AT: "provision:after-astgrep",
      })
      expect(result.status).not.toBe(0)

      const skillsRoot = path.join(home, ".agents", "skills")
      const remaining = fs.existsSync(skillsRoot) ? fs.readdirSync(skillsRoot).sort() : []
      expect(remaining).toEqual(["user-thing"])
      expect(fs.readFileSync(path.join(userDir, "SKILL.md"), "utf8")).toBe("user body\n")
    })
  })
})
