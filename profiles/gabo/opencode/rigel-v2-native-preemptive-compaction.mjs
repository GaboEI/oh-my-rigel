/**
 * Rigel native V2 preemptive compaction.
 *
 * V1 owner: `packages/omo-opencode/src/hooks/preemptive-compaction.ts` plus
 * `preemptive-compaction-trigger.ts`, `preemptive-compaction-degradation-monitor.ts`
 * and `preemptive-compaction-no-text-tail.ts`. The V1 hook is gated by
 * `experimental.preemptive_compaction` and is off by default. It watches the
 * token usage of the last assistant message, compares
 * `(input + cache.read) / actualContextLimit` against a threshold, and asks the
 * host to summarize (compact) the session before the context window overflows.
 *
 * V2 carries the same effect through the documented surfaces:
 *
 * - the `context` hook (`event.sessionID` / `event.agent` / `event.model`) is the
 *   agent-loop boundary where the native runtime observes a session;
 * - `ctx.session.context({ sessionID })` returns the persisted transcript whose
 *   assistant messages carry `tokens` (same shape as V1 `message.updated` info),
 *   so the token source stays provider-reported instead of estimated;
 * - `ctx.session.compact({ sessionID })` durably admits the compaction;
 * - `model.list` rows carry `limit.context`, the V2 source of the model's real
 *   context window.
 *
 * A shared incident registry lets the reactive context-limit recovery
 * (`rigel-v2-native-phase4-events.mjs`) and this preemptive trigger never hold two
 * pending compaction requests for one session.
 *
 * Pure module: only injected dependencies, no imports, no I/O.
 */

// ---------------------------------------------------------------------------
// V1 constants (byte-faithful)
// ---------------------------------------------------------------------------

export const PREEMPTIVE_COMPACTION_THRESHOLD = 0.78
export const PREEMPTIVE_COMPACTION_COOLDOWN_MS = 60_000
export const POST_COMPACTION_MONITOR_COUNT = 5
export const POST_COMPACTION_NO_TEXT_THRESHOLD = 3
export const MAX_RECOVERY_ATTEMPTS = 3
export const RECOVERY_COMPACTION_SUPPRESSION_MS = 5_000
export const DEFAULT_ANTHROPIC_ACTUAL_LIMIT = 200_000
export const ANTHROPIC_GA_1M_LIMIT = 1_000_000

/** Default window after which a pending incident self-heals (see registry). */
export const INCIDENT_PENDING_TIMEOUT_MS = 60_000

// ---------------------------------------------------------------------------
// Context limit resolution (V1 `resolveActualContextLimit` port)
// ---------------------------------------------------------------------------

/** V1 `isAnthropicProvider`. */
export function isAnthropicProvider(providerID, modelID) {
  const normalized = String(providerID ?? "").toLowerCase()
  const model = String(modelID ?? "").toLowerCase()
  return normalized === "anthropic"
    || normalized === "google-vertex-anthropic"
    || normalized === "aws-bedrock-anthropic"
    || (normalized === "google" && model.startsWith("claude-"))
}

/** V1 `hasGA1MContext`. */
export function hasGA1MContext(modelID) {
  const model = String(modelID ?? "").toLowerCase()
  return /^claude-(opus|sonnet)-4(?:-|\.)(?:6|7|8)(?:-high)?$/.test(model)
    || /^claude-(?:fable|mythos|sonnet)-5$/.test(model)
}

function isPositiveLimit(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

/**
 * Resolve the model's actual context window for the preemptive threshold.
 *
 * The catalog row (`limit.context`) is the REAL window and wins for every
 * provider, Anthropic included: the id-regex fallbacks exist only for a row that
 * carries no usable limit. A new Anthropic model that the regex does not know
 * (`claude-sonnet-5-5`) would otherwise be pinned to the 200k V1 default while
 * its real window is 1M, and the trigger would compact five times too early.
 *
 * An explicit 1M env override still wins first (V1 parity). The non-Anthropic
 * branch returns `null` when the row carries no usable limit, so the trigger
 * degrades to a no-op exactly like V1 when the limit is unknown.
 */
export function resolveNativeContextLimit({ providerID, modelID, modelContextLimit, env } = {}) {
  const environment = env ?? {}
  if (isAnthropicProvider(providerID, modelID)) {
    const explicit1M = environment.ANTHROPIC_1M_CONTEXT === "true" || environment.VERTEX_ANTHROPIC_1M_CONTEXT === "true"
    if (explicit1M) return ANTHROPIC_GA_1M_LIMIT
    if (isPositiveLimit(modelContextLimit)) return modelContextLimit
    if (hasGA1MContext(modelID)) return ANTHROPIC_GA_1M_LIMIT
    return DEFAULT_ANTHROPIC_ACTUAL_LIMIT
  }
  return isPositiveLimit(modelContextLimit) ? modelContextLimit : null
}

// ---------------------------------------------------------------------------
// Usage math (V1 `totalInputTokens`)
// ---------------------------------------------------------------------------

function tokenNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Reduce a V1/V2 `TokenInfo` to the trigger's input footprint: V1 computes
 * `tokens.input + tokens.cache.read`, ignoring output and cache writes.
 */
export function contextUsage(tokens) {
  const input = tokenNumber(tokens?.input)
  const cacheRead = tokenNumber(tokens?.cache?.read)
  return { input, cacheRead, total: input + cacheRead }
}

/** V1 usage ratio: total input footprint over the actual context limit. */
export function usageRatio(tokens, limit) {
  if (!isPositiveLimit(limit)) return 0
  return contextUsage(tokens).total / limit
}

// ---------------------------------------------------------------------------
// Transcript reading (V1 `message.updated` + `session.messages()` port)
// ---------------------------------------------------------------------------

function partType(part) {
  return typeof part?.type === "string" ? part.type : undefined
}

function partHasText(part) {
  return typeof part?.text === "string" && part.text.trim().length > 0
}

/**
 * V1 `isStepOnlyNoTextParts` plus the V2 part vocabulary. V1 treated a tail made
 * only of `step-start` / `step-finish` parts with no text as the degradation
 * signal. V2 transcript content additionally carries `reasoning` and `tool`
 * parts, so a submission with no visible `text` part and no `tool` part (only
 * reasoning/step content) is the equivalent no-text tail. An empty array is not
 * a no-text tail (V1 parity).
 */
export function isNoTextAssistantContent(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return false
  for (const part of parts) {
    const type = partType(part)
    if (type === undefined) return false
    // A tool call means the assistant acted, so the submission is not a no-text
    // tail. Only a visible `text` (or a step part carrying text, V1 parity)
    // counts as output; a `reasoning` part is internal and never visible.
    if (type === "tool" || type === "tool-call" || type === "tool_call") return false
    if ((type === "text" || type === "step-start" || type === "step-finish") && partHasText(part)) return false
  }
  // Every part was a non-text, non-tool part (V1 step-only tail, or a V2
  // reasoning-only tail): the submission carried no visible output.
  return true
}

function messageRole(message) {
  return typeof message?.type === "string" ? message.type : (typeof message?.info?.role === "string" ? message.info.role : undefined)
}

function messageAgent(message) {
  return typeof message?.agent === "string" ? message.agent : (typeof message?.info?.agent === "string" ? message.info.agent : undefined)
}

function messageModel(message) {
  const ref = message?.model ?? message?.info?.model
  if (!ref || typeof ref !== "object") return {}
  const providerID = typeof ref.providerID === "string" ? ref.providerID : (typeof ref.provider === "string" ? ref.provider : undefined)
  const modelID = typeof ref.id === "string" ? ref.id : (typeof ref.modelID === "string" ? ref.modelID : undefined)
  return { providerID, modelID }
}

function messageTokens(message) {
  return message?.tokens ?? message?.info?.tokens
}

function messageContent(message) {
  if (Array.isArray(message?.content)) return message.content
  if (Array.isArray(message?.parts)) return message.parts
  if (Array.isArray(message?.info?.parts)) return message.info.parts
  return undefined
}

function transcriptList(transcript) {
  if (Array.isArray(transcript)) return transcript
  if (Array.isArray(transcript?.data)) return transcript.data
  if (Array.isArray(transcript?.messages)) return transcript.messages
  return []
}

/**
 * Read the last non-compaction assistant message from a `session.context`
 * transcript. V1 ignored messages whose agent is `compaction`
 * (`isCompactionAgent`), so the compaction summary never feeds the trigger.
 *
 * Returns `{ messageID, tokens, providerID, modelID, noText }` or `undefined`
 * when the transcript has no usable assistant turn.
 */
export function readAssistantUsage(transcript) {
  const messages = transcriptList(transcript)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (messageRole(message) !== "assistant") continue
    if (String(messageAgent(message) ?? "").trim().toLowerCase() === "compaction") continue
    const tokens = messageTokens(message)
    if (!tokens || typeof tokens !== "object") continue
    const { providerID, modelID } = messageModel(message)
    return {
      messageID: typeof message?.id === "string" ? message.id : (typeof message?.info?.id === "string" ? message.info.id : undefined),
      tokens,
      providerID,
      modelID,
      noText: isNoTextAssistantContent(messageContent(message)),
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Shared incident registry
// ---------------------------------------------------------------------------

/**
 * One pending-compaction incident per session, shared between the preemptive
 * trigger and the reactive context-limit recovery so neither admits a second
 * `session.compact` while one is already pending. A pending mark that outlives
 * `pendingTimeoutMs` self-heals (the host may drop a compaction event), so a
 * lost edge can never disable the feature for the rest of the session.
 */
export function createNativeCompactionIncidentRegistry({ pendingTimeoutMs = INCIDENT_PENDING_TIMEOUT_MS, now = () => Date.now() } = {}) {
  const pending = new Map()
  const expired = (sessionID) => {
    const since = pending.get(sessionID)
    return typeof since !== "number" || now() - since >= pendingTimeoutMs
  }
  return {
    /** Begin an incident. Returns false when one is already pending. */
    begin(sessionID) {
      if (typeof sessionID !== "string" || !sessionID) return false
      if (pending.has(sessionID) && !expired(sessionID)) return false
      pending.set(sessionID, now())
      return true
    },
    /** End an incident (compaction landed, request failed, or session deleted). */
    end(sessionID) {
      pending.delete(sessionID)
    },
    has(sessionID) {
      if (!pending.has(sessionID)) return false
      if (expired(sessionID)) {
        pending.delete(sessionID)
        return false
      }
      return true
    },
    clear(sessionID) {
      pending.delete(sessionID)
    },
    clearAll() {
      pending.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// Preemptive compaction controller
// ---------------------------------------------------------------------------

/**
 * Create the preemptive compaction controller.
 *
 * Injected dependencies:
 * - `readUsage(sessionID)` async: returns `readAssistantUsage(...)` from the
 *   session transcript, or `undefined`.
 * - `resolveContextLimit({ providerID, modelID })`: the model's context window
 *   (model row `limit.context`), or a non-positive value / `null` when unknown.
 * - `requestCompact({ sessionID })` async: admits the compaction
 *   (`ctx.session.compact`).
 * - `incident`: shared registry (a private one is created when omitted).
 * - `onDecision(event)`: optional receipt sink; only fires when the trigger
 *   decides (never on a skip), so a gate-off or below-threshold run leaves no
 *   receipt.
 */
export function createNativePreemptiveCompaction({
  threshold = PREEMPTIVE_COMPACTION_THRESHOLD,
  cooldownMs = PREEMPTIVE_COMPACTION_COOLDOWN_MS,
  now = () => Date.now(),
  readUsage,
  resolveContextLimit,
  requestCompact,
  incident,
  log = () => {},
  onDecision,
  recovery = true,
  postCompactionMonitorCount = POST_COMPACTION_MONITOR_COUNT,
  postCompactionNoTextThreshold = POST_COMPACTION_NO_TEXT_THRESHOLD,
  maxRecoveryAttempts = MAX_RECOVERY_ATTEMPTS,
  recoverySuppressionMs = RECOVERY_COMPACTION_SUPPRESSION_MS,
  rearmDedupeMs = 500,
} = {}) {
  const registry = incident ?? createNativeCompactionIncidentRegistry({ now })
  const compactedSessions = new Set()
  const compactedAtMessageID = new Map()
  const lastCompactionTime = new Map()

  const postCompactionRemaining = new Map()
  const postCompactionNoTextStreak = new Map()
  const postCompactionRecoveryTriggered = new Set()
  const postCompactionEpoch = new Map()
  const suppressRecoveryCompactionUntil = new Map()
  const postCompactionRecoveryCount = new Map()
  const lastMonitoredMessageID = new Map()
  // V2 may deliver more than one event name for a single compaction
  // (`session.compacted` plus the streamed `session.compaction.ended`), so the
  // post-compaction monitor is armed at most once per short window. The incident
  // end and the trigger re-arm are idempotent and always run.
  const lastCompactedAt = new Map()

  const clear = (sessionID) => {
    compactedSessions.delete(sessionID)
    compactedAtMessageID.delete(sessionID)
    lastCompactionTime.delete(sessionID)
    postCompactionRemaining.delete(sessionID)
    postCompactionNoTextStreak.delete(sessionID)
    postCompactionRecoveryTriggered.delete(sessionID)
    postCompactionEpoch.delete(sessionID)
    suppressRecoveryCompactionUntil.delete(sessionID)
    postCompactionRecoveryCount.delete(sessionID)
    lastMonitoredMessageID.delete(sessionID)
    lastCompactedAt.delete(sessionID)
    registry.clear(sessionID)
  }

  const record = (entry) => {
    if (typeof onDecision === "function") {
      try { onDecision(entry) } catch (error) { log(`[preemptive-compaction] decision sink failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
  }

  /**
   * V1 `onSessionCompacted`: bump the epoch, arm the post-compaction monitor and
   * reset its streak, unless a recovery compaction was just requested for the
   * current epoch (the 5s suppression window).
   */
  const onCompacted = (sessionID) => {
    if (typeof sessionID !== "string" || !sessionID) return
    registry.end(sessionID)
    // A real compaction re-arms the trigger: the next observed assistant turn is
    // what V1's `message.updated` handler waited for.
    compactedSessions.delete(sessionID)
    compactedAtMessageID.delete(sessionID)
    if (!recovery) return
    const at = now()
    const previousAt = lastCompactedAt.get(sessionID)
    if (typeof previousAt === "number" && at - previousAt < rearmDedupeMs) return
    lastCompactedAt.set(sessionID, at)
    const suppressedUntil = suppressRecoveryCompactionUntil.get(sessionID)
    if (suppressedUntil && suppressedUntil > now()) {
      suppressRecoveryCompactionUntil.delete(sessionID)
      return
    }
    suppressRecoveryCompactionUntil.delete(sessionID)
    postCompactionEpoch.set(sessionID, (postCompactionEpoch.get(sessionID) ?? 0) + 1)
    postCompactionRemaining.set(sessionID, postCompactionMonitorCount)
    postCompactionNoTextStreak.set(sessionID, 0)
    postCompactionRecoveryTriggered.delete(sessionID)
    lastMonitoredMessageID.delete(sessionID)
  }

  const triggerRecovery = async (sessionID, usage) => {
    if (!recovery) return false
    if (postCompactionRecoveryTriggered.has(sessionID) || registry.has(sessionID)) return false
    const recoveryCount = postCompactionRecoveryCount.get(sessionID) ?? 0
    if (recoveryCount >= maxRecoveryAttempts) {
      log(`[oh-my-rigel] Native V2 preemptive compaction: max recovery attempts reached; session=${sessionID}; count=${recoveryCount}`)
      return false
    }
    if (!usage?.modelID) {
      log(`[oh-my-rigel] Native V2 preemptive compaction: no-text tail detected but model is unavailable; session=${sessionID}`)
      return false
    }
    if (!registry.begin(sessionID)) return false
    postCompactionRecoveryCount.set(sessionID, recoveryCount + 1)
    postCompactionRecoveryTriggered.add(sessionID)
    const recoveryEpoch = postCompactionEpoch.get(sessionID) ?? 0
    suppressRecoveryCompactionUntil.set(sessionID, now() + recoverySuppressionMs)
    try {
      await requestCompact({ sessionID })
      record({ kind: "recovery", sessionID, epoch: recoveryEpoch, attempt: recoveryCount + 1 })
      log(`[oh-my-rigel] Native V2 preemptive compaction recovery requested: session=${sessionID}; attempt=${recoveryCount + 1}`)
      return true
    } catch (error) {
      suppressRecoveryCompactionUntil.delete(sessionID)
      registry.end(sessionID)
      log(`[oh-my-rigel] Native V2 preemptive compaction recovery failed: session=${sessionID}; ${error instanceof Error ? error.message : String(error)}`)
      return false
    } finally {
      // V1 `triggerRecovery` finally: once this epoch's recovery was attempted,
      // the post-compaction monitor is spent for the epoch. The recovery count
      // (the session-lifetime cap) is deliberately kept.
      if ((postCompactionEpoch.get(sessionID) ?? 0) === recoveryEpoch) {
        postCompactionRemaining.delete(sessionID)
        postCompactionNoTextStreak.delete(sessionID)
        postCompactionRecoveryTriggered.delete(sessionID)
        postCompactionEpoch.delete(sessionID)
        lastMonitoredMessageID.delete(sessionID)
      }
    }
  }

  /** V1 post-compaction no-text tail monitor, driven by the transcript diff. */
  const monitorPostCompaction = async (sessionID, usage) => {
    if (!recovery) return false
    const remaining = postCompactionRemaining.get(sessionID)
    if (remaining === undefined || remaining <= 0) return false
    if (!usage.messageID || lastMonitoredMessageID.get(sessionID) === usage.messageID) return false
    lastMonitoredMessageID.set(sessionID, usage.messageID)
    if (remaining === 1) postCompactionRemaining.delete(sessionID)
    else postCompactionRemaining.set(sessionID, remaining - 1)
    if (!usage.noText) {
      postCompactionNoTextStreak.set(sessionID, 0)
      return false
    }
    const streak = (postCompactionNoTextStreak.get(sessionID) ?? 0) + 1
    postCompactionNoTextStreak.set(sessionID, streak)
    if (streak < postCompactionNoTextThreshold) return false
    log(`[oh-my-rigel] Native V2 preemptive compaction: post-compaction no-text tail; session=${sessionID}; streak=${streak}`)
    return await triggerRecovery(sessionID, usage)
  }

  /**
   * Observe one agent-loop request. Returns a decision descriptor for tests and
   * QA, and performs the admitted compaction when the threshold is crossed.
   */
  const observe = async ({ sessionID, model } = {}) => {
    if (typeof sessionID !== "string" || !sessionID) return undefined
    if (typeof readUsage !== "function") return undefined
    let usage
    try {
      usage = await readUsage(sessionID)
    } catch (error) {
      log(`[oh-my-rigel] Native V2 preemptive compaction transcript read failed: session=${sessionID}; ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    if (!usage) return undefined

    // A new non-compaction assistant turn after a compaction re-arms the trigger.
    if (compactedSessions.has(sessionID) && usage.messageID && usage.messageID !== compactedAtMessageID.get(sessionID)) {
      compactedSessions.delete(sessionID)
      compactedAtMessageID.delete(sessionID)
    }

    if (await monitorPostCompaction(sessionID, usage)) {
      return { decision: "recovery", sessionID, messageID: usage.messageID }
    }

    if (compactedSessions.has(sessionID) || registry.has(sessionID)) {
      return { decision: "skip", reason: "already-pending", sessionID }
    }
    const lastTime = lastCompactionTime.get(sessionID)
    if (typeof lastTime === "number" && now() - lastTime < cooldownMs) {
      return { decision: "skip", reason: "cooldown", sessionID }
    }

    const providerID = usage.providerID ?? model?.providerID ?? model?.provider
    const modelID = usage.modelID ?? model?.modelID ?? model?.id
    const limit = typeof resolveContextLimit === "function" ? await resolveContextLimit({ providerID, modelID }) : null
    if (!isPositiveLimit(limit)) {
      log(`[oh-my-rigel] Native V2 preemptive compaction skipped: unknown context limit; session=${sessionID}; provider=${providerID ?? "unknown"}; model=${modelID ?? "unknown"}`)
      return { decision: "skip", reason: "unknown-limit", sessionID }
    }
    const ratio = usageRatio(usage.tokens, limit)
    if (ratio < threshold) {
      return { decision: "skip", reason: "below-threshold", sessionID, ratio, limit, threshold }
    }

    if (!registry.begin(sessionID)) {
      return { decision: "skip", reason: "already-pending", sessionID }
    }
    lastCompactionTime.set(sessionID, now())
    try {
      await requestCompact({ sessionID })
      compactedSessions.add(sessionID)
      if (usage.messageID) compactedAtMessageID.set(sessionID, usage.messageID)
      record({ kind: "preemptive", sessionID, ratio, limit, threshold, providerID, modelID, messageID: usage.messageID })
      log(`[oh-my-rigel] Native V2 preemptive compaction requested: session=${sessionID}; ratio=${ratio.toFixed(4)}; limit=${limit}; threshold=${threshold}`)
      return { decision: "compact", sessionID, ratio, limit, threshold }
    } catch (error) {
      registry.end(sessionID)
      log(`[oh-my-rigel] Native V2 preemptive compaction failed: session=${sessionID}; ${error instanceof Error ? error.message : String(error)}`)
      return { decision: "error", sessionID, error: error instanceof Error ? error.message : String(error) }
    }
  }

  const clearAll = () => {
    compactedSessions.clear()
    compactedAtMessageID.clear()
    lastCompactionTime.clear()
    postCompactionRemaining.clear()
    postCompactionNoTextStreak.clear()
    postCompactionRecoveryTriggered.clear()
    postCompactionEpoch.clear()
    suppressRecoveryCompactionUntil.clear()
    postCompactionRecoveryCount.clear()
    lastMonitoredMessageID.clear()
    lastCompactedAt.clear()
    registry.clearAll()
  }

  const getState = (sessionID) => ({
    compacted: compactedSessions.has(sessionID),
    pending: registry.has(sessionID),
    lastCompactionTime: lastCompactionTime.get(sessionID),
    postCompactionRemaining: postCompactionRemaining.get(sessionID),
    postCompactionNoTextStreak: postCompactionNoTextStreak.get(sessionID),
    postCompactionRecoveryCount: postCompactionRecoveryCount.get(sessionID),
    postCompactionEpoch: postCompactionEpoch.get(sessionID),
  })

  return { observe, onCompacted, clear, clearAll, getState, incident: registry }
}
