import fs from "node:fs"
import path from "node:path"

/**
 * Discover every ESM module the native V2 entries transitively import from the
 * source tree. The deployed runtime, the activation script, and the isolated QA
 * contracts all copy the same set from this one function, so a newly added
 * module can never be silently dropped by a hand-maintained list (the failure
 * mode that makes the lab runtime fail to import a module after an edit).
 *
 * The native runtime has two entrypoints: the server plugin
 * (`rigel-v2-native.mjs`) and the companion CLI plugin
 * (`rigel-v2-native-cli.mjs`, exported as the package `./tui`). The companion
 * composes no session notifier: the host owns that surface (row 57).
 * Both roots are walked so the CLI entry's own dependency graph is staged too.
 *
 * Returns repo-forward-slash relative paths, sorted, excluding the entry
 * modules themselves: callers deploy each entry under its own name.
 */
export const RUNTIME_ENTRIES = Object.freeze([
  "rigel-v2-native.mjs",
  "rigel-v2-native-cli.mjs",
])

export function discoverRuntimeModules(sourceOpenDir, entries = RUNTIME_ENTRIES) {
  const entryList = Array.isArray(entries) ? entries : [entries]
  const entrySet = new Set(entryList)
  const seen = new Set()
  const stack = [...entryList]
  while (stack.length > 0) {
    const file = stack.pop()
    if (seen.has(file)) continue
    const absolute = path.join(sourceOpenDir, file)
    if (!fs.existsSync(absolute)) continue
    seen.add(file)
    const text = fs.readFileSync(absolute, "utf8")
    for (const match of text.matchAll(/from\s+"(\.[^"]+)"/g)) {
      let target = match[1]
      if (!/\.(?:mjs|js|ts)$/.test(target)) target += ".mjs"
      stack.push(path.normalize(path.join(path.dirname(file), target)).split(path.sep).join("/"))
    }
  }
  return [...seen].filter((file) => !entrySet.has(file)).sort()
}
