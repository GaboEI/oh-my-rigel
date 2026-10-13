#!/usr/bin/env node
/**
 * Deterministic guard for the NLS1-only boundary rule.
 *
 * `.omo/rules/protect-opencode-v1.md` used to declare the isolated V2 laboratory
 * (`opencode-v2-lab.service`) as the single authorized live path. The atomic law
 * makes NLS1 the only live validation surface, and the laboratory and Docker
 * prohibited. This guard is the machine check that keeps that alignment from
 * being silently reverted: it is deliberately a plain regex scan (no external
 * binary, no locale, no ordering) so CI, a developer laptop and an auditor all
 * reach the same verdict from the same bytes.
 *
 * It asserts three required properties and one prohibition:
 *   1. the rule states NLS1 is the only permitted live validation surface;
 *   2. every mention of the laboratory is a prohibition, not an authorization;
 *   3. Docker is prohibited;
 *   4. no legacy authorizing sentence for the laboratory is present.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const BOUNDARY_RULE_PATH = path.join(".omo", "rules", "protect-opencode-v1.md")
export const LABORATORY_SERVICE = "opencode-v2-lab.service"

const NLS1_ONLY_STATEMENTS = [
  /only permitted live validation surface/i,
  /only live validation surface/i,
  /live validation for oh my rigel v2 happens only on/i,
]

const PROHIBITION_WORDS = /\bprohibit(?:ed|s)?\b|\bforbidden\b|\bmay not\b|\bmust not\b|\bnever\b|\bnot a live\b|\bnot be used\b|\bno longer\b/i
const AUTHORIZATION_WORDS = /\bonly\b|\bsole\b|\bexecute only\b|\brefresh or install only\b|\bauthorized path\b|\bpermitted path\b|\bthe runtime path\b/i
// A Docker sentence must carry its own prohibition verb: an incidental "never"
// somewhere else on the line must not be able to satisfy this check.
const DOCKER_PROHIBITION = /\bDocker\b[^.]{0,120}\b(?:prohibited|forbidden|banned|may not|must not|is not allowed|not permitted)\b|\b(?:prohibited|forbidden|banned|may not|must not|is not allowed|not permitted)\b[^.]{0,120}\bDocker\b/i

const LEGACY_AUTHORIZATIONS = [
  /execute only through/i,
  /\bsole authorized path\b/i,
  /only permitted runtime path/i,
  /refresh or install only through/i,
  /use only its dedicated v2 state/i,
  /there is no second approved live-runtime path/i,
]

/**
 * Scan the rule text. Returns one entry per check with a machine-readable name so
 * a caller can report exactly which property regressed.
 */
export function scanRuleNls1Only(text) {
  const lines = text.split("\n")
  const laboratoryLines = lines.filter((line) => line.includes(LABORATORY_SERVICE))
  const dockerLines = lines.filter((line) => /\bdocker\b/i.test(line))

  const nls1Only = NLS1_ONLY_STATEMENTS.some((pattern) => pattern.test(text))
  const laboratoryProhibited =
    laboratoryLines.length > 0 && laboratoryLines.every((line) => !AUTHORIZATION_WORDS.test(line) || PROHIBITION_WORDS.test(line))
  const dockerProhibited = dockerLines.some((line) => DOCKER_PROHIBITION.test(line))
  const legacyAuthorization = lines
    .filter((line) => LEGACY_AUTHORIZATIONS.some((pattern) => pattern.test(line)))
    .map((line) => line.trim())

  const checks = [
    {
      name: "rule.nls1OnlyLiveSurface",
      pass: nls1Only,
      detail: nls1Only ? "the rule names NLS1 as the only permitted live validation surface" : "the rule no longer asserts an NLS1-only live surface",
    },
    {
      name: "rule.laboratoryProhibited",
      pass: laboratoryLines.length > 0 && laboratoryProhibited,
      detail:
        laboratoryLines.length === 0
          ? `the rule does not mention ${LABORATORY_SERVICE}; it must name what it prohibits`
          : laboratoryProhibited
            ? `every ${LABORATORY_SERVICE} mention is a prohibition`
            : `${LABORATORY_SERVICE} is mentioned as an authorized path`,
    },
    {
      name: "rule.dockerProhibited",
      pass: dockerProhibited,
      detail: dockerProhibited ? "Docker is prohibited by the rule" : "the rule no longer prohibits Docker",
    },
    {
      name: "rule.noLegacyLaboratoryAuthorization",
      pass: legacyAuthorization.length === 0,
      detail:
        legacyAuthorization.length === 0
          ? "no legacy authorizing sentence for the laboratory remains"
          : `legacy laboratory authorization restored: ${legacyAuthorization.join(" | ")}`,
    },
  ]

  return { ok: checks.every((check) => check.pass), checks }
}

export function scanBoundaryRule({ rulePath }) {
  if (!fs.existsSync(rulePath)) throw new Error(`boundary rule is missing: ${rulePath}`)
  return scanRuleNls1Only(fs.readFileSync(rulePath, "utf8"))
}

function main(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--rule" && argv[index + 1] !== undefined) { flags.rule = argv[index + 1]; index += 1 }
    if (argv[index] === "--json") flags.json = true
  }
  const repoRoot = path.resolve(path.join(fileURLToPath(import.meta.url), "../../.."))
  const rulePath = path.resolve(flags.rule ?? path.join(repoRoot, BOUNDARY_RULE_PATH))
  const result = scanBoundaryRule({ rulePath })
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify({ rulePath, ...result }, null, 2)}\n`)
  } else {
    for (const check of result.checks) process.stdout.write(`${check.pass ? "PASS" : "FAIL"} ${check.name}: ${check.detail}\n`)
  }
  return result.ok ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
