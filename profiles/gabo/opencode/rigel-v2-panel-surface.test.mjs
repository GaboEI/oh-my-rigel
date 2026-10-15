/**
 * Behaviour tests for the read-only panel adapter.
 *
 * The adapter owns the host boundary: the single slot registration, the render
 * value (a <text> node or null, never a bare string), isolated reads for every
 * representation, and the headless self-skip. A stub OpenTUI Solid runtime is
 * injected so the assertions observe the node contract without a live renderer.
 */
import { describe, expect, test } from "bun:test"

import { PANEL_SLOT_APPEND, createPanelSurface } from "./rigel-v2-panel-surface.mjs"

function stubSolid() {
  const nodes = []
  return {
    nodes,
    createElement(tag) {
      const node = { tag, children: [] }
      nodes.push(node)
      return node
    },
    insert(parent, child) {
      parent.children.push(child)
    },
    setProp(parent, name, value) {
      parent[name] = value
    },
  }
}

function fakeContext({
  renderer = { isDestroyed: false },
  sessions,
  titles = {},
  statuses = {},
  models,
  agents,
  providers,
  agentsThrows = false,
  location = { directory: "/w" },
} = {}) {
  const renders = []
  const slotCalls = []
  const context = {
    renderer,
    location,
    data: {
      session: {
        list: sessions === undefined ? undefined : () => sessions,
        get: (id) => ({ title: titles[id] }),
        status: (id) => statuses[id],
      },
      location: {
        model: { list: () => models },
        agent: {
          list: () => {
            if (agentsThrows) throw new Error("agent read failed")
            return agents
          },
        },
        provider: { list: () => providers },
      },
    },
    ui: {
      slot: (options) => {
        slotCalls.push(options)
        renders.push(options.render)
        return () => {}
      },
    },
  }
  return { context, renders, slotCalls }
}

function renderedText(fake) {
  const node = fake.renders[0]()
  return node.children[0]
}

describe("#given the panel surface at the host boundary", () => {
  test("#then setup registers exactly the sidebar.content slot with a render", () => {
    const fake = fakeContext()
    const dispose = createPanelSurface({ solid: stubSolid() }).setup(fake.context)
    expect(typeof dispose).toBe("function")
    expect(fake.slotCalls).toHaveLength(1)
    expect(fake.slotCalls[0].append).toBe(PANEL_SLOT_APPEND)
    expect(typeof fake.slotCalls[0].render).toBe("function")
  })

  describe("#when render runs with available data for every representation", () => {
    test("#then it returns a single <text> node carrying the sessions and catalog rows", () => {
      const solid = stubSolid()
      const fake = fakeContext({
        sessions: [{ id: "ses_1" }],
        titles: { ses_1: "First" },
        statuses: { ses_1: "idle" },
        models: [{ id: "gpt", name: "GPT" }],
        agents: [{ id: "sisyphus", name: "Sisyphus" }],
        providers: [{ id: "anthropic", name: "Anthropic" }],
      })
      createPanelSurface({ solid }).setup(fake.context)
      const node = fake.renders[0]()
      expect(node).not.toBeNull()
      expect(node.tag).toBe("text")
      expect(node.children).toHaveLength(1)
      const text = node.children[0]
      expect(typeof text).toBe("string")
      expect(text).toContain("- First [idle]")
      expect(text).toContain("- GPT")
      expect(text).toContain("- Sisyphus")
      expect(text).toContain("- Anthropic")
    })
  })

  describe("#when a catalog read is absent", () => {
    test("#then render still returns a node (no throw) and never a bare string", () => {
      const solid = stubSolid()
      const fake = fakeContext({ sessions: undefined, models: undefined, agents: undefined, providers: undefined })
      createPanelSurface({ solid }).setup(fake.context)
      const node = fake.renders[0]()
      expect(typeof node).toBe("object")
      expect(node.tag).toBe("text")
      expect(typeof node.children[0]).toBe("string")
    })
  })

  describe("#when only the agents read fails", () => {
    test("#then the agent section degrades to error while the others stay readable", () => {
      const solid = stubSolid()
      const fake = fakeContext({
        sessions: [{ id: "ses_1" }],
        titles: { ses_1: "First" },
        models: [{ id: "gpt", name: "GPT" }],
        agentsThrows: true,
        providers: [{ id: "anthropic", name: "Anthropic" }],
      })
      createPanelSurface({ solid }).setup(fake.context)
      const text = renderedText(fake)
      expect(text).toContain("Agents")
      expect(text).toContain("error")
      expect(text).toContain("- First")
      expect(text).toContain("- GPT")
      expect(text).toContain("- Anthropic")
    })
  })

  describe("#when the renderer itself throws on the render primitive", () => {
    test("#then render degrades to null and never propagates", () => {
      const throwing = {
        createElement() {
          throw new Error("no renderer")
        },
        insert() {},
      }
      const fake = fakeContext()
      createPanelSurface({ solid: throwing }).setup(fake.context)
      expect(() => fake.renders[0]()).not.toThrow()
      expect(fake.renders[0]()).toBeNull()
    })
  })

  describe("#given a headless host", () => {
    test("#then a destroyed renderer self-skips and registers nothing", () => {
      const fake = fakeContext({ renderer: { isDestroyed: true } })
      const dispose = createPanelSurface({ solid: stubSolid() }).setup(fake.context)
      expect(dispose).toBeUndefined()
      expect(fake.slotCalls).toHaveLength(0)
    })
  })

  describe("#given a host without the ui.slot API", () => {
    test("#then setup self-skips and registers nothing", () => {
      const fake = fakeContext()
      delete fake.context.ui.slot
      const dispose = createPanelSurface({ solid: stubSolid() }).setup(fake.context)
      expect(dispose).toBeUndefined()
      expect(fake.slotCalls).toHaveLength(0)
    })
  })
})
