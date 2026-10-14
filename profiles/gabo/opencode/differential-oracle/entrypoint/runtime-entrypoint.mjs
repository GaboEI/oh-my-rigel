/**
 * Full-plugin-entrypoint drivers.
 *
 * This drives the COMPLETE plugin entrypoint rather than a generic boundary: it This module imports the REAL `rigel-v2-native.mjs` default export
 * (id `oh-my-rigel`, `setup(ctx)`), drives it with the fake V2 context built by
 * `fake-context.mjs`, and returns the observable each surface produces:
 *
 *   - handoff:    a background child completes -> the runtime delivers the
 *                 parent handoff prompt (child id + result) through the real
 *                 background manager / event loop.
 *   - recovery:   a token-limit `session.error` -> the runtime requests exactly
 *                 one `session.compact` for the incident.
 *   - compaction: the summary request -> the runtime appends the compaction
 *                 context block to the provider-visible messages, once.
 *   - ultrawork:  the registered context hook appends the directive.
 *   - rules:      the registered execute.after hook injects a rule block.
 *   - permissions: the registered execute.before gate decides allow/deny/ask.
 *   - fallback:   a `session.execution.failed` event -> the runtime calls
 *                 `session.switchModel` with the next chain rung.
 *   - goal:       the registered `goal` command drives the real goal controller.
 *   - skills:     a delegated child prompt carries the discovered skill body.
 *
 * Boundary: every driver isolates HOME / XDG so no V1 path is read or written,
 * points `location.directory` at a throwaway temp dir, and restores the
 * environment in `finally`. Nothing here touches `packages/` or a live host.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import plugin from "../../rigel-v2-native.mjs"
import manifest from "../../rigel-v2-native-agent-manifest.mjs"
import { createEntrypointContext, hooksNamed, messageText, tempDir, toolHooksNamed, writeFile } from "./fake-context.mjs"

export { plugin as entrypointPlugin }

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROMPT_DIR = path.resolve(HERE, "..", "..", "prompts")
const ULTRAWORK_PROMPT_FILES = Object.freeze([
  "ultrawork-default.md",
  "ultrawork-gpt.md",
  "ultrawork-gemini.md",
  "ultrawork-glm.md",
  "ultrawork-planner.md",
])

/**
 * Temporarily materialize the prompt files `setup()` reads, snapshotting any
 * existing bytes so the exact prior state is restored. Returns the restore
 * function. Used to exercise the real ultrawork directive path without adding a
 * test hook to the runtime: the source tree does not ship these files because
 * the installer materializes them, so the driver supplies the real V1-detected
 * body on disk for the duration of one setup.
 */
function materializePromptFiles(contents) {
  const snapshots = new Map()
  for (const name of ULTRAWORK_PROMPT_FILES) {
    const file = path.join(PROMPT_DIR, name)
    snapshots.set(file, fs.existsSync(file) ? fs.readFileSync(file) : null)
  }
  try {
    for (const [name, content] of Object.entries(contents)) {
      fs.writeFileSync(path.join(PROMPT_DIR, name), content)
    }
  } catch (error) {
    for (const [file, before] of snapshots) {
      if (before === null) { if (fs.existsSync(file)) fs.rmSync(file) } else fs.writeFileSync(file, before)
    }
    throw error
  }
  return () => {
    for (const [file, before] of snapshots) {
      if (before === null) { if (fs.existsSync(file)) fs.rmSync(file) }
      else fs.writeFileSync(file, before)
    }
  }
}

const ENV_KEYS = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]

/**
 * Run `fn` with HOME/XDG isolated to throwaway dirs (or removed), restoring the
 * process environment in `finally`. This is the boundary guard: the real
 * `setup()` must never resolve a state/config path under the user's real home.
 */
async function withIsolatedEnv(fn) {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))
  const sandbox = tempDir("diff-entrypoint-env-")
  for (const key of ENV_KEYS) process.env[key] = path.join(sandbox, key.toLowerCase())
  try {
    return await fn(sandbox)
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
}

/** Bounded wait for an async predicate; throws loudly on timeout, never sleeps blind. */
async function waitFor(predicate, { timeout = 3000, label = "condition" } = {}) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error(`timed out after ${timeout}ms waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function collapseWhitespace(value) {
  return String(value ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n").trim()
}

/** Build a context + temp dir, run the REAL setup, and hand back the handle. */
async function startEntrypoint(options = {}) {
  const owned = options.directory === undefined
  const directory = options.directory ?? tempDir("diff-entrypoint-")
  const { context, capture, feed } = createEntrypointContext({ ...options, directory })
  const dispose = await plugin.setup(context)
  return { context, capture, feed, dispose, directory, owned }
}

async function stopEntrypoint(handle, sandbox) {
  try {
    await handle?.dispose?.()
  } finally {
    // Only remove a directory this driver created; a caller-provided corpus
    // tree (rules/skills) must survive across matrix and mutation runs.
    if (handle?.owned) fs.rmSync(handle.directory, { recursive: true, force: true })
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// delegation: background child completion -> parent handoff
// ---------------------------------------------------------------------------

export async function driveHandoff(input) {
  return withIsolatedEnv(async () => {
    let resolveHandoff
    const handoffSeen = new Promise((resolve) => { resolveHandoff = resolve })
    const handle = await startEntrypoint({
      childSessionID: input.childSessionID ?? "ses_entrypoint_child",
      childTranscript: [{ type: "assistant", content: [{ type: "text", text: input.evidence }] }],
      onPrompt: (prompt) => {
        if (typeof prompt?.text === "string" && prompt.text.includes("<rigel-native-background-result>")) resolveHandoff(prompt.text)
      },
    })
    try {
      const task = handle.capture.tools.get("rigel_task")
      if (!task) throw new Error("rigel_task was not registered by setup()")
      await task.execute(
        { subagent_type: input.agent, prompt: input.prompt, run_in_background: true },
        { sessionID: input.parentSessionID },
      )
      const consumed = handle.feed.consumed()
      handle.feed.push({ type: "session.execution.succeeded", data: { sessionID: input.childSessionID ?? "ses_entrypoint_child" } })
      await consumed
      await Promise.race([
        handoffSeen,
        waitFor(() => false, { timeout: 3000, label: "parent handoff prompt" }),
      ])
      const text = await handoffSeen
      const delivered = handle.capture.prompts.filter((prompt) => String(prompt?.text ?? "").includes("<rigel-native-background-result>"))
      return {
        delivered: delivered.length,
        hasIdentifier: text.includes(input.childSessionID ?? "ses_entrypoint_child"),
        hasEvidence: text.includes(input.evidence),
        hasStatus: /(succeed|complet|ready)/i.test(text),
      }
    } finally {
      await stopEntrypoint(handle)
    }
  })
}

// ---------------------------------------------------------------------------
// recovery: token-limit session.error -> exactly one compaction per incident
// ---------------------------------------------------------------------------

export async function driveContextLimit(input) {
  return withIsolatedEnv(async () => {
    const handle = await startEntrypoint({})
    try {
      const send = async (message) => {
        const consumed = handle.feed.consumed()
        handle.feed.push({ type: "session.error", data: { sessionID: input.sessionID }, error: { message } })
        await consumed
      }
      await send(input.message)
      const afterFirst = handle.capture.compactCalls.length
      await send(input.message)
      const afterSecond = handle.capture.compactCalls.length
      return { detected: afterFirst === 1 && afterSecond === 1, compactions: afterSecond }
    } finally {
      await stopEntrypoint(handle)
    }
  })
}

// ---------------------------------------------------------------------------
// compaction: summary request -> injected block in the provider-visible messages
// ---------------------------------------------------------------------------

export async function driveCompactionSummary(input) {
  return withIsolatedEnv(async () => {
    const handle = await startEntrypoint({})
    try {
      const compactionHooks = hooksNamed(handle.capture, "compaction")
      if (compactionHooks.length === 0) throw new Error("no compaction hook registered by setup()")
      // The native compaction-context hook is registered last (after the
      // claude-code compaction bridge); the runtime's registration-order test
      // pins this.
      const nativeHook = compactionHooks[compactionHooks.length - 1]
      const event = {
        sessionID: input.sessionID,
        messages: [{ role: "user", content: [{ type: "text", text: "You MUST summarize the conversation" }] }],
      }
      await nativeHook.handler(event)
      const firstLength = event.messages.length
      const block = collapseWhitespace(messageText(event.messages[event.messages.length - 1]))
      await nativeHook.handler(event)
      if (event.messages.length !== firstLength) throw new Error("compaction block injected more than once")
      return { block, injectedOnce: true, hasMarker: block.includes("[SYSTEM DIRECTIVE: OH-MY-OPENCODE - COMPACTION CONTEXT]") }
    } finally {
      await stopEntrypoint(handle)
    }
  })
}

// ---------------------------------------------------------------------------
// ultrawork: the registered context hook appends the directive
// ---------------------------------------------------------------------------

export async function driveUltraworkInjection(input) {
  return withIsolatedEnv(async () => {
    const restorePrompts = materializePromptFiles(input.promptContents ?? {})
    let handle
    try {
      handle = await startEntrypoint({})
      const contextHooks = hooksNamed(handle.capture, "context")
      if (contextHooks.length === 0) throw new Error("no context hook registered by setup()")
      const event = {
        sessionID: input.sessionID ?? "ses_entrypoint",
        agent: input.agent,
        model: { providerID: "openai", modelID: input.modelID },
        system: [],
        messages: [{ role: "user", content: [{ type: "text", text: input.text }] }],
        options: {},
      }
      await contextHooks[contextHooks.length - 1].handler(event)
      const rendered = event.messages.map(messageText).join(" ")
      return { rendered, hasDirective: rendered.includes("<ultrawork-mode>"), retainsRequest: rendered.includes(input.text) }
    } finally {
      await stopEntrypoint(handle)
      restorePrompts()
    }
  })
}

// ---------------------------------------------------------------------------
// rules: the registered execute.after hook injects a discovered rule block
// ---------------------------------------------------------------------------

export async function driveRulesInjection(input) {
  return withIsolatedEnv(async () => {
    const handle = await startEntrypoint({ directory: input.project, home: input.home, skillsHome: input.home })
    try {
      const afterHooks = toolHooksNamed(handle.capture, "execute.after")
      if (afterHooks.length < 2) throw new Error("expected the directory and ordered-rules execute.after hooks")
      // Order pinned by the runtime's registration-order test: directory
      // instructions (0), then the ordered result/rule chain (1); the
      // claude-code bridge appends a third. Drive the ordered-rules chain.
      const event = {
        status: "completed",
        tool: "read",
        sessionID: input.sessionID ?? "ses_entrypoint",
        input: { filePath: path.join(input.project, "src", "a.ts") },
        result: { content: "file body" },
      }
      await afterHooks[1].handler(event)
      return { block: collapseWhitespace(event.result?.content ?? event.output ?? "") }
    } finally {
      await stopEntrypoint(handle)
    }
  })
}

// ---------------------------------------------------------------------------
// permissions: the registered execute.before gate decides allow/deny/ask
// ---------------------------------------------------------------------------

async function permissionDecision(capture, tool, agent) {
  const handlers = toolHooksNamed(capture, "execute.before")
  // Order pinned by the runtime's registration-order test: the write-guard
  // chain, the non-interactive env guard, then the tool-name permission gate.
  const gate = handlers[2]
  if (!gate) throw new Error("permission gate execute.before hook is not registered")
  try {
    await gate.handler({ tool, agent })
    return "allow"
  } catch (error) {
    if (error && error.code === "RIGEL_TOOL_PERMISSION_APPROVAL_REQUIRED") return "ask"
    return "deny"
  }
}

export async function drivePermissionGate(input) {
  const previousMetadata = manifest.metadata
  const previousAgents = manifest.agents
  manifest.metadata = { global: { tools: input.global ?? {} } }
  manifest.agents = input.agents ?? {}
  try {
    return await withIsolatedEnv(async () => {
      const handle = await startEntrypoint({
        // The V2 roster the runtime registers agents against; `sisyphus` must be
        // present so the agent-level gate is registered and can override global.
        agents: [
          { id: "explore", name: "Explore", mode: "subagent" },
          { id: "sisyphus", name: "Sisyphus - ultraworker", mode: "primary" },
        ],
      })
      try {
        return { decision: await permissionDecision(handle.capture, input.tool, input.agent) }
      } finally {
        await stopEntrypoint(handle)
      }
    })
  } finally {
    if (previousMetadata === undefined) delete manifest.metadata
    else manifest.metadata = previousMetadata
    if (previousAgents === undefined) delete manifest.agents
    else manifest.agents = previousAgents
  }
}

// ---------------------------------------------------------------------------
// fallback: session.execution.failed -> session.switchModel carries the next rung
// ---------------------------------------------------------------------------

export async function driveReactiveFallback(input) {
  return withIsolatedEnv(async (sandbox) => {
    // The runtime resolves an agent's model chain ONLY from the live
    // `~/.omo/omo.jsonc` (JSON-only contract); an agent with no entry inherits
    // the OpenCode global and has no rung to advance to. A real install
    // materializes each agent's ordered chain into that file, so seed the same
    // shape under the isolated HOME: a head `model` plus the ordered
    // `fallback_models` the reactive fallback walks.
    writeFile(
      path.join(sandbox, "home", ".omo", "omo.jsonc"),
      `${JSON.stringify({
        agents: {
          [input.agent]: {
            model: `${input.currentProvider}/${input.currentModel}`,
            fallback_models: [{ providers: [input.rung.providerID], model: input.rung.model }],
          },
        },
      }, null, 2)}\n`,
    )
    const handle = await startEntrypoint({
      models: [{ providerID: input.rung.providerID, id: input.rung.model, enabled: true }],
    })
    try {
      const requestHooks = hooksNamed(handle.capture, "model.request")
      if (requestHooks.length === 0) throw new Error("no model.request hook registered by setup()")
      const request = {
        sessionID: input.sessionID ?? "ses_entrypoint_child",
        agent: input.agent,
        model: { providerID: input.currentProvider, modelID: input.currentModel },
        request: new Request("https://example.invalid/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: input.currentModel, messages: [{ role: "user", content: "work" }] }),
        }),
      }
      await requestHooks[requestHooks.length - 1].handler(request)
      const consumed = handle.feed.consumed()
      handle.feed.push({ type: "session.execution.failed", data: { sessionID: input.sessionID ?? "ses_entrypoint_child" } })
      await consumed
      await waitFor(() => handle.capture.switchModelCalls.length > 0, { label: "session.switchModel reactive call" })
      const switched = handle.capture.switchModelCalls[0]
      return { rung: `${switched.model.providerID}/${switched.model.id}` }
    } finally {
      await stopEntrypoint(handle)
    }
  })
}

// The inherited goal command is quarantined (PR B), so it has no runtime
// entrypoint to drive here; the goal family's parity lives at the helper level
// (scenarios/goal.mjs).

// ---------------------------------------------------------------------------
// skills: a delegated child prompt carries the discovered skill body
// ---------------------------------------------------------------------------

export async function driveSkillBody(input) {
  return withIsolatedEnv(async () => {
    writeFile(path.join(input.project, "package.json"), "{}\n")
    writeFile(path.join(input.project, ".opencode", "skills", input.skillName, "SKILL.md"), `---\nname: ${input.skillName}\ndescription: entrypoint test\n---\n${input.body}\n`)
    const handle = await startEntrypoint({
      directory: input.project,
      withSkill: true,
      skillsHome: input.home,
      skillsEnv: { HOME: input.home, XDG_CONFIG_HOME: path.join(input.home, ".config") },
    })
    try {
      const task = handle.capture.tools.get("rigel_task")
      if (!task) throw new Error("rigel_task was not registered by setup()")
      await task.execute(
        { subagent_type: input.agent, prompt: input.prompt, load_skills: [input.skillName] },
        { sessionID: input.parentSessionID },
      )
      const childPrompt = handle.capture.prompts.map((prompt) => String(prompt?.text ?? "")).find((text) => text.includes(input.body))
      return { injected: Boolean(childPrompt), childPrompt: childPrompt ?? "" }
    } finally {
      await stopEntrypoint(handle)
    }
  })
}
