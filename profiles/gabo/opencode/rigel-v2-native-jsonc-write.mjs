/**
 * The one file-system boundary of the native V2 settings writer.
 *
 * Three properties matter here and they are the reason this module exists
 * instead of inline `fs` calls at the call site:
 *
 * 1. EVERYTHING IS INJECTED. `env`, `home`, `directory`, and the file system are
 *    parameters. Nothing in this module calls `os.homedir()` or reads
 *    `process.env`, so a test can drive it against a sandbox and the live
 *    installation can never be touched by accident.
 * 2. A WRITE IS NEVER PARTIAL. `writeTextAtomic` writes a unique temp file in
 *    the target directory, fsyncs it, renames it over the target, then fsyncs
 *    the directory. A failure before the rename removes the temp file, so the
 *    target is either the old bytes or the new bytes.
 * 3. A SYMLINK IS REFUSED. A settings edit must not be retargeted by a symlink
 *    planted at the config file or at the `.omo` directory that holds it.
 *
 * The JSONC text engine is `./rigel-v2-native-jsonc-parse.mjs` (parsing,
 * formatting, rendering) and `./rigel-v2-native-jsonc-edit.mjs` (splicing); this
 * module owns bytes, envelopes, symlinks, and errors only.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {
  DEFAULT_JSONC_FORMAT,
  detectJsoncFormat,
  parseJsoncDocument,
  serializeJsoncDocument,
} from "./rigel-v2-native-jsonc-parse.mjs"

const BOM = "\ufeff"

/** Structured, stable error codes the command layer maps to localized text. */
export const JSONC_WRITE_ERRORS = Object.freeze({
  READ_FAILED: "JSONC_READ_FAILED",
  WRITE_FAILED: "JSONC_WRITE_FAILED",
  PARSE_FAILED: "JSONC_PARSE_FAILED",
  SYMLINK_TARGET: "JSONC_SYMLINK_TARGET",
  SYMLINK_DIRECTORY: "JSONC_SYMLINK_DIRECTORY",
})

export class JsoncWriteError extends Error {
  constructor(code, message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = "JsoncWriteError"
    this.code = code
    this.details = details
  }
}

/** The exact file-system surface this module needs, injected by the caller. */
export const DEFAULT_JSONC_FILE_SYSTEM = Object.freeze({
  existsSync: fs.existsSync,
  lstatSync: fs.lstatSync,
  readFileSync: (file, encoding) => fs.readFileSync(file, encoding),
  mkdirSync: fs.mkdirSync,
  openSync: fs.openSync,
  writeFileSync: fs.writeFileSync,
  fsyncSync: fs.fsyncSync,
  closeSync: fs.closeSync,
  renameSync: fs.renameSync,
  rmSync: fs.rmSync,
  realpathSync: fs.realpathSync,
})

function detail(error) {
  return error instanceof Error ? error.message : String(error)
}

function isMissing(error) {
  return error instanceof Error && Reflect.get(error, "code") === "ENOENT"
}

/** Whether `target` exists and is a symbolic link; an unknown state counts as unsafe. */
export function isSymlinkPath(target, fileSystem = DEFAULT_JSONC_FILE_SYSTEM) {
  if (typeof fileSystem.lstatSync !== "function" || !fileSystem.existsSync(target)) return false
  try {
    return fileSystem.lstatSync(target).isSymbolicLink()
  } catch (error) {
    if (isMissing(error)) return false
    // An lstat that fails for any other reason is treated as a refusal: an
    // unknown target state must never resolve to "safe to write".
    return true
  }
}

/**
 * Refuse a target that is a symlink, or that lives in a symlinked directory.
 * Returns the file path on success and throws a coded `JsoncWriteError`
 * otherwise. A missing file is safe (it is about to be created).
 */
export function assertSafeJsoncTarget({ fileSystem, filePath, directory } = {}) {
  if (typeof filePath !== "string" || filePath === "") {
    throw new JsoncWriteError(JSONC_WRITE_ERRORS.WRITE_FAILED, "a settings write requires a target path", { path: filePath })
  }
  const fsm = fileSystem ?? DEFAULT_JSONC_FILE_SYSTEM
  const parent = directory ?? path.dirname(filePath)
  if (isSymlinkPath(parent, fsm)) {
    throw new JsoncWriteError(JSONC_WRITE_ERRORS.SYMLINK_DIRECTORY, `refusing to write through symlinked directory ${parent}`, { path: filePath, directory: parent })
  }
  if (isSymlinkPath(filePath, fsm)) {
    throw new JsoncWriteError(JSONC_WRITE_ERRORS.SYMLINK_TARGET, `refusing to write through symlinked config ${filePath}`, { path: filePath })
  }
  return filePath
}

/**
 * Read and parse a JSONC document from the injected file system.
 * Never throws for a missing, unreadable, or malformed file: the caller decides.
 */
export function readJsoncFile({ fileSystem, filePath } = {}) {
  const fsm = fileSystem ?? DEFAULT_JSONC_FILE_SYSTEM
  if (typeof fsm.existsSync !== "function" || !fsm.existsSync(filePath)) {
    return { ok: true, exists: false, path: filePath, text: "", value: {}, format: { ...DEFAULT_JSONC_FORMAT }, reason: undefined }
  }
  let text
  try {
    text = fsm.readFileSync(filePath, "utf-8")
  } catch (error) {
    return { ok: false, exists: true, path: filePath, text: "", value: null, format: { ...DEFAULT_JSONC_FORMAT }, reason: detail(error) }
  }
  const format = detectJsoncFormat(text)
  const parsed = parseJsoncDocument(text)
  if (!parsed.ok) {
    return { ok: false, exists: true, path: filePath, text, value: null, format, reason: parsed.reason, offset: parsed.offset }
  }
  return { ok: true, exists: true, path: filePath, text, value: parsed.value, root: parsed.root, format, reason: undefined }
}

/** Re-apply the document envelope a splice cannot carry: a leading BOM. */
export function applyJsoncEnvelope(text, format = DEFAULT_JSONC_FORMAT) {
  const source = typeof text === "string" ? text : ""
  const wantsBom = format?.bom === true
  const hasBom = source.charCodeAt(0) === 0xfeff
  if (wantsBom && !hasBom) return `${BOM}${source}`
  if (!wantsBom && hasBom) return source.slice(1)
  return source
}

/** Render a brand-new document with an explicit envelope (creation only). */
export function renderJsoncDocument({ value, format } = {}) {
  return serializeJsoncDocument({ value, format: { ...DEFAULT_JSONC_FORMAT, ...(format ?? {}) } })
}

/**
 * Atomic single-file write: unique temp file in the target directory, fsync, rename
 * over the target, then a best-effort directory fsync. Any failure before the
 * rename removes the temp file so the target is never observed half-written.
 */
export function writeTextAtomic({ fileSystem, filePath, text, mode = 0o600 } = {}) {
  const fsm = fileSystem ?? DEFAULT_JSONC_FILE_SYSTEM
  const directory = path.dirname(filePath)
  const temp = `${filePath}.tmp-${crypto.randomBytes(6).toString("hex")}`
  try {
    fsm.mkdirSync(directory, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new JsoncWriteError(JSONC_WRITE_ERRORS.WRITE_FAILED, `could not create ${directory}: ${detail(error)}`, { path: filePath, operation: "mkdir", cause: error })
  }
  let fd
  try {
    fd = fsm.openSync(temp, "w", mode)
    fsm.writeFileSync(fd, text)
    fsm.fsyncSync(fd)
  } catch (error) {
    if (fd !== undefined) { try { fsm.closeSync(fd) } catch { /* already closed */ } }
    try { fsm.rmSync(temp, { force: true }) } catch { /* nothing to remove */ }
    throw new JsoncWriteError(JSONC_WRITE_ERRORS.WRITE_FAILED, `could not write ${filePath}: ${detail(error)}`, { path: filePath, operation: "write", cause: error })
  }
  try {
    fsm.closeSync(fd)
    fsm.renameSync(temp, filePath)
  } catch (error) {
    try { fsm.rmSync(temp, { force: true }) } catch { /* nothing to remove */ }
    throw new JsoncWriteError(JSONC_WRITE_ERRORS.WRITE_FAILED, `could not replace ${filePath}: ${detail(error)}`, { path: filePath, operation: "rename", cause: error })
  }
  let directoryFd
  try {
    directoryFd = fsm.openSync(directory, "r")
    fsm.fsyncSync(directoryFd)
  } catch { /* a directory fsync is a durability nicety, not a correctness gate */ } finally {
    if (directoryFd !== undefined) { try { fsm.closeSync(directoryFd) } catch { /* already closed */ } }
  }
  return filePath
}

/** Write a JSONC document atomically, restoring the envelope the caller detected. */
export function writeJsoncTextAtomic({ fileSystem, filePath, text, format, mode = 0o600 } = {}) {
  return writeTextAtomic({ fileSystem, filePath, text: applyJsoncEnvelope(text, format), mode })
}

/** Remove a file the writer created, tolerating an already-absent target. */
export function removeJsoncFile({ fileSystem, filePath } = {}) {
  const fsm = fileSystem ?? DEFAULT_JSONC_FILE_SYSTEM
  try {
    fsm.rmSync(filePath, { force: true })
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw new JsoncWriteError(JSONC_WRITE_ERRORS.WRITE_FAILED, `could not remove ${filePath}: ${detail(error)}`, { path: filePath, operation: "remove", cause: error })
  }
}
