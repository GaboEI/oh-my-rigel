/**
 * Schema parity for the Rigel V2 setting catalog.
 *
 * The catalog is only trustworthy if it equals what the shipped schemas declare:
 * no setting the user cannot see, no key the loader would strip. This test walks
 * BOTH shipped schemas - `assets/oh-my-opencode.schema.json` (the plugin block's
 * own definition) and `assets/omo.schema.json` (the unified layer file, which
 * repeats that block under `[opencode]`) - and pins three invariants:
 *
 *   1. `[opencode].<key>` is the SAME node in both schemas, so one canonical
 *      spelling addresses the same leaf in a legacy flat file and in
 *      `~/.omo/omo.jsonc`.
 *   2. Every catalogued `validation` equals the projection of its real schema
 *      node: type, default, bounds, enum, item type and required list.
 *   3. {@link createSchemaParityReport} reports neither `missing` nor `invented`,
 *      which is the contract `/rigel_setting` depends on.
 *
 * It also proves the report can FAIL: a dropped entry and a fabricated key are
 * both rejected, so a green run is evidence and not a tautology.
 */
import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"

import {
  SETTING_CATALOG,
  createSchemaParityReport,
  lookupSetting,
} from "./rigel-v2-native-setting-catalog.mjs"

const OPENCODE_SCHEMA_URL = new URL("../../../assets/oh-my-opencode.schema.json", import.meta.url)
const OMO_SCHEMA_URL = new URL("../../../assets/omo.schema.json", import.meta.url)

/** Every property path a schema node declares, mapping path -> node. */
function collectPropertyPaths(node, prefix = "", out = new Map()) {
  if (node === null || typeof node !== "object") return out
  const properties = node.properties
  if (properties === null || typeof properties !== "object") return out
  for (const [key, child] of Object.entries(properties)) {
    const path = prefix === "" ? key : `${prefix}.${key}`
    out.set(path, child)
    collectPropertyPaths(child, path, out)
  }
  return out
}

/** The canonical validation metadata for one schema node. */
function projectValidation(node) {
  const projected = { type: node.type ?? "union" }
  if (node.items?.type) projected.itemType = node.items.type
  if (node.items?.enum) projected.itemEnum = node.items.enum
  if (node.default !== undefined) projected.default = node.default
  if (node.enum) projected.enum = node.enum
  if (node.minimum !== undefined) projected.minimum = node.minimum
  if (node.maximum !== undefined) projected.maximum = node.maximum
  if (node.required) projected.required = node.required
  return projected
}

const opencodeSchema = JSON.parse(readFileSync(OPENCODE_SCHEMA_URL, "utf8"))
const omoSchema = JSON.parse(readFileSync(OMO_SCHEMA_URL, "utf8"))

const opencodePaths = collectPropertyPaths(opencodeSchema)
const omoPaths = collectPropertyPaths(omoSchema)

/** The paths the catalog addresses: the plugin block first, then the shared layer. */
const declaredPaths = [
  ...[...opencodePaths.keys()].map((path) => `[opencode].${path}`),
  ...omoPaths.keys(),
]
const declaredNodes = new Map([
  ...[...opencodePaths.entries()].map(([path, node]) => [`[opencode].${path}`, node]),
  ...omoPaths.entries(),
])

const parityReport = createSchemaParityReport({ schemaPaths: declaredPaths })

describe("#given the catalog and the two shipped schemas", () => {
  test("#when the schemas are compared #then the [opencode] block repeats the plugin schema node for node", () => {
    // given: the unified schema declares the plugin block inline, so its copy must
    // never drift from the standalone plugin schema
    const mismatched = []
    for (const [path, node] of opencodePaths) {
      const unified = omoPaths.get(`[opencode].${path}`)
      if (unified === undefined) mismatched.push(`[opencode].${path}: absent from assets/omo.schema.json`)
      else if (JSON.stringify(unified) !== JSON.stringify(node)) mismatched.push(`[opencode].${path}: node differs between the two schemas`)
    }
    // then
    expect(mismatched).toEqual([])
  })

  test("#when every schema path is checked against the catalog #then nothing is missing and nothing is invented", () => {
    // when / then
    expect(parityReport).toEqual({ ok: true, missing: [], invented: [] })
  })

  test("#when an entry is checked #then its validation is the schema node projection", () => {
    // given
    const drifted = []
    for (const entry of SETTING_CATALOG) {
      const node = declaredNodes.get(entry.key)
      if (node === undefined) {
        drifted.push(`${entry.key}: no schema node`)
        continue
      }
      const projected = projectValidation(node)
      if (JSON.stringify(projected) !== JSON.stringify(entry.validation)) {
        drifted.push(`${entry.key}: catalog=${JSON.stringify(entry.validation)} schema=${JSON.stringify(projected)}`)
      }
    }
    // then
    expect(drifted).toEqual([])
  })

  test("#when a section entry claims coverage #then its schema node is object-shaped", () => {
    // given: an object node may enumerate its children (`properties`) or declare
    // them as a map (`additionalProperties`), so only the SHAPE can be asserted
    const fakeContainers = SETTING_CATALOG
      .filter((entry) => entry.coversChildren)
      .filter((entry) => {
        const node = declaredNodes.get(entry.key)
        return node === undefined || (node.type ?? "union") !== "object"
      })
      .map((entry) => entry.key)
    // then: a scalar can never contain a setting, so coverage would be a lie
    expect(fakeContainers).toEqual([])
  })

  test("#when a schema-backed live key is edited #then the catalog says a restart is enough", () => {
    // given
    const mislabelled = SETTING_CATALOG
      .filter((entry) => entry.tier === "live" || entry.tier === "baked")
      .filter((entry) => entry.activation !== (entry.tier === "live" ? "restart" : "reinstall"))
      .map((entry) => entry.key)
    // then
    expect(mislabelled).toEqual([])
  })
})

describe("#given the parity report itself", () => {
  test("#when a catalogued setting is dropped #then the schema path is reported missing", () => {
    // given
    const removed = lookupSetting("[opencode].experimental.task_system")
    const catalog = SETTING_CATALOG.filter((entry) => entry.key !== removed.key)
    // when
    const report = createSchemaParityReport({ catalog, schemaPaths: declaredPaths })
    // then: the leaf itself has no child to cover it, so it must be named
    expect(report.missing).toContain("[opencode].experimental.task_system")
    expect(report.ok).toBe(false)
  })

  test("#when a key no schema declares is catalogued #then it is reported invented", () => {
    // given: the exact failure a hand-written toggle list produces
    const fabricated = {
      ...lookupSetting("[opencode].hashline_edit"),
      key: "[opencode].internal_feature_flag",
      coversChildren: false,
    }
    const catalog = [...SETTING_CATALOG, fabricated]
    // when
    const report = createSchemaParityReport({ catalog, schemaPaths: declaredPaths })
    // then
    expect(report.invented).toEqual(["[opencode].internal_feature_flag"])
    expect(report.ok).toBe(false)
  })

  test("#when a container path has catalogued children #then it is not reported missing", () => {
    // given: `[opencode].monitor` is a container whose leaves are catalogued
    expect(lookupSetting("[opencode].monitor")).toBeUndefined()
    // when / then
    expect(parityReport.missing).not.toContain("[opencode].monitor")
  })
})
