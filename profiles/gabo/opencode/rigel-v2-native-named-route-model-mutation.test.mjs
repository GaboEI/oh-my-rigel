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
 *
 * Both contracts run in a child process (`runMutationInChild`): the same test
 * first imported these modules statically and loaded mutants through a uniquely
 * named copy, and on Windows the runtime served an earlier module instance for
 * one of them, so the mutation was invisible and the contract was green while
 * proving nothing. The check modules below are the SAME assertions, executed
 * where the only source that exists is the file on disk.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runMutationInChild } from "./test-support/mutation-harness.mjs"

const OPENCODE_DIR = import.meta.dir
const AGENTS_FILE = join(OPENCODE_DIR, "rigel-v2-native-agents.mjs")
const RUNTIME_FILE = join(OPENCODE_DIR, "rigel-v2-native.mjs")

// (1) The JSON-only registration ref must be the SERVED inventory row.
const REACHABLE_REF_IS_SERVED = {
  name: "the JSON-only registration ref canonicalizes to the served inventory row",
  check: [
    "const mod = await import(MUTANT)",
    'const inventory = [{ providerID: "opencode-go", id: "deepseek-v4.1-flash", enabled: true }]',
    'const explicit = new Map([["oracle", { model: "opencode-go/deepseek-v4.1-FLASH" }]])',
    'const resolved = mod.resolveProactiveAgentModels({ oracle: { name: "Oracle", mode: "subagent" } }, inventory, explicit, { chainFallback: false })',
    'const model = resolved.get("oracle")',
    'if (model?.providerID !== "opencode-go" || model?.id !== "deepseek-v4.1-flash") {',
    "  throw new Error(`expected the served canonical ref opencode-go/deepseek-v4.1-flash, got ${JSON.stringify(model)}`)",
    "}",
  ].join("\n"),
}

// (2) The registration map must carry the user's `fallback_models` chain so an
// unserved head falls to a reachable rung exactly like the delegation path.
const REGISTRATION_CARRIES_FALLBACK_CHAIN = {
  name: "buildExplicitAgentModels carries the user fallback_models chain into registration",
  check: [
    "const mod = await import(MUTANT)",
    'const agents = await import(here("rigel-v2-native-agents.mjs"))',
    'const explicit = mod.buildExplicitAgentModels({ "Sisyphus-Junior": { model: "kimi-for-coding/kimi-x", fallback_models: ["openai/gpt-6-luna-fast"] } })',
    'const inventory = [{ providerID: "openai", id: "gpt-6-luna-fast", enabled: true }]',
    'const resolved = agents.resolveProactiveAgentModels({ "Sisyphus-Junior": { name: "Sisyphus-Junior", mode: "subagent" } }, inventory, explicit, { chainFallback: false })',
    'const model = resolved.get("Sisyphus-Junior")',
    'if (model?.providerID !== "openai" || model?.id !== "gpt-6-luna-fast") {',
    "  throw new Error(`expected the served fallback rung openai/gpt-6-luna-fast, got ${JSON.stringify(model)}`)",
    "}",
  ].join("\n"),
}

test("mutation: dropping the named-route canonicalization turns the registration contract red", async () => {
  const before = readFileSync(AGENTS_FILE)
  const receipt = await runMutationInChild({
    file: AGENTS_FILE,
    mutate: (source) => source.replace(
      "if (ref) resolved.set(id, resolveAgentDelegationModel(explicitEntry, inventory) ?? ref)",
      "if (ref) resolved.set(id, ref)",
    ),
    contract: REACHABLE_REF_IS_SERVED,
  })
  expect(receipt.contract).toBe(REACHABLE_REF_IS_SERVED.name)
  expect(receipt.red).toBe(true)
  expect(receipt.redError).toContain("expected the served canonical ref")
  expect(receipt.beforeHash).toBe(receipt.afterHash)
  expect(readFileSync(AGENTS_FILE).equals(before)).toBe(true)
})

test("mutation: dropping the fallback_models carry turns the registration rung contract red", async () => {
  const before = readFileSync(RUNTIME_FILE)
  const receipt = await runMutationInChild({
    file: RUNTIME_FILE,
    mutate: (source) => source.replace(
      "...(Array.isArray(override.fallback_models) ? { fallback_models: [...override.fallback_models] } : {}),",
      "",
    ),
    contract: REGISTRATION_CARRIES_FALLBACK_CHAIN,
  })
  expect(receipt.contract).toBe(REGISTRATION_CARRIES_FALLBACK_CHAIN.name)
  expect(receipt.red).toBe(true)
  expect(receipt.redError).toContain("expected the served fallback rung")
  expect(receipt.beforeHash).toBe(receipt.afterHash)
  expect(readFileSync(RUNTIME_FILE).equals(before)).toBe(true)
})
