/**
 * Named-RED mutation tests for the named-route model canonicalization seam
 * (fix/v2-junior-quick).
 *
 * The seam is exactly two touch points, so the mutation coverage is exactly two
 * contracts:
 *   1. `rigel-v2-native-agents.mjs` resolves the JSON-only registration ref
 *      against the live inventory via `resolveAgentDelegationModel`, so a
 *      reachable configured model registers its SERVED canonical ref;
 *   2. `rigel-v2-native.mjs` `buildExplicitAgentModels` carries the user's
 *      ordered `fallback_models` chain, so registration can walk the SAME chain
 *      the delegated child walks.
 * Each mutation must turn its NAMED contract RED while the same contract is
 * GREEN pre-mutation, and the harness restores the bytes sha256-identically.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runMutation } from "./test-support/mutation-harness.mjs"
import { resolveProactiveAgentModels } from "./rigel-v2-native-agents.mjs"

const OPENCODE_DIR = import.meta.dir
const AGENTS_FILE = join(OPENCODE_DIR, "rigel-v2-native-agents.mjs")
const RUNTIME_FILE = join(OPENCODE_DIR, "rigel-v2-native.mjs")

// (1) The JSON-only registration ref must be the SERVED inventory row.
const reachableRefIsServed = {
  name: "the JSON-only registration ref canonicalizes to the served inventory row",
  run: async ({ load }) => {
    const module = await load()
    const inventory = [{ providerID: "opencode-go", id: "deepseek-v4.1-flash", enabled: true }]
    const explicit = new Map([["oracle", { model: "opencode-go/deepseek-v4.1-FLASH" }]])
    const resolved = module.resolveProactiveAgentModels(
      { oracle: { name: "Oracle", mode: "subagent" } },
      inventory,
      explicit,
      { chainFallback: false },
    )
    const model = resolved.get("oracle")
    if (model?.providerID !== "opencode-go" || model?.id !== "deepseek-v4.1-flash") {
      throw new Error(`expected the served canonical ref opencode-go/deepseek-v4.1-flash, got ${JSON.stringify(model)}`)
    }
  },
}

// (2) The registration map must carry the user's `fallback_models` chain so an
// unserved head falls to a reachable rung exactly like the delegation path.
const registrationCarriesFallbackChain = {
  name: "buildExplicitAgentModels carries the user fallback_models chain into registration",
  run: async ({ load }) => {
    const module = await load()
    const explicit = module.buildExplicitAgentModels({
      "Sisyphus-Junior": { model: "kimi-for-coding/kimi-x", fallback_models: ["openai/gpt-6-luna-fast"] },
    })
    const inventory = [{ providerID: "openai", id: "gpt-6-luna-fast", enabled: true }]
    const resolved = resolveProactiveAgentModels(
      { "Sisyphus-Junior": { name: "Sisyphus-Junior", mode: "subagent" } },
      inventory,
      explicit,
      { chainFallback: false },
    )
    const model = resolved.get("Sisyphus-Junior")
    if (model?.providerID !== "openai" || model?.id !== "gpt-6-luna-fast") {
      throw new Error(`expected the served fallback rung openai/gpt-6-luna-fast, got ${JSON.stringify(model)}`)
    }
  },
}

test("mutation: dropping the named-route canonicalization turns the registration contract red", async () => {
  const before = readFileSync(AGENTS_FILE)
  const receipt = await runMutation({
    file: AGENTS_FILE,
    mutate: (source) => source.replace(
      "if (ref) resolved.set(id, resolveAgentDelegationModel(explicitEntry, inventory) ?? ref)",
      "if (ref) resolved.set(id, ref)",
    ),
    contract: reachableRefIsServed,
  })
  expect(receipt.contract).toBe(reachableRefIsServed.name)
  expect(receipt.red).toBe(true)
  expect(receipt.redError).toContain("expected the served canonical ref")
  expect(receipt.beforeHash).toBe(receipt.afterHash)
  expect(readFileSync(AGENTS_FILE).equals(before)).toBe(true)
})

test("mutation: dropping the fallback_models carry turns the registration rung contract red", async () => {
  const before = readFileSync(RUNTIME_FILE)
  const receipt = await runMutation({
    file: RUNTIME_FILE,
    mutate: (source) => source.replace(
      "...(Array.isArray(override.fallback_models) ? { fallback_models: [...override.fallback_models] } : {}),",
      "",
    ),
    contract: registrationCarriesFallbackChain,
  })
  expect(receipt.contract).toBe(registrationCarriesFallbackChain.name)
  expect(receipt.red).toBe(true)
  expect(receipt.redError).toContain("expected the served fallback rung")
  expect(receipt.beforeHash).toBe(receipt.afterHash)
  expect(readFileSync(RUNTIME_FILE).equals(before)).toBe(true)
})
