import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

// The `/rigel_setting` surface is a settings EDITOR. A settings read happens at
// plugin-init, so the honest contract is: preview, write through the one writer,
// and hand the reload commands to the user. Any process or service control in
// these modules would be a lifecycle action nobody asked for, and it would run
// against whatever server happens to be up instead of the sandbox this repository
// insists on. These scans guard that architecture contract: the modules own the
// reload STRINGS, never a call that performs one.
const MODULE_DIR = import.meta.dir
const MODULES = Object.freeze([
  "rigel-v2-native-setting-command.mjs",
  "rigel-v2-native-setting-command.mjs",
  "rigel-v2-native-setting-tool.mjs",
  "rigel-v2-native-setting-actions.mjs",
  "rigel-v2-native-setting-descriptor.mjs",
])

const FORBIDDEN_PATTERNS = Object.freeze([
  { label: "process.kill", pattern: /\bprocess\.kill\b/ },
  { label: "process.exit", pattern: /\bprocess\.exit\b/ },
  { label: "child_process", pattern: /\bchild_process\b/ },
  { label: "spawn", pattern: /\bspawn(?:Sync)?\s*\(/ },
  { label: "exec", pattern: /\bexec(?:Sync|File)?\s*\(/ },
  { label: "fork", pattern: /\bfork\s*\(/ },
  { label: "systemctl", pattern: /\bsystemctl\b/ },
  { label: "lifecycle call", pattern: /\b(?:restart|stop|shutdown|terminate|abort|reset|kill|reload)\s*\(/i },
])

function sourceOf(moduleName) {
  return fs.readFileSync(path.join(MODULE_DIR, moduleName), "utf8")
}

describe("#given the rigel_setting modules", () => {
  test("#when each module source is scanned #then no process, child-process or lifecycle call shape is present", () => {
    const findings = []
    for (const moduleName of MODULES) {
      const source = sourceOf(moduleName)
      for (const { label, pattern } of FORBIDDEN_PATTERNS) {
        if (pattern.test(source)) findings.push(`${moduleName}: ${label}`)
      }
    }

    expect(findings).toEqual([])
  })

  test("#when the command source is scanned #then it delegates no write and performs none itself", () => {
    const source = sourceOf("rigel-v2-native-setting-command.mjs")
    const directWrites = [
      "writeFileSync",
      "writeTextAtomic",
      "writeJsoncTextAtomic",
      "applySettingEdit",
      "previewSettingEdit",
      "setJsoncPath",
      "unsetJsoncPath",
      "addJsoncListItem",
      "removeJsoncListItem",
    ]

    expect(directWrites.filter((name) => source.includes(name))).toEqual([])
  })

  test("#when the tool and action sources are scanned #then every write goes through the writer module", () => {
    const writerImport = 'from "./rigel-v2-native-setting-write.mjs"'
    const actions = sourceOf("rigel-v2-native-setting-actions.mjs")
    const tool = sourceOf("rigel-v2-native-setting-tool.mjs")
    const command = sourceOf("rigel-v2-native-setting-command.mjs")

    expect(actions).toContain(writerImport)
    expect(actions).toContain("applySettingEdit(")
    expect(actions).toContain("previewSettingEdit(")
    expect(command).toContain(writerImport)
    for (const source of [actions, tool, command]) {
      expect(source.includes("writeFileSync")).toBe(false)
      expect(source.includes("writeJsoncTextAtomic")).toBe(false)
      expect(source.includes("setJsoncPath")).toBe(false)
      expect(source.includes("writeTextAtomic")).toBe(false)
    }
  })
})
