/**
 * Hermetic contract for the pinned ast-grep `sg` provisioning strategy (U3).
 *
 * `provisionAstGrepSg` must use the single pinned strategy (`provisionSgBinary`
 * over `SG_PINNED_VERSION` + per-platform sha256): the target dir is the exact
 * resolver path `<home>/.omo/runtime/ast-grep/<slug>`, the asset sha256 is
 * enforced, and a rejected asset leaves no binary behind. A crafted local zip
 * stands in for the pinned release asset, so no network is used.
 */
import { afterEach, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { astGrepRuntimeDir, findSgBinarySync } from "@oh-my-opencode/utils"
import { astGrepUserRuntimeDir, provisionAstGrepSg } from "./rigel-v2-ast-grep-provision.mjs"

const SG_SCRIPT = "#!/bin/sh\necho \"ast-grep 0.43.0\"\n"
const roots = []

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-sg-provision-"))
  roots.push(home)
  return home
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop(), { recursive: true, force: true })
})

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex")
}

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

// Resolve the provisioned path without executing the fixture on a host whose
// platform differs from the forced linux target (Windows cannot run `/bin/sh`).
// The resolver is made hermetic: only the provisioned path, no PATH/real-home.
function resolveProvisioned(targetDir) {
  const binaryPath = path.resolve(path.join(targetDir, "sg"))
  return findSgBinarySync({
    runtimeDir: targetDir,
    homeDir: path.join(targetDir, ".empty-home"),
    env: {},
    which: () => null,
    fileExists: (candidate) => path.resolve(candidate) === binaryPath && fs.existsSync(candidate),
    ...(process.platform === "win32" ? { runVersionProbeSync: () => "ast-grep 0.43.0" } : {}),
  })
}

describe("#given the shared runtime-dir helper", () => {
  test("#when platform/arch vary #then it equals astGrepRuntimeDir(join(home, '.omo'))", () => {
    for (const [platform, arch, slug] of [
      ["linux", "x64", "linux-x64"],
      ["darwin", "arm64", "darwin-arm64"],
      ["win32", "x64", "win32-x64"],
      ["freebsd", "ia32", "linux-x64"],
    ]) {
      const home = "/home/operator"
      expect(astGrepUserRuntimeDir(home, platform, arch)).toBe(astGrepRuntimeDir(path.join(home, ".omo"), platform, arch))
      expect(path.basename(astGrepUserRuntimeDir(home, platform, arch))).toBe(slug)
    }
  })
})

describe("#given provisionAstGrepSg over an injected pinned asset", () => {
  test("#when the asset sha256 matches #then sg lands on the resolver path and resolves there", async () => {
    const home = makeHome()
    const zip = storeZip("ast-grep", SG_SCRIPT)
    const result = await provisionAstGrepSg({
      home,
      platform: "linux",
      arch: "x64",
      fetchImpl: async () => new Response(zip, { status: 200 }),
      releaseAssets: { "linux-x64": { url: "https://assets.invalid/ast-grep-0.43.0.zip", sha256: sha256Hex(zip) } },
    })

    expect(result.targetDir).toBe(astGrepUserRuntimeDir(home, "linux", "x64"))
    expect(fs.readFileSync(result.binaryPath, "utf8")).toBe(SG_SCRIPT)
    expect(resolveProvisioned(result.targetDir)).toBe(result.binaryPath)
  })

  test("#when the asset sha256 mismatches #then it rejects with bad_checksum and leaves no binary", async () => {
    const home = makeHome()
    const zip = storeZip("ast-grep", SG_SCRIPT)
    const targetDir = astGrepUserRuntimeDir(home, "linux", "x64")
    let error
    try {
      await provisionAstGrepSg({
        home,
        platform: "linux",
        arch: "x64",
        fetchImpl: async () => new Response(zip, { status: 200 }),
        releaseAssets: { "linux-x64": { url: "https://assets.invalid/ast-grep-0.43.0.zip", sha256: "0".repeat(64) } },
      })
    } catch (caught) {
      error = caught
    }

    expect(error?.code).toBe("bad_checksum")
    expect(fs.existsSync(path.join(targetDir, "sg"))).toBe(false)
  })
})
