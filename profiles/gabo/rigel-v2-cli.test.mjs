/**
 * Integration contract for the Rigel V2 CLI: it SPAWNS the real shipped entry
 * (`profiles/gabo/rigel-v2-cli.mjs`) and asserts each command's observable
 * behavior positively and negatively. This is the "test over V2" that the audit
 * requires for the CLI rows: the effect lives in this CLI, not in the V1 owners.
 *
 * The CLI runs under `bun` because it delegates the actual codex/native install
 * to the real workspace adapter packages (`@oh-my-opencode/omo-codex/install`,
 * `@oh-my-opencode/omo-senpi/install`), which are TypeScript. It never launches
 * OpenCode, never uses Docker, and never touches V1.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync, spawn } from "node:child_process"
import { createServer } from "node:http"

const CLI = fileURLToPath(new URL("./rigel-v2-cli.mjs", import.meta.url))
const scratch = []

function cli(args, env = {}) {
  const result = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

// Async variant: keeps the test process's event loop free so an in-process stub
// HTTP server can serve the spawned CLI (spawnSync would block it).
function cliAsync(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn("bun", [CLI, ...args], { env: { ...process.env, ...env } })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("close", (status) => resolve({ status, stdout, stderr }))
  })
}

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

afterAll(() => {
  while (scratch.length > 0) rmSync(scratch.pop(), { recursive: true, force: true })
})

describe("#given the Rigel V2 CLI entry", () => {
  test("#when invoked with --help #then it lists the command surface and exits 0", () => {
    const result = cli(["--help"])
    expect(result.status).toBe(0)
    for (const command of ["install", "uninstall", "version", "doctor", "ulw-loop", "worktree-sweep", "refresh-model-capabilities", "ast-grep"]) {
      expect(result.stdout).toContain(command)
    }
  })

  test("#when an unknown command is given #then it fails with a message", () => {
    const result = cli(["definitely-not-a-command"])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Unknown command")
  })

  test("#when `version` runs #then it prints the Rigel version", () => {
    const result = cli(["version"])
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/oh-my-rigel v\d+\.\d+\.\d+/)
  })
})

describe("#given the Rigel V2 CLI install command", () => {
  test("#when the platform is unknown #then it is refused", () => {
    const result = cli(["install", "--platform=bogus", "--dry-run"])
    expect(result.status).toBe(1)
    expect(`${result.stdout}${result.stderr}`).toMatch(/platform/i)
  })

  test("#when native-dev is requested without the flag #then it is refused", () => {
    const result = cli(["install", "--platform=native-dev", "--dry-run"], { OMO_ENABLE_NATIVE_DEV_PLATFORM: "" })
    expect(result.status).toBe(1)
  })

  test("#when native-dev is requested with the flag #then the plan is emitted", () => {
    const result = cli(["install", "--platform=native-dev", "--dry-run", "--json"], { OMO_ENABLE_NATIVE_DEV_PLATFORM: "1" })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("native-dev")
  })

  test("#when a dry-run plan is requested as JSON #then the plan and steps are emitted with no native-edition hint", () => {
    const result = cli(["install", "--dry-run", "--json"], { RIGEL_V2_LAB_ROOT: tempDir("rigel-cli-lab-") })
    expect(result.status).toBe(0)
    const payload = JSON.parse(result.stdout)
    expect(payload.platform).toBe("opencode")
    expect(payload.dryRun).toBe(true)
    expect(payload.steps.map((step) => step.kind)).toEqual(["lab-refresh"])
    expect(payload.steps[0].path).toContain("apply-v2-runtime-service.sh")
    expect(Object.hasOwn(payload, "nativeEditionHint")).toBe(false)
  })

  test("#when install --dry-run runs without --json #then only the plan is printed and no other-edition install is suggested", () => {
    const result = cli(["install", "--dry-run"], { RIGEL_V2_LAB_ROOT: tempDir("rigel-cli-lab-") })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Plan for platform opencode:")
    expect(result.stdout).toContain("apply-v2-runtime-service.sh")
    expect(result.stdout).not.toContain("OmO Native")
    expect(result.stdout).not.toContain("install --platform=native")
    expect(result.stdout).not.toContain("migrating-from-opencode")
  })

  test("#when the codex platform is planned #then the codex installer is named", () => {
    const result = cli(["install", "--platform=codex", "--dry-run", "--json"])
    expect(result.status).toBe(0)
    expect(result.stdout.toLowerCase()).toContain("codex")
  })

  test("#when the star courtesy is requested in dry-run #then the gh command is shown", () => {
    const result = cli(["install", "--dry-run", "--star"])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("user/starred")
  })
})

describe("#given the Rigel V2 CLI uninstall command", () => {
  test("#when a dry-run uninstall is requested #then the plan is printed", () => {
    const result = cli(["uninstall", "--dry-run", "--json"], { RIGEL_V2_LAB_ROOT: tempDir("rigel-cli-lab-") })
    expect(result.status).toBe(0)
  })

  test("#when a foreign plugin entry is present #then the real uninstall refuses it", () => {
    const labRoot = tempDir("rigel-cli-lab-")
    mkdirSync(join(labRoot, "config", "opencode"), { recursive: true })
    writeFileSync(join(labRoot, "config", "opencode", "opencode.json"), JSON.stringify({ plugin: ["/some/foreign/plugin"] }))
    const result = cli(["uninstall"], { RIGEL_V2_LAB_ROOT: labRoot })
    expect(result.status).toBe(1)
  })
})

describe("#given the Rigel V2 CLI worktree-sweep command", () => {
  let repo
  beforeAll(() => {
    repo = tempDir("rigel-wt-")
    const run = (args) => spawnSync("git", args, { encoding: "utf8" })
    run(["init", "-q", repo])
    run(["-C", repo, "config", "user.email", "t@t"])
    run(["-C", repo, "config", "user.name", "t"])
    writeFileSync(join(repo, "a.txt"), "a\n")
    run(["-C", repo, "add", "."])
    run(["-C", repo, "commit", "-qm", "init"])
    run(["-C", repo, "worktree", "add", "-q", join(repo, ".wt", "feat"), "-b", "feat"])
  })

  test("#when a real repo with a linked worktree is swept #then a JSON report is produced", () => {
    const result = cli(["worktree-sweep", "--repo", repo, "--dry-run", "--json"])
    expect(result.status).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(Array.isArray(report.repos)).toBe(true)
    const [entry] = report.repos
    const branches = [...entry.kept, ...entry.swept, ...entry.pruned].map((record) => record.branch)
    expect(branches).toContain("feat")
  })

  test("#when the path is not a git repo #then it fails", () => {
    const result = cli(["worktree-sweep", "--repo", tempDir("rigel-not-repo-"), "--json"])
    expect(result.status).toBe(1)
  })
})

describe("#given the Rigel V2 CLI remaining commands", () => {
  test("#when refresh-model-capabilities targets an unreachable host #then it fails without writing", () => {
    const result = cli(["refresh-model-capabilities", "--host", "http://127.0.0.1:9", "--out", join(tempDir("rigel-cap-"), "cap.json")])
    expect(result.status).toBe(1)
  })

  test("#when ast-grep is planned #then a target under the omo home is reported", () => {
    const result = cli(["ast-grep", "--home", tempDir("rigel-home-"), "--dry-run", "--json"])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("ast-grep")
  })

  test("#when no ulw-loop component is installed #then it fails with a concise message and no other-product install advice", () => {
    const result = cli(["ulw-loop"], {
      HOME: tempDir("rigel-home-"),
      CODEX_HOME: tempDir("rigel-codex-home-"),
      CODEX_LOCAL_BIN_DIR: tempDir("rigel-codex-bin-"),
      OMO_ULW_LOOP_DELEGATED: "",
    })
    expect(result.status).toBe(1)
    const output = `${result.stdout}${result.stderr}`
    expect(output).toContain("not installed")
    expect(output).not.toContain("Run:")
    expect(output.toLowerCase()).not.toContain("npx")
    expect(output.toLowerCase()).not.toContain("lazycodex")
  })

  test("#when a local ulw-loop component bin exists #then it resolves that binary", () => {
    const binDir = tempDir("rigel-codex-bin-")
    writeFileSync(join(binDir, "omo-ulw-loop"), "#!/bin/sh\n")
    const result = cli(["ulw-loop", "--json"], {
      HOME: tempDir("rigel-home-"),
      CODEX_HOME: tempDir("rigel-codex-home-"),
      CODEX_LOCAL_BIN_DIR: binDir,
      OMO_ULW_LOOP_DELEGATED: "",
    })
    expect(result.status).toBe(0)
    const payload = JSON.parse(result.stdout)
    expect(payload.delegated).toBe(false)
    expect(payload.command.executable).toBe(join(binDir, "omo-ulw-loop"))
  })

  test("#when the `cleanup` alias is used #then it runs the uninstall command", () => {
    const result = cli(["cleanup", "--dry-run", "--json"], { RIGEL_V2_LAB_ROOT: tempDir("rigel-cli-lab-") })
    expect(result.status).toBe(0)
  })

  test("#when a native install is planned #then the senpi installer is named", () => {
    const result = cli(["install", "--platform=native", "--dry-run", "--json"])
    expect(result.status).toBe(0)
    expect(result.stdout.toLowerCase()).toContain("senpi")
  })

  test("#when a codex uninstall is planned #then the codex cleanup is named", () => {
    const result = cli(["uninstall", "--platform=codex", "--dry-run", "--json"])
    expect(result.status).toBe(0)
    expect(result.stdout.toLowerCase()).toContain("codex")
  })

  test("#when the host serves a catalog #then refresh writes a snapshot", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: [{ id: "m1" }] }))
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const { port } = server.address()
      const out = join(tempDir("rigel-cap-"), "cap.json")
      const result = await cliAsync(["refresh-model-capabilities", "--host", `http://127.0.0.1:${port}`, "--out", out, "--json"])
      expect(result.status).toBe(0)
      expect(JSON.parse(readFileSync(out, "utf8")).modelCount).toBe(1)
    } finally {
      server.close()
    }
  })
})
