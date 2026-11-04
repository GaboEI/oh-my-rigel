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
 * Representations: a leading flat "Agents per session" block (G4: one
 * `agent model` row per session that is not a category entry, exposes an agent,
 * and whose read status is `idle` or `running`, no tree) followed by R2
 * "Sessions" and R3 "Models"/"Agents"/"Providers" (the catalog representation),
 * each with its own isolated state, all inside the one <text> node the adapter
 * renders.
 *
 * Layout (F5): every boundary below comes from a sealed live capture, never from a
 * measurement this module or the surface would have to take. Width comes from the
 * F4 capture, height from the F6c capture.
 * At the 200x80 terminal of `.omo/evidence/20261104-rigel-v2-sidebar-implementation/
 * f4/live-20261104/probe-A.txt` the host paints its border cell at 0-based column
 * 155 of the 199 captured columns, so the sidebar content column is 199 - 156 = 43
 * cells wide. Two of those cells keep the main-pane background as a gutter, leaving
 * 41 usable text cells, and the same capture pins that boundary from both sides: a
 * 41-cell sidebar row (`    • context7                  Connected`, capture row 11)
 * rendered on one row, while the 42nd cell of the probe box bottom row
 * (`    └────────────────────────────────────`, capture row 32) was pushed onto the
 * next row as its own `┘` (capture row 33).
 * Every emitted line is therefore fitted to 41 cells, so no line of this block can
 * wrap into a second row and split a row's meaning.
 *
 * Growth is vertical only: no scroll, no clipping, no hiding. A block longer than
 * the 52 rows the F6c capture observed between this block's own header and the
 * last sidebar row can never be fully visible, so it degrades to the header plus
 * the read session rows, and when not even that fits it emits no line at all for
 * the adapter to render.
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

/**
 * Sidebar content column observed in the F4 live capture at 200x80: the host
 * border cell sits at 0-based column 155 of the 199 captured columns, so the
 * column right of it holds 43 cells.
 */
export const PANEL_CONTENT_WIDTH = 43

/** Cells of that column the host keeps on the main-pane background, never text. */
export const PANEL_GUTTER_WIDTH = 2

/**
 * Usable text cells: 43 - 2 = 41. The capture fits 41 cells on one row and wraps
 * the 42nd, so a line at or below this width cannot split into a second row.
 */
export const PANEL_TEXT_WIDTH = PANEL_CONTENT_WIDTH - PANEL_GUTTER_WIDTH

/**
 * Rows this block can actually use, taken from the sealed live capture
 * `.omo/evidence/20261104-rigel-v2-sidebar-implementation/f6c/visible-after.txt`
 * instead of from the terminal height the previous value carried. In that capture
 * the sidebar column spans rows 2-72 and the block header (`oh-my-rigel · models`)
 * sits at row 21, as `cat -n` numbers them (rows 1-71 and header row 20 counting
 * from zero), so the host allotted the block 72 - 21 + 1 = 52 rows from its own
 * header down to the last sidebar row. The terminal is taller than that (80 rows),
 * but the host paints the native Context and MCP panels above this block, so the
 * terminal height is a budget this block cannot use.
 */
export const PANEL_MAX_LINES = 52

/** Layout outcomes: the whole block, the header plus the read session rows, or no line. */
export const PANEL_LAYOUT = Object.freeze({
  FULL: "completo",
  COMPACT: "compacto",
  NONE: "omitido",
})

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

/**
 * East Asian wide/fullwidth cells occupy two terminal columns. The captured host
 * renders wide session titles in its own tab bar (`开始 Atlas 计划执行会`), so counting
 * characters instead of cells would overflow the observed 41-cell budget.
 */
const WIDE_RANGES = Object.freeze([
  Object.freeze([0x1100, 0x115f]),
  Object.freeze([0x2e80, 0x303e]),
  Object.freeze([0x3041, 0x33ff]),
  Object.freeze([0x3400, 0x4dbf]),
  Object.freeze([0x4e00, 0x9fff]),
  Object.freeze([0xa000, 0xa4cf]),
  Object.freeze([0xac00, 0xd7a3]),
  Object.freeze([0xf900, 0xfaff]),
  Object.freeze([0xfe30, 0xfe6f]),
  Object.freeze([0xff00, 0xff60]),
  Object.freeze([0xffe0, 0xffe6]),
  Object.freeze([0x1f300, 0x1f64f]),
  Object.freeze([0x1f900, 0x1f9ff]),
  Object.freeze([0x20000, 0x3fffd]),
])

/** Width of one code point in terminal cells. A combining mark occupies none. */
function cellWidth(codePoint) {
  if (codePoint === 0x200d || (codePoint >= 0x0300 && codePoint <= 0x036f)) return 0
  for (const [start, end] of WIDE_RANGES) {
    if (codePoint >= start && codePoint <= end) return 2
  }
  return 1
}

/** Display width of a string in terminal cells, never in code points. */
export function displayWidth(text) {
  const value = typeof text === "string" ? text : ""
  let width = 0
  for (const char of value) width += cellWidth(char.codePointAt(0))
  return width
}

/**
 * Pure visual truncation in cells: depends only on the string itself, never on
 * data or on a measurement. The ellipsis is part of the budget, so a truncated
 * value never exceeds `max` cells.
 */
export function truncate(text, max = LABEL_MAX) {
  const value = typeof text === "string" ? text : ""
  if (displayWidth(value) <= max) return value
  let fitted = ""
  let used = 0
  for (const char of value) {
    const width = cellWidth(char.codePointAt(0))
    if (used + width + 1 > max) break
    fitted += char
    used += width
  }
  return `${fitted}\u2026`
}

/** Fit one emitted line to the usable text budget observed in the sidebar. */
export function fitLine(line) {
  return truncate(line, PANEL_TEXT_WIDTH)
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

function sessionStatus(statusOf, id) {
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
    return { session, id, status: sessionStatus(reads.statusOf, id) }
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

/**
 * Title of the agent block (G4). It names exactly what its rows show: the agent
 * and effective model of each eligible session, meaning a session that is not a
 * category entry, exposes an agent, and whose read status is `idle` or `running`.
 * A session with no read status, or with a status outside that set (`terminated`),
 * contributes no row even if its status was read.
 *
 * It makes NO activity claim. I-3 admits one status read, for the
 * slot-selected session, so the panel cannot know whether any other listed
 * session is active; a title such as "Active agents" would assert a roster-wide
 * activity truth this panel does not have. It is also deliberately NOT the
 * catalog "Agents" title: that section lists what is installed, this block lists
 * what the read sessions run, and merging them would claim the catalog is live.
 */
const AGENT_BLOCK_TITLE = "Agents per session"

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
 * G4 keeps the agent of each row-eligible session visible: a row exists only for
 * a session that is not a category entry, exposes an agent, and whose read status
 * is `idle` or `running`, so a session with no read status or with a status
 * outside that set (`terminated`) is omitted. G5's tree
 * form (a `*` main row, indented children, `|_` nesting) and its enumeration stay
 * BLOQUEADO until the host demonstrates `parentID`, depth and a stable enumeration,
 * so this block renders a FLAT list: no glyph, no indentation level, no counter,
 * and no ordering claim beyond the roster order the read already carries.
 *
 * Each row is `agent model`. The model is the session's own effective model, or
 * `-` when the source supplied none; a catalog entry is never substituted for it.
 * No row shows a status: only the slot-selected session's status was read (I-3),
 * so a per-row status would either invent one or repeat a read this panel never
 * performed.
 *
 * The block is omitted entirely when the roster read is unavailable or errored
 * and when no session qualifies. The Sessions section already carries that same
 * degradation, so repeating "no disponible"/"error" here would claim one fact
 * twice and could be read as a second, independent failure.
 */
function activeAgentLines(model) {
  const active = isRecord(model) ? model.agentRows : undefined
  if (!isRecord(active) || active.state !== PANEL_STATE.AVAILABLE) return []
  if (!Array.isArray(active.rows)) return []

  const lines = []
  for (const row of active.rows) {
    if (!isRecord(row)) continue
    const agent = typeof row.agent === "string" && row.agent.length > 0 ? row.agent : null
    if (agent === null) continue
    const modelLabel = typeof row.model === "string" && row.model.length > 0 ? row.model : "-"
    lines.push(`  - ${agent} ${modelLabel}`)
  }
  return lines.length > 0 ? [AGENT_BLOCK_TITLE, ...lines] : []
}

/**
 * Format the model as ONE plain multiline string, with every line fitted to the
 * observed sidebar text budget. This is the only textual contract; the adapter
 * renders it into a single OpenTUI <text> node. The function never throws: a
 * malformed model degrades to a safe header.
 */
export function formatPanel(model) {
  try {
    const lines = ["Oh My Rigel"]
    const location = isRecord(model) && typeof model.location === "string" && model.location.length > 0 ? model.location : null
    lines.push(location ? `  ${location}` : "  no disponible")
    lines.push(...activeAgentLines(model))
    const sections = isRecord(model) && Array.isArray(model.sections) ? model.sections : []
    for (const section of sections) {
      if (isRecord(section) && typeof section.id === "string") lines.push(...sectionLines(section))
    }
    return lines.map(fitLine).join("\n")
  } catch {
    return "Oh My Rigel\n  no disponible"
  }
}

/** The formatted block below its own standalone title line, one entry per line. */
function bodyLines(model) {
  const formatted = formatPanel(model)
  const index = formatted.indexOf("\n")
  return index === -1 ? [] : formatted.slice(index + 1).split("\n")
}

/**
 * The read-status session rows a compact block may keep: a session row is
 * rendered only when its `status` is a non-empty string, meaning the status was
 * actually read. A session whose status was never read keeps no state claim, so
 * it contributes no line and no invented value. `status` is the model's
 * already-derived field, never a fresh read.
 */
function readStatusSessionLines(model) {
  const sections = isRecord(model) && Array.isArray(model.sections) ? model.sections : []
  const sessions = sections.find((section) => isRecord(section) && section.id === "sessions")
  if (!isRecord(sessions) || !Array.isArray(sessions.rows)) return []
  const lines = []
  for (const row of sessions.rows) {
    if (!isRecord(row) || typeof row.status !== "string" || row.status.length === 0) continue
    lines.push(fitLine(rowLine("sessions", row)))
  }
  return lines
}

/**
 * Decide what the block renders without measuring anything: the whole block while
 * it fits the 52 rows the sidebar actually leaves it, otherwise the header plus
 * the read-session information, otherwise no line at all. The returned lines are
 * final and fitted; the mode says which of the three outcomes produced them, so
 * the adapter never has to infer a degradation.
 */
export function layoutPanelLines(model, headerLine) {
  const header = fitLine(typeof headerLine === "string" ? headerLine : "")
  const full = [header, ...bodyLines(model)]
  if (full.length <= PANEL_MAX_LINES) return { mode: PANEL_LAYOUT.FULL, lines: full }
  const compact = [header, ...readStatusSessionLines(model)]
  if (compact.length <= PANEL_MAX_LINES) return { mode: PANEL_LAYOUT.COMPACT, lines: compact }
  return { mode: PANEL_LAYOUT.NONE, lines: [] }
}
