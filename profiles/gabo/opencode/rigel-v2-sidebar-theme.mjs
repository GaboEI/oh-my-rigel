/**
 * Defensive V2 theme adapter for the sidebar.
 *
 * `buildViewNodes` (the V1 IR) expects FLAT theme keys:
 *   error, warning, success, info, text, textMuted, accent, borderSubtle.
 * The V2 plugin context theme is NESTED in the installed host (`text.feedback.*`,
 * `text.muted`, `text.base`, `text.action.primary.base`, `hue.accent[400]`,
 * `border.base`), while the internal `Theme` type in the V2 source is FLAT. Both
 * shapes are present in the 2.0.26 binary, so this adapter resolves the NESTED
 * keys first and FALLS BACK to the flat keys, then to `undefined` — never
 * assuming a single host version (not 2.0.19).
 *
 * It returns a plain flat object safe to hand to `buildViewNodes(view, theme)`.
 */

function readPath(root, path) {
  let current = root
  for (const key of path.split(".")) {
    if (current === null || current === undefined) return undefined
    current = current[key]
  }
  return current
}

export function adaptTheme(theme) {
  const source = theme && typeof theme === "object" ? theme : {}
  const pick = (...paths) => {
    for (const path of paths) {
      const value = readPath(source, path)
      if (value !== undefined && value !== null) return value
    }
    return undefined
  }
  return {
    warning: pick("text.feedback.warning.base", "warning"),
    success: pick("text.feedback.success.base", "success"),
    error: pick("text.feedback.error.base", "error"),
    info: pick("text.feedback.info.base", "info"),
    textMuted: pick("text.muted", "textMuted"),
    text: pick("text.base", "text"),
    accent: pick("hue.accent.400", "text.action.primary.base", "accent"),
    borderSubtle: pick("border.base", "borderSubtle"),
  }
}
