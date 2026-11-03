import { expect, test } from "bun:test"
import { rewriteLegacyDelegationToolExamples } from "./rigel-v2-native-prompt-tools.mjs"

test("rewrites only legacy delegation call names to the registered native tool", () => {
  expect(rewriteLegacyDelegationToolExamples(
    "task(subagent_type=\"explore\"); call_omo_agent(subagent_type=\"oracle\"); task_create(subject=\"x\"); rigel_task(prompt=\"already native\")",
  )).toBe(
    "rigel_task(subagent_type=\"explore\"); rigel_task(subagent_type=\"oracle\"); task_create(subject=\"x\"); rigel_task(prompt=\"already native\")",
  )
  expect(rewriteLegacyDelegationToolExamples(undefined)).toBeUndefined()
})

test("updates the OpenCode side of Codex compatibility examples and preserves Codex translations", () => {
  const prompt = [
    "Use task(subagent_type=\"explore\") in OpenCode.",
    "## Codex Harness Tool Compatibility",
    "In Codex, do not call task(...) or call_omo_agent(...); translate them.",
    "| OpenCode: task(subagent_type=\"explore\") | Codex: multi_agent_v1.spawn_agent(...) |",
    "## Usage",
    "Call task(category=\"quick\").",
  ].join("\n")

  expect(rewriteLegacyDelegationToolExamples(prompt)).toBe([
    "Use rigel_task(subagent_type=\"explore\") in OpenCode.",
    "## Codex Harness Tool Compatibility",
    "In Codex, do not call rigel_task(...) or rigel_task(...); translate them.",
    "| OpenCode: rigel_task(subagent_type=\"explore\") | Codex: multi_agent_v1.spawn_agent(...) |",
    "## Usage",
    "Call rigel_task(category=\"quick\").",
  ].join("\n"))
  expect(rewriteLegacyDelegationToolExamples(prompt)).toContain("multi_agent_v1")
})
