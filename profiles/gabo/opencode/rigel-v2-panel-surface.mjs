/**
 * Oh My Rigel read-only panel, V2 companion CLI surface.
 *
 * The panel is a strictly visual, read-only consumer: it reads an authorized,
 * demonstrated subset of the host's public read selectors, formats them with the
 * pure core (`rigel-v2-panel-model.mjs`), and renders ONE OpenTUI <text> node
 * into the host sidebar through the single documented slot API:
 *
 *     context.ui.slot({ append: "sidebar.content", render })
 *
 * It never writes, never subscribes, never starts a timer, never emits events or
 * commands, and never touches functional logic. The host owns the render cycle;
 * the slot registration returns the disposer. `render` never throws and never
 * returns a bare string: it returns a valid <text> node, or `null` as the only
 * safe degradation (the host rejects a bare string and aborts the TUI).
 *
 * The OpenTUI Solid peer is resolved by a STATIC bare import; the V2 host injects
 * it at load time (demonstrated on NLS1 by the S1 probe), so the module stays
 * buildless with no node_modules. `overrides.solid` is a unit-test seam only.
 */

import { createElement, insert } from "@opentui/solid"
import { PANEL_ID, buildPanelModel, formatPanel } from "./rigel-v2-panel-model.mjs"

/** The V2 sidebar content slot this surface appends to. */
export const PANEL_SLOT_APPEND = "sidebar.content"

/** Run one read in isolation so a single failure degrades one section only. */
function readResult(read) {
  try {
    return { ok: true, value: read() }
  } catch {
    return { ok: false, value: undefined }
  }
}

/** Read only the authorized, demonstrated selectors; never await, never cache. */
function readPanelInputs(context) {
  const data = context?.data
  const location = readResult(() => context?.location ?? data?.location?.default?.())
  const sessions = readResult(() => data?.session?.list?.())
  const models = readResult(() => data?.location?.model?.list?.(location.value))
  const agents = readResult(() => data?.location?.agent?.list?.(location.value))
  const providers = readResult(() => data?.location?.provider?.list?.(location.value))
  return {
    location: location.value,
    locationError: !location.ok,
    sessions: sessions.value,
    sessionsError: !sessions.ok,
    titleOf: (id) => readResult(() => data?.session?.get?.(id)?.title).value,
    statusOf: (id) => readResult(() => data?.session?.status?.(id)).value,
    models: models.value,
    modelsError: !models.ok,
    agents: agents.value,
    agentsError: !agents.ok,
    providers: providers.value,
    providersError: !providers.ok,
  }
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

      const render = () => {
        try {
          const text = formatPanel(buildPanelModel(readPanelInputs(context)))
          return buildTextNode(solid, text)
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
