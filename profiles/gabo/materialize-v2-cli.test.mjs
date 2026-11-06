/**
 * Hermetic contract for the CLI materializer: it stages the CLI into a lab root,
 * links the workspace node_modules, writes a lab-scoped launcher, and refuses any
 * lab root / lab home that uses traversal, a relative path or a symlink to
 * escape into a V1 root. Runs against temp dirs only and asserts zero writes on
 * every refusal.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT = fileURLToPath(new URL("./materialize-v2-cli.mjs", import.meta.url))
const created = []

function tempDir(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  created.push(dir)
  return dir
}
afterEach(() => {
  while (created.length > 0) rmSync(created.pop(), { recursive: true, force: true })
})

function run(env, cwd) {
  const result = spawnSync("node", [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    ...(cwd === undefined ? {} : { cwd }),
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

describe("#given the Rigel V2 CLI materializer", () => {
  test("#when run against a temp lab #then it stages the CLI, links node_modules and writes a lab-scoped launcher", () => {
    const lab = tempDir("rigel-mat-lab-")
    const home = join(lab, "home")
    const result = run({ RIGEL_V2_LAB_ROOT: lab, RIGEL_V2_HOME: home })
    expect(result.status).toBe(0)
    expect(existsSync(join(lab, "rigel", "cli", "rigel-v2-cli.mjs"))).toBe(true)
    expect(existsSync(join(lab, "rigel", "cli", "cli", "commands", "install.mjs"))).toBe(true)
    expect(lstatSync(join(lab, "rigel", "cli", "node_modules")).isSymbolicLink()).toBe(true)
    const launcher = join(lab, "rigel", "bin", "rigel-v2")
    expect(existsSync(launcher)).toBe(true)
    const text = readFileSync(launcher, "utf8")
    expect(text).toContain(`lab_root="${lab}"`)
    expect(text).toContain('export HOME="$lab_root/home"')
    expect(text).toContain('export RIGEL_V2_LAB_ROOT="$lab_root"')
    expect(text).toContain("exec bun")
    expect(existsSync(join(home, ".local", "bin", "rigel-v2"))).toBe(true)
  })

  test("#when the lab root resolves under a V1 root #then it refuses and writes nothing", () => {
    const fakeHome = tempDir("rigel-mat-home-")
    const lab = join(fakeHome, ".config", "opencode", "lab")
    const result = run({ HOME: fakeHome, RIGEL_V2_LAB_ROOT: lab, RIGEL_V2_HOME: join(lab, "home") })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("V1")
    expect(existsSync(join(lab, "rigel", "bin", "rigel-v2"))).toBe(false)
  })

  test("#when the lab root uses .. traversal into a V1 root #then it refuses and writes nothing", () => {
    const fakeHome = tempDir("rigel-mat-home-")
    const lab = join(fakeHome, ".config", "opencode", "..", "opencode", "lab")
    const result = run({ HOME: fakeHome, RIGEL_V2_LAB_ROOT: lab, RIGEL_V2_HOME: join(fakeHome, ".config", "opencode", "lab", "home") })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("V1")
    expect(existsSync(join(fakeHome, ".config", "opencode", "lab"))).toBe(false)
  })

  test("#when the lab root is a relative path into a V1 root #then it refuses and writes nothing", () => {
    const fakeHome = tempDir("rigel-mat-home-")
    const result = run(
      { HOME: fakeHome, RIGEL_V2_LAB_ROOT: ".config/opencode/lab", RIGEL_V2_HOME: ".config/opencode/lab/home" },
      fakeHome,
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("V1")
    expect(existsSync(join(fakeHome, ".config", "opencode", "lab"))).toBe(false)
  })

  test("#when the lab root is a symlink into a V1 root #then it refuses and writes nothing", () => {
    const fakeHome = tempDir("rigel-mat-home-")
    const v1 = join(fakeHome, ".config", "opencode")
    mkdirSync(v1, { recursive: true })
    const linkParent = tempDir("rigel-mat-link-")
    const link = join(linkParent, "lab-link")
    symlinkSync(v1, link, "dir")
    const result = run({ HOME: fakeHome, RIGEL_V2_LAB_ROOT: join(link, "lab"), RIGEL_V2_HOME: join(link, "lab", "home") })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("V1")
    expect(existsSync(join(v1, "lab"))).toBe(false)
  })

  test("#when the lab home escapes the lab root #then it refuses and writes nothing", () => {
    const lab = tempDir("rigel-mat-lab-")
    const fakeHome = tempDir("rigel-mat-home-")
    const result = run({ HOME: fakeHome, RIGEL_V2_LAB_ROOT: lab, RIGEL_V2_HOME: join(fakeHome, "elsewhere", "home") })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("escapes")
    expect(existsSync(join(lab, "rigel"))).toBe(false)
  })
})
