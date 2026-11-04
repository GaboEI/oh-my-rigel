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
import { PANEL_CONTENT_WIDTH, PANEL_TEXT_WIDTH, displayWidth } from "./rigel-v2-panel-model.mjs"

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

  describe("#given a host whose session titles render in wide cells", () => {
    test("#then no rendered line reaches the observed content column edge", () => {
      const fake = fakeContext({
        location: { directory: `/${"deep/".repeat(20)}` },
        sessions: [{ id: "ses_wide" }],
        titles: { ses_wide: "\u5f00\u59cb Atlas \u8ba1\u5212\u6267\u884c\u4f1a\u8bdd\u6807\u9898\u5f88\u957f\u5f88\u957f\u975e\u5e38\u957f" },
        statuses: { ses_wide: "running" },
        models: [{ id: "gpt", name: "g".repeat(120) }],
        agents: [{ id: "sisyphus", name: "Sisyphus" }],
        providers: [{ id: "anthropic", name: "a".repeat(120) }],
      })
      createPanelSurface({ solid: stubSolid() }).setup(fake.context)

      const lines = renderedText(fake, { sessionID: "ses_wide" }).split("\n")

      expect(lines.length).toBeGreaterThan(6)
      for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(PANEL_TEXT_WIDTH)
      for (const line of lines) expect(displayWidth(line)).toBeLessThan(PANEL_CONTENT_WIDTH)
    })
  })

  describe("#given a block that cannot fit even in its compact form", () => {
    test("#then render returns null instead of a node, and never a bare string", () => {
      const sessions = Array.from({ length: 120 }, (_, index) => ({ id: `ses_${index}`, status: "idle", agent: "atlas" }))
      const solid = stubSolid()
      const fake = fakeContext({ sessions })
      createPanelSurface({ solid }).setup(fake.context)

      expect(fake.renders[0]({ sessionID: "ses_0" })).toBeNull()
      // Nothing was mounted for the omitted block.
      expect(solid.nodes).toHaveLength(0)
    })
  })

  /**
 * Read-census seam. A reviewer cannot check "the panel only reads what it was
 * allowed to read" from the surface alone, so every host access is recorded by a
 * stable logical name and the whole set is pinned by exact equality. `session.get`
 * records the property actually consumed, and `session.status` records the
 * identity it was asked for, so a widened read shows up instead of passing.
 */
function censusContext({ sessions = [], titles = {}, statuses = {}, models = [], agents = [], providers = [], contextLocation = true } = {}) {
  const reads = []
  const selectorCalls = []
  const renders = []
  const slotCalls = []
  const fixtures = {
    sessions,
    titles,
    statuses,
    models,
    agents,
    providers,
    location: { directory: "/w" },
  }
  const context = {
    renderer: { isDestroyed: false },
    data: {
      session: {
        list: (...args) => {
          reads.push("data.session.list")
          selectorCalls.push({ name: "data.session.list", args })
          return fixtures.sessions
        },
        get: (id) => {
          selectorCalls.push({ name: "data.session.get", args: [id] })
          const entry = { title: fixtures.titles[id] }
          return new Proxy(entry, {
            get(target, property) {
              reads.push(`data.session.get.${String(property)}`)
              return target[property]
            },
          })
        },
        status: (id) => {
          reads.push(`data.session.status:${id}`)
          selectorCalls.push({ name: "data.session.status", args: [id] })
          return fixtures.statuses[id]
        },
      },
      location: {
        default: (...args) => {
          reads.push("location")
          selectorCalls.push({ name: "data.location.default", args })
          return fixtures.location
        },
        model: {
          list: (...args) => {
            reads.push("data.location.model.list")
            selectorCalls.push({ name: "data.location.model.list", args })
            return fixtures.models
          },
        },
        agent: {
          list: (...args) => {
            reads.push("data.location.agent.list")
            selectorCalls.push({ name: "data.location.agent.list", args })
            return fixtures.agents
          },
        },
        provider: {
          list: (...args) => {
            reads.push("data.location.provider.list")
            selectorCalls.push({ name: "data.location.provider.list", args })
            return fixtures.providers
          },
        },
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
  if (contextLocation) {
    Object.defineProperty(context, "location", {
      get() {
        reads.push("location")
        return fixtures.location
      },
    })
  }
  return { context, fixtures, reads, selectorCalls, renders, slotCalls }
}

const EXPECTED_HOST_READS = [
  "data.location.agent.list",
  "data.location.model.list",
  "data.location.provider.list",
  "data.session.get.title",
  "data.session.get.title",
  "data.session.list",
  "data.session.status:ses_b",
  "location",
]

function expectedSelectorCalls({ location, sessionIDs, slotSessionID }) {
  return [
    { name: "data.session.list", args: [] },
    { name: "data.location.model.list", args: [location] },
    { name: "data.location.agent.list", args: [location] },
    { name: "data.location.provider.list", args: [location] },
    { name: "data.session.status", args: [slotSessionID] },
    ...sessionIDs.map((id) => ({ name: "data.session.get", args: [id] })),
  ]
}

describe("#given the host read census", () => {
  test("#then one render performs exactly the passive read set, with status only for the slot identity", () => {
    const census = censusContext({
      sessions: [{ id: "ses_a" }, { id: "ses_b" }],
      titles: { ses_a: "Other", ses_b: "Selected" },
      statuses: { ses_a: "running", ses_b: "idle" },
      models: [{ id: "m" }],
      agents: [{ id: "a" }],
      providers: [{ id: "p" }],
    })
    createPanelSurface({ solid: stubSolid() }).setup(census.context)

    const node = census.renders[0]({ sessionID: "ses_b" })

    // A census over a render that never happened would prove nothing.
    expect(node.tag).toBe("text")
    expect([...census.reads].sort()).toEqual(EXPECTED_HOST_READS)
    expect(census.selectorCalls).toEqual(
      expectedSelectorCalls({
        location: census.fixtures.location,
        sessionIDs: ["ses_a", "ses_b"],
        slotSessionID: "ses_b",
      }),
    )
    // I-3's reactive read is not one-per-session: it is one, for the input identity.
    expect(census.reads.filter((read) => read.startsWith("data.session.status"))).toEqual(["data.session.status:ses_b"])
  })

  test("#then a second render repeats the same set with current values and selector arguments", () => {
    const census = censusContext({
      sessions: [{ id: "ses_a" }, { id: "ses_b" }],
      titles: { ses_a: "Other", ses_b: "Selected" },
      statuses: { ses_b: "idle" },
      models: [{ id: "first-model", name: "First model" }],
      agents: [{ id: "first-agent", name: "First agent" }],
      providers: [{ id: "first-provider", name: "First provider" }],
    })
    createPanelSurface({ solid: stubSolid() }).setup(census.context)

    const firstNode = census.renders[0]({ sessionID: "ses_b" })
    const firstText = firstNode.children[0]
    const firstLength = census.reads.length
    const firstCallLength = census.selectorCalls.length
    const firstRender = [...census.reads].sort()
    const firstCalls = census.selectorCalls.slice(0, firstCallLength)
    expect(firstRender).toEqual(EXPECTED_HOST_READS)
    expect(firstCalls).toEqual(
      expectedSelectorCalls({
        location: census.fixtures.location,
        sessionIDs: ["ses_a", "ses_b"],
        slotSessionID: "ses_b",
      }),
    )

    census.fixtures.location = { directory: "/second" }
    census.fixtures.sessions = [{ id: "ses_a" }, { id: "ses_b" }]
    census.fixtures.titles = { ses_a: "Current other", ses_b: "Current selected" }
    census.fixtures.statuses = { ses_b: "running" }
    census.fixtures.models = [{ id: "second-model", name: "Second model" }]
    census.fixtures.agents = [{ id: "second-agent", name: "Second agent" }]
    census.fixtures.providers = [{ id: "second-provider", name: "Second provider" }]

    const secondNode = census.renders[0]({ sessionID: "ses_b" })
    const secondText = secondNode.children[0]
    const secondRender = [...census.reads.slice(firstLength)].sort()
    const secondCalls = census.selectorCalls.slice(firstCallLength)

    expect(secondRender).toEqual(firstRender)
    expect(secondCalls).toEqual(
      expectedSelectorCalls({
        location: census.fixtures.location,
        sessionIDs: ["ses_a", "ses_b"],
        slotSessionID: "ses_b",
      }),
    )
    expect(secondText).not.toBe(firstText)
    expect(firstText).toContain("- Selected [idle]")
    expect(firstText).toContain("- First model")
    expect(firstText).toContain("- First agent")
    expect(firstText).toContain("- First provider")
    expect(secondText).toContain("- Current selected [running]")
    expect(secondText).toContain("- Second model")
    expect(secondText).toContain("- Second agent")
    expect(secondText).toContain("- Second provider")
    expect(secondText).not.toContain("Selected")
    expect(secondText).not.toContain("First model")
  })

  test("#then a host without a context location still costs exactly one location read", () => {
    const census = censusContext({ contextLocation: false, sessions: [{ id: "ses_b" }], statuses: { ses_b: "idle" } })
    createPanelSurface({ solid: stubSolid() }).setup(census.context)

    census.renders[0]({ sessionID: "ses_b" })

    expect(census.reads.filter((read) => read === "location")).toHaveLength(1)
  })
})

describe("#given an active session with an agent but no sourced model", () => {
  test("#then the active-agent block reaches the mounted node and the catalog never fills the gap", () => {
    const fake = fakeContext({
      sessions: [{ id: "ses_a", agent: "atlas" }],
      statuses: { ses_a: "running" },
      models: [{ id: "catalog-only", name: "Catalog-only" }],
    })
    createPanelSurface({ solid: stubSolid() }).setup(fake.context)

    const lines = renderedText(fake, { sessionID: "ses_a" }).split("\n")

    expect(lines).toContain("Active agents")
    expect(lines).toContain("  - atlas -")
    expect(lines).not.toContain("  - atlas Catalog-only")
  })

  test("#then an unread non-selected agent is not rendered as active", () => {
    const fake = fakeContext({
      sessions: [{ id: "ses_a", agent: "sisyphus" }, { id: "ses_b", agent: "atlas" }],
      statuses: { ses_a: "running", ses_b: "running" },
    })
    createPanelSurface({ solid: stubSolid() }).setup(fake.context)

    const lines = renderedText(fake, { sessionID: "ses_b" }).split("\n")

    expect(lines).toContain("  - atlas -")
    expect(lines).not.toContain("  - sisyphus -")
  })

  test("#then no agent block is rendered when the roster read is absent", () => {
    const fake = fakeContext({ sessions: undefined, models: [], agents: [], providers: [] })
    createPanelSurface({ solid: stubSolid() }).setup(fake.context)

    expect(renderedText(fake)).not.toContain("Active agents")
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
