/**
 * Native OpenCode V2 configuration resolution for Oh My Rigel.
 *
 * Resolves the harness-neutral `omo.jsonc` chain into the plugin-facing keys that
 * gate the Phase 3 tool and category slices: `monitor.enabled`, `goal.enabled`,
 * `experimental.task_system`, the disabled tool/agent/skill denylists, and the
 * user category records.
 *
 * This is a runtime-only port. The isolated V2 laboratory stages the native
 * runtime as a flat directory with no `node_modules`, so it cannot import the
 * TypeScript config-core packages or `zod`. Every algorithm here is ported from
 * the real owners and the port is pinned against them by
 * `rigel-v2-native-config.parity.test.mjs`:
 *
 *   - packages/omo-config-core/src/loader/paths.ts        (layer discovery)
 *   - packages/omo-config-core/src/loader/merge.ts        (pollution-safe merge)
 *   - packages/omo-config-core/src/loader/resolution.ts   (harness/profile fold)
 *   - packages/omo-config-core/src/schema/config.ts       (layer key contract)
 *   - packages/omo-config-core/src/schema/category.ts     (category key contract)
 *   - packages/omo-config-core/src/schema/legacy-category-names.ts
 *   - packages/omo-opencode/src/plugin-config/omo-config-chain.ts (view assembly)
 *   - packages/omo-opencode/src/plugin-config/config-merger.ts    (union/deep-merge)
 *   - packages/omo-opencode/src/config/validate.ts        (per-key parse, defaults, migration)
 *   - packages/omo-opencode/src/config/schema/{monitor,goal,experimental}.ts
 *   - packages/omo-opencode/src/shared/task-system-enabled.ts
 *
 * Only Node built-ins are imported.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs"
import { userInfo } from "node:os"
import { dirname, join, resolve } from "node:path"

import { quarantineNativeGates } from "./rigel-v2-native-goal-quarantine.mjs"
import { projectOpenclawEndpointIdentities } from "./rigel-v2-native-openclaw-identity.mjs"
import { normalizeOpenclawConfig } from "./rigel-v2-native-openclaw-core.mjs"

/** Monitor gate defaults, from config/schema/monitor.ts. */
export const NATIVE_MONITOR_DEFAULTS = Object.freeze({
  enabled: false,
  live_mode_enabled: false,
  max_monitors_per_session: 3,
  max_runtime_ms: 1800000,
  batch_max_lines: 50,
  batch_max_bytes: 16384,
  flush_interval_ms: 1000,
  ring_max_lines: 1000,
  line_max_bytes: 8192,
  pattern_max_length: 512,
})

/** Goal gate defaults, from config/schema/goal.ts. */
export const NATIVE_GOAL_DEFAULTS = Object.freeze({
  enabled: false,
  auto_start: false,
  default_max_iterations: 100,
})

/** Default-mode defaults, from config/schema/default-mode.ts (`z.boolean().default(false)`). */
export const NATIVE_DEFAULT_MODE_DEFAULTS = Object.freeze({
  ultrawork: false,
  goal: false,
})

// Known top-level keys of OmoConfigLayerSchema (config.ts). Anything else at the
// top level of an omo.jsonc layer is stripped by the real loader, so it must not
// reach the plugin view here either.
const LAYER_KEYS = new Set([
  "formatOnMutation", "gateway", "$schema", "categories", "agents", "git_master", "disabled_mcps", "mcp_env_allowlist",
  "task", "teams", "models", "model_profiles", "model_profile", "memory",
  "telemetry", "computer", "disabled_skills", "openclaw", "[opencode]", "[native]", "[senpi]",
  "[codex]", "[omo]", "profiles", "_migrations", "legacy_migrations",
])
// Block keys of OmoConfigLayerSchema / OmoConfigProfileSchema.
const HARNESS_BLOCK_KEYS = new Set(["[opencode]", "[native]", "[senpi]", "[codex]", "[omo]"])
// Keys omo-config-chain.ts deliberately drops from the plugin base view.
const NON_PLUGIN_FIELDS = new Set(["legacy_migrations", "models", "task", "teams"])
// Known keys of OmoConfigProfileSchema, reduced to the ones this resolver reads.
const PROFILE_KEYS = new Set(["categories", "disabled_skills", "openclaw", "[opencode]", "[native]", "[senpi]", "[codex]"])

const TARGET_KEYS = new Set([
  "monitor", "goal", "experimental", "team_mode", "skills", "disabled_tools", "disabled_agents", "disabled_mcps",
  "disabled_skills", "disabled_commands", "disabled_hooks", "categories", "agents", "ralph_loop", "hashline_edit", "openclaw",
  "default_mode",
])

const MAX_PROJECT_CONFIG_DIRECTORY_DEPTH = 256

const STRING_ARRAY_KEYS = new Set(["disabled_tools", "disabled_agents", "disabled_skills", "disabled_hooks", "disabled_mcps", "disabled_commands", "mcp_env_allowlist"])

// --- Explicit declaration tracking (presence contract) ---
// A resolved view cannot answer "did a layer write this key?": the validated
// sections materialize their schema defaults (`monitor`, `goal`), the plugin
// projection fills an absent collection with `[]` or `{}`, and a value the
// schema refused is dropped exactly like a key no layer authored. A reader that
// tested truthiness (`value || fallback`) or bare presence in the view therefore
// could not tell `false`, `0`, `[]` and `{}` from an undeclared key, and could
// not tell a rejected declaration from an absent one.
//
// `declarations` is that contract, computed from the SAME fold the view uses:
//   - `declared`:   a layer authored the key and the value survived validation.
//                   `false`, `0`, `[]` and `{}` are declarations exactly like a
//                   non-empty value; none of them is absence.
//   - `error`:      a layer authored the key and the schema refused the value.
//                   The refusal diagnostic is still reported in `diagnostics`.
//                   A file that could not be read or parsed is a DIFFERENT error
//                   class: it is reported in `loadFailures`, and a non-empty
//                   `loadFailures` means NO entry here is authoritative, not
//                   even a `declared` one, because an unreadable layer may have
//                   overridden it.
//   - `undeclared`: no layer authored the key. A view default is NEVER read as
//                   a declaration.
// `sources` names the declaring file and placement, so a later authority
// migration can report provenance without re-reading the chain. Resolved values
// are deliberately not carried: they live in the view, and a refused raw value
// never reaches this contract. Legacy migration (`ralph_loop` -> `goal`) runs
// AFTER this record, so presence names the key a layer actually wrote and never
// a synthesized one.
//
// Authority per root key mirrors the fold. `replace` keys keep the last
// surviving declaration because the resolved section replaces the previous one
// whole, `merge` keys deep-merge, and `union` keys accumulate string lists. A
// section that a later layer re-declares RESETS the leaf declarations it does
// not repeat, because the resolved section no longer reflects them. That is why
// a section leaf is decided from the PAIR (`monitor` state and `monitor.enabled`
// state), never from the leaf alone.

/** Section leaves tracked per validated section (mirrors the parse contract). */
const DECLARATION_SECTION_LEAVES = Object.freeze({
  monitor: Object.freeze(["enabled", "live_mode_enabled"]),
  goal: Object.freeze(["enabled", "auto_start", "default_max_iterations"]),
  experimental: Object.freeze([
    "task_system",
    "preemptive_compaction",
    "preemptive_compaction_threshold",
    "truncate_all_tool_outputs",
    "max_tools",
    "hashline_edit",
  ]),
  team_mode: Object.freeze(["enabled", "tmux_visualization", "max_members"]),
  default_mode: Object.freeze(["ultrawork", "goal"]),
})

/** How each tracked root key combines across layers (the fold's own semantics). */
const DECLARATION_ROOT_KINDS = Object.freeze({
  monitor: "replace",
  goal: "replace",
  experimental: "replace",
  team_mode: "replace",
  default_mode: "replace",
  hashline_edit: "replace",
  skills: "replace",
  openclaw: "replace",
  ralph_loop: "replace",
  categories: "merge",
  agents: "merge",
  disabled_tools: "union",
  disabled_agents: "union",
  disabled_skills: "union",
  disabled_hooks: "union",
  disabled_mcps: "union",
  disabled_commands: "union",
  mcp_env_allowlist: "union",
})

/** Every statically tracked path, in a stable order so the record is deterministic. */
const DECLARATION_PATHS = Object.freeze([
  ...Object.keys(DECLARATION_ROOT_KINDS).filter((key) => key !== "mcp_env_allowlist"),
  ...Object.entries(DECLARATION_SECTION_LEAVES).flatMap(([section, leaves]) => leaves.map((leaf) => `${section}.${leaf}`)),
  "mcp_env_allowlist",
])

function declarationKindOf(key) {
  return DECLARATION_ROOT_KINDS[key.split(".")[0]] ?? "replace"
}

function appendDeclaration(records, key, entry) {
  const list = records.get(key)
  if (list === undefined) records.set(key, [entry])
  else list.push(entry)
}

/**
 * Record what ONE placement view authored, in the fold's own order. `rejected`
 * carries the dotted keys the parser refused for this view, so "authored but
 * refused" can never collapse into "undeclared".
 */
function observeDeclarations(records, view, rejected) {
  const { config, path, at } = view
  if (!isPlainRecord(config)) return
  for (const [rootKey, kind] of Object.entries(DECLARATION_ROOT_KINDS)) {
    if (rootKey === "mcp_env_allowlist") continue
    if (!Object.prototype.hasOwnProperty.call(config, rootKey)) continue
    const value = config[rootKey]
    appendDeclaration(records, rootKey, { path, at: `${at}${rootKey}`, rejected: rejected.has(rootKey) })
    const leaves = DECLARATION_SECTION_LEAVES[rootKey]
    if (leaves !== undefined) {
      // A refused section (`monitor: 7`) is dropped by the parser, so the earlier
      // section stays in effect and its leaf declarations survive.
      if (!isPlainRecord(value)) continue
      for (const leaf of leaves) {
        const leafKey = `${rootKey}.${leaf}`
        // The resolved section replaced the previous one whole.
        records.delete(leafKey)
        if (!Object.prototype.hasOwnProperty.call(value, leaf)) continue
        appendDeclaration(records, leafKey, { path, at: `${at}${leafKey}`, rejected: rejected.has(leafKey) })
      }
      continue
    }
    if (kind !== "merge" || !isPlainRecord(value)) continue
    for (const [name, entry] of Object.entries(value)) {
      const childKey = `${rootKey}.${rootKey === "categories" ? canonicalCategoryName(name) : name}`
      appendDeclaration(records, childKey, { path, at: `${at}${childKey}`, rejected: rejected.has(`${rootKey}.${name}`) })
      if (!isPlainRecord(entry)) continue
      for (const leaf of Object.keys(entry)) {
        const leafKey = `${childKey}.${leaf}`
        appendDeclaration(records, leafKey, {
          path,
          at: `${at}${leafKey}`,
          rejected: rejected.has(`${rootKey}.${name}.${leaf}`),
        })
      }
    }
  }
}

function declarationSourceOf(entry) {
  return { path: entry.path, at: entry.at }
}

function declarationEntryOf(key, list) {
  if (list === undefined || list.length === 0) return { state: "undeclared" }
  const survived = list.filter((entry) => !entry.rejected)
  if (survived.length === 0) return { state: "error", sources: list.map(declarationSourceOf) }
  const winners = declarationKindOf(key) === "replace" ? [survived[survived.length - 1]] : survived
  return { state: "declared", sources: winners.map(declarationSourceOf) }
}

function buildDeclarations(records) {
  const declarations = {}
  const staticKeys = new Set(DECLARATION_PATHS)
  for (const key of DECLARATION_PATHS) declarations[key] = declarationEntryOf(key, records.get(key))
  for (const key of [...records.keys()].filter((entry) => !staticKeys.has(entry)).sort()) {
    declarations[key] = declarationEntryOf(key, records.get(key))
  }
  return declarations
}
const DEFAULT_READ_FILE_SYSTEM = {
  existsSync,
  lstatSync,
  readFileSync: (path) => readFileSync(path, "utf-8"),
  realpathSync,
}

const ACCOUNT_HOME_DIR = userInfo().homedir

function isPlainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.prototype.toString.call(value) === "[object Object]"
}

function isUnsafeObjectKey(key) {
  return key === "__proto__" || key === "constructor" || key === "prototype"
}

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry))
  if (!isPlainRecord(value)) return value
  const sanitized = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isUnsafeObjectKey(key)) continue
    sanitized[key] = sanitizeValue(entry)
  }
  return sanitized
}

/** Port of omo-config-core loader/merge.ts mergeOmoConfigRecords. */
function mergeRecords(base, override) {
  const result = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (isUnsafeObjectKey(key)) continue
    const safeValue = sanitizeValue(value)
    const baseValue = result[key]
    result[key] = isPlainRecord(baseValue) && isPlainRecord(safeValue)
      ? mergeRecords(baseValue, safeValue)
      : safeValue
  }
  return result
}

/** Port of packages/utils deepMerge: objects recurse, arrays replace, undefined keeps base. */
function deepMerge(base, override) {
  if (!base && !override) return undefined
  if (!base) return override
  if (!override) return base
  const result = { ...base }
  for (const key of Object.keys(override)) {
    if (isUnsafeObjectKey(key)) continue
    const baseValue = base[key]
    const overrideValue = override[key]
    if (overrideValue === undefined) continue
    result[key] = isPlainRecord(baseValue) && isPlainRecord(overrideValue)
      ? deepMerge(baseValue, overrideValue)
      : overrideValue
  }
  return result
}

/** Port of mergeUniqueStrings: first-seen order, deduped. */
function mergeUniqueStrings(base, override) {
  return [...new Set([...(base ?? []), ...(override ?? [])])]
}

function removeTrailingCommas(text) {
  let out = ""
  let inString = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      out += char
      if (char === "\\") {
        out += text[index + 1] ?? ""
        index += 1
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === ",") {
      let lookahead = index + 1
      while (lookahead < text.length && /\s/.test(text[lookahead])) lookahead += 1
      if (text[lookahead] === "}" || text[lookahead] === "]") continue
    }
    out += char
  }
  return out
}

function stripComments(text) {
  let out = ""
  let index = 0
  let inString = false
  while (index < text.length) {
    const char = text[index]
    if (inString) {
      out += char
      if (char === "\\") {
        out += text[index + 1] ?? ""
        index += 2
        continue
      }
      if (char === '"') inString = false
      index += 1
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      index += 1
      continue
    }
    if (char === "/" && text[index + 1] === "/") {
      index += 2
      while (index < text.length && text[index] !== "\n") index += 1
      continue
    }
    if (char === "/" && text[index + 1] === "*") {
      index += 2
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1
      index += 2
      continue
    }
    out += char
    index += 1
  }
  return out
}

function readJsonc(text) {
  return parseJsoncText(text)
}

/**
 * Parse a user config file that may carry JSONC comments. Strict JSON is tried
 * first so a well-formed file is never rewritten; only a strict failure falls
 * back to the comment-stripping pass, which is string-aware so a `//` inside a
 * quoted value (a `$schema` URL, a gateway URL) is never read as a comment.
 */
export function parseJsoncText(text) {
  const source = String(text ?? "")
  try {
    return JSON.parse(source)
  } catch {
    return JSON.parse(removeTrailingCommas(stripComments(source)))
  }
}

// Filesystem failures carry a libuv errno code, which names the class of the
// failure without quoting the file. The list is closed on purpose: a code is
// only echoed when it is one of these, so an arbitrary string can never reach a
// diagnostic through the `code` field.
const SAFE_READ_ERROR_CODES = new Set([
  "EACCES", "EIO", "EISDIR", "ELOOP", "EMFILE", "ENFILE", "ENOENT", "ENOMEM", "ENOTDIR", "EPERM", "EROFS",
])

/**
 * Reduce a read/parse failure to a VALUE-FREE reason.
 *
 * The diagnostic contract (`Contrato_Transportes_OpenClaw.md` S4.3) allows a
 * state, a path, a key and a class: never a value, never a token, never a URL.
 * `JSON.parse` violates that on its own, because its message quotes the source
 * it choked on (V8 shows a window around the token, JSC names the identifier),
 * and a malformed `omo.jsonc` line is very often a credential
 * (`discordBotToken`, a gateway URL, an API key). The raw message therefore
 * never leaves this function.
 *
 * A filesystem failure is a different case: its errno comes from libuv, not from
 * the file content, so the code alone is both safe and the part an operator
 * needs to tell a permission problem from a malformed file.
 */
function readFailureReason(error) {
  if (error instanceof SyntaxError) return "invalid JSON"
  const code = typeof error === "object" && error !== null ? error.code : undefined
  if (typeof code === "string" && SAFE_READ_ERROR_CODES.has(code)) return code
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  // A wrapped or stubbed file system may throw a message-only error
  // (`new Error("EIO: cannot read")`), so the leading errno token is honoured
  // too — but only when it is one of the known codes, never as free text.
  const leading = /^([A-Z][A-Z0-9_]{1,31})(?::|$)/.exec(message)?.[1]
  return leading !== undefined && SAFE_READ_ERROR_CODES.has(leading) ? leading : "read failed"
}

function resolveHomeDir(env) {
  const homeDir = env?.HOME ?? env?.USERPROFILE ?? process.cwd()
  return resolve(homeDir)
}

function isSymlinkedProjectPath(path, fileSystem) {
  if (fileSystem.lstatSync === undefined || !fileSystem.existsSync(path)) return false
  try {
    return fileSystem.lstatSync(path).isSymbolicLink()
  } catch (error) {
    if (error instanceof Error) return true
    throw error
  }
}

function isLoadableProjectConfigFile(path, fileSystem) {
  return fileSystem.existsSync(path) && !isSymlinkedProjectPath(path, fileSystem)
}

function detectProjectConfigPath(dir, fileSystem) {
  const omoDir = join(dir, ".omo")
  if (isSymlinkedProjectPath(omoDir, fileSystem)) return null
  const jsoncPath = join(omoDir, "omo.jsonc")
  if (isLoadableProjectConfigFile(jsoncPath, fileSystem)) return jsoncPath
  const jsonPath = join(omoDir, "omo.json")
  return isLoadableProjectConfigFile(jsonPath, fileSystem) ? jsonPath : null
}

function detectUserConfigPath(env, fileSystem) {
  const configDir = join(resolveHomeDir(env), ".omo")
  const jsoncPath = join(configDir, "omo.jsonc")
  if (fileSystem.existsSync(jsoncPath)) return jsoncPath
  const jsonPath = join(configDir, "omo.json")
  return fileSystem.existsSync(jsonPath) ? jsonPath : jsoncPath
}

function realpathOrSelf(path, fileSystem) {
  if (fileSystem.realpathSync === undefined) return path
  try {
    return fileSystem.realpathSync(path)
  } catch {
    return path
  }
}

/** Port of findProjectConfigPathsFarthestFirst (paths.ts). */
function findProjectConfigPathsFarthestFirst(cwd, homeDir, fileSystem, accountHomeDir) {
  const startDir = resolve(cwd)
  const boundaryDirs = [...new Set([resolve(homeDir), resolve(accountHomeDir)])]
  const realBoundaryDirs = new Set(boundaryDirs.map((path) => realpathOrSelf(path, fileSystem)))
  const nearestFirst = []
  let currentDir = startDir

  for (let depth = 0; depth < MAX_PROJECT_CONFIG_DIRECTORY_DEPTH; depth += 1) {
    const isHomeDir = boundaryDirs.includes(currentDir) || realBoundaryDirs.has(realpathOrSelf(currentDir, fileSystem))
    const configPath = isHomeDir ? null : detectProjectConfigPath(currentDir, fileSystem)
    if (configPath !== null) nearestFirst.push(configPath)
    if (isHomeDir) break
    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) break
    currentDir = parentDir
  }

  return nearestFirst.reverse()
}

/** Port of resolveOmoConfigPaths (paths.ts). */
function resolveLayerPaths({ cwd, env, fileSystem }) {
  const userPath = detectUserConfigPath(env, fileSystem)
  const projectPaths = findProjectConfigPathsFarthestFirst(cwd, resolveHomeDir(env), fileSystem, ACCOUNT_HOME_DIR)
  return [
    { path: userPath, scope: "user" },
    ...projectPaths.map((path) => ({ path, scope: "project" })),
  ]
}

function resolveManifestProfileName(manifest) {
  const value = manifest?.metadata?.profile
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function resolveProfileName(env, manifest) {
  const value = env?.OMO_PROFILE || env?.OCX_PROFILE
  if (typeof value === "string" && value.length > 0) return value
  const opencodeConfigDir = env?.OPENCODE_CONFIG_DIR
  const match = typeof opencodeConfigDir === "string"
    ? /(?:^|[\\/])profiles[\\/]([^\\/]+)[\\/]*$/.exec(opencodeConfigDir)
    : null
  if (match?.[1] && match[1].length > 0) return match[1]
  return resolveManifestProfileName(manifest)
}

function withoutControlKeys(config) {
  const result = {}
  for (const [key, value] of Object.entries(config)) {
    if (key === "profiles" || HARNESS_BLOCK_KEYS.has(key)) continue
    result[key] = value
  }
  return result
}

/** Port of resolution.ts harnessLayer: lift `[opencode]` (canonical harness) to top level. */
function harnessLayer(config, harness) {
  if (harness !== "opencode") return {}
  return isPlainRecord(config["[opencode]"]) ? { ...config["[opencode]"] } : {}
}

/** Port of resolveOmoConfigView (resolution.ts), reduced to the OpenCode harness. */
function resolveOmoConfigView(config, harness, profileName) {
  const profiles = isPlainRecord(config.profiles) ? config.profiles : undefined
  const profile = profileName !== undefined && profiles !== undefined && isPlainRecord(profiles[profileName])
    ? profiles[profileName]
    : undefined
  const layers = [
    withoutControlKeys(config),
    harnessLayer(config, harness),
    profile === undefined ? {} : withoutControlKeys(profile),
    profile === undefined ? {} : harnessLayer(profile, harness),
  ]
  let resolved = {}
  for (const layer of layers) resolved = mergeRecords(resolved, layer)
  return withoutControlKeys(resolved)
}

/**
 * Diagnostics sink for one parsed placement view. It keeps the shared diagnostic
 * list byte-identical while remembering WHICH dotted keys that view refused,
 * which is what separates `error` from `undeclared` in `declarations`.
 */
function createDiagnosticsSink(diagnostics) {
  const rejected = new Set()
  return {
    rejected,
    push: (line) => diagnostics.push(line),
    reject: (key) => rejected.add(key),
  }
}

function warn(diagnostics, message, key) {
  diagnostics.push(message)
  if (key !== undefined && typeof diagnostics.reject === "function") diagnostics.reject(key)
}

/**
 * Record a schema refusal for presence tracking WITHOUT emitting a diagnostic.
 * `ralph_loop` has always been dropped silently, and this phase may not change
 * the diagnostic stream; the declaration record still has to say the authored
 * value was refused instead of reporting it as `declared`.
 */
function rejectDeclaration(diagnostics, key) {
  if (typeof diagnostics.reject === "function") diagnostics.reject(key)
}

function intInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max
}

function validateMonitor(value, path, diagnostics) {
  if (!isPlainRecord(value)) {
    warn(diagnostics, `config: ${path}: monitor ignored (invalid value)`, "monitor")
    return undefined
  }
  const parsed = {}
  for (const key of ["enabled", "live_mode_enabled"]) {
    if (!(key in value)) continue
    if (typeof value[key] === "boolean") parsed[key] = value[key]
    else warn(diagnostics, `config: ${path}: monitor.${key} ignored (invalid value)`, `monitor.${key}`)
  }
  const integerBounds = {
    max_monitors_per_session: [1, 16],
    max_runtime_ms: [1000, Number.MAX_SAFE_INTEGER],
    batch_max_lines: [1, Number.MAX_SAFE_INTEGER],
    batch_max_bytes: [1024, Number.MAX_SAFE_INTEGER],
    flush_interval_ms: [250, Number.MAX_SAFE_INTEGER],
    ring_max_lines: [1, Number.MAX_SAFE_INTEGER],
    line_max_bytes: [256, Number.MAX_SAFE_INTEGER],
    pattern_max_length: [1, Number.MAX_SAFE_INTEGER],
  }
  for (const [key, [min, max]] of Object.entries(integerBounds)) {
    if (!(key in value)) continue
    if (intInRange(value[key], min, max)) parsed[key] = value[key]
    else warn(diagnostics, `config: ${path}: monitor.${key} ignored (invalid value)`, `monitor.${key}`)
  }
  if ("allowed_commands" in value) {
    if (Array.isArray(value.allowed_commands) && value.allowed_commands.every((entry) => typeof entry === "string")) {
      parsed.allowed_commands = [...value.allowed_commands]
    } else {
      warn(diagnostics, `config: ${path}: monitor.allowed_commands ignored (invalid value)`)
    }
  }
  return { ...NATIVE_MONITOR_DEFAULTS, ...parsed }
}

function validateGoal(value, path, diagnostics) {
  if (!isPlainRecord(value)) {
    warn(diagnostics, `config: ${path}: goal ignored (invalid value)`, "goal")
    return undefined
  }
  const parsed = {}
  for (const key of ["enabled", "auto_start"]) {
    if (!(key in value)) continue
    if (typeof value[key] === "boolean") parsed[key] = value[key]
    else warn(diagnostics, `config: ${path}: goal.${key} ignored (invalid value)`, `goal.${key}`)
  }
  if ("default_max_iterations" in value) {
    if (intInRange(value.default_max_iterations, 1, 1000)) parsed.default_max_iterations = value.default_max_iterations
    else warn(diagnostics, `config: ${path}: goal.default_max_iterations ignored (invalid value)`, "goal.default_max_iterations")
  }
  return { ...NATIVE_GOAL_DEFAULTS, ...parsed }
}

/**
 * Port of `DefaultModeConfigSchema` (config/schema/default-mode.ts).
 *
 * Both fields are `z.boolean().default(false)`, so a DECLARED block materializes
 * the documented `false` for a field it omits. That is why the switch reader
 * cannot answer "was `ultrawork` authored?" from this value and reads the
 * `declarations` contract instead. A refused block returns `undefined` so the
 * earlier layer's block stays in effect, exactly like `monitor`/`goal`.
 */
function validateDefaultMode(value, path, diagnostics) {
  if (!isPlainRecord(value)) {
    warn(diagnostics, `config: ${path}: default_mode ignored (invalid value)`, "default_mode")
    return undefined
  }
  const parsed = {}
  for (const key of ["ultrawork", "goal"]) {
    if (!(key in value)) continue
    if (typeof value[key] === "boolean") parsed[key] = value[key]
    else warn(diagnostics, `config: ${path}: default_mode.${key} ignored (invalid value)`, `default_mode.${key}`)
  }
  return { ...NATIVE_DEFAULT_MODE_DEFAULTS, ...parsed }
}

function validateExperimental(value, path, diagnostics) {
  if (!isPlainRecord(value)) {
    warn(diagnostics, `config: ${path}: experimental ignored (invalid value)`, "experimental")
    return undefined
  }
  const parsed = {}
  if ("task_system" in value) {
    if (typeof value.task_system === "boolean") parsed.task_system = value.task_system
    else warn(diagnostics, `config: ${path}: experimental.task_system ignored (invalid value)`, "experimental.task_system")
  }
  // T34: V1 `experimental.preemptive_compaction` gate (off by default). The
  // threshold is a Rigel addition (V1 hardcodes 0.78); it must be a fraction in
  // (0, 1] so a bad value degrades to the V1 default instead of disabling the
  // guard silently.
  if ("preemptive_compaction" in value) {
    if (typeof value.preemptive_compaction === "boolean") parsed.preemptive_compaction = value.preemptive_compaction
    else warn(diagnostics, `config: ${path}: experimental.preemptive_compaction ignored (invalid value)`, "experimental.preemptive_compaction")
  }
  if ("preemptive_compaction_threshold" in value) {
    const threshold = value.preemptive_compaction_threshold
    if (typeof threshold === "number" && Number.isFinite(threshold) && threshold > 0 && threshold <= 1) parsed.preemptive_compaction_threshold = threshold
    else warn(diagnostics, `config: ${path}: experimental.preemptive_compaction_threshold ignored (invalid value)`, "experimental.preemptive_compaction_threshold")
  }
  if ("max_tools" in value) {
    if (intInRange(value.max_tools, 1, 1000)) parsed.max_tools = value.max_tools
    else warn(diagnostics, `config: ${path}: experimental.max_tools ignored (invalid value)`, "experimental.max_tools")
  }
  // V1 migrates experimental.hashline_edit up to the root key; keep the legacy
  // placement readable so an older profile still enables the hashline surface.
  if ("hashline_edit" in value) {
    if (typeof value.hashline_edit === "boolean") parsed.hashline_edit = value.hashline_edit
    else warn(diagnostics, `config: ${path}: experimental.hashline_edit ignored (invalid value)`, "experimental.hashline_edit")
  }
  // T38: V1 `experimental.truncate_all_tool_outputs` (off by default). When set,
  // the native tool-output truncator applies to every tool, not only the V1
  // TRUNCATABLE_TOOLS list.
  if ("truncate_all_tool_outputs" in value) {
    if (typeof value.truncate_all_tool_outputs === "boolean") parsed.truncate_all_tool_outputs = value.truncate_all_tool_outputs
    else warn(diagnostics, `config: ${path}: experimental.truncate_all_tool_outputs ignored (invalid value)`, "experimental.truncate_all_tool_outputs")
  }
  return parsed
}

const TEAM_MODE_MAX_MEMBERS_CEILING = 8
const KNOWN_UNHONORED = new Set([
  "max_parallel_members",
  "max_messages_per_run",
  "max_wall_clock_minutes",
  "max_member_turns",
  "base_dir",
  "message_payload_max_bytes",
  "recipient_unread_max_bytes",
  "mailbox_poll_interval_ms",
])

function validateTeamMode(value, path, diagnostics) {
  if (!isPlainRecord(value)) {
    warn(diagnostics, `config: ${path}: team_mode ignored (invalid value)`, "team_mode")
    return undefined
  }
  const validated = {}
  if ("enabled" in value && typeof value.enabled !== "boolean") {
    warn(diagnostics, `config: ${path}: team_mode.enabled ignored (invalid value)`, "team_mode.enabled")
  } else if ("enabled" in value) {
    validated.enabled = value.enabled
  }
  // tmux visualization gate (rewritten feature): a boolean that rides with the
  // team_mode block so the generator can materialize it into the manifest.
  if ("tmux_visualization" in value && typeof value.tmux_visualization !== "boolean") {
    warn(diagnostics, `config: ${path}: team_mode.tmux_visualization ignored (invalid value)`, "team_mode.tmux_visualization")
  } else if ("tmux_visualization" in value) {
    validated.tmux_visualization = value.tmux_visualization
  }
  if ("max_members" in value) {
    if (typeof value.max_members !== "number" || !Number.isInteger(value.max_members) || value.max_members < 1) {
      warn(diagnostics, `config: ${path}: team_mode.max_members ignored (invalid value)`, "team_mode.max_members")
    } else {
      validated.max_members = Math.min(value.max_members, TEAM_MODE_MAX_MEMBERS_CEILING)
    }
  }
  for (const key of KNOWN_UNHONORED) {
    if (key in value) warn(diagnostics, `config: ${path}: team_mode.${key} ignored (not honored by native runtime)`)
  }
  return validated
}

const CATEGORY_STRING_FIELDS = ["description", "model", "variant", "prompt_append"]
const CATEGORY_BOOLEAN_FIELDS = ["is_unstable_agent", "disable", "warn_unavailable"]
const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
const TEXT_VERBOSITIES = new Set(["low", "medium", "high"])

function validateCategoryEntry(value, path, categoryName, diagnostics) {
  if (!isPlainRecord(value)) {
    warn(diagnostics, `config: ${path}: categories.${categoryName} ignored (invalid value)`, `categories.${categoryName}`)
    return undefined
  }
  const parsed = {}
  for (const key of CATEGORY_STRING_FIELDS) {
    if (!(key in value)) continue
    if (typeof value[key] === "string") parsed[key] = value[key]
    else warn(diagnostics, `config: ${path}: categories.${categoryName}.${key} ignored (invalid value)`, `categories.${categoryName}.${key}`)
  }
  for (const key of CATEGORY_BOOLEAN_FIELDS) {
    if (!(key in value)) continue
    if (typeof value[key] === "boolean") parsed[key] = value[key]
    else warn(diagnostics, `config: ${path}: categories.${categoryName}.${key} ignored (invalid value)`, `categories.${categoryName}.${key}`)
  }
  if ("temperature" in value) {
    if (typeof value.temperature === "number" && value.temperature >= 0 && value.temperature <= 2) parsed.temperature = value.temperature
    else warn(diagnostics, `config: ${path}: categories.${categoryName}.temperature ignored (invalid value)`, `categories.${categoryName}.temperature`)
  }
  if ("top_p" in value) {
    if (typeof value.top_p === "number" && value.top_p >= 0 && value.top_p <= 1) parsed.top_p = value.top_p
    else warn(diagnostics, `config: ${path}: categories.${categoryName}.top_p ignored (invalid value)`, `categories.${categoryName}.top_p`)
  }
  for (const key of ["max_tokens", "max_prompt_tokens"]) {
    if (!(key in value)) continue
    if (intInRange(value[key], 1, Number.MAX_SAFE_INTEGER)) parsed[key] = value[key]
    else warn(diagnostics, `config: ${path}: categories.${categoryName}.${key} ignored (invalid value)`, `categories.${categoryName}.${key}`)
  }
  if ("maxTokens" in value) {
    if (typeof value.maxTokens === "number") parsed.maxTokens = value.maxTokens
    else warn(diagnostics, `config: ${path}: categories.${categoryName}.maxTokens ignored (invalid value)`, `categories.${categoryName}.maxTokens`)
  }
  if ("reasoningEffort" in value) {
    if (REASONING_EFFORTS.has(value.reasoningEffort)) parsed.reasoningEffort = value.reasoningEffort
    else warn(diagnostics, `config: ${path}: categories.${categoryName}.reasoningEffort ignored (invalid value)`, `categories.${categoryName}.reasoningEffort`)
  }
  if ("textVerbosity" in value) {
    if (TEXT_VERBOSITIES.has(value.textVerbosity)) parsed.textVerbosity = value.textVerbosity
    else warn(diagnostics, `config: ${path}: categories.${categoryName}.textVerbosity ignored (invalid value)`, `categories.${categoryName}.textVerbosity`)
  }
  if ("provider_options" in value) {
    if (isPlainRecord(value.provider_options)) parsed.provider_options = value.provider_options
    else warn(diagnostics, `config: ${path}: categories.${categoryName}.provider_options ignored (invalid value)`, `categories.${categoryName}.provider_options`)
  }
  if ("thinking" in value) {
    const thinking = value.thinking
    if (isPlainRecord(thinking) && (thinking.type === "enabled" || thinking.type === "disabled")) {
      parsed.thinking = thinking.budgetTokens === undefined || typeof thinking.budgetTokens === "number"
        ? { ...thinking }
        : { type: thinking.type }
    } else {
      warn(diagnostics, `config: ${path}: categories.${categoryName}.thinking ignored (invalid value)`, `categories.${categoryName}.thinking`)
    }
  }
  if ("models" in value) {
    if (Array.isArray(value.models)) parsed.models = [...value.models]
    else warn(diagnostics, `config: ${path}: categories.${categoryName}.models ignored (invalid value)`, `categories.${categoryName}.models`)
  }
  if ("fallback_models" in value) {
    if (Array.isArray(value.fallback_models)) parsed.fallback_models = [...value.fallback_models]
    else warn(diagnostics, `config: ${path}: categories.${categoryName}.fallback_models ignored (invalid value)`, `categories.${categoryName}.fallback_models`)
  }
  if ("reasoning" in value) {
    if (typeof value.reasoning === "string" || isPlainRecord(value.reasoning)) parsed.reasoning = value.reasoning
    else warn(diagnostics, `config: ${path}: categories.${categoryName}.reasoning ignored (invalid value)`, `categories.${categoryName}.reasoning`)
  }
  if ("tools" in value) {
    if (isPlainRecord(value.tools) && Object.values(value.tools).every((entry) => typeof entry === "boolean")) {
      parsed.tools = { ...value.tools }
    } else {
      warn(diagnostics, `config: ${path}: categories.${categoryName}.tools ignored (invalid value)`, `categories.${categoryName}.tools`)
    }
  }
  return parsed
}

function validateCategories(value, path, diagnostics) {
  if (!isPlainRecord(value)) {
    warn(diagnostics, `config: ${path}: categories ignored (invalid value)`, "categories")
    return undefined
  }
  const parsed = {}
  for (const [name, definition] of Object.entries(value)) {
    const entry = validateCategoryEntry(definition, path, name, diagnostics)
    if (entry !== undefined) parsed[name] = entry
  }
  return parsed
}

/** Port of validate.ts parseConfig: keep only target keys that pass their schema. */
function parseConfigView(view, diagnostics) {
  const parsed = {}
  for (const [key, value] of Object.entries(view.config)) {
    if (!TARGET_KEYS.has(key)) continue
    if (key === "monitor") {
      const section = validateMonitor(value, view.path, diagnostics)
      if (section !== undefined) parsed.monitor = section
    } else if (key === "goal") {
      const section = validateGoal(value, view.path, diagnostics)
      if (section !== undefined) parsed.goal = section
    } else if (key === "experimental") {
      const section = validateExperimental(value, view.path, diagnostics)
      if (section !== undefined) parsed.experimental = section
    } else if (key === "team_mode") {
      const section = validateTeamMode(value, view.path, diagnostics)
      if (section !== undefined) parsed.team_mode = section
    } else if (key === "default_mode") {
      const section = validateDefaultMode(value, view.path, diagnostics)
      if (section !== undefined) parsed.default_mode = section
    } else if (key === "skills") {
      if (isPlainRecord(value)) parsed.skills = sanitizeValue(value)
      else warn(diagnostics, `config: ${view.path}: skills ignored (invalid value)`, "skills")
    } else if (key === "hashline_edit") {
      if (typeof value === "boolean") parsed.hashline_edit = value
      else warn(diagnostics, `config: ${view.path}: hashline_edit ignored (invalid value)`, "hashline_edit")
    } else if (STRING_ARRAY_KEYS.has(key)) {
      if (Array.isArray(value)) parsed[key] = value.filter((entry) => typeof entry === "string")
      else warn(diagnostics, `config: ${view.path}: ${key} ignored (invalid value)`, key)
    } else if (key === "categories") {
      const section = validateCategories(value, view.path, diagnostics)
      if (section !== undefined) parsed.categories = section
    } else if (key === "agents") {
      // The user's per-agent overrides (`agents.<id>.model` / `.models` /
      // `.fallback_models` plus adjacent fields) are the runtime's sole model
      // source; carry the block sanely so the live reader can normalize it. The
      // shape is validated downstream by `readAgentOverridesFromConfig`.
      if (isPlainRecord(value)) parsed.agents = sanitizeValue(value)
      else warn(diagnostics, `config: ${view.path}: agents ignored (invalid value)`, "agents")
    } else if (key === "ralph_loop") {
      if (isPlainRecord(value)) parsed.ralph_loop = value
      else rejectDeclaration(diagnostics, "ralph_loop")
    } else if (key === "openclaw") {
      // The bidirectional OpenClaw block is carried raw (sanitized
      // against prototype-pollution keys) because its own shape is validated at
      // runtime by the native normalizer, exactly like V1 read it from the
      // plugin config. An absent block stays absent (no-op), never materialized.
      if (isPlainRecord(value)) parsed.openclaw = sanitizeValue(value)
      else warn(diagnostics, `config: ${view.path}: openclaw ignored (invalid value)`, "openclaw")
    }
  }
  return parsed
}

/** Port of config-merger.ts mergeConfigs reduced to the exposed keys. */
function mergeConfigViews(base, override) {
  return {
    ...base,
    ...override,
    disabled_tools: mergeUniqueStrings(base.disabled_tools, override.disabled_tools),
    disabled_agents: mergeUniqueStrings(base.disabled_agents, override.disabled_agents),
    disabled_skills: mergeUniqueStrings(base.disabled_skills, override.disabled_skills),
    disabled_hooks: mergeUniqueStrings(base.disabled_hooks, override.disabled_hooks),
    disabled_commands: mergeUniqueStrings(base.disabled_commands, override.disabled_commands),
    disabled_mcps: mergeUniqueStrings(base.disabled_mcps, override.disabled_mcps),
    categories: deepMerge(base.categories, override.categories),
    agents: deepMerge(base.agents, override.agents),
  }
}

/** Port of validate.ts migrateRalphLoopConfig. */
function migrateRalphLoop(config) {
  const legacy = config.ralph_loop
  if (!isPlainRecord(legacy)) return config
  const enabled = typeof legacy.enabled === "boolean" ? legacy.enabled : undefined
  const defaultMaxIterations = typeof legacy.default_max_iterations === "number" ? legacy.default_max_iterations : undefined
  if (enabled === undefined && defaultMaxIterations === undefined) return config
  const existingGoal = config.goal
  return {
    ...config,
    goal: {
      enabled: existingGoal?.enabled ?? enabled ?? false,
      auto_start: existingGoal?.auto_start ?? false,
      default_max_iterations: existingGoal?.default_max_iterations ?? defaultMaxIterations ?? 100,
    },
  }
}

function canonicalCategoryName(name) {
  return name === "deep" ? "deep-low" : name
}

/** Port of canonicalizeCategoriesRecord: rename `deep`, drop a legacy collision. */
function canonicalizeCategoriesRecord(categories) {
  const result = {}
  for (const [name, definition] of Object.entries(categories)) {
    const canonical = canonicalCategoryName(name)
    if (canonical === name) {
      result[name] = definition
      continue
    }
    if (!Object.hasOwn(categories, canonical)) result[canonical] = definition
  }
  return result
}

function baseLayerView(layer) {
  const result = {}
  for (const [key, value] of Object.entries(layer)) {
    if (key === "profiles" || HARNESS_BLOCK_KEYS.has(key) || NON_PLUGIN_FIELDS.has(key)) continue
    result[key] = value
  }
  return result
}

function blockView(layer) {
  return isPlainRecord(layer["[opencode]"]) ? { ...layer["[opencode]"] } : {}
}

function profileRecord(layer, profileName) {
  if (profileName === undefined || !isPlainRecord(layer.profiles)) return {}
  const selected = layer.profiles[profileName]
  if (!isPlainRecord(selected)) return {}
  const result = {}
  for (const key of PROFILE_KEYS) {
    if (key in selected) result[key] = selected[key]
  }
  return result
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : []
}

/**
 * The user-scope MCP env allowlist across every placement the unified schema
 * admits at the user layer: the layer root, the `[opencode]` harness block, and
 * the same two spots inside the selected profile block. Mirrors V1
 * `protectedUserView` (which reads the block) without dropping a root-level key.
 *
 * Presence is reported beside the values, because this key is not one of
 * `parseConfigView`'s target keys and this collector IS its parser: an empty
 * list, a key no layer wrote and a refused value must stay distinguishable.
 * Project-scope placements are deliberately NOT declarations: the fold refuses
 * them by scope, and that scope policy is a later migration phase.
 */
function collectUserMcpEnvAllowlist(layer, profileName, path) {
  const profile = profileRecord(layer, profileName)
  const placements = [
    { placement: layer, at: "" },
    { placement: layer["[opencode]"], at: "[opencode]." },
    { placement: profile, at: profileName === undefined ? "" : `profiles.${profileName}.` },
    {
      placement: profile["[opencode]"],
      at: profileName === undefined ? "[opencode]." : `profiles.${profileName}.[opencode].`,
    },
  ]
  const values = []
  const declarations = []
  for (const { placement, at } of placements) {
    if (!isPlainRecord(placement)) continue
    if (!Object.prototype.hasOwnProperty.call(placement, "mcp_env_allowlist")) continue
    const value = placement.mcp_env_allowlist
    declarations.push({ path, at: `${at}mcp_env_allowlist`, rejected: !Array.isArray(value) })
    values.push(...stringArray(value))
  }
  return { values, declarations }
}

// `disabled_mcps` is observed through the SAME placement list the plugin fold
// uses (declared below), so the observer can never drift from the fold: a
// placement the fold drops is not a declaration here either.

/**
 * Record whether ONE layer declared `disabled_mcps`, and whether the value it
 * authored was refused, split by LAYER SCOPE.
 *
 * This is the ONLY reason a second record exists beside `declarations`: a union
 * fold can answer "did any layer declare the key?" but never "did the USER
 * declare it?", and MCP blocking's scope contract depends on exactly that. Values
 * are deliberately NOT collected here; the enforced list always comes from the
 * resolved view, so a live list can never disagree with what a fresh install
 * would bake from the same file.
 *
 * The selected sections are the fold's own placements (layer root, `[opencode]`,
 * the profile block, the profile's `[opencode]`), which is why the shipped
 * profile's `profiles.<p>.[opencode].disabled_mcps` is a USER declaration.
 */
function observeMcpDisabledScope(record, layer, scope, profileName) {
  const entry = record[scope]
  if (entry === undefined) return
  for (const placement of PLUGIN_PLACEMENTS) {
    const section = placement.select(layer, profileName)
    if (!isPlainRecord(section)) continue
    if (!Object.prototype.hasOwnProperty.call(section, "disabled_mcps")) continue
    entry.declared = true
    // A refused declaration is recorded as REFUSED, not as absent: an
    // unconfirmed deny must keep denying.
    if (!Array.isArray(section.disabled_mcps)) entry.refused = true
  }
}

function validateLayer(raw, source, diagnostics) {
  if (!isPlainRecord(raw)) {
    warn(diagnostics, `config: ${source.path}: layer ignored (not an object)`)
    return undefined
  }
  const layer = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!LAYER_KEYS.has(key)) continue
    if (key === "[opencode]" || key === "[native]" || key === "[senpi]" || key === "[codex]" || key === "[omo]") {
      if (isPlainRecord(value)) layer[key] = value
      continue
    }
    if (key === "categories") {
      const categories = validateCategories(value, source.path, diagnostics)
      if (categories !== undefined) layer.categories = canonicalizeCategoriesRecord(categories)
      continue
    }
    if (key === "disabled_skills") {
      if (Array.isArray(value)) layer.disabled_skills = value.filter((entry) => typeof entry === "string")
      else warn(diagnostics, `config: ${source.path}: disabled_skills ignored (invalid value)`, "disabled_skills")
      continue
    }
    if (key === "profiles") {
      if (isPlainRecord(value)) layer.profiles = value
      continue
    }
    layer[key] = value
  }
  return layer
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry)
    return Object.freeze(value)
  }
  if (isPlainRecord(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry)
    return Object.freeze(value)
  }
  return value
}

/**
 * Resolve the three read options every live authority here shares, so the
 * plugin view and the per-key readers can never disagree on which file chain
 * they are reading.
 */
function resolveLiveReadOptions(options = {}) {
  return {
    directory: options.directory ?? process.cwd(),
    env: options.env ?? process.env,
    fileSystem: options.fileSystem ?? DEFAULT_READ_FILE_SYSTEM,
  }
}

/**
 * Load the live user+project layer chain ONCE.
 *
 * `resolveNativePluginConfig` absorbs a per-file read/parse failure into
 * `diagnostics` and keeps going, so one broken project layer cannot take the
 * whole runtime down. A LIVE reader can NOT treat that absorption as "the chain
 * declared nothing": falling back to the install-time manifest there is the
 * silent re-enable `resolveNativeTmuxVisualization` documents at length. The
 * failures therefore ride along in `loadFailures`, so the only reader that must
 * fail closed can tell "no layer declared the key" from "a layer could not be
 * read", while every existing caller keeps the historical behavior.
 */
function collectLiveConfigLayers({ directory, env, fileSystem, manifest }) {
  const diagnostics = []
  const profileName = resolveProfileName(env, manifest)
  const candidates = resolveLayerPaths({ cwd: directory, env, fileSystem })
  const sources = []
  const layers = []
  const loadFailures = []
  // Presence records for the two keys this pass owns before the fold: the
  // user-scope MCP env allowlist and a layer-root key the layer validator
  // refused. Both are DECLARATIONS: the file wrote them.
  const mcpEnvAllowlistDeclarations = []
  const layerDeclarations = []
  let userMcpEnvAllowlist = []
  const mcpDisabledScope = {
    user: { declared: false, refused: false },
    project: { declared: false, refused: false },
  }

  for (const candidate of candidates) {
    if (!fileSystem.existsSync(candidate.path)) {
      sources.push({ path: candidate.path, scope: candidate.scope, loaded: false })
      continue
    }
    let layer
    const layerSink = createDiagnosticsSink(diagnostics)
    try {
      layer = validateLayer(readJsonc(fileSystem.readFileSync(candidate.path, "utf-8")), candidate, layerSink)
    } catch (error) {
      const reason = readFailureReason(error)
      warn(diagnostics, `config: ${candidate.path}: ${reason}`)
      sources.push({ path: candidate.path, scope: candidate.scope, loaded: false })
      loadFailures.push({ path: candidate.path, scope: candidate.scope, reason })
      continue
    }
    if (layer === undefined) {
      // `validateLayer` rejects a root that parses but is not an object (`null`,
      // `[]`, a scalar). The file exists, so this is a layer the chain could not
      // read as an entry, NOT a layer that declared nothing: recording it as a
      // load failure is what keeps the fail-closed reader from reporting
      // `undeclared` and restoring the install-time block it may not confirm.
      const reason = "layer root is not an object"
      sources.push({ path: candidate.path, scope: candidate.scope, loaded: false })
      loadFailures.push({ path: candidate.path, scope: candidate.scope, reason })
      continue
    }
    layers.push({ config: layer, path: candidate.path, scope: candidate.scope })
    // A key the layer validator refused (a malformed `categories` or
    // `disabled_skills` at the layer root) was authored by the file, so it is
    // recorded here as a refused layer-root declaration instead of vanishing
    // into `undeclared`.
    for (const key of layerSink.rejected) layerDeclarations.push({ key, path: candidate.path, at: key, rejected: true })
    // V1 security rule: the MCP env allowlist is user-layer only, so a project
    // layer can never extend it. V1 reads it from the harness block
    // (`protectedUserView` = `[opencode]`), and the unified layer schema also
    // admits it at the layer root and in the user's own profile block, so a
    // user-scope layer contributes from all three placements.
    if (candidate.scope === "user") {
      const allowlist = collectUserMcpEnvAllowlist(layer, profileName, candidate.path)
      userMcpEnvAllowlist = [...new Set([...userMcpEnvAllowlist, ...allowlist.values])]
      mcpEnvAllowlistDeclarations.push(...allowlist.declarations)
    }
    // MCP blocking's scope contract needs the declaration split per scope; the
    // union fold below carries the VALUE and the generic `declarations` record
    // carries presence, but neither can name the declaring scope.
    observeMcpDisabledScope(mcpDisabledScope, layer, candidate.scope, profileName)
    sources.push({ path: candidate.path, scope: candidate.scope, loaded: true })
  }

  return { diagnostics, profileName, sources, layers, loadFailures, userMcpEnvAllowlist, mcpEnvAllowlistDeclarations, layerDeclarations, mcpDisabledScope }
}

const PLUGIN_PLACEMENTS = Object.freeze([
  { select: (layer) => baseLayerView(layer), prefix: () => "" },
  { select: (layer) => blockView(layer), prefix: () => "[opencode]." },
  {
    select: (layer, profileName) => baseLayerView(profileRecord(layer, profileName)),
    prefix: (profileName) => (profileName === undefined ? "" : `profiles.${profileName}.`),
  },
  {
    select: (layer, profileName) => blockView(profileRecord(layer, profileName)),
    prefix: (profileName) => (profileName === undefined ? "[opencode]." : `profiles.${profileName}.[opencode].`),
  },
])

/**
 * Fold the collected layers into the plugin-facing view. Split out of
 * `resolveNativePluginConfig` so a second live-read authority can reuse the
 * exact same assembly instead of re-deriving it.
 *
 * The precedence is PLACEMENT-MAJOR and LAYER-INNER: every layer contributes the
 * first placement, then every layer contributes the second, and so on, so a
 * placement on a farther layer outranks a lower placement on a nearer one
 * (`profiles.<P>.[opencode]` > `profiles.<P>` > `[opencode]` > root). Which
 * placement wins is therefore a property of `PLUGIN_PLACEMENTS`, shared with the
 * declaration finder below instead of restated in a second loop nesting.
 */
function buildResolvedConfigView(collected, directory) {
  const { diagnostics, profileName, sources, layers, loadFailures, userMcpEnvAllowlist, mcpEnvAllowlistDeclarations, layerDeclarations, mcpDisabledScope } = collected

  // Declaration records follow the fold below, so presence can never disagree
  // with the value the resolved view carries.
  const declarationRecords = new Map()
  for (const entry of mcpEnvAllowlistDeclarations) appendDeclaration(declarationRecords, "mcp_env_allowlist", entry)
  for (const entry of layerDeclarations) appendDeclaration(declarationRecords, entry.key, entry)

  const views = []
  for (const placement of PLUGIN_PLACEMENTS) {
    for (const layer of layers) {
      const config = placement.select(layer.config, profileName)
      if (Object.keys(config).length > 0) {
        views.push({ config, path: layer.path, at: placement.prefix(profileName), declare: true })
      }
    }
  }

  const mergedLayers = layers.reduce((accumulator, layer) => mergeRecords(accumulator, layer.config), {})
  const resolvedView = resolveOmoConfigView(mergedLayers, "opencode", profileName)
  if (isPlainRecord(resolvedView.categories)) {
    // The real loader canonicalizes legacy category names at layer validation, so
    // `deep` never survives into the merged view. Canonicalize here too, before
    // the deep-merge, or the legacy key would be re-introduced by the merge.
    const categories = canonicalizeCategoriesRecord(resolvedView.categories)
    if (Object.keys(categories).length > 0) {
      views.push({ config: { categories }, path: layers[0]?.path ?? directory, at: "", declare: false })
    }
  }

  let config = {}
  for (const view of views) {
    const sink = createDiagnosticsSink(diagnostics)
    const parsed = parseConfigView(view, sink)
    // The synthetic merged-categories view is a projection, not a declaration:
    // it re-validates values already recorded by their own placements.
    if (view.declare) observeDeclarations(declarationRecords, view, sink.rejected)
    config = mergeConfigViews(config, parsed)
  }
  config = migrateRalphLoop(config)

  // Parity with the real OmO loader: when a key is absent from every layer the
  // loader leaves it `undefined`; it does NOT materialize schema defaults into
  // the plugin config view. Emitting synthetic defaults here would diverge from
  // V1, so each gate preserves its absence instead of inventing a value. What the
  // loader DOES preserve, whether a layer authored a key, is published separately
  // as `declarations` below; it never feeds the value projection.
  const monitor = config.monitor
  const goal = config.goal
  const view = {
    monitor,
    goal,
    experimental: {
      task_system: config.experimental?.task_system ?? false,
      max_tools: config.experimental?.max_tools,
      // T34: preemptive compaction gate (V1 default off) and its Rigel threshold
      // override. Absence keeps the gate off and the threshold unmaterialized, so
      // the runtime falls back to the V1 0.78 constant.
      preemptive_compaction: config.experimental?.preemptive_compaction ?? false,
      preemptive_compaction_threshold: config.experimental?.preemptive_compaction_threshold,
      // T38: V1 truncate-all gate (off by default). Rides the manifest so the
      // truncator rule reads it without parsing omo.jsonc in the runtime.
      truncate_all_tool_outputs: config.experimental?.truncate_all_tool_outputs ?? false,
    },
    team_mode: config.team_mode,
    // OmO's "start the session in this mode" switch. Undefined when no layer
    // declared the block (V1 parity: the loader leaves an absent optional block
    // absent); a declared block carries the schema's `false` defaults.
    default_mode: config.default_mode,
    // Root hashline_edit is authoritative; the legacy experimental placement is
    // folded in when the root key is absent, mirroring V1's config migration.
    hashline_edit: config.hashline_edit === true || config.experimental?.hashline_edit === true,
    disabled: {
      tools: config.disabled_tools ?? [],
      agents: config.disabled_agents ?? [],
      skills: config.disabled_skills ?? [],
      // V1 `disabled_hooks` gate (e.g. "think-mode"). Carried so a per-hook
      // runtime surface can honor the same disable switch.
      hooks: config.disabled_hooks ?? [],
      // V1 `disabled_commands` gate: the builtin command loader filters these
      // names out. Carried so the native command surface honors the same switch.
      commands: config.disabled_commands ?? [],
    },
    disabled_mcps: config.disabled_mcps ?? [],
    // User-layer only (V1 parity): never merged from project layers.
    mcp_env_allowlist: userMcpEnvAllowlist,
    // Presence/refusal of `disabled_mcps` PER SCOPE, from the same layer pass
    // that produced `disabled_mcps` above. The value always comes from that
    // resolved list; this record only says which scope authored it, which is what
    // the user-baseline vs project-hardening rule needs. See
    // `resolveNativeDisabledLists`.
    mcpDisabledScope,
    categories: config.categories ?? {},
    // Upstream 5a9bb74a4: the raw user `agents` block, carried so the generator can
    // materialize the per-agent "explicit model" overrides into the manifest.
    agents: config.agents ?? {},
    // The resolved OpenClaw block is undefined when no layer sets it. The
    // generator materializes it into the manifest; the runtime never parses
    // omo.jsonc itself.
    openclaw: config.openclaw,
    // Whether a layer AUTHORED each gate/block/list, derived from the same fold.
    // `false`, `0`, `[]` and `{}` are declarations; a default the projection
    // invented is not. See the declaration contract at the top of this module.
    declarations: buildDeclarations(declarationRecords),
    // Files that exist but could not be read or parsed. A non-empty list means
    // no presence entry is authoritative: an unreadable layer may have declared
    // or overridden the key, so a sensitive reader must fail closed instead of
    // treating `undeclared` as "the install-time manifest still applies".
    // Existing readers keep their historical behavior; a later phase consumes
    // this to fail closed.
    loadFailures,
    diagnostics,
    sources,
  }
  return deepFreeze(view)
}

/**
 * Resolve the plugin-facing OmO configuration view for the native V2 runtime.
 *
 * @param {{ directory?: string, env?: Record<string, string|undefined>, fileSystem?: object, manifest?: object }} [options]
 * @returns {{
 *   monitor: Record<string, unknown>,
 *   goal: { enabled: boolean, auto_start: boolean, default_max_iterations: number },
 *   experimental: { task_system: boolean },
 *   disabled: { tools: string[], agents: string[], skills: string[] },
 *   default_mode: { ultrawork: boolean, goal: boolean } | undefined,
 *   disabled_mcps: string[],
 *   mcp_env_allowlist: string[],
 *   categories: Record<string, unknown>,
 *   diagnostics: string[],
 *   declarations: Record<string, { state: "declared" | "error" | "undeclared", sources?: { path: string, at: string }[] }>,
 *   loadFailures: { path: string, scope: string, reason: string }[],
 *   sources: { path: string, scope: string, loaded: boolean }[],
 * }}
 */
export function resolveNativePluginConfig(options = {}) {
  const { directory, env, fileSystem } = resolveLiveReadOptions(options)
  const collected = collectLiveConfigLayers({ directory, env, fileSystem, manifest: options.manifest })
  return buildResolvedConfigView(collected, directory)
}

// --- Native V2 gate reader (Task 15 aggregator contract) ---
// Reads materialized gates from the generated agent manifest so a tool
// family is registered only when its gate is enabled. Distinct from
// resolveNativePluginConfig (which reads omo.jsonc directly).
const GATE_KEYS = Object.freeze(["monitor", "goal", "task_system", "team_mode", "interactive_bash", "hashline_edit", "preemptive_compaction"])

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/**
 * Read the materialized feature gates from a manifest. Returns a frozen record
 * with every known gate present as a boolean; an absent or malformed gate is
 * `false`. Unknown keys are ignored so a newer generator can add gates without
 * breaking an older runtime.
 *
 * The `goal` gate is quarantined by {@link quarantineNativeGates}: the inherited
 * Goal is replaced by the vendored community engine, so a manifest that forces
 * `goal: true` (hand-edited or materialized before the switchover) still reads
 * `goal: false`. This is the runtime fail-closed backstop.
 */
export function readNativeGates(manifest) {
  const gates = isPlainObject(manifest?.metadata?.global?.gates) ? manifest.metadata.global.gates : {}
  const resolved = {}
  for (const key of GATE_KEYS) resolved[key] = gates[key] === true
  return Object.freeze(quarantineNativeGates(resolved))
}

/**
 * Read the user-declared categories materialized by the generator. Returns a
 * plain object (never the manifest's live reference) so a caller cannot mutate
 * the manifest. Absent or malformed data yields `{}`.
 */
export function readUserCategories(manifest) {
  const categories = manifest?.metadata?.global?.categories
  return isPlainObject(categories) ? { ...categories } : {}
}

/**
 * Normalize one raw per-agent override entry (V1 `agents.<id>` block) for the
 * runtime. The FULL authored entry is preserved (a shallow copy, with the
 * `models`/`fallback_models` arrays copied) so no adjacent or unknown supported
 * field is flattened away. The canonical ordered candidates (`models[]`) are
 * then decomposed with V1 `materializeAgentModelChains` parity: `models[0]`
 * becomes `model` (plus its `variant` when it is an object and neither is
 * already authored), the remaining candidates append to `fallback_models`, and
 * the `models` key is dropped. An explicitly authored `model`/`variant`/
 * `fallback_models` is never overwritten. Returns `undefined` only when `value`
 * is not a plain object, so a malformed entry is dropped rather than
 * materialized. The input is never mutated.
 */
function normalizeAgentOverrideEntry(value) {
  if (!isPlainObject(value)) return undefined
  const entry = { ...value }
  if (Array.isArray(value.models)) entry.models = [...value.models]
  if (Array.isArray(value.fallback_models)) entry.fallback_models = [...value.fallback_models]
  const models = entry.models
  if (Array.isArray(models) && models.length > 0) {
    const [primary, ...fallbacks] = models
    if (!(typeof entry.model === "string" && entry.model.trim())) {
      if (typeof primary === "string") entry.model = primary
      else if (isPlainObject(primary) && typeof primary.model === "string") entry.model = primary.model
    }
    if (!(typeof entry.variant === "string" && entry.variant) && isPlainObject(primary) && typeof primary.variant === "string") {
      entry.variant = primary.variant
    }
    if (fallbacks.length > 0) {
      const existing = Array.isArray(entry.fallback_models) ? entry.fallback_models : []
      entry.fallback_models = [...existing, ...fallbacks]
    }
    delete entry.models
  }
  return entry
}

/**
 * Read the per-agent overrides from a raw `agents` block (the live
 * `~/.omo/omo.jsonc` view). Keys are kept as authored; the key-canonicalizing
 * authority selection lives in `resolveAuthoritativeAgentOverrides`. Absent or
 * malformed input yields `{}` and the input is never mutated.
 */
export function readAgentOverridesFromConfig(agents) {
  if (!isPlainObject(agents)) return {}
  const result = {}
  for (const [id, value] of Object.entries(agents)) {
    const entry = normalizeAgentOverrideEntry(value)
    if (entry) result[id] = entry
  }
  return result
}

/**
 * Read the per-agent overrides from the LIVE OmO config the host environment
 * resolves: the user `~/.omo/omo.jsonc`, through the SAME authority the manifest
 * generator uses, so the live view and the baked manifest agree on shape. V2's
 * plugin setup context exposes no plugin `config` (probed: `context.config` is
 * undefined), so the on-disk config is the only live source.
 *
 * Returns a discriminated SOURCE rather than a bare override map, because the
 * R1 gate must tell three states apart. A single `{}` for every failure is
 * exactly the bug it fixes: it cannot distinguish "the user removed the pin"
 * from "the file is unreadable", so both fell back to the baked manifest and
 * revived a removed pin.
 *
 *   - `{ state: "absent", path }`             no live config file exists
 *   - `{ state: "loaded", path, overrides, categories }`  the live file parsed;
 *     authoritative, also carrying the resolved live `categories` block
 *   - `{ state: "error", path, reason }`      the live file exists but could not
 *     be read/parsed; the caller must NOT fall back to a stale baked pin
 *
 * Resolution is anchored at the resolved HOME (`options.home` / `$HOME`),
 * mirroring the generator's `--directory <home>`. That keeps the read to the
 * USER layer and stops the project-layer walk from escaping ABOVE the home: the
 * host runs on Bun, where `os.userInfo().homedir` follows `$HOME`, so a session
 * whose directory sits outside the home would otherwise load the real
 * `~/.omo/omo.jsonc` as a project layer that wins over the intended user config.
 * The live path detection and the view resolution share one effective env
 * (`HOME` forced to the same `home`) so they can never disagree on the file.
 */
export function readLiveAgentOverridesSource(options = {}) {
  const env = options.env ?? process.env
  const home = resolve(options.home ?? env.HOME ?? env.USERPROFILE ?? process.cwd())
  const fileSystem = options.fileSystem ?? DEFAULT_READ_FILE_SYSTEM
  const effectiveEnv = { ...env, HOME: home }
  const userPath = detectUserConfigPath(effectiveEnv, fileSystem)
  if (!fileSystem.existsSync(userPath)) return { state: "absent", path: userPath }
  try {
    readJsonc(fileSystem.readFileSync(userPath, "utf-8"))
  } catch (error) {
    return { state: "error", path: userPath, reason: readFailureReason(error) }
  }
  const view = resolveNativePluginConfig({ ...options, env: effectiveEnv, directory: home })
  // `categories` rides the same resolved view: category delegation reads the live
  // `~/.omo/omo.jsonc` through this one live-read authority instead of a second
  // parse. A file without a `categories` key yields `{}` (built-ins only), which
  // is identical to the previous behavior.
  return { state: "loaded", path: userPath, overrides: readAgentOverridesFromConfig(view?.agents), categories: view?.categories }
}

/**
 * Read the materialized denylists (tools / agents / skills) the generator wrote
 * from the resolved config view. Returns normalized string arrays; absent or
 * malformed data yields empty arrays so a caller can never crash on a manifest.
 */
export function readNativeDisabled(manifest) {
  const raw = manifest?.metadata?.global?.disabled
  const source = isPlainObject(raw) ? raw : {}
  const normalize = (value) => Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : []
  return {
    tools: normalize(source.tools),
    agents: normalize(source.agents),
    skills: normalize(source.skills),
    hooks: normalize(source.hooks),
    commands: normalize(source.commands),
  }
}

/**
 * Read the materialized `openclaw` profile block. Returns the block or
 * undefined when absent, which is the strict no-op default. The runtime
 * normalizes and gates it; the generator wrote it from the resolved config view,
 * so the runtime never parses omo.jsonc itself.
 */
export function readNativeOpenclaw(manifest) {
  const value = manifest?.metadata?.global?.openclaw
  return isPlainObject(value) ? value : undefined
}

/**
 * Read the materialized `team_mode` profile block. The generator owns config
 * parsing; callers still validate individual limits because manifests can be
 * stale or manually corrupted.
 */
export function readNativeTeamMode(manifest) {
  const value = manifest?.metadata?.global?.teamMode
  return isPlainObject(value) ? value : undefined
}

/**
 * Read the materialized `experimental.max_tools` cap. Returns undefined when
 * unset (no trimming) or when the manifest carries a non-integer value, so the
 * trimming caller can treat "unset" and "invalid" the same way: no cap.
 */
export function readNativeTmuxVisualization(manifest) {
  return manifest?.metadata?.global?.tmuxVisualization === true
}

/**
 * Resolve `team_mode.tmux_visualization` from the LIVE user+project chain.
 *
 * Three states, mirroring `readLiveAgentOverridesSource`:
 * - `declared`: a layer declared the key; the merged view is authoritative and
 *   the project layer wins, per the documented precedence.
 * - `undeclared`: no layer declared it. The caller keeps whatever the
 *   install-time manifest materialized, so no value is invented here.
 * - `error`: the chain could not be resolved at all; the caller fails closed.
 */
export function readLiveTmuxVisualizationSource(options = {}) {
  try {
    const view = resolveNativePluginConfig(options)
    const teamMode = view?.team_mode
    if (!isPlainObject(teamMode) || !Object.prototype.hasOwnProperty.call(teamMode, "tmux_visualization")) {
      return { state: "undeclared" }
    }
    return { state: "declared", value: teamMode.tmux_visualization === true }
  } catch (error) {
    return { state: "error", reason: readFailureReason(error) }
  }
}

/**
 * Resolve the tmux-visualization gate at RUNTIME.
 *
 * The manifest value is materialized at INSTALL time from the install-time user
 * layer, so it can never see a public project layer: a project declaring
 * `[opencode].team_mode.tmux_visualization = true` stayed dark no matter what
 * it asked for. The live chain is therefore authoritative once it declares the
 * key, while an undeclared key keeps the materialized manifest value, so an
 * already-enabled install is never disabled and no default changes. `true` is
 * never synthesized.
 *
 * An ERROR reading the live chain is NOT "undeclared": it must FAIL CLOSED. A
 * fallback to the install-time manifest here would re-enable the gate from a
 * value the runtime could not confirm: if the manifest baked the gate ON and
 * the project chain became unreadable, the error would silently turn the
 * feature back on. Only a truly UNDECLARED key may consult the manifest.
 */
export function resolveNativeTmuxVisualization({ manifest, ...options } = {}) {
  const live = readLiveTmuxVisualizationSource({ manifest, ...options })
  if (live.state === "declared") return live.value === true
  if (live.state === "error") return false
  return readNativeTmuxVisualization(manifest)
}

/**
 * Read the live `[opencode].openclaw` block from the user+project chain.
 *
 * Third live-read authority, beside `readLiveAgentOverridesSource` and
 * `readLiveTmuxVisualizationSource`. Same three states, same reason for them:
 *
 * - `declared`: a layer wrote the key, so the resolved live block is
 *   authoritative WHOLESALE (Contrato_Transportes_OpenClaw.md S4.2). A
 *   field-by-field merge is rejected on purpose: the absent field would be
 *   refilled from the manifest, so "I deleted a gateway" could never be
 *   expressed and the deletion would re-silence itself.
 * - `undeclared`: no layer wrote it, so the caller keeps the install-time
 *   manifest value. On an install that never declared the block both coincide
 *   by construction, which is why the current behavior is preserved.
 * - `error`: the chain could not be resolved, OR a layer that exists could not
 *   be read/parsed, OR a layer whose root parses to something that is not an
 *   object, OR the declaration that wins is not an object. The caller must
 *   fail CLOSED. `resolveNativeTmuxVisualization` argues the reason: falling
 *   back to the manifest would re-enable a NETWORK surface from a value the
 *   runtime could not confirm.
 *
 * The per-file failure classification is a deliberate divergence from the tmux
 * analogue, which pins the loader's absorption as `undeclared`. U2's acceptance
 * criterion requires exactly the opposite observable (an unreadable live file
 * leaves `openclaw` inert with the error reported), and that criterion exists
 * because this surface reaches the network. A rejected layer root counts as one
 * of those failures: the file exists and parses, so classifying it as
 * `undeclared` would hand back the install-time block.
 *
 * The declaration is chosen in the fold's own placement order (see
 * `PLUGIN_PLACEMENTS`), so `at`/`path` name the placement the resolved view
 * actually keeps, and a non-object at that placement is an error instead of a
 * bypass. `reason` is value-free by construction (`readFailureReason`): it
 * names a path and a class, never source text.
 */
export function readLiveOpenclawSource(options = {}) {
  const { directory, env, fileSystem } = resolveLiveReadOptions(options)
  let collected
  try {
    collected = collectLiveConfigLayers({ directory, env, fileSystem, manifest: options.manifest })
  } catch (error) {
    return { state: "error", reason: readFailureReason(error) }
  }

  const failure = collected.loadFailures[0]
  if (failure !== undefined) {
    return { state: "error", path: failure.path, scope: failure.scope, reason: failure.reason }
  }

  const declaration = findOpenclawDeclaration(collected.layers, collected.profileName)
  if (declaration === undefined) return { state: "undeclared" }
  if (!isPlainRecord(declaration.value)) {
    return { state: "error", path: declaration.path, at: declaration.at, reason: `${declaration.at} is not an object` }
  }

  const view = buildResolvedConfigView(collected, directory)
  return { state: "declared", path: declaration.path, at: declaration.at, value: view.openclaw }
}

/**
 * Resolve the `openclaw` block the runtime must use, plus the transitions to
 * report.
 *
 * The manifest is only consulted for a genuinely UNDECLARED key. A declared
 * chain wins wholesale, and a chain in error yields NO config at all, which the
 * composition turns into its documented inert no-op: no dispatch, no listener,
 * no network.
 *
 * Diagnostics are identity-level only (S4.3): state, resolved path, and which
 * surfaces/gateways/channels were added or removed. Never a value, never a
 * token, never a URL. At most ONE line is produced per resolution, so a state
 * change is reported once instead of spamming the log, and an agreeing chain
 * reports nothing. `live.reason` is already value-free when it arrives here
 * (`readFailureReason`), so the interpolation below cannot leak source text.
 */
export function resolveNativeOpenclaw({ manifest, ...options } = {}) {
  const live = readLiveOpenclawSource({ manifest, ...options })
  const diagnostics = []

  if (live.state === "error") {
    const where = typeof live.path === "string" ? `${live.path}: ` : ""
    diagnostics.push(`Native V2 openclaw: ${where}live config could not be resolved (${live.reason}); openclaw stays disabled instead of using the installed manifest`)
    return { state: live.state, config: undefined, diagnostics }
  }

  if (live.state === "declared") {
    const diff = openclawIdentityDiff(openclawIdentities(readNativeOpenclaw(manifest)), openclawIdentities(live.value))
    if (diff.length > 0) {
      diagnostics.push(`Native V2 openclaw: live config declares ${live.at} in ${live.path} (${diff.join("; ")}); using the live block wholesale. Reinstall to resync the manifest`)
    }
    return { state: live.state, path: live.path, config: live.value, diagnostics }
  }

  return { state: live.state, config: readNativeOpenclaw(manifest), diagnostics }
}

/**
 * Locate the placement that declares `openclaw`, in the SAME order
 * `buildResolvedConfigView` folds: placement-major, layer-inner, so the LAST
 * declaration is the one the resolved view keeps.
 *
 * Sharing `PLUGIN_PLACEMENTS` is what makes that claim structural instead of a
 * comment. The finder used to walk layers first, which let a lower-precedence
 * project placement masquerade as the declared one (an `openclaw: null` at
 * `profiles.<P>.[opencode]` lost to the project root, and the enabled project
 * block was dispatched from a chain the user had switched off).
 */
function findOpenclawDeclaration(layers, profileName) {
  let found
  for (const placement of PLUGIN_PLACEMENTS) {
    for (const layer of layers) {
      const source = placement.select(layer.config, profileName)
      if (!Object.prototype.hasOwnProperty.call(source, "openclaw")) continue
      found = { path: layer.path, at: `${placement.prefix(profileName)}openclaw`, value: source.openclaw }
    }
  }
  return found
}

/**
 * The identity view of an `openclaw` block: which surfaces exist and which
 * identities they name. Deliberately excludes every value, so a diff can be
 * logged without exposing a token, a URL or an instruction.
 */
function openclawIdentities(config) {
  const source = isPlainRecord(config) ? config : {}
  const keys = (value) => (isPlainRecord(value) ? Object.keys(value).sort() : [])
  const endpointIdentities = projectOpenclawEndpointIdentities({ normalized: normalizeOpenclawConfig(source), config: source })
  const replyPolicy = keys(source.replyPolicy)
  const replyPolicyAllowedAuthors = Object.fromEntries(replyPolicy.map((identity) => {
    const policy = source.replyPolicy[identity]
    const nonempty = isPlainRecord(policy) && Array.isArray(policy.allowedAuthors) && policy.allowedAuthors.length > 0
    return [identity, nonempty ? "nonempty" : "empty"]
  }))
  return {
    enabled: source.enabled === true,
    gateways: keys(source.gateways),
    hooks: keys(source.hooks),
    channels: endpointIdentities.channels.toSorted(),
    replyPolicy,
    replyPolicyAllowedAuthors,
    replyListener: keys(source.replyListener),
  }
}

function openclawIdentityDiff(from, to) {
  const parts = []
  if (from.enabled !== to.enabled) parts.push(`enabled ${from.enabled} -> ${to.enabled}`)
  for (const surface of ["gateways", "hooks", "channels", "replyPolicy", "replyListener"]) {
    const added = to[surface].filter((identity) => !from[surface].includes(identity))
    const removed = from[surface].filter((identity) => !to[surface].includes(identity))
    if (added.length > 0) parts.push(`${surface} +[${added.join(",")}]`)
    if (removed.length > 0) parts.push(`${surface} -[${removed.join(",")}]`)
  }
  for (const identity of from.replyPolicy) {
    if (!to.replyPolicy.includes(identity)) continue
    if (from.replyPolicyAllowedAuthors[identity] !== to.replyPolicyAllowedAuthors[identity]) {
      parts.push(`replyPolicy.${identity}.allowedAuthors ${from.replyPolicyAllowedAuthors[identity]} -> ${to.replyPolicyAllowedAuthors[identity]}`)
    }
  }
  return parts
}

// --- Native V2 gate policy (LIVE vs BAKED) ---
// WHERE each feature gate's value comes from at RUNTIME. The manifest is baked
// at INSTALL time, so a runtime that reads only the manifest answers an edited
// `~/.omo/omo.jsonc` with the stale install-time value and says nothing about it.
// This policy makes the choice EXPLICIT per gate instead of leaving it implied by
// whichever reader a caller happened to use.
//
// A LIVE gate is re-resolved from the same live user+project chain the generator
// used (`resolveNativePluginConfig`), so the runtime value is exactly what a
// reinstall would bake now. A BAKED gate keeps the install-time manifest value.
//
// LIVE is only claimed where the live chain can DECLARE the key on its own:
// - `team_mode`: `validateTeamMode` keeps only the keys a layer actually wrote, so
//   `enabled` is absent unless declared.
// - `monitor`: `validateMonitor` materializes the block defaults, so the presence
//   of a `monitor` block IS the declaration; a block that omits `enabled` declares
//   the family and reads the documented `false`.
// - `preemptive_compaction`, `task_system`, `hashline_edit`: the resolved view
//   materializes their `false` default, so the VALUE cannot answer "was it
//   declared". `declarations` can, and it also separates a REFUSED declaration from
//   an absent one, which is what lets a broken chain fail closed instead of
//   reviving the install-baked gate. `hashline_edit` tracks BOTH placements the
//   parser accepts (root `hashline_edit`, authoritative, plus the legacy
//   `experimental.hashline_edit`) and reads the SAME projected boolean the
//   materializer bakes, so a live value can never disagree with a fresh install.
//
// Everything else stays BAKED, each for a recorded reason:
// - `goal`: `quarantineNativeGates` owns the value on BOTH sides (generator and
//   runtime), so the live chain can never change it. Resolving it live would add a
//   second path to a gate that is deliberately forced `false`.
// - `interactive_bash`: its truth is host availability (a persistent-terminal
//   factory or a `tmux` on PATH), not a config key; the baked value records only
//   that `disabled_tools` does not forbid the family. That ONE recorded fact is
//   re-resolved at runtime: `releaseBakedDisabledToolGate` clears a baked `false`
//   when the EFFECTIVE live denylist stops naming the tool, so an explicit
//   `disabled_tools: []` re-enables the family without a reinstall. Host
//   availability is still probed where the family registers, never assumed.
export const NATIVE_GATE_POLICY = Object.freeze({
  monitor: "live",
  team_mode: "live",
  goal: "baked",
  task_system: "live",
  interactive_bash: "baked",
  hashline_edit: "live",
  preemptive_compaction: "live",
})

// How a LIVE gate reads its declaration out of the resolved config view.
// `undefined` means the chain did not declare the key. Every gate the policy marks
// `live` must appear here; a missing reader degrades to "undeclared", so the
// manifest is kept rather than a value invented.
const LIVE_GATE_DECLARATIONS = Object.freeze({
  monitor: (view) => (isPlainObject(view?.monitor) ? view.monitor.enabled === true : undefined),
  team_mode: (view) => (isPlainObject(view?.team_mode) && Object.prototype.hasOwnProperty.call(view.team_mode, "enabled")
    ? view.team_mode.enabled === true
    : undefined),
  preemptive_compaction: (view) => declaredKeyBoolean(view, ["experimental.preemptive_compaction"], () => view?.experimental?.preemptive_compaction),
  task_system: (view) => declaredKeyBoolean(view, ["experimental.task_system"], () => view?.experimental?.task_system),
  hashline_edit: (view) => declaredKeyBoolean(view, ["hashline_edit", "experimental.hashline_edit"], () => view?.hashline_edit),
})

/**
 * Read a boolean gate whose section the resolved view materializes a default for.
 *
 * The VALUE cannot answer "was the key declared", so this reads the phase-1
 * `declarations` record instead. Two failure classes are `error` rather than
 * `undeclared`, because both mean the runtime cannot confirm the gate and must
 * fail closed: a layer that exists but could not be read/parsed (`loadFailures`),
 * and a key that was authored but refused by the schema.
 *
 * `keys` lists the tracked paths that can declare the SAME gate, in precedence
 * order. A refused declaration is only fatal when no tracked placement survived
 * (a valid legacy `experimental.hashline_edit` still resolves the gate), and the
 * value always comes from the resolved view, never from the raw layer.
 */
function declaredKeyBoolean(view, keys, readValue) {
  const failure = Array.isArray(view?.loadFailures) ? view.loadFailures[0] : undefined
  if (failure !== undefined) {
    return { state: "error", path: failure.path, reason: failure.reason }
  }
  let refused
  for (const key of keys) {
    const declaration = view?.declarations?.[key]
    if (declaration === undefined || declaration.state === "undeclared") continue
    if (declaration.state === "error") {
      refused ??= { state: "error", at: key, reason: "declared value was refused by the schema" }
      continue
    }
    return { state: "declared", value: readValue() === true }
  }
  return refused
}

/**
 * Read the LIVE value of every LIVE gate from the user+project chain.
 *
 * Two states, mirroring `readLiveTmuxVisualizationSource`:
 * - `resolved`: the chain was read. `gates` carries ONLY the gates a layer
 *   declared; a gate absent from `gates` is undeclared and the caller keeps the
 *   install-time manifest value, so nothing is invented here. `failedClosed`
 *   names the gates the chain COULD have declared but could not confirm (a
 *   refused value, an unreadable layer); those never consult the manifest.
 * - `error`: the chain could not be resolved at all; the caller fails closed.
 *
 * BAKED gates are absent from `gates` in both states: they never read the chain.
 */
export function readLiveGatesSource(options = {}) {
  try {
    const view = resolveNativePluginConfig(options)
    const gates = {}
    const failedClosed = {}
    for (const gate of GATE_KEYS) {
      if (NATIVE_GATE_POLICY[gate] !== "live") continue
      const read = LIVE_GATE_DECLARATIONS[gate]
      if (typeof read !== "function") continue
      const value = read(view)
      if (value === undefined) continue
      if (typeof value === "boolean") {
        gates[gate] = value
        continue
      }
      if (value.state === "declared") {
        gates[gate] = value.value === true
        continue
      }
      failedClosed[gate] = value.reason ?? "unconfirmed declaration"
    }
    return { state: "resolved", gates, failedClosed }
  } catch (error) {
    return { state: "error", reason: readFailureReason(error) }
  }
}

/**
 * Release the single BAKED gate whose recorded meaning IS a denylist.
 *
 * `deriveNativeGates` bakes `interactive_bash` from one fact only: whether the
 * install-time `disabled_tools` forbade the family. Host availability is never
 * baked (the runtime probes it), so a `disabled_tools` edit is the only way that
 * gate can change without a reinstall. Keeping a stale `false` made the documented
 * `disabled_tools: []` release impossible: the live list reached registration as
 * an exact-name removal, but the family was never built in the first place.
 *
 * `liveDisabledTools` is the EFFECTIVE list `resolveNativeDisabledLists` produced,
 * so every fail-closed path arrives here as the installed list and keeps the gate
 * off: an unreadable chain, a refused value, and an undeclared list all preserve
 * the protection. A live list that still names the tool keeps it off too, and so
 * does a baked `false` the denylist never produced (an unknown bake is not proof
 * of a release).
 */
function releaseBakedDisabledToolGate({ manifest, gates, liveDisabledTools, diagnostics }) {
  if (gates.interactive_bash !== false) return
  if (!readNativeDisabled(manifest).tools.includes("interactive_bash")) return
  if (!Array.isArray(liveDisabledTools) || liveDisabledTools.includes("interactive_bash")) return
  gates.interactive_bash = true
  diagnostics.push("Native V2 gate policy: interactive_bash is released by the live disabled_tools list (it no longer names the tool, the installed manifest did); host availability is still probed where the family registers")
}

/**
 * Resolve the feature gates at RUNTIME under {@link NATIVE_GATE_POLICY}.
 *
 * `readNativeGates` stays the pure manifest reader: the materializer contract pins
 * its exact shape, so this resolver WRAPS it and never rewrites it.
 *
 * An ERROR reading the live chain is NOT "undeclared": LIVE gates FAIL CLOSED,
 * for the reason documented on `resolveNativeTmuxVisualization`. Falling back to
 * the install-time manifest would re-enable a gate from a value the runtime could
 * not confirm. Only a genuinely UNDECLARED key consults the manifest, and BAKED
 * gates never read the chain at all, so neither case can change them.
 *
 * A single gate whose declaration exists but was REFUSED, or whose layer could
 * not be read, fails closed on its own (`failedClosed`) while every other gate
 * keeps its resolved outcome: one malformed key must not silently flip a gate on,
 * and it must not take the readable gates down with it.
 *
 * A declared value that DISAGREES with the baked manifest is reported in
 * `diagnostics` and the live value is used: that is the whole point of a LIVE
 * gate, and the diagnostic is what the silent version was missing. `diagnostics`
 * is empty when the live chain agrees with the manifest or declares nothing.
 *
 * `disabledTools` is the EFFECTIVE live `disabled_tools` list, passed in already
 * resolved so this resolver never reads the chain twice. It releases the one
 * BAKED gate the denylist is the whole meaning of (`interactive_bash`); see
 * `releaseBakedDisabledToolGate`. Without it that baked `false` outlives the list
 * that produced it, so the documented `disabled_tools: []` release would need a
 * reinstall.
 */
export function resolveNativeGates({ manifest, disabledTools: suppliedDisabledTools, ...options } = {}) {
  const baked = readNativeGates(manifest)
  const live = readLiveGatesSource({ manifest, ...options })
  // A caller that already resolved the denylist passes it in (setup does, so the
  // chain is read once). Omitting it must not silently lose the release, so the
  // same authority is consulted here instead of treating "absent" as "declared
  // empty".
  const liveDisabledTools = suppliedDisabledTools ?? resolveNativeDisabledLists({ manifest, ...options }).lists.tools
  const gates = { ...baked }
  const diagnostics = []
  const liveGates = GATE_KEYS.filter((gate) => NATIVE_GATE_POLICY[gate] === "live")
  if (live.state === "error") {
    for (const gate of liveGates) gates[gate] = false
    if (liveGates.length > 0) {
      diagnostics.push(`Native V2 gate policy: live config unreadable (${live.reason ?? "unknown"}); ${liveGates.join(", ")} failed closed instead of using the installed manifest`)
    }
    return { gates: Object.freeze(gates), diagnostics }
  }
  for (const gate of liveGates) {
    const failure = live.failedClosed?.[gate]
    if (typeof failure === "string") {
      gates[gate] = false
      diagnostics.push(`Native V2 gate policy: ${gate} failed closed (${failure}) instead of using the installed manifest`)
      continue
    }
    if (!Object.prototype.hasOwnProperty.call(live.gates, gate)) continue
    const value = live.gates[gate] === true
    gates[gate] = value
    if (value !== baked[gate]) {
      diagnostics.push(`Native V2 gate drift: ${gate} is ${value} in the live config but ${baked[gate]} in the installed manifest; using the live value. Reinstall to resync the manifest`)
    }
  }
  // The ONE baked gate whose recorded meaning is the denylist may be RELEASED by
  // the resolved live list. Every other baked gate keeps the manifest value.
  releaseBakedDisabledToolGate({ manifest, gates, liveDisabledTools, diagnostics })
  return { gates: Object.freeze(gates), diagnostics }
}

// --- Native V2 default-mode switch (LIVE, opt-in, off on any doubt) ---
// `default_mode.ultrawork` is OmO's documented "start every conversation in
// Ultrawork" setting (config/schema/default-mode.ts). Unlike the gates above it
// does not switch a FEATURE on or off: it ACTIVATES a mode on a new root session
// by routing the ultrawork body through the keyword seam's `defaultUltrawork`
// input, which already owns the default-vs-explicit split.
//
// Its authority is LIVE for a structural reason: the install-time bake pins
// `modes.defaultUltrawork` false (the manifest must never arm the mode on its
// own), so the manifest cannot carry the user's value at all and re-reading the
// chain is the only way the documented edit works without a reinstall.
//
// Its failure direction is OFF, which is the opposite of a denylist's. An
// unconfirmed read resolves `enabled: false` and is REPORTED, so a switch the
// runtime could not read is observable and never silently arms the mode.
// "Unconfirmed" follows the PARSER's own section semantics: a refused
// `default_mode` block leaves the earlier, valid block in effect (`monitor` and
// `goal` behave the same way), so it is only reported, and only fails closed,
// when no valid `ultrawork` leaf survives anywhere in the chain.

const DEFAULT_MODE_ULTRAWORK_DECLARATION = "default_mode.ultrawork"
const DEFAULT_MODE_BLOCK_DECLARATION = "default_mode"

/**
 * The single fail-closed report for the default-mode switch. `where` names the
 * file when the failure came from an unreadable layer, and the dotted placement
 * when it came from a refused value.
 */
function defaultModeFailClosed(entry) {
  const where = typeof entry?.path === "string" ? `${entry.path}: ` : ""
  return {
    enabled: false,
    state: "error",
    diagnostics: [
      `Native V2 default mode: ${where}could not confirm ${entry?.at ?? DEFAULT_MODE_ULTRAWORK_DECLARATION} (${entry?.reason ?? "unconfirmed declaration"}); Ultrawork stays off (fail-closed)`,
    ],
  }
}

/**
 * Resolve the `defaultUltrawork` flag the keyword seam consumes, plus the
 * transitions to report.
 *
 * `true` only when a live layer declares `default_mode.ultrawork: true`. The two
 * declarations are read separately, in precedence order, because they answer
 * different questions:
 * - the LEAF says the switch itself was authored (declared, or refused);
 * - the BLOCK is only consulted when no leaf survived, and only for its failure:
 *   a block that declares just `goal` is NOT a declaration of this switch (it
 *   reads the documented `false`), while a REFUSED block (`default_mode: 7`)
 *   with no earlier valid leaf is an unconfirmed declaration that must be
 *   reported, never read as absent.
 *
 * A refused block over an earlier valid leaf resolves that leaf: the parser
 * drops the refused section, so the earlier block stays in effect, exactly like
 * `monitor`/`goal`. This reader mirrors the parser instead of inventing a
 * stricter rule.
 *
 * `declaredKeyBoolean` supplies the shared semantics: an unreadable layer and a
 * schema-refused value are `error`, never `undeclared`.
 */
export function resolveNativeDefaultUltrawork({ ...options } = {}) {
  let leaf
  let block
  try {
    const view = resolveNativePluginConfig(options)
    const readValue = () => view?.default_mode?.ultrawork
    leaf = declaredKeyBoolean(view, [DEFAULT_MODE_ULTRAWORK_DECLARATION], readValue)
    if (leaf === undefined) block = declaredKeyBoolean(view, [DEFAULT_MODE_BLOCK_DECLARATION], readValue)
  } catch (error) {
    leaf = { state: "error", reason: readFailureReason(error) }
  }
  if (leaf === undefined) {
    if (block?.state !== "error") return { enabled: false, state: "undeclared", diagnostics: [] }
    return defaultModeFailClosed(block)
  }
  if (leaf.state === "declared") return { enabled: leaf.value === true, state: "declared", diagnostics: [] }
  return defaultModeFailClosed(leaf)
}

// --- Native V2 denylist policy (LIVE vs BAKED) ---
// WHERE each `disabled_*` denylist's value comes from at RUNTIME. The manifest is
// baked at INSTALL time, so a runtime that reads only the manifest answers an
// edited `~/.omo/omo.jsonc` with the stale install-time list: removing an agent
// from `disabled_agents` could not re-enable it without a reinstall, and a newly
// disabled command kept registering from the baked copy.
//
// A LIVE list is re-resolved from the same user+project chain the generator used
// (`resolveNativePluginConfig`), so a live edit takes effect on the next setup.
//
// `disabled_mcps` is LIVE too, but with a different SCOPE rule, so it carries its
// own policy value: MCP blocking is the one deny surface where the layered chain
// has a user baseline and project hardening besides the installed default. A USER
// declaration replaces the installed list (an explicit `[]` is the only release
// path), while a PROJECT declaration may only ADD a deny. See
// `resolveLiveMcpDenyList`.
export const NATIVE_DISABLED_LIST_POLICY = Object.freeze({
  tools: "live",
  agents: "live",
  skills: "live",
  hooks: "live",
  commands: "live",
  mcps: "live-harden-only",
})

/** The declaration path that publishes each denylist's presence. */
const DISABLED_LIST_DECLARATIONS = Object.freeze({
  tools: "disabled_tools",
  agents: "disabled_agents",
  skills: "disabled_skills",
  hooks: "disabled_hooks",
  commands: "disabled_commands",
  mcps: "disabled_mcps",
})

/** Every denylist the installed manifest materializes, normalized. */
function readBakedDisabledLists(manifest) {
  const disabled = readNativeDisabled(manifest)
  return {
    tools: disabled.tools,
    agents: disabled.agents,
    skills: disabled.skills,
    hooks: disabled.hooks,
    commands: disabled.commands,
    mcps: readNativeMcpPolicy(manifest).disabled,
  }
}

/**
 * Read one list out of the resolved view. `disabled_mcps` sits beside the
 * `disabled` block (V1 parity), not inside it, so the accessor is explicit
 * instead of a string-keyed lookup that would silently miss it.
 */
function readLiveDisabledList(view, name) {
  if (name === "mcps") return view?.disabled_mcps
  return view?.disabled?.[name]
}

/**
 * Read the LIVE value of every denylist a layer declared.
 *
 * Same shape as `readLiveGatesSource`, with the same split per list:
 * - `resolved.lists` carries ONLY the lists a layer declared. A list absent from
 *   it is undeclared and the caller keeps the install-time value, so nothing is
 *   invented here.
 * - `resolved.failedClosed` names the lists the chain could have declared but
 *   could not confirm: a value the schema refused, or a resolved value that is
 *   not a string list. The caller must never release a protection on those.
 * - `error` means a LAYER of the chain could not be read, or the chain could not
 *   be resolved at all.
 *
 * `error` still carries `lists`, and that is deliberate: `loadFailures` is
 * per-FILE, so one unreadable layer does not invalidate the layers that WERE
 * read. Nothing here is authoritative in that state, because the unreadable
 * layer may have declared or overridden any of them, so the caller may only ADD
 * what was confirmed. Discarding the confirmed entries instead is what released
 * a live protection: with an installed denylist of `[]`, a readable user
 * `disabled_mcps: ["context7"]` beside a broken project layer enforced nothing.
 * A read that throws outright reports no `lists` at all.
 *
 * Values always come from the resolved view, never from the raw layer, so a live
 * list can never disagree with what a fresh install would bake from the same
 * file. Every list is reported here, including the ones the policy keeps BAKED,
 * so the policy is the ONLY thing that decides which list is enforced.
 */
export function readLiveDisabledListsSource(options = {}) {
  try {
    const view = resolveNativePluginConfig(options)
    const failure = Array.isArray(view?.loadFailures) ? view.loadFailures[0] : undefined
    const lists = {}
    const failedClosed = {}
    for (const [name, key] of Object.entries(DISABLED_LIST_DECLARATIONS)) {
      const declaration = view?.declarations?.[key]
      if (declaration === undefined || declaration.state === "undeclared") continue
      if (declaration.state === "error") {
        failedClosed[name] = "declared value was refused by the schema"
        continue
      }
      const value = readLiveDisabledList(view, name)
      if (!Array.isArray(value)) {
        failedClosed[name] = "resolved value is not a string list"
        continue
      }
      lists[name] = [...value]
    }
    if (failure !== undefined) {
      return { state: "error", path: failure.path, reason: failure.reason, lists, failedClosed, mcpScope: readMcpDisabledScope(view) }
    }
    return { state: "resolved", lists, failedClosed, mcpScope: readMcpDisabledScope(view) }
  } catch (error) {
    return { state: "error", reason: readFailureReason(error) }
  }
}

/**
 * Normalize the per-scope `disabled_mcps` record the fold published. A view from
 * an older assembly (or a caller's own object) degrades to "no scope declared
 * anything", which keeps the installed denylist.
 */
function readMcpDisabledScope(view) {
  const raw = view?.mcpDisabledScope
  const entry = (value) => ({ declared: value?.declared === true, refused: value?.refused === true })
  return { user: entry(raw?.user), project: entry(raw?.project) }
}

/**
 * Compose the LIVE `disabled_mcps` list.
 *
 * The value always comes from the resolved view (`source.lists.mcps`), so a live
 * list can never disagree with what a fresh install would bake from the same
 * file; only the scope PRESENCE comes from `source.mcpScope`.
 *
 * Scope rules, in the fail-closed direction a denylist requires:
 * - a USER declaration is the baseline. Its list replaces the installed one, and
 *   an explicit `[]` is the ONLY way a protection is released;
 * - a PROJECT declaration may only add. A project `[]` adds nothing, so it can
 *   never release the installed list, a user deny, or another layer's deny;
 * - a refused declaration leaves the user baseline UNCONFIRMED: nothing is
 *   released, the installed list is kept, and every valid deny is unioned on.
 *
 * `unconfirmed` reaches the same fail-closed state from the other direction: a
 * layer of the chain could not be read, so the user baseline is unconfirmed as
 * well. The confirmed denies are still real protections, so they are unioned
 * onto the installed list, and a `[]` release is NOT honored because the layer
 * that could not be read may have contradicted it.
 */
function resolveLiveMcpDenyList({ baked, source, diagnostics, unconfirmed }) {
  const declared = Array.isArray(source.lists?.mcps) ? source.lists.mcps : []
  const scope = source.mcpScope ?? { user: { declared: false, refused: false }, project: { declared: false, refused: false } }
  const userConfirmed = unconfirmed === undefined && scope.user.declared && !scope.user.refused
  const effective = userConfirmed ? [...declared] : mergeUniqueStrings(baked, declared)
  if (!userConfirmed) {
    if (unconfirmed !== undefined) {
      // Only worth a line of its own when a confirmed deny actually outlived the
      // failure: otherwise the installed list alone applies and the caller's
      // "kept the installed denylist" line already says so.
      if (JSON.stringify(effective) !== JSON.stringify(baked)) {
        const where = typeof unconfirmed.path === "string" ? `${unconfirmed.path}: ` : ""
        diagnostics.push(`Native V2 disabled lists: disabled_mcps kept the installed denylist plus every deny a readable layer confirmed, so [${effective.join(", ")}] apply (${where}${unconfirmed.reason ?? "unknown"}); a layer the chain could not read may not release a protection`)
      }
    } else if (scope.user.refused) {
      diagnostics.push(`Native V2 disabled lists: disabled_mcps kept the installed denylist (the user-scope declared value was refused by the schema); project declarations may only add to it`)
    } else if (scope.project.refused) {
      diagnostics.push(`Native V2 disabled lists: disabled_mcps ignored a project-scope declaration refused by the schema; the installed denylist is kept and only valid project denies apply`)
    }
  }
  if (unconfirmed === undefined && JSON.stringify(effective) !== JSON.stringify(baked)) {
    diagnostics.push(`Native V2 disabled lists: disabled_mcps is [${effective.join(", ")}] in the live config but [${baked.join(", ")}] in the installed manifest; using the live list. Reinstall to resync the manifest`)
  }
  return effective
}

/**
 * Resolve the denylists the runtime must enforce, plus the drift to report.
 *
 * A denylist is a PROTECTION, so its fail-closed direction is the OPPOSITE of a
 * boolean gate's:
 * - an unreadable chain, a refused value, or a value that is not a string list
 *   KEEPS the installed denylist. Falling back to "nothing is disabled" would
 *   release a protection the runtime could not confirm.
 * - a deny a READABLE layer confirmed is UNIONED onto that installed list. The
 *   installed list is a floor, not a ceiling: dropping a confirmed deny because
 *   an unrelated layer failed to parse released a protection with no evidence
 *   that anyone asked for it, and a `[]` release stays unconfirmed for the same
 *   reason.
 * - an UNDECLARED list keeps the install-time value, which is the backward-
 *   compatible half: an install that never edited anything behaves exactly as
 *   before.
 * - a DECLARED list REPLACES it, `[]` included, when every layer was readable.
 *   An explicit empty list is the user saying "nothing is disabled", never an
 *   absence.
 *
 * BAKED lists never read the chain, and every disagreement the runtime actually
 * applies is reported once so a silent override cannot happen.
 *
 * `disabled_mcps` is the exception that proves the rule: it is LIVE but
 * HARDEN-ONLY across scope, so its value comes from `resolveLiveMcpDenyList`
 * instead of the plain replace below.
 */
export function resolveNativeDisabledLists({ manifest, ...options } = {}) {
  const baked = readBakedDisabledLists(manifest)
  const source = readLiveDisabledListsSource({ manifest, ...options })
  const diagnostics = []
  const lists = { ...baked }
  const live = {}
  const liveNames = Object.keys(DISABLED_LIST_DECLARATIONS)
    .filter((name) => NATIVE_DISABLED_LIST_POLICY[name] !== "baked")
  if (source.state === "error") {
    // An unreadable layer invalidates AUTHORITY, never a deny another layer
    // confirmed: the installed list is a floor, so the confirmed denies are
    // unioned onto it instead of replacing it.
    if (liveNames.length > 0) {
      diagnostics.push(`Native V2 disabled lists: live config unreadable (${source.reason ?? "unknown"}); ${liveNames.map((name) => DISABLED_LIST_DECLARATIONS[name]).join(", ")} kept the installed denylist instead of dropping protections`)
    }
    for (const [name, value] of Object.entries(source.lists ?? {})) live[name] = [...value]
    for (const name of liveNames) {
      if (name === "mcps") {
        lists.mcps = resolveLiveMcpDenyList({ baked: baked.mcps, source, diagnostics, unconfirmed: { path: source.path, reason: source.reason } })
        continue
      }
      const confirmed = Array.isArray(source.lists?.[name]) ? source.lists[name] : []
      if (confirmed.length === 0) continue
      lists[name] = mergeUniqueStrings(baked[name], confirmed)
      diagnostics.push(`Native V2 disabled lists: ${DISABLED_LIST_DECLARATIONS[name]} kept the installed denylist plus the denies a readable layer confirmed ([${confirmed.join(", ")}]) even though a layer of the chain could not be read`)
    }
    return { lists: deepFreeze(lists), live: deepFreeze(live), diagnostics }
  }
  for (const [name, value] of Object.entries(source.lists ?? {})) live[name] = [...value]
  for (const name of liveNames) {
    if (name === "mcps") {
      lists.mcps = resolveLiveMcpDenyList({ baked: baked.mcps, source, diagnostics })
      continue
    }
    const failure = source.failedClosed?.[name]
    if (typeof failure === "string") {
      diagnostics.push(`Native V2 disabled lists: ${DISABLED_LIST_DECLARATIONS[name]} kept the installed denylist (${failure})`)
      continue
    }
    if (!Object.prototype.hasOwnProperty.call(source.lists ?? {}, name)) continue
    const value = source.lists[name]
    lists[name] = [...value]
    if (JSON.stringify(value) !== JSON.stringify(baked[name])) {
      diagnostics.push(`Native V2 disabled lists: ${DISABLED_LIST_DECLARATIONS[name]} is [${value.join(", ")}] in the live config but [${baked[name].join(", ")}] in the installed manifest; using the live list. Reinstall to resync the manifest`)
    }
  }
  return { lists: deepFreeze(lists), live: deepFreeze(live), diagnostics }
}

export function readNativeMcpPolicy(manifest) {
  const raw = manifest?.metadata?.global?.mcp
  const source = isPlainObject(raw) ? raw : {}
  const normalize = (value) => Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : []
  return { disabled: normalize(source.disabled), envAllowlist: normalize(source.envAllowlist) }
}

// --- Native V2 MCP env allowlist policy (user-only, fail-closed) ---
// `mcp_env_allowlist` names the env vars a tier-2 `.mcp.json` may expand. It is a
// GRANT list, so its fail-closed direction is the OPPOSITE of a denylist's: an
// unconfirmed read must grant NOTHING. A tier-2 `.mcp.json` can live in a PROJECT
// directory, so a grant set resurrected from an unconfirmed read is exactly the
// leak this allowlist exists to stop.
//
// SCOPE is a hard boundary, not a preference: the fold collects the key from
// user-scope placements only (layer root, `[opencode]`, the user's own profile),
// so a project layer can never extend it, and a project placement is not even a
// declaration.

/**
 * Read the LIVE user-scope `mcp_env_allowlist`.
 *
 * Same three states as every other live-read authority here:
 * - `declared`: a user placement authored the key and the value survived, so the
 *   live list outranks the install-time manifest. `[]` is a declaration.
 * - `undeclared`: no user placement authored it; the caller keeps the installed
 *   allowlist, which is the backward-compatible half.
 * - `error`: the chain could not be read, or the authored value was refused.
 *   The caller must grant nothing.
 */
export function readLiveMcpEnvAllowlistSource(options = {}) {
  try {
    const view = resolveNativePluginConfig(options)
    const failure = Array.isArray(view?.loadFailures) ? view.loadFailures[0] : undefined
    if (failure !== undefined) return { state: "error", path: failure.path, scope: failure.scope, reason: failure.reason }
    const declaration = view?.declarations?.mcp_env_allowlist
    if (declaration === undefined || declaration.state === "undeclared") return { state: "undeclared" }
    if (declaration.state === "error") {
      return { state: "error", at: "mcp_env_allowlist", reason: "declared value was refused by the schema" }
    }
    const values = view?.mcp_env_allowlist
    if (!Array.isArray(values)) {
      return { state: "error", at: "mcp_env_allowlist", reason: "resolved value is not a string list" }
    }
    return { state: "declared", values: [...values], sources: declaration.sources }
  } catch (error) {
    return { state: "error", reason: readFailureReason(error) }
  }
}

/**
 * Resolve the MCP env allowlist the runtime must enforce, plus the drift to
 * report. A confirmation failure grants nothing; only an ABSENT key falls back to
 * the installed value.
 */
export function resolveNativeMcpEnvAllowlist({ manifest, ...options } = {}) {
  const baked = readNativeMcpPolicy(manifest).envAllowlist
  const live = readLiveMcpEnvAllowlistSource({ manifest, ...options })
  const diagnostics = []
  if (live.state === "declared") {
    if (JSON.stringify(live.values) !== JSON.stringify(baked)) {
      diagnostics.push(`Native V2 MCP env allowlist: mcp_env_allowlist is [${live.values.join(", ")}] in the live config but [${baked.join(", ")}] in the installed manifest; using the live value. Reinstall to resync the manifest`)
    }
    return { state: live.state, allowlist: [...live.values], diagnostics }
  }
  if (live.state === "error") {
    const where = typeof live.path === "string" ? `${live.path}: ` : ""
    diagnostics.push(`Native V2 MCP env allowlist: ${where}could not confirm mcp_env_allowlist (${live.reason ?? "unknown"}); no MCP env reference may expand (fail-closed)`)
    return { state: live.state, allowlist: [], diagnostics }
  }
  return { state: live.state, allowlist: [...baked], diagnostics }
}

/**
 * Read the materialized repo root (T38) used to resolve `packages/lsp-daemon`
 * for the native builtin `lsp` MCP server. Returns undefined when absent or
 * non-string, so the caller degrades instead of guessing a path.
 */
export function readNativeRepoRoot(manifest) {
  const value = manifest?.metadata?.global?.repoRoot
  return typeof value === "string" && value.trim() ? value : undefined
}

/**
 * Read the materialized MCP retention policy (T38): the OmO builtin MCP servers
 * the profile keeps (`retained`) and the ones it disables (`builtinsDisabled`).
 * Both normalize to string arrays; an absent block yields empty arrays.
 */
// The SINGLE source of truth for the materialized `metadata.global.mcpPolicy`
// entry. BOTH agent-manifest writers (build-target-agent-manifest.mjs and
// generate-v2-agents.mjs) call this, so the policy has exactly one writer and the
// two manifests can never drift. Input is the raw `integration-manifest.json`
// `mcpPolicy` block.
export function buildMcpPolicyEntry(mcpPolicy = {}) {
  const policy = isPlainObject(mcpPolicy) ? mcpPolicy : {}
  const strings = (value) => Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : []
  const record = (value) => isPlainObject(value) ? { ...value } : {}
  return {
    retained: strings(policy.omoBuiltinsRetained),
    builtinsDisabled: strings(policy.omoBuiltinsDisabled),
    bundledLocal: strings(policy.bundledLocal),
    externalConnections: strings(policy.coreExternalConnections),
    externalEnvKeys: record(policy.externalEnvKeys),
    externalEndpoints: record(policy.externalEndpoints),
    bundledSupplyChain: record(policy.bundledSupplyChain),
  }
}

export function readNativeMcpBuiltinsPolicy(manifest) {
  const raw = manifest?.metadata?.global?.mcpPolicy
  const source = isPlainObject(raw) ? raw : {}
  const normalize = (value) => Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : []
  const externalEnvKeys = isPlainObject(source.externalEnvKeys) ? source.externalEnvKeys : {}
  return {
    retained: normalize(source.retained),
    builtinsDisabled: normalize(source.builtinsDisabled),
    // The bundled local servers (ssh) and the external connections (obsidian)
    // materialized from the integration manifest, plus the env var name each
    // external connection reads its key from. All names only, never a secret.
    bundledLocal: normalize(source.bundledLocal),
    externalConnections: normalize(source.externalConnections),
    externalEnvKeys: Object.fromEntries(
      Object.entries(externalEnvKeys).filter(([, value]) => typeof value === "string" && value.length > 0),
    ),
    externalEndpoints: Object.fromEntries(
      Object.entries(isPlainObject(source.externalEndpoints) ? source.externalEndpoints : {})
        .filter(([, value]) => typeof value === "string" && value.length > 0),
    ),
    bundledSupplyChain: isPlainObject(source.bundledSupplyChain) ? { ...source.bundledSupplyChain } : {},
  }
}

export function readNativeMaxTools(manifest) {
  const value = manifest?.metadata?.global?.maxTools
  return Number.isInteger(value) && value >= 1 ? value : undefined
}

/**
 * The V1 threshold the preemptive trigger falls back to when nothing declares
 * one. It duplicates `rigel-v2-native-preemptive-compaction.mjs`
 * `PREEMPTIVE_COMPACTION_THRESHOLD` because that module is a pure port with no
 * imports; `rigel-v2-native-config.test.mjs` pins the two copies equal so the
 * duplication cannot drift.
 */
export const NATIVE_PREEMPTIVE_COMPACTION_THRESHOLD_DEFAULT = 0.78

const PREEMPTIVE_THRESHOLD_DECLARATION = "experimental.preemptive_compaction_threshold"

function isPreemptiveThreshold(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1
}

/**
 * Read the materialized `experimental.preemptive_compaction_threshold` (T34).
 * Returns undefined when unset or out of the (0, 1] range, so the runtime keeps
 * the V1 0.78 default instead of guessing.
 */
export function readNativePreemptiveThreshold(manifest) {
  const value = manifest?.metadata?.global?.preemptiveCompactionThreshold
  return isPreemptiveThreshold(value) ? value : undefined
}

/**
 * Read the LIVE `experimental.preemptive_compaction_threshold` from the
 * user+project chain.
 *
 * Same three states as the other live-read authorities:
 * - `declared`: a layer wrote the key and the schema accepted it, so the
 *   resolved value outranks the install-time manifest.
 * - `undeclared`: no layer wrote it; the caller keeps the manifest value.
 * - `error`: the chain could not be resolved, a layer that exists could not be
 *   read/parsed, or the key was authored but refused. A threshold drives a
 *   compaction request, so an unconfirmed one is never used: the caller fails
 *   closed to the documented default instead of the stale manifest.
 */
export function readLivePreemptiveThresholdSource(options = {}) {
  try {
    const view = resolveNativePluginConfig(options)
    const failure = Array.isArray(view?.loadFailures) ? view.loadFailures[0] : undefined
    if (failure !== undefined) {
      return { state: "error", path: failure.path, scope: failure.scope, reason: failure.reason }
    }
    const declaration = view?.declarations?.[PREEMPTIVE_THRESHOLD_DECLARATION]
    if (declaration === undefined || declaration.state === "undeclared") return { state: "undeclared" }
    if (declaration.state === "error") {
      return { state: "error", at: PREEMPTIVE_THRESHOLD_DECLARATION, reason: "declared value was refused by the schema" }
    }
    const value = view?.experimental?.preemptive_compaction_threshold
    if (!isPreemptiveThreshold(value)) {
      return { state: "error", at: PREEMPTIVE_THRESHOLD_DECLARATION, reason: "declared value is not a fraction in (0, 1]" }
    }
    return { state: "declared", value, sources: declaration.sources }
  } catch (error) {
    return { state: "error", reason: readFailureReason(error) }
  }
}

/**
 * Resolve the preemptive threshold the runtime must use, plus the transitions
 * to report.
 *
 * Only a valid declaration from the live chain outranks the install-time
 * manifest. An undeclared key keeps the manifest value, so an install that baked
 * a custom threshold keeps it, and 0.78 is used only when neither source carries
 * one. A chain that could not confirm the value FAILS CLOSED to 0.78 rather than
 * to a manifest value the runtime could not verify.
 */
export function resolveNativePreemptiveThreshold({ manifest, ...options } = {}) {
  const baked = readNativePreemptiveThreshold(manifest)
  const live = readLivePreemptiveThresholdSource({ manifest, ...options })
  const diagnostics = []
  if (live.state === "declared") {
    if (baked !== undefined && baked !== live.value) {
      diagnostics.push(`Native V2 preemptive compaction: threshold is ${live.value} in the live config but ${baked} in the installed manifest; using the live value. Reinstall to resync the manifest`)
    }
    return { state: live.state, value: live.value, diagnostics }
  }
  if (live.state === "error") {
    const where = typeof live.path === "string" ? `${live.path}: ` : ""
    diagnostics.push(`Native V2 preemptive compaction: ${where}live config could not confirm the threshold (${live.reason}); using the documented ${NATIVE_PREEMPTIVE_COMPACTION_THRESHOLD_DEFAULT} default instead of the installed manifest`)
    return { state: live.state, value: NATIVE_PREEMPTIVE_COMPACTION_THRESHOLD_DEFAULT, diagnostics }
  }
  return { state: live.state, value: baked ?? NATIVE_PREEMPTIVE_COMPACTION_THRESHOLD_DEFAULT, diagnostics }
}

/**
 * Read the materialized `experimental.truncate_all_tool_outputs` (T38). Defaults
 * to false (V1 default) when absent or non-boolean.
 */
export function readNativeTruncateAllToolOutputs(manifest) {
  return manifest?.metadata?.global?.truncateAllToolOutputs === true
}

// The materialized host minimum. `integration-manifest.json` declares the
// supported platform as a range (e.g. ">=2.0.19"); the generator reduces it to
// the bare version so the runtime never parses the range itself.
const HOST_VERSION_SELECTOR = /(\d+(?:\.\d+)*)/

/**
 * Reduce a declared OpenCode platform selector to the bare minimum version the
 * generator materializes. Returns undefined for an absent or selector-free
 * value so the runtime degrades instead of blocking setup on a malformed source.
 */
export function deriveNativeMinOpenCodeVersion(integrationManifest) {
  const declared = integrationManifest?.platform?.opencode
  if (typeof declared !== "string") return undefined
  const match = HOST_VERSION_SELECTOR.exec(declared.trim())
  return match ? match[1] : undefined
}

/**
 * Read the materialized minimum host version (`metadata.global.minOpenCodeVersion`).
 * Absent or non-string yields undefined, so a manifest predating this field keeps
 * loading exactly as before.
 */
export function readNativeMinOpenCodeVersion(manifest) {
  const value = manifest?.metadata?.global?.minOpenCodeVersion
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/**
 * Read the materialized bundled OmO build version
 * (`metadata.global.bundledVersion`). The native update check compares this
 * against the published package's npm dist-tags (V1 `getBundledVersion` parity).
 * Absent or non-string yields undefined, so the check degrades to a no-op
 * instead of guessing a version, the same way V1 skipped when no version was
 * resolvable.
 */
export function readNativeBundledVersion(manifest) {
  const value = manifest?.metadata?.global?.bundledVersion
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/**
 * Port of `packages/omo-opencode/src/shared/opencode-version.ts` `compareVersions`
 * (numeric, prerelease-suffix stripped). Kept in lockstep by the parity test so
 * the runtime and the V1 CLI cannot disagree on a version boundary.
 */
export function compareNativeVersions(left, right) {
  const parse = (value) => String(value ?? "").replace(/^v/, "").split("-")[0].split(".").map((part) => parseInt(part, 10) || 0)
  const leftParts = parse(left)
  const rightParts = parse(right)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0
    const rightPart = rightParts[index] ?? 0
    if (leftPart < rightPart) return -1
    if (leftPart > rightPart) return 1
  }
  return 0
}

/**
 * Host-version gate (V1 `minimum-opencode-version.ts` parity). Reads the
 * materialized minimum from the manifest and compares it to the host identity
 * the V2 setup context exposes on `context.app.version`. Degrades silently
 * (`checked: false`) when either side is absent, so a host that does not publish
 * its version and a manifest that does not carry a minimum both stay loadable.
 */
export function checkNativeHostVersion(manifest, hostVersion) {
  const minimum = readNativeMinOpenCodeVersion(manifest)
  if (minimum === undefined) return { checked: false, ok: true }
  if (typeof hostVersion !== "string" || hostVersion.trim().length === 0) return { checked: false, ok: true }
  if (compareNativeVersions(hostVersion, minimum) >= 0) return { checked: true, ok: true, minimum }
  return {
    checked: true,
    ok: false,
    minimum,
    message: `Detected OpenCode ${hostVersion}, but this Rigel runtime requires OpenCode ${minimum}+. Update OpenCode, then reload the plugin.`,
  }
}

/**
 * Convenience predicate for a single gate. Kept separate from
 * `readNativeGates` so a caller that only needs one gate does not allocate the
 * whole record, and so the "unknown gate is off" rule lives in one place.
 */
export function isNativeGateEnabled(manifest, gate) {
  if (!GATE_KEYS.includes(gate)) return false
  return readNativeGates(manifest)[gate] === true
}

/**
 * Derive the materialized `metadata.global.gates` record from a resolved native
 * plugin config view (the inverse of `readNativeGates`). The manifest generator
 * writes exactly this shape so the runtime never parses `omo.jsonc` itself.
 *
 * `interactive_bash` has no `omo.jsonc` key: the V1 gate is pure tmux
 * availability at run time (`interactive-bash-availability.ts` `which("tmux")`).
 * Baking host availability into a portable manifest would be wrong, so this gate
 * only records that the config permits the family (it is not explicitly
 * disabled); the runtime's own tmux probe remains the availability authority.
 */
export function deriveNativeGates(view) {
  const disabledTools = Array.isArray(view?.disabled?.tools) ? view.disabled.tools : []
  // The inherited Goal is quarantined: `goal.enabled` stays present and inert in
  // `omo.jsonc`, but the generated gate is always false so the legacy surface
  // never registers. See `rigel-v2-native-goal-quarantine.mjs`.
  return quarantineNativeGates({
    monitor: view?.monitor?.enabled === true,
    goal: view?.goal?.enabled === true,
    task_system: view?.experimental?.task_system === true,
    team_mode: view?.team_mode?.enabled === true,
    interactive_bash: !disabledTools.includes("interactive_bash"),
    hashline_edit: view?.hashline_edit === true,
    // T34: V1 `experimental.preemptive_compaction`, off unless explicitly set.
    preemptive_compaction: view?.experimental?.preemptive_compaction === true,
  })
}

export { GATE_KEYS }

// The schema-backed setting catalog is published from the settings authority so
// lab staging ships it with the runtime it documents. It registers nothing,
// reads no file and changes no resolution: `/rigel_setting` consumes it in a
// later change.
export * from "./rigel-v2-native-setting-catalog.mjs"
