#!/usr/bin/env node
/**
 * Rigel V2 CLI: the command surface of the Oh My Rigel V2 distribution.
 *
 * This CLI is materialized into the isolated V2 laboratory deployment by
 * `profiles/gabo/materialize-v2-cli.mjs`, which `apply-v2-runtime-service.sh`
 * (the single authorized live V2 path) invokes on every refresh. The launcher
 * lands at `<labRoot>/rigel/bin/rigel-v2` and `<labHome>/.local/bin/rigel-v2`,
 * rooted entirely at the lab HOME/XDG. It is not distributed as a standalone
 * binary: running this source file directly proves nothing about the installed
 * surface.
 *
 * The CLI owns the ported command logic (argument validation, platform gating,
 * the star courtesy, worktree sweep, sg provisioning, capabilities refresh) and
 * delegates only the actual install or uninstall to the authorized lab refresh
 * wrapper and to the real adapter packages
 * (`@oh-my-opencode/omo-codex/install`, `@oh-my-opencode/omo-senpi/install`).
 * It never launches OpenCode, never executes the retired activation scripts,
 * and never touches V1 state.
 */
import { pathToFileURL } from "node:url"

import { defaultIo } from "./cli/rigel-v2-cli-io.mjs"
import { COMMANDS } from "./cli/rigel-v2-cli-registry.mjs"

export function commandIndex(commands = COMMANDS) {
  const index = new Map()
  for (const command of commands) {
    index.set(command.name, command)
    for (const alias of command.aliases ?? []) index.set(alias, command)
  }
  return index
}

export function helpText(commands = COMMANDS) {
  const lines = ["Rigel V2 CLI", "", "Usage: rigel-v2 <command> [options]", "", "Commands:"]
  for (const command of commands) lines.push(`  ${command.name.padEnd(28)} ${command.summary}`)
  lines.push("", "Run `rigel-v2 <command> --help` for command options.")
  return `${lines.join("\n")}\n`
}

export async function runRigelV2Cli(argv, io = defaultIo(), commands = COMMANDS) {
  const index = commandIndex(commands)
  const [first, ...rest] = argv
  if (!first || first === "help" || first === "--help" || first === "-h") {
    io.stdout.write(helpText(commands))
    return 0
  }
  if (first === "--version" || first === "-v") {
    const version = index.get("version")
    if (version) return await version.run([], io)
  }
  const command = index.get(first)
  if (!command) {
    io.stderr.write(`[rigel-v2] Unknown command: ${first}\n`)
    io.stdout.write(helpText(commands))
    return 1
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    io.stdout.write(`${command.usage ? `${command.usage}\n` : `${command.name}\n`}`)
    return 0
  }
  return await command.run(rest, io)
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runRigelV2Cli(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((error) => { console.error(error); process.exitCode = 1 })
}
