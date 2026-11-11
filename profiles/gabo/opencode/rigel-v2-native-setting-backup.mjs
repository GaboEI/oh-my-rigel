/**
 * The durability half of a settings write: the 0600 backup taken before a real
 * change, and the rollback that puts the previous bytes back.
 *
 * The contract is deliberately strict. A backup that cannot be created is a
 * REFUSAL, not a warning: a settings edit without a restore point is not
 * allowed. A rollback restores from the bytes read before the write (not from
 * the backup) so a partially readable backup cannot corrupt the restore. The
 * backup is removed only AFTER the restore has landed, so a restore that fails
 * keeps its own restore point and reports it: a failed edit must never end with
 * a modified config and no way back.
 */
import { removeJsoncFile, writeTextAtomic } from "./rigel-v2-native-jsonc-write.mjs"
import { SETTING_WRITE_ERRORS, SettingWriteError } from "./rigel-v2-native-setting-errors.mjs"

function backupCandidate({ filePath, now, attempt }) {
  const stamp = (typeof now === "function" ? now() : new Date()).toISOString().replace(/[:.]/g, "-")
  return attempt === 0 ? `${filePath}.bak.${stamp}` : `${filePath}.bak.${stamp}.${attempt}`
}

/** Copy `text` to a sibling backup at mode 0600, never replacing an existing one. */
export function createSettingBackup({ fileSystem, filePath, text, now, mode = 0o600 }) {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const candidate = backupCandidate({ filePath, now, attempt })
    try {
      fileSystem.writeFileSync(candidate, text, { encoding: "utf-8", mode, flag: "wx" })
      return candidate
    } catch (error) {
      if (Reflect.get(error ?? {}, "code") === "EEXIST") continue
      const reason = error instanceof Error ? error.message : String(error)
      throw new SettingWriteError(SETTING_WRITE_ERRORS.BACKUP_FAILED, `could not back up ${filePath}: ${reason}`, { path: filePath, cause: error })
    }
  }
  throw new SettingWriteError(SETTING_WRITE_ERRORS.BACKUP_FAILED, `could not allocate a backup path for ${filePath}`, { path: filePath })
}

/** Drop a backup whose edit no longer needs one; a missing backup is not an error. */
export function discardSettingBackup({ fileSystem, backupPath }) {
  if (backupPath === null || backupPath === undefined) return
  try {
    removeJsoncFile({ fileSystem, filePath: backupPath })
  } catch { /* cleanup must never mask the failure that triggered it */ }
}

/**
 * Restore the pre-write state: the previous bytes when the file existed, or no
 * file at all when the writer created it.
 *
 * The backup is discarded only after the restore has landed. If the restore
 * itself fails, the backup is deliberately KEPT and the failure is a coded
 * `ROLLBACK_FAILED` that reports the kept path and the still-modified state, so
 * a caller can never report a rollback that did not happen.
 */
export function restorePreviousBytes({ fileSystem, filePath, existed, originalText, backupPath, mode = 0o600 }) {
  try {
    if (existed) {
      writeTextAtomic({ fileSystem, filePath, text: originalText, mode })
    } else {
      removeJsoncFile({ fileSystem, filePath })
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const kept = backupPath === null || backupPath === undefined ? "no backup was available" : `the backup was kept at ${backupPath}`
    throw new SettingWriteError(
      SETTING_WRITE_ERRORS.ROLLBACK_FAILED,
      `could not restore ${filePath} (${kept}): ${reason}`,
      { path: filePath, backupPath: backupPath ?? null, restored: false, configModified: true, cause: error },
    )
  }
  discardSettingBackup({ fileSystem, backupPath })
}
