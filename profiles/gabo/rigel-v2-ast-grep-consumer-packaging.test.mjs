/**
 * C1 packaging contract: the ast-grep provisioning consumers shipped under
 * `profiles/gabo` are distributed with the profile tree on their own, so they
 * must resolve with NO workspace `node_modules`. A bare `@oh-my-opencode/*`
 * specifier that only the monorepo can resolve leaves the shipped consumer
 * broken outside the checkout.
 *
 * This test copies the REAL consumer closure OUTSIDE the repository and imports
 * it there, so a workspace-only specifier fails for the same reason it fails in a
 * shipped install. It guards the package/distribution contract (the profile tree
 * is shippable standalone), not any wording.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(moduleDirectory, "../..")
// The shipped consumer closure, copied preserving the relative layout it imports by.
const CONSUMER_FILES = [
  "profiles/gabo/cli/commands/ast-grep.mjs",
  "profiles/gabo/cli/rigel-v2-cli-io.mjs",
  "profiles/gabo/rigel-v2-ast-grep-provision.mjs",
  "profiles/gabo/rigel-v2-ast-grep-runtime.mjs",
]
const CONSUMER_ENTRIES = [
  "profiles/gabo/cli/commands/ast-grep.mjs",
  "profiles/gabo/rigel-v2-ast-grep-provision.mjs",
]

const roots = []
afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop(), { recursive: true, force: true })
})

function stageOutsideRepo() {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-ast-grep-consumer-"))
  roots.push(staging)
  const copied = []
  for (const relative of CONSUMER_FILES) {
    const source = path.join(repoRoot, relative)
    if (!fs.existsSync(source)) continue
    const target = path.join(staging, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
    copied.push(relative)
  }
  return { staging, copied }
}

/** Import a staged module in a throwaway node process whose resolution root is the staging dir. */
function importOutsideRepo(staging, relative) {
  const target = path.join(staging, relative)
  const probe = `
    try {
      await import(${JSON.stringify(target)})
      process.stdout.write("IMPORTED")
    } catch (error) {
      process.stderr.write(String(error && error.code ? error.code : error))
      process.exitCode = 1
    }
  `
  // Only PATH: no NODE_PATH, no inherited cwd module resolution, no workspace node_modules.
  const result = spawnSync("node", ["--input-type=module", "-e", probe], {
    cwd: os.tmpdir(),
    env: { PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 60_000,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe("#given the ast-grep consumers shipped under profiles/gabo", () => {
  test("#when imported with no workspace node_modules #then every consumer resolves", () => {
    const { staging, copied } = stageOutsideRepo()
    expect(copied).toContain(CONSUMER_ENTRIES[0])
    expect(copied).toContain(CONSUMER_ENTRIES[1])
    for (const relative of CONSUMER_ENTRIES) {
      const { status, stderr } = importOutsideRepo(staging, relative)
      expect(status, `import ${relative} outside the repo failed: ${stderr}`).toBe(0)
    }
  })
})
