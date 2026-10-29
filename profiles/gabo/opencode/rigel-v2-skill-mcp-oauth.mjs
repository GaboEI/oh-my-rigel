// Native OpenCode V2 OAuth 2.0 for skill-embedded MCP HTTP servers
// (Phase-4 Ola 6, counterpart of V1 `features/mcp-oauth/**` +
// `mcp-client-core/src/mcp-oauth/**`).
//
// Manager-side flow, mirroring the V1 semantics:
// - discovery: protected-resource metadata (`/.well-known/oauth-protected-resource`)
//   -> `authorization_servers`, then authorization-server metadata
//   (`/.well-known/oauth-authorization-server`).
// - dynamic client registration (RFC 7591) when no static `clientId` is set.
// - authorization-code flow with PKCE S256 through a localhost callback server.
// - token persistence through the V2 storage domain (never a file in the user
//   home), refresh via `grant_type=refresh_token`, and 403 step-up handling
//   (merge `WWW-Authenticate` scopes, re-login).
//
// The interactive flow opens the system browser; tests inject `openBrowser`
// and `fetchImpl`, and drive the callback server directly.

import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { spawn } from "node:child_process"

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000
export const TOKEN_STORAGE_PREFIX = "rigel-v2/oauth-token/"
// Parallel to V1 `mcp-oauth/storage-index.ts`: the token entry is keyed by a
// hash of the server URL, so an index entry is the only way to recover the URL
// (and the human label) for `status`/`logout` without guessing.
export const TOKEN_INDEX_PREFIX = "rigel-v2/oauth-token-index/"

export function isOAuthConfigured(config) {
  return Boolean(config?.oauth && typeof config?.url === "string" && config.url.trim())
}

function b64url(value) {
  return Buffer.from(value).toString("base64url")
}

export function generateCodeVerifier() {
  return randomBytes(32).toString("base64url")
}

export function generateCodeChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url")
}

export function buildAuthorizationUrl(authorizationEndpoint, { clientId, redirectUri, codeChallenge, state, scopes, resource }) {
  const url = new URL(authorizationEndpoint)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", clientId)
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("code_challenge", codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", state)
  if (Array.isArray(scopes) && scopes.length > 0) url.searchParams.set("scope", scopes.join(" "))
  if (resource) url.searchParams.set("resource", resource)
  return url.toString()
}

// Subscribe-first callback waiter: the server listens BEFORE the browser opens,
// so a fast redirect can never be lost.
function createCallbackWaiter(port, redirectPath, timeoutMs = CALLBACK_TIMEOUT_MS) {
  let settle
  const promise = new Promise((resolve, reject) => { settle = { resolve, reject } })
  const timeout = setTimeout(() => {
    try { server.close() } catch { /* already closed */ }
    settle.reject(new Error(`OAuth callback timed out after ${timeoutMs}ms on port ${port}`))
  }, timeoutMs)
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://localhost:${port}`)
    if (requestUrl.pathname !== redirectPath && requestUrl.pathname !== "/") {
      response.writeHead(404)
      response.end()
      return
    }
    const code = requestUrl.searchParams.get("code")
    const state = requestUrl.searchParams.get("state")
    const error = requestUrl.searchParams.get("error")
    if (error) {
      response.writeHead(400, { "content-type": "text/html" })
      response.end("<html><body><h1>Authorization failed</h1></body></html>")
      close()
      settle.reject(new Error(`OAuth authorization failed: ${error}`))
      return
    }
    if (!code || !state) {
      response.writeHead(400, { "content-type": "text/html" })
      response.end("<html><body><h1>Missing code or state</h1></body></html>")
      return
    }
    response.writeHead(200, { "content-type": "text/html" })
    response.end("<html><body><h1>Authorization successful. You can close this tab.</h1></body></html>")
    close()
    settle.resolve({ code, state })
  })
  function close() {
    if (timeout) clearTimeout(timeout)
    try { server.close() } catch { /* already closed */ }
  }
  server.on("error", (error) => {
    close()
    settle.reject(error)
  })
  server.listen(port, "127.0.0.1", () => {})
  return { promise, close }
}

export function openSystemBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]
  try {
    return spawn(command, args, { stdio: "ignore", detached: true }).unref()
  } catch {
    return undefined
  }
}

async function fetchJson(fetchImpl, url, init) {
  const response = await fetchImpl(url, init)
  const body = await response.text()
  let json = null
  try { json = JSON.parse(body) } catch { json = null }
  return { status: response.status, ok: response.ok, json, body }
}

// Discovery: PRM first (RFC 9728), then the authorization-server metadata; the
// V1 fallback order is preserved (issuer path first, then root well-known).
export async function discoverOAuthServerMetadata(serverUrl, fetchImpl = fetch) {
  const resourceUrl = new URL(serverUrl)
  if (resourceUrl.protocol !== "https:" && resourceUrl.protocol !== "http:") {
    throw new Error("OAuth resource server URL must be http(s)")
  }
  const resourceOrigin = resourceUrl.origin
  const resourcePath = resourceUrl.pathname.replace(/\/+$/, "")
  const prmUrl = `${resourceOrigin}/.well-known/oauth-protected-resource${resourcePath}`
  const prm = await fetchJson(fetchImpl, prmUrl)
  if (prm.ok && Array.isArray(prm.json?.authorization_servers) && prm.json.authorization_servers.length > 0) {
    for (const issuer of prm.json.authorization_servers) {
      if (typeof issuer !== "string" || !issuer) continue
      try {
        return await fetchAuthorizationServerMetadata(issuer, fetchImpl)
      } catch { /* try the next advertised issuer */ }
    }
  }
  if (prm.status !== 404 && !prm.ok && prm.status !== 200) {
    // A non-404 PRM failure means the resource exists but is misconfigured.
    throw new Error(`OAuth protected resource metadata fetch failed (${prm.status})`)
  }
  return await fetchAuthorizationServerMetadata(serverUrl, fetchImpl)
}

async function fetchAuthorizationServerMetadata(issuer, fetchImpl) {
  const issuerUrl = new URL(issuer)
  const issuerPath = issuerUrl.pathname.replace(/\/+$/, "")
  const candidates = []
  if (issuerPath) candidates.push(`${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`)
  candidates.push(`${issuerUrl.origin}/.well-known/oauth-authorization-server`)
  candidates.push(`${issuerUrl.origin}/.well-known/openid-configuration`)
  let lastStatus = 0
  for (const metadataUrl of candidates) {
    const metadata = await fetchJson(fetchImpl, metadataUrl)
    if (metadata.ok && metadata.json) {
      const authorizationEndpoint = metadata.json.authorization_endpoint
      const tokenEndpoint = metadata.json.token_endpoint
      if (typeof authorizationEndpoint !== "string" || typeof tokenEndpoint !== "string") {
        throw new Error("OAuth authorization server metadata missing endpoints")
      }
      return {
        authorizationEndpoint,
        tokenEndpoint,
        registrationEndpoint: typeof metadata.json.registration_endpoint === "string" ? metadata.json.registration_endpoint : undefined,
        scopesSupported: Array.isArray(metadata.json.scopes_supported)
          ? metadata.json.scopes_supported.filter((scope) => typeof scope === "string")
          : undefined,
      }
    }
    lastStatus = metadata.status
  }
  if (lastStatus === 404) throw new Error("OAuth authorization server metadata not found")
  throw new Error(`OAuth authorization server metadata fetch failed (${lastStatus})`)
}

// RFC 7591 dynamic client registration.
async function registerClient(registrationEndpoint, { serverUrl, scopes, fetchImpl }) {
  const registration = await fetchJson(fetchImpl, registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["http://localhost/callback"],
      client_name: "oh-my-rigel",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(Array.isArray(scopes) && scopes.length > 0 ? { scope: scopes.join(" ") } : {}),
    }),
  })
  if (!registration.ok || typeof registration.json?.client_id !== "string") {
    throw new Error(`OAuth dynamic client registration failed (${registration.status})`)
  }
  return {
    clientId: registration.json.client_id,
    ...(typeof registration.json.client_secret === "string" ? { clientSecret: registration.json.client_secret } : {}),
  }
}

async function exchangeToken(tokenEndpoint, form, fetchImpl) {
  const tokenResponse = await fetchJson(fetchImpl, tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  })
  if (!tokenResponse.ok) {
    let detail = String(tokenResponse.body ?? "").slice(0, 200)
    if (tokenResponse.json?.error) detail = `${tokenResponse.json.error}${tokenResponse.json.error_description ? `: ${tokenResponse.json.error_description}` : ""}`
    throw new Error(`Token exchange failed: ${detail || tokenResponse.status}`)
  }
  const tokenData = tokenResponse.json ?? {}
  if (typeof tokenData.access_token !== "string") throw new Error("Token response missing access_token")
  return {
    accessToken: tokenData.access_token,
    refreshToken: typeof tokenData.refresh_token === "string" ? tokenData.refresh_token : undefined,
    expiresAt: typeof tokenData.expires_in === "number" ? Math.floor(Date.now() / 1000) + tokenData.expires_in : undefined,
  }
}

export function tokenStorageKey(serverUrl) {
  return `${TOKEN_STORAGE_PREFIX}${tokenHash(serverUrl)}`
}

function tokenHash(serverUrl) {
  return createHash("sha256").update(serverUrl).digest("hex").slice(0, 24)
}

function tokenIndexKey(serverUrl) {
  return `${TOKEN_INDEX_PREFIX}${tokenHash(serverUrl)}`
}

/**
 * Mirror of V1 `mcp-oauth/storage.ts` `normalizeHost`: reduce a server URL or
 * host string to the bare host so `status` can address a token the way V1 did
 * (scheme/port/path tolerant).
 */
export function normalizeServerHost(value) {
  let host = String(value ?? "").trim()
  if (!host) return host
  if (host.includes("://")) {
    try { host = new URL(host).hostname } catch { host = host.split("/")[0] ?? "" }
  } else {
    host = host.split("/")[0] ?? ""
  }
  if (host.startsWith("[")) {
    const closing = host.indexOf("]")
    return closing !== -1 ? host.slice(0, closing + 1) : host
  }
  return host.includes(":") ? (host.split(":")[0] ?? "") : host
}

export function isTokenExpired(tokenData, now = Date.now()) {
  if (tokenData?.expiresAt == null) return false
  return tokenData.expiresAt < Math.floor(now / 1000)
}

/**
 * V2 counterpart of V1 `mcp-oauth/storage.ts` + `storage-index.ts`, over the
 * official `ctx.storage` domain (never a file in the user home). The token value
 * keeps the V1 `OAuthTokenData` shape; a parallel index entry recovers the
 * server URL and the human label so `status`/`logout` can address a token by
 * URL or by the name the user logged in with.
 */
export function createOAuthTokenStore({ storage } = {}) {
  const canGet = Boolean(storage) && typeof storage.get === "function"
  const canSet = Boolean(storage) && typeof storage.set === "function"
  const canRemove = Boolean(storage) && typeof storage.remove === "function"
  const canScan = Boolean(storage) && typeof storage.scan === "function"

  async function scanAll(prefix) {
    const entries = []
    let after
    do {
      const page = await storage.scan({ prefix, ...(after ? { after } : {}) })
      const listed = Array.isArray(page) ? page : page?.entries ?? []
      for (const entry of listed) entries.push(entry)
      after = Array.isArray(page) ? undefined : page?.next
    } while (after)
    return entries
  }

  return {
    keyFor: (serverUrl) => tokenStorageKey(serverUrl),
    indexKeyFor: (serverUrl) => tokenIndexKey(serverUrl),
    async load(serverUrl) {
      if (!canGet) return null
      return (await storage.get(tokenStorageKey(serverUrl))) ?? null
    },
    async save(serverUrl, tokens) {
      if (!canSet) return false
      await storage.set(tokenStorageKey(serverUrl), tokens)
      return true
    },
    async remember(serverUrl, name) {
      if (!canSet) return false
      await storage.set(tokenIndexKey(serverUrl), { serverUrl, ...(name ? { name } : {}) })
      return true
    },
    async clear(serverUrl) {
      let removed = false
      if (canRemove) {
        await storage.remove(tokenStorageKey(serverUrl))
        await storage.remove(tokenIndexKey(serverUrl))
        removed = true
      }
      return removed
    },
    async entries() {
      if (!canScan) return []
      const listed = await scanAll(TOKEN_STORAGE_PREFIX)
      return listed.map((entry) => ({
        hash: entry.key.slice(TOKEN_STORAGE_PREFIX.length),
        token: entry.value,
        storageKey: entry.key,
      }))
    },
    async index() {
      if (!canScan) return []
      const listed = await scanAll(TOKEN_INDEX_PREFIX)
      const index = new Map()
      for (const entry of listed) {
        const value = entry.value
        const hash = entry.key.slice(TOKEN_INDEX_PREFIX.length)
        if (value && typeof value.serverUrl === "string") {
          index.set(hash, { serverUrl: value.serverUrl, ...(typeof value.name === "string" ? { name: value.name } : {}) })
        }
      }
      return index
    },
  }
}

export function isStepUpRequired(statusCode, headers) {
  if (statusCode !== 403) return null
  const wwwAuth = headers?.["www-authenticate"] ?? headers?.["WWW-Authenticate"]
  if (!wwwAuth) return null
  const scopeMatch = /scope="([^"]*)"/i.exec(wwwAuth)
  const errorMatch = /error="([^"]*)"/i.exec(wwwAuth)
  const errorDescriptionMatch = /error_description="([^"]*)"/i.exec(wwwAuth)
  const requiredScopes = scopeMatch ? scopeMatch[1].split(/[\s+]+/).filter(Boolean) : []
  if (requiredScopes.length === 0) return null
  return {
    requiredScopes,
    ...(errorMatch ? { error: errorMatch[1] } : {}),
    ...(errorDescriptionMatch ? { errorDescription: errorDescriptionMatch[1] } : {}),
  }
}

export function mergeScopes(current, required) {
  const merged = [...(current ?? [])]
  for (const scope of required ?? []) {
    if (!merged.includes(scope)) merged.push(scope)
  }
  return merged
}

export function createNativeOAuthProvider({
  serverUrl,
  clientId,
  scopes = [],
  resource,
  fetchImpl = fetch,
  storage,
  openBrowser = openSystemBrowser,
  callbackPort = 0,
  callbackRedirectPath = "/callback",
  callbackTimeoutMs = CALLBACK_TIMEOUT_MS,
} = {}) {
  if (!serverUrl || typeof serverUrl !== "string") throw new Error("OAuth provider requires a server URL")
  let tokens = null
  let tokensHydrated = false
  let clientCredentials = typeof clientId === "string" && clientId ? { clientId } : null
  let cachedMetadata = null
  let currentScopes = [...scopes]

  async function hydrateTokens() {
    if (tokensHydrated) return tokens
    tokensHydrated = true
    if (storage && typeof storage.get === "function") {
      const stored = await storage.get(tokenStorageKey(serverUrl))
      tokens = stored && typeof stored.accessToken === "string" ? stored : null
    }
    return tokens
  }

  async function persistTokens(next) {
    tokens = next
    tokensHydrated = true
    if (storage && typeof storage.set === "function") {
      await storage.set(tokenStorageKey(serverUrl), tokens)
    }
  }

  async function ensureMetadata() {
    if (cachedMetadata) return cachedMetadata
    cachedMetadata = await discoverOAuthServerMetadata(serverUrl, fetchImpl)
    return cachedMetadata
  }

  async function ensureClientCredentials(metadata) {
    if (clientCredentials) return clientCredentials
    if (!metadata.registrationEndpoint) {
      throw new Error(`OAuth server ${serverUrl} has no registration endpoint and no static clientId is configured`)
    }
    clientCredentials = await registerClient(metadata.registrationEndpoint, { serverUrl, scopes: currentScopes, fetchImpl })
    return clientCredentials
  }

  async function login() {
    const metadata = await ensureMetadata()
    const credentials = await ensureClientCredentials(metadata)
    const verifier = generateCodeVerifier()
    const challenge = generateCodeChallenge(verifier)
    const state = randomBytes(16).toString("hex")
    const port = Number.isInteger(callbackPort) && callbackPort > 0 ? callbackPort : await findAvailablePort()
    const redirectUri = `http://localhost:${port}${callbackRedirectPath}`
    const authorizationUrl = buildAuthorizationUrl(metadata.authorizationEndpoint, {
      clientId: credentials.clientId,
      redirectUri,
      codeChallenge: challenge,
      state,
      scopes: currentScopes,
      resource,
    })
    // Subscribe first: the callback server listens BEFORE the browser opens,
    // so a fast redirect can never be lost.
    const callback = createCallbackWaiter(port, callbackRedirectPath, callbackTimeoutMs)
    openBrowser?.(authorizationUrl)
    try {
      const result = await callback.promise
      if (result.state !== state) throw new Error("OAuth state parameter mismatch")
      const tokenData = await exchangeToken(metadata.tokenEndpoint, {
        grant_type: "authorization_code",
        code: result.code,
        redirect_uri: redirectUri,
        client_id: credentials.clientId,
        ...(credentials.clientSecret ? { client_secret: credentials.clientSecret } : {}),
        code_verifier: verifier,
        ...(resource ? { resource } : {}),
      }, fetchImpl)
      await persistTokens(tokenData)
      return tokenData
    } finally {
      callback.close()
    }
  }

  async function refresh(refreshToken) {
    const metadata = await ensureMetadata()
    const credentials = await ensureClientCredentials(metadata)
    const tokenData = await exchangeToken(metadata.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: credentials.clientId,
      ...(credentials.clientSecret ? { client_secret: credentials.clientSecret } : {}),
    }, fetchImpl)
    // RFC 6749 allows a refresh response to omit `refresh_token`. In that case
    // the existing grant remains authoritative; dropping it would force an
    // unnecessary interactive login on the next expiry or resource-server 401.
    const persisted = { ...tokenData, refreshToken: tokenData.refreshToken ?? refreshToken }
    await persistTokens(persisted)
    return persisted
  }

  async function getValidToken() {
    await hydrateTokens()
    if (tokens && !isTokenExpired(tokens)) return tokens.accessToken
    if (tokens?.refreshToken) {
      try {
        return (await refresh(tokens.refreshToken)).accessToken
      } catch { /* fall through to a full login */ }
    }
    return (await login()).accessToken
  }

  function stepUp(requiredScopes) {
    currentScopes = mergeScopes(currentScopes, requiredScopes)
    tokens = null
  }

  function invalidateAccessToken() {
    // A resource-server 401 rejects the bearer, not the refresh grant. Keep the
    // refresh token long enough for getValidToken() to try the non-interactive
    // refresh path before falling back to a full authorization-code login.
    tokens = tokens ? { ...tokens, expiresAt: 0 } : null
  }

  return {
    get serverUrl() { return serverUrl },
    get scopes() { return [...currentScopes] },
    tokens: () => tokens,
    login,
    refresh,
    getValidToken,
    stepUp,
    invalidateAccessToken,
  }
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
    server.on("error", reject)
  })
}

// A full MCP JSON-RPC 2.0 client over Streamable HTTP with OAuth: it mirrors
// `createHttpMcpClient` (SSE + session id carry) and adds the manager-side
// auth behavior: bearer injection, one 401 refresh-or-relogin retry, and one
// 403 step-up retry.
export function createOAuthHttpMcpClient({ url, oauth, headers = {}, fetchImpl = fetch, storage, openBrowser, callbackPort }) {
  const provider = createNativeOAuthProvider({
    serverUrl: url,
    ...(typeof oauth?.clientId === "string" ? { clientId: oauth.clientId } : {}),
    ...(Array.isArray(oauth?.scopes) ? { scopes: oauth.scopes } : typeof oauth?.scope === "string" ? { scopes: oauth.scope.split(/[\s+]+/).filter(Boolean) } : {}),
    ...(typeof oauth?.resource === "string" ? { resource: oauth.resource } : {}),
    fetchImpl,
    storage,
    openBrowser,
    ...(Number.isInteger(oauth?.callbackPort) && oauth.callbackPort > 0 ? { callbackPort: oauth.callbackPort } : {}),
    ...(Number.isInteger(oauth?.callbackTimeoutMs) && oauth.callbackTimeoutMs > 0 ? { callbackTimeoutMs: oauth.callbackTimeoutMs } : {}),
  })
  const state = { sessionID: null, protocolVersion: "2024-11-05" }

  function baseHeadersWithBearer(extra) {
    return { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers, ...extra }
  }

  async function post(payload, bearerToken) {
    const extra = bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}
    const requestHeaders = state.sessionID ? { ...baseHeadersWithBearer(extra), "mcp-session-id": state.sessionID } : baseHeadersWithBearer(extra)
    const response = await fetchImpl(url, { method: "POST", headers: requestHeaders, body: JSON.stringify(payload) })
    const issued = response.headers?.get?.("mcp-session-id")
    if (issued) state.sessionID = issued
    if (response.status === 202 || response.status === 204) return null
    if (!response.ok) {
      const error = new Error(`MCP HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`)
      error.status = response.status
      error.wwwAuthenticate = response.headers?.get?.("www-authenticate") ?? undefined
      throw error
    }
    const contentType = response.headers?.get?.("content-type") ?? ""
    const body = await response.text()
    if (!body.trim()) return null
    if (contentType.includes("text/event-stream")) {
      const dataLines = body.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean)
      const messages = dataLines.map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
      return messages.find((message) => message.id === payload.id) ?? messages.at(-1) ?? null
    }
    try { return JSON.parse(body) } catch { return null }
  }

  async function requestWithAuth(method, params) {
    const attempt = async (bearerToken) => {
      const id = Math.floor(Math.random() * 1e9)
      const message = await post({ jsonrpc: "2.0", id, method, params }, bearerToken)
      if (message?.error) throw new Error(message.error.message ?? JSON.stringify(message.error))
      return message?.result ?? {}
    }
    const bearer = await provider.getValidToken()
    try {
      return await attempt(bearer)
    } catch (error) {
      const status = error.status ?? Number(/\bHTTP (\d{3})\b/.exec(error.message)?.[1] ?? 0)
      if (status === 403) {
        const stepUp = isStepUpRequired(403, { "www-authenticate": error.wwwAuthenticate })
        if (stepUp) {
          provider.stepUp(stepUp.requiredScopes)
          return attempt(await provider.getValidToken())
        }
      }
      if (status !== 401 && status !== 403) throw error
      // Force a fresh token (refresh first, full login as fallback) and retry once.
      provider.invalidateAccessToken()
      return attempt(await provider.getValidToken())
    }
  }

  return {
    transport: "http",
    oauthProvider: provider,
    async initialize() {
      const result = await requestWithAuth("initialize", { protocolVersion: state.protocolVersion, capabilities: {}, clientInfo: { name: "oh-my-rigel", version: "1.0.0" } })
      if (typeof result?.protocolVersion === "string") state.protocolVersion = result.protocolVersion
      await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, await provider.getValidToken())
    },
    listTools: async () => (await requestWithAuth("tools/list", {})).tools ?? [],
    callTool: async ({ name, arguments: toolArgs }) => await requestWithAuth("tools/call", { name, arguments: toolArgs ?? {} }),
    listResources: async () => (await requestWithAuth("resources/list", {})).resources ?? [],
    readResource: async ({ uri }) => await requestWithAuth("resources/read", { uri }),
    listPrompts: async () => (await requestWithAuth("prompts/list", {})).prompts ?? [],
    getPrompt: async ({ name, arguments: promptArgs }) => await requestWithAuth("prompts/get", { name, arguments: promptArgs ?? {} }),
    async close() {
      if (!state.sessionID) return
      try {
        await fetchImpl(url, { method: "DELETE", headers: { ...baseHeadersWithBearer({}), "mcp-session-id": state.sessionID } })
      } catch { /* best effort */ }
    },
  }
}
