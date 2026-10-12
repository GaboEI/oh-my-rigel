/**
 * Upstream 5a9bb74a4: effective fallback-chain resolution for a native V2
 * session. An explicit user model (a category `models` chain or `model`, or an
 * agent `model`) suppresses the built-in canonical chain; only the user's
 * `fallback_models` remain. A configured `fallback_models` replaces the built-in
 * chain even when the model was not pinned, mirroring V1 `configuredFallbackChain`.
 * With no user override the built-in chain stays.
 *
 * Pure and dependency-injected so `rigel-v2-native-explicit-chain.test.mjs` can
 * pin the decision without booting the runtime.
 */

import { agentChain, categoryChain } from "./rigel-v2-native-model-chains.mjs"
import { normalizeUserChain } from "./rigel-v2-native-categories.mjs"

/** Canonical agent key: lowercase base id, display suffix (" - ...") stripped. */
export function normalizeAgentOverrideKey(agent) {
  const raw = String(agent ?? "").trim().toLocaleLowerCase()
  return raw ? raw.split(/\s+-\s+/)[0].trim() : ""
}

/** The user override for an agent, matched by canonical or raw (lowercased) id. */
export function agentOverrideFor(agentOverrides, agent) {
  const overrides = agentOverrides && typeof agentOverrides === "object" ? agentOverrides : {}
  const key = normalizeAgentOverrideKey(agent)
  if (!key) return undefined
  if (overrides[key]) return overrides[key]
  const direct = Object.keys(overrides).find((candidate) => candidate.toLocaleLowerCase() === key)
  return direct ? overrides[direct] : undefined
}

/**
 * Copy a per-agent override map into a fresh object keyed by CANONICAL agent id.
 * A live key authored as a display name (`Hephaestus - Deep Agent`) and a
 * lookup by the base id (`hephaestus`) collapse to one entry; an entry with no
 * canonical key is dropped. The FULL entry is preserved (spread), and the
 * `models`/`fallback_models` arrays are copied, so a later mutation of the
 * result can never reach the source. Pure: the input is never mutated.
 */
export function canonicalizeAgentOverrides(source) {
  const overrides = source && typeof source === "object" && !Array.isArray(source) ? source : {}
  const result = {}
  for (const [id, value] of Object.entries(overrides)) {
    const key = normalizeAgentOverrideKey(id)
    if (!key) continue
    const entry = value && typeof value === "object" && !Array.isArray(value) ? value : {}
    result[key] = {
      ...entry,
      ...(Array.isArray(entry.models) ? { models: [...entry.models] } : {}),
      ...(Array.isArray(entry.fallback_models) ? { fallback_models: [...entry.fallback_models] } : {}),
    }
  }
  return result
}

/**
 * Choose the AUTHORITATIVE per-agent override map for the current process (R1).
 *
 * The runtime model source is JSON-ONLY: `~/.omo/omo.jsonc` is the sole
 * persistent source of truth, so the manifest is NEVER consulted here. The live
 * config is authoritative-COMPLETE the moment it EXISTS and parses: its `agents`
 * block, INCLUDING an absent or empty block, REPLACES whatever was there before
 * for deciding current pins. An unreadable/unparseable live file FAILS SAFE to
 * NO overrides, so a corrupt file can never silently revive a removed pin.
 *
 * `live` is the discriminated source from `readLiveAgentOverridesSource`:
 *   - `{ state: "loaded", overrides }` -> live authoritative, canonicalized
 *   - `{ state: "absent" }`            -> no overrides
 *   - `{ state: "error" }`             -> no overrides (never revive)
 * An unknown/legacy caller (no discriminated source) yields no overrides. The
 * result is canonicalized, and no input is mutated.
 */
export function resolveAuthoritativeAgentOverrides({ live } = {}) {
  const state = live && typeof live === "object" ? live.state : undefined
  if (state === "loaded") return canonicalizeAgentOverrides(live.overrides)
  return {}
}

/** Whether a user category config pinned its own model (the explicit signal). */
export function categoryIsExplicit(userCategories, name) {
  const config = userCategories && typeof userCategories === "object" ? userCategories[name] : undefined
  return Boolean(
    (typeof config?.model === "string" && config.model.trim())
    || (Array.isArray(config?.models) && config.models.length > 0),
  )
}

/** The user `fallback_models` chain for a category, or undefined when absent. */
export function categoryFallbackChain(userCategories, name) {
  const config = userCategories && typeof userCategories === "object" ? userCategories[name] : undefined
  return normalizeUserChain(config?.fallback_models)
}

/**
 * Resolve the fallback chain a session walks.
 *
 * `descriptor` is the tracked category child (`{ name, explicit?, chain? }`)
 * when the session is a category delegation; a restored descriptor may carry
 * only `name`, so the explicit flag/chain are recomputed from `userCategories`.
 * Otherwise the session is an agent session and the agent's user override (if
 * any) decides. Returns an array (possibly empty when explicit with no
 * `fallback_models`, meaning "no fallback") or undefined when nothing applies.
 */
export function resolveEffectiveChain({ descriptor, agent, userCategories, agentOverrides } = {}) {
  if (descriptor && typeof descriptor === "object" && typeof descriptor.name === "string") {
    const name = descriptor.name
    const explicit = typeof descriptor.explicit === "boolean" ? descriptor.explicit : categoryIsExplicit(userCategories, name)
    const configured = Array.isArray(descriptor.chain) ? descriptor.chain : categoryFallbackChain(userCategories, name)
    if (configured) return configured
    return explicit ? [] : categoryChain(name)
  }
  const override = agentOverrideFor(agentOverrides, agent)
  if (override) {
    const configured = normalizeUserChain(override.fallback_models)
    if (configured) return configured
    if (typeof override.model === "string" && override.model) return []
  }
  return agentChain(agent)
}
