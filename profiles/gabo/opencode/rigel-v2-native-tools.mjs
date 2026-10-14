/**
 * Native OpenCode V2 tool aggregator for Oh My Rigel.
 *
 * F2 (`task-14-17-fase3-herramientas.md`) owns this module: it scans
 * `profiles/gabo/opencode/tools/*.tools.mjs` in sorted order, imports each
 * family, and merges the returned tool records into one map. A family is
 * included only when its gate is enabled, so a disabled feature contributes no
 * tool name to the editor.
 *
 * Task 15 registers three families through this aggregator:
 *   - `session.tools.mjs`  (always on)
 *   - `look-at.tools.mjs`  (always on; the multimodal-looker agent gate is a
 *     separate concern owned by the agent manifest)
 *   - `monitor.tools.mjs`  (gated on `gates.monitor`)
 *
 * The aggregator is deliberately explicit rather than a dynamic `readdir`
 * import: a static import list is auditable, works under Bun's bundler, and
 * cannot silently pick up a stray file. F2 may replace the list with a scan;
 * the merge contract stays the same.
 */

import { createSessionTools } from "./tools/session.tools.mjs"
import { createLookAtTool } from "./tools/look-at.tools.mjs"
import { createMonitorTools } from "./tools/monitor.tools.mjs"
import { createMonitorRegistry } from "./tools/monitor-engine.mjs"
import { createPersistentTerminalPort } from "./tools/terminal-driver.mjs"
import { readNativeGates } from "./rigel-v2-native-config.mjs"

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/**
 * Build every enabled native tool family.
 *
 * @param {object} input
 * @param {object[]} input.clients   ordered V2 client candidates
 * @param {object}   input.location  V2 location
 * @param {object}   input.manifest  materialized agent manifest (gate source)
 * @param {object}   input.context   V2 setup context (storage/event/session domains)
 * @param {object}   input.pluginConfig  profile config block (monitor settings)
 * @param {object}   [input.serverApi]   injected HTTP server API (createServerApi)
 * @param {Function} [input.resolveLookAtModel]  resolves the look_at child's start
 *   model through the same JSON-only resolver the delegation path uses
 * @returns {{ tools: Record<string, object>, registry: object|undefined, unavailable: object[] }}
 */
export function createNativeToolFamilies({ clients, location, manifest, context, pluginConfig, readTodos, serverApi, resolveLookAtModel }) {
  const gates = readNativeGates(manifest)
  const tools = {}

  // `serverApi` is consumed by the session family (the enumeration fallback when
  // the setup-context client cannot list sessions) and by the monitor family.
  Object.assign(tools, createSessionTools({ clients, directory: location?.directory, readTodos, serverApi }))
  tools.look_at = createLookAtTool({ clients, location, resolveModel: resolveLookAtModel })

  let registry
  const unavailable = []
  if (gates.monitor) {
    // A monitor is a session-scoped persistent terminal served by the HTTP API;
    // the V2 setup context exposes no persistent-pty domain. Availability hinges
    // on the resolved server API being fully usable (a loopback origin from the
    // V2 host, the environment, or this process's serve argv, plus the server
    // credential). A resolved-but-unauthenticated origin is not enough.
    if (serverApi?.available) {
      // The resolved monitor block (enabled + allowed_commands) is materialized
      // in the manifest because the V2 setup context does not carry the OmO
      // `[opencode].monitor` block; the manifest is the honest source. Fall back
      // to the plugin config only for a caller that supplies no manifest block
      // (fixtures).
      const monitorConfig = isPlainObject(manifest?.metadata?.global?.monitor)
        ? manifest.metadata.global.monitor
        : isPlainObject(pluginConfig?.monitor) ? pluginConfig.monitor : {}
      const terminalFactory = (sessionID) => createPersistentTerminalPort({ serverApi, sessionID })
      registry = createMonitorRegistry({
        storage: context?.storage,
        terminalFactory,
        event: context?.event,
        sessions: context?.session,
        config: monitorConfig,
      })
      Object.assign(tools, createMonitorTools({ registry, pluginConfig: { ...(pluginConfig ?? {}), monitor: monitorConfig } }))
    } else {
      unavailable.push({
        family: "monitor",
        reason: "OpenCode V2 server API unavailable: a loopback server origin and OPENCODE_PASSWORD or OPENCODE_SERVER_PASSWORD are required for persistent terminals",
      })
    }
  }

  return { tools, registry, unavailable }
}

export { readNativeGates }
