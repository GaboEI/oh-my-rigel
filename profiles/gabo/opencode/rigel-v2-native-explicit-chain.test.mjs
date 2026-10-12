import { test, expect } from "bun:test"
import { agentOverrideChain, agentOverrideFor, categoryIsExplicit, resolveAgentDelegationModel, resolveAuthoritativeAgentOverrides, resolveEffectiveChain } from "./rigel-v2-native-explicit-chain.mjs"
import { categoryChain } from "./rigel-v2-native-model-chains.mjs"

// Upstream 5a9bb74a4: an explicit user model suppresses the built-in chain.

test("an explicit category with no fallback_models resolves to an empty (no-fallback) chain", () => {
  const userCategories = { quick: { model: "openai/gpt-6-luna-fast" } }
  const chain = resolveEffectiveChain({ descriptor: { name: "quick", explicit: true }, agent: "Sisyphus-Junior", userCategories })
  expect(chain).toEqual([])
})

test("a non-explicit category keeps the built-in chain", () => {
  const chain = resolveEffectiveChain({ descriptor: { name: "quick", explicit: false }, agent: "Sisyphus-Junior", userCategories: {} })
  expect(chain).toEqual(categoryChain("quick"))
})

test("an explicit category uses only the user fallback_models chain", () => {
  const userCategories = {
    quick: { model: "openai/gpt-6-luna-fast", fallback_models: ["openai/gpt-6-luna-fast(low)", "deepseek/deepseek-flash"] },
  }
  const chain = resolveEffectiveChain({ descriptor: { name: "quick", explicit: true }, agent: "Sisyphus-Junior", userCategories })
  expect(chain).toEqual([
    { providers: ["openai"], model: "gpt-6-luna-fast", variant: "low" },
    { providers: ["deepseek"], model: "deepseek-flash" },
  ])
})

test("a restored category descriptor recomputes explicit from the live user categories", () => {
  const userCategories = { quick: { model: "openai/gpt-6-luna-fast" } }
  expect(resolveEffectiveChain({ descriptor: { name: "quick" }, agent: "Sisyphus-Junior", userCategories })).toEqual([])
})

test("an explicit agent model suppresses the built-in chain", () => {
  const agentOverrides = { sisyphus: { model: "anthropic/claude-opus-5-5", variant: "max" } }
  expect(resolveEffectiveChain({ agent: "Sisyphus - ultraworker", agentOverrides })).toEqual([])
})

test("an agent fallback_models chain is the effective chain, in the user's order", () => {
  const agentOverrides = {
    oracle: {
      model: "opencode/nemotron-3-ultra-free",
      fallback_models: ["openai/gpt-6-astra(xhigh)", { providers: ["deepseek"], model: "deepseek-flash" }],
    },
  }
  expect(resolveEffectiveChain({ agent: "oracle", agentOverrides })).toEqual([
    { providers: ["openai"], model: "gpt-6-astra", variant: "xhigh" },
    { providers: ["deepseek"], model: "deepseek-flash" },
  ])
})

// JSON-ONLY mutant: the effective agent chain comes ONLY from `~/.omo/omo.jsonc`.
// The built-in canonical chain (e.g. `agentChain("oracle")`, `agentChain("explore")`)
// must be dead at runtime, so a decoy canonical agent yields an EMPTY chain when
// the JSON has no entry for it - the session then inherits the OpenCode global
// (never `exo-free` resurrected from a baked chain, never the canonical rung).
test("an agent with no JSON override inherits the global (empty chain, canonical chain never consulted)", () => {
  expect(resolveEffectiveChain({ agent: "oracle", agentOverrides: {} })).toEqual([])
  expect(resolveEffectiveChain({ agent: "explore", agentOverrides: {} })).toEqual([])
  expect(resolveEffectiveChain({ agent: "librarian", agentOverrides: {} })).toEqual([])
})

test("an agent with an empty JSON entry inherits the global (empty chain)", () => {
  expect(resolveEffectiveChain({ agent: "oracle", agentOverrides: { oracle: {} } })).toEqual([])
  // A display-cased JSON key with no model is still empty after canonicalization.
  expect(resolveEffectiveChain({ agent: "oracle", agentOverrides: { "Oracle": { variant: "max" } } })).toEqual([])
})

test("isolation: an explicit session's chain does not affect a sibling session", () => {
  const userCategories = { quick: { model: "openai/gpt-6-luna-fast" }, writing: {} }
  const explicit = resolveEffectiveChain({ descriptor: { name: "quick", explicit: true }, agent: "Sisyphus-Junior", userCategories })
  const builtin = resolveEffectiveChain({ descriptor: { name: "writing", explicit: false }, agent: "Sisyphus-Junior", userCategories })
  expect(explicit).toEqual([])
  expect(builtin).toEqual(categoryChain("writing"))
})

test("agentOverrideFor matches a display-cased agent name to its override id", () => {
  expect(agentOverrideFor({ sisyphus: { model: "x/y" } }, "Sisyphus - ultraworker")).toEqual({ model: "x/y" })
})

test("categoryIsExplicit only fires on a user model or models chain", () => {
  expect(categoryIsExplicit({ quick: { description: "no model" } }, "quick")).toBe(false)
  expect(categoryIsExplicit({ quick: { models: ["openai/gpt-6-luna-fast"] } }, "quick")).toBe(true)
})

// R1: the runtime model source is JSON-ONLY. `~/.omo/omo.jsonc` is
// authoritative-COMPLETE when it exists, its `agents` block INCLUDING an absent
// or empty one, and the manifest is NEVER consulted. An unreadable file fails
// safe to no overrides.

test("resolveAuthoritativeAgentOverrides: a loaded live source is authoritative and canonicalized", () => {
  const chosen = resolveAuthoritativeAgentOverrides({
    live: { state: "loaded", overrides: { explore: { model: "qwen/q3" }, "Hephaestus - Deep Agent": { model: "rigel-nsg/gpt-4o" } } },
  })
  expect(chosen).toEqual({ explore: { model: "qwen/q3" }, hephaestus: { model: "rigel-nsg/gpt-4o" } })
})

test("resolveAuthoritativeAgentOverrides: an empty loaded live block yields no overrides", () => {
  expect(resolveAuthoritativeAgentOverrides({ live: { state: "loaded", overrides: {} } })).toEqual({})
})

test("resolveAuthoritativeAgentOverrides: an absent live file yields no overrides (manifest never consulted)", () => {
  expect(resolveAuthoritativeAgentOverrides({ live: { state: "absent" } })).toEqual({})
})

test("resolveAuthoritativeAgentOverrides: an unreadable live file fails safe to no overrides", () => {
  expect(resolveAuthoritativeAgentOverrides({
    live: { state: "error", path: "/h/.omo/omo.jsonc", reason: "Unexpected token" },
  })).toEqual({})
})

test("resolveAuthoritativeAgentOverrides: a loaded live change A->B is returned verbatim", () => {
  const chosen = resolveAuthoritativeAgentOverrides({
    live: { state: "loaded", overrides: { oracle: { model: "deepseek/deepseek-v4-pro", variant: "max" } } },
  })
  expect(chosen).toEqual({ oracle: { model: "deepseek/deepseek-v4-pro", variant: "max" } })
})

test("resolveAuthoritativeAgentOverrides tolerates malformed sources without mutating them", () => {
  expect(resolveAuthoritativeAgentOverrides()).toEqual({})
  expect(resolveAuthoritativeAgentOverrides({ live: "nope" })).toEqual({})
  const live = Object.freeze({
    state: "loaded",
    overrides: Object.freeze({
      explore: Object.freeze({ model: "c/d", models: Object.freeze(["c/d", "e/f"]) }),
    }),
  })
  const chosen = resolveAuthoritativeAgentOverrides({ live })
  expect(chosen.explore.model).toBe("c/d")
  expect(chosen.explore.models).toEqual(["c/d", "e/f"])
  // The authoritative entry and its arrays are copies: a later mutation can
  // never reach the frozen source.
  expect(chosen.explore).not.toBe(live.overrides.explore)
  expect(chosen.explore.models).not.toBe(live.overrides.explore.models)
})

// The agent JSON ordered chain (head + fallback_models) and its inventory walk.
// This is the delegation-time model source: JSON-only, never the manifest.

test("agentOverrideChain: an absent or model-less override yields no chain; a bare fallback_models is an explicit chain", () => {
  expect(agentOverrideChain(undefined)).toEqual([])
  expect(agentOverrideChain({})).toEqual([])
  expect(agentOverrideChain({ variant: "max" })).toEqual([])
  expect(agentOverrideChain({ fallback_models: ["openai/gpt-6-luna-fast(low)"] })).toEqual([
    { providers: ["openai"], model: "gpt-6-luna-fast", variant: "low" },
  ])
})

test("agentOverrideChain: the head keeps its variant and the fallback_models follow in order", () => {
  const chain = agentOverrideChain({
    model: "kimi-for-coding/kimi-for-coding-highspeed",
    variant: "off",
    fallback_models: [
      { providers: ["openai"], model: "gpt-6-luna-fast", variant: "low" },
      { providers: ["deepseek"], model: "deepseek-flash", variant: "max" },
    ],
  })
  expect(chain).toEqual([
    { providers: ["kimi-for-coding"], model: "kimi-for-coding-highspeed", variant: "off" },
    { providers: ["openai"], model: "gpt-6-luna-fast", variant: "low" },
    { providers: ["deepseek"], model: "deepseek-flash", variant: "max" },
  ])
})

test("resolveAgentDelegationModel: an empty JSON override inherits the global", () => {
  expect(resolveAgentDelegationModel(undefined, [{ providerID: "openai", id: "gpt-6-luna-fast", enabled: true }])).toBeUndefined()
  expect(resolveAgentDelegationModel({}, [{ providerID: "openai", id: "gpt-6-luna-fast", enabled: true }])).toBeUndefined()
})

// RED->GREEN: the pinned head provider is absent from the live inventory, so the
// child must start on the next reachable rung instead of the unavailable head.
test("resolveAgentDelegationModel: an unavailable head falls through to the first available fallback rung", () => {
  const override = {
    model: "kimi-for-coding/kimi-for-coding-highspeed",
    variant: "off",
    fallback_models: [{ providers: ["openai"], model: "gpt-6-luna-fast", variant: "low" }],
  }
  const inventory = [{ providerID: "openai", id: "gpt-6-luna-fast", enabled: true }]
  expect(resolveAgentDelegationModel(override, inventory)).toEqual({ providerID: "openai", id: "gpt-6-luna-fast", variant: "low" })
})

test("resolveAgentDelegationModel: an available head is kept", () => {
  const override = { model: "opencode/big-pickle" }
  const inventory = [{ providerID: "opencode", id: "big-pickle", enabled: true }]
  expect(resolveAgentDelegationModel(override, inventory)).toEqual({ providerID: "opencode", id: "big-pickle" })
})

// Contract: an exhausted explicit chain is NEVER downgraded to the global. With
// no reachable rung the child must keep the CONFIGURED head so it fails AS
// CONFIGURED, instead of silently inheriting the OpenCode global.
test("resolveAgentDelegationModel: an exhausted explicit chain keeps the configured head (never the global)", () => {
  const override = {
    model: "kimi-for-coding/kimi-for-coding-highspeed",
    variant: "off",
    fallback_models: [{ providers: ["deepseek"], model: "deepseek-flash" }],
  }
  const inventory = [{ providerID: "opencode", id: "big-pickle", enabled: true }]
  expect(resolveAgentDelegationModel(override, inventory)).toEqual({ providerID: "kimi-for-coding", id: "kimi-for-coding-highspeed", variant: "off" })
})

test("resolveAgentDelegationModel: a bare fallback_models chain is an explicit chain (first reachable rung; configured head when none)", () => {
  const override = { fallback_models: [{ providers: ["openai"], model: "gpt-6-luna-fast", variant: "low" }] }
  expect(resolveAgentDelegationModel(override, [{ providerID: "openai", id: "gpt-6-luna-fast", enabled: true }]))
    .toEqual({ providerID: "openai", id: "gpt-6-luna-fast", variant: "low" })
  // No rung reachable -> keep the configured head, never undefined/global.
  expect(resolveAgentDelegationModel(override, [{ providerID: "opencode", id: "big-pickle", enabled: true }]))
    .toEqual({ providerID: "openai", id: "gpt-6-luna-fast", variant: "low" })
})

test("resolveAgentDelegationModel: an unreadable inventory keeps the configured head (never fails closed)", () => {
  const override = { model: "kimi-for-coding/kimi-for-coding-highspeed", variant: "off" }
  expect(resolveAgentDelegationModel(override, undefined)).toEqual({ providerID: "kimi-for-coding", id: "kimi-for-coding-highspeed", variant: "off" })
})

test("resolveAgentDelegationModel: a bare-id pin with an unreadable inventory keeps the configured head", () => {
  expect(resolveAgentDelegationModel({ model: "not-a-provider-ref" }, undefined)).toEqual({ id: "not-a-provider-ref" })
})
