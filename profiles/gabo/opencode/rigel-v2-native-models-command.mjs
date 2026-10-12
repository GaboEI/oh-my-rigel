// Native OpenCode V2 `/rmo-models` command: guide the active agent through
// inspecting and changing the per-agent model configuration in
// `~/.omo/omo.jsonc`. Registered through `ctx.command.transform` (the same seam
// the builtin commands and the mcp-oauth command use) and delivered into the
// real session turn via `ctx.session.prompt`.
//
// The command is ADDITIVE: it never restarts, stops, or kills the server or the
// active session. It only injects a guided instruction; the actual on-disk edit
// is performed by the active agent with its own tools, following the instruction
// and the pure helpers exported here (read / validate / summarize / atomic
// write). Because `~/.omo/omo.jsonc` is consumed by the plugin at plugin-init,
// the turn ENDS by showing the verified reload commands and leaves running them
// to the user.
//
// Self-contained on purpose: the isolated V2 laboratory stages the native
// runtime as a FLAT directory, so this module imports only Node built-ins and
// sibling `./` modules that the discovery walker can follow.
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const COMMAND_NAME = "rmo-models"

/** The two VERIFIED reload commands (OpenCode v2.0.26). No `server reset`. */
export const MODELS_RELOAD_COMMANDS = Object.freeze({
  reload: "opencode reload",
  serviceRestart: "opencode service restart",
  // `opencode reload` reloads configuration without restarting the server.
  reloadDescription: "Reloads configuration without restarting the server.",
  // `opencode service restart` restarts the background server.
  serviceRestartDescription: "Restart the background server.",
  // Because the plugin reads ~/.omo/omo.jsonc at plugin-init, only a full
  // service restart is guaranteed to re-read it.
  guaranteed: "Because ~/.omo/omo.jsonc is read by the plugin at plugin-init, `opencode service restart` is the guaranteed mechanism.",
})

// The complete per-agent override surface (packages/omo-opencode/src/config/schema/agent-overrides.ts).
// Kept only to WARN on a likely typo; it never causes a write to drop a field.
const KNOWN_AGENT_FIELDS = Object.freeze([
  "model", "models", "fallback_models", "reasoning", "variant", "category", "skills",
  "temperature", "top_p", "prompt", "prompt_append", "tools", "disable", "description",
  "mode", "color", "displayName", "permission", "maxTokens", "thinking", "reasoningEffort",
  "textVerbosity", "providerOptions", "provider_options", "ultrawork", "compaction",
  "allow_non_gpt_model",
])

const AGENT_MODES = new Set(["subagent", "primary", "all"])
const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.prototype.toString.call(value) === "[object Object]"
}

function isUnsafeKey(key) {
  return key === "__proto__" || key === "constructor" || key === "prototype"
}

function deepClone(value) {
  if (value === undefined || value === null) return value
  return structuredClone(value)
}

/** JSONC parse: strip comments and trailing commas, then `JSON.parse`. */
function stripComments(text) {
  let out = ""
  let index = 0
  let inString = false
  while (index < text.length) {
    const char = text[index]
    if (inString) {
      out += char
      if (char === "\\") { out += text[index + 1] ?? ""; index += 2; continue }
      if (char === '"') inString = false
      index += 1
      continue
    }
    if (char === '"') { inString = true; out += char; index += 1; continue }
    if (char === "/" && text[index + 1] === "/") { index += 2; while (index < text.length && text[index] !== "\n") index += 1; continue }
    if (char === "/" && text[index + 1] === "*") { index += 2; while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1; index += 2; continue }
    out += char
    index += 1
  }
  return out
}

function removeTrailingCommas(text) {
  let out = ""
  let inString = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      out += char
      if (char === "\\") { out += text[index + 1] ?? ""; index += 1 }
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; out += char; continue }
    if (char === ",") {
      let lookahead = index + 1
      while (lookahead < text.length && /\s/.test(text[lookahead])) lookahead += 1
      if (text[lookahead] === "}" || text[lookahead] === "]") continue
    }
    out += char
  }
  return out
}

function parseJsoncText(text) {
  return JSON.parse(removeTrailingCommas(stripComments(String(text ?? ""))))
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "undefined"
}

function deepEqual(left, right) {
  return stableStringify(left) === stableStringify(right)
}

const DEFAULT_READ_FILE_SYSTEM = {
  existsSync: fs.existsSync,
  readFileSync: (file) => fs.readFileSync(file, "utf-8"),
}

/** Resolve the user config path from the effective HOME. */
export function resolveModelsConfigPath(env = process.env) {
  const home = env?.HOME ?? env?.USERPROFILE ?? os.homedir()
  return path.join(home, ".omo", "omo.jsonc")
}

/**
 * Read and parse the JSONC config, returning the FULL `agents` block WITHOUT
 * narrowing or flattening any field. Never throws: a missing file yields
 * `exists: false`, an unreadable or malformed file yields `ok: false`.
 */
export function readModelsConfig(fileSystem, filePath) {
  const fsm = fileSystem ?? DEFAULT_READ_FILE_SYSTEM
  if (typeof fsm.existsSync !== "function" || !fsm.existsSync(filePath)) {
    return { ok: true, exists: false, path: filePath, text: "", config: {}, agents: {} }
  }
  let text
  try {
    text = fsm.readFileSync(filePath, "utf-8")
  } catch (error) {
    return { ok: false, exists: true, path: filePath, text: "", config: null, agents: null, reason: error instanceof Error ? error.message : String(error) }
  }
  let config
  try {
    config = parseJsoncText(text)
  } catch (error) {
    return { ok: false, exists: true, path: filePath, text, config: null, agents: null, reason: error instanceof Error ? error.message : String(error) }
  }
  if (!isPlainObject(config)) {
    return { ok: false, exists: true, path: filePath, text, config: null, agents: null, reason: "config root must be an object" }
  }
  const agents = isPlainObject(config.agents) ? deepClone(config.agents) : {}
  return { ok: true, exists: true, path: filePath, text, config: deepClone(config), agents }
}

function isModelEntry(value) {
  return typeof value === "string" ? value.trim().length > 0 : isPlainObject(value) && typeof value.model === "string" && value.model.trim().length > 0
}

function isFallbackList(value) {
  if (typeof value === "string") return value.trim().length > 0
  return Array.isArray(value) && value.every(isModelEntry)
}

/**
 * Validate an `agents` block. Returns `{ ok, errors, warnings }`; each finding is
 * `{ agent, field, message }`. Type violations on known fields are errors; an
 * unknown field is only a warning so a valid extension is never dropped.
 */
export function validateModelsConfig(agents) {
  const errors = []
  const warnings = []
  if (!isPlainObject(agents)) {
    return { ok: false, errors: [{ agent: null, field: null, message: "agents block must be an object" }], warnings }
  }
  for (const [id, entry] of Object.entries(agents)) {
    if (isUnsafeKey(id)) { errors.push({ agent: id, field: null, message: "unsafe agent name" }); continue }
    if (!isPlainObject(entry)) { errors.push({ agent: id, field: null, message: "agent config must be an object" }); continue }
    if ("model" in entry && !(typeof entry.model === "string" && entry.model.trim())) errors.push({ agent: id, field: "model", message: "model must be a non-empty string" })
    if ("models" in entry && !(Array.isArray(entry.models) && entry.models.every(isModelEntry))) errors.push({ agent: id, field: "models", message: "models must be an array of model strings or {model} objects" })
    if ("fallback_models" in entry && !isFallbackList(entry.fallback_models)) errors.push({ agent: id, field: "fallback_models", message: "fallback_models must be a model string or an array of model strings/objects" })
    if ("variant" in entry && typeof entry.variant !== "string") errors.push({ agent: id, field: "variant", message: "variant must be a string" })
    if ("temperature" in entry && !(typeof entry.temperature === "number" && entry.temperature >= 0 && entry.temperature <= 2)) errors.push({ agent: id, field: "temperature", message: "temperature must be a number in [0, 2]" })
    if ("top_p" in entry && !(typeof entry.top_p === "number" && entry.top_p >= 0 && entry.top_p <= 1)) errors.push({ agent: id, field: "top_p", message: "top_p must be a number in [0, 1]" })
    if ("mode" in entry && !AGENT_MODES.has(entry.mode)) errors.push({ agent: id, field: "mode", message: "mode must be subagent, primary, or all" })
    if ("color" in entry && !(typeof entry.color === "string" && COLOR_PATTERN.test(entry.color))) errors.push({ agent: id, field: "color", message: "color must be #RRGGBB" })
    if ("thinking" in entry && !(isPlainObject(entry.thinking) && (entry.thinking.type === "enabled" || entry.thinking.type === "disabled"))) errors.push({ agent: id, field: "thinking", message: "thinking must be { type: enabled|disabled }" })
    for (const key of Object.keys(entry)) {
      if (!KNOWN_AGENT_FIELDS.includes(key)) warnings.push({ agent: id, field: key, message: `unrecognized per-agent field "${key}"` })
    }
  }
  return { ok: errors.length === 0, errors, warnings }
}

function agentFields(entry) {
  return isPlainObject(entry) ? Object.keys(entry).sort() : []
}

/**
 * Exact per-agent before/after change list from two `agents` blocks. Sorted by
 * agent id then field; a whole-agent add/remove with no fields yields one
 * `field: null` entry so the change is never invisible.
 */
export function summarizeModelChanges(before, after) {
  const from = isPlainObject(before) ? before : {}
  const to = isPlainObject(after) ? after : {}
  const changes = []
  const ids = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort()
  for (const id of ids) {
    const hasFrom = Object.hasOwn(from, id)
    const hasTo = Object.hasOwn(to, id)
    if (hasFrom && !hasTo) {
      const fields = agentFields(from[id])
      if (fields.length === 0) changes.push({ agent: id, field: null, kind: "removed", before: deepClone(from[id]), after: undefined })
      else for (const field of fields) changes.push({ agent: id, field, kind: "removed", before: deepClone(from[id][field]), after: undefined })
      continue
    }
    if (!hasFrom && hasTo) {
      const fields = agentFields(to[id])
      if (fields.length === 0) changes.push({ agent: id, field: null, kind: "added", before: undefined, after: deepClone(to[id]) })
      else for (const field of fields) changes.push({ agent: id, field, kind: "added", before: undefined, after: deepClone(to[id][field]) })
      continue
    }
    const fields = [...new Set([...agentFields(from[id]), ...agentFields(to[id])])].sort()
    for (const field of fields) {
      const hadField = isPlainObject(from[id]) && Object.hasOwn(from[id], field)
      const hasField = isPlainObject(to[id]) && Object.hasOwn(to[id], field)
      if (hadField && !hasField) changes.push({ agent: id, field, kind: "removed", before: deepClone(from[id][field]), after: undefined })
      else if (!hadField && hasField) changes.push({ agent: id, field, kind: "added", before: undefined, after: deepClone(to[id][field]) })
      else if (!deepEqual(from[id][field], to[id][field])) changes.push({ agent: id, field, kind: "changed", before: deepClone(from[id][field]), after: deepClone(to[id][field]) })
    }
  }
  return changes
}

function mergeAgentEntry(base, patch) {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (isUnsafeKey(key)) continue
    if (value === undefined) continue
    if (value === null) { delete out[key]; continue }
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeAgentEntry(out[key], value)
    else out[key] = deepClone(value)
  }
  return out
}

function mergeEditedAgents(base, patch) {
  const out = {}
  for (const [key, value] of Object.entries(base)) if (!isUnsafeKey(key)) out[key] = deepClone(value)
  for (const [id, entry] of Object.entries(patch)) {
    if (isUnsafeKey(id)) continue
    if (entry === null) { delete out[id]; continue }
    if (!isPlainObject(entry)) { out[id] = deepClone(entry); continue }
    out[id] = mergeAgentEntry(isPlainObject(out[id]) ? out[id] : {}, entry)
  }
  return out
}

/**
 * Apply a per-agent edit to the current JSONC text WITHOUT touching any agent or
 * field that is not named in `edit.agents`. A named object field deep-merges, a
 * named array replaces, `null` deletes a key, `undefined` is skipped. PURE: no
 * filesystem access and no throw; a malformed source or an empty edit returns
 * `changed: false` with the original text.
 */
export function applyModelsEdit(currentText, edit) {
  const source = typeof currentText === "string" ? currentText : ""
  let config
  try {
    config = source.trim() === "" ? {} : parseJsoncText(source)
  } catch (error) {
    return { ok: false, changed: false, text: source, reason: error instanceof Error ? error.message : String(error) }
  }
  if (!isPlainObject(config)) return { ok: false, changed: false, text: source, reason: "config root must be an object" }
  const patch = isPlainObject(edit) && isPlainObject(edit.agents) ? edit.agents : {}
  const currentAgents = isPlainObject(config.agents) ? config.agents : {}
  if (Object.keys(patch).length === 0) {
    return { ok: true, changed: false, text: source, agents: deepClone(currentAgents) }
  }
  const nextAgents = mergeEditedAgents(currentAgents, patch)
  if (deepEqual(nextAgents, currentAgents) && isPlainObject(config.agents)) {
    return { ok: true, changed: false, text: source, agents: nextAgents }
  }
  const nextConfig = { ...config, agents: nextAgents }
  const text = `${JSON.stringify(nextConfig, null, 2)}\n`
  return { ok: true, changed: text !== source, text, config: nextConfig, agents: nextAgents }
}

/**
 * Atomic single-file write: unique temp file, fsync, rename over the target,
 * then a best-effort parent fsync. A failure before the rename removes the temp
 * file, so the target is never observed half-written. `fileSystem` defaults to
 * `node:fs`; inject a wrapper to force a failure boundary in a test.
 */
export function writeModelsConfigAtomic(filePath, text, { fileSystem = fs } = {}) {
  fileSystem.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`
  let fd
  try {
    fd = fileSystem.openSync(temp, "w", 0o600)
    fileSystem.writeFileSync(fd, text)
    fileSystem.fsyncSync(fd)
  } catch (error) {
    if (fd !== undefined) { try { fileSystem.closeSync(fd) } catch { /* already closed */ } }
    try { fileSystem.rmSync(temp, { force: true }) } catch { /* nothing to remove */ }
    throw error
  }
  fileSystem.closeSync(fd)
  try {
    fileSystem.renameSync(temp, filePath)
  } catch (error) {
    try { fileSystem.rmSync(temp, { force: true }) } catch { /* nothing to remove */ }
    throw error
  }
  let dirFd
  try {
    dirFd = fileSystem.openSync(path.dirname(filePath), "r")
    fileSystem.fsyncSync(dirFd)
  } catch { /* directory fsync is a durability nicety, not a correctness gate */ } finally {
    if (dirFd !== undefined) { try { fileSystem.closeSync(dirFd) } catch { /* already closed */ } }
  }
  return filePath
}

/**
 * The commit boundary. Applies `edit` and writes ONLY when the edit changed
 * something: a cancel / no-op or a malformed source performs NO write. Returns
 * `{ ok, changed, written, text, reason? }`.
 */
export function commitModelsEdit({ fileSystem, filePath, currentText, edit } = {}) {
  const applied = applyModelsEdit(currentText, edit)
  if (!applied.ok) return { ok: false, changed: false, written: false, text: applied.text, reason: applied.reason }
  if (!applied.changed) return { ok: true, changed: false, written: false, text: applied.text, agents: applied.agents }
  writeModelsConfigAtomic(filePath, applied.text, { fileSystem })
  return { ok: true, changed: true, written: true, text: applied.text, agents: applied.agents }
}

/**
 * The guided instruction the command injects. It embeds the CURRENT config so
 * the active agent guides from ground truth, and it mandates: preserve untouched
 * agents/fields, validate before writing, present an EXACT change summary, write
 * atomically only on confirmation, and never write on cancel.
 */
export function renderModelsCommandPrompt({ path: configPath, read, userText = "", reload = MODELS_RELOAD_COMMANDS } = {}) {
  const target = configPath ?? resolveModelsConfigPath()
  const state = read?.ok === false
    ? `The current file could not be read or parsed (${read.reason}). Do not attempt an edit until it is repaired; report the problem to the user.`
    : read?.exists === false
      ? "The file does not exist yet. A new edit will create it."
      : "The current `agents` block is below."
  const current = read?.ok === true && isPlainObject(read.agents) ? `${JSON.stringify(read.agents, null, 2)}\n` : "{}\n"
  const request = typeof userText === "string" && userText.trim() ? `\nThe user's request: ${userText.trim()}\n` : ""
  return [
    "You are handling the `/rmo-models` command. Guide the user through inspecting and changing the per-agent model configuration.",
    "",
    `Target file: ${target}`,
    state,
    request,
    "Current per-agent configuration (`agents` block):",
    current,
    "Supported per-agent fields (all must be preserved unless the user asks to change them):",
    KNOWN_AGENT_FIELDS.join(", "),
    "",
    "Follow this workflow exactly:",
    "1. Inspect the current `agents` block above and confirm the file state with the user.",
    "2. Ask which agent and which field the user wants to change (primary `model`, the ordered `models[]` chain, `fallback_models`, `variant`/`reasoning`, and every other supported field).",
    "3. Propose the exact resulting `agents` block, changing ONLY what was asked.",
    "4. Validate the result before writing: every `model`, `models[]`, and `fallback_models` entry must be valid, and `temperature`/`top_p` must be in range.",
    "5. Present an EXACT per-agent before/after summary of every field that changes, and let the user confirm or cancel.",
    "6. Write `" + target + "` ATOMICALLY (temp file, fsync, rename over the target) only after explicit confirmation, preserving every untouched agent and field.",
    "7. If the user cancels or changes nothing, write NOTHING.",
    "8. Never restart, stop, or kill the server or the current session, and never perform a destructive lifecycle action.",
    "",
    "When the write is complete, end by showing the user the verified reload command(s):",
    `- \`${reload.reload}\` - ${reload.reloadDescription}`,
    `- \`${reload.serviceRestart}\` - ${reload.serviceRestartDescription}`,
    reload.guaranteed,
    "The user decides when to run the reload.",
  ].join("\n")
}

/**
 * Build the `/rmo-models` command definition. `execute` only reads the config to
 * ground the guidance and injects the instruction; it performs no write and no
 * lifecycle action.
 */
export function createModelsCommand({ context, fileSystem, modelsPath, env = process.env } = {}) {
  const target = modelsPath ?? resolveModelsConfigPath(env)
  const fsm = fileSystem ?? DEFAULT_READ_FILE_SYSTEM
  return {
    name: COMMAND_NAME,
    description: "Inspect and change the per-agent model configuration in ~/.omo/omo.jsonc.",
    execute: async ({ sessionID, prompt, delivery } = {}) => {
      if (typeof sessionID !== "string" || sessionID.length === 0) return
      if (typeof context?.session?.prompt !== "function") return
      const base = prompt !== null && typeof prompt === "object" ? prompt : {}
      const userText = typeof prompt === "string" ? prompt : typeof prompt?.text === "string" ? prompt.text : ""
      const read = readModelsConfig(fsm, target)
      const text = renderModelsCommandPrompt({ path: target, read, userText })
      await context.session.prompt({ ...base, sessionID, text, delivery })
    },
  }
}

/**
 * Register the command when the host exposes a command domain and the name is
 * not denied by the materialized `disabled_commands` gate. Returns the host
 * registration (with `dispose`) or `undefined`, so the caller can dispose
 * uniformly.
 */
export async function registerModelsCommand(options = {}) {
  const { context } = options
  if (typeof context?.command?.transform !== "function") return undefined
  const disabled = new Set(Array.isArray(options.disabledCommands) ? options.disabledCommands : [])
  if (disabled.has(COMMAND_NAME)) return undefined
  const definition = createModelsCommand(options)
  return context.command.transform((editor) => editor.add(definition))
}
