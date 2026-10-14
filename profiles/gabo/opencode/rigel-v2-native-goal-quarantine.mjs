/**
 * Single authority for the hard quarantine of the inherited (legacy) Goal.
 *
 * The inherited Goal is replaced by the vendored community engine. This module
 * owns the one switch that neutralizes the legacy surface in BOTH directions:
 *
 *   - the generator side applies {@link quarantineNativeGates} to the record
 *     `deriveNativeGates` bakes into the materialized manifest, and
 *   - the runtime side applies it to the record `readNativeGates` returns, so an
 *     already-materialized or hand-edited manifest (`metadata.global.gates.goal`
 *     forced to `true`) is neutralized too.
 *
 * The generator additionally strips the legacy `goal_*` tool permission so a
 * stale V1 default can never re-grant the quarantined family. No legacy file is
 * deleted: the code stays physical while exposing zero registered or effective
 * surface. `goal.enabled` in `omo.jsonc` stays present and inert.
 */

/**
 * The single quarantine switch. While true the legacy Goal cannot be enabled by
 * configuration or by a manifest, in the generator or at runtime. Flipping it to
 * false is the positive-control lever the tests use to prove the surface would
 * otherwise appear; production never flips it.
 */
export const LEGACY_GOAL_QUARANTINED = true

/** The legacy Goal tool-permission family (the `goal_*` key, plus a bare `goal`). */
export const LEGACY_GOAL_TOOL_PREFIX = "goal_"

/**
 * Force the `goal` gate to `false` on a gates record. Pure and total: the input
 * is never mutated, no other gate is touched, and every other key is preserved
 * as-is. When `quarantined` is false the record is returned with `goal` coerced
 * to a strict boolean, which is the positive-control path only.
 */
export function quarantineNativeGates(gates, { quarantined = LEGACY_GOAL_QUARANTINED } = {}) {
  const source = gates !== null && typeof gates === "object" ? gates : {}
  const next = { ...source }
  next.goal = quarantined ? false : next.goal === true
  return next
}

/**
 * Remove the legacy Goal tool permission from a materialized tool map so a stale
 * V1 `goal_*` default can never re-grant the quarantined surface. Returns a new
 * map; the input is never mutated. A no-op when the quarantine is lifted.
 */
export function stripLegacyGoalToolPermission(tools, { quarantined = LEGACY_GOAL_QUARANTINED } = {}) {
  if (!quarantined || tools === null || typeof tools !== "object" || Array.isArray(tools)) return tools
  const next = {}
  for (const [key, value] of Object.entries(tools)) {
    if (key === "goal" || key.startsWith(LEGACY_GOAL_TOOL_PREFIX)) continue
    next[key] = value
  }
  return next
}
