import fs from "node:fs"
import path from "node:path"
import pluginModule from "../../dist/index.js"

const client = { app: { log: async () => undefined }, session: { messages: async () => ({ data: [] }) } }
const serverUrl = new URL("http://127.0.0.1:4096")

export function readBundledVersion(sourceRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"))
    return typeof pkg.version === "string" && pkg.version ? pkg.version : undefined
  } catch (error) {
    console.error(`Rigel target agent manifest: could not read bundled version: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

export async function withProcessEnv(env, run) {
  const saved = { ...process.env }
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  try {
    return await run()
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, saved)
  }
}

export async function runPluginConfig(rawConfig, directory, model) {
  const clone = structuredClone(rawConfig)
  if (model) clone.model = model
  const hooks = await pluginModule.server({ directory, client, serverUrl }, {})
  try {
    await hooks.config(clone)
  } finally {
    await hooks.dispose?.()
  }
  return clone
}
