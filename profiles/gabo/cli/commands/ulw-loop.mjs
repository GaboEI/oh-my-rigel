// Rigel V2 CLI `ulw-loop`.
//
// Resolves the Codex ulw-loop component over the same candidate set the Codex
// installer records, with an equivalent written here rather than imported from
// the V1 CLI owner. Resolution order mirrors the shipped behavior: a component
// bin on the local bin roots first, then the newest cached component CLI inside
// the Codex plugin cache, and finally the delegation sentinel that terminates
// the chain so a broken install cannot fork-bomb the host.
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"

import { fail, parseArgs, truthy, writeJson } from "../rigel-v2-cli-io.mjs"

export const ULW_LOOP_DELEGATION_SENTINEL = "OMO_ULW_LOOP_DELEGATED"

const COMPONENT_BIN_NAME = "omo-ulw-loop"
const CACHE_MARKETPLACE = "sisyphuslabs"
const CACHE_PLUGIN = "omo"

function codexHome(io) {
  return io.env.CODEX_HOME ?? path.join(io.home, ".codex")
}

function localBinCandidates(io) {
  const candidates = []
  if (typeof io.env.CODEX_LOCAL_BIN_DIR === "string" && io.env.CODEX_LOCAL_BIN_DIR.length > 0) {
    candidates.push(path.join(io.env.CODEX_LOCAL_BIN_DIR, COMPONENT_BIN_NAME))
  }
  candidates.push(path.join(io.home, ".local", "bin", COMPONENT_BIN_NAME))
  candidates.push(path.join(codexHome(io), "bin", COMPONENT_BIN_NAME))
  return candidates
}

function compareVersionNames(left, right) {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10))
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10))
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const leftValue = Number.isFinite(leftParts[index] ?? Number.NaN) ? leftParts[index] ?? 0 : 0
    const rightValue = Number.isFinite(rightParts[index] ?? Number.NaN) ? rightParts[index] ?? 0 : 0
    if (leftValue !== rightValue) return leftValue - rightValue
  }
  return left.localeCompare(right)
}

function findNewestCachedComponentCli(io) {
  const versionsRoot = path.join(codexHome(io), "plugins", "cache", CACHE_MARKETPLACE, CACHE_PLUGIN)
  if (!existsSync(versionsRoot)) return null
  const versions = readdirSync(versionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareVersionNames)
    .reverse()
  for (const version of versions) {
    const candidate = path.join(versionsRoot, version, "components", "ulw-loop", "dist", "cli.js")
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function resolveUlwLoopCommand(argv, io) {
  for (const candidate of localBinCandidates(io)) {
    if (existsSync(candidate)) return { executable: candidate, argsPrefix: [] }
  }
  const cachedCli = findNewestCachedComponentCli(io)
  if (cachedCli !== null) return { executable: process.execPath, argsPrefix: [cachedCli] }
  return null
}

export const ulwLoopCommand = {
  name: "ulw-loop",
  summary: "Resolve and print the Codex ulw-loop component command",
  usage: "rigel-v2 ulw-loop [--json]",
  async run(argv, io) {
    const { options } = parseArgs(argv)
    const delegated = truthy(io.env[ULW_LOOP_DELEGATION_SENTINEL])
    const resolved = delegated ? null : resolveUlwLoopCommand(argv, io)
    if (resolved === null) {
      if (delegated) {
        if (options.json === true) {
          writeJson(io, { delegated: true, command: null })
        } else {
          io.stdout.write("ulw-loop delegation is already active; nothing to resolve\n")
        }
        return 0
      }
      return fail(io, "Codex ulw-loop is not installed.")
    }
    if (options.json === true) {
      writeJson(io, { delegated: false, command: resolved })
    } else {
      writeJson(io, resolved)
    }
    return 0
  },
}
