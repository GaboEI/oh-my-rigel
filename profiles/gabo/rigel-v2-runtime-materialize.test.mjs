import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { stageLspRuntime } from "./rigel-v2-runtime-materialize.mjs"

const temporaryRoots = []
function temporaryRoot(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporaryRoots.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function writePackage(root, name, { built = false } = {}) {
  const directory = path.join(root, "packages", name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, version: "0.1.0" }))
  if (built) {
    fs.mkdirSync(path.join(directory, "dist"), { recursive: true })
    fs.writeFileSync(path.join(directory, "dist", "cli.js"), "#!/usr/bin/env node\n")
  }
}

describe("stageLspRuntime", () => {
  test("#given a built source #when staging #then the LSP package.json and dist land in the deployment", () => {
    // given
    const sourceRoot = temporaryRoot("rigel-lsp-stage-src-")
    const runtimeDir = temporaryRoot("rigel-lsp-stage-runtime-")
    writePackage(sourceRoot, "lsp-daemon", { built: true })
    writePackage(sourceRoot, "lsp-tools-mcp", { built: true })

    // when
    const staged = stageLspRuntime({ sourceRoot, runtimeDir })

    // then the deployment OWNS the LSP runtime, so a valid install no longer
    // depends on the transient source checkout surviving.
    expect(staged.sort()).toEqual([
      "packages/lsp-daemon/dist",
      "packages/lsp-daemon/package.json",
      "packages/lsp-tools-mcp/dist",
      "packages/lsp-tools-mcp/package.json",
    ])
    for (const relative of staged) expect(fs.existsSync(path.join(runtimeDir, relative))).toBe(true)
    expect(
      fs.readFileSync(path.join(runtimeDir, "packages/lsp-daemon/dist/cli.js"), "utf8"),
    ).toContain("node")
  })

  test("#given an unbuilt source #when staging #then nothing is staged and no error is thrown", () => {
    // given a source tree whose LSP packages were never built
    const sourceRoot = temporaryRoot("rigel-lsp-stage-unbuilt-src-")
    const runtimeDir = temporaryRoot("rigel-lsp-stage-unbuilt-runtime-")
    writePackage(sourceRoot, "lsp-daemon", { built: false })
    writePackage(sourceRoot, "lsp-tools-mcp", { built: false })

    // when
    const staged = stageLspRuntime({ sourceRoot, runtimeDir })

    // then the runtime has no self-contained dist, so it degrades to a disabled
    // server instead of depending on a transient source root.
    expect(staged).toEqual([])
    expect(fs.existsSync(path.join(runtimeDir, "packages"))).toBe(false)
  })

  test("#given a source without any LSP package #when staging #then nothing is staged and no error is thrown", () => {
    // given
    const sourceRoot = temporaryRoot("rigel-lsp-stage-none-src-")
    const runtimeDir = temporaryRoot("rigel-lsp-stage-none-runtime-")

    // when / then
    expect(stageLspRuntime({ sourceRoot, runtimeDir })).toEqual([])
  })
})
