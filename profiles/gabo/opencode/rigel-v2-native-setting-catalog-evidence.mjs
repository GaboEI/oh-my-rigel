/**
 * Evidence-path anchors shared by the catalog data modules.
 *
 * Every `evidence` string in the catalog is a repo-forward-slash `path:line`
 * pointer to the reader that makes a tier true (or to the probe that proves no
 * reader exists). Keeping the module prefixes here means a file move updates one
 * place instead of a hundred string literals.
 */

export const CONFIG = "profiles/gabo/opencode/rigel-v2-native-config.mjs"
export const NATIVE = "profiles/gabo/opencode/rigel-v2-native.mjs"
export const MANIFEST = "profiles/gabo/build-target-agent-manifest.mjs"
export const QUARANTINE = "profiles/gabo/opencode/rigel-v2-native-goal-quarantine.mjs"

/** Evidence for a key the resolver never projects: it is outside `TARGET_KEYS`. */
export const NOT_A_TARGET = `${CONFIG}:80`
