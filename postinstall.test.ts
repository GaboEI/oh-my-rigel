/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { delimiter } from "node:path"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { MINIMUM_OPENCODE_VERSION } from "./packages/omo-opencode/src/shared/opencode-version"

const postinstallPath = fileURLToPath(new URL("./postinstall.mjs", import.meta.url))
const RENAME_NOTICE =
  "oh-my-openagent: the 'omo' command is now 'omo-agent-toolkit' (the old name was removed in this major release)."
const PACKAGE_VERSION: string = JSON.parse(readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8")).version
const NATIVE_NOTICE = `oh-my-openagent: OmO Native is the same omo as one 'omo' command, with no OpenCode host: bun add -g ${PACKAGE_VERSION.includes("-") ? "omo-ai@beta" : "omo-ai"}`
const SUBPROCESS_TEST_TIMEOUT_MS = 30_000
const HANGING_OPENCODE_MS = 60_000

type PostinstallRun = {
  status: number | null
  stdout: string
  stderr: string
}

function runPostinstallInFixtureEnv(options: { readonly pathPrefix?: string; readonly timeoutMs?: number } = {}): PostinstallRun {
  const fixtureHome = mkdtempSync(join(tmpdir(), "omo-postinstall-fixture-"))
  const inheritedPath = process.env.PATH ?? ""
  try {
    const result = spawnSync(process.execPath, [postinstallPath], {
      encoding: "utf8",
      timeout: options.timeoutMs,
      env: {
        ...inheritedPlatformEnv(),
        PATH: options.pathPrefix === undefined ? inheritedPath : `${options.pathPrefix}${delimiter}${inheritedPath}`,
        HOME: fixtureHome,
        USERPROFILE: fixtureHome,
        XDG_CACHE_HOME: join(fixtureHome, "cache"),
      },
    })
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
  } finally {
    rmSync(fixtureHome, { recursive: true, force: true })
  }
}

function writeOpencodeVersionShim(version: string): string {
  const binDir = mkdtempSync(join(tmpdir(), "omo-postinstall-opencode-version-"))
  writeFileSync(join(binDir, "opencode"), `#!/bin/sh\necho ${version}\n`)
  chmodSync(join(binDir, "opencode"), 0o755)
  writeFileSync(join(binDir, "opencode.cmd"), `@echo ${version}\r\n`)
  return binDir
}

function writeHangingOpencodeShim(): string {
  const binDir = mkdtempSync(join(tmpdir(), "omo-postinstall-hanging-opencode-"))
  const hang = `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, ${HANGING_OPENCODE_MS})"`
  writeFileSync(join(binDir, "opencode"), `#!/bin/sh\nexec ${hang}\n`)
  chmodSync(join(binDir, "opencode"), 0o755)
  writeFileSync(join(binDir, "opencode.cmd"), `@${hang}\r\n`)
  return binDir
}

function inheritedPlatformEnv(): Record<string, string> {
  const inherited: Record<string, string> = {}
  for (const key of ["SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "PATHEXT", "TEMP", "TMP", "windir"]) {
    const value = process.env[key]
    if (value !== undefined) inherited[key] = value
  }
  return inherited
}

function countNoticeLines(output: string): number {
  return output.split("\n").filter((line) => line.trim() === RENAME_NOTICE).length
}

function countNativeNotices(output: string): number {
  return output.split("\n").filter((line) => line.trim() === NATIVE_NOTICE).length
}

describe("postinstall rename notice", () => {
  test("names the install line of the package's own channel", async () => {
    const { nativeNotice } = await import("./postinstall.mjs")
    expect(nativeNotice("5.0.0")).toEndWith("bun add -g omo-ai")
    expect(nativeNotice("5.0.0-beta.90")).toEndWith("bun add -g omo-ai@beta")
  })

  test("announces the omo-agent-toolkit rename exactly once", () => {
    // #given
    // a fixture environment isolated from the real HOME and OpenCode plugin cache

    // #when
    const run = runPostinstallInFixtureEnv()

    // #then
    expect(countNoticeLines(run.stdout)).toBe(1)
    expect(countNativeNotices(run.stdout)).toBe(1)
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  test("never fails the install regardless of platform binary resolution", () => {
    // #given
    // a fixture environment isolated from the real HOME and OpenCode plugin cache

    // #when
    const run = runPostinstallInFixtureEnv()

    // #then
    expect(run.status).toBe(0)
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  test("finishes when the opencode version probe never returns", () => {
    // #given
    const hangingBinDir = writeHangingOpencodeShim()

    try {
      // #when
      const startedAt = Date.now()
      const run = runPostinstallInFixtureEnv({ pathPrefix: hangingBinDir, timeoutMs: HANGING_OPENCODE_MS * 2 })

      // #then
      expect(run.status).toBe(0)
      expect(Date.now() - startedAt).toBeLessThan(HANGING_OPENCODE_MS)
    } finally {
      rmSync(hangingBinDir, { recursive: true, force: true })
    }
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  test("stays idempotent across repeated runs", () => {
    // #given
    const firstRun = runPostinstallInFixtureEnv()

    // #when
    const secondRun = runPostinstallInFixtureEnv()

    // #then
    expect(countNoticeLines(firstRun.stdout)).toBe(1)
    expect(countNoticeLines(secondRun.stdout)).toBe(1)
    expect(countNativeNotices(firstRun.stdout)).toBe(1)
    expect(countNativeNotices(secondRun.stdout)).toBe(1)
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})

describe("postinstall OpenCode version floor", () => {
  test("declares the same OpenCode floor as the plugin", () => {
    // #given
    // the installer script and the plugin's single source of truth

    // #when
    const declaredInScript = readFileSync(postinstallPath, "utf8").match(/const MIN_OPENCODE_VERSION = "([^"]+)"/)?.[1]

    // #then
    // the two copies can never drift apart
    expect(declaredInScript).toBe(MINIMUM_OPENCODE_VERSION)
    expect(MINIMUM_OPENCODE_VERSION).toBe("2.0.19")
  })

  test("warns that a pre-V2 host is unsupported and names the floor", () => {
    // #given
    // a host still on the retired V1 line
    const binDir = writeOpencodeVersionShim("1.4.0")

    try {
      // #when
      const run = runPostinstallInFixtureEnv({ pathPrefix: binDir })

      // #then
      expect(run.status).toBe(0)
      expect(run.stderr).toContain(`OpenCode ${MINIMUM_OPENCODE_VERSION}+ (V2)`)
      expect(run.stderr).toContain("Detected: 1.4.0")
      expect(run.stderr).toContain("Pre-V2 OpenCode hosts are not supported")
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  test("stays silent about the floor for a V2 host", () => {
    // #given
    // a host at the declared V2 floor
    const binDir = writeOpencodeVersionShim(MINIMUM_OPENCODE_VERSION)

    try {
      // #when
      const run = runPostinstallInFixtureEnv({ pathPrefix: binDir })

      // #then
      expect(run.status).toBe(0)
      expect(run.stderr).not.toContain("requires OpenCode")
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  test("reads the version out of the banner a real host prints", () => {
    // #given
    // `opencode --version` prints a prefixed banner, so the probe must read the semver
    const binDir = writeOpencodeVersionShim("opencode v2.2.5")

    try {
      // #when
      const run = runPostinstallInFixtureEnv({ pathPrefix: binDir })

      // #then
      expect(run.status).toBe(0)
      expect(run.stderr).not.toContain("requires OpenCode")
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  test("still refuses a V1 host whose banner carries the prefix", () => {
    // #given
    const binDir = writeOpencodeVersionShim("opencode v1.4.0")

    try {
      // #when
      const run = runPostinstallInFixtureEnv({ pathPrefix: binDir })

      // #then
      expect(run.stderr).toContain("Detected: 1.4.0")
      expect(run.stderr).toContain(`OpenCode ${MINIMUM_OPENCODE_VERSION}+ (V2)`)
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})
