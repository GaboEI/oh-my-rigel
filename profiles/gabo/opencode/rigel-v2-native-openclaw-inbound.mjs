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
 *     id) to a state file so a daemon restart resumed correctly. The correlation a
 *     reply is answered against lives in the native registry (`ctx.storage`), and
 *     since U8 the poll cursor does too (`rigel-v2-native-openclaw-cursor.mjs`).
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
 *
 * U8 (`§U8`) moves ONE piece of mutable state from the process to storage: the
 * poll cursor. It is versioned per platform AND per channel, it advances only
 * after the acknowledgement of the message it would pass, and it carries the
 * duplicate memory that keeps a re-read window from injecting the same reply
 * twice. The ack payload, the ack order and the processing order are untouched:
 * a failed ack holds the cursor instead of dropping the message, and a message
 * that is already terminal never counts twice.
 *
 * Three failure modes of that machinery are explicit here, because each one used
 * to be indistinguishable from a healthy poll:
 *   - A cursor whose write could not land is reported on the platform surface
 *     (`cursor-persist`) instead of a success, for as long as the in-memory value
 *     of THAT position is ahead of storage. Processing continues on the in-memory
 *     frontier; what is degraded is durability, and the document says so. The
 *     report is per `(platform, channel)`: a rejected write for one position is
 *     never evidence of degradation for another.
 *   - A Telegram offset that is no longer a valid resume point is retired and the
 *     poll restarts from the platform's own pending set, reported once as
 *     `cursor-expired`. The duplicate memory survives, so the re-read cannot inject
 *     a reply that already reached its session.
 *   - A reply with nothing injectable is TERMINAL, not a refusal: it spends no rate
 *     limit token, halts nothing, and lets the cursor pass it. Halting on it re-read
 *     the same message every cycle until the budget was gone, and the frontier then
 *     moved past replies that had never been injected.
 */
import {
  DEFAULT_REPLY_POLL_INTERVAL_MS,
  createReplyListenerRateLimiter,
  normalizeReplyListenerConfig,
  sanitizeReplyInput,
} from "./rigel-v2-native-openclaw-core.mjs"
import { createOpenclawCursorStore } from "./rigel-v2-native-openclaw-cursor.mjs"

const DEFAULT_DISCORD_API_BASE = "https://discord.com/api/v10"
const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org"
const REQUEST_TIMEOUT_MS = 10_000
/** URL-encoded white heavy check mark, the V1 acknowledgement reaction. */
const REPLY_ACK_REACTION = "%E2%9C%85"

/** Status-document surfaces this module reports under (U4). */
export const OPENCLAW_DISCORD_STATUS_SURFACE = "discord"
export const OPENCLAW_TELEGRAM_STATUS_SURFACE = "telegram"
export const OPENCLAW_INJECTION_STATUS_SURFACE = "injection"

/** Poll-loop platform identifiers. They are also the cursor key space (§U8). */
const DISCORD_PLATFORM = "discord"
const TELEGRAM_PLATFORM = "telegram"

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
 * @param {object} [options.storage] the V2 plugin storage domain the poll cursor is
 *   persisted under (§U8). Absent, the cursor lives in the process, which is the
 *   pre-U8 behaviour and the whole independent rollback.
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
  storage,
} = {}) {
  const normalized = normalizeReplyListenerConfig(replyListener) ?? {}
  // §U8: the poll cursor and its duplicate memory. Built from the storage domain
  // only: `hydrate()` runs at `start()` (storage reads, zero network) and every
  // advance or dedup record is persisted before it is treated as done.
  const cursors = createOpenclawCursorStore({ storage, now, log })
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
   * The exact text this module would inject for a raw reply: the whole of the V1
   * transformation (prefix, sanitize, truncate) with no side effect, so emptiness
   * can be decided BEFORE the rate limiter is consulted. A reply with nothing to
   * inject owes nothing, and spending a token on it is what turned one attachment
   * into a window the poller could never get past.
   */
  function prepareReplyText(content, platform) {
    const prefix = includePrefix ? `[reply:${platform}] ` : ""
    const sanitized = sanitizeReplyInput(prefix + (typeof content === "string" ? content : ""))
    return sanitized.slice(0, maxMessageLength)
  }

  /**
   * The single delivery path. The text arrives prepared, so `false` means exactly
   * one thing: the gate refused this session or the host rejected the prompt, and
   * `halt` is then the right answer for the rest of the window.
   */
  async function deliver(text, sessionID) {
    try {
      return await deliverInboundReply({ sessionID, text })
    } catch (error) {
      log(`ERROR: inbound reply delivery failed: ${errorMessage(error)}`)
      return false
    }
  }

  /**
   * The Discord acknowledgement. Returns whether it LANDED: a non-2xx answer is a
   * failed ack, not a success, because the cursor gate (§U8) may only advance on a
   * real acknowledgement. The request itself (method, URL, headers) is the V1
   * shape, unchanged.
   *
   * `report` is false on a RETRY. A held cursor re-asks for the same message every
   * poll, and repeating one failure per interval is the flood §9.3 forbids: the
   * first attempt already named the failure, and the held cursor is what says the
   * acknowledgement is still owed.
   */
  async function acknowledgeDiscord(messageId, { report = true } = {}) {
    try {
      const response = await request(
        `${discordApiBase}/channels/${normalized.discordChannelId}/messages/${messageId}/reactions/${REPLY_ACK_REACTION}/@me`,
        { method: "PUT", headers: { Authorization: `Bot ${normalized.discordBotToken}` } },
      )
      if (response?.ok === false) {
        if (report) log(`WARN: Failed to acknowledge Discord message ${messageId}: HTTP ${response.status}`)
        return false
      }
      return true
    } catch (error) {
      if (report) log(`WARN: Failed to acknowledge Discord message ${messageId}: ${errorMessage(error)}`)
      return false
    }
  }

  /**
   * The Telegram acknowledgement. Same landing and `report` rules as Discord, and
   * the payload `Contrato_Transportes_OpenClaw.md` §11.1 pins is byte-identical:
   * one POST with `{ chat_id, text, reply_to_message_id }`.
   */
  async function acknowledgeTelegram(messageId, { report = true } = {}) {
    try {
      const response = await request(`${telegramApiBase}/bot${normalized.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: normalized.telegramChatId,
          text: "Injected into OpenCode V2 session.",
          reply_to_message_id: messageId,
        }),
      })
      if (response?.ok === false) {
        if (report) log(`WARN: Failed to acknowledge Telegram message ${messageId}: HTTP ${response.status}`)
        return false
      }
      return true
    } catch (error) {
      if (report) log(`WARN: Failed to acknowledge Telegram message ${messageId}: ${errorMessage(error)}`)
      return false
    }
  }

  /**
   * Resolve one Discord message and report how the cursor must treat it.
   *
   *   "advance"      terminal: nothing is owed (no reply reference, an
   *                  unauthorized author, an expired correlation, an empty reply,
   *                  a rate-limit drop) or the acknowledgement already landed
   *   "acknowledged" the reply is in the session AND its ack landed now
   *   "hold"         the reply is in the session but the ack failed: the cursor
   *                  must not move, yet later messages still run because they
   *                  cannot be reordered behind one that already arrived
   *   "halt"         the injection path refused this message, so it would refuse
   *                  the rest of the window the same way
   */
  async function settleDiscordMessage({ message, messageId, replyToMessageId, channel }) {
    if (messageId !== undefined) {
      const known = cursors.stateOf(DISCORD_PLATFORM, channel, messageId)
      // §U8 dedup: a message already injected is never injected again when a held
      // cursor makes the poller re-read the window. An "acked" one is terminal:
      // only its cursor write was lost, so it is skipped without a second ack.
      if (known === "acked") return { outcome: "advance" }
      if (known === "delivered") {
        // A retry: the failure was named on the first attempt, so repeating it
        // every poll would be the flood §9.3 forbids.
        if (!(await acknowledgeDiscord(messageId, { report: false }))) return { outcome: "hold" }
        return { outcome: "acknowledged" }
      }
    }
    if (!replyToMessageId || messageId === undefined) return { outcome: "advance" }
    // §9.3: an unauthorized author stays SILENT on purpose. Answering would be an
    // oracle, so this filter records nothing: no line, no counter, no state.
    if (!authorizedUserIds.includes(message?.author?.id)) return { outcome: "advance" }
    const mapping = registry?.lookup?.("discord-bot", replyToMessageId)
    if (!mapping) return { outcome: "advance" }
    const text = prepareReplyText(message.content, "discord")
    // An attachment with no text and no prefix has nothing to inject. It is not a
    // refusal: refusing it halted the window, and because the frontier never moved
    // the same message came back every poll until the rate-limit budget was gone,
    // after which the frontier passed replies that had never been injected. Nothing
    // is owed, so it is terminal and it does not spend a token.
    if (text.length === 0) return { outcome: "advance" }
    if (!rateLimiter.canProceed()) {
      // §9.3: an individual rate-limit drop is never reported. It only moves the
      // aggregate counter, so the channel stays readable. The drop is terminal for
      // this message (V1 semantics: a rate-limited reply is not retried) and moving
      // the frontier past it is what keeps one drop from pinning the window.
      state.errors += 1
      await statusDocument?.recordRateLimit?.(OPENCLAW_DISCORD_STATUS_SURFACE)
      return { outcome: "advance" }
    }
    if (!(await deliver(text, mapping.sessionID))) {
      state.errors += 1
      await statusDocument?.recordFailure?.(OPENCLAW_INJECTION_STATUS_SURFACE, { errorClass: "delivery-refused", detail: "discord" })
      return { outcome: "halt" }
    }
    state.messagesInjected += 1
    // The gate accepted this reply, so the injection surface works again. A refusal
    // is the only writer of that surface, so without this the document keeps the
    // `delivery-refused` row - and the degraded line - for the life of the install.
    await statusDocument?.recordSuccess?.(OPENCLAW_INJECTION_STATUS_SURFACE)
    // Persisted BEFORE the ack, and it never moves the cursor: a crash between the
    // injection and the ack must not inject the same reply twice, and because the
    // cursor stays put the message stays retryable until its ack lands.
    await cursors.markDelivered(DISCORD_PLATFORM, channel, messageId)
    if (!(await acknowledgeDiscord(messageId))) return { outcome: "hold" }
    return { outcome: "acknowledged" }
  }

  /**
   * Report what became of one poll, in one place, so `recordSuccess` cannot be
   * reached while the in-memory cursor of the POLLED POSITION is still ahead of
   * storage. That is the whole of the "no silent advancement" rule: processing does
   * not stop when a write fails, but the surface says the durable half is degraded
   * until it lands.
   *
   * The report is scoped to `(platform, channel)` on purpose. The store's pending
   * set is shared by every port this listener polls, so asking it globally would
   * let a rejected Discord write degrade a Telegram poll that owed nothing - and
   * keep that surface degraded for as long as the other one stays dirty. The
   * caller therefore passes the same pair it used for `resumeCursorFor` and
   * `flush`; `surface` stays the observability id.
   */
  async function reportPollOutcome(surface, { expired = false, platform, channel } = {}) {
    if (cursors.unsaved(platform, channel) > 0) {
      state.errors += 1
      await statusDocument?.recordFailure?.(surface, { errorClass: "cursor-persist" })
      return
    }
    if (expired) {
      // One shot: the retired position is gone, so it cannot be stale again.
      state.errors += 1
      await statusDocument?.recordFailure?.(surface, { errorClass: "cursor-expired" })
      return
    }
    await statusDocument?.recordSuccess?.(surface)
  }

  async function pollDiscord() {
    if (!discordEnabled) return
    if (now() < discordBackoffUntil) return
    const channel = String(normalized.discordChannelId)
    // Discord is exempt from resume expiry: its ids only grow, so an old `after=`
    // value can never skip a newer message.
    const resume = cursors.resumeCursorFor(DISCORD_PLATFORM, channel)
    const stored = resume.cursor
    const query = stored ? `?after=${stored}&limit=10` : "?limit=10"
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
    // §U9: the contract threshold is EXHAUSTED budget, not "almost out". A budget of
    // 1 still serves the next poll, so it must not stand the poller down; only 0 does.
    if (remaining !== null && remaining !== undefined && Number.parseInt(remaining, 10) === 0) {
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
    // A 200 whose body is not a message list is NOT an empty window. The body shape
    // is the only evidence the poll read what this port speaks to, so accepting it
    // reported a proxy that answers with something else as healthy, and a healthy
    // report CLEARS a real Discord failure while the malformed responses continue.
    if (!Array.isArray(messages)) {
      await statusDocument?.recordFailure?.(OPENCLAW_DISCORD_STATUS_SURFACE, { errorClass: "malformed-response" })
      return
    }
    if (messages.length === 0) {
      // §U8: an empty window is a healthy poll, but "empty" and "durable" are two
      // questions, and a cursor left unsaved by an earlier window is still unsaved.
      // The retry belongs here too: without it a domain that heals while the channel
      // is quiet would never get its queued write until the next message arrived.
      await cursors.flush()
      await reportPollOutcome(OPENCLAW_DISCORD_STATUS_SURFACE, { expired: resume.expired, platform: DISCORD_PLATFORM, channel })
      return
    }

    // §U8: the cursor is a CONTIGUOUS frontier. It only moves past a message whose
    // processing finished, so a held reply can never be skipped for good.
    let frontier = stored
    let contiguous = true
    for (const message of [...messages].reverse()) {
      if (typeof message?.id === "string") state.messagesSeen += 1
      const messageId = typeof message?.id === "string" ? message.id : undefined
      const settled = await settleDiscordMessage({
        message,
        messageId,
        replyToMessageId: message?.message_reference?.message_id,
        channel,
      })
      if (settled.outcome === "hold" || settled.outcome === "halt") {
        contiguous = false
        if (settled.outcome === "halt") break
        continue
      }
      const next = contiguous && messageId !== undefined ? messageId : frontier
      if (settled.outcome === "acknowledged") {
        // The frontier is what a held predecessor caps: a message acknowledged
        // behind one cannot move the cursor past it.
        await cursors.commitAck(DISCORD_PLATFORM, channel, { messageId, cursor: next })
      }
      frontier = next
    }
    cursors.setCursor(DISCORD_PLATFORM, channel, frontier)
    await cursors.flush()
    await reportPollOutcome(OPENCLAW_DISCORD_STATUS_SURFACE, { expired: resume.expired, platform: DISCORD_PLATFORM, channel })
  }

  /**
   * Resolve one Telegram update with the same outcome vocabulary as Discord. The
   * cursor is the update id (Telegram's own `offset` currency) while the duplicate
   * key is the message id, the identifier `§U8` names.
   */
  async function settleTelegramUpdate({ update, message, channel }) {
    const updateId = typeof update?.update_id === "number" ? update.update_id : undefined
    const messageId = message?.message_id === undefined || message?.message_id === null
      ? undefined
      : String(message.message_id)
    const trackId = messageId ?? (updateId === undefined ? undefined : `update.${updateId}`)

    if (trackId !== undefined) {
      const known = cursors.stateOf(TELEGRAM_PLATFORM, channel, trackId)
      if (known === "acked") return { outcome: "advance" }
      if (known === "delivered") {
        if (!(await acknowledgeTelegram(message?.message_id, { report: false }))) return { outcome: "hold" }
        return { outcome: "acknowledged", trackId }
      }
    }

    const replyToMessageId = message?.reply_to_message?.message_id
    if (replyToMessageId === undefined || replyToMessageId === null) return { outcome: "advance" }
    if (String(message?.chat?.id) !== channel) return { outcome: "advance" }
    // §U7: the chat filter says WHERE the message was written; this one says WHO
    // wrote it. A user missing from the list (or a message with no `from` at all)
    // is dropped SILENTLY on purpose (§9.3): answering an intruder would be an
    // oracle, so nothing is reported — no line, no error counter, no ack and no
    // status write. The cursor still advances past it: leaving an unknown author
    // at the head would re-read the same update forever.
    if (authorizedTelegramUserIds !== null) {
      const userId = message?.from?.id
      if (userId === undefined || userId === null) return { outcome: "advance" }
      if (!authorizedTelegramUserIds.includes(String(userId))) return { outcome: "advance" }
    }
    if (!message?.text) return { outcome: "advance" }
    const text = prepareReplyText(message.text, "telegram")
    // Same rule as the Discord port: nothing injectable is terminal, not a refusal.
    if (text.length === 0) return { outcome: "advance" }
    // The correlation identity of a Telegram message is `(chat, message_id)`: the
    // platform sequences ids per chat, so `77` in another chat is another message.
    // `channel` is the chat this update was read from (already compared above), and
    // passing it is what keeps two chats from stealing each other's reply.
    const mapping = registry?.lookup?.("telegram", String(replyToMessageId), channel)
    if (!mapping) return { outcome: "advance" }
    if (!rateLimiter.canProceed()) {
      state.errors += 1
      await statusDocument?.recordRateLimit?.(OPENCLAW_TELEGRAM_STATUS_SURFACE)
      return { outcome: "advance" }
    }
    if (!(await deliver(text, mapping.sessionID))) {
      state.errors += 1
      await statusDocument?.recordFailure?.(OPENCLAW_INJECTION_STATUS_SURFACE, { errorClass: "delivery-refused", detail: "telegram" })
      return { outcome: "halt" }
    }
    state.messagesInjected += 1
    // Same recovery rule as the Discord port.
    await statusDocument?.recordSuccess?.(OPENCLAW_INJECTION_STATUS_SURFACE)
    if (trackId !== undefined) await cursors.markDelivered(TELEGRAM_PLATFORM, channel, trackId)
    if (!(await acknowledgeTelegram(message?.message_id))) return { outcome: "hold" }
    return { outcome: "acknowledged", trackId }
  }

  async function pollTelegram() {
    if (!telegramEnabled) return
    const channel = String(normalized.telegramChatId)
    // §U8 recovery: a stored offset is a promise that the id space still honours it.
    // Telegram rebuilds that space after a week of inactivity, and an offset above
    // every new id filters the feed out for good, so a position that has not been
    // written inside the window is retired and the poll re-reads from zero. The
    // duplicate memory is what makes that safe: already-acked ids come back as
    // `advance`, never as a second injection.
    const resume = cursors.resumeCursorFor(TELEGRAM_PLATFORM, channel)
    const stored = resume.cursor
    const offset = stored !== null ? stored + 1 : 0
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
    // Same rule as Discord: a 200 without an update list is a malformed body, not
    // an empty window. `result` missing, an object, or a scalar body all mean the
    // poll read something that is not this API, and reporting it healthy would
    // clear a real Telegram failure.
    if (body === null || typeof body !== "object" || !Array.isArray(body.result)) {
      await statusDocument?.recordFailure?.(OPENCLAW_TELEGRAM_STATUS_SURFACE, { errorClass: "malformed-response" })
      return
    }
    const updates = body.result

    let frontier = stored
    let contiguous = true
    for (const update of updates) {
      const updateId = typeof update?.update_id === "number" ? update.update_id : undefined
      const settled = await settleTelegramUpdate({ update, message: update?.message, channel })
      if (settled.outcome === "hold" || settled.outcome === "halt") {
        contiguous = false
        if (settled.outcome === "halt") break
        continue
      }
      const next = contiguous && updateId !== undefined ? updateId : frontier
      if (settled.outcome === "acknowledged") {
        await cursors.commitAck(TELEGRAM_PLATFORM, channel, { messageId: settled.trackId, cursor: next })
      }
      frontier = next
    }
    cursors.setCursor(TELEGRAM_PLATFORM, channel, frontier)
    await cursors.flush()
    await reportPollOutcome(OPENCLAW_TELEGRAM_STATUS_SURFACE, { expired: resume.expired, platform: TELEGRAM_PLATFORM, channel })
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
    // §U8: load what a previous process persisted BEFORE the first poll, so a
    // restart resumes at the last acknowledged position instead of replaying the
    // window. Storage reads only: setup still performs zero network calls (§11.3).
    await cursors.hydrate()
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
    // A poll advanced in memory may still owe its write. Never relinquish the loop
    // with an acknowledged position unrecorded.
    await cursors.flush()
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
      discordLastMessageId: cursors.cursorFor(DISCORD_PLATFORM, normalized.discordChannelId),
      telegramLastUpdateId: cursors.cursorFor(TELEGRAM_PLATFORM, normalized.telegramChatId),
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
