/**
 * Pure model for the native Rigel sidebar panel.
 *
 * The compositor injects the declared roster once when the TUI session opens.
 * This module never reads files, host catalogs, or renderer state. It only
 * projects that roster and the already-read session statuses into one of the
 * two approved panel states.
 */

export const PANEL_ID = "oh-my-rigel.panel"
export const PANEL_HEADER_REST = "oh-my-rigel · models"
export const PANEL_HEADER_WORKING = "oh-my-rigel · working"

export const PANEL_COLORS = Object.freeze({
  base: "#E8D8B0",
  dim: "#9A8F73",
  brand: "#5FA8D3",
  working: "#7FB069",
  warn: "#D9A05B",
  border: "#6E6552",
})

export const PRINCIPAL_FALLBACK_COLORS = Object.freeze([
  "#00CED1",
  "#D97706",
  "#FF5722",
  "#10B981",
  "#20B2AA",
])

export const PRINCIPAL_NAMES = Object.freeze([
  "Sisyphus",
  "Hephaestus",
  "Prometheus",
  "Atlas",
  "Sisyphus-Junior",
  "Judge",
])

const STARRED_PRINCIPAL_NAMES = new Set(["Sisyphus", "Hephaestus", "Prometheus", "Atlas", "Judge"])

export const SUBAGENT_NAMES = Object.freeze([
  "explore",
  "librarian",
  "Metis",
  "Momus",
  "multimodal-looker",
  "Oracle",
])

export const CATEGORY_NAMES = Object.freeze([
  "artistry",
  "deep-high",
  "deep-low",
  "quick",
  "ultrabrain",
  "unspecified-high",
  "unspecified-low",
  "visual-engineering",
  "writing",
])

const PRINCIPAL_ALIASES = Object.freeze({
  sisyphus: "Sisyphus",
  hephaestus: "Hephaestus",
  prometheus: "Prometheus",
  atlas: "Atlas",
  "sisyphus-junior": "Sisyphus-Junior",
  sisyphusjunior: "Sisyphus-Junior",
  judge: "Judge",
})

const DISPLAY_BY_KEY = Object.freeze(
  Object.fromEntries(
    [...PRINCIPAL_NAMES, ...SUBAGENT_NAMES, ...CATEGORY_NAMES].map((name) => [name.toLowerCase(), name]),
  ),
)

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function canonicalKey(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+-\s+.*$/, "")
    .replace(/\s+/g, "-")
    .toLowerCase()
}

function displayName(value) {
  const raw = stringValue(value) ?? ""
  const key = canonicalKey(raw)
  return PRINCIPAL_ALIASES[key] ?? DISPLAY_BY_KEY[key] ?? raw
}

function findEntry(source, expectedName) {
  if (Array.isArray(source)) {
    return source.find((entry) => canonicalKey(entry?.name ?? entry?.id ?? entry) === canonicalKey(expectedName))
  }
  if (!isRecord(source)) return undefined
  for (const [key, value] of Object.entries(source)) {
    if (canonicalKey(key) === canonicalKey(expectedName) || canonicalKey(value?.name) === canonicalKey(expectedName)) return value
  }
  return undefined
}

function firstModel(entry) {
  if (Array.isArray(entry?.models) && entry.models.length > 0) return entry.models[0]
  return entry?.model
}

function modelReference(entry) {
  const candidate = firstModel(entry)
  if (typeof candidate === "string") return candidate
  if (isRecord(candidate)) return candidate.model ?? candidate.id ?? candidate.modelID
  return undefined
}

/**
 * Convert a provider-qualified model to the family.variant display requested by
 * the vault. Provider names and the `-flash` transport suffix are not useful in
 * this roster. Decision 18: abbreviate to family.variant.
 */
export function abbreviateModel(value) {
  const raw = stringValue(value)
  if (!raw) return "-"
  const withoutVariant = raw.split("#", 1)[0]
  const family = withoutVariant.split("/").at(-1) ?? withoutVariant
  return family.replace(/-flash$/, "")
}

function hexColor(value) {
  const raw = stringValue(value)
  return raw?.match(/^#[0-9a-f]{6}$/i) ? raw.toUpperCase() : undefined
}

function nearWhite(value) {
  const hex = hexColor(value)
  if (!hex) return false
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16))
  return channels.every((channel) => channel > 0xe0)
}

/**
 * Decision 20: all resolved colors pass this pure anti-white filter. Unknown
 * host theme tokens use the approved semantic fallback rather than becoming a
 * renderer default that could silently resolve to white.
 */
export function filterPanelColor(value, fallback = PANEL_COLORS.base) {
  const fixed = hexColor(value)
  if (fixed && !nearWhite(fixed)) return fixed
  if (fixed || value === "theme.text.base" || value === "text.base") return PANEL_COLORS.base
  if (value === "theme.text.muted" || value === "text.muted") return PANEL_COLORS.dim
  if (value === "primary" || value === "theme.primary") return PANEL_COLORS.brand
  if (value === "text.feedback.success" || value === "theme.text.feedback.success") return PANEL_COLORS.working
  return filterPanelColor(fallback, PANEL_COLORS.base)
}

function colorForPrincipal(name, index, colors) {
  const configured = isRecord(colors) ? colors[name] ?? colors[canonicalKey(name)] : undefined
  return filterPanelColor(configured, PRINCIPAL_FALLBACK_COLORS[index % PRINCIPAL_FALLBACK_COLORS.length])
}

function rosterRows(source, names, colors, principalOffset = 0) {
  return names.map((name, index) => {
    const entry = findEntry(source, name)
    const model = abbreviateModel(modelReference(entry))
    const principal = PRINCIPAL_NAMES.includes(name)
    return {
      name,
      model,
      nameColor: principal ? colorForPrincipal(name, principalOffset + index, colors) : PANEL_COLORS.base,
      modelColor: PANEL_COLORS.dim,
    }
  })
}

/**
 * Build the compositor-owned roster. Decision 11: each row uses models[0] from
 * the live `omo.jsonc` view. Decision 13: Judge is supplied separately from
 * OpenCode's default model because it is not declared in that file.
 */
export function buildRoster({ agents, categories, judgeModel, principalColors } = {}) {
  const principals = rosterRows(agents, PRINCIPAL_NAMES.slice(0, 5), principalColors)
  principals.push({
    name: "Judge",
    model: abbreviateModel(judgeModel),
    nameColor: colorForPrincipal("Judge", 5, principalColors),
    modelColor: PANEL_COLORS.dim,
  })
  return Object.freeze({
    principals: Object.freeze(principals),
    subagents: Object.freeze(rosterRows(agents, SUBAGENT_NAMES, undefined)),
    categories: Object.freeze(rosterRows(categories, CATEGORY_NAMES, undefined)),
  })
}

function normalizeList(value) {
  if (Array.isArray(value)) return { available: true, items: value }
  if (isRecord(value) && Array.isArray(value.data)) return { available: true, items: value.data }
  return { available: false, items: [] }
}

function sessionId(session, index) {
  const id = isRecord(session) ? stringValue(session.id ?? session.sessionID) : undefined
  return id ?? `internal-${index}`
}

function normalizeStatus(value) {
  if (typeof value === "string") return value
  return stringValue(value?.status)
}

function creationTime(session, index) {
  const candidate = session?.time?.created ?? session?.created ?? session?.createdAt
  if (typeof candidate === "number") return candidate
  if (typeof candidate === "string") {
    const parsed = Date.parse(candidate)
    if (!Number.isNaN(parsed)) return parsed
  }
  return index
}

function sessionAgent(session) {
  return displayName(session?.agent ?? session?.agentID)
}


function isPrincipal(name) {
  return STARRED_PRINCIPAL_NAMES.has(name)
}

function buildWorkingRows(sessions, statusOf) {
  const entries = sessions.items
    .map((session, index) => {
      const id = sessionId(session, index)
      const status = normalizeStatus(typeof statusOf === "function" ? statusOf(id) : undefined)
      return { session, id, status, order: creationTime(session, index), index }
    })
    .filter(({ status }) => status === "running")
    .sort((left, right) => left.order - right.order || left.index - right.index)

  let juniorNumber = 0
  return entries.map(({ session, id, status }) => {
    const name = sessionAgent(session)
    const junior = name === "Sisyphus-Junior"
    // decision 28: compact numbering is recalculated over the creation-ordered running list.
    if (junior) juniorNumber += 1
    return {
      name: junior ? `${name} ${juniorNumber}` : name,
      rawName: name,
      // decision 27: only orchestration principals carry the approved marker.
      prefix: isPrincipal(name) ? "* " : "",
      status,
      sessionID: id,
      nameColor: isPrincipal(name) ? undefined : PANEL_COLORS.base,
      statusColor: PANEL_COLORS.working,
    }
  })
}

function rosterNameColumnWidth(roster) {
  const rows = [
    ...(roster?.principals ?? []),
    ...(roster?.subagents ?? []),
    ...(roster?.categories ?? []),
  ]
  return rows.reduce((width, row) => Math.max(width, String(row?.name ?? "").length), 0) + 1
}

/**
 * Decision 9: the panel has exactly two projections. Decision 14/24: the
 * working projection is only the current running set, never history.
 */
export function buildPanelModel(reads = {}) {
  const roster = reads.roster ?? buildRoster()
  const sessions = normalizeList(reads.sessions)
  const workingRows = buildWorkingRows(sessions, reads.statusOf)
  const working = workingRows.length > 0
  const groups = working
    ? []
    : [
        { id: "principals", rows: roster.principals ?? [] },
        { id: "subagents", rows: roster.subagents ?? [] },
        { id: "categories", rows: roster.categories ?? [] },
      ]

  return {
    id: PANEL_ID,
    mode: working ? "working" : "models",
    header: working ? PANEL_HEADER_WORKING : PANEL_HEADER_REST,
    groups,
    rows: working ? workingRows : groups.flatMap((group) => group.rows),
    nameColumnWidth: rosterNameColumnWidth(roster),
    currentSessionID: stringValue(reads.sessionID),
  }
}

function paddedName(row, width) {
  const label = `${row.prefix ?? ""}${row.name ?? ""}`
  return label.padEnd(width)
}

/**
 * Plain rendered-text evidence. The live surface uses a computed name column
 * because row/flex layout was not proven available in this slot; the column is
 * the roster's longest name plus its one separator, with no invented width.
 */
export function formatPanel(model) {
  try {
    const source = isRecord(model) ? model : buildPanelModel()
    const width = Number.isInteger(source.nameColumnWidth) ? source.nameColumnWidth : 0
    const lines = [source.header ?? PANEL_HEADER_REST, ""]
    if (source.mode === "working") {
      for (const row of source.rows ?? []) lines.push(`${paddedName(row, width)}${row.status ?? ""}`)
      return lines.join("\n")
    }
    for (const [index, group] of (source.groups ?? []).entries()) {
      for (const row of group.rows ?? []) lines.push(`${paddedName(row, width)}${row.model ?? ""}`)
      if (index < (source.groups?.length ?? 0) - 1) lines.push("")
    }
    return lines.join("\n")
  } catch {
    return PANEL_HEADER_REST
  }
}
