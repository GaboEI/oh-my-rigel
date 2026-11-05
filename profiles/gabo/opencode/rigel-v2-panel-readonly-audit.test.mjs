/**
 * Read-only boundary audit for the native V2 panel (S2/S3/S4).
 *
 * Architecture contract this test owns (test-discipline retention bar): the
 * read-only visual panel must stay a passive consumer at the host boundary. That
 * is a compiled-in harness boundary no runtime assertion can observe once the
 * module is loaded, so it is guarded at the source seam, scoped to exactly the
 * three files this change owns. Four independent contracts:
 *   - the pure core has ZERO imports (deterministic, no host/fs/timers);
 *   - the adapter's ONLY imports are the relative core and the host-resolved
 *     OpenTUI peer, and it registers the single sidebar slot and nothing else;
 *   - the panel exposes no interactive surface: no app-slot, no command, no
 *     keymap, no hook/event, no subscription, no write/mutator, no product log;
 *   - the retired V1 mechanics and the S1-only instrumentation are pinned
 *     forbidden, so a later edit cannot silently reintroduce them.
 * Comments are stripped before every scan so prose can neither create nor hide a
 * hit; the negatives are scoped to the three files (never the V1 OmO tree).
 */
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))

function readSource(name) {
  return fs.readFileSync(path.join(HERE, name), "utf8")
}

/** Remove block and line comments so prose cannot create false hits or misses. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
}

const MODEL = stripComments(readSource("rigel-v2-panel-model.mjs"))
const SURFACE = stripComments(readSource("rigel-v2-panel-surface.mjs"))
const COMPOSITOR = stripComments(readSource("rigel-v2-native-cli.mjs"))

// Retired V1/V2-native sidebar mechanics and S1-only instrumentation.
const FORBIDDEN_SYMBOLS = [
  "api.slots.register",
  "slots.register",
  "sidebar_content",
  "buildViewNodes",
  "describeView",
  "TuiRuntimeSnapshot",
  "writeMirror",
  "readMirror",
  "resolveRoster",
  "validatePluginConfig",
  "getTasksSnapshot",
  "readActiveLoop",
  "backgroundManager",
]

function forbiddenHits(text) {
  return FORBIDDEN_SYMBOLS.filter((symbol) => text.includes(symbol))
}

// Contract prohibitions a passive consumer must never carry: no interaction
// surface, no side effect, no persistence.
const HARDENED_PROHIBITIONS = [
  { label: "product logging", pattern: /console\s*\.|process\s*\.\s*(stdout|stderr)/ },
  { label: "writes/mutators", pattern: /\b(writeFile|writeFileSync|appendFileSync|mkdirSync|rmSync|renameSync|unlinkSync|createWriteStream)\b/ },
  { label: "dynamic require", pattern: /\brequire\s*\(/ },
  { label: "command", pattern: /\bcommands?\s*[:(]|\bslash\s*:|["']slash["']/ },
  { label: "keymap", pattern: /\bkeymap\b/ },
  { label: "hooks/events", pattern: /\bhooks?\s*:|\bevents?\s*:|\bcontext\.event\b/ },
  { label: "storage", pattern: /\bcontext\.storage\b|\bstorage\s*\.\s*(store|memory)\b/ },
  { label: "timers", pattern: /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b/ },
  { label: "subscriptions", pattern: /\bdata\.on\s*\(|\.subscribe\s*\(|\.listen\s*\(/ },
  { label: "sync/invalidate", pattern: /\binvalidate\b|\.sync\s*\(/ },
  { label: "app-slot", pattern: /\bappend\s*:\s*["']app["']/ },
  { label: "manual disposer invocation", pattern: /\bdispose\s*\(\s*\)/ },
]

function hardenedHits(text) {
  return HARDENED_PROHIBITIONS.filter((rule) => rule.pattern.test(text)).map((rule) => rule.label)
}

function fromSpecifiers(source) {
  return [...source.matchAll(/\bfrom\s*"([^"]+)"/g)].map((match) => match[1])
}

describe("native V2 read-only panel boundary", () => {
  describe("#given the pure panel core", () => {
    test("#then it has no import statement and no re-export", () => {
      expect(MODEL).not.toMatch(/(^|\n)\s*import\b/)
      expect(MODEL).not.toMatch(/(^|\n)\s*export\s[^\n]*\bfrom\b/)
      expect(MODEL).not.toMatch(/\bfrom\s*"/)
    })

    test("#then it exposes the model, the formatter and the id", () => {
      expect(MODEL).toContain("export function buildPanelModel")
      expect(MODEL).toContain("export function formatPanel")
      expect(MODEL).toContain("export const PANEL_ID")
    })
  })

  describe("#given the panel adapter", () => {
    test("#then its only specifiers are the relative core and the bare OpenTUI peer", () => {
      const specifiers = fromSpecifiers(SURFACE)
      expect(specifiers).toHaveLength(2)
      expect(new Set(specifiers)).toEqual(new Set(["@opentui/solid", "./rigel-v2-panel-model.mjs"]))
    })

    test("#then it uses only the double-quoted static import form", () => {
      expect(SURFACE).not.toMatch(/\bfrom\s*'/)
      expect(SURFACE).not.toMatch(/\bimport\s+["']/)
      expect(SURFACE).not.toMatch(/\bimport\s*\(\s*["'`]/)
    })

    test("#then it registers exactly one sidebar.content slot and builds one <text> node", () => {
      expect(SURFACE).toContain("context.ui.slot({")
      expect(SURFACE).toContain("append: PANEL_SLOT_APPEND")
      expect(SURFACE).toContain('PANEL_SLOT_APPEND = "sidebar.content"')
      expect(SURFACE).toContain('createElement("text")')
      expect(SURFACE).toContain("insert(")
      // Exactly one slot call, and never an auxiliary `app` slot.
      expect((SURFACE.match(/\.slot\s*\(/g) ?? []).length).toBe(1)
      expect(SURFACE).not.toMatch(/\bappend\s*:\s*["']app["']/)
    })
  })

  describe("#given the composed ./tui entry", () => {
    test("#then it imports and composes the panel after the protected surfaces", () => {
      expect(COMPOSITOR).toContain('from "./rigel-v2-panel-surface.mjs"')
      expect(COMPOSITOR).toContain("createPanelSurface(")
      expect(COMPOSITOR.indexOf("createPanelSurface(")).toBeGreaterThan(COMPOSITOR.indexOf("createBtwCliSurface("))
    })
  })

  describe("#given the panel sources", () => {
    test("#then none reintroduces a retired mechanic or S1-only instrumentation", () => {
      expect(forbiddenHits(MODEL)).toEqual([])
      expect(forbiddenHits(SURFACE)).toEqual([])
      expect(forbiddenHits(COMPOSITOR)).toEqual([])
    })

    test("#then none imports a V1 OmO surface or a node builtin", () => {
      for (const source of [MODEL, SURFACE, COMPOSITOR]) {
        expect(source).not.toContain("packages/omo-opencode")
      }
      for (const source of [MODEL, SURFACE]) {
        expect(source).not.toMatch(/\bfrom\s*"node:/)
      }
    })

    test("#then none carries an interaction surface, a side effect or persistence", () => {
      expect(hardenedHits(MODEL)).toEqual([])
      expect(hardenedHits(SURFACE)).toEqual([])
    })
  })

  describe("#given a planted violation", () => {
    test("#then the retired-mechanic scanner reports it RED", () => {
      expect(forbiddenHits("api.slots.register({})")).toContain("api.slots.register")
      expect(forbiddenHits("const view = buildViewNodes(model)\n")).toEqual(["buildViewNodes"])
    })

    test("#then the hardened scanner reports each planted prohibition RED", () => {
      expect(hardenedHits('console.error("x")')).toEqual(["product logging"])
      expect(hardenedHits("context.keymap.layer(fn)")).toEqual(["keymap"])
      expect(hardenedHits("context.storage.store()")).toEqual(["storage"])
      expect(hardenedHits("const layer = { commands: [] }")).toContain("command")
      expect(hardenedHits("const spec = { slash: {} }")).toContain("command")
      expect(hardenedHits("context.ui.slot({ append: \"app\", render })")).toContain("app-slot")
      expect(hardenedHits("dispose()")).toEqual(["manual disposer invocation"])
    })
  })
})
