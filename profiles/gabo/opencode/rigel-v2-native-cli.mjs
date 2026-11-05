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
 *   - host-native notification          authoritative; never duplicated by this companion.
 *   - `oh-my-rigel.legacy-plugin-notice` legacy plugin-name detection + toast; default-on.
 *   - `oh-my-rigel.native-edition-nudge` one-time native-edition nudge + /native dialog; default-on.
 *   - `oh-my-rigel.task-toast`          task progress/completion toasts; default-on.
 *   - `oh-my-rigel.btw`                 the /btw side-session picker; default-on.
 *   - `oh-my-rigel.panel`               the read-only sidebar panel; headless self-skip.
 *
 * A surface that throws during `setup` is logged and skipped; a surface that
 * returns a disposer has it run on plugin dispose in reverse order. A headless
 * host (no renderer) makes the UI surfaces self-skip, so the aggregate setup is
 * still side-effect-free there.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { buildRoster } from "./rigel-v2-panel-model.mjs"
import { readLiveAgentOverridesSource } from "./rigel-v2-native-config.mjs"
import { createLegacyNoticeCliSurface } from "./rigel-v2-native-cli-legacy-notice.mjs"
import { createNudgeCliSurface } from "./rigel-v2-native-cli-nudge.mjs"
import { createTaskToastCliSurface } from "./rigel-v2-native-cli-task-toast.mjs"
import { createBtwCliSurface } from "./rigel-v2-native-cli-btw.mjs"
import { createPanelSurface } from "./rigel-v2-panel-surface.mjs"

export const CLI_PLUGIN_ID = "oh-my-rigel.cli"

function parseJsonc(text) {
  return JSON.parse(text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""))
}

function readDefaultModel() {
  for (const path of [join(homedir(), ".config", "opencode", "opencode.json"), join(homedir(), ".config", "opencode", "opencode.jsonc")]) {
    try {
      const value = parseJsonc(readFileSync(path, "utf8"))
      if (typeof value?.model === "string" && value.model.length > 0) return value.model
    } catch {
      // The next canonical V2 config filename is the only fallback.
    }
  }
  return undefined
}

function readPrincipalColors(context) {
  try {
    const location = context?.location ?? context?.data?.location?.default?.()
    const raw = context?.data?.location?.agent?.list?.(location)
    const entries = Array.isArray(raw) ? raw : raw?.data
    if (!Array.isArray(entries)) return undefined
    return Object.fromEntries(
      entries
        .filter((entry) => typeof entry?.color === "string")
        .map((entry) => [entry.name ?? entry.id, entry.color]),
    )
  } catch {
    return undefined
  }
}

/**
 * Decision 12: read the live user roster once during setup, not during render.
 * Decision 13: Judge is filled from OpenCode's default model because it is not
 * an `omo.jsonc` agent entry. The install manifest is intentionally not read.
 */
function readPanelRoster(context, override) {
  if (override) return override
  try {
    const source = readLiveAgentOverridesSource({ home: homedir() })
    return buildRoster({
      agents: source.state === "loaded" ? source.overrides : undefined,
      categories: source.state === "loaded" ? source.categories : undefined,
      judgeModel: readDefaultModel(),
      principalColors: readPrincipalColors(context),
    })
  } catch {
    return buildRoster({ judgeModel: readDefaultModel() })
  }
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Build the composed CLI plugin. `overrides` carries the per-surface test seams
 * (`legacyPluginNotice`, `nativeEditionNudge`, `taskToast`, `btw`, `panel`); the
 * live configuration is read by each surface from `context.options`.
 */
export function createCompanionCliPlugin(overrides = {}) {
  return {
    id: CLI_PLUGIN_ID,
    setup(context) {
      const roster = readPanelRoster(context, overrides.panel?.roster)
      const surfaces = [
        createLegacyNoticeCliSurface(overrides.legacyPluginNotice ?? {}),
        createNudgeCliSurface(overrides.nativeEditionNudge ?? {}),
        createTaskToastCliSurface(overrides.taskToast ?? {}),
        createBtwCliSurface(overrides.btw ?? {}),
        createPanelSurface({ ...overrides.panel, roster }),
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
