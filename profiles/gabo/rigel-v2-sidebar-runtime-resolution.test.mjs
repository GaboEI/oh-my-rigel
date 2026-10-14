/**
 * Isolated-runtime regression gate for the sidebar's OpenTUI peer resolution.
 *
 * The sidebar builds host nodes with the OpenTUI Solid peers the HOST provides
 * (official V2 contract: "add OpenTUI peers when the plugin renders JSX"). The
 * runtime is materialized by COPYING modules only, so the peers are never
 * installed beside it; a static `import "@opentui/solid"` in the companion entry
 * therefore crashes the WHOLE CLI plugin (`ERR_MODULE_NOT_FOUND`) on a real
 * install. This gate materializes the runtime into an isolated temp dir OUTSIDE
 * the checkout (so the checkout `node_modules` is unreachable) and asserts:
 *
 *   A. no peer      -> the companion entry still loads and boots; the sidebar
 *                      degrades (writes its receipt, registers no slot).
 *   B. peer present -> the sidebar registers `sidebar.content` and its render
 *                      returns a MATERIALIZED host node (never text/IR).
 *   C. disabled     -> the runtime boots when `tui.sidebar.enabled === false`.
 *
 * It is the regression guard for the static-import crash Codex found.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { discoverRuntimeModules } from "./native-runtime-modules.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const opencodeDir = join(here, "opencode")

const DRIVER = `
let result = { importError: null }
try {
  const mod = await import("./tui.js")
  const slots = []
  const toasts = []
  const handlers = new Map()
  const options = JSON.parse(process.env.RT_OPTIONS ?? "{}")
  const context = {
    options,
    renderer: { isDestroyed: false, requestRender() {} },
    location: { current: { directory: process.cwd() } },
    theme: {},
    data: {
      on: (name, handler) => { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); return () => {} },
      session: { get: () => undefined },
    },
    ui: {
      toast: { show: (t) => toasts.push(t) },
      dialog: { select() {}, clear() {}, show() {} },
      slot: (spec) => { slots.push(spec); return { update() {}, dispose() {} } },
    },
    keymap: { layer: () => () => {} },
  }
  const plugin = mod.createCompanionCliPlugin({ sidebar: { stateRoot: process.env.RT_STATE, log: () => {} } })
  const dispose = plugin.setup(context)
  const sidebarSlots = slots.filter((s) => s && s.append === "sidebar.content")
  let renderedTag = null
  if (sidebarSlots[0] && typeof sidebarSlots[0].render === "function") {
    const node = sidebarSlots[0].render({ sessionID: "ses_x" })
    renderedTag = node === null || node === undefined ? null : typeof node.tag
  }
  result = {
    importError: null,
    hasDisposer: typeof dispose === "function",
    sidebarSlots: sidebarSlots.length,
    renderedTag,
    totalSlots: slots.length,
    handlers: handlers.size,
  }
} catch (error) {
  result = { importError: String((error && error.message) || error) }
}
process.stdout.write("RESULT:" + JSON.stringify(result) + "\\n")
`

function materializeRuntime(root) {
  mkdirSync(root, { recursive: true })
  for (const file of discoverRuntimeModules(opencodeDir)) {
    const dest = join(root, file)
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(join(opencodeDir, file), dest)
  }
  cpSync(join(opencodeDir, "rigel-v2-native-cli.mjs"), join(root, "tui.js"))
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "rigel-v2-native", type: "module", exports: { ".": "./index.js", "./tui": "./tui.js" }, peerDependencies: { "@opentui/core": ">=0.5.8", "@opentui/solid": ">=0.5.8", "solid-js": ">=1.9.0" } }, null, 2)}\n`,
  )
  writeFileSync(join(root, "driver.mjs"), DRIVER)
}

// A tiny stand-in for the host-provided OpenTUI Solid peers: enough to prove the
// resolution path and that render returns a MATERIALIZED node (tag-bearing).
function writeSolidPeer(root) {
  const pkgDir = join(root, "node_modules", "@opentui", "solid")
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, "package.json"), `${JSON.stringify({ name: "@opentui/solid", version: "0.5.11", type: "module", main: "index.js", exports: { ".": "./index.js" } }, null, 2)}\n`)
  writeFileSync(
    join(pkgDir, "index.js"),
    [
      "export function createElement(tag) { return { tag, props: {}, children: [] } }",
      "export function setProp(node, name, value) { node.props[name] = value }",
      "export function insert(parent, child) { parent.children.push(child) }",
      "",
    ].join("\n"),
  )
}

function runDriver(root, env = {}) {
  const proc = spawnSync("node", ["driver.mjs"], {
    cwd: root,
    env: { ...process.env, RT_STATE: join(root, "state"), ...env },
    encoding: "utf8",
  })
  const line = (proc.stdout ?? "").split("\n").find((value) => value.startsWith("RESULT:"))
  return { status: proc.status, stderr: proc.stderr ?? "", result: line ? JSON.parse(line.slice("RESULT:".length)) : undefined }
}

let noPeerDir
let withPeerDir

beforeAll(() => {
  noPeerDir = mkdtempSync(join(tmpdir(), "rigel-rt-nopeer-"))
  withPeerDir = mkdtempSync(join(tmpdir(), "rigel-rt-peer-"))
  materializeRuntime(noPeerDir)
  materializeRuntime(withPeerDir)
  writeSolidPeer(withPeerDir)
})

afterAll(() => {
  rmSync(noPeerDir, { recursive: true, force: true })
  rmSync(withPeerDir, { recursive: true, force: true })
})

describe("#given a materialized runtime with NO OpenTUI peer (real install shape)", () => {
  test("#then the companion entry still loads and boots; the sidebar degrades without crashing", () => {
    // Guard: the runtime is isolated (no checkout node_modules reachable).
    expect(existsSync(join(noPeerDir, "node_modules"))).toBe(false)
    const { status, result } = runDriver(noPeerDir)
    expect(status).toBe(0)
    expect(result?.importError).toBeNull()
    expect(result?.hasDisposer).toBe(true) // the WHOLE companion boots
    expect(result?.handlers).toBeGreaterThan(0) // other surfaces still subscribe
    expect(result?.sidebarSlots).toBe(0) // the sidebar degrades, no host crash
    expect(result?.renderedTag).toBeNull()
  })

  test("#given tui.sidebar.enabled=false #then the runtime still boots (previous behavior intact)", () => {
    const { status, result } = runDriver(noPeerDir, { RT_OPTIONS: JSON.stringify({ tui: { sidebar: { enabled: false } } }) })
    expect(status).toBe(0)
    expect(result?.importError).toBeNull()
    expect(result?.hasDisposer).toBe(true)
    expect(result?.sidebarSlots).toBe(0)
  })
})

describe("#given a materialized runtime WITH the host OpenTUI peer", () => {
  test("#then the sidebar registers sidebar.content and render returns a materialized host node", () => {
    const { status, result } = runDriver(withPeerDir)
    expect(status).toBe(0)
    expect(result?.importError).toBeNull()
    expect(result?.hasDisposer).toBe(true)
    expect(result?.sidebarSlots).toBe(1)
    expect(result?.renderedTag).toBe("string") // a host node, not text/IR
  })

  test("#given tui.sidebar.enabled=false #then no sidebar slot is registered", () => {
    const { status, result } = runDriver(withPeerDir, { RT_OPTIONS: JSON.stringify({ tui: { sidebar: { enabled: false } } }) })
    expect(status).toBe(0)
    expect(result?.sidebarSlots).toBe(0)
    expect(result?.hasDisposer).toBe(true)
  })
})
