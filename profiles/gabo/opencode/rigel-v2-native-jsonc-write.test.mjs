import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  addJsoncListItem,
  readJsoncValue,
  removeJsoncListItem,
  setJsoncPath,
  unsetJsoncPath,
} from "./rigel-v2-native-jsonc-edit.mjs"
import {
  detectJsoncFormat,
  parseJsoncDocument,
  serializeJsoncValue,
} from "./rigel-v2-native-jsonc-parse.mjs"
import {
  JsoncWriteError,
  applyJsoncEnvelope,
  assertSafeJsoncTarget,
  isSymlinkPath,
  readJsoncFile,
  renderJsoncDocument,
  writeTextAtomic,
} from "./rigel-v2-native-jsonc-write.mjs"

const temporary = []
afterEach(() => { while (temporary.length > 0) fs.rmSync(temporary.pop(), { recursive: true, force: true }) })

/** A real directory under the OS temp root; nothing outside it is ever touched. */
function sandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rigel-jsonc-")))
  temporary.push(root)
  return root
}

function errorCode(run) {
  try {
    run()
  } catch (error) {
    return error instanceof JsoncWriteError ? error.code : `unexpected:${String(error)}`
  }
  return "no-throw"
}

const COMMENTED_DOCUMENT = `// keep this header comment
{
  "goal": {
    "enabled": false, // the user's choice
    "max": 3,
  },
}
`

describe("jsonc parsing", () => {
  test("#given a document with comments and trailing commas #when parsed #then the values are exact and spans point at the source", () => {
    // when
    const parsed = parseJsoncDocument(COMMENTED_DOCUMENT)

    // then
    expect(parsed.ok).toBe(true)
    expect(parsed.value).toEqual({ goal: { enabled: false, max: 3 } })
    expect(COMMENTED_DOCUMENT.slice(parsed.root.start, parsed.root.end).startsWith("{")).toBe(true)
    expect(COMMENTED_DOCUMENT.slice(parsed.root.start, parsed.root.end).endsWith("}")).toBe(true)
  })

  test("#given an authored prototype key #when parsed #then the object prototype is untouched", () => {
    // when
    const parsed = parseJsoncDocument('{ "__proto__": { "polluted": true } }')

    // then
    expect(parsed.ok).toBe(true)
    expect(Object.hasOwn(parsed.value, "__proto__")).toBe(true)
    expect({}.polluted).toBeUndefined()
  })

  test("#given a malformed document #when parsed #then it fails with a parse code and an offset", () => {
    // when
    const parsed = parseJsoncDocument('{ "goal": ')

    // then
    expect(parsed.ok).toBe(false)
    expect(parsed.code).toBe("PARSE_FAILED")
    expect(typeof parsed.offset).toBe("number")
  })

  test("#given an unterminated block comment #when parsed #then it fails instead of dropping the rest of the document", () => {
    // when
    const parsed = parseJsoncDocument('{ /* "goal": { "enabled": true }')

    // then
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toContain("block comment")
  })

  test("#given trailing content after the root object #when parsed #then it fails", () => {
    // when
    const parsed = parseJsoncDocument('{ "a": 1 }\n{ "b": 2 }\n')

    // then
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toContain("trailing")
  })
})

describe("jsonc format detection", () => {
  test("#given a BOM, CRLF, and four-space indentation #when detected #then the envelope is recovered", () => {
    // when
    const format = detectJsoncFormat('\ufeff{\r\n    "a": 1\r\n}\r\n')

    // then
    expect(format).toEqual({ bom: true, eol: "\r\n", indent: "    ", finalNewline: true })
  })

  test("#given an LF document with two-space indentation #when detected #then the defaults are reported", () => {
    // when
    const format = detectJsoncFormat('{\n  "a": 1\n}\n')

    // then
    expect(format).toEqual({ bom: false, eol: "\n", indent: "  ", finalNewline: true })
  })

  test("#given a document without a final newline #when detected #then the missing newline is reported", () => {
    expect(detectJsoncFormat('{\n  "a": 1\n}').finalNewline).toBe(false)
  })
})

describe("jsonc span splicing", () => {
  test("#given a commented document #when a nested value is set #then every comment and key order survives", () => {
    // when
    const result = setJsoncPath(COMMENTED_DOCUMENT, ["goal", "enabled"], true)

    // then
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.text).toContain("// keep this header comment")
    expect(result.text).toContain('"enabled": true, // the user')
    expect(result.text).toContain('"max": 3,')
    expect(parseJsoncDocument(result.text).value).toEqual({ goal: { enabled: true, max: 3 } })
  })

  test("#given the same value #when set again #then the text is returned untouched and nothing is marked changed", () => {
    // given
    const first = setJsoncPath(COMMENTED_DOCUMENT, ["goal", "enabled"], true)

    // when
    const second = setJsoncPath(first.text, ["goal", "enabled"], true)

    // then
    expect(second.changed).toBe(false)
    expect(second.text).toBe(first.text)
  })

  test("#given a missing nested key #when set #then the parents are created without touching sibling comments", () => {
    // when
    const result = setJsoncPath(COMMENTED_DOCUMENT, ["goal", "auto_start"], false)

    // then
    expect(result.changed).toBe(true)
    expect(result.text).toContain("// keep this header comment")
    expect(parseJsoncDocument(result.text).value).toEqual({ goal: { enabled: false, max: 3, auto_start: false } })
  })

  test("#given a missing deep path #when set #then the intermediate objects are created", () => {
    // when
    const result = setJsoncPath('{\n}\n', ["profiles", "gabo", "[opencode]", "goal", "enabled"], true)

    // then
    expect(result.changed).toBe(true)
    expect(parseJsoncDocument(result.text).value).toEqual({ profiles: { gabo: { "[opencode]": { goal: { enabled: true } } } } })
  })

  test("#given an existing member #when unset #then only that member and its separator are removed", () => {
    // when
    const result = unsetJsoncPath(COMMENTED_DOCUMENT, ["goal", "max"])

    // then
    expect(result.changed).toBe(true)
    expect(result.text).toContain("// the user's choice")
    expect(parseJsoncDocument(result.text).value).toEqual({ goal: { enabled: false } })
  })

  test("#given an absent member #when unset #then nothing changes", () => {
    // when
    const result = unsetJsoncPath(COMMENTED_DOCUMENT, ["goal", "missing"])

    // then
    expect(result.changed).toBe(false)
    expect(result.text).toBe(COMMENTED_DOCUMENT)
  })

  test("#given an inline list #when an item is added #then the list stays inline and the comments survive", () => {
    // given
    const source = '{\n  // agents to skip\n  "disabled_agents": ["forja"],\n}\n'

    // when
    const result = addJsoncListItem(source, ["disabled_agents"], "prometheus")

    // then
    expect(result.text).toContain("// agents to skip")
    expect(result.text).toContain('["forja", "prometheus"]')
    expect(readJsoncValue(result.text, ["disabled_agents"]).value).toEqual(["forja", "prometheus"])
  })

  test("#given an inline list the author closed with a trailing separator #when an item is added #then the separator is re-emitted instead of two values sharing none", () => {
    // given
    const source = '{\n  // agents to skip\n  "disabled_agents": ["forja",],\n}\n'

    // when
    const result = addJsoncListItem(source, ["disabled_agents"], "prometheus")

    // then
    expect(result.ok).toBe(true)
    expect(result.text).toContain("// agents to skip")
    expect(result.text).toContain('["forja", "prometheus",]')
    expect(readJsoncValue(result.text, ["disabled_agents"]).value).toEqual(["forja", "prometheus"])
  })

  test("#given an inline list whose trailing separator carries a block comment #when an item is added #then the comment survives and the list still parses", () => {
    // given
    const source = '{ "disabled_agents": ["forja", /* keep */] }'

    // when
    const result = addJsoncListItem(source, ["disabled_agents"], "prometheus")

    // then
    expect(result.ok).toBe(true)
    expect(result.text).toContain("/* keep */")
    expect(readJsoncValue(result.text, ["disabled_agents"]).value).toEqual(["forja", "prometheus"])
  })

  test("#given a document without the list #when an item is added #then the list is initialized instead of refused", () => {
    // given
    const source = '{\n  // profile notes\n  "profiles": {\n    "gabo": {}\n  }\n}\n'

    // when
    const result = addJsoncListItem(source, ["profiles", "gabo", "[opencode]", "disabled_agents"], "forja")

    // then
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.text).toContain("// profile notes")
    expect(readJsoncValue(result.text, ["profiles", "gabo", "[opencode]", "disabled_agents"]).value).toEqual(["forja"])
  })

  test("#given a list this planner just created #when the same item is added again #then nothing changes", () => {
    // given
    const first = addJsoncListItem('{\n}\n', ["disabled_agents"], "forja")

    // when
    const second = addJsoncListItem(first.text, ["disabled_agents"], "forja")

    // then
    expect(second.ok).toBe(true)
    expect(second.changed).toBe(false)
    expect(second.text).toBe(first.text)
  })

  test("#given an absent element of a list #when an item is added there #then the path is refused as unwritable", () => {
    // when
    const result = addJsoncListItem('{ "list": ["a"] }', ["list", 4], "forja")

    // then
    expect(result.ok).toBe(false)
    expect(result.code).toBe("PATH_NOT_WRITABLE")
  })

  test("#given an inline object the author closed with a trailing separator #when a member is added #then the separator is re-emitted and the document still parses", () => {
    // given
    const source = '{ "goal": { "enabled": false, }, }\n'

    // when
    const result = setJsoncPath(source, ["goal", "max"], 3)

    // then
    expect(result.ok).toBe(true)
    expect(result.text).toContain('"enabled": false, "max": 3,')
    expect(readJsoncValue(result.text, ["goal"]).value).toEqual({ enabled: false, max: 3 })
  })

  test("#given an item already present #when added again #then the list is untouched", () => {
    // given
    const source = '{\n  "disabled_agents": ["forja"],\n}\n'

    // when
    const result = addJsoncListItem(source, ["disabled_agents"], "forja")

    // then
    expect(result.changed).toBe(false)
    expect(result.text).toBe(source)
  })

  test("#given an absent item #when removed #then the result is the remaining list", () => {
    // given
    const source = '{\n  "disabled_agents": ["forja", "prometheus"],\n}\n'

    // when
    const removed = removeJsoncListItem(source, ["disabled_agents"], "forja")
    const absent = removeJsoncListItem(source, ["disabled_agents"], "oracle")

    // then
    expect(readJsoncValue(removed.text, ["disabled_agents"]).value).toEqual(["prometheus"])
    expect(absent.changed).toBe(false)
    expect(absent.text).toBe(source)
  })

  test("#given a sole inline list item with a trailing separator #when removed #then the empty list remains valid JSONC", () => {
    const source = '{ "disabled_agents": ["forja",] }'
    const result = removeJsoncListItem(source, ["disabled_agents"], "forja")
    expect(result.ok).toBe(true)
    expect(readJsoncValue(result.text, ["disabled_agents"]).value).toEqual([])
  })

  test("#given a sole inline object member with a trailing separator #when unset #then the empty object remains valid JSONC", () => {
    const source = '{ "goal": { "enabled": false, }, }'
    const result = unsetJsoncPath(source, ["goal", "enabled"])
    expect(result.ok).toBe(true)
    expect(readJsoncValue(result.text, ["goal"]).value).toEqual({})
  })

  test("#given a CRLF document #when a member is inserted #then the inserted separator is CRLF too", () => {
    // given
    const source = '{\r\n  "goal": {\r\n    "enabled": true\r\n  }\r\n}\r\n'

    // when
    const result = setJsoncPath(source, ["goal", "auto_start"], false)

    // then
    expect(result.text).toContain('"enabled": true,\r\n')
    expect(result.text.split("\n").every((line, index, lines) => index === lines.length - 1 || line.endsWith("\r"))).toBe(true)
  })

  test("#given a BOM document #when a value is set #then the byte-order mark is still first", () => {
    // given
    const source = '\ufeff{\n  "goal": { "enabled": false }\n}\n'

    // when
    const result = setJsoncPath(source, ["goal", "enabled"], true)

    // then
    expect(result.text.charCodeAt(0)).toBe(0xfeff)
    expect(parseJsoncDocument(result.text).value.goal.enabled).toBe(true)
  })

  test("#given a list target that is not a list #when an item is added #then it reports NOT_A_LIST", () => {
    // when
    const result = addJsoncListItem('{ "disabled_agents": true }', ["disabled_agents"], "forja")

    // then
    expect(result.ok).toBe(false)
    expect(result.code).toBe("NOT_A_LIST")
  })

  test("#given a non-object root #when parsed #then the document is refused", () => {
    expect(parseJsoncDocument("[1, 2]").ok).toBe(false)
  })

  test("#given a long value #when rendered multiline #then the requested indent is used", () => {
    // when
    const rendered = serializeJsoncValue({ a: 1 }, { indent: "    ", eol: "\r\n" })

    // then
    expect(rendered).toBe('{\r\n    "a": 1\r\n}')
  })
})

describe("jsonc file system boundary", () => {
  test("#given a missing file #when read #then it reports absence instead of throwing", () => {
    // given
    const root = sandbox()

    // when
    const read = readJsoncFile({ fileSystem: fs, filePath: path.join(root, "absent.jsonc") })

    // then
    expect(read).toMatchObject({ ok: true, exists: false, value: {} })
  })

  test("#given a malformed file #when read #then it reports the parse failure with a reason", () => {
    // given
    const root = sandbox()
    const file = path.join(root, "omo.jsonc")
    fs.writeFileSync(file, '{ "goal": ')

    // when
    const read = readJsoncFile({ fileSystem: fs, filePath: file })

    // then
    expect(read.ok).toBe(false)
    expect(read.reason.length).toBeGreaterThan(0)
  })

  test("#given a BOM file #when read #then the BOM is detected and the value is parsed", () => {
    // given
    const root = sandbox()
    const file = path.join(root, "omo.jsonc")
    fs.writeFileSync(file, '\ufeff{ "goal": { "enabled": true } }\n')

    // when
    const read = readJsoncFile({ fileSystem: fs, filePath: file })

    // then
    expect(read.format.bom).toBe(true)
    expect(read.value).toEqual({ goal: { enabled: true } })
  })

  test("#given a symlinked target #when asserted #then the write is refused with SYMLINK_TARGET", () => {
    // given
    const root = sandbox()
    const real = path.join(root, "real.jsonc")
    fs.writeFileSync(real, "{}\n")
    const link = path.join(root, "omo.jsonc")
    fs.symlinkSync(real, link)

    // when
    const code = errorCode(() => assertSafeJsoncTarget({ fileSystem: fs, filePath: link }))

    // then
    expect(code).toBe("JSONC_SYMLINK_TARGET")
  })

  test("#given a symlinked parent directory #when asserted #then the write is refused with SYMLINK_DIRECTORY", () => {
    // given
    const root = sandbox()
    const realDir = path.join(root, "real-omo")
    fs.mkdirSync(realDir)
    const linkDir = path.join(root, ".omo")
    fs.symlinkSync(realDir, linkDir)

    // when
    const code = errorCode(() => assertSafeJsoncTarget({ fileSystem: fs, filePath: path.join(linkDir, "omo.jsonc") }))

    // then
    expect(code).toBe("JSONC_SYMLINK_DIRECTORY")
  })

  test("#given a regular missing target #when asserted #then the path is returned", () => {
    // given
    const root = sandbox()

    // when
    const safe = assertSafeJsoncTarget({ fileSystem: fs, filePath: path.join(root, ".omo", "omo.jsonc") })

    // then
    expect(safe).toBe(path.join(root, ".omo", "omo.jsonc"))
    expect(isSymlinkPath(path.join(root, ".omo"), fs)).toBe(false)
  })

  test("#given a target #when written atomically #then the bytes land at mode 0600 and no temp file survives", () => {
    // given
    const root = sandbox()
    const file = path.join(root, "nested", "omo.jsonc")

    // when
    writeTextAtomic({ fileSystem: fs, filePath: file, text: '{\n}\n' })

    // then
    expect(fs.readFileSync(file, "utf8")).toBe('{\n}\n')
    // POSIX mode bits are not represented on Windows; the writer still requests 0600.
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(path.dirname(file))).toEqual(["omo.jsonc"])
  })

  test("#given a rename failure #when written atomically #then the target is unchanged and the temp file is removed", () => {
    // given
    const root = sandbox()
    const file = path.join(root, "omo.jsonc")
    fs.writeFileSync(file, "original")
    const failing = {
      existsSync: fs.existsSync,
      lstatSync: fs.lstatSync,
      readFileSync: fs.readFileSync,
      mkdirSync: fs.mkdirSync,
      openSync: fs.openSync,
      writeFileSync: fs.writeFileSync,
      fsyncSync: fs.fsyncSync,
      closeSync: fs.closeSync,
      rmSync: fs.rmSync,
      renameSync: () => { throw new Error("rename failed") },
    }

    // when
    let code = "no-throw"
    try {
      writeTextAtomic({ fileSystem: failing, filePath: file, text: "next" })
    } catch (error) {
      code = error instanceof JsoncWriteError ? error.code : `unexpected:${String(error)}`
    }

    // then
    expect(code).toBe("JSONC_WRITE_FAILED")
    expect(fs.readFileSync(file, "utf8")).toBe("original")
    expect(fs.readdirSync(root).filter((entry) => entry.includes(".tmp-"))).toEqual([])
  })

  test("#given a detected BOM #when the envelope is applied #then the marker is restored exactly once", () => {
    const once = applyJsoncEnvelope('{\n}\n', { bom: true })
    expect(once.charCodeAt(0)).toBe(0xfeff)
    expect(applyJsoncEnvelope(once, { bom: true })).toBe(once)
    expect(applyJsoncEnvelope(once, { bom: false })).toBe('{\n}\n')
  })

  test("#given a format #when a new document is rendered #then the envelope matches the request", () => {
    expect(renderJsoncDocument({ value: { a: 1 }, format: { bom: true, eol: "\r\n", indent: "    ", finalNewline: true } }))
      .toBe('\ufeff{\r\n    "a": 1\r\n}\r\n')
  })
})
