import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { discoverRuntimeModules, RUNTIME_ENTRIES } from "./native-runtime-modules.mjs"
import { stageLspRuntime } from "./rigel-v2-runtime-materialize.mjs"

/**
 * The native V2 runtime records and sends no usage statistics. That is a
 * property of the DEPLOYED tree, so it is asserted on the two things the
 * deployment actually derives from the source: the module graph the discovery
 * parser reaches from the real entries, and the package set the materializer
 * stages next to it. A new module that reached a reporter would silently
 * reintroduce the collection, and a hand-maintained staging list would be the
 * other way in.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME_SUBDIR = "opencode"
const TELEMETRY_TOKENS = /posthog|telemetry-core/i

const temporary = []
afterEach(() => {
  while (temporary.length > 0) fs.rmSync(temporary.pop(), { recursive: true, force: true })
})

function temporaryRoot(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporary.push(directory)
  return directory
}

function writeBuiltPackage(root, name) {
  const directory = path.join(root, "packages", name)
  fs.mkdirSync(path.join(directory, "dist"), { recursive: true })
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, version: "0.1.0" }))
  fs.writeFileSync(path.join(directory, "dist", "cli.js"), "#!/usr/bin/env node\n")
}

describe("#given the native V2 runtime graph", () => {
  test("#then no module reached from the entries imports or mentions a telemetry reporter", () => {
    // given
    const sourceDir = path.join(HERE, RUNTIME_SUBDIR)
    const files = [...RUNTIME_ENTRIES, ...discoverRuntimeModules(sourceDir, RUNTIME_ENTRIES)]
    // when
    const offenders = []
    for (const file of files) {
      const absolute = path.join(sourceDir, file)
      if (!fs.existsSync(absolute)) continue
      const match = fs.readFileSync(absolute, "utf8").match(TELEMETRY_TOKENS)
      if (match) offenders.push(`${file}: ${match[0]}`)
    }
    // then
    expect(files.length).toBeGreaterThan(0)
    expect(offenders).toEqual([])
  })
})

describe("#given a source tree that also builds telemetry packages", () => {
  test("#then the deployment stages only the LSP runtime and no telemetry package", () => {
    // given
    const sourceRoot = temporaryRoot("rigel-telemetry-stage-src-")
    const runtimeDir = temporaryRoot("rigel-telemetry-stage-runtime-")
    for (const name of ["lsp-daemon", "lsp-tools-mcp", "telemetry-core", "posthog-node"]) writeBuiltPackage(sourceRoot, name)
    // when
    const staged = stageLspRuntime({ sourceRoot, runtimeDir })
    // then
    expect(staged.length).toBeGreaterThan(0)
    expect(staged.filter((entry) => TELEMETRY_TOKENS.test(entry))).toEqual([])
  })
})
