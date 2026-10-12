/**
 * Effective fallback-chain resolution for a native V2 session. The runtime
 * model source is JSON-ONLY: `~/.omo/omo.jsonc` is the sole runtime source.
 *
 * Categories keep the canonical chain (a category is not a named agent and its
 * chain is unchanged by this contract). An AGENT's effective chain comes ONLY
 * from the user's JSON override, in the order the user wrote it:
 *   - a user `fallback_models` chain -> exactly those rungs;
 *   - a user `model` with no `fallback_models` -> `[]` ("no fallback");
 *   - NO entry, or an entry with no model and no `fallback_models` -> `[]`, so
 *     the session inherits the OpenCode global. The built-in canonical
 *     `agentChain` is NEVER consulted at runtime; it is seed data for a clean
 *     install only.
 *
 * The START-model contract (delegation) is stricter than the retry-chain one: an
 * agent inherits the OpenCode global ONLY when its entry is absent or
 * deliberately empty (no `model`/`models`/`fallback_models` at all). A
 * configured but unreachable chain is NEVER silently downgraded to the global:
 * the child keeps the configured head and fails AS CONFIGURED.
 *
 * Pure and dependency-injected so `rigel-v2-native-explicit-chain.test.mjs` can
 * pin the decision without booting the runtime.
 */

import { categoryChain, parseModel, resolveFallbackModel } from "./rigel-v2-native-model-chains.mjs"
import { normalizeUserChain, normalizeUserChainEntry } from "./rigel-v2-native-categories.mjs"

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
 * Otherwise the session is an agent session and the agent's JSON override (if
 * any) decides. Always returns an array; an agent with no usable JSON chain
 * returns `[]` (inherit the OpenCode global), never the built-in chain.
 */
export function resolveEffectiveChain({ descriptor, agent, userCategories, agentOverrides } = {}) {
  if (descriptor && typeof descriptor === "object" && typeof descriptor.name === "string") {
    const name = descriptor.name
    const explicit = typeof descriptor.explicit === "boolean" ? descriptor.explicit : categoryIsExplicit(userCategories, name)
    const configured = Array.isArray(descriptor.chain) ? descriptor.chain : categoryFallbackChain(userCategories, name)
    if (configured) return configured
    return explicit ? [] : categoryChain(name)
  }
  // JSON-only: the effective agent chain is exactly what the user wrote. No
  // entry, or an entry without a model/fallback_models, yields `[]` so the
  // session inherits the global. The canonical `agentChain` is never consulted.
  const override = agentOverrideFor(agentOverrides, agent)
  if (override) {
    const configured = normalizeUserChain(override.fallback_models)
    if (configured) return configured
  }
  return []
}

/**
 * Normalize ONE declared rung into `{ providers, model, variant? }`. A STRING is
 * parsed leniently so a provider-less (bare-id) pin still yields a rung; an
 * object reuses the category entry shape. Returns `undefined` only for a value
 * with no model id at all.
 */
function declaredRung(value) {
  if (typeof value !== "string") return normalizeUserChainEntry(value)
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = parseModel(trimmed)
  if (!parsed) return undefined
  return {
    providers: parsed.providerID ? [parsed.providerID] : [],
    model: parsed.id,
    ...(parsed.variant ? { variant: parsed.variant } : {}),
  }
}

/**
 * Build the ORDERED candidate rungs an explicit agent JSON override declares:
 * the head (`model`, or `models[0]` when `model` is absent) carrying its
 * `variant`, then any remaining `models`, then the user `fallback_models`, in
 * the order written.
 *
 * A rung is kept even when it resolves to no provider (a bare-id pin), so an
 * explicit entry ALWAYS yields a configured head. Returns `[]` ONLY for an
 * absent entry or one that declares no model source at all (`model`, `models`,
 * `fallback_models`); such an entry inherits the OpenCode global. Pure; it never
 * consults the manifest or the built-in canonical chain.
 */
export function agentOverrideChain(override) {
  const entry = override && typeof override === "object" && !Array.isArray(override) ? override : undefined
  if (!entry) return []
  const variant = typeof entry.variant === "string" && entry.variant ? entry.variant : undefined
  const hasModel = Boolean(typeof entry.model === "string" && entry.model.trim())
  const headSource = hasModel
    ? entry.model.trim()
    : (Array.isArray(entry.models) && entry.models.length > 0 ? entry.models[0] : undefined)
  const chain = []
  const head = declaredRung(headSource)
  if (head) {
    chain.push({ ...head, ...(variant ? { variant } : {}) })
    if (!hasModel && Array.isArray(entry.models)) {
      for (const extra of entry.models.slice(1)) {
        const rung = declaredRung(extra)
        if (rung) chain.push(rung)
      }
    }
  }
  if (Array.isArray(entry.fallback_models)) {
    for (const extra of entry.fallback_models) {
      const rung = declaredRung(extra)
      if (rung) chain.push(rung)
    }
  }
  return chain
}

/**
 * The model a delegated child must START on, resolved ONLY from the agent's JSON
 * ordered chain (`agents.<id>.model`/`.models` plus `.fallback_models`) against
 * the live inventory. The first reachable rung wins. The manifest is NEVER
 * consulted here.
 *
 * Returns `undefined` (inherit the OpenCode global) ONLY when the entry is
 * absent or deliberately empty (no `model`, `models`, or `fallback_models`).
 *
 * A NON-empty configured chain is NEVER silently downgraded to the global: when
 * no rung is reachable on the live inventory, the configured head is preserved
 * verbatim, so the child is created on what the user configured and fails AS
 * CONFIGURED instead of running on the global. The same holds when the inventory
 * cannot be read (not an array), mirroring the setup-time "never fail closed"
 * rule.
 */
export function resolveAgentDelegationModel(override, availableModels) {
  const chain = agentOverrideChain(override)
  if (chain.length === 0) return undefined
  const head = chain[0]
  const headRef = {
    ...(Array.isArray(head.providers) && head.providers.length > 0 ? { providerID: head.providers[0] } : {}),
    id: head.model,
    ...(head.variant ? { variant: head.variant } : {}),
  }
  if (!Array.isArray(availableModels)) return headRef
  return resolveFallbackModel({ chain, availableModels }) ?? headRef
}
