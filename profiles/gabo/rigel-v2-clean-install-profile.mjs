/**
 * Clean-install profile rendering for the Rigel V2 user installer.
 *
 * The tracked `profiles/gabo/omo.jsonc` is Gabo's operator profile. A generic
 * clean install must start from the product defaults and must NOT bake the
 * Context7 decision into `disabled_mcps`: whether the builtin Context7 is live is
 * decided by the RUNTIME on every setup (an external Context7 in the user's
 * OpenCode config wins by name collision, and the builtin is emitted only when no
 * external server exists). Baking `disabled_mcps: ["context7"]` at install time
 * would strand a user at ZERO Context7 after they later remove their external
 * server, because an existing profile is never rewritten.
 *
 * This function is pure and side-effect free, so the seeding contract can be
 * exercised without spawning the installer.
 */

/**
 * Render the clean-install profile: force `default_mode.goal` and
 * `default_mode.ultrawork` off, and drop any `context7` entry from
 * `disabled_mcps` so the runtime's live exclusivity owns Context7. Every other
 * field is preserved and the input is never mutated.
 */
export function renderCleanInstallProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return profile
  const profiles = profile.profiles
  const gabo = profiles && typeof profiles === "object" && !Array.isArray(profiles) ? profiles.gabo : undefined
  const block = gabo && typeof gabo === "object" && !Array.isArray(gabo) ? gabo["[opencode]"] : undefined
  if (!block || typeof block !== "object" || Array.isArray(block)) return profile

  const existingDisabled = Array.isArray(block.disabled_mcps)
    ? block.disabled_mcps.filter((name) => typeof name === "string")
    : []
  const existingMode = block.default_mode && typeof block.default_mode === "object" && !Array.isArray(block.default_mode)
    ? block.default_mode
    : {}

  return {
    ...profile,
    profiles: {
      ...profiles,
      gabo: {
        ...gabo,
        "[opencode]": {
          ...block,
          disabled_mcps: existingDisabled.filter((name) => name !== "context7"),
          default_mode: { ...existingMode, goal: false, ultrawork: false },
        },
      },
    },
  }
}
