/**
 * Native V2 OpenClaw A2A transport: the CONVERSATIONAL half of
 * `Contrato_Transportes_OpenClaw.md` §1, and the client for the two methods the
 * vendor actually implements (`Contratos_Verificados_OpenClaw.md` §2).
 *
 * §1 separates notification from conversation because their failure modes are
 * incompatible. A notification that is lost is acceptable. A lost `SendMessage`
 * leaves a task running on OpenClaw with no endpoint to find it again (there is
 * no task listing), so the conversational path must write the correlation record
 * BEFORE the request, reconcile with `GetTask`, and never resend blindly: the
 * vendor does not deduplicate by `messageId`, so a retry creates a second task.
 *
 * Three facts from the verified contracts shape every branch below:
 *
 *   - **HTTP 200 is not success.** `-32000`, `-32001`, `-32600`, `-32601`,
 *     `-32602`, `-32700` and the 1 MiB overflow all travel over 200. Only 401,
 *     404 and 413 are non-200, plus the empty-body 200 of a notification-shaped
 *     request.
 *   - **`status.state` is the only truth.** `REJECTED` and `FAILED` arrive as a
 *     JSON-RPC success, so a caller that checks `response.ok` reports a rejection
 *     as an answer.
 *   - **A blocking `SendMessage` may take `replyTimeoutMs`.** The client timeout
 *     therefore has to EXCEED it, or every slow-but-healthy task is reported as a
 *     transport failure while the task keeps running.
 *
 * Peer resolution happens once, at setup, and performs no network at all: the
 * discovery of `/.well-known/agent-card.json` is lazy, on the first send
 * (`Contrato_Transportes_OpenClaw.md` §11.3). Credentials use the U3 reference
 * forms and fail closed per peer, naming the key and the variable but never a
 * value. The card is untrusted input: the endpoint it advertises is put through
 * the same URL policy as the configured one before it is cached or handed the
 * bearer token, and a URL that fails it is never repeated in a diagnostic.
 *
 * Only Node built-ins and sibling native modules are imported so the flat
 * laboratory runtime (no `node_modules`) can load this module.
 */
import { isPlainObject, validateGatewayUrl } from "./rigel-v2-native-openclaw-core.mjs"
import { resolveOpenclawSecretRef } from "./rigel-v2-native-openclaw-secrets.mjs"

/** Status-document surface of the conversational transport. */
export const OPENCLAW_AGENT_STATUS_SURFACE = "a2a"

/** Peer name shape, from the vendor's own validation. */
export const OPENCLAW_A2A_PEER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** Vendor bounds of `replyTimeoutMs`. */
export const OPENCLAW_A2A_MIN_REPLY_TIMEOUT_MS = 5_000
export const OPENCLAW_A2A_MAX_REPLY_TIMEOUT_MS = 600_000
export const OPENCLAW_A2A_DEFAULT_REPLY_TIMEOUT_MS = 120_000

/**
 * Headroom the client adds on top of `replyTimeoutMs`. The vendor answers a
 * blocking send at `replyTimeoutMs`, so a client that timed out at the same
 * instant would report a failure for every request that took its full budget.
 */
export const OPENCLAW_A2A_CLIENT_TIMEOUT_MARGIN_MS = 30_000

/** Request budget per peer per minute (§10). Independent of the declared vendor field. */
export const OPENCLAW_A2A_REQUESTS_PER_MINUTE = 30

/** Keys a `channels.a2a` block may carry. */
const A2A_KEYS = new Set(["enabled", "advertisedUrl", "peers"])

/** Keys a `channels.a2a.peers.<name>` block may carry. */
const PEER_KEYS = new Set(["url", "token", "outboundToken", "replyTimeoutMs"])

/** Discovery path the vendor registers without gateway authentication. */
const AGENT_CARD_PATH = "/.well-known/agent-card.json"

/** Endpoint the vendor serves the two JSON-RPC methods on. */
const A2A_ENDPOINT_PATH = "/a2a/v1"

/** JSON-RPC methods this client may call. `CancelTask` is refused by the vendor on purpose. */
export const OPENCLAW_A2A_METHODS = Object.freeze(["SendMessage", "GetTask"])

/**
 * Send failures that prove the request never created a task, so the record can be
 * settled as `failed` instead of `lost`. Everything else is ambiguous: the task
 * may exist and be unobservable, which is exactly what `lost` reports.
 */
const DEFINITIVE_SEND_FAILURES = new Set([
  "invalid-url",
  "missing-url",
  "unauthorized",
  "peer-not-found",
  "payload-too-large",
  "rpc--32600",
  "rpc--32601",
  "rpc--32602",
  "rpc--32700",
])

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "")
}

/**
 * The endpoint policy of this client, applied to every URL it will cache and
 * send a bearer token to.
 *
 * `validateGatewayUrl` is the same policy the resolver applies to the configured
 * peer URL: https anywhere, plaintext http only on loopback. A URL that carries
 * `userinfo` is refused on top of it, because a credential in a URL is a
 * plaintext secret in a cached value (and `fetch` cannot even build a request
 * from it). Returns the normalized endpoint, or `null`; the refused value is
 * never returned, so no caller can leak it into a diagnostic.
 */
function safeEndpointUrl(value) {
  if (typeof value !== "string" || value.length === 0) return null
  if (!validateGatewayUrl(value)) return null
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) return null
  return trimTrailingSlash(value)
}

/** Peer name for a log line. Identity only: never the url, never the token. */
function peerLabel(peer) {
  return typeof peer?.name === "string" && peer.name.length > 0 ? peer.name : "<unnamed>"
}

/**
 * The client-side timeout for one request. Always strictly greater than
 * `replyTimeoutMs`, which is the acceptance criterion: a blocking send is allowed
 * to consume its whole budget and still be healthy.
 */
export function resolveClientTimeoutMs(replyTimeoutMs) {
  const base = Number.isFinite(replyTimeoutMs) ? replyTimeoutMs : OPENCLAW_A2A_DEFAULT_REPLY_TIMEOUT_MS
  return base + OPENCLAW_A2A_CLIENT_TIMEOUT_MARGIN_MS
}

/**
 * Normalize the vendor's task state to the registry's vocabulary.
 *
 * The vendor documents `TASK_STATE_*` constants and assigns the bare enum, so
 * both spellings are accepted instead of making the whole transport fail on a
 * cosmetic difference. `CANCELED` is never assigned by the vendor; if it ever
 * appears, `failed` is the closest honest state (the task stopped without an
 * answer).
 */
export function normalizeTaskState(value) {
  if (typeof value !== "string" || value.length === 0) return null
  const bare = value.startsWith("TASK_STATE_") ? value.slice("TASK_STATE_".length) : value
  const lower = bare.toLowerCase()
  if (lower === "submitted") return "submitted"
  if (lower === "working") return "working"
  if (lower === "completed") return "completed"
  if (lower === "failed") return "failed"
  if (lower === "rejected") return "rejected"
  if (lower === "canceled" || lower === "cancelled") return "failed"
  return null
}

function joinPartTexts(parts) {
  if (!Array.isArray(parts)) return ""
  const chunks = []
  for (const part of parts) {
    if (!isPlainObject(part)) continue
    if (typeof part.text === "string" && part.text.length > 0) chunks.push(part.text)
  }
  return chunks.join("\n")
}

/**
 * The answer text of a task. The vendor puts it in `artifacts[].parts[]`; a
 * terminal task with no text carries an empty artifact list, which is a
 * legitimate completion and not an error.
 */
export function openclawTaskReplyText(task) {
  if (!isPlainObject(task)) return ""
  const chunks = []
  if (Array.isArray(task.artifacts)) {
    for (const artifact of task.artifacts) {
      const text = joinPartTexts(artifact?.parts)
      if (text.length > 0) chunks.push(text)
    }
  }
  if (chunks.length > 0) return chunks.join("\n").trim()
  return joinPartTexts(task.status?.message?.parts).trim()
}

/** Human text of a rejected or failed task, truncated by the vendor to 512 chars. */
export function openclawTaskStatusMessage(task) {
  if (!isPlainObject(task)) return ""
  const message = task.status?.message
  if (!isPlainObject(message)) return ""
  const fromParts = joinPartTexts(message.parts).trim()
  if (fromParts.length > 0) return fromParts
  return typeof message.text === "string" ? message.text.trim() : ""
}

/** Human text for one rejected peer or channel block. Never a value, never a token. */
export function describeOpenclawAgentPeerDiagnostic(diagnostic) {
  const path = typeof diagnostic?.path === "string" ? diagnostic.path : "openclaw.channels.a2a"
  const reason = diagnostic?.reason
  const subject = typeof diagnostic?.peer === "string" ? "a2a peer" : "a2a channel"
  if (reason === "not-an-object") return `${subject} ${path} is not an object; the A2A converser stays off for it`
  if (reason === "unknown-key") return `${subject} ${path} is not a known key; the A2A converser stays off for it`
  if (reason === "missing-peers") return `a2a channel ${path} names no peer, so nothing can start; the A2A converser stays off`
  if (reason === "no-usable-peers") return `a2a channel ${path} has no usable peer; the A2A converser stays off`
  if (reason === "invalid-peer-name") return `a2a peer ${path} is not a valid peer name; that peer stays off`
  if (reason === "missing-token") return `a2a peer ${path} declares no token; that peer stays off`
  if (reason === "unresolvable-token") {
    return diagnostic?.envName === undefined
      ? `a2a peer ${path} is not a usable secret reference (expected "env:VAR" or { env: "VAR" }); that peer stays off`
      : `a2a peer ${path} names ${diagnostic.envName}, which ${diagnostic.envReason === "empty-env-variable" ? "is empty" : "is not set"}; that peer stays off`
  }
  if (reason === "unresolvable-outbound-token") {
    return diagnostic?.envName === undefined
      ? `a2a peer ${path} carries an unusable outbound token reference; that peer stays off`
      : `a2a peer ${path} names ${diagnostic.envName} as its outbound token, which ${diagnostic.envReason === "empty-env-variable" ? "is empty" : "is not set"}; that peer stays off`
  }
  if (reason === "missing-url") return `a2a peer ${path} declares no url and the channel declares no advertisedUrl; that peer stays off`
  if (reason === "invalid-url") return `a2a peer ${path} is not an HTTPS url (loopback HTTP is allowed); that peer stays off`
  if (reason === "invalid-reply-timeout") return `a2a peer ${path} must be an integer between 5000 and 600000; that peer stays off`
  if (reason === "duplicate-token") return `a2a peer ${path} reuses another peer's token, so the vendor would resolve both to the first one; that peer stays off`
  return `a2a peer ${path} is not usable (${String(reason)}); that peer stays off`
}

/**
 * Resolve `openclaw.channels.a2a` into the peers this runtime can actually dial.
 *
 * Fail closed per peer, never per plugin: a broken reference, an invalid URL, a
 * duplicate token or an unknown key removes exactly that peer and reports the
 * exact path. `enabled` is true only when the surface is switched on AND at least
 * one peer survived, which mirrors the vendor rule that `configured` means "at
 * least one peer" (with `peers: {}` the whole surface answers 404).
 *
 * @param {unknown} rawA2a raw `openclaw.channels.a2a` from the live chain
 * @param {{ env?: Record<string, string|undefined> }} [options]
 */
export function resolveOpenclawAgentPeers(rawA2a, { env } = {}) {
  const none = { declared: false, enabled: false, peers: [], diagnostics: [], disabled: [] }
  if (rawA2a === undefined || rawA2a === null) return none
  if (!isPlainObject(rawA2a)) {
    return {
      declared: true,
      enabled: false,
      peers: [],
      diagnostics: [{ path: "openclaw.channels.a2a", reason: "not-an-object", peer: null }],
      disabled: [],
    }
  }

  const diagnostics = []
  const disabled = []
  const unknownKey = Object.keys(rawA2a).find((key) => !A2A_KEYS.has(key))
  if (unknownKey !== undefined) {
    // An unknown key here is the defect this front exists to remove: the
    // operator wrote something the runtime would otherwise drop in silence.
    return {
      declared: true,
      enabled: false,
      peers: [],
      diagnostics: [{ path: `openclaw.channels.a2a.${unknownKey}`, reason: "unknown-key", peer: null }],
      disabled: [],
    }
  }

  if (rawA2a.enabled !== true) return { declared: true, enabled: false, peers: [], diagnostics, disabled }
  if (!isPlainObject(rawA2a.peers) || Object.keys(rawA2a.peers).length === 0) {
    // `configured` means "at least one peer": with none the vendor registers no
    // route at all, so the whole surface answers 404 including discovery.
    diagnostics.push({ path: "openclaw.channels.a2a.peers", reason: "missing-peers", peer: null })
    return { declared: true, enabled: false, peers: [], diagnostics, disabled }
  }

  const peers = []
  const seenTokens = new Set()
  const advertisedUrl = typeof rawA2a.advertisedUrl === "string" ? rawA2a.advertisedUrl : undefined

  for (const [name, block] of Object.entries(rawA2a.peers)) {
    const path = `openclaw.channels.a2a.peers.${name}`
    const reject = (reason, extra = {}) => {
      diagnostics.push({ path, reason, peer: name, ...extra })
      disabled.push({ peer: name, path, reason })
    }
    if (!OPENCLAW_A2A_PEER_NAME_PATTERN.test(name)) {
      reject("invalid-peer-name")
      continue
    }
    if (!isPlainObject(block)) {
      reject("not-an-object")
      continue
    }
    const peerUnknownKey = Object.keys(block).find((key) => !PEER_KEYS.has(key))
    if (peerUnknownKey !== undefined) {
      diagnostics.push({ path: `${path}.${peerUnknownKey}`, reason: "unknown-key", peer: name })
      disabled.push({ peer: name, path: `${path}.${peerUnknownKey}`, reason: "unknown-key" })
      continue
    }
    if (!Object.prototype.hasOwnProperty.call(block, "token")) {
      reject("missing-token")
      continue
    }
    const token = resolveOpenclawSecretRef(block.token, { env })
    if (!token.ok) {
      reject("unresolvable-token", { envReason: token.reason, envName: token.envName })
      continue
    }
    if (typeof token.value !== "string" || token.value.length === 0) {
      reject("unresolvable-token", { envReason: "empty-env-variable" })
      continue
    }
    let outboundToken = token.value
    if (Object.prototype.hasOwnProperty.call(block, "outboundToken")) {
      const resolved = resolveOpenclawSecretRef(block.outboundToken, { env })
      if (!resolved.ok || typeof resolved.value !== "string" || resolved.value.length === 0) {
        reject("unresolvable-outbound-token", { envReason: resolved.reason, envName: resolved.envName })
        continue
      }
      outboundToken = resolved.value
    }
    if (seenTokens.has(outboundToken)) {
      // The vendor resolves a bearer token by first match in configuration order,
      // so a second peer with the same token is unreachable by construction.
      reject("duplicate-token")
      continue
    }
    const url = typeof block.url === "string" && block.url.length > 0 ? block.url : advertisedUrl
    if (typeof url !== "string" || url.length === 0) {
      reject("missing-url")
      continue
    }
    if (!validateGatewayUrl(url)) {
      reject("invalid-url")
      continue
    }
    let replyTimeoutMs = OPENCLAW_A2A_DEFAULT_REPLY_TIMEOUT_MS
    if (Object.prototype.hasOwnProperty.call(block, "replyTimeoutMs")) {
      const declared = block.replyTimeoutMs
      if (
        !Number.isInteger(declared)
        || declared < OPENCLAW_A2A_MIN_REPLY_TIMEOUT_MS
        || declared > OPENCLAW_A2A_MAX_REPLY_TIMEOUT_MS
      ) {
        reject("invalid-reply-timeout")
        continue
      }
      replyTimeoutMs = declared
    }
    seenTokens.add(outboundToken)
    peers.push({
      name,
      url,
      token: outboundToken,
      replyTimeoutMs,
      clientTimeoutMs: resolveClientTimeoutMs(replyTimeoutMs),
    })
  }

  if (peers.length === 0) {
    diagnostics.push({ path: "openclaw.channels.a2a.peers", reason: "no-usable-peers", peer: null })
    return { declared: true, enabled: false, peers, diagnostics, disabled }
  }
  return { declared: true, enabled: true, peers, diagnostics, disabled }
}

/**
 * Classify one HTTP answer before its body is trusted.
 *
 * Only 401, 404 and 413 are non-200 in the vendor; everything else arrives over
 * 200 and is classified from the JSON-RPC envelope.
 */
function failureFromStatus(status) {
  if (status === 401) return "unauthorized"
  if (status === 404) return "peer-not-found"
  if (status === 413) return "payload-too-large"
  return `http-${status}`
}

function errorClassOfRpcCode(code) {
  return `rpc-${typeof code === "number" ? code : String(code)}`
}

/**
 * Create the A2A client over a resolved peer list.
 *
 * `fetchImpl` is injected so a unit test and the live gate drive a loopback
 * server instead of a real peer. The transport keeps no durable state: the
 * registry owns the write-ahead record and the single in-flight slot.
 *
 * Endpoint discovery is LAZY and cached per peer: the first send resolves
 * `<url>/a2a/v1` through the agent card exactly once, and setup never dials.
 */
export function createOpenclawAgentTransport({ peers = [], fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  const peerIndex = new Map(peers.map((peer) => [peer.name, peer]))
  /** peer name -> resolved endpoint; a miss means discovery has not run yet. */
  const endpoints = new Map()
  let requestSequence = 0

  function nextRequestId() {
    requestSequence += 1
    return `rigel-a2a-${requestSequence}`
  }

  async function discoverEndpoint(peer) {
    // The policy runs BEFORE the card is requested: a peer URL that cannot carry
    // the token must not receive even the discovery probe.
    const base = safeEndpointUrl(peer.url)
    if (base === null) {
      log(`[oh-my-rigel] Native V2 openclaw a2a peer ${peerLabel(peer)} has no usable url; nothing is dialled`)
      return null
    }
    if (base.endsWith(A2A_ENDPOINT_PATH)) return base
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), peer.clientTimeoutMs)
    try {
      const response = await fetchImpl(`${base}${AGENT_CARD_PATH}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      })
      if (!response.ok) return `${base}${A2A_ENDPOINT_PATH}`
      const body = JSON.parse(await response.text())
      const interfaces = Array.isArray(body?.supportedInterfaces) ? body.supportedInterfaces : []
      const advertised = interfaces.find((entry) => typeof entry?.url === "string" && entry.url.length > 0)
      if (advertised === undefined) return `${base}${A2A_ENDPOINT_PATH}`
      // The card is untrusted input. An endpoint outside the policy is refused
      // outright instead of being cached and handed the bearer token; the
      // documented endpoint of the validated base is the fallback, exactly as it
      // is when the card is absent.
      const endpoint = safeEndpointUrl(advertised.url)
      if (endpoint === null) {
        log(`[oh-my-rigel] Native V2 openclaw a2a peer ${peerLabel(peer)} advertised an endpoint outside the url policy; using the documented endpoint`)
        return `${base}${A2A_ENDPOINT_PATH}`
      }
      return endpoint
    } catch {
      // The card is decorative (only `skills[]` filtering); the documented
      // endpoint is the correct fallback and the send below reports the truth.
      return `${base}${A2A_ENDPOINT_PATH}`
    } finally {
      clearTimeout(timer)
    }
  }

  /** Resolved endpoint for a peer, discovering it on the FIRST use only. */
  async function endpointFor(peerName) {
    const peer = peerIndex.get(peerName)
    if (peer === undefined) return null
    const cached = endpoints.get(peerName)
    if (cached !== undefined) return cached
    const resolved = await discoverEndpoint(peer)
    // A refused URL is not cached: the cache holds endpoints that passed the
    // policy, never the absence of one.
    if (resolved !== null) endpoints.set(peerName, resolved)
    return resolved
  }

  /**
   * One JSON-RPC call. Returns a discriminated result and never throws: every
   * failure becomes a named class so the caller can decide between `failed` and
   * `lost` (the difference between "no task was created" and "we cannot tell").
   */
  async function call(peerName, method, params, { timeoutMs, signal } = {}) {
    const peer = peerIndex.get(peerName)
    if (peer === undefined) return { ok: false, errorClass: "unknown-peer" }
    const endpoint = await endpointFor(peerName)
    // The only ways to get here are an unusable peer URL (the unknown peer is
    // refused above), and both prove no request was made, so the record can be
    // settled instead of reported lost.
    if (endpoint === null) return { ok: false, errorClass: "invalid-url" }
    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : peer.clientTimeoutMs
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, budget)
    const forwardAbort = () => controller.abort()
    if (signal !== undefined) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener("abort", forwardAbort, { once: true })
    }
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${peer.token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextRequestId(), method, params }),
        signal: controller.signal,
      })
      if (!response.ok) return { ok: false, errorClass: failureFromStatus(response.status) }
      const raw = await response.text()
      if (typeof raw !== "string" || raw.trim().length === 0) return { ok: false, errorClass: "empty-response" }
      let body
      try {
        body = JSON.parse(raw)
      } catch {
        return { ok: false, errorClass: "invalid-json" }
      }
      if (isPlainObject(body) && body.error !== undefined && body.error !== null) {
        return { ok: false, errorClass: errorClassOfRpcCode(body.error?.code), rpcCode: body.error?.code ?? null }
      }
      if (!isPlainObject(body) || body.result === undefined) return { ok: false, errorClass: "malformed-response" }
      return { ok: true, result: body.result }
    } catch (error) {
      if (timedOut) return { ok: false, errorClass: "timeout" }
      if (signal?.aborted) return { ok: false, errorClass: "aborted" }
      const name = error instanceof Error ? error.name : ""
      if (name === "AbortError") return { ok: false, errorClass: timedOut ? "timeout" : "aborted" }
      return { ok: false, errorClass: "network" }
    } finally {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener("abort", forwardAbort)
    }
  }

  /**
   * `SendMessage`. The vendor always answers the Task branch (never a bare
   * Message), and ignores `message.taskId`; the returned `task.id` is the only
   * id `GetTask` will accept.
   */
  async function send({ peer, text, contextId, messageId, signal, timeoutMs } = {}) {
    const params = {
      message: {
        role: "ROLE_USER",
        parts: [{ kind: "text", text, mediaType: "text/plain" }],
        messageId,
        contextId,
      },
    }
    const outcome = await call(peer, "SendMessage", params, { signal, timeoutMs })
    if (!outcome.ok) return { kind: "failed", errorClass: outcome.errorClass }
    const task = isPlainObject(outcome.result?.task) ? outcome.result.task : null
    if (task === null) return { kind: "failed", errorClass: "malformed-response" }
    const remoteTaskId = typeof task.id === "string" && task.id.length > 0 ? task.id : null
    if (remoteTaskId === null) return { kind: "failed", errorClass: "malformed-response" }
    const state = normalizeTaskState(task.status?.state) ?? "submitted"
    return {
      kind: "task",
      remoteTaskId,
      state,
      replyText: openclawTaskReplyText(task),
      statusMessage: openclawTaskStatusMessage(task),
      contextId: typeof task.contextId === "string" ? task.contextId : null,
    }
  }

  /**
   * `GetTask`. The vendor returns the bare task here, without the `{ task }`
   * wrapper `SendMessage` uses, so both shapes are unwrapped.
   */
  async function getTask({ peer, remoteTaskId, signal, timeoutMs } = {}) {
    const outcome = await call(peer, "GetTask", { id: remoteTaskId }, { signal, timeoutMs })
    if (!outcome.ok) return { kind: "failed", errorClass: outcome.errorClass, rpcCode: outcome.rpcCode ?? null }
    const candidate = isPlainObject(outcome.result?.task) ? outcome.result.task : outcome.result
    if (!isPlainObject(candidate)) return { kind: "failed", errorClass: "malformed-response" }
    const state = normalizeTaskState(candidate.status?.state)
    if (state === null) return { kind: "failed", errorClass: "unknown-task-state" }
    return {
      kind: "task",
      remoteTaskId: typeof candidate.id === "string" ? candidate.id : remoteTaskId,
      state,
      replyText: openclawTaskReplyText(candidate),
      statusMessage: openclawTaskStatusMessage(candidate),
      contextId: typeof candidate.contextId === "string" ? candidate.contextId : null,
    }
  }

  return {
    send,
    getTask,
    endpointFor,
    peerNames: () => [...peerIndex.keys()],
    hasPeer: (name) => peerIndex.has(name),
    isDefinitiveSendFailure: (errorClass) => DEFINITIVE_SEND_FAILURES.has(errorClass),
  }
}
