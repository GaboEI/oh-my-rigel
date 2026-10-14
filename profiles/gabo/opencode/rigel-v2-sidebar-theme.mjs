/**
 * Defensive theming adapter for the Oh My Rigel sidebar.
 *
 * `buildViewNodes` (the ported V1 IR) expects FLAT theme keys:
 *   error, warning, success, info, text, textMuted, accent, borderSubtle.
 * The V2 host theme is NESTED (`text.base`, `text.muted`, `text.feedback.*`,
 * `text.action.primary.base`, `hue.accent[400]`, `border.base`), while the
 * internal V2 `Theme` type is FLAT. Both shapes occur across host versions, so
 * this adapter resolves the NESTED keys first and FALLS BACK to the flat keys,
 * then to `undefined` (a missing colour must never throw).
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
