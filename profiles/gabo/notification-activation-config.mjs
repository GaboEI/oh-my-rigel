/**
 * Activation-time resolution for Oh My Rigel session notifications.
 *
 * The V2 companion CLI plugin is inert unless its config is present and
 * `enabled` is true. This module owns that resolution so the activation script
 * stays a thin file copier and the decision is unit-testable without touching
 * the laboratory.
 *
 * V1 gate, ported: the hook is created only when `session-notification` is not
 * in `disabled_hooks`, and an external notifier conflict suppresses it unless
 * `notification.force_enable` is true.
 */

export const NOTIFICATION_PLUGIN_ID = "oh-my-rigel.notification"

/** `cli.json` plugin entry that disables the always-on host notifier. */
export const DISABLED_BUILTIN_NOTIFICATION = "-opencode.notifications"

/** V1 default, from `createSessionNotification`'s merged config. */
export const DEFAULT_IDLE_CONFIRMATION_DELAY = 1500

/** Strip `//` and block comments plus trailing commas from a JSONC document. */
export function stripJsonComments(text) {
  if (typeof text !== "string") return ""
  let output = ""
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    const next = text[index + 1]
    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false
        output += char
      }
      continue
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false
        index++
      }
      continue
    }
    if (inString) {
      output += char
      if (char === "\\") {
        index++
        output += text[index] ?? ""
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === "/" && next === "/") {
      inLineComment = true
      index++
      continue
    }
    if (char === "/" && next === "*") {
      inBlockComment = true
      index++
      continue
    }
    output += char
  }
  return output.replace(/,(\s*[}\]])/g, "$1")
}

export function parseJsonc(text) {
  const stripped = stripJsonComments(text).trim()
  if (stripped.length === 0) return {}
  return JSON.parse(stripped)
}

function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * Resolve the effective `[opencode]` config block from an OmO profile
 * document. Accepts an already-merged block (an object carrying `disabled_hooks`
 * or `notification`) unchanged, or the multi-profile document written in
 * `omo.jsonc`.
 */
export function resolveProfileOpenCodeBlock(document, profileName) {
  const root = document && typeof document === "object" ? document : {}
  if (Array.isArray(root.disabled_hooks) || (root.notification && typeof root.notification === "object")) return root
  const profiles = root.profiles && typeof root.profiles === "object" ? root.profiles : undefined
  if (!profiles) return root
  const name = typeof profileName === "string" && profileName.length > 0 ? profileName : "gabo"
  const selected = profiles[name] ?? profiles.gabo ?? Object.values(profiles).find((entry) => entry && typeof entry === "object")
  if (!selected || typeof selected !== "object") return {}
  const opencode = selected["[opencode]"]
  if (opencode && typeof opencode === "object") return opencode
  return selected
}

/**
 * Resolve the plugin options from the effective OmO profile.
 *
 * The binding contract: an absent `notification` block means the companion is
 * never registered and the host builtin is left alone. Only an explicit
 * `notification` block with `enabled: true` (and no blocker) lets the plugin take
 * ownership. `enabledOverride` is the QA seam that forces the gate, but it still
 * requires the block to be present, so an unconfigured profile stays inert.
 */
export function resolveNotificationOptions({ profile, externalNotifierDetected = false, enabledOverride } = {}) {
  const record = profile && typeof profile === "object" ? profile : {}
  const notification = record.notification && typeof record.notification === "object" && !Array.isArray(record.notification)
    ? record.notification
    : undefined
  const configured = notification !== undefined
  const disabledHooks = Array.isArray(record.disabled_hooks) ? record.disabled_hooks : []
  const forceEnable = notification?.force_enable === true
  const hookDisabled = disabledHooks.includes("session-notification")

  let enabled = configured && notification.enabled === true && !hookDisabled && (!externalNotifierDetected || forceEnable)
  if (typeof enabledOverride === "boolean") enabled = configured && enabledOverride

  return {
    configured,
    enabled,
    forceEnable,
    playSound: notification?.play_sound === true,
    soundName: typeof notification?.sound_name === "string" && notification.sound_name.length > 0 ? notification.sound_name : "done",
    idleConfirmationDelay: numberOr(notification?.idle_confirmation_delay, DEFAULT_IDLE_CONFIRMATION_DELAY),
    skipIfIncompleteTodos: notification?.skip_if_incomplete_todos !== false,
    enforceMainSessionFilter: notification?.enforce_main_session_filter !== false,
  }
}

/**
 * A path is owned by the Rigel CLI-plugin family when it equals the stable
 * family root or sits underneath it. The family root is the version-independent
 * Rigel state directory, so a version transition (which moves the runtime from
 * `versions/<a>/runtime` to `versions/<b>/runtime`) is still recognised as the
 * same family entry and can be replaced in place instead of duplicated.
 */
function underFamily(candidate, familyRoot) {
  if (typeof candidate !== "string" || typeof familyRoot !== "string" || familyRoot.length === 0) return false
  if (candidate === familyRoot) return true
  return candidate.startsWith(`${familyRoot}/`) || candidate.startsWith(`${familyRoot}\\`)
}

function isOurRuntimeEntry(entry, { runtimeDir, familyRoot }) {
  const pkg = typeof entry === "string" ? entry : entry && typeof entry === "object" ? entry.package : undefined
  if (typeof pkg !== "string") return false
  return pkg === runtimeDir || underFamily(pkg, familyRoot)
}

/**
 * Return a new `cli.json` with our companion plugin registered exactly once
 * (object form carrying the resolved options) and the host's built-in notifier
 * disabled so the two never double-announce - ONLY when the notification config
 * is explicitly present and enabled.
 *
 * When it is absent or disabled, any previous registration and the builtin
 * disable marker are removed, so an unconfigured profile leaves `cli.json`
 * without our entry and with `opencode.notifications` untouched. Idempotent:
 * re-running yields the same array, and unrelated plugins keep their position.
 */
export function registerNotificationCliPlugin(cliConfig, { runtimeDir, familyRoot = runtimeDir, options, disableBuiltin = true } = {}) {
  const next = { ...(cliConfig && typeof cliConfig === "object" ? cliConfig : {}) }
  const current = Array.isArray(next.plugins) ? next.plugins : []
  const plugins = current.filter((entry) => {
    if (isOurRuntimeEntry(entry, { runtimeDir, familyRoot })) return false
    if (entry === DISABLED_BUILTIN_NOTIFICATION) return false
    return true
  })
  if (options?.enabled === true) {
    plugins.push({ package: runtimeDir, options: { notification: options } })
    if (disableBuiltin) plugins.push(DISABLED_BUILTIN_NOTIFICATION)
  }
  next.plugins = plugins
  return next
}

/**
 * Register the composed companion CLI plugin (`./tui`) exactly once and, when
 * the notification config is enabled, disable the host's always-on builtin
 * notifier so the two never double-announce.
 *
 * Unlike {@link registerNotificationCliPlugin}, this always registers the
 * package: the companion now composes several independent surfaces (notification,
 * legacy-name notice, native-edition nudge, task toasts), and the
 * non-notification surfaces are default-on. Each surface applies its own gate, so
 * registering the package while the notification block is disabled is not a
 * double-announce risk.
 *
 * Family identity: `familyRoot` is the stable, version-independent Rigel state
 * root. Every entry whose package sits under it belongs to the same family, so a
 * version transition replaces the existing family entry IN PLACE with the active
 * `runtimeDir` instead of appending a second one. Exactly one family entry
 * survives; foreign plugins keep their position; the host builtin disable marker
 * is present if and only if the notification surface is enabled. Idempotent.
 */
export function registerCompanionCliPlugin(cliConfig, { runtimeDir, familyRoot = runtimeDir, options, notificationEnabled = false, disableBuiltin = true } = {}) {
  const next = { ...(cliConfig && typeof cliConfig === "object" ? cliConfig : {}) }
  const current = Array.isArray(next.plugins) ? next.plugins : []
  const entry = { package: runtimeDir, options: { notification: options } }
  const plugins = []
  let placed = false
  for (const candidate of current) {
    if (candidate === DISABLED_BUILTIN_NOTIFICATION) continue
    if (isOurRuntimeEntry(candidate, { runtimeDir, familyRoot })) {
      if (!placed) {
        plugins.push(entry)
        placed = true
      }
      continue
    }
    plugins.push(candidate)
  }
  if (!placed) plugins.push(entry)
  if (notificationEnabled && disableBuiltin) plugins.push(DISABLED_BUILTIN_NOTIFICATION)
  next.plugins = plugins
  return next
}

/**
 * Remove every Rigel-family companion entry and the host builtin disable marker,
 * leaving foreign plugins untouched and in order. The mirror of
 * {@link registerCompanionCliPlugin}: after it runs, `cli.json` carries no
 * Rigel-owned surface, which is the correct end state for uninstall.
 */
export function removeRigelCliEntries(cliConfig, { familyRoot } = {}) {
  const next = { ...(cliConfig && typeof cliConfig === "object" ? cliConfig : {}) }
  const current = Array.isArray(next.plugins) ? next.plugins : []
  next.plugins = current.filter((entry) => {
    if (entry === DISABLED_BUILTIN_NOTIFICATION) return false
    return !isOurRuntimeEntry(entry, { runtimeDir: familyRoot, familyRoot })
  })
  return next
}
