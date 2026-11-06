import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(moduleDirectory, "../..")
const installerPath = path.join(moduleDirectory, "rigel-v2-user-install.mjs")

describe("rigel-v2-user-install manifest openclaw", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-user-install-manifest-openclaw-"))

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  test("copies declared staged manifest openclaw key names into the installed runtime", async () => {
    // given
    const profileFile = path.join(base, "source-profile.jsonc")
    const home = path.join(base, "home")
    const stateRoot = path.join(base, "state")
    const configFile = path.join(base, "config", "opencode", "opencode.json")
    const runtimeManifest = path.join(stateRoot, "versions", "1", "runtime", "rigel-v2-native-agent-manifest.mjs")
    const openclaw = {
      enabled: false,
      channels: { discord: { transport: "discord" } },
      replyPolicy: { "discord-bot": { allowedAuthors: ["operator"] } },
    }
    fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(configFile, "{}\n", { mode: 0o600 })
    fs.writeFileSync(profileFile, JSON.stringify({ profiles: { gabo: { "[opencode]": { openclaw } } } }))

    // when
    const install = spawnSync("node", [installerPath, "install", "--version", "1", "--home", home, "--config", configFile, "--state", stateRoot, "--json"], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH,
        HOME: path.join(base, "installer-home"),
        XDG_CONFIG_HOME: path.join(base, "installer-xdg", "config"),
        XDG_DATA_HOME: path.join(base, "installer-xdg", "data"),
        XDG_STATE_HOME: path.join(base, "installer-xdg", "state"),
        XDG_CACHE_HOME: path.join(base, "installer-xdg", "cache"),
        OMO_DISABLE_PROCESS_CLEANUP: "1",
        RIGEL_V2_PROFILE_FILE: profileFile,
        RIGEL_V2_SG_PROVISION: "0",
      },
      encoding: "utf8",
      timeout: 240_000,
    })

    // then
    expect(install.status, `install failed: ${install.stderr || install.stdout}`).toBe(0)
    const installed = (await import(`${pathToFileURL(runtimeManifest).href}?t=${Date.now()}`)).default
    expect(Object.keys(installed.metadata.global.openclaw).sort()).toEqual(Object.keys(openclaw).sort())
    expect(Object.keys(installed.metadata.global.openclaw.channels).sort()).toEqual(Object.keys(openclaw.channels).sort())
    expect(Object.keys(installed.metadata.global.openclaw.replyPolicy).sort()).toEqual(Object.keys(openclaw.replyPolicy).sort())
  }, 300_000)
})
