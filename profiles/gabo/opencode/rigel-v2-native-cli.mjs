/**
 * Oh My Rigel companion CLI plugin: the single `./tui` entrypoint.
 *
 * OpenCode V2 loads CLI plugins from `cli.json` by resolving the configured
 * package's `./tui` export. The fork has several independent CLI surfaces, so
 * this module composes them behind one `{ id, setup(context) }` definition
 * instead of asking the host to load several entries (the current deployment
 * resolves exactly one `tui.js`).
 *
 * Composition order and each surface's own gate:
 *   - `oh-my-rigel.notification`        session/attention/toast notices; config-gated.
 *   - `oh-my-rigel.legacy-plugin-notice` legacy plugin-name detection + toast; default-on.
 *   - `oh-my-rigel.native-edition-nudge` one-time native-edition nudge + /native dialog; default-on.
 *   - `oh-my-rigel.task-toast`          task progress/completion toasts; default-on.
 *
 * A surface that throws during `setup` is logged and skipped; a surface that
 * returns a disposer has it run on plugin dispose in reverse order. A headless
 * host (no renderer) makes the UI surfaces self-skip, so the aggregate setup is
 * still side-effect-free there.
 */

import { createNotificationPlugin } from "./rigel-v2-native-cli-notification.mjs"
import { createLegacyNoticeCliSurface } from "./rigel-v2-native-cli-legacy-notice.mjs"
import { createNudgeCliSurface } from "./rigel-v2-native-cli-nudge.mjs"
import { createTaskToastCliSurface } from "./rigel-v2-native-cli-task-toast.mjs"
import { createBtwCliSurface } from "./rigel-v2-native-cli-btw.mjs"

export const CLI_PLUGIN_ID = "oh-my-rigel.cli"

function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Build the composed CLI plugin. `overrides` carries the per-surface test seams
 * (`notification`, `legacyPluginNotice`, `nativeEditionNudge`, `taskToast`); the
 * live configuration is read by each surface from `context.options`.
 */
export function createCompanionCliPlugin(overrides = {}) {
  return {
    id: CLI_PLUGIN_ID,
    setup(context) {
      const surfaces = [
        createNotificationPlugin(overrides.notification ?? {}),
        createLegacyNoticeCliSurface(overrides.legacyPluginNotice ?? {}),
        createNudgeCliSurface(overrides.nativeEditionNudge ?? {}),
        createTaskToastCliSurface(overrides.taskToast ?? {}),
        createBtwCliSurface(overrides.btw ?? {}),
      ]
      const disposers = []
      for (const surface of surfaces) {
        if (!surface || typeof surface.setup !== "function") continue
        try {
          const dispose = surface.setup(context)
          if (typeof dispose === "function") disposers.push(dispose)
        } catch (error) {
          console.error(`[oh-my-rigel] CLI surface ${surface.id ?? "unknown"} setup failed: ${describeError(error)}`)
        }
      }
      return () => {
        for (const dispose of disposers.reverse()) {
          try {
            dispose()
          } catch (error) {
            console.error(`[oh-my-rigel] CLI surface dispose failed: ${describeError(error)}`)
          }
        }
      }
    },
  }
}

export default createCompanionCliPlugin()
