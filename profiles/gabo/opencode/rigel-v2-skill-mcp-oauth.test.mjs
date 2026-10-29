import { describe, expect, test } from "bun:test"
import {
  buildAuthorizationUrl,
  createNativeOAuthProvider,
  createOAuthHttpMcpClient,
  generateCodeChallenge,
  generateCodeVerifier,
  isOAuthConfigured,
  isStepUpRequired,
  mergeScopes,
  tokenStorageKey,
} from "./rigel-v2-skill-mcp-oauth.mjs"

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key) : undefined },
    async set(key, value) { map.set(key, value) },
  }
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })
}

const METADATA = {
  authorization_endpoint: "https://auth.example.com/authorize",
  token_endpoint: "https://auth.example.com/token",
  registration_endpoint: "https://auth.example.com/register",
  scopes_supported: ["mcp:read", "mcp:write"],
}

function discoveryFetch(overrides = {}) {
  const seen = []
  return {
    seen,
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      seen.push({ url, init })
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return jsonResponse({ authorization_servers: ["https://auth.example.com"] }, overrides.prmStatus ?? 200)
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) return jsonResponse(METADATA)
      if (url === METADATA.registration_endpoint) {
        if (overrides.registrationStatus) return jsonResponse({ error: "invalid_client_metadata" }, overrides.registrationStatus)
        return jsonResponse({ client_id: "dynamic-client", client_secret: "dynamic-secret" })
      }
      if (url === METADATA.token_endpoint) {
        if (overrides.tokenFailure) return jsonResponse(overrides.tokenFailure, overrides.tokenFailureStatus ?? 400)
        const form = new URLSearchParams(init?.body ?? "")
        if (form.get("grant_type") === "authorization_code") {
          return jsonResponse({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 })
        }
        return jsonResponse({ access_token: "access-2", expires_in: 3600 })
      }
      return new Response("not found", { status: 404 })
    },
  }
}

function callbackOrigin(authorizationUrl) {
  // The callback port lives on the redirect_uri parameter, not on the
  // authorization endpoint itself (which is https and has no explicit port).
  const url = new URL(authorizationUrl)
  return new URL(url.searchParams.get("redirect_uri")).origin
}

function driveCallbackWith(authorizationUrl, { code = "the-code", state } = {}) {
  const issued = new URL(authorizationUrl).searchParams.get("state")
  const effectiveState = state ?? issued
  return fetch(`${callbackOrigin(authorizationUrl)}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(effectiveState)}`)
}

function driveCallback(authorizationUrl) {
  return driveCallbackWith(authorizationUrl)
}

function driveCallbackError(authorizationUrl, error = "access_denied") {
  return fetch(`${callbackOrigin(authorizationUrl)}/callback?error=${encodeURIComponent(error)}`)
}

describe("oauth primitives", () => {
  test("isOAuthConfigured requires both an oauth block and a url", () => {
    expect(isOAuthConfigured({ oauth: { scopes: [] }, url: "https://x" })).toBe(true)
    expect(isOAuthConfigured({ oauth: { scopes: [] } })).toBe(false)
    expect(isOAuthConfigured({ url: "https://x" })).toBe(false)
    expect(isOAuthConfigured({ oauth: false, url: "https://x" })).toBe(false)
  })

  test("PKCE material follows the S256 shape", () => {
    const verifier = generateCodeVerifier()
    const challenge = generateCodeChallenge(verifier)
    expect(verifier.length).toBeGreaterThanOrEqual(40)
    expect(challenge).not.toBe(verifier)
    const url = buildAuthorizationUrl("https://auth.example.com/authorize", {
      clientId: "c1", redirectUri: "http://localhost:0/callback", codeChallenge: challenge, state: "s1", scopes: ["mcp:read"], resource: "https://mcp.example.com",
    })
    expect(url).toContain("code_challenge_method=S256")
    expect(url).toContain("scope=mcp%3Aread")
    expect(url).toContain("resource=https%3A%2F%2Fmcp.example.com")
  })

  test("step-up parses WWW-Authenticate scopes and mergeScopes is additive", () => {
    const stepUp = isStepUpRequired(403, { "WWW-Authenticate": `Bearer error="insufficient_scope", scope="mcp:write admin"` })
    expect(stepUp.requiredScopes).toEqual(["mcp:write", "admin"])
    expect(isStepUpRequired(401, { "WWW-Authenticate": `scope="x"` })).toBeNull()
    expect(isStepUpRequired(403, {})).toBeNull()
    expect(mergeScopes(["mcp:read"], ["mcp:write", "mcp:read"])).toEqual(["mcp:read", "mcp:write"])
  })
})

describe("native OAuth provider", () => {
  test("full PKCE login: discovery, DCR, authorization code exchange, token persistence", async () => {
    // given
    const storage = memoryStorage()
    const { fetchImpl, seen } = discoveryFetch()
    const provider = createNativeOAuthProvider({
      serverUrl: "https://mcp.example.com",
      scopes: ["mcp:read"],
      fetchImpl,
      storage,
      openBrowser: (authorizationUrl) => { void driveCallback(authorizationUrl) },
    })
    expect(provider.tokens()).toBeNull()
    // when
    const tokenData = await provider.login()
    // then
    expect(tokenData.accessToken).toBe("access-1")
    expect(provider.tokens()).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1" })
    expect(seen.some((entry) => entry.url.endsWith("/.well-known/oauth-protected-resource"))).toBe(true)
    expect(seen.some((entry) => entry.url === METADATA.registration_endpoint)).toBe(true)
    const stored = await storage.get([...storage.map.keys()][0])
    expect(stored.accessToken).toBe("access-1")
  })

  test("a persisted valid token is reused without opening the browser", async () => {
    const serverUrl = "https://mcp.example.com"
    const storage = memoryStorage({ [tokenStorageKey(serverUrl)]: { accessToken: "persisted-access", expiresAt: Math.floor(Date.now() / 1000) + 3600 } })
    let browserOpened = false
    const provider = createNativeOAuthProvider({
      serverUrl,
      clientId: "static-client",
      storage,
      fetchImpl: async () => { throw new Error("token reuse must not contact OAuth discovery") },
      openBrowser: () => { browserOpened = true },
    })
    expect(await provider.getValidToken()).toBe("persisted-access")
    expect(browserOpened).toBe(false)
  })

  test("a static clientId skips DCR and refresh exchanges grant_type=refresh_token", async () => {
    // given
    const { fetchImpl, seen } = discoveryFetch()
    const provider = createNativeOAuthProvider({
      serverUrl: "https://mcp.example.com",
      clientId: "static-client",
      fetchImpl,
      openBrowser: (authorizationUrl) => { void driveCallback(authorizationUrl) },
    })
    await provider.login()
    // when
    const refreshed = await provider.refresh("refresh-1")
    // then
    expect(refreshed.accessToken).toBe("access-2")
    expect(seen.some((entry) => entry.url === METADATA.registration_endpoint)).toBe(false)
  })

  test("refresh retains the persisted refresh token when the server does not rotate it", async () => {
    const serverUrl = "https://mcp.example.com"
    const storage = memoryStorage({
      [tokenStorageKey(serverUrl)]: {
        accessToken: "expired-access",
        refreshToken: "stable-refresh",
        expiresAt: 0,
      },
    })
    const grants = []
    let refreshCount = 0
    let browserOpened = false
    const fetchImpl = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return jsonResponse({ authorization_servers: ["https://auth.example.com"] })
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) return jsonResponse(METADATA)
      if (url === METADATA.token_endpoint) {
        const form = new URLSearchParams(init?.body)
        grants.push({ grantType: form.get("grant_type"), refreshToken: form.get("refresh_token") })
        refreshCount += 1
        return jsonResponse({ access_token: `access-${refreshCount}`, expires_in: 3600 })
      }
      throw new Error(`unexpected OAuth request: ${url}`)
    }
    const provider = createNativeOAuthProvider({
      serverUrl,
      clientId: "static-client",
      storage,
      fetchImpl,
      openBrowser: () => { browserOpened = true },
    })

    expect(await provider.getValidToken()).toBe("access-1")
    provider.invalidateAccessToken()
    expect(await provider.getValidToken()).toBe("access-2")

    expect(grants).toEqual([
      { grantType: "refresh_token", refreshToken: "stable-refresh" },
      { grantType: "refresh_token", refreshToken: "stable-refresh" },
    ])
    expect((await storage.get(tokenStorageKey(serverUrl))).refreshToken).toBe("stable-refresh")
    expect(browserOpened).toBe(false)
  })

  test("getValidToken refreshes an expired token without a second login", async () => {
    const { fetchImpl } = discoveryFetch()
    const provider = createNativeOAuthProvider({
      serverUrl: "https://mcp.example.com",
      clientId: "static-client",
      fetchImpl,
      openBrowser: (authorizationUrl) => { void driveCallback(authorizationUrl) },
    })
    await provider.login()
    const before = provider.tokens()
    const token = await provider.getValidToken()
    expect(token).toBe("access-1")
    // force expiry: refresh path returns access-2
    provider.tokens().expiresAt = 0
    const token2 = await provider.getValidToken()
    expect(token2).toBe("access-2")
    void before
  })

  test("a state mismatch or missing registration endpoint fails loudly", async () => {
    const { fetchImpl } = discoveryFetch()
    const provider = createNativeOAuthProvider({ serverUrl: "https://mcp.example.com", fetchImpl })
    // no registration endpoint override: use metadata without registration
    const noDcrFetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.endsWith("/.well-known/oauth-protected-resource")) return new Response("no", { status: 404 })
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return jsonResponse({ authorization_endpoint: METADATA.authorization_endpoint, token_endpoint: METADATA.token_endpoint })
      }
      return new Response("no", { status: 404 })
    }
    const strict = createNativeOAuthProvider({ serverUrl: "https://mcp.example.com", fetchImpl: noDcrFetch })
    await expect(strict.login()).rejects.toThrow("no registration endpoint")
    void provider
    void fetchImpl
  })

  test("a callback state mismatch is rejected and no token is persisted", async () => {
    // given: the browser returns a state the provider never issued
    const storage = memoryStorage()
    const { fetchImpl } = discoveryFetch()
    const provider = createNativeOAuthProvider({
      serverUrl: "https://mcp.example.com",
      clientId: "static-client",
      fetchImpl,
      storage,
      openBrowser: (authorizationUrl) => { void driveCallbackWith(authorizationUrl, { state: "not-the-issued-state" }) },
    })
    // when / then
    await expect(provider.login()).rejects.toThrow("OAuth state parameter mismatch")
    expect(provider.tokens()).toBeNull()
    expect(storage.map.size).toBe(0)
  })

  test("a token endpoint error surfaces error and error_description", async () => {
    // given: the token endpoint rejects the authorization code
    const storage = memoryStorage()
    const { fetchImpl } = discoveryFetch({ tokenFailure: { error: "invalid_grant", error_description: "code already used" } })
    const provider = createNativeOAuthProvider({
      serverUrl: "https://mcp.example.com",
      clientId: "static-client",
      fetchImpl,
      storage,
      openBrowser: (authorizationUrl) => { void driveCallback(authorizationUrl) },
    })
    // when / then
    await expect(provider.login()).rejects.toThrow("Token exchange failed: invalid_grant: code already used")
    expect(provider.tokens()).toBeNull()
    expect(storage.map.size).toBe(0)
  })

  test("refresh rejects when the token endpoint answers 400", async () => {
    // given: every token request fails with a 400 OAuth error body
    const { fetchImpl } = discoveryFetch({ tokenFailure: { error: "invalid_grant", error_description: "refresh token expired" } })
    const provider = createNativeOAuthProvider({ serverUrl: "https://mcp.example.com", clientId: "static-client", fetchImpl })
    // when / then
    await expect(provider.refresh("bad")).rejects.toThrow("Token exchange failed: invalid_grant: refresh token expired")
    expect(provider.tokens()).toBeNull()
  })

  test("dynamic client registration failure is surfaced with the status", async () => {
    // given: the registration endpoint answers non-ok
    const { fetchImpl } = discoveryFetch({ registrationStatus: 400 })
    const provider = createNativeOAuthProvider({
      serverUrl: "https://mcp.example.com",
      fetchImpl,
      openBrowser: () => { /* registration fails before any browser open */ },
    })
    // when / then
    await expect(provider.login()).rejects.toThrow("OAuth dynamic client registration failed (400)")
    expect(provider.tokens()).toBeNull()
  })

  test("a callback that never arrives times out with the configured timeout and port", async () => {
    // given: timeout override, and a browser that deliberately never drives the callback
    const { fetchImpl } = discoveryFetch()
    const provider = createNativeOAuthProvider({
      serverUrl: "https://mcp.example.com",
      clientId: "static-client",
      fetchImpl,
      callbackTimeoutMs: 50,
      openBrowser: () => { /* deliberately never drives the callback */ },
    })
    // when / then
    await expect(provider.login()).rejects.toThrow(/^OAuth callback timed out after 50ms on port \d+$/)
    expect(provider.tokens()).toBeNull()
  })

  test("a callback error query parameter is surfaced", async () => {
    // given: the browser returns ?error=access_denied instead of a code
    const storage = memoryStorage()
    const { fetchImpl } = discoveryFetch()
    const provider = createNativeOAuthProvider({
      serverUrl: "https://mcp.example.com",
      clientId: "static-client",
      fetchImpl,
      storage,
      openBrowser: (authorizationUrl) => { void driveCallbackError(authorizationUrl, "access_denied") },
    })
    // when / then
    await expect(provider.login()).rejects.toThrow("OAuth authorization failed: access_denied")
    expect(provider.tokens()).toBeNull()
    expect(storage.map.size).toBe(0)
  })
})

describe("OAuth MCP HTTP client", () => {
  function mcpFetch({ expectedToken, failFirstWith }) {
    const calls = []
    let initialized = 0
    return {
      calls,
      fetchImpl: async (input, init) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url === "https://mcp.example.com") {
          calls.push({ url, authorization: init?.headers?.authorization, body: init?.body, status: undefined })
          const auth = init?.headers?.authorization ?? ""
          if (expectedToken && auth !== `Bearer ${expectedToken[calls.length - 1] ?? expectedToken[0]}`) {
            return new Response("unauthorized", { status: 401, headers: { "www-authenticate": `Bearer error="invalid_token", scope="mcp:read"` } })
          }
          const payload = JSON.parse(init?.body ?? "{}")
          if (payload.method === "initialize") {
            initialized += 1
            void initialized
            return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: { protocolVersion: "2025-03-26" } })
          }
          if (failFirstWith && calls.length <= failFirstWith.afterCalls && payload.method === "tools/call") {
            return new Response("forbidden", { status: failFirstWith.status, headers: failFirstWith.headers })
          }
          return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: { tools: [] } })
        }
        return discoveryFetch().fetchImpl(input, init)
      },
    }
  }

  test("injects the bearer token from the OAuth flow into MCP requests", async () => {
    // given: the MCP server accepts any bearer; first request carries access-1
    const { fetchImpl, calls } = mcpFetch({ expectedToken: ["access-1"] })
    const client = createOAuthHttpMcpClient({
      url: "https://mcp.example.com",
      oauth: { clientId: "static-client", scopes: ["mcp:read"] },
      fetchImpl,
      openBrowser: (authorizationUrl) => { void driveCallback(authorizationUrl) },
    })
    // when
    await client.initialize()
    const result = await client.listTools()
    // then
    expect(result).toEqual([])
    expect(calls.some((call) => call.authorization === "Bearer access-1")).toBe(true)
  })

  test("a 401 triggers one fresh-token retry instead of surfacing the failure", async () => {
    // given: a persisted bearer is rejected, but its refresh grant is still valid
    const serverUrl = "https://mcp.example.com"
    const storage = memoryStorage({
      [tokenStorageKey(serverUrl)]: {
        accessToken: "persisted-access",
        refreshToken: "persisted-refresh",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    })
    const calls = []
    const grants = []
    let toolCalls = 0
    let browserOpened = false
    const mcp = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url === "https://auth.example.com/token") {
        const body = new URLSearchParams(init?.body)
        grants.push({ grantType: body.get("grant_type"), refreshToken: body.get("refresh_token") })
        return jsonResponse({ access_token: "refreshed-access", refresh_token: "next-refresh", expires_in: 3600 })
      }
      if (url === "https://mcp.example.com/.well-known/oauth-protected-resource") {
        return jsonResponse({ authorization_servers: ["https://auth.example.com"] })
      }
      if (url === "https://mcp.example.com/.well-known/oauth-authorization-server") {
        return jsonResponse(METADATA)
      }
      if (url !== serverUrl) throw new Error(`unexpected OAuth request: ${url}`)
      const payload = JSON.parse(init?.body ?? "{}")
      calls.push({ url, authorization: init?.headers?.authorization, body: init?.body })
      if (payload.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: {} })
      if (payload.method === "tools/call" || payload.method === "tools/list") {
        toolCalls += 1
        if (toolCalls === 1) {
          return new Response("expired", { status: 401, headers: { "www-authenticate": `Bearer scope="mcp:read"` } })
        }
        return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: { tools: [{ name: "ok" }] } })
      }
      return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: {} })
    }
    const client = createOAuthHttpMcpClient({
      url: serverUrl,
      oauth: { clientId: "static-client" },
      fetchImpl: mcp,
      storage,
      openBrowser: () => { browserOpened = true },
    })
    await client.initialize()
    // when
    const result = await client.listTools()
    // then: the retry after refresh succeeds
    expect(result.map((tool) => tool.name)).toEqual(["ok"])
    expect(calls.filter((call) => call.body?.includes("tools/list"))).toHaveLength(2)
    expect(grants).toEqual([{ grantType: "refresh_token", refreshToken: "persisted-refresh" }])
    expect(calls.at(-1)?.authorization).toBe("Bearer refreshed-access")
    expect(browserOpened).toBe(false)
  })

  test("a 403 with WWW-Authenticate scopes performs step-up and retries", async () => {
    // given
    let stepUpDone = false
    const mcp = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url === METADATA.token_endpoint) {
        return jsonResponse({ access_token: "access-1", expires_in: 3600 })
      }
      if (url !== "https://mcp.example.com") {
        return jsonResponse(METADATA)
      }
      const payload = JSON.parse(init?.body ?? "{}")
      if (payload.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: {} })
      if (payload.method === "tools/list") {
        if (!stepUpDone) {
          stepUpDone = true
          return new Response("insufficient", { status: 403, headers: { "www-authenticate": `Bearer error="insufficient_scope", scope="mcp:write"` } })
        }
        return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: { tools: [{ name: "stepped" }] } })
      }
      return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: {} })
    }
    const client = createOAuthHttpMcpClient({
      url: "https://mcp.example.com",
      oauth: { clientId: "static-client", scopes: ["mcp:read"] },
      fetchImpl: mcp,
      openBrowser: (authorizationUrl) => { void driveCallback(authorizationUrl) },
    })
    await client.initialize()
    // when
    const result = await client.listTools()
    // then
    expect(result.map((tool) => tool.name)).toEqual(["stepped"])
    expect(client.oauthProvider.scopes).toContain("mcp:write")
  })
})
