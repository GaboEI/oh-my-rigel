import { describe, expect, test } from "bun:test"

import {
  CATEGORY_NAMES,
  PANEL_COLORS,
  PANEL_HEADER_REST,
  PANEL_HEADER_WORKING,
  PRINCIPAL_NAMES,
  SUBAGENT_NAMES,
  abbreviateModel,
  buildPanelModel,
  buildRoster,
  filterPanelColor,
  formatPanel,
} from "./rigel-v2-panel-model.mjs"

function roster() {
  const agents = Object.fromEntries(
    [...PRINCIPAL_NAMES, ...SUBAGENT_NAMES].map((name) => [name, { models: [`provider/${name.toLowerCase()}-flash`] }]),
  )
  const categories = Object.fromEntries(CATEGORY_NAMES.map((name) => [name, { models: [`provider/${name}-flash`] }]))
  return buildRoster({
    agents,
    categories,
    judgeModel: "opencode-go/deepseek-v4.1-flash",
    principalColors: { Sisyphus: "#00CED1", Judge: "#FCFCFC" },
  })
}

describe("Rigel sidebar pure panel model", () => {
  test("#given an idle session #then it renders the complete three-group roster with aligned model columns", () => {
    const model = buildPanelModel({ roster: roster(), sessions: [{ id: "ses_root" }], statusOf: () => "idle" })

    expect(model.mode).toBe("models")
    expect(model.header).toBe(PANEL_HEADER_REST)
    expect(model.groups.map((group) => group.id)).toEqual(["principals", "subagents", "categories"])
    expect(model.groups.map((group) => group.rows.length)).toEqual([6, 6, 9])
    expect(model.rows).toHaveLength(21)

    const text = formatPanel(model)
    expect(text).toContain("oh-my-rigel · models")
    expect(text).toContain(`${"Sisyphus".padEnd(model.nameColumnWidth)}sisyphus`)
    expect(text).toContain(`${"multimodal-looker".padEnd(model.nameColumnWidth)}multimodal-looker`)
    expect(text).toContain(`${"visual-engineering".padEnd(model.nameColumnWidth)}visual-engineering`)
    expect(text).not.toContain("PRINCIPALES")
    expect(text).not.toContain("SUBAGENTES")
    expect(text).not.toContain("CATEGORÍAS")
  })

  test("#given no running session #then model and provider suffixes are abbreviated", () => {
    expect(abbreviateModel("deepseek-v4.1-flash")).toBe("deepseek-v4.1")
    expect(abbreviateModel("google/gemini-3.7-flash")).toBe("gemini-3.7")
    expect(abbreviateModel("openai/gpt-5.6-luna#high")).toBe("gpt-5.6-luna")
  })

  test("#given a running roster #then it projects only running agents in creation order without task text", () => {
    const sessions = [
      { id: "ses_sisyphus", agent: "Sisyphus", task: "orchestrate", time: { created: 1 } },
      { id: "ses_judge", agent: "judge", task: "judge task", time: { created: 2 } },
      { id: "ses_oracle", agent: "oracle", task: "oracle task", time: { created: 3 } },
      { id: "ses_junior", agent: "Sisyphus-Junior", task: "junior task", time: { created: 4 } },
      { id: "ses_idle", agent: "explore", time: { created: 5 }, title: "forbidden title" },
    ]
    const status = new Map([
      ["ses_sisyphus", "running"],
      ["ses_judge", "running"],
      ["ses_oracle", "running"],
      ["ses_junior", { status: "running" }],
      ["ses_idle", "idle"],
    ])
    const model = buildPanelModel({ roster: roster(), sessionID: "ses_junior", sessions, statusOf: (id) => status.get(id) })
    const text = formatPanel(model)

    expect(model.mode).toBe("working")
    expect(model.header).toBe(PANEL_HEADER_WORKING)
    expect(model.groups).toEqual([])
    expect(model.rows.map((row) => row.name)).toEqual(["Sisyphus", "Judge", "Oracle", "Sisyphus-Junior 1"])
    expect(model.rows.map((row) => row.prefix)).toEqual(["* ", "* ", "", ""])
    expect(model.rows.map((row) => row.status)).toEqual(["running", "running", "running", "running"])
    expect(text).toContain(`${"* Sisyphus".padEnd(model.nameColumnWidth)}running`)
    expect(text).toContain(`${"* Judge".padEnd(model.nameColumnWidth)}running`)
    expect(text).toContain(`${"Oracle".padEnd(model.nameColumnWidth)}running`)
    expect(text).toContain(`${"Sisyphus-Junior 1".padEnd(model.nameColumnWidth)}running`)
    expect(text).not.toContain("busy")
    expect(text).not.toContain("orchestrate")
    expect(text).not.toContain("judge task")
    expect(text).not.toContain("oracle task")
    expect(text).not.toContain("junior task")
    expect(text).not.toContain("ses_")
    expect(text).not.toContain("forbidden title")
  })

  test("#given only completed or idle sessions #then it returns to the full roster", () => {
    const model = buildPanelModel({
      roster: roster(),
      sessions: [
        { id: "ses_done", agent: "oracle", time: { created: 1 } },
        { id: "ses_idle", agent: "explore", time: { created: 2 } },
      ],
      statusOf: (id) => (id === "ses_done" ? "idle" : "retry"),
    })
    expect(model.mode).toBe("models")
    expect(model.rows).toHaveLength(21)
  })

  test("#given a host color #then the pure filter makes near-white impossible", () => {
    for (const color of ["#FCFCFC", "#FFFFFF", "#E1E2E3", "#F1E1FF", "theme.text.base"]) {
      expect(filterPanelColor(color)).toBe(PANEL_COLORS.base)
    }
    expect(filterPanelColor("#00CED1")).toBe("#00CED1")
    expect(filterPanelColor("theme.text.muted")).toBe(PANEL_COLORS.dim)
  })

  test("#given malformed input #then the model still has one of the two safe states", () => {
    expect(() => buildPanelModel(undefined)).not.toThrow()
    expect(["models", "working"]).toContain(buildPanelModel(undefined).mode)
    expect(typeof formatPanel(undefined)).toBe("string")
  })
})
