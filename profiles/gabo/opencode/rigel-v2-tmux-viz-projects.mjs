/**
 * Native V2 tmux visualization: PER-PROJECT registry.
 *
 * One V2 plugin instance can serve several projects while
 * `context.location.directory` is the instance's STATIC location (the runtime
 * already documents this in `resolveCallingSessionDirectory`). Resolving the
 * public gate once at setup therefore froze every project in the daemon to
 * whichever project the instance was created for: a project declaring
 * `team_mode.tmux_visualization = true` got nothing because a sibling project's
 * value — or the instance's own value — had already won.
 *
 * This registry resolves the gate, the caller pane and the pane working
 * directory PER PROJECT and creates one manager per eligible project, lazily:
 *
 * - gate off for that project      -> no manager, nothing constructed (no side
 *                                     effect, no default change);
 * - caller pane absent/ambiguous   -> the manager is created but degrades with a
 *                                     recorded reason (fail closed, no guess);
 * - project unknown/unresolvable   -> refused; the caller must pass the actual
 *                                     project, never the static instance path.
 *
 * Nothing here assumes a project, and no project's value can leak into another's.
 */

/**
 * Resolve the project directory of a `session.created` CHILD session from the
 * payload the V2 host actually emits.
 *
 * Authority: the `@opencode-ai/sdk` V2 `EventSessionCreated` type is
 * `{ type: "session.created", properties: { sessionID, info: Session } }` and
 * `Session` carries `directory` as a TOP-LEVEL field
 * (`{ id, slug, projectID, directory, parentID?, ... }`). There is no
 * `info.location.directory`: reading that invented path is what made the real
 * daemon resolve no project and silently spawn no pane while every synthetic
 * unit fixture passed. The remaining shapes are read AFTER the authoritative
 * one so a host that changes its nesting degrades loudly instead of silently.
 *
 * Returns `undefined` when nothing resolves; the caller must then fail closed
 * rather than inherit the plugin instance's static location.
 */
export function resolveChildProjectDirectory(info) {
  if (!info || typeof info !== "object") return undefined
  const candidates = [
    info.directory,
    info.location?.directory,
    info.data?.directory,
    info.data?.location?.directory,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate
  }
  return undefined
}

function firstNonEmptyString(values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

/**
 * Normalize ONE `session.created` event into `{ id, parentID, directory, title }`.
 *
 * The live OpenCode V2 daemon (observed on NLS1, 2.0.32) emits
 * `{ type: "session.created", properties: {}, data: { sessionID, projectID,
 * location, subpath, parentID?, slug, agent, model, version } }` — `properties`
 * is EMPTY and the payload is in `data`, so `properties.info` is `null` at
 * runtime even though the SDK typings describe `properties.info`. The SDK shape
 * is still preferred when present so a host that adopts it keeps working.
 *
 * Returns `undefined` when the event carries no session identity, which makes
 * the caller fail closed instead of inventing a project.
 */
export function resolveChildSessionInfo(event) {
  if (!event || typeof event !== "object") return undefined
  const info = event?.properties?.info
  if (info && typeof info === "object") {
    const id = firstNonEmptyString([info.id, event?.properties?.sessionID])
    if (!id) return undefined
    return {
      id,
      parentID: info.parentID,
      directory: resolveChildProjectDirectory(info),
      title: info.title,
    }
  }
  const data = event?.data
  if (data && typeof data === "object") {
    const id = firstNonEmptyString([data.sessionID, event?.sessionID])
    if (!id) return undefined
    return {
      id,
      parentID: data.parentID,
      directory: firstNonEmptyString([
        data.directory,
        data.location?.directory,
        data.location?.path,
        data.path,
      ]),
      title: data.title,
    }
  }
  return undefined
}


/**
 * @param {object} options
 * @param {unknown} options.manifest install-time materialized manifest
 * @param {object} options.env environment used for config resolution
 * @param {boolean} options.teamModeEnabled install-level team-mode gate
 * @param {(args: {manifest: unknown, directory: string, env: object}) => boolean} options.resolveGate
 *        resolves `team_mode.tmux_visualization` for ONE project directory
 * @param {(directory: string) => Promise<{paneId: string|null, reason: string|null}>} options.discoverPane
 *        resolves the caller pane for ONE project directory
 * @param {(args: {directory: string, discoveredPaneId: string|null, discoveryReason: string|null}) => object} options.createManager
 * @param {(directory: string) => string} [options.normalizeDirectory]
 * @param {(message: string) => void} [options.logger]
 */
export function createTmuxVizProjectRegistry({
  manifest,
  env,
  teamModeEnabled,
  resolveGate,
  discoverPane,
  createManager,
  normalizeDirectory = (directory) => directory,
  logger = console.error,
} = {}) {
  /** @type {Map<string, object>} project key -> manager */
  const managers = new Map()
  /** @type {Map<string, string>} project key -> why no manager was created */
  const refusals = new Map()

  function keyOf(projectDirectory) {
    if (typeof projectDirectory !== "string" || projectDirectory.length === 0) return null
    try {
      const normalized = normalizeDirectory(projectDirectory)
      return typeof normalized === "string" && normalized.length > 0 ? normalized : projectDirectory
    } catch {
      return projectDirectory
    }
  }

  /**
   * Resolve (and cache) the manager for ONE project. Returns `null` when the
   * project is not eligible, and never inspects or reuses another project's
   * state.
   */
  async function ensure(projectDirectory) {
    const key = keyOf(projectDirectory)
    if (key === null) return null
    if (managers.has(key)) return managers.get(key)
    if (refusals.has(key)) return null
    if (teamModeEnabled !== true) {
      refusals.set(key, "team_mode gate is off")
      return null
    }
    if (typeof resolveGate !== "function") {
      refusals.set(key, "no gate resolver")
      return null
    }
    let gate
    try {
      gate = resolveGate({ manifest, directory: key, env }) === true
    } catch (error) {
      // An unreadable chain must never enable the feature: fail closed for THIS
      // project only, leaving every other project unaffected.
      refusals.set(key, `gate resolution failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
    if (!gate) {
      refusals.set(key, "tmux_visualization is off for this project")
      return null
    }

    let discovered = { paneId: null, reason: null }
    if (typeof discoverPane === "function") {
      try {
        discovered = (await discoverPane(key)) ?? discovered
      } catch (error) {
        discovered = { paneId: null, reason: `caller pane discovery failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    }

    let manager
    try {
      manager = createManager({
        directory: key,
        discoveredPaneId: discovered?.paneId ?? null,
        discoveryReason: discovered?.reason ?? null,
      })
    } catch (error) {
      refusals.set(key, `manager construction failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
    if (!manager) {
      refusals.set(key, "manager construction returned nothing")
      return null
    }

    managers.set(key, manager)
    if (manager.enabled !== true) {
      logger(`[oh-my-rigel] tmux-viz degraded for ${key}: ${manager.degradedReason}`)
    }
    return manager
  }

  return {
    ensure,
    /** Every constructed manager, in construction order. */
    all: () => [...managers.values()],
    /** Why a project has no manager (diagnostics; never used to infer a gate). */
    refusalReason: (projectDirectory) => {
      const key = keyOf(projectDirectory)
      return key === null ? null : refusals.get(key) ?? null
    },
    get size() {
      return managers.size
    },
    async cleanup() {
      for (const manager of managers.values()) {
        await manager.cleanup?.()
      }
      managers.clear()
      refusals.clear()
    },
  }
}
