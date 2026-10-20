/**
 * Prints the positive isolation proof required before any OpenCode launch, and
 * exits non-zero if any resolved state root can reach production V1.
 * Read-only: touches no V1 surface.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { assertLaunchGoalStateMatchesRuntime, assertSingleRigelRuntimeInLaunch, buildIsolatedV2Env, launchConfigSources, PROTECTED_V1_ROOTS, REAL_HOME } from "./isolated-v2-env.mjs"

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-isolation-proof-"))
const env = buildIsolatedV2Env({ sandbox })
const lines = []
lines.push(`# Isolation proof ${new Date().toISOString()}`)
lines.push(`real_home=${REAL_HOME}`)
lines.push(`sandbox=${sandbox}`)
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "OPENCODE_GOAL_STATE_PATH"]) {
  lines.push(`${key}=${env[key]}`)
}
lines.push(`stripped_env=${(env.__rigelStrippedEnvKeys ?? []).join(",")}`)
let leak = false
for (const protectedRoot of PROTECTED_V1_ROOTS) {
  const hits = Object.entries(env).filter(([, value]) => typeof value === "string" && (value === protectedRoot || value.startsWith(protectedRoot + path.sep)))
  const status = hits.length === 0 ? "clean" : `LEAK(${hits.map(([key]) => key).join(",")})`
  if (hits.length > 0) leak = true
  lines.push(`protected[${protectedRoot}]=${status}`)
}
const goalStore = path.join(REAL_HOME, ".local/share/opencode-goal-plugin/goals.json")
lines.push(`goal_state_is_production=${path.resolve(env.OPENCODE_GOAL_STATE_PATH) === goalStore}`)
if (path.resolve(env.OPENCODE_GOAL_STATE_PATH) === goalStore) leak = true
// The state roots above are necessary but not sufficient. The host merges every
// config source it can resolve, and a chain that declares TWO Rigel runtimes
// loads both plugins: the first registration keeps the tool names and the prompt
// seams, so the newer runtime never executes and the run proves nothing about
// it. Audit the chain the CURRENT shell would hand to the host, so a launch that
// is not safe to read fails here instead of producing plausible evidence.
const launchSources = launchConfigSources()
lines.push(`launch_config_sources=${launchSources.map((entry) => entry.source).join(",") || "none"}`)
let launchRuntimes = []
try {
  const chain = assertSingleRigelRuntimeInLaunch({ env: process.env })
  launchRuntimes = chain.runtimes
  lines.push(`rigel_runtimes_in_launch_config=${chain.runtimes.length}`)
  for (const runtime of chain.runtimes) lines.push(`rigel_runtime=${runtime}`)
} catch (error) {
  leak = true
  lines.push(`rigel_runtimes_in_launch_config=REFUSED`)
  lines.push(`rigel_runtime_collision=${error instanceof Error ? error.message : String(error)}`)
}
// One runtime is still not enough. The deployed runtime derives its state root
// from its own location and fails CLOSED when `OPENCODE_GOAL_STATE_PATH`
// escapes it: the host logs a WARN, loads the plugin with ZERO registrations
// (no tools, no prompt seam, no slash command) and keeps serving prompts, so the
// run proves nothing about the code it was supposed to exercise (row 55 host
// retest 3). Prove the agreement here, for the environment THIS shell launches.
try {
  const goalAudit = launchRuntimes.length > 0 ? assertLaunchGoalStateMatchesRuntime({ env: process.env }) : undefined
  if (goalAudit) {
    lines.push(`rigel_state_root=${goalAudit.stateRoots.join(",") || "none"}`)
    lines.push(`launch_goal_state_path=${goalAudit.goalStatePath ?? "unset(runtime installs its default)"}`)
    lines.push(`goal_state_within_rigel_state_root=${goalAudit.installedByRuntime ? "unset(runtime default)" : "true"}`)
  }
} catch (error) {
  leak = true
  lines.push(`goal_state_within_rigel_state_root=REFUSED`)
  lines.push(`goal_state_runtime_mismatch=${error instanceof Error ? error.message : String(error)}`)
}
lines.push(leak ? "verdict=UNSAFE" : "verdict=ISOLATED")
process.stdout.write(lines.join("\n") + "\n")
fs.rmSync(sandbox, { recursive: true, force: true })
if (leak) process.exit(1)
