/**
 * Crash/fault-safe transaction primitive for the Rigel V2 user lifecycle.
 *
 * `install`, `upgrade`, `rollback` and `uninstall` mutate three shared files -
 * the OpenCode config (`opencode.json`), the companion CLI config (`cli.json`)
 * and the install state (`install-state.json`) - plus the versioned runtime
 * tree. A crash between those writes would otherwise leave config and state
 * desynchronised (for example: `opencode.json` pointing at a version the state
 * file does not record, or a half-materialised version directory).
 *
 * This module makes every such operation compensating: the three files are
 * snapshotted byte for byte before the first write, any version directory the
 * operation creates is tracked, any directory the operation replaces is moved
 * aside and restorable, and on any thrown error the files are restored
 * byte-identically, the created directories are removed and the replaced
 * directories are put back. Writes go through
 * {@link writeTextAtomic} (unique temp file, fsync, rename, fsync parent), so a
 * single file is never observed half-written.
 *
 * Fault injection: when `RIGEL_V2_FAIL_AT` names a boundary, {@link failAt}
 * throws exactly there. It is inert otherwise. This is the documented QA seam
 * the lifecycle contract uses to prove restoration at every boundary; it never
 * changes behavior in a normal run.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export const FAIL_AT_ENV = "RIGEL_V2_FAIL_AT"

function fsyncDirectory(directory) {
  let fd
  try {
    fd = fs.openSync(directory, "r")
    fs.fsyncSync(fd)
  } catch {
    /* best-effort: a directory fsync is a durability nicety, not a correctness gate */
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** Write `text` atomically: unique temp file, fsync, rename over the target, fsync parent. */
export function writeTextAtomic(file, text, { mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`
  const fd = fs.openSync(temp, "w", mode)
  try {
    fs.writeFileSync(fd, text)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(temp, file)
  fsyncDirectory(path.dirname(file))
}

/** Serialise `value` and write it atomically with the same trailing-newline shape as the rest of the kit. */
export function writeJsonAtomic(file, value, { mode = 0o600 } = {}) {
  writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`, { mode })
}

/** Read every target's bytes (or `null` when it does not exist) for a later byte-identical restore. */
export function snapshotFiles(files) {
  const snapshot = new Map()
  for (const file of files) {
    snapshot.set(file, fs.existsSync(file) ? fs.readFileSync(file) : null)
  }
  return snapshot
}

/** Restore snapshotted bytes; a `null` snapshot means the file did not exist and is removed. */
export function restoreFiles(snapshot) {
  for (const [file, bytes] of snapshot) {
    if (bytes === null) {
      try { fs.rmSync(file, { force: true }) } catch { /* already absent */ }
      continue
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, bytes, { mode: 0o600 })
  }
}

/** Throw when `RIGEL_V2_FAIL_AT` names this boundary; inert otherwise. */
export function failAt(name) {
  if (process.env[FAIL_AT_ENV] === name) {
    throw new Error(`injected failure at ${name}`)
  }
}

/**
 * Open a compensating transaction over `files`. The caller runs the mutations,
 * calls `txn.failAt("<boundary>")` where a fault may be injected, tracks any
 * directory it creates with `txn.trackCreatedDir(dir)`, and ends with
 * `txn.commit()` on success. On any throw it must call `txn.rollback()` (or let
 * the caller's `lifecycle()` helper do it) so the files are restored
 * byte-identically and every created directory is removed.
 */
export function beginLifecycleTransaction({ files }) {
  const snapshot = snapshotFiles(files)
  const createdDirs = []
  const replacedDirs = []
  let settled = false
  return {
    failAt,
    writeJsonAtomic,
    writeTextAtomic,
    trackCreatedDir(dir) {
      if (!fs.existsSync(dir)) createdDirs.push(dir)
    },
    /**
     * Move an existing directory aside so a fresh tree can be materialised in its
     * place without inheriting files a previous operation wrote (for example a
     * runtime module retired by a same-version reinstall). The move is recorded:
     * on rollback the fresh tree is removed and the original is renamed back
     * byte-identically, and on commit the aside copy is discarded. A directory
     * that does not exist is a no-op, so a clean install tracks nothing here.
     */
    trackReplacedDir(dir) {
      if (!fs.existsSync(dir)) return
      const backup = `${dir}.txn-${crypto.randomBytes(6).toString("hex")}`
      fs.renameSync(dir, backup)
      replacedDirs.push({ dir, backup })
    },
    commit() {
      settled = true
      for (const { backup } of replacedDirs) {
        try { fs.rmSync(backup, { recursive: true, force: true }) } catch { /* best-effort */ }
      }
    },
    rollback() {
      if (settled) return
      settled = true
      restoreFiles(snapshot)
      for (const dir of [...createdDirs].reverse()) {
        try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
      }
      for (const { dir, backup } of [...replacedDirs].reverse()) {
        try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
        try { fs.renameSync(backup, dir) } catch { /* best-effort */ }
      }
    },
  }
}
