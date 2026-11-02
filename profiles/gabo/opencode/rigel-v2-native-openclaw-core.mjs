/**
 * Native OpenCode V2 OpenClaw core: the pure, I/O-free half of the bidirectional
 * integration. This is a runtime-only port of the V1 owners
 * (`packages/openclaw-core/src/{config,dispatcher,runtime-dispatch,reply-listener-injection}.ts`).
 * Every function here is deterministic and dependency-free so it can be unit
 * tested without a host, a network, or a session.
 *
 * Behavior contracts preserved verbatim from V1:
 *   - event -> hook alias lookup (`session.created -> [session.created,
 *     session-start]`, `session.deleted -> [session.deleted, session-end]`,
 *     `session.idle -> [session.idle, stop]`);
 *   - instruction interpolation empties a missing `{{var}}`, while the command
 *     interpreter keeps an undefined placeholder literal and shell-escapes values;
 *   - wake-metadata extraction accepts correlation fields from a JSON object
 *     (`messageId`/`platform`/`channelId`/`threadId` plus aliases) or falls back
 *     to the V1 text patterns (`Message ID: <id>` / `Sent via <platform>`);
 *   - `sanitizeReplyInput` strips C0 controls and bidi/zero-width marks, folds
 *     newlines to spaces, escapes the shell-active characters and trims;
 *   - the Discord platform normalizes to `discord-bot`.
 */

/** Raw V1 session events mapped to the ordered hook keys V1 tries. */
export const OPENCLAW_EVENT_HOOKS = Object.freeze({
  "session.created": Object.freeze(["session.created", "session-start"]),
  "session.deleted": Object.freeze(["session.deleted", "session-end"]),
  "session.idle": Object.freeze(["session.idle", "stop"]),
})

/** Context keys V1 forwarded to a gateway payload (`buildWhitelistedContext`). */
export const OPENCLAW_CONTEXT_WHITELIST = Object.freeze([
  "sessionId",
  "projectPath",
  "tmuxSession",
  "prompt",
  "contextSummary",
  "reasoning",
  "question",
  "tmuxTail",
  "replyChannel",
  "replyTarget",
  "replyThread",
])

export const DEFAULT_HTTP_TIMEOUT_MS = 10_000
export const DEFAULT_COMMAND_TIMEOUT_MS = 5_000
export const MIN_COMMAND_TIMEOUT_MS = 100
export const MAX_COMMAND_TIMEOUT_MS = 300_000

export const DEFAULT_REPLY_POLL_INTERVAL_MS = 3_000
export const MIN_REPLY_POLL_INTERVAL_MS = 500
export const MAX_REPLY_POLL_INTERVAL_MS = 60_000
export const DEFAULT_REPLY_RATE_LIMIT_PER_MINUTE = 10
export const DEFAULT_REPLY_MAX_MESSAGE_LENGTH = 500
export const MIN_REPLY_MAX_MESSAGE_LENGTH = 1
export const MAX_REPLY_MAX_MESSAGE_LENGTH = 4_000

/** Env var V1 reads as the command-transport timeout fallback. */
export const COMMAND_TIMEOUT_ENV = "OMO_OPENCLAW_COMMAND_TIMEOUT_MS"
/** Env var V1 reads for verbose wake logging. */
export const DEBUG_ENV = "OMO_OPENCLAW_DEBUG"

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeInteger(value, minimum, maximum, fallback) {
  const parsed = typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : typeof value === "string" && value.trim() !== "" ? Math.trunc(Number(value)) : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  if (parsed < minimum) return minimum
  if (parsed > maximum) return maximum
  return parsed
}

/**
 * Port of `normalizeReplyListenerConfig`. Returns a new record with bounded
 * integers and a filtered authorized-user list. `includePrefix` defaults true
 * (`!== false`). Returns `undefined` when no reply-listener block is present.
 */
export function normalizeReplyListenerConfig(raw) {
  if (!isPlainObject(raw)) return undefined
  return {
    ...raw,
    authorizedDiscordUserIds: Array.isArray(raw.authorizedDiscordUserIds)
      ? raw.authorizedDiscordUserIds.filter((entry) => typeof entry === "string" && entry.length > 0)
      : [],
    pollIntervalMs: normalizeInteger(raw.pollIntervalMs, MIN_REPLY_POLL_INTERVAL_MS, MAX_REPLY_POLL_INTERVAL_MS, DEFAULT_REPLY_POLL_INTERVAL_MS),
    rateLimitPerMinute: normalizeInteger(raw.rateLimitPerMinute, 1, Number.MAX_SAFE_INTEGER, DEFAULT_REPLY_RATE_LIMIT_PER_MINUTE),
    maxMessageLength: normalizeInteger(raw.maxMessageLength, MIN_REPLY_MAX_MESSAGE_LENGTH, MAX_REPLY_MAX_MESSAGE_LENGTH, DEFAULT_REPLY_MAX_MESSAGE_LENGTH),
    includePrefix: raw.includePrefix !== false,
  }
}

const OPENCLAW_KEYS = new Set(["enabled", "gateways", "hooks", "replyListener"])
const GATEWAY_KEYS = new Set(["type", "url", "method", "headers", "command", "timeout"])
const HOOK_KEYS = new Set(["enabled", "gateway", "instruction"])
const REPLY_LISTENER_KEYS = new Set([
  "discordBotToken", "discordChannelId", "discordMention", "authorizedDiscordUserIds",
  "telegramBotToken", "telegramChatId", "pollIntervalMs", "rateLimitPerMinute",
  "maxMessageLength", "includePrefix",
])

export class OpenclawConfigValidationError extends Error {
  constructor(path) {
    super(`unknown OpenClaw configuration key at ${path}`)
    this.name = "OpenclawConfigValidationError"
    this.path = path
  }
}

function unknownKeyPath(record, allowed, path) {
  if (!isPlainObject(record)) return undefined
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return `${path}.${key}`
  }
  return undefined
}

function findUnknownOpenclawKey(raw) {
  const root = unknownKeyPath(raw, OPENCLAW_KEYS, "openclaw")
  if (root) return root
  if (isPlainObject(raw.gateways)) {
    for (const [name, gateway] of Object.entries(raw.gateways)) {
      const path = unknownKeyPath(gateway, GATEWAY_KEYS, `openclaw.gateways.${name}`)
      if (path) return path
    }
  }
  if (isPlainObject(raw.hooks)) {
    for (const [name, hook] of Object.entries(raw.hooks)) {
      const path = unknownKeyPath(hook, HOOK_KEYS, `openclaw.hooks.${name}`)
      if (path) return path
    }
  }
  return unknownKeyPath(raw.replyListener, REPLY_LISTENER_KEYS, "openclaw.replyListener")
}

/**
 * Normalize a resolved `openclaw` config block. Returns `null` when the block is
 * absent or `enabled !== true`, which is the single strict no-op gate the whole
 * surface keys off (no dispatch, no listener, no network).
 */
export function normalizeOpenclawConfig(raw, { onInvalid } = {}) {
  if (!isPlainObject(raw) || raw.enabled !== true) return null
  const unknownPath = findUnknownOpenclawKey(raw)
  if (unknownPath) {
    onInvalid?.(new OpenclawConfigValidationError(unknownPath))
    return null
  }
  return {
    enabled: true,
    gateways: isPlainObject(raw.gateways) ? { ...raw.gateways } : {},
    hooks: isPlainObject(raw.hooks) ? { ...raw.hooks } : {},
    replyListener: normalizeReplyListenerConfig(raw.replyListener),
  }
}

/**
 * Port of `validateGatewayUrl`. HTTPS is required except for loopback HTTP
 * (`localhost`, `127.0.0.1`, `::1`, `[::1]`). A non-parseable value is invalid.
 */
export function validateGatewayUrl(url) {
  if (typeof url !== "string" || url.length === 0) return false
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol === "https:") return true
  if (parsed.protocol !== "http:") return false
  return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1" || parsed.hostname === "[::1]"
}

/** Ordered hook keys V1 tries for a raw session event. Unknown events yield []. */
export function mapRawEventToHooks(rawEvent) {
  const mapped = OPENCLAW_EVENT_HOOKS[rawEvent]
  return mapped ? [...mapped] : []
}

/**
 * Port of `resolveGateway`: returns `{ gatewayName, gateway, instruction }` for a
 * hook event, or `null` when the hook is absent/disabled or its gateway is
 * missing. `type` defaults to `http`; an http gateway needs a `url`, a command
 * gateway needs a `command`.
 */
export function resolveGateway(config, hookEvent) {
  if (!config || config.enabled !== true) return null
  const mapping = config.hooks?.[hookEvent]
  if (!isPlainObject(mapping) || mapping.enabled === false) return null
  if (typeof mapping.gateway !== "string" || mapping.gateway.length === 0) return null
  const gateway = config.gateways?.[mapping.gateway]
  if (!isPlainObject(gateway)) return null
  const type = gateway.type === "command" ? "command" : "http"
  if (type === "command") {
    if (typeof gateway.command !== "string" || gateway.command.length === 0) return null
  } else if (typeof gateway.url !== "string" || gateway.url.length === 0) {
    return null
  }
  return { gatewayName: mapping.gateway, gateway: { ...gateway, type }, instruction: typeof mapping.instruction === "string" ? mapping.instruction : "" }
}

/** Port of `interpolateInstruction`: a missing variable becomes the empty string. */
export function interpolateInstruction(template, variables) {
  if (typeof template !== "string") return ""
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => variables?.[key] ?? "")
}

/** Port of `shellEscapeArg`: single-quote wrapping with `'\''` escaping. */
export function shellEscapeArg(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

/**
 * Port of the command interpolation: an undefined placeholder is preserved
 * literally (unlike the instruction pass) and a defined value is shell-escaped.
 */
export function interpolateCommand(template, variables) {
  if (typeof template !== "string") return ""
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = variables?.[key]
    return value === undefined ? match : shellEscapeArg(value)
  })
}

/** Port of `resolveCommandTimeoutMs`: gateway timeout, then env, then 5000; clamp [100, 300000]. */
export function resolveCommandTimeoutMs(gatewayTimeout, envRaw = process.env[COMMAND_TIMEOUT_ENV]) {
  const finite = typeof gatewayTimeout === "number" && Number.isFinite(gatewayTimeout)
    ? gatewayTimeout
    : typeof envRaw === "string" && envRaw.trim() !== "" && Number.isFinite(Number(envRaw)) ? Number(envRaw) : DEFAULT_COMMAND_TIMEOUT_MS
  return Math.min(MAX_COMMAND_TIMEOUT_MS, Math.max(MIN_COMMAND_TIMEOUT_MS, Math.trunc(finite)))
}

/** Port of `normalizePlatform`: the Discord platform normalizes to `discord-bot`. */
export function normalizePlatform(platform) {
  return platform === "discord" ? "discord-bot" : platform
}

/** Port of `buildWhitelistedContext`: only the documented keys survive. */
export function buildWhitelistedContext(context) {
  const result = {}
  for (const key of OPENCLAW_CONTEXT_WHITELIST) {
    const value = context?.[key]
    if (value !== undefined) result[key] = value
  }
  return result
}

function firstStringValue(record, aliases) {
  if (!isPlainObject(record)) return undefined
  for (const alias of aliases) {
    const value = record[alias]
    if (typeof value === "string" && value.length > 0) return value
    if (typeof value === "number" && Number.isFinite(value)) return String(value)
  }
  return undefined
}

/**
 * Port of `extractWakeMetadata`: score each candidate record by the correlation
 * fields it carries and return the best-scoring set. A record with no field
 * yields `{}`.
 */
export function extractWakeMetadata(payload) {
  const record = isPlainObject(payload) ? payload : {}
  const candidates = [record, record.data, record.result, record.message]
  let best = {}
  let bestScore = 0
  for (const candidate of candidates) {
    const messageId = firstStringValue(candidate, ["messageId", "message_id", "id"])
    const platform = firstStringValue(candidate, ["platform", "source"])
    const channelId = firstStringValue(candidate, ["channelId", "channel_id", "channel"])
    const threadId = firstStringValue(candidate, ["threadId", "thread_id", "thread"])
    const score = (messageId ? 4 : 0) + (platform ? 3 : 0) + (channelId ? 2 : 0) + (threadId ? 1 : 0)
    if (score > bestScore) {
      bestScore = score
      best = {}
      if (messageId) best.messageId = messageId
      if (platform) best.platform = platform
      if (channelId) best.channelId = channelId
      if (threadId) best.threadId = threadId
    }
  }
  return best
}

/**
 * Port of `parseWakeMetadata`: JSON first, then the V1 text patterns. Empty input
 * yields `{}`; a JSON number/string yields `{}`.
 */
export function parseWakeMetadata(raw) {
  if (typeof raw !== "string") return {}
  const text = raw.trim()
  if (text.length === 0) return {}
  try {
    const parsed = JSON.parse(text)
    if (isPlainObject(parsed)) return extractWakeMetadata(parsed)
  } catch {
    // not JSON: fall through to the text patterns
  }
  const metadata = {}
  const messageMatch = /message\s+id:\s*([^\s]+)/i.exec(text)
  if (messageMatch?.[1]) metadata.messageId = messageMatch[1]
  const platformMatch = /sent\s+via\s+([a-z0-9_-]+)/i.exec(text)
  if (platformMatch?.[1]) metadata.platform = platformMatch[1].toLowerCase()
  return metadata
}

/**
 * Port of `sanitizeReplyInput`. Strips C0 controls and bidi/zero-width marks,
 * folds newlines to spaces, escapes backslash, backtick, `$(` and `${`, then trims.
 */
export function sanitizeReplyInput(text) {
  return String(text ?? "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\r?\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\(/g, "\\$(")
    .replace(/\$\{/g, "\\${")
    .trim()
}

/**
 * Port of `ReplyListenerRateLimiter`. A sliding 60_000 ms window; `canProceed()`
 * records the timestamp when it allows a message.
 */
export function createReplyListenerRateLimiter(maxPerMinute, now = Date.now) {
  const limit = Number.isFinite(maxPerMinute) && maxPerMinute > 0 ? Math.trunc(maxPerMinute) : DEFAULT_REPLY_RATE_LIMIT_PER_MINUTE
  const windowMs = 60_000
  const timestamps = []
  return {
    canProceed() {
      const current = now()
      while (timestamps.length > 0 && current - timestamps[0] > windowMs) timestamps.shift()
      if (timestamps.length >= limit) return false
      timestamps.push(current)
      return true
    },
  }
}

/** The exact downstream payload V1 POSTs (or interpolates into a command). */
export function buildOpenclawPayload({ event, instruction, timestamp, context }) {
  const enriched = context ?? {}
  const payload = {
    event,
    instruction,
    text: instruction,
    timestamp,
  }
  for (const key of ["sessionId", "projectPath", "projectName", "tmuxSession", "tmuxTail"]) {
    if (enriched[key] !== undefined) payload[key] = enriched[key]
  }
  if (enriched.replyChannel !== undefined) payload.channel = enriched.replyChannel
  if (enriched.replyTarget !== undefined) payload.to = enriched.replyTarget
  if (enriched.replyThread !== undefined) payload.threadId = enriched.replyThread
  payload.context = buildWhitelistedContext(enriched)
  return payload
}

/** Basename of a project path without importing node:path (pure, portable). */
export function projectNameOf(projectPath) {
  if (typeof projectPath !== "string" || projectPath.length === 0) return ""
  const normalized = projectPath.replace(/[\\/]+$/, "")
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"))
  return index >= 0 ? normalized.slice(index + 1) : normalized
}
