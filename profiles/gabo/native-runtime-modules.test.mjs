import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { discoverRuntimeModules, RUNTIME_ENTRIES } from "./native-runtime-modules.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, "..", "..")
const RUNTIME_SUBDIR = "opencode"
const ENTRY = "rigel-v2-native.mjs"

/**
 * Test-only source-dir override. Default is the real runtime tree; a control
 * run may point it at a disposable copy to drive the real assertions RED
 * without touching the repository. Never set in a normal run.
 */
const SOURCE_DIR = process.env.RIGEL_NATIVE_SOURCE_DIR ? path.resolve(process.env.RIGEL_NATIVE_SOURCE_DIR) : path.join(HERE, RUNTIME_SUBDIR)

const temporary = []
afterEach(() => { while (temporary.length > 0) fs.rmSync(temporary.pop(), { recursive: true, force: true }) })

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-discovery-"))
  temporary.push(root)
  return root
}

/**
 * Local-relative import shapes discoverRuntimeModules() cannot follow. Any of
 * these silently drops the target module from lab staging, so the deployed
 * runtime fails to import it later. Only `from "..."` with double quotes is
 * accepted by the discovery parser.
 */
const FORBIDDEN_RELATIVE_IMPORTS = [
  { form: "single-quoted static import", pattern: /\bfrom\s*'(\.[^'\n]+)'/g },
  { form: "side-effect import", pattern: /\bimport\s*["'](\.[^"'\n]+)["']/g },
  { form: "dynamic import", pattern: /\bimport\s*\(\s*["'`](\.[^"'`\n]+)["'`]\s*\)/g },
]

/** The entries plus every module the parser transitively discovers from them. */
function reachableRuntimeFiles(sourceDir) {
  return [...RUNTIME_ENTRIES, ...discoverRuntimeModules(sourceDir, RUNTIME_ENTRIES)]
}

/** Every reachable module using a local import shape the parser cannot follow. */
function findForbiddenRelativeImports(sourceDir, files = reachableRuntimeFiles(sourceDir)) {
  const violations = []
  for (const file of files) {
    const absolute = path.join(sourceDir, file)
    if (!fs.existsSync(absolute)) continue
    const text = fs.readFileSync(absolute, "utf8")
    for (const { form, pattern } of FORBIDDEN_RELATIVE_IMPORTS) {
      for (const match of text.matchAll(pattern)) {
        violations.push({ file, form, specifier: match[1] })
      }
    }
  }
  return violations
}

/** Runtime-looking candidates that lab staging would never copy. */
function findUnreachableRuntimeModules(candidates, discovered, entries = RUNTIME_ENTRIES) {
  const known = new Set(discovered)
  const entrySet = new Set(entries)
  return candidates.filter((file) => !entrySet.has(file) && !known.has(file)).sort()
}

/**
 * Non-test `rigel-v2-*.mjs` modules in the committed tree. HEAD is the source of
 * truth, not the index, so untracked in-flight modules owned by a parallel task
 * are out of scope until they are wired and committed.
 */
function committedRuntimeModules() {
  const prefix = `profiles/gabo/${RUNTIME_SUBDIR}/`
  const output = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", `profiles/gabo/${RUNTIME_SUBDIR}`], { cwd: REPO_ROOT, encoding: "utf8" })
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((file) => file.startsWith(prefix) && /^rigel-v2-.*\.mjs$/.test(file.slice(prefix.length)))
    .map((file) => file.slice(prefix.length))
    .filter((file) => !file.endsWith(".test.mjs"))
}

/**
 * Narrow a HEAD-derived candidate list to modules that still exist on disk.
 *
 * A module deleted in the working tree is RETIRED, not orphaned: lab staging has
 * nothing to copy, and the removal is proven by the deletion (and by the diff)
 * rather than by reachability. Without this filter the guard reports every
 * uncommitted retirement as "orphaned from lab staging" until the deletion is
 * committed, which makes the guard unusable for exactly the review window it is
 * meant to protect.
 *
 * The failure mode the guard actually exists for is preserved: a module that is
 * still on disk but that the entry can never reach would deploy as dead weight
 * (or break at import time), and it is still reported.
 */
function existingRuntimeModules(sourceDir, candidates = committedRuntimeModules()) {
  return candidates.filter((file) => fs.existsSync(path.join(sourceDir, file)))
}

describe("Rigel native runtime module discovery", () => {
  test("#given an entry that imports a nested module #when discovering #then both the entry's deps and nested files are returned", () => {
    const root = workspace()
    fs.mkdirSync(path.join(root, "tools"), { recursive: true })
    fs.writeFileSync(path.join(root, "rigel-v2-native.mjs"), 'import { a } from "./a.mjs"\nimport { b } from "./tools/b.mjs"\n')
    fs.writeFileSync(path.join(root, "a.mjs"), 'import { c } from "./c.mjs"\nexport const a = c\n')
    fs.writeFileSync(path.join(root, "c.mjs"), "export const c = 1\n")
    fs.writeFileSync(path.join(root, "tools/b.mjs"), "export const b = 1\n")
    const found = discoverRuntimeModules(root)
    expect(found).toContain("a.mjs")
    expect(found).toContain("c.mjs")
    expect(found).toContain("tools/b.mjs")
    expect(found).not.toContain("rigel-v2-native.mjs")
  })

  test("#given an entry importing a TypeScript helper #when discovering #then the helper is staged with its runtime", () => {
    const root = workspace()
    fs.writeFileSync(path.join(root, "rigel-v2-native.mjs"), 'import { parser } from "./parser.ts"\n')
    fs.writeFileSync(path.join(root, "parser.ts"), 'import { Parser } from "htmlparser2"\nexport const parser = Parser\n')
    expect(discoverRuntimeModules(root)).toContain("parser.ts")
  })

  test("#given a broken relative import #when discovering #then the missing target is skipped without throwing", () => {
    const root = workspace()
    fs.writeFileSync(path.join(root, "rigel-v2-native.mjs"), 'import { missing } from "./missing.mjs"\nimport { p } from "./present.mjs"\n')
    fs.writeFileSync(path.join(root, "present.mjs"), "export const p = 1\n")
    const found = discoverRuntimeModules(root)
    expect(found).toContain("present.mjs")
    expect(found).not.toContain("missing.mjs")
  })
})

describe("Rigel native runtime module staging guard", () => {
  test("#given the native entry's transitive runtime graph #when every reachable module is scanned for local imports #then each uses the double-quoted from form", () => {
    expect(findForbiddenRelativeImports(SOURCE_DIR)).toEqual([])
  })

  test("#given the committed runtime modules #when compared to the native entry's transitive graph #then none is orphaned from lab staging", () => {
    const unreachable = findUnreachableRuntimeModules(existingRuntimeModules(SOURCE_DIR), discoverRuntimeModules(SOURCE_DIR, RUNTIME_ENTRIES))
    expect(unreachable).toEqual([])
  })

  const FORBIDDEN_FIXTURES = [
    { form: "single-quoted static import", entry: "import { dep } from './dep.mjs'\n" },
    { form: "side-effect import", entry: 'import "./dep.mjs"\n' },
    { form: "dynamic import", entry: 'const dep = await import("./dep.mjs")\n' },
  ]

  for (const { form, entry } of FORBIDDEN_FIXTURES) {
    test(`#given a runtime entry with a ${form} of a local module #when guarding #then it is reported RED`, () => {
      const root = workspace()
      fs.writeFileSync(path.join(root, ENTRY), entry)
      fs.writeFileSync(path.join(root, "dep.mjs"), "export const dep = 1\n")
      expect(findForbiddenRelativeImports(root)).toContainEqual({ file: ENTRY, form, specifier: "./dep.mjs" })
    })
  }

  test("#given a candidate list mixing present and deleted modules #when narrowed to the disk #then only present modules survive", () => {
    const root = workspace()
    fs.writeFileSync(path.join(root, ENTRY), 'import { a } from "./present.mjs"\n')
    fs.writeFileSync(path.join(root, "present.mjs"), "export const a = 1\n")
    expect(existingRuntimeModules(root, ["present.mjs", "retired.mjs"])).toEqual(["present.mjs"])
  })

  test("#given a module still on disk but reachable from nothing #when narrowed to the disk #then it is NOT dropped and stays RED", () => {
    // Pins the limit of the existence filter: it excuses deletions only. A
    // present-but-unreachable module is still the guard's actual failure mode.
    const root = workspace()
    fs.writeFileSync(path.join(root, ENTRY), 'import { a } from "./present.mjs"\n')
    fs.writeFileSync(path.join(root, "present.mjs"), "export const a = 1\n")
    fs.writeFileSync(path.join(root, "rigel-v2-orphan.mjs"), "export const orphan = 1\n")
    const candidates = existingRuntimeModules(root, ["present.mjs", "rigel-v2-orphan.mjs"])
    expect(findUnreachableRuntimeModules(candidates, discoverRuntimeModules(root, ENTRY))).toEqual(["rigel-v2-orphan.mjs"])
  })

  test("#given a runtime-looking module reachable from nothing #when checking reachability #then it is reported RED", () => {
    const root = workspace()
    fs.writeFileSync(path.join(root, ENTRY), 'import { a } from "./reachable.mjs"\n')
    fs.writeFileSync(path.join(root, "reachable.mjs"), "export const a = 1\n")
    fs.writeFileSync(path.join(root, "rigel-v2-orphan.mjs"), "export const orphan = 1\n")
    const unreachable = findUnreachableRuntimeModules(["reachable.mjs", "rigel-v2-orphan.mjs"], discoverRuntimeModules(root, ENTRY))
    expect(unreachable).toEqual(["rigel-v2-orphan.mjs"])
  })
})

/**
 * REGRESSION GUARD: the failure mode that retired the OpenGateway V2 port.
 *
 * `discoverRuntimeModules` follows only `from "./*.mjs"` and appends `.mjs`, so
 * a module that loads a sibling NON-`.mjs` asset at runtime (a JSON catalog via
 * `new URL(..., import.meta.url)`, a `.txt` template, …) is staged WITHOUT that
 * asset. The module then deploys and silently degrades at runtime instead of
 * failing at packaging time: `rigel-v2-native-opengateway.mjs` loaded a 60-model
 * JSON catalog this way, deployed fine on NLS1 v1/v2/v3, and registered a
 * provider with ZERO models even when a credential was present.
 *
 * These tests pin the property that makes that detectable: a runtime module
 * must not reference a non-`.mjs` sibling asset, because the materializer will
 * never ship it.
 */
describe("runtime modules must not depend on non-.mjs sibling assets", () => {
  const NON_MODULE_ASSET_REF = /new URL\(\s*["']\.\/([^"']+\.(?:json|txt|md|yml|yaml|toml))["']\s*,\s*import\.meta\.url\s*\)/g

  function findAssetRefs(dir) {
    const findings = []
    for (const rel of discoverRuntimeModules(dir, ENTRY)) {
      const abs = path.join(dir, rel)
      if (!fs.existsSync(abs)) continue
      const text = fs.readFileSync(abs, "utf8")
      for (const match of text.matchAll(NON_MODULE_ASSET_REF)) findings.push({ file: rel, asset: match[1] })
    }
    return findings
  }

  test("#given the real runtime tree #when scanned #then no module references a non-.mjs sibling asset", () => {
    // If this fails, the referenced file will be absent from every deployed
    // runtime: stage it explicitly in the materializer, or inline the data.
    expect(findAssetRefs(path.join(HERE, RUNTIME_SUBDIR))).toEqual([])
  })

  test("#given a module referencing a sibling JSON asset #when scanned #then it is reported RED", () => {
    const root = workspace()
    fs.writeFileSync(path.join(root, ENTRY), 'import { a } from "./dep.mjs"\n')
    fs.writeFileSync(path.join(root, "dep.mjs"),
      'const url = new URL("./models.json", import.meta.url)\nexport const a = url.pathname\n')
    fs.writeFileSync(path.join(root, "models.json"), "{}\n")
    expect(findAssetRefs(root)).toEqual([{ file: "dep.mjs", asset: "models.json" }])
  })

  test("#given the retired opengateway layer's exact pattern #when scanned #then it is reported RED", () => {
    const root = workspace()
    fs.writeFileSync(path.join(root, ENTRY), 'import { a } from "./dep.mjs"\n')
    // Verbatim shape of the retired rigel-v2-native-opengateway.mjs line 32.
    fs.writeFileSync(path.join(root, "dep.mjs"),
      'const CATALOG_URL = new URL("./rigel-v2-opengateway-models.json", import.meta.url)\nexport const a = CATALOG_URL.href\n')
    fs.writeFileSync(path.join(root, "rigel-v2-opengateway-models.json"), "{}\n")
    expect(findAssetRefs(root)).toContainEqual({ file: "dep.mjs", asset: "rigel-v2-opengateway-models.json" })
  })
})
