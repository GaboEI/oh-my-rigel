/**
 * Owner tests for the Rigel V2 `doctor` runtime-entry detection.
 *
 * Regression for finding N5: `checkSystem` used to detect the registered runtime
 * by the substring "rigel-v2-native" in the plugin entry. The installer writes a
 * plain directory entry (`<stateRoot>/versions/<v>/runtime`), so a HEALTHY install
 * was reported as "Rigel runtime plugin is not registered". These tests pin the
 * observable behavior the user's health check must have:
 *   - a resolvable, loadable runtime entry -> SYSTEM pass
 *   - a registered entry that does not resolve -> SYSTEM fail naming the path
 *   - no Rigel runtime registered at all -> SYSTEM fail ("not registered")
 *
 * Only machine-consumed fields (status + issue title/description) are asserted.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { doctorCommand } from "./doctor.mjs"

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..")

const created = []
afterEach(() => {
  while (created.length > 0) rmSync(created.pop(), { recursive: true, force: true })
})

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "rigel-doctor-"))
  created.push(home)
  return home
}

/** A materialized runtime dir: package.json name=rigel-v2-native (+ optional index.js). */
function writeRuntime(root, { name = "runtime", withIndex = true, pkgName = "rigel-v2-native" } = {}) {
  const dir = join(root, "state", "versions", "1", name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: pkgName, type: "module", exports: { ".": "./index.js" } }, null, 2)}\n`)
  if (withIndex) writeFileSync(join(dir, "index.js"), "export default {}\n")
  return dir
}

function writeConfig(home, plugin) {
  const configFile = join(home, "config", "opencode", "opencode.json")
  mkdirSync(join(home, "config", "opencode"), { recursive: true })
  writeFileSync(configFile, `${JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin }, null, 2)}\n`)
  return configFile
}

async function runDoctor(configFile, home) {
  const chunks = []
  const io = {
    stdout: { write: (s) => { chunks.push(s); return true } },
    stderr: { write: () => true },
    env: {
      RIGEL_V2_REPO_ROOT: REPO_ROOT,
      RIGEL_V2_CONFIG: configFile,
      RIGEL_OPENCODE_V2_BIN: join(home, ".opencode", "bin", "opencode"),
      XDG_CACHE_HOME: join(home, ".cache"),
    },
    home,
    cwd: home,
    // Never launch a real binary in this test.
    spawn: () => ({ status: 0, stdout: "opencode v2.0.26\n", stderr: "" }),
  }
  await doctorCommand.run(["--json"], io)
  return JSON.parse(chunks.join(""))
}

async function runSystem(configFile, home) {
  return (await runDoctor(configFile, home)).results.find((result) => result.name === "SYSTEM")
}

describe("rigel-v2 doctor SYSTEM runtime detection", () => {
  test("#given a resolvable, loadable runtime entry #then SYSTEM passes", async () => {
    // given: the real installer shape — a `versions/1/runtime` dir, NOT named rigel-v2-native
    const home = makeHome()
    const runtime = writeRuntime(home)
    const configFile = writeConfig(home, [runtime])

    // when
    const system = await runSystem(configFile, home)

    // then
    expect(system.status).toBe("pass")
    expect(system.issues).toEqual([])
  })

  test("#given a runtime entry whose index.js is missing #then SYSTEM fails naming the path", async () => {
    // given: a dir named rigel-v2-native but with no loadable entry
    const home = makeHome()
    const runtime = writeRuntime(home, { name: "rigel-v2-native", withIndex: false })
    const configFile = writeConfig(home, [runtime])

    // when
    const system = await runSystem(configFile, home)

    // then
    expect(system.status).toBe("fail")
    const issue = system.issues[0]
    expect(issue.severity).toBe("error")
    expect(`${issue.title} ${issue.description}`).toContain(runtime)
  })

  test("#given a registered entry whose runtime was deleted #then SYSTEM fails as registered-but-missing", async () => {
    // given: the installer's lifecycle shape — state root records the runtime at
    // <stateRoot>/versions/1/runtime, and that directory no longer exists. The
    // entry keeps NO rigel-v2-native basename and NO package.json, so identity
    // must come from the lifecycle state/path (finding A).
    const home = makeHome()
    const stateRoot = join(home, ".local", "share", "oh-my-rigel")
    const runtime = join(stateRoot, "versions", "1", "runtime")
    mkdirSync(stateRoot, { recursive: true })
    writeFileSync(join(stateRoot, "install-state.json"), `${JSON.stringify({ schema: 2, version: "1", pluginEntry: runtime }, null, 2)}\n`)
    const configFile = writeConfig(home, [runtime])

    // when
    const system = await runSystem(configFile, home)

    // then: a DISTINCT issue — registered but not resolvable — not "not registered"
    expect(system.status).toBe("fail")
    const issue = system.issues[0]
    expect(issue.severity).toBe("error")
    expect(issue.title).toContain("does not resolve")
    expect(issue.description).toContain(runtime)
  })

  test("#given no Rigel runtime registered #then SYSTEM fails as not registered", async () => {
    // given: only a foreign plugin entry
    const home = makeHome()
    const configFile = writeConfig(home, ["some-other-plugin"])

    // when
    const system = await runSystem(configFile, home)

    // then
    expect(system.status).toBe("fail")
    const issue = system.issues[0]
    expect(issue.severity).toBe("error")
    // the declared entry is surfaced so the diagnostic is actionable
    expect(`${issue.title} ${issue.description}`).toContain("some-other-plugin")
  })

  test("#given a foreign path shaped like versions/<n>/runtime outside every Rigel state root #then it is not treated as Rigel", async () => {
    // given: a plugin that merely happens to sit at a `versions/<n>/runtime`
    // path — no rigel-v2-native package.json, no lifecycle record, outside every
    // Rigel state root. The previous bare path-shape fallback classified ANY
    // such path as the Rigel runtime (false positive).
    const home = makeHome()
    const foreign = join(home, "foreign", "versions", "1", "runtime")
    mkdirSync(foreign, { recursive: true })
    const configFile = writeConfig(home, [foreign])

    // when
    const system = await runSystem(configFile, home)

    // then: "not registered" naming the declared foreign entry — never a
    // "registered but does not resolve" verdict for a non-Rigel plugin.
    expect(system.status).toBe("fail")
    const issue = system.issues[0]
    expect(issue.severity).toBe("error")
    expect(issue.title).toContain("not registered")
    expect(issue.description).toContain(foreign)
  })
})
