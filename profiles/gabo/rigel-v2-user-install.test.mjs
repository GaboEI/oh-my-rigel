/**
 * Owner test for the Rigel V2 user lifecycle `status` runtime-resolvability check.
 *
 * Regression for finding N5: `statusOf` proved the config registered the runtime
 * string but never proved the registered path resolved. A moved/deleted runtime
 * could still be reported as a healthy install. This pins the new
 * `config.entryResolves` check by driving the real CLI over a crafted, isolated
 * lifecycle fixture (no OpenCode launch, no V1 path).
 */
import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const INSTALLER = join(fileURLToPath(new URL(".", import.meta.url)), "rigel-v2-user-install.mjs")

const created = []
afterEach(() => {
  while (created.length > 0) rmSync(created.pop(), { recursive: true, force: true })
})

function makeFixture() {
  const home = mkdtempSync(join(tmpdir(), "rigel-status-"))
  created.push(home)
  const root = join(home, "state")
  const versionDir = join(root, "versions", "1")
  const runtime = join(versionDir, "runtime")
  mkdirSync(runtime, { recursive: true })
  writeFileSync(join(runtime, "package.json"), `${JSON.stringify({ name: "rigel-v2-native", type: "module" })}\n`)
  writeFileSync(join(runtime, "index.js"), "export default {}\n")
  const agentManifest = join(versionDir, "agent-manifest.mjs")
  writeFileSync(agentManifest, "export default { agents: {}, modes: {} }\n")

  const configDir = join(home, "config", "opencode")
  mkdirSync(configDir, { recursive: true })
  const configFile = join(configDir, "opencode.json")
  writeFileSync(configFile, `${JSON.stringify({ plugin: [runtime] }, null, 2)}\n`)
  writeFileSync(join(configDir, "cli.json"), `${JSON.stringify({ plugins: [{ package: runtime, options: { notification: { enabled: false } } }] }, null, 2)}\n`)

  writeFileSync(join(root, "install-state.json"), `${JSON.stringify({
    schema: 2,
    version: "1",
    pluginEntry: runtime,
    agentManifest,
    versionDigests: {},
  }, null, 2)}\n`)

  return { home, root, runtime, configFile }
}

function runStatus(fixture) {
  const result = spawnSync(process.execPath, [
    INSTALLER, "status",
    "--state", fixture.root,
    "--home", fixture.home,
    "--config", fixture.configFile,
    "--json",
  ], { encoding: "utf8" })
  return JSON.parse(result.stdout)
}

function check(report, name) {
  return (report.checks ?? []).find((entry) => entry.name === name)
}

describe("rigel-v2 user-install status entry resolvability", () => {
  test("#given a registered runtime whose path resolves #then config.entryResolves passes", () => {
    // given
    const fixture = makeFixture()

    // when
    const report = runStatus(fixture)

    // then
    const entry = check(report, "config.entryResolves")
    expect(entry).toBeDefined()
    expect(entry.pass).toBe(true)
  })

  test("#given the registered runtime path is gone #then config.entryResolves fails", () => {
    // given: the config registers a runtime directory that does not exist
    const fixture = makeFixture()
    writeFileSync(fixture.configFile, `${JSON.stringify({ plugin: [join(fixture.home, "moved-away-runtime")] }, null, 2)}\n`)
    // the install state still points at the (now absent) original
    rmSync(fixture.runtime, { recursive: true, force: true })

    // when
    const report = runStatus(fixture)

    // then
    const entry = check(report, "config.entryResolves")
    expect(entry).toBeDefined()
    expect(entry.pass).toBe(false)
  })
})
