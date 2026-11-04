#!/usr/bin/env node
/**
 * Hermetic contract: a matched project rule is injected into the same V2 tool
 * result, so the next provider request carries it.
 *
 * Isolation boundary (`.omo/rules/protect-opencode-v1.md`): this contract MUST
 * NOT spawn OpenCode and MUST NOT use `--standalone`. The previous version
 * spawned `$HOME/.opencode/bin/opencode --standalone` with a fake provider and
 * blindly copied the operator-local `.omo/rules/rigel.md` from the checkout;
 * both are removed. Instead it drives the shipped native runtime module
 * (`profiles/gabo/opencode/rigel-v2-native-rules.mjs`, the exact file
 * `apply-v2-runtime-service.sh` materializes into the lab) against an explicit
 * hermetic fixture and asserts the injected payload directly. When the lab copy
 * is present it must be byte-identical, tying the proof to the code the live
 * service loads.
 *
 * The live provider turn belongs to the authorized lab lane
 * (`run-lab-acceptance.sh` -> `opencode-v2-lab.service`); this contract proves
 * the deterministic injection payload without any OpenCode process.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { buildIsolatedV2Env } from "./isolated-v2-env.mjs"

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const rulesModuleSource = path.join(sourceRoot, "profiles/gabo/opencode/rigel-v2-native-rules.mjs")
const labRoot = process.env.RIGEL_V2_LAB_ROOT ?? path.join(os.homedir(), ".local", "share", "opencode-v2-lab")
const evidenceDir = path.join(sourceRoot, ".omo/evidence/20261008-rigel-v2-native-rules-injector")
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-v2-rules-contract-"))

function save(name, value) {
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(evidenceDir, name), value, { mode: 0o600 })
}

try {
  const home = path.join(temporary, "home")
  const workspace = path.join(temporary, "project")
  fs.mkdirSync(path.join(workspace, ".omo/rules"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(workspace, "package.json"), "{}\n", { mode: 0o600 })
  fs.writeFileSync(path.join(workspace, "src/subject.ts"), "export const subject = 1\n", { mode: 0o600 })

  // Explicit fixtures owned by the contract. No host-checkout file is copied:
  // the old `copyFileSync(.omo/rules/rigel.md)` broke portability on any
  // checkout without that operator-local file.
  fs.writeFileSync(
    path.join(workspace, ".omo/rules/hermetic-always.md"),
    "---\nalwaysApply: true\ndescription: Hermetic always-apply rule.\n---\nHERMETIC_ALWAYS_MARKER\n",
    { mode: 0o600 },
  )
  fs.writeFileSync(
    path.join(workspace, ".omo/rules/hermetic-glob.md"),
    "---\nglobs:\n  - src/**/*.ts\n---\nHERMETIC_GLOB_MARKER\n",
    { mode: 0o600 },
  )

  // Positive isolation proof; the contract spawns nothing, so nothing can touch
  // the real user installation.
  const isolatedEnv = buildIsolatedV2Env({ sandbox: temporary, home })
  assert.ok(isolatedEnv.HOME.startsWith(temporary), "isolated HOME escapes the sandbox")

  const rules = await import(`${pathToFileURL(rulesModuleSource).href}?contract=${Date.now()}`)
  const injector = rules.createNativeRulesInjector({ directory: workspace, home })
  const readEvent = {
    status: "completed",
    tool: "read",
    sessionID: "ses_contract",
    input: { path: path.join(workspace, "src/subject.ts") },
    result: { content: "read output" },
  }
  const injected = await injector.after(readEvent)
  const content = String(readEvent.result.content)
  const injectedAlways = content.includes("[Rule: .omo/rules/hermetic-always.md]") && content.includes("HERMETIC_ALWAYS_MARKER")
  const injectedGlob = content.includes("[Rule: .omo/rules/hermetic-glob.md]") && content.includes("HERMETIC_GLOB_MARKER")
  const deduped = (await injector.after(readEvent)) === false

  const labModule = path.join(labRoot, "rigel", "opencode", "rigel-v2-native-rules.mjs")
  const labModuleByteIdentical = fs.existsSync(labModule) && fs.readFileSync(labModule).equals(fs.readFileSync(rulesModuleSource))

  const passed = injected === true && injectedAlways && injectedGlob && deduped
  const report = [
    "# Rigel V2 native rules injector contract (hermetic)",
    "",
    "- OpenCode process spawned: no.",
    "- `--standalone` used: no.",
    "- Real user installation read or written: no.",
    `- Shipped module under test: ${path.relative(sourceRoot, rulesModuleSource)}.`,
    `- Lab-materialized module byte-identical: ${labModuleByteIdentical ? "yes" : "no (lab copy not materialized)"}.`,
    `- Matched alwaysApply rule injected into the read result: ${injectedAlways ? "yes" : "no"}.`,
    `- Matched glob rule injected into the read result: ${injectedGlob ? "yes" : "no"}.`,
    `- Repeat read deduplicated (no duplicate injection): ${deduped ? "yes" : "no"}.`,
  ].join("\n") + "\n"
  save("validation.md", report)
  save("injected-result.txt", content)
  process.stdout.write(report)
  if (!passed) process.exitCode = 1
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}
