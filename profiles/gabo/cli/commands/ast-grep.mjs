// Rigel V2 CLI `ast-grep`.
//
// Provisions the pinned `sg` binary the ast-grep skill consumes. Single strategy
// and single pin: `provisionSgBinary` over the pinned manifest
// (`SG_PINNED_VERSION` + per-platform sha256), the same strategy the install
// transaction uses. The vendored skill `install.sh` (no checksum) is
// deliberately NOT used.
import path from "node:path"

import { astGrepRuntimeDir, provisionSgBinary } from "../../rigel-v2-ast-grep-runtime.mjs"

import { fail, parseArgs, writeJson } from "../rigel-v2-cli-io.mjs"

function describeError(error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
  const message = error instanceof Error ? error.message : String(error)
  return code ? `${code}: ${message}` : message
}

async function defaultAstGrepInstall({ platform, arch, targetDir }) {
  try {
    await provisionSgBinary({ platform, arch, targetDir })
    return { kind: "succeeded" }
  } catch (error) {
    return { kind: "failed", reason: describeError(error) }
  }
}

function describeResult(result) {
  if (result?.kind === "succeeded") return null
  if (result?.kind === "timed-out") return "timed out after 30s"
  if (typeof result?.reason === "string" && result.reason.length > 0) return result.reason
  return typeof result?.kind === "string" ? result.kind : "unknown failure"
}

export const astGrepCommand = {
  name: "ast-grep",
  summary: "Provision the sg binary for the ast-grep skill",
  usage: "rigel-v2 ast-grep [--home <dir>] [--platform <p>] [--arch <a>] [--dry-run] [--json]",
  async run(argv, io) {
    const { options } = parseArgs(argv)
    const platform = options.platform !== undefined ? String(options.platform) : process.platform
    const arch = options.arch !== undefined ? String(options.arch) : process.arch
    const home = options.home !== undefined ? String(options.home) : io.home
    const baseDir = path.join(home, ".omo")
    const targetDir = astGrepRuntimeDir(baseDir, platform, arch)

    if (options["dry-run"] === true) {
      const plan = { platform, arch, targetDir }
      if (options.json === true) writeJson(io, { ok: true, dryRun: true, ...plan })
      else io.stdout.write(`ast-grep sg would be provisioned into ${targetDir}\n`)
      return 0
    }

    const installer = io.astGrepInstall ?? defaultAstGrepInstall
    const result = await installer({ platform, arch, targetDir })
    const failure = describeResult(result)
    if (failure !== null) return fail(io, `sg provisioning failed: ${failure}`)

    if (options.json === true) writeJson(io, { ok: true, targetDir })
    else io.stdout.write(`sg provisioned into ${targetDir}\n`)
    return 0
  },
}
