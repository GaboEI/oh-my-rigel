#!/usr/bin/env node
/**
 * Materializes the Rigel V2 CLI into the isolated V2 laboratory deployment.
 *
 * This is the ONLY vehicle that installs the CLI. It is invoked exclusively by
 * `profiles/gabo/apply-v2-runtime-service.sh` (the single authorized live V2
 * path). It copies the CLI entry + `cli/**` into `<labRoot>/rigel/cli/`, links
 * the workspace `node_modules` so `bun` resolves the adapter packages, and
 * writes an executable launcher under the lab's dedicated HOME/XDG
 * (`<labRoot>/rigel/bin/rigel-v2` and `<labHome>/.local/bin/rigel-v2`) whose
 * environment is rooted at the lab. It never touches V1 and never launches
 * OpenCode.
 *
 * After a fast-forward/merge, run the refresh + acceptance from the MAIN
 * checkout, not a temporary worktree: the launcher bakes RIGEL_V2_REPO_ROOT and
 * the node_modules symlink to the checkout it ran from, so an ephemeral worktree
 * path would break the installed CLI once removed.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// The home the guard protects is the one this process would use: `os.homedir()`
// on Windows ignores `HOME` and reads `USERPROFILE`, so a caller that scopes HOME
// to a lab (every isolation harness does) would otherwise have its V1 roots
// resolved to the operator's real profile and its refusals silently skipped.
const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir()

const sourceRoot = canonicalize(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."))
const labRoot = canonicalize(process.env.RIGEL_V2_LAB_ROOT || path.join(homeDir, ".local", "share", "opencode-v2-lab"))
const labHome = canonicalize(process.env.RIGEL_V2_HOME || path.join(labRoot, "home"))
const cliSource = path.join(sourceRoot, "profiles", "gabo")
const cliDest = path.join(labRoot, "rigel", "cli")
const binDir = path.join(labRoot, "rigel", "bin")
const launcher = path.join(binDir, "rigel-v2")
const homeLauncher = path.join(labHome, ".local", "bin", "rigel-v2")

const V1_ROOTS = [
  path.join(homeDir, ".config", "opencode"),
  path.join(homeDir, ".local", "share", "opencode"),
  path.join(homeDir, ".local", "share", "opencode-goal-plugin"),
  path.join(homeDir, ".cache", "opencode"),
].map(canonicalize)

// Canonicalize an absolute path: resolve `.`/`..` segments, then realpath the
// longest existing prefix so a relative path or a symlink into V1 cannot
// masquerade as the lab root.
function canonicalize(target) {
  const resolved = path.resolve(target)
  const suffix = []
  let current = resolved
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) break
    suffix.unshift(path.basename(current))
    current = parent
  }
  let real
  try {
    real = fs.realpathSync(current)
  } catch {
    real = current
  }
  return suffix.length > 0 ? path.join(real, ...suffix) : real
}

function fail(message) {
  console.error(`Rigel V2 CLI materialization refused: ${message}`)
  process.exit(1)
}

function under(child, parent) {
  return child === parent || child.startsWith(`${parent}${path.sep}`)
}

// Isolation guard, checked BEFORE any write: the canonical lab root must neither
// sit inside nor contain a V1 root, and every materialization target must be
// contained in the canonical lab root and never resolve under V1.
for (const v1 of V1_ROOTS) {
  if (under(labRoot, v1)) fail(`the lab root resolves under a V1 root (${v1}): ${labRoot}`)
  if (under(v1, labRoot)) fail(`the lab root contains a V1 root (${v1}): ${labRoot}`)
}
for (const [name, target] of Object.entries({ labHome, cliDest, binDir, launcher, homeLauncher })) {
  const canonical = canonicalize(target)
  if (!under(canonical, labRoot)) fail(`${name} escapes the isolated lab root: ${canonical}`)
  for (const v1 of V1_ROOTS) {
    if (under(canonical, v1)) fail(`${name} resolves under a V1 root (${v1}): ${canonical}`)
  }
}

function copyTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.isDirectory()) copyTree(from, to)
    else if (entry.isFile()) {
      fs.copyFileSync(from, to)
      fs.chmodSync(to, 0o600)
    }
  }
}

// 1. Stage the CLI entry + its command modules.
fs.rmSync(cliDest, { recursive: true, force: true })
fs.mkdirSync(cliDest, { recursive: true, mode: 0o700 })
fs.copyFileSync(path.join(cliSource, "rigel-v2-cli.mjs"), path.join(cliDest, "rigel-v2-cli.mjs"))
copyTree(path.join(cliSource, "cli"), path.join(cliDest, "cli"))
// 1b. Stage the native runtime modules the CLI command modules import as
// `../../opencode/*` and root helpers as `../../<name>`. The deployed entry sits
// at `rigel/cli/rigel-v2-cli.mjs` and its registry/commands under
// `rigel/cli/cli/`, so a command's `../../` resolves to `rigel/cli/`: the shared
// runtime tree and root helpers are staged there. This keeps the exact relative
// specifier valid in both the source checkout and the materialized deployment.
const cliDeployedBase = path.join(labRoot, "rigel", "cli")
const cliRuntimeSource = path.join(cliSource, "opencode")
if (fs.existsSync(cliRuntimeSource)) {
  copyTree(cliRuntimeSource, path.join(cliDeployedBase, "opencode"))
}
for (const helper of ["notification-activation-config.mjs"]) {
  const from = path.join(cliSource, helper)
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(cliDeployedBase, helper))
}

// 2. Link the workspace node_modules so bun resolves @oh-my-opencode/* adapters.
const nodeModules = path.join(cliDest, "node_modules")
fs.rmSync(nodeModules, { force: true })
fs.symlinkSync(path.join(sourceRoot, "node_modules"), nodeModules, "dir")

// 3. Launcher rooted entirely at the lab HOME/XDG.
fs.mkdirSync(binDir, { recursive: true, mode: 0o700 })
const launcherScript = `#!/usr/bin/env bash
# Rigel V2 CLI launcher. Materialized by apply-v2-runtime-service.sh; the
# environment is rooted at the isolated V2 laboratory. Never touches V1.
set -euo pipefail
lab_root="${labRoot}"
if ! command -v bun >/dev/null 2>&1; then
  echo "rigel-v2: bun is required to run the Rigel V2 CLI" >&2
  exit 127
fi
export HOME="$lab_root/home"
export XDG_CONFIG_HOME="$lab_root/config"
export XDG_DATA_HOME="$lab_root/data"
export XDG_STATE_HOME="$lab_root/state"
export XDG_CACHE_HOME="$lab_root/cache"
export OPENCODE_CONFIG_DIR="$lab_root/config/opencode"
export RIGEL_V2_LAB_ROOT="$lab_root"
export RIGEL_V2_HOME="$lab_root/home"
export RIGEL_V2_CONFIG="$lab_root/config/opencode/opencode.json"
export RIGEL_V2_REPO_ROOT="${sourceRoot}"
exec bun "$lab_root/rigel/cli/rigel-v2-cli.mjs" "$@"
`
fs.writeFileSync(launcher, launcherScript, { mode: 0o700 })
fs.chmodSync(launcher, 0o700)

// 4. Expose the same launcher under the lab home's user bin.
fs.mkdirSync(path.dirname(homeLauncher), { recursive: true, mode: 0o700 })
fs.rmSync(homeLauncher, { force: true })
fs.symlinkSync(launcher, homeLauncher)

console.log(
  JSON.stringify({ launcher, homeLauncher, cliDest, repoRoot: sourceRoot, labRoot }),
)
