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

import { LABEL_MAX, PANEL_ID, PANEL_STATE, buildPanelModel, formatPanel, truncate } from "./rigel-v2-panel-model.mjs"

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
})
