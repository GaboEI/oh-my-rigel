/**
 * The durability half of a settings write: the 0600 backup taken before a real
 * change, and the rollback that puts the previous bytes back.
 *
 * The contract is deliberately strict. A backup that cannot be created is a
 * REFUSAL, not a warning: a settings edit without a restore point is not
 * allowed. A rollback restores from the bytes read before the write (not from
 * the backup) so a partially readable backup cannot corrupt the restore, and it
 * removes the backup it discards so a rolled-back edit leaves no trace.
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
 * file at all when the writer created it. The backup is discarded either way.
 */
export function restorePreviousBytes({ fileSystem, filePath, existed, originalText, backupPath, mode = 0o600 }) {
  discardSettingBackup({ fileSystem, backupPath })
  if (existed) {
    writeTextAtomic({ fileSystem, filePath, text: originalText, mode })
    return
  }
  removeJsoncFile({ fileSystem, filePath })
}
