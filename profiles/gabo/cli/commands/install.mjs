// Rigel V2 CLI `install`.
//
// Owns the ported install surface of this fork: platform validation, the
// native-dev opt-in gate, plan resolution and the star courtesy. It delegates
// the actual install to the real adapters
// (`@oh-my-opencode/omo-codex/install`, `@oh-my-opencode/omo-senpi/install`) and
// the real Rigel activation scripts. It never launches OpenCode.
import path from "node:path"
import { fileURLToPath } from "node:url"

import * as codexInstall from "@oh-my-opencode/omo-codex/install"
import * as senpiInstall from "@oh-my-opencode/omo-senpi/install"

import { exitCodeOf, fail, parseArgs, truthy, writeJson } from "../rigel-v2-cli-io.mjs"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")
// The ONLY authorized live V2 path is the lab refresh wrapper
// (`apply-v2-runtime-service.sh` on `opencode-v2-lab.service`). The fork never
// executes the retired activation scripts (`apply-v2-agent-layer.mjs`,
// `switch-live-plugin-to-native-v2.mjs`) directly from the CLI.
const AUTHORIZED_REFRESH = "apply-v2-runtime-service.sh"
const NATIVE_DEV_FLAGS = ["OMO_ENABLE_NATIVE_DEV_PLATFORM", "OMO_ENABLE_SENPI_PLATFORM"]
const PLATFORMS = ["opencode", "codex", "both", "native", "native-dev"]

const STAR_REPOSITORIES = {
  opencode: ["code-yeongyu/oh-my-openagent"],
  codex: ["code-yeongyu/oh-my-openagent", "code-yeongyu/lazycodex"],
  both: ["code-yeongyu/oh-my-openagent", "code-yeongyu/lazycodex"],
  native: ["code-yeongyu/oh-my-openagent", "code-yeongyu/lazycodex"],
  "native-dev": ["code-yeongyu/oh-my-openagent", "code-yeongyu/lazycodex"],
}

function isNativeDevEnabled(env) {
  return NATIVE_DEV_FLAGS.some((flag) => truthy(env[flag]))
}

function repoRoot(io) {
  return io.env.RIGEL_V2_REPO_ROOT ?? REPO_ROOT
}

function refreshScriptPath(io) {
  return path.join(repoRoot(io), "profiles", "gabo", AUTHORIZED_REFRESH)
}

function resolveSteps(io, platform) {
  const steps = []
  if (platform === "opencode" || platform === "both") {
    steps.push({ kind: "lab-refresh", path: refreshScriptPath(io) })
  }
  if (platform === "codex" || platform === "both") steps.push({ kind: "codex-installer" })
  if (platform === "native" || platform === "native-dev") steps.push({ kind: "senpi-installer" })
  return steps
}

function isolatedLabRoot(io) {
  return path.resolve(io.env.RIGEL_V2_LAB_ROOT ?? path.join(io.home, ".local", "share", "opencode-v2-lab"))
}

function isolatedLabHome(io) {
  return path.resolve(io.env.RIGEL_V2_HOME ?? path.join(isolatedLabRoot(io), "home"))
}

function isolatedLabConfig(io) {
  return path.resolve(io.env.RIGEL_V2_CONFIG ?? path.join(isolatedLabRoot(io), "config", "opencode", "opencode.json"))
}

// The opencode install must stay inside the isolated lab: pin the wrapper to the
// lab root/home/config and never forward caller-supplied paths.
function isolatedRefreshEnv(io) {
  return {
    ...io.env,
    RIGEL_V2_LAB_ROOT: isolatedLabRoot(io),
    RIGEL_V2_HOME: isolatedLabHome(io),
    RIGEL_V2_CONFIG: isolatedLabConfig(io),
  }
}

async function runStarWorkflow(io, platform) {
  const results = []
  for (const repository of STAR_REPOSITORIES[platform]) {
    try {
      io.spawn("gh", ["api", "--silent", "--method", "PUT", `/user/starred/${repository}`], { encoding: "utf8" })
      results.push({ repository, ok: true })
    } catch (error) {
      results.push({ repository, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
}

export const installCommand = {
  name: "install",
  summary: "Install the Rigel V2 surface for a platform",
  usage:
    "rigel-v2 install [--platform opencode|codex|both|native|native-dev] [--dry-run] [--json] [--star] [--home <dir>] [--config <file>] [--codex-home <dir>]",
  async run(argv, io) {
    const { options } = parseArgs(argv)
    const platform = options.platform === undefined ? "opencode" : String(options.platform)
    if (!PLATFORMS.includes(platform)) {
      return fail(io, `Unknown platform: ${platform}. Expected one of ${PLATFORMS.join(", ")}`)
    }
    if (platform === "native-dev" && !isNativeDevEnabled(io.env)) {
      return fail(
        io,
        "The native-dev platform requires OMO_ENABLE_NATIVE_DEV_PLATFORM=1 (legacy OMO_ENABLE_SENPI_PLATFORM accepted)",
      )
    }

    const steps = resolveSteps(io, platform)
    const dryRun = options["dry-run"] === true
    const starRepositories = options.star === true ? STAR_REPOSITORIES[platform] : []
    const codexHome = options["codex-home"] === undefined
      ? io.env.CODEX_HOME ?? path.join(io.home, ".codex")
      : String(options["codex-home"])

    if (dryRun) {
      if (options.json === true) {
        writeJson(io, { ok: true, platform, dryRun: true, steps, star: starRepositories })
        return 0
      }
      io.stdout.write(`Plan for platform ${platform}:\n`)
      for (const step of steps) {
        if (step.kind === "lab-refresh") io.stdout.write(`- run the authorized lab refresh: bash ${step.path}\n`)
        if (step.kind === "codex-installer") io.stdout.write(`- run the Codex installer into ${codexHome}\n`)
        if (step.kind === "senpi-installer") io.stdout.write(`- run the Senpi installer into ${io.home}\n`)
      }
      for (const repository of starRepositories) {
        io.stdout.write(`- star: gh api --silent --method PUT /user/starred/${repository}\n`)
      }
      return 0
    }

    const starResults = []
    if (platform === "opencode" || platform === "both") {
      if (options.home !== undefined && path.resolve(String(options.home)) !== isolatedLabHome(io)) {
        return fail(io, "--home cannot move the install outside the isolated lab home")
      }
      if (options.config !== undefined && path.resolve(String(options.config)) !== isolatedLabConfig(io)) {
        return fail(io, "--config cannot move the install outside the isolated lab config")
      }
      // Route through the single authorized lab refresh wrapper, pinned to the
      // isolated lab. The CLI never runs the retired activation scripts itself.
      const env = isolatedRefreshEnv(io)
      const result = io.spawn("bash", [refreshScriptPath(io)], { cwd: repoRoot(io), env, encoding: "utf8" })
      const code = exitCodeOf(result)
      if (code !== 0) {
        if (result?.stdout) io.stdout.write(result.stdout)
        if (result?.stderr) io.stderr.write(result.stderr)
        return code
      }
    }
    if (platform === "codex" || platform === "both") {
      const adapter = io.codexInstall ?? codexInstall
      await adapter.runCodexInstaller({ codexHome, homeDir: io.home })
    }
    if (platform === "native" || platform === "native-dev") {
      const adapter = io.senpiInstall ?? senpiInstall
      await adapter.runSenpiInstaller({ homeDir: io.home })
    }
    if (options.star === true) {
      starResults.push(...(await runStarWorkflow(io, platform)))
    }

    if (options.json === true) {
      const ok = starResults.every((entry) => entry.ok)
      writeJson(io, { ok, platform, dryRun: false, steps, star: starResults })
      return 0
    }
    io.stdout.write(`Installed platform ${platform}.\n`)
    return 0
  },
}
