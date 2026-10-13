/**
 * Named-RED mutation tests for the Sisyphus-Junior `all` mode seam
 * (fix/v2-junior-quick / audit R2 H1): promoting `@Sisyphus-Junior` from a
 * child-only subagent into a primary-capable, in-session-selectable agent.
 *
 * The seam is the manifest `mode` value the target generator writes from the
 * profile's `nativeAgentModeOverrides`. `applyLegacyAgentDefinition` is the
 * runtime boundary that turns that value into the V2 `agent.mode`, so this file
 * mutates exactly that boundary:
 *
 *   1. dropping `all` from the allowlist must demote a promoted agent back to
 *      the `subagent` default (the override stops being honored);
 *   2. promoting the fallback default must turn every agent with an absent or
 *      unknown mode into a primary agent (the roster would gain selectable
 *      agents nobody configured).
 *
 * Each mutation must turn its NAMED contract RED while the same contract is
 * GREEN pre-mutation, and the harness restores the bytes sha256-identically.
 */
import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { runMutation } from "./test-support/mutation-harness.mjs"

const OPENCODE_DIR = import.meta.dir
const AGENTS_FILE = path.join(OPENCODE_DIR, "rigel-v2-native-agents.mjs")

// (1) `all` must survive the allowlist so the promoted agent is primary-capable.
const manifestAllPromotesAgent = {
  name: "applyLegacyAgentDefinition promotes a manifest all mode to a primary-capable V2 agent",
  run: async ({ load }) => {
    const module = await load()
    const agent = { request: { headers: {}, body: {} }, permissions: [] }
    module.applyLegacyAgentDefinition(agent, "Sisyphus-Junior", { name: "Sisyphus-Junior", mode: "all", prompt: "Execute." })
    if (agent.mode !== "all") throw new Error(`expected the agent mode all, got ${JSON.stringify(agent.mode)}`)
  },
}

// (2) An absent mode must stay the child-only default; nobody is promoted by
// omission, so the primary roster is exactly the agents the profile declared.
const absentModeStaysSubagent = {
  name: "applyLegacyAgentDefinition defaults an absent mode to subagent",
  run: async ({ load }) => {
    const module = await load()
    const agent = { request: { headers: {}, body: {} }, permissions: [] }
    module.applyLegacyAgentDefinition(agent, "oracle", { name: "oracle" })
    if (agent.mode !== "subagent") throw new Error(`expected the subagent default, got ${JSON.stringify(agent.mode)}`)
  },
}

test("mutation: dropping all from the runtime allowlist demotes the promoted agent", async () => {
  const before = fs.readFileSync(AGENTS_FILE)
  const receipt = await runMutation({
    file: AGENTS_FILE,
    mutate: (source) => source.replace(
      '["primary", "subagent", "all"].includes(source.mode)',
      '["primary", "subagent"].includes(source.mode)',
    ),
    contract: manifestAllPromotesAgent,
  })
  expect(receipt.contract).toBe(manifestAllPromotesAgent.name)
  expect(receipt.red).toBe(true)
  expect(receipt.redError).toContain("expected the agent mode all")
  expect(receipt.beforeHash).toBe(receipt.afterHash)
  expect(fs.readFileSync(AGENTS_FILE).equals(before)).toBe(true)
})

test("mutation: promoting the fallback default turns unrelated agents primary", async () => {
  const before = fs.readFileSync(AGENTS_FILE)
  const receipt = await runMutation({
    file: AGENTS_FILE,
    mutate: (source) => source.replace('? source.mode : "subagent"', '? source.mode : "primary"'),
    contract: absentModeStaysSubagent,
  })
  expect(receipt.contract).toBe(absentModeStaysSubagent.name)
  expect(receipt.red).toBe(true)
  expect(receipt.redError).toContain("expected the subagent default")
  expect(receipt.beforeHash).toBe(receipt.afterHash)
  expect(fs.readFileSync(AGENTS_FILE).equals(before)).toBe(true)
})
