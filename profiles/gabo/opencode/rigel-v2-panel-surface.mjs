/**
 * Passive OpenCode V2 sidebar adapter for the pure Rigel panel model.
 *
 * The compositor injects the roster. This adapter reads only the current
 * session projection and creates OpenTUI nodes; it never reads disk, catalogs,
 * models, providers, storage, or Goal state.
 */

import { createElement, insert, setProp } from "@opentui/solid"
import {
  PANEL_COLORS,
  PANEL_ID,
  buildPanelModel,
  filterPanelColor,
  padNameColumn,
} from "./rigel-v2-panel-model.mjs"

export const PANEL_SLOT_APPEND = "sidebar.content"

function readResult(read) {
  try {
    return { ok: true, value: read() }
  } catch {
    return { ok: false, value: undefined }
  }
}

function slotSessionID(props) {
  const value = props?.sessionID
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function setNodeProp(solid, node, name, value) {
  if (typeof solid.setProp === "function") solid.setProp(node, name, value)
  else node[name] = value
}

function makeNode(solid, tag, props = {}) {
  const node = solid.createElement(tag)
  for (const [name, value] of Object.entries(props)) setNodeProp(solid, node, name, value)
  return node
}

function textNode(solid, text, color, props = {}) {
  const node = makeNode(solid, "text", { ...props, fg: filterPanelColor(color) })
  solid.insert(node, text)
  return node
}

// Every row is a fixed single-line box: no flex growth or shrink, so the
// renderer cannot spread free space into blank lines between siblings.
function rowNode(solid, children) {
  const row = makeNode(solid, "box", {
    flexDirection: "row",
    width: "100%",
    height: 1,
    flexGrow: 0,
    flexShrink: 0,
  })
  for (const child of children) solid.insert(row, child)
  return row
}

function headerNode(solid, model) {
  const suffixColor = model.mode === "working" ? PANEL_COLORS.working : PANEL_COLORS.dim
  const suffix = model.mode === "working" ? "working" : "models"
  return rowNode(solid, [
    textNode(solid, "oh-my-rigel", PANEL_COLORS.brand),
    textNode(solid, " · ", PANEL_COLORS.dim),
    textNode(solid, suffix, suffixColor),
  ])
}

// Row/flex alignment was not proven available in this slot, so the computed roster column is used.
// The column is fixed: `flexShrink: 0` keeps a narrow sidebar from squeezing the
// separator out of the longest label, which was the only row that lost it while
// every shorter label still started its model at the same column.
function modelRowNode(solid, row, nameColumnWidth) {
  const name = textNode(solid, padNameColumn(row.name, nameColumnWidth), row.nameColor ?? PANEL_COLORS.base, { flexShrink: 0 })
  const model = textNode(solid, row.model, row.modelColor ?? PANEL_COLORS.dim)
  return rowNode(solid, [name, model])
}

function workingRowNode(solid, row, nameColumnWidth) {
  const label = `${row.prefix ?? ""}${row.name}`
  const name = textNode(solid, padNameColumn(label, nameColumnWidth), row.nameColor ?? PANEL_COLORS.base, { flexShrink: 0 })
  const status = textNode(solid, row.status ?? "", row.statusColor ?? PANEL_COLORS.working)
  return rowNode(solid, [name, status])
}

// The group separator is the only blank line: a one-line row holding "".
function blankNode(solid) {
  return rowNode(solid, [textNode(solid, "", PANEL_COLORS.base)])
}

function panelNode(solid, model) {
  const root = makeNode(solid, "box", {
    flexDirection: "column",
    borderStyle: "single",
    borderColor: filterPanelColor(PANEL_COLORS.border),
    // The vault box is 37 cells wide: 2 of left padding, a 19-cell name column
    // plus its separator, and a 13-cell model. A right padding would push the
    // model past the border and clip it, so the right edge is the border itself.
    paddingLeft: 2,
    paddingRight: 0,
  })
  solid.insert(root, headerNode(solid, model))
  solid.insert(root, blankNode(solid))

  if (model.mode === "working") {
    for (const row of model.rows) solid.insert(root, workingRowNode(solid, row, model.nameColumnWidth))
    return root
  }

  for (const [index, group] of model.groups.entries()) {
    for (const row of group.rows) solid.insert(root, modelRowNode(solid, row, model.nameColumnWidth))
    if (index < model.groups.length - 1) solid.insert(root, blankNode(solid))
  }
  return root
}

function readPanelInputs(context, props, roster) {
  const data = context?.data
  const sessions = readResult(() => data?.session?.list?.())
  const sessionID = slotSessionID(props)
  const statuses = new Map()
  const entries = Array.isArray(sessions.value) ? sessions.value : sessions.value?.data
  if (Array.isArray(entries)) {
    for (const session of entries) {
      const id = typeof session?.id === "string" ? session.id : session?.sessionID
      if (typeof id !== "string" || id.length === 0) continue
      statuses.set(id, readResult(() => data?.session?.status?.(id)).value)
    }
  }
  if (sessionID && !statuses.has(sessionID)) statuses.set(sessionID, readResult(() => data?.session?.status?.(sessionID)).value)
  return {
    roster,
    sessionID,
    sessions: sessions.value,
    sessionsError: !sessions.ok,
    statusOf: (id) => statuses.get(id),
  }
}

/**
 * Decision 23: one bounded, read-only status event subscription keeps silent
 * long-running children from leaving a stale projection. It is owned by the
 * slot setup and removed by the same returned disposer; no polling or timer is
 * introduced.
 */
function subscribeToSessionStatus(context) {
  const on = context?.data?.on
  if (typeof on !== "function") return undefined
  try {
    return on.call(context.data, "session.status", () => {})
  } catch {
    return undefined
  }
}

export function createPanelSurface(overrides = {}) {
  const solid = overrides.solid ?? { createElement, insert, setProp }
  const roster = overrides.roster
  return {
    id: PANEL_ID,
    setup(context) {
      if (!context?.renderer || context.renderer.isDestroyed === true) return undefined
      if (typeof context?.ui?.slot !== "function") return undefined

      const render = (props) => {
        try {
          const model = buildPanelModel(readPanelInputs(context, props, roster))
          return panelNode(solid, model)
        } catch {
          return null
        }
      }

      let removeSlot
      try {
        removeSlot = context.ui.slot({ append: PANEL_SLOT_APPEND, render })
      } catch {
        return undefined
      }
      const removeStatus = subscribeToSessionStatus(context)
      return () => {
        if (typeof removeStatus === "function") removeStatus()
        if (typeof removeSlot === "function") removeSlot()
      }
    },
  }
}

export default createPanelSurface()
