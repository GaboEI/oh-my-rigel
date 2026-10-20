/**
 * Hermetic parity contract for 5 V1 `cli/` rows with a real runtime effect.
 * Each row pins the native V2 mechanism against the real V1 owner; nothing here
 * launches OpenCode (the live contracts are named per row).
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateConfigFile } from "../../packages/utils/src/migration/config-migration.ts"
import { validatePluginConfig } from "../../packages/omo-opencode/src/config/validate.ts"
import { compareVersions } from "../../packages/omo-opencode/src/shared/opencode-version.ts"
import {
  checkNativeHostVersion,
  compareNativeVersions,
  deriveNativeMinOpenCodeVersion,
  readNativeMinOpenCodeVersion,
  resolveNativePluginConfig,
} from "./opencode/rigel-v2-native-config.mjs"
import { delegateNamedAgent } from "./opencode/rigel-v2-native-core.mjs"
import { listV2Models } from "./opencode/rigel-v2-native-categories.mjs"
import { AGENT_MODEL_CHAINS, resolveFallbackModel } from "./opencode/rigel-v2-native-model-chains.mjs"
import plugin from "./opencode/rigel-v2-native.mjs"
import nativeManifest from "./opencode/rigel-v2-native-agent-manifest.mjs"

const integrationManifest = JSON.parse(readFileSync(new URL("./integration-manifest.json", import.meta.url), "utf8"))
const created = []

function makeFixture() {
  const home = mkdtempSync(join(tmpdir(), "rigel-cli-parity-"))
  const project = join(home, "project")
  mkdirSync(join(home, ".omo"), { recursive: true })
  mkdirSync(join(project, ".omo"), { recursive: true })
  created.push(home)
  return {
    home,
    project,
    writeUser: (text) => writeFileSync(join(home, ".omo", "omo.jsonc"), text),
    writeProject: (text) => writeFileSync(join(project, ".omo", "omo.jsonc"), text),
    resolve: () => resolveNativePluginConfig({ directory: project, env: { HOME: home, USERPROFILE: home } }),
  }
}

afterEach(() => {
  while (created.length > 0) rmSync(created.pop(), { recursive: true, force: true })
})

// Row 1 `run` (`cli/run/runner.ts`): V1 creates a session, prompts it, drives it
// to idle. V2 owns no plugin session loop, so the native runtime drives the HOST
// session API (create -> prompt -> wait/context). Live proof is the sibling
// `profiles/gabo/qa-v2-builtin-mcps.mjs` (create + prompt + idle against
// `opencode-v2-lab.service`) and `qa-v2-native-delegation.mjs`. This launches
// nothing.
describe("#given the native runtime non-interactive session flow", () => {
  test("#when a session is driven #then it goes create -> prompt(resume) -> wait -> context on the host API", async () => {
    const calls = []
    const client = {
      session: {
        create: async (input) => { calls.push(["create", input]); return { data: { id: "ses_run" } } },
        prompt: async (input) => { calls.push(["prompt", input]); return { data: {} } },
        wait: async (input) => { calls.push(["wait", input]); return { data: {} } },
        context: async (input) => { calls.push(["context", input]); return [{ type: "assistant", content: [{ type: "text", text: "RIGEL_RUN_DONE" }] }] },
      },
    }
    const result = await delegateNamedAgent({ client, location: { directory: "/native-v2" }, agent: { id: "explore", name: "Explore" }, prompt: "Do the work." })
    expect(calls.map(([name]) => name)).toEqual(["create", "prompt", "wait", "context"])
    expect(calls[1][1]).toMatchObject({ sessionID: "ses_run", resume: true })
    expect(result).toEqual({ sessionID: "ses_run", agent: "Explore", background: false, result: "RIGEL_RUN_DONE" })
  })

  test("#when the host exposes no session API #then the runtime refuses instead of running its own loop", async () => {
    await expect(delegateNamedAgent({ client: {}, location: {}, agent: { id: "explore" }, prompt: "x" }))
      .rejects.toThrow("session.create/session.prompt is unavailable")
  })
})

// Row 2 `config-migrate` (`startup-migration.ts` -> runOpenCodeStartupMigration; automatic only):
// V1 migrates legacy keys; V2 migrates them in-memory in the resolver. Each case
// is pinned to the real V1 owner of that exact key.
describe("#given the native loader legacy-key migration table", () => {
  test("#when ralph_loop is present #then native and the real V1 loader migrate the same goal (values: parity test)", () => {
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "ralph_loop": { "enabled": true, "default_max_iterations": 42 } } }`)
    const native = fixture.resolve()
    const real = validatePluginConfig(fixture.project, { HOME: fixture.home, USERPROFILE: fixture.home })
    expect(native.goal).toBeDefined()
    expect(native.goal).toEqual(real.config.goal)
  })

  test("#when experimental.hashline_edit is present #then both move it to the root key", () => {
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "experimental": { "hashline_edit": true } } }`)
    const configPath = join(fixture.home, "legacy-omo.jsonc")
    writeFileSync(configPath, `{ "experimental": { "hashline_edit": true } }`)
    const rawLegacy = { experimental: { hashline_edit: true } }
    const native = fixture.resolve()
    migrateConfigFile(configPath, rawLegacy)
    expect(native.hashline_edit).toBe(true)
    expect(rawLegacy.hashline_edit).toBe(true)
    expect(rawLegacy.experimental).toBeUndefined()
  })
})

// Row 3 `config-manager` (`cli/config-manager/`): V1 install-time load/merge and
// user-only field protection. V2 resolves the same view natively; the contract is
// a differential against the real V1 loader plus the native layer-load contract.
describe("#given install-time config load, merge and field protection", () => {
  test("#when user and project layers disagree #then the native resolver equals the V1 loader and keeps the user-only allowlist", () => {
    const fixture = makeFixture()
    fixture.writeUser(`{ "[opencode]": { "monitor": { "enabled": true, "live_mode_enabled": true }, "mcp_env_allowlist": ["USER_VAR"] } }`)
    fixture.writeProject(`{ "[opencode]": { "monitor": { "enabled": false }, "mcp_env_allowlist": ["PROJECT_VAR"] } }`)
    const native = fixture.resolve()
    const real = validatePluginConfig(fixture.project, { HOME: fixture.home, USERPROFILE: fixture.home })
    expect(native.monitor.enabled).toBe(real.config.monitor.enabled)
    expect(native.monitor.enabled).toBe(false)
    expect(native.mcp_env_allowlist).toEqual(real.config.mcp_env_allowlist)
    expect(native.mcp_env_allowlist).toEqual(["USER_VAR"])
    expect(native.sources.filter((source) => source.loaded).map((source) => source.scope).sort()).toEqual(["project", "user"])
  })
})

// Row 4 `refresh-model-capabilities` (`cli/refresh-model-capabilities.ts`): V1
// refreshes a models.dev cache. V2 has no separate cache: the host resolves the
// catalog (`/api/model`) and the runtime resolves against that host inventory.
// The live catalog (98 models) is proven by the lab; this is the hermetic half.
describe("#given the host model catalog is the runtime source", () => {
  test("#when the host advertises a model #then the native fallback resolves it from the host inventory", async () => {
    const client = { model: { list: async () => ({ data: [{ providerID: "openai", id: "gpt-6-luna-fast", enabled: true }] }) } }
    const available = await listV2Models(client, { directory: "/native-v2" })
    const resolved = resolveFallbackModel({ chain: AGENT_MODEL_CHAINS.explore, availableModels: available, currentModel: "missing-model" })
    expect(resolved).toEqual({ providerID: "openai", id: "gpt-6-luna-fast", variant: "low" })
  })

  test("#when the host advertises nothing #then a chain-named model stays unresolved, with no bundled-cache fallback", () => {
    const resolved = resolveFallbackModel({ chain: AGENT_MODEL_CHAINS.sisyphus, availableModels: [], currentModel: "anthropic/claude-opus-5-5" })
    expect(resolved).toBeUndefined()
  })
})

// Row 5 `minimum-opencode-version` (`cli/minimum-opencode-version.ts`): V1 refuses
// an unsupported host. V2 materializes the minimum from integration-manifest.json
// platform.opencode and refuses setup below it.
describe("#given the materialized minimum OpenCode version", () => {
  test("#when the integration manifest declares a range #then derivation and the manifest reader agree on the bare minimum", () => {
    const minimum = deriveNativeMinOpenCodeVersion(integrationManifest)
    expect(minimum).toBe("2.0.19")
    expect(readNativeMinOpenCodeVersion({ metadata: { global: { minOpenCodeVersion: minimum } } })).toBe("2.0.19")
    expect(readNativeMinOpenCodeVersion({ metadata: { global: {} } })).toBeUndefined()
  })

  test("#when each boundary is compared #then the native comparator agrees with the V1 comparator", () => {
    const pairs = [["2.0.18", "2.0.19"], ["2.0.19", "2.0.19"], ["2.1.0", "2.0.19"], ["v2.0.20", "2.0.19"], ["2.0.19-beta.1", "2.0.19"]]
    for (const [left, right] of pairs) expect(compareNativeVersions(left, right)).toBe(compareVersions(left, right))
  })

  test("#when the host version is below the minimum #then setup refuses with a clear error", async () => {
    const originalMetadata = nativeManifest.metadata
    nativeManifest.metadata = { global: { minOpenCodeVersion: deriveNativeMinOpenCodeVersion(integrationManifest) } }
    try {
      await expect(plugin.setup({ location: { directory: "/native-v2" }, app: { version: "2.0.18" }, tool: { transform: async () => ({ dispose() {} }) } }))
        .rejects.toThrow(/requires OpenCode 2\.0\.19\+/)
    } finally {
      if (originalMetadata === undefined) delete nativeManifest.metadata
      else nativeManifest.metadata = originalMetadata
    }
  })

  test("#when the host version is at or above the minimum #then the check passes", () => {
    const manifest = { metadata: { global: { minOpenCodeVersion: "2.0.19" } } }
    expect(checkNativeHostVersion(manifest, "2.0.19")).toMatchObject({ checked: true, ok: true })
    expect(checkNativeHostVersion(manifest, "2.1.0")).toMatchObject({ checked: true, ok: true })
  })

  test("#when the host does not publish a version #then the check degrades without throwing", () => {
    const manifest = { metadata: { global: { minOpenCodeVersion: "2.0.19" } } }
    for (const hostVersion of [undefined, null, ""]) {
      expect(checkNativeHostVersion(manifest, hostVersion)).toEqual({ checked: false, ok: true })
    }
    expect(checkNativeHostVersion({ metadata: { global: {} } }, "1.0.0")).toEqual({ checked: false, ok: true })
  })
})
