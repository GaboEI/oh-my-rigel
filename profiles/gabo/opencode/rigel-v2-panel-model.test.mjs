import { describe, expect, test } from "bun:test"

import {
  CATEGORY_NAMES,
  PANEL_COLORS,
  PANEL_HEADER_REST,
  PANEL_HEADER_WORKING,
  PRINCIPAL_FALLBACK_COLORS,
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

  test("#given a running principal #then the working row keeps its own roster colour instead of the base colour", () => {
    const built = roster()
    const sisyphus = built.principals.find((row) => row.name === "Sisyphus")
    const hephaestus = built.principals.find((row) => row.name === "Hephaestus")
    const model = buildPanelModel({
      roster: built,
      sessions: [
        { id: "ses_sisyphus", agent: "Sisyphus", time: { created: 1 } },
        { id: "ses_hephaestus", agent: "hephaestus", time: { created: 2 } },
        { id: "ses_oracle", agent: "Oracle", time: { created: 3 } },
      ],
      statusOf: () => "running",
    })
    const colors = Object.fromEntries(model.rows.map((row) => [row.rawName, row.nameColor]))

    expect(model.mode).toBe("working")
    expect(sisyphus.nameColor).not.toBe(PANEL_COLORS.base)
    expect(colors.Sisyphus).toBe(sisyphus.nameColor)
    expect(colors.Hephaestus).toBe(hephaestus.nameColor)
    expect(colors.Oracle).toBe(PANEL_COLORS.base)
  })

  test("#given a running principal the roster does not carry #then the working row keeps its own fallback colour", () => {
    const model = buildPanelModel({
      roster: { principals: [], subagents: [], categories: [] },
      sessions: [{ id: "ses_sisyphus", agent: "Sisyphus", time: { created: 1 } }],
      statusOf: () => "running",
    })

    expect(model.rows[0].nameColor).toBe(PRINCIPAL_FALLBACK_COLORS[0])
    expect(model.rows[0].nameColor).not.toBe(PANEL_COLORS.base)
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

  test("#given a name exactly as wide as the roster column #then the model keeps at least one separator and is never glued", () => {
    const built = roster()
    const longest = built.principals.concat(built.subagents, built.categories)
      .map((row) => row.name)
      .reduce((widest, name) => (name.length > widest.length ? name : widest), "")
    const model = buildPanelModel({ roster: built, sessions: [{ id: "ses_root" }], statusOf: () => "idle" })
    const lines = formatPanel(model).split("\n")
    const longestRow = model.rows.find((row) => row.name === longest)

    expect(model.nameColumnWidth).toBe(longest.length + 1)
    expect(lines).toContain(`${longest} ${longestRow.model}`)
    expect(lines.some((line) => line.startsWith(`${longest}${longestRow.model}`))).toBe(false)

    const wideLabel = "a-running-label-wider-than-the-roster-column"
    const working = buildPanelModel({
      roster: built,
      sessions: [{ id: "ses_wide", agent: wideLabel }],
      statusOf: () => "running",
    })
    const workingLine = formatPanel(working).split("\n").find((line) => line.includes("running"))

    expect(working.mode).toBe("working")
    expect(workingLine).toBe(`${wideLabel} running`)
  })

  test("#given the inherited OpenCode default model #then Judge renders the abbreviated family.variant", () => {
    const model = buildPanelModel({ roster: buildRoster({ judgeModel: "opencode-go/deepseek-v4.1-flash" }) })
    const judgeLine = formatPanel(model).split("\n").find((line) => line.startsWith("Judge"))

    expect(judgeLine).toBe(`${"Judge".padEnd(model.nameColumnWidth)}deepseek-v4.1`)
  })

  test("#given malformed input #then the model still has one of the two safe states", () => {
    expect(() => buildPanelModel(undefined)).not.toThrow()
    expect(["models", "working"]).toContain(buildPanelModel(undefined).mode)
    expect(typeof formatPanel(undefined)).toBe("string")
  })
})
