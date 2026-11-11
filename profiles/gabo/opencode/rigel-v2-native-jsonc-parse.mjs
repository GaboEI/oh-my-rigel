/**
 * Dependency-free JSONC parsing, formatting detection, and value rendering.
 *
 * The deployed runtime is staged as a FLAT directory whose only third-party
 * dependency is `htmlparser2`, so the settings writer cannot reuse
 * `jsonc-parser` the way `packages/omo-config-core` does. This module is the
 * replacement scanner: it understands both comment styles and trailing commas,
 * and it produces a node tree that carries SOURCE SPANS, which is what lets the
 * edit layer rewrite one value without re-serializing the document.
 *
 * Nothing here touches the file system, throws, or returns a partial document.
 */
const BOM = "\ufeff"
const LITERALS = Object.freeze([["true", true], ["false", false], ["null", null]])
const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/

/** Formatting defaults used when a document does not exist yet. */
export const DEFAULT_JSONC_FORMAT = Object.freeze({ bom: false, eol: "\n", indent: "  ", finalNewline: true })

/** The document a writer starts from when the target file does not exist. */
export const EMPTY_JSONC_DOCUMENT = "{\n}\n"

/** The failure shape every planner returns instead of throwing. */
export function failResult(code, reason, extra = {}) {
  return { ok: false, changed: false, code, reason, ...extra }
}

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.prototype.toString.call(value) === "[object Object]"
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "undefined"
}

/** Structural equality that ignores key order. */
export function deepEqual(left, right) {
  return stableStringify(left) === stableStringify(right)
}

class JsoncScanError extends Error {
  constructor(offset, reason) {
    super(reason)
    this.name = "JsoncScanError"
    this.offset = offset
    this.reason = reason
  }
}

/**
 * Skip whitespace, a leading BOM, and both comment styles.
 * Returns the next significant offset and, for an unterminated block comment,
 * the offset where it started so the parser can report the exact position.
 */
export function skipTriviaAt(text, index) {
  let cursor = index
  let unterminated = -1
  while (cursor < text.length) {
    const char = text[cursor]
    if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === BOM) {
      cursor += 1
      continue
    }
    if (char === "/" && text[cursor + 1] === "/") {
      cursor += 2
      while (cursor < text.length && text[cursor] !== "\n") cursor += 1
      continue
    }
    if (char === "/" && text[cursor + 1] === "*") {
      const end = text.indexOf("*/", cursor + 2)
      if (end === -1) {
        unterminated = cursor
        cursor = text.length
        break
      }
      cursor = end + 2
      continue
    }
    break
  }
  return { index: cursor, unterminated }
}

class JsoncScanner {
  constructor(text) {
    this.text = text
    this.length = text.length
  }

  raise(offset, reason) {
    throw new JsoncScanError(offset, reason)
  }

  skipTrivia(index) {
    const skipped = skipTriviaAt(this.text, index)
    if (skipped.unterminated !== -1) this.raise(skipped.unterminated, "unterminated block comment")
    return skipped.index
  }

  readString(index) {
    const text = this.text
    let cursor = index + 1
    while (cursor < this.length) {
      const char = text[cursor]
      if (char === "\\") { cursor += 2; continue }
      if (char === '"') {
        const raw = text.slice(index, cursor + 1)
        let value
        try { value = JSON.parse(raw) } catch { this.raise(index, "invalid string literal") }
        return { end: cursor + 1, value }
      }
      if (char === "\n") break
      cursor += 1
    }
    return this.raise(index, "unterminated string literal")
  }

  readValue(index) {
    const start = this.skipTrivia(index)
    if (start >= this.length) this.raise(start, "unexpected end of input")
    const char = this.text[start]
    if (char === "{") return this.readObject(start)
    if (char === "[") return this.readArray(start)
    if (char === '"') {
      const string = this.readString(start)
      return { node: { kind: "scalar", start, end: string.end, value: string.value }, next: string.end }
    }
    for (const [literal, value] of LITERALS) {
      if (this.text.startsWith(literal, start)) {
        return { node: { kind: "scalar", start, end: start + literal.length, value }, next: start + literal.length }
      }
    }
    const number = NUMBER_PATTERN.exec(this.text.slice(start, start + 64))
    if (number !== null) {
      return { node: { kind: "scalar", start, end: start + number[0].length, value: Number(number[0]) }, next: start + number[0].length }
    }
    return this.raise(start, "unexpected token")
  }

  readObject(start) {
    const members = []
    const value = {}
    let cursor = start + 1
    for (;;) {
      cursor = this.skipTrivia(cursor)
      if (cursor >= this.length) this.raise(cursor, "unterminated object")
      if (this.text[cursor] === "}") return { node: { kind: "object", start, end: cursor + 1, members, value }, next: cursor + 1 }
      if (this.text[cursor] !== '"') this.raise(cursor, "expected an object key")
      const keyStart = cursor
      const key = this.readString(keyStart)
      const separator = this.skipTrivia(key.end)
      if (this.text[separator] !== ":") this.raise(separator, 'expected ":"')
      const member = this.readValue(separator + 1)
      members.push({ key: key.value, start: keyStart, end: member.node.end, value: member.node })
      defineValue(value, key.value, member.node.value)
      cursor = this.skipTrivia(member.next)
      if (this.text[cursor] === ",") { cursor += 1; continue }
      if (this.text[cursor] === "}") return { node: { kind: "object", start, end: cursor + 1, members, value }, next: cursor + 1 }
      this.raise(cursor, 'expected "," or "}"')
    }
  }

  readArray(start) {
    const items = []
    const value = []
    let cursor = start + 1
    for (;;) {
      cursor = this.skipTrivia(cursor)
      if (cursor >= this.length) this.raise(cursor, "unterminated array")
      if (this.text[cursor] === "]") return { node: { kind: "array", start, end: cursor + 1, items, value }, next: cursor + 1 }
      const item = this.readValue(cursor)
      items.push(item.node)
      value.push(item.node.value)
      cursor = this.skipTrivia(item.next)
      if (this.text[cursor] === ",") { cursor += 1; continue }
      if (this.text[cursor] === "]") return { node: { kind: "array", start, end: cursor + 1, items, value }, next: cursor + 1 }
      this.raise(cursor, 'expected "," or "]"')
    }
  }
}

function defineValue(target, key, value) {
  // defineProperty keeps an authored `__proto__` key inert instead of retargeting
  // the prototype of the object the settings layer is built on.
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true })
}

/**
 * Parse a JSONC document into a span-carrying node tree.
 * Returns `{ ok: true, root, value }` or a failure with `code`, `reason`, `offset`.
 */
export function parseJsoncDocument(text) {
  const source = typeof text === "string" ? text : ""
  const scanner = new JsoncScanner(source)
  try {
    const root = scanner.readValue(0)
    const trailing = scanner.skipTrivia(root.next)
    if (trailing !== source.length) return failResult("PARSE_FAILED", "unexpected trailing content", { offset: trailing })
    if (root.node.kind !== "object") return failResult("PARSE_FAILED", "document root must be an object", { offset: root.node.start })
    return { ok: true, root: root.node, value: root.node.value, offset: 0 }
  } catch (error) {
    if (error instanceof JsoncScanError) return failResult("PARSE_FAILED", error.reason, { offset: error.offset })
    throw error
  }
}

/** Detect the authored envelope so a rewrite can keep the author's bytes. */
export function detectJsoncFormat(text) {
  const source = typeof text === "string" ? text : ""
  const bom = source.charCodeAt(0) === 0xfeff
  const body = bom ? source.slice(1) : source
  const crlf = (body.match(/\r\n/g) ?? []).length
  const lf = (body.match(/\n/g) ?? []).length - crlf
  const indentMatch = /^([ \t]+)\S/m.exec(body)
  return {
    bom,
    eol: crlf > lf ? "\r\n" : "\n",
    indent: indentMatch?.[1] ?? DEFAULT_JSONC_FORMAT.indent,
    finalNewline: /[\r\n]$/.test(body) || body === "",
  }
}

function writeInline(value) {
  if (Array.isArray(value)) return `[${value.map(writeInline).join(", ")}]`
  if (isPlainObject(value)) {
    const entries = Object.keys(value).map((key) => `${JSON.stringify(key)}: ${writeInline(value[key])}`)
    return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`
  }
  return JSON.stringify(value) ?? "null"
}

/** Render a value for insertion; `inline` keeps a single-line container single-line. */
export function serializeJsoncValue(value, options = {}) {
  const indent = typeof options.indent === "string" && options.indent !== "" ? options.indent : DEFAULT_JSONC_FORMAT.indent
  const eol = options.eol === "\r\n" ? "\r\n" : "\n"
  if (options.inline === true) return writeInline(value)
  const body = JSON.stringify(value, null, indent)
  // `JSON.stringify(undefined)` is not a string; render the JSON literal instead
  // of letting a TypeError escape the planner.
  return typeof body === "string" ? body.split("\n").join(eol) : "null"
}

/** Render a whole new document (used only when the target file does not exist). */
export function serializeJsoncDocument({ value, format } = {}) {
  const envelope = { ...DEFAULT_JSONC_FORMAT, ...(isPlainObject(format) ? format : {}) }
  const body = serializeJsoncValue(value, { indent: envelope.indent, eol: envelope.eol })
  return `${envelope.bom ? BOM : ""}${body}${envelope.finalNewline ? envelope.eol : ""}`
}
