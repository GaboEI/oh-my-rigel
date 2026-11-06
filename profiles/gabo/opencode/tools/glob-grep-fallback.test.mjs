import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Semaphore } from "./glob-grep-concurrency.mjs"
import { createCliResolver } from "./glob-grep-cli.mjs"
import { downloadAndInstallRipgrep, PLATFORM_CONFIG } from "./glob-grep-install.mjs"
import { buildFindArgs, buildGrepArgs, buildPowerShellCommand, runRg, runRgFiles } from "./glob-grep-search.mjs"
import { discoverRuntimeModules, RUNTIME_ENTRIES } from "../../native-runtime-modules.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** A minimal child-process stub: emits data then close on the next microtask. */
function fakeProcess({ stdout = "", stderr = "", exitCode = 0 } = {}) {
  const proc = new EventEmitter()
  const stream = (text) => {
    const handlers = { data: [] }
    return {
      on(type, cb) {
        ;(handlers[type] ??= []).push(cb)
        return this
      },
      emitData() {
        for (const cb of handlers.data) cb(Buffer.from(text))
      },
    }
  }
  proc.stdout = stream(stdout)
  proc.stderr = stream(stderr)
  proc.kill = () => {}
  queueMicrotask(() => {
    proc.stdout.emitData()
    proc.stderr.emitData()
    proc.emit("close", exitCode)
  })
  return proc
}

function resolverFor({ existing = [], which = {}, install } = {}) {
  const existingSet = new Set(existing)
  const whichMap = which
  return createCliResolver({
    fs: { existsSync: (candidate) => existingSet.has(candidate) },
    spawnSync: (command, args) => {
      const found = whichMap[args[0]]
      return found ? { status: 0, stdout: `${found}\n` } : { status: 1, stdout: "" }
    },
    env: {},
    homedir: "/home/u",
    platform: "linux",
    execPath: "/opt/oc/bin/opencode",
    // The resolver is asked for the linux rules, so the path module it joins
    // with must be the POSIX one too: the real `path` would rewrite these
    // fixtures with backslashes on Windows and never match `existing`.
    pathModule: path.posix,
    install,
  })
}

describe("ripgrep concurrency cap", () => {
  test("#given a cap of two #when three searches acquire #then the third waits until a release", async () => {
    const semaphore = new Semaphore(2)
    await semaphore.acquire()
    await semaphore.acquire()
    let third = false
    const pending = semaphore.acquire().then(() => {
      third = true
    })
    await Promise.resolve()
    expect(third).toBe(false)
    semaphore.release()
    await pending
    expect(third).toBe(true)
  })

  test("#given the V1 default #then the shared search semaphore admits two at once", async () => {
    const { rgSemaphore } = await import("./glob-grep-concurrency.mjs")
    expect(rgSemaphore.max).toBe(2)
  })
})

describe("search backend resolution", () => {
  test("#given an OpenCode bundled rg #when resolving #then it is used with the rg backend", () => {
    const bundled = "/home/u/.cache/opencode/bin/rg"
    expect(resolverFor({ existing: [bundled] }).resolve()).toEqual({ path: bundled, backend: "rg" })
  })

  test("#given no bundled rg but rg on PATH #when resolving #then PATH rg is used", () => {
    expect(resolverFor({ which: { rg: "/usr/bin/rg" } }).resolve()).toEqual({ path: "/usr/bin/rg", backend: "rg" })
  })

  test("#given no rg anywhere but grep on PATH #when resolving #then the grep backend is used", () => {
    expect(resolverFor({ which: { grep: "/usr/bin/grep" } }).resolve()).toEqual({ path: "/usr/bin/grep", backend: "grep" })
  })

  test("#given nothing available #when resolving #then it falls back to plain rg as V1 does", () => {
    expect(resolverFor({}).resolve()).toEqual({ path: "rg", backend: "rg" })
  })

  test("#given rg absent #when auto-installing #then the installer result becomes the rg backend", async () => {
    const resolver = resolverFor({ which: {}, install: async () => "/installed/rg" })
    expect(await resolver.resolveWithAutoInstall()).toEqual({ path: "/installed/rg", backend: "rg" })
  })

  test("#given rg absent and a failing installer #when auto-installing #then the current fallback is returned", async () => {
    const resolver = resolverFor({ which: { grep: "/usr/bin/grep" }, install: async () => { throw new Error("network down") } })
    expect(await resolver.resolveWithAutoInstall()).toEqual({ path: "/usr/bin/grep", backend: "grep" })
  })

  test("#given rg already resolved #when auto-installing #then the installer is not invoked", async () => {
    let called = false
    const resolver = resolverFor({ which: { rg: "/usr/bin/rg" }, install: async () => { called = true; return "/x" } })
    expect(await resolver.resolveWithAutoInstall()).toEqual({ path: "/usr/bin/rg", backend: "rg" })
    expect(called).toBe(false)
  })
})

describe("glob Unix and Windows fallbacks", () => {
  test("#given the find backend #then the V1 find args are built", () => {
    expect(buildFindArgs({ pattern: "*.txt" })).toEqual(["-L", ".", "-maxdepth", "20", "-type", "f", "-name", "*.txt"])
    expect(buildFindArgs({ pattern: "*.txt", hidden: false })).toContain("-not")
  })

  test("#given no rg on Unix #when globbing #then the find backend runs and paths are cwd-joined", async () => {
    let captured
    const spawner = (command, options) => {
      captured = { command, options }
      return fakeProcess({ stdout: "a.txt\n" })
    }
    const result = await runRgFiles(
      { pattern: "*.txt", paths: ["/work"] },
      { cli: { path: "/usr/bin/find", backend: "grep" }, spawner, platform: "linux" },
    )
    expect(captured.command[0]).toBe("/usr/bin/find")
    expect(captured.command).toContain("-name")
    expect(result.files.map((entry) => entry.path)).toEqual(["/work/a.txt"])
  })

  test("#given Windows without rg #when globbing #then the PowerShell fallback runs", async () => {
    let captured
    const spawner = (command) => {
      captured = command
      return fakeProcess({ stdout: "C:\\work\\a.txt\n" })
    }
    const result = await runRgFiles(
      { pattern: "*.txt", paths: ["C:\\work"] },
      { cli: { path: "/usr/bin/grep", backend: "grep" }, spawner, platform: "win32" },
    )
    expect(captured[0]).toBe("powershell.exe")
    expect(captured.join(" ")).toContain("Get-ChildItem")
    expect(captured.join(" ")).toContain("-Force")
    expect(result.files.map((entry) => entry.path)).toEqual(["C:\\work\\a.txt"])
  })

  test("#given the PowerShell command #then the V1 depth and escaping are applied", () => {
    const command = buildPowerShellCommand({ pattern: "a'b", paths: ["C:\\w"] })
    expect(command[0]).toBe("powershell.exe")
    expect(command.join(" ")).toContain("-Depth 19")
    expect(command.join(" ")).toContain("'a''b'")
  })
})

describe("grep classic fallback", () => {
  test("#given the classic grep backend #then the V1 grep args are built", () => {
    const args = buildGrepArgs({ pattern: "x", globs: ["*.txt"], context: 0 })
    expect(args).toEqual(expect.arrayContaining(["-r", "-n", "-H", "--color=never", "-i", "--include=*.txt", "--exclude-dir=.git", "--exclude-dir=node_modules"]))
  })

  test("#given no rg #when grepping #then the classic backend runs with -e pattern", async () => {
    let captured
    const spawner = (command) => {
      captured = command
      return fakeProcess({ stdout: "/work/a.txt:2:ALPHA\n" })
    }
    const result = await runRg(
      { pattern: "ALPHA", paths: ["/work"], context: 0, outputMode: "content" },
      { cli: { path: "/usr/bin/grep", backend: "grep" }, spawner },
    )
    expect(captured[0]).toBe("/usr/bin/grep")
    expect(captured).toContain("-e")
    expect(captured).toContain("ALPHA")
    expect(result.matches).toEqual([{ file: "/work/a.txt", line: 2, text: "ALPHA" }])
  })
})

describe("ripgrep auto-provisioning", () => {
  test("#given the V1 platform map #then the known keys are preserved", () => {
    expect(Object.keys(PLATFORM_CONFIG)).toEqual(["arm64-darwin", "arm64-linux", "x64-darwin", "x64-linux", "x64-win32"])
    expect(PLATFORM_CONFIG["x64-linux"].platform).toBe("x86_64-unknown-linux-musl")
  })

  test("#given rg already installed #when provisioning #then it short-circuits without downloading", async () => {
    const rgPath = path.join("/home/u", ".cache", "oh-my-opencode", "bin", "rg")
    let downloaded = false
    const resolved = await downloadAndInstallRipgrep({
      fs: { existsSync: (candidate) => candidate === rgPath, mkdirSync() {}, chmodSync() {}, unlinkSync() {}, writeFileSync() {} },
      homedir: "/home/u",
      platform: "linux",
      arch: "x64",
      pathModule: path,
      download: async () => { downloaded = true },
    })
    expect(resolved).toBe(rgPath)
    expect(downloaded).toBe(false)
  })

  test("#given rg absent #when provisioning #then the archive is fetched and the rg path is returned", async () => {
    const rgPath = path.join("/home/u", ".cache", "oh-my-opencode", "bin", "rg")
    const existing = new Set()
    let unpacked = false
    const resolved = await downloadAndInstallRipgrep({
      fs: { existsSync: (candidate) => existing.has(candidate), mkdirSync() {}, chmodSync() {}, unlinkSync() {}, writeFileSync() {} },
      homedir: "/home/u",
      platform: "linux",
      arch: "x64",
      pathModule: path,
      download: async () => {},
      unpack: async () => { unpacked = true; existing.add(rgPath) },
    })
    expect(resolved).toBe(rgPath)
    expect(unpacked).toBe(true)
  })

  test("#given an unsupported platform #when provisioning #then it fails loudly", async () => {
    await expect(
      downloadAndInstallRipgrep({ homedir: "/home/u", platform: "linux", arch: "mips", pathModule: path }),
    ).rejects.toThrow("Unsupported platform: mips-linux")
  })
})

describe("runtime staging graph", () => {
  test("#given the native entry #when discovering modules #then every glob/grep port module is staged", () => {
    const discovered = discoverRuntimeModules(path.join(HERE, ".."), RUNTIME_ENTRIES)
    for (const file of [
      "tools/glob-grep.tools.mjs",
      "tools/glob-grep-search.mjs",
      "tools/glob-grep-format.mjs",
      "tools/glob-grep-cli.mjs",
      "tools/glob-grep-install.mjs",
      "tools/glob-grep-concurrency.mjs",
    ]) {
      expect(discovered).toContain(file)
    }
  })
})
