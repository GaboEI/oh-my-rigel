// Native OpenCode V2 port of OmO's skill loading surface.
//
// V1 discovery lives in `packages/skills-loader-core` (scope priority, SKILL.md
// frontmatter, body extraction) and `packages/omo-opencode/src/tools/skill` +
// `tools/delegate-task/skill-resolver.ts` (matching, agent restriction, real
// body injection into a delegated child). This module reproduces that behavior
// without importing the V1 plugin or its packages, so it can run inside the
// isolated V2 lab runtime. Discovered skills are also exposed through V2's
// native `context.skill.transform` surface, so the host's built-in `skill` tool
// serves exactly the V1-equivalent set.
//
// No `@oh-my-opencode/*` import is possible in the deployed runtime: the module
// ships standalone with only Node builtins.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

// Higher wins on the same skill name. Mirrors
// `packages/skills-loader-core/src/features/opencode-skill-loader/merger/scope-priority.ts`.
export const SCOPE_PRIORITY = {
  builtin: 1,
  shared: 1,
  config: 2,
  user: 3,
  opencode: 4,
  project: 5,
  "opencode-project": 6,
}

// Mirrors the display-name -> config-key map that agent restriction compares
// (`getAgentConfigKey` in `packages/omo-opencode/src/shared/agent-display-names.ts`).
const AGENT_CONFIG_KEYS = {
  "sisyphus - ultraworker": "sisyphus",
  "hephaestus - deep agent": "hephaestus",
  "prometheus - plan builder": "prometheus",
  "atlas - plan executor": "atlas",
  "sisyphus-junior": "sisyphus-junior",
  "metis - plan consultant": "metis",
  "momus - plan critic": "momus",
  "athena - council": "athena",
  "athena-junior - council": "athena-junior",
}
const INVISIBLE_AGENT_CHARS = /[\u200B\u200C\u200D\uFEFF]/g
const AGENT_LIST_SORT_PREFIX = /^\d+\|/
const AGENT_WRAPPER_CHARS = /^[\\/"']+|[\\/"']+$/g

export function getAgentConfigKey(agentName) {
  if (typeof agentName !== "string") return ""
  const cleaned = agentName.replace(INVISIBLE_AGENT_CHARS, "").replace(AGENT_LIST_SORT_PREFIX, "").replace(AGENT_WRAPPER_CHARS, "").trim()
  if (!cleaned) return ""
  const lower = cleaned.toLowerCase()
  if (AGENT_CONFIG_KEYS[lower]) return AGENT_CONFIG_KEYS[lower]
  const withoutParens = lower.replace(/\s*\([^)]*\)\s*$/, "").trim()
  return AGENT_CONFIG_KEYS[withoutParens] ?? withoutParens
}

// Minimal, tag-free YAML frontmatter reader. V1 uses js-yaml with JSON_SCHEMA
// (no code execution, no custom tags). This parser accepts the SKILL.md subset
// (block mappings, block sequences, inline arrays, quoted/plain scalars) and
// deliberately ignores anchors, aliases, and tags so a hostile skill file
// cannot expand into arbitrary structures.
export function parseFrontmatter(content) {
  const normalized = content.startsWith("\uFEFF") ? content.slice(1) : content
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n?---\r?\n([\s\S]*)$/)
  if (!match) return { data: {}, body: normalized, hadFrontmatter: false, parseError: false }
  try {
    const data = parseYamlBlock(splitYamlLines(match[1]))
    return { data: data && typeof data === "object" ? data : {}, body: match[2], hadFrontmatter: true, parseError: false }
  } catch {
    return { data: {}, body: match[2], hadFrontmatter: true, parseError: true }
  }
}

function splitYamlLines(yaml) {
  return yaml.replace(/\r\n/g, "\n").split("\n")
}

function lineIndent(line) {
  return line.length - line.replace(/^\s*/, "").length
}

function stripYamlComment(line) {
  let quote = null
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"' || character === "'") {
      if (!quote) quote = character
      else if (quote === character) quote = null
      continue
    }
    if (!quote && character === "#" && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index)
  }
  return line
}

function isBlankYamlLine(line) {
  const stripped = stripYamlComment(line).trim()
  return stripped.length === 0
}

function parseYamlBlock(lines) {
  let index = 0
  function peek() {
    while (index < lines.length && isBlankYamlLine(lines[index])) index += 1
    return index < lines.length ? { raw: lines[index], indent: lineIndent(lines[index]) } : null
  }
  function parseNode(minIndent) {
    const head = peek()
    if (!head || head.indent < minIndent) return null
    const isSequence = stripYamlComment(head.raw).trimStart().startsWith("- ")
    const container = isSequence ? [] : {}
    while (true) {
      const current = peek()
      if (!current || current.indent < minIndent) break
      const text = stripYamlComment(current.raw).trim()
      if (isSequence) {
        if (!text.startsWith("-")) break
        index += 1
        const inline = text.slice(1).trim()
        if (inline === "") {
          const child = parseNode(minIndent + 1)
          container.push(child ?? null)
        } else if (inline.includes(": ") || inline.endsWith(":")) {
          const item = parseInlineMapping(inline, lines, index, current.indent)
          index = item.nextIndex
          container.push(item.value)
        } else {
          container.push(parseScalar(inline))
        }
        continue
      }
      if (text.startsWith("- ")) break
      const colon = indexOfYamlColon(text)
      if (colon === -1) { index += 1; continue }
      const key = text.slice(0, colon).trim()
      const rawValue = text.slice(colon + 1).trim()
      index += 1
      let value
      if (rawValue === "") {
        const child = parseNode(minIndent + 1)
        value = child ?? null
      } else {
        value = parseScalar(rawValue)
      }
      if (key) container[key] = value
    }
    return container
  }
  const root = parseNode(0)
  return root ?? {}
}

function parseInlineMapping(inline, lines, nextIndex, baseIndent) {
  const value = {}
  const colon = indexOfYamlColon(inline)
  const key = inline.slice(0, colon).trim()
  const rest = inline.slice(colon + 1).trim()
  if (!key) return { value, nextIndex }
  if (rest === "") {
    const nested = parseInlineMappingRest(lines, nextIndex, baseIndent + 2)
    value[key] = nested.value
    nextIndex = nested.nextIndex
  } else {
    value[key] = parseScalar(rest)
    const nested = parseInlineMappingRest(lines, nextIndex, baseIndent + 2)
    Object.assign(value, nested.value)
    nextIndex = nested.nextIndex
  }
  return { value, nextIndex }
}

function parseInlineMappingRest(lines, startIndex, childIndent) {
  const nested = []
  let index = startIndex
  while (index < lines.length) {
    if (isBlankYamlLine(lines[index])) { index += 1; continue }
    if (lineIndent(lines[index]) < childIndent) break
    nested.push(lines[index])
    index += 1
  }
  return { value: parseYamlBlock(nested.map((line) => line.slice(childIndent))), nextIndex: index }
}

function indexOfYamlColon(text) {
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '"' || character === "'") {
      if (!quote) quote = character
      else if (quote === character) quote = null
      continue
    }
    if (!quote && character === ":") return index
  }
  return -1
}

function parseScalar(raw) {
  const trimmed = raw.trim()
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return splitCommaSeparated(trimmed.slice(1, -1)).map(parseScalar).filter((value) => value !== "")
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  if (trimmed === "true") return true
  if (trimmed === "false") return false
  if (trimmed === "null" || trimmed === "~") return null
  return trimmed
}

function splitCommaSeparated(value) {
  const parts = []
  let current = ""
  let quote = null
  for (const character of value) {
    if (character === '"' || character === "'") {
      if (!quote) quote = character
      else if (quote === character) quote = null
      current += character
      continue
    }
    if (!quote && character === ",") { parts.push(current.trim()); current = ""; continue }
    current += character
  }
  parts.push(current.trim())
  return parts
}

export function parseAllowedTools(allowedTools) {
  if (!allowedTools) return undefined
  if (Array.isArray(allowedTools)) return allowedTools.map((tool) => String(tool).trim()).filter(Boolean)
  return String(allowedTools).split(/\s+/).filter(Boolean)
}

// Mirrors `packages/utils/src/skill-path-resolver.ts` (JSON_SCHEMA-safe, no
// dependency on the utility package at runtime).
export function resolveSkillPathReferences(content, basePath) {
  const normalizedBase = String(basePath ?? "").replace(/[\\/]$/, "")
  return content.replace(
    /(?<![a-zA-Z0-9="(])@([a-zA-Z0-9_-]+\/[a-zA-Z0-9_.\-/]*)/g,
    (match, relativePath) => {
      if (!looksLikeFilePath(relativePath)) return match
      const isWindows = /^[A-Za-z]:[\\/]/.test(normalizedBase)
      const isPosix = normalizedBase.startsWith("/") && !isWindows
      const resolved = isWindows
        ? path.win32.resolve(normalizedBase, relativePath)
        : isPosix
          ? path.posix.resolve(normalizedBase, relativePath)
          : path.resolve(normalizedBase, relativePath)
      const relativeFromBase = isWindows
        ? path.win32.relative(normalizedBase, resolved)
        : isPosix
          ? path.posix.relative(normalizedBase, resolved)
          : path.relative(normalizedBase, resolved)
      if (relativeFromBase.startsWith("..") || path.isAbsolute(relativeFromBase)) return match
      const display = resolved.replaceAll("\\", "/")
      return relativePath.endsWith("/") && !display.endsWith("/") ? `${display}/` : display
    },
  )
}

function looksLikeFilePath(value) {
  if (value.endsWith("/")) return true
  const lastSegment = value.split("/").pop() ?? ""
  return /\.[a-zA-Z0-9]+$/.test(lastSegment)
}

export function parseSkillMcpConfig(frontmatterData, resolvedPath) {
  if (frontmatterData && typeof frontmatterData.mcp === "object" && frontmatterData.mcp !== null) {
    return frontmatterData.mcp
  }
  try {
    const raw = fs.readFileSync(path.join(resolvedPath, "mcp.json"), "utf8")
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object") {
      if (parsed.mcpServers && typeof parsed.mcpServers === "object") return parsed.mcpServers
      if (Object.values(parsed).some((entry) => entry && typeof entry === "object" && "command" in entry)) return parsed
    }
  } catch {
    return undefined
  }
  return undefined
}

function toSkillFromFile({ skillPath, resolvedPath, defaultName, scope, namePrefix = "" }) {
  let content
  try {
    content = fs.readFileSync(skillPath, "utf8")
  } catch {
    return null
  }
  const { data, body } = parseFrontmatter(content)
  const baseName = String(data.name || defaultName)
  const name = namePrefix ? `${namePrefix}/${baseName}` : baseName
  const rawBody = body.trim()
  const resolvedBody = resolveSkillPathReferences(rawBody, resolvedPath)
  const template = `<skill-instruction>\nBase directory for this skill: ${resolvedPath}/\nFile references (@path) in this skill are relative to this directory.\n\n${resolvedBody}\n</skill-instruction>\n\n<user-request>\n$ARGUMENTS\n</user-request>`
  return {
    name,
    path: skillPath,
    resolvedPath,
    scope,
    description: typeof data.description === "string" ? data.description : "",
    agent: typeof data.agent === "string" && data.agent ? data.agent : undefined,
    model: typeof data.model === "string" ? data.model : undefined,
    license: typeof data.license === "string" ? data.license : undefined,
    compatibility: typeof data.compatibility === "string" ? data.compatibility : undefined,
    metadata: data.metadata && typeof data.metadata === "object" ? data.metadata : undefined,
    allowedTools: parseAllowedTools(data["allowed-tools"]),
    mcpConfig: parseSkillMcpConfig(data, resolvedPath),
    rawBody,
    resolvedBody,
    template,
  }
}

export function loadSkillsFromDir({ skillsDir, scope, namePrefix = "", depth = 0, maxDepth = 2 }) {
  const skills = new Map()
  let entries
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const add = (skill) => { if (skill && !skills.has(skill.name)) skills.set(skill.name, skill) }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue
    const entryPath = path.join(skillsDir, entry.name)
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      let resolvedPath = entryPath
      try { resolvedPath = fs.realpathSync(entryPath) } catch { resolvedPath = entryPath }
      const skillMd = path.join(resolvedPath, "SKILL.md")
      if (isFile(skillMd)) { add(toSkillFromFile({ skillPath: skillMd, resolvedPath, defaultName: entry.name, scope, namePrefix })); continue }
      const namedMd = path.join(resolvedPath, `${entry.name}.md`)
      if (isFile(namedMd)) { add(toSkillFromFile({ skillPath: namedMd, resolvedPath, defaultName: entry.name, scope, namePrefix })); continue }
      if (depth < maxDepth) {
        const nestedPrefix = namePrefix ? `${namePrefix}/${entry.name}` : entry.name
        for (const nested of loadSkillsFromDir({ skillsDir: resolvedPath, scope, namePrefix: nestedPrefix, depth: depth + 1, maxDepth })) add(nested)
      }
      continue
    }
    if (!/\.md$/i.test(entry.name)) continue
    add(toSkillFromFile({ skillPath: entryPath, resolvedPath: skillsDir, defaultName: path.basename(entryPath, ".md"), scope, namePrefix }))
  }
  return Array.from(skills.values())
}

function isFile(candidate) {
  try { return fs.statSync(candidate).isFile() } catch { return false }
}

function directoryExists(candidate) {
  try { return fs.statSync(candidate).isDirectory() } catch { return false }
}

function gitRoot(directory) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: directory, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined
  } catch {
    return undefined
  }
}

// Walk from `startDirectory` to the git root (or filesystem root when the
// directory is not a repo), collecting every existing `segmentPath`.
function findAncestorDirs(startDirectory, segmentPaths) {
  const found = []
  const seen = new Set()
  const stop = gitRoot(startDirectory)
  let current = path.resolve(startDirectory)
  while (true) {
    for (const segments of segmentPaths) {
      const candidate = path.join(current, ...segments)
      if (!directoryExists(candidate)) continue
      const resolved = safeRealpath(candidate)
      if (seen.has(resolved)) continue
      seen.add(resolved)
      found.push(resolved)
    }
    if (stop && path.resolve(current) === path.resolve(stop)) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return found
}

function safeRealpath(candidate) {
  try { return fs.realpathSync(candidate) } catch { return candidate }
}

function opencodeConfigDirs(env) {
  const dirs = new Set()
  const custom = env.OPENCODE_CONFIG_DIR && String(env.OPENCODE_CONFIG_DIR).trim()
  if (custom) dirs.add(path.resolve(custom))
  const xdg = env.XDG_CONFIG_HOME && String(env.XDG_CONFIG_HOME).trim()
  dirs.add(path.join(xdg || path.join(env.HOME || os.homedir(), ".config"), "opencode"))
  return Array.from(dirs)
}

function discoverScope(dirs, scope) {
  const out = []
  for (const dir of dirs) {
    out.push(...loadSkillsFromDir({ skillsDir: dir, scope }))
  }
  return out
}

function dedupeSkills(skills) {
  const merged = new Map()
  for (const skill of skills) {
    const existing = merged.get(skill.name)
    if (!existing || (SCOPE_PRIORITY[skill.scope] ?? 0) > (SCOPE_PRIORITY[existing.scope] ?? 0)) merged.set(skill.name, skill)
  }
  return Array.from(merged.values())
}

// Locale-independent string order so a listing built from this is byte-identical
// across processes regardless of the filesystem's readdir order (upstream #9432).
function compareCodeUnits(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

// Scope priority desc, then name asc. The name tie-break makes the registered
// listing independent of discovery order, so the host-rendered tool prefix stays
// cacheable.
function sortSkillsForListing(skills) {
  return [...skills].sort(
    (left, right) =>
      (SCOPE_PRIORITY[right.scope] ?? 0) - (SCOPE_PRIORITY[left.scope] ?? 0)
      || compareCodeUnits(left.name, right.name),
  )
}

/**
 * `skills.paths` is the OpenCode configuration key for configured skill
 * directories. `skills.sources` remains as a legacy fallback for older Rigel
 * configurations while users migrate to the host schema.
 */
function configuredSkillDirs(config, directory) {
  const paths = config?.skills?.paths
  const legacySources = config?.skills?.sources
  if (!Array.isArray(paths) && !Array.isArray(legacySources)) return []
  const dirs = []
  const seen = new Set()
  for (const source of [...(Array.isArray(paths) ? paths : []), ...(Array.isArray(legacySources) ? legacySources : [])]) {
    const rawPath = typeof source === "string" ? source : source?.path
    if (typeof rawPath !== "string" || !rawPath.trim()) continue
    const resolved = path.resolve(directory, rawPath)
    if (seen.has(resolved) || !directoryExists(resolved)) continue
    seen.add(resolved)
    dirs.push(resolved)
  }
  return dirs
}

export function discoverSkills({ directory, home = os.homedir(), env = process.env, config } = {}) {
  const start = directory || process.cwd()
  const homeDir = home || os.homedir()
  const opencodeProjectDirs = findAncestorDirs(start, [[".opencode", "skills"], [".opencode", "skill"]])
  const claudeProjectDirs = findAncestorDirs(start, [[".claude", "skills"]])
  const agentsProjectDirs = findAncestorDirs(start, [[".agents", "skills"]])
  const opencodeGlobals = opencodeConfigDirs({ ...env, HOME: homeDir }).flatMap((dir) => [path.join(dir, "skills"), path.join(dir, "skill")])
  const claudeConfigDir = (env.CLAUDE_CONFIG_DIR && String(env.CLAUDE_CONFIG_DIR).trim()) || path.join(homeDir, ".claude")
  const userDirs = [path.join(claudeConfigDir, "skills"), path.join(homeDir, ".agents", "skills")]

  return dedupeSkills([
    ...discoverScope(opencodeProjectDirs, "opencode-project"),
    ...discoverScope(opencodeGlobals, "opencode"),
    ...discoverScope(claudeProjectDirs, "project"),
    ...discoverScope(agentsProjectDirs, "project"),
    ...discoverScope(configuredSkillDirs(config, start), "config"),
    ...discoverScope(userDirs, "user"),
  ])
}

export function matchSkillByName(skills, requestedName) {
  if (typeof requestedName !== "string") return undefined
  const normalized = requestedName.replace(/^\//, "").toLowerCase()
  const exact = skills.find((skill) => skill.name.toLowerCase() === normalized)
  if (exact) return exact
  const shortMatches = skills.filter((skill) => {
    const parts = skill.name.split("/")
    return parts.length > 1 && (parts[parts.length - 1] ?? "").toLowerCase() === normalized
  })
  return shortMatches.length === 1 ? shortMatches[0] : undefined
}

export function findPartialSkillMatches(skills, requestedName) {
  const normalized = String(requestedName ?? "").toLowerCase()
  return skills.map((skill) => skill.name).filter((name) => name.toLowerCase().includes(normalized))
}

export function collectDisabledSkillAliases(config = {}) {
  const disabled = new Set()
  for (const name of config.disabled_skills ?? []) {
    if (typeof name === "string") disabled.add(name.toLowerCase())
  }
  const skillsConfig = config.skills
  if (skillsConfig && typeof skillsConfig === "object" && !Array.isArray(skillsConfig)) {
    if (Array.isArray(skillsConfig.disable)) {
      for (const name of skillsConfig.disable) if (typeof name === "string") disabled.add(name.toLowerCase())
    }
    for (const [name, entry] of Object.entries(skillsConfig)) {
      if (name === "sources" || name === "enable" || name === "disable") continue
      if (entry === false || (entry && typeof entry === "object" && entry.disable === true)) disabled.add(name.toLowerCase())
    }
  }
  return disabled
}

export function isDisabledSkillAlias(skill, disabledSkills) {
  if (!disabledSkills || disabledSkills.size === 0) return false
  return disabledSkills.has(skill.name.toLowerCase())
}

export function isSkillAllowedForTargetAgent(skill, targetAgent) {
  const restrictedAgent = skill.agent
  if (!restrictedAgent) return true
  if (typeof targetAgent !== "string" || !targetAgent.trim()) return false
  return getAgentConfigKey(restrictedAgent) === getAgentConfigKey(targetAgent)
}

// Resolve requested skill names to real bodies for a delegated child. Collision
// precedence is the discovered order (higher scope priority already won during
// merge). A name that is unknown, disabled, or restricted to another agent is
// reported as `missing` rather than silently dropped, so the caller can still
// emit the textual fallback notice.
export function selectSkillsForChild(skills, requestedNames, { targetAgent, disabledSkills } = {}) {
  const injected = []
  const missing = []
  for (const raw of requestedNames ?? []) {
    const name = typeof raw === "string" ? raw.trim() : ""
    if (!name) continue
    const skill = matchSkillByName(skills, name)
    if (!skill || isDisabledSkillAlias(skill, disabledSkills) || !isSkillAllowedForTargetAgent(skill, targetAgent)) {
      missing.push(name)
      continue
    }
    injected.push({ name: skill.name, body: skill.rawBody || skill.resolvedBody || "" })
  }
  return { injected, missing }
}

export function formatSkillInjection({ injected, missing }) {
  const blocks = []
  for (const skill of injected ?? []) {
    blocks.push(`<skill name="${skill.name}">\n${skill.body}\n</skill>`)
  }
  if ((missing ?? []).length > 0) {
    blocks.push(`<rigel-requested-skills>Before working, load these native skills if available: ${missing.join(", ")}</rigel-requested-skills>`)
  }
  return blocks.join("\n\n")
}

function nativeSkillInfo(skill) {
  return {
    id: skill.name,
    name: skill.name,
    description: skill.description,
    path: skill.path ?? skill.resolvedPath ?? "",
    content: skill.rawBody || "",
  }
}

function collectionNames(collection) {
  const names = new Set()
  if (!collection || typeof collection.list !== "function") return names
  try {
    for (const entry of collection.list() ?? []) {
      const name = entry?.name ?? entry?.skill?.name
      if (typeof name === "string") names.add(name.toLowerCase())
    }
  } catch {
    return names
  }
  return names
}

function addNativeSkill(collection, skill) {
  const info = nativeSkillInfo(skill)
  if (typeof collection.add === "function") { collection.add(info); return }
  if (typeof collection.source === "function") { collection.source({ type: "embedded", skill: info }); return }
  throw new Error("OpenCode V2 skill draft exposes neither add() nor source()")
}

// Register the V1-equivalent discovered set into V2's native skill surface.
// Host-registered names win over ours, matching OmO's "existing entry wins"
// precedence. Returns the discovered list so delegation can inject real bodies
// without re-reading the disk.
export async function registerNativeSkills(context, { directory, home, env, disabledSkills, config } = {}) {
  const target = directory ?? context?.location?.directory ?? process.cwd()
  const discovered = discoverSkills({ directory: target, home, env, config: config ?? context?.config })
  const enabled = disabledSkills && disabledSkills.size > 0
    ? discovered.filter((skill) => !isDisabledSkillAlias(skill, disabledSkills))
    : discovered
  const skills = sortSkillsForListing(enabled)
  const registered = []
  const skillDomain = context?.skill
  if (skillDomain && typeof skillDomain.transform === "function") {
    const registration = await skillDomain.transform((collection) => {
      const existing = collectionNames(collection)
      for (const skill of skills) {
        if (existing.has(skill.name.toLowerCase())) continue
        addNativeSkill(collection, skill)
        existing.add(skill.name.toLowerCase())
        registered.push(skill.name)
      }
    })
    return { skills, registered, dispose: registration?.dispose }
  }
  return { skills, registered, dispose: undefined }
}

// Runtime host-skill source (V1 parity: `plugin/runtime-skill-resolver.ts`).
// Skills that other plugins add to the host's merged skill catalog through
// config hooks are invisible to the on-disk discovery above. V2 exposes the
// merged catalog on `ctx.skill.list()`, read lazily at skill_mcp call time and
// cached with single-flight dedupe; on any failure the base skills are
// returned unchanged. Base skills keep precedence on name collisions: they
// were fully discovered with bodies and MCP config on disk.
export async function readRuntimeHostSkills(context) {
  if (typeof context?.skill?.list !== "function") return undefined
  const entries = await context.skill.list()
  const hostSkills = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = typeof entry?.name === "string" && entry.name.trim() ? entry.name : entry?.id
    if (typeof name !== "string" || !name.trim()) continue
    const skillPath = typeof entry?.path === "string" ? entry.path : ""
    if (skillPath && isFile(skillPath)) {
      const parsed = toSkillFromFile({ skillPath, resolvedPath: skillPath, defaultName: name, scope: "runtime-host" })
      if (parsed) {
        hostSkills.push(parsed)
        continue
      }
    }
    hostSkills.push({
      name: name.trim(),
      path: skillPath,
      resolvedPath: skillPath,
      scope: "runtime-host",
      description: typeof entry?.description === "string" ? entry.description : "",
      rawBody: typeof entry?.content === "string" ? entry.content : "",
      resolvedBody: typeof entry?.content === "string" ? entry.content : "",
    })
  }
  return hostSkills
}

export function createRuntimeHostSkillSource({ context, baseSkills, disabledSkills } = {}) {
  let inflight
  const resolve = async () => {
    try {
      const hostSkills = await readRuntimeHostSkills(context)
      if (!hostSkills || hostSkills.length === 0) return baseSkills
      const seen = new Set(baseSkills.map((skill) => skill.name.toLowerCase()))
      const merged = [...baseSkills]
      for (const skill of hostSkills) {
        const key = skill.name.toLowerCase()
        if (seen.has(key) || isDisabledSkillAlias(skill, disabledSkills)) continue
        seen.add(key)
        merged.push(skill)
      }
      return merged
    } catch {
      return baseSkills
    }
  }
  return () => {
    if (!inflight) inflight = resolve()
    return inflight
  }
}
