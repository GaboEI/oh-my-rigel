import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { loadAndValidate, validate } from "./schema-validate.mjs"
import { BASELINE_COMMIT, computeDataSha256, SCHEMA_VERSION, SEALED_FILES } from "./seal-lib.mjs"

const DATA_URL = new URL("./", import.meta.url)
const REPO = new URL("../../", import.meta.url)

type Campo = { procedencia: string; valor?: string | string[]; razon?: string; fuente: string }
type Funcion = {
  id: string
  nombre: string
  area: string
  areaSlug: string
  estado: string
  v2: string
  que_es: string
  como_se_activa: string
  como_se_usa: string
  cuando_sirve: string
  url: string
  modo_de_activacion: string
  requisitos: Campo
  valores_por_defecto: Campo
  ejemplos: Campo
  comandos: Campo
  version_desde: Campo
  cambios_relevantes: Campo
}
type Area = { id: string; name: string; slug: string; count: number }
type Catalog = {
  schemaVersion: number
  catalog: { source: string; sourceStatus: string; totalFunctions: number; totalAreas: number; stateTotals: Record<string, number> }
  areas: Area[]
  functions: Funcion[]
}
type Rung = { order: number; providers: string[]; model: string; variant: string | null }
type Chain = { id: string; order: number; rungs: Rung[] }
type Agent = {
  id: string
  mode: string
  defaultState: string
  defaultStateProvenance: { procedencia: string; fuente: string; razon?: string }
  requiresProvider: string[]
  requiresAnyModel: boolean
  requiresModel: string | null
}
type ModelCore = {
  AGENT_MODEL_REQUIREMENTS: Record<string, { fallbackChain: { providers: string[]; model: string; variant?: string }[]; requiresProvider?: string[]; requiresAnyModel?: boolean; requiresModel?: string }>
  CATEGORY_MODEL_REQUIREMENTS: Record<string, { fallbackChain: { providers: string[]; model: string; variant?: string }[]; requiresProvider?: string[]; requiresAnyModel?: boolean; requiresModel?: string }>
}
type GuideAgent = { id: string; provenance: string; funcion: string; cuandoUsar: string; displayName?: string; mode?: string }
type GuideSkill = { id: string; provenance: string; funcion: string; uso: string }
type GuideCommand = { id: string; surface: string; name: string; queHace: string; queToca: string }
type Guide = { schemaVersion: number; source: Record<string, string>; agents: GuideAgent[]; skills: GuideSkill[]; commands: GuideCommand[] }
type GuideOverlay = {
  schemaVersion: number
  document: string
  locale: string
  coverage: { fields: string[]; note: string }
  agents: Record<string, { funcion: string; cuandoUsar: string }>
  skills: Record<string, { funcion: string; uso: string }>
  commands: Record<string, { queHace: string; queToca: string }>
}

const EXPECTED_PER_AREA: Record<string, number> = { A: 15, B: 10, C: 11, D: 17, E: 6, F: 9, G: 3, H: 3, I: 7, J: 5, K: 9, L: 6, M: 3, N: 3 }
const COVERAGE_FINGERPRINT = "6d64a10b20ed526224688e6c6186838a5455433777f5c785e10129b5455ab3a9"

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, DATA_URL), "utf8")) as T
}
function readRepo(rel: string): string {
  return readFileSync(new URL(rel, REPO), "utf8")
}
function skillIds(rel: string): string[] {
  const dir = new URL(`${rel}/`, REPO)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(new URL(`${entry.name}/SKILL.md`, dir)))
    .map((entry) => entry.name)
}
async function loadModelCore(): Promise<ModelCore> {
  const agent = (await import(`${fileURLToPath(REPO)}packages/model-core/src/agent-model-requirements.ts`)) as ModelCore
  const cat = (await import(`${fileURLToPath(REPO)}packages/model-core/src/category-model-requirements.ts`)) as { CATEGORY_MODEL_REQUIREMENTS: ModelCore["CATEGORY_MODEL_REQUIREMENTS"] }
  return { AGENT_MODEL_REQUIREMENTS: agent.AGENT_MODEL_REQUIREMENTS, CATEGORY_MODEL_REQUIREMENTS: cat.CATEGORY_MODEL_REQUIREMENTS }
}

const catalog = readJson<Catalog>("catalog.json")
const agentsDoc = readJson<{ schemaVersion: number; roster: Record<string, number> & { note: string }; agents: Agent[] }>("agents.json")
const chainsDoc = readJson<{ schemaVersion: number; agents: Chain[]; categories: Chain[] }>("chains.json")
const cliDoc = readJson<{ schemaVersion: number; owners: Record<string, { commands: unknown[] }>; warnings: { id: string; text: string }[] }>("cli.json")
const seal = readJson<{ schemaVersion: number; productVersion: string; baselineCommit: string; algorithm: string; canonical: string; sealedFiles: string[]; dataSha256: string }>("seal.json")
const guideDoc = readJson<Guide>("guide.json")
const guideOverlay = readJson<GuideOverlay>("i18n/guide.en.json")
const sourceSchema = readJson<Record<string, unknown>>("schema/source.schema.json")

describe("#given the web data source #when its documents are read #then each is schema-versioned", () => {
  test("#given every source document #when its schemaVersion is inspected #then it equals 1", () => {
    // given / when / then
    for (const [name, doc] of Object.entries({ catalog, agents: agentsDoc, chains: chainsDoc, cli: cliDoc, guide: guideDoc, seal })) {
      expect(`${name}:${(doc as { schemaVersion: number }).schemaVersion}`).toBe(`${name}:1`)
      expect((doc as { schemaVersion: number }).schemaVersion).toBe(SCHEMA_VERSION)
    }
  })
})

describe("#given the migrated catalog #when coverage is checked #then it is exactly 1:1 with the approved catalog", () => {
  test("#given the catalog totals #when counted #then 107 functions across 14 areas", () => {
    // given / when / then
    expect(catalog.catalog.totalFunctions).toBe(107)
    expect(catalog.catalog.totalAreas).toBe(14)
    expect(catalog.functions.length).toBe(107)
    expect(catalog.areas.length).toBe(14)
  })

  test("#given each area #when its declared count is compared to its functions #then they match the approved per-area counts", () => {
    // given / when / then
    const actual: Record<string, number> = {}
    for (const f of catalog.functions) actual[f.area] = (actual[f.area] ?? 0) + 1
    expect(actual).toEqual(EXPECTED_PER_AREA)
    for (const area of catalog.areas) expect([area.id, area.count]).toEqual([area.id, EXPECTED_PER_AREA[area.id]])
  })

  test("#given the state totals #when recomputed from functions #then they match the approved summary (76/15/16)", () => {
    // given / when / then
    const totals: Record<string, number> = { activada: 0, desactivada: 0, condicionada: 0 }
    for (const f of catalog.functions) totals[f.estado] += 1
    expect(totals).toEqual({ activada: 76, desactivada: 15, condicionada: 16 })
    expect(catalog.catalog.stateTotals).toEqual(totals)
  })

  test("#given the function ids #when hashed #then the coverage fingerprint matches the frozen oracle", () => {
    // given / when / then
    const fp = createHash("sha256").update([...catalog.functions.map((f) => f.id)].sort().join("\n")).digest("hex")
    expect(fp).toBe(COVERAGE_FINGERPRINT)
  })
})

describe("#given the catalog functions #when integrity rules are applied #then no duplicate, orphan or contradictory entry exists", () => {
  test("#given ids and urls #when uniqueness is checked #then there are no duplicates", () => {
    // given / when / then
    const ids = catalog.functions.map((f) => f.id)
    const urls = catalog.functions.map((f) => f.url)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(urls).size).toBe(urls.length)
  })

  test("#given area, slug and url fields #when cross-checked #then every reference resolves and the url matches the id", () => {
    // given / when / then
    const areaById = new Map(catalog.areas.map((a) => [a.id, a]))
    for (const f of catalog.functions) {
      const area = areaById.get(f.area)
      expect([f.id, area !== undefined]).toEqual([f.id, true])
      expect(f.areaSlug).toBe(area?.slug)
      expect(f.url).toBe(`/catalogo/${f.id}/`)
    }
  })

  test("#given each function #when v2 and estado are combined #then excluded/unmigrated is disabled and substituted is enabled", () => {
    // given / when / then
    for (const f of catalog.functions) {
      if (f.v2 === "excluida" || f.v2 === "no_migrada") expect([f.id, f.estado]).toEqual([f.id, "desactivada"])
      if (f.v2 === "sustituida") expect([f.id, f.estado]).toEqual([f.id, "activada"])
      expect(["activada", "desactivada", "condicionada"]).toContain(f.estado)
      expect(["migrada", "adaptada", "reescrita", "sustituida", "no_migrada", "excluida"]).toContain(f.v2)
      for (const field of [f.nombre, f.que_es, f.como_se_activa, f.como_se_usa, f.cuando_sirve]) expect(field.length).toBeGreaterThan(0)
    }
  })
})

describe("#given the source documents #when validated #then the real JSON Schema validates them", () => {
  test("#given every document #when validated against source.schema.json #then there are no errors", () => {
    // given / when / then
    const defs: Record<string, string> = { catalog: "catalog", agents: "agentsDoc", chains: "chainsDoc", cli: "cliDoc", guide: "guideDoc", seal: "seal" }
    const docs: Record<string, unknown> = { catalog, agents: agentsDoc, chains: chainsDoc, cli: cliDoc, guide: guideDoc, seal }
    for (const [name, def] of Object.entries(defs)) {
      const errors = loadAndValidate(sourceSchema, def, docs[name])
      expect([name, errors]).toEqual([name, []])
    }
  })

  test("#given a document with a removed required field #when validated #then the schema rejects it", () => {
    // given / when / then
    const bad = JSON.parse(JSON.stringify(catalog))
    delete bad.functions[0].requisitos
    expect(loadAndValidate(sourceSchema, "catalog", bad).length).toBeGreaterThan(0)
  })

  test("#given a document with an out-of-range enum #when validated #then the schema rejects it", () => {
    // given / when / then
    const bad = JSON.parse(JSON.stringify(catalog))
    bad.functions[0].estado = "encendida"
    expect(loadAndValidate(sourceSchema, "catalog", bad).length).toBeGreaterThan(0)
  })

  test("#given a document with an unknown field #when validated #then the schema rejects it", () => {
    // given / when / then
    const bad = JSON.parse(JSON.stringify(catalog))
    bad.functions[0].inventado = true
    expect(loadAndValidate(sourceSchema, "catalog", bad).length).toBeGreaterThan(0)
  })
})

describe("#given the per-function contract fields #when inspected #then each is explicit and sourced", () => {
  const campos = ["requisitos", "valores_por_defecto", "ejemplos", "comandos", "version_desde", "cambios_relevantes"] as const
  test("#given each function #when the six contract fields are read #then each has a source and no_consta carries a reason", () => {
    // given / when / then
    for (const f of catalog.functions) {
      for (const name of campos) {
        const campo = f[name]
        expect([f.id, name, typeof campo.fuente, campo.fuente.length > 0]).toEqual([f.id, name, "string", true])
        expect([f.id, name, ["derivado", "no_consta", "no_aplica"].includes(campo.procedencia)]).toEqual([f.id, name, true])
        if (campo.procedencia === "derivado") expect([f.id, name, campo.valor !== undefined]).toEqual([f.id, name, true])
        else expect([f.id, name, typeof campo.razon === "string" && campo.razon.length > 0]).toEqual([f.id, name, true])
      }
    }
  })

  test("#given the contract fields #when their content is inspected #then requisitos is a real requirement, defaults are concrete and changes are dispositions", () => {
    // given / when / then
    const concreteChange = new Set(["reescrita", "sustituida", "no_migrada", "excluida"])
    const defaultMarker = /por defecto se usan|por defecto solo informa|sin clave|una vez al día|se comparte una sola vez|modo agresivo/
    for (const f of catalog.functions) {
      expect([f.id, f.modo_de_activacion.length > 0]).toEqual([f.id, true])
      if (f.requisitos.procedencia === "derivado") {
        expect([f.id, f.requisitos.valor !== f.modo_de_activacion]).toEqual([f.id, true])
      }
      if (f.valores_por_defecto.procedencia === "derivado") {
        const v = Array.isArray(f.valores_por_defecto.valor) ? f.valores_por_defecto.valor.join(" ") : String(f.valores_por_defecto.valor)
        expect([f.id, defaultMarker.test(v)]).toEqual([f.id, true])
      }
      if (f.cambios_relevantes.procedencia === "derivado") {
        const v = Array.isArray(f.cambios_relevantes.valor) ? f.cambios_relevantes.valor.join(" ") : String(f.cambios_relevantes.valor)
        expect([f.id, concreteChange.has(f.v2) || v.includes("No expuesto todavía")]).toEqual([f.id, true])
        expect([f.id, v.includes("se conserva tal cual")]).toEqual([f.id, false])
      } else {
        expect([f.id, ["migrada", "adaptada"].includes(f.v2)]).toEqual([f.id, true])
      }
    }
  })

  test("#given each function's comandos #when checked against the CLI allowlist #then every command resolves", () => {
    // given / when / then
    const omo = new Set<string>()
    for (const c of cliDoc.owners.omo.commands as { name: string; aliases: string[] }[]) { omo.add(c.name); for (const a of c.aliases) omo.add(a) }
    const rigel = new Set<string>()
    for (const c of cliDoc.owners["rigel-v2"].commands as { name: string; aliases: string[] }[]) { rigel.add(c.name); for (const a of c.aliases) rigel.add(a) }
    const slash = new Set(cliDoc.owners.slash.commands as string[])
    for (const f of catalog.functions) {
      const cmd = f.comandos.valor
      const list = Array.isArray(cmd) ? cmd : []
      for (const token of list) {
        const resolves = token.startsWith("/") ? slash.has(token.slice(1))
          : token.startsWith("omo ") ? omo.has(token.slice(4))
            : token.startsWith("oh-my-openagent ") ? omo.has(token.slice(16))
              : token.startsWith("rigel-v2 ") ? rigel.has(token.slice(9))
                : token === "get.omo.dev/install.sh"
        expect([f.id, token, resolves]).toEqual([f.id, token, true])
      }
    }
  })
})

describe("#given agents.json #when re-derived against the real product surfaces #then it cannot drift", () => {
  test("#given the built-in agent union #when compared to agents.json #then the rosters are identical", async () => {
    // given / when / then
    const names = (await import(`${fileURLToPath(REPO)}packages/omo-opencode/src/config/schema/agent-names.ts`)) as { BuiltinAgentNameSchema: { options: string[] } }
    const expected = [...names.BuiltinAgentNameSchema.options].sort()
    const actual = agentsDoc.agents.map((a) => a.id).sort()
    expect(actual).toEqual(expected)
  })

  test("#given the model requirements #when compared to agents.json #then default model, providers and conditional state match", async () => {
    // given / when / then
    const { AGENT_MODEL_REQUIREMENTS } = await loadModelCore()
    for (const agent of agentsDoc.agents) {
      const req = AGENT_MODEL_REQUIREMENTS[agent.id]
      expect([agent.id, req !== undefined]).toEqual([agent.id, true])
      expect(agent.requiresProvider).toEqual(req.requiresProvider ?? [])
      expect(agent.requiresAnyModel).toBe(req.requiresAnyModel ?? false)
      expect(agent.defaultState).toBe((req.requiresProvider ?? []).length > 0 ? "conditional" : "active")
    }
  })

  test("#given the mode constants in the factories #when parsed #then they equal agents.json modes", () => {
    // given / when / then
    const modeFiles: Record<string, string> = {
      sisyphus: "packages/omo-opencode/src/agents/sisyphus-agent-factory.ts",
      hephaestus: "packages/omo-opencode/src/agents/hephaestus/agent.ts",
      prometheus: "packages/omo-opencode/src/plugin-handlers/prometheus-agent-config-builder.ts",
      oracle: "packages/omo-opencode/src/agents/oracle.ts",
      librarian: "packages/omo-opencode/src/agents/librarian.ts",
      explore: "packages/omo-opencode/src/agents/explore.ts",
      "multimodal-looker": "packages/omo-opencode/src/agents/multimodal-looker.ts",
      metis: "packages/omo-opencode/src/agents/metis.ts",
      momus: "packages/omo-opencode/src/agents/momus.ts",
      atlas: "packages/omo-opencode/src/agents/atlas/agent.ts",
      "sisyphus-junior": "packages/omo-opencode/src/agents/sisyphus-junior/agent.ts",
    }
    for (const agent of agentsDoc.agents) {
      const text = readRepo(modeFiles[agent.id])
      const m = text.match(/mode:\s*"(primary|subagent|all)"/) ?? text.match(/const MODE: AgentMode = "(primary|subagent|all)"/)
      expect([agent.id, m?.[1]]).toEqual([agent.id, agent.mode])
    }
  })

  test("#given the runtime roster sources #when counted #then published=11, gabo profile=12, senpi native=7", async () => {
    // given / when / then
    expect(agentsDoc.roster.publishedPublic).toBe(11)
    expect(agentsDoc.roster.gaboProfileRegistered).toBe(12)
    const senpi = (await import(`${fileURLToPath(REPO)}packages/senpi-task/src/agents/builtin/index.ts`)) as { BUILTIN_AGENT_DEFAULTS: unknown[] }
    expect(senpi.BUILTIN_AGENT_DEFAULTS.length).toBe(agentsDoc.roster.senpiNativeBuiltins)
    expect(agentsDoc.roster.senpiNativeBuiltins).toBe(7)
  })

  test("#given the V2 runtime surfaces #when default states are inspected #then each state is anchored to V2 provenance", () => {
    // given / when / then
    const v2Selection = readRepo("profiles/gabo/v2-agent-selection.json")
    const v2Agents = readRepo("profiles/gabo/opencode/rigel-v2-native-agents.mjs")
    for (const agent of agentsDoc.agents) {
      const p = agent.defaultStateProvenance
      expect([agent.id, p.procedencia, typeof p.fuente === "string" && p.fuente.length > 0]).toEqual([agent.id, "derivado", true])
      expect([agent.id, p.fuente.includes("profiles/gabo")]).toEqual([agent.id, true])
    }
    const hephaestus = agentsDoc.agents.find((a) => a.id === "hephaestus")
    expect(hephaestus?.defaultState).toBe("conditional")
    expect(hephaestus?.defaultStateProvenance.fuente).toContain("rigel-v2-native-agents.mjs")
    expect(v2Agents).toContain("isHephaestusAgentId")
    expect(v2Selection).toContain("orchestratedAgentIds")
  })
})

describe("#given chains.json #when re-derived against model-core #then agent and category chains cannot drift", () => {
  test("#given agent chains #when compared to AGENT_MODEL_REQUIREMENTS #then every rung matches", async () => {
    // given / when / then
    const { AGENT_MODEL_REQUIREMENTS } = await loadModelCore()
    expect(chainsDoc.agents.map((c) => c.id).sort()).toEqual(Object.keys(AGENT_MODEL_REQUIREMENTS).sort())
    for (const chain of chainsDoc.agents) {
      const expected = AGENT_MODEL_REQUIREMENTS[chain.id].fallbackChain.map((e, i) => ({ order: i, providers: e.providers, model: e.model, variant: e.variant ?? null }))
      expect(chain.rungs).toEqual(expected)
    }
  })

  test("#given category chains #when compared to CATEGORY_MODEL_REQUIREMENTS #then every rung matches", async () => {
    // given / when / then
    const { CATEGORY_MODEL_REQUIREMENTS } = await loadModelCore()
    expect(chainsDoc.categories.map((c) => c.id).sort()).toEqual(Object.keys(CATEGORY_MODEL_REQUIREMENTS).sort())
    for (const chain of chainsDoc.categories) {
      const expected = CATEGORY_MODEL_REQUIREMENTS[chain.id].fallbackChain.map((e, i) => ({ order: i, providers: e.providers, model: e.model, variant: e.variant ?? null }))
      expect(chain.rungs).toEqual(expected)
    }
  })
})

describe("#given cli.json #when re-derived against the real CLI sources #then no invented or missing command exists", () => {
  test("#given the parent plugin CLI #when parsed #then its commands match cli.json", () => {
    // given / when / then
    const files = [
      "packages/omo-opencode/src/cli/cli-program.ts",
      "packages/omo-opencode/src/cli/runtime-commands.ts",
      "packages/omo-opencode/src/cli/cleanup-command.ts",
      "packages/omo-opencode/src/cli/mcp-oauth/index.ts",
    ]
    const parsed = new Set<string>()
    for (const f of files) for (const m of readRepo(f).matchAll(/\.command\(\s*"([a-z][a-z0-9-]*)/g)) parsed.add(m[1])
    // `login`/`logout`/`status` are real nested `mcp oauth` subcommands. `migrate` was removed
    // deliberately: the public `config migrate` command is retired (PR2/F71) and internal legacy
    // migration is automatic at startup (`startup-migration.ts`, consumed by
    // `testing/create-plugin-module.ts` and `cli/config-manager/write-omo-config.ts`), so it has no
    // CLI verb. Keeping it allowlisted made this gate blind to a reintroduced `.command("migrate")`.
    const nested = new Set(["login", "logout", "status"])
    const declared = new Set((cliDoc.owners.omo.commands as { name: string }[]).map((c) => c.name))
    for (const name of parsed) expect(["omo", name, declared.has(name) || nested.has(name)]).toEqual(["omo", name, true])
    for (const name of declared) expect(["omo", name, parsed.has(name) || name === "setup" || name === "mcp"]).toEqual(["omo", name, true])
  })

  test("#given the Rigel V2 command modules #when parsed #then names and aliases match cli.json exactly", () => {
    // given / when / then
    const dir = new URL("../../profiles/gabo/cli/commands/", import.meta.url)
    const files = readdirSync(dir).filter((n) => n.endsWith(".mjs") && !n.endsWith(".test.mjs"))
    const parsed: { name: string; aliases: string[] }[] = []
    for (const file of files) {
      const text = readFileSync(new URL(file, dir), "utf8")
      const name = text.match(/^\s*name:\s*"([a-z][a-z0-9-]*)"/m)?.[1]
      const aliases = text.match(/aliases:\s*\[([^\]]*)\]/)?.[1].match(/"[a-z][a-z0-9-]*"/g)?.map((s) => s.slice(1, -1)) ?? []
      if (name) parsed.push({ name, aliases })
    }
    const declared = (cliDoc.owners["rigel-v2"].commands as { name: string; aliases: string[] }[]).map((c) => ({ name: c.name, aliases: c.aliases }));
    expect(parsed.map((c) => c.name).sort()).toEqual(declared.map((c) => c.name).sort())
    for (const c of declared) expect(parsed.find((p) => p.name === c.name)?.aliases).toEqual(c.aliases)
  })

  test("#given the builtin commands source #when the registered names are parsed #then the slash set matches cli.json", () => {
    // given / when / then
    const defs = readRepo("packages/omo-opencode/src/features/builtin-commands/commands.ts")
    const registered = [...defs.matchAll(/^ {4}"?([a-z][a-z0-9-]*)"?:\s*\{/gm)].map((m) => m[1])
    const btw = readRepo("packages/omo-opencode/src/features/btw-side/btw-command-draft.ts")
    const btwNames = btw.match(/\/\(\?:([a-z|]+)\)/)?.[1].split("|") ?? []
    const slash = [...registered, ...btwNames].sort()
    expect(slash.length).toBeGreaterThanOrEqual(9)
    expect((cliDoc.owners.slash.commands as string[]).slice().sort()).toEqual(slash)
  })

  test("#given the catalog usage cells #when command tokens are extracted #then every command resolves to a real surface", () => {
    // given / when / then
    const omo = new Set<string>()
    for (const c of cliDoc.owners.omo.commands as { name: string; aliases: string[] }[]) { omo.add(c.name); for (const a of c.aliases) omo.add(a) }
    const rigel = new Set<string>()
    for (const c of cliDoc.owners["rigel-v2"].commands as { name: string; aliases: string[] }[]) { rigel.add(c.name); for (const a of c.aliases) rigel.add(a) }
    const slash = new Set(cliDoc.owners.slash.commands as string[])

    for (const f of catalog.functions) {
      const cell = f.como_se_usa
      for (const m of cell.matchAll(/(?:^|[\s(`])\/([a-z][a-z0-9-]*)/g)) expect([f.id, "/" + m[1], slash.has(m[1])]).toEqual([f.id, "/" + m[1], true])
      for (const m of cell.matchAll(/\bomo ([a-z][a-z0-9-]*)/g)) expect([f.id, "omo " + m[1], omo.has(m[1])]).toEqual([f.id, "omo " + m[1], true])
      for (const m of cell.matchAll(/\brigel-v2 ([a-z][a-z0-9-]*)/g)) expect([f.id, "rigel-v2 " + m[1], rigel.has(m[1])]).toEqual([f.id, "rigel-v2 " + m[1], true])
      for (const m of cell.matchAll(/\boh-my-openagent ([a-z][a-z0-9-]*)/g)) expect([f.id, "oh-my-openagent " + m[1], omo.has(m[1])]).toEqual([f.id, "oh-my-openagent " + m[1], true])
    }
  })

  test("#given the mandatory warnings #when inspected #then setup ownership and absent rigel setup are present", () => {
    // given / when / then
    const ids = cliDoc.warnings.map((w) => w.id)
    expect(ids).toContain("omo-setup-parent")
    expect(ids).toContain("rigel-setup-absent")
  })

  test("#given the install route contract #when cli.json is inspected #then the public route never offers the lab CLI install command", () => {
    // given / when / then
    const warning = cliDoc.warnings.find((w) => w.id === "omr-install-not-parent-install")
    expect(warning).toBeDefined()
    const installText = `${cliDoc.install.omrReal}\n${warning!.text}`
    expect(installText).toContain("script/agent/setup.sh")
    expect(installText).toContain("rigel-v2-user-install.mjs")
    expect(installText).not.toContain("rigel-v2 install")
  })
})

describe("#given seal.json #when verified #then it seals the current source with the documented version", () => {
  test("#given the source files #when hashed #then the seal matches and the version is current", () => {
    // given / when / then
    expect(computeDataSha256(DATA_URL)).toBe(seal.dataSha256)
    expect(seal.sealedFiles).toEqual(SEALED_FILES)
    expect(seal.algorithm).toBe("sha256")
    expect(seal.canonical).toBe("sorted-keys-json")
    expect(seal.baselineCommit).toBe(BASELINE_COMMIT)
    const pkg = JSON.parse(readRepo("package.json")) as { version: string }
    expect(seal.productVersion).toBe(pkg.version)
  })
})

describe("#given the W3 i18n overlay #when validated #then it is id-anchored, translatable-only, and sealed", () => {
  const overlay = readJson<{
    schemaVersion: number
    document: string
    locale: string
    coverage: { fields: string[]; note: string }
    areas: Record<string, { name: string }>
    functions: Record<string, { nombre: string; que_es: string; modo_de_activacion: string; como_se_usa: string; cuando_sirve: string; requisitos: string; valores_por_defecto: string }>
  }>("i18n/catalog.en.json")
  const areaById = new Map(catalog.areas.map((area) => [area.id, area]))
  const fieldText = (f: Funcion["requisitos"]) => (f.procedencia === "derivado" ? (Array.isArray(f.valor) ? f.valor.join(", ") : f.valor) : f.razon)

  test("#given the overlay #when compared to the source #then every id exists and only translatable fields are present", () => {
    // given / when / then
    expect(overlay.schemaVersion).toBe(SCHEMA_VERSION)
    expect(overlay.document).toBe("catalog.json")
    expect(overlay.locale).toBe("en")
    expect(overlay.coverage.fields).toEqual(["areas[].name", "functions[].nombre", "functions[].que_es", "functions[].modo_de_activacion", "functions[].como_se_usa", "functions[].cuando_sirve", "functions[].requisitos", "functions[].valores_por_defecto"])
    const ids = Object.keys(overlay.areas)
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) {
      const source = areaById.get(id)
      expect(source).toBeDefined()
      expect(Object.keys(overlay.areas[id])).toEqual(["name"])
      const name = overlay.areas[id].name
      expect(typeof name).toBe("string")
      expect(name.length).toBeGreaterThan(0)
      expect(name).not.toBe(source!.name)
    }
  })

  test("#given the overlay functions #when compared to the catalogue #then every function is translated, non-empty and distinct from the ES source", () => {
    // given / when / then
    const fnById = new Map(catalog.functions.map((fn) => [fn.id, fn]))
    const ids = Object.keys(overlay.functions)
    expect(ids.length).toBe(107)
    for (const id of ids) {
      const src = fnById.get(id)
      expect([id, src !== undefined]).toEqual([id, true])
      const o = overlay.functions[id]
      for (const field of ["nombre", "que_es", "como_se_usa", "cuando_sirve"] as const) {
        expect([id, field, typeof o[field] === "string" && o[field].length > 0]).toEqual([id, field, true])
        expect([id, field, o[field] !== src![field]]).toEqual([id, field, true])
      }
      expect([id, typeof o.modo_de_activacion === "string" && o.modo_de_activacion.length > 0]).toEqual([id, true])
      expect([id, o.requisitos.length > 0 && o.requisitos !== fieldText(src!.requisitos)]).toEqual([id, true])
      expect([id, o.valores_por_defecto.length > 0 && o.valores_por_defecto !== fieldText(src!.valores_por_defecto)]).toEqual([id, true])
    }
  })

  test("#given each translated function #when its fields are read #then it carries only the translatable whitelist (no product-state field leaks)", () => {
    // given / when / then
    const allowed = ["como_se_usa", "cuando_sirve", "modo_de_activacion", "nombre", "que_es", "requisitos", "valores_por_defecto"]
    for (const [id, entry] of Object.entries(overlay.functions)) {
      expect([id, Object.keys(entry).sort()]).toEqual([id, allowed])
    }
  })

  test("#given the overlay #when sealed #then it is listed in sealedFiles and covered by the hash", () => {
    // given / when / then
    expect(SEALED_FILES).toContain("i18n/catalog.en.json")
    expect(seal.sealedFiles).toContain("i18n/catalog.en.json")
    expect(computeDataSha256(DATA_URL)).toBe(seal.dataSha256)
  })
})

describe("#given the guide source #when checked against the real product surfaces #then its inventory cannot drift", () => {
  test("#given the guide agents #when compared to agents.json and the beta Judge #then every id is covered once with the right provenance", () => {
    // given / when / then
    const omoIds = guideDoc.agents.filter((a) => a.provenance === "omo").map((a) => a.id).sort()
    const betaIds = guideDoc.agents.filter((a) => a.provenance === "beta").map((a) => a.id)
    expect(omoIds).toEqual(agentsDoc.agents.map((a) => a.id).sort())
    expect(betaIds).toEqual(["judge"])
    const ids = guideDoc.agents.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    const judge = guideDoc.agents.find((a) => a.id === "judge")!
    const judgeJson = JSON.parse(readRepo("profiles/gabo/opencode/agents/judge.v2.json")) as { name: string; mode: string }
    expect(judge.displayName).toBe(judgeJson.name)
    expect(judge.mode).toBe(judgeJson.mode)
    for (const agent of guideDoc.agents) {
      expect([agent.id, typeof agent.funcion === "string" && agent.funcion.length > 0]).toEqual([agent.id, true])
      expect([agent.id, typeof agent.cuandoUsar === "string" && agent.cuandoUsar.length > 0]).toEqual([agent.id, true])
    }
  })

  test("#given the guide skills #when compared to the shipped and beta skill trees #then every id is covered once with the right provenance", () => {
    // given / when / then
    const omo = skillIds("packages/shared-skills/skills")
    const beta = skillIds("profiles/gabo/skills")
    expect(omo.length).toBe(18)
    expect(beta.length).toBe(15)
    expect(guideDoc.skills.filter((s) => s.provenance === "omo").map((s) => s.id).sort()).toEqual(omo.sort())
    expect(guideDoc.skills.filter((s) => s.provenance === "beta").map((s) => s.id).sort()).toEqual(beta.sort())
    const ids = guideDoc.skills.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const skill of guideDoc.skills) {
      expect([skill.id, typeof skill.funcion === "string" && skill.funcion.length > 0]).toEqual([skill.id, true])
      expect([skill.id, typeof skill.uso === "string" && skill.uso.length > 0]).toEqual([skill.id, true])
    }
  })

  test("#given the guide commands #when compared to cli.json #then every command id is covered once on the right surface", () => {
    // given / when / then
    const expected = new Set<string>()
    for (const c of cliDoc.owners["rigel-v2"].commands as { name: string }[]) expected.add(`rigel-v2:${c.name}`)
    for (const c of cliDoc.owners.omo.commands as { name: string }[]) expected.add(`omo:${c.name}`)
    for (const name of cliDoc.owners.slash.commands as string[]) expected.add(`slash:${name}`)
    const actual = guideDoc.commands.map((c) => c.id)
    expect(actual.slice().sort()).toEqual([...expected].sort())
    expect(new Set(actual).size).toBe(actual.length)
    for (const command of guideDoc.commands) {
      const [surface, name] = command.id.split(":")
      expect([command.id, command.surface, command.name]).toEqual([command.id, surface, name])
      expect([command.id, typeof command.queHace === "string" && command.queHace.length > 0]).toEqual([command.id, true])
      expect([command.id, typeof command.queToca === "string" && command.queToca.length > 0]).toEqual([command.id, true])
    }
  })

  test("#given the guide agents #when chain coverage is measured against chains.json #then at least one agent declares no chain, so a universal agent/model claim is invalid", () => {
    // given / when / then
    const chained = new Set(chainsDoc.agents.map((c) => c.id))
    const without = guideDoc.agents.filter((a) => !chained.has(a.id)).map((a) => a.id)
    expect(without).toEqual(["judge"])
    expect(chainsDoc.agents.length).toBe(11)
  })

  test("#given the rigel-v2 install/uninstall cards #when read #then they name the isolated lab and the public human route, not a chosen-config install", () => {
    // given / when / then
    const install = guideDoc.commands.find((c) => c.id === "rigel-v2:install")!
    const uninstall = guideDoc.commands.find((c) => c.id === "rigel-v2:uninstall")!
    expect(install.queToca).toContain("laboratorio")
    expect(install.queToca).toContain("rigel-v2-user-install.mjs")
    expect(uninstall.queToca).toContain("laboratorio")
    expect(uninstall.queToca).toContain("V1")
    const enInstall = guideOverlay.commands["rigel-v2:install"]
    const enUninstall = guideOverlay.commands["rigel-v2:uninstall"]
    expect(enInstall.queToca).toContain("laboratory")
    expect(enInstall.queToca).toContain("rigel-v2-user-install.mjs")
    expect(enUninstall.queToca).toContain("laboratory")
    expect(enUninstall.queToca).toContain("V1")
  })

  test("#given the effect-bearing command cards #when read #then each names its real surface: cleanup is Codex-only and the two worktree-sweep flags differ", () => {
    // given / when / then
    const byId = Object.fromEntries(guideDoc.commands.map((c) => [c.id, c]))
    const en = guideOverlay.commands
    expect(byId["omo:cleanup"].queHace).toContain("Codex")
    expect(byId["omo:cleanup"].queToca).toContain("--platform codex")
    expect(en["omo:cleanup"].queHace).toContain("Codex")
    expect(en["omo:cleanup"].queToca).toContain("--platform codex")
    expect(byId["rigel-v2:worktree-sweep"].queToca).toContain("--dry-run")
    expect(en["rigel-v2:worktree-sweep"].queToca).toContain("--dry-run")
    expect(byId["omo:worktree-sweep"].queToca).toContain("--apply")
    expect(en["omo:worktree-sweep"].queToca).toContain("--apply")
  })
})

describe("#given the guide EN overlay #when checked #then every id and prose field is translated and distinct from the ES source", () => {
  test("#given the overlay #when its shape is read #then it is id-anchored to guide.json and names the guide prose fields", () => {
    // given / when / then
    expect(guideOverlay.schemaVersion).toBe(SCHEMA_VERSION)
    expect(guideOverlay.document).toBe("guide.json")
    expect(guideOverlay.locale).toBe("en")
    expect(guideOverlay.coverage.fields).toEqual(["agents[].funcion", "agents[].cuandoUsar", "skills[].funcion", "skills[].uso", "commands[].queHace", "commands[].queToca"])
  })

  test("#given each guide entry #when the EN prose is compared to the ES source #then it is present, non-empty and different", () => {
    // given / when / then
    for (const agent of guideDoc.agents) {
      const en = guideOverlay.agents[agent.id]
      expect([agent.id, en !== undefined]).toEqual([agent.id, true])
      for (const field of ["funcion", "cuandoUsar"] as const) {
        expect([agent.id, field, typeof en[field] === "string" && en[field].length > 0]).toEqual([agent.id, field, true])
        expect([agent.id, field, en[field] !== agent[field]]).toEqual([agent.id, field, true])
      }
    }
    for (const skill of guideDoc.skills) {
      const en = guideOverlay.skills[skill.id]
      expect([skill.id, en !== undefined]).toEqual([skill.id, true])
      for (const field of ["funcion", "uso"] as const) {
        expect([skill.id, field, typeof en[field] === "string" && en[field].length > 0]).toEqual([skill.id, field, true])
        expect([skill.id, field, en[field] !== skill[field]]).toEqual([skill.id, field, true])
      }
    }
    for (const command of guideDoc.commands) {
      const en = guideOverlay.commands[command.id]
      expect([command.id, en !== undefined]).toEqual([command.id, true])
      for (const field of ["queHace", "queToca"] as const) {
        expect([command.id, field, typeof en[field] === "string" && en[field].length > 0]).toEqual([command.id, field, true])
        expect([command.id, field, en[field] !== command[field]]).toEqual([command.id, field, true])
      }
    }
  })

  test("#given the overlay #when extra ids are checked #then it carries no id absent from guide.json", () => {
    // given / when / then
    expect(Object.keys(guideOverlay.agents).sort()).toEqual(guideDoc.agents.map((a) => a.id).sort())
    expect(Object.keys(guideOverlay.skills).sort()).toEqual(guideDoc.skills.map((s) => s.id).sort())
    expect(Object.keys(guideOverlay.commands).sort()).toEqual(guideDoc.commands.map((c) => c.id).sort())
  })
})
