#!/usr/bin/env node
/**
 * P3 atomicity contract for the Rigel V2 user lifecycle.
 *
 * Proves that `install`, `upgrade`, `rollback` and `uninstall` are compensating
 * transactions over `opencode.json`, `cli.json` and `install-state.json`: a
 * failure injected at EVERY write boundary (`RIGEL_V2_FAIL_AT`) must leave the
 * three files byte-identical to their pre-operation bytes and must not leave a
 * partially materialised version directory behind.
 *
 * Hermetic: no OpenCode spawn, no Docker, no `--standalone`; the isolated
 * HOME/XDG roots are asserted clear of V1 before and after.
 */
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { buildProtectedManifest, diffProtectedManifests } from "./v1-protected-surfaces.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const installer = path.join(root, "profiles/gabo/rigel-v2-user-install.mjs")
const evidenceDir = path.join(root, ".omo/evidence/20261008-production-readiness/rotation5-transaction")
const checks = []
const created = []

function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? "" : String(detail) })
}
function sha(file) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") } catch { return null }
}
function run(args, { failAt } = {}) {
  const env = { ...process.env, RIGEL_V2_SG_PROVISION: "0" }
  if (failAt === undefined) delete env.RIGEL_V2_FAIL_AT
  else env.RIGEL_V2_FAIL_AT = failAt
  return spawnSync(process.execPath, [installer, ...args], { cwd: root, encoding: "utf8", timeout: 180_000, env })
}

const v1Config = path.join(os.homedir(), ".config", "opencode", "opencode.json")
const v1Before = { config: sha(v1Config), protected: buildProtectedManifest(os.homedir()) }

try {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-user-txn-"))
  created.push(base)
  const home = path.join(base, "home")
  const configDir = path.join(base, "config", "opencode")
  const configFile = path.join(configDir, "opencode.json")
  const cliFile = path.join(configDir, "cli.json")
  const stateRoot = path.join(base, "state")
  const stateFile = path.join(stateRoot, "install-state.json")
  const skillsStateFile = path.join(home, ".local", "share", "oh-my-rigel", "skills-v2.json")
  for (const dir of [home, configDir, stateRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(configFile, `${JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "rigel-fixture/fixture", plugin: ["rigel-foreign-plugin"] }, null, 2)}\n`, { mode: 0o600 })
  fs.writeFileSync(cliFile, `${JSON.stringify({ plugins: ["rigel-foreign-cli-plugin"] }, null, 2)}\n`, { mode: 0o600 })

  const v1Source = path.join(base, "runtime-v1")
  const v2Source = path.join(base, "runtime-v2")
  fs.cpSync(path.join(root, "profiles/gabo/opencode"), v1Source, { recursive: true })
  fs.cpSync(v1Source, v2Source, { recursive: true })
  fs.writeFileSync(path.join(v2Source, "rigel-v2-upgrade-probe.mjs"), "export const RIGEL_V2_UPGRADE_PROBE = \"v2\"\n", { mode: 0o600 })
  fs.appendFileSync(path.join(v2Source, "rigel-v2-native.mjs"), "\nexport * from \"./rigel-v2-upgrade-probe.mjs\"\n")

  const common = ["--home", home, "--config", configFile, "--state", stateRoot, "--json"]
  const installV1 = ["install", "--version", "1", "--runtime-source", v1Source, ...common]
  const upgradeV2 = ["upgrade", "--version", "2", "--runtime-source", v2Source, ...common]

  const snapshot = () => ({
    config: fs.readFileSync(configFile),
    cli: fs.readFileSync(cliFile),
    state: fs.existsSync(stateFile) ? fs.readFileSync(stateFile) : null,
    skills: fs.existsSync(skillsStateFile) ? fs.readFileSync(skillsStateFile) : null,
  })
  const assertRestored = (label, before) => {
    check(`${label}.configByteIdentical`, Buffer.compare(fs.readFileSync(configFile), before.config) === 0)
    check(`${label}.cliByteIdentical`, Buffer.compare(fs.readFileSync(cliFile), before.cli) === 0)
    const stateNow = fs.existsSync(stateFile) ? fs.readFileSync(stateFile) : null
    check(`${label}.stateByteIdentical`, before.state === null ? stateNow === null : stateNow !== null && Buffer.compare(stateNow, before.state) === 0)
    const skillsNow = fs.existsSync(skillsStateFile) ? fs.readFileSync(skillsStateFile) : null
    check(`${label}.skillsByteIdentical`, before.skills === null ? skillsNow === null : skillsNow !== null && Buffer.compare(skillsNow, before.skills) === 0)
  }

  // ------------------------------------------------------- install boundaries
  for (const boundary of ["install:after-runtime", "provision:after-astgrep", "install:after-state"]) {
    const before = snapshot()
    const result = run(installV1, { failAt: boundary })
    check(`${boundary}.refused`, result.status !== 0, `status=${result.status}`)
    assertRestored(boundary, before)
    check(`${boundary}.noPartialVersion`, !fs.existsSync(path.join(stateRoot, "versions", "1")))
  }
  // A real install now, so the next phases have a baseline.
  check("install.baseline.ok", run(installV1).status === 0)

  // ------------------------------------------------------- upgrade boundaries
  for (const boundary of ["upgrade:after-runtime", "provision:after-astgrep", "upgrade:after-state"]) {
    const before = snapshot()
    const result = run(upgradeV2, { failAt: boundary })
    check(`${boundary}.refused`, result.status !== 0, `status=${result.status}`)
    assertRestored(boundary, before)
    check(`${boundary}.noPartialVersion`, !fs.existsSync(path.join(stateRoot, "versions", "2")))
  }
  check("upgrade.baseline.ok", run(upgradeV2).status === 0)

  // ------------------------------------------------------ rollback boundaries
  for (const boundary of ["rollback:after-config", "rollback:after-cli", "rollback:after-state"]) {
    const before = snapshot()
    const result = run(["rollback", ...common], { failAt: boundary })
    check(`${boundary}.refused`, result.status !== 0, `status=${result.status}`)
    assertRestored(boundary, before)
  }
  check("rollback.baseline.ok", run(["rollback", ...common]).status === 0)
  const stateAfterRollback = JSON.parse(fs.readFileSync(stateFile, "utf8"))
  check("rollback.baseline.versionRestored", stateAfterRollback.version === "1")

  // ----------------------------------------------------- uninstall boundaries
  for (const boundary of ["uninstall:after-config", "uninstall:after-versions", "uninstall:after-skills", "uninstall:after-state"]) {
    const before = snapshot()
    const result = run(["uninstall", ...common], { failAt: boundary })
    check(`${boundary}.refused`, result.status !== 0, `status=${result.status}`)
    assertRestored(boundary, before)
    check(`${boundary}.versionsRestored`, fs.existsSync(path.join(stateRoot, "versions", "1", "runtime", "index.js")))
    check(`${boundary}.statusStillGreen`, run(["status", ...common]).status === 0)
  }
  const uninstall = run(["uninstall", ...common])
  check("uninstall.baseline.ok", uninstall.status === 0)
  check("uninstall.baseline.removed", !fs.existsSync(stateFile) && !fs.existsSync(path.join(stateRoot, "versions")))
} finally {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true })
}

const v1After = { config: sha(v1Config), protected: buildProtectedManifest(os.homedir()) }
const protectedDiff = diffProtectedManifests(v1Before.protected, v1After.protected)
check("v1.untouched", v1Before.config === v1After.config && protectedDiff.added.length === 0 && protectedDiff.removed.length === 0 && protectedDiff.changed.length === 0, JSON.stringify(protectedDiff))

const failed = checks.filter((entry) => !entry.pass)
fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
fs.writeFileSync(path.join(evidenceDir, "transaction-contract.json"), `${JSON.stringify({ spawnedOpenCode: false, dockerUsed: false, standaloneUsed: false, checks, failed: failed.map((entry) => entry.name) }, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify({ passed: checks.length - failed.length, total: checks.length, failed: failed.map((entry) => entry.name) }, null, 2))
if (failed.length > 0) process.exitCode = 1
