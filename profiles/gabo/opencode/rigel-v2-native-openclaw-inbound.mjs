/**
 * Native V2 OpenClaw inbound: the reply listener V1 ran as a detached daemon, now
 * owned by the plugin runtime. Ported from
 * `packages/openclaw-core/src/{reply-listener-discord,reply-listener-telegram,reply-listener-injection}.ts`.
 *
 * Two differences from V1 are deliberate and are the whole point of the port:
 *   - V1 injected a reply by typing into the pane that owned the OpenCode CLI
 *     (`tmux send-keys`). V2 injects through the official session API instead:
 *     `ctx.session.prompt({ sessionID, text, delivery: "queue" })`. That call is
 *     the ONLY effect, and it goes through `createInternalPromptGate`, so no
 *     reply can reach a session without the host accepting it as a queued
 *     internal prompt.
 *   - V1 persisted its poll cursor (Discord last message id, Telegram last update
 *     id) to a state file so a daemon restart resumed correctly. Here the cursor
 *     lives in the process; the correlation that a reply is answered against is
 *     the durable half and lives in the native registry (`ctx.storage`).
 *
 * Effects preserved verbatim from V1: the same Discord `?after=` poll and the
 * same `x-ratelimit-remaining` backoff, the same Telegram `getUpdates?offset=`
 * poll, the same authorized-user and chat filters, the same sliding-window rate
 * limiter, the same `[reply:<platform>] ` prefix, the same `sanitizeReplyInput`
 * + truncate-to-`maxMessageLength`, and the same best-effort acknowledgement
 * (Discord reaction, Telegram sendMessage).
 *
 * Only Node built-ins and sibling native modules are imported so the flat
 * laboratory runtime (no `node_modules`) can load this module.
 *
 * U4 (`Unidades_Atomicas_OpenClaw.md` §U4) turns the counters into a report
 * without turning the channel into spam: a poll failure, a malformed response
 * and a refused injection are `degraded` transitions on the status document (one
 * line each, deduplicated by class); an individual rate-limit drop only moves the
 * aggregate `rateLimited` counter; an unauthorized author records nothing at all,
 * because §9.3 makes that silence deliberate.
 *
 * U6 (`§U6`) touches ONE decision here: where the authorized-author list comes
 * from. An injected `discordAuthorization` from the new namespace's reply policy
 * replaces the legacy list outright, and the poller runs only when that list
 * actually authorizes someone. The gate itself (`enabled` needs a non-empty list)
 * is unchanged on purpose: the legacy route keeps its silent disablement, and what
 * the new route adds is that the composition REPORTS an empty authorization
 * instead of leaving the poller silently off. The per-message filter still never
 * records an unauthorized author.
 *
 * U7 (`§U7`) touches the SAME two decisions for Telegram, whose defect is one step
 * wider: `telegramEnabled` used to be `token && chatId`, and the per-message filter
 * compared only `message.chat.id`, so any user able to write in that conversation
 * reached the session. An injected `telegramAuthorization` comes from the new
 * namespace's `replyPolicy.telegram.allowedAuthors`, adds `message.from.id` to the
 * ingress filter, and keeps the poller down when it authorizes nobody. The legacy
 * route keeps its chat-only filter byte for byte — there is no legacy Telegram user
 * list, and inventing one would give a legacy record semantics it never had
 * (`Contrato_Transportes_OpenClaw.md` §5.2 rule 5).
 */
import {
  DEFAULT_REPLY_POLL_INTERVAL_MS,
  createReplyListenerRateLimiter,
  normalizeReplyListenerConfig,
  sanitizeReplyInput,
} from "./rigel-v2-native-openclaw-core.mjs"

const DEFAULT_DISCORD_API_BASE = "https://discord.com/api/v10"
const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org"
const REQUEST_TIMEOUT_MS = 10_000
/** URL-encoded white heavy check mark, the V1 acknowledgement reaction. */
const REPLY_ACK_REACTION = "%E2%9C%85"

/** Status-document surfaces this module reports under (U4). */
export const OPENCLAW_DISCORD_STATUS_SURFACE = "discord"
export const OPENCLAW_TELEGRAM_STATUS_SURFACE = "telegram"
export const OPENCLAW_INJECTION_STATUS_SURFACE = "injection"

/**
 * Reduce a poll failure to a stable CLASS, so the document dedups on
 * `(surface, severity, errorClass)` instead of on a per-attempt message that
 * would defeat the dedup and turn the channel into spam.
 */
export function openclawPollErrorClass(error) {
  if (error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message))) return "poll-timeout"
  return "poll-error"
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Build the internal-prompt gate. It is the single seam every inbound reply
 * crosses: an empty session or text is refused, a host without `session.prompt`
 * is refused, and an accepted call is delivered as a queued prompt so it never
 * preempts the user's in-flight turn.
 *
 * @param {{ session?: { prompt?: (input: object) => Promise<unknown> } }} [options]
 * @returns {(input: { sessionID?: string, text?: string }) => Promise<boolean>}
 */
export function createInternalPromptGate({ session } = {}) {
  return async function deliverInboundReply({ sessionID, text } = {}) {
    if (typeof sessionID !== "string" || sessionID.length === 0) return false
    if (typeof text !== "string" || text.length === 0) return false
    if (!session || typeof session.prompt !== "function") return false
    await session.prompt({ sessionID, text, delivery: "queue" })
    return true
  }
}

/**
 * Create the inbound reply listener. `start()` is non-blocking; `stop()` aborts
 * the loop and resolves only after the in-flight poll has drained, so no request
 * outlives `dispose()`. `status()` is the observability surface a lab run reads
 * to prove injections, errors and the poll cursors.
 *
 * @param {object} [options]
 * @param {object} [options.replyListener] raw `openclaw.replyListener` block
 * @param {object} [options.registry] the correlation registry (`lookup/prune`)
 * @param {(input: { sessionID: string, text: string }) => Promise<boolean>} [options.deliverInboundReply]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(ms: number) => Promise<void>} [options.sleep] test seam; defaults to a cancel-aware timer
 * @param {object} [options.statusDocument] optional status document (U4); absent,
 *   reporting is off. Named `statusDocument` because this module already exposes a
 *   `status()` accessor, and a hoisted function declaration would shadow the
 *   parameter inside every poll.
 * @param {{ source: string, explicit: boolean, allowedAuthors: string[] }} [options.discordAuthorization]
 *   the NEW namespace's authorization for the Discord inbound surface (`§U6`).
 *   When provided it REPLACES `replyListener.authorizedDiscordUserIds`: a policy
 *   that authorizes nobody leaves the list empty, so the poller stays down
 *   (fail closed) and the composition reports why. When absent, the legacy list
 *   governs and an empty list disables the poller exactly as before.
 * @param {{ source: string, explicit: boolean, allowedAuthors: string[] }} [options.telegramAuthorization]
 *   the NEW namespace's authorization for the Telegram inbound surface (`§U7`).
 *   When provided it is the ONLY user filter: the poller runs only when it
 *   authorizes at least one user id, and every message whose `message.from.id` is
 *   not on the list is dropped silently. When absent, the legacy route filters by
 *   chat only, exactly like before this unit.
 */
export function createOpenclawInbound({
  replyListener,
  registry,
  deliverInboundReply,
  fetchImpl = globalThis.fetch,
  sleep,
  log = () => {},
  now = () => Date.now(),
  statusDocument,
  discordApiBase = process.env.RIGEL_OPENCLAW_DISCORD_API_BASE || DEFAULT_DISCORD_API_BASE,
  telegramApiBase = DEFAULT_TELEGRAM_API_BASE,
  discordAuthorization,
  telegramAuthorization,
} = {}) {
  const normalized = normalizeReplyListenerConfig(replyListener) ?? {}
  // §U6: one authorization source, never a field-by-field merge. A declared
  // `openclaw.replyPolicy` governs this identity (`Contrato_Transportes_OpenClaw.md`
  // §5.2 rule 2); the legacy list is then not consulted at all.
  const authorization = discordAuthorization && typeof discordAuthorization === "object"
    ? {
        source: typeof discordAuthorization.source === "string" ? discordAuthorization.source : "replyPolicy",
        explicit: discordAuthorization.explicit === true,
        allowedAuthors: Array.isArray(discordAuthorization.allowedAuthors)
          ? discordAuthorization.allowedAuthors.filter((entry) => typeof entry === "string" && entry.length > 0)
          : [],
      }
    : undefined
  // §U7: same shape, one identity further. `undefined` is the legacy route, and it
  // is the ONLY case that keeps the chat-only filter.
  const telegramUserAuthorization = telegramAuthorization && typeof telegramAuthorization === "object"
    ? {
        source: typeof telegramAuthorization.source === "string" ? telegramAuthorization.source : "replyPolicy",
        explicit: telegramAuthorization.explicit === true,
        allowedAuthors: Array.isArray(telegramAuthorization.allowedAuthors)
          ? telegramAuthorization.allowedAuthors.filter((entry) => typeof entry === "string" && entry.length > 0)
          : [],
      }
    : undefined
  const authorizedUserIds = authorization
    ? authorization.allowedAuthors
    : Array.isArray(normalized.authorizedDiscordUserIds) ? normalized.authorizedDiscordUserIds : []
  const authorizedTelegramUserIds = telegramUserAuthorization ? telegramUserAuthorization.allowedAuthors : null
  const discordEnabled = Boolean(normalized.discordBotToken && normalized.discordChannelId && authorizedUserIds.length > 0)
  // §U7 fail closed: a new-namespace Telegram port with no authorized user keeps the
  // poller down instead of reading every message in the chat.
  const telegramEnabled = Boolean(
    normalized.telegramBotToken
    && normalized.telegramChatId
    && (authorizedTelegramUserIds === null || authorizedTelegramUserIds.length > 0),
  )
  const enabled = discordEnabled || telegramEnabled
  const pollIntervalMs = normalized.pollIntervalMs ?? DEFAULT_REPLY_POLL_INTERVAL_MS
  const maxMessageLength = normalized.maxMessageLength ?? 500
  const includePrefix = normalized.includePrefix !== false
  const rateLimiter = createReplyListenerRateLimiter(normalized.rateLimitPerMinute ?? 10, now)
  const callFetch = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch

  const state = {
    discordLastMessageId: null,
    telegramLastUpdateId: null,
    messagesSeen: 0,
    messagesInjected: 0,
    errors: 0,
    lastError: undefined,
  }

  const abort = new AbortController()
  const abortPromise = new Promise((resolve) => {
    if (abort.signal.aborted) resolve()
    else abort.signal.addEventListener("abort", resolve, { once: true })
  })
  let loopPromise
  let started = false
  let discordBackoffUntil = 0
  let wakeResolve
  let pendingWake = false

  async function request(url, init = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      return await callFetch(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  function defaultSleep(ms) {
    return new Promise((resolve) => {
      if (abort.signal.aborted) return resolve()
      const timer = setTimeout(resolve, ms)
      abort.signal.addEventListener("abort", () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
  }

  async function pause(ms) {
    if (abort.signal.aborted) return
    // A wake requested while the previous poll was still running is honoured
    // immediately, so a correlation registered mid-poll is picked up without
    // waiting a whole poll interval. This is what keeps the outbound -> inbound
    // handoff prompt instead of racing a fixed 3s timer.
    if (pendingWake) {
      pendingWake = false
      return
    }
    const wakePromise = new Promise((resolve) => { wakeResolve = resolve })
    const wait = typeof sleep === "function" ? sleep(ms) : defaultSleep(ms)
    await Promise.race([wait, abortPromise, wakePromise])
    wakeResolve = undefined
  }

  /**
   * Ask the loop to poll again immediately. Called by the composition after an
   * outbound wake registers a fresh reply correlation, so a reply posted right
   * after the outbound message is delivered on the next poll rather than after a
   * full interval. A no-op before `start()`; safe to call at any time.
   */
  function wake() {
    if (!started) return
    if (wakeResolve) {
      const resolve = wakeResolve
      wakeResolve = undefined
      resolve()
      return
    }
    pendingWake = true
  }

  /**
   * The single delivery path. The prefix is applied to the raw reply, then the
   * whole string is sanitized and truncated, exactly like V1's
   * `injectReplyIntoPane`; only the final effect differs (queued prompt instead
   * of `send-keys`).
   */
  async function deliver(content, platform, sessionID) {
    const prefix = includePrefix ? `[reply:${platform}] ` : ""
    const sanitized = sanitizeReplyInput(prefix + (typeof content === "string" ? content : ""))
    const truncated = sanitized.slice(0, maxMessageLength)
    if (truncated.length === 0) return false
    try {
      return await deliverInboundReply({ sessionID, text: truncated })
    } catch (error) {
      log(`ERROR: inbound reply delivery failed: ${errorMessage(error)}`)
      return false
    }
  }

  async function acknowledgeDiscord(messageId) {
    try {
      await request(
        `${discordApiBase}/channels/${normalized.discordChannelId}/messages/${messageId}/reactions/${REPLY_ACK_REACTION}/@me`,
        { method: "PUT", headers: { Authorization: `Bot ${normalized.discordBotToken}` } },
      )
    } catch (error) {
      log(`WARN: Failed to acknowledge Discord message ${messageId}: ${errorMessage(error)}`)
    }
  }

  async function acknowledgeTelegram(messageId) {
    try {
      await request(`${telegramApiBase}/bot${normalized.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: normalized.telegramChatId,
          text: "Injected into OpenCode V2 session.",
          reply_to_message_id: messageId,
        }),
      })
    } catch (error) {
      log(`WARN: Failed to acknowledge Telegram message ${messageId}: ${errorMessage(error)}`)
    }
  }

  async function pollDiscord() {
    if (!discordEnabled) return
    if (now() < discordBackoffUntil) return
    const query = state.discordLastMessageId ? `?after=${state.discordLastMessageId}&limit=10` : "?limit=10"
    let response
    try {
      response = await request(`${discordApiBase}/channels/${normalized.discordChannelId}/messages${query}`, {
        method: "GET",
        headers: { Authorization: `Bot ${normalized.discordBotToken}` },
      })
    } catch (error) {
      state.errors += 1
      state.lastError = errorMessage(error)
      log(`Discord polling error: ${state.lastError}`)
      await statusDocument?.recordFailure?.(OPENCLAW_DISCORD_STATUS_SURFACE, { errorClass: openclawPollErrorClass(error) })
      return
    }

    const remaining = response.headers?.get?.("x-ratelimit-remaining")
    if (remaining !== null && remaining !== undefined && Number.parseInt(remaining, 10) < 2) {
      const reset = response.headers?.get?.("x-ratelimit-reset")
      const parsedReset = reset ? Number.parseFloat(reset) : Number.NaN
      discordBackoffUntil = Number.isFinite(parsedReset) ? parsedReset * 1000 : now() + 10_000
      log(`WARN: Discord rate limit low (remaining: ${remaining}), backing off`)
    }

    if (!response.ok) {
      state.errors += 1
      state.lastError = `Discord API error: HTTP ${response.status}`
      log(state.lastError)
      await statusDocument?.recordFailure?.(OPENCLAW_DISCORD_STATUS_SURFACE, { errorClass: `http-${response.status}` })
      return
    }

    let messages
    try {
      messages = await response.json()
    } catch {
      await statusDocument?.recordFailure?.(OPENCLAW_DISCORD_STATUS_SURFACE, { errorClass: "malformed-response" })
      return
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      await statusDocument?.recordSuccess?.(OPENCLAW_DISCORD_STATUS_SURFACE)
      return
    }

    for (const message of [...messages].reverse()) {
      if (typeof message?.id === "string") {
        state.discordLastMessageId = message.id
        state.messagesSeen += 1
      }
      const replyToMessageId = message?.message_reference?.message_id
      if (!replyToMessageId) continue
      // §9.3: an unauthorized author stays SILENT on purpose. Answering would be
      // an oracle, so this filter records nothing: no line, no counter, no state.
      if (!authorizedUserIds.includes(message?.author?.id)) continue
      const mapping = registry?.lookup?.("discord-bot", replyToMessageId)
      if (!mapping) continue
      if (!rateLimiter.canProceed()) {
        // §9.3: an individual rate-limit drop is never reported. It only moves
        // the aggregate counter, so the channel stays readable.
        state.errors += 1
        await statusDocument?.recordRateLimit?.(OPENCLAW_DISCORD_STATUS_SURFACE)
        continue
      }
      if (await deliver(message.content, "discord", mapping.sessionID)) {
        state.messagesInjected += 1
        await acknowledgeDiscord(message.id)
      } else {
        state.errors += 1
        await statusDocument?.recordFailure?.(OPENCLAW_INJECTION_STATUS_SURFACE, { errorClass: "delivery-refused", detail: "discord" })
      }
    }
    await statusDocument?.recordSuccess?.(OPENCLAW_DISCORD_STATUS_SURFACE)
  }

  async function pollTelegram() {
    if (!telegramEnabled) return
    const offset = state.telegramLastUpdateId !== null ? state.telegramLastUpdateId + 1 : 0
    let response
    try {
      response = await request(
        `${telegramApiBase}/bot${normalized.telegramBotToken}/getUpdates?offset=${offset}&timeout=0`,
        { method: "GET" },
      )
    } catch (error) {
      state.errors += 1
      state.lastError = errorMessage(error)
      log(`Telegram polling error: ${state.lastError}`)
      await statusDocument?.recordFailure?.(OPENCLAW_TELEGRAM_STATUS_SURFACE, { errorClass: openclawPollErrorClass(error) })
      return
    }

    if (!response.ok) {
      state.errors += 1
      state.lastError = `Telegram API error: HTTP ${response.status}`
      log(state.lastError)
      await statusDocument?.recordFailure?.(OPENCLAW_TELEGRAM_STATUS_SURFACE, { errorClass: `http-${response.status}` })
      return
    }

    let body
    try {
      body = await response.json()
    } catch {
      await statusDocument?.recordFailure?.(OPENCLAW_TELEGRAM_STATUS_SURFACE, { errorClass: "malformed-response" })
      return
    }
    const updates = body && typeof body === "object" && Array.isArray(body.result) ? body.result : []

    for (const update of updates) {
      if (typeof update?.update_id === "number") state.telegramLastUpdateId = update.update_id
      const message = update?.message
      const replyToMessageId = message?.reply_to_message?.message_id
      if (replyToMessageId === undefined || replyToMessageId === null) continue
      if (String(message?.chat?.id) !== String(normalized.telegramChatId)) continue
      // §U7: the chat filter says WHERE the message was written; this one says WHO
      // wrote it. A user missing from the list (or a message with no `from` at all)
      // is dropped SILENTLY on purpose (§9.3): answering an intruder would be an
      // oracle, so nothing is reported — no line, no error counter, no ack and no
      // status write. The poll offset above still advances: that is how Telegram
      // considers an update consumed, and re-reading it forever would be its own bug.
      if (authorizedTelegramUserIds !== null) {
        const userId = message?.from?.id
        if (userId === undefined || userId === null) continue
        if (!authorizedTelegramUserIds.includes(String(userId))) continue
      }
      if (!message?.text) continue
      const mapping = registry?.lookup?.("telegram", String(replyToMessageId))
      if (!mapping) continue
      if (!rateLimiter.canProceed()) {
        state.errors += 1
        await statusDocument?.recordRateLimit?.(OPENCLAW_TELEGRAM_STATUS_SURFACE)
        continue
      }
      if (await deliver(message.text, "telegram", mapping.sessionID)) {
        state.messagesInjected += 1
        await acknowledgeTelegram(message.message_id)
      } else {
        state.errors += 1
        await statusDocument?.recordFailure?.(OPENCLAW_INJECTION_STATUS_SURFACE, { errorClass: "delivery-refused", detail: "telegram" })
      }
    }
    await statusDocument?.recordSuccess?.(OPENCLAW_TELEGRAM_STATUS_SURFACE)
  }

  async function loop() {
    log("[oh-my-rigel] Native V2 openclaw reply listener started")
    while (!abort.signal.aborted) {
      try {
        await registry?.prune?.()
        await pollDiscord()
        await pollTelegram()
      } catch (error) {
        state.errors += 1
        state.lastError = errorMessage(error)
        log(`Poll error: ${state.lastError}`)
      }
      if (abort.signal.aborted) break
      await pause(pollIntervalMs)
    }
    log("[oh-my-rigel] Native V2 openclaw reply listener stopped")
  }

  async function start() {
    if (!enabled) return { started: false, reason: "no-credentials" }
    if (started) return { started: true, reason: "already-started" }
    started = true
    loopPromise = loop()
    return { started: true }
  }

  async function stop() {
    if (!started) return { stopped: false }
    abort.abort()
    try {
      await loopPromise
    } catch {
      // the loop isolates every poll error; a rejection here would be a bug in
      // this module, not a runtime condition, and must not hang dispose
    }
    started = false
    return { stopped: true }
  }

  function status() {
    return {
      enabled,
      started,
      platforms: { discord: discordEnabled, telegram: telegramEnabled },
      messagesSeen: state.messagesSeen,
      messagesInjected: state.messagesInjected,
      errors: state.errors,
      ...(state.lastError !== undefined ? { lastError: state.lastError } : {}),
      discordLastMessageId: state.discordLastMessageId,
      telegramLastUpdateId: state.telegramLastUpdateId,
      // §U6: reported only when the new namespace supplied the authorization, so a
      // legacy configuration keeps the exact status shape the pinned tests assert.
      // Booleans and the source name only: an author id is data, not observability.
      ...(authorization ? { authorization: { source: authorization.source, explicit: authorization.explicit } } : {}),
      // §U7: same rule for the Telegram user filter, under its own key so the U6
      // shape stays byte-identical for every Discord-only configuration.
      ...(telegramUserAuthorization ? { telegramAuthorization: { source: telegramUserAuthorization.source, explicit: telegramUserAuthorization.explicit } } : {}),
    }
  }

  return { enabled, start, stop, status, wake }
}
