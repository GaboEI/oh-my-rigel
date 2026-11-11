/**
 * Rigel V2 setting catalog: the pure, schema-backed index behind `/rigel_setting`.
 *
 * The interactive command must offer every real setting and must not invent one,
 * so this module owns four answers and nothing else: WHAT exists (one entry per
 * schema-declared setting, keyed by its canonical `~/.omo/omo.jsonc` path), WHAT
 * IT DOES (`tier`: `live` re-read at runtime, `baked` re-materialized on install,
 * `inert` no reader in this runtime, `engine` owned by another layer, plus the
 * `activation` it implies), WHETHER IT IS EDITABLE (`writable`, derived from the
 * tier so a quarantined surface, an inert key, an engine key and an internal-only
 * toggle are non-writable by construction) and WHY (`evidence` plus a one-line
 * `note`).
 *
 * Purity is a hard contract: no filesystem, no environment, no clock. The schemas
 * are read by `rigel-v2-native-setting-catalog.parity.test.mjs`, which hands the
 * discovered paths to {@link createSchemaParityReport} so drift fails the suite
 * instead of reaching a user who edits a key that does nothing.
 */

import { OPENCODE_SETTINGS } from "./rigel-v2-native-setting-catalog-opencode.mjs"
import { OPENCODE_LIMIT_SETTINGS } from "./rigel-v2-native-setting-catalog-opencode-limits.mjs"
import { SHARED_SETTINGS } from "./rigel-v2-native-setting-catalog-shared.mjs"

/** The four classification tiers, in report order. */
export const SETTING_TIERS = Object.freeze(["live", "baked", "inert", "engine"])

/** The activation a tier implies: what the user must do for an edit to land. */
export const SETTING_ACTIVATIONS = Object.freeze(["restart", "reinstall", "informational"])

/** The shape kinds the editor branches on. */
export const SETTING_KINDS = Object.freeze(["toggle", "value", "list", "section", "block", "metadata"])

/** `tier` -> `activation`. The single authority both the catalog and the tests use. */
export const TIER_ACTIVATION = Object.freeze({
  live: "restart",
  baked: "reinstall",
  inert: "informational",
  engine: "informational",
})

/**
 * Paths the schemas declare as CONTAINERS, not settings: every child of
 * `[opencode]` is catalogued on its own, so the block is never a setting.
 */
export const SCHEMA_NAMESPACE_PATHS = Object.freeze(["[opencode]"])

const TIER_SET = new Set(SETTING_TIERS)
const KIND_SET = new Set(SETTING_KINDS)

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

/** `live` and `baked` are editable; `inert` and `engine` are explanation only. */
function isWritableTier(tier) {
  return tier === "live" || tier === "baked"
}

/**
 * Complete one raw data record into an exported entry: the derived `writable`,
 * `activation` and `list` metadata are computed here exactly once, so a data file
 * can never disagree with the tier it declares.
 */
function completeEntry(record) {
  const writable = isWritableTier(record.tier)
  const validation = deepFreeze({ ...record.validation })
  const entry = {
    key: record.key,
    tier: record.tier,
    activation: TIER_ACTIVATION[record.tier] ?? "informational",
    writable,
    kind: record.kind,
    validation,
    evidence: deepFreeze([...record.evidence]),
    note: record.note,
    coversChildren: record.coversChildren === true,
  }
  if (record.kind === "list") {
    entry.list = deepFreeze({
      itemType: validation.itemType ?? "string",
      itemEnum: validation.itemEnum,
      addable: writable,
      removable: writable,
    })
  }
  return deepFreeze(entry)
}

/** Every catalogued setting: the plugin feature surface, its limit leaves, then the shared/engine layer. */
export const SETTING_CATALOG = deepFreeze([...OPENCODE_SETTINGS, ...OPENCODE_LIMIT_SETTINGS, ...SHARED_SETTINGS].map(completeEntry))

const INDEX = new Map(SETTING_CATALOG.map((entry) => [entry.key, entry]))

/** A trimmed canonical key, or `""` for anything that is not a string. */
export function normalizeSettingKey(key) {
  return typeof key === "string" ? key.trim() : ""
}

/** The entry for one canonical key, or `undefined`. Keys are exact and case-sensitive. */
export function lookupSetting(key) {
  return INDEX.get(normalizeSettingKey(key))
}

/**
 * Every entry matching ALL supplied filters. An unknown filter value matches
 * nothing instead of being ignored, so a typo cannot silently return the whole
 * catalog and hide a bug in the caller.
 */
export function listSettings(filters = {}) {
  const wanted = Object.entries(filters).filter(([, value]) => value !== undefined)
  return SETTING_CATALOG.filter((entry) => wanted.every(([field, value]) => entry[field] === value))
}

/** Every key an interactive edit may write. */
export function listEditableSettingKeys() {
  return SETTING_CATALOG.filter((entry) => entry.writable).map((entry) => entry.key)
}

/** Whether an edit to this key can take effect at all. Unknown keys are not writable. */
export function isSettingWritable(key) {
  return lookupSetting(key)?.writable === true
}

/** The schema-derived validation metadata for one key, or `undefined`. */
export function settingValidation(key) {
  return lookupSetting(key)?.validation
}

/**
 * Integrity problems in the CATALOG itself (never in the schemas). Empty means
 * the data is internally consistent: unique keys, known tier and kind, an
 * activation and writability that match the tier, list metadata on every list,
 * and `coversChildren` only on a container.
 */
export function findCatalogProblems(catalog = SETTING_CATALOG) {
  const problems = []
  const seen = new Set()
  for (const entry of catalog) {
    const key = normalizeSettingKey(entry.key)
    if (key === "") problems.push("entry with an empty key")
    else if (seen.has(key)) problems.push(`${key}: duplicate key`)
    seen.add(key)
    if (!TIER_SET.has(entry.tier)) problems.push(`${key}: unknown tier ${String(entry.tier)}`)
    if (!KIND_SET.has(entry.kind)) problems.push(`${key}: unknown kind ${String(entry.kind)}`)
    if (entry.activation !== TIER_ACTIVATION[entry.tier]) problems.push(`${key}: activation does not match tier ${String(entry.tier)}`)
    if (entry.writable !== isWritableTier(entry.tier)) problems.push(`${key}: writable does not match tier ${String(entry.tier)}`)
    if (entry.kind === "list" && (entry.list === undefined || entry.list.addable !== entry.writable)) {
      problems.push(`${key}: list metadata missing or inconsistent with writability`)
    }
    if (entry.kind !== "list" && entry.list !== undefined) problems.push(`${key}: list metadata on a non-list kind`)
    if (entry.coversChildren && entry.kind !== "section" && entry.kind !== "block") {
      problems.push(`${key}: coversChildren on kind ${String(entry.kind)}`)
    }
    if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) problems.push(`${key}: no evidence`)
    if (typeof entry.note !== "string" || entry.note === "") problems.push(`${key}: no note`)
    if (entry.validation === null || typeof entry.validation !== "object") problems.push(`${key}: no validation metadata`)
  }
  return problems
}

function isCoveredByCatalog(path, keys, sectionKeys) {
  if (keys.has(path)) return true
  for (const section of sectionKeys) if (path.startsWith(`${section}.`)) return true
  const prefix = `${path}.`
  for (const key of keys) if (key.startsWith(prefix)) return true
  return false
}

/**
 * Compare the catalog against the paths the shipped schemas actually declare.
 *
 * `schemaPaths` is the discovered property-path inventory (the parity test walks
 * both schemas and merges them; the catalog stays pure). The report answers two
 * failures and only these:
 *
 *   - `missing`: a schema path with no entry for itself, no container entry
 *     above it, and no catalogued child under it. A schema setting nobody can
 *     see is a hole in `/rigel_setting`.
 *   - `invented`: a catalog key no shipped schema declares. A key the user can
 *     edit but the loader would strip is worse than a missing one.
 */
export function createSchemaParityReport({
  schemaPaths = [],
  namespaces = SCHEMA_NAMESPACE_PATHS,
  catalog = SETTING_CATALOG,
} = {}) {
  const keys = new Set(catalog.map((entry) => normalizeSettingKey(entry.key)).filter((key) => key !== ""))
  const sections = new Set(catalog.filter((entry) => entry.coversChildren).map((entry) => entry.key))
  const declared = new Set(schemaPaths.map((path) => normalizeSettingKey(path)).filter((path) => path !== ""))
  const namespaceSet = new Set(namespaces)
  const missing = [...declared]
    .filter((path) => !namespaceSet.has(path))
    .filter((path) => !isCoveredByCatalog(path, keys, sections))
    .sort()
  const invented = [...keys].filter((key) => !declared.has(key)).sort()
  return { ok: missing.length === 0 && invented.length === 0, missing, invented }
}
