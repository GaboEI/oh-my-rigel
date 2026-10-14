/**
 * Pure formatters and search for the native V2 `session_*` tools.
 *
 * Ported from `packages/omo-opencode/src/tools/session-manager/session-formatter.ts`.
 * These functions take plain data and return the exact V1 strings; they hold no
 * V2 client reference, so they are unit-testable without a session domain.
 */

export const NO_SESSIONS_MESSAGE = "No sessions found."
export const NO_VALID_SESSIONS_MESSAGE = "No valid sessions found."

export function formatSessionList(sessions, { emptyMessage = NO_SESSIONS_MESSAGE } = {}) {
  if (sessions.length === 0) return emptyMessage
  const headers = ["Session ID", "Messages", "First", "Last", "Agents"]
  const rows = sessions.map((session) => {
    const id = session?.id ?? session?.sessionID ?? session?.session?.id ?? "unknown"
    const count = session?.message_count ?? session?.messageCount ?? 0
    const first = session?.first_message ?? session?.time?.created
    const last = session?.last_message ?? session?.time?.updated
    const agents = Array.isArray(session?.agents_used) ? session.agents_used : []
    return [
      String(id),
      String(count),
      first ? new Date(first).toISOString().split("T")[0] : "N/A",
      last ? new Date(last).toISOString().split("T")[0] : "N/A",
      agents.join(", ") || "none",
    ]
  })
  const colWidths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index].length)))
  const formatRow = (cells) => "| " + cells.map((cell, index) => cell.padEnd(colWidths[index])).join(" | ").trim() + " |"
  const separator = "|" + colWidths.map((width) => "-".repeat(width + 2)).join("|") + "|"
  return [formatRow(headers), separator, ...rows.map(formatRow)].join("\n")
}

export function formatSessionMessages(messages, includeTodos, todos) {
  if (messages.length === 0) return "No messages found in this session."
  const lines = []
  for (const message of messages) {
    const created = message?.time?.created ?? message?.created
    const timestamp = created ? new Date(created).toISOString() : "Unknown time"
    const agent = message?.agent ? ` (${message.agent})` : ""
    lines.push(`\n[${message?.role ?? message?.type ?? "unknown"}${agent}] ${timestamp}`)
    for (const part of messageParts(message)) {
      if (part?.type === "text" && part.text) {
        lines.push(String(part.text).trim())
      } else if (part?.type === "thinking" && part?.thinking) {
        lines.push(`[thinking] ${String(part.thinking).substring(0, 200)}...`)
      } else if ((part?.type === "tool_use" || part?.type === "tool") && part?.tool) {
        const input = part?.input ? JSON.stringify(part.input).substring(0, 100) : ""
        lines.push(`[tool: ${part.tool}] ${input}`)
      } else if (part?.type === "tool_result") {
        const output = part?.output ? String(part.output).substring(0, 200) : ""
        lines.push(`[tool result] ${output}...`)
      } else if (part?.type === "reasoning" && (part?.text || part?.thinking)) {
        lines.push(`[reasoning] ${String(part.text ?? part.thinking).substring(0, 200)}...`)
      }
    }
  }
  if (includeTodos && Array.isArray(todos) && todos.length > 0) {
    lines.push("\n\n=== Todos ===")
    for (const todo of todos) {
      const status = todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[-]" : "[ ]"
      lines.push(`${status} [${todo.status}] ${todo.content}`)
    }
  }
  return lines.join("\n")
}

export function formatSessionInfo(info) {
  const lines = [
    `Session ID: ${info.id}`,
    `Messages: ${info.message_count}`,
    `Date Range: ${info.first_message ? new Date(info.first_message).toISOString() : "N/A"} to ${info.last_message ? new Date(info.last_message).toISOString() : "N/A"}`,
    `Agents Used: ${info.agents_used.join(", ") || "none"}`,
    `Has Todos: ${info.has_todos ? `Yes (${info.todos?.length ?? 0} items)` : "No"}`,
    `Has Transcript: ${info.has_transcript ? `Yes (${info.transcript_entries} entries)` : "No"}`,
  ]
  if (info.first_message && info.last_message) {
    const duration = new Date(info.last_message).getTime() - new Date(info.first_message).getTime()
    const days = Math.floor(duration / (1000 * 60 * 60 * 24))
    const hours = Math.floor((duration % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))
    if (days > 0 || hours > 0) lines.push(`Duration: ${days} days, ${hours} hours`)
  }
  return lines.join("\n")
}

export function formatSearchResults(results) {
  if (results.length === 0) return "No matches found."
  const lines = [`Found ${results.length} matches:\n`]
  for (const result of results) {
    const timestamp = result.timestamp ? new Date(result.timestamp).toISOString() : ""
    lines.push(`[${result.session_id}] ${result.message_id} (${result.role}) ${timestamp}`)
    lines.push(`  ${result.excerpt}`)
    lines.push(`  Matches: ${result.match_count}\n`)
  }
  return lines.join("\n")
}

export function messageParts(message) {
  if (Array.isArray(message?.parts)) return message.parts
  if (Array.isArray(message?.content)) return message.content
  // A V2 user message stores its body as a root-level `text` with no parts array
  // (`{ type:"user", text, files }`, the live `session.context`/`/context` shape).
  // Surface it as a single text part so search, read, and the transcript see it.
  if (typeof message?.text === "string" && message.text.length > 0) return [{ type: "text", text: message.text }]
  return []
}

/**
 * Count transcript entries from a real V2 source.
 *
 * V1 counted lines of a separate `transcripts/<sessionID>.jsonl` log
 * (`session-manager/file-storage.ts` `getFileSessionTranscript`). V2 keeps no
 * such log, so the honest equivalent is the persisted session activity: the
 * number of message parts V2 actually stored. This is a real, per-session value
 * (never a constant), and the semantic difference from a V1 JSONL line count is
 * documented here and in the migration ledger.
 */
export function countTranscriptEntries(messages) {
  if (!Array.isArray(messages)) return 0
  let count = 0
  for (const message of messages) count += messageParts(message).length
  return count
}

export function messageCreatedAt(message) {
  const created = message?.time?.created ?? message?.created
  return typeof created === "number" ? created : undefined
}

export function messageRole(message) {
  return message?.role ?? message?.type ?? "unknown"
}

export function messageAgent(message) {
  return message?.agent ?? message?.info?.agent
}

/**
 * Tolerant extraction of the message array from a V2 session export body.
 * Accepts `{ data: { messages } }` (the real
 * `GET /api/experimental/session/{id}/export` shape), `{ messages }`, a bare
 * array, and `{ data: [...] }` so a shape change degrades to the messages that
 * are present instead of throwing.
 */
function exportMessages(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.data?.messages)) return payload.data.messages
  if (Array.isArray(payload?.messages)) return payload.messages
  if (Array.isArray(payload?.data)) return payload.data
  return []
}

function partPreview(part) {
  const candidate = part?.text ?? part?.thinking ?? part?.tool ?? part?.output
  return typeof candidate === "string" ? candidate : ""
}

function messagePreview(message) {
  const candidate = message?.text ?? message?.summary
  return typeof candidate === "string" ? candidate : ""
}

/**
 * Flatten a V2 export body into bounded transcript entries. Each entry is
 * `{ role, partType, time, preview }`, one per message part (or one per message
 * when a message stored no parts).
 */
export function normalizeTranscriptExport(payload) {
  const entries = []
  for (const message of exportMessages(payload)) {
    const role = messageRole(message)
    const time = messageCreatedAt(message)
    const parts = messageParts(message)
    if (parts.length === 0) {
      entries.push({ role, partType: "message", time, preview: messagePreview(message).substring(0, 200) })
      continue
    }
    for (const part of parts) {
      const partTime = part?.time?.created ?? time
      entries.push({
        role,
        partType: part?.type ?? "unknown",
        time: typeof partTime === "number" ? partTime : time,
        preview: partPreview(part).substring(0, 200),
      })
    }
  }
  return entries
}

export function countExportEntries(payload) {
  return normalizeTranscriptExport(payload).length
}

/**
 * Render the transcript block appended by `session_read` when
 * `include_transcript` is set. Always emits the header, including for zero
 * entries, so a successful export is never confused with a missing one.
 */
export function formatTranscript(entries) {
  const list = Array.isArray(entries) ? entries : []
  const lines = [`\n\n=== Transcript (${list.length} entries) ===`]
  list.forEach((entry, index) => {
    const role = entry?.role ?? "unknown"
    const partType = entry?.partType ?? "unknown"
    const time = entry?.time ? new Date(entry.time).toISOString() : "Unknown time"
    const preview = entry?.preview ? String(entry.preview).substring(0, 200) : ""
    lines.push(`[${index + 1}] ${role}/${partType} ${time}${preview ? ` ${preview}` : ""}`)
  })
  return `${lines.join("\n")}\n`
}

export function searchInMessages(sessionID, messages, query, caseSensitive, maxResults) {
  const results = []
  const searchQuery = caseSensitive ? query : query.toLowerCase()
  for (const message of messages) {
    if (maxResults && results.length >= maxResults) break
    let matchCount = 0
    const excerpts = []
    for (const part of messageParts(message)) {
      if (part?.type !== "text" || typeof part.text !== "string") continue
      const text = part.text
      const haystack = caseSensitive ? text : text.toLowerCase()
      const matches = haystack.split(searchQuery).length - 1
      if (matches <= 0) continue
      matchCount += matches
      const index = haystack.indexOf(searchQuery)
      if (index !== -1) {
        const start = Math.max(0, index - 50)
        const end = Math.min(haystack.length, index + searchQuery.length + 50)
        let excerpt = text.substring(start, end)
        if (start > 0) excerpt = "..." + excerpt
        if (end < haystack.length) excerpt = excerpt + "..."
        excerpts.push(excerpt)
      }
    }
    if (matchCount > 0) {
      results.push({
        session_id: sessionID,
        message_id: message?.id ?? "unknown",
        role: messageRole(message),
        excerpt: excerpts[0] || "",
        match_count: matchCount,
        timestamp: messageCreatedAt(message),
      })
    }
  }
  return results
}

export function buildSessionInfo(sessionID, messages, { todos = [], transcriptEntries = 0 } = {}) {
  const agentsUsed = new Set()
  let firstMessage
  let lastMessage
  for (const message of messages) {
    const agent = messageAgent(message)
    if (agent) agentsUsed.add(agent)
    const created = messageCreatedAt(message)
    if (created) {
      const date = new Date(created)
      if (!firstMessage || date < firstMessage) firstMessage = date
      if (!lastMessage || date > lastMessage) lastMessage = date
    }
  }
  const todoList = Array.isArray(todos) ? todos : []
  const entries = Number.isFinite(transcriptEntries) && transcriptEntries > 0 ? transcriptEntries : 0
  return {
    id: sessionID,
    message_count: messages.length,
    first_message: firstMessage,
    last_message: lastMessage,
    agents_used: Array.from(agentsUsed),
    has_todos: todoList.length > 0,
    has_transcript: entries > 0,
    todos: todoList,
    transcript_entries: entries,
  }
}
