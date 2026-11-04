#!/usr/bin/env bun
/**
 * Acceptance for the INSTALLED Rigel V2 CLI.
 *
 * It invokes the launcher materialized into the V2 laboratory by
 * `apply-v2-runtime-service.sh` (`<labRoot>/rigel/bin/rigel-v2`, exposed at
 * `<labHome>/.local/bin/rigel-v2`) - NOT the source file. It demonstrates help
 * and version, positive and negative results of the applicable commands, that
 * the CLI resolves only inside the lab (never the real user installation), and
 * that the real installation stays byte-identical. It never launches OpenCode and
 * never uses a container runner.
 *
 * Usage: bun profiles/gabo/qa-v2-cli-installed.mjs
 */
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"

import { buildProtectedManifest, diffProtectedManifests } from "./v1-protected-surfaces.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const labRoot = process.env.RIGEL_V2_LAB_ROOT || path.join(os.homedir(), ".local", "share", "opencode-v2-lab")
const labHome = process.env.RIGEL_V2_HOME || path.join(labRoot, "home")
const launcher = path.join(labRoot, "rigel", "bin", "rigel-v2")
const homeLauncher = path.join(labHome, ".local", "bin", "rigel-v2")
const evidenceDir = path.join(root, ".omo/evidence/20261007-t38-coverage-guards")
const V1_ROOTS = [
  path.join(os.homedir(), ".config", "opencode"),
  path.join(os.homedir(), ".local", "share", "opencode"),
  path.join(os.homedir(), ".local", "share", "opencode-goal-plugin"),
  path.join(os.homedir(), ".cache", "opencode"),
]
const V1_CONFIG = path.join(os.homedir(), ".config", "opencode", "opencode.json")
const created = []

function skip(reason) {
  console.log(`Rigel V2 CLI acceptance: SKIP (${reason})`)
  process.exit(0)
}
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  created.push(dir)
  return dir
}
function sha(file) {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex")
  } catch {
    return null
  }
}
function cli(args, env = {}) {
  const result = spawnSync(launcher, args, { encoding: "utf8", env: { ...process.env, ...env }, timeout: 120_000 })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

// Path-segment containment: /a/opencode must never match /a/opencode-v2-lab.
function under(child, parent) {
  return child === parent || child.startsWith(`${parent}${path.sep}`)
}

// Async variant keeps this process's event loop free so an in-process stub
// server can serve the spawned launcher.
function cliAsync(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(launcher, args, { env: { ...process.env, ...env } })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("close", (status) => resolve({ status, stdout, stderr }))
  })
}

if (!fs.existsSync(launcher)) skip(`launcher not materialized at ${launcher}; run apply-v2-runtime-service.sh`)

const checks = []
const beforeConfig = sha(V1_CONFIG)
const beforeProtected = buildProtectedManifest(os.homedir())

function check(name, pass, detail) {
  checks.push({ name, pass, detail })
}

// 1. The installed launcher lives under the lab, never the real installation.
check("launcher.underLabRoot", under(launcher, labRoot), launcher)
check("launcher.homeExposed", fs.existsSync(homeLauncher), homeLauncher)
for (const v1 of V1_ROOTS) check(`launcher.notUnderV1:${path.basename(v1)}`, !under(launcher, v1), v1)

// 2. help + version from the installed CLI.
const help = cli(["--help"])
check("help", help.status === 0 && help.stdout.includes("install") && help.stdout.includes("worktree-sweep"), help.stdout.split("\n")[0])
const version = cli(["version"])
check("version", version.status === 0 && /oh-my-rigel v\d+\.\d+\.\d+/.test(version.stdout), version.stdout.trim())

// 3. Positives + negatives of the applicable commands.
const badPlatform = cli(["install", "--platform=bogus", "--dry-run"])
check("install.unknownPlatformRefused", badPlatform.status === 1, `${badPlatform.stdout}${badPlatform.stderr}`.trim().slice(0, 120))
const nativeDevNoFlag = cli(["install", "--platform=native-dev", "--dry-run"], { OMO_ENABLE_NATIVE_DEV_PLATFORM: "" })
check("install.nativeDevRefusedWithoutFlag", nativeDevNoFlag.status === 1, "exit 1 expected")
const nativeDevWithFlag = cli(["install", "--platform=native-dev", "--dry-run", "--json"], { OMO_ENABLE_NATIVE_DEV_PLATFORM: "1" })
check("install.nativeDevWithFlag", nativeDevWithFlag.status === 0 && nativeDevWithFlag.stdout.includes("native-dev"), "exit 0 expected")
const opencodePlan = cli(["install", "--dry-run", "--json"])
check("install.opencodePlanUsesAuthorizedRefresh", opencodePlan.status === 0 && opencodePlan.stdout.includes("apply-v2-runtime-service.sh"), opencodePlan.stdout.slice(0, 160))
check("install.opencodePlanHasNoRetiredScripts", !opencodePlan.stdout.includes("apply-v2-agent-layer") && !opencodePlan.stdout.includes("switch-live-plugin"), "no retired scripts")
const uninstallPlan = cli(["uninstall", "--dry-run", "--json"])
const uninstallConfig = (() => {
  try {
    const steps = JSON.parse(uninstallPlan.stdout).steps
    return steps.find((step) => step.kind === "unregister-runtime")?.config ?? ""
  } catch {
    return ""
  }
})()
check("uninstall.planResolvesToLab", uninstallPlan.status === 0 && under(uninstallConfig, labRoot), uninstallConfig || uninstallPlan.stdout.slice(0, 120))
check("uninstall.planNeverV1", !under(uninstallConfig, path.dirname(V1_CONFIG)), uninstallConfig || "no config")

const ulwLoop = cli(["ulw-loop"], { CODEX_LOCAL_BIN_DIR: tempDir("rigel-cli-bin-") })
check("ulwLoop.runs", [0, 1].includes(ulwLoop.status) && `${ulwLoop.stdout}${ulwLoop.stderr}`.length > 0, `exit ${ulwLoop.status}`)

const repo = tempDir("rigel-cli-repo-")
const git = (args) => spawnSync("git", args, { encoding: "utf8" })
git(["init", "-q", repo])
git(["-C", repo, "config", "user.email", "t@t"])
git(["-C", repo, "config", "user.name", "t"])
fs.writeFileSync(path.join(repo, "a.txt"), "a\n")
git(["-C", repo, "add", "."])
git(["-C", repo, "commit", "-qm", "init"])
git(["-C", repo, "worktree", "add", "-q", path.join(repo, ".wt", "feat"), "-b", "feat"])
const sweep = cli(["worktree-sweep", "--repo", repo, "--dry-run", "--json"])
check("worktreeSweep.realRepo", sweep.status === 0 && JSON.parse(sweep.stdout).repos.length === 1, sweep.stdout.slice(0, 120))
const notRepo = cli(["worktree-sweep", "--repo", tempDir("rigel-cli-nonrepo-"), "--json"])
check("worktreeSweep.nonRepoRefused", notRepo.status === 1, `exit ${notRepo.status}`)

const astGrep = cli(["ast-grep", "--dry-run", "--json"])
check("astGrep.dryRun", astGrep.status === 0 && astGrep.stdout.includes("ast-grep"), astGrep.stdout.slice(0, 120))

// 3b. T25 commands: get-local-version, doctor, boulder (driven from the installed
// launcher, not the source file).
const glv = cli(["get-local-version", "--json"])
let glvPayload = null
try { glvPayload = JSON.parse(glv.stdout) } catch {}
check(
  "getLocalVersion.jsonShape",
  [0, 1].includes(glv.status) && glvPayload !== null && typeof glvPayload.status === "string" && "currentVersion" in glvPayload && "channel" in glvPayload,
  glv.stdout.slice(0, 140) || `exit ${glv.status}`,
)
const glvDown = cli(["get-local-version", "--registry", "http://127.0.0.1:9", "--json"])
check("getLocalVersion.unreachableDegrades", glvDown.status === 1, `exit ${glvDown.status}`)

const doctor = cli(["doctor", "--json"])
let doctorPayload = null
try { doctorPayload = JSON.parse(doctor.stdout) } catch {}
check(
  "doctor.jsonShape",
  doctorPayload !== null && Array.isArray(doctorPayload.results) && doctorPayload.results.length === 4 && typeof doctorPayload.exitCode === "number",
  doctor.stdout.slice(0, 140) || `exit ${doctor.status}`,
)

const boulderDir = tempDir("rigel-cli-boulder-")
const boulderMissing = cli(["boulder", "--directory", boulderDir, "--json"])
check("boulder.missingStateRefused", boulderMissing.status === 1, `exit ${boulderMissing.status}`)
fs.mkdirSync(path.join(boulderDir, ".omo"), { recursive: true })
fs.writeFileSync(
  path.join(boulderDir, ".omo", "boulder.json"),
  JSON.stringify({
    schema_version: 2,
    active_work_id: "plan-1",
    works: {
      "plan-1": {
        work_id: "plan-1",
        plan_name: "plan",
        active_plan: "plan.md",
        status: "active",
        started_at: new Date().toISOString(),
        session_ids: ["opencode:ses_1"],
      },
    },
  }),
)
const boulderOk = cli(["boulder", "--directory", boulderDir, "--json"])
check("boulder.readsState", boulderOk.status === 0 && boulderOk.stdout.includes("works"), boulderOk.stdout.slice(0, 140) || `exit ${boulderOk.status}`)

// 4. refresh-model-capabilities positive against a stub host.
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" })
  response.end(JSON.stringify({ data: [{ id: "m1" }] }))
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const { port } = server.address()
const out = path.join(tempDir("rigel-cli-cap-"), "cap.json")
const refresh = await cliAsync(["refresh-model-capabilities", "--host", `http://127.0.0.1:${port}`, "--out", out, "--json"])
server.close()
check("refresh.writesSnapshot", refresh.status === 0 && fs.existsSync(out) && JSON.parse(fs.readFileSync(out, "utf8")).modelCount === 1, refresh.stdout.slice(0, 120))
const refreshDown = cli(["refresh-model-capabilities", "--host", "http://127.0.0.1:9", "--out", path.join(tempDir("rigel-cli-cap-"), "cap.json")])
check("refresh.unreachableRefused", refreshDown.status === 1, `exit ${refreshDown.status}`)

// 5. The real user installation stays byte-identical.
const afterConfig = sha(V1_CONFIG)
const afterProtected = buildProtectedManifest(os.homedir())
check("v1.configByteIdentical", beforeConfig === afterConfig, `${String(beforeConfig).slice(0, 16)} -> ${String(afterConfig).slice(0, 16)}`)
const protectedDiff = diffProtectedManifests(beforeProtected, afterProtected)
const protectedClean = protectedDiff.added.length === 0 && protectedDiff.removed.length === 0 && protectedDiff.changed.length === 0
check("v1.protectedSurfacesUnchanged", protectedClean, protectedClean ? `${Object.keys(afterProtected).length} protected files unchanged` : JSON.stringify(protectedDiff))

const failed = checks.filter((entry) => !entry.pass).map((entry) => entry.name)
const report = { launcher, homeLauncher, labRoot, spawnedOpenCode: false, dockerUsed: false, v1Config: { before: beforeConfig, after: afterConfig }, v1Protected: { files: Object.keys(afterProtected).length, clean: protectedClean }, checks, failed }
fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
fs.writeFileSync(path.join(evidenceDir, "cli-installed-verdicts.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })

for (const dir of created) fs.rmSync(dir, { recursive: true, force: true })

console.log(JSON.stringify({ launcher, passed: checks.length - failed.length, total: checks.length, failed }, null, 2))
if (failed.length > 0) {
  console.error(`Rigel V2 CLI acceptance FAILED: ${failed.join(", ")}`)
  process.exitCode = 1
} else {
  console.log(`Rigel V2 CLI acceptance PASS (${checks.length} checks, installed launcher)`)
}
