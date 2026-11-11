/**
 * The native OpenCode V2 `/rigel_setting` command: a guided turn over the
 * catalogued settings of the layered omo config.
 *
 * The command itself decides nothing about a setting. It renders ground truth
 * (the active profile, the reader's layer order, the catalog split by tier) and
 * injects a working instruction, then hands the conversation to the active
 * agent, which uses the `rigel_setting` tool for a read and the host `question`
 * tool for the choices. That split keeps one write authority (the writer behind
 * the tool) instead of letting a command prompt edit files on its own.
 *
 * The injected text starts with `OMO_INTERNAL_INITIATOR_MARKER` so the keyword
 * seam treats it as an internal initiator instead of a fresh user request, and
 * every technical term (key, command, tier) is wrapped in a code span, so a
 * catalogued name can never arm a mode.
 *
 * The command is ADDITIVE: it never restarts, stops, kills or reloads anything.
 * A settings read happens at plugin-init, so the turn ends by naming
 * `opencode reload` and the guaranteed `opencode service restart` and leaves
 * running them to the user.
 *
 * The writer module is imported statically on purpose: the isolated V2 staging
 * copies only what the import graph reaches, and the refusal codes this prompt
 * explains come from the writer's own contract.
 */
import fs from "node:fs"
import { OMO_INTERNAL_INITIATOR_MARKER } from "./rigel-v2-keyword-core.mjs"
import { SETTING_CATALOG, SETTING_TIERS } from "./rigel-v2-native-setting-catalog.mjs"
import { SETTING_SURFACE_ERRORS, mutableRefusal } from "./rigel-v2-native-setting-descriptor.mjs"
import { resolveSettingPaths } from "./rigel-v2-native-setting-targets.mjs"
import { readJsoncFile } from "./rigel-v2-native-jsonc-write.mjs"
import { SETTING_WRITE_ERRORS } from "./rigel-v2-native-setting-write.mjs"

export const SETTING_COMMAND_NAME = "rigel_setting"

/** The two verified reload commands (OpenCode v2.0.26). No `server reset`. */
export const SETTING_RELOAD_COMMANDS = Object.freeze({
  reload: "opencode reload",
  serviceRestart: "opencode service restart",
  reloadDescription: "Reloads configuration without restarting the server.",
  serviceRestartDescription: "Restarts the background server.",
  guaranteed: "Because the plugin reads the omo config at plugin-init, `opencode service restart` is the guaranteed mechanism.",
})

const TIER_ACTIVATION_NOTE = Object.freeze({
  live: "takes effect on the next session after the reload",
  baked: "lands on the next reinstall",
  inert: "explanation only: no reader in this runtime",
  engine: "explanation only: another layer owns it",
})

const REFUSAL_CODES = Object.freeze([...new Set([...Object.values(SETTING_WRITE_ERRORS), ...Object.values(SETTING_SURFACE_ERRORS)])])

function catalogCounts(catalog) {
  const counts = { total: catalog.length, editable: 0, byTier: {} }
  for (const tier of SETTING_TIERS) counts.byTier[tier] = 0
  for (const entry of catalog) {
    counts.byTier[entry.tier] += 1
    if (mutableRefusal(entry) === null) counts.editable += 1
  }
  return counts
}

function renderEditableLines(catalog) {
  const lines = catalog
    .filter((entry) => mutableRefusal(entry) === null)
    .map((entry) => `- \`${entry.key}\` (${entry.kind}, ${entry.tier} -> ${entry.activation})`)
  return lines.length === 0 ? ["- none"] : lines
}

function renderLayerLines(layers) {
  if (layers.length === 0) return ["- none resolved"]
  return layers.map((layer) => `- ${layer.scope} \`${layer.path}\` ${layer.exists ? "present" : "absent"}${layer.ok === false ? " unparseable" : ""}`)
}

/**
 * The instruction the command injects. It embeds the current profile, the layer
 * order the reader folds and the catalog split, so the active agent guides from
 * ground truth rather than from memory.
 */
export function renderSettingCommandPrompt({ userText = "", profileName, layers = [], catalog = SETTING_CATALOG, reload = SETTING_RELOAD_COMMANDS, resolved = true } = {}) {
  const counts = catalogCounts(catalog)
  const tiers = SETTING_TIERS.map((tier) => `\`${tier}\`=${counts.byTier[tier]}`).join(", ")
  const tierNotes = SETTING_TIERS.map((tier) => `- \`${tier}\`: ${TIER_ACTIVATION_NOTE[tier]}`).join("\n")
  const request = typeof userText === "string" && userText.trim() !== "" ? `\nThe user's request: ${userText.trim()}\n` : ""
  return [
    OMO_INTERNAL_INITIATOR_MARKER,
    "You are handling the `/rigel_setting` command. Guide the user through explaining or changing one Rigel V2 setting.",
    "",
    resolved
      ? "The user config layer below is the file the native reader folds highest for a catalogued key."
      : "The layer chain could not be resolved, so do not offer a write until that is fixed; explain the failure to the user.",
    `Active profile: ${profileName === undefined ? "`none`" : `\`${profileName}\``}`,
    "Layers, in the reader's fold order (user first, then project layers farthest to nearest):",
    ...renderLayerLines(layers),
    request,
    `Catalog: \`${counts.total}\` settings, \`${counts.editable}\` editable through this surface. Tiers: ${tiers}.`,
    "What an edit costs by tier:",
    tierNotes,
    "",
    "Editable settings (`tier -> activation`, key, kind):",
    ...renderEditableLines(catalog),
    "",
    "How to read this catalog: `inert` and `engine` keys are explanation only, and a `section` / `block` / `metadata` key is a container you explain but never replace. Edit a container's leaves instead.",
    "",
    "Call the `rigel_setting` tool for ground truth before you answer. It answers with JSON:",
    "- `list` filters by `tier`, `kind`, `writable` and `query`.",
    "- `get` returns the catalog entry, the folded layers and the current effective value with its source layer.",
    "- `validate` checks a value against the catalog metadata and writes nothing.",
    "- `set`, `add` and `remove` return a preview unless called with `confirm: true`; `add` and `remove` take one list item.",
    "",
    "Follow this workflow exactly:",
    "1. Ask with the host `question` tool whether the user wants an explanation or a change, and which setting. Keep the options short.",
    "2. For an explanation, report the tier, the activation, the current effective value, the source layer and the catalog note.",
    "3. For a change, call `get` first, then state the exact before and after and ask the user to confirm with the `question` tool.",
    "4. Only after that explicit confirmation call the tool again with `confirm: true`. Never edit the config file directly and never write without the confirmation.",
    "5. For a `list` setting, show the resulting list before confirming an `add` or a `remove`.",
    "6. A refusal is a person-readable outcome, not a retry signal: explain the code instead of repeating the same call. Refusals use one of `" + REFUSAL_CODES.join("`, `") + "`.",
    "7. Reply in the language of the user's most recent message, and switch whenever their latest message uses a different language.",
    "",
    "Close with a summary that states:",
    "- what changed, or that nothing changed, plus the backup path when a write happened;",
    `- \`${reload.reload}\`: ${reload.reloadDescription}`,
    `- \`${reload.serviceRestart}\`: ${reload.serviceRestartDescription}`,
    reload.guaranteed,
    "The user runs those commands; never run them yourself.",
    "",
    "Never restart, stop, or kill the server or the session, and never perform any other lifecycle action.",
  ].join("\n")
}

/** The profile and layer state the prompt renders. A resolution failure is reported, not thrown. */
export function resolveSettingCommandState({ env, home, directory, accountHome, manifest, fileSystem }) {
  try {
    const paths = resolveSettingPaths({ env, home, directory, accountHome, manifest, fileSystem })
    const layers = paths.layers.map((layer) => {
      const read = readJsoncFile({ fileSystem, filePath: layer.path })
      return { path: layer.path, scope: layer.scope, exists: read.exists === true, ok: read.ok !== false }
    })
    return { resolved: true, profileName: paths.profileName, layers }
  } catch (error) {
    return { resolved: false, profileName: undefined, layers: [], reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Build the `/rigel_setting` command definition. `execute` only reads state and
 * injects the instruction: it performs no write and no lifecycle action.
 */
export function createSettingCommand({ context, env, home, directory, accountHome, manifest, fileSystem, catalog } = {}) {
  const fsm = fileSystem ?? fs
  return {
    name: SETTING_COMMAND_NAME,
    description: "Explain or change a catalogued Rigel V2 setting in the layered omo config.",
    execute: async ({ sessionID, prompt, delivery } = {}) => {
      if (typeof sessionID !== "string" || sessionID.length === 0) return
      if (typeof context?.session?.prompt !== "function") return
      const base = prompt !== null && typeof prompt === "object" ? prompt : {}
      const userText = typeof prompt === "string" ? prompt : typeof prompt?.text === "string" ? prompt.text : ""
      const state = resolveSettingCommandState({ env, home, directory, accountHome, manifest, fileSystem: fsm })
      const text = renderSettingCommandPrompt({ userText, catalog, ...state })
      await context.session.prompt({ ...base, sessionID, text, delivery })
    },
  }
}

/**
 * Register the command when the host exposes a command domain and the name is
 * not denied by the materialized `disabled_commands` gate. Returns the host
 * registration (with `dispose`) or `undefined`, so the caller disposes uniformly.
 */
export async function registerSettingCommand(options = {}) {
  const { context } = options
  if (typeof context?.command?.transform !== "function") return undefined
  const disabled = new Set(Array.isArray(options.disabledCommands) ? options.disabledCommands : [])
  if (disabled.has(SETTING_COMMAND_NAME)) return undefined
  const definition = createSettingCommand(options)
  return context.command.transform((editor) => editor.add(definition))
}
