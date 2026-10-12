import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { discoverRuntimeModules, RUNTIME_ENTRIES } from "../native-runtime-modules.mjs"

// T38 boundary contract: the native V2 plugin runtime must never execute V1 OmO
// code from the CLI (distribution/installer), the config loader/schema, or the
// tier-1 MCP implementations. The runtime reimplements config resolution
// natively (`rigel-v2-native-config.mjs`) and re-registers the retained tier-1
// MCP servers natively (`rigel-v2-native-builtin-mcps.mjs`) because the V2 host
// neither runs language servers / exposes LSP tools nor lists `grep_app`
// (official migrate-v1: V2 "does not run language servers, expose LSP tools, or
// produce LSP diagnostics"). Any runtime import of a V1 module under these trees
// would mean V1 code is running in the mirror. This is the real contract behind
// the `config`, `mcp`, and `cli` ledger rows that the migration reduces to
// build/CLI surface rather than migrating into the plugin.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME_DIR = HERE
const REPO_ROOT = path.resolve(HERE, "..", "..", "..")
const V1_OFF_RUNTIME = "packages/omo-opencode/src/"

function reachable(sourceDir) {
  return [...RUNTIME_ENTRIES, ...discoverRuntimeModules(sourceDir, RUNTIME_ENTRIES)]
}

/** Every V1 OmO specifier imported by a module reachable from the native entry. */
export function findV1Imports(sourceDir, files = reachable(sourceDir)) {
  const hits = []
  for (const file of files) {
    const absolute = path.join(sourceDir, file)
    if (!fs.existsSync(absolute)) continue
    const text = fs.readFileSync(absolute, "utf8")
    for (const pattern of [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, /\bimport\s+["']([^"']+)["']/g]) {
      for (const match of text.matchAll(pattern)) {
        if (match[1].includes(V1_OFF_RUNTIME)) hits.push({ file, specifier: match[1] })
      }
    }
  }
  return hits
}

const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "profiles/gabo/integration-manifest.json"), "utf8"))

describe("native V2 runtime boundary against the V1 OmO surfaces", () => {
  test("#given the native entry's reachable module graph #when scanned #then no module imports V1 cli/config/mcp code", () => {
    expect(findV1Imports(RUNTIME_DIR)).toEqual([])
  })

  test("#given the profile manifest #then the CLI reduction and the MCP retention policy are declared", () => {
    expect(manifest.platform.installation).toBe("manual-after-isolated-acceptance")
    expect(manifest.mcpPolicy.omoBuiltinsRetained).toEqual(expect.arrayContaining(["grep_app", "lsp", "context7"]))
    // Context7 is decided dynamically (host collision / live disabled_mcps), so it
    // is retained but never statically disabled.
    expect(manifest.mcpPolicy.omoBuiltinsDisabled).not.toContain("context7")
    expect(manifest.nonGoals.length).toBeGreaterThan(0)
  })

  test("#given a runtime module importing a V1 surface #when scanned #then it is reported RED", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-boundary-"))
    try {
      fs.writeFileSync(path.join(root, "rigel-v2-native.mjs"), 'import { run } from "../../../packages/omo-opencode/src/cli/index.ts"\n')
      const hits = findV1Imports(root)
      expect(hits.length).toBe(1)
      expect(hits[0].specifier).toContain("packages/omo-opencode/src/cli/")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
