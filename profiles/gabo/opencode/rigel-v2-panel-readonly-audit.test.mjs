/**
 * Source guard for the passive native sidebar panel.
 *
 * This is an architecture owner test: the model stays host-free, the adapter
 * stays limited to the documented slot plus one approved read-only status
 * subscription, and every unrelated side effect remains forbidden.
 */
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))

function readSource(name) {
  return fs.readFileSync(path.join(HERE, name), "utf8")
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
}

const MODEL = stripComments(readSource("rigel-v2-panel-model.mjs"))
const SURFACE = stripComments(readSource("rigel-v2-panel-surface.mjs"))
const COMPOSITOR = stripComments(readSource("rigel-v2-native-cli.mjs"))

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

function forbiddenHits(text) {
  return FORBIDDEN_SYMBOLS.filter((symbol) => text.includes(symbol))
}

function stripApprovedStatusSubscription(text) {
  return text.replace(/on\.call\(context\.data,\s*"session\.status",\s*\(\)\s*=>\s*\{\}\)/g, "")
}

function hardenedHits(text) {
  return HARDENED_PROHIBITIONS
    .filter((rule) => rule.pattern.test(stripApprovedStatusSubscription(text)))
    .map((rule) => rule.label)
}

function fromSpecifiers(source) {
  return [...source.matchAll(/\bfrom\s*"([^"]+)"/g)].map((match) => match[1])
}

describe("native V2 read-only panel boundary", () => {
  test("#given the pure panel core #then it has no import statement or re-export", () => {
    expect(MODEL).not.toMatch(/(^|\n)\s*import\b/)
    expect(MODEL).not.toMatch(/(^|\n)\s*export\s[^\n]*\bfrom\b/)
    expect(MODEL).not.toMatch(/\bfrom\s*"/)
  })

  test("#given the panel core #then it exports only pure model entry points", () => {
    expect(MODEL).toContain("export function buildPanelModel")
    expect(MODEL).toContain("export function formatPanel")
    expect(MODEL).toContain("export const PANEL_ID")
  })

  test("#given the adapter #then it keeps exactly two imports and the one sidebar slot", () => {
    expect(fromSpecifiers(SURFACE)).toHaveLength(2)
    expect(new Set(fromSpecifiers(SURFACE))).toEqual(new Set(["@opentui/solid", "./rigel-v2-panel-model.mjs"]))
    expect(SURFACE).toContain("context.ui.slot({")
    expect(SURFACE).toContain('PANEL_SLOT_APPEND = "sidebar.content"')
    expect(SURFACE).toContain('makeNode(solid, "box"')
    expect(SURFACE).toContain('makeNode(solid, "text"')
    expect(SURFACE).toContain("borderStyle")
    expect((SURFACE.match(/\.slot\s*\(/g) ?? []).length).toBe(1)
    expect(SURFACE).not.toMatch(/\bappend\s*:\s*["']app["']/)
  })

  test("#given the approved refresh seam #then only one session.status subscription is present", () => {
    expect((SURFACE.match(/session\.status/g) ?? []).length).toBeGreaterThan(0)
    expect((SURFACE.match(/on\.call\(context\.data,\s*"session\.status"/g) ?? []).length).toBe(1)
    expect(SURFACE).toContain("removeStatus")
  })

  test("#given the composed CLI entry #then the panel is composed after the protected surfaces", () => {
    expect(COMPOSITOR).toContain('from "./rigel-v2-panel-surface.mjs"')
    expect(COMPOSITOR).toContain("createPanelSurface(")
    expect(COMPOSITOR.indexOf("createPanelSurface(")).toBeGreaterThan(COMPOSITOR.indexOf("createBtwCliSurface("))
  })

  test("#given the panel sources #then retired mechanics and unrelated side effects stay forbidden", () => {
    expect(forbiddenHits(MODEL)).toEqual([])
    expect(forbiddenHits(SURFACE)).toEqual([])
    expect(forbiddenHits(COMPOSITOR)).toEqual([])
    expect(hardenedHits(MODEL)).toEqual([])
    expect(hardenedHits(SURFACE)).toEqual([])
  })

  test("#given the panel sources #then no V1 package or node builtin enters the pure seam", () => {
    for (const source of [MODEL, SURFACE, COMPOSITOR]) expect(source).not.toContain("packages/omo-opencode")
    for (const source of [MODEL, SURFACE]) expect(source).not.toMatch(/\bfrom\s*"node:/)
  })

  test("#given a planted violation #then the scanners report it RED", () => {
    expect(forbiddenHits("api.slots.register({})")).toContain("api.slots.register")
    expect(forbiddenHits("const view = buildViewNodes(model)\n")).toEqual(["buildViewNodes"])
    expect(hardenedHits('console.error("x")')).toEqual(["product logging"])
    expect(hardenedHits("context.keymap.layer(fn)")).toEqual(["keymap"])
    expect(hardenedHits("context.storage.store() ")).toEqual(["storage"])
    expect(hardenedHits("const layer = { commands: [] }")).toContain("command")
    expect(hardenedHits("context.ui.slot({ append: \"app\", render })")).toContain("app-slot")
    expect(hardenedHits("dispose()")).toEqual(["manual disposer invocation"])
  })
})
