import { describe, test, expect } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

/**
 * Strip comments before scanning, so a commented-out registration is never
 * mistaken for a live one. `//` preceded by `:` (a URL) is preserved.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/gm, "$1")
}

type CommandRegistration = { receiver: string; verb: string }

/**
 * Every `.command(...)` registration in the source, with the receiver it is chained
 * onto. The public product surface is the root `program` chain, so a nested group
 * that legitimately owns a `run` verb (e.g. `oauth.command("run")`) must not trip the
 * F72 guard, while any retired top-level spelling must. The receiver is resolved from
 * the same line (`program.command(`) or, for the multi-line chain Commander is written
 * in here (`program\n  .name(...)\n  .command(...)`), from the nearest preceding
 * identifier line — otherwise a `run` added further down a chain would escape.
 */
function commandRegistrations(source: string): CommandRegistration[] {
  const code = stripComments(source)
  const registrations: CommandRegistration[] = []
  for (const match of code.matchAll(/\.command\(\s*["'`]([^"'`]*)["'`]/g)) {
    const before = code.slice(0, match.index)
    const inlineReceiver = before.match(/([A-Za-z_$][\w$]*)[ \t]*$/)
    const chainRoot = [
      ...before.matchAll(
        /(?:^|\n)[ \t]*(?:(?:return|const|let|var)[ \t]+)?([A-Za-z_$][\w$]*)[ \t]*\n/g,
      ),
    ].pop()
    registrations.push({
      receiver: inlineReceiver?.[1] ?? chainRoot?.[1] ?? "<unresolved>",
      verb: match[1],
    })
  }
  return registrations
}

/** Verbs registered directly on the root `program` object — and only that receiver. */
function publicProgramVerbs(source: string): string[] {
  return commandRegistrations(source)
    .filter((registration) => registration.receiver === "program")
    .map((registration) => registration.verb)
}

/**
 * Receivers that are not the root `program` chain: nested command groups. Reported so
 * the guard's blind spot stays closed — a new, unrecognised receiver fails the test
 * instead of silently hiding a `run` from the scan.
 */
function nestedCommandReceivers(source: string): string[] {
  return commandRegistrations(source)
    .filter((registration) => registration.receiver !== "program")
    .map((registration) => registration.receiver)
}

/**
 * A retired `run` verb, in any spelling it ever shipped: bare `run`, and the
 * `run <message>` form that took a prompt. The negative lookahead keeps real verbs
 * such as `runner` out of the match.
 */
function retiredRunVerbs(source: string): string[] {
  return publicProgramVerbs(source).filter((verb) => /^run(?![a-z0-9-])/.test(verb))
}

describe("cli-program", () => {
  test("install command exposes 'setup' as an alias so the historical install path keeps working", async () => {
    // given
    const cliProgramSource = await readFile(
      path.resolve(import.meta.dir, "cli-program.ts"),
      "utf-8",
    )

    // when
    const installBlock = cliProgramSource.match(
      /program\s*\n\s*\.command\("install"\)([\s\S]*?)\.action\(/,
    )

    // then
    expect(installBlock).not.toBeNull()
    expect(installBlock?.[1]).toContain('.alias("setup")')
  })

  test("cleanup command exposes Codex cleanup for lazycodex migrations", async () => {
    // given
    const cliProgramSource = await readFile(
      path.resolve(import.meta.dir, "cleanup-command.ts"),
      "utf-8",
    )

    // when
    const cleanupBlock = cliProgramSource.match(
      /program\s*\n\s*\.command\("cleanup"\)([\s\S]*?)\.action\(/,
    )

    // then
    expect(cleanupBlock).not.toBeNull()
    expect(cleanupBlock?.[1]).toContain('new Option("--platform <platform>"')
    expect(cleanupBlock?.[1]).toContain('.choices(["codex"])')
    expect(cleanupBlock?.[1]).toContain("--codex-home")
    expect(cleanupBlock?.[1]).toContain("--project")
  })

  test("cleanup command exposes uninstall as the user-facing alias", async () => {
    // given
    const cliProgramSource = await readFile(
      path.resolve(import.meta.dir, "cleanup-command.ts"),
      "utf-8",
    )

    // when
    const cleanupBlock = cliProgramSource.match(
      /program\s*\n\s*\.command\("cleanup"\)([\s\S]*?)\.action\(/,
    )

    // then
    expect(cleanupBlock).not.toBeNull()
    expect(cleanupBlock?.[1]).toContain('.alias("uninstall")')
  })

  test("retired config command is absent from the public surface", async () => {
    // given
    const cliProgramSource = await readFile(
      path.resolve(import.meta.dir, "cli-program.ts"),
      "utf-8",
    )

    // when
    const configGroup = cliProgramSource.match(/\.command\("config"\)/)
    const configMigrateImport = cliProgramSource.match(/from\s+"\.\/config-migrate"/)
    const configMigrateSymbol = cliProgramSource.match(/\brunConfigMigrate\b/)

    // then
    // PR2/F71 contract: legacy config migration is automatic at plugin startup, Senpi startup,
    // Codex startup, and install. No public `config` group may reappear, and neither the deleted
    // module nor its entry symbol may be imported again — the absence is guarded exactly like
    // F72 guards `./run`, so a silent reintroduction cannot pass as green.
    expect(configGroup).toBeNull()
    expect(configMigrateImport).toBeNull()
    expect(configMigrateSymbol).toBeNull()
  })

  test("retired run command is absent from the public surface", async () => {
    // given
    const publicCliSources = [
      "cli-program.ts",
      "runtime-commands.ts",
      "cleanup-command.ts",
      path.join("mcp-oauth", "index.ts"),
    ]
    const sources = new Map<string, string>()
    for (const relative of publicCliSources) {
      sources.set(relative, await readFile(path.resolve(import.meta.dir, relative), "utf-8"))
    }
    const cliProgramSource = sources.get("cli-program.ts") as string

    // when
    const retired = [...sources].flatMap(([relative, source]) =>
      retiredRunVerbs(source).map((verb) => `${relative}: program.command("${verb}")`),
    )
    const nestedReceivers = [
      ...new Set([...sources].flatMap(([, source]) => nestedCommandReceivers(source))),
    ]
    const runImport = cliProgramSource.match(/from\s+"\.\/run"/)

    // then
    // PR2/F72 contract: the public `run` command is retired, including the `run <message>`
    // spelling that took a prompt. The host owns the non-interactive flow, and the internal
    // non-interactive guard plus the OPENCODE_CLI_RUN_MODE readers stay in place, so no `run`
    // module may be imported here again.
    expect(retired).toEqual([])
    // The detector's blind spot is closed, not assumed: every registration in these four
    // files resolves to the root `program` chain or to the single known nested group
    // (`oauth`, mounted with `program.addCommand`). A new or unresolvable receiver fails
    // here instead of silently hiding a `run` from the scan.
    expect(nestedReceivers).toEqual(["oauth"])
    expect(runImport).toBeNull()

    // then - the detector is proven, not assumed: it catches every retired spelling,
    // including a `run` registered further down a multi-line chain rooted at `program`…
    expect(retiredRunVerbs('program\n  .command("run")')).toEqual(["run"])
    expect(retiredRunVerbs('program.command("run <message>")')).toEqual(["run <message>"])
    expect(retiredRunVerbs('program\n  .command("run [message]")')).toEqual(["run [message]"])
    expect(
      retiredRunVerbs('program\n  .name("omo")\n  .description("x")\n  .command("run <message>")'),
    ).toEqual(["run <message>"])
    // …ignores comments, so a commented-out registration never counts as a live one…
    expect(retiredRunVerbs('// program.command("run")\nprogram\n  .command("team")')).toEqual([])
    expect(retiredRunVerbs('/* program.command("run") */\nprogram\n  .command("team")')).toEqual([])
    // …and stays silent on nested commands and on verbs that merely start with `run`.
    expect(retiredRunVerbs('oauth.command("run")')).toEqual([])
    expect(nestedCommandReceivers('oauth.command("run")')).toEqual(["oauth"])
    expect(retiredRunVerbs('member.command("run")')).toEqual([])
    expect(retiredRunVerbs('program.command("runner")')).toEqual([])
    expect(retiredRunVerbs('program\n  .command("team")')).toEqual([])
  })

  test("doctor command exposes explicit platform selection for Codex-only diagnostics", async () => {
    // given
    const cliProgramSource = await readFile(
      path.resolve(import.meta.dir, "cli-program.ts"),
      "utf-8",
    )

    // when
    const doctorBlock = cliProgramSource.match(
      /program\s*\n\s*\.command\("doctor"\)([\s\S]*?)\.action\(/,
    )

    // then
    expect(doctorBlock).not.toBeNull()
    expect(doctorBlock?.[1]).toContain('new Option("--platform <platform>"')
    expect(doctorBlock?.[1]).toContain('.choices(["opencode", "codex"])')
    expect(cliProgramSource).toContain(
      "resolveDoctorTarget(process.env.OMO_INVOCATION_NAME, options.platform ?? rootDoctorPlatform)",
    )
  })
})

test("program configures explicit '-h, --help' help option for consistent help-flag ordering", async () => {
  // given
  const cliProgramSource = await readFile(
    path.resolve(import.meta.dir, "cli-program.ts"),
    "utf-8",
  )

  // when
  const programBlock = cliProgramSource.match(
    /program\s*\n((?:\s*\.\w+\([^)]*\)\s*\n?)*)/,
  )

  // then
  expect(programBlock).not.toBeNull()
  expect(programBlock?.[1]).toContain('.helpOption("-h, --help", "Display help for command")')
})

test("program registers runtime commands", async () => {
  // given
  const cliProgramSource = await readFile(
    path.resolve(import.meta.dir, "cli-program.ts"),
    "utf-8",
  )

  // when
  const registersRuntimeCommands = cliProgramSource.includes("configureRuntimeCommands(program)")

  // then
  expect(registersRuntimeCommands).toBe(true)
})
