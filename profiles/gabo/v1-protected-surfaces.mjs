import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

// V1 surfaces the V2 installer must never touch. Every file here is hashed.
export const PROTECTED_DIRS = [
  ".config/opencode/agents",
  ".config/opencode/command",
  ".config/opencode/commands",
  ".config/opencode/skills",
  ".config/opencode/plugins",
  ".config/opencode/themes",
  ".config/opencode/mcp-oauth",
  ".local/share/opencode/plugin",
  ".local/share/opencode/agent",
  ".local/share/opencode/skill",
  ".local/share/opencode/command",
  ".local/share/opencode-goal-plugin",
]

// Credential files under the V1 data root (explicit: the data root also holds
// operational state that must not be part of the invariant).
export const PROTECTED_FILES = [
  ".local/share/opencode/auth.json",
  ".local/share/opencode/mcp-auth.json",
]

// Volatile credential files: still classified protected (their presence or
// absence is reported by the diff) but NOT content-hashed, because V1 rewrites
// them on token refresh. Hashing their content made the digest drift across
// runs for reasons unrelated to this installer; a stable marker keeps the
// within-run before/after invariant and makes the digest reproducible across
// runs without ever reading a credential value.
export const VOLATILE_PROTECTED_FILES = [
  ".local/share/opencode/auth.json",
  ".local/share/opencode/mcp-auth.json",
]

// Demonstrated operational state (session/db/log/cache/runtime). This is the
// ONLY exclusion rationale: the audit runs inside live V1, so these mutate
// legitimately. Any top-level entry outside this list AND outside the protected
// allow-list is unclassified: it is hashed (files) or gets a shape marker
// (directories), so a V2 installer that drops a new file or subdirectory
// anywhere in V1 shows up as an added entry instead of being invisible.
export const OPERATIONAL_SURFACES = [
  ".config/opencode/context-mode",
  ".config/opencode/oh-my-openagent",
  ".config/opencode/backups",
  ".config/opencode/node_modules",
  ".local/share/opencode/opencode.db",
  ".local/share/opencode/opencode.db-shm",
  ".local/share/opencode/opencode.db-wal",
  ".local/share/opencode/log",
  ".local/share/opencode/storage",
  ".local/share/opencode/snapshot",
  ".local/share/opencode/shell",
  ".local/share/opencode/tool-output",
  ".local/share/opencode/worktree",
  ".local/share/opencode/repos",
  ".cache/opencode",
]

// Roots whose entire subtree is operational by policy (cache churn).
export const OPERATIONAL_ROOTS = [".cache/opencode"]

// Every V1 root the manifest walks.
export const V1_ROOTS = [
  ".config/opencode",
  ".local/share/opencode",
  ".local/share/opencode-goal-plugin",
  ".cache/opencode",
]

function isUnder(rel, prefix) {
  return rel === prefix || rel.startsWith(`${prefix}/`)
}

function classify(rel) {
  if (PROTECTED_FILES.includes(rel)) return "protected"
  if (PROTECTED_DIRS.some((dir) => isUnder(rel, dir))) return "protected"
  if (OPERATIONAL_SURFACES.some((surface) => isUnder(rel, surface))) return "operational"
  return "unclassified"
}

function listFiles(absDir, home, out) {
  let entries
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const child = path.join(absDir, entry.name)
    if (entry.isDirectory()) listFiles(child, home, out)
    else if (entry.isFile()) out.push(path.relative(home, child))
  }
}

export function collectProtectedFiles(home) {
  const files = []
  for (const root of V1_ROOTS) {
    if (OPERATIONAL_ROOTS.some((operational) => isUnder(root, operational))) continue
    const absRoot = path.join(home, root)
    let entries
    try {
      entries = fs.readdirSync(absRoot, { withFileTypes: true })
    } catch {
      continue
    }
    if (PROTECTED_DIRS.includes(root)) {
      listFiles(absRoot, home, files)
      continue
    }
    for (const entry of entries) {
      const rel = `${root}/${entry.name}`
      const kind = classify(rel)
      if (kind === "operational") continue
      if (entry.isDirectory()) {
        if (kind === "unclassified") files.push(`${rel}/`)
        listFiles(path.join(absRoot, entry.name), home, files)
      } else if (entry.isFile()) {
        files.push(rel)
      }
    }
  }
  return [...new Set(files)].sort()
}

export function buildProtectedManifest(home = os.homedir()) {
  const manifest = {}
  for (const rel of collectProtectedFiles(home)) {
    if (rel.endsWith("/")) {
      manifest[rel] = "dir"
      continue
    }
    if (VOLATILE_PROTECTED_FILES.includes(rel)) {
      manifest[rel] = "volatile"
      continue
    }
    try {
      manifest[rel] = crypto.createHash("sha256").update(fs.readFileSync(path.join(home, rel))).digest("hex")
    } catch {
      manifest[rel] = "unreadable"
    }
  }
  return manifest
}

export function diffProtectedManifests(before, after) {
  return {
    added: Object.keys(after).filter((k) => !(k in before)).sort(),
    removed: Object.keys(before).filter((k) => !(k in after)).sort(),
    changed: Object.keys(after).filter((k) => k in before && before[k] !== after[k]).sort(),
  }
}

export function manifestDigest(manifest) {
  return crypto
    .createHash("sha256")
    .update(Object.entries(manifest).map(([file, hash]) => `${file}\0${hash}`).sort().join("\n"))
    .digest("hex")
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2]
  const home = process.argv[3] ?? os.homedir()
  const manifest = buildProtectedManifest(home)
  if (mode === "--digest") {
    process.stdout.write(`${manifestDigest(manifest)}\n`)
  } else if (mode === "--manifest") {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
  } else {
    process.stdout.write(`protected files: ${Object.keys(manifest).length}\ndigest: ${manifestDigest(manifest)}\n`)
  }
}
