/**
 * Owner tests for the defensive V2 theme adapter.
 *
 * The host exposes a NESTED plugin theme (`text.feedback.*`, `text.muted`,
 * `text.base`, `text.action.primary.base`, `hue.accent[400]`, `border.base`),
 * while the ported V1 IR expects FLAT keys. The adapter must resolve either
 * shape and never assume one host version.
 */
import { describe, expect, test } from "bun:test"

import { adaptTheme } from "./rigel-v2-sidebar-theme.mjs"

const NESTED = {
  text: {
    base: "TEXT",
    muted: "MUTED",
    feedback: {
      warning: { base: "WARN" },
      success: { base: "OK" },
      error: { base: "ERR" },
      info: { base: "INFO" },
    },
    action: { primary: { base: "ACTION" } },
  },
  hue: { accent: { 400: "ACCENT" } },
  border: { base: "BORDER" },
}

const FLAT = {
  text: "TEXT",
  textMuted: "MUTED",
  warning: "WARN",
  success: "OK",
  error: "ERR",
  info: "INFO",
  accent: "ACCENT",
  borderSubtle: "BORDER",
}

describe("adaptTheme", () => {
  test("#given the nested V2 shape #then every flat key maps", () => {
    expect(adaptTheme(NESTED)).toEqual({
      warning: "WARN",
      success: "OK",
      error: "ERR",
      info: "INFO",
      textMuted: "MUTED",
      text: "TEXT",
      accent: "ACCENT",
      borderSubtle: "BORDER",
    })
  })

  test("#given the flat shape #then the same flat keys resolve (defensive fallback)", () => {
    expect(adaptTheme(FLAT)).toEqual({
      warning: "WARN",
      success: "OK",
      error: "ERR",
      info: "INFO",
      textMuted: "MUTED",
      text: "TEXT",
      accent: "ACCENT",
      borderSubtle: "BORDER",
    })
  })

  test("#given a nested theme without hue #then accent falls back to text.action.primary.base", () => {
    const theme = { text: { ...NESTED.text, action: { primary: { base: "ACTION" } } }, border: { base: "B" } }
    expect(adaptTheme(theme).accent).toBe("ACTION")
  })

  test("#given no theme #then every key is undefined (no crash)", () => {
    expect(adaptTheme(undefined)).toEqual({
      warning: undefined,
      success: undefined,
      error: undefined,
      info: undefined,
      textMuted: undefined,
      text: undefined,
      accent: undefined,
      borderSubtle: undefined,
    })
  })
})
