/**
 * Catalog -> writer projection for the native V2 `/rigel_setting` surface.
 *
 * The catalog answers WHY a setting exists (tier, evidence, note) and the writer
 * answers HOW a value is committed (layer, validation, backup, rollback), but
 * neither speaks the other's vocabulary: a catalog key is the canonical dotted
 * spelling (`[opencode].monitor.max_runtime_ms`), while the writer works with a
 * path RELATIVE to a placement plus a descriptor type. This module is the single
 * seam between them, so the command, the deterministic tool and the tests all
 * agree on one projection instead of each re-deriving it.
 *
 * Three rules live here and nowhere else:
 *
 * 1. SCOPE. A key under the `[opencode]` block is written at
 *    `profiles.<P>.[opencode]`; a shared top-level key is written at
 *    `profiles.<P>`. Both are the reader's highest-precedence placement for that
 *    key, so a write lands where the runtime actually reads it.
 * 2. MUTABILITY. Only a `writable` leaf (a `toggle`, `value` or `list`) whose
 *    validation the writer can express is mutable. `inert` and `engine` keys are
 *    explanation only, and a `section` / `block` / `metadata` container is never
 *    replaced wholesale by this surface.
 * 3. EFFECTIVE VALUE. The current value is folded exactly like the reader:
 *    placement-major (root, `[opencode]`, `profiles.<P>`, `profiles.<P>.[opencode]`)
 *    and layer-inner (nearest project wins). A scalar or `replace` key keeps its
 *    highest-precedence declaration, while a `union` list key ACCUMULATES every
 *    declaration in that same fold order (first seen first), because that is the
 *    list `mergeConfigViews` hands the runtime. Reporting only the last raw
 *    declaration of a denylist reports a value the runtime never runs with.
 *
 * Pure by contract: no file system, no environment, no clock.
 */
import { readJsoncValue } from "./rigel-v2-native-jsonc-edit.mjs"
import { isPlainObject } from "./rigel-v2-native-jsonc-parse.mjs"
import { lookupSetting, normalizeSettingKey } from "./rigel-v2-native-setting-catalog.mjs"

/** The harness block a catalog key may be nested under. */
export const SETTING_HARNESS_BLOCK = "[opencode]"

/** The entry kinds this surface may mutate; a container is never replaced. */
export const MUTABLE_SETTING_KINDS = Object.freeze(["toggle", "value", "list"])

/**
 * The list keys the reader's fold UNIONS instead of replacing, mirroring
 * `DECLARATION_ROOT_KINDS` + `mergeConfigViews` in `rigel-v2-native-config.mjs`
 * (which cannot be imported here: that module is the reader, this one is the
 * pure projection over it). A union key accumulates every declaration of every
 * placement, first-seen unique, so folding it like a scalar under-reports what
 * the runtime actually denies.
 */
const UNION_SETTING_ROOT_KEYS = Object.freeze([
  "disabled_tools",
  "disabled_agents",
  "disabled_skills",
  "disabled_hooks",
  "disabled_mcps",
  "disabled_commands",
  "mcp_env_allowlist",
])

/**
 * The union keys the reader admits at a PROFILE ROOT (`profiles.<P>.<key>`). The
 * fold's `profileRecord` keeps only `categories`, `disabled_skills`, `openclaw`
 * and the harness blocks (`PROFILE_KEYS` in `rigel-v2-native-config.mjs`), so a
 * `profiles.<P>.disabled_tools` declaration is never read by the runtime and must
 * not be reported as an effective denial.
 */
const PROFILE_ROOT_UNION_KEYS = Object.freeze(["disabled_skills"])

/**
 * The union key the reader accepts from USER-scope layers only: a project layer
 * can never extend the MCP env allowlist (V1 parity, `collectUserMcpEnvAllowlist`).
 */
const USER_SCOPE_UNION_KEYS = Object.freeze(["mcp_env_allowlist"])

const REPLACED_SECTION_ROOT_KEYS = Object.freeze(["monitor", "goal", "experimental", "team_mode", "default_mode"])

function replacedSectionRootFor(entry) {
  if (entry === null || typeof entry !== "object" || entry.kind === "list") return undefined
  const settingPath = settingPathFor(entry.key)
  return settingPath.length > 1 && REPLACED_SECTION_ROOT_KEYS.includes(settingPath[0]) ? settingPath[0] : undefined
}

function rawLeafMatchesValidation(validation, value) {
  if (validation === null || typeof validation !== "object") return false
  if (validation.type === "boolean") return typeof value === "boolean"
  if (validation.type === "integer") return typeof value === "number" && Number.isInteger(value)
  if (validation.type === "number") return typeof value === "number" && Number.isFinite(value)
  if (validation.type === "string") return typeof value === "string"
  if (validation.type === "array") return Array.isArray(value) && value.every((entry) => typeof entry === "string")
  return true
}

/**
 * Read a leaf from a schema-normalized replacement section. A later valid
 * section declaration replaces the prior section, and omitted leaves receive
 * the catalog's schema default instead of falling through to a lower section.
 */
function readReplacedSectionSetting({ entry, profileName, layers }) {
  const settingPath = settingPathFor(entry.key)
  const section = settingPath[0]
  const leaf = settingPath[1]
  const validation = entry.validation
  let sectionFound = false
  let found = false
  let value
  let source
  for (const placement of settingPlacementsFor(entry.key, profileName)) {
    for (const layer of layers) {
      if (layer === null || typeof layer !== "object" || layer.ok === false) continue
      const read = readJsoncValue(layer.text, [...placement, section])
      if (read.ok !== true || read.found !== true || !isPlainObject(read.value)) continue
      sectionFound = true
      const hasLeaf = Object.hasOwn(read.value, leaf) && rawLeafMatchesValidation(validation, read.value[leaf])
      found = hasLeaf || Object.hasOwn(validation, "default")
      value = hasLeaf ? read.value[leaf] : validation.default
      source = layer.path
    }
  }
  return { found: sectionFound && found, value: sectionFound && found ? value : undefined, source }
}

/** Refusals owned by the projection, using the writer's stable code vocabulary. */
export const SETTING_SURFACE_ERRORS = Object.freeze({
  UNKNOWN_SETTING: "SETTING_UNKNOWN_SETTING",
  NOT_WRITABLE: "SETTING_NOT_WRITABLE",
  INERT: "SETTING_INERT",
  ENGINE_OWNED: "SETTING_ENGINE_OWNED",
  CONTAINER_NOT_MUTABLE: "SETTING_CONTAINER_NOT_MUTABLE",
  UNSUPPORTED_TYPE: "SETTING_UNSUPPORTED_TYPE",
})

const WRITER_SCALAR_TYPES = Object.freeze({
  boolean: "boolean",
  integer: "integer",
  number: "number",
  string: "string",
  object: "object",
})

/** The dotted key split into segments. `"[opencode].a.b"` -> `["[opencode]", "a", "b"]`. */
export function settingKeySegments(key) {
  const normalized = normalizeSettingKey(key)
  return normalized === "" ? [] : normalized.split(".")
}

/** `"harness"` when the key lives under `[opencode]`, otherwise `"root"`. */
export function settingScopeFor(key) {
  return settingKeySegments(key)[0] === SETTING_HARNESS_BLOCK ? "harness" : "root"
}

/** The path segments relative to the key's own scope root. */
export function settingPathFor(key) {
  const segments = settingKeySegments(key)
  return settingScopeFor(key) === "harness" ? segments.slice(1) : segments
}

/**
 * Every placement the reader folds for this key, lowest precedence first. The
 * last entry is the placement a write targets.
 */
export function settingPlacementsFor(key, profileName) {
  const profile = typeof profileName === "string" && profileName !== "" ? profileName : undefined
  if (settingScopeFor(key) === "harness") {
    return profile === undefined
      ? [[SETTING_HARNESS_BLOCK]]
      : [[SETTING_HARNESS_BLOCK], ["profiles", profile, SETTING_HARNESS_BLOCK]]
  }
  return profile === undefined ? [[]] : [[], ["profiles", profile]]
}

/** The placement a write targets: the reader's highest-precedence one. */
export function settingWritePlacementFor(key, profileName) {
  return settingPlacementsFor(key, profileName).at(-1)
}

/** The writer descriptor type for a catalog validation node, or `undefined`. */
export function writerTypeForValidation(validation) {
  if (validation === null || typeof validation !== "object") return undefined
  if (validation.type === "array") return validation.itemType === "string" ? "string-list" : undefined
  return WRITER_SCALAR_TYPES[validation.type]
}

/**
 * The writer descriptor for one catalog entry: the scope-relative path plus the
 * validation the writer enforces. `undefined` when the writer cannot express the
 * type (a `union`, or an array whose item type is not a string).
 */
export function toSettingDescriptor(entry) {
  if (entry === null || typeof entry !== "object") return undefined
  const type = writerTypeForValidation(entry.validation)
  const path = settingPathFor(entry.key)
  if (type === undefined || path.length === 0) return undefined
  const descriptor = { path, type }
  const validation = entry.validation
  if (typeof validation.minimum === "number") descriptor.minimum = validation.minimum
  if (typeof validation.maximum === "number") descriptor.maximum = validation.maximum
  if (typeof entry.runtimeMaximum === "number") descriptor.maximum = Math.min(descriptor.maximum ?? entry.runtimeMaximum, entry.runtimeMaximum)
  if (Array.isArray(validation.values)) descriptor.values = [...validation.values]
  if (Object.hasOwn(validation, "default") && validation.default !== undefined) descriptor.default = validation.default
  return descriptor
}

/** The JSON-safe record a caller (and the tool's `list`/`get`) receives. */
export function describeSetting(entry) {
  const refusal = mutableRefusal(entry)
  const described = {
    key: entry.key,
    tier: entry.tier,
    activation: entry.activation,
    writable: entry.writable === true,
    mutable: refusal === null,
    kind: entry.kind,
    validation: entry.validation,
    evidence: [...entry.evidence],
    note: entry.note,
  }
  if (entry.list !== undefined) described.list = entry.list
  if (refusal !== null) described.refusal = refusal
  return described
}

/**
 * Why a key cannot be mutated, or `null` when it can. An unknown key, an inert
 * key, an engine-owned key and a container all refuse before any writer call, so
 * a caller never learns a write was possible for a key with no reader.
 */
export function mutableRefusal(entry) {
  if (entry === null || entry === undefined || typeof entry.key !== "string" || entry.key === "") {
    return { code: SETTING_SURFACE_ERRORS.UNKNOWN_SETTING, message: "the catalog has no entry for this key" }
  }
  if (entry.tier === "inert") {
    return { code: SETTING_SURFACE_ERRORS.INERT, message: "no reader in this runtime reads this key", tier: entry.tier }
  }
  if (entry.tier === "engine") {
    return { code: SETTING_SURFACE_ERRORS.ENGINE_OWNED, message: "another layer owns this key", tier: entry.tier }
  }
  if (entry.writable !== true) {
    return { code: SETTING_SURFACE_ERRORS.NOT_WRITABLE, message: "the catalog marks this key non-writable", tier: entry.tier }
  }
  if (!MUTABLE_SETTING_KINDS.includes(entry.kind)) {
    return { code: SETTING_SURFACE_ERRORS.CONTAINER_NOT_MUTABLE, message: "this key holds other settings; edit its leaves instead", kind: entry.kind }
  }
  if (toSettingDescriptor(entry) === undefined) {
    return { code: SETTING_SURFACE_ERRORS.UNSUPPORTED_TYPE, message: "the writer cannot express this validation", type: entry.validation?.type }
  }
  return null
}

/** The root key of a catalog key: the first segment of its scope-relative path. */
function unionRootKeyOf(key) {
  return settingPathFor(key)[0]
}

/** Whether this entry is a union list the reader accumulates across declarations. */
function isUnionSettingEntry(entry) {
  if (entry === null || typeof entry !== "object") return false
  if (entry.kind !== "list") return false
  const validation = entry.validation
  if (validation === null || typeof validation !== "object") return false
  if (validation.type !== "array" || validation.itemType !== "string") return false
  return UNION_SETTING_ROOT_KEYS.includes(unionRootKeyOf(entry.key))
}

/**
 * Every placement the reader folds for a UNION key, lowest precedence first,
 * each carrying the dotted `at` a declaration record would name. This is the
 * reader's own `PLUGIN_PLACEMENTS` order restricted to what its fold actually
 * admits for a union key, and the last entry is still the write target.
 */
function settingUnionPlacementsFor(key, profileName) {
  const settingPath = settingPathFor(key)
  const profile = typeof profileName === "string" && profileName !== "" ? profileName : undefined
  const placements = [
    { segments: [], at: "" },
    { segments: [SETTING_HARNESS_BLOCK], at: `${SETTING_HARNESS_BLOCK}.` },
  ]
  if (profile !== undefined) {
    if (PROFILE_ROOT_UNION_KEYS.includes(settingPath[0])) {
      placements.push({ segments: ["profiles", profile], at: `profiles.${profile}.` })
    }
    placements.push({ segments: ["profiles", profile, SETTING_HARNESS_BLOCK], at: `profiles.${profile}.${SETTING_HARNESS_BLOCK}.` })
  }
  return placements.map((placement) => ({
    segments: [...placement.segments, ...settingPath],
    at: `${placement.at}${settingPath.join(".")}`
  }))
}

/**
 * The effective value of a UNION list: every declaration the reader folds,
 * deduped first-seen in the reader's own placement-major / layer-inner order.
 *
 * `sources` names every contributing placement, lowest precedence first, and
 * `source` the highest-precedence contributor, so a merged answer is never
 * mistaken for one file's value. A declaration the parser refuses (a non-array,
 * or non-string members) contributes nothing and never resets the list, exactly
 * like `parseConfigView`; `found` still reports that a layer authored the key,
 * so an explicit `[]` (which releases a deny) never reads as undeclared.
 */
function readUnionSetting({ entry, profileName, layers }) {
  const userScopeOnly = USER_SCOPE_UNION_KEYS.includes(unionRootKeyOf(entry.key))
  const collected = []
  const sources = []
  let found = false
  for (const placement of settingUnionPlacementsFor(entry.key, profileName)) {
    for (const layer of layers) {
      if (layer === null || typeof layer !== "object" || layer.ok === false) continue
      if (userScopeOnly && layer.scope !== "user") continue
      const read = readJsoncValue(layer.text, placement.segments)
      if (read.ok !== true || read.found !== true) continue
      if (!Array.isArray(read.value)) continue
      found = true
      for (const item of read.value) if (typeof item === "string") collected.push(item)
      sources.push({ path: layer.path, at: placement.at })
    }
  }
  return {
    found,
    value: found ? [...new Set(collected)] : undefined,
    source: sources.at(-1)?.path,
    sources,
    union: true,
  }
}

/**
 * The CURRENT effective value of one entry, folded like the reader. `layers`
 * must be in the reader's own order (user first, then projects farthest-first)
 * and carry the parsed `text` of each loaded layer; an unreadable layer is
 * skipped here because this is a read, not a write decision.
 *
 * A `union` list key is accumulated (`readUnionSetting`); every other key keeps
 * its highest-precedence declaration, which is what a `replace` fold carries.
 */
export function readEffectiveSetting({ entry, profileName, layers = [] } = {}) {
  if (entry === null || entry === undefined) return { found: false, value: undefined, source: undefined }
  if (replacedSectionRootFor(entry) !== undefined) return readReplacedSectionSetting({ entry, profileName, layers })
  if (isUnionSettingEntry(entry)) return readUnionSetting({ entry, profileName, layers })
  const settingPath = settingPathFor(entry.key)
  let found = false
  let value
  let source
  for (const placement of settingPlacementsFor(entry.key, profileName)) {
    for (const layer of layers) {
      if (layer === null || typeof layer !== "object" || layer.ok === false) continue
      const read = readJsoncValue(layer.text, [...placement, ...settingPath])
      if (read.ok !== true || read.found !== true) continue
      found = true
      value = read.value
      source = layer.path
    }
  }
  return { found, value, source }
}

/** The catalog entry for one key, or `undefined`. */
export function findSettingEntry(key) {
  return lookupSetting(normalizeSettingKey(key))
}
