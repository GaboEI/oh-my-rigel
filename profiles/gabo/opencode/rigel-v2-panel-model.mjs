/**
 * Pure core for the Oh My Rigel native OpenCode V2 read-only panel.
 *
 * The panel is a strictly visual, read-only surface: it derives a small model
 * from already-read host values and formats it as ONE plain string. This module
 * has ZERO imports so every branch is deterministic and testable without a host,
 * a renderer, or a file system. The thin runtime adapter
 * (`rigel-v2-panel-surface.mjs`) performs the authorized reads and renders the
 * string into a single OpenTUI <text> node.
 *
 * Degradation vocabulary, one per section: disponible / vacio / no disponible /
 * error. An absent or shape-undemonstrated read renders "no disponible"; a
 * demonstrated-but-empty list renders the section's empty state; a failed read
 * renders "error". No value is ever inferred or invented.
 *
 * Representations: R2 "Sessions" plus R3 "Models"/"Agents"/"Providers" (the
 * catalog representation), each with its own isolated state, all inside the one
 * <text> node the adapter renders.
 */

export const PANEL_ID = "oh-my-rigel.panel"

/** The four audited section degradation states. */
export const PANEL_STATE = Object.freeze({
  AVAILABLE: "disponible",
  EMPTY: "vac\u00edo",
  UNAVAILABLE: "no disponible",
  ERROR: "error",
})

/** Longest label rendered before a purely visual ellipsis is applied. */
export const LABEL_MAX = 40

/** V2 hierarchy fields are unavailable until the authorized F4 runtime gate. */
export const HIERARCHY_BLOCKED = "BLOQUEADO"

const BLOCKED_HIERARCHY = Object.freeze({
  parentID: HIERARCHY_BLOCKED,
  depth: HIERARCHY_BLOCKED,
  enumeration: HIERARCHY_BLOCKED,
})

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/** Pure visual truncation: depends only on the string itself, never on data. */
export function truncate(text, max = LABEL_MAX) {
  const value = typeof text === "string" ? text : ""
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}\u2026`
}

/** Normalize a demonstrated list-or-absent read into { available, items }. */
function normalizeList(value) {
  if (Array.isArray(value)) return { available: true, items: value }
  if (isRecord(value) && Array.isArray(value.data)) return { available: true, items: value.data }
  return { available: false, items: [] }
}

/** Resolve one section's state from its read, honoring an explicit error. */
function sectionState(error, available, count) {
  if (error) return PANEL_STATE.ERROR
  if (!available) return PANEL_STATE.UNAVAILABLE
  return count > 0 ? PANEL_STATE.AVAILABLE : PANEL_STATE.EMPTY
}

function asId(value, index) {
  if (isRecord(value) && typeof value.id === "string" && value.id.length > 0) return value.id
  if (typeof value === "string" && value.length > 0) return value
  return `#${index + 1}`
}

function resolveTitle(titleOf, id, fallback) {
  if (typeof titleOf === "function") {
    const title = titleOf(id)
    if (typeof title === "string" && title.length > 0) return title
  }
  return fallback
}

function resolveStatus(statusOf, id) {
  if (typeof statusOf === "function") {
    const status = statusOf(id)
    if (typeof status === "string" && status.length > 0) return status
  }
  return null
}

const ACTIVE_SESSION_STATUSES = new Set(["idle", "running"])

function sessionStatus(session, statusOf, id) {
  if (isRecord(session) && typeof session.status === "string" && session.status.length > 0) return session.status
  return resolveStatus(statusOf, id)
}

function isCategoryEntry(session) {
  return isRecord(session) && (session.category === true || session.kind === "category" || session.type === "category")
}

function agentName(session) {
  return isRecord(session) && typeof session.agent === "string" && session.agent.length > 0 ? session.agent : null
}

function effectiveModel(session) {
  if (!isRecord(session)) return "-"
  if (typeof session.model === "string" && session.model.length > 0) return session.model
  if (!isRecord(session.model)) return "-"
  const providerID = typeof session.model.providerID === "string" && session.model.providerID.length > 0 ? session.model.providerID : null
  const modelID = typeof session.model.modelID === "string" && session.model.modelID.length > 0 ? session.model.modelID : null
  if (providerID && modelID) return `${providerID}/${modelID}`
  return modelID ?? "-"
}

function activeAgentRows(sessionEntries, sessionsAvailable, sessionsError) {
  if (sessionsError) return { state: PANEL_STATE.ERROR, rows: [] }
  if (!sessionsAvailable) return { state: PANEL_STATE.UNAVAILABLE, rows: [] }

  const rows = []
  for (const { session, sessionID, status } of sessionEntries) {
    const agent = agentName(session)
    if (isCategoryEntry(session) || !ACTIVE_SESSION_STATUSES.has(status) || !agent) continue
    rows.push({ sessionID, agent, model: effectiveModel(session), status })
  }
  return { state: sectionState(false, true, rows.length), rows }
}

function extractDirectory(location) {
  if (typeof location === "string" && location.length > 0) return location
  if (isRecord(location)) {
    if (typeof location.directory === "string" && location.directory.length > 0) return location.directory
    if (typeof location.path === "string" && location.path.length > 0) return location.path
  }
  return null
}

function resolveLabel(entry, fallback) {
  if (typeof entry === "string" && entry.length > 0) return entry
  if (isRecord(entry)) {
    for (const key of ["name", "label", "title", "id", "modelID", "model"]) {
      const value = entry[key]
      if (typeof value === "string" && value.length > 0) return value
    }
  }
  return fallback
}

/**
 * Build the read-only panel model from already-read host values. Every input is
 * optional; a missing input degrades its own section, never the whole panel.
 * Reads are plain values plus optional per-session accessors, so the core stays
 * pure and unit-testable.
 *
 * @param {object} [reads]
 * @param {unknown} [reads.location]       resolved location object (directory/project)
 * @param {unknown} [reads.sessions]       raw session.list() result
 * @param {(id:string)=>unknown} [reads.titleOf]   session.get(id) title accessor
 * @param {(id:string)=>unknown} [reads.statusOf]  session.status(id) accessor
 * @param {unknown} [reads.models]         retained catalog read for the legacy F3 surface
 * @param {unknown} [reads.agents]         retained catalog read for the legacy F3 surface
 * @param {unknown} [reads.providers]      retained catalog read for the legacy F3 surface
 * @param {boolean} [reads.locationError]
 * @param {boolean} [reads.sessionsError]
 * @param {boolean} [reads.modelsError]
 * @param {boolean} [reads.agentsError]
 * @param {boolean} [reads.providersError]
 * @returns {{ id: string, location: string | null, agentRows: { state: string, hierarchy: object, rows: Array<{ sessionID: string, agent: string, model: string, status: string }> }, sections: Array<object> }}
 */
export function buildPanelModel(reads = {}) {
  const location = reads.locationError ? null : extractDirectory(reads.location)
  const sessions = normalizeList(reads.sessions)
  const models = normalizeList(reads.models)
  const agents = normalizeList(reads.agents)
  const providers = normalizeList(reads.providers)
  const sessionEntries = sessions.items.map((session, index) => {
    const id = asId(session, index)
    return { session, id, status: sessionStatus(session, reads.statusOf, id) }
  })
  const activeAgents = activeAgentRows(
    sessionEntries.map(({ session, id, status }) => ({ session, sessionID: id, status })),
    sessions.available,
    reads.sessionsError,
  )
  const sessionRows = sessionEntries.map(({ id, status }) => ({
    id,
    title: truncate(resolveTitle(reads.titleOf, id, id)),
    status,
  }))

  const labelRows = (items) =>
    items.map((entry, index) => {
      const id = asId(entry, index)
      return { id, label: truncate(resolveLabel(entry, id)) }
    })

  const modelRows = labelRows(models.items)
  const agentRows = labelRows(agents.items)
  const providerRows = labelRows(providers.items)

  return {
    id: PANEL_ID,
    location,
    agentRows: {
      state: activeAgents.state,
      hierarchy: BLOCKED_HIERARCHY,
      rows: activeAgents.rows,
    },
    sections: [
      {
        id: "sessions",
        title: "Sessions",
        state: sectionState(reads.sessionsError, sessions.available, sessionRows.length),
        rows: sessionRows,
      },
      {
        id: "models",
        title: "Models",
        state: sectionState(reads.modelsError, models.available, modelRows.length),
        rows: modelRows,
      },
      {
        id: "agents",
        title: "Agents",
        state: sectionState(reads.agentsError, agents.available, agentRows.length),
        rows: agentRows,
      },
      {
        id: "providers",
        title: "Providers",
        state: sectionState(reads.providersError, providers.available, providerRows.length),
        rows: providerRows,
      },
    ],
  }
}

const EMPTY_LINES = Object.freeze({
  sessions: "  (sin sesiones)",
  models: "  No hay modelos disponibles",
  agents: "  No hay agentes disponibles",
  providers: "  No hay proveedores disponibles",
})

function emptyLine(sectionId) {
  return Object.prototype.hasOwnProperty.call(EMPTY_LINES, sectionId) ? EMPTY_LINES[sectionId] : "  (sin elementos)"
}

function rowLine(sectionId, row) {
  if (sectionId === "sessions") {
    return row.status ? `  - ${row.title} [${row.status}]` : `  - ${row.title}`
  }
  return `  - ${row.label}`
}

function sectionLines(section) {
  const lines = [section.title]
  if (section.state === PANEL_STATE.AVAILABLE) {
    for (const row of section.rows) lines.push(rowLine(section.id, row))
  } else if (section.state === PANEL_STATE.EMPTY) {
    lines.push(emptyLine(section.id))
  } else {
    lines.push(`  ${section.state}`)
  }
  return lines
}

/**
 * Format the model as ONE plain multiline string. This is the only textual
 * contract; the adapter renders it into a single OpenTUI <text> node. The
 * function never throws: a malformed model degrades to a safe header.
 */
export function formatPanel(model) {
  try {
    const lines = ["Oh My Rigel"]
    const location = isRecord(model) && typeof model.location === "string" && model.location.length > 0 ? model.location : null
    lines.push(location ? `  ${truncate(location, 60)}` : "  no disponible")
    const sections = isRecord(model) && Array.isArray(model.sections) ? model.sections : []
    for (const section of sections) {
      if (isRecord(section) && typeof section.id === "string") lines.push(...sectionLines(section))
    }
    return lines.join("\n")
  } catch {
    return "Oh My Rigel\n  no disponible"
  }
}
