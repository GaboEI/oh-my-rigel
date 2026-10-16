import { describe, expect, test } from "bun:test"
import {
  afterRules,
  beforeRules,
  createFlowRules,
  eventHandlers,
  requestSteps,
} from "./rigel-v2-native-flow-rules.mjs"

describe("#given the frozen flow-rule registry", () => {
  test("#then the before, after, and request chains keep their declared order", () => {
    // given / when / then
    expect(beforeRules.map((rule) => rule.name)).toEqual([
      "notepad-write-guard",
      "question-label-truncator",
      "sisyphus-junior-notepad",
      "bash-file-read-guard",
    ])
    expect(afterRules.map((rule) => rule.name)).toEqual([
      "delegate-task-retry",
      "empty-task-response-detector",
      "tool-output-truncator",
    ])
    expect(requestSteps.map((step) => step.name)).toEqual(["image-resizer"])
    expect(Object.isFrozen(beforeRules)).toBe(true)
    expect(Object.isFrozen(afterRules)).toBe(true)
    expect(Object.isFrozen(requestSteps)).toBe(true)
    expect(Object.isFrozen(eventHandlers)).toBe(true)
    expect(eventHandlers).toHaveLength(0)
  })
})

describe("#given a factory-built flow set", () => {
  test("#when the builder runs #then it mirrors the frozen registry's declared order and is itself frozen", () => {
    // given / when
    const built = createFlowRules()
    // then
    expect(built.beforeRules.map((rule) => rule.name)).toEqual(beforeRules.map((rule) => rule.name))
    expect(built.afterRules.map((rule) => rule.name)).toEqual(afterRules.map((rule) => rule.name))
    expect(Object.isFrozen(built)).toBe(true)
  })
})
