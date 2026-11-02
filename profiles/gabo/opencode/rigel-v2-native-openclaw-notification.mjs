/**
 * Native V2 OpenClaw NOTIFICATION transports and the `channels.<name>` adapter
 * that feeds them (`Unidades_Atomicas_OpenClaw.md` §U5).
 *
 * `Contrato_Transportes_OpenClaw.md` §1 splits output into two abstractions that
 * must not be unified: NOTIFICATION (nobody waits for an answer, no durable
 * record, bounded timeout, never retried) and CONVERSATION (write-ahead, task
 * reconciliation, never a blind resend). This module owns the first one for the
 * two platforms the vendor serves with a bot API, and the common currency they
 * share:
 *
 *   transport.deliver(message) -> Receipt
 *   Receipt = { kind: "delivered", ... } | { kind: "task", ... } | { kind: "failed", errorClass }
 *
 * A transport that can return a handle does not pretend it cannot (§1), so a
 * successful notification carries the `messageId`/`channelId` the platform
 * answered with. That handle is load-bearing, not cosmetic: the chat
 * correlation registry keys on `(platform, messageId)`, and the Telegram reply
 * loop is structurally unreachable until Rigel publishes a message of its own
 * that a user can reply to (confirmed defect 3).
 *
 * Three properties here are deliberate:
 *
 *   - **No retry.** §1 is explicit: a retried notification duplicates a message
 *     a human already sees. One attempt, then a named error class.
 *   - **The credential never enters an error.** Telegram carries the bot token
 *     in the URL path, so forwarding a `fetch` exception's message would print
 *     the secret. Every error this module returns is built from a class.
 *   - **The new namespace is the only route.** §5.2 forbids giving the legacy
 *     `gateways`/`hooks` records new semantics, so nothing here is reachable
 *     from them; a legacy configuration yields zero channels by construction
 *     and therefore emits no new Discord or Telegram send.
 *
 * Only Node built-ins and sibling native modules are imported so the flat
 * laboratory runtime (no `node_modules`) can load this module.
 */
import { isPlainObject } from "./rigel-v2-native-openclaw-core.mjs"
import { resolveOpenclawSecretRef } from "./rigel-v2-native-openclaw-secrets.mjs"

const DEFAULT_DISCORD_API_BASE = "https://discord.com/api/v10"
const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org"
const DEFAULT_NOTIFICATION_TIMEOUT_MS = 10_000

/** Platform tags the chat correlation registry already knows (`inbound` looks these up). */
export const DISCORD_PLATFORM = "discord-bot"
export const TELEGRAM_PLATFORM = "telegram"

/** Receipt kinds of `Contrato_Transportes_OpenClaw.md` §1. */
export const OPENCLAW_RECEIPT_KINDS = Object.freeze(["delivered", "task", "failed"])

/** Transports the new `channels.<name>` namespace may declare today. */
export const OPENCLAW_NOTIFICATION_TRANSPORTS = Object.freeze(["discord", "telegram"])

/** Raw session events a notification channel may subscribe to. */
export const OPENCLAW_NOTIFICATION_EVENTS = Object.freeze(["session.created", "session.deleted", "session.idle"])

/** Keys a `channels.<name>` notification block may carry. */
const CHANNEL_KEYS = new Set(["transport", "token", "channelId", "chatId", "instruction", "events"])

/**
 * `channels.a2a` is the A2A converser's namespace (§2.7), not a notification
 * channel. It is skipped here so a peer block is never mistaken for a bot
 * endpoint; serving it belongs to the unit that implements the converser.
 */
const RESERVED_CHANNELS = new Set(["a2a"])

/** Receipt of a delivery the platform accepted. */
function deliveredReceipt({ platform, messageId, channelId }) {
  const receipt = { kind: "delivered", platform }
  if (typeof messageId === "string" && messageId.length > 0) receipt.messageId = messageId
  if (typeof channelId === "string" && channelId.length > 0) receipt.channelId = channelId
  return receipt
}

/** Receipt of a delivery that did not happen. Always a named, stable class. */
export function notificationFailure(errorClass) {
  return { kind: "failed", errorClass }
}

/** True when a value is one of the three §1 receipts. */
export function isOpenclawTransportReceipt(value) {
  return isPlainObject(value) && OPENCLAW_RECEIPT_KINDS.includes(value.kind)
}

/**
 * Human text for a failed receipt. Deliberately a closed vocabulary: the
 * envelope's `error` field is what U4 logs, so it must never embed a URL, a
 * header or a platform response body.
 */
export function notificationErrorText(errorClass) {
  if (typeof errorClass !== "string" || errorClass.length === 0) return "Delivery failed"
  if (errorClass === "timeout") return "Request timed out"
  if (errorClass === "transport-error") return "Transport error"
  if (errorClass === "missing-credentials") return "No credentials configured"
  if (errorClass === "missing-text") return "No message text"
  if (errorClass === "missing-message-id") return "Platform returned no message id"
  if (errorClass === "platform-rejected") return "Rejected by the platform"
  if (errorClass === "malformed-response") return "Malformed platform response"
  if (errorClass === "invalid-url") return "Invalid URL (HTTPS required)"
  if (errorClass.startsWith("http-")) return `HTTP ${errorClass.slice("http-".length)}`
  return "Delivery failed"
}

/**
 * Compose a transport receipt into the envelope the outbound dispatcher has
 * always returned, so U4's reporting and the chat correlation keep consuming
 * the same shape they did before the notification path existed.
 */
export function notificationEnvelope(gatewayName, receipt) {
  if (!isPlainObject(receipt)) return { gateway: gatewayName, success: false, error: "Delivery failed", errorClass: "transport-error", receipt: notificationFailure("transport-error") }
  if (receipt.kind !== "delivered") {
    const errorClass = typeof receipt.errorClass === "string" && receipt.errorClass.length > 0 ? receipt.errorClass : "transport-error"
    const envelope = { gateway: gatewayName, success: false, error: notificationErrorText(errorClass), errorClass, receipt }
    if (Number.isInteger(receipt.statusCode)) envelope.statusCode = receipt.statusCode
    return envelope
  }
  const envelope = { gateway: gatewayName, success: true, platform: receipt.platform, receipt }
  if (typeof receipt.messageId === "string") envelope.messageId = receipt.messageId
  if (typeof receipt.channelId === "string") envelope.channelId = receipt.channelId
  if (Number.isInteger(receipt.statusCode)) envelope.statusCode = receipt.statusCode
  return envelope
}

/**
 * POST one JSON body and reduce the answer to a discriminated outcome.
 *
 * `timeout` and `transport-error` are constructed here, never copied from the
 * exception: `fetch` failures routinely echo the request URL, and one of these
 * transports puts a bot token in that URL.
 */
async function postJson({ url, headers, body, fetchImpl, timeoutMs }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response?.ok) {
      const status = Number.isInteger(response?.status) ? response.status : 0
      const outcome = { ok: false, errorClass: status > 0 ? `http-${status}` : "transport-error" }
      if (status > 0) outcome.statusCode = status
      return outcome
    }
    let payload = null
    try {
      payload = await response.json()
    } catch {
      const outcome = { ok: false, errorClass: "malformed-response" }
      if (Number.isInteger(response.status)) outcome.statusCode = response.status
      return outcome
    }
    return { ok: true, statusCode: response.status, payload }
  } catch (error) {
    const aborted = error instanceof Error && (error.name === "AbortError" || controller.signal.aborted)
    return { ok: false, errorClass: aborted ? "timeout" : "transport-error" }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Publish one notification to Discord through the bot API.
 *
 * The endpoint is `POST /channels/{channelId}/messages` with `Authorization:
 * Bot <token>` and `{ content }`, which is what makes the bot author a real
 * message the user can reply to (the Discord half of the reply loop).
 *
 * @returns {Promise<object>} a §1 receipt
 */
export async function deliverDiscordNotification({ gatewayName, gateway, message, fetchImpl = globalThis.fetch, timeoutMs, env } = {}) {
  const token = typeof gateway?.token === "string" ? gateway.token : ""
  const channelId = typeof gateway?.channelId === "string" ? gateway.channelId : ""
  if (token.length === 0 || channelId.length === 0) return notificationFailure("missing-credentials")
  const text = typeof message?.text === "string" ? message.text : ""
  if (text.length === 0) return notificationFailure("missing-text")
  const base = typeof env?.RIGEL_OPENCLAW_DISCORD_API_BASE === "string" && env.RIGEL_OPENCLAW_DISCORD_API_BASE.length > 0
    ? env.RIGEL_OPENCLAW_DISCORD_API_BASE
    : DEFAULT_DISCORD_API_BASE
  const url = `${base}/channels/${encodeURIComponent(channelId)}/messages`
  const outcome = await postJson({
    url,
    headers: { Authorization: `Bot ${token}` },
    body: { content: text },
    fetchImpl,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_NOTIFICATION_TIMEOUT_MS,
  })
  if (!outcome.ok) return { ...notificationFailure(outcome.errorClass), ...(Number.isInteger(outcome.statusCode) ? { statusCode: outcome.statusCode } : {}) }
  const payload = isPlainObject(outcome.payload) ? outcome.payload : {}
  if (typeof payload.id !== "string" || payload.id.length === 0) {
    return { ...notificationFailure("missing-message-id"), statusCode: outcome.statusCode }
  }
  return {
    ...deliveredReceipt({
      platform: DISCORD_PLATFORM,
      messageId: payload.id,
      channelId: typeof payload.channel_id === "string" ? payload.channel_id : channelId,
    }),
    statusCode: outcome.statusCode,
  }
}

/**
 * Publish one notification to Telegram through the bot API.
 *
 * The endpoint is `POST /bot<token>/sendMessage` with `{ chat_id, text }`. That
 * exact method name is the maintainer's decision of 2026-10-31 and it is also
 * what makes the inbound `getUpdates` loop reachable: Telegram only delivers
 * replies to messages the bot itself published.
 *
 * Telegram answers 200 with `{ ok: false }` for a refused send, so `ok` is
 * checked independently of the HTTP status.
 *
 * @returns {Promise<object>} a §1 receipt
 */
export async function deliverTelegramNotification({ gatewayName, gateway, message, fetchImpl = globalThis.fetch, timeoutMs, env } = {}) {
  const token = typeof gateway?.token === "string" ? gateway.token : ""
  const chatId = gateway?.chatId === undefined || gateway?.chatId === null ? "" : String(gateway.chatId)
  if (token.length === 0 || chatId.length === 0) return notificationFailure("missing-credentials")
  const text = typeof message?.text === "string" ? message.text : ""
  if (text.length === 0) return notificationFailure("missing-text")
  const base = typeof env?.RIGEL_OPENCLAW_TELEGRAM_API_BASE === "string" && env.RIGEL_OPENCLAW_TELEGRAM_API_BASE.length > 0
    ? env.RIGEL_OPENCLAW_TELEGRAM_API_BASE
    : DEFAULT_TELEGRAM_API_BASE
  const url = `${base}/bot${token}/sendMessage`
  const outcome = await postJson({
    url,
    headers: {},
    body: { chat_id: chatId, text },
    fetchImpl,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_NOTIFICATION_TIMEOUT_MS,
  })
  if (!outcome.ok) return { ...notificationFailure(outcome.errorClass), ...(Number.isInteger(outcome.statusCode) ? { statusCode: outcome.statusCode } : {}) }
  const payload = isPlainObject(outcome.payload) ? outcome.payload : {}
  const result = isPlainObject(payload.result) ? payload.result : {}
  if (payload.ok !== true) return { ...notificationFailure("platform-rejected"), statusCode: outcome.statusCode }
  const messageId = typeof result.message_id === "number" ? String(result.message_id) : typeof result.message_id === "string" ? result.message_id : ""
  if (messageId.length === 0) return { ...notificationFailure("missing-message-id"), statusCode: outcome.statusCode }
  const answeredChat = result.chat?.id === undefined || result.chat?.id === null ? chatId : String(result.chat.id)
  return {
    ...deliveredReceipt({ platform: TELEGRAM_PLATFORM, messageId, channelId: answeredChat }),
    statusCode: outcome.statusCode,
  }
}

/**
 * Describe a rejected `channels.<name>` block for the setup diagnostic line.
 * Names the path and, for a reference, the environment variable; never a value.
 */
export function describeOpenclawChannelDiagnostic(diagnostic) {
  const path = typeof diagnostic?.path === "string" ? diagnostic.path : "openclaw.channels"
  const reason = diagnostic?.reason
  if (reason === "missing-env-variable" || reason === "empty-env-variable") {
    const variable = typeof diagnostic.envName === "string" && diagnostic.envName.length > 0 ? diagnostic.envName : "an unnamed variable"
    return `notification channel ${path} names ${variable}, which ${reason === "empty-env-variable" ? "is empty" : "is not set"}; that channel stays disabled`
  }
  if (reason === "missing-credential") return `notification channel ${path} has no usable token; that channel stays disabled`
  if (reason === "unknown-key") return `notification channel ${path} is not a known key; that channel stays disabled`
  if (reason === "unsupported-transport") return `notification channel ${path} is not "discord" or "telegram"; that channel stays disabled`
  if (reason === "missing-target") return `notification channel ${path} is missing its channel id; that channel stays disabled`
  if (reason === "missing-instruction") return `notification channel ${path} has no instruction text to send; that channel stays disabled`
  if (reason === "missing-events" || reason === "invalid-events") return `notification channel ${path} must list at least one of the documented session events; that channel stays disabled`
  if (reason === "not-an-object") return `notification channel ${path} is not an object; that channel stays disabled`
  return `notification channel ${path} is not usable (${String(reason)}); that channel stays disabled`
}

/**
 * Resolve the notification channels of the raw `openclaw.channels` block into
 * the endpoints the outbound dispatcher consumes.
 *
 * The credential is resolved HERE and once (§8: resolution happens in setup,
 * never per send), so a broken reference is one named line instead of one per
 * event. A channel that fails any check yields no endpoint and one diagnostic:
 * fail closed per surface, never fail open, never in silence.
 *
 * @param {unknown} rawChannels raw `openclaw.channels` from the live chain
 * @param {{ env?: Record<string, string|undefined> }} [options]
 * @returns {{ channels: Array<{ name: string, transport: string, token: string, target: string, instruction: string, events: string[] }>, diagnostics: Array<{ path: string, reason: string, envName?: string }> }}
 */
export function resolveOpenclawNotificationChannels(rawChannels, { env } = {}) {
  const channels = []
  const diagnostics = []
  if (!isPlainObject(rawChannels)) return { channels, diagnostics }
  for (const [name, block] of Object.entries(rawChannels)) {
    if (RESERVED_CHANNELS.has(name)) continue
    const path = `openclaw.channels.${name}`
    if (!isPlainObject(block)) {
      diagnostics.push({ path, reason: "not-an-object" })
      continue
    }
    const unknownKey = Object.keys(block).find((key) => !CHANNEL_KEYS.has(key))
    if (unknownKey !== undefined) {
      diagnostics.push({ path: `${path}.${unknownKey}`, reason: "unknown-key" })
      continue
    }
    const transport = block.transport
    if (!OPENCLAW_NOTIFICATION_TRANSPORTS.includes(transport)) {
      diagnostics.push({ path: `${path}.transport`, reason: "unsupported-transport" })
      continue
    }
    const targetKey = transport === "discord" ? "channelId" : "chatId"
    const target = block[targetKey]
    const targetValue = typeof target === "number" && Number.isFinite(target) ? String(target) : target
    if (typeof targetValue !== "string" || targetValue.length === 0) {
      diagnostics.push({ path: `${path}.${targetKey}`, reason: "missing-target" })
      continue
    }
    const secret = resolveOpenclawSecretRef(block.token, { env })
    if (!secret.ok) {
      diagnostics.push({ path: `${path}.token`, reason: secret.reason, ...(secret.envName !== undefined ? { envName: secret.envName } : {}) })
      continue
    }
    if (typeof secret.value !== "string" || secret.value.length === 0) {
      diagnostics.push({ path: `${path}.token`, reason: "missing-credential" })
      continue
    }
    if (typeof block.instruction !== "string" || block.instruction.length === 0) {
      diagnostics.push({ path: `${path}.instruction`, reason: "missing-instruction" })
      continue
    }
    if (!Array.isArray(block.events)) {
      diagnostics.push({ path: `${path}.events`, reason: "missing-events" })
      continue
    }
    const invalidEvent = block.events.find((event) => typeof event !== "string" || !OPENCLAW_NOTIFICATION_EVENTS.includes(event))
    if (invalidEvent !== undefined) {
      diagnostics.push({ path: `${path}.events`, reason: "invalid-events" })
      continue
    }
    if (block.events.length === 0) {
      diagnostics.push({ path: `${path}.events`, reason: "missing-events" })
      continue
    }
    channels.push({
      name,
      transport,
      token: secret.value,
      target: targetValue,
      instruction: block.instruction,
      events: [...new Set(block.events)],
    })
  }
  return { channels, diagnostics }
}
