/**
 * Native OpenCode V2 runtime primitives for Oh My Rigel.
 *
 * This module deliberately has no dependency on OmO's V1 plugin contract.
 * It uses V2's location-scoped agent and session APIs directly.
 */

const callableModes = new Set(["subagent", "all"])
import { sortAgentsByCanonicalOrder } from "./rigel-v2-native-agent-order.mjs"
import { childTaskPrompt } from "./rigel-v2-native-prompt.mjs"

// Coordinator guard, ported from upstream OmO:
//   packages/omo-opencode/src/tools/delegate-task/constants.ts:405-414 defines
//   COORDINATOR_AGENT_NAMES = ["prometheus"]. Atlas is not a coordinator.
//   packages/omo-opencode/src/tools/delegate-task/subagent-request-preflight.ts:58-67
//   rejects a delegation whose target is a coordinator, before any session is
//   created. A coordinator owns an orchestration loop, so delegating to one
//   duplicates coordinators and splits team state; workers must be selected
//   instead.
export const COORDINATOR_AGENT_NAMES = ["prometheus"]

function normalizeAgentName(value) {
  return String(value ?? "").trim().toLocaleLowerCase().split(/\s+-\s+/)[0].trim()
}

export function isCoordinatorAgent(name) {
  return COORDINATOR_AGENT_NAMES.includes(normalizeAgentName(name))
}

// Demoted-agent detection, ported from upstream OmO
// packages/omo-opencode/src/tools/delegate-task/subagent-discovery.ts:71-75:
// a hidden subagent named `plan` stays delegable so the translated Ultrawork
// flow can reach the plan builder, while every other hidden agent (including
// `build`) is excluded from delegation.
export function isDemotedPlanAgent(agent) {
  return agent?.mode === "subagent" && agent?.hidden === true && normalizeAgentName(agent?.name) === "plan"
}

export function normalizeAgentInventory(response) {
  const data = Array.isArray(response) ? response : (response?.data ?? response?.agents)
  if (!Array.isArray(data)) return []
  return data.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return []
    const nested = entry.agent && typeof entry.agent === "object" ? entry.agent : {}
    const name = entry.name ?? entry.id ?? nested.name ?? nested.id
    const id = entry.id ?? nested.id ?? name
    const mode = entry.mode ?? nested.mode ?? entry.config?.mode ?? nested.config?.mode
    if (typeof name !== "string" || typeof id !== "string" || typeof mode !== "string") return []
    return [{ id, name, mode, hidden: Boolean(entry.hidden ?? nested.hidden) }]
  })
}

export function callableAgents(response) {
  // Task 13 (Oh My Rigel Phase 2 migration): the callable inventory is the one
  // place host order enters the roster (prompt injection and delegation both
  // read it), so the canonical Sisyphus -> Hephaestus -> Prometheus -> Atlas
  // head is applied here; remaining agents keep their input order.
  return sortAgentsByCanonicalOrder(
    normalizeAgentInventory(response).filter((agent) => callableModes.has(agent.mode) && (!agent.hidden || isDemotedPlanAgent(agent))),
  )
}

export async function listCallableAgents(client, location) {
  if (typeof client?.agent?.list === "function") {
    return callableAgents(await client.agent.list({ location }))
  }
  // OpenCode V2 currently exposes this same location-scoped inventory through
  // app.agents on plugin setup contexts. It is a V2 host surface, not a V1
  // fallback: the essential requirement is supplying the location explicitly.
  if (typeof client?.app?.agents === "function") {
    return callableAgents(await client.app.agents({
      directory: location?.directory,
      ...(location?.workspace ? { workspace: location.workspace } : {}),
    }))
  }
  throw new Error("OpenCode V2 agent inventory API is unavailable")
}

/**
 * V2 exposes a setup client and a tool-execution client.  They need not carry
 * the same endpoint subsets, so inventory is intentionally resolved from the
 * first client that can answer it, never from an assumed global singleton.
 */
export async function listCallableAgentsFromClients(clients, location) {
  const diagnostics = []
  for (const client of clients.filter(Boolean)) {
    try {
      const agents = await listCallableAgents(client, location)
      if (agents.length > 0) return agents
      diagnostics.push("inventory returned no callable agents")
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error))
    }
  }
  throw new Error(`OpenCode V2 callable-agent inventory is unavailable: ${diagnostics.join("; ")}`)
}

export function resolveNamedAgent(agents, requestedName) {
  const requested = String(requestedName ?? "").trim()
  // OmO's prompts use stable lowercase identifiers (`explore`, `oracle`),
  // while V2 can surface a display-cased builtin (`Explore`). Resolve names
  // case-insensitively, but preserve V2's stable `id` for session.create.
  // The demoted `plan` agent is registered in the inventory under its natural
  // name, so no alias is applied here.
  const alias = requested
  const agent = agents.find((candidate) => candidate.name === alias)
    ?? agents.find((candidate) => candidate.name.toLocaleLowerCase() === alias.toLocaleLowerCase())
  if (agent) {
    console.error(`[oh-my-rigel] Native V2 agent resolved: requested=${requested}; canonical=${agent.name}; id=${agent.id}`)
    return agent
  }
  const available = agents.map((candidate) => candidate.name).sort()
  throw new Error(`Unknown agent: "${requested}". Available agents: ${available.join(", ")}`)
}

function sessionApi(client) {
  // OpenCode V2 plugin hosts expose the V2 session surface directly. Keeping
  // this resolver small also gives a precise diagnostic if a host changes its
  // API instead of silently falling back to a V1 endpoint.
  const api = client?.v2?.session ?? client?.session
  if (typeof api?.create !== "function" || typeof api?.prompt !== "function") {
    throw new Error("OpenCode V2 session.create/session.prompt is unavailable")
  }
  return api
}

function responseData(response) {
  return response?.data ?? response
}

function sessionIdFrom(response) {
  const data = responseData(response)
  const id = data?.id ?? data?.sessionID ?? data?.session?.id
  if (typeof id !== "string" || id.length === 0) throw new Error("OpenCode V2 did not return a child session ID")
  return id
}

function contextData(response) {
  return Array.isArray(response) ? response : (response?.data ?? [])
}

export function completedChildText(response) {
  const messages = contextData(response)
  if (!Array.isArray(messages)) return ""
  const assistant = [...messages].reverse().find((message) => message?.type === "assistant")
  const text = assistant?.content
    ?.filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
  return text ?? ""
}

export async function delegateNamedAgent({ client, location, agent, prompt, background = false, model, parentSessionID, onChildSession }) {
  const sessions = sessionApi(client)
  const created = await sessions.create({
    agent: agent.id ?? agent.name,
    location,
    ...(parentSessionID ? { parentID: parentSessionID } : {}),
    ...(model ? { model } : {}),
  })
  const sessionID = sessionIdFrom(created)
  onChildSession?.(sessionID, { model, agent: agent.id ?? agent.name })
  await sessions.prompt({
    sessionID,
    // Plugin V2's SessionDomain takes PromptInput fields directly. The SDK
    // client wraps this as `prompt: { text }`, but this domain does not.
    text: childTaskPrompt(prompt),
    // V2 schedules the agent loop unless `resume` is explicitly false. Both
    // modes must therefore resume; foreground work is distinguished by the
    // `wait()` boundary below, not by suppressing child execution.
    resume: true,
  })
  if (background) return { sessionID, agent: agent.name, background }

  // `wait` is the native V2 foreground boundary. It is deliberately exercised
  // by the isolated V2 delegation contract: only after it resolves do we read
  // the child's final text and hand it back as the actual tool result.
  if (typeof sessions.wait !== "function" || typeof sessions.context !== "function") {
    throw new Error("OpenCode V2 session.wait/session.context is unavailable for foreground delegation")
  }
  await sessions.wait({ sessionID })
  const result = completedChildText(await sessions.context({ sessionID }))
  return { sessionID, agent: agent.name, background, result }
}

export async function resumeDelegatedSession({ client, sessionID, prompt, background = false }) {
  const sessions = sessionApi(client)
  await sessions.prompt({ sessionID, text: childTaskPrompt(prompt), resume: true })
  if (background) return { sessionID, agent: "resumed", background }
  if (typeof sessions.wait !== "function" || typeof sessions.context !== "function") {
    throw new Error("OpenCode V2 session.wait/session.context is unavailable for foreground continuation")
  }
  await sessions.wait({ sessionID })
  return { sessionID, agent: "resumed", background, result: completedChildText(await sessions.context({ sessionID })) }
}

export async function delegateNamedAgentFromClients({ clients, ...input }) {
  const diagnostics = []
  for (const client of clients.filter(Boolean)) {
    try {
      return await delegateNamedAgent({ ...input, client })
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error))
    }
  }
  throw new Error(`OpenCode V2 child session could not be created: ${diagnostics.join("; ")}`)
}

export async function resumeDelegatedSessionFromClients({ clients, ...input }) {
  const diagnostics = []
  for (const client of clients.filter(Boolean)) {
    try {
      return await resumeDelegatedSession({ ...input, client })
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error))
    }
  }
  throw new Error(`OpenCode V2 child session could not be resumed: ${diagnostics.join("; ")}`)
}

/**
 * Normalize a native tool's return value to the OpenCode V2 host contract.
 *
 * V2's tool-result normalizer (schema-less tool definitions, i.e. no `output`
 * schema) rejects an `output` property and throws a TypeError when the value is
 * a primitive. It reads `content` and `metadata` instead. The V1 contract this
 * runtime ports returned a bare string, and the delegation presenter returns
 * `{ content, metadata }`; both are folded into `{ content, metadata? }` here so
 * the host receives a valid object. This is the single normalization point,
 * applied at the registration seam (`normalizeToolDefinition`), so no tool has
 * to change its own return type.
 */
export function normalizeV2ToolResult(result) {
  if (typeof result === "string") return { content: result }
  if (result && typeof result === "object") {
    if ("content" in result) return result
    const content = typeof result.output === "string" ? result.output : JSON.stringify(result)
    const normalized = { content }
    if (result.metadata && typeof result.metadata === "object") normalized.metadata = result.metadata
    return normalized
  }
  return { content: String(result) }
}

/**
 * Wrap a tool definition's `execute` so whatever it returns (a V1-style string
 * or an object) reaches the V2 host as a valid result object. Non-tool values
 * pass through unchanged so a malformed registration still fails loudly.
 */
export function normalizeToolDefinition(definition) {
  if (!definition || typeof definition.execute !== "function") return definition
  const execute = definition.execute
  return {
    ...definition,
    execute: async (input, toolContext) => normalizeV2ToolResult(await execute(input, toolContext)),
  }
}

export function taskResult({ sessionID, agent, background, result, taskId }) {
  const lifecycle = background
    ? "The subagent is working in the background."
    : "The subagent has been started."
  const idSuffix = typeof taskId === "string" && taskId ? ` taskId: ${taskId};` : ""
  // A foreground child that returned no text still needs a non-empty lifecycle
  // wrapper for the model. The wrapper hides the emptiness from a text-only
  // reader, so the signal travels in metadata for the `execute.after` detector;
  // a background spawn is never an empty-response case.
  const childEmpty = !background && !result
  const returned = background
    ? `${lifecycle}${idSuffix} sessionID: ${sessionID}; agent: ${agent}.`
    : `The subagent completed. sessionID: ${sessionID}; agent: ${agent}.\n\n<rigel-native-child-result>\n${result || "(The child returned no text.)"}\n</rigel-native-child-result>`
  return {
    content: returned,
    metadata: { sessionID, agent, background, childEmpty, ...(typeof taskId === "string" && taskId ? { taskId } : {}) },
  }
}

/**
 * Turn a completed native child into a fresh parent turn. This is a prompt,
 * because V2 already completed the original tool turn when a background child
 * settles; a synthetic tool result would misrepresent that lifecycle.
 */
export function backgroundHandoffPrompt({ sessionID, agent, status, result, error }) {
  const agentLabel = typeof agent === "string"
    ? agent
    : agent && typeof agent === "object" && typeof agent.name === "string" ? agent.name : "unknown"
  const detail = status === "succeeded"
    ? (result || "(The child completed without visible text.)")
    : `(The child ${status ?? "ended"} before returning a result.)`
  // A failed handoff must name the cause; the flag-only detail left the parent
  // unable to tell a provider error from an abort.
  const cause = status === "failed" && error ? `\nerror: ${typeof error === "string" ? error : JSON.stringify(error)}` : ""
  return `<rigel-native-background-result>\nagent: ${agentLabel}\nsessionID: ${sessionID}\nstatus: ${status ?? "unknown"}${cause}\n${detail}\n</rigel-native-background-result>`
}
