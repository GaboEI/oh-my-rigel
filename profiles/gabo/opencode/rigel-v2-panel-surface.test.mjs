/**
 * Behaviour tests for the read-only panel adapter.
 *
 * The adapter owns the host boundary: the single additive slot registration, the
 * slot-input identity (`input.sessionID`), the exact G2 header for the
 * demonstrated state, the render value (a <text> node or null, never a bare
 * string), isolated reads for every representation, and the headless self-skip.
 * A stub OpenTUI Solid runtime is injected so the assertions observe the node
 * contract without a live renderer.
 */
import { describe, expect, test } from "bun:test"

import { PANEL_HEADER_REST, PANEL_HEADER_WORKING, PANEL_SLOT_APPEND, createPanelSurface } from "./rigel-v2-panel-surface.mjs"

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
  statusThrows = false,
  models,
  agents,
  providers,
  agentsThrows = false,
  location = { directory: "/w" },
} = {}) {
  const renders = []
  const slotCalls = []
  const statusCalls = []
  const context = {
    renderer,
    location,
    data: {
      session: {
        list: sessions === undefined ? undefined : () => sessions,
        get: (id) => ({ title: titles[id] }),
        status: (id) => {
          statusCalls.push(id)
          if (statusThrows) throw new Error("status read failed")
          return statuses[id]
        },
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
  return { context, renders, slotCalls, statusCalls }
}

function renderedText(fake, input) {
  const node = fake.renders[0](input)
  return node.children[0]
}

function firstLine(text) {
  return text.split("\n")[0]
}

describe("#given the panel surface at the host boundary", () => {
  test("#then setup registers exactly one additive sidebar.content slot with a render", () => {
    const fake = fakeContext()
    const dispose = createPanelSurface({ solid: stubSolid() }).setup(fake.context)
    expect(typeof dispose).toBe("function")
    expect(fake.slotCalls).toHaveLength(1)
    expect(fake.slotCalls[0].append).toBe(PANEL_SLOT_APPEND)
    expect(typeof fake.slotCalls[0].render).toBe("function")
    // The host-owned lifecycle receives only the additive slot contract: no
    // replacement target, ordering claim, subscription, or active capability.
    expect(Object.keys(fake.slotCalls[0]).sort()).toEqual(["append", "render"])
  })

  describe("#given the G2 header contract", () => {
    test("#then the two registered header literals are exact", () => {
      expect(PANEL_SLOT_APPEND).toBe("sidebar.content")
      expect(PANEL_HEADER_REST).toBe("oh-my-rigel · models")
      expect(PANEL_HEADER_WORKING).toBe("oh-my-rigel · working")
    })
  })

  describe("#given a slot input naming the selected session", () => {
    test("#then I-3's single read targets that identity and the other sessions stay unread", () => {
      const fake = fakeContext({
        sessions: [
          { id: "ses_a", agent: "sisyphus" },
          { id: "ses_b", agent: "atlas" },
        ],
        titles: { ses_a: "Other", ses_b: "Selected" },
        statuses: { ses_a: "idle", ses_b: "running" },
        models: [],
        agents: [],
        providers: [],
      })
      createPanelSurface({ solid: stubSolid() }).setup(fake.context)

      const text = renderedText(fake, { sessionID: "ses_b" })

      expect(firstLine(text)).toBe(PANEL_HEADER_WORKING)
      // Exactly one status read, for the slot-provided identity. The roster is
      // never widened: the other listed session is not read at all.
      expect(fake.statusCalls).toEqual(["ses_b"])
      expect(text).toContain("- Selected [running]")
      // An unread session keeps no state: the row is rendered without a status
      // claim instead of inventing one or borrowing the selected session's.
      expect(text).toContain("- Other")
      expect(text).not.toContain("[idle]")
    })

    test("#then a status the host would answer for another session is never requested or claimed", () => {
      const fake = fakeContext({
        sessions: [
          { id: "ses_a", agent: "sisyphus" },
          { id: "ses_b", agent: "atlas" },
        ],
        titles: { ses_a: "Other", ses_b: "Selected" },
        statuses: { ses_a: "running", ses_b: "idle" },
      })
      createPanelSurface({ solid: stubSolid() }).setup(fake.context)

      const text = renderedText(fake, { sessionID: "ses_b" })

      expect(firstLine(text)).toBe(PANEL_HEADER_REST)
      expect(fake.statusCalls).toEqual(["ses_b"])
      expect(text).not.toContain("[running]")
    })
  })

  describe("#given a host that provides no slot input", () => {
    test("#then no identity is invented, no status is read and the header stays at rest", () => {
      const fake = fakeContext({
        sessions: [{ id: "ses_a", agent: "sisyphus" }],
        statuses: { ses_a: "running" },
      })
      createPanelSurface({ solid: stubSolid() }).setup(fake.context)

      const text = renderedText(fake)

      expect(firstLine(text)).toBe(PANEL_HEADER_REST)
      // I-3 admits no read without the slot-provided identity.
      expect(fake.statusCalls).toEqual([])
    })
  })

  describe("#when the selected session is idle", () => {
    test("#then the header is the rest header", () => {
      const fake = fakeContext({ sessions: [{ id: "ses_a", agent: "atlas" }], statuses: { ses_a: "idle" } })
      createPanelSurface({ solid: stubSolid() }).setup(fake.context)

      expect(firstLine(renderedText(fake, { sessionID: "ses_a" }))).toBe(PANEL_HEADER_REST)
    })
  })

  describe("#when the selected session is active", () => {
    test("#then the header is the working header and the host literal is preserved", () => {
      const fake = fakeContext({
        sessions: [{ id: "ses_a", agent: "atlas" }],
        titles: { ses_a: "Active" },
        statuses: { ses_a: "running" },
      })
      createPanelSurface({ solid: stubSolid() }).setup(fake.context)

      const text = renderedText(fake, { sessionID: "ses_a" })

      expect(firstLine(text)).toBe(PANEL_HEADER_WORKING)
      // G1 fallback: the accessor literal is shown as read, never translated.
      expect(text).toContain("[running]")
      expect(text).not.toContain("busy")
    })
  })

  describe("#when the accessor returns no status or a failed read", () => {
    test("#then the header stays at rest instead of claiming work", () => {
      const absent = fakeContext({ sessions: [{ id: "ses_a", agent: "atlas" }], statuses: {} })
      createPanelSurface({ solid: stubSolid() }).setup(absent.context)
      expect(firstLine(renderedText(absent, { sessionID: "ses_a" }))).toBe(PANEL_HEADER_REST)

      const failing = fakeContext({ sessions: [{ id: "ses_a", agent: "atlas" }], statusThrows: true })
      createPanelSurface({ solid: stubSolid() }).setup(failing.context)
      expect(firstLine(renderedText(failing, { sessionID: "ses_a" }))).toBe(PANEL_HEADER_REST)
    })
  })

  describe("#when the accessor returns a literal outside the demonstrated vocabulary", () => {
    test("#then the header stays at rest and the literal is not re-mapped", () => {
      const fake = fakeContext({ sessions: [{ id: "ses_a", agent: "atlas" }], statuses: { ses_a: "retry" } })
      createPanelSurface({ solid: stubSolid() }).setup(fake.context)

      const text = renderedText(fake, { sessionID: "ses_a" })

      expect(firstLine(text)).toBe(PANEL_HEADER_REST)
      expect(text).toContain("[retry]")
    })
  })

  describe("#when render runs with available data for every representation", () => {
    test("#then it returns a single <text> node carrying one header and the sessions and catalog rows", () => {
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
      const node = fake.renders[0]({ sessionID: "ses_1" })
      expect(node).not.toBeNull()
      expect(node.tag).toBe("text")
      expect(node.children).toHaveLength(1)
      const text = node.children[0]
      expect(typeof text).toBe("string")
      expect(firstLine(text)).toBe(PANEL_HEADER_REST)
      // Exactly one block header, and no competing standalone title above it.
      expect(text.split("oh-my-rigel").length - 1).toBe(1)
      expect(text).not.toContain("Oh My Rigel")
      expect(text).toContain("- First [idle]")
      expect(text).toContain("- GPT")
      expect(text).toContain("- Sisyphus")
      expect(text).toContain("- Anthropic")
      // Host-native blocks stay independent: this block never renders them.
      for (const native of ["Context", "MCP", "Goal"]) expect(text).not.toContain(native)
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
      const text = renderedText(fake, { sessionID: "ses_1" })
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
