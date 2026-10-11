/**
 * Module contract for the Rigel V2 CLI commands: drives each command's real
 * `run(argv, io)` with a captured io and injected seams, asserting POSITIVE and
 * NEGATIVE behavior per row. The effect lives in these modules (the shipped V2
 * command surface), not in the V1 owners.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { astGrepCommand } from "./ast-grep.mjs"
import { doctorCommand } from "./doctor.mjs"
import { installCommand } from "./install.mjs"
import { refreshModelCapabilitiesCommand } from "./refresh-model-capabilities.mjs"
import { ulwLoopCommand } from "./ulw-loop.mjs"
import { uninstallCommand } from "./uninstall.mjs"
import { versionCommand } from "./version.mjs"
import { worktreeSweepCommand } from "./worktree-sweep.mjs"

const created = []
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}
afterEach(() => {
  while (created.length > 0) rmSync(created.pop(), { recursive: true, force: true })
})

function captureIo(overrides = {}) {
  const out = []
  const err = []
  const io = {
    stdout: { write: (chunk) => out.push(String(chunk)) },
    stderr: { write: (chunk) => err.push(String(chunk)) },
    env: overrides.env ?? {},
    cwd: overrides.cwd ?? process.cwd(),
    home: overrides.home ?? tempDir("rigel-home-"),
    spawn: overrides.spawn ?? (() => ({ status: 0, stdout: "", stderr: "" })),
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (key === "env" || key === "cwd" || key === "home" || key === "spawn") continue
    io[key] = value
  }
  io.text = () => out.join("")
  io.errors = () => err.join("")
  return io
}

describe("#given the version command", () => {
  test("#when run #then it prints the product version and --json emits an object", async () => {
    const io = captureIo()
    expect(await versionCommand.run([], io)).toBe(0)
    expect(io.text()).toMatch(/oh-my-rigel v\d+\.\d+\.\d+/)
    const jsonIo = captureIo()
    await versionCommand.run(["--json"], jsonIo)
    expect(JSON.parse(jsonIo.text())).toMatchObject({ name: "oh-my-rigel" })
  })
})

describe("#given the doctor command", () => {
  test("#when every category is healthy #then it reports OK and --json emits the four categories", async () => {
    const home = tempDir("rigel-doctor-home-")
    const config = join(tempDir("rigel-doctor-cfg-"), "opencode.json")
    writeFileSync(config, JSON.stringify({ plugin: ["/opt/rigel/rigel-v2-native"], mcp: { lsp: {} } }, null, 2))
    const env = { RIGEL_V2_CONFIG: config, XDG_CACHE_HOME: join(home, "cache") }
    const healthy = () => ({ status: 0, stdout: "2.0.22\n", stderr: "" })
    const io = captureIo({ home, env, spawn: healthy })
    expect(await doctorCommand.run([], io)).toBe(0)
    expect(io.text()).toContain("Rigel V2 doctor: OK")
    const jsonIo = captureIo({ home, env, spawn: healthy })
    expect(await doctorCommand.run(["--json"], jsonIo)).toBe(0)
    const payload = JSON.parse(jsonIo.text())
    expect(payload.results.map((result) => result.name)).toEqual(["SYSTEM", "CONFIG", "TOOLS", "MODELS"])
    expect(payload.exitCode).toBe(0)
    expect(payload.target).toBe("opencode")
  })

  test("#when the binary is missing and the runtime is unregistered #then it exits 1", async () => {
    const io = captureIo({ env: { RIGEL_V2_CONFIG: join(tempDir("rigel-doctor-none-"), "absent.json") }, spawn: () => ({ status: 1, stdout: "", stderr: "not found" }) })
    expect(await doctorCommand.run([], io)).toBe(1)
    expect(io.text()).toContain("SYSTEM: fail")
  })
})

describe("#given the install command", () => {
  test("#when the platform is unknown #then it is refused", async () => {
    expect(await installCommand.run(["--platform=bogus"], captureIo())).toBe(1)
  })

  test("#when native-dev lacks the opt-in flag #then it is refused, and passes with it", async () => {
    expect(await installCommand.run(["--platform=native-dev", "--dry-run"], captureIo({ env: {} }))).toBe(1)
    const ok = captureIo({ env: { OMO_ENABLE_NATIVE_DEV_PLATFORM: "1" } })
    expect(await installCommand.run(["--platform=native-dev", "--dry-run", "--json"], ok)).toBe(0)
    expect(ok.text()).toContain("native-dev")
  })

  test("#when a dry-run opencode plan is requested #then it prints the plan and the native-edition hint", async () => {
    const io = captureIo()
    expect(await installCommand.run(["--dry-run"], io)).toBe(0)
    expect(io.text()).toContain("apply-v2-runtime-service.sh")
    expect(io.text()).toMatch(/OmO Native/)
  })

  test("#when the opencode platform is installed #then it runs only the authorized lab refresh wrapper pinned to the lab", async () => {
    const seen = []
    const io = captureIo({ spawn: (command, args, options) => { seen.push([command, args, options]); return { status: 0, stdout: "", stderr: "" } } })
    expect(await installCommand.run(["--platform=opencode"], io)).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0][0]).toBe("bash")
    expect(seen[0][1][0]).toContain("apply-v2-runtime-service.sh")
    expect(seen[0][1][0]).not.toContain("apply-v2-agent-layer")
    expect(seen[0][1][0]).not.toContain("switch-live-plugin")
    expect(seen[0][2].env.RIGEL_V2_LAB_ROOT).toContain("opencode-v2-lab")
    expect(seen[0][2].env.RIGEL_V2_HOME).toContain("opencode-v2-lab")
  })

  test("#when opencode install is given a foreign --home or --config #then it is refused without spawning", async () => {
    const seen = []
    const io = captureIo({ spawn: (command, args) => { seen.push([command, args]); return { status: 0, stdout: "", stderr: "" } } })
    expect(await installCommand.run(["--platform=opencode", "--home=/tmp/elsewhere"], io)).toBe(1)
    expect(await installCommand.run(["--platform=opencode", "--config=/tmp/elsewhere.json"], io)).toBe(1)
    expect(seen).toHaveLength(0)
  })

  test("#when the star courtesy is requested #then the gh command is shown and the runner is invoked", async () => {
    const dry = captureIo()
    await installCommand.run(["--dry-run", "--star"], dry)
    expect(dry.text()).toContain("user/starred")
    const seen = []
    const real = captureIo({ spawn: (cmd, args) => { seen.push([cmd, args]); return { status: 0, stdout: "", stderr: "" } } })
    await installCommand.run(["--star"], real)
    expect(seen.some(([cmd, args]) => cmd === "gh" && args.includes("api"))).toBe(true)
  })

  test("#when the codex platform is installed #then the real adapter is invoked with the codex home", async () => {
    const calls = []
    const io = captureIo({ codexInstall: { runCodexInstaller: async (options) => { calls.push(options); return { ok: true } } } })
    expect(await installCommand.run(["--platform=codex"], io)).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0].codexHome).toContain(".codex")
  })

  test("#when the native platform is installed #then the real senpi installer is invoked", async () => {
    const calls = []
    const io = captureIo({ senpiInstall: { runSenpiInstaller: async (options) => { calls.push(options); return { ok: true } } } })
    expect(await installCommand.run(["--platform=native"], io)).toBe(0)
    expect(calls).toHaveLength(1)
  })
})

describe("#given the uninstall command", () => {
  test("#when the config registers the staged runtime #then it removes the entry and the runtime dir", async () => {
    const labRoot = tempDir("rigel-lab-")
    const runtime = join(labRoot, "rigel", "runtime", "rigel-v2-native")
    mkdirSync(runtime, { recursive: true })
    writeFileSync(join(labRoot, "rigel", "active-trial.json"), "{}")
    mkdirSync(join(labRoot, "config", "opencode"), { recursive: true })
    const config = join(labRoot, "config", "opencode", "opencode.json")
    writeFileSync(config, JSON.stringify({ plugin: ["/other/plugin", runtime] }))
    const io = captureIo({ env: { RIGEL_V2_LAB_ROOT: labRoot } })
    expect(await uninstallCommand.run([], io)).toBe(0)
    expect(JSON.parse(readFileSync(config, "utf8")).plugin).toEqual(["/other/plugin"])
    expect(existsSync(runtime)).toBe(false)
  })

  test("#when the config does not register the staged runtime #then it refuses", async () => {
    const labRoot = tempDir("rigel-lab-")
    mkdirSync(join(labRoot, "config", "opencode"), { recursive: true })
    writeFileSync(join(labRoot, "config", "opencode", "opencode.json"), JSON.stringify({ plugin: ["/foreign"] }))
    expect(await uninstallCommand.run([], captureIo({ env: { RIGEL_V2_LAB_ROOT: labRoot } }))).toBe(1)
  })

  test("#when the codex platform is cleaned #then the real cleanup adapter is invoked", async () => {
    const calls = []
    const io = captureIo({ codexInstall: { cleanupCodexLight: async (options) => { calls.push(options); return { configChanged: false } } } })
    expect(await uninstallCommand.run(["--platform=codex"], io)).toBe(0)
    expect(calls).toHaveLength(1)
  })
})

describe("#given the ulw-loop command", () => {
  test("#when a component bin exists #then it resolves, and when absent #then it fails", async () => {
    const binDir = tempDir("rigel-bin-")
    writeFileSync(join(binDir, "omo-ulw-loop"), "#!/bin/sh\n")
    const found = captureIo({ env: { CODEX_LOCAL_BIN_DIR: binDir } })
    expect(await ulwLoopCommand.run([], found)).toBe(0)
    expect(found.text()).toContain("omo-ulw-loop")
    const missing = captureIo({ env: { CODEX_LOCAL_BIN_DIR: tempDir("rigel-bin-empty-") } })
    expect(await ulwLoopCommand.run([], missing)).toBe(1)
  })

  test("#when the delegation sentinel is set #then it is a no-op success", async () => {
    const io = captureIo({ env: { OMO_ULW_LOOP_DELEGATED: "1" } })
    expect(await ulwLoopCommand.run([], io)).toBe(0)
  })
})

describe("#given the refresh-model-capabilities command", () => {
  test("#when the host returns a catalog #then a snapshot is written", async () => {
    const out = join(tempDir("rigel-cap-"), "cap.json")
    const io = captureIo({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "m1" }, { id: "m2" }] }) }) })
    expect(await refreshModelCapabilitiesCommand.run(["--out", out, "--json"], io)).toBe(0)
    expect(JSON.parse(readFileSync(out, "utf8")).modelCount).toBe(2)
  })

  test("#when the host is unreachable #then it fails and writes nothing", async () => {
    const out = join(tempDir("rigel-cap-"), "cap.json")
    const io = captureIo({ fetch: async () => { throw new Error("ECONNREFUSED") } })
    expect(await refreshModelCapabilitiesCommand.run(["--out", out], io)).toBe(1)
    expect(existsSync(out)).toBe(false)
  })
})

describe("#given the ast-grep command", () => {
  test("#when the installer succeeds #then the target is under the omo home", async () => {
    const home = tempDir("rigel-home-")
    const calls = []
    const io = captureIo({ home, astGrepInstall: async (options) => { calls.push(options); return { kind: "succeeded" } } })
    expect(await astGrepCommand.run(["--home", home], io)).toBe(0)
    expect(calls[0].targetDir.startsWith(join(home, ".omo"))).toBe(true)
  })

  test("#when the installer fails #then it reports the reason and exits 1", async () => {
    const io = captureIo({ astGrepInstall: async () => ({ kind: "failed", reason: "no sg" }) })
    expect(await astGrepCommand.run([], io)).toBe(1)
    expect(io.errors()).toContain("no sg")
  })
})

describe("#given the worktree-sweep command", () => {
  test("#when the target is not a git repository #then it fails", async () => {
    const io = captureIo({ spawn: () => ({ status: 128, stdout: "", stderr: "not a git repository" }) })
    expect(await worktreeSweepCommand.run([], io)).toBe(1)
  })
})
