#!/usr/bin/env node
/**
 * Materializes the four remaining V1 builtin commands as a data-only manifest
 * for the native V2 command editor. The V1 owner is
 * `packages/omo-opencode/src/features/builtin-commands/commands.ts`; this
 * generator imports it directly so the deployed runtime carries the exact V1
 * template bodies (wrapper, team-mode addendum and placeholders included) and
 * cannot drift from the owner.
 *
 * `goal`, `ulw-execute` and `stop-continuation` are intentionally excluded:
 * `goal` and `ulw-execute` are already registered by the native runtime and
 * `stop-continuation` is delivered by the native prompt seam. Registering them
 * here would duplicate an existing command template.
 *
 * Run with Bun, because it imports the V1 TypeScript owner:
 *   bun run profiles/gabo/generate-v2-builtin-command-manifest.mjs
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadBuiltinCommands } from "../../packages/omo-opencode/src/features/builtin-commands/commands.ts"
import { rewriteLegacyDelegationToolExamples } from "./opencode/rigel-v2-native-prompt-tools.mjs"

/** The V1 builtin commands migrated by this surface, in V1 declaration order. */
export const BUILTIN_COMMAND_NAMES = Object.freeze(["refactor", "remove-ai-slops", "handoff", "hyperplan"])

const HEADER = "// Generated; do not edit. Source: packages/omo-opencode/src/features/builtin-commands/commands.ts\n"

/**
 * Build the manifest from the V1 owner. Both the base and the team-mode variant
 * are captured because V1 appends the team-mode addendum to `refactor` and
 * `remove-ai-slops` when team mode is enabled; the runtime selects the variant
 * from the materialized team_mode gate.
 */
export function buildBuiltinCommandManifest() {
  const base = loadBuiltinCommands(undefined, { teamModeEnabled: false })
  const team = loadBuiltinCommands(undefined, { teamModeEnabled: true })
  const commands = {}
  for (const name of BUILTIN_COMMAND_NAMES) {
    const baseDefinition = base[name]
    const teamDefinition = team[name]
    if (!baseDefinition || typeof baseDefinition.template !== "string") {
      throw new Error(`V1 builtin command is missing or has no template: ${name}`)
    }
    if (!teamDefinition || typeof teamDefinition.template !== "string") {
      throw new Error(`V1 builtin command has no team-mode template: ${name}`)
    }
    commands[name] = {
      description: typeof baseDefinition.description === "string" ? baseDefinition.description : "",
      template: rewriteLegacyDelegationToolExamples(baseDefinition.template),
      teamModeTemplate: rewriteLegacyDelegationToolExamples(teamDefinition.template),
    }
  }
  return { commands }
}

export function serializeBuiltinCommandManifest(manifest) {
  return `${HEADER}export default ${JSON.stringify(manifest, null, 2)}\n`
}

const isMain = typeof process.argv[1] === "string" && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const output = path.join(path.dirname(fileURLToPath(import.meta.url)), "opencode/rigel-v2-native-builtin-command-manifest.mjs")
  fs.writeFileSync(output, serializeBuiltinCommandManifest(buildBuiltinCommandManifest()))
  console.log(JSON.stringify({ output, commands: [...BUILTIN_COMMAND_NAMES] }))
}
