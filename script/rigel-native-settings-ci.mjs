#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  assertIsolatedV2Env,
  buildIsolatedV2Env,
  PROTECTED_V1_ROOTS,
  REAL_HOME,
} from "../profiles/gabo/isolated-v2-env.mjs"

// CI gate for the native `/rigel_setting` surface.
//
// The suites below run inside a disposable sandbox built by
// `profiles/gabo/isolated-v2-env.mjs` (boundary: `.omo/rules/protect-opencode-v1.md`),
// never against the caller's HOME/XDG/OpenCode state. They are pinned by name so
// a rename makes this gate fail loudly instead of shrinking coverage: the broad
// `profiles/gabo/opencode` discovery run cannot notice a suite that stopped
// matching its glob.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** Settings descriptor/catalog, JSONC write, command, tool, abstinence and runtime-module discovery. */
export const NATIVE_SETTING_SUITES = Object.freeze([
  "profiles/gabo/opencode/rigel-v2-native-setting-abstinence.test.mjs",
  "profiles/gabo/opencode/rigel-v2-native-setting-catalog.test.mjs",
  "profiles/gabo/opencode/rigel-v2-native-setting-catalog.parity.test.mjs",
  "profiles/gabo/opencode/rigel-v2-native-setting-command.test.mjs",
  "profiles/gabo/opencode/rigel-v2-native-setting-tool.test.mjs",
  "profiles/gabo/opencode/rigel-v2-native-setting-write.test.mjs",
  "profiles/gabo/opencode/rigel-v2-native-jsonc-write.test.mjs",
  // Proves the command and tool are actually registered on the native runtime,
  // so the settings surface is reachable and not only unit-tested in isolation.
  "profiles/gabo/opencode/rigel-v2-native-runtime.test.mjs",
  "profiles/gabo/native-runtime-modules.test.mjs",
])

const SANDBOX_SUBDIRECTORIES = ["home", "config", "data", "state", "cache"]

/** Suites that are pinned here but no longer exist: a rename must not silently drop the gate. */
export function missingSuites(root = REPO_ROOT) {
  return NATIVE_SETTING_SUITES.filter((relativePath) => !fs.existsSync(path.join(root, relativePath)))
}

/**
 * The positive isolation proof, one `key=value` line each. `assertIsolatedV2Env`
 * already threw for every violation the builder can detect, so these lines exist
 * to be read in the job log and to refuse any protected root that a future
 * environment change would smuggle back in.
 */
function isolationReport(env, sandbox) {
  const report = assertIsolatedV2Env(env, { sandbox, rigelStateRoot: env.RIGEL_V2_USER_ROOT })
  const lines = [`real_home=${REAL_HOME}`, `sandbox=${report.sandbox}`, ...report.checks]
  lines.push(`goal_state_is_production=${path.resolve(env.OPENCODE_GOAL_STATE_PATH) === path.join(REAL_HOME, ".local/share/opencode-goal-plugin/goals.json")}`)
  lines.push(`stripped_env=${(env.__rigelStrippedEnvKeys ?? []).join(",")}`)
  for (const protectedRoot of PROTECTED_V1_ROOTS) {
    const leaks = Object.entries(env)
      .filter(([, value]) => typeof value === "string" && (value === protectedRoot || value.startsWith(protectedRoot + path.sep)))
      .map(([key]) => key)
    lines.push(`protected[${protectedRoot}]=${leaks.length === 0 ? "clean" : `LEAK(${leaks.join(",")})`}`)
    if (leaks.length > 0) {
      throw new Error(`isolation violation: ${leaks.join(",")} still resolve into the protected surface ${protectedRoot}`)
    }
  }
  return lines
}

/** Runs the focused suites with the sandbox environment and returns the test process exit code. */
export function runFocusedSuites(root = REPO_ROOT) {
  const missing = missingSuites(root)
  if (missing.length > 0) {
    process.stderr.write(`::error::native setting suites are listed for CI but missing: ${missing.join(", ")}\n`)
    return 1
  }

  // Outside the real home on purpose: `buildIsolatedV2Env` refuses a sandbox
  // inside it, and the default temp root is already outside on every CI runner.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-native-settings-ci-"))
  try {
    for (const directory of SANDBOX_SUBDIRECTORIES) {
      fs.mkdirSync(path.join(sandbox, directory), { recursive: true })
    }
    const env = buildIsolatedV2Env({ sandbox })
    process.stdout.write(`${isolationReport(env, sandbox).join("\n")}\n`)

    // `bun` resolves through the inherited PATH, the one variable this gate
    // shares with the caller; everything state-bearing is sandbox-scoped.
    const result = spawnSync("bun", ["test", "--timeout", "20000", ...NATIVE_SETTING_SUITES], {
      cwd: root,
      env,
      stdio: "inherit",
    })
    if (result.error !== undefined) {
      process.stderr.write(`::error::failed to spawn bun test: ${result.error.message}\n`)
      return 1
    }
    if (result.signal !== null) {
      process.stderr.write(`::error::bun test was killed by ${result.signal}\n`)
      return 1
    }
    return result.status ?? 1
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runFocusedSuites()
}
