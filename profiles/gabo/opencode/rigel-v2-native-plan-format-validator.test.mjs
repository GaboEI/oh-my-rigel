import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  createNativePlanFormatValidator,
  effortBandForDuration,
  getPlanProgress,
  isStructuredTaskRow,
  normalizePlanEffort,
  PLAN_EFFORT_BANDS,
} from "./rigel-v2-native-plan-format-validator.mjs"
import {
  getPlanProgress as v1GetPlanProgress,
  isStructuredTaskRow as v1IsStructuredTaskRow,
} from "../../../packages/boulder-state/src/index.ts"

const temporary = []
afterEach(() => {
  while (temporary.length > 0) fs.rmSync(temporary.pop(), { recursive: true, force: true })
})

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-v2-plan-format-"))
  temporary.push(root)
  fs.mkdirSync(path.join(root, ".omo", "plans"), { recursive: true })
  return root
}

function writePlan(root, name, content) {
  const file = path.join(root, ".omo", "plans", name)
  fs.writeFileSync(file, content, "utf-8")
  return file
}

function writeEvent(filePath, result) {
  return { tool: "write", input: { filePath }, result: typeof result === "string" ? { content: result } : result }
}

const VALID_PLAN = [
  "**Effort:** Medium",
  "",
  "## TODOs",
  "- [ ] 1. First task",
  "- [x] 2. Second task",
  "",
  "## Final Verification Wave",
  "- [ ] F1. Verify it",
].join("\n")

const MALFORMED_PLAN = ["## TODOs", "- [ ] Phase 1: do x", "- [ ] Task-1. do y"].join("\n")

const CORPUS = [
  { name: "valid", markdown: VALID_PLAN },
  { name: "malformed", markdown: MALFORMED_PLAN },
  { name: "final-wave", markdown: ["## Final Verification Wave", "- [ ] F1. good", "- [ ] T-F1. bad", "- [x] H2. done"].join("\n") },
  { name: "fenced", markdown: ["## TODOs", "- [ ] 1. real", "```md", "- [ ] 2. fenced", "```", "- [ ] 3. after"].join("\n") },
  { name: "empty-section", markdown: ["## TODOs", "Only prose in this section.", "## Final Verification Wave"].join("\n") },
  { name: "simple-mode", markdown: ["# Plan", "- [ ] alpha", "- [x] beta"].join("\n") },
]

const STRUCTURED_LINES = ["1. Task", "Phase 1: do x", "T1.2a. nested", "F1. Verify", "T-F1. nope", "H2. ok", "- [ ] 1. wrapped"]

describe("pure effort helpers", () => {
  test("exposes the five bands", () => {
    // given the ported band constants
    // when read
    // then they match the V1 template order
    expect(PLAN_EFFORT_BANDS).toEqual(["Quick", "Short", "Medium", "Large", "XL"])
  })

  test("maps durations to bounding bands", () => {
    // given duration strings
    // when each is converted
    // then it lands in the V1 band
    expect(effortBandForDuration("200 hours")).toBe("XL")
    expect(effortBandForDuration("2 days")).toBe("Medium")
    expect(effortBandForDuration("3 days")).toBe("Large")
    expect(effortBandForDuration("2-3 weeks")).toBe("XL")
    expect(effortBandForDuration("Medium")).toBeNull()
  })

  test("normalizes only duration efforts", () => {
    // given a duration effort and a band effort
    // when normalized
    // then only the duration is rewritten
    expect(normalizePlanEffort("**Effort:** 200 hours\nbody").content).toContain("**Effort:** XL")
    expect(normalizePlanEffort("**Effort:** Medium\nbody")).toBeNull()
  })
})

describe("Rigel native V2 plan-format validator", () => {
  test("leaves a band effort and a valid plan untouched", async () => {
    // given a valid plan with a band effort
    const root = scratch()
    const file = writePlan(root, "valid.md", VALID_PLAN)
    const validator = createNativePlanFormatValidator({ directory: root })
    const result = { content: "Edited plan." }
    // when a write result is processed
    await validator.after(writeEvent(".omo/plans/valid.md", result))
    // then nothing is rewritten and no warning is appended
    expect(fs.readFileSync(file, "utf-8")).toBe(VALID_PLAN)
    expect(result.content).toBe("Edited plan.")
  })

  test("rewrites a duration effort to XL and appends a warning", async () => {
    // given a plan whose effort is a wall-clock duration
    const root = scratch()
    const content = VALID_PLAN.replace("**Effort:** Medium", "**Effort:** 200 hours")
    const file = writePlan(root, "duration.md", content)
    const validator = createNativePlanFormatValidator({ directory: root })
    const result = { content: "ack" }
    // when the write result is processed
    await validator.after(writeEvent(".omo/plans/duration.md", result))
    // then the file was rewritten and the result carries the warning
    const written = fs.readFileSync(file, "utf-8")
    expect(written).toContain("**Effort:** XL")
    expect(written).not.toContain("200 hours")
    expect(result.content).toContain("<plan-format-warning>")
  })

  test("warns when malformed rows under ## TODOs would be skipped", async () => {
    // given a plan with only malformed task rows
    const root = scratch()
    writePlan(root, "malformed.md", MALFORMED_PLAN)
    const validator = createNativePlanFormatValidator({ directory: root })
    const result = { content: "" }
    // when the write result is processed
    await validator.after(writeEvent(".omo/plans/malformed.md", result))
    // then a warning explains the empty parsed section
    expect(result.content).toContain("<plan-format-warning>")
    expect(result.content).toContain("no valid task rows")
  })

  test("ignores a write to a non-plan path", async () => {
    // given a non-plan source file
    const root = scratch()
    fs.mkdirSync(path.join(root, "src"), { recursive: true })
    fs.writeFileSync(path.join(root, "src", "foo.ts"), "x")
    const validator = createNativePlanFormatValidator({ directory: root })
    const result = { content: "unchanged" }
    // when its write result is processed
    await validator.after(writeEvent("src/foo.ts", result))
    // then nothing changes
    expect(result.content).toBe("unchanged")
    expect(fs.readFileSync(path.join(root, "src", "foo.ts"), "utf-8")).toBe("x")
  })

  test("appends to array text parts and skips an existing warning", async () => {
    // given a malformed plan and an array-shaped result
    const root = scratch()
    writePlan(root, "array.md", MALFORMED_PLAN)
    const validator = createNativePlanFormatValidator({ directory: root })
    const parts = { content: [{ type: "text", text: "Tool output." }] }
    // when processed
    await validator.after({ tool: "edit", input: { filePath: ".omo/plans/array.md" }, result: parts })
    // then a warning text part is appended
    expect(parts.content).toHaveLength(2)
    expect(parts.content[1].text).toContain("<plan-format-warning>")
    // when a result already carrying a warning is processed
    const again = { content: [{ type: "text", text: "<plan-format-warning> already" }] }
    await validator.after({ tool: "edit", input: { filePath: ".omo/plans/array.md" }, result: again })
    // then no second warning is appended
    expect(again.content).toHaveLength(1)
  })

  test("reads and annotates the real event.output channel", async () => {
    // given a malformed plan and the live after-event shape: a plain event.output string
    const root = scratch()
    writePlan(root, "output.md", MALFORMED_PLAN)
    const validator = createNativePlanFormatValidator({ directory: root })
    const event = { tool: "write", input: { filePath: ".omo/plans/output.md" }, output: "Wrote file successfully." }
    // when the write result is processed
    await validator.after(event)
    // then the warning is appended onto event.output
    expect(event.output).toContain("<plan-format-warning>")
  })

  test("normalizes a duration effort on the real event.output channel", async () => {
    // given a plan whose effort is a duration, read through event.output
    const root = scratch()
    const content = VALID_PLAN.replace("**Effort:** Medium", "**Effort:** 200 hours")
    const file = writePlan(root, "output-duration.md", content)
    const validator = createNativePlanFormatValidator({ directory: root })
    const event = { tool: "write", input: { filePath: ".omo/plans/output-duration.md" }, output: "saved" }
    // when processed
    await validator.after(event)
    // then the file was rewritten and the warning landed on event.output
    expect(fs.readFileSync(file, "utf-8")).toContain("**Effort:** XL")
    expect(event.output).toContain("<plan-format-warning>")
  })

  test("is a no-op when no result channel carries text", async () => {
    // given a malformed plan but an event with no output/result channel at all
    const root = scratch()
    writePlan(root, "nochannel.md", MALFORMED_PLAN)
    const validator = createNativePlanFormatValidator({ directory: root })
    const event = { tool: "write", input: { filePath: ".omo/plans/nochannel.md" } }
    // when processed
    await validator.after(event)
    // then nothing is annotated
    expect(event.output).toBeUndefined()
    expect(event.result).toBeUndefined()
  })

  test("ignores tools other than write/edit", async () => {
    // given a read tool event on a plan
    const root = scratch()
    writePlan(root, "read.md", MALFORMED_PLAN)
    const validator = createNativePlanFormatValidator({ directory: root })
    const result = { content: "x" }
    // when the event is processed
    await validator.after({ tool: "read", input: { filePath: ".omo/plans/read.md" }, result })
    // then the result is untouched
    expect(result.content).toBe("x")
  })
})

describe("parity with the V1 boulder-state parser", () => {
  test("getPlanProgress deep-equals V1 over the corpus", () => {
    // given the same corpus written to disk
    const root = scratch()
    const files = CORPUS.map(({ name, markdown }) => writePlan(root, `${name}.md`, markdown))
    // when local and V1 progress are read
    // then every entry matches, and the valid anchor is non-vacuous
    for (const file of files) {
      expect(getPlanProgress(file)).toEqual(v1GetPlanProgress(file))
    }
    expect(v1GetPlanProgress(files[0])).toEqual({ total: 3, completed: 1, isComplete: false })
  })

  test("isStructuredTaskRow matches V1 over structured lines", () => {
    // given a set of candidate rows
    // when both implementations classify each row in each section
    // then the decisions are identical
    for (const line of STRUCTURED_LINES) {
      for (const section of ["todo", "final-wave"]) {
        expect(isStructuredTaskRow(line, section)).toBe(v1IsStructuredTaskRow(line, section))
      }
    }
  })
})
