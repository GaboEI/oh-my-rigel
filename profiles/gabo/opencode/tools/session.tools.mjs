/**
 * Native OpenCode V2 `session_*` tools.
 *
 * Ports the observable semantics of
 * `packages/omo-opencode/src/tools/session-manager/tools.ts` onto the V2
 * session domain. The V2 plugin setup context exposes `get`/`context` for
 * scoped reads. The injected HTTP `serverApi` (`rigel-v2-native-http.mjs`
 * `createServerApi`) is the PRIMARY enumeration authority for `session_list`
 * and global `session_search` (the live host's session domain exposes no
 * `list`); a setup-context client `session.list`, when a host provides it, is
 * the secondary path. The server API is also the transcript source:
 *   - `getSessions`        -> `session_list`/global `session_search`
 *   - `getSessionContext`  -> per-session enrichment (the V1 N+1)
 *   - `getSessionExport`   -> `session_read include_transcript` + `session_info`
 *
 * The HTTP transport is Basic-auth, loopback-only and injectable; this module
 * never builds a URL, a port or a credential. `serverApi` is optional so the
 * module loads before the runtime wires it: when neither the server API nor the
 * setup-context `session.list` exists, `session_list` and global
 * `session_search` return the typed `Error: OpenCode V2 server API unavailable`
 * string (never a throw), while scoped tools keep using the setup context.
 *
 * Preserved V1 behavior:
 *   - `session_list`: project_path default, parentID/main-session filter, the
 *     "/" directory normalization, date filter on the last message, limit slice,
 *     `time.updated` desc sort, the N+1 enrichment, and the distinct
 *     "No sessions found." / "No valid sessions found." empties.
 *   - `session_search`: `query` required, optional `session_id` scope, the
 *     60s timeout, the global 50-session scan cap, accumulation to `limit`
 *     (default 20), and the `Found N matches:` format.
 *   - `session_read`: `session_id` required, `Session not found:` on a missing
 *     or message-less session, `limit` + `from_end` slicing.
 *   - `session_info`: `session_id` required, the `Session not found:` error, the
 *     exact info block, and transcript counts from the export (not the parts).
 */

import { normalize, parse, sep } from "node:path"
import {
  formatSessionList,
  formatSessionMessages,
  formatSessionInfo,
  formatSearchResults,
  searchInMessages,
  buildSessionInfo,
  normalizeTranscriptExport,
  countExportEntries,
  formatTranscript,
  NO_SESSIONS_MESSAGE,
  NO_VALID_SESSIONS_MESSAGE,
} from "./session-formatter.mjs"

const SEARCH_TIMEOUT_MS = 60_000
const DEFAULT_SEARCH_LIMIT = 20
const MAX_SEARCH_SESSIONS = 50
// Ask the V2 `GET /api/session` endpoint for one high page so the server's own
// default cap never truncates before our filter/sort/slice. `session_list`
// enriches at most the sliced `limit` (default: this page) with
// `getSessionContext`, which bounds the N+1.
const SESSION_ENUM_LIMIT = 200
const SERVER_API_UNAVAILABLE = "Error: OpenCode V2 server API unavailable"
const SESSION_DOMAIN_UNAVAILABLE = "OpenCode V2 session domain is unavailable"

export const SESSION_LIST_DESCRIPTION = `List all OpenCode sessions with optional filtering.

Returns a list of available session IDs with metadata including message count, date range, and agents used.

Arguments:
- limit (optional): Maximum number of sessions to return
- from_date (optional): Filter sessions from this date (ISO 8601 format)
- to_date (optional): Filter sessions until this date (ISO 8601 format)

Example output:
| Session ID | Messages | First | Last | Agents |
|------------|----------|-------|------|--------|
| ses_abc123 | 45 | 2025-12-20 | 2025-12-24 | build, oracle |
| ses_def456 | 12 | 2025-12-19 | 2025-12-19 | build |`

export const SESSION_READ_DESCRIPTION = `Read messages and history from an OpenCode session.

Returns a formatted view of session messages with role, timestamp, and content. Optionally includes todos and transcript data.

Arguments:
- session_id (required): Session ID to read
- include_todos (optional): Include todo list if available (default: false)
- include_transcript (optional): Include transcript log if available (default: false)
- limit (optional): Maximum number of messages to return (default: all)

Example output:
Session: ses_abc123
Messages: 45
Date Range: 2025-12-20 to 2025-12-24

[Message 1] user (2025-12-20 10:30:00)
Hello, can you help me with...

[Message 2] assistant (2025-12-20 10:30:15)
Of course! Let me help you with...`

export const SESSION_SEARCH_DESCRIPTION = `Search for content within OpenCode session messages.

Performs full-text search across session messages and returns matching excerpts with context.

Arguments:
- query (required): Search query string
- session_id (optional): Search within specific session only (default: all sessions)
- case_sensitive (optional): Case-sensitive search (default: false)
- limit (optional): Maximum number of results to return (default: 20)

Example output:
Found 3 matches across 2 sessions:

[ses_abc123] Message msg_001 (user)
...implement the **session manager** tool...`

export const SESSION_INFO_DESCRIPTION = `Get metadata and statistics about an OpenCode session.

Returns detailed information about a session including message count, date range, agents used, and available data sources.

Arguments:
- session_id (required): Session ID to inspect

Example output:
Session ID: ses_abc123
Messages: 45
Date Range: 2025-12-20 10:30:00 to 2025-12-24 15:45:30
Duration: 4 days, 5 hours
Agents Used: build, oracle, librarian
Has Todos: Yes (12 items, 8 completed)
Has Transcript: Yes (234 entries)`

function withTimeout(promise, ms, operation) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${operation} timed out after ${ms}ms`)), ms)),
  ])
}

function responseData(response) {
  if (response && typeof response === "object" && "data" in response) return response.data
  return response
}

function asArray(value) {
  if (Array.isArray(value)) return value
  const data = responseData(value)
  return Array.isArray(data) ? data : []
}

// ---- setup-context session domain (scoped reads, preserved V1 path) --------

function sessionApiOf(client) {
  return client?.session ?? client?.v2?.session
}

function pickClient(clients) {
  for (const client of (clients ?? []).filter(Boolean)) {
    const api = sessionApiOf(client)
    if (typeof api?.get === "function" || typeof api?.context === "function") return client
  }
  return undefined
}

async function getClientMeta(client, sessionID) {
  const api = sessionApiOf(client)
  if (typeof api?.get !== "function") return undefined
  try {
    return responseData(await api.get({ sessionID }))
  } catch {
    return undefined
  }
}

async function getClientMessages(client, sessionID) {
  const api = sessionApiOf(client)
  if (typeof api?.context !== "function") return []
  return asArray(await api.context({ sessionID }))
}

// ---- injected HTTP server API ---------------------------------------------

function hasServerApi(serverApi) {
  return Boolean(serverApi) && typeof serverApi.getSessions === "function" && typeof serverApi.getSessionContext === "function"
}

function sessionListApiOf(client) {
  const api = sessionApiOf(client)
  return typeof api?.list === "function" ? api : undefined
}

// Resolve the enumeration source. The injected HTTP server API is the primary
// authority on a live V2 host (the setup-context session domain exposes no
// `list` there); the in-process client `session.list` is the secondary path for
// a host that does expose it.
function resolveEnumerationSource(clients, serverApi) {
  if (hasServerApi(serverApi)) return { kind: "server", serverApi }
  for (const client of (clients ?? []).filter(Boolean)) {
    if (sessionListApiOf(client)) return { kind: "client", client }
  }
  return undefined
}

// Enumerate via the resolved source. The client `session.list` receives only the
// parameters it documents (limit, directory); the server path keeps the full
// V1 query (limit + order + directory).
async function listSessions(source, query) {
  if (source.kind === "client") {
    const mapped = {}
    if (typeof query?.limit === "number") mapped.limit = query.limit
    if (typeof query?.directory === "string") mapped.directory = query.directory
    return listFromResult(await sessionListApiOf(source.client).list(mapped))
  }
  return await fetchSessions(source.serverApi, query)
}

// Read a session's messages through the same source that enumerated it.
async function readMessagesFrom(source, sessionID) {
  if (source.kind === "client") return await getClientMessages(source.client, sessionID)
  return await fetchContextMessages(source.serverApi, sessionID)
}

function errorMessageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function apiErrorMessage(result, fallback) {
  return result?.error?.message || fallback
}

function listFromResult(result) {
  const body = result?.data
  if (Array.isArray(body?.data)) return body.data
  if (Array.isArray(body)) return body
  return []
}

async function fetchSessions(serverApi, query) {
  const result = await serverApi.getSessions(query)
  if (!result?.ok) throw new Error(apiErrorMessage(result, "OpenCode V2 session request failed"))
  return listFromResult(result)
}

async function fetchContextMessages(serverApi, sessionID) {
  const result = await serverApi.getSessionContext(sessionID)
  if (result?.ok) return listFromResult(result)
  const error = new Error(apiErrorMessage(result, `OpenCode V2 context request failed for ${sessionID}`))
  if (result?.error?.code === "v2_http_not_found") error.code = result.error.code
  throw error
}

function isNotFoundError(error) {
  return Boolean(error) && error.code === "v2_http_not_found"
}

// ---- directory + date filtering (V1 storage.ts / directory-filter.ts) ------

function comparisonSeparators(path) {
  return sep === "\\" ? path.replace(/\\/g, "/") : path
}

function normalizeSessionDirectory(directory) {
  const normalized = normalize(directory)
  const root = parse(normalized).root
  const withoutTrailing = normalized !== root && normalized.endsWith(sep) ? normalized.slice(0, -1) : normalized
  return comparisonSeparators(withoutTrailing)
}

function sessionDirectoriesMatch(stored, filter) {
  if (typeof stored !== "string" || typeof filter !== "string") return false
  return normalizeSessionDirectory(stored) === normalizeSessionDirectory(filter)
}

// V1 `normalizeProjectFilter`: a multi-project server resolves `ctx.directory`
// to "/", which never matches a stored directory; treat it as no filter.
function normalizeProjectFilter(directory) {
  if (typeof directory !== "string" || directory.length === 0) return undefined
  if (directory === "/") return undefined
  return directory
}

function sessionDirectory(session) {
  if (typeof session?.directory === "string") return session.directory
  const location = session?.location
  if (typeof location === "string") return location
  if (location && typeof location === "object") {
    for (const key of ["directory", "path", "cwd"]) {
      if (typeof location[key] === "string") return location[key]
    }
  }
  return undefined
}

function sessionUpdatedAt(session) {
  return session?.time?.updated ?? session?.time?.created ?? 0
}

// V1 `getMainSessions`: no parentID, optional directory match, newest first.
async function enumerateMainSessions(source, directory) {
  const filter = normalizeProjectFilter(directory)
  const query = { limit: SESSION_ENUM_LIMIT, order: "desc" }
  if (filter) query.directory = filter
  const sessions = await listSessions(source, query)
  return sessions
    .filter((session) => !session?.parentID)
    .filter((session) => !filter || sessionDirectoriesMatch(sessionDirectory(session), filter))
    .sort((a, b) => sessionUpdatedAt(b) - sessionUpdatedAt(a))
}

// V1 `getAllSessions`: every session (children included), newest first.
async function enumerateAllSessions(source) {
  const sessions = await listSessions(source, { limit: SESSION_ENUM_LIMIT, order: "desc" })
  return sessions
    .slice()
    .sort((a, b) => sessionUpdatedAt(b) - sessionUpdatedAt(a))
    .map((session) => session?.id)
    .filter(Boolean)
}

function parseDate(value) {
  if (typeof value !== "string" || value.length === 0) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function withinDateRange(info, from, to) {
  if (!from && !to) return true
  if (!info?.last_message) return false
  if (from && info.last_message < from) return false
  if (to && info.last_message > to) return false
  return true
}

/**
 * Build the four `session_*` tool definitions.
 *
 * @param {object}   input
 * @param {object[]} [input.clients]    ordered V2 setup-context client candidates
 * @param {object}   [input.serverApi]  injected HTTP server API (createServerApi)
 * @param {string}   [input.directory]  default project directory for session_list
 * @param {Function} [input.readTodos]  per-session todo reader owned by the runtime
 */
export function createSessionTools({ clients = [], serverApi, directory, readTodos } = {}) {
  const enumerationSource = resolveEnumerationSource(clients, serverApi)
  async function readMessages(sessionID) {
    const client = pickClient(clients)
    if (client) return await getClientMessages(client, sessionID)
    if (!hasServerApi(serverApi)) throw new Error(SESSION_DOMAIN_UNAVAILABLE)
    try {
      return await fetchContextMessages(serverApi, sessionID)
    } catch (error) {
      if (isNotFoundError(error)) return null
      throw error
    }
  }

  async function readMeta(sessionID) {
    const client = pickClient(clients)
    if (!client) return undefined
    return await getClientMeta(client, sessionID)
  }

  async function readTodosFor(sessionID) {
    return typeof readTodos === "function" ? await readTodos(sessionID) : []
  }

  async function readTranscriptCount(sessionID) {
    if (!hasServerApi(serverApi) || typeof serverApi.getSessionExport !== "function") return 0
    const result = await serverApi.getSessionExport(sessionID)
    if (!result?.ok) return 0
    return countExportEntries(result.data)
  }

  // A successful export always renders a header; a failure states the reason
  // instead of silently omitting the transcript.
  async function transcriptSuffix(sessionID) {
    if (!hasServerApi(serverApi) || typeof serverApi.getSessionExport !== "function") {
      return "\ntranscript: unavailable (OpenCode V2 server API unavailable)"
    }
    const result = await serverApi.getSessionExport(sessionID)
    if (!result?.ok) {
      return `\ntranscript: unavailable (${apiErrorMessage(result, "OpenCode V2 export request failed")})`
    }
    return formatTranscript(normalizeTranscriptExport(result.data))
  }

  const session_list = {
    description: SESSION_LIST_DESCRIPTION,
    input: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum number of sessions to return" },
        from_date: { type: "string", description: "Filter sessions from this date (ISO 8601 format)" },
        to_date: { type: "string", description: "Filter sessions until this date (ISO 8601 format)" },
        project_path: { type: "string", description: "Filter sessions by project path (default: current working directory)" },
      },
      additionalProperties: false,
    },
    async execute(args = {}) {
      try {
        if (!enumerationSource) return SERVER_API_UNAVAILABLE
        const filterDirectory = args.project_path ?? directory
        const mainSessions = await enumerateMainSessions(enumerationSource, filterDirectory)
        let sessionIDs = mainSessions.map((session) => session?.id).filter(Boolean)
        if (typeof args.limit === "number" && args.limit > 0) sessionIDs = sessionIDs.slice(0, args.limit)
        if (sessionIDs.length === 0) return NO_SESSIONS_MESSAGE

        const infos = []
        for (const sessionID of sessionIDs) {
          const messages = await readMessagesFrom(enumerationSource, sessionID)
          if (messages.length === 0) continue
          infos.push(buildSessionInfo(sessionID, messages, { todos: [], transcriptEntries: 0 }))
        }
        if (infos.length === 0) return NO_VALID_SESSIONS_MESSAGE

        const from = parseDate(args.from_date)
        const to = parseDate(args.to_date)
        if (from || to) {
          const ranged = infos.filter((info) => withinDateRange(info, from, to))
          if (ranged.length === 0) return NO_SESSIONS_MESSAGE
          return formatSessionList(ranged)
        }
        return formatSessionList(infos)
      } catch (error) {
        return `Error: ${errorMessageOf(error)}`
      }
    },
  }

  const session_read = {
    description: SESSION_READ_DESCRIPTION,
    input: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID to read" },
        include_todos: { type: "boolean", description: "Include todo list if available (default: false)" },
        include_transcript: { type: "boolean", description: "Include transcript log if available (default: false)" },
        limit: { type: "number", description: "Maximum number of messages to return (default: all messages)" },
        from_end: { type: "boolean", description: "Read messages from the END of the session (default: false)." },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    async execute(args = {}) {
      try {
        const sessionID = args.session_id
        if (typeof sessionID !== "string" || !sessionID) return "Error: Missing required parameter 'session_id'."
        const session = await readMeta(sessionID)
        let messages = await readMessages(sessionID)
        if (messages === null) return `Session not found: ${sessionID}`
        if (!session && messages.length === 0) return `Session not found: ${sessionID}`
        if (messages.length === 0) return `Session not found: ${sessionID}`
        if (typeof args.limit === "number" && args.limit > 0) {
          messages = args.from_end ? messages.slice(-args.limit) : messages.slice(0, args.limit)
        }
        // V2 has no native session-todo API; the runtime injects a real reader
        // over its own per-session registry. An absent reader is honest (no
        // registry configured) and renders no todos, never a constant.
        const todos = args.include_todos === true ? await readTodosFor(sessionID) : []
        let output = formatSessionMessages(messages, args.include_todos === true, todos)
        if (args.include_transcript === true) output += await transcriptSuffix(sessionID)
        return output
      } catch (error) {
        return `Error: ${errorMessageOf(error)}`
      }
    },
  }

  const session_search = {
    description: SESSION_SEARCH_DESCRIPTION,
    input: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query string" },
        session_id: { type: "string", description: "Search within specific session only (default: all sessions)" },
        case_sensitive: { type: "boolean", description: "Case-sensitive search (default: false)" },
        limit: { type: "number", description: "Maximum number of results to return (default: 20)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(args = {}) {
      try {
        const query = args.query
        if (typeof query !== "string" || !query) return "Error: Missing required parameter 'query'."
        const scopedID = typeof args.session_id === "string" && args.session_id ? args.session_id : undefined
        if (!scopedID && !enumerationSource) return SERVER_API_UNAVAILABLE
        const resultLimit = typeof args.limit === "number" && args.limit > 0 ? args.limit : DEFAULT_SEARCH_LIMIT
        const caseSensitive = args.case_sensitive === true
        const searchOperation = async () => {
          if (scopedID) {
            const messages = (await readMessages(scopedID)) ?? []
            return searchInMessages(scopedID, messages, query, caseSensitive, resultLimit)
          }
          const sessionIDs = (await enumerateAllSessions(enumerationSource)).slice(0, MAX_SEARCH_SESSIONS)
          const allResults = []
          for (const sessionID of sessionIDs) {
            if (allResults.length >= resultLimit) break
            const remaining = resultLimit - allResults.length
            const messages = await readMessagesFrom(enumerationSource, sessionID)
            allResults.push(...searchInMessages(sessionID, messages, query, caseSensitive, remaining))
          }
          return allResults.slice(0, resultLimit)
        }
        const results = await withTimeout(searchOperation(), SEARCH_TIMEOUT_MS, "Search")
        return formatSearchResults(results)
      } catch (error) {
        return `Error: ${errorMessageOf(error)}`
      }
    },
  }

  const session_info = {
    description: SESSION_INFO_DESCRIPTION,
    input: {
      type: "object",
      properties: { session_id: { type: "string", description: "Session ID to inspect" } },
      required: ["session_id"],
      additionalProperties: false,
    },
    async execute(args = {}) {
      try {
        const sessionID = args.session_id
        if (typeof sessionID !== "string" || !sessionID) return "Error: Missing required parameter 'session_id'."
        const messages = await readMessages(sessionID)
        if (messages === null) return `Session not found: ${sessionID}`
        const session = await readMeta(sessionID)
        if (!session && messages.length === 0) return `Session not found: ${sessionID}`
        const todos = await readTodosFor(sessionID)
        const transcriptEntries = await readTranscriptCount(sessionID)
        return formatSessionInfo(buildSessionInfo(sessionID, messages, { todos, transcriptEntries }))
      } catch (error) {
        return `Error: ${errorMessageOf(error)}`
      }
    },
  }

  return { session_list, session_read, session_search, session_info }
}
