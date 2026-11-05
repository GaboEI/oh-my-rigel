import { describe, expect, test } from "bun:test"

import { PANEL_COLORS, buildRoster } from "./rigel-v2-panel-model.mjs"
import { PANEL_SLOT_APPEND, createPanelSurface } from "./rigel-v2-panel-surface.mjs"

function stubSolid() {
  return {
    createElement(tag) {
      return { tag, children: [] }
    },
    insert(parent, child) {
      parent.children.push(child)
    },
    setProp(parent, name, value) {
      parent[name] = value
    },
  }
}

function fakeRoster() {
  return buildRoster({
    agents: {
      Sisyphus: { models: ["openai/gpt-5.6-luna"] },
      explore: { models: ["opencode-go/deepseek-v4.1-flash"] },
    },
    categories: { artistry: { models: ["openai/gpt-5.6-terra"] } },
    judgeModel: "opencode-go/deepseek-v4.1-flash",
    principalColors: { Sisyphus: "#00CED1" },
  })
}
function threeGroupRoster() {
  const row = (name, model) => ({ name, model, nameColor: PANEL_COLORS.base, modelColor: PANEL_COLORS.dim })
  return Object.freeze({
    principals: Object.freeze([
      row("Sisyphus", "deepseek-v4.1"),
      row("Hephaestus", "gpt-6-luna"),
      row("Prometheus", "deepseek-v4.1"),
    ]),
    subagents: Object.freeze([row("explore", "deepseek-v4.1"), row("librarian", "gpt-6-luna")]),
    categories: Object.freeze([row("artistry", "gpt-6-terra")]),
  })
}

// 200x80 terminal with the sidebar at 41 columns: 41 - 2 border - 4 padding.
const PANEL_INNER_WIDTH = 35
// Longest roster name ("Hephaestus"/"Prometheus") plus its one separator.
const ROSTER_NAME_WIDTH = 11

function rowBoxText(node) {
  return node.children.map(textValue).join("")
}

// A row box that does not pin its own height expands into the column's free
// space and spends a blank line after its text, which is the reported defect.
function isSingleLineRow(node) {
  return node?.tag === "box" && node.flexDirection === "row" && node.height === 1 && node.flexShrink === 0
}

function renderedLines(root) {
  const lines = []
  for (const child of root.children) {
    if (child.tag !== "box") {
      lines.push(...textValue(child).split("\n"))
      continue
    }
    lines.push(rowBoxText(child).slice(0, PANEL_INNER_WIDTH))
    if (!isSingleLineRow(child)) lines.push("")
  }
  return lines
}


function fakeContext({ sessions = [], statuses = {}, renderer = { isDestroyed: false } } = {}) {
  const slotCalls = []
  const statusSubscriptions = []
  const context = {
    renderer,
    data: {
      session: {
        list: () => sessions,
        status: (id) => statuses[id],
      },
      on: (event, callback) => {
        statusSubscriptions.push({ event, callback, removed: false })
        const record = statusSubscriptions.at(-1)
        return () => { record.removed = true }
      },
    },
    ui: {
      slot: (options) => {
        slotCalls.push(options)
        return () => { options.removed = true }
      },
    },
  }
  return { context, slotCalls, statusSubscriptions }
}

function textValue(node) {
  if (typeof node === "string") return node
  return node?.children?.map(textValue).join("") ?? ""
}

describe("Rigel sidebar OpenTUI surface", () => {
  test("#given a live renderer #then it registers one sidebar slot and one bounded status subscription", () => {
    const fake = fakeContext()
    const dispose = createPanelSurface({ solid: stubSolid(), roster: fakeRoster() }).setup(fake.context)

    expect(typeof dispose).toBe("function")
    expect(fake.slotCalls).toHaveLength(1)
    expect(fake.slotCalls[0].append).toBe(PANEL_SLOT_APPEND)
    expect(fake.statusSubscriptions.map((entry) => entry.event)).toEqual(["session.status"])

    dispose()
    expect(fake.slotCalls[0].removed).toBe(true)
    expect(fake.statusSubscriptions[0].removed).toBe(true)
  })

  test("#when the roster is idle #then it renders a bordered box with colored row nodes", () => {
    const solid = stubSolid()
    const fake = fakeContext({ sessions: [{ id: "ses_root", agent: "Sisyphus" }], statuses: { ses_root: "idle" } })
    createPanelSurface({ solid, roster: fakeRoster() }).setup(fake.context)
    const root = fake.slotCalls[0].render({ sessionID: "ses_root" })

    expect(root.tag).toBe("box")
    expect(root.borderStyle).toBe("single")
    expect(root.borderColor).toBe(PANEL_COLORS.border)
    expect(root.paddingLeft).toBe(2)
    expect(root.paddingRight).toBe(2)
    expect(root.children[0].tag).toBe("box")
    expect(textValue(root.children[0])).toContain("oh-my-rigel · models")
    expect(root.children[0].children[0].fg).toBe(PANEL_COLORS.brand)
    expect(root.children[0].children[1].fg).toBe(PANEL_COLORS.dim)
    expect(root.children[0].children[2].fg).toBe(PANEL_COLORS.dim)

    const rows = root.children
      .filter((child) => child.tag === "box" && textValue(child).trim().length > 0)
      .slice(1)
    const sisyphusRow = rows.find((row) => textValue(row.children[0]).startsWith("Sisyphus"))
    const model = sisyphusRow.children.find((child) => textValue(child).startsWith("gpt-5.6"))
    expect(sisyphusRow.children[0].fg).toBe("#00CED1")
    expect(model.fg).toBe(PANEL_COLORS.dim)
    expect(rows.length).toBe(21)
  })

  test("#given a three-group idle model #then every row is one line and only group separators are blank", () => {
    const solid = stubSolid()
    const fake = fakeContext()
    const roster = threeGroupRoster()
    createPanelSurface({ solid, roster }).setup(fake.context)
    const root = fake.slotCalls[0].render({ sessionID: "ses_root" })

    const rowLine = (row) => `${row.name.padEnd(ROSTER_NAME_WIDTH)}${row.model}`
    const expected = [
      "oh-my-rigel · models",
      "",
      ...roster.principals.map(rowLine),
      "",
      ...roster.subagents.map(rowLine),
      "",
      ...roster.categories.map(rowLine),
    ]

    expect(renderedLines(root)).toEqual(expected)
    expect(renderedLines(root).filter((line) => line === "")).toHaveLength(3)

    // The longest label is the one that lost its separator in the live panel: it
    // keeps exactly one space and its column cannot be squeezed by a narrow sidebar.
    const longestRow = root.children.find((child) => child.tag === "box" && textValue(child).startsWith("Prometheus"))
    expect(textValue(longestRow.children[0])).toBe(`${"Prometheus".padEnd(ROSTER_NAME_WIDTH)}`)
    expect(textValue(longestRow.children[0])).not.toBe("Prometheus")
    expect(longestRow.children[0].flexShrink).toBe(0)
  })

  test("#when an agent is running #then it renders only running rows without task text", () => {
    const solid = stubSolid()
    const fake = fakeContext({
      sessions: [
        { id: "ses_idle", agent: "explore", time: { created: 1 }, title: "not rendered" },
        { id: "ses_running", agent: "oracle", task: "investigate the bounded task", time: { created: 2 } },
      ],
      statuses: { ses_idle: "idle", ses_running: "running" },
    })
    createPanelSurface({ solid, roster: fakeRoster() }).setup(fake.context)
    const root = fake.slotCalls[0].render({ sessionID: "ses_running" })
    const rows = root.children
      .filter((child) => child.tag === "box" && textValue(child).trim().length > 0)
      .slice(1)
    const rowText = rows.map((row) => row.children.map(textValue).join(""))

    expect(textValue(root.children[0])).toContain("oh-my-rigel · working")
    expect(root.children[0].children[0].fg).toBe(PANEL_COLORS.brand)
    expect(root.children[0].children[1].fg).toBe(PANEL_COLORS.dim)
    expect(root.children[0].children[2].fg).toBe(PANEL_COLORS.working)
    expect(rowText).toEqual([`${"Oracle".padEnd("visual-engineering".length + 1)}running`])
    expect(rows[0].children).toHaveLength(2)
    expect(rows[0].children[1].fg).toBe(PANEL_COLORS.working)
    expect(rowText.join(" ")).not.toContain("busy")
    expect(rowText.join(" ")).not.toContain("investigate the bounded task")
    expect(rowText.join(" ")).not.toContain("not rendered")
    expect(rowText.join(" ")).not.toContain("ses_")
  })

  test("#when the host omits the renderer or slot #then setup self-skips", () => {
    const destroyed = fakeContext({ renderer: { isDestroyed: true } })
    expect(createPanelSurface({ solid: stubSolid(), roster: fakeRoster() }).setup(destroyed.context)).toBeUndefined()
    expect(destroyed.slotCalls).toHaveLength(0)

    const noSlot = fakeContext()
    delete noSlot.context.ui.slot
    expect(createPanelSurface({ solid: stubSolid(), roster: fakeRoster() }).setup(noSlot.context)).toBeUndefined()
  })

  test("#when the renderer primitive throws #then render returns a safe bordered box", () => {
    const fake = fakeContext()
    const throwing = {
      createElement() { throw new Error("renderer") },
      insert() {},
      setProp() {},
    }
    createPanelSurface({ solid: throwing, roster: fakeRoster() }).setup(fake.context)
    expect(() => fake.slotCalls[0].render({ sessionID: "ses_root" })).not.toThrow()
    expect(fake.slotCalls[0].render({ sessionID: "ses_root" })).toBeNull()
  })
})
