import { describe, expect, test } from "bun:test"
import {
  ULTRAWORK_PATTERN,
  decideKeywordInjection,
  detectKeywordTypes,
  extractPromptText,
  getUltraworkSource,
  isGeminiModel,
  isGlmModel,
  isGptModel,
  isNonOmoAgent,
  isPlannerAgent,
  isSyntheticOrInternalOnlyTextParts,
  isSystemDirective,
  looksLikeSlashCommand,
  removeCodeBlocks,
  removeSystemReminders,
} from "./rigel-v2-keyword-core.mjs"
import { loadV1Oracle } from "./test-support/v1-oracle.mjs"

// Fixture message bodies: stand-ins for the V1 prompt texts T12 will pass in.
// Shape only matters for joined-guidance and already-injected assertions.
const MESSAGES = Object.freeze({
  ultrawork: "ULTRAWORK PROTOCOL BODY",
  team: "TEAM MODE BODY",
  hyperplan: "HYPERPLAN BODY",
  "hyperplan-ultrawork": "HYPERPLAN ULTRAWORK BODY",
})

function decide(text, overrides = {}) {
  const texts = Array.isArray(text) ? text : [text]
  return decideKeywordInjection({
    parts: texts.map((part) => ({ type: "text", text: part })),
    messageTexts: MESSAGES,
    ...overrides,
  })
}

describe("Rigel V2 keyword core: exact V1 patterns", () => {
  test("ultrawork matches ultrawork and ulw, and rejects ultraworker", () => {
    // given / when / then
    expect(ULTRAWORK_PATTERN.test("do ultrawork now")).toBe(true)
    expect(ULTRAWORK_PATTERN.test("ULW")).toBe(true)
    expect(ULTRAWORK_PATTERN.test("ultraworker")).toBe(false)
    expect(ULTRAWORK_PATTERN.test("ultraworkers")).toBe(false)
  })

  test("hyperplan shorthand rejects dotted file extensions", () => {
    // given / when / then
    expect(detectKeywordTypes("interface.hpp")).toEqual([])
    expect(detectKeywordTypes("src/buffer.hpp")).toEqual([])
    expect(detectKeywordTypes("buffer.HPP")).toEqual([])
    expect(detectKeywordTypes("hpp now")).toEqual(["hyperplan"])
    expect(detectKeywordTypes("x-hpp")).toEqual(["hyperplan"])
  })

  test("combo requires strict adjacency in both orders", () => {
    // given / when / then
    expect(detectKeywordTypes("hpp ulw")).toEqual(["ultrawork", "hyperplan", "hyperplan-ultrawork"])
    expect(detectKeywordTypes("ulw hpp")).toEqual(["ultrawork", "hyperplan", "hyperplan-ultrawork"])
    expect(detectKeywordTypes("hpp do ulw")).toEqual(["ultrawork", "hyperplan"])
    // `\s+` keeps multi-space adjacency
    expect(detectKeywordTypes("hyperplan  ultrawork")).toEqual(["ultrawork", "hyperplan", "hyperplan-ultrawork"])
  })
})

describe("Rigel V2 keyword core: detect gating", () => {
  const corpus = [
    { name: "ultrawork", text: "do ultrawork now", expected: ["ultrawork"] },
    { name: "ulw", text: "ulw", expected: ["ultrawork"] },
    { name: "uppercase", text: "PLEASE ULTRAWORK", expected: ["ultrawork"] },
    { name: "ultraworker negative", text: "ultraworker", expected: [] },
    { name: "team mode", text: "use team mode", expected: ["team"] },
    { name: "team-mode", text: "team-mode", expected: ["team"] },
    { name: "team_mode", text: "team_mode", expected: ["team"] },
    { name: "teammode", text: "teammode", expected: ["team"] },
    { name: "bare team is not a keyword", text: "team esto es una prueba de palabra clave", expected: [] },
    { name: "team double space is not team mode", text: "team  mode", expected: [] },
    { name: "hyperplan", text: "hyperplan this", expected: ["hyperplan"] },
    { name: "hpp", text: "hpp", expected: ["hyperplan"] },
    { name: ".hpp path", text: "interface.hpp", expected: [] },
    { name: "combo", text: "hpp ulw", expected: ["ultrawork", "hyperplan", "hyperplan-ultrawork"] },
    { name: "non adjacent", text: "hpp do ulw", expected: ["ultrawork", "hyperplan"] },
    { name: "fenced code block", text: "```\nultrawork\n```", expected: [] },
    { name: "inline code", text: "`ulw`", expected: [] },
    { name: "code then prose", text: "```\nulw\n```\nbut team mode yes", expected: ["team"] },
    { name: "combined", text: "ulw team mode", expected: ["ultrawork", "team"] },
    { name: "disabled team", text: "ulw team mode", disabled: ["team"], expected: ["ultrawork"] },
    { name: "disabled ultrawork drops combo but keeps hyperplan", text: "ulw hpp", disabled: ["ultrawork"], expected: ["hyperplan"] },
    { name: "disabled hyperplan drops combo but keeps ultrawork", text: "ulw hpp", disabled: ["hyperplan"], expected: ["ultrawork"] },
    { name: "disabled both base keywords", text: "ulw hpp", disabled: ["ultrawork", "hyperplan"], expected: [] },
    { name: "allowlist keeps only team", text: "ulw hpp team mode", enabled: ["team"], expected: ["team"] },
    { name: "empty allowlist blocks all", text: "ulw hpp team mode", enabled: [], expected: [] },
    { name: "allowlist keeps only combo", text: "hpp ulw team mode", enabled: ["hyperplan-ultrawork"], expected: ["hyperplan-ultrawork"] },
  ]

  test("detectKeywordTypes matches the table over the corpus", () => {
    for (const row of corpus) {
      // given
      const options = { disabledKeywords: row.disabled, enabledExpansions: row.enabled }

      // when
      const actual = detectKeywordTypes(row.text, options)

      // then
      expect(actual, row.name).toEqual(row.expected)
    }
  })

  test("does not mutate the disabled or enabled config arrays", () => {
    // given
    const disabled = ["ultrawork"]
    const enabled = ["team"]

    // when
    detectKeywordTypes("ulw hpp team mode", { disabledKeywords: disabled, enabledExpansions: enabled })

    // then
    expect(disabled).toEqual(["ultrawork"])
    expect(enabled).toEqual(["team"])
  })

  test("differential: detectKeywordTypes agrees with the V1 detector across the corpus", async () => {
    // given
    const oracle = await loadV1Oracle("keyword-detector.detector")

    // then: the oracle verdict is recorded; parity is only claimed from the real V1 core
    expect(oracle.source).toBe("v1")
    expect(oracle.degraded).toBe(false)
    for (const row of corpus) {
      // when
      const ours = detectKeywordTypes(row.text, { disabledKeywords: row.disabled, enabledExpansions: row.enabled })
      const v1 = oracle.module
        .detectKeywordsWithType(row.text, undefined, undefined, row.disabled, row.enabled)
        .map((keyword) => keyword.type)

      // then
      expect(v1, `V1 parity: ${row.name}`).toEqual(ours)
    }
  })
})

describe("Rigel V2 keyword core: prompt extraction and text guards", () => {
  test("extractPromptText keeps only real text parts and joins with a single space", () => {
    // given
    const parts = [
      { type: "text", text: "first" },
      { type: "file", path: "/tmp/x" },
      { type: "text", text: "second", synthetic: true },
      { type: "text", text: "third\n<!-- OMO_INTERNAL_INITIATOR -->" },
      { type: "text", text: "fourth" },
    ]

    // when
    const text = extractPromptText(parts)

    // then
    expect(text).toBe("first fourth")
    expect(isSyntheticOrInternalOnlyTextParts(parts)).toBe(false)
  })

  test("synthetic or internal-only parts are recognized as fully injected", () => {
    // given / when / then
    expect(isSyntheticOrInternalOnlyTextParts([{ type: "text", text: "ulw", synthetic: true }])).toBe(true)
    expect(isSyntheticOrInternalOnlyTextParts([{ type: "text", text: "ulw\n<!-- OMO_INTERNAL_INITIATOR -->" }])).toBe(true)
    expect(isSyntheticOrInternalOnlyTextParts([{ type: "file", path: "x" }])).toBe(false)
    expect(isSyntheticOrInternalOnlyTextParts([])).toBe(false)
  })

  test("plugin handoff reports do not activate keyword modes while user requests still do", () => {
    // given a background handoff or child task injected as a user message
    const reports = [
      "<rigel-native-background-result>\nagent: explore\nreport mentions ultrawork-default.md, hyperplan.md, and team-mode\n</rigel-native-background-result>",
      "  <rigel-native-child-task>\nplease use ultrawork and team mode\n</rigel-native-child-task>",
    ]

    // when the native keyword decision scans those injected messages
    for (const report of reports) {
      const result = decide(report)

      // then no mode is inferred from plugin output
      expect(result.types).toEqual([])
      expect(result.reason).toBe("synthetic-internal-only")
    }

    // Positive control: explicit user intent remains active.
    expect(decide("ulw fix the parser").types).toContain("ultrawork")
  })

  test("differential: extractPromptText agrees with the V1 detector", async () => {
    // given
    const oracle = await loadV1Oracle("keyword-detector.detector")
    const rows = [
      [{ type: "text", text: "first" }, { type: "text", text: "second" }],
      [{ type: "text", text: "first", synthetic: true }, { type: "text", text: "second" }],
      [{ type: "text", text: "first\n<!-- OMO_INTERNAL_INITIATOR -->" }, { type: "text", text: "second" }],
      [{ type: "file", path: "x" }, { type: "text", text: "hello" }],
    ]

    // then
    expect(oracle.source).toBe("v1")
    for (const parts of rows) {
      expect(oracle.module.extractPromptText(parts)).toBe(extractPromptText(parts))
    }
  })

  test("system directives are detected with and without a leading mode keyword", () => {
    // given / when / then
    expect(isSystemDirective("[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]")).toBe(true)
    expect(isSystemDirective("  [SYSTEM DIRECTIVE: OH-MY-OPENCODE - X] ulw")).toBe(true)
    expect(isSystemDirective("ulw [SYSTEM DIRECTIVE: OH-MY-OPENCODE - X]")).toBe(true)
    expect(isSystemDirective("please continue ulw")).toBe(false)
  })

  test("system reminders are stripped and slash commands recognized", () => {
    // given / when / then
    expect(removeSystemReminders("<system-reminder>ulw</system-reminder> team mode")).toBe("team mode")
    expect(removeSystemReminders("plain ulw")).toBe("plain ulw")
    expect(looksLikeSlashCommand("/help ulw")).toBe(true)
    expect(looksLikeSlashCommand("/stop-continuation now")).toBe(true)
    expect(looksLikeSlashCommand("please /help")).toBe(false)
    expect(looksLikeSlashCommand("/1bad")).toBe(false)
  })

  test("code blocks are removed fence-first and inline-second", () => {
    // given / when / then
    expect(removeCodeBlocks("```\nultrawork\n```\n`ulw` team mode")).toBe("\n team mode")
    expect(detectKeywordTypes("```\n`ulw`\n```")).toEqual([])
  })

  test("differential: removeCodeBlocks and looksLikeSlashCommand agree with V1", async () => {
    // given
    const oracle = await loadV1Oracle("keyword-detector.detector")
    const codeRows = ["```\nulw\n```", "`ulw`", "```\n`ulw`\n``` team mode", "plain ulw", "\n\ncode"]
    const slashRows = ["/help ulw", "/stop-continuation now", "please /help", "/1bad", "/a-b_c d", "  /x"]

    // then
    expect(oracle.source).toBe("v1")
    for (const text of codeRows) {
      expect(oracle.module.removeCodeBlocks(text)).toBe(removeCodeBlocks(text))
    }
    for (const text of slashRows) {
      expect(oracle.module.looksLikeSlashCommand(text)).toBe(looksLikeSlashCommand(text))
    }
  })
})

describe("Rigel V2 keyword core: agent and model routing", () => {
  test("planner and non-OMO agent detection matches the V1 matrix", () => {
    // given
    const plannerAgents = ["prometheus", "Prometheus - Plan Builder", "planner", "plan", "plan-mode", "plan_mode", "PLAN"]
    const nonPlannerAgents = ["sisyphus", "myplan", "replan", "planning", "general"]
    const nonOmoAgents = ["builder", "Builder", "general-builder", "plan", "Plan"]
    const omoAgents = ["plan-mode", "planning", "sisyphus", ""]

    // when / then
    for (const agent of plannerAgents) expect(isPlannerAgent(agent), agent).toBe(true)
    for (const agent of nonPlannerAgents) expect(isPlannerAgent(agent), agent).toBe(false)
    for (const agent of nonOmoAgents) expect(isNonOmoAgent(agent), agent).toBe(true)
    for (const agent of omoAgents) expect(isNonOmoAgent(agent), agent).toBe(false)
  })

  test("model family predicates use the last slug segment", () => {
    // given / when / then
    expect(isGptModel("openai/gpt-5.2")).toBe(true)
    expect(isGptModel("openrouter/x-gpt-y")).toBe(true)
    expect(isGptModel("gpt-host/claude-sonnet")).toBe(false)
    expect(isGlmModel("zai/glm-5")).toBe(true)
    expect(isGlmModel("zai/claude")).toBe(false)
    expect(isGeminiModel("google/gemini-3-pro")).toBe(true)
    expect(isGeminiModel("google-vertex/gemini-2.5-flash")).toBe(true)
    expect(isGeminiModel("github-copilot/gemini-2.5-pro")).toBe(true)
    expect(isGeminiModel("github-copilot/claude-sonnet-4")).toBe(false)
    expect(isGeminiModel("gemini-3-pro")).toBe(true)
    expect(isGeminiModel("gemini")).toBe(false)
  })

  test("source routing resolves planner before model family", () => {
    // given / when / then
    expect(getUltraworkSource("prometheus", "anthropic/claude-opus-5")).toBe("planner")
    expect(getUltraworkSource("plan-mode", undefined)).toBe("planner")
    expect(getUltraworkSource("sisyphus", "openai/gpt-5.2")).toBe("gpt")
    expect(getUltraworkSource("sisyphus", "google/gemini-3-pro")).toBe("gemini")
    expect(getUltraworkSource("sisyphus", "zai/glm-5")).toBe("glm")
    expect(getUltraworkSource("sisyphus", "anthropic/claude-sonnet-4-6")).toBe("default")
    expect(getUltraworkSource(undefined, undefined)).toBe("default")
  })

  test("differential: agent/model routing agrees with the V1 source detector", async () => {
    // given
    const oracle = await loadV1Oracle("keyword-detector.ultrawork.source-detector")
    const agents = [undefined, "", "sisyphus", "prometheus", "my_planner", "plan-mode", "plan", "planning"]
    const models = [
      undefined,
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5.2",
      "google/gemini-3-pro",
      "google-vertex/gemini-2.5-flash",
      "github-copilot/gemini-2.5-pro",
      "zai/glm-5",
    ]

    // then
    expect(oracle.source).toBe("v1")
    for (const agent of agents) {
      expect(oracle.module.isPlannerAgent(agent)).toBe(isPlannerAgent(agent))
      expect(oracle.module.isNonOmoAgent(agent)).toBe(isNonOmoAgent(agent))
      for (const model of models) {
        expect(oracle.module.getUltraworkSource(agent, model)).toBe(getUltraworkSource(agent, model))
      }
    }
  })
})

describe("Rigel V2 keyword core: decision pipeline", () => {
  test("synthetic-only and internal-only parts are ignored", () => {
    // given / when / then
    const synthetic = decideKeywordInjection({
      parts: [{ type: "text", text: "ulw", synthetic: true }],
      messageTexts: MESSAGES,
    })
    expect(synthetic.action).toBe("ignore")
    expect(synthetic.reason).toBe("synthetic-internal-only")
    expect(synthetic.types).toEqual([])

    const internal = decideKeywordInjection({
      parts: [{ type: "text", text: "ulw\n<!-- OMO_INTERNAL_INITIATOR -->" }],
      messageTexts: MESSAGES,
    })
    expect(internal.reason).toBe("synthetic-internal-only")
  })

  test("mixed parts keep only the real text for detection", () => {
    // given
    const parts = [
      { type: "text", text: "ulw", synthetic: true },
      { type: "text", text: "team mode" },
    ]

    // when
    const decision = decideKeywordInjection({ parts, messageTexts: MESSAGES })

    // then
    expect(decision.action).toBe("inject")
    expect(decision.types).toEqual(["team"])
  })

  test("system directive and slash command invocations are ignored", () => {
    // given / when / then
    expect(decide("[SYSTEM DIRECTIVE: OH-MY-OPENCODE - X] ulw").reason).toBe("system-directive")
    expect(decide("ulw [SYSTEM DIRECTIVE: OH-MY-OPENCODE - X]").reason).toBe("system-directive")
    const slash = decide("/help ulw")
    expect(slash.action).toBe("ignore")
    expect(slash.reason).toBe("slash-command")
    expect(slash.clearExplicit).toBe(false)
  })

  test("/stop-continuation clears the explicit session record and injects nothing", () => {
    // given / when
    const decision = decide("/stop-continuation")

    // then
    expect(decision.action).toBe("ignore")
    expect(decision.reason).toBe("slash-command")
    expect(decision.clearExplicit).toBe(true)
  })

  test("non-OMO agents never receive keyword injection", () => {
    // given / when / then
    expect(decide("ulw", { agent: "builder" }).reason).toBe("non-omo-agent")
    expect(decide("ulw", { agent: "Plan" }).reason).toBe("non-omo-agent")
  })

  test("planner agents drop ultrawork, hyperplan, and the combo but keep team", () => {
    // given / when
    const decision = decide("ulw hpp team mode", { agent: "prometheus" })

    // then
    expect(decision.action).toBe("inject")
    expect(decision.types).toEqual(["team"])
  })

  test("planner agents with only ultrawork end ignored", () => {
    // given / when / then
    expect(decide("ulw", { agent: "plan-mode" }).reason).toBe("no-keywords")
  })

  test("subagent sessions return before any injection", () => {
    // given / when
    const decision = decide("ulw", { isSubagentSession: true })

    // then
    expect(decision.action).toBe("ignore")
    expect(decision.reason).toBe("subagent-session")
  })

  test("non-main sessions keep only ultrawork and the combo", () => {
    // given / when
    const withUw = decide("ulw team mode", { isNonMainSession: true })
    const teamOnly = decide("team mode", { isNonMainSession: true })

    // then
    expect(withUw.action).toBe("inject")
    expect(withUw.types).toEqual(["ultrawork"])
    expect(teamOnly.action).toBe("ignore")
    expect(teamOnly.reason).toBe("non-main-filtered")
  })

  test("already injected guidance is not injected twice", () => {
    // given / when
    const decision = decide("please ULTRAWORK PROTOCOL BODY again")

    // then
    expect(decision.action).toBe("ignore")
    expect(decision.reason).toBe("already-injected")
  })

  test("default ultrawork activates once for main sessions only", () => {
    // given / when
    const activated = decide("hello", { defaultUltrawork: true })
    const already = decide("hello", { defaultUltrawork: true, defaultModeInjected: true })
    const nonMain = decide("hello", { defaultUltrawork: true, isNonMainSession: true })
    const disabled = decide("hello")

    // then
    expect(activated.action).toBe("default-mode")
    expect(activated.rememberDefaultMode).toBe(true)
    expect(already.reason).toBe("no-keywords")
    expect(nonMain.reason).toBe("no-keywords")
    expect(disabled.reason).toBe("no-keywords")
  })

  test("empty enabled_expansions blocks every keyword", () => {
    // given / when
    const decision = decide("ulw hpp team mode", { enabledExpansions: [] })

    // then
    expect(decision.action).toBe("ignore")
    expect(decision.reason).toBe("no-keywords")
  })

  test("code blocks never trigger the decision", () => {
    // given / when / then
    expect(decide("```\nulw\n```").reason).toBe("no-keywords")
    expect(decide("`ulw`").reason).toBe("no-keywords")
  })

  test("ultraworker never activates ultrawork", () => {
    // given / when
    const decision = decide("ultraworker")

    // then
    expect(decision.action).toBe("ignore")
    expect(decision.types).toEqual([])
  })
})

describe("Rigel V2 keyword core: combo suppression", () => {
  test("combo suppresses standalone ultrawork and hyperplan in both orders", () => {
    // given / when
    const first = decide("hpp ulw")
    const second = decide("ulw hpp")

    // then
    expect(first.types).toEqual(["hyperplan-ultrawork"])
    expect(second.types).toEqual(["hyperplan-ultrawork"])
    expect(first.toast).toEqual({ ultrawork: false, hyperplan: false, hyperplanUltrawork: true })
  })

  test("non-adjacent hpp and ulw stay standalone", () => {
    // given / when
    const decision = decide("hpp do ulw")

    // then
    expect(decision.types).toEqual(["ultrawork", "hyperplan"])
    expect(decision.toast).toEqual({ ultrawork: true, hyperplan: true, hyperplanUltrawork: false })
  })

  test("disabling one base keyword disables the combo but keeps the other base", () => {
    // given / when
    const ultraworkOff = decide("ulw hpp", { disabledKeywords: ["ultrawork"] })
    const hyperplanOff = decide("ulw hpp", { disabledKeywords: ["hyperplan"] })
    const bothOff = decide("ulw hpp", { disabledKeywords: ["ultrawork", "hyperplan"] })

    // then
    expect(ultraworkOff.types).toEqual(["hyperplan"])
    expect(hyperplanOff.types).toEqual(["ultrawork"])
    expect(bothOff.action).toBe("ignore")
    expect(bothOff.reason).toBe("no-keywords")
  })

  test("hyperplan shorthand alone injects the hyperplan body", () => {
    // given / when
    const decision = decide("hpp")

    // then
    expect(decision.types).toEqual(["hyperplan"])
    expect(decision.allMessages).toBe(MESSAGES.hyperplan)
    expect(decision.toast.hyperplan).toBe(true)
  })

  test("combined standalone bodies join in detector order with a blank line", () => {
    // given / when
    const decision = decide("hpp do ulw")

    // then
    expect(decision.allMessages).toBe(`${MESSAGES.ultrawork}\n\n${MESSAGES.hyperplan}`)
  })
})

describe("Rigel V2 keyword core: replay and compaction state transitions", () => {
  test("a live explicit record replays compact ultrawork without full guidance", () => {
    // given / when
    const decision = decide("continue the work", {
      activeUltrawork: { source: "default", needsRestoration: false },
    })

    // then
    expect(decision.action).toBe("inject")
    expect(decision.types).toEqual(["ultrawork"])
    expect(decision.replayUltrawork).toBe(true)
    expect(decision.explicitUltrawork).toBe(false)
    expect(decision.compactUltrawork).toBe(true)
    expect(decision.continuationMarker).toBe(true)
    expect(decision.requiresFullGuidance).toBe(false)
    expect(decision.allMessages).toBe("")
    expect(decision.explicitPersistence).toBe(true)
    expect(decision.toast.ultrawork).toBe(false)
  })

  test("a record marked for restoration replays the full guidance", () => {
    // given / when
    const decision = decide("continue the work", {
      activeUltrawork: { source: "default", needsRestoration: true },
    })

    // then
    expect(decision.action).toBe("inject")
    expect(decision.replayUltrawork).toBe(true)
    expect(decision.compactUltrawork).toBe(false)
    expect(decision.continuationMarker).toBe(false)
    expect(decision.requiresFullGuidance).toBe(true)
    expect(decision.allMessages).toBe(MESSAGES.ultrawork)
    expect(decision.explicitPersistence).toBe(true)
  })

  test("a source mismatch disables the compact replay", () => {
    // given / when
    const decision = decide("continue the work", {
      activeUltrawork: { source: "gpt", needsRestoration: false },
    })

    // then
    expect(decision.promptSource).toBe("default")
    expect(decision.replayUltrawork).toBe(true)
    expect(decision.compactUltrawork).toBe(false)
    expect(decision.requiresFullGuidance).toBe(true)
  })

  test("an explicit keyword wins over replay and compacts when the source matches", () => {
    // given / when
    const decision = decide("ulw", {
      activeUltrawork: { source: "default", needsRestoration: false },
    })

    // then
    expect(decision.explicitUltrawork).toBe(true)
    expect(decision.replayUltrawork).toBe(false)
    expect(decision.compactUltrawork).toBe(true)
    expect(decision.continuationMarker).toBe(true)
    expect(decision.requiresFullGuidance).toBe(false)
    expect(decision.toast.ultrawork).toBe(true)
  })

  test("team-only decisions never persist an explicit ultrawork record", () => {
    // given / when
    const decision = decide("team mode")

    // then
    expect(decision.action).toBe("inject")
    expect(decision.explicitPersistence).toBe(false)
  })
})
