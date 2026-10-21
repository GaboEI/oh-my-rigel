/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { runSenpiInstaller, runSenpiUninstaller } from "./install-senpi"
import { createPluginFixture } from "./install-test-fixture"
import { installLocalLauncher, localLauncherPath } from "./local-launcher"

const repoRoot = resolve(import.meta.dir, "../../../..")
const tempDirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function makePluginFixture(): Promise<string> {
  const pluginPath = await createPluginFixture()
  tempDirs.push(pluginPath)
  return pluginPath
}

async function readSettings(agentDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>
}

/**
 * The engine package a dependency tree carries, with a CLI that reports what it was started with.
 *
 * The CLI is the engine the real package ships: the launcher spawns it with the plugin and the
 * product brand, and it echoes both back so the test can read them off the wire.
 */
async function writeEngineTree(root: string, version: string): Promise<string> {
  const packageRoot = join(root, "node_modules", "@code-yeongyu", "senpi")
  const cliPath = join(packageRoot, "dist", "bundle", "cli.js")
  await mkdir(dirname(cliPath), { recursive: true })
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@code-yeongyu/senpi", version }))
  await writeFile(
    cliPath,
    [
      "const payload = {",
      "  started: true,",
      `  engineVersion: ${JSON.stringify(version)},`,
      "  args: process.argv.slice(2),",
      "  brand: process.env.SENPI_BRAND,",
      "  agentDir: process.env.OMO_CODING_AGENT_DIR,",
      "}",
      'process.stdout.write(JSON.stringify(payload) + "\\n")',
      "",
    ].join("\n"),
  )
  return cliPath
}

/** The manifest that pins the engine version this edition expects. */
async function writePinManifest(root: string, pin: string): Promise<void> {
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "senpi-launcher-fixture", peerDependencies: { "@code-yeongyu/senpi": pin } }),
  )
}

interface LauncherRun {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs the installed launcher against an isolated home and agent directory. */
async function runLauncher(
  homeDir: string,
  extraEnv: Readonly<Record<string, string | undefined>> = {},
): Promise<LauncherRun> {
  const agentDir = join(homeDir, "agent")
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: homeDir,
    OMO_CODING_AGENT_DIR: agentDir,
    SENPI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_DIR: agentDir,
  }
  delete env.OMO_SENPI_CLI_PATH
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  const proc = Bun.spawn([localLauncherPath(homeDir), "--version"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

interface LauncherPayload {
  readonly started: boolean
  readonly engineVersion: string
  readonly args: readonly string[]
  readonly brand: {
    readonly displayVersion?: string
    readonly name?: string
    readonly command?: string
    readonly configDir?: string
    readonly envPrefix?: string
  }
}

/** What the engine the launcher started reported about itself. */
function launcherPayload(stdout: string): LauncherPayload {
  const line = stdout.trim().split("\n").at(-1) ?? ""
  const raw = JSON.parse(line) as Omit<LauncherPayload, "brand"> & { readonly brand?: string }
  return {
    started: raw.started,
    engineVersion: raw.engineVersion,
    args: raw.args,
    brand: raw.brand === undefined ? {} : (JSON.parse(raw.brand) as LauncherPayload["brand"]),
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("runSenpiInstaller local launcher", () => {
  test("#given a sandbox home #when installing #then the launcher is written under that home and reported", async () => {
    // given
    const agentDir = await makeTempDir("omo-senpi-launcher-agent-")
    const homeDir = await makeTempDir("omo-senpi-launcher-home-")
    const pluginPath = await makePluginFixture()

    // when
    const result = await runSenpiInstaller({ env: { HOME: homeDir, SENPI_CODING_AGENT_DIR: agentDir }, repoRoot, pluginPath })

    // then
    expect(result.launcherPath).toBe(localLauncherPath(homeDir))
    expect(await readFile(localLauncherPath(homeDir), "utf8")).toContain("omo-local-launcher")
  })

  test("#given a foreign omo launcher #when installing #then the plugin is registered and the launcher is left untouched", async () => {
    // given
    const agentDir = await makeTempDir("omo-senpi-launcher-agent-")
    const homeDir = await makeTempDir("omo-senpi-launcher-home-")
    const pluginPath = await makePluginFixture()
    const foreignLauncher = "#!/bin/sh\necho foreign\n"
    await mkdir(join(homeDir, ".local", "bin"), { recursive: true })
    await writeFile(localLauncherPath(homeDir), foreignLauncher)
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: ["keep-me"] }))

    // when
    const result = await runSenpiInstaller({ env: { HOME: homeDir, SENPI_CODING_AGENT_DIR: agentDir }, repoRoot, pluginPath })

    // then
    expect(result.launcherPath).toBeUndefined()
    expect(await readSettings(agentDir)).toEqual({ packages: ["keep-me", pluginPath] })
    expect(await readFile(localLauncherPath(homeDir), "utf8")).toBe(foreignLauncher)
  })

  test("#given an installed launcher #when uninstalling #then the launcher under that home is removed", async () => {
    // given
    const agentDir = await makeTempDir("omo-senpi-launcher-agent-")
    const homeDir = await makeTempDir("omo-senpi-launcher-home-")
    const pluginPath = await makePluginFixture()
    const env = { HOME: homeDir, SENPI_CODING_AGENT_DIR: agentDir }
    await runSenpiInstaller({ env, repoRoot, pluginPath })

    // when
    await runSenpiUninstaller({ env, repoRoot, pluginPath })

    // then
    await expect(readFile(localLauncherPath(homeDir), "utf8")).rejects.toThrow()
  })

  // A packed plugin tree ships the plugin artifacts, not the dependency tree the engine lives in:
  // an install that demanded the engine would refuse a payload that is complete on its own.
  test("#given a packed plugin tree without an engine dependency #when installing #then the install succeeds and registers the shipped plugin tree", async () => {
    // given
    const agentDir = await makeTempDir("omo-senpi-launcher-agent-")
    const homeDir = await makeTempDir("omo-senpi-launcher-home-")
    const pluginPath = await makePluginFixture()
    const isolatedRoot = await makeTempDir("omo-senpi-launcher-no-engine-")

    // when
    const result = await runSenpiInstaller({
      env: { HOME: homeDir, SENPI_CODING_AGENT_DIR: agentDir },
      repoRoot: isolatedRoot,
      pluginPath,
    })

    // then
    expect(result.ok).toBe(true)
    expect(result.pluginPath).toBe(pluginPath)
    expect((await readSettings(agentDir)).packages).toEqual([pluginPath])
    expect(existsSync(localLauncherPath(homeDir))).toBe(true)
  })

  // Without an engine the launcher is explicit about it: it never spawns a path that does not
  // exist and never lets the engine host report a module-resolution error instead.
  test("#given an install whose tree carries no engine #when the launcher runs #then it exits non-zero with an actionable message", async () => {
    // given
    const agentDir = await makeTempDir("omo-senpi-launcher-agent-")
    const homeDir = await makeTempDir("omo-senpi-launcher-home-")
    const pluginPath = await makePluginFixture()
    const isolatedRoot = await makeTempDir("omo-senpi-launcher-no-engine-")
    await runSenpiInstaller({
      env: { HOME: homeDir, SENPI_CODING_AGENT_DIR: agentDir },
      repoRoot: isolatedRoot,
      pluginPath,
    })

    // when
    const run = await runLauncher(homeDir)

    // then
    expect(run.exitCode).toBe(1)
    expect(run.stdout).toBe("")
    expect(run.stderr).toContain("@code-yeongyu/senpi")
    expect(run.stderr).toContain("bun add @code-yeongyu/senpi")
    expect(run.stderr).toContain("OMO_SENPI_CLI_PATH")
  })

  // The launcher is the product entry point of the local route: it starts the engine the
  // dependency tree carries, hands it the plugin, and brands it as the product.
  test("#given a dependency tree that carries the engine #when the launcher runs #then it starts the engine with the plugin and reports the engine version", async () => {
    // given
    const agentDir = await makeTempDir("omo-senpi-launcher-agent-")
    const homeDir = await makeTempDir("omo-senpi-launcher-home-")
    const pluginPath = await makePluginFixture()
    await writeEngineTree(pluginPath, "9.9.9")
    await runSenpiInstaller({
      env: { HOME: homeDir, SENPI_CODING_AGENT_DIR: agentDir },
      repoRoot: await makeTempDir("omo-senpi-launcher-tree-"),
      pluginPath,
    })

    // when
    const run = await runLauncher(homeDir)

    // then
    expect(run.exitCode).toBe(0)
    const payload = launcherPayload(run.stdout)
    expect(payload.started).toBe(true)
    expect(payload.engineVersion).toBe("9.9.9")
    expect(payload.args).toEqual(["--extension", pluginPath, "--version"])
    expect(payload.brand.name).toBe("OmO")
    expect(payload.brand.command).toBe("omo")
    expect(payload.brand.configDir).toBe(".omo")
    expect(payload.brand.envPrefix).toBe("OMO")
    expect(payload.brand.displayVersion).toBe("local (senpi 9.9.9)")
  })

  // A differently versioned engine is a different engine, but the install is not broken by it:
  // the launcher warns and starts the engine the consumer actually has.
  test("#given an engine whose version differs from the pinned one #when the launcher runs #then it warns and still starts the engine", async () => {
    // given
    const agentDir = await makeTempDir("omo-senpi-launcher-agent-")
    const homeDir = await makeTempDir("omo-senpi-launcher-home-")
    const pluginPath = await makePluginFixture()
    await writeEngineTree(pluginPath, "1.0.1")
    const treeRoot = await makeTempDir("omo-senpi-launcher-tree-")
    await writePinManifest(treeRoot, "1.0.0")
    await runSenpiInstaller({
      env: { HOME: homeDir, SENPI_CODING_AGENT_DIR: agentDir },
      repoRoot: treeRoot,
      pluginPath,
    })

    // when
    const run = await runLauncher(homeDir)

    // then
    expect(run.exitCode).toBe(0)
    expect(run.stderr).toContain("warning")
    expect(run.stderr).toContain("1.0.1")
    expect(run.stderr).toContain("1.0.0")
    expect(launcherPayload(run.stdout).engineVersion).toBe("1.0.1")
  })

  test("#given an engine override #when the launcher runs #then the override wins over the dependency tree", async () => {
    // given
    const agentDir = await makeTempDir("omo-senpi-launcher-agent-")
    const homeDir = await makeTempDir("omo-senpi-launcher-home-")
    const pluginPath = await makePluginFixture()
    await writeEngineTree(pluginPath, "9.9.9")
    const overrideRoot = await makeTempDir("omo-senpi-launcher-override-")
    const overrideCli = await writeEngineTree(overrideRoot, "8.8.8")
    await runSenpiInstaller({
      env: { HOME: homeDir, SENPI_CODING_AGENT_DIR: agentDir },
      repoRoot: await makeTempDir("omo-senpi-launcher-tree-"),
      pluginPath,
    })

    // when
    const run = await runLauncher(homeDir, { OMO_SENPI_CLI_PATH: overrideCli })

    // then
    expect(run.exitCode).toBe(0)
    expect(launcherPayload(run.stdout).engineVersion).toBe("8.8.8")
    expect(launcherPayload(run.stdout).brand.displayVersion).toBe("local (senpi 8.8.8)")
  })

  test("#given an engine override that points at nothing #when the launcher runs #then it exits non-zero naming the override", async () => {
    // given
    const agentDir = await makeTempDir("omo-senpi-launcher-agent-")
    const homeDir = await makeTempDir("omo-senpi-launcher-home-")
    const pluginPath = await makePluginFixture()
    await writeEngineTree(pluginPath, "9.9.9")
    await runSenpiInstaller({
      env: { HOME: homeDir, SENPI_CODING_AGENT_DIR: agentDir },
      repoRoot: await makeTempDir("omo-senpi-launcher-tree-"),
      pluginPath,
    })
    const missing = join(homeDir, "no-such-senpi-cli.js")

    // when
    const run = await runLauncher(homeDir, { OMO_SENPI_CLI_PATH: missing })

    // then
    expect(run.exitCode).toBe(1)
    expect(run.stdout).toBe("")
    expect(run.stderr).toContain("OMO_SENPI_CLI_PATH")
    expect(run.stderr).toContain(missing)
  })
})
