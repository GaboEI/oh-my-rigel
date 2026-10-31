import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildBuiltinCommandManifest, serializeBuiltinCommandManifest } from "./generate-v2-builtin-command-manifest.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const committedPath = path.join(here, "opencode/rigel-v2-native-builtin-command-manifest.mjs")

test("#given the V1 command owner #when the generator runs #then the committed manifest is byte-identical to a fresh generation", () => {
  const fresh = serializeBuiltinCommandManifest(buildBuiltinCommandManifest())
  const committed = readFileSync(committedPath, "utf8")
  expect(fresh).toBe(committed)
})

test("#given the migrated surface #when reading the manifest #then it owns the four remaining commands and no already-registered template", () => {
  const names = Object.keys(buildBuiltinCommandManifest().commands)
  expect(names).toEqual(["refactor", "remove-ai-slops", "handoff", "hyperplan"])
  for (const alreadyRegistered of ["goal", "ulw-execute", "stop-continuation"]) {
    expect(names).not.toContain(alreadyRegistered)
  }
})

test("#given the migrated surface #when reading the manifest #then every command carries a base and a team-mode template", () => {
  for (const [name, entry] of Object.entries(buildBuiltinCommandManifest().commands)) {
    expect(typeof entry.description).toBe("string")
    expect(entry.template.length).toBeGreaterThan(0)
    expect(entry.teamModeTemplate.length).toBeGreaterThan(0)
    expect(name.length).toBeGreaterThan(0)
  }
})

test("#given native command templates #when generated #then operational examples use V2 names and Codex compatibility stays intact", () => {
  for (const [name, entry] of Object.entries(buildBuiltinCommandManifest().commands)) {
    for (const template of [entry.template, entry.teamModeTemplate]) {
      expect(template, name).not.toMatch(/(?<!rigel_)\btask\(/)
      expect(template, name).not.toContain("call_omo_agent(")
      expect(template, name).not.toMatch(/`rigel_task\(\.\.\.\)`, `rigel_task\(\.\.\.\)`,/)
      if (template.includes("## Codex Harness Tool Compatibility")) {
        expect(template, name).toContain("multi_agent_v1.spawn_agent")
        expect(template, name).toContain("OpenCode example")
      }
    }
  }
})
