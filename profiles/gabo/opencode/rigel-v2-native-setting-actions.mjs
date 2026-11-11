/**
 * The action layer of the `rigel_setting` tool: what each request actually does,
 * with the tool definition kept in its own module.
 *
 * The split exists so one file answers "what does this tool accept" and this one
 * answers "what happens then". Everything here is injected (`env`, `home`,
 * `directory`, `fileSystem`) and every answer is a JSON-safe payload, so a test
 * drives the real decision path inside a disposable sandbox.
 *
 * The write authority is the settings writer and nothing else: `set`, `add` and
 * `remove` PREVIEW when the caller has not confirmed and only then delegate to
 * `applySettingEdit`. An inert, engine-owned, container or unexpressable key is
 * refused before any writer call, so a caller never learns a write was possible
 * for a key with no reader.
 */
import { SETTING_CATALOG, SETTING_TIERS, listSettings, normalizeSettingKey } from "./rigel-v2-native-setting-catalog.mjs"
import {
  SETTING_SURFACE_ERRORS,
  describeSetting,
  findSettingEntry,
  mutableRefusal,
  readEffectiveSetting,
  settingWritePlacementFor,
  toSettingDescriptor,
} from "./rigel-v2-native-setting-descriptor.mjs"
import { resolveSettingPaths } from "./rigel-v2-native-setting-targets.mjs"
import { readJsoncFile } from "./rigel-v2-native-jsonc-write.mjs"
import {
  SETTING_WRITE_ERRORS,
  SettingWriteError,
  applySettingEdit,
  previewSettingEdit,
  validateSettingValue,
} from "./rigel-v2-native-setting-write.mjs"

export const SETTING_TOOL_ACTIONS = Object.freeze(["list", "get", "validate", "set", "add", "remove"])

const MUTATING_ACTIONS = new Set(["set", "add", "remove"])
const DEFAULT_LIST_LIMIT = 200
const MAX_LIST_LIMIT = 500

function failure(code, message, details) {
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } }
}

function thrownFailure(error) {
  if (error instanceof SettingWriteError) return failure(error.code, error.message, error.details)
  const code = typeof error?.code === "string" ? error.code : undefined
  const message = error instanceof Error ? error.message : String(error)
  return failure(code ?? SETTING_WRITE_ERRORS.EDIT_FAILED, message)
}

/** The layer view plus the current effective value of one entry. */
function readCurrent(entry, { env, home, directory, accountHome, manifest, fileSystem }) {
  const paths = resolveSettingPaths({ env, home, directory, accountHome, manifest, fileSystem })
  const layers = paths.layers.map((layer) => ({ ...layer, ...readJsoncFile({ fileSystem, filePath: layer.path }) }))
  const current = readEffectiveSetting({ entry, profileName: paths.profileName, layers })
  return {
    profileName: paths.profileName,
    layers: layers.map((layer) => ({ path: layer.path, scope: layer.scope, exists: layer.exists === true, ok: layer.ok !== false })),
    unreadable: layers.filter((layer) => layer.ok === false).map((layer) => layer.path),
    current,
  }
}

/** The profile a write lands in, resolved without reading any setting value. */
function readProfileName(options) {
  try {
    return resolveSettingPaths(options).profileName
  } catch {
    return undefined
  }
}

function listAction(input) {
  const filters = {}
  if (input.tier !== undefined) filters.tier = input.tier
  if (input.kind !== undefined) filters.kind = input.kind
  if (input.writable !== undefined) filters.writable = input.writable === true
  let entries = listSettings(filters)
  const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : ""
  if (query !== "") entries = entries.filter((entry) => entry.key.toLowerCase().includes(query) || entry.note.toLowerCase().includes(query))
  const limit = Number.isInteger(input.limit) ? Math.min(Math.max(input.limit, 1), MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT
  const counts = { total: SETTING_CATALOG.length, writable: 0, mutable: 0, byTier: {} }
  for (const tier of SETTING_TIERS) counts.byTier[tier] = 0
  for (const entry of SETTING_CATALOG) {
    counts.byTier[entry.tier] += 1
    if (entry.writable) counts.writable += 1
    if (mutableRefusal(entry) === null) counts.mutable += 1
  }
  return { ok: true, action: "list", counts, matched: entries.length, entries: entries.slice(0, limit).map(describeSetting) }
}

function getAction(input, options) {
  const entry = findSettingEntry(normalizeSettingKey(input.key))
  if (entry === undefined) return failure(SETTING_SURFACE_ERRORS.UNKNOWN_SETTING, `no catalog entry for ${JSON.stringify(input.key ?? "")}`)
  const state = readCurrent(entry, options)
  return {
    ok: true,
    action: "get",
    setting: describeSetting(entry),
    profileName: state.profileName,
    layers: state.layers,
    unreadable: state.unreadable,
    current: state.current,
  }
}

function validateAction(input, options) {
  const entry = findSettingEntry(normalizeSettingKey(input.key))
  if (entry === undefined) return failure(SETTING_SURFACE_ERRORS.UNKNOWN_SETTING, `no catalog entry for ${JSON.stringify(input.key ?? "")}`)
  const refusal = mutableRefusal(entry)
  if (refusal !== null) return { ok: false, action: "validate", key: entry.key, error: refusal }
  try {
    const value = validateSettingValue(toSettingDescriptor(entry), input.value)
    return { ok: true, action: "validate", key: entry.key, valid: true, value }
  } catch (error) {
    const reported = thrownFailure(error)
    return { ok: false, action: "validate", key: entry.key, valid: false, error: reported.error }
  }
}

function mutateAction(input, options) {
  const entry = findSettingEntry(normalizeSettingKey(input.key))
  if (entry === undefined) return failure(SETTING_SURFACE_ERRORS.UNKNOWN_SETTING, `no catalog entry for ${JSON.stringify(input.key ?? "")}`)
  const refusal = mutableRefusal(entry)
  if (refusal !== null) return { ok: false, action: input.action, key: entry.key, error: refusal }
  if (input.action === "remove" && entry.kind !== "list" && input.value !== undefined) {
    return failure(SETTING_WRITE_ERRORS.INVALID_VALUE, "a scalar `remove` takes no value; it deletes the key so the catalog default applies")
  }
  const request = {
    env: options.env,
    home: options.home,
    directory: options.directory,
    accountHome: options.accountHome,
    manifest: options.manifest,
    fileSystem: options.fileSystem,
    now: options.now,
    setting: toSettingDescriptor(entry),
    placement: settingWritePlacementFor(entry.key, readProfileName(options)),
    operation: input.action,
    value: input.value,
  }
  try {
    if (input.confirm !== true) {
      const preview = previewSettingEdit(request)
      return {
        ok: true,
        action: input.action,
        key: entry.key,
        requiresConfirmation: true,
        changed: preview.changed,
        path: preview.path,
        placement: preview.placement,
        fullPath: preview.fullPath,
        before: preview.before,
        after: preview.after,
        hook: entry.activation,
      }
    }
    const applied = applySettingEdit({ ...request, confirm: true })
    return {
      ok: true,
      action: input.action,
      key: entry.key,
      requiresConfirmation: false,
      changed: applied.changed,
      written: applied.written,
      verified: applied.verified === true,
      path: applied.path,
      placement: applied.placement,
      fullPath: applied.fullPath,
      before: applied.before,
      after: applied.after,
      backupPath: applied.backupPath,
      hook: entry.activation,
    }
  } catch (error) {
    return { ok: false, action: input.action, key: entry.key, ...thrownFailure(error) }
  }
}

/** Dispatch one request. Every branch answers with a JSON-safe payload. */
export function runSettingAction(input, options) {
  const request = input !== null && typeof input === "object" ? input : {}
  if (!SETTING_TOOL_ACTIONS.includes(request.action)) {
    return failure("SETTING_UNKNOWN_ACTION", `unknown action ${JSON.stringify(request.action ?? "")}`)
  }
  if (request.action === "list") return listAction(request)
  if (request.action === "get") return getAction(request, options)
  if (request.action === "validate") return validateAction(request, options)
  return mutateAction(request, options)
}

/** Whether the request mutates, used only by the tool's result metadata. */
export function isMutatingSettingAction(action) {
  return MUTATING_ACTIONS.has(action)
}
