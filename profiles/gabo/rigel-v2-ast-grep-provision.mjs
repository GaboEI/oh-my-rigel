#!/usr/bin/env node
/**
 * Provision the pinned ast-grep `sg` binary the ast-grep skill consumes.
 *
 * Single strategy and single pin: `provisionSgBinary` over the pinned manifest
 * (`SG_PINNED_VERSION` + `SG_RELEASE_ASSETS` sha256 per platform). The vendored
 * skill `install.sh` (no checksum) is deliberately NOT used. The binary lands in
 * `<home>/.omo/runtime/ast-grep/<slug>`, the exact runtime path the resolver
 * probes, so a real ast-grep search works after install.
 *
 * The install transaction calls this best-effort: a failed download never fails
 * the install, and the caller tracks the runtime dir so a rollback removes it
 * byte-identically. `RIGEL_V2_SG_ASSET_FILE` (plus `RIGEL_V2_SG_ASSET_SHA256`)
 * points at a local release zip for a hermetic, network-free run; otherwise the
 * pinned GitHub asset is downloaded.
 *
 * Self-contained: the pinned provisioning strategy lives in the sibling
 * `./rigel-v2-ast-grep-runtime.mjs` (a documented copy of the pieces this tree
 * needs from `packages/utils`), so the shipped tree never resolves a bare
 * `@oh-my-opencode/*` specifier. Only `node:` and relative imports, so the
 * node-run installer can import `astGrepUserRuntimeDir` for its tracking.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { astGrepRuntimeDir, provisionSgBinary, runtimeSlug } from "./rigel-v2-ast-grep-runtime.mjs"

// Mirror of the utils normalizers, kept in sync by the path-parity test.
function normalizePlatform(platform) {
  return platform === "darwin" || platform === "linux" || platform === "win32" ? platform : "linux"
}
function normalizeArch(arch) {
  return arch === "arm64" || arch === "aarch64" ? "arm64" : "x64"
}

/** `<home>/.omo/runtime/ast-grep/<slug>`: the resolver's tier-2 candidate path. */
export function astGrepUserRuntimeDir(home, platform = process.platform, arch = process.arch) {
  return path.join(home, ".omo", "runtime", "ast-grep", `${normalizePlatform(platform)}-${normalizeArch(arch)}`)
}

function fileSha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

/** A fetch that serves a local release zip so provisioning needs no network. */
function localAssetFetch(assetFile) {
  return async (_url, init) => {
    if (init?.signal?.aborted) throw new Error("ast-grep provisioning aborted")
    return new Response(fs.readFileSync(assetFile), { status: 200 })
  }
}

/**
 * Provision `sg` into `<home>/.omo/runtime/ast-grep/<slug>`. Returns the target
 * dir and the binary path. Throws `SgProvisionError` on a checksum or platform
 * failure; the caller decides whether that is fatal. Self-contained: no runtime
 * relies on the workspace `@oh-my-opencode/utils` resolving.
 */
export async function provisionAstGrepSg({ home, platform, arch, assetFile, assetSha256, fetchImpl, releaseAssets, signal } = {}) {
  const resolvedPlatform = platform ?? process.platform
  const resolvedArch = arch ?? process.arch
  const targetDir = astGrepRuntimeDir(path.join(home, ".omo"), resolvedPlatform, resolvedArch)
  // No-drift guard: the installer tracks this same path from astGrepUserRuntimeDir.
  if (path.resolve(targetDir) !== path.resolve(astGrepUserRuntimeDir(home, resolvedPlatform, resolvedArch))) {
    throw new Error(`ast-grep runtime dir drift: ${targetDir} != ${astGrepUserRuntimeDir(home, resolvedPlatform, resolvedArch)}`)
  }

  const options = { targetDir, platform: resolvedPlatform, arch: resolvedArch }
  if (signal !== undefined) options.signal = signal
  if (fetchImpl !== undefined) options.fetchImpl = fetchImpl
  if (releaseAssets !== undefined) options.releaseAssets = releaseAssets

  const offlineFile = assetFile ?? process.env.RIGEL_V2_SG_ASSET_FILE ?? null
  if (typeof offlineFile === "string" && offlineFile.length > 0) {
    const sha256 = assetSha256 ?? process.env.RIGEL_V2_SG_ASSET_SHA256 ?? fileSha256(offlineFile)
    if (fetchImpl === undefined) options.fetchImpl = localAssetFetch(offlineFile)
    if (releaseAssets === undefined) {
      options.releaseAssets = { [runtimeSlug(resolvedPlatform, resolvedArch)]: { url: `file://${offlineFile}`, sha256 } }
    }
  }

  const binaryPath = await provisionSgBinary(options)
  return { targetDir, binaryPath }
}

function parseFlags(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith("--")) continue
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next
      index += 1
    } else {
      flags[key] = true
    }
  }
  return flags
}

const isMain = typeof process.argv[1] === "string" && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const flags = parseFlags(process.argv.slice(2))
  const home = path.resolve(typeof flags.home === "string" ? flags.home : process.env.HOME || os.homedir())
  const platform = typeof flags.platform === "string" ? flags.platform : undefined
  const arch = typeof flags.arch === "string" ? flags.arch : undefined
  try {
    const result = await provisionAstGrepSg({ home, platform, arch })
    if (flags.json === true) process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`)
    else process.stdout.write(`sg provisioned: ${result.binaryPath}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (flags.json === true) process.stdout.write(`${JSON.stringify({ ok: false, targetDir: astGrepUserRuntimeDir(home, platform ?? process.platform, arch ?? process.arch), error: message })}\n`)
    else process.stderr.write(`sg provisioning failed: ${message}\n`)
    process.exitCode = 1
  }
}
