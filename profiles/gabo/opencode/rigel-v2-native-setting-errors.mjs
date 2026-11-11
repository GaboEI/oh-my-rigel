/**
 * The stable error contract of the native V2 settings writer.
 *
 * The writer stays language-agnostic: every message here is a diagnostic for a
 * developer, and every failure carries a stable `code` plus structured `details`
 * so the command layer can render localized text for the user without parsing
 * English. This module exists on its own so the target-resolution layer and the
 * edit layer can both refuse without importing each other.
 */
export const SETTING_WRITE_ERRORS = Object.freeze({
  MISSING_HOME: "SETTING_MISSING_HOME",
  MISSING_DIRECTORY: "SETTING_MISSING_DIRECTORY",
  MISSING_FILE_SYSTEM: "SETTING_MISSING_FILE_SYSTEM",
  CONFIRMATION_REQUIRED: "SETTING_CONFIRMATION_REQUIRED",
  AMBIGUOUS_LAYER: "SETTING_AMBIGUOUS_LAYER",
  PROJECT_LAYER_UNREADABLE: "SETTING_PROJECT_LAYER_UNREADABLE",
  TARGET_UNPARSEABLE: "SETTING_TARGET_UNPARSEABLE",
  TARGET_SHAPE_CONFLICT: "SETTING_TARGET_SHAPE_CONFLICT",
  UNKNOWN_SETTING: "SETTING_UNKNOWN_SETTING",
  UNSUPPORTED_TYPE: "SETTING_UNSUPPORTED_TYPE",
  INVALID_VALUE: "SETTING_INVALID_VALUE",
  VALUE_OUT_OF_RANGE: "SETTING_VALUE_OUT_OF_RANGE",
  EDIT_FAILED: "SETTING_EDIT_FAILED",
  BACKUP_FAILED: "SETTING_BACKUP_FAILED",
  VERIFY_FAILED: "SETTING_VERIFY_FAILED",
  SECTION_SHADOW: "SETTING_SECTION_SHADOW",
  ROLLBACK_FAILED: "SETTING_ROLLBACK_FAILED",
})

export class SettingWriteError extends Error {
  constructor(code, message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = "SettingWriteError"
    this.code = code
    this.details = details
  }
}
