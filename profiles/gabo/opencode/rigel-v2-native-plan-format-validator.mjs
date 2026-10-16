import fs from "node:fs"
import path from "node:path"

const WRITE_TOOLS = new Set(["write", "edit"])
const SECTION_BOUNDARY_HEADING = /^#{1,2}(?:[ \t]+|$)/
const HEADING_TODOS = /^##[ \t]+TODOs(?:[ \t]+#+)?[ \t]*$/i
const HEADING_FINAL_WAVE = /^##[ \t]+Final Verification Wave(?:[ \t]+#+)?[ \t]*$/i
const TOPLEVEL_CHECKBOX = /^[-*]\s*\[[ xX~]?\]/
const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/
const SIMPLE_CHECKBOX = /^[-*][ \t]*\[[ \t]*([xX~]?)[ \t]*\][ \t]+(.+)$/
const STRUCTURED_CHECKBOX = /^- \[([ xX~])\] (.+)$/
const TODO_TASK_LABEL = /^([1-9]\d*|T[1-9]\d*(?:\.[1-9]\d*[a-z]?)?)(?:\.[ \t]+|[ \t]+(?:[-\u2014][ \t]+)?)(.+)$/i
const FINAL_WAVE_TASK_LABEL = /^([FH][1-9]\d*(?:\.[1-9]\d*[a-z]?)?)(?:\.[ \t]+|[ \t]+(?:[-\u2014][ \t]+)?)(.+)$/i
const EFFORT_LINE = /^(\*\*Effort:\*\*[ \t]*)(.*)$/
const DURATION_VALUE = /(\d+(?:[.,]\d+)?)\s*(?:-|\u2013|to)?\s*(\d+(?:[.,]\d+)?)?\s*(min(?:ute)?s?|h(?:ou)?rs?|d(?:ay)?s?|w(?:ee)?ks?|mo(?:nth)?s?)\b/i
const HOURS_PER_UNIT = { min: 1 / 60, h: 1, d: 8, w: 40, mo: 160 }
const BAND_UPPER_BOUND_HOURS = [["Quick", 1], ["Short", 4], ["Medium", 16], ["Large", 40]]

/** The five Effort bands; effort is a size signal, never a wall-clock estimate. */
export const PLAN_EFFORT_BANDS = ["Quick", "Short", "Medium", "Large", "XL"]

/** Maps a written duration ("200 hours", "3 days", "2-3 weeks") to the band that bounds it. */
export function effortBandForDuration(value) {
  const match = value.match(DURATION_VALUE)
  if (match === null) return null
  const upper = (match[2] ?? match[1] ?? "").replace(",", ".")
  const unit = (match[3] ?? "").toLowerCase()
  const key = unit.startsWith("mi") ? "min" : unit.startsWith("mo") ? "mo" : unit.charAt(0)
  const hours = Number.parseFloat(upper) * (HOURS_PER_UNIT[key] ?? 1)
  if (!Number.isFinite(hours)) return null
  for (const [band, bound] of BAND_UPPER_BOUND_HOURS) if (hours <= bound) return band
  return "XL"
}

/** Rewrites a duration-bearing `**Effort:**` value to its bounding band; leaves bands/labels alone. */
export function normalizePlanEffort(content) {
  const lines = content.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const match = (lines[index] ?? "").match(EFFORT_LINE)
    if (match === null) continue
    const value = (match[2] ?? "").trim()
    const band = effortBandForDuration(value)
    if (band === null) return null
    lines[index] = `${match[1] ?? ""}${band}`
    return { content: lines.join(content.includes("\r\n") ? "\r\n" : "\n"), original: value, band }
  }
  return null
}

function parseOpeningFence(line) {
  const match = line.match(FENCE_OPEN)
  const run = match?.[1]
  const info = match?.[2]
  const marker = run?.charAt(0)
  if (run === undefined || info === undefined || (marker !== "`" && marker !== "~") || (marker === "`" && info.includes("`"))) return null
  return { marker, length: run.length }
}

function isClosingFence(line, fence) {
  const run = line.match(FENCE_CLOSE)?.[1]
  return run?.charAt(0) === fence.marker && run.length >= fence.length
}

/** The lines the V1 parser visits: fenced code blocks are removed. */
function unfencedLines(content) {
  const kept = []
  let fence = null
  for (const line of content.split(/\r?\n/)) {
    if (fence !== null) {
      if (isClosingFence(line, fence)) fence = null
      continue
    }
    const opening = parseOpeningFence(line)
    if (opening !== null) fence = opening
    else kept.push(line)
  }
  return kept
}

function statusOf(marker) {
  return marker.toLowerCase() === "x" ? "done" : marker === "~" ? "in-progress" : "open"
}

function simpleRow(line) {
  const match = line.match(SIMPLE_CHECKBOX)
  if (match?.[1] === undefined || match?.[2] === undefined) return null
  return { status: statusOf(match[1]) }
}

function structuredRow(line, section) {
  const match = line.match(STRUCTURED_CHECKBOX)
  if (match?.[1] === undefined || match?.[2] === undefined) return null
  const label = match[2].match(section === "todo" ? TODO_TASK_LABEL : FINAL_WAVE_TASK_LABEL)
  if (label?.[1] === undefined || label?.[2] === undefined) return null
  return { status: statusOf(match[1]) }
}

/** Whether `line` is a top-level task row the structured parser counts inside `section`. */
export function isStructuredTaskRow(line, section) {
  return structuredRow(line, section) !== null
}

function tally(bucket, row) {
  bucket.total += 1
  if (row.status === "done") bucket.completed += 1
  else if (row.status !== "in-progress") bucket.remaining += 1
}

function parsePlanChecklist(markdown) {
  const simple = { total: 0, completed: 0, remaining: 0 }
  const structured = { total: 0, completed: 0, remaining: 0 }
  let hasSection = false
  let hasUntracked = false
  let section = "other"
  for (const line of unfencedLines(markdown)) {
    if (SECTION_BOUNDARY_HEADING.test(line)) {
      section = HEADING_TODOS.test(line) ? "todo" : HEADING_FINAL_WAVE.test(line) ? "final-wave" : "other"
      if (section !== "other") hasSection = true
      continue
    }
    const raw = simpleRow(line)
    if (raw !== null) {
      tally(simple, raw)
      if (section === "other") hasUntracked = true
    }
    if (section !== "other") {
      const candidate = structuredRow(line, section)
      if (candidate !== null) tally(structured, candidate)
    }
  }
  if (!hasSection) return simple
  return structured.total === 0 && hasUntracked ? simple : structured
}

/** Faithful minimal reimplementation of the V1 boulder-state plan progress reader. */
export function getPlanProgress(planPath) {
  if (!fs.existsSync(planPath)) return { total: 0, completed: 0, isComplete: false }
  try {
    const checklist = parsePlanChecklist(fs.readFileSync(planPath, "utf-8"))
    return { total: checklist.total, completed: checklist.completed, isComplete: checklist.total > 0 && checklist.remaining === 0 }
  } catch {
    return { total: 0, completed: 0, isComplete: false }
  }
}

function analyzeStructuredSections(content) {
  const sections = []
  let section = null
  for (const line of unfencedLines(content)) {
    if (SECTION_BOUNDARY_HEADING.test(line)) {
      const name = HEADING_TODOS.test(line) ? "todo" : HEADING_FINAL_WAVE.test(line) ? "final-wave" : null
      section = name === null ? null : { name, stats: { raw: 0, valid: 0 } }
      if (section !== null) sections.push(section.stats)
      continue
    }
    if (section === null || !TOPLEVEL_CHECKBOX.test(line)) continue
    section.stats.raw += 1
    if (isStructuredTaskRow(line, section.name)) section.stats.valid += 1
  }
  return { rawCount: sections.reduce((total, item) => total + item.raw, 0), hasEmptySection: sections.some((item) => item.valid === 0), hasMalformedRows: sections.some((item) => item.raw !== item.valid), recognized: sections.length > 0 }
}

function buildEffortWarning(normalized) {
  return [
    "",
    "<plan-format-warning>",
    `Effort was written as a duration (\`${normalized.original}\`) and has been replaced with the band \`${normalized.band}\`.`,
    "Effort is a size band, never a wall-clock estimate. Use exactly one of:",
    "  Quick (single edit, minutes of agent work) | Short (one focused change, a few files)\n  | Medium (multi-file feature in one session) | Large (several waves, one long session)\n  | XL (multi-session or architectural work).",
    "Size is communicated by the counted todo rows; do not write hours or days.",
    "</plan-format-warning>",
  ].join("\n")
}

function buildWarning(rawCount, parsedCount, hasEmptySection) {
  const skipped = rawCount - parsedCount
  if (hasEmptySection) {
    const summary = parsedCount === 0
      ? "Plan has recognized task sections but no valid task rows."
      : "One or more recognized task sections contain no valid task rows."
    return [
      "",
      "<plan-format-warning>",
      summary,
      "Those sections will contribute no tasks to `/ulw-execute` progress.",
      "**Fix**: Every task checkbox under `## TODOs` MUST start with a bare number followed by dot + space: `1.`, `2.`, `3.` - NOT `Phase 1:`, `Task-1.` etc.",
      "Every Final Verification Wave checkbox MUST start with `F` + number: `F1.`, `F2.` - NOT `T-F1.`, `F-1.`, `Final-1.` etc.",
      "</plan-format-warning>",
    ].join("\n")
  }
  return [
    "",
    "<plan-format-warning>",
    `Plan has **${rawCount} task checkbox(es)** but \`getPlanProgress()\` only parsed **${parsedCount}**. `,
    `**${skipped} task(s)** have malformed labels and will be SKIPPED by the progress counter.`,
    `\`/ulw-execute\` will show "Progress: ${parsedCount} tasks" - missing ${skipped} task(s).`,
    "**Fix**: Ensure every skipped task checkbox uses bare-number format:\n  `## TODOs` -> `1.`, `2.`, `3.` (NOT `Phase 1:`, `Task-1.`)\n  `## Final Verification Wave` -> `F1.`, `F2.`, `F3.` (NOT `T-F1.`, `F-1.`, `Final-1.`)",
    "</plan-format-warning>",
  ].join("\n")
}

function isPlanFilePath(filePath) {
  const normalized = filePath.toLowerCase().replace(/\\/g, "/")
  return normalized.includes(".omo/plans/") && normalized.endsWith(".md")
}

/**
 * Read the tool-result text from whichever channel the real V2
 * `tool.execute.after` event carries. The live form for a `write` is a plain
 * `event.output` string; `event.result.content` (string or text-part array) and
 * `event.result.output` are honored as fallbacks so the validator is not tied to
 * one host shape.
 */
function readResultText(event) {
  const content = event?.result?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("")
  if (typeof event?.result?.output === "string") return event.result.output
  if (typeof event?.output === "string") return event.output
  return ""
}

/** Whether the event exposes any mutable result channel to annotate. */
function hasResultChannel(event) {
  const content = event?.result?.content
  return typeof content === "string" || Array.isArray(content) || typeof event?.result?.output === "string" || typeof event?.output === "string"
}

/** Append text to whichever mutable result channel the event exposes. */
function appendResultText(event, text) {
  const content = event?.result?.content
  if (Array.isArray(content)) {
    content.push({ type: "text", text })
    return true
  }
  if (typeof content === "string") {
    event.result.content = content + text
    return true
  }
  if (typeof event?.result?.output === "string") {
    event.result.output += text
    return true
  }
  if (typeof event?.output === "string") {
    event.output += text
    return true
  }
  return false
}

/**
 * Native V2 replacement for the V1 plan-format-validator hook: after a plan write,
 * normalize duration efforts to bands and warn when malformed task rows would be skipped.
 */
export function createNativePlanFormatValidator({
  directory,
  readFile = (file) => fs.readFileSync(file, "utf-8"),
  writeFile = (file, content) => fs.writeFileSync(file, content, "utf-8"),
  existsSync = (file) => fs.existsSync(file),
  getPlanProgress: readProgress = getPlanProgress,
} = {}) {
  const root = directory ?? process.cwd()
  return {
    async after(event) {
      const tool = String(event?.tool ?? "").toLowerCase()
      if (!WRITE_TOOLS.has(tool)) return
      const args = event?.input ?? event?.args
      if (!args || typeof args !== "object") return
      const filePath = args.filePath ?? args.path ?? args.file
      if (typeof filePath !== "string") return
      if (!isPlanFilePath(filePath)) return

      if (!hasResultChannel(event)) return
      const prior = readResultText(event)
      if (prior.includes("<plan-format-warning>")) return

      const resolved = path.resolve(root, filePath)
      if (!existsSync(resolved)) return

      let content = readFile(resolved)
      const effort = normalizePlanEffort(content)
      if (effort !== null) {
        content = effort.content
        writeFile(resolved, content)
        appendResultText(event, buildEffortWarning(effort))
      }

      const stats = analyzeStructuredSections(content)
      if (!stats.recognized) return
      const parsedCount = readProgress(resolved).total
      if (!stats.hasEmptySection && !stats.hasMalformedRows) return
      appendResultText(event, buildWarning(stats.rawCount, parsedCount, stats.hasEmptySection))
    },
  }
}
