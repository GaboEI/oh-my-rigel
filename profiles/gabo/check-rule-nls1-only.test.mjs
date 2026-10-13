/**
 * Contract test for the NLS1-only boundary guard.
 *
 * Retention bar: this is a SECURITY/BOUNDARY contract, not prose coverage. The
 * rule file is machine-consumed (the rules-injector discovers and injects every
 * `.omo/rules/*.md`, and the session bootstrap reads it before any project work),
 * and the guard is the mechanism the audited plan requires to keep the alignment
 * from being silently reverted. Each case below is driven by an in-memory mutant
 * of the shipped rule, so the test fails for the exact regression it guards:
 * restoring the laboratory as an authorized live path, dropping the Docker
 * prohibition, or dropping the NLS1-only statement.
 */
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { BOUNDARY_RULE_PATH, scanBoundaryRule, scanRuleNls1Only } from "./check-rule-nls1-only.mjs"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const rulePath = path.join(repoRoot, BOUNDARY_RULE_PATH)
const ruleText = fs.readFileSync(rulePath, "utf8")

function failingChecks(text) {
  return scanRuleNls1Only(text).checks.filter((check) => !check.pass).map((check) => check.name)
}

describe("#given the shipped boundary rule", () => {
  describe("#when the NLS1-only guard scans it", () => {
    test("#then NLS1-only, the laboratory prohibition, the Docker prohibition and the legacy-authorization check all hold", () => {
      const result = scanBoundaryRule({ rulePath })
      expect(result.checks.map((check) => check.name)).toEqual([
        "rule.nls1OnlyLiveSurface",
        "rule.laboratoryProhibited",
        "rule.dockerProhibited",
        "rule.noLegacyLaboratoryAuthorization",
      ])
      expect(result.ok).toBe(true)
    })

    test("#then the rule no longer names the laboratory as the authorized live runtime path", () => {
      expect(ruleText).not.toMatch(/execute only through/i)
      expect(ruleText).not.toMatch(/sole authorized path/i)
      expect(ruleText).not.toMatch(/only permitted runtime path/i)
    })
  })

  describe("#when the laboratory is re-authorized as a live path", () => {
    test("#then the guard fails on the restored authorization", () => {
      const mutant = ruleText.replace(
        "## The only permitted live validation surface",
        [
          "## The only permitted runtime path",
          "",
          "The sole authorized path for any live OpenCode V2 execution is the existing dedicated V2 laboratory:",
          "",
          "- execute only through `opencode-v2-lab.service`;",
          "",
          "## The only permitted live validation surface",
        ].join("\n"),
      )
      expect(mutant).not.toBe(ruleText)
      expect(failingChecks(mutant)).toContain("rule.noLegacyLaboratoryAuthorization")
      expect(failingChecks(mutant)).toContain("rule.laboratoryProhibited")
    })
  })

  describe("#when the Docker prohibition is dropped", () => {
    test("#then the guard fails on the Docker check", () => {
      const mutant = ruleText.replace(/Docker and every container-based runner are (?:explicitly )?prohibited[^.]*\./g, "Docker is available for isolation.")
      expect(mutant).not.toBe(ruleText)
      expect(failingChecks(mutant)).toEqual(["rule.dockerProhibited"])
    })
  })

  describe("#when the NLS1-only statement is dropped", () => {
    test("#then the guard fails on the NLS1 check", () => {
      const mutant = ruleText
        .replace(/## The only permitted live validation surface/, "## Approved runtime surface")
        .replace(/Live validation for Oh My Rigel V2 happens only on \*\*NLS1\*\*[\s\S]*?There is no second approved live path\./, "Live validation happens on the approved surface.")
      expect(mutant).not.toBe(ruleText)
      expect(failingChecks(mutant)).toEqual(["rule.nls1OnlyLiveSurface"])
    })
  })

  describe("#when the boundary rule cannot be read", () => {
    test("#then the guard fails closed instead of reporting a pass", () => {
      expect(() => scanBoundaryRule({ rulePath: path.join(repoRoot, ".omo", "rules", "does-not-exist.md") })).toThrow(/boundary rule is missing/)
    })
  })
})
