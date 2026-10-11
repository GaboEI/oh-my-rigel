/**
 * Pure selection logic for the native V2 agent manifest.
 *
 * Kept free of any `dist/` or plugin import so it is unit-testable without a
 * build. `generate-v2-agents.mjs` owns the plugin bake; this module owns the
 * decision of WHICH generated agents enter the manifest.
 */

/** Base agent key: lowercase, display suffix (` - ...`) stripped. */
export function canonicalAgentKey(id) {
  const raw = String(id ?? "").trim().toLocaleLowerCase()
  return raw ? raw.split(/\s+-\s+/)[0].trim() : ""
}

/**
 * Select the orchestrated agents present in the generated agent map.
 *
 * An orchestrated agent the plugin did not generate is SKIPPED and reported in
 * `missing` instead of aborting the whole manifest (finding N1): a fresh install
 * from an empty config cannot rely on an agent whose model is unresolvable
 * (e.g. `Atlas - Plan Executor`). Optional and demoted agents are kept only when
 * present; disabled agents are dropped without being reported missing.
 */
export function selectOrchestratedAgents({ allAgents = {}, selection = {}, disabledAgentKeys = new Set() } = {}) {
  const agents = allAgents && typeof allAgents === "object" ? allAgents : {}
  const required = Array.isArray(selection?.orchestratedAgentIds) && selection.orchestratedAgentIds.length > 0
    ? selection.orchestratedAgentIds
    : Object.keys(agents)
  const selected = {}
  const missing = []
  for (const id of required) {
    if (disabledAgentKeys.has(canonicalAgentKey(id))) continue
    if (!agents[id]) {
      missing.push(id)
      continue
    }
    selected[id] = agents[id]
  }
  for (const id of selection?.optionalAgentIds ?? []) {
    if (agents[id]) selected[id] = agents[id]
  }
  for (const id of selection?.demotedAgentIds ?? []) {
    if (agents[id]) selected[id] = agents[id]
  }
  return { selected, missing }
}

/**
 * The manifest `defaultAgent` must name a selected key that the runtime will
 * actually register. When the configured default was not generated, or would be
 * skipped by the runtime's eligibility/provider gates (`isEligible`), fall back
 * to the first eligible selected agent so the manifest never points at an agent
 * that `registerNativeAgents` will leave out of the roster. Returns `undefined`
 * when nothing is selected, and when no selected agent is eligible.
 *
 * `isEligible` is optional and defaults to every key being eligible, so the
 * generator can pass the statically-knowable gate (e.g. the Hephaestus model
 * check) without this module importing the gate itself.
 */
export function resolveDefaultAgent(defaultAgent, selected, isEligible) {
  const eligible = typeof isEligible === "function" ? isEligible : () => true
  if (typeof defaultAgent === "string" && selected && selected[defaultAgent] && eligible(defaultAgent)) {
    return defaultAgent
  }
  return Object.keys(selected ?? {}).find((key) => eligible(key))
}
