#!/usr/bin/env node
/**
 * Deterministic guard for the single-laboratory boundary rule.
 *
 * `.omo/rules/protect-opencode-v1.md` declares **kris** the only permitted live
 * validation surface and retires **NLS1**. The laboratory service
 * (`opencode-v2-lab.service`) and Docker remain prohibited. This guard is the
 * machine check that keeps that alignment from being silently reverted: it is
 * deliberately a plain regex scan (no external binary, no locale, no ordering)
 * so CI, a developer laptop and an auditor all reach the same verdict from the
 * same bytes.
 *
 * It asserts four required properties and one prohibition:
 *   1. the rule states live validation happens only on kris;
 *   2. the rule retires NLS1 explicitly;
 *   3. every other laboratory, service, sandbox and runner is prohibited;
 *   4. Docker is prohibited;
 *   5. no legacy authorizing sentence for the laboratory is present.
 *
 * The module and file name are retained for compatibility with the profile
 * README and any external auditor script; only the enforced policy moved from
 * NLS1 to kris.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const BOUNDARY_RULE_PATH = path.join(".omo", "rules", "protect-opencode-v1.md")
export const LABORATORY_SERVICE = "opencode-v2-lab.service"
export const LIVE_LABORATORY = "kris"

const KRIS_ONLY_STATEMENTS = [
  /live validation for oh my rigel v2 happens only on \*\*kris\*\*/i,
  /only permitted live validation surface[\s\S]{0,400}\bonly on \*\*kris\*\*/i,
]

const NLS1_RETIRED_STATEMENTS = [
  /\bNLS1 is retired\b/i,
  /\bNLS1\b[^.]{0,80}\bmust not be used\b/i,
]

const OTHER_LAB_PROHIBITION =
  /\bany other laborator(?:y|ies)\b[^.]{0,160}\b(?:prohibited|forbidden|banned|may not|must not|is not allowed|not permitted)\b/i
const OTHER_LAB_AUTHORIZATION =
  /\bany other laborator(?:y|ies)\b[^.]{0,80}\b(?:permitted|allowed|authorized|available)\b/i

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

  const krisOnly = KRIS_ONLY_STATEMENTS.some((pattern) => pattern.test(text))
  const nls1Retired = NLS1_RETIRED_STATEMENTS.some((pattern) => pattern.test(text))
  const otherLaboratoriesProhibited =
    /\bkris is the only laboratory\b/i.test(text) &&
    OTHER_LAB_PROHIBITION.test(text) &&
    !OTHER_LAB_AUTHORIZATION.test(text)
  const laboratoryProhibited =
    laboratoryLines.length === 0 ||
    laboratoryLines.every((line) => !AUTHORIZATION_WORDS.test(line) || PROHIBITION_WORDS.test(line))
  const dockerProhibited = dockerLines.some((line) => DOCKER_PROHIBITION.test(line))
  const legacyAuthorization = lines
    .filter((line) => LEGACY_AUTHORIZATIONS.some((pattern) => pattern.test(line)))
    .map((line) => line.trim())

  const checks = [
    {
      name: "rule.krisOnlyLiveSurface",
      pass: krisOnly,
      detail: krisOnly
        ? "the rule names kris as the only permitted live validation surface"
        : "the rule no longer asserts that live validation happens only on kris",
    },
    {
      name: "rule.nls1Retired",
      pass: nls1Retired,
      detail: nls1Retired
        ? "the rule retires NLS1 explicitly"
        : "the rule no longer states that NLS1 is retired and must not be used",
    },
    {
      name: "rule.otherLaboratoriesProhibited",
      pass: otherLaboratoriesProhibited,
      detail: otherLaboratoriesProhibited
        ? "kris is the only laboratory and every other laboratory, service, sandbox and runner is prohibited"
        : "the rule does not both name kris as the only laboratory and prohibit the others",
    },
    {
      name: "rule.laboratoryProhibited",
      pass: laboratoryProhibited,
      detail:
        laboratoryLines.length === 0
          ? `${LABORATORY_SERVICE} is not named as an authorized path`
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
