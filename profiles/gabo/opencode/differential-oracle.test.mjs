import { describe, expect, test } from "bun:test"

import { FAMILIES, QUARANTINED_ENTRYPOINT_FAMILIES, scenarios } from "./differential-oracle/registry.mjs"
import { runMatrix, runMutations } from "./differential-oracle/harness.mjs"
import { COMPARATORS, compare, deepEqual, normalize } from "./differential-oracle/normalize.mjs"
import { loadV1Oracle } from "./test-support/v1-oracle.mjs"

// Families whose runtime entrypoint is quarantined in V2 (the inherited Goal);
// their parity is asserted at the helper level, not end-to-end. See registry.mjs.
const ENTRYPOINT_FAMILIES = FAMILIES.filter((family) => !QUARANTINED_ENTRYPOINT_FAMILIES.includes(family))

// Run the whole matrix once. Each scenario imports the REAL V1 owner and the
// native V2 mirror; a degraded V1 oracle surfaces as BLOCKED and fails below.
const matrix = await runMatrix(scenarios)
const mutations = await runMutations(scenarios)

function failedRows(result) {
  return result.rows.filter((row) => !row.pass).map((row) => `${row.name} (${row.detail})`)
}

describe("Differential oracle differential oracle: registry coverage", () => {
  test("#given the scenario registry #when grouped by family #then all nine required families are present", () => {
    // given
    const present = [...new Set(scenarios.map((scenario) => scenario.family))].sort()

    // when / then
    expect(present).toEqual([...FAMILIES].sort())
  })

  test("#given each family #when counted #then every family contributes at least one scenario", () => {
    // given
    const counts = new Map()
    for (const scenario of scenarios) {
      counts.set(scenario.family, (counts.get(scenario.family) ?? 0) + 1)
    }

    // when / then
    for (const family of FAMILIES) {
      expect(counts.get(family) ?? 0, `family ${family} has no scenarios`).toBeGreaterThan(0)
    }
  })
})

describe("Differential oracle differential oracle: V1 parity matrix", () => {
  test("#given every scenario #when the V1 oracle loads #then none is degraded (BLOCKED)", () => {
    // given
    const blocked = matrix.filter((result) => result.verdict === "BLOCKED").map((result) => `${result.id}: ${result.reason}`)

    // when / then
    expect(blocked).toEqual([])
  })

  test("#given every scenario #when V1 and V2 observables are compared #then the whole matrix passes", () => {
    // given
    const failures = matrix
      .filter((result) => result.verdict !== "PASS")
      .map((result) => `${result.id}: ${failedRows(result).join(", ") || result.reason}`)

    // when / then
    expect(failures).toEqual([])
  })

  test("#given every scenario #when its corpus runs #then no scenario has an empty corpus", () => {
    // given / when / then
    for (const result of matrix) {
      expect(result.rows.length, `${result.id} has an empty corpus`).toBeGreaterThan(0)
    }
  })
})

describe("Differential oracle differential oracle: live comparisons (RED mutations)", () => {
  test("#given every scenario #when its V2 export is mutated #then the scenario flips to RED", () => {
    // given
    const notRed = mutations.filter((result) => result.verdict !== "RED").map((result) => `${result.id}: ${result.verdict} - ${result.reason}`)

    // when / then
    expect(notRed).toEqual([])
  })
})

describe("Differential oracle differential oracle: V2 is not a reduction of V1", () => {
  test("#given every V1 edit-error pattern #when V2 processes it #then V2 still fires the recovery reminder", async () => {
    // given
    const v1 = await loadV1Oracle("recovery.edit")
    const recovery = await import("./rigel-v2-native-recovery.mjs")
    expect(v1.source).toBe("v1")

    // when / then
    for (const pattern of v1.module.EDIT_ERROR_PATTERNS) {
      const event = { tool: "edit", result: { content: `something ${pattern} happened` } }
      expect(recovery.applyNativeRecoveryReminder(event), `V2 must cover V1 pattern: ${pattern}`).toBe(true)
    }
  })

  test("#given every V1 JSON-error excluded tool #when given a JSON error #then V2 still skips it", async () => {
    // given
    const v1 = await loadV1Oracle("recovery.json")
    const recovery = await import("./rigel-v2-native-recovery.mjs")
    expect(v1.source).toBe("v1")

    // when / then
    for (const tool of v1.module.JSON_ERROR_TOOL_EXCLUDE_LIST) {
      const event = { tool, result: { content: "invalid json" } }
      expect(recovery.applyNativeRecoveryReminder(event), `V2 must exclude V1 tool: ${tool}`).toBe(false)
    }
  })
})

describe("Differential oracle differential oracle: integration coverage", () => {
  test("#given the nine families #when integration scenarios are counted #then each family has an end-to-end integration scenario", () => {
    // given
    const familiesWithIntegration = new Set(scenarios.filter((scenario) => scenario.integration).map((scenario) => scenario.family))

    // when / then
    for (const family of FAMILIES) {
      expect(familiesWithIntegration.has(family), `family ${family} lacks an end-to-end integration scenario`).toBe(true)
    }
  })

  test("#given every integration scenario #when labeled #then it declares a cross-host observable type", () => {
    // given
    const allowed = new Set(["provider-payload", "result-mutation", "block-decision", "handoff", "state-persistence", "selection"])

    // when / then
    for (const scenario of scenarios.filter((entry) => entry.integration)) {
      expect(allowed.has(scenario.observableType), `${scenario.id} observableType=${scenario.observableType}`).toBe(true)
    }
  })

  test("#given the integration scenarios #when the matrix runs #then none is BLOCKED and all pass", () => {
    // given
    const integrationIds = new Set(scenarios.filter((scenario) => scenario.integration).map((scenario) => scenario.id))
    const integrationResults = matrix.filter((result) => integrationIds.has(result.id))

    // when / then
    expect(integrationResults.length).toBeGreaterThanOrEqual(FAMILIES.length)
    for (const result of integrationResults) {
      expect(result.verdict, `${result.id}: ${failedRows(result).join(", ")}`).toBe("PASS")
    }
  })
})

describe("Differential oracle differential oracle: full-plugin-entrypoint proof", () => {
  test("#given the entrypoint scenarios #when grouped by family #then every non-quarantined family is covered end-to-end", () => {
    // given
    const families = new Set(scenarios.filter((scenario) => scenario.entrypoint).map((scenario) => scenario.family))

    // when / then
    for (const family of ENTRYPOINT_FAMILIES) {
      expect(families.has(family), `family ${family} lacks a full-plugin-entrypoint scenario`).toBe(true)
    }
  })

  test("#given every entrypoint scenario #when inspected #then it drives the real setup and carries an on-disk mutation", () => {
    // given
    const entrypoints = scenarios.filter((scenario) => scenario.entrypoint)

    // when / then
    expect(entrypoints.length).toBeGreaterThanOrEqual(ENTRYPOINT_FAMILIES.length)
    for (const scenario of entrypoints) {
      expect(typeof scenario.loadV2, `${scenario.id} loadV2`).toBe("function")
      expect(scenario.mutation?.onDisk?.find, `${scenario.id} on-disk mutation seam`).toBeTruthy()
      expect(scenario.mutation?.onDisk?.replace, `${scenario.id} on-disk mutation replacement`).toBeTruthy()
    }
  })

  test("#given the entrypoint scenarios #when the matrix runs #then none is BLOCKED and all pass", () => {
    // given
    const ids = new Set(scenarios.filter((scenario) => scenario.entrypoint).map((scenario) => scenario.id))
    const results = matrix.filter((result) => ids.has(result.id))

    // when / then
    expect(results.length).toBeGreaterThanOrEqual(ENTRYPOINT_FAMILIES.length)
    for (const result of results) {
      expect(result.verdict, `${result.id}: ${failedRows(result).join(", ")}`).toBe("PASS")
    }
  })

  test("#given the entrypoint scenarios #when their V2 export is mutated #then each flips to RED", () => {
    // given
    const ids = new Set(scenarios.filter((scenario) => scenario.entrypoint).map((scenario) => scenario.id))
    const results = mutations.filter((result) => ids.has(result.id))

    // when / then
    expect(results.length).toBeGreaterThanOrEqual(ENTRYPOINT_FAMILIES.length)
    for (const result of results) {
      expect(result.verdict, `${result.id}: ${result.reason}`).toBe("RED")
    }
  })
})

describe("Differential oracle differential oracle: comparator self-tests", () => {
  test("#given the exact comparator #when values differ #then it fails, and equal values pass", () => {
    // given / when / then
    expect(COMPARATORS.exact({ a: 1 }, { a: 1 }).ok).toBe(true)
    expect(COMPARATORS.exact({ a: 1 }, { a: 2 }).ok).toBe(false)
    expect(COMPARATORS.exact([1, 2], [2, 1]).ok).toBe(false)
  })

  test("#given the set comparator #when order differs #then it passes, and membership differences fail", () => {
    // given / when / then
    expect(COMPARATORS.set(["b", "a"], ["a", "b"]).ok).toBe(true)
    expect(COMPARATORS.set(["a"], ["a", "b"]).ok).toBe(false)
    expect(COMPARATORS.set("not-array", ["a"]).ok).toBe(false)
  })

  test("#given the substring comparator #when the needle is present #then it passes, absent it fails", () => {
    // given / when / then
    expect(COMPARATORS.substring("needle", "a needle here").ok).toBe(true)
    expect(COMPARATORS.substring("needle", "nothing").ok).toBe(false)
  })

  test("#given the numeric-range comparator #when within tolerance #then it passes, outside it fails", () => {
    // given / when / then
    expect(COMPARATORS["numeric-range"](10, 11, { abs: 1 }).ok).toBe(true)
    expect(COMPARATORS["numeric-range"](10, 12, { abs: 1 }).ok).toBe(false)
  })

  test("#given an unknown tolerance kind #when compared #then it fails instead of passing silently", () => {
    // given / when / then
    expect(compare(1, 1, { kind: "looks-fine" }).ok).toBe(false)
  })
})

describe("Differential oracle differential oracle: normalization", () => {
  test("#given volatile ids and absolute paths #when normalized #then they are erased but real values survive", () => {
    // given
    const roots = { repoRoot: "/repo", home: "/home/u", tmp: "/tmp" }
    const value = {
      message: "wrote /repo/out and /home/u/.config/x (session ses_abc123)",
      createdAt: 123,
      nested: { keep: "yes", requestID: "req_x" },
    }

    // when
    const normalized = normalize(value, roots)

    // then
    expect(normalized.message).toBe("wrote <REPO>/out and <HOME>/.config/x (session <ID>)")
    expect(normalized.createdAt).toBeUndefined()
    expect(normalized.nested).toEqual({ keep: "yes" })
  })

  test("#given object key order differs #when normalized #then the values are deep-equal", () => {
    // given / when / then
    expect(deepEqual(normalize({ a: 1, b: 2 }), normalize({ b: 2, a: 1 }))).toBe(true)
    expect(deepEqual(normalize({ a: 1 }), normalize({ a: 2 }))).toBe(false)
  })
})
