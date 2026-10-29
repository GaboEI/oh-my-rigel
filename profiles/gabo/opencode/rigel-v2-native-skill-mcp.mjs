// Native OpenCode V2 port of OmO's tier-3 skill-embedded MCP surface.
//
// V1 lives in `packages/mcp-client-core/src/skill-mcp-manager` (per-session
// client registry keyed `${sessionID}:${skillName}:${serverName}`, stdio +
// HTTP transports, env cleaning, error redaction) and
// `packages/omo-opencode/src/tools/skill-mcp` (the `skill_mcp` tool). The
// deployed V2 runtime cannot import `@modelcontextprotocol/sdk` (no
// node_modules beside it), so this module ships a small, real JSON-RPC 2.0 MCP
// client for both transports plus the per-session manager.
//
// Skill MCP servers are also exposed through V2's native `context.mcp.transform`
// surface (translated to V2 `local`/`remote` config), while isolated invocation
// stays in the manager so sessions never share an MCP client.

import { spawn } from "node:child_process"
import { createOAuthHttpMcpClient, isOAuthConfigured } from "./rigel-v2-skill-mcp-oauth.mjs"

export const SKILL_MCP_TOOL_NAME = "skill_mcp"
export const SKILL_MCP_DESCRIPTION = "Invoke MCP server operations from skill-embedded MCPs. Requires mcp_name plus exactly one of: tool_name, resource_name, or prompt_name."

export const BUILTIN_MCP_TOOL_HINTS = {
  context7: ["context7_resolve-library-id", "context7_query-docs"],
  websearch: ["websearch_web_search_exa"],
  grep_app: ["grep_app_searchGitHub"],
}

// Mirrors `env-cleaner.ts`: the blacklist applies only to inherited ambient
// vars; skill-declared env entries pass through so a server can receive its
// configured credentials.
export const EXCLUDED_ENV_PATTERNS = [
  /^NPM_CONFIG_/i, /^YARN_/i, /^PNPM_/i, /^NO_UPDATE_NOTIFIER$/i,
  /^ANTHROPIC_API_KEY$/i, /^AWS_ACCESS_KEY_ID$/i, /^AWS_SECRET_ACCESS_KEY$/i,
  /^GOOGLE_APPLICATION_CREDENTIALS$/i, /^GOOGLE_CLOUD_PROJECT$/i, /^GITHUB_TOKEN$/i,
  /^DATABASE_URL$/i, /^OPENAI_API_KEY$/i, /^AZURE_/i, /^GCP_/i, /^FIREBASE_/i,
  /^HEROKU_/i, /^DOCKER_AUTH/i, /^KUBECONFIG$/i, /^VAULT_/i,
  /_KEY$/i, /_SECRET$/i, /_TOKEN$/i, /_PASSWORD$/i, /_CREDENTIAL$/i, /_CREDENTIALS$/i, /_API_KEY$/i,
]

const SENSITIVE_PATTERNS = [
  /[a-zA-Z0-9_-]*(?:api[_-]?key|apikey)["\s]*[:=]["\s]*([a-zA-Z0-9_-]{16,})/gi,
  /[a-zA-Z0-9_-]*(?:auth[_-]?token|authtoken)["\s]*[:=]["\s]*([a-zA-Z0-9_-]{16,})/gi,
  /[a-zA-Z0-9_-]*(?:access[_-]?token|accesstoken)["\s]*[:=]["\s]*([a-zA-Z0-9_-]{16,})/gi,
  /[a-zA-Z0-9_-]*(?:secret)["\s]*[:=]["\s]*([a-zA-Z0-9_-]{16,})/gi,
  /[a-zA-Z0-9_-]*(?:password)["\s]*[:=]["\s]*([a-zA-Z0-9_-]{8,})/gi,
  /bearer\s+([a-zA-Z0-9_-]{20,})/gi,
  /sk-[a-zA-Z0-9]{20,}/g,
  /gh[pousr]_[a-zA-Z0-9]{20,}/gi,
  /glpat-[a-zA-Z0-9_-]{20,}/gi,
  /xox[baprs]-[a-zA-Z0-9-]{10,}/gi,
]

export function redactSensitiveData(input) {
  let result = String(input ?? "")
  for (const pattern of SENSITIVE_PATTERNS) result = result.replace(pattern, "[REDACTED]")
  return result
}

export function createCleanMcpEnvironment(customEnv = {}, ambientEnv = process.env) {
  const clean = {}
  for (const [key, value] of Object.entries(ambientEnv ?? {})) {
    if (value === undefined) continue
    if (EXCLUDED_ENV_PATTERNS.some((pattern) => pattern.test(key))) continue
    clean[key] = value
  }
  Object.assign(clean, customEnv ?? {})
  return clean
}

// Mirrors `connection-type.ts`: explicit type > url presence > command presence.
export function getConnectionType(config) {
  if (config?.type === "http" || config?.type === "sse") return "http"
  if (config?.type === "stdio") return "stdio"
  if (config?.url) return "http"
  if (config?.command) return "stdio"
  return null
}

// Translate a V1 `ClaudeCodeMcpServer` into a V2 `McpLocalConfig` /
// `McpRemoteConfig`. Unsupported (commandless local / urlless remote) returns
// null so the caller can skip it explicitly instead of registering a broken
// server.
export function translateSkillMcpConfig(config) {
  const type = getConnectionType(config)
  if (type === "stdio" && typeof config?.command === "string" && config.command.trim()) {
    const translated = { type: "local", command: [config.command, ...(config.args ?? [])] }
    if (config.env && Object.keys(config.env).length > 0) translated.environment = { ...config.env }
    if (config.disabled === true) translated.enabled = false
    return translated
  }
  if (type === "http" && typeof config?.url === "string" && config.url.trim()) {
    const translated = { type: "remote", url: config.url }
    if (config.headers && Object.keys(config.headers).length > 0) translated.headers = { ...config.headers }
    if (config.oauth === false) translated.oauth = false
    else if (config.oauth && typeof config.oauth === "object") {
      const scopes = Array.isArray(config.oauth.scopes)
        ? config.oauth.scopes.filter((scope) => typeof scope === "string" && scope.trim()).join(" ")
        : typeof config.oauth.scope === "string" ? config.oauth.scope : undefined
      translated.oauth = {
        ...(typeof config.oauth.clientId === "string" ? { clientId: config.oauth.clientId } : {}),
        ...(typeof config.oauth.clientSecret === "string" ? { clientSecret: config.oauth.clientSecret } : {}),
        ...(scopes ? { scope: scopes } : {}),
        ...(Number.isInteger(config.oauth.callbackPort) ? { callbackPort: config.oauth.callbackPort } : {}),
        ...(typeof config.oauth.redirectUri === "string" ? { redirectUri: config.oauth.redirectUri } : {}),
      }
    }
    if (config.disabled === true) translated.enabled = false
    return translated
  }
  return null
}

export function buildSkillMcpClientKey(info, options) {
  const base = `${info.sessionID}:${info.skillName}:${info.serverName}`
  return options?.cdpUrl ? `${base}::cdp=${options.cdpUrl}` : base
}

function withCdpEndpoint(config, options) {
  if (!options?.cdpUrl) return config
  const next = { ...config, args: [...(config.args ?? []), "--cdp-endpoint", options.cdpUrl] }
  return next
}

const RPC_TIMEOUT_MS = 20000

function rpcError(message) {
  const error = new Error(redactSensitiveData(message))
  error.name = "SkillMcpError"
  return error
}

// A real MCP JSON-RPC 2.0 client over newline-delimited stdio.
export function createStdioMcpClient({ command, args = [], env, cwd }) {
  const child = spawn(command, args, {
    cwd,
    env: createCleanMcpEnvironment(env),
    stdio: ["pipe", "pipe", "pipe"],
  })
  let buffer = ""
  let nextId = 1
  let closed = false
  let stderr = ""
  const pending = new Map()

  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk) => {
    buffer += chunk
    let newline = buffer.indexOf("\n")
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) handleLine(line)
      newline = buffer.indexOf("\n")
    }
  })
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000) })
  child.on("exit", (code) => {
    closed = true
    for (const [, entry] of pending) entry.reject(rpcError(`MCP server exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`))
    pending.clear()
  })
  child.on("error", (error) => {
    closed = true
    for (const [, entry] of pending) entry.reject(rpcError(error.message))
    pending.clear()
  })

  function handleLine(line) {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message && typeof message.id !== "undefined" && pending.has(message.id)) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) entry.reject(rpcError(message.error.message ?? JSON.stringify(message.error)))
      else entry.resolve(message.result ?? {})
    }
  }

  function send(payload) {
    if (closed) throw rpcError("MCP stdio client is closed")
    child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  function request(method, params) {
    if (closed) return Promise.reject(rpcError("MCP stdio client is closed"))
    const id = nextId
    nextId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(rpcError(`MCP request timed out: ${method}`))
      }, RPC_TIMEOUT_MS)
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      try { send({ jsonrpc: "2.0", id, method, params }) } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(error)
      }
    })
  }

  function notify(method, params) {
    try { send({ jsonrpc: "2.0", method, params }) } catch { /* notification is best effort */ }
  }

  return {
    transport: "stdio",
    async initialize() {
      await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "oh-my-rigel", version: "1.0.0" } })
      notify("notifications/initialized", {})
    },
    listTools: async () => (await request("tools/list", {})).tools ?? [],
    callTool: async ({ name, arguments: toolArgs }) => await request("tools/call", { name, arguments: toolArgs ?? {} }),
    listResources: async () => (await request("resources/list", {})).resources ?? [],
    readResource: async ({ uri }) => await request("resources/read", { uri }),
    listPrompts: async () => (await request("prompts/list", {})).prompts ?? [],
    getPrompt: async ({ name, arguments: promptArgs }) => await request("prompts/get", { name, arguments: promptArgs ?? {} }),
    async close() {
      closed = true
      try { child.kill() } catch { /* already gone */ }
    },
  }
}

// A real MCP JSON-RPC 2.0 client over Streamable HTTP. Accepts either a plain
// JSON response or an SSE (`text/event-stream`) body, and carries the
// `mcp-session-id` header across requests when the server issues one.
export function createHttpMcpClient({ url, headers = {}, fetchImpl = fetch }) {
  let sessionID = null
  let protocolVersion = "2024-11-05"
  const baseHeaders = { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers }

  async function post(payload) {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: sessionID ? { ...baseHeaders, "mcp-session-id": sessionID } : baseHeaders,
      body: JSON.stringify(payload),
    })
    const issued = response.headers?.get?.("mcp-session-id")
    if (issued) sessionID = issued
    if (response.status === 202 || response.status === 204) return null
    if (!response.ok) throw rpcError(`MCP HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`)
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

  async function request(method, params) {
    const id = Math.floor(Math.random() * 1e9)
    const message = await post({ jsonrpc: "2.0", id, method, params })
    if (message?.error) throw rpcError(message.error.message ?? JSON.stringify(message.error))
    return message?.result ?? {}
  }

  return {
    transport: "http",
    async initialize() {
      const result = await request("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "oh-my-rigel", version: "1.0.0" } })
      if (typeof result?.protocolVersion === "string") protocolVersion = result.protocolVersion
      await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    },
    listTools: async () => (await request("tools/list", {})).tools ?? [],
    callTool: async ({ name, arguments: toolArgs }) => await request("tools/call", { name, arguments: toolArgs ?? {} }),
    listResources: async () => (await request("resources/list", {})).resources ?? [],
    readResource: async ({ uri }) => await request("resources/read", { uri }),
    listPrompts: async () => (await request("prompts/list", {})).prompts ?? [],
    getPrompt: async ({ name, arguments: promptArgs }) => await request("prompts/get", { name, arguments: promptArgs ?? {} }),
    async close() {
      if (!sessionID) return
      try { await fetchImpl(url, { method: "DELETE", headers: { ...baseHeaders, "mcp-session-id": sessionID } }) } catch { /* best effort */ }
    },
  }
}

// Per-session manager. Key is `${sessionID}:${skillName}:${serverName}`, so the
// same skill loaded in two sessions never shares an MCP client.
export function createSkillMcpManager({ createClient, fetchImpl, storage } = {}) {
  const clients = new Map()
  const pending = new Map()
  const clientFactory = createClient ?? ((config, options) => {
    const resolved = withCdpEndpoint(config, options)
    const type = getConnectionType(config)
    if (type === "stdio") return createStdioMcpClient({ command: resolved.command, args: resolved.args ?? [], env: resolved.env, cwd: resolved.cwd })
    if (type === "http") {
      // OAuth-configured HTTP servers get the full manager-side OAuth client
      // (PKCE + DCR + step-up); plain HTTP servers keep the unauthenticated
      // client. V1 parity: `skill-mcp-manager/oauth-handler.ts`.
      if (isOAuthConfigured(resolved)) {
        return createOAuthHttpMcpClient({ url: resolved.url, oauth: resolved.oauth, headers: resolved.headers, fetchImpl, storage })
      }
      return createHttpMcpClient({ url: resolved.url, headers: resolved.headers, fetchImpl })
    }
    throw rpcError("Unsupported MCP server configuration")
  })

  async function connect(key, config, options) {
    if (clients.has(key)) return clients.get(key).client
    if (pending.has(key)) return await pending.get(key)
    const promise = (async () => {
      const client = clientFactory(config, options)
      await client.initialize()
      clients.set(key, { client, lastUsedAt: Date.now() })
      pending.delete(key)
      return client
    })().catch((error) => {
      pending.delete(key)
      throw error instanceof Error ? error : rpcError(String(error))
    })
    pending.set(key, promise)
    return await promise
  }

  function touch(key) {
    const entry = clients.get(key)
    if (entry) entry.lastUsedAt = Date.now()
  }

  async function withClient(info, config, options, operation) {
    const key = buildSkillMcpClientKey(info, options)
    let lastError
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const client = await connect(key, config, options)
        const result = await operation(client)
        touch(key)
        return result
      } catch (error) {
        lastError = error instanceof Error ? error : rpcError(String(error))
        if (!lastError.message.toLowerCase().includes("not connected")) throw lastError
        const entry = clients.get(key)
        if (entry) { clients.delete(key); try { await entry.client.close() } catch { /* ignore */ } }
        if (attempt === 3) throw rpcError(`Failed after 3 reconnection attempts: ${lastError.message}`)
      }
    }
    throw lastError ?? rpcError("Operation failed with unknown error")
  }

  return {
    async listTools(info, config, options) { return await withClient(info, config, options, (client) => client.listTools()) },
    async callTool(info, config, name, args, options) {
      return await withClient(info, config, options, async (client) => (await client.callTool({ name, arguments: args })).content)
    },
    async listResources(info, config, options) { return await withClient(info, config, options, (client) => client.listResources()) },
    async readResource(info, config, uri, options) {
      return await withClient(info, config, options, async (client) => (await client.readResource({ uri })).contents)
    },
    async listPrompts(info, config, options) { return await withClient(info, config, options, (client) => client.listPrompts()) },
    async getPrompt(info, config, name, args, options) {
      return await withClient(info, config, options, async (client) => (await client.getPrompt({ name, arguments: args })).messages)
    },
    isConnected(info, options) { return clients.has(buildSkillMcpClientKey(info, options)) },
    connectedKeys() { return Array.from(clients.keys()) },
    async disconnectSession(sessionID) {
      for (const key of Array.from(clients.keys())) {
        if (key.startsWith(`${sessionID}:`)) {
          const entry = clients.get(key)
          clients.delete(key)
          try { await entry.client.close() } catch { /* ignore */ }
        }
      }
      for (const key of Array.from(pending.keys())) if (key.startsWith(`${sessionID}:`)) pending.delete(key)
    },
    async disconnectAll() {
      const entries = Array.from(clients.values())
      clients.clear()
      pending.clear()
      for (const entry of entries) { try { await entry.client.close() } catch { /* ignore */ } }
    },
  }
}

// Register every skill-embedded MCP server through V2's native mcp surface.
// Existing (host/config) servers win on a name collision, matching V1's
// precedence in `OpencodePlugin.apply`.
export async function registerSkillMcpServers(context, skills) {
  const registered = []
  const mcpDomain = context?.mcp
  if (!mcpDomain || typeof mcpDomain.transform !== "function") return { registered, dispose: undefined }
  const registration = await mcpDomain.transform((collection) => {
    for (const skill of skills ?? []) {
      for (const [name, config] of Object.entries(skill.mcpConfig ?? {})) {
        if (typeof collection?.get === "function" && collection.get(name)) continue
        const translated = translateSkillMcpConfig(config)
        if (!translated) continue
        if (typeof collection?.set !== "function") continue
        collection.set(name, translated)
        registered.push({ name, skill: skill.name })
      }
    }
  })
  return { registered, dispose: registration?.dispose }
}

function validateOperationParams(args) {
  const operations = []
  if (args.tool_name) operations.push({ type: "tool", name: args.tool_name })
  if (args.resource_name) operations.push({ type: "resource", name: args.resource_name })
  if (args.prompt_name) operations.push({ type: "prompt", name: args.prompt_name })
  if (operations.length === 0) {
    throw new Error(
      "Missing operation. Exactly one of tool_name, resource_name, or prompt_name must be specified.\n\n" +
        "Examples:\n" +
        '  skill_mcp(mcp_name="sqlite", tool_name="query", arguments=\'{"sql": "SELECT * FROM users"}\')\n' +
        '  skill_mcp(mcp_name="memory", resource_name="memory://notes")\n' +
        '  skill_mcp(mcp_name="helper", prompt_name="summarize", arguments=\'{"text": "..."}\')',
    )
  }
  if (operations.length > 1) {
    const provided = [
      args.tool_name && `tool_name="${args.tool_name}"`,
      args.resource_name && `resource_name="${args.resource_name}"`,
      args.prompt_name && `prompt_name="${args.prompt_name}"`,
    ].filter(Boolean).join(", ")
    throw new Error(`Multiple operations specified. Exactly one of tool_name, resource_name, or prompt_name must be provided.\n\nReceived: ${provided}\n\nUse separate calls for each operation.`)
  }
  return operations[0]
}

export function parseSkillMcpArguments(argsJson) {
  if (!argsJson) return {}
  if (typeof argsJson === "object" && argsJson !== null) return argsJson
  try {
    const jsonString = String(argsJson).startsWith("'") && String(argsJson).endsWith("'") ? String(argsJson).slice(1, -1) : String(argsJson)
    const parsed = JSON.parse(jsonString)
    if (typeof parsed !== "object" || parsed === null) throw new Error("Arguments must be a JSON object")
    return parsed
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid arguments JSON: ${message}\n\nExpected a valid JSON object, e.g.: '{"key": "value"}'\nReceived: ${argsJson}`)
  }
}

export function applyGrepFilter(output, pattern) {
  if (!pattern) return output
  try {
    const regex = new RegExp(pattern, "i")
    const lines = output.split("\n")
    const filtered = lines.filter((line) => regex.test(line))
    return filtered.length > 0 ? filtered.join("\n") : `[grep] No lines matched pattern: ${pattern}`
  } catch {
    return output
  }
}

function findMcpServer(mcpName, skills) {
  for (const skill of skills) {
    if (skill.mcpConfig && mcpName in skill.mcpConfig) return { skill, config: skill.mcpConfig[mcpName] }
  }
  return null
}

function formatAvailableMcps(skills) {
  const mcps = []
  for (const skill of skills) {
    for (const serverName of Object.keys(skill.mcpConfig ?? {})) mcps.push(`  - "${serverName}" from skill "${skill.name}"`)
  }
  return mcps.length > 0 ? mcps.join("\n") : "  (none found)"
}

function formatBuiltinMcpHint(mcpName) {
  const nativeTools = BUILTIN_MCP_TOOL_HINTS[mcpName]
  if (!nativeTools) return null
  return (
    `"${mcpName}" is a builtin MCP, not a skill MCP.\n` +
    "skill_mcp can only call MCP servers declared by loaded skills; do not retry this builtin through skill_mcp.\n" +
    "Use the native builtin tool names when OpenCode exposes them:\n" +
    nativeTools.map((toolName) => `  - ${toolName}`).join("\n")
  )
}

export const SKILL_MCP_INPUT_SCHEMA = {
  type: "object",
  properties: {
    mcp_name: { type: "string", description: "Name of the MCP server from skill config" },
    tool_name: { type: "string", description: "MCP tool to call" },
    resource_name: { type: "string", description: "MCP resource URI to read" },
    prompt_name: { type: "string", description: "MCP prompt to get" },
    arguments: { anyOf: [{ type: "string" }, { type: "object" }], description: "JSON string or object of arguments" },
    grep: { type: "string", description: "Regex pattern to filter output lines (only matching lines returned)" },
    cdp_url: { type: "string", description: "CDP endpoint URL to connect Playwright to an existing browser (e.g. http://localhost:9222). Creates a separate MCP instance per unique URL." },
  },
  required: ["mcp_name"],
  additionalProperties: false,
}

// Build the editor.add() definition for `skill_mcp`. The manager is injected so
// tests can drive the real dispatch path with a deterministic client.
export function createSkillMcpToolDefinition({ manager, getSkills, getSessionID }) {
  return {
    name: SKILL_MCP_TOOL_NAME,
    options: { codemode: false },
    description: `${SKILL_MCP_DESCRIPTION} Optional cdp_url connects Playwright to a runtime CDP endpoint.`,
    input: SKILL_MCP_INPUT_SCHEMA,
    execute: async (args, toolContext) => {
      const operation = validateOperationParams(args ?? {})
      const skills = (await getSkills?.()) ?? []
      const found = findMcpServer(args.mcp_name, skills)
      if (!found) {
        const builtinHint = formatBuiltinMcpHint(args.mcp_name)
        if (builtinHint) throw new Error(builtinHint)
        throw new Error(
          `MCP server "${args.mcp_name}" not found.\n\nAvailable MCP servers in loaded skills:\n${formatAvailableMcps(skills)}\n\nHint: Load the skill first using the 'skill' tool, then call skill_mcp.`,
        )
      }
      const sessionID = toolContext?.sessionID || getSessionID?.()
      if (!sessionID) throw new Error("No active session available for skill MCP call.")
      const info = { serverName: args.mcp_name, skillName: found.skill.name, sessionID, scope: found.skill.scope, directory: toolContext?.directory }
      const parsedArgs = parseSkillMcpArguments(args.arguments)
      const cdpOptions = args.cdp_url ? { cdpUrl: args.cdp_url } : undefined
      let output
      if (operation.type === "tool") {
        output = JSON.stringify(await manager.callTool(info, found.config, operation.name, parsedArgs, cdpOptions), null, 2)
      } else if (operation.type === "resource") {
        output = JSON.stringify(await manager.readResource(info, found.config, operation.name, cdpOptions), null, 2)
      } else {
        const stringArgs = {}
        for (const [key, value] of Object.entries(parsedArgs)) stringArgs[key] = String(value)
        output = JSON.stringify(await manager.getPrompt(info, found.config, operation.name, stringArgs, cdpOptions), null, 2)
      }
      return applyGrepFilter(output, args.grep)
    },
  }
}
