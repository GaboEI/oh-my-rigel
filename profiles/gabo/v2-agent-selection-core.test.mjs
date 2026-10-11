/**
 * Owner tests for the native agent manifest selection logic.
 *
 * Regression for finding N1: `generate-v2-agents.mjs` hard-threw when the plugin
 * did not generate an orchestrated agent (e.g. `Atlas - Plan Executor` needs a
 * resolvable model). A fresh install from an empty config must complete without
 * depending on an agent that was not generated. These tests pin the observable
 * decision: a missing orchestrated agent is SKIPPED and reported, never fatal.
 *
 * Only machine-consumed values (selected keys, missing list, default agent) are
 * asserted.
 */
import { describe, expect, test } from "bun:test"

import { canonicalAgentKey, resolveDefaultAgent, selectOrchestratedAgents } from "./v2-agent-selection-core.mjs"

describe("selectOrchestratedAgents", () => {
  test("#given an orchestrated agent the plugin did not generate #then it is skipped and reported, not thrown", () => {
    const { selected, missing } = selectOrchestratedAgents({
      allAgents: { "Sisyphus - ultraworker": { name: "Sisyphus - ultraworker" } },
      selection: { orchestratedAgentIds: ["Sisyphus - ultraworker", "Atlas - Plan Executor"] },
    })

    expect(Object.keys(selected)).toEqual(["Sisyphus - ultraworker"])
    expect(missing).toEqual(["Atlas - Plan Executor"])
  })

  test("#given a disabled orchestrated agent #then it is excluded and not reported missing", () => {
    const { selected, missing } = selectOrchestratedAgents({
      allAgents: { forja: { name: "forja" }, "Sisyphus - ultraworker": { name: "Sisyphus - ultraworker" } },
      selection: { orchestratedAgentIds: ["forja", "Sisyphus - ultraworker"] },
      disabledAgentKeys: new Set(["forja"]),
    })

    expect(Object.keys(selected)).toEqual(["Sisyphus - ultraworker"])
    expect(missing).toEqual([])
  })

  test("#given optional and demoted agents #then they are added only when present", () => {
    const { selected } = selectOrchestratedAgents({
      allAgents: { "Sisyphus - ultraworker": { name: "Sisyphus - ultraworker" }, plan: { name: "plan" } },
      selection: { orchestratedAgentIds: ["Sisyphus - ultraworker"], optionalAgentIds: ["absent"], demotedAgentIds: ["plan"] },
    })

    expect(Object.keys(selected)).toEqual(["Sisyphus - ultraworker", "plan"])
  })

  test("#given a manifest id with a display suffix #then canonicalAgentKey returns the base id", () => {
    expect(canonicalAgentKey("Hephaestus - Deep Agent")).toBe("hephaestus")
    expect(canonicalAgentKey("oracle")).toBe("oracle")
  })
})

describe("resolveDefaultAgent", () => {
  test("#given the configured default is selected #then it is kept", () => {
    expect(resolveDefaultAgent("Sisyphus - ultraworker", { "Sisyphus - ultraworker": {} })).toBe("Sisyphus - ultraworker")
  })

  test("#given the configured default was not generated #then the first selected agent is used", () => {
    expect(resolveDefaultAgent("Missing - Agent", { "Sisyphus - ultraworker": {}, atlas: {} })).toBe("Sisyphus - ultraworker")
  })

  test("#given the configured default is absent and the first selected agent is ineligible #then the fallback skips it", () => {
    // The runtime skips the first manifest agent (e.g. a Hephaestus whose model
    // gate fails); the default must resolve to the first ELIGIBLE agent, not the
    // first agent that registerNativeAgents will leave out of the roster.
    const selected = { "Hephaestus - Deep Agent": {}, "Sisyphus - ultraworker": {}, atlas: {} }
    const eligible = (id) => id !== "Hephaestus - Deep Agent"

    expect(resolveDefaultAgent("Missing - Agent", selected, eligible)).toBe("Sisyphus - ultraworker")
  })

  test("#given the configured default is selected but ineligible #then an eligible agent is used", () => {
    const selected = { "Hephaestus - Deep Agent": {}, sisyphus: {} }

    expect(resolveDefaultAgent("Hephaestus - Deep Agent", selected, (id) => id !== "Hephaestus - Deep Agent")).toBe("sisyphus")
  })

  test("#given no selected agent is eligible #then the fallback is undefined", () => {
    expect(resolveDefaultAgent("Missing - Agent", { "Hephaestus - Deep Agent": {}, atlas: {} }, () => false)).toBeUndefined()
  })
})
