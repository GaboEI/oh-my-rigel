/**
 * Native V2 category resolution for Oh My Rigel.
 *
 * Category definitions are a frozen data export of the matching OmO revision.
 * This module deliberately does not import the V1 delegate-task runtime: it
 * resolves the currently available V2 models and produces a V2 ModelRef.
 *
 * The canonical fallback chain (ported in `rigel-v2-native-model-chains.mjs`)
 * is the source of truth for which model a category runs on. The manifest still
 * owns the description/guidance/prompt text and the primary lane used as a
 * fallback when a chain is somehow absent.
 */
import manifest from "./rigel-v2-category-manifest.mjs"
import { categoryChain, resolveFallbackModel } from "./rigel-v2-native-model-chains.mjs"

function dataOf(response) {
  return Array.isArray(response) ? response : (response?.data ?? [])
}

function modelKey(model) {
  if (!model || typeof model !== "object") return undefined
  const providerID = model.providerID ?? model.provider
  const id = model.id ?? model.modelID
  return typeof providerID === "string" && typeof id === "string" ? `${providerID}/${id}` : undefined
}

function parseModel(value) {
  if (typeof value !== "string") return undefined
  const match = /^([^/]+)\/(.+?)(?:\(([^)]+)\))?$/.exec(value.trim())
  if (!match) return undefined
  return { providerID: match[1], id: match[2], ...(match[3] ? { variant: match[3] } : {}) }
}

function comparable(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")
}

function findAvailable(configured, available) {
  const exact = available.find((row) => modelKey(row) === `${configured.providerID}/${configured.id}`)
  if (exact) return exact
  // Providers sometimes publish a harmless suffix/punctuation variant.  We
  // only accept a match inside the same provider, never cross-route a model.
  return available.find((row) => {
    const key = modelKey(row)
    if (!key) return false
    const parsed = parseModel(key)
    return parsed?.providerID === configured.providerID && comparable(parsed.id) === comparable(configured.id)
  })
}

export async function listV2Models(client, location) {
  const api = client?.v2?.model ?? client?.model
  if (typeof api?.list !== "function") {
    throw new Error("OpenCode V2 model.list is unavailable")
  }
  const result = await api.list({ location })
  return dataOf(result).filter((row) => modelKey(row) !== undefined && row.enabled !== false)
}

/**
 * Resolve the V2 model inventory from the first client that can answer it.
 * Setup and tool-execution clients expose different endpoint subsets, so a
 * total miss is a real error the caller decides how to surface.
 */
export async function listV2ModelsFromClients(clients, location) {
  const diagnostics = []
  for (const client of (Array.isArray(clients) ? clients : []).filter(Boolean)) {
    try {
      return await listV2Models(client, location)
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error))
    }
  }
  throw new Error(`OpenCode V2 model inventory is unavailable: ${diagnostics.join("; ")}`)
}

export async function resolveCategoryFromClients(clients, location, categoryName, options = {}) {
  const diagnostics = []
  for (const client of clients.filter(Boolean)) {
    try {
      return await resolveCategory(client, location, categoryName, options)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A semantic category error must not be hidden by probing another
      // client. Only endpoint-shape failures justify trying the next client.
      if (!/model\.list is unavailable/i.test(message)) throw error
      diagnostics.push(message)
    }
  }
  throw new Error(`OpenCode V2 category model inventory is unavailable: ${diagnostics.join("; ")}`)
}

/**
 * Merge the built-in category set with the user's `pluginConfig.categories`,
 * mirroring V1 `mergeCategories` (`packages/omo-opencode/src/shared/merge-categories.ts`):
 * a user entry overrides the built-in of the same name, a user-only entry is
 * added, and a `disable: true` entry is dropped from the enabled set. The
 * built-in manifest stays the source of the description/guidance/prompt text
 * and the primary lane; a user entry may override any of those fields.
 */
export function mergeCategories(userCategories) {
  const merged = userCategories && typeof userCategories === "object" && !Array.isArray(userCategories)
    ? { ...manifest.categories, ...userCategories }
    : { ...manifest.categories }
  return Object.fromEntries(
    Object.entries(merged).filter(([, config]) => !config?.disable),
  )
}

export function availableCategoryNames(userCategories) {
  return Object.keys(mergeCategories(userCategories)).sort()
}

function manifestLane(config, available) {
  const configured = parseModel(config.model)
  if (!configured) return undefined
  const row = findAvailable(configured, available)
  if (!row) return undefined
  const selected = parseModel(modelKey(row))
  return selected ? { ...selected, ...(config.variant ? { variant: config.variant } : {}) } : undefined
}

export async function resolveCategory(client, location, categoryName, options = {}) {
  const name = String(categoryName ?? "").trim()
  const userCategories = options?.userCategories
  const enabled = mergeCategories(userCategories)
  const config = enabled[name]
  if (!config) {
    // V1-equivalent tolerant resolution error: name the requested category and
    // the full enabled set (built-ins plus user categories) instead of an
    // opaque failure, so the caller can correct the request.
    throw new Error(`Unknown category: "${name}". Available: ${Object.keys(enabled).sort().join(", ")}`)
  }
  const available = await listV2Models(client, location)
  const userConfig = userCategories && typeof userCategories === "object" ? userCategories[name] : undefined
  // Upstream 5a9bb74a4: an EXPLICIT user model suppresses the built-in canonical
  // chain entirely. A user `models` chain or a single `model` is the only
  // selection; when there is none, the built-in chain stays the source of truth.
  // `fallback_models` is the user's retry chain and replaces the built-in chain
  // whether or not the model was pinned (V1 `configuredFallbackChain`).
  const userChain = Array.isArray(userConfig?.models) && userConfig.models.length > 0
    ? userConfig.models.map((entry) => normalizeUserChainEntry(entry)).filter(Boolean)
    : undefined
  const fallbackChain = normalizeUserChain(userConfig?.fallback_models)
  const explicitModel = typeof userConfig?.model === "string" && userConfig.model.trim()
    ? userConfig.model.trim()
    : undefined
  const explicit = Boolean(explicitModel || (userChain && userChain.length > 0))
  let selected
  if (explicit) {
    // The user's own model(s) are the ONLY selection; the built-in chain is never
    // consulted. A reachable `models` chain wins over a single `model`.
    selected = userChain && userChain.length > 0
      ? resolveFallbackModel({ chain: userChain, availableModels: available })
      : manifestLane({ model: explicitModel, variant: userConfig?.variant }, available)
    if (!selected) {
      const requested = userChain?.map((entry) => entry.model).filter(Boolean).join(", ") || explicitModel
      throw new Error(`Category "${name}" was pinned to the user model(s) (${requested}), none of which is available in this OpenCode V2 location. Available models: ${available.map(modelKey).filter(Boolean).sort().join(", ")}`)
    }
  } else {
    // First reachable rung of the canonical chain, provider-scoped per rung.
    // `sameProviderAs` is intentionally omitted: category resolution runs before
    // V2 selects the provider, so choosing a rung on another provider is
    // legitimate here and is not the post-selection misroute the HTTP hook
    // guards against. A category with no canonical chain falls back to its
    // manifest lane.
    const chain = categoryChain(name)
    selected = Array.isArray(chain) && chain.length > 0
      ? resolveFallbackModel({ chain, availableModels: available })
      : manifestLane(config, available)
    if (!selected) {
      const visible = available.map(modelKey).filter(Boolean).sort()
      const required = Array.isArray(chain) && chain.length > 0
        ? chain.map((entry) => entry.model).join(", ")
        : config.model
      throw new Error(`Category "${name}" requires one of its canonical fallback models (${required}), none of which is available in this OpenCode V2 location. Available models: ${visible.join(", ")}`)
    }
  }
  return {
    name,
    description: userConfig?.description ?? manifest.descriptions[name],
    callerGuidance: userConfig?.caller_guidance ?? manifest.guidance[name],
    promptAppend: userConfig?.prompt_append ?? manifest.prompts[name] ?? "",
    model: selected,
    configuredModel: config.model,
    explicit,
    fallbackChain,
  }
}

/**
 * Normalize one user category chain entry into the `{ providers, model, variant }`
 * shape `resolveFallbackModel` walks. A bare string is `provider/model` (or a
 * bare id); an object may carry `model`, `variant`, and `providers`.
 *
 * Both forms name a provider the same way: a `model` string containing "/" is
 * parsed with `parseModel`, so `{ model: "anthropic/claude-opus-5-5" }` yields
 * providers `["anthropic"]` and model `"claude-opus-5-5"`. An explicit
 * `providers` array / `providerID` on the object overrides the prefix. A model
 * without "/" keeps its id verbatim, and an entry that names no provider at all
 * stays provider-less so the resolver matches the id on any provider, which is
 * the V1 user-chain behaviour.
 */
export function normalizeUserChainEntry(entry) {
  if (typeof entry === "string") {
    const parsed = parseModel(entry)
    return parsed ? { providers: parsed.providerID ? [parsed.providerID] : [], model: parsed.id, ...(parsed.variant ? { variant: parsed.variant } : {}) } : undefined
  }
  if (!entry || typeof entry !== "object") return undefined
  const raw = typeof entry.model === "string" ? entry.model : undefined
  if (!raw) return undefined
  const parsed = parseModel(raw)
  const declaredProviders = Array.isArray(entry.providers)
    ? entry.providers.filter((providerID) => typeof providerID === "string" && providerID)
    : (typeof entry.providerID === "string" && entry.providerID ? [entry.providerID] : [])
  const providers = declaredProviders.length > 0
    ? declaredProviders
    : (parsed?.providerID ? [parsed.providerID] : [])
  const variant = typeof entry.variant === "string" && entry.variant ? entry.variant : parsed?.variant
  return { providers, model: parsed?.id ?? raw, ...(variant ? { variant } : {}) }
}

/**
 * Normalize a user `fallback_models` list into the `{ providers, model, variant }`
 * chain `resolveFallbackModel` walks, or `undefined` when the list is absent or
 * empty. Reuses the same entry shape as the category `models` chain.
 */
export function normalizeUserChain(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return undefined
  const chain = entries.map((entry) => normalizeUserChainEntry(entry)).filter(Boolean)
  return chain.length > 0 ? chain : undefined
}

export function categoryTaskPrompt(prompt, category) {
  const appendix = category.promptAppend ? `\n\n${category.promptAppend}` : ""
  return `${prompt}${appendix}`
}
