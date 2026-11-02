/**
 * Native V2 OpenClaw outbound: map a raw session event to its configured hook,
 * dispatch it through the resolved gateway, and record the reply-correlation
 * mapping. Ported from `packages/openclaw-core/src/runtime-dispatch.ts` and the
 * `wakeOpenClaw` half of `src/index.ts`.
 *
 * Effects preserved from V1:
 *   - only `session.created`, `session.deleted` and `session.idle` react;
 *   - the first hook that resolves a gateway wins (a failure still stops the
 *     search, exactly like V1's "break on first non-null result");
 *   - a `session.created` for a subagent session is skipped;
 *   - a successful wake carrying `messageId` + `platform` writes a correlation
 *     mapping; `session.deleted` removes the session's mappings;
 *   - `OPENCLAW_REPLY_CHANNEL` / `OPENCLAW_REPLY_TARGET` / `OPENCLAW_REPLY_THREAD`
 *     are the environment fallbacks for reply correlation;
 *   - observability only under `OMO_OPENCLAW_DEBUG=1`.
 *
 * U4 (`Unidades_Atomicas_OpenClaw.md` §U4) closes the silent half: a failed
 * dispatch used to be a `{ success: false }` nobody saw. With a status document
 * injected, a failure is a `degraded` transition (one line, deduplicated by
 * error class) and a later success is the recovery transition. Delivery itself
 * is untouched: same payload, same alias order, same single attempt, no retry.
 */
import {
  buildOpenclawPayload,
  buildWhitelistedContext,
  interpolateInstruction,
  mapRawEventToHooks,
  normalizePlatform,
  projectNameOf,
  resolveGateway,
} from "./rigel-v2-native-openclaw-core.mjs"
import { dispatchGateway } from "./rigel-v2-native-openclaw-transport.mjs"

/** Status-document surface this module reports under. */
export const OPENCLAW_OUTBOUND_STATUS_SURFACE = "outbound"

/**
 * Reduce a dispatch failure to a stable error CLASS, so the document dedups on
 * `(surface, severity, errorClass)` instead of on a per-attempt message. The
 * class is the shape of the failure, never its variable text: an HTTP status, a
 * timeout, an invalid URL, an exit code, a transport error.
 */
export function openclawDispatchErrorClass(result) {
  if (result === null || typeof result !== "object") return "dispatch-failed"
  if (typeof result.statusCode === "number") return `http-${result.statusCode}`
  const error = typeof result.error === "string" ? result.error : ""
  if (/timeout/i.test(error)) return "timeout"
  if (/invalid url/i.test(error)) return "invalid-url"
  if (/^No command configured$/i.test(error)) return "no-command"
  if (/^Command exited with code /i.test(error)) return "command-exit"
  return "transport-error"
}

export function createOpenclawOutbound({
  config,
  registry,
  fetchImpl,
  spawnImpl,
  env = process.env,
  platform = process.platform,
  commandTimeoutEnv,
  log = () => {},
  now = () => Date.now(),
  isSubagentSession,
  /**
   * Optional status document (U4). Absent, this module behaves exactly as it did
   * before: no reporting and no storage access.
   */
  statusDocument,
} = {}) {
  const enabled = Boolean(config && config.enabled === true)
  const debug = env?.OMO_OPENCLAW_DEBUG === "1"
  /**
   * Record the dispatch outcome on the status document. A successful dispatch on
   * an `up` surface is a no-op inside the document, so the healthy legacy path
   * keeps its zero-write call sequence.
   */
  async function reportOutcome(result) {
    if (!statusDocument) return
    if (result === null) return
    if (result.success === true) {
      await statusDocument.recordSuccess?.(OPENCLAW_OUTBOUND_STATUS_SURFACE)
      return
    }
    await statusDocument.recordFailure?.(OPENCLAW_OUTBOUND_STATUS_SURFACE, {
      errorClass: openclawDispatchErrorClass(result),
      detail: typeof result.gateway === "string" && result.gateway.length > 0 ? `gateway ${result.gateway}` : null,
    })
  }

  async function handleEvent(event) {
    if (!enabled) return null
    const rawEvent = event?.type
    const hooks = mapRawEventToHooks(rawEvent)
    if (hooks.length === 0) return null
    const sessionID = event?.sessionID
    if (typeof sessionID !== "string" || sessionID.length === 0) return null

    if (rawEvent === "session.created" && typeof isSubagentSession === "function" && isSubagentSession(sessionID)) {
      return null
    }

    const timestamp = new Date(now()).toISOString()
    const projectPath = typeof event.projectPath === "string" ? event.projectPath : ""
    const replyChannel = event.replyChannel ?? env?.OPENCLAW_REPLY_CHANNEL
    const replyTarget = event.replyTarget ?? env?.OPENCLAW_REPLY_TARGET
    const replyThread = event.replyThread ?? env?.OPENCLAW_REPLY_THREAD
    const tmuxSession = typeof event.tmuxSession === "string" ? event.tmuxSession : undefined

    let result = null
    for (const hook of hooks) {
      const resolved = resolveGateway(config, hook)
      if (!resolved) continue
      const context = {
        sessionId: sessionID,
        projectPath,
        projectName: projectNameOf(projectPath),
        tmuxSession,
        prompt: event.prompt,
        contextSummary: event.contextSummary,
        reasoning: event.reasoning,
        question: event.question,
        tmuxTail: event.tmuxTail,
        replyChannel,
        replyTarget,
        replyThread,
      }
      const variables = {}
      for (const [key, value] of Object.entries(context)) if (value !== undefined) variables[key] = String(value)
      variables.event = hook
      variables.timestamp = timestamp
      const interpolatedInstruction = interpolateInstruction(resolved.instruction, variables)
      variables.instruction = interpolatedInstruction
      if (resolved.gateway.type === "command") {
        variables.context = buildWhitelistedContext(context)
        result = await dispatchGateway({
          gatewayName: resolved.gatewayName,
          gateway: resolved.gateway,
          variables,
          spawnImpl,
          env,
          platform,
          commandTimeoutEnv,
        })
      } else {
        const payload = buildOpenclawPayload({ event: hook, instruction: interpolatedInstruction, timestamp, context })
        result = await dispatchGateway({
          gatewayName: resolved.gatewayName,
          gateway: resolved.gateway,
          payload,
          fetchImpl,
        })
      }
      break
    }

    if (result !== null && result.success === true && typeof result.messageId === "string" && typeof result.platform === "string" && rawEvent !== "session.deleted") {
      await registry?.register?.({
        sessionID,
        projectPath,
        platform: normalizePlatform(result.platform),
        messageId: result.messageId,
        channelId: result.channelId,
        threadId: result.threadId,
        createdAt: timestamp,
      })
    }
    if (rawEvent === "session.deleted") {
      await registry?.removeSession?.(sessionID)
    }
    await reportOutcome(result)
    if (debug && result !== null) {
      log(`[openclaw] wake ${rawEvent} -> ${result.gateway}: ${result.success ? "ok" : result.error ?? "failed"}`)
    }
    return result
  }

  return { enabled, handleEvent }
}
