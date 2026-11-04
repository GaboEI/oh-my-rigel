/**
 * Oh My Rigel read-only panel, V2 companion CLI surface.
 *
 * The panel is a strictly visual, read-only consumer: it takes the selected
 * session from the host slot input, reads an authorized, demonstrated subset of
 * the host's public read selectors, formats them with the pure core
 * (`rigel-v2-panel-model.mjs`), and renders ONE OpenTUI <text> node into the host
 * sidebar through the single documented slot API:
 *
 *     context.ui.slot({ append: "sidebar.content", render })
 *
 * The slot callback receives the selected session, exactly as the two host-native
 * consumers of this slot do (`render: (input) => ... input.sessionID`). This
 * surface consumes that input instead of assuming an identity, and I-3's single
 * admissible read is taken literally: `session.status(sessionID)` for the
 * slot-provided session, read once inside `render` (the reactive owner seam).
 * Every other listed session keeps an UNREAD status, so the block omits its state
 * instead of reading a wider roster or inventing an activity value.
 *
 * Header contract (G2): exactly two visible headers, `oh-my-rigel · models` at
 * rest and `oh-my-rigel · working` while the selected session is active. G1's
 * optional `running` -> `busy` label is deliberately NOT applied: it would need a
 * visual translation the runtime never demonstrated, so G1's own fallback holds
 * and the host literal (`running`) is preserved untouched in the rows. Every
 * other value, including an absent or failed status read, stays at rest.
 *
 * It never writes, never subscribes, never starts a timer, never polls, never
 * persists, never emits events or commands, and never touches functional logic,
 * Goal, Context, MCP or any host-native block. The host owns the render cycle;
 * the slot registration returns the disposer. `render` never throws and never
 * returns a bare string: it returns a valid <text> node, or `null` as the only
 * safe degradation (the host rejects a bare string and aborts the TUI).
 *
 * Whether the host reinvokes this callback on a state change is NOT claimed here:
 * that is the F4 runtime gate. This module only proves the input is consumed and
 * the read is the single authorized accessor.
 *
 * The OpenTUI Solid peer is resolved by a STATIC bare import; the V2 host injects
 * it at load time, so the module stays buildless with no node_modules.
 * `overrides.solid` is a unit-test seam only.
 */

import { createElement, insert } from "@opentui/solid"
import { PANEL_ID, buildPanelModel, formatPanel } from "./rigel-v2-panel-model.mjs"

/** The V2 sidebar content slot this surface appends to. */
export const PANEL_SLOT_APPEND = "sidebar.content"

/** G2: the only two headers this block may render. */
export const PANEL_HEADER_REST = "oh-my-rigel · models"
export const PANEL_HEADER_WORKING = "oh-my-rigel · working"

/** The only accessor value that means "active" (host read vocabulary: running/idle). */
const ACTIVE_STATUS = "running"

/** Run one read in isolation so a single failure degrades one section only. */
function readResult(read) {
  try {
    return { ok: true, value: read() }
  } catch {
    return { ok: false, value: undefined }
  }
}

/** The slot hands the selected session; an absent or blank input is no identity. */
function slotSessionID(input) {
  const id = input?.sessionID
  return typeof id === "string" && id.length > 0 ? id : null
}

/**
 * I-3 at the host boundary: `session.status(sessionID)` is read exactly once, for
 * the identity the slot handed us, inside this render. The model receives an
 * accessor that answers only for that identity, so no other session is ever read
 * from the host and no status is invented for one. Without a slot identity there
 * is no admissible read at all.
 */
function selectedStatusReader(readStatus, sessionID) {
  if (sessionID === null) return () => undefined
  const status = readResult(() => readStatus(sessionID)).value
  return (id) => (id === sessionID ? status : undefined)
}

/** Read only the authorized, demonstrated selectors; never await, never cache. */
function readPanelInputs(context, input) {
  const data = context?.data
  const sessionID = slotSessionID(input)
  const location = readResult(() => context?.location ?? data?.location?.default?.())
  const sessions = readResult(() => data?.session?.list?.())
  const models = readResult(() => data?.location?.model?.list?.(location.value))
  const agents = readResult(() => data?.location?.agent?.list?.(location.value))
  const providers = readResult(() => data?.location?.provider?.list?.(location.value))
  const statusOf = selectedStatusReader((id) => data?.session?.status?.(id), sessionID)
  return {
    sessionID,
    selectedStatus: statusOf(sessionID) ?? null,
    location: location.value,
    locationError: !location.ok,
    sessions: sessions.value,
    sessionsError: !sessions.ok,
    titleOf: (id) => readResult(() => data?.session?.get?.(id)?.title).value,
    statusOf,
    models: models.value,
    modelsError: !models.ok,
    agents: agents.value,
    agentsError: !agents.ok,
    providers: providers.value,
    providersError: !providers.ok,
  }
}

/** G2 header for the demonstrated state; anything unproven stays at rest. */
function headerFor(status) {
  return status === ACTIVE_STATUS ? PANEL_HEADER_WORKING : PANEL_HEADER_REST
}

/**
 * The model's first line is its own standalone title. This surface owns the
 * visible header (G2), so the body starts below that title and the block never
 * renders two competing titles.
 */
function bodyOf(formatted) {
  const index = formatted.indexOf("\n")
  return index === -1 ? "" : formatted.slice(index + 1)
}

/** Compose the single multiline text this block renders: header + model body. */
function panelText(inputs) {
  return `${headerFor(inputs.selectedStatus)}\n${bodyOf(formatPanel(buildPanelModel(inputs)))}`
}

/** Build the single multiline OpenTUI <text> node the host mounts. */
function buildTextNode(solid, text) {
  const node = solid.createElement("text")
  solid.insert(node, text)
  return node
}

/**
 * Build the panel surface. `overrides` carries the test seam (`solid`); the live
 * renderer is taken from the host. A surface without a renderer or a `ui.slot`
 * self-skips and returns undefined, so a headless host is exactly zero effects.
 */
export function createPanelSurface(overrides = {}) {
  const solid = overrides.solid ?? { createElement, insert }
  return {
    id: PANEL_ID,
    setup(context) {
      const renderer = context?.renderer
      if (!renderer || renderer.isDestroyed === true) return undefined
      if (typeof context?.ui?.slot !== "function") return undefined

      const render = (input) => {
        try {
          return buildTextNode(solid, panelText(readPanelInputs(context, input)))
        } catch {
          return null
        }
      }

      let dispose
      try {
        dispose = context.ui.slot({ append: PANEL_SLOT_APPEND, render })
      } catch {
        return undefined
      }
      return typeof dispose === "function" ? dispose : undefined
    },
  }
}

export default createPanelSurface()
