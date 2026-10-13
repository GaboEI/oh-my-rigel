import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import path from "node:path"

import {
  CONTEXT7_MCP_NAME,
  GREP_APP_MCP,
  createAncestorCliCandidates,
  createBuiltinMcpConfigs,
  createContext7McpConfig,
  createLspMcpConfig,
  hasCliSuffix,
  normalizeContext7ApiKey,
  registerNativeBuiltinMcps,
  resolveOpenCodeConfigDir,
  resolveRuntimeExecutable,
} from "./rigel-v2-native-builtin-mcps.mjs"

const REPO = "/repo"
// A root that owns nothing: used as the explicit self/repo anchor when a test
// wants to prove a candidate is NOT resolved from that root.
const EMPTY = "/empty-root"
const DAEMON_DIST = path.join(REPO, "packages/lsp-daemon/dist/cli.js")
const DAEMON_SOURCE = path.join(REPO, "packages/lsp-daemon/src/cli.ts")
const TOOLS_DIST = path.join(REPO, "packages/lsp-tools-mcp/dist/cli.js")
const DAEMON_PKG = path.join(REPO, "packages/lsp-daemon/package.json")
const ROOT_PKG = path.join(REPO, "package.json")

function layoutAt(root, { dist = false, source = false, toolsDist = false, daemonVersion = "9.9.9" } = {}) {
  const files = new Map()
  if (dist) files.set(path.join(root, "packages/lsp-daemon/dist/cli.js"), "")
  if (source) files.set(path.join(root, "packages/lsp-daemon/src/cli.ts"), "")
  if (toolsDist) files.set(path.join(root, "packages/lsp-tools-mcp/dist/cli.js"), "")
  files.set(path.join(root, "packages/lsp-daemon/package.json"), JSON.stringify({ version: daemonVersion }))
  files.set(path.join(root, "package.json"), "{}")
  return {
    exists: (candidate) => files.has(candidate),
    readFile: (candidate) => {
      if (!files.has(candidate)) throw new Error(`ENOENT: ${candidate}`)
      return files.get(candidate)
    },
  }
}

function layout(options = {}) {
  return layoutAt(REPO, options)
}

const available = (name) => ({ command: `/usr/bin/${name}`, available: true })
const unavailable = (name) => ({ command: name, available: false })

function fakeCollection(existing = []) {
  const map = new Map(existing.map((name) => [name, { type: "remote", url: "https://existing.invalid" }]))
  return { get: (name) => map.get(name), set: (name, config) => map.set(name, config), map }
}

function fakeDomain(collection, disposer) {
  return { transform: async (callback) => { callback(collection); return { dispose: disposer } } }
}

describe("native builtin MCP port", () => {
  describe("#given hasCliSuffix #when comparing paths #then it normalizes separators", () => {
    test("#then windows separators match and a different suffix does not", () => {
      expect(hasCliSuffix("C:\\a\\dist\\cli.js", "dist/cli.js")).toBe(true)
      expect(hasCliSuffix("/a/dist/cli.js", "src/cli.ts")).toBe(false)
    })
  })

  describe("#given resolveRuntimeExecutable #when the command name is unsafe #then it is unavailable", () => {
    test("#then traversal, separators, drive letters and NUL are refused", () => {
      for (const name of ["../node", "a/b", "a\\b", "C:node", "node\0evil", ""]) {
        expect(resolveRuntimeExecutable(name)).toEqual({ command: name, available: false })
      }
    })

    test("#then node resolves to the running node executable and other commands go through which", () => {
      expect(resolveRuntimeExecutable("node", { execPath: "/usr/bin/node" })).toEqual({ command: "/usr/bin/node", available: true })
      expect(resolveRuntimeExecutable("bun", { which: () => "/opt/bun" })).toEqual({ command: "/opt/bun", available: true })
      expect(resolveRuntimeExecutable("bun", { which: () => null })).toEqual({ command: "bun", available: false })
    })
  })

  describe("#given createAncestorCliCandidates #when walking the repo root #then dist and source candidates are emitted", () => {
    test("#then the repo candidate carries both CLI shapes", () => {
      const fsx = layout({ dist: true, source: true, toolsDist: true })
      const candidates = createAncestorCliCandidates({
        startDirectory: REPO,
        packageRel: "packages/lsp-daemon",
        distCliRel: "dist/cli.js",
        sourceCliRel: "src/cli.ts",
        pathExists: fsx.exists,
        resolveExecutable: available,
      })
      expect(candidates[0].path).toBe(DAEMON_DIST)
      expect(candidates[0].exists).toBe(true)
      expect(candidates[1].path).toBe(DAEMON_SOURCE)
      expect(candidates[1].exists).toBe(true)
    })
  })

  describe("#given createLspMcpConfig #when the dist CLI is present #then it becomes a V2 local server", () => {
    test("#then the command runs the dist CLI under node and the env is lab-scoped", () => {
      const fsx = layout({ dist: true, source: true, toolsDist: true })
      const config = createLspMcpConfig({ repoRoot: REPO, cwd: "/work", configDir: "/labcfg", exists: fsx.exists, readFile: fsx.readFile, resolveExecutable: available })
      expect(config.type).toBe("local")
      expect(config.disabled).toBe(false)
      expect(config.command).toEqual(["/usr/bin/node", DAEMON_DIST, "mcp"])
      expect(config.cwd).toBe("/work")
      expect(config.environment.LSP_TOOLS_MCP_CWD).toBe("/work")
      expect(config.environment.LSP_TOOLS_MCP_USER_CONFIG).toBe("/labcfg/lsp.json")
      expect(config.environment.LSP_TOOLS_MCP_INSTALL_DECISIONS).toBe("/labcfg/lsp-install-decisions.json")
      expect(config.environment.LSP_TOOLS_MCP_PROJECT_CONFIG).toBe(
        [".opencode/lsp.json", ".omo/lsp.json", ".omo/lsp-client.json"].map((entry) => path.join("/work", entry)).join(path.delimiter),
      )
    })
  })

  describe("#given createLspMcpConfig #when only the source CLI is available #then it runs under bun with the daemon markers", () => {
    test("#then the source candidate is selected and OMO_LSP_DAEMON_CLI/VERSION are exported", () => {
      const fsx = layout({ dist: false, source: true, toolsDist: true, daemonVersion: "1.2.3" })
      const config = createLspMcpConfig({ repoRoot: REPO, cwd: "/work", configDir: "/labcfg", exists: fsx.exists, readFile: fsx.readFile, resolveExecutable: available })
      expect(config.command).toEqual(["/usr/bin/bun", DAEMON_SOURCE, "mcp"])
      expect(config.environment.OMO_LSP_DAEMON_CLI).toBe(DAEMON_SOURCE)
      expect(config.environment.OMO_LSP_DAEMON_VERSION).toBe("1.2.3")
      expect(config.disabled).toBe(false)
    })
  })

  describe("#given createLspMcpConfig #when no self-contained CLI exists anywhere #then it disables instead of running an unresolvable install", () => {
    test("#then the server is disabled and no package-manager install command is ever emitted", () => {
      const fsx = layout({ dist: false, source: false, toolsDist: false })
      const config = createLspMcpConfig({ selfRoot: EMPTY, repoRoot: REPO, cwd: "/work", configDir: "/labcfg", exists: fsx.exists, readFile: fsx.readFile, resolveExecutable: available })
      expect(config.disabled).toBe(true)
      expect(config.command).toEqual([])
      // The repo declares `workspace:*` dependencies that npm cannot resolve, so
      // the runtime must never emit a bootstrap/install that depends on them.
      const serialized = JSON.stringify(config.command)
      expect(serialized).not.toContain("install")
      expect(serialized).not.toContain("--prefix")
      expect(serialized).not.toContain("npm")
    })

    test("#then the server is disabled when no javascript runtime is available either", () => {
      const fsx = layout({ dist: false, source: false, toolsDist: false })
      const config = createLspMcpConfig({ selfRoot: EMPTY, repoRoot: REPO, cwd: "/work", configDir: "/labcfg", exists: fsx.exists, readFile: fsx.readFile, resolveExecutable: unavailable })
      expect(config.disabled).toBe(true)
      expect(config.command).toEqual([])
    })
  })

  describe("#given createLspMcpConfig #when the deployment owns a self-contained dist #then it resolves without the source root", () => {
    test("#then the deployment dist is selected even though repoRoot has no LSP tree", () => {
      const deployRoot = "/deploy/runtime"
      const deployDist = path.join(deployRoot, "packages/lsp-daemon/dist/cli.js")
      const fsx = layoutAt(deployRoot, { dist: true })
      const config = createLspMcpConfig({ selfRoot: deployRoot, repoRoot: EMPTY, cwd: "/work", configDir: "/labcfg", exists: fsx.exists, readFile: fsx.readFile, resolveExecutable: available })
      expect(config.disabled).toBe(false)
      expect(config.command).toEqual(["/usr/bin/node", deployDist, "mcp"])
    })
  })

  describe("#given createBuiltinMcpConfigs #when applying the retention policy #then only retained builtins are emitted", () => {
    test("#then grep_app and lsp are emitted and context7/websearch are never present", () => {
      const configs = createBuiltinMcpConfigs({ disabledMcps: ["context7"], retained: ["grep_app", "lsp"], repoRoot: REPO, cwd: "/w", configDir: "/c", exists: layout({ dist: true }).exists, readFile: layout({ dist: true }).readFile, resolveExecutable: available })
      expect(Object.keys(configs).sort()).toEqual(["grep_app", "lsp"])
      expect(configs.grep_app).toEqual({ type: "remote", url: "https://mcp.grep.app", disabled: false, oauth: false })
      expect(configs.context7).toBeUndefined()
      expect(configs.websearch).toBeUndefined()
    })

    test("#then a disabled retained server is omitted", () => {
      const configs = createBuiltinMcpConfigs({ disabledMcps: ["grep_app"], retained: ["grep_app", "lsp"], repoRoot: REPO, cwd: "/w", configDir: "/c", exists: layout({ dist: true }).exists, readFile: layout({ dist: true }).readFile, resolveExecutable: available })
      expect(Object.keys(configs)).toEqual(["lsp"])
    })

    test("#then a server outside the retained list is omitted", () => {
      const configs = createBuiltinMcpConfigs({ disabledMcps: [], retained: ["grep_app"], repoRoot: REPO, cwd: "/w", configDir: "/c", exists: layout({ dist: true }).exists, readFile: layout({ dist: true }).readFile, resolveExecutable: available })
      expect(Object.keys(configs)).toEqual(["grep_app"])
    })

    test("#then an absent retained list defaults to every retained builtin", () => {
      const configs = createBuiltinMcpConfigs({ disabledMcps: [], repoRoot: REPO, cwd: "/w", configDir: "/c", exists: layout({ dist: true }).exists, readFile: layout({ dist: true }).readFile, resolveExecutable: available })
      expect(Object.keys(configs).sort()).toEqual(["context7", "grep_app", "lsp"])
    })
  })

  describe("#given the exclusive Context7 policy #when the profile retains it and has not disabled it #then the official builtin is emitted", () => {
    test("#then the config matches the V1 remote definition and carries no key header", () => {
      const configs = createBuiltinMcpConfigs({ disabledMcps: [], retained: ["grep_app", "lsp", "context7"], env: {}, repoRoot: REPO, cwd: "/w", configDir: "/c", exists: layout({ dist: true }).exists, readFile: layout({ dist: true }).readFile, resolveExecutable: available })
      expect(configs[CONTEXT7_MCP_NAME]).toEqual({ type: "remote", url: "https://mcp.context7.com/mcp", disabled: false, oauth: false })
    })

    test("#then an optional CONTEXT7_API_KEY becomes a bearer header and appears nowhere else in the config", () => {
      const config = createContext7McpConfig({ CONTEXT7_API_KEY: "ctx7-secret-value" })
      expect(config.headers).toEqual({ Authorization: "Bearer ctx7-secret-value" })
      expect(config.url).toBe("https://mcp.context7.com/mcp")
      // The credential lives ONLY in the Authorization header: every other field
      // is serialized without it.
      const { headers, ...rest } = config
      expect(JSON.stringify(rest)).not.toContain("ctx7-secret-value")
    })

    test("#then absent, empty, and placeholder keys emit no header", () => {
      expect(createContext7McpConfig({}).headers).toBeUndefined()
      expect(createContext7McpConfig({ CONTEXT7_API_KEY: "   " }).headers).toBeUndefined()
      expect(createContext7McpConfig({ CONTEXT7_API_KEY: "your api key" }).headers).toBeUndefined()
      expect(normalizeContext7ApiKey(undefined)).toBeNull()
      expect(normalizeContext7ApiKey("  real  ")).toBe("real")
      // Punctuation-only values normalize to nothing and must not become a header.
      expect(normalizeContext7ApiKey('""')).toBeNull()
      expect(normalizeContext7ApiKey("<>")).toBeNull()
      expect(createContext7McpConfig({ CONTEXT7_API_KEY: '""' }).headers).toBeUndefined()
    })
  })

  describe("#given the exclusive Context7 policy #when the profile disables it or the host already serves it #then the builtin is omitted", () => {
    test("#then a disabled context7 is not emitted", () => {
      const configs = createBuiltinMcpConfigs({ disabledMcps: ["context7"], retained: ["grep_app", "lsp", "context7"], env: {}, repoRoot: REPO, cwd: "/w", configDir: "/c", exists: layout({ dist: true }).exists, readFile: layout({ dist: true }).readFile, resolveExecutable: available })
      expect(configs[CONTEXT7_MCP_NAME]).toBeUndefined()
    })

    test("#then a non-retained context7 is not emitted", () => {
      const configs = createBuiltinMcpConfigs({ disabledMcps: [], retained: ["grep_app", "lsp"], env: {}, repoRoot: REPO, cwd: "/w", configDir: "/c", exists: layout({ dist: true }).exists, readFile: layout({ dist: true }).readFile, resolveExecutable: available })
      expect(configs[CONTEXT7_MCP_NAME]).toBeUndefined()
    })

    test("#then an external Context7 in the host collection is preserved and the builtin is skipped", async () => {
      const collection = fakeCollection(["context7"])
      collection.map.get("context7").url = "https://mcp.context7.com/mcp"
      const result = await registerNativeBuiltinMcps({ mcp: fakeDomain(collection) }, { retained: ["grep_app", "lsp", "context7"], disabledMcps: [], env: { CONTEXT7_API_KEY: "ctx7-secret-value" }, repoRoot: REPO, cwd: "/w", configDir: "/c", exists: layout({ dist: true }).exists, readFile: layout({ dist: true }).readFile, resolveExecutable: available })
      expect(result.registered).not.toContain(CONTEXT7_MCP_NAME)
      expect(collection.map.get("context7").url).toBe("https://mcp.context7.com/mcp")
      expect([...collection.map.values()].filter((entry) => typeof entry.url === "string" && entry.url.includes("mcp.context7.com"))).toHaveLength(1)
    })
  })

  describe("#given the exclusive Context7 policy #when no external server exists #then exactly one builtin Context7 is registered", () => {
    test("#then the inventory names context7 once and exposes no credential", async () => {
      const collection = fakeCollection()
      const result = await registerNativeBuiltinMcps({ mcp: fakeDomain(collection) }, { retained: ["grep_app", "lsp", "context7"], disabledMcps: [], env: { CONTEXT7_API_KEY: "ctx7-secret-value" }, repoRoot: REPO, cwd: "/w", configDir: "/c", exists: layout({ dist: true }).exists, readFile: layout({ dist: true }).readFile, resolveExecutable: available })
      // The returned inventory is names only; the credential never enters it.
      expect(result.registered.slice().sort()).toEqual(["context7", "grep_app", "lsp"])
      expect(collection.map.get(CONTEXT7_MCP_NAME).headers).toEqual({ Authorization: "Bearer ctx7-secret-value" })
    })
  })

  describe("#given the exclusive Context7 policy #when the user's Context7 config changes across restarts #then the builtin self-reconciles to exactly one", () => {
    const options = () => ({ retained: ["grep_app", "lsp", "context7"], disabledMcps: [], env: {}, repoRoot: REPO, cwd: "/w", configDir: "/c", exists: layout({ dist: true }).exists, readFile: layout({ dist: true }).readFile, resolveExecutable: available })
    // One registration pass against a host that reflects the user's CURRENT
    // OpenCode config (the builtin never persists between setups).
    async function registerAgainst(userServers) {
      const host = new Map(userServers)
      const collection = { get: (name) => host.get(name), set: (name, config) => host.set(name, config) }
      const result = await registerNativeBuiltinMcps({ mcp: fakeDomain(collection) }, options())
      const liveContext7 = [...host.values()].filter((entry) => typeof entry.url === "string" && entry.url.includes("mcp.context7.com"))
      return { result, host, liveContext7 }
    }

    test("#then a declared external Context7 wins and the builtin is omitted (exactly one)", async () => {
      const { result, liveContext7 } = await registerAgainst([["context7", { type: "remote", url: "https://mcp.context7.com/mcp" }]])
      expect(result.registered).not.toContain("context7")
      expect(liveContext7).toHaveLength(1)
    })

    test("#then after the external is removed, the next setup emits the builtin (exactly one, never zero)", async () => {
      const { result, host, liveContext7 } = await registerAgainst([])
      expect(result.registered).toContain("context7")
      expect(host.get("context7").url).toBe("https://mcp.context7.com/mcp")
      expect(liveContext7).toHaveLength(1)
    })

    test("#then after an external is added, the next setup omits the builtin (exactly one, never two)", async () => {
      const { result, liveContext7 } = await registerAgainst([["context7", { type: "remote", url: "https://mcp.context7.com/mcp" }]])
      expect(result.registered).not.toContain("context7")
      expect(liveContext7).toHaveLength(1)
    })
  })

  describe("#given registerNativeBuiltinMcps #when the host exposes mcp.transform #then servers are registered once", () => {
    test("#then grep_app and lsp are set and a host collision is preserved", async () => {
      const collection = fakeCollection(["tavily"])
      const result = await registerNativeBuiltinMcps({ mcp: fakeDomain(collection) }, { repoRoot: REPO, cwd: "/w", configDir: "/c", disabledMcps: ["context7"], retained: ["grep_app", "lsp"], exists: layout({ dist: true }).exists, readFile: layout({ dist: true }).readFile, resolveExecutable: available })
      expect(result.registered).toEqual(["grep_app", "lsp"])
      expect(collection.map.get("grep_app").url).toBe("https://mcp.grep.app")
      expect(collection.map.get("lsp").type).toBe("local")
      expect(collection.map.get("tavily").url).toBe("https://existing.invalid")
    })

    test("#then an existing server of the same name wins and is not overwritten", async () => {
      const collection = fakeCollection(["grep_app"])
      const result = await registerNativeBuiltinMcps({ mcp: fakeDomain(collection) }, { repoRoot: REPO, cwd: "/w", configDir: "/c", disabledMcps: [], retained: ["grep_app", "lsp"], exists: layout({ dist: true }).exists, readFile: layout({ dist: true }).readFile, resolveExecutable: available })
      expect(result.registered).toEqual(["lsp"])
      expect(collection.map.get("grep_app").url).toBe("https://existing.invalid")
    })

    test("#then the registration dispose is propagated", async () => {
      const collection = fakeCollection()
      const disposer = async () => undefined
      const result = await registerNativeBuiltinMcps({ mcp: fakeDomain(collection, disposer) }, { repoRoot: REPO, cwd: "/w", configDir: "/c", disabledMcps: [], retained: ["grep_app"], exists: layout({ dist: true }).exists, readFile: layout({ dist: true }).readFile, resolveExecutable: available })
      expect(result.dispose).toBe(disposer)
    })

    test("#then a host without mcp.transform degrades to an inert registration", async () => {
      expect(await registerNativeBuiltinMcps({}, {})).toEqual({ registered: [], planned: [], dispose: undefined })
      expect(await registerNativeBuiltinMcps({ mcp: {} }, {})).toEqual({ registered: [], planned: [], dispose: undefined })
    })
  })

  describe("#given resolveOpenCodeConfigDir #when resolving the config dir #then it stays on the isolated roots", () => {
    test("#then OPENCODE_CONFIG_DIR wins over XDG and XDG wins over the home default", () => {
      expect(resolveOpenCodeConfigDir({ OPENCODE_CONFIG_DIR: "/lab/config/opencode", XDG_CONFIG_HOME: "/lab/config" })).toBe("/lab/config/opencode")
      expect(resolveOpenCodeConfigDir({ XDG_CONFIG_HOME: "/lab/config" })).toBe(path.join("/lab/config", "opencode"))
      expect(resolveOpenCodeConfigDir({})).toBe(path.join(homedir(), ".config", "opencode"))
    })
  })

  test("#then the exported grep_app template stays the V1 remote definition", () => {
    expect(GREP_APP_MCP).toEqual({ type: "remote", url: "https://mcp.grep.app", disabled: false, oauth: false })
  })
})
