/**
 * Settings-write primitives for the native V2 `/rigel_setting` surface.
 *
 * This module owns the WHOLE decision an edit needs before a byte is written,
 * and it refuses instead of guessing:
 *
 * 1. WHICH LAYER. `resolveSettingPaths` (from the targets module) reproduces the
 *    native reader's discovery, and the default target is the reader's
 *    highest-precedence placement - `profiles.<active>.[opencode]` in the USER
 *    config. A project layer that would shadow it, or a project layer that
 *    cannot be read, is a refusal rather than a write the runtime never sees.
 * 2. WHAT THE EDIT IS. `set` / `add` / `remove` are planned against INJECTED
 *    catalog metadata and validated (type, enum, range, list item), and an edit
 *    that changes nothing performs ZERO writes and creates no backup.
 * 3. HOW IT IS COMMITTED. Explicit caller confirmation, a 0600 backup of the
 *    current bytes, an atomic write, a post-write verification of the effective
 *    value read back from disk, and a rollback that restores the original bytes
 *    when that verification fails.
 *
 * Everything is injected: `env`, `home`, `directory`, and the file system. No
 * `os.homedir()`, no `process.env`, no `process.cwd()`. Every failure is a
 * `SettingWriteError` with a stable code, so the command layer can render
 * localized text without this module knowing any language.
 */
import {
  addJsoncListItem,
  readJsoncValue,
  removeJsoncListItem,
  setJsoncPath,
  unsetJsoncPath,
} from "./rigel-v2-native-jsonc-edit.mjs"
import { deepEqual, isPlainObject } from "./rigel-v2-native-jsonc-parse.mjs"
import { assertSafeJsoncTarget, JsoncWriteError, readJsoncFile, writeJsoncTextAtomic } from "./rigel-v2-native-jsonc-write.mjs"
import { createSettingBackup, discardSettingBackup, restorePreviousBytes } from "./rigel-v2-native-setting-backup.mjs"
import { SETTING_WRITE_ERRORS, SettingWriteError } from "./rigel-v2-native-setting-errors.mjs"
import { assertPlacementShape, resolveSettingTarget } from "./rigel-v2-native-setting-targets.mjs"
import { readEffectiveSetting } from "./rigel-v2-native-setting-descriptor.mjs"

const LIST_TYPES = new Set(["string-list"])

const REPLACED_SECTION_ROOTS = new Set(["monitor", "goal", "experimental", "team_mode", "default_mode"])
const HARNESS_BLOCK = "[opencode]"

function sectionShadowRefusal({ descriptor, target, layers, profileName, operation }) {
  if (operation !== "set" && operation !== "add") return null
  if (!Array.isArray(target?.placement) || target.placement[0] !== "profiles") return null
  const section = descriptor.path[0]
  if (!REPLACED_SECTION_ROOTS.has(section)) return null
  const targetSection = readJsoncValue(target.target?.text ?? "", [...target.placement, section])
  if (targetSection.found === true) return null
  const sources = []
  const placements = [[HARNESS_BLOCK], ["profiles", profileName, HARNESS_BLOCK]]
  for (const placement of placements) {
    if (placement.includes(undefined)) continue
    for (const layer of layers ?? []) {
      if (layer?.ok === false) continue
      const read = readJsoncValue(layer.text, [...placement, section])
      if (read.ok === true && read.found === true && isPlainObject(read.value)) {
        sources.push({ path: layer.path, placement, section: read.value })
      }
    }
  }
  if (sources.length === 0) return null
  return new SettingWriteError(
    SETTING_WRITE_ERRORS.SECTION_SHADOW,
    `the profile section ${section} is absent; writing only ${descriptor.path.join(".")} would replace effective sibling settings`,
    {
      section,
      requestedPath: [...target.placement, ...descriptor.path],
      targetPath: target.path,
      targetPlacement: target.placement,
      shadowedSources: sources.map(({ path, placement }) => ({ path, placement })),
      effectiveSection: sources.at(-1).section,
      profileName,
      operation,
    },
  )
}

function effectiveUnionRemovalRefusal({ options, descriptor, target, layers, profileName, planned }) {
  if (options.operation !== "remove" || descriptor.type !== "string-list" || options.catalogEntry === undefined) return null
  const projectedLayers = (layers ?? []).map((layer) => layer.path === target.path
    ? { ...layer, text: planned.text, exists: true, ok: true }
    : layer)
  const effective = readEffectiveSetting({ entry: options.catalogEntry, profileName, layers: projectedLayers })
  if (!effective.found || !Array.isArray(effective.value) || !effective.value.includes(options.value)) return null
  return new SettingWriteError(
    SETTING_WRITE_ERRORS.EFFECTIVE_UNION_REMAINS,
    `removing ${JSON.stringify(options.value)} from this layer does not release the effective denylist; another layer still contributes it`,
    { path: planned.fullPath, value: options.value, effective: effective.value, sources: effective.sources ?? [], rolledBack: false },
  )
}

/** Resolve a catalog descriptor from a `Map`, a record, or a `getSetting()` provider. */
export function resolveSettingDescriptor(catalog, key) {
  if (catalog === undefined || catalog === null) return undefined
  if (typeof catalog.getSetting === "function") return catalog.getSetting(key)
  if (catalog instanceof Map) return catalog.get(key)
  if (isPlainObject(catalog)) return catalog[key]
  return undefined
}

function requireDescriptor(descriptor) {
  if (!isPlainObject(descriptor)) {
    throw new SettingWriteError(SETTING_WRITE_ERRORS.UNKNOWN_SETTING, "no setting descriptor was supplied")
  }
  const segments = Array.isArray(descriptor.path) ? [...descriptor.path] : undefined
  const resolved = segments ?? (typeof descriptor.key === "string" && descriptor.key !== "" ? descriptor.key.split(".") : undefined)
  if (resolved === undefined || resolved.length === 0) {
    throw new SettingWriteError(SETTING_WRITE_ERRORS.UNKNOWN_SETTING, "the setting has no path")
  }
  return { ...descriptor, path: resolved }
}

function invalidValue(setting, value) {
  return new SettingWriteError(
    SETTING_WRITE_ERRORS.INVALID_VALUE,
    `${setting.path.join(".")} expects a ${setting.type} value, received ${JSON.stringify(value)}`,
    { setting: setting.path, type: setting.type },
  )
}

/** Type, enum, range, and list-item validation. A `remove` takes no value. */
export function validateSettingValue(descriptor, value) {
  const setting = requireDescriptor(descriptor)
  switch (setting.type) {
    case "boolean":
      if (typeof value !== "boolean") throw invalidValue(setting, value)
      return value
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) throw invalidValue(setting, value)
      if (setting.type === "integer" && !Number.isInteger(value)) throw invalidValue(setting, value)
      const minimum = typeof setting.minimum === "number" ? setting.minimum : undefined
      const maximum = typeof setting.maximum === "number" ? setting.maximum : undefined
      if ((minimum !== undefined && value < minimum) || (maximum !== undefined && value > maximum)) {
        throw new SettingWriteError(
          SETTING_WRITE_ERRORS.VALUE_OUT_OF_RANGE,
          `${setting.path.join(".")} must be between ${minimum ?? "-inf"} and ${maximum ?? "+inf"}`,
          { setting: setting.path, value, minimum, maximum },
        )
      }
      return value
    }
    case "string":
      if (typeof value !== "string") throw invalidValue(setting, value)
      return value
    case "enum": {
      const allowed = Array.isArray(setting.values) ? setting.values : []
      if (!allowed.includes(value)) throw invalidValue(setting, value)
      return value
    }
    case "string-list": {
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw invalidValue(setting, value)
      return [...value]
    }
    case "object":
      if (!isPlainObject(value)) throw invalidValue(setting, value)
      return value
    default:
      throw new SettingWriteError(SETTING_WRITE_ERRORS.UNSUPPORTED_TYPE, `unsupported setting type ${String(setting.type)}`, { setting: setting.path })
  }
}

function requireListItem(setting, value) {
  if (typeof value !== "string") throw invalidValue(setting, value)
  return value
}

function normalizeOperation(setting, operation) {
  const requested = operation ?? "set"
  if (requested === "set") return "set"
  if (requested === "add") {
    if (!LIST_TYPES.has(setting.type)) {
      throw new SettingWriteError(SETTING_WRITE_ERRORS.UNSUPPORTED_TYPE, "add requires a list setting", { setting: setting.path, type: setting.type })
    }
    return requested
  }
  // `remove` is valid for a list (drop one entry) and for a scalar (delete the
  // key so the catalog default applies again).
  if (requested === "remove") return requested
  throw new SettingWriteError(SETTING_WRITE_ERRORS.UNSUPPORTED_TYPE, `unsupported operation ${String(requested)}`, { setting: setting.path })
}

/**
 * The FILE-LEVEL truth after the edit. A scalar `remove` deletes the key, so the
 * file no longer carries it; the catalog default is reported separately as the
 * effective value the runtime will use.
 */
function expectAfterWrite({ descriptor, operation, value, before }) {
  if (operation === "remove" && !LIST_TYPES.has(descriptor.type)) return { found: false, value: undefined }
  if (operation === "add" || operation === "remove") {
    const base = before.found && Array.isArray(before.value) ? before.value : []
    return { found: true, value: operation === "add" ? [...base, value] : base.filter((entry) => entry !== value) }
  }
  return { found: true, value }
}

function editFailure(result) {
  return new SettingWriteError(
    SETTING_WRITE_ERRORS.EDIT_FAILED,
    `the edit could not be planned: ${result.reason}`,
    { code: result.code, reason: result.reason, offset: result.offset },
  )
}

/**
 * Plan an edit against the current text. Pure: no file system, no writes. The
 * planned result is re-read from the produced text before it is returned, so a
 * plan that does not apply exactly what was asked is refused here.
 */
export function planSettingEdit({ descriptor, operation, value, text, prefix = [] } = {}) {
  const setting = requireDescriptor(descriptor)
  const mode = normalizeOperation(setting, operation)
  const source = typeof text === "string" ? text : ""
  const fullPath = [...prefix, ...setting.path]
  const before = readJsoncValue(source, fullPath)
  if (!before.ok) throw editFailure(before)
  const applied = mode === "set"
    ? setJsoncPath(source, fullPath, validateSettingValue(setting, value))
    : mode === "add"
      ? addJsoncListItem(source, fullPath, requireListItem(setting, value))
      : LIST_TYPES.has(setting.type)
        ? removeJsoncListItem(source, fullPath, requireListItem(setting, value))
        : unsetJsoncPath(source, fullPath)
  if (!applied.ok) throw editFailure(applied)
  const expected = applied.changed
    ? expectAfterWrite({ descriptor: setting, operation: mode, value, before })
    : { found: before.found, value: before.value }
  if (applied.changed) {
    const after = readJsoncValue(applied.text, fullPath)
    const matches = expected.found ? after.found === true && deepEqual(after.value, expected.value) : after.found === false
    if (!matches) {
      throw new SettingWriteError(
        SETTING_WRITE_ERRORS.EDIT_FAILED,
        "the planned edit did not produce the expected value",
        { setting: fullPath, expected, actual: after.found ? after.value : undefined },
      )
    }
  }
  const effective = mode === "remove" && !LIST_TYPES.has(setting.type) && Object.hasOwn(setting, "default")
    ? setting.default
    : expected.found ? expected.value : undefined
  return { changed: applied.changed === true, text: applied.text, fullPath, operation: mode, before, expected, after: effective }
}

function resolveRequest(options) {
  const descriptor = requireDescriptor(options.setting ?? resolveSettingDescriptor(options.catalog, options.key))
  return { descriptor, ...resolveSettingTarget({ ...options, settingPath: descriptor.path }) }
}

/** Preview an edit: everything a commit decides, with no backup and no write. */
export function previewSettingEdit(options = {}) {
  const { descriptor, target, profileName, layers, baseText } = resolveRequest(options)
  const sectionRefusal = sectionShadowRefusal({ descriptor, target, layers, profileName, operation: options.operation })
  if (sectionRefusal !== null) throw sectionRefusal
  const planned = planSettingEdit({ descriptor, operation: options.operation, value: options.value, text: baseText, prefix: target.placement })
  const unionRemovalRefusal = effectiveUnionRemovalRefusal({ options, descriptor, target, layers, profileName, planned })
  if (unionRemovalRefusal !== null) throw unionRemovalRefusal
  return {
    ok: true,
    changed: planned.changed,
    path: target.path,
    placement: target.placement,
    fullPath: planned.fullPath,
    before: planned.before.found ? planned.before.value : undefined,
    after: planned.after,
    text: planned.text,
  }
}

/**
 * Roll back a commit that failed verification and return the error to report.
 * A restore that lands is a clean `VERIFY_FAILED` with `rolledBack: true`; a
 * restore that cannot land reports the kept backup path and the still-modified
 * state, because a caller that claims a rollback which never happened is worse
 * than useless to whoever reads the result.
 */
function verificationFailure({ fileSystem, filePath, existed, originalText, backupPath, message, details }) {
  try {
    restorePreviousBytes({ fileSystem, filePath, existed, originalText, backupPath })
  } catch (rollbackError) {
    const kept = rollbackError instanceof SettingWriteError ? (rollbackError.details.backupPath ?? null) : null
    const restorePoint = kept === null ? "no backup was available" : `the backup was kept at ${kept}`
    return new SettingWriteError(
      SETTING_WRITE_ERRORS.ROLLBACK_FAILED,
      `${message}; restoring the previous bytes also failed (${restorePoint}), so the config is still modified`,
      { ...details, path: filePath, rolledBack: false, configModified: true, backupPath: kept, cause: rollbackError, verificationCause: details.cause },
    )
  }
  return new SettingWriteError(SETTING_WRITE_ERRORS.VERIFY_FAILED, message, { ...details, path: filePath, rolledBack: true })
}

/**
 * Commit an edit. Refuses without `confirm: true`, writes nothing when the edit
 * changes nothing, backs up the current bytes at mode 0600 before a real change,
 * writes atomically, verifies the effective value read back from disk, and rolls
 * back to the previous bytes when that verification fails. The backup survives
 * the verification step and is removed only once the restore has landed.
 */
export function applySettingEdit(options = {}) {
  if (options.confirm !== true) {
    throw new SettingWriteError(SETTING_WRITE_ERRORS.CONFIRMATION_REQUIRED, "a settings write requires explicit confirmation")
  }
  const { fileSystem, now } = options
  const { descriptor, target, read, profileName, layers, baseText } = resolveRequest(options)
  const sectionRefusal = sectionShadowRefusal({ descriptor, target, layers, profileName, operation: options.operation })
  if (sectionRefusal !== null) throw sectionRefusal
  assertPlacementShape(read.value ?? {}, target.placement)
  const planned = planSettingEdit({ descriptor, operation: options.operation, value: options.value, text: baseText, prefix: target.placement })
  const unionRemovalRefusal = effectiveUnionRemovalRefusal({ options, descriptor, target, layers, profileName, planned })
  if (unionRemovalRefusal !== null) throw unionRemovalRefusal
  const result = {
    ok: true,
    changed: planned.changed,
    written: false,
    path: target.path,
    placement: target.placement,
    fullPath: planned.fullPath,
    backupPath: null,
    before: planned.before.found ? planned.before.value : undefined,
    after: planned.after,
  }
  if (!planned.changed) return result

  assertSafeJsoncTarget({ fileSystem, filePath: target.path })
  const backupFile = read.exists ? createSettingBackup({ fileSystem, filePath: target.path, text: read.text, now }) : null
  try {
    writeJsoncTextAtomic({ fileSystem, filePath: target.path, text: planned.text, format: read.format })
  } catch (error) {
    discardSettingBackup({ fileSystem, backupPath: backupFile })
    throw error
  }

  let verified
  try {
    verified = readJsoncFile({ fileSystem, filePath: target.path })
    if (!verified.ok) throw new SettingWriteError(SETTING_WRITE_ERRORS.TARGET_UNPARSEABLE, "the written config could not be parsed", { path: target.path, reason: verified.reason })
  } catch (error) {
    throw verificationFailure({ fileSystem, filePath: target.path, existed: read.exists, originalText: read.text, backupPath: backupFile, message: "the written config could not be verified", details: { cause: error } })
  }
  const actual = readJsoncValue(verified.text, planned.fullPath)
  const matches = planned.expected.found
    ? actual.found === true && deepEqual(actual.value, planned.expected.value)
    : actual.found === false
  if (!matches) {
    throw verificationFailure({
      fileSystem,
      filePath: target.path,
      existed: read.exists,
      originalText: read.text,
      backupPath: backupFile,
      message: "the written value does not match the requested setting",
      details: { expected: planned.expected, actual: actual.found ? actual.value : undefined },
    })
  }
  return { ...result, written: true, backupPath: backupFile, verified: true }
}

export { SETTING_WRITE_ERRORS, SettingWriteError, JsoncWriteError }
