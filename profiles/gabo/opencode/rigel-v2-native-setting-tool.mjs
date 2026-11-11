/**
 * The deterministic half of the native V2 `/rigel_setting` surface: one tool
 * definition that lists, inspects, validates and commits a catalogued setting.
 *
 * This module owns only the shape a host and a model see: the name, the input
 * schema and the JSON result contract. The decisions live in the action layer,
 * which refuses an inert or engine key and delegates every mutation to the
 * settings writer, so this surface has exactly one write authority.
 *
 * The catalog key and the command name are the same string (`rigel_setting`).
 * That is deliberate and legal: commands and tools are separate host registries,
 * and the guided command calls this tool by name.
 *
 * A disabled tool name is refused at the registration seam, exactly like every
 * other native tool, so `disabled_tools` still wins over this surface.
 */
import fs from "node:fs"
import { SETTING_KINDS, SETTING_TIERS, normalizeSettingKey } from "./rigel-v2-native-setting-catalog.mjs"
import { SETTING_TOOL_ACTIONS, runSettingAction } from "./rigel-v2-native-setting-actions.mjs"

export const SETTING_TOOL_NAME = "rigel_setting"

export { SETTING_TOOL_ACTIONS }

const SETTING_TOOL_DESCRIPTION = [
  "Inspect and change a catalogued Rigel V2 setting in the layered omo config.",
  "`list` and `get` are read-only and report the current effective value.",
  "`validate` checks a value against the catalog metadata without touching disk.",
  "`set`, `add` and `remove` preview the exact change unless `confirm` is true, and refuse an inert or engine-owned key.",
  "A list setting accepts `add` / `remove` for one item; `remove` on a scalar deletes the key so the default applies again.",
].join(" ")

const SETTING_TOOL_INPUT = Object.freeze({
  type: "object",
  properties: {
    action: { type: "string", enum: [...SETTING_TOOL_ACTIONS], description: "What to do." },
    key: { type: "string", description: "Canonical catalog key, for example `[opencode].monitor.enabled`." },
    value: { description: "The value for `set`/`validate`, or the list item for `add`/`remove`." },
    confirm: { type: "boolean", description: "Set true to commit a mutation after the user confirmed the preview." },
    tier: { type: "string", enum: [...SETTING_TIERS], description: "`list` filter: only this tier." },
    kind: { type: "string", enum: [...SETTING_KINDS], description: "`list` filter: only this kind." },
    writable: { type: "boolean", description: "`list` filter: only writable (or non-writable) entries." },
    query: { type: "string", description: "`list` filter: substring match on the key or the note." },
    limit: { type: "integer", minimum: 1, maximum: 500, description: "`list` result cap." },
  },
  required: ["action"],
  additionalProperties: false,
})

/**
 * Build the `rigel_setting` tool definition. Everything that touches the machine
 * is injected (`env`, `home`, `directory`, `fileSystem`), so a test can drive the
 * real decision path inside a disposable sandbox.
 */
export function createSettingTool({ env, home, directory, accountHome, manifest, fileSystem, now } = {}) {
  const options = { env, home, directory, accountHome, manifest, fileSystem: fileSystem ?? fs, now }
  return {
    name: SETTING_TOOL_NAME,
    options: { codemode: false },
    description: SETTING_TOOL_DESCRIPTION,
    input: { ...SETTING_TOOL_INPUT, properties: { ...SETTING_TOOL_INPUT.properties } },
    execute: async (input) => {
      const request = input !== null && typeof input === "object" ? input : {}
      const payload = runSettingAction(request, options)
      return {
        content: JSON.stringify(payload, null, 2),
        metadata: { ok: payload.ok === true, action: request.action, key: payload.key ?? normalizeSettingKey(request.key) },
      }
    },
  }
}

/**
 * Register the tool on the host editor unless `disabled_tools` names it. The
 * returned value is whatever the editor returned, so the caller owns disposal of
 * the containing transform rather than a second lifecycle.
 */
export function registerSettingTool(editor, options = {}) {
  if (typeof editor?.add !== "function") return undefined
  const disabled = new Set(Array.isArray(options.disabledTools) ? options.disabledTools : [])
  if (disabled.has(SETTING_TOOL_NAME)) return undefined
  const definition = options.definition ?? createSettingTool(options)
  return editor.add(definition)
}
