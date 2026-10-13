/**
 * Deterministic, dependency-free tarball codec for the pinned goal vendor.
 *
 * The npm registry publishes every tarball as a plain `ustar` archive whose
 * entries are regular files owned by `0/0` with a normalised mtime, so a small
 * reader is enough and gives something a platform `tar` binary cannot: an
 * extraction that is byte-identical on every OS and that fails closed on any
 * entry shape it does not understand.
 *
 * Boundary: read-only over the caller's files; never touches the network, V1,
 * or the laboratory. Used only by the goal vendorizer.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"

const BLOCK = 512
const NAME_FIELD = [0, 100]
const SIZE_FIELD = [124, 136]
const TYPE_FIELD = 156
const MAGIC_FIELD = [257, 263]
const PREFIX_FIELD = [345, 500]
const USTAR_MAGICS = new Set(["ustar\u0000", "ustar  "])

export function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex")
}

export function sha512Base64(bytes) {
  return crypto.createHash("sha512").update(bytes).digest("base64")
}

/**
 * Verify raw bytes against a Subresource-Integrity string such as
 * `sha512-<base64>`. Only the algorithms the registry actually publishes are
 * accepted; anything else is a hard failure rather than a silent pass.
 */
export function verifyIntegrity(bytes, integrity, { sha256 = null } = {}) {
  if (typeof integrity !== "string" || !integrity.includes("-")) {
    throw new Error(`unusable integrity string: ${String(integrity)}`)
  }
  const separator = integrity.indexOf("-")
  const algorithm = integrity.slice(0, separator)
  const expected = integrity.slice(separator + 1)
  if (algorithm !== "sha512") throw new Error(`unsupported integrity algorithm: ${algorithm}`)
  const actual = sha512Base64(bytes)
  if (actual !== expected) return { ok: false, actual: `${algorithm}-${actual}`, expected: integrity }
  if (sha256 !== null && sha256Hex(bytes) !== sha256) {
    return { ok: false, actual: `sha256-${sha256Hex(bytes)}`, expected: `sha256-${sha256}` }
  }
  return { ok: true, actual: integrity, expected: integrity }
}

function field(header, [start, end]) {
  return header.subarray(start, end).toString("binary")
}

function readCString(header, [start, end]) {
  const raw = field(header, [start, end])
  const end0 = raw.indexOf("\u0000")
  return (end0 === -1 ? raw : raw.slice(0, end0)).trim()
}

function readOctal(header, [start, end], label) {
  const raw = readCString(header, [start, end])
  if (raw === "") return 0
  if (!/^[0-7]+$/.test(raw)) throw new Error(`tar ${label} is not octal: ${JSON.stringify(raw)}`)
  return Number.parseInt(raw, 8)
}

function assertSafeEntryPath(entryPath) {
  if (entryPath.length === 0) throw new Error("tar entry has an empty name")
  if (entryPath.startsWith("/")) throw new Error(`tar entry is absolute: ${entryPath}`)
  const segments = entryPath.split("/")
  if (segments.some((segment) => segment === ".." || segment === ".")) {
    throw new Error(`tar entry escapes its root: ${entryPath}`)
  }
  if (entryPath.includes("\\")) throw new Error(`tar entry uses a non-portable separator: ${entryPath}`)
}

/**
 * Decompress and parse a gzipped ustar archive. Every entry is validated before
 * any byte is handed back, so an unexpected archive shape is a loud failure.
 */
export function readTarEntries(tgzBytes) {
  const archive = zlib.gunzipSync(tgzBytes)
  const entries = []
  let offset = 0
  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK)
    if (header.every((byte) => byte === 0)) break
    const magic = field(header, MAGIC_FIELD)
    if (!USTAR_MAGICS.has(magic)) throw new Error(`tar entry is not ustar: magic=${JSON.stringify(magic)}`)
    const type = String.fromCharCode(header[TYPE_FIELD])
    const prefix = readCString(header, PREFIX_FIELD)
    const name = readCString(header, NAME_FIELD)
    const entryPath = prefix.length > 0 ? `${prefix}/${name}` : name
    const size = readOctal(header, SIZE_FIELD, "size")
    const bodyStart = offset + BLOCK
    const bodyEnd = bodyStart + size
    if (bodyEnd > archive.length) throw new Error(`tar entry is truncated: ${entryPath}`)
    offset = bodyStart + Math.ceil(size / BLOCK) * BLOCK
    if (type === "5") continue
    if (type !== "0" && type !== "\u0000") {
      throw new Error(`tar entry type "${type}" is not supported by the deterministic reader: ${entryPath}`)
    }
    assertSafeEntryPath(entryPath)
    entries.push({ path: entryPath, bytes: Buffer.from(archive.subarray(bodyStart, bodyEnd)), execute: (readOctal(header, [100, 108], "mode") & 0o111) !== 0 })
  }
  return entries
}

/**
 * Strip a required archive root (`package/` for npm tarballs) and return entries
 * sorted by relative path so every consumer sees one deterministic order.
 */
export function extractEntries(tgzBytes, { strip = "package/" } = {}) {
  const entries = []
  for (const entry of readTarEntries(tgzBytes)) {
    if (!entry.path.startsWith(strip)) {
      throw new Error(`tar entry is outside the required archive root ${strip}: ${entry.path}`)
    }
    const relative = entry.path.slice(strip.length)
    if (relative.length === 0) continue
    entries.push({ path: relative, bytes: entry.bytes, execute: entry.execute })
  }
  return entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

/**
 * Content-only digest over an explicit entry list: paths, sizes and bytes, with
 * no mtime, uid/gid or ordering influence, so the same archive digests the same
 * on every machine. Bare sha256 hex, matching the installer's `treeDigest`
 * convention so one manifest never mixes digest formats.
 */
export function digestOfEntries(entries) {
  const hash = crypto.createHash("sha256")
  for (const entry of entries) {
    hash.update(`${entry.path}\u0000${entry.bytes.length}\u0000`)
    hash.update(entry.bytes)
    hash.update("\n")
  }
  return hash.digest("hex")
}

/** Content-only digest of a directory tree, in the same shape as `digestOfEntries`. */
export function digestOfDirectory(root) {
  const entries = []
  const walk = (directory, prefix) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name)
      const relative = prefix === "" ? name : `${prefix}/${name}`
      if (fs.statSync(absolute).isDirectory()) walk(absolute, relative)
      else entries.push({ path: relative, bytes: fs.readFileSync(absolute) })
    }
  }
  walk(root, "")
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return digestOfEntries(entries)
}
