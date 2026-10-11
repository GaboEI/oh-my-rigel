/**
 * Owner tests for the V1-faithful sidebar materializer.
 *
 * Fidelity source: `packages/omo-opencode/src/tui.ts:49-70` (`materialize` /
 * `materializeNode`) and `.../features/tui-sidebar/render-view.ts:25`
 * (`buildViewNodes`). The V1 flow is `buildViewNodes -> ViewNode[] -> materialize`
 * over the `@opentui/solid` runtime; the V2 port must produce the same element
 * tree. A stub `SolidRuntime` records the tree so every view is asserted.
 */
import { describe, expect, test } from "bun:test"

import { buildViewNodes } from "./rigel-v2-sidebar-core.mjs"
import { materialize, materializeNode, nodeText } from "./rigel-v2-sidebar-node.mjs"

const stubSolid = {
  createElement: (tag) => ({ tag, props: {}, children: [] }),
  setProp: (node, name, value) => { node.props[name] = value },
  insert: (parent, child) => { parent.children.push(child) },
}

const view = (v) => materialize(buildViewNodes(v, undefined), stubSolid)

describe("materialize — V1-faithful element tree per view", () => {
  test("#given idle/empty #then a real box tree carries 'No configured models'", () => {
    const root = view({ kind: "idle", roster: { kind: "empty" } })

    expect(typeof root).not.toBe("string")
    expect(root.tag).toBe("box")
    expect(root.props.flexDirection).toBe("column")
    expect(nodeText(root)).toContain("No configured models")
  })

  test("#given idle/rows #then the roster rows render", () => {
    const root = view({ kind: "idle", roster: { kind: "rows", rows: [{ label: "sisyphus", model: "anthropic/x" }] } })

    expect(nodeText(root)).toContain("sisyphus anthropic/x")
  })

  test("#given active #then the Agents section and rows render", () => {
    const root = view({
      kind: "active",
      configBanner: { kind: "none" },
      loop: { kind: "none" },
      agents: { kind: "list", agents: [{ name: "atlas", status: "running" }] },
      jobs: { kind: "none" },
    })

    expect(nodeText(root)).toContain("Agents")
    expect(nodeText(root)).toContain("atlas running")
  })

  test("#given active with a ULW loop #then the ULW section renders", () => {
    const root = view({
      kind: "active",
      configBanner: { kind: "none" },
      loop: { kind: "live", goalsDone: 1, goalsTotal: 2, pass: 1, fail: 0, pending: 1, blocked: 0, activeGoal: null },
      agents: { kind: "none" },
      jobs: { kind: "none" },
    })

    expect(nodeText(root)).toContain("ULW")
    expect(nodeText(root)).toContain("goals 1/2")
  })

  test("#given broken #then the config notice renders", () => {
    const root = view({ kind: "broken", messages: ["config broken"] })

    expect(nodeText(root)).toContain("config invalid - run doctor")
    expect(nodeText(root)).toContain("config broken")
  })

  test("#then a section box keeps the V1 border/padding (single border, padding 1)", () => {
    const root = view({ kind: "idle", roster: { kind: "empty" } })
    const section = root.children[0]

    expect(section.tag).toBe("box")
    expect(section.props.borderStyle).toBe("single")
    expect(section.props.padding).toBe(1)
    expect(section.props.flexDirection).toBe("column")
  })
})

describe("materializeNode", () => {
  test("#then a text node inserts its text and sets its props", () => {
    const el = materializeNode({ kind: "text", props: { fg: "red" }, text: "hi" }, stubSolid)

    expect(el.tag).toBe("text")
    expect(el.props.fg).toBe("red")
    expect(el.children).toEqual(["hi"])
  })
})
