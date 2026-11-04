#!/usr/bin/env node
/**
 * Runs `run-session-authority-preflight.sh` against a DISPOSABLE Rigel-managed
 * installation instead of the invoking operator's home.
 *
 * The preflight asserts a complete managed Goal surface (goal gate `managed`,
 * one server shim, one CLI shim, both builtin-disable markers, and the
 * Rigel-owned Goal state path), and it reads that surface from `$HOME`. Invoked
 * bare from the acceptance suite it therefore graded the OPERATOR's real
 * installation, so a host without Rigel's managed shims failed an otherwise
 * valid laboratory run - the opposite of the suite's job, which is to validate
 * the checkout's own delivery.
 *
 * This driver prepares a real managed installation inside a disposable sandbox
 * through the productized installer (`rigel-v2-user-install.mjs install`), then
 * points the untouched preflight at it. The gate keeps its full strength: an
 * installation whose managed shape is incomplete still fails.
 *
 * The sandbox environment is built by `isolated-v2-env.mjs`, never composed by
 * hand: every inherited `XDG_`, `OPENCODE_`, `OMO_`, `SENPI_`, `PI_`, and
 * `RIGEL_` variable is stripped or rebuilt, so a host that exports (for example)
 * `OPENCODE_GOAL_STATE_PATH` cannot steer this run at the real installation.
 *
 * Usage: node run-session-authority-preflight-isolated.mjs
 * Exit: the preflight's own status (0 only when the managed shims are complete).
 */
import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { assertIsolatedV2Env, buildIsolatedV2Env } from "./isolated-v2-env.mjs"

const suiteDir = path.dirname(fileURLToPath(import.meta.url))
// The preflight is invoked from the repository root, the way its documented
// command line runs it: some of its behavior tests resolve fixtures relative to
// the working directory.
const repoRoot = path.resolve(suiteDir, "../..")
const installer = path.join(suiteDir, "rigel-v2-user-install.mjs")
const preflight = path.join(suiteDir, "run-session-authority-preflight.sh")

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-preflight-"))
let status = 1

try {
  const home = path.join(sandbox, "home")
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })

  const env = buildIsolatedV2Env({ sandbox, home })
  const configDir = path.join(env.XDG_CONFIG_HOME, "opencode")
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
  const configFile = path.join(configDir, "opencode.json")
  fs.writeFileSync(configFile, `${JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [] }, null, 2)}\n`, { mode: 0o600 })
  fs.writeFileSync(path.join(configDir, "cli.json"), `${JSON.stringify({ plugins: [] }, null, 2)}\n`, { mode: 0o600 })

  const installEnv = { ...env, RIGEL_V2_HOME: home, RIGEL_V2_CONFIG: configFile, RIGEL_V2_SG_PROVISION: "0" }
  const installed = childProcess.spawnSync(
    process.execPath,
    [installer, "install", "--version", "1", "--home", home, "--config", configFile, "--state", env.RIGEL_V2_USER_ROOT, "--json"],
    { cwd: repoRoot, env: installEnv, encoding: "utf8", timeout: 180_000 },
  )
  if (installed.status !== 0) {
    process.stderr.write(`disposable managed installation could not be prepared under ${sandbox}:\n${installed.stderr || installed.stdout}\n`)
    throw new Error("disposable managed installation failed")
  }

  // Positive proof before the graded run: the home, config, data, state, cache,
  // goal state, and (when known) the Rigel state root all resolve inside the
  // sandbox, and none of them touches the real installation.
  const proof = assertIsolatedV2Env(env, { sandbox, rigelStateRoot: env.RIGEL_V2_USER_ROOT })
  process.stdout.write(`session-authority preflight target: disposable managed installation at ${home}\n`)
  for (const line of proof.checks) process.stdout.write(`  ${line}\n`)
  process.stdout.write(`  RIGEL_V2_USER_ROOT=${env.RIGEL_V2_USER_ROOT}\n  RIGEL_V2_CONFIG=${configFile}\n`)

  const run = childProcess.spawnSync("bash", [preflight], { cwd: repoRoot, env: installEnv, stdio: "inherit", timeout: 900_000 })
  if (run.error) {
    process.stderr.write(`session-authority preflight could not run: ${run.error.message}\n`)
  }
  status = run.status ?? 1
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  status = 1
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true })
}

process.exit(status)
