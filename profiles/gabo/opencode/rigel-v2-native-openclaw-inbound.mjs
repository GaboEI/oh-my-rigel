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
 */
export function createOpenclawInbound({
  replyListener,
  registry,
  deliverInboundReply,
  fetchImpl = globalThis.fetch,
  sleep,
  log = () => {},
  now = () => Date.now(),
  discordApiBase = process.env.RIGEL_OPENCLAW_DISCORD_API_BASE || DEFAULT_DISCORD_API_BASE,
  telegramApiBase = DEFAULT_TELEGRAM_API_BASE,
} = {}) {
  const normalized = normalizeReplyListenerConfig(replyListener) ?? {}
  const authorizedUserIds = Array.isArray(normalized.authorizedDiscordUserIds) ? normalized.authorizedDiscordUserIds : []
  const discordEnabled = Boolean(normalized.discordBotToken && normalized.discordChannelId && authorizedUserIds.length > 0)
  const telegramEnabled = Boolean(normalized.telegramBotToken && normalized.telegramChatId)
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
      return
    }

    let messages
    try {
      messages = await response.json()
    } catch {
      return
    }
    if (!Array.isArray(messages) || messages.length === 0) return

    for (const message of [...messages].reverse()) {
      if (typeof message?.id === "string") {
        state.discordLastMessageId = message.id
        state.messagesSeen += 1
      }
      const replyToMessageId = message?.message_reference?.message_id
      if (!replyToMessageId) continue
      if (!authorizedUserIds.includes(message?.author?.id)) continue
      const mapping = registry?.lookup?.("discord-bot", replyToMessageId)
      if (!mapping) continue
      if (!rateLimiter.canProceed()) {
        log(`WARN: Rate limit exceeded, dropping Discord message ${message.id}`)
        state.errors += 1
        continue
      }
      if (await deliver(message.content, "discord", mapping.sessionID)) {
        state.messagesInjected += 1
        await acknowledgeDiscord(message.id)
      } else {
        state.errors += 1
      }
    }
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
      return
    }

    if (!response.ok) {
      state.errors += 1
      state.lastError = `Telegram API error: HTTP ${response.status}`
      log(state.lastError)
      return
    }

    let body
    try {
      body = await response.json()
    } catch {
      return
    }
    const updates = body && typeof body === "object" && Array.isArray(body.result) ? body.result : []

    for (const update of updates) {
      if (typeof update?.update_id === "number") state.telegramLastUpdateId = update.update_id
      const message = update?.message
      const replyToMessageId = message?.reply_to_message?.message_id
      if (replyToMessageId === undefined || replyToMessageId === null) continue
      if (String(message?.chat?.id) !== String(normalized.telegramChatId)) continue
      if (!message?.text) continue
      const mapping = registry?.lookup?.("telegram", String(replyToMessageId))
      if (!mapping) continue
      if (!rateLimiter.canProceed()) {
        log(`WARN: Rate limit exceeded, dropping Telegram message ${message.message_id}`)
        state.errors += 1
        continue
      }
      if (await deliver(message.text, "telegram", mapping.sessionID)) {
        state.messagesInjected += 1
        await acknowledgeTelegram(message.message_id)
      } else {
        state.errors += 1
      }
    }
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
    }
  }

  return { enabled, start, stop, status, wake }
}
