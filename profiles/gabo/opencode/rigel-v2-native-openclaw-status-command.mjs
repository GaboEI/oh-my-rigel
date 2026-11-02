/**
 * Native V2 `/openclaw-status`: the on-demand report surface for the OpenClaw
 * composition (`Contrato_Transportes_OpenClaw.md` §9.1, §9.2; U4 of
 * `Unidades_Atomicas_OpenClaw.md`).
 *
 * The server plugin has no `ctx.ui` and no `ctx.log`, so this is the only place a
 * user can ask for the state document. The command is strictly a READER:
 *
 *   - it renders the report the composition derives from `rigel-v2/openclaw/status`;
 *   - it delivers that text through `context.session.prompt`, the same command
 *     contract `/goal` uses;
 *   - it never switches a model, never creates a session, never writes storage.
 *
 * The rendering is identity-only by construction: the report shape never carries a
 * token, a URL or an instruction, so no redaction step can be forgotten here.
 *
 * Only sibling native modules are imported so the flat laboratory runtime can
 * load this module.
 */

/** Command name, registered by `context.command.transform`. */
export const OPENCLAW_STATUS_COMMAND_NAME = "openclaw-status"

/** Rendered when no surface has been recorded yet. */
const EMPTY_LINE = "surfaces: none recorded"

function formatSurfaceLine(id, surface) {
  const parts = [`- ${id}: ${surface.state}`]
  if (typeof surface.errorClass === "string" && surface.errorClass.length > 0) parts.push(`(${surface.errorClass})`)
  parts.push(`failures=${surface.consecutiveFailures}`)
  if (surface.rateLimited > 0) parts.push(`rateLimited=${surface.rateLimited}`)
  if (surface.truncations > 0) parts.push(`truncations=${surface.truncations}`)
  if (typeof surface.lastErrorAt === "string") parts.push(`last=${surface.lastErrorAt}`)
  return parts.join(" ")
}

/**
 * Render the derived report as the text the command delivers.
 *
 * Deterministic: surfaces are sorted by id, so the same document always renders
 * the same text and an evidence capture can be compared byte for byte.
 *
 * @param {object} report the composition's `report()`
 * @returns {string}
 */
export function formatOpenclawStatusReport(report) {
  const source = report !== null && typeof report === "object" ? report : {}
  const surfaces = source.surfaces !== null && typeof source.surfaces === "object" ? source.surfaces : {}
  const ids = Object.keys(surfaces).sort()
  const configState = typeof source.configState === "string" && source.configState.length > 0 ? ` (config: ${source.configState})` : ""
  const lines = [
    `openclaw: ${source.enabled === true ? "enabled" : "disabled"}${configState}`,
    `listener: ${source.started === true ? "started" : "stopped"}`,
    ids.length === 0 ? EMPTY_LINE : "surfaces:",
  ]
  for (const id of ids) lines.push(formatSurfaceLine(id, surfaces[id]))
  if (typeof source.updatedAt === "string" && source.updatedAt.length > 0) lines.push(`updated: ${source.updatedAt}`)
  return lines.join("\n")
}

/**
 * Build the command definition.
 *
 * `getReport` is a reader supplied by the composition. An absent reader renders
 * the empty report instead of throwing, so the command can never break the
 * command channel.
 *
 * @param {{ getReport?: () => object, context?: object }} [options]
 */
export function createOpenclawStatusCommand({ getReport, context } = {}) {
  return {
    name: OPENCLAW_STATUS_COMMAND_NAME,
    description: "Show the OpenClaw surface state document: per-surface state, error class and aggregates.",
    execute: async ({ sessionID, prompt, delivery } = {}) => {
      if (typeof sessionID !== "string" || sessionID.length === 0) return
      if (typeof context?.session?.prompt !== "function") return
      // The V2 command executor receives a PromptInput object, not a raw string.
      // Reuse it so the delivery keeps whatever the host already attached, exactly
      // like the `/goal` command. The host discards the executor's return value,
      // so the report travels through `ctx.session.prompt`.
      const base = prompt !== null && typeof prompt === "object" ? prompt : {}
      let rendered
      try {
        const report = typeof getReport === "function" ? await getReport() : undefined
        rendered = formatOpenclawStatusReport(report)
      } catch (error) {
        rendered = `openclaw: report unavailable (${error instanceof Error ? error.message : String(error)})`
      }
      await context.session.prompt({ ...base, sessionID, text: rendered, delivery })
    },
  }
}

/**
 * Register the command, honoring the materialized `disabled_commands` denylist
 * exactly like the other native commands.
 *
 * @param {{ context?: object, getReport?: () => object, disabledCommands?: string[] }} [options]
 * @returns {Promise<{ dispose?: () => Promise<void> } | undefined>}
 */
export async function registerOpenclawStatusCommand({ context, getReport, disabledCommands } = {}) {
  if (typeof context?.command?.transform !== "function") return undefined
  const disabled = new Set(Array.isArray(disabledCommands) ? disabledCommands : [])
  if (disabled.has(OPENCLAW_STATUS_COMMAND_NAME)) return undefined
  const definition = createOpenclawStatusCommand({ getReport, context })
  return context.command.transform((editor) => editor.add(definition))
}
