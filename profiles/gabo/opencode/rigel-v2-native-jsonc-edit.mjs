/**
 * Comment-, BOM-, and line-ending-PRESERVING edit planners for a JSONC document.
 *
 * Every planner returns the new document text by replacing only the spans it
 * must change, so an edit that touches one value leaves every comment, blank
 * line, key order, byte-order mark, and CRLF pair in place. A planner never
 * writes, never throws, and returns `changed: false` with the source text
 * untouched when the edit is a no-op, which is what makes "an idempotent request
 * writes nothing" a property of the planner instead of a caller convention.
 *
 * After splicing, the result is re-parsed before it is returned: a planner that
 * would produce unparseable JSONC reports EDIT_CORRUPTED instead of handing a
 * broken document to the writer.
 */
import {
  deepEqual,
  detectJsoncFormat,
  failResult,
  parseJsoncDocument,
  serializeJsoncValue,
  skipTriviaAt,
} from "./rigel-v2-native-jsonc-parse.mjs"

function normalizeSegments(path) {
  if (!Array.isArray(path) || path.length === 0) return failResult("INVALID_PATH", "path must be a non-empty array")
  for (const segment of path) {
    const valid = typeof segment === "string" || (typeof segment === "number" && Number.isInteger(segment) && segment >= 0)
    if (!valid) return failResult("INVALID_PATH", "path segments must be strings or non-negative integers")
  }
  return { ok: true, segments: [...path] }
}

/** The matching child plus its position among its siblings (last duplicate wins). */
function childOf(node, segment) {
  if (node.kind === "object" && typeof segment === "string") {
    for (let index = node.members.length - 1; index >= 0; index -= 1) {
      if (node.members[index].key === segment) return { found: true, node: node.members[index].value, index }
    }
    return { found: false }
  }
  if (node.kind === "array" && typeof segment === "number" && segment < node.items.length) {
    return { found: true, node: node.items[segment], index: segment }
  }
  return { found: false }
}

function locate(text, path) {
  const parsed = parseJsoncDocument(text)
  if (!parsed.ok) return parsed
  const normalized = normalizeSegments(path)
  if (!normalized.ok) return normalized
  const segments = normalized.segments
  let container = parsed.root
  let index = 0
  while (index < segments.length) {
    const step = childOf(container, segments[index])
    if (!step.found) return { ok: true, found: false, container, index, segments, root: parsed.root }
    if (index === segments.length - 1) return { ok: true, found: true, node: step.node, container, sibling: step.index, index, segments, root: parsed.root }
    container = step.node
    index += 1
  }
  return { ok: true, found: false, container, index, segments, root: parsed.root }
}

/** Read a value by path from JSONC text. */
export function readJsoncValue(text, path) {
  const source = typeof text === "string" ? text : ""
  const parsed = parseJsoncDocument(source)
  if (!parsed.ok) return parsed
  const normalized = normalizeSegments(path)
  if (!normalized.ok) return normalized
  let node = parsed.root
  for (const segment of normalized.segments) {
    const step = childOf(node, segment)
    if (!step.found) return { ok: true, found: false, value: undefined }
    node = step.node
  }
  return { ok: true, found: true, value: node.value, node }
}

function indentOfLine(text, offset) {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1
  const prefix = text.slice(lineStart, offset)
  return /^[ \t]*$/.test(prefix) ? prefix : ""
}

function padContinuation(rendered, column, eol) {
  if (column === "" || !rendered.includes(eol)) return rendered
  return rendered.split(eol).map((line, index) => (index === 0 ? line : `${column}${line}`)).join(eol)
}

function replaceValueEdits(text, node, value, format) {
  const inline = !/[\r\n]/.test(text.slice(node.start, node.end))
  const rendered = serializeJsoncValue(value, { indent: format.indent, eol: format.eol, inline })
  return [{ start: node.start, end: node.end, replacement: padContinuation(rendered, indentOfLine(text, node.start), format.eol) }]
}

/** Whether a separator already follows an element, so insertion never doubles it. */
function hasSeparatorAfter(text, offset) {
  return text[skipTriviaAt(text, offset).index] === ","
}

function insertMemberEdits(text, object, key, value, format) {
  const multiline = /[\r\n]/.test(text.slice(object.start, object.end))
  const last = object.members.at(-1)
  if (!multiline) {
    const entry = `${JSON.stringify(key)}: ${serializeJsoncValue(value, { inline: true })}`
    if (last === undefined) return [{ start: object.start + 1, end: object.start + 1, replacement: entry }]
    const separator = hasSeparatorAfter(text, last.end) ? "" : ","
    return [{ start: last.end, end: last.end, replacement: `${separator} ${entry}` }]
  }
  const closeAt = object.end - 1
  const memberIndent = last === undefined ? `${indentOfLine(text, object.start)}${format.indent}` : indentOfLine(text, last.start)
  const rendered = padContinuation(serializeJsoncValue(value, { indent: format.indent, eol: format.eol }), memberIndent, format.eol)
  const edits = []
  if (last !== undefined && !hasSeparatorAfter(text, last.end)) edits.push({ start: last.end, end: last.end, replacement: "," })
  edits.push({ start: closeAt, end: closeAt, replacement: `${JSON.stringify(key)}: ${rendered}${format.eol}${indentOfLine(text, closeAt)}` })
  return edits
}

function insertItemEdits(text, array, item, format) {
  const multiline = /[\r\n]/.test(text.slice(array.start, array.end))
  const last = array.items.at(-1)
  if (!multiline) {
    const entry = serializeJsoncValue(item, { inline: true })
    if (last === undefined) return [{ start: array.start + 1, end: array.start + 1, replacement: entry }]
    const separator = hasSeparatorAfter(text, last.end) ? "" : ","
    return [{ start: last.end, end: last.end, replacement: `${separator} ${entry}` }]
  }
  const closeAt = array.end - 1
  const itemIndent = last === undefined ? `${indentOfLine(text, array.start)}${format.indent}` : indentOfLine(text, last.start)
  const rendered = padContinuation(serializeJsoncValue(item, { indent: format.indent, eol: format.eol }), itemIndent, format.eol)
  const edits = []
  if (last !== undefined && !hasSeparatorAfter(text, last.end)) edits.push({ start: last.end, end: last.end, replacement: "," })
  edits.push({ start: closeAt, end: closeAt, replacement: `${rendered}${format.eol}${indentOfLine(text, closeAt)}` })
  return edits
}

/**
 * Remove one element. An element on its own line takes the whole line and its
 * separator with it, which keeps the previous line's trailing comment intact; an
 * inline element takes an adjacent separator instead.
 */
function removeElementEdits(text, elements, index) {
  const target = elements[index]
  const next = elements[index + 1]
  const previous = elements[index - 1]
  const lineStart = text.lastIndexOf("\n", target.start - 1) + 1
  if (/^[ \t]*$/.test(text.slice(lineStart, target.start))) {
    let end = target.end
    const afterValue = skipTriviaAt(text, end).index
    end = text[afterValue] === "," ? afterValue + 1 : end
    const lineEnd = text.indexOf("\n", end)
    if (lineEnd !== -1 && /^[ \t]*\r?$/.test(text.slice(end, lineEnd))) end = lineEnd + 1
    return [{ start: lineStart, end, replacement: "" }]
  }
  if (next !== undefined) return [{ start: target.start, end: next.start, replacement: "" }]
  if (previous !== undefined) return [{ start: previous.end, end: target.end, replacement: "" }]
  return [{ start: target.start, end: target.end, replacement: "" }]
}

function applySplices(source, splices) {
  const ordered = [...splices].sort((left, right) => right.start - left.start || right.end - left.end)
  let limit = source.length
  let output = source
  for (const splice of ordered) {
    if (splice.start < 0 || splice.end > limit || splice.start > splice.end) {
      return failResult("EDIT_CONFLICT", "overlapping or out-of-range edit span", { offset: splice.start })
    }
    output = `${output.slice(0, splice.start)}${splice.replacement}${output.slice(splice.end)}`
    limit = splice.start
  }
  return { ok: true, changed: true, text: output }
}

function spliceDocument(source, splices) {
  const applied = applySplices(source, splices)
  if (!applied.ok) return applied
  const verified = parseJsoncDocument(applied.text)
  if (!verified.ok) return failResult("EDIT_CORRUPTED", "the planned edit produced unparseable JSONC", { offset: verified.offset })
  return applied
}

function buildNested(segments, value) {
  let nested = value
  for (let index = segments.length - 1; index >= 1; index -= 1) {
    if (typeof segments[index] !== "string") return failResult("PATH_NOT_WRITABLE", "cannot create array elements")
    nested = { [segments[index]]: nested }
  }
  return { ok: true, value: nested }
}

/** Set a value at `path`, creating missing object parents. No-op when unchanged. */
export function setJsoncPath(text, path, value) {
  const source = typeof text === "string" ? text : ""
  const located = locate(source, path)
  if (!located.ok) return located
  const format = detectJsoncFormat(source)
  if (located.found) {
    if (deepEqual(located.node.value, value)) return { ok: true, changed: false, text: source }
    return spliceDocument(source, replaceValueEdits(source, located.node, value, format))
  }
  if (located.container.kind !== "object") return failResult("PATH_NOT_WRITABLE", "path parent is not an object")
  const missing = located.segments.slice(located.index)
  if (typeof missing[0] !== "string") return failResult("PATH_NOT_WRITABLE", "cannot create an array element")
  const nested = buildNested(missing, value)
  if (!nested.ok) return nested
  return spliceDocument(source, insertMemberEdits(source, located.container, missing[0], nested.value, format))
}

/** Remove the value at `path`. No-op when the path is already absent. */
export function unsetJsoncPath(text, path) {
  const source = typeof text === "string" ? text : ""
  const located = locate(source, path)
  if (!located.ok) return located
  if (!located.found) return { ok: true, changed: false, text: source }
  const siblings = located.container.kind === "object"
    ? located.container.members
    : located.container.kind === "array" ? located.container.items : null
  if (siblings === null || typeof located.sibling !== "number") return failResult("PATH_NOT_WRITABLE", "path parent is not a container")
  return spliceDocument(source, removeElementEdits(source, siblings, located.sibling))
}

/** Append `item` to the list at `path`. No-op when the item is already present. */
export function addJsoncListItem(text, path, item) {
  const source = typeof text === "string" ? text : ""
  const located = locate(source, path)
  if (!located.ok) return located
  if (!located.found) return failResult("LIST_MISSING", "list path is absent")
  if (located.node.kind !== "array") return failResult("NOT_A_LIST", "target path is not a list")
  if (located.node.value.some((entry) => deepEqual(entry, item))) return { ok: true, changed: false, text: source }
  return spliceDocument(source, insertItemEdits(source, located.node, item, detectJsoncFormat(source)))
}

/** Remove `item` from the list at `path`. No-op when the item is absent. */
export function removeJsoncListItem(text, path, item) {
  const source = typeof text === "string" ? text : ""
  const located = locate(source, path)
  if (!located.ok) return located
  if (!located.found) return failResult("LIST_MISSING", "list path is absent")
  if (located.node.kind !== "array") return failResult("NOT_A_LIST", "target path is not a list")
  const index = located.node.value.findIndex((entry) => deepEqual(entry, item))
  if (index === -1) return { ok: true, changed: false, text: source }
  return spliceDocument(source, removeElementEdits(source, located.node.items, index))
}
