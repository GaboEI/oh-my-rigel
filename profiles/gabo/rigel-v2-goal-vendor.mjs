#!/usr/bin/env node
/**
 * Vendorizer for the pinned community goal engine (PR A: vendor fijado, oscuro).
 *
 * It acquires the pinned tarball once (M2), lays the artifact plus its exact
 * runtime/TUI closure into the in-tree vendor directory, records provenance
 * (version, tag, commit, MIT license, dist integrity, tarball hash, tree digest)
 * and materializes everything OFFLINE at install time (M1 target) — the install
 * never touches the registry.
 *
 * PR A is deliberately dark: this module is referenced by the materializer only,
 * writes nothing into `opencode.json` / `cli.json`, registers no command, tool,
 * hook, listener or TUI, and never reads or writes any live goal state. The
 * inherited Goal and the community engine are both untouched.
 *
 * Boundary: local files only. No network except the explicit `acquire`
 * subcommand, which is a maintainer action, never part of an install.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { renderGoalVendorNotice, noticeHeadingFor } from "./goal-vendor-notice.mjs"
import { digestOfDirectory, digestOfEntries, extractEntries, sha256Hex, verifyIntegrity } from "./goal-vendor-tarball.mjs"

export const GOAL_VENDOR_ID = "opencode-goal-plugin"
export const GOAL_VENDOR_MANIFEST = "pin.json"
export const GOAL_VENDOR_NOTICE = "NOTICE"
export const GOAL_VENDOR_LICENSE = "LICENSE"
export const GOAL_VENDOR_SCHEMA = 1

/**
 * Frozen provenance of the artifact. Every field is the audited pin: this
 * constant is the authority, `pin.json` is the recorded snapshot that must agree
 * with it, and the vendored bytes must agree with both.
 */
export const GOAL_VENDOR_ARTIFACT = Object.freeze({
  name: "@prevalentware/opencode-goal-plugin",
  version: "0.1.60",
  tag: "v0.1.60",
  commit: "cf22feaaa7ab3367053a9a99913cbc40e5c3224e",
  license: "MIT",
  distIntegrity: "sha512-mDEwq3DdZtUPtty26FFf7SptSnTATeJYZGXOYEMVt/utjB7YwTzxiZwur6D65hxYEzhC6Qw7uSMi2wrP3OK0og==",
  tarballSha256: "292680c8a777113f92c82811a8683c4f9da368023d966fb0ead059c5243c9689",
  tarball: `tarballs/prevalentware-${GOAL_VENDOR_ID}-0.1.60.tgz`,
  engineEntry: "dist/server.js",
  tuiEntry: "src/tui.ts",
})

/**
 * Frozen closure: the artifact's declared runtime dependency set plus the nested
 * runtime closure of the plugin-owned dependency `effect-goal-state`. Peers are
 * recorded and vendored so the TUI entry specifiers resolve offline; their own
 * subgraph is host-owned (that is what `peerDependencies` means upstream).
 */
export const GOAL_VENDOR_CLOSURE = Object.freeze([
  Object.freeze({
    name: "zod",
    version: "4.6.7",
    role: "dependency",
    license: "MIT",
    integrity: "sha512-g8W2D2kU6a8untc053fX1uVBKzM7yqAxW/3zwk83+6RyF2+SKOuV+c0wBDhUwzV1PaGapmZH+rmcUzPf+3CGwg==",
    tarball: "tarballs/zod-4.6.7.tgz",
    installPath: "node_modules/zod",
  }),
  Object.freeze({
    name: "effect-goal-state",
    version: "3.22.2",
    role: "dependency",
    aliasOf: "effect",
    registryName: "effect",
    license: "MIT",
    integrity: "sha512-fm1CQXCs7GTMwpadZxwU5rnAb2bN6mbQpknq/pXBGCzSKkosNYb9k0wsoL0TfB10rSa5xOEZJjo77u/KLXSANg==",
    tarball: "tarballs/effect-3.22.2.tgz",
    installPath: "node_modules/effect-goal-state",
  }),
  Object.freeze({
    name: "fast-check",
    version: "3.23.2",
    role: "dependency",
    license: "MIT",
    integrity: "sha512-h5+1OzzfCC3Ef7VbtKdcv7zsstUQwUDlYpUTvjeUsJAssPgLn7QzbboPtL5ro04Mq0rPOsMzl7q5hIbRs2wD1A==",
    tarball: "tarballs/fast-check-3.23.2.tgz",
    installPath: "node_modules/effect-goal-state/node_modules/fast-check",
  }),
  Object.freeze({
    name: "pure-rand",
    version: "6.1.0",
    role: "dependency",
    license: "MIT",
    integrity: "sha512-bVWawvoZoBYpp6yIoQtQXHZjmz35RSVHnUOTefl8Vcjr8snTPY1wnpSPMWekcFwbxI6gtmT7rSYPFvz71ldiOA==",
    tarball: "tarballs/pure-rand-6.1.0.tgz",
    installPath: "node_modules/effect-goal-state/node_modules/pure-rand",
  }),
  Object.freeze({
    name: "@opentui/solid",
    version: "0.6.4",
    role: "peer",
    license: "MIT",
    integrity: "sha512-GGF72qTtMWxFQOCI/JoDBr4fzcquPf/QZhMybOiOGmWsXTdF1MNxfYeVEYQSAxHgvixW7a1qdB39cb2TMqnR7A==",
    tarball: "tarballs/opentui-solid-0.6.4.tgz",
    installPath: "node_modules/@opentui/solid",
  }),
  Object.freeze({
    name: "solid-js",
    version: "1.9.12",
    role: "peer",
    license: "MIT",
    integrity: "sha512-QzKaSJq2/iDrWR1As6MHZQ8fQkdOBf8GReYb7L5iKwMGceg7HxDcaOHk0at66tNgn9U2U7dXo8ZZpLIAmGMzgw==",
    tarball: "tarballs/solid-js-1.9.12.tgz",
    installPath: "node_modules/solid-js",
  }),
])

export function goalVendorSourceDir(sourceRoot) {
  return path.join(sourceRoot, "profiles", "gabo", "vendor", GOAL_VENDOR_ID)
}

export function goalVendorTargetDir(runtimeDir) {
  return path.join(runtimeDir, "vendor", GOAL_VENDOR_ID)
}

/** Namespaced so the additively recorded vendor digest never collides with the version keys. */
export function goalVendorDigestKey(version) {
  return `${GOAL_VENDOR_ID}:${version}`
}

function fail(message) {
  throw new Error(`goal vendor refused: ${message}`)
}

function readTarBytes(file) {
  if (!fs.existsSync(file)) fail(`vendored tarball is missing: ${file}`)
  return fs.readFileSync(file)
}

function assertSame(actual, expected, label) {
  if (actual !== expected) fail(`${label} mismatch: recorded ${JSON.stringify(actual)} / pinned ${JSON.stringify(expected)}`)
}

function assertFrozenClosure(closure) {
  const recorded = new Map(closure.map((entry) => [entry.name, entry]))
  if (recorded.size !== closure.length) fail("closure manifest contains a duplicate package")
  if (recorded.size !== GOAL_VENDOR_CLOSURE.length) {
    fail(`closure manifest has ${recorded.size} packages, expected ${GOAL_VENDOR_CLOSURE.length}`)
  }
  for (const pinned of GOAL_VENDOR_CLOSURE) {
    const entry = recorded.get(pinned.name)
    if (entry === undefined) fail(`closure manifest is missing ${pinned.name}`)
    for (const key of ["version", "role", "license", "integrity", "tarball", "installPath", "registryName"]) {
      assertSame(entry[key] ?? null, pinned[key] ?? null, `closure ${pinned.name} ${key}`)
    }
    assertSame(entry.aliasOf ?? null, pinned.aliasOf ?? null, `closure ${pinned.name} aliasOf`)
  }
}

function artifactDigests(sourceDir) {
  const artifactBytes = readTarBytes(path.join(sourceDir, GOAL_VENDOR_ARTIFACT.tarball))
  const integrity = verifyIntegrity(artifactBytes, GOAL_VENDOR_ARTIFACT.distIntegrity)
  if (!integrity.ok) fail(`artifact tarball integrity ${integrity.actual} does not match the pin`)
  return { entries: extractEntries(artifactBytes), artifactSha256: sha256Hex(artifactBytes) }
}

function closureDigests(sourceDir) {
  const entries = []
  const sha256 = {}
  for (const pinned of GOAL_VENDOR_CLOSURE) {
    const bytes = readTarBytes(path.join(sourceDir, pinned.tarball))
    const integrity = verifyIntegrity(bytes, pinned.integrity)
    if (!integrity.ok) fail(`closure tarball integrity for ${pinned.name} is ${integrity.actual}, pin is ${pinned.integrity}`)
    sha256[pinned.name] = sha256Hex(bytes)
    for (const entry of extractEntries(bytes)) {
      entries.push({ path: `${pinned.installPath}/${entry.path}`, bytes: entry.bytes, execute: entry.execute })
    }
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return { entries, sha256 }
}

export function readGoalVendorPin(sourceDir) {
  const manifest = path.join(sourceDir, GOAL_VENDOR_MANIFEST)
  if (!fs.existsSync(manifest)) fail(`manifest is missing: ${manifest}`)
  return JSON.parse(fs.readFileSync(manifest, "utf8"))
}

/**
 * Verify the whole in-tree vendor: recorded provenance against the frozen pin,
 * every vendored byte against its integrity, the LICENSE against the upstream
 * tarball, and the NOTICE against the deterministic regeneration.
 */
export function verifyGoalVendor({ sourceDir }) {
  const pin = readGoalVendorPin(sourceDir)
  if (pin.schema !== GOAL_VENDOR_SCHEMA) fail(`manifest schema ${String(pin.schema)} is not ${GOAL_VENDOR_SCHEMA}`)
  for (const key of ["name", "version", "tag", "commit", "license", "distIntegrity", "tarball", "engineEntry", "tuiEntry"]) {
    assertSame(pin.artifact?.[key], GOAL_VENDOR_ARTIFACT[key], `artifact ${key}`)
  }
  assertFrozenClosure(pin.closure ?? [])

  const { entries: artifactEntries, artifactSha256 } = artifactDigests(sourceDir)
  assertSame(pin.artifact.tarballSha256, artifactSha256, "artifact tarball sha256")
  const upstreamLicense = artifactEntries.find((entry) => entry.path === GOAL_VENDOR_LICENSE)
  if (upstreamLicense === undefined) fail("artifact tarball carries no LICENSE")
  const shippedLicense = path.join(sourceDir, GOAL_VENDOR_LICENSE)
  if (!fs.existsSync(shippedLicense)) fail(`vendored ${GOAL_VENDOR_LICENSE} is missing`)
  if (fs.readFileSync(shippedLicense).compare(upstreamLicense.bytes) !== 0) {
    fail(`vendored ${GOAL_VENDOR_LICENSE} is not byte-identical to the upstream LICENSE`)
  }

  const artifactTree = digestOfEntries(artifactEntries)
  assertSame(pin.digests?.artifactTree, artifactTree, "artifact tree digest")

  const { entries: closureEntries, sha256 } = closureDigests(sourceDir)
  for (const pinned of GOAL_VENDOR_CLOSURE) {
    const record = (pin.closure ?? []).find((entry) => entry.name === pinned.name)
    assertSame(record?.sha256, sha256[pinned.name], `closure ${pinned.name} sha256`)
  }
  const closureTree = digestOfEntries(closureEntries)
  assertSame(pin.digests?.closureTree, closureTree, "closure tree digest")

  const noticeFile = path.join(sourceDir, GOAL_VENDOR_NOTICE)
  if (!fs.existsSync(noticeFile)) fail(`vendored ${GOAL_VENDOR_NOTICE} is missing`)
  const notice = fs.readFileSync(noticeFile, "utf8")
  const expectedNotice = renderGoalVendorNotice(pin.artifact, pin.closure ?? [])
  if (notice !== expectedNotice) fail(`${GOAL_VENDOR_NOTICE} does not match its deterministic regeneration`)
  assertSame(pin.digests?.notice, sha256Hex(Buffer.from(notice, "utf8")), "notice digest")
  for (const attributed of [pin.artifact, ...(pin.closure ?? [])]) {
    if (!notice.includes(noticeHeadingFor(attributed))) {
      fail(`${GOAL_VENDOR_NOTICE} is missing the attribution entry for ${attributed.name} ${attributed.version}`)
    }
  }

  return { pin, artifact: pin.artifact, closure: pin.closure, digests: { artifactTree, closureTree, notice: pin.digests.notice } }
}

function writeEntries(root, entries) {
  for (const entry of entries) {
    const target = path.join(root, entry.path)
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    fs.writeFileSync(target, entry.bytes, { mode: entry.execute === true ? 0o755 : 0o644 })
  }
}

/**
 * Lay the verified vendor into the deployment's versioned runtime tree. Offline:
 * it only reads and writes local files, and it is safe to repeat (a second call
 * produces the same bytes and the same digest).
 */
export function materializeGoalVendor({ sourceRoot, runtimeDir, sourceDir = goalVendorSourceDir(sourceRoot) }) {
  const verified = verifyGoalVendor({ sourceDir })
  const target = goalVendorTargetDir(runtimeDir)
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true, mode: 0o700 })

  const artifactRoot = path.join(target, "node_modules", ...GOAL_VENDOR_ARTIFACT.name.split("/"))
  const artifactBytes = readTarBytes(path.join(sourceDir, GOAL_VENDOR_ARTIFACT.tarball))
  writeEntries(artifactRoot, extractEntries(artifactBytes))
  for (const pinned of GOAL_VENDOR_CLOSURE) {
    const bytes = readTarBytes(path.join(sourceDir, pinned.tarball))
    writeEntries(path.join(target, ...pinned.installPath.split("/")), extractEntries(bytes))
  }
  for (const file of [GOAL_VENDOR_MANIFEST, GOAL_VENDOR_NOTICE, GOAL_VENDOR_LICENSE, "README.md"]) {
    const from = path.join(sourceDir, file)
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(target, file))
  }

  const treeDigest = digestOfDirectory(target)
  return {
    id: GOAL_VENDOR_ID,
    dir: target,
    engineEntry: path.join(artifactRoot, GOAL_VENDOR_ARTIFACT.engineEntry),
    tuiEntry: path.join(artifactRoot, GOAL_VENDOR_ARTIFACT.tuiEntry),
    version: verified.artifact.version,
    digests: { ...verified.digests, tree: treeDigest },
    treeDigest,
  }
}

/** Deterministically (re)write LICENSE, NOTICE and pin.json from a pinned tarball. */
export function writeGoalVendor({ sourceDir, artifactTarball }) {
  fs.mkdirSync(sourceDir, { recursive: true, mode: 0o700 })
  const tarballTarget = path.join(sourceDir, GOAL_VENDOR_ARTIFACT.tarball)
  if (artifactTarball !== undefined && path.resolve(artifactTarball) !== path.resolve(tarballTarget)) {
    fs.copyFileSync(artifactTarball, tarballTarget)
  }
  const artifactBytes = readTarBytes(tarballTarget)
  const integrity = verifyIntegrity(artifactBytes, GOAL_VENDOR_ARTIFACT.distIntegrity)
  if (!integrity.ok) fail(`acquired artifact integrity is ${integrity.actual}, pin is ${GOAL_VENDOR_ARTIFACT.distIntegrity}`)
  const artifactEntries = extractEntries(artifactBytes)
  const upstreamLicense = artifactEntries.find((entry) => entry.path === GOAL_VENDOR_LICENSE)
  if (upstreamLicense === undefined) fail("acquired artifact carries no LICENSE")
  fs.writeFileSync(path.join(sourceDir, GOAL_VENDOR_LICENSE), upstreamLicense.bytes, { mode: 0o644 })

  const { entries: closureEntries, sha256 } = closureDigests(sourceDir)
  const artifact = { ...GOAL_VENDOR_ARTIFACT, tarballSha256: sha256Hex(artifactBytes) }
  const closure = GOAL_VENDOR_CLOSURE.map((pinned) => {
    const record = { ...pinned, sha256: sha256[pinned.name] }
    return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
  })
  const notice = renderGoalVendorNotice(artifact, closure)
  fs.writeFileSync(path.join(sourceDir, GOAL_VENDOR_NOTICE), notice, { mode: 0o644 })
  const pin = {
    schema: GOAL_VENDOR_SCHEMA,
    artifact,
    closure,
    digests: {
      artifactTree: digestOfEntries(artifactEntries),
      closureTree: digestOfEntries(closureEntries),
      notice: sha256Hex(Buffer.from(notice, "utf8")),
    },
  }
  fs.writeFileSync(
    path.join(sourceDir, GOAL_VENDOR_MANIFEST),
    `${JSON.stringify(pin, null, 2)}\n`,
    { mode: 0o644 },
  )
  return verifyGoalVendor({ sourceDir })
}

function parseCliArgs(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith("--")) continue
    const key = token.slice(2)
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

async function acquireClosure(sourceDir) {
  const { download } = await import("./goal-vendor-fetch.mjs")
  fs.mkdirSync(path.join(sourceDir, "tarballs"), { recursive: true, mode: 0o700 })
  for (const pinned of GOAL_VENDOR_CLOSURE) {
    const target = path.join(sourceDir, pinned.tarball)
    const bytes = await download(pinned)
    const integrity = verifyIntegrity(bytes, pinned.integrity)
    if (!integrity.ok) fail(`acquired ${pinned.name} integrity is ${integrity.actual}`)
    fs.writeFileSync(target, bytes)
    process.stdout.write(`acquired ${pinned.name}@${pinned.version}\n`)
  }
}

async function main(argv) {
  const [command = "verify", ...rest] = argv
  const flags = parseCliArgs(rest)
  const sourceRoot = path.resolve(flags["source-root"] ?? path.join(fileURLToPath(import.meta.url), "../../.."))
  const sourceDir = path.resolve(flags.source ?? goalVendorSourceDir(sourceRoot))
  if (command === "verify") {
    const verified = verifyGoalVendor({ sourceDir })
    process.stdout.write(`${JSON.stringify({ ok: true, artifact: `${verified.artifact.name}@${verified.artifact.version}`, closure: verified.closure.length, digests: verified.digests })}\n`)
    return 0
  }
  if (command === "seal") {
    const verified = writeGoalVendor({ sourceDir, artifactTarball: typeof flags["artifact-tarball"] === "string" ? flags["artifact-tarball"] : undefined })
    process.stdout.write(`${JSON.stringify({ ok: true, sealed: sourceDir, digests: verified.digests })}\n`)
    return 0
  }
  if (command === "acquire") {
    await acquireClosure(sourceDir)
    return 0
  }
  if (command === "materialize") {
    const runtimeDir = path.resolve(String(flags.out ?? ""))
    if (runtimeDir === "") fail("materialize requires --out <runtimeDir>")
    const result = materializeGoalVendor({ sourceRoot, runtimeDir, sourceDir })
    process.stdout.write(`${JSON.stringify({ ok: true, dir: result.dir, engineEntry: result.engineEntry, treeDigest: result.treeDigest })}\n`)
    return 0
  }
  process.stderr.write(`unknown command: ${command}\nusage: rigel-v2-goal-vendor.mjs verify|acquire|seal|materialize [--source-root <repo>] [--source <vendorDir>] [--out <runtimeDir>] [--artifact-tarball <tgz>]\n`)
  return 2
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
