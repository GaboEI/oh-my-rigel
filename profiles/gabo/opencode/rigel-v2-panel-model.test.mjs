/**
 * Behaviour tests for the pure read-only panel core.
 *
 * The core owns the data-to-string derivation and the four degradation states
 * for every representation: R2 "Sessions" and R3 "Models"/"Agents"/"Providers".
 * These tests pin the observable branch each input produces (disponible / vacio /
 * no disponible / error) and the rendered lines, so no read can be silently
 * dropped and the adapter can stay a thin host boundary.
 */
import { describe, expect, test } from "bun:test"

import { HIERARCHY_BLOCKED, LABEL_MAX, PANEL_CONTENT_WIDTH, PANEL_ID, PANEL_LAYOUT, PANEL_MAX_LINES, PANEL_STATE, PANEL_TEXT_WIDTH, buildPanelModel, displayWidth, fitLine, formatPanel, layoutPanelLines, truncate } from "./rigel-v2-panel-model.mjs"

function section(model, id) {
  return model.sections.find((entry) => entry.id === id)
}

describe("#given the read-only panel core", () => {
  test("#then the container advertises the stable id and the four representations", () => {
    const model = buildPanelModel({})
    expect(model.id).toBe(PANEL_ID)
    expect(model.sections.map((entry) => entry.id)).toEqual(["sessions", "models", "agents", "providers"])
  })

  describe("#given available reads for every representation", () => {
    test("#then each section is disponible and renders its real rows", () => {
      const model = buildPanelModel({
        location: { directory: "/work", project: "p" },
        sessions: [{ id: "ses_1" }, { id: "ses_2" }],
        titleOf: (id) => (id === "ses_1" ? "First" : "Second"),
        statusOf: (id) => (id === "ses_1" ? "idle" : "busy"),
        models: [{ id: "gpt", name: "GPT" }],
        agents: [{ id: "sisyphus", name: "Sisyphus" }],
        providers: [{ id: "anthropic", name: "Anthropic" }],
      })
      expect(section(model, "sessions").state).toBe(PANEL_STATE.AVAILABLE)
      expect(section(model, "sessions").rows).toEqual([
        { id: "ses_1", title: "First", status: "idle" },
        { id: "ses_2", title: "Second", status: "busy" },
      ])
      expect(section(model, "models").state).toBe(PANEL_STATE.AVAILABLE)
      expect(section(model, "models").rows).toEqual([{ id: "gpt", label: "GPT" }])
      expect(section(model, "agents").rows).toEqual([{ id: "sisyphus", label: "Sisyphus" }])
      expect(section(model, "providers").rows).toEqual([{ id: "anthropic", label: "Anthropic" }])
      const text = formatPanel(model)
      expect(text).toContain("/work")
      expect(text).toContain("- First [idle]")
      expect(text).toContain("- GPT")
      expect(text).toContain("- Sisyphus")
      expect(text).toContain("- Anthropic")
    })
  })

  describe("#given demonstrated-but-empty catalog reads", () => {
    test("#then each section is vacio and renders its own empty state", () => {
      const model = buildPanelModel({ sessions: [], models: [], agents: [], providers: [] })
      for (const id of ["sessions", "models", "agents", "providers"]) {
        expect(section(model, id).state).toBe(PANEL_STATE.EMPTY)
      }
      const text = formatPanel(model)
      expect(text).toContain("(sin sesiones)")
      expect(text).toContain("No hay modelos disponibles")
      expect(text).toContain("No hay agentes disponibles")
      expect(text).toContain("No hay proveedores disponibles")
    })
  })

  describe("#given a transient absence (undemonstrated read)", () => {
    test("#then only that section degrades to no disponible and invents no rows", () => {
      const model = buildPanelModel({ sessions: [{ id: "s1" }], models: undefined, agents: undefined, providers: undefined })
      expect(section(model, "sessions").state).toBe(PANEL_STATE.AVAILABLE)
      expect(section(model, "models").state).toBe(PANEL_STATE.UNAVAILABLE)
      expect(section(model, "agents").state).toBe(PANEL_STATE.UNAVAILABLE)
      expect(section(model, "providers").state).toBe(PANEL_STATE.UNAVAILABLE)
      expect(section(model, "agents").rows).toEqual([])
      expect(section(model, "providers").rows).toEqual([])
    })
  })

  describe("#given an isolated failed read", () => {
    test("#then only that section is error and the others keep their state", () => {
      const model = buildPanelModel({
        sessions: [{ id: "s1" }],
        titleOf: (id) => id,
        models: [{ id: "m" }],
        agents: [],
        agentsError: true,
        providersError: true,
      })
      expect(section(model, "sessions").state).toBe(PANEL_STATE.AVAILABLE)
      expect(section(model, "models").state).toBe(PANEL_STATE.AVAILABLE)
      expect(section(model, "agents").state).toBe(PANEL_STATE.ERROR)
      expect(section(model, "providers").state).toBe(PANEL_STATE.ERROR)
      expect(formatPanel(model)).toContain("error")
    })
  })

  describe("#given a session without a resolvable title or status", () => {
    test("#then the row falls back to the id and omits the status", () => {
      const model = buildPanelModel({ sessions: [{ id: "ses_only" }], titleOf: () => undefined, statusOf: () => undefined })
      expect(section(model, "sessions").rows).toEqual([{ id: "ses_only", title: "ses_only", status: null }])
      expect(formatPanel(model)).toContain("- ses_only\n")
    })
  })

  describe("#given active V2 sessions", () => {
    test("#then every sourced agent stays visible with its effective model or a dash", () => {
      const model = buildPanelModel({
        sessions: [
          { id: "ses_model", agent: "sisyphus", model: { providerID: "openai", modelID: "gpt-6" } },
          { id: "ses_missing", agent: "atlas" },
        ],
        statusOf: (id) => (id === "ses_model" ? "running" : "idle"),
        models: [{ id: "catalog-only", name: "Catalog-only" }],
      })
      expect(model.agentRows).toEqual({
        state: PANEL_STATE.AVAILABLE,
        hierarchy: { parentID: HIERARCHY_BLOCKED, depth: HIERARCHY_BLOCKED, enumeration: HIERARCHY_BLOCKED },
        rows: [
          { sessionID: "ses_model", agent: "sisyphus", model: "openai/gpt-6", status: "running" },
          { sessionID: "ses_missing", agent: "atlas", model: "-", status: "idle" },
        ],
      })
    })

    test("#then explicitly terminated sessions and category entries do not become agent rows", () => {
      const model = buildPanelModel({
        sessions: [
          { id: "ses_active", agent: "sisyphus" },
          { id: "ses_terminated", agent: "atlas" },
          { id: "ses_category", agent: "category", category: true },
          { id: "ses_kind", agent: "category", kind: "category" },
        ],
        statusOf: (id) => ({ ses_active: "idle", ses_terminated: "terminated", ses_category: "running", ses_kind: "running" })[id],
      })
      expect(model.agentRows).toMatchObject({
        state: PANEL_STATE.AVAILABLE,
        rows: [{ sessionID: "ses_active", agent: "sisyphus", model: "-", status: "idle" }],
      })
    })
  })

  describe("#given an unavailable V2 session source", () => {
    test("#then it emits no agent rows while preserving the explicit hierarchy block", () => {
      const model = buildPanelModel({ sessions: undefined })
      expect(model.agentRows).toEqual({
        state: PANEL_STATE.UNAVAILABLE,
        hierarchy: { parentID: HIERARCHY_BLOCKED, depth: HIERARCHY_BLOCKED, enumeration: HIERARCHY_BLOCKED },
        rows: [],
      })
    })
  })

  describe("#given active V2 sessions and a rendered block", () => {
    test("#then every read session's agent is visible as `agent model`, with `-` when none was sourced", () => {
      const model = buildPanelModel({
        sessions: [
          { id: "ses_model", agent: "sisyphus", model: { providerID: "openai", modelID: "gpt-6" } },
          { id: "ses_missing", agent: "atlas" },
        ],
        statusOf: (id) => (id === "ses_model" ? "running" : "idle"),
        models: [{ id: "catalog-only", name: "Catalog-only" }],
      })

      const lines = formatPanel(model).split("\n")
      const start = lines.indexOf("Agents per session")

      expect(start).toBeGreaterThan(-1)
      // The missing model is `-`, never the catalog entry listed further down.
      expect(lines.slice(start + 1, start + 3)).toEqual(["  - sisyphus openai/gpt-6", "  - atlas -"])
    })

    test("#then the block title claims the agent and model of each read session, never activity", () => {
      const model = buildPanelModel({
        sessions: [{ id: "ses_sel", agent: "atlas", model: "openai/gpt-6" }],
        statusOf: () => "running",
      })

      const lines = formatPanel(model).split("\n")
      const titleIndex = lines.indexOf("Agents per session")

      expect(titleIndex).toBeGreaterThan(-1)
      expect(lines[titleIndex + 1]).toBe("  - atlas openai/gpt-6")
      // I-3 reads one status, for the slot-selected session. The panel cannot
      // know the roster's activity, so the title may not name activity at all.
      expect(lines[titleIndex]).not.toMatch(/active|activo|running|busy/i)
    })

    test("#then the block is a flat list with no tree glyph, indentation level or counter", () => {
      const sessions = [1, 2, 3].map((index) => ({ id: `ses_${index}`, agent: `agent-${index}` }))
      const model = buildPanelModel({ sessions, statusOf: () => "running" })

      const lines = formatPanel(model).split("\n")
      const start = lines.indexOf("Agents per session")
      const rows = lines.slice(start + 1, start + 4)

      expect(rows).toEqual(["  - agent-1 -", "  - agent-2 -", "  - agent-3 -"])
      for (const row of rows) expect(row.match(/^ */)[0]).toHaveLength(2)
      // G5's parent/depth/enumeration stay BLOQUEADO, so nothing may imply a tree
      // shape or a persisted position the host never demonstrated.
      expect(model.agentRows.hierarchy).toEqual({ parentID: HIERARCHY_BLOCKED, depth: HIERARCHY_BLOCKED, enumeration: HIERARCHY_BLOCKED })
      expect(lines.some((line) => line.includes("*") || line.includes("|_"))).toBe(false)
      expect(lines.some((line) => /^\s*\d+[.)]\s/.test(line))).toBe(false)
    })

    test("#then an inline roster status neither overrides the selected accessor nor claims an unread session", () => {
      const model = buildPanelModel({
        sessions: [
          { id: "ses_sel", agent: "atlas", status: "idle" },
          { id: "ses_unread", agent: "sisyphus", status: "running" },
        ],
        statusOf: (id) => (id === "ses_sel" ? "running" : undefined),
        titleOf: () => "Title",
      })

      expect(section(model, "sessions").rows).toEqual([
        { id: "ses_sel", title: "Title", status: "running" },
        { id: "ses_unread", title: "Title", status: null },
      ])
      const lines = formatPanel(model).split("\n")
      const start = lines.indexOf("Agents per session")
      const rows = lines.slice(start + 1).filter((line) => line.startsWith("  - ") && !line.includes("Title"))

      expect(rows).toEqual(["  - atlas -"])
      expect(rows.some((row) => row.includes("["))).toBe(false)
    })

    test("#then the block is omitted entirely when the roster is unavailable, errored, inactive or empty", () => {
      const models = [
        buildPanelModel({ sessions: undefined }),
        buildPanelModel({ sessions: [{ id: "ses_1", agent: "atlas" }], sessionsError: true }),
        buildPanelModel({ sessions: [{ id: "ses_1", agent: "atlas" }], statusOf: () => "terminated" }),
        buildPanelModel({ sessions: [] }),
      ]

      for (const model of models) {
        const text = formatPanel(model)
        expect(text).not.toContain("Agents per session")
        expect(text).not.toContain("atlas")
      }
    })

    test("#then a long agent or model is fitted to the text budget with the agent kept visible", () => {
      const model = buildPanelModel({
        sessions: [{ id: "ses_long", agent: `agent-${"x".repeat(60)}`, model: `provider/${"m".repeat(60)}` }],
        statusOf: () => "running",
      })

      const lines = formatPanel(model).split("\n")
      const row = lines[lines.indexOf("Agents per session") + 1]

      expect(displayWidth(row)).toBeLessThanOrEqual(PANEL_TEXT_WIDTH)
      expect(row.startsWith("  - agent-")).toBe(true)
    })

    test("#then the block takes part in the height decision instead of overrunning it", () => {
      const sessions = Array.from({ length: 40 }, (_, index) => ({ id: `ses_${index}`, agent: "atlas" }))
      const model = buildPanelModel({ sessions, titleOf: (id) => `Title ${id}`, statusOf: () => "running" })

      expect(formatPanel(model).split("\n").length).toBeGreaterThan(PANEL_MAX_LINES)

      const layout = layoutPanelLines(model, "oh-my-rigel \u00b7 models")

      expect(layout.mode).toBe(PANEL_LAYOUT.COMPACT)
      expect(layout.lines.length).toBeLessThanOrEqual(PANEL_MAX_LINES)
    })
  })

  describe("#given a long label", () => {
    test("#then truncation is purely visual and bounded", () => {
      const long = "x".repeat(LABEL_MAX + 10)
      expect(truncate(long).length).toBe(LABEL_MAX)
      expect(truncate("ok")).toBe("ok")
    })
  })

  test("#when formatting a malformed model #then it never throws", () => {
    expect(() => formatPanel(undefined)).not.toThrow()
    expect(() => formatPanel({ sections: "nope" })).not.toThrow()
    expect(typeof formatPanel({})).toBe("string")
  })

  describe("#given a session title the host renders in wide cells", () => {
    test("#then truncation is a single visual ellipsis counted in cells, not characters", () => {
      // Two independent literals: 40 single-cell columns, and 20 double-cell
      // columns, each followed by the ellipsis that closes the 41-cell budget.
      expect(fitLine("x".repeat(60))).toBe(`${"x".repeat(PANEL_TEXT_WIDTH - 1)}\u2026`)
      expect(fitLine("\u754c".repeat(30))).toBe(`${"\u754c".repeat(20)}\u2026`)
      expect(displayWidth(fitLine("\u754c".repeat(30)))).toBe(PANEL_TEXT_WIDTH)
      expect(fitLine("short")).toBe("short")
    })
  })

  describe("#given a block with wide titles and long paths", () => {
    test("#then every emitted line fits the observed text budget so no row wraps", () => {
      const model = buildPanelModel({
        location: { directory: `/${"deep/".repeat(20)}` },
        sessions: [{ id: "ses_wide" }],
        titleOf: () => "开始 Atlas 计划执行会话标题很长很长非常长",
        statusOf: () => "running",
        models: [{ id: "m", name: "m".repeat(120) }],
        agents: [{ id: "sisyphus", name: "Sisyphus" }],
        providers: [{ id: "p", name: "p".repeat(120) }],
      })
      const lines = formatPanel(model).split("\n")
      expect(lines.length).toBeGreaterThan(6)
      for (const line of lines) {
        expect(displayWidth(line)).toBeLessThanOrEqual(PANEL_TEXT_WIDTH)
        // The text budget must stay strictly inside the observed content column.
        expect(displayWidth(line)).toBeLessThan(PANEL_CONTENT_WIDTH)
      }
    })
  })

  describe("#given a block longer than the rows the sidebar allots it", () => {
    const manySessions = (count, idOf = (index) => `ses_${index}`) =>
      Array.from({ length: count }, (_, index) => ({ id: idOf(index) }))

    test("#then it keeps the header and the read-session row and omits the rest", () => {
      const model = buildPanelModel({
        sessions: manySessions(PANEL_MAX_LINES - 5),
        titleOf: (id) => `Title ${id}`,
        statusOf: () => "idle",
        models: [{ id: "m" }],
        agents: [{ id: "a" }],
        providers: [{ id: "p" }],
      })
      expect(formatPanel(model).split("\n").length).toBeGreaterThan(PANEL_MAX_LINES)

      const layout = layoutPanelLines(model, "oh-my-rigel \u00b7 models")

      expect(layout.mode).toBe(PANEL_LAYOUT.COMPACT)
      expect(layout.lines[0]).toBe("oh-my-rigel \u00b7 models")
      expect(layout.lines[1]).toBe("  - Title ses_0 [idle]")
      expect(layout.lines.length).toBeLessThanOrEqual(PANEL_MAX_LINES)
      // Compact keeps the read rows and drops the catalog sections.
      expect(layout.lines.join("\n")).not.toContain("Models")
      expect(layout.lines.join("\n")).not.toContain("no disponible")
    })

    test("#then a session whose status was never read keeps no state claim in compact", () => {
      const read = manySessions(PANEL_MAX_LINES - 10, (index) => `ses_read_${index}`)
      const unread = manySessions(25, (index) => `ses_unread_${index}`).map(({ id }) => ({ id }))
      const model = buildPanelModel({
        sessions: [...read, ...unread],
        titleOf: (id) => (id.startsWith("ses_read") ? "Read row" : "Unread row"),
        statusOf: (id) => (id.startsWith("ses_read") ? "idle" : undefined),
        models: [{ id: "m" }],
        agents: [{ id: "a" }],
        providers: [{ id: "p" }],
      })
      expect(formatPanel(model).split("\n").length).toBeGreaterThan(PANEL_MAX_LINES)

      const layout = layoutPanelLines(model, "oh-my-rigel \u00b7 models")

      expect(layout.mode).toBe(PANEL_LAYOUT.COMPACT)
      expect(layout.lines.some((line) => line.includes("Read row"))).toBe(true)
      expect(layout.lines.some((line) => line.includes("Unread row"))).toBe(false)
      // Only the rows whose status was read carry a bracket.
      expect(layout.lines.filter((line) => line.includes("[")).every((line) => line.includes("Read row"))).toBe(true)
    })

    test("#then a compact block that also cannot fit emits no line at all", () => {
      const model = buildPanelModel({
        sessions: manySessions(PANEL_MAX_LINES + 10),
        titleOf: (id) => `Title ${id}`,
        statusOf: () => "idle",
      })
      const layout = layoutPanelLines(model, "oh-my-rigel \u00b7 models")
      expect(layout.mode).toBe(PANEL_LAYOUT.NONE)
      expect(layout.lines).toEqual([])
    })
  })

  describe("#given the exact rows the sidebar allots this block", () => {
    // The sealed F6c capture allots this block 52 rows from its header down to
    // the last sidebar row (PANEL_MAX_LINES). A rendered block is header +
    // location + the Sessions title with one row per session + three two-line
    // catalog sections, so its length is 9 + sessions: 43 sessions fill it to
    // exactly the allotment.
    const blockOf = (sessionCount) =>
      buildPanelModel({
        location: { directory: "/w" },
        sessions: Array.from({ length: sessionCount }, (_, index) => ({ id: `ses_${index}` })),
        statusOf: () => "idle",
        models: [],
        agents: [],
        providers: [],
      })

    test("#then a block of exactly the allotment renders in full", () => {
      const model = blockOf(43)
      expect(formatPanel(model).split("\n").length).toBe(PANEL_MAX_LINES)

      const layout = layoutPanelLines(model, "oh-my-rigel \u00b7 models")

      expect(layout.mode).toBe(PANEL_LAYOUT.FULL)
      expect(layout.lines).toHaveLength(PANEL_MAX_LINES)
    })

    test("#then one row past the allotment degrades to compact instead of overflowing", () => {
      const model = blockOf(44)
      expect(formatPanel(model).split("\n").length).toBe(PANEL_MAX_LINES + 1)

      const layout = layoutPanelLines(model, "oh-my-rigel \u00b7 models")

      expect(layout.mode).toBe(PANEL_LAYOUT.COMPACT)
      // Header plus one row per session; the catalog sections are dropped.
      expect(layout.lines).toHaveLength(1 + 44)
    })

    test("#then a compact block that still exceeds the allotment emits no line at all", () => {
      // Every row carries a read status, so compact keeps all of them: 52 rows
      // plus the header is 53, one past the allotment, and the whole block is 61.
      const model = blockOf(52)
      expect(formatPanel(model).split("\n").length).toBe(61)

      const layout = layoutPanelLines(model, "oh-my-rigel \u00b7 models")

      expect(layout.mode).toBe(PANEL_LAYOUT.NONE)
      expect(layout.lines).toEqual([])
    })
  })
})
