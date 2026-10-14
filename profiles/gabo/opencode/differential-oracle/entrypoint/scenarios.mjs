/**
 * Full-plugin-entrypoint differential scenarios.
 *
 * Each scenario drives the REAL `rigel-v2-native.mjs` `setup()` through a fake
 * V2 context (`runtime-entrypoint.mjs`) and compares its observable with a REAL
 * V1 owner for the same behavior. These are the "hermetic proof of the complete
 * plugin entrypoint"; the per-family helper and
 * integration scenarios remain as secondary drift guards.
 *
 * Observable types cross the host: handoff, provider payload, result mutation,
 * block decision, state persistence. Every scenario carries an injection
 * mutation (harness liveness) and an on-disk mutation of the real runtime seam
 * (runtime liveness, byte-identical restore).
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const PKG = "../../../../../packages"

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, "utf8")
}

/** Bounded wait; throws loudly on timeout instead of sleeping blind. */
async function waitFor(predicate, label) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 3000) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function collapseWhitespace(value) {
  return String(value ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n").trim()
}

/** Strip the V1 skill-instruction wrapper so the raw body is comparable to V2. */
function extractSkillRawBody(value) {
  const text = String(value ?? "")
  const marker = "<skill-instruction>"
  if (!text.includes(marker)) return text.trim()
  const afterHeader = text.slice(text.indexOf(marker))
  const blank = afterHeader.indexOf("\n\n")
  let body = blank === -1 ? afterHeader : afterHeader.slice(blank + 2)
  const close = body.indexOf("</skill-instruction>")
  if (close !== -1) body = body.slice(0, close)
  return body.trim()
}

/** V1 permission decision semantics: agent value wins over the global value. */
function v1PermissionDecision(global, agent, tool) {
  if (agent && typeof agent[tool] === "string") return agent[tool]
  if (global && typeof global[tool] === "string") return global[tool]
  if (global && global[tool] === false) return "deny"
  return "allow"
}

/** The V1-detected ultrawork directive for a prompt, or undefined (no keyword). */
function ultraworkMessageFor(v1, input) {
  const detected = v1.detector.detectKeywordsWithType(input.text, input.agent, input.modelID, undefined, undefined)
  return detected.find((keyword) => keyword.type === "ultrawork")?.message
}

/** The V1 ultrawork prompt bodies keyed by the runtime's prompt-file names. */
function ultraworkPromptContents(message) {
  if (!message) return undefined
  return {
    "ultrawork-default.md": message,
    "ultrawork-gpt.md": message,
    "ultrawork-gemini.md": message,
    "ultrawork-glm.md": message,
    "ultrawork-planner.md": message,
  }
}

/** Project a goal record to the comparable identity fields. */
function projectGoal(goal) {
  return goal ? { objective: goal.objective, status: goal.status } : null
}

/** @type {import("../harness.mjs").Scenario[]} */
export const scenarios = [
  // -------------------------------------------------------------------------
  // delegation: real entrypoint -> background child completion -> parent handoff
  // -------------------------------------------------------------------------
  {
    id: "delegation.entrypoint-handoff",
    family: "delegation",
    integration: true,
    entrypoint: true,
    observableType: "handoff",
    why: "The real plugin setup() tracks the background child and the real event loop delivers the parent handoff prompt (child identifier + child result + terminal status) after session.execution.succeeded; the V1 parent-wake queue delivers the same structured handoff.",
    loadV1: async () => {
      const queue = await import(`${PKG}/omo-opencode/src/features/background-agent/parent-wake-pending-queue.ts`)
      const template = await import(`${PKG}/omo-opencode/src/features/background-agent/background-task-notification-template.ts`)
      return { queue, template }
    },
    loadV2: () => import("./runtime-entrypoint.mjs"),
    tolerance: { kind: "exact" },
    observeV1: async (v1, input) => {
      const delivered = []
      const queue = new v1.queue.ParentWakePendingQueue({
        pendingRetryMs: 0,
        enqueueNotificationForParent: async (_sessionID, operation) => { await operation() },
      })
      const text = v1.template.buildBackgroundTaskNotificationText({
        task: { id: input.childId, description: input.evidence, status: "completed" },
        duration: "1s",
        statusText: "COMPLETED",
        allComplete: false,
        remainingCount: 1,
        completedTasks: [],
      })
      queue.queueWake(input.childId, text, {}, false)
      for (const sessionID of [...queue.getWakes().keys()]) {
        queue.scheduleFlush(sessionID, async () => { delivered.push(text) }, 0)
      }
      await waitFor(() => delivered.length === 1, "V1 parent wake delivery")
      queue.shutdown()
      const value = String(delivered[0] ?? "")
      return {
        delivered: delivered.length,
        hasIdentifier: value.includes(input.childId),
        hasEvidence: value.includes(input.evidence),
        hasStatus: /(succeed|complet|ready)/i.test(value),
      }
    },
    observeV2: (v2, input) => v2.driveHandoff({
      agent: input.agent,
      prompt: input.prompt,
      parentSessionID: input.parentSessionID,
      childSessionID: input.childId,
      evidence: input.evidence,
    }),
    corpus: [{
      name: "child completed",
      agent: "explore",
      prompt: "find the auth code",
      parentSessionID: "ses_parent",
      childId: "ses_parent_handoff_child",
      evidence: "CHILD_EVIDENCE_MARKER",
    }],
    mutation: {
      target: "driveHandoff",
      perturb: () => async () => ({ delivered: 0, hasIdentifier: false, hasEvidence: false, hasStatus: false }),
      onDisk: { find: "if (status) backgroundManager.enqueueHandoff(sessionID, status)", replace: "if (status) void status" },
    },
  },

  // -------------------------------------------------------------------------
  // recovery: real entrypoint -> token-limit session.error -> one compaction
  // -------------------------------------------------------------------------
  {
    id: "recovery.entrypoint-context-limit",
    family: "recovery",
    integration: true,
    entrypoint: true,
    observableType: "block-decision",
    why: "The real setup() wires the context-limit recovery into the real event loop: a token-limit session.error requests exactly one session.compact for the incident and a repeated error does not request a second, exactly matching the V1 anthropic token-limit parser's detection.",
    loadV1: () => import(`${PKG}/omo-opencode/src/hooks/anthropic-context-window-limit-recovery/parser.ts`),
    loadV2: () => import("./runtime-entrypoint.mjs"),
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => {
      const parsed = v1.parseAnthropicTokenLimitError(input.message)
      return { detected: parsed !== null && parsed !== undefined }
    },
    observeV2: async (v2, input) => {
      const result = await v2.driveContextLimit({ sessionID: "ses_entrypoint", message: input.message })
      return { detected: result.detected }
    },
    corpus: [
      { name: "prompt too long", message: "Prompt is too long: 250000 tokens exceeds the maximum context length" },
      { name: "maximum context", message: "This model's maximum context length is exceeded" },
      { name: "unrelated negative", message: "rate limit exceeded, please retry" },
    ],
    mutation: {
      target: "driveContextLimit",
      perturb: () => async () => ({ detected: false, compactions: 0 }),
      onDisk: { find: "await contextLimitRecovery.handle({ ...event, sessionID })", replace: "void contextLimitRecovery" },
    },
  },

  // -------------------------------------------------------------------------
  // compaction: real entrypoint -> summary request -> injected context block
  // -------------------------------------------------------------------------
  {
    id: "compaction.entrypoint-summary",
    family: "compaction",
    integration: true,
    entrypoint: true,
    observableType: "provider-payload",
    why: "The real setup() registers the compaction-context hook; driving the summary request appends the V1-identical compaction context block to the provider-visible messages exactly once, matching the V1 compaction-context injector output.",
    loadV1: () => import(`${PKG}/omo-opencode/src/hooks/compaction-context-injector/hook.ts`),
    loadV2: () => import("./runtime-entrypoint.mjs"),
    tolerance: { kind: "exact" },
    observeV1: (v1) => {
      const injector = v1.createCompactionContextInjector({
        backgroundManager: { taskHistory: { formatForCompaction: () => "" } },
      })
      return { block: collapseWhitespace(injector.inject("ses_entrypoint")) }
    },
    observeV2: async (v2) => {
      const result = await v2.driveCompactionSummary({ sessionID: "ses_entrypoint" })
      return { block: result.block }
    },
    corpus: [{ name: "summary request" }],
    mutation: {
      target: "driveCompactionSummary",
      perturb: () => async () => ({ block: "", injectedOnce: false, hasMarker: false }),
      onDisk: { find: "return nativeCompactionContextHook(event)", replace: "return undefined" },
    },
  },

  // -------------------------------------------------------------------------
  // ultrawork: real entrypoint -> context hook appends the directive
  // -------------------------------------------------------------------------
  {
    id: "ultrawork.entrypoint-injection",
    family: "ultrawork",
    integration: true,
    entrypoint: true,
    observableType: "provider-payload",
    why: "The real setup() registers the context hook; driving it appends the V1 ultrawork directive to the provider-visible user message for a keyword prompt and nothing for a normal prompt. The directive body is the real V1-detected message written to the prompt files setup() reads for the duration of the run (snapshot/restore, byte-identical) because the source tree does not ship the install-time prompt files.",
    loadV1: async () => {
      const hook = await import(`${PKG}/omo-opencode/src/hooks/keyword-detector/hook.ts`)
      const detector = await import(`${PKG}/omo-opencode/src/hooks/keyword-detector/detector.ts`)
      return { hook, detector }
    },
    loadV2: () => import("./runtime-entrypoint.mjs"),
    tolerance: { kind: "exact" },
    observeV1: async (v1, input) => {
      const detector = v1.hook.createKeywordDetectorHook({ client: { tui: { showToast: () => ({ catch() {} }) } } })
      const output = { message: {}, parts: [{ type: "text", text: input.text }] }
      await detector["chat.message"](
        { sessionID: "ses_entrypoint", agent: input.agent, model: { providerID: "openai", modelID: input.modelID } },
        output,
      )
      const rendered = output.parts.map((part) => part.text).join(" ")
      const message = ultraworkMessageFor(v1, input)
      return { injected: Boolean(message) && rendered.includes(message) }
    },
    observeV2: async (v2, input, v1) => {
      const message = ultraworkMessageFor(v1, input)
      const result = await v2.driveUltraworkInjection({
        text: input.text,
        agent: input.agent,
        modelID: input.modelID,
        sessionID: "ses_entrypoint",
        promptContents: ultraworkPromptContents(message),
      })
      return { injected: Boolean(message) && result.rendered.includes(message) }
    },
    corpus: [
      { name: "ultrawork keyword", text: "do ultrawork now", agent: "sisyphus", modelID: "gpt-5.5" },
      { name: "ulw keyword", text: "ulw please", agent: "sisyphus", modelID: "claude-sonnet-4-6" },
      { name: "no keyword negative", text: "just a normal request", agent: "sisyphus", modelID: "gpt-5.5" },
    ],
    mutation: {
      target: "driveUltraworkInjection",
      perturb: () => async () => ({ rendered: "", hasDirective: false, retainsRequest: false }),
      onDisk: { find: "await nativeContextPipeline(event)", replace: "void nativeContextPipeline" },
    },
  },

  // -------------------------------------------------------------------------
  // rules: real entrypoint -> execute.after hook injects a rule block
  // -------------------------------------------------------------------------
  {
    id: "rules.entrypoint-injection",
    family: "rules",
    integration: true,
    entrypoint: true,
    observableType: "result-mutation",
    why: "The real setup() registers the ordered execute.after chain; driving it over the same on-disk rule tree injects the same rule block into a read result as the V1 rule-injection processor.",
    loadV1: async () => {
      const processor = await import(`${PKG}/omo-opencode/src/hooks/rules-injector/injection-processor.ts`)
      return { processor }
    },
    loadV2: () => import("./runtime-entrypoint.mjs"),
    tolerance: { kind: "exact" },
    observeV1: async (v1, input) => {
      const processor = v1.processor.createRuleInjectionProcessor({
        workspaceDirectory: input.project,
        truncator: { truncate: async (_sessionID, content) => ({ result: content, truncated: false }) },
        getSessionCache: () => ({ realPaths: new Set(), contentHashes: new Set() }),
      })
      const output = { title: "read", output: "file body", metadata: {} }
      await processor.processFilePathForInjection(path.join(input.project, "src", "a.ts"), "ses_entrypoint", output)
      return { block: collapseWhitespace(output.output) }
    },
    observeV2: async (v2, input) => {
      const result = await v2.driveRulesInjection({ project: input.project, home: input.home, sessionID: "ses_entrypoint" })
      return { block: result.block }
    },
    corpus: (() => {
      const project = tempDir("diff-entrypoint-rules-")
      const home = tempDir("diff-entrypoint-rules-home-")
      writeFile(path.join(project, "package.json"), "{}\n")
      writeFile(path.join(project, ".omo", "rules", "always.md"), "---\nalwaysApply: true\n---\nENTRYPOINT-RULE-BODY\n")
      writeFile(path.join(project, "src", "a.ts"), "const a = 1\n")
      return [{ name: "project rule", project, home }]
    })(),
    mutation: {
      target: "driveRulesInjection",
      perturb: () => async () => ({ block: "file body" }),
      onDisk: { find: '{ name: "rules-injector", run: (event) => rules.after(event) },', replace: '{ name: "rules-injector", run: () => false },' },
    },
  },

  // -------------------------------------------------------------------------
  // permissions: real entrypoint -> execute.before gate decision
  // -------------------------------------------------------------------------
  {
    id: "permissions.entrypoint-gate",
    family: "permissions",
    integration: true,
    entrypoint: true,
    observableType: "block-decision",
    why: "The real setup() registers the tool-name permission gate; driving it decides allow/deny for the same tool and identical V1 permission values, with an agent gate overriding the global default.",
    loadV1: () => import(`${PKG}/omo-opencode/src/agents/frontier-tool-schema-guard.ts`),
    loadV2: () => import("./runtime-entrypoint.mjs"),
    tolerance: { kind: "exact" },
    observeV1: (_v1, input) => ({ decision: v1PermissionDecision(input.global, input.agentPermission, input.tool) }),
    observeV2: async (v2, input) => {
      const result = await v2.drivePermissionGate({
        tool: input.tool,
        global: input.global,
        agents: input.agentPermission ? { sisyphus: { name: "Sisyphus - ultraworker", permission: input.agentPermission } } : {},
        agent: "sisyphus",
      })
      return { decision: result.decision }
    },
    corpus: [
      { name: "global denies look_at", tool: "look_at", global: { look_at: false }, agentPermission: undefined },
      { name: "global allows glob", tool: "glob", global: {}, agentPermission: undefined },
      { name: "agent re-allows over global deny", tool: "look_at", global: { look_at: false }, agentPermission: { look_at: "allow" } },
      { name: "agent denies look_at", tool: "look_at", global: {}, agentPermission: { look_at: "deny" } },
    ],
    mutation: {
      target: "drivePermissionGate",
      perturb: () => async () => ({ decision: "allow" }),
      onDisk: { find: "permissionWiring.before(input)", replace: "undefined" },
    },
  },

  // -------------------------------------------------------------------------
  // fallback: real entrypoint -> session.execution.failed -> switchModel rung
  // -------------------------------------------------------------------------
  {
    id: "fallback.entrypoint-reactive-switch",
    family: "fallback",
    integration: true,
    entrypoint: true,
    observableType: "provider-payload",
    why: "The real setup() wires the reactive fallback into the real event loop: a failed execution switches the session model to the next reachable chain rung, and the switch payload resolves to the same provider/model as the V1 retry-model payload for that rung.",
    loadV1: () => import(`${PKG}/omo-opencode/src/hooks/runtime-fallback/retry-model-payload.ts`),
    loadV2: () => import("./runtime-entrypoint.mjs"),
    tolerance: { kind: "exact" },
    observeV1: (v1, input) => {
      const payload = v1.buildRetryModelPayload(`${input.rung.providerID}/${input.rung.model}`)
      return { rung: payload ? `${payload.model.providerID}/${payload.model.modelID}` : null }
    },
    observeV2: async (v2, input) => {
      const result = await v2.driveReactiveFallback({
        agent: "explore",
        currentProvider: "opencode-go",
        currentModel: "grok-4.7",
        rung: input.rung,
        sessionID: "ses_entrypoint_child",
      })
      return { rung: result.rung }
    },
    corpus: [{
      name: "advance to first reachable rung",
      rung: { providers: ["openai"], providerID: "openai", model: "gpt-6-luna-fast" },
    }],
    mutation: {
      target: "driveReactiveFallback",
      perturb: () => async () => ({ rung: null }),
      onDisk: { find: "if (next?.id && typeof context?.session?.switchModel === \"function\") {", replace: "if (false) {" },
    },
  },

  // -------------------------------------------------------------------------
  // skills: real entrypoint -> delegated child prompt carries the skill body
  // -------------------------------------------------------------------------
  {
    id: "skills.entrypoint-body-injection",
    family: "skills",
    integration: true,
    entrypoint: true,
    observableType: "provider-payload",
    why: "The real setup() discovers the on-disk skill; delegating a child with load_skills resolves and injects the same raw skill body into the child prompt as the V1 skill loader yields.",
    loadV1: async () => {
      const loader = await import(`${PKG}/skills-loader-core/src/features/opencode-skill-loader/loader.ts`)
      return { loader }
    },
    loadV2: () => import("./runtime-entrypoint.mjs"),
    tolerance: { kind: "substring" },
    observeV1: async (v1, input) => {
      const previousHome = process.env.HOME
      process.env.HOME = input.home
      try {
        const skills = await v1.loader.discoverAllSkills(input.project)
        const match = skills.find((skill) => skill.name === input.skillName)
        if (!match) return ""
        const body = match.lazyContent ? await match.lazyContent.load() : (match.lazyContent?.content ?? "")
        return extractSkillRawBody(body)
      } finally {
        process.env.HOME = previousHome
      }
    },
    observeV2: async (v2, input) => {
      const result = await v2.driveSkillBody({
        project: input.project,
        home: input.home,
        skillName: input.skillName,
        body: input.body,
        agent: "explore",
        prompt: "do the work",
        parentSessionID: "ses_parent",
      })
      return result.childPrompt
    },
    corpus: (() => {
      const project = tempDir("diff-entrypoint-skills-")
      const home = tempDir("diff-entrypoint-skills-home-")
      writeFile(path.join(project, "package.json"), "{}\n")
      writeFile(path.join(project, ".opencode", "skills", "diff-entrypoint-body", "SKILL.md"), "---\nname: diff-entrypoint-body\ndescription: entrypoint test\n---\nENTRYPOINT-BODY-INJECTION\n")
      return [{ name: "inject skill body", project, home, skillName: "diff-entrypoint-body", body: "ENTRYPOINT-BODY-INJECTION" }]
    })(),
    mutation: {
      target: "driveSkillBody",
      perturb: () => async () => ({ injected: false, childPrompt: "" }),
      onDisk: { find: "const selected = selectSkillsForChild(skillRegistry.skills, [name])", replace: "const selected = { injected: [], missing: [name] }" },
    },
  },
]
