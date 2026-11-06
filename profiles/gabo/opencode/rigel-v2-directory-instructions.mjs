import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

// V2 boundary: the directory context is appended to the completed READ result in
// `tool.execute.after`, exactly like the V1 directory-agents/readme injectors
// (`output.output += formatAgentsMdContextBlock(...)`). The appended block lives
// in the tool result the model reads, and `<rigel-native-directory-agents>` is
// the sentinel that makes the Rigel injector distinguishable from OpenCode's own
// native AGENTS.md loader (which emits `Instructions from: ...` instead).
export const DIRECTORY_AGENTS_MARKER = "<rigel-native-directory-agents>"

const AGENTS_FILENAME = "AGENTS.md"
const README_FILENAME = "README.md"
const CHARS_PER_TOKEN_ESTIMATE = 4
const DEFAULT_TARGET_MAX_TOKENS = 50_000
const DEFAULT_PRESERVE_HEADER_LINES = 3
const TRUNCATION_NOTICE_PREFIX = "\n\n[Note: Content was truncated to save context window space. For full context, please read the file directly: "
const TRUNCATION_NOTICE_SUFFIX = "]"
const INTRODUCTION = "Directory-specific rules and documentation discovered while reading files in this session. Follow AGENTS.md rules as applicable; use README.md as project context for the file currently being worked on:"

function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE)
}

// Inline port of the V1 token-limit truncator (4 chars/token, first 3 lines
// preserved). A flat runtime has no context-usage source, so the store uses the
// 50 000-token default.
function truncateToTokenLimit(output, maxTokens, preserveHeaderLines = DEFAULT_PRESERVE_HEADER_LINES) {
  if (typeof output !== "string") return { result: String(output ?? ""), truncated: false }
  if (estimateTokens(output) <= maxTokens) return { result: output, truncated: false }

  const lines = output.split("\n")
  if (lines.length <= preserveHeaderLines) {
    const maxChars = maxTokens * CHARS_PER_TOKEN_ESTIMATE
    return { result: output.slice(0, maxChars) + "\n\n[Output truncated due to context window limit]", truncated: true }
  }

  const headerLines = lines.slice(0, preserveHeaderLines)
  const contentLines = lines.slice(preserveHeaderLines)
  const headerText = headerLines.join("\n")
  const availableTokens = maxTokens - estimateTokens(headerText) - 50
  if (availableTokens <= 0) {
    return { result: headerText + "\n\n[Content truncated due to context window limit]", truncated: true, removedCount: contentLines.length }
  }

  const resultLines = []
  let usedTokens = 0
  for (const line of contentLines) {
    const lineTokens = estimateTokens(`${line}\n`)
    if (usedTokens + lineTokens > availableTokens) break
    resultLines.push(line)
    usedTokens += lineTokens
  }
  const removedCount = contentLines.length - resultLines.length
  return {
    result: [...headerLines, ...resultLines].join("\n") + `\n\n[${removedCount} more lines truncated due to context window limit]`,
    truncated: true,
    removedCount,
  }
}

function canonicalizePath(target) {
  try {
    return realpathSync(target)
  } catch {
    return resolve(target)
  }
}

function isSameOrChildPath(childPath, parentPath) {
  const relativePath = relative(parentPath, childPath)
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
}

// Canonical containment: a read target is accepted only after realpath resolves
// to the workspace root or a descendant. A symlink that escapes the workspace
// is rejected, not silently followed.
function resolveWithin(rootCanonical, candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) return undefined
  const resolved = isAbsolute(candidate) ? candidate : resolve(rootCanonical, candidate)
  const canonical = canonicalizePath(resolved)
  return isSameOrChildPath(canonical, rootCanonical) ? canonical : undefined
}

function resolveInstructionFile(candidate, rootCanonical) {
  if (!existsSync(candidate)) return undefined
  try {
    const canonical = realpathSync(candidate)
    if (!isSameOrChildPath(canonical, rootCanonical)) return undefined
    return statSync(canonical).isFile() ? canonical : undefined
  } catch {
    return undefined
  }
}

function ancestorDirectories(startDir, rootCanonical) {
  const directories = []
  let current = startDir
  while (true) {
    directories.unshift(current)
    if (current === rootCanonical) break
    const parent = dirname(current)
    if (parent === current || !isSameOrChildPath(parent, rootCanonical)) break
    current = parent
  }
  return directories
}

// AGENTS.md walk with skipRoot defaulting to true: the workspace-root AGENTS.md
// is delivered by the Hephaestus path, not by file-read context. Root-first.
function findAgentsMdUp({ startDir, rootDir, skipRoot, cache }) {
  const start = canonicalizePath(startDir)
  const root = canonicalizePath(rootDir)
  if (!isSameOrChildPath(start, root)) return []
  const cacheKey = [start, root, skipRoot ? "1" : "0"].join("\0")
  const cached = cache.get(cacheKey)
  if (cached) return [...cached]

  const found = []
  let current = start
  while (true) {
    const isRootDir = current === root
    if (!(skipRoot && isRootDir)) {
      const file = resolveInstructionFile(join(current, AGENTS_FILENAME), root)
      if (file) found.push(file)
    }
    if (isRootDir) break
    const parent = dirname(current)
    if (parent === current || !isSameOrChildPath(parent, root)) break
    current = parent
  }
  const result = found.reverse()
  cache.set(cacheKey, result)
  return result
}

// README.md walk includes the workspace-root README. Root-first.
function findReadmeMdUp({ startDir, rootDir, cache }) {
  const start = canonicalizePath(startDir)
  const root = canonicalizePath(rootDir)
  if (!isSameOrChildPath(start, root)) return []
  const cacheKey = [start, root, "readme"].join("\0")
  const cached = cache.get(cacheKey)
  if (cached) return [...cached]

  const found = []
  let current = start
  while (true) {
    const file = resolveInstructionFile(join(current, README_FILENAME), root)
    if (file) found.push(file)
    if (current === root) break
    const parent = dirname(current)
    if (parent === current || !isSameOrChildPath(parent, root)) break
    current = parent
  }
  const result = found.reverse()
  cache.set(cacheKey, result)
  return result
}

function requestedReadPath(event) {
  const args = event?.input ?? event?.args ?? {}
  const raw = args.path ?? args.file ?? args.filename ?? args.filePath
  if (typeof raw === "string" && raw.trim()) return raw
  const metadataPath = event?.result?.metadata?.filePath
  return typeof metadataPath === "string" && metadataPath.trim() ? metadataPath : undefined
}

function readSourceText(file) {
  try {
    const text = readFileSync(file, "utf8")
    return text && text.trim() ? text : undefined
  } catch {
    return undefined
  }
}

function appendToResult(result, content) {
  if (typeof result?.content === "string") {
    result.content += content
    return true
  }
  if (Array.isArray(result?.content)) {
    result.content.push({ type: "text", text: content })
    return true
  }
  return false
}

/**
 * Native V2 replacement for the V1 directory-agents and directory-readme
 * injectors. It ports agents-md-core semantics (root-first walk-up discovery,
 * skipRoot for the workspace-root AGENTS.md, a root-inclusive README walk,
 * canonical realpath containment, a discovery cache keyed by
 * (startDir, rootDir, skipRoot), per-directory dedup, dynamic token truncation
 * with the V1 truncation notice) and appends the applicable blocks to the same
 * completed read result the model reads.
 */
export function createDirectoryInstructionStore({ directory, maxFiles = 32, maxCharsPerFile } = {}) {
  const workspace = canonicalizePath(resolve(directory ?? process.cwd()))
  const discoveryCache = new Map()
  const sessions = new Map()
  const charUpperBound = Number.isFinite(maxCharsPerFile) ? maxCharsPerFile : undefined

  function truncateContent(source, file) {
    const tokenResult = truncateToTokenLimit(source, DEFAULT_TARGET_MAX_TOKENS, DEFAULT_PRESERVE_HEADER_LINES)
    let text = tokenResult.result
    let truncated = tokenResult.truncated
    if (charUpperBound !== undefined && text.length > charUpperBound) {
      text = text.slice(0, charUpperBound)
      truncated = true
    }
    if (truncated) text += `${TRUNCATION_NOTICE_PREFIX}${file}${TRUNCATION_NOTICE_SUFFIX}`
    return { text, truncated }
  }

  function sessionState(sessionID) {
    let state = sessions.get(sessionID)
    if (!state) {
      state = { directories: new Set(), count: 0 }
      sessions.set(sessionID, state)
    }
    return state
  }

  function renderFile(file, text) {
    // The tag path is model-facing text, so it is always repo-relative with
    // POSIX separators: a Windows checkout must not inject a backslash-separated
    // path into the context and make the same project look different per host.
    const relativePath = (relative(workspace, file) || file.split(/[\\/]/).pop()).replaceAll("\\", "/")
    const tag = file.toLowerCase().endsWith(README_FILENAME.toLowerCase()) ? "project-readme" : "agents-file"
    return `<${tag} path=${JSON.stringify(relativePath)}>\n${text}\n</${tag}>`
  }

  function renderEnvelope(entries, introduction) {
    if (entries.length === 0) return ""
    const rendered = entries.map((entry) => renderFile(entry.file, entry.text))
    return `${DIRECTORY_AGENTS_MARKER}\n${introduction}\n${rendered.join("\n")}\n${DIRECTORY_AGENTS_MARKER}`
  }

  function after(event) {
    if (event?.status !== "completed") return false
    if (String(event?.tool ?? "").toLowerCase() !== "read") return false
    if (typeof event?.sessionID !== "string" || !event.sessionID) return false
    const result = event.result
    if (!result || (typeof result.content !== "string" && !Array.isArray(result.content))) return false

    const target = resolveWithin(workspace, requestedReadPath(event))
    if (!target) return false

    const startDir = dirname(target)
    const agentsPaths = findAgentsMdUp({ startDir, rootDir: workspace, skipRoot: true, cache: discoveryCache })
    const readmePaths = findReadmeMdUp({ startDir, rootDir: workspace, cache: discoveryCache })
    const agentsByDir = new Map(agentsPaths.map((file) => [dirname(file), file]))
    const readmeByDir = new Map(readmePaths.map((file) => [dirname(file), file]))

    const state = sessionState(event.sessionID)
    const added = []
    for (const dir of ancestorDirectories(startDir, workspace)) {
      if (state.directories.has(dir)) continue
      const candidates = []
      const agentsFile = agentsByDir.get(dir)
      if (agentsFile) candidates.push(agentsFile)
      const readmeFile = readmeByDir.get(dir)
      if (readmeFile) candidates.push(readmeFile)
      if (candidates.length === 0) continue

      const entries = []
      for (const file of candidates) {
        if (state.count >= maxFiles) break
        const source = readSourceText(file)
        if (source === undefined) continue
        const { text } = truncateContent(source, file)
        entries.push({ file, text })
        state.count += 1
      }
      if (entries.length === 0) continue
      state.directories.add(dir)
      added.push(...entries)
    }

    if (added.length === 0) return false
    return appendToResult(result, `\n\n${renderEnvelope(added, INTRODUCTION)}`)
  }

  // Hephaestus' V1 hook injects only the workspace-root AGENTS.md before its
  // first model turn. This path is independent of skipRoot and of read history.
  function rootAgentsGuidance() {
    const file = resolveInstructionFile(join(workspace, AGENTS_FILENAME), workspace)
    if (!file) return ""
    const source = readSourceText(file)
    if (source === undefined) return ""
    const { text } = truncateContent(source, file)
    return renderEnvelope([{ file, text }], "Workspace-root AGENTS.md instructions for this Hephaestus session:")
  }

  function clear(sessionID) {
    sessions.delete(sessionID)
  }

  function clearAll() {
    sessions.clear()
  }

  return { after, rootAgentsGuidance, clear, clearAll }
}

export function isDirectoryInstructionMessage(message) {
  return message?.role === "system"
    && typeof message.content === "string"
    && message.content.includes(DIRECTORY_AGENTS_MARKER)
}
