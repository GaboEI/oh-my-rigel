#!/usr/bin/env node
/**
 * Exposes the Rigel profile skills through OpenCode V2's native global
 * discovery directory.  V2 watches ~/.agents/skills, not
 * ~/.config/opencode/skills.
 *
 * Existing user-owned entries are never overwritten.  Legacy OpenCode skills
 * are linked into the V2 surface when there is no collision; Rigel-provided
 * skills are linked from this checkout; the cross-harness shared pool is linked
 * only for the skills `skillPolicy` authorizes (omoAdopt + omoAdapt +
 * omoProgressive), so the OmO skills the profile confirms reach the live
 * inventory while omoDisabled/unclassified pool skills stay out.  The manifest
 * makes every managed entry auditable and lets a future uninstall remove only
 * Rigel-owned links.
 */
import os from "node:os"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const home = process.env.HOME || os.homedir()
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const rigelSkills = path.join(sourceRoot, "profiles/gabo/skills")
const sharedSkills = path.join(sourceRoot, "packages/shared-skills/skills")
const manifestFile = path.join(sourceRoot, "profiles/gabo/integration-manifest.json")
const legacySkills = path.join(home, ".config/opencode/skills")
const targetRoot = path.join(home, ".agents/skills")
const stateDir = path.join(home, ".local/share/oh-my-rigel")
const stateFile = path.join(stateDir, "skills-v2.json")

/**
 * The shared-pool skills `skillPolicy` authorizes, as a name set. `omoDisabled`
 * and any unclassified pool skill are absent by construction, so linking the
 * pool can never expose a deliberately-off browser surface.
 */
function authorizedSharedSkills() {
  let policy
  try {
    policy = JSON.parse(fs.readFileSync(manifestFile, "utf8")).skillPolicy ?? {}
  } catch {
    policy = {}
  }
  const names = []
  for (const key of ["omoAdopt", "omoAdapt", "omoProgressive"]) {
    if (Array.isArray(policy[key])) names.push(...policy[key])
  }
  return new Set(names.filter((name) => typeof name === "string"))
}

function isSkill(directory) {
  return fs.existsSync(path.join(directory, "SKILL.md"))
}
function entryExists(candidate) {
  try { fs.lstatSync(candidate); return true } catch { return false }
}
function pointsAt(target, source) {
  try { return fs.realpathSync(target) === fs.realpathSync(source) } catch { return false }
}
function listSkills(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && isSkill(path.join(directory, entry.name)))
    .map(entry => entry.name)
    .sort()
}
function link(source, target) {
  fs.symlinkSync(source, target, "dir")
}

/** Prior manifest (if any): name -> the source this profile last recorded for it. */
function previousManagedSources() {
  try {
    const prior = JSON.parse(fs.readFileSync(stateFile, "utf8"))
    const map = new Map()
    for (const entry of Array.isArray(prior.managed) ? prior.managed : []) {
      if (entry && typeof entry.name === "string" && typeof entry.source === "string") map.set(entry.name, entry.source)
    }
    return map
  } catch {
    return new Map()
  }
}
function linkText(candidate) {
  try { return fs.readlinkSync(candidate) } catch { return null }
}

/**
 * Deliver one name into the discovery root. An absent target is linked; a target
 * that already resolves to `source` is managed; a target that is a symlink still
 * pointing at the source THIS profile previously recorded (proof Rigel created
 * it) is re-pointed to the current `source`; anything else - including every
 * non-symlink - is a user entry and is preserved untouched. A user-owned path is
 * never removed or rewritten.
 */
function deliverName({ name, source, kind, target, previousManaged, managed, preserved, linkedTargets }) {
  if (!entryExists(target)) {
    link(source, target)
    managed.push({ name, source, kind })
    linkedTargets.add(name)
    return
  }
  if (pointsAt(target, source)) {
    managed.push({ name, source, kind })
    linkedTargets.add(name)
    return
  }
  const recorded = previousManaged.get(name)
  if (recorded !== undefined && recorded === linkText(target)) {
    fs.rmSync(target, { force: true })
    link(source, target)
    managed.push({ name, source, kind })
    linkedTargets.add(name)
    return
  }
  preserved.push(name)
}

fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 })
const managed = []
const preserved = []
const linkedTargets = new Set()
const previousManaged = previousManagedSources()

// Keep the user's pre-Rigel skill inventory usable in OpenCode V2.  These are
// deliberately *not* copied into the fork: their source remains user-owned.
for (const name of listSkills(legacySkills)) {
  deliverName({ name, source: path.join(legacySkills, name), kind: "legacy-bridge", target: path.join(targetRoot, name), previousManaged, managed, preserved, linkedTargets })
}

// Rigel skills fill the remaining names.  A user skill with the same name
// always wins, which avoids silently changing an established workflow.
for (const name of listSkills(rigelSkills)) {
  if (linkedTargets.has(name)) continue
  deliverName({ name, source: path.join(rigelSkills, name), kind: "rigel", target: path.join(targetRoot, name), previousManaged, managed, preserved, linkedTargets })
}

// The cross-harness shared pool. Only the `skillPolicy`-authorized names are
// linked; `browser` (unclassified) and `ultimate-browsing` (omoDisabled) are
// absent from the authorized union and therefore never reach the live
// inventory. A name already linked (legacy/rigel) or owned by the user wins.
const authorized = authorizedSharedSkills()
for (const name of listSkills(sharedSkills)) {
  if (!authorized.has(name)) continue
  if (linkedTargets.has(name)) continue
  deliverName({ name, source: path.join(sharedSkills, name), kind: "shared", target: path.join(targetRoot, name), previousManaged, managed, preserved, linkedTargets })
}

fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 })
fs.writeFileSync(stateFile, JSON.stringify({
  generatedAt: new Date().toISOString(),
  discoveryRoot: targetRoot,
  managed,
  preserved: [...new Set(preserved)].sort(),
}, null, 2) + "\n", { mode: 0o600 })
console.log(JSON.stringify({ discoveryRoot: targetRoot, linked: managed.map(item => item.name), preserved: [...new Set(preserved)].sort() }))
