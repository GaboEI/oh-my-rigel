/**
 * Contract for the config bootstrap on the PUBLISHED env-variable route.
 *
 * A fresh host has no config yet. Both agent-manifest generation and runtime
 * materialization must READ the config, so when the explicitly provided config
 * path is ABSENT the installer creates its parent and an empty valid config `{}`
 * before generating the manifest. An existing config is never reset; it only
 * receives the Rigel runtime entry, and invalid existing JSON still fails where
 * it is parsed.
 *
 * Positive: absent explicit config -> config created + runtime manifest produced.
 * Preservation: existing valid config -> its content is kept, runtime entry added.
 * Negative: invalid existing JSON -> install fails, the file stays byte-identical.
 *
 * Hermetic: every HOME/state root inside a temp tree; no real HOME, no network.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { AGENT_MODEL_CHAINS } from "./opencode/rigel-v2-native-model-chains.mjs"
import { registerNativeBuiltinMcps } from "./opencode/rigel-v2-native-builtin-mcps.mjs"
import { renderCleanInstallProfile } from "./rigel-v2-clean-install-profile.mjs"

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(moduleDirectory, "../..")
const installerPath = path.join(repoRoot, "profiles/gabo/rigel-v2-user-install.mjs")

const EXPECTED_AGENT_KEYS = [
  "Sisyphus - ultraworker",
  "Hephaestus - Deep Agent",
  "Prometheus - Plan Builder",
  "Atlas - Plan Executor",
  "explore",
  "librarian",
  "Metis - Plan Consultant",
  "Momus - Plan Critic",
  "multimodal-looker",
  "oracle",
  "Sisyphus-Junior",
  "plan",
  "build",
  "judge",
]

function runRoute(home, configFile, stateRoot) {
  return spawnSync("node", [installerPath, "install", "--version", "1", "--json"], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      RIGEL_V2_HOME: home,
      RIGEL_V2_CONFIG: configFile,
      RIGEL_V2_USER_ROOT: stateRoot,
      OMO_DISABLE_PROCESS_CLEANUP: "1",
    },
    encoding: "utf8",
    timeout: 240_000,
  })
}

function runtimeDirAt(stateRoot) {
  return path.join(stateRoot, "versions", "1", "runtime")
}

function runtimeManifestAt(stateRoot) {
  return path.join(runtimeDirAt(stateRoot), "rigel-v2-native-agent-manifest.mjs")
}

async function loadManifest(file) {
  return (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)).default
}

/** The seeded `[opencode]` harness block inside the profile's `gabo` profile. */
function opencodeBlockOf(profile) {
  return profile.profiles.gabo["[opencode]"]
}

/**
 * Canonical chain key for a seeded agent key. Mirrors the runtime's
 * `normalizeAgentName` (strip the ` - <display suffix>` tail), so
 * `"Sisyphus - ultraworker"` maps to the `sisyphus` chain.
 */
function canonicalAgentName(key) {
  return String(key).trim().toLocaleLowerCase().split(/\s+-\s+/)[0].trim()
}

/** Project a canonical chain rung exactly the way the installer seeds `fallback_models`. */
function projectRung(rung) {
  return {
    ...(Array.isArray(rung.providers) && rung.providers.length > 0 ? { providers: [...rung.providers] } : {}),
    model: rung.model,
    ...(typeof rung.variant === "string" && rung.variant ? { variant: rung.variant } : {}),
  }
}

describe("installer config bootstrap: absent explicit config", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-absent-config-"))
  const home = path.join(base, "home")
  // The whole config directory is absent on a fresh host.
  const configFile = path.join(home, ".config", "opencode", "opencode.json")
  const stateRoot = path.join(home, ".local", "share", "oh-my-rigel")
  let install
  let manifest
  let config

  beforeAll(async () => {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    install = runRoute(home, configFile, stateRoot)
    if (install.status === 0) {
      config = JSON.parse(fs.readFileSync(configFile, "utf8"))
      manifest = await loadManifest(runtimeManifestAt(stateRoot))
    }
  }, 300_000)

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  describe("#given no config exists at the explicit path", () => {
    describe("#when the installer runs the published route", () => {
      test("#then it creates a valid config and installs without error", () => {
        expect(install.status, `install failed: ${install.stderr || install.stdout}`).toBe(0)
        expect(fs.existsSync(configFile)).toBe(true)
        expect(Array.isArray(config.plugin)).toBe(true)
        expect(config.plugin).toContain(runtimeDirAt(stateRoot))
      })

      test("#then the runtime manifest and runtime tree are produced", () => {
        expect(fs.existsSync(runtimeManifestAt(stateRoot))).toBe(true)
        expect(fs.existsSync(path.join(runtimeDirAt(stateRoot), "index.js"))).toBe(true)
      })

      test("#then the produced runtime manifest carries the exact 14-agent surface", () => {
        expect(Object.keys(manifest.agents)).toEqual(EXPECTED_AGENT_KEYS)
        expect(manifest.agents.judge.model).toBeUndefined()
      })
    })
  })
})

describe("installer config bootstrap: existing config is preserved", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-existing-config-"))
  const home = path.join(base, "home")
  const configFile = path.join(home, ".config", "opencode", "opencode.json")
  const stateRoot = path.join(home, ".local", "share", "oh-my-rigel")
  const original = { $schema: "https://opencode.ai/config.json", plugin: ["rigel-foreign-plugin"], theme: "custom" }
  let install
  let config

  beforeAll(() => {
    fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(configFile, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 })
    install = runRoute(home, configFile, stateRoot)
    if (install.status === 0) config = JSON.parse(fs.readFileSync(configFile, "utf8"))
  }, 300_000)

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  describe("#given a valid config already exists at the explicit path", () => {
    describe("#when the installer registers the runtime", () => {
      test("#then the install succeeds and the runtime entry is added", () => {
        expect(install.status, `install failed: ${install.stderr || install.stdout}`).toBe(0)
        expect(config.plugin).toContain(runtimeDirAt(stateRoot))
      })

      test("#then the pre-existing content is preserved, not reset", () => {
        expect(config.$schema).toBe(original.$schema)
        expect(config.theme).toBe("custom")
        expect(config.plugin).toContain("rigel-foreign-plugin")
      })
    })
  })
})

describe("installer config bootstrap: invalid existing config still fails", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-invalid-config-"))
  const home = path.join(base, "home")
  const configFile = path.join(home, ".config", "opencode", "opencode.json")
  const stateRoot = path.join(home, ".local", "share", "oh-my-rigel")
  const invalid = "{ \"plugin\": [ /* not valid json */\n"
  let install
  let bytesAfter

  beforeAll(() => {
    fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(configFile, invalid, { mode: 0o600 })
    install = runRoute(home, configFile, stateRoot)
    bytesAfter = fs.readFileSync(configFile)
  }, 300_000)

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  describe("#given the explicit config exists but is not valid JSON", () => {
    describe("#when the installer runs the published route", () => {
      test("#then the install fails and the file is left byte-identical", () => {
        expect(install.status).not.toBe(0)
        expect(bytesAfter.toString("utf8")).toBe(invalid)
        expect(fs.existsSync(runtimeManifestAt(stateRoot))).toBe(false)
      })
    })
  })
})

describe("installer editable OmO profile: seeded on clean install, never overwritten", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-editable-profile-"))
  const home = path.join(base, "home")
  const configFile = path.join(home, ".config", "opencode", "opencode.json")
  const stateRoot = path.join(home, ".local", "share", "oh-my-rigel")
  // The durable config the native runtime reads LIVE for `agents.<id>.model`.
  const profileFile = path.join(home, ".omo", "omo.jsonc")
  const edited = `${JSON.stringify({ agents: { oracle: { model: "opencode-go/deepseek-v4-pro" } } }, null, 2)}\n`
  let seeded
  let afterEdit
  let firstInstall
  let secondInstall

  beforeAll(() => {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    firstInstall = runRoute(home, configFile, stateRoot)
    if (firstInstall.status === 0 && fs.existsSync(profileFile)) {
      seeded = fs.readFileSync(profileFile, "utf8")
      // Simulate the operator editing `agents.<id>.model` in the live config.
      fs.writeFileSync(profileFile, edited, { mode: 0o600 })
    }
    secondInstall = runRoute(home, configFile, stateRoot)
    if (secondInstall.status === 0 && fs.existsSync(profileFile)) {
      afterEdit = fs.readFileSync(profileFile, "utf8")
    }
  }, 300_000)

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  describe("#given a clean install with no OmO profile yet", () => {
    describe("#when the installer materializes the config", () => {
      test("#then it seeds a durable editable ~/.omo/omo.jsonc with every machine token resolved", () => {
        expect(firstInstall.status, `install failed: ${firstInstall.stderr || firstInstall.stdout}`).toBe(0)
        expect(fs.existsSync(profileFile)).toBe(true)
        expect(typeof seeded).toBe("string")
        // The profile-root placeholder must be resolved, or the runtime/loader
        // would try to open the literal `__OMO_PROFILE_ROOT__/...` prompt path.
        expect(seeded.includes("__OMO_PROFILE_ROOT__")).toBe(false)
        expect(JSON.parse(seeded).profiles.gabo).toBeDefined()
      })

      test("#then it seeds each agent's product-default model from the generated manifest", () => {
        const seededProfile = JSON.parse(seeded)
        // A known orchestrated agent present in the manifest carries its
        // product-default model under top-level `agents.<id>`.
        expect(typeof seededProfile.agents?.oracle?.model).toBe("string")
        expect(seededProfile.agents.oracle.model.length).toBeGreaterThan(0)
        expect(typeof seededProfile.agents?.explore?.model).toBe("string")
        // The FULL ordered chain is seeded, not just the head: the remaining
        // canonical rungs land in `fallback_models`, each keeping its providers,
        // model and variant, so the runtime can walk them in order when the head
        // model is unavailable. The manifest is never consulted for models.
        expect(Array.isArray(seededProfile.agents.oracle.fallback_models)).toBe(true)
        expect(seededProfile.agents.oracle.fallback_models.length).toBeGreaterThan(0)
        expect(seededProfile.agents.oracle.fallback_models[0]).toMatchObject({ model: expect.any(String) })
        expect(Array.isArray(seededProfile.agents.oracle.fallback_models[0].providers)).toBe(true)
        // The tracked profile's non-model content is preserved, not replaced.
        expect(seededProfile.profiles.gabo).toBeDefined()
        // The Judge ships with no manifest model, so it is never seeded.
        expect(seededProfile.agents?.judge).toBeUndefined()
      })

      test("#then a later install preserves the user's live model selection", () => {
        expect(secondInstall.status, `install failed: ${secondInstall.stderr || secondInstall.stdout}`).toBe(0)
        expect(typeof afterEdit).toBe("string")
        // The installer seeds the file once and never resets it. The OmO config
        // migration engine may append its own `_migrations` ledger while the
        // profile is read, but it must never clobber the operator's edit.
        expect(JSON.parse(afterEdit).agents.oracle.model).toBe("opencode-go/deepseek-v4-pro")
        // Product defaults (the head model AND its fallback chain) are seeded ONCE
        // on the clean install; a reinstall must not inject the manifest's other
        // agent models or fallback rungs into an existing file.
        expect(JSON.parse(afterEdit).agents.oracle.fallback_models).toBeUndefined()
        // Product defaults are seeded ONCE on the clean install; a reinstall
        // must not inject the manifest's other agent models into the existing
        // file. `explore` is absent from the operator's edit and stays absent.
        expect(JSON.parse(afterEdit).agents.explore).toBeUndefined()
      })
    })
  })
})

describe("clean install with no external Context7", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-clean-no-c7-"))
  const home = path.join(base, "home")
  const configFile = path.join(home, ".config", "opencode", "opencode.json")
  const stateRoot = path.join(home, ".local", "share", "oh-my-rigel")
  // A generic host: no MCP block at all, so no external Context7 exists.
  const config = { $schema: "https://opencode.ai/config.json", plugin: ["rigel-foreign-plugin"] }
  let install
  let seededProfile
  let manifest

  beforeAll(async () => {
    fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    install = runRoute(home, configFile, stateRoot)
    if (install.status === 0) {
      seededProfile = JSON.parse(fs.readFileSync(path.join(home, ".omo", "omo.jsonc"), "utf8"))
      manifest = await loadManifest(runtimeManifestAt(stateRoot))
    }
  }, 300_000)

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  describe("#given a clean install whose OpenCode config declares no Context7", () => {
    describe("#when the installer seeds the profile and builds the manifest", () => {
      test("#then Ultrawork is off and the builtin Context7 is left enabled", () => {
        expect(install.status, `install failed: ${install.stderr || install.stdout}`).toBe(0)
        const block = opencodeBlockOf(seededProfile)
        expect(block.disabled_mcps).not.toContain("context7")
        expect(block.default_mode).toEqual({ goal: false, ultrawork: false })
        expect(manifest.modes.defaultUltrawork).toBe(false)
      })

      test("#then the policy ran before the manifest build (no Context7 in the MCP denylist)", () => {
        expect(manifest.metadata.global.mcp.disabled).not.toContain("context7")
      })

      test("#then exactly one real Context7 is live: with no external the builtin is registered once", async () => {
        const host = new Map()
        const collection = { get: (name) => host.get(name), set: (name, config) => host.set(name, config) }
        function fakeDomain(c) { return { transform: async (cb) => { cb(c); return { dispose: undefined } } } }
        const result = await registerNativeBuiltinMcps({ mcp: fakeDomain(collection) }, {
          retained: manifest.metadata.global.mcpPolicy.retained,
          disabledMcps: manifest.metadata.global.mcp.disabled,
          env: {},
        })
        expect(result.registered.filter((name) => name === "context7")).toHaveLength(1)
        expect(host.get("context7")).toMatchObject({ type: "remote", url: "https://mcp.context7.com/mcp", oauth: false })
      })

      test("#then each seeded agent's head model matches the manifest's resolved model", () => {
        for (const [key, record] of Object.entries(manifest.agents)) {
          if (typeof record.model !== "string" || record.model === "") continue
          const seeded = seededProfile.agents[key]
          expect(seeded, `agent ${key} was not seeded`).toBeDefined()
          expect(seeded.model).toBe(record.model)
          if (typeof record.variant === "string" && record.variant) expect(seeded.variant).toBe(record.variant)
          else expect(seeded.variant).toBeUndefined()
        }
        // Explicit product pins: the chain head, provider-prefixed, plus its variant.
        expect(seededProfile.agents["Hephaestus - Deep Agent"]).toMatchObject({ model: "openai/gpt-6-sol", variant: "medium" })
        const prometheus = seededProfile.agents["Prometheus - Plan Builder"]
        expect(prometheus).toMatchObject({ model: "anthropic/claude-fable-5-1", variant: "xhigh" })
        expect(prometheus.fallback_models).toHaveLength(2)
      })

      test("#then Prometheus is seeded and the model-less judge is not", () => {
        // Regression guard: the gated coordinator carried no resolved manifest
        // model, so before the seeding fix it was silently dropped from the file.
        expect(seededProfile.agents["Prometheus - Plan Builder"]).toBeDefined()
        expect(seededProfile.agents.judge).toBeUndefined()
      })

      test("#then each canonical agent's fallback tail matches the canonical chain", () => {
        for (const [key, seeded] of Object.entries(seededProfile.agents)) {
          const chain = AGENT_MODEL_CHAINS[canonicalAgentName(key)]
          if (!chain) continue
          const expectedTail = chain.slice(1).map(projectRung)
          if (expectedTail.length === 0) {
            expect(seeded.fallback_models).toBeUndefined()
            continue
          }
          expect(seeded.fallback_models).toEqual(expectedTail)
          // The chain head is seeded provider-prefixed (`providers[0]/model`) and a
          // manifest-resolved model is seeded verbatim, so only assert the derived
          // head when the manifest record carries no model of its own. No provider
          // transform mismatch was observed for any seeded canonical agent.
          const record = manifest.agents[key]
          if (!(record && typeof record.model === "string" && record.model)) {
            const head = chain[0]
            expect(seeded.model).toBe(`${head.providers[0]}/${head.model}`)
            if (typeof head.variant === "string" && head.variant) expect(seeded.variant).toBe(head.variant)
          }
        }
      })
    })
  })
})

describe("clean install with external Context7", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-clean-ext-c7-"))
  const home = path.join(base, "home")
  const configFile = path.join(home, ".config", "opencode", "opencode.json")
  const stateRoot = path.join(home, ".local", "share", "oh-my-rigel")
  const original = {
    $schema: "https://opencode.ai/config.json",
    theme: "custom",
    plugin: ["rigel-foreign-plugin"],
    mcp: { context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true } },
  }
  let install
  let seededProfile
  let manifest
  let configAfter

  beforeAll(async () => {
    fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(configFile, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 })
    install = runRoute(home, configFile, stateRoot)
    if (install.status === 0) {
      seededProfile = JSON.parse(fs.readFileSync(path.join(home, ".omo", "omo.jsonc"), "utf8"))
      configAfter = JSON.parse(fs.readFileSync(configFile, "utf8"))
      manifest = await loadManifest(runtimeManifestAt(stateRoot))
    }
  }, 300_000)

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  describe("#given a clean install whose OpenCode config runs an external Context7", () => {
    describe("#when the installer seeds the profile and builds the manifest", () => {
      test("#then the seed never bakes a Context7 disable and the user's config is preserved", () => {
        expect(install.status, `install failed: ${install.stderr || install.stdout}`).toBe(0)
        // The clean seed must NOT bake the Context7 decision: the runtime owns it
        // so a later removal of the external server self-reconciles on restart.
        expect(opencodeBlockOf(seededProfile).disabled_mcps).not.toContain("context7")
        expect(configAfter.$schema).toBe(original.$schema)
        expect(configAfter.theme).toBe("custom")
        expect(configAfter.mcp.context7).toEqual(original.mcp.context7)
        expect(configAfter.plugin).toContain("rigel-foreign-plugin")
        expect(configAfter.plugin).toContain(runtimeDirAt(stateRoot))
      })

      test("#then the manifest MCP denylist does not carry Context7", () => {
        expect(manifest.metadata.global.mcp.disabled).not.toContain("context7")
      })

      test("#then exactly one real Context7 is live: the external collides, the builtin is omitted", async () => {
        // The live host already serves context7 (the user's external server); the
        // builtin registration must skip the name collision, leaving exactly one.
        const host = new Map([["context7", { type: "remote", url: "https://mcp.context7.com/mcp" }]])
        const collection = { get: (name) => host.get(name), set: (name, config) => host.set(name, config) }
        function fakeDomain(c) { return { transform: async (cb) => { cb(c); return { dispose: undefined } } } }
        const result = await registerNativeBuiltinMcps({ mcp: fakeDomain(collection) }, {
          retained: manifest.metadata.global.mcpPolicy.retained,
          disabledMcps: manifest.metadata.global.mcp.disabled,
          env: {},
        })
        expect(result.registered).not.toContain("context7")
        expect([...host.values()].filter((entry) => typeof entry.url === "string" && entry.url.includes("mcp.context7.com"))).toHaveLength(1)
        expect(configAfter.mcp.context7).toEqual(original.mcp.context7)
      })
    })
  })
})

describe("reinstall over a sentinel OmO profile preserves the operator's edits", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-sentinel-profile-"))
  const home = path.join(base, "home")
  const configFile = path.join(home, ".config", "opencode", "opencode.json")
  const stateRoot = path.join(home, ".local", "share", "oh-my-rigel")
  const profileFile = path.join(home, ".omo", "omo.jsonc")
  const sentinel = {
    agents: {
      "Prometheus - Plan Builder": { model: "opencode-go/deepseek-v4-pro" },
      oracle: { model: "x/y" },
    },
    profiles: {
      gabo: {
        "[opencode]": {
          default_mode: { goal: false, ultrawork: true },
          disabled_mcps: ["context7"],
        },
      },
    },
  }
  let install
  let beforeRaw
  let afterRaw
  let before
  let after
  let manifest

  beforeAll(async () => {
    fs.mkdirSync(path.join(home, ".omo"), { recursive: true, mode: 0o700 })
    fs.writeFileSync(profileFile, `${JSON.stringify(sentinel, null, 2)}\n`, { mode: 0o600 })
    beforeRaw = fs.readFileSync(profileFile, "utf8")
    before = JSON.parse(beforeRaw)
    install = runRoute(home, configFile, stateRoot)
    afterRaw = fs.readFileSync(profileFile, "utf8")
    after = JSON.parse(afterRaw)
    if (install.status === 0) manifest = await loadManifest(runtimeManifestAt(stateRoot))
  }, 300_000)

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  describe("#given an existing OmO profile carrying operator edits", () => {
    describe("#when the installer runs again", () => {
      test("#then the profile is byte-identical and the sentinel values survive", () => {
        expect(install.status, `install failed: ${install.stderr || install.stdout}`).toBe(0)
        // The installer seeds the profile ONCE; a reinstall must not rewrite an
        // existing file at all. The bytes are preserved verbatim because the
        // builder is spawned without a real-home `--directory`: the OmO migration
        // engine no longer reads this file as a project layer, so it cannot append
        // its `_migrations` ledger to an existing config.
        expect(afterRaw).toBe(beforeRaw)
        expect(after.agents["Prometheus - Plan Builder"].model).toBe("opencode-go/deepseek-v4-pro")
        expect(after.agents.oracle.model).toBe("x/y")
        expect(after.profiles.gabo["[opencode]"].default_mode.ultrawork).toBe(true)
        // An explicit `disabled_mcps` the user already chose in an existing config
        // is respected verbatim (never rewritten, never completed).
        expect(after.profiles.gabo["[opencode]"].disabled_mcps).toEqual(["context7"])
        expect(after).toEqual(before)
        // The runtime honors that existing choice: the regenerated manifest denylist
        // still carries context7, so the builtin stays omitted for this config.
        expect(manifest.metadata.global.mcp.disabled).toContain("context7")
      })
    })
  })
})

describe("renderCleanInstallProfile drops the baked Context7 decision", () => {
  const preFixSeed = {
    profiles: {
      gabo: {
        "[opencode]": {
          disabled_mcps: ["context7", "docs"],
          default_mode: { goal: false, ultrawork: true },
        },
      },
    },
  }

  describe("#given the pre-fix seed that baked a Context7 disable and drove Ultrawork", () => {
    describe("#when the clean-install profile is rendered", () => {
      test("#then it drops context7, keeps every other disable, and forces Ultrawork off", () => {
        const rendered = renderCleanInstallProfile(preFixSeed)
        const block = opencodeBlockOf(rendered)
        expect(block.disabled_mcps).not.toContain("context7")
        expect(block.disabled_mcps).toContain("docs")
        expect(block.default_mode).toEqual({ goal: false, ultrawork: false })
      })

      test("#then the input object is not mutated", () => {
        renderCleanInstallProfile(preFixSeed)
        expect(preFixSeed.profiles.gabo["[opencode]"].disabled_mcps).toEqual(["context7", "docs"])
        expect(preFixSeed.profiles.gabo["[opencode]"].default_mode.ultrawork).toBe(true)
      })

      test("#then rendering is idempotent", () => {
        const once = renderCleanInstallProfile(preFixSeed)
        const twice = renderCleanInstallProfile(once)
        expect(twice).toEqual(once)
      })
    })
  })
})
