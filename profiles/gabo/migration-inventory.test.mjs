import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "../..")
const ledgerPath = path.join(here, "V2_MIGRATION_INVENTORY.md")
const generatorPath = path.join(here, "generate-v2-migration-inventory.mjs")

const ALLOWED = new Set([
  "Migrar",
  "Adaptar",
  "Equivale a builtin V2",
  "Interno de build (sin superficie de runtime)",
  "Excluido (unwired upstream)",
])

// The bounded migration-status vocabulary the generator enforces on authored
// fragments. Every rendered Estado column must be one of these values.
const ALLOWED_STATUSES = new Set([
  "Migrado",
  "Migrado parcialmente",
  "Incompatible (con evidencia)",
  "Pendiente de ejecución",
  "unwired upstream",
])

// Authored statuses that must reach the ledger for the audited surfaces. The
// two `monitor` rows (tools and features) both carry the same authored status,
// so the duplicate entry requires both rows to render it.
const EXPECTED_STATUS_ROWS = [
  ["goal", "Migrado"],
  // The final two surface walls must render as migrated in the ledger.
  ["auto-update-checker", "Migrado"],
  ["tool-definition", "Migrado"],
  ["glob", "Migrado"],
  ["grep", "Migrado"],
  ["interactive-bash-session", "Migrado"],
  ["monitor", "Migrado"],
  ["monitor", "Migrado"],
  ["session-manager", "Migrado"],
  ["session-notification", "Migrado"],
  ["task", "Migrado"],
  ["opencode-skill-loader", "Migrado"],
  ["Goal", "Migrado"],
  // Rows closed in the T25 closure pass, each pinned so a regeneration cannot
  // silently downgrade the audited terminal status.
  ["continuations", "Migrado"],
  ["Team mode", "Migrado"],
  ["boulder-state", "Migrado"],
  ["claude-tasks", "Migrado"],
  ["delegate-task", "Migrado"],
  ["background-task", "Migrado"],
  ["background-notification", "Migrado"],
  ["chat-message", "Migrado"],
  ["stop-continuation", "Migrado"],
  ["session-compacting", "Migrado"],
  ["context7", "Migrado"],
  ["websearch", "Migrado"],
  ["default Ultrawork", "Migrado"],
  ["keyword Ultrawork / ULW", "Migrado"],
  ["background-task handoff", "Migrado"],
  // T25 final closure: the last real runtime gaps, each pinned so a
  // regeneration cannot silently downgrade the audited terminal status.
  ["legacy-plugin-toast", "Migrado"],
  ["native-edition-nudge", "Migrado"],
  ["native-edition-nudge", "Migrado"],
  ["btw-side", "Migrado"],
  ["opengateway-provider", "Migrado"],
  ["task-toast-manager", "Migrado"],
  // The 2026-10-14 sidebar retirement withdrew the native V2 port; the
  // from-scratch rewrite then passed its live gates (S6 candidate + S7
  // canonical a1c152be), so the row is pinned terminal.
  ["tui-sidebar", "Migrado"],
  ["gpt-apply-patch-guard", "Migrado"],
  ["boulder", "Migrado"],
  ["doctor", "Migrado"],
  ["get-local-version", "Migrado"],
]

// Terminal statuses: a closed row renders one of these. Anything else is an
// open row and must be named in OPEN_GAPS_T25.
const TERMINAL_STATUSES = new Set(["Migrado", "Equivale a builtin V2", "unwired upstream"])

// T25 open-debt register. A non-terminal row is only allowed if it is named
// here, so a regeneration can never introduce a NEW silent pending/partial row.
// The from-scratch sidebar rewrite closed at S7 (canonical a1c152be), so there
// is no remaining open debt. Any non-terminal row fails the suite.
const OPEN_GAPS_T25 = []


// The rationale is greedy so a stray " | " inside it does not split the row.
const ROW = /^\| `([^`]+)` \| ([^|]+?) \| ([^|]+?) \| (.+) \| (.+) \|$/

function readLedger() {
  return fs.readFileSync(ledgerPath, "utf8")
}

function parseRows(markdown) {
  const rows = []
  for (const line of markdown.split("\n")) {
    const match = line.match(ROW)
    if (!match) continue
    rows.push({
      name: match[1],
      classification: match[2].trim(),
      status: match[3].trim(),
      rationale: match[4].trim(),
      futureEvidence: match[5].trim(),
    })
  }
  return rows
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex")
}

describe("migration inventory ledger", () => {
  const markdown = readLedger()
  const rows = parseRows(markdown)

  describe("#given the generated ledger", () => {
    test("#then it classifies at least every V1 surface", () => {
      expect(rows.length).toBeGreaterThanOrEqual(198)
    })

    test("#then no row is left unclassified", () => {
      const pending = rows.filter((row) => row.classification === "SIN CLASIFICAR")
      expect(pending.map((row) => row.name)).toEqual([])
      expect(markdown.includes("SIN CLASIFICAR")).toBe(true)
    })

    test("#then no legacy pending sentinel survives", () => {
      const legacy = rows.filter((row) => row.classification.includes("Pendiente de clasificación"))
      expect(legacy.map((row) => row.name)).toEqual([])
    })

    test("#then every classification is in the allowed vocabulary", () => {
      const invalid = rows
        .filter((row) => !ALLOWED.has(row.classification))
        .map((row) => `${row.name}: ${row.classification}`)
      expect(invalid).toEqual([])
    })

    test("#then every rendered Estado is in the status vocabulary", () => {
      const invalid = rows
        .filter((row) => !ALLOWED_STATUSES.has(row.status))
        .map((row) => `${row.name}: ${row.status}`)
      expect(invalid).toEqual([])
    })

    test("#then the audited surfaces render their authored status", () => {
      const required = new Map()
      for (const [name, status] of EXPECTED_STATUS_ROWS) {
        const key = `${name}\u0000${status}`
        required.set(key, (required.get(key) ?? 0) + 1)
      }
      const unmet = []
      for (const [key, count] of required) {
        const [name, status] = key.split("\u0000")
        const actual = rows.filter((row) => row.name === name && row.status === status).length
        if (actual < count) unmet.push(`${name}: ${status} (${actual}/${count})`)
      }
      expect(unmet).toEqual([])
    })

    test("#then no row outside the T25 open-debt register is left non-terminal", () => {
      const nonTerminal = rows
        .filter((row) => !TERMINAL_STATUSES.has(row.status))
        .map((row) => row.name)
        .sort()
      expect(nonTerminal).toEqual(OPEN_GAPS_T25)
    })

    test("#then every row carries a rationale and a future-evidence entry", () => {
      const incomplete = rows
        .filter((row) => row.rationale.length === 0 || row.rationale === "-" || row.futureEvidence.length === 0)
        .map((row) => row.name)
      expect(incomplete).toEqual([])
    })

    test("#then no machine-local personal path leaks into the ledger", () => {
      expect(/\/home\/gabodev/.test(markdown)).toBe(false)
    })

    test("#then no em dash or en dash is present", () => {
      expect(/[\u2014\u2013]/.test(markdown)).toBe(false)
    })
  })

  describe("#when the generator runs twice", () => {
    test("#then it is idempotent and does not downgrade classifications", () => {
      const before = readLedger()
      execFileSync("node", [generatorPath], { cwd: root, stdio: "pipe" })
      const first = readLedger()
      execFileSync("node", [generatorPath], { cwd: root, stdio: "pipe" })
      const second = readLedger()
      expect(sha256(first)).toBe(sha256(second))
      // Regeneration must preserve every classification already present.
      // Rows are compared by position: the generator emits them in a stable
      // order, and a row name is not unique across sections (for example
      // `monitor` and `atlas` appear in more than one section).
      const beforeRows = parseRows(before)
      const afterRows = parseRows(second)
      expect(afterRows.length).toBe(beforeRows.length)
      beforeRows.forEach((row, index) => {
        const after = afterRows[index]
        expect(after.name).toBe(row.name)
        if (row.classification !== "SIN CLASIFICAR") {
          expect(after.classification).toBe(row.classification)
        }
      })
    })
  })
})
