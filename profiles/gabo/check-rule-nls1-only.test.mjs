/**
 * Contract test for the single-laboratory boundary guard.
 *
 * Retention bar: this is a SECURITY/BOUNDARY contract, not prose coverage. The
 * rule file is machine-consumed (the rules-injector discovers and injects every
 * `.omo/rules/*.md`, and the session bootstrap reads it before any project work),
 * and the guard is the mechanism that keeps the declared live surface from being
 * silently reverted. Each case below is driven by an in-memory mutant of the
 * shipped rule, so the test fails for the exact regression it guards: restoring
 * a laboratory as an authorized live path, dropping the Docker prohibition,
 * dropping the kris-only statement, restoring NLS1, or allowing another lab.
 */
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { BOUNDARY_RULE_PATH, scanBoundaryRule, scanRuleNls1Only } from "./check-rule-nls1-only.mjs"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const rulePath = path.join(repoRoot, BOUNDARY_RULE_PATH)
const ruleText = fs.readFileSync(rulePath, "utf8")

const CHECK_NAMES = [
  "rule.krisOnlyLiveSurface",
  "rule.nls1Retired",
  "rule.otherLaboratoriesProhibited",
  "rule.laboratoryProhibited",
  "rule.dockerProhibited",
  "rule.noLegacyLaboratoryAuthorization",
]

function failingChecks(text) {
  return scanRuleNls1Only(text).checks.filter((check) => !check.pass).map((check) => check.name)
}

describe("#given the shipped boundary rule", () => {
  describe("#when the single-laboratory guard scans it", () => {
    test("#then kris-only, NLS1 retirement, laboratory prohibition, the Docker prohibition and the legacy-authorization check all hold", () => {
      const result = scanBoundaryRule({ rulePath })
      expect(result.checks.map((check) => check.name)).toEqual(CHECK_NAMES)
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

  describe("#when the kris-only statement is dropped", () => {
    test("#then the guard fails on the kris-only check", () => {
      const mutant = ruleText.replace(
        /Live validation for Oh My Rigel V2 happens only on \*\*kris\*\*[\s\S]*?There is no second approved live path\./,
        "Live validation happens on the approved surface.",
      )
      expect(mutant).not.toBe(ruleText)
      expect(failingChecks(mutant)).toEqual(["rule.krisOnlyLiveSurface"])
    })
  })

  describe("#when the NLS1 retirement is dropped", () => {
    test("#then the guard fails on the NLS1 retirement check", () => {
      const mutant = ruleText.replace(
        /\*\*NLS1 is retired\.\*\* It must not be used for validation, and any NLS1 evidence is historical\ntechnical support only, never conclusive\./,
        "NLS1 remains available as a secondary surface.",
      )
      expect(mutant).not.toBe(ruleText)
      expect(failingChecks(mutant)).toEqual(["rule.nls1Retired"])
    })
  })

  describe("#when another laboratory is authorized", () => {
    test("#then the guard fails on the other-laboratory prohibition", () => {
      const mutant = ruleText.replace(
        /Any other laboratory, service, sandbox, or runner is prohibited\s*\n?\s*and may not be used/,
        "Any other laboratory is permitted and may be used",
      )
      expect(mutant).not.toBe(ruleText)
      expect(failingChecks(mutant)).toEqual(["rule.otherLaboratoriesProhibited"])
    })
  })

  describe("#when the boundary rule cannot be read", () => {
    test("#then the guard fails closed instead of reporting a pass", () => {
      expect(() => scanBoundaryRule({ rulePath: path.join(repoRoot, ".omo", "rules", "does-not-exist.md") })).toThrow(/boundary rule is missing/)
    })
  })
})
