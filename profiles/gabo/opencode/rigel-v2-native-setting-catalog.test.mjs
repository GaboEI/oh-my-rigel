/**
 * Integrity and query contract for the Rigel V2 setting catalog.
 *
 * The schema parity suite proves the catalog MATCHES the shipped schemas. This
 * suite proves the catalog is internally usable: the derived metadata is
 * consistent, the refusal rules hold (`goal.enabled`, inert keys, engine keys and
 * internal toggles are never writable), and the helpers an interactive command
 * calls behave on exact keys, unknown keys and filters.
 */
import { describe, expect, test } from "bun:test"

import {
  SETTING_ACTIVATIONS,
  SETTING_CATALOG,
  SETTING_KINDS,
  SETTING_TIERS,
  TIER_ACTIVATION,
  findCatalogProblems,
  isSettingWritable,
  listEditableSettingKeys,
  listSettings,
  lookupSetting,
  normalizeSettingKey,
  settingValidation,
} from "./rigel-v2-native-setting-catalog.mjs"

describe("#given the catalog data", () => {
  test("#when its internal consistency is checked #then it reports no problem", () => {
    // given / when
    const problems = findCatalogProblems()
    // then
    expect(problems).toEqual([])
  })

  test("#when the tiers are inspected #then every classification is represented", () => {
    // given
    const counts = Object.fromEntries(SETTING_TIERS.map((tier) => [tier, listSettings({ tier }).length]))
    // then: a tier nobody uses would mean a whole class of settings was guessed away
    for (const tier of SETTING_TIERS) expect(counts[tier]).toBeGreaterThan(0)
  })

  test("#when a tampered catalog is checked #then each inconsistency is named", () => {
    // given: one broken entry per invariant the checker owns
    const valid = lookupSetting("[opencode].hashline_edit")
    const tampered = [
      { ...valid, key: "[opencode].alpha", activation: "reinstall" },
      { ...valid, key: "[opencode].beta", writable: false },
      { ...valid, key: "[opencode].gamma", tier: "someday" },
      { ...valid, key: "[opencode].delta", kind: "toggle-list" },
      { ...valid, key: "[opencode].epsilon", evidence: [] },
      { ...valid, key: "[opencode].zeta", note: "" },
      { ...valid, key: "[opencode].eta", kind: "value", coversChildren: true },
      { ...valid },
      { ...valid },
    ]
    // when
    const problems = findCatalogProblems(tampered)
    // then
    expect(problems).toContain("[opencode].alpha: activation does not match tier live")
    expect(problems).toContain("[opencode].beta: writable does not match tier live")
    expect(problems).toContain("[opencode].gamma: unknown tier someday")
    expect(problems).toContain("[opencode].delta: unknown kind toggle-list")
    expect(problems).toContain("[opencode].epsilon: no evidence")
    expect(problems).toContain("[opencode].zeta: no note")
    expect(problems).toContain("[opencode].eta: coversChildren on kind value")
    expect(problems).toContain("[opencode].hashline_edit: duplicate key")
  })

  test("#when the exported catalog is mutated #then it stays frozen", () => {
    // given
    const entry = lookupSetting("[opencode].monitor.enabled")
    // when
    try {
      entry.tier = "engine"
      SETTING_CATALOG.push({})
    } catch {
      // a frozen object may throw in strict ESM; either way nothing may change
    }
    // then
    expect(entry.tier).toBe("live")
    expect(SETTING_CATALOG).not.toContainEqual({})
  })

  test("#when the activation table is read #then it maps every tier the catalog uses", () => {
    // then
    expect(Object.keys(TIER_ACTIVATION).sort()).toEqual([...SETTING_TIERS].sort())
    for (const entry of SETTING_CATALOG) {
      expect(SETTING_ACTIVATIONS).toContain(entry.activation)
      expect(SETTING_KINDS).toContain(entry.kind)
    }
  })
})

describe("#given the refusal rules", () => {
  test("#when the quarantined goal gate is looked up #then it is not writable", () => {
    // given
    const entry = lookupSetting("[opencode].goal.enabled")
    // when / then
    expect(entry.tier).toBe("inert")
    expect(entry.writable).toBe(false)
    expect(entry.activation).toBe("informational")
  })

  test("#when every inert and engine key is checked #then none of them is writable", () => {
    // given
    const writable = SETTING_CATALOG
      .filter((entry) => entry.tier === "inert" || entry.tier === "engine")
      .filter((entry) => entry.writable)
      .map((entry) => entry.key)
    // then
    expect(writable).toEqual([])
  })

  test("#when an internal-only toggle is listed #then it cannot be edited", () => {
    // given: V1-only switches whose V2 consumer either does not exist or is forced
    const internal = [
      "[opencode].new_task_system_enabled",
      "[opencode].experimental.aggressive_truncation",
      "[opencode].experimental.disable_live_parent_wake_routing",
      "[opencode].model_fallback",
      "[opencode].goal.auto_start",
      "[opencode].default_mode.goal",
    ]
    // when / then
    for (const key of internal) expect(isSettingWritable(key)).toBe(false)
  })

  test("#when the editable list is built #then it is exactly the live and baked entries", () => {
    // given
    const expected = SETTING_CATALOG
      .filter((entry) => entry.tier === "live" || entry.tier === "baked")
      .map((entry) => entry.key)
    // when / then
    expect(listEditableSettingKeys()).toEqual(expected)
  })

  test("#when default_mode.ultrawork is looked up #then it is an ordinary editable live setting", () => {
    // given
    const entry = lookupSetting("[opencode].default_mode.ultrawork")
    // when / then
    expect(entry.tier).toBe("live")
    expect(entry.writable).toBe(true)
    expect(entry.activation).toBe("restart")
    expect(entry.validation).toEqual({ type: "boolean", default: false })
  })

  test("#when an engine key is looked up #then it is explanation only", () => {
    // given
    const entry = lookupSetting("teams")
    // when / then
    expect(entry.tier).toBe("engine")
    expect(entry.writable).toBe(false)
    expect(entry.activation).toBe("informational")
  })
})

describe("#given the query helpers", () => {
  test("#when a key is looked up #then exact spelling is required", () => {
    // given
    const exact = "[opencode].monitor.enabled"
    // when / then
    expect(lookupSetting(exact)?.key).toBe(exact)
    expect(normalizeSettingKey(`  ${exact}  `)).toBe(exact)
    expect(lookupSetting("[opencode].MONITOR.ENABLED")).toBeUndefined()
    expect(lookupSetting("monitor.enabled")).toBeUndefined()
    expect(lookupSetting(undefined)).toBeUndefined()
    expect(lookupSetting(42)).toBeUndefined()
  })

  test("#when filters are combined #then every filter must match", () => {
    // given
    const liveToggles = listSettings({ tier: "live", kind: "toggle" })
    // when / then
    expect(liveToggles.length).toBeGreaterThan(0)
    for (const entry of liveToggles) {
      expect(entry.tier).toBe("live")
      expect(entry.kind).toBe("toggle")
    }
    expect(listSettings({ tier: "someday" })).toEqual([])
  })

  test("#when a list setting is inspected #then add and remove follow writability", () => {
    // given
    const live = lookupSetting("[opencode].disabled_tools")
    const inert = lookupSetting("[opencode].disabled_providers")
    // when / then
    expect(live.list).toEqual({ itemType: "string", itemEnum: undefined, addable: true, removable: true })
    expect(inert.list).toEqual({ itemType: "string", itemEnum: undefined, addable: false, removable: false })
    expect(lookupSetting("[opencode].hashline_edit").list).toBeUndefined()
  })

  test("#when validation metadata is requested for an unknown key #then it is undefined", () => {
    // when / then
    expect(settingValidation("[opencode].monitor.max_monitors_per_session")).toEqual({
      type: "integer",
      default: 3,
      minimum: 1,
      maximum: 16,
    })
    expect(settingValidation("[opencode].nonexistent")).toBeUndefined()
  })

  test("#when the catalog is listed #then every entry carries the metadata an editor needs", () => {
    // given
    const incomplete = SETTING_CATALOG
      .filter((entry) => typeof entry.key !== "string" || entry.key === "")
      .concat(SETTING_CATALOG.filter((entry) => entry.evidence.length === 0 || entry.note === ""))
      .map((entry) => entry.key)
    // then
    expect(incomplete).toEqual([])
  })
})
