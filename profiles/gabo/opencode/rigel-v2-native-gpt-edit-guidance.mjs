/**
 * Native V2 port of V1 `packages/omo-opencode/src/agents/gpt-apply-patch-guard.ts`.
 *
 * V1 baked one of two file-edit guidance strings into a GPT agent's prompt at
 * build time: the `apply_patch` string when the harness edited files through
 * `apply_patch`, the generic string when it exposed a different editing tool.
 * V2 exposes the runtime model on the `context` hook (`event.model.modelID`) and
 * lets the hook mutate `event.system`, so the same choice is made per request
 * instead of per baked body.
 *
 * This module is pure: no imports, no state, no I/O. It keys the guidance on the
 * bare model name (the last `/` segment, provider-independent, mirroring
 * `extractModelName` in `rigel-v2-native-sisyphus-prompt.mjs`).
 *
 * Which editing tool the harness actually exposes is decided PER MODEL. When the
 * caller does not pass `hasApplyPatchTool: true`, `gptEditGuidanceForModel` falls
 * back to `hostExposesPatchTool(modelID)`, which mirrors the host's own per-model
 * toolset rule: for `gpt-*` ids that are neither `oss` nor `gpt-4*` the host keeps
 * `patch` and deletes `edit`/`write`; for every other id it keeps `edit`/`write`
 * and deletes `patch`.
 *
 * Consequences on OpenCode V2:
 *   - `gpt-5*` / `gpt-6*` (non-`gpt-4`, non-`oss`) -> `GPT_PATCH_ONLY_GUIDANCE`,
 *     because the host removed `edit`/`write` for exactly those ids.
 *   - `gpt-4*`, `gpt-oss*`, `codex*`, `o1`/`o3`/`o4` -> `GPT_FILE_EDIT_GUIDANCE`,
 *     because the host keeps `edit`/`write` (and removes `patch`) for them.
 *
 * The generic string is therefore NOT the universal GPT answer: naming
 * `edit`/`write` to a model whose host just deleted them was the defect this
 * module now avoids. A non-GPT id still yields `undefined` (no guidance applies).
 */

/** V1 `GPT_APPLY_PATCH_GUIDANCE`, byte-identical. */
export const GPT_APPLY_PATCH_GUIDANCE =
  "Use `apply_patch` for file edits. Keep patches small and match the surrounding lines exactly so verification passes."

/**
 * V1 `GPT_FILE_EDIT_GUIDANCE` is retained byte-identical for the models whose
 * harness still exposes `edit`/`write`, but it is NO LONGER what a GPT-family
 * model receives on OpenCode V2: the host removes `edit`/`write` for exactly
 * those models, so naming them instructed the model to use tools it does not
 * have. The V2 block for that family is `GPT_PATCH_ONLY_GUIDANCE`.
 */
export const GPT_FILE_EDIT_GUIDANCE =
  "Use whichever file-editing tool is exposed in your toolset (`apply_patch`, or `edit`/`write`). Keep each change small and match the surrounding lines exactly so it applies on the first attempt."

/**
 * Guidance for a model whose host exposes ONLY the patch tool.
 *
 * Two facts drive the wording: (1) on OpenCode V2 the GPT family gets `patch`
 * and loses `edit`/`write`, and (2) `patch` is the host's own name for the
 * apply_patch tool (`apply_patch -> patch` in the tool-name map), while the V2
 * prompt surface exposes it as `apply_patch`. Naming both is what makes the
 * instruction correct instead of aspirational.
 */
export const GPT_PATCH_ONLY_GUIDANCE =
  "Your toolset exposes only the patch-based editing tool (`apply_patch`, surfaced as `patch`); `edit` and `write` are not available for this model. Use it for every file change. Keep each patch small and match the surrounding lines exactly so verification passes on the first attempt."

/**
 * Sentinel for the injected guidance block, so a repeated context pass rebuilds
 * the block instead of accumulating it (registered alongside the roster,
 * ultrawork, update and directory-instruction markers).
 */
export const GPT_EDIT_GUIDANCE_MARKER = "<rigel-native-gpt-edit-guidance>"

/**
 * Bare, provider-independent model name: the last `/` segment, lowercased.
 * Mirrors `extractModelName` in `rigel-v2-native-sisyphus-prompt.mjs`.
 */
function bareModelName(modelID) {
  const raw = String(modelID ?? "").trim()
  if (!raw) return ""
  const slash = raw.lastIndexOf("/")
  return (slash >= 0 ? raw.slice(slash + 1) : raw).toLowerCase()
}

// Exact GPT-family rule, applied to the lowercased bare name:
//   - the substring `gpt-` (the OpenAI GPT family: `gpt-5.6-sol`,
//     `openai/gpt-4o`, `chatgpt-4o`), OR
//   - the substring `codex` (the OpenAI codex family: `gpt-5-codex`,
//     `codex-mini-latest`), OR
//   - the token `o1`, `o3`, or `o4` delimited by a non-alphanumeric character or
//     the end of the string (so `o1`, `o1-mini`, `o3-high`, `o4` match, while
//     `o2`, `go4`, and `opus` do not).
const GPT_FAMILY_PATTERN = /gpt-|codex|(?:^|[^a-z0-9])o[134](?:$|[^a-z0-9])/

/**
 * True when `modelID` names a GPT-family model. A provider-prefixed id is
 * reduced to its bare segment first; a missing or empty id is not GPT-family.
 */
export function isGptFamilyModel(modelID) {
  const bare = bareModelName(modelID)
  return bare !== "" && GPT_FAMILY_PATTERN.test(bare)
}

/**
 * File-edit guidance for the runtime model.
 *
 * Returns `GPT_APPLY_PATCH_GUIDANCE` for a GPT-family model when the harness
 * exposes an `apply_patch` tool, `GPT_FILE_EDIT_GUIDANCE` for a GPT-family model
 * without one, and `undefined` for a non-GPT model (no guidance applies).
 */
export function gptEditGuidanceForModel(modelID, { hasApplyPatchTool = false } = {}) {
  if (!isGptFamilyModel(modelID)) return undefined
  // The patch-only wording is correct whenever the harness exposes the patch
  // tool — either because the caller said so, or because the model is one the
  // host strips `edit`/`write` from (the GPT family the host recognises).
  if (hasApplyPatchTool === true || hostExposesPatchTool(modelID)) return GPT_PATCH_ONLY_GUIDANCE
  return GPT_FILE_EDIT_GUIDANCE
}

/**
 * True when the OpenCode V2 host exposes the patch-based editing tool for this
 * model, which is exactly when it removes `edit`/`write`.
 *
 * Mirrors the host's per-model toolset hook verbatim (decompiled from the
 * v2.0.32 binary), on the lowercased bare name:
 *
 *   if (id.includes("gpt-") && !id.includes("oss") && !id.includes("gpt-4")) {
 *     delete tools.edit; delete tools.write   // `patch` (apply_patch) remains
 *   } else {
 *     delete tools.patch                      // `edit`/`write` remain
 *   }
 *
 * This predicate is deliberately NOT `isGptFamilyModel`: that one is the V1
 * inclusion rule for the *guidance text*, which is broader (it also covers
 * `codex`, `o1`, `o3`, `o4` and `gpt-4*`). Using the V1 rule to decide which
 * editing tool exists is what made the injected text name tools the host had
 * just removed.
 */
export function hostExposesPatchTool(modelID) {
  const bare = bareModelName(modelID)
  if (bare === "") return false
  return bare.includes("gpt-") && !bare.includes("oss") && !bare.includes("gpt-4")
}

/**
 * Marker-wrapped guidance block for idempotent injection into `event.system`,
 * or `""` when the model is not GPT-family. The block is delimited by
 * `GPT_EDIT_GUIDANCE_MARKER` so the runtime's marker strip (which cuts from the
 * first known marker to the end) rebuilds it on a repeated pass instead of
 * appending a second copy.
 */
export function gptEditGuidanceBlock(modelID, options) {
  const guidance = gptEditGuidanceForModel(modelID, options)
  if (!guidance) return ""
  return `${GPT_EDIT_GUIDANCE_MARKER}\n${guidance}\n${GPT_EDIT_GUIDANCE_MARKER}`
}
