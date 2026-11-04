import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// Fail-closed WCAG contrast gate over the LONG palette tokens that W5 actually uses.
// It parses the two `:root` token sets from styles.css (dark default + light media),
// resolves `var()` chains, computes the real WCAG 2.1 contrast ratio, and asserts the
// thresholds the phase requires: >= 4.5:1 for text, >= 3:1 for focus/indicator and other
// non-text UI. A missing token or an unresolvable var() fails the suite (never silently
// skipped), so a token edit that breaks contrast is a build failure.

const CSS = readFileSync(new URL("./styles.css", import.meta.url), "utf8")

type Tokens = Record<string, string>

function parseDecls(body: string): Tokens {
  const decls: Tokens = {}
  for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) decls[match[1]] = match[2].trim()
  return decls
}

function darkTokens(): Tokens {
  const block = CSS.match(/:root\s*\{([^}]*)\}/)
  if (!block) throw new Error("styles.css is missing the default :root token block")
  return parseDecls(block[1])
}

function lightTokens(base: Tokens): Tokens {
  const at = CSS.indexOf("@media (prefers-color-scheme: light)")
  if (at < 0) throw new Error("styles.css is missing the light colour-scheme block")
  const slice = CSS.slice(at)
  const start = slice.indexOf(":root")
  const open = slice.indexOf("{", start)
  const close = slice.indexOf("}", open)
  return { ...base, ...parseDecls(slice.slice(open + 1, close)) }
}

function resolve(tokens: Tokens, name: string, seen: string[] = []): string {
  if (seen.includes(name)) throw new Error(`var() cycle at ${name}`)
  const value = tokens[name]
  if (value === undefined) throw new Error(`token ${name} is not defined`)
  const ref = value.match(/^var\(\s*(--[a-z0-9-]+)\s*\)$/)
  return ref ? resolve(tokens, ref[1], [...seen, name]) : value
}

function toRgb(hex: string): [number, number, number] {
  const h = hex.trim().replace(/^#/, "")
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`not a 6-digit hex colour: ${hex}`)
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function luminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(toRgb(a)), luminance(toRgb(b))].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function ratio(tokens: Tokens, fg: string, bg: string): number {
  return contrastRatio(resolve(tokens, fg), resolve(tokens, bg))
}

const TEXT = 4.5
const NON_TEXT = 3

// Each pair maps to a real usage in styles.css (commented), not a cartesian product.
const TEXT_PAIRS: [string, string, string][] = [
  ["--fg", "--bg", "body text"],
  ["--fg-muted", "--bg", "lead/meta on page background"],
  ["--fg-label", "--bg", "eyebrow/permalink on page background"],
  ["--accent", "--bg", "default link text"],
  ["--visited", "--bg", "visited link text"],
  ["--fg", "--surf", "fact-list cell text / open body"],
  ["--fg-muted", "--surf", "dt, setting label, copy icon, ficha one-liner"],
  ["--fg", "--surf-2", "open ficha title"],
  ["--fg-muted", "--surf-2", "hovered control text"],
  ["--btn-fg", "--btn-bg", "primary CTA at rest"],
  ["--btn-fg-hover", "--btn-bg-hover", "primary CTA hover/focus"],
  ["--fg", "--ficha-bg", "closed ficha summary text"],
  ["--fg-muted", "--ficha-bg", "closed ficha one-liner"],
  ["--fg", "--ficha-open-bg", "open ficha summary title"],
  ["--fg-muted", "--ficha-open-bg", "open ficha one-liner"],
]

const NON_TEXT_PAIRS: [string, string, string][] = [
  ["--accent", "--bg", "focus outline on page background"],
  ["--accent", "--surf", "focus outline on a control surface"],
  ["--accent", "--surf-2", "open ficha left accent / hovered focus"],
  ["--accent", "--ficha-open-bg", "open ficha left accent"],
  ["--info", "--surf", "command chip / agent-prompt / setting left border"],
  ["--info", "--bg", "agent-prompt left border on page"],
  ["--ok", "--bg", "preserve-note border"],
  ["--warn", "--bg", "lifecycle-env-note border"],
  ["--err", "--ficha-bg", "copy error icon and error border on the command row"],
  ["--err", "--bg", "error command-row border against the page background"],
]

describe("#given the W5 palette tokens #when WCAG contrast is measured #then every used pair passes", () => {
  for (const [theme, build] of [["dark", (): Tokens => darkTokens()], ["light", (): Tokens => lightTokens(darkTokens())]] as const) {
    describe(`#given the ${theme} theme`, () => {
      test(`#given text pairs #when measured #then each is >= ${TEXT}:1`, () => {
        // given / when / then
        const tokens = build()
        for (const [fg, bg, usage] of TEXT_PAIRS) {
          const value = ratio(tokens, fg, bg)
          expect([theme, fg, bg, usage, Number(value.toFixed(2)) >= TEXT]).toEqual([theme, fg, bg, usage, true])
        }
      })

      test(`#given focus and non-text pairs #when measured #then each is >= ${NON_TEXT}:1`, () => {
        // given / when / then
        const tokens = build()
        for (const [fg, bg, usage] of NON_TEXT_PAIRS) {
          const value = ratio(tokens, fg, bg)
          expect([theme, fg, bg, usage, Number(value.toFixed(2)) >= NON_TEXT]).toEqual([theme, fg, bg, usage, true])
        }
      })
    })
  }
})

describe("#given the contrast helper #when fed a low-contrast pair #then it reports below threshold", () => {
  test("#given two mid greys #when measured #then the ratio is below 4.5 (negative control)", () => {
    // given / when / then
    expect(contrastRatio("#777777", "#888888")).toBeLessThan(TEXT)
    expect(contrastRatio("#000000", "#ffffff")).toBeGreaterThan(20)
  })

  test("#given an undefined token #when resolved #then it throws (fail-closed)", () => {
    // given / when / then
    expect(() => resolve(darkTokens(), "--not-a-token")).toThrow()
  })
})
