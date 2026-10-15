/**
 * Self-contained ast-grep runtime helpers for the Gabo profile tree (C1).
 *
 * WHY THIS EXISTS. The shipped `profiles/gabo` tree runs outside the monorepo -
 * in a source install, or in a published package that does NOT ship
 * `packages/utils` - so its ast-grep consumers must not depend on the bare
 * `@oh-my-opencode/utils` specifier that only the workspace can resolve. This
 * module is a deliberate, documented copy of the four pieces the ast-grep
 * provisioning path needs from `packages/utils/src/ast-grep/`: `sg-manifest`
 * (pin + slug rules + binary name), `sg-provisioner` (the download/verify/extract
 * strategy), and `install-script`'s `astGrepRuntimeDir`.
 *
 * The strategy and the behaviour are identical: a single pin
 * (`SG_PINNED_VERSION` + per-platform sha256), verified before the binary is
 * written, with the same zip handling and the same target path. A parity test
 * (`rigel-v2-ast-grep-runtime.parity.test.mjs`) pins this copy to the
 * `packages/utils` surface so the manifest or the slug rules cannot drift
 * silently. Everything else stays in `packages/utils`; nothing else is copied.
 */
import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { inflateRawSync } from "node:zlib"

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000
const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const ZIP64_SENTINEL = 0xffffffff

export const SG_PINNED_VERSION = "0.43.0"

export const SG_RELEASE_ASSETS = {
  "darwin-arm64": {
    sha256: "8c847d0a29aa4b3101b3361e0b3ee7fb53c7e497adc9ed1afc9615538cd40782",
    url: "https://github.com/ast-grep/ast-grep/releases/download/0.43.0/app-aarch64-apple-darwin.zip",
  },
  "darwin-x64": {
    sha256: "6d703090b106747b2f56086b6ccc7e798fe78bcae70257aa20519b220153555b",
    url: "https://github.com/ast-grep/ast-grep/releases/download/0.43.0/app-x86_64-apple-darwin.zip",
  },
  "linux-arm64": {
    sha256: "e706846148493967f3ab8011334817edd86ce5acbec10718b2a7b40799c640ff",
    url: "https://github.com/ast-grep/ast-grep/releases/download/0.43.0/app-aarch64-unknown-linux-gnu.zip",
  },
  "linux-x64": {
    sha256: "a26253a9c821d935f7e383e40f0de7c2ca62a4121de1f73a6d81ec32eae631e0",
    url: "https://github.com/ast-grep/ast-grep/releases/download/0.43.0/app-x86_64-unknown-linux-gnu.zip",
  },
  "win32-arm64": {
    sha256: "a519fdd90324bf6858fde2d3feb2b862d67b834dc11af8f5b6c2c8143ab6a6c5",
    url: "https://github.com/ast-grep/ast-grep/releases/download/0.43.0/app-aarch64-pc-windows-msvc.zip",
  },
  "win32-x64": {
    sha256: "a4febbc8c48671e5729d85e29e4ebe5a051b7250d19545bca18e725ccf40ef61",
    url: "https://github.com/ast-grep/ast-grep/releases/download/0.43.0/app-x86_64-pc-windows-msvc.zip",
  },
}

export function normalizeRuntimePlatform(platform = process.platform) {
  if (platform === "darwin" || platform === "linux" || platform === "win32") return platform
  return "linux"
}

export function normalizeRuntimeArch(arch = process.arch) {
  if (arch === "arm64" || arch === "aarch64") return "arm64"
  return "x64"
}

export function runtimeSlug(platform = process.platform, arch = process.arch) {
  return `${normalizeRuntimePlatform(platform)}-${normalizeRuntimeArch(arch)}`
}

export function sgBinaryName(platform = process.platform) {
  return normalizeRuntimePlatform(platform) === "win32" ? "sg.exe" : "sg"
}

/** `<baseDir>/runtime/ast-grep/<slug>` - the path the resolver probes. */
export function astGrepRuntimeDir(baseDir, platform = process.platform, arch = process.arch) {
  return join(baseDir, "runtime", "ast-grep", runtimeSlug(platform, arch))
}

export class SgProvisionError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = "SgProvisionError"
    this.code = code
  }
}

function describeFailure(error) {
  return error instanceof Error ? error.message : String(error)
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function timeoutSignal(signal) {
  const timeout = AbortSignal.timeout(DEFAULT_DOWNLOAD_TIMEOUT_MS)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

async function downloadAsset(url, fetchImpl, signal) {
  const activeFetch = fetchImpl ?? globalThis.fetch
  let response
  try {
    response = await activeFetch(url, { signal })
  } catch (error) {
    throw new SgProvisionError("download_failed", `failed to download ast-grep ${SG_PINNED_VERSION} from ${url}: ${describeFailure(error)}`, { cause: error })
  }
  if (!response.ok) {
    throw new SgProvisionError("download_failed", `failed to download ast-grep ${SG_PINNED_VERSION} from ${url}: HTTP ${response.status}`)
  }
  try {
    return Buffer.from(await response.arrayBuffer())
  } catch (error) {
    throw new SgProvisionError("download_failed", `failed to read ast-grep ${SG_PINNED_VERSION} download from ${url}: ${describeFailure(error)}`, { cause: error })
  }
}

function zipEntryBaseName(entryName) {
  const segments = entryName.split("/")
  return segments[segments.length - 1] ?? entryName
}

function findEndOfCentralDirectory(zip) {
  const lowestOffset = Math.max(0, zip.length - 22 - 65_535)
  for (let offset = zip.length - 22; offset >= lowestOffset; offset -= 1) {
    if (zip.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  throw new SgProvisionError("extract_failed", "downloaded ast-grep asset is not a zip archive")
}

function listZipEntries(zip) {
  const eocdOffset = findEndOfCentralDirectory(zip)
  const entryCount = zip.readUInt16LE(eocdOffset + 10)
  let cursor = zip.readUInt32LE(eocdOffset + 16)
  const entries = []
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > zip.length || zip.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new SgProvisionError("extract_failed", "downloaded ast-grep zip central directory is corrupt")
    }
    const nameLength = zip.readUInt16LE(cursor + 28)
    const extraLength = zip.readUInt16LE(cursor + 30)
    const commentLength = zip.readUInt16LE(cursor + 32)
    entries.push({
      compressedSize: zip.readUInt32LE(cursor + 20),
      localHeaderOffset: zip.readUInt32LE(cursor + 42),
      method: zip.readUInt16LE(cursor + 10),
      name: zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8"),
      uncompressedSize: zip.readUInt32LE(cursor + 24),
    })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function decompressZipEntry(raw, entry) {
  if (entry.method === 0) return Buffer.from(raw)
  if (entry.method === 8) return inflateRawSync(raw)
  throw new SgProvisionError("extract_failed", `ast-grep zip entry ${entry.name} uses unsupported compression method ${entry.method}`)
}

function readZipEntryBytes(zip, entry) {
  if (entry.compressedSize === ZIP64_SENTINEL || entry.uncompressedSize === ZIP64_SENTINEL || entry.localHeaderOffset === ZIP64_SENTINEL) {
    throw new SgProvisionError("extract_failed", `ast-grep zip entry ${entry.name} uses unsupported zip64 extensions`)
  }
  if (zip.readUInt32LE(entry.localHeaderOffset) !== LOCAL_SIGNATURE) {
    throw new SgProvisionError("extract_failed", `ast-grep zip entry ${entry.name} has a corrupt local header`)
  }
  const nameLength = zip.readUInt16LE(entry.localHeaderOffset + 26)
  const extraLength = zip.readUInt16LE(entry.localHeaderOffset + 28)
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength
  const bytes = decompressZipEntry(zip.subarray(dataStart, dataStart + entry.compressedSize), entry)
  if (bytes.length !== entry.uncompressedSize) {
    throw new SgProvisionError("extract_failed", `ast-grep zip entry ${entry.name} inflated to ${bytes.length} bytes, expected ${entry.uncompressedSize}`)
  }
  return bytes
}

function extractStandaloneSgBinary(zip, platform) {
  const suffix = platform === "win32" ? ".exe" : ""
  const entries = listZipEntries(zip)
  const preferredNames = [`ast-grep${suffix}`, `sg${suffix}`]
  for (const preferred of preferredNames) {
    const entry = entries.find((candidate) => zipEntryBaseName(candidate.name) === preferred)
    if (entry !== undefined) return readZipEntryBytes(zip, entry)
  }
  throw new SgProvisionError("extract_failed", `ast-grep release zip has no standalone ${preferredNames.join(" or ")} binary`)
}

function assertInsideTarget(targetDir, filePath) {
  const relativePath = relative(targetDir, filePath)
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new SgProvisionError("write_failed", `refusing to write ast-grep binary outside targetDir: ${filePath}`)
  }
}

/**
 * Provision `sg` into `options.targetDir`. Identical byte-for-byte behaviour to
 * `provisionSgBinary` in `packages/utils/src/ast-grep/sg-provisioner.ts`: resolve
 * the slug, pick the pinned asset (or an injected one for offline runs), download,
 * verify sha256, extract the standalone binary, chmod 0755, and rename it into
 * place. Returns the destination path.
 */
export async function provisionSgBinary(options) {
  const platform = options.platform ?? process.platform
  const slug = runtimeSlug(platform, options.arch ?? process.arch)
  const asset = options.releaseAssets?.[slug] ?? SG_RELEASE_ASSETS[slug]
  if (asset === undefined) {
    throw new SgProvisionError("unsupported_platform", `ast-grep ${SG_PINNED_VERSION} has no asset for ${slug}`)
  }
  const targetDir = resolve(options.targetDir)
  const destination = join(targetDir, sgBinaryName(platform))
  const tempPath = join(targetDir, `.sg-${randomUUID().slice(0, 8)}.partial`)
  assertInsideTarget(targetDir, destination)
  assertInsideTarget(targetDir, tempPath)

  try {
    await mkdir(targetDir, { recursive: true })
    const archive = await downloadAsset(asset.url, options.fetchImpl, timeoutSignal(options.signal))
    const actualSha256 = sha256(archive)
    if (actualSha256 !== asset.sha256) {
      throw new SgProvisionError("bad_checksum", `checksum mismatch for ${basename(asset.url)}: expected ${asset.sha256}, got ${actualSha256}`)
    }
    await writeFile(tempPath, extractStandaloneSgBinary(archive, platform))
    await chmod(tempPath, 0o755)
    await rename(tempPath, destination)
    return destination
  } catch (error) {
    await rm(tempPath, { force: true })
    if (error instanceof SgProvisionError) throw error
    throw new SgProvisionError("write_failed", `failed to provision ast-grep ${SG_PINNED_VERSION} into ${targetDir}: ${describeFailure(error)}`, { cause: error })
  }
}
