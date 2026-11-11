/**
 * The target-resolution half of the native V2 settings writer: WHICH FILE, and
 * WHICH LAYER inside it.
 *
 * This is a deliberate port of the native reader's own discovery in
 * `rigel-v2-native-config.mjs`, not an interpretation of it:
 *
 * - the user config is `~/.omo/omo.jsonc`, else `~/.omo/omo.json` when only that
 *   exists, else the jsonc path it will create;
 * - project configs are `<dir>/.omo/omo.jsonc` (or `.json`) collected from
 *   `directory` upward, STOPPING at `home`, with a symlinked `.omo` directory or
 *   a symlinked config file skipped exactly as the reader skips them;
 * - the active profile is `OMO_PROFILE`, then `OCX_PROFILE`, then the tail of
 *   `OPENCODE_CONFIG_DIR`, then the manifest's `metadata.profile`.
 *
 * The reader folds layers PLACEMENT-MAJOR: every layer contributes root, then
 * `[opencode]`, then `profiles.<P>`, then `profiles.<P>.[opencode]`. Within one
 * placement the nearest project layer wins. So the writer's default target -
 * the USER config at `profiles.<active>.[opencode]` - is the highest-precedence
 * placement, and a project layer declaring the same path is the ONLY thing that
 * can shadow it. That case is refused as AMBIGUOUS_LAYER instead of writing a
 * value the runtime will never see.
 */
import path from "node:path"
import { EMPTY_JSONC_DOCUMENT, isPlainObject } from "./rigel-v2-native-jsonc-parse.mjs"
import { isSymlinkPath, readJsoncFile } from "./rigel-v2-native-jsonc-write.mjs"
import { readJsoncValue } from "./rigel-v2-native-jsonc-edit.mjs"
import { SETTING_WRITE_ERRORS, SettingWriteError } from "./rigel-v2-native-setting-errors.mjs"

const MAX_PROJECT_CONFIG_DIRECTORY_DEPTH = 256
const HARNESS_BLOCK = "[opencode]"
const REPLACED_SECTION_ROOTS = new Set(["monitor", "goal", "experimental", "team_mode", "default_mode"])

function isLoadableConfigFile(file, fileSystem) {
  return fileSystem.existsSync(file) && !isSymlinkPath(file, fileSystem)
}

function realpathOrSelf(target, fileSystem) {
  if (typeof fileSystem.realpathSync !== "function") return target
  try {
    return fileSystem.realpathSync(target)
  } catch {
    return target
  }
}

function detectProjectConfigPath(dir, fileSystem) {
  const omoDir = path.join(dir, ".omo")
  if (isSymlinkPath(omoDir, fileSystem)) return null
  const jsoncPath = path.join(omoDir, "omo.jsonc")
  if (isLoadableConfigFile(jsoncPath, fileSystem)) return jsoncPath
  const jsonPath = path.join(omoDir, "omo.json")
  return isLoadableConfigFile(jsonPath, fileSystem) ? jsonPath : null
}

function detectUserConfigPath(home, fileSystem) {
  const jsoncPath = path.join(home, ".omo", "omo.jsonc")
  if (fileSystem.existsSync(jsoncPath)) return jsoncPath
  const jsonPath = path.join(home, ".omo", "omo.json")
  return fileSystem.existsSync(jsonPath) ? jsonPath : jsoncPath
}

function findProjectConfigPathsFarthestFirst({ directory, home, accountHome, fileSystem }) {
  const boundaries = [...new Set([path.resolve(home), path.resolve(accountHome ?? home)])]
  const realBoundaries = new Set(boundaries.map((entry) => realpathOrSelf(entry, fileSystem)))
  const nearestFirst = []
  let current = path.resolve(directory)
  for (let depth = 0; depth < MAX_PROJECT_CONFIG_DIRECTORY_DEPTH; depth += 1) {
    const isBoundary = boundaries.includes(current) || realBoundaries.has(realpathOrSelf(current, fileSystem))
    const configPath = isBoundary ? null : detectProjectConfigPath(current, fileSystem)
    if (configPath !== null) nearestFirst.push(configPath)
    if (isBoundary) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return nearestFirst.reverse()
}

/** Port of the reader's profile resolution. */
export function resolveActiveProfile({ env, manifest } = {}) {
  const direct = env?.OMO_PROFILE || env?.OCX_PROFILE
  if (typeof direct === "string" && direct.length > 0) return direct
  const opencodeConfigDir = env?.OPENCODE_CONFIG_DIR
  const match = typeof opencodeConfigDir === "string"
    ? /(?:^|[\\/])profiles[\\/]([^\\/]+)[\\/]*$/.exec(opencodeConfigDir)
    : null
  if (typeof match?.[1] === "string" && match[1].length > 0) return match[1]
  const fromManifest = manifest?.metadata?.profile
  return typeof fromManifest === "string" && fromManifest.length > 0 ? fromManifest : undefined
}

function resolveHome({ env, home } = {}) {
  const candidate = typeof home === "string" && home !== "" ? home : env?.HOME ?? env?.USERPROFILE
  if (typeof candidate !== "string" || candidate === "") {
    throw new SettingWriteError(SETTING_WRITE_ERRORS.MISSING_HOME, "a settings write requires an explicit home directory")
  }
  return path.resolve(candidate)
}

function resolveDirectory({ directory } = {}) {
  if (typeof directory !== "string" || directory === "") {
    throw new SettingWriteError(SETTING_WRITE_ERRORS.MISSING_DIRECTORY, "a settings write requires an explicit project directory")
  }
  return path.resolve(directory)
}

/**
 * The layer paths the native reader would load, in the reader's order (user
 * first, then projects farthest-first), together with the active profile.
 * `home` is a parameter, never `os.homedir()`, so a caller cannot inherit the
 * real machine by accident.
 */
export function resolveSettingPaths({ env, home, directory, accountHome, manifest, fileSystem } = {}) {
  if (fileSystem === undefined) {
    throw new SettingWriteError(SETTING_WRITE_ERRORS.MISSING_FILE_SYSTEM, "a settings write requires an injected file system")
  }
  const resolvedHome = resolveHome({ env, home })
  const resolvedDirectory = resolveDirectory({ directory })
  const userPath = detectUserConfigPath(resolvedHome, fileSystem)
  const projectPaths = findProjectConfigPathsFarthestFirst({ directory: resolvedDirectory, home: resolvedHome, accountHome, fileSystem })
  return {
    home: resolvedHome,
    directory: resolvedDirectory,
    profileName: resolveActiveProfile({ env, manifest }),
    userPath,
    projectPaths,
    layers: [{ path: userPath, scope: "user" }, ...projectPaths.map((entry) => ({ path: entry, scope: "project" }))],
  }
}

/** The placement the writer targets: the reader's highest-precedence placement. */
export function settingPlacement(profileName) {
  return profileName === undefined ? [HARNESS_BLOCK] : ["profiles", profileName, HARNESS_BLOCK]
}

/**
 * Choose the write target, or refuse. A project layer that declares the same
 * path outranks the user placement, so the write would be shadowed; an
 * unreadable project layer makes the absence of such a declaration unprovable.
 * Both cases are refusals, never silent writes.
 *
 * `placement` is an explicit override of the reader's harness placement, used
 * by `/rigel_setting` for a key that lives at the layer ROOT (`profiles.<P>`),
 * or at the document root when no profile is active, instead of inside
 * `[opencode]`. An omitted or non-array value keeps the reader's own placement,
 * so every existing caller is unaffected.
 */
export function chooseSettingWriteTarget({ layers, profileName, settingPath, placement: requestedPlacement } = {}) {
  const placement = Array.isArray(requestedPlacement) ? [...requestedPlacement] : settingPlacement(profileName)
  const fullPath = [...placement, ...settingPath]
  const sectionPath = settingPath.length > 1 && REPLACED_SECTION_ROOTS.has(settingPath[0])
    ? [...placement, settingPath[0]]
    : undefined
  const conflicts = []
  for (const layer of layers) {
    if (layer.scope !== "project") continue
    if (!layer.ok) {
      throw new SettingWriteError(
        SETTING_WRITE_ERRORS.PROJECT_LAYER_UNREADABLE,
        `cannot rule out a shadowing declaration in ${layer.path}`,
        { path: layer.path, reason: layer.reason },
      )
    }
    const leafDeclared = readJsoncValue(layer.text, fullPath).found === true
    const sectionDeclared = sectionPath !== undefined && readJsoncValue(layer.text, sectionPath).found === true
    if (leafDeclared || sectionDeclared) conflicts.push(layer.path)
  }
  if (conflicts.length > 0) {
    throw new SettingWriteError(
      SETTING_WRITE_ERRORS.AMBIGUOUS_LAYER,
      `the setting or its replacement section is declared by a nearer project layer: ${conflicts.join(", ")}`,
      { placement, settingPath, conflicts },
    )
  }
  const userLayer = layers[0]
  if (userLayer === undefined || userLayer.scope !== "user") {
    throw new SettingWriteError(SETTING_WRITE_ERRORS.MISSING_HOME, "the user config layer could not be resolved")
  }
  return { path: userLayer.path, scope: "user", placement, fullPath, target: userLayer }
}

/**
 * Refuse a placement the target document cannot hold. Replacing a non-object
 * `profiles` (or `profiles.<P>`) with an object would destroy authored data, so
 * an unexpected shape is a refusal.
 */
export function assertPlacementShape(value, placement) {
  let cursor = value
  for (const segment of placement) {
    if (!isPlainObject(cursor)) {
      throw new SettingWriteError(SETTING_WRITE_ERRORS.TARGET_SHAPE_CONFLICT, `${placement.join(".")} is not an object in the target config`, { placement })
    }
    if (!Object.hasOwn(cursor, segment)) return
    cursor = cursor[segment]
  }
}

function readTargetLayer({ fileSystem, filePath }) {
  const read = readJsoncFile({ fileSystem, filePath })
  if (read.exists && !read.ok) {
    throw new SettingWriteError(
      SETTING_WRITE_ERRORS.TARGET_UNPARSEABLE,
      `the target config could not be parsed: ${read.reason}`,
      { path: filePath, reason: read.reason, offset: read.offset },
    )
  }
  return read
}

/**
 * Resolve everything the read half of a write needs: the active profile, the
 * write target, the current bytes of that target, and the text an edit starts
 * from (an empty document when the file does not exist yet).
 */
export function resolveSettingTarget({ env, home, directory, accountHome, manifest, fileSystem, settingPath, placement } = {}) {
  if (fileSystem === undefined) {
    throw new SettingWriteError(SETTING_WRITE_ERRORS.MISSING_FILE_SYSTEM, "a settings write requires an injected file system")
  }
  const paths = resolveSettingPaths({ env, home, directory, accountHome, manifest, fileSystem })
  const layers = paths.layers.map((layer) => ({ ...layer, ...readJsoncFile({ fileSystem, filePath: layer.path }) }))
  const target = chooseSettingWriteTarget({ layers, profileName: paths.profileName, settingPath, placement })
  const read = readTargetLayer({ fileSystem, filePath: target.path })
  return { profileName: paths.profileName, layers, target, read, baseText: read.exists ? read.text : EMPTY_JSONC_DOCUMENT }
}
