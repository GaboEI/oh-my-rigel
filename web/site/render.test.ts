import { describe, expect, test } from "bun:test"

import { homePage, guidePage, catalogPage, GUIDE_LEAD, MODEL_OVERRIDE_EXAMPLE, AGENT_PROMPT } from "./lib/render.mjs"
import { loadSource } from "./lib/data.mjs"
import { loadOverlays, localizeSource } from "./lib/i18n.mjs"

// The public route is the OH-MY-RIGEL.md source install: it includes the migrated, confirmed
// OmO functionality plus an external BETA layer (Judge/agents/skills from profiles/gabo). The
// home pages must present the human route, the agent route with the canonical ENGLISH prompt
// (byte-identical ES/EN), and the lifecycle commands; no secret value may appear.

const source = await loadSource()
const overlays = await loadOverlays()
const HOME = {
  es: homePage("es", localizeSource(source, "es", overlays)),
  en: homePage("en", localizeSource(source, "en", overlays)),
}
const GUIDE = {
  es: guidePage("es", localizeSource(source, "es", overlays)),
  en: guidePage("en", localizeSource(source, "en", overlays)),
}
const CATALOG = {
  en: catalogPage("en", localizeSource(source, "en", overlays)),
}

function agentPromptBytes(html: string): string {
  const wrapper = html.match(/<div class="agent-prompt">([\s\S]*?)<\/div>/)
  if (!wrapper) throw new Error("home page has no agent-prompt block")
  const copy = wrapper[1].match(/data-copy="([^"]*)"/)
  if (!copy) throw new Error("agent-prompt block has no copyable text")
  return copy[1]
}

const REAL_COMMANDS = [
  "curl -fsSL https://opencode.ai/v2/install | bash",
  "git clone --branch v2-mirror --single-branch https://github.com/GaboEI/oh-my-rigel.git",
  "script/agent/setup.sh",
  "node profiles/gabo/validate-profile.mjs",
  "node profiles/gabo/rigel-v2-user-install.mjs install --version 1",
  "node profiles/gabo/rigel-v2-user-install.mjs status",
  "node profiles/gabo/rigel-v2-user-install.mjs upgrade --version 2",
  "node profiles/gabo/rigel-v2-user-install.mjs rollback",
  "node profiles/gabo/rigel-v2-user-install.mjs uninstall",
]

describe("#given the two-route install #when the agent prompt is inspected #then it is the English canonical prompt on both languages", () => {
  test("#given the ES and EN pages #when the agent prompt bytes are compared #then they are identical", () => {
    // given / when / then
    expect(agentPromptBytes(HOME.es)).toBe(agentPromptBytes(HOME.en))
  })

  test("#given each language page #when the agent prompt is read #then it equals the canonical ENGLISH constant", () => {
    // given / when / then
    expect(agentPromptBytes(HOME.es)).toBe(AGENT_PROMPT)
    expect(agentPromptBytes(HOME.en)).toBe(AGENT_PROMPT)
  })
})

describe("#given the install routes #when the markup is inspected #then both routes exist with the real commands", () => {
  for (const lang of ["es", "en"] as const) {
    test(`#given the ${lang} page #when the routes are read #then agent and manual anchors are present and every command is copyable`, () => {
      // given / when / then
      const html = HOME[lang]
      expect(html).toContain('id="install-agent"')
      expect(html).toContain('id="install-manual"')
      expect(html.includes('class="install-routes"')).toBe(false)
      expect(html.includes("/proyecto/")).toBe(false)
      expect(html.includes("/problemas/")).toBe(false)
      expect(html.includes('id="more"')).toBe(false)
      expect(html.includes('class="hero__actions"')).toBe(false)
      expect(html.includes('id="what"')).toBe(false)
      expect(html.includes("#what")).toBe(false)
      expect((html.match(/href="[^"]*\/catalogo\/"/g) || []).length).toBe(1)
      expect(html).toContain("/agentes-y-modelos/")
      expect(html).toContain('id="relationship"')
      expect(html).toContain('id="help"')
      expect(html).toContain('id="agentes-skill-comandos"')
      expect(html).toContain("#agentes-skill-comandos")
      expect(html).toContain("/agentes-y-modelos/guia-modelos/")
      for (const cmd of REAL_COMMANDS) expect([lang, cmd, html.includes(`data-copy="${cmd}"`)]).toEqual([lang, cmd, true])
    })
  }
})

describe("#given the cover #when the removed #what section is checked #then it is gone and the hero names the parent", () => {
  for (const lang of ["es", "en"] as const) {
    test(`#given the ${lang} page #when scanned #then the #what section and its nav link are absent`, () => {
      // given / when / then
      expect(HOME[lang].includes('id="what"')).toBe(false)
      expect(HOME[lang].includes("#what")).toBe(false)
    })
  }

  test("#given the hero #when read #then it names the parent project the first time", () => {
    // given / when / then
    expect(HOME.es).toContain("Oh My OpenCode (OmO)")
    expect(HOME.en).toContain("Oh My OpenCode (OmO)")
  })
})

describe("#given every copy control #when the markup is inspected #then it is icon-only with an accessible name and a failure message", () => {
  for (const lang of ["es", "en"] as const) {
    test(`#given the ${lang} page #when copy buttons are parsed #then none shows visible text and each carries the copy, check and error icons`, () => {
      // given / when / then
      const buttons = [...HOME[lang].matchAll(/<button class="copy"[^>]*>([\s\S]*?)<\/button>/g)]
      expect(buttons.length).toBeGreaterThan(0)
      for (const [tag, inner] of buttons) {
        expect(inner.replace(/<svg[\s\S]*?<\/svg>/g, "").trim()).toBe("")
        expect((inner.match(/class="copy__icon copy__icon--copy"/g) || []).length).toBe(1)
        expect((inner.match(/class="copy__icon copy__icon--done"/g) || []).length).toBe(1)
        expect((inner.match(/class="copy__icon copy__icon--error"/g) || []).length).toBe(1)
        expect(/data-error="[^"]+"/.test(tag)).toBe(true)
      }
    })
  }
})

describe("#given the public pages #when secret-like values are scanned #then none is present", () => {
  for (const lang of ["es", "en"] as const) {
    test(`#given the ${lang} page #when scanned #then there is no key, token or private key`, () => {
      // given / when / then
      expect(/sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(HOME[lang])).toBe(false)
    })
  }
})

describe("#given the guide page #when rendered #then it is the complete grouped inventory in both languages", () => {
  for (const lang of ["es", "en"] as const) {
    test(`#given the ${lang} guide #when scanned #then it carries every group and item with unique ids`, () => {
      // given / when / then
      const html = GUIDE[lang]
      expect((html.match(/class="guide-item"/g) || []).length).toBe(75)
      for (const [prefix, count] of [["agente-", 12], ["skill-", 33], ["cmd-", 30]] as const) {
        const ids = [...html.matchAll(new RegExp(`id="${prefix}([^"]+)"`, "g"))].map((m) => m[1])
        expect([prefix, ids.length, new Set(ids).size]).toEqual([prefix, count, count])
      }
      expect(html).toContain('id="agentes"')
      expect(html).toContain('id="skills"')
      expect(html).toContain('id="comandos"')
      expect(/<details[^>]*\sname=/.test(html)).toBe(false)
      expect(html).toContain("/agentes-y-modelos/")
    })
  }

  test("#given the cover #when the guide link is read #then ES is the exact text and EN is natural", () => {
    // given / when / then
    expect(HOME.es).toContain("Ver guía de modelos, skills y comandos")
    expect(HOME.en).toContain("Open the models, skills and commands guide")
  })

  test("#given the two guides #when the localized prose is compared #then the EN overlay changed it", () => {
    // given / when / then
    expect(GUIDE.es).toContain("Cuándo usarlo")
    expect(GUIDE.en).toContain("When to use it")
    expect(GUIDE.en.includes("Cuándo usarlo")).toBe(false)
  })

  // The beta Judge declares no model and no chain in model-core, so the agent/model intro must be
  // scoped to the OmO inventory; a universal "every agent has a model and chain" would be false.
  test("#given a guide agent without a declared model or chain #when the intro is rendered #then the copy is scoped, never universal", () => {
    // given / when / then
    for (const lang of ["es", "en"] as const) {
      expect(GUIDE[lang]).toContain(GUIDE_LEAD[lang].inventory)
      expect(GUIDE[lang].includes(GUIDE_LEAD[lang].all)).toBe(false)
      expect(GUIDE[lang]).toContain('data-agent-model-scope="inventory"')
    }
    expect(GUIDE.es).toContain("Sin cadena declarada en model-core")
    expect(GUIDE.en).toContain("No chain declared in model-core")
  })
})

describe("#given the EN pages #when scanned #then they are fully English with no translation notice", () => {
  test("#given the EN catalogue, cover and guide #when rendered #then no translation notice appears", () => {
    // given / when / then
    expect(CATALOG.en.includes('class="translation-notice"')).toBe(false)
    expect(HOME.en.includes('class="translation-notice"')).toBe(false)
    expect(GUIDE.en.includes('class="translation-notice"')).toBe(false)
  })

  test("#given the EN catalogue #when scanned #then it carries no Spanish accent (only the Español language name is allowed)", () => {
    // given / when / then
    expect(/[áéíóúÁÉÍÓÚñÑ¿¡«»]/.test(CATALOG.en.replaceAll("Español", ""))).toBe(false)
  })
})

describe("#given the default-models block #when rendered #then it lives on the deep guide, not the cover", () => {
  const rows = (html: string) => [...html.matchAll(/data-agent-id="([^"]+)" data-default-model="([^"]*)"/g)].map((m) => ({ id: m[1], model: m[2] }))
  const example = (html: string) => html.slice(html.indexOf('id="modelos-por-agente"')).match(/data-copy="([^"]*)"/)?.[1] ?? ""

  test("#given the guide #when the rows are read #then each model equals agents.json and the beta Judge declares none", () => {
    // given / when / then
    const list = rows(GUIDE.es)
    expect(list.length).toBe(source.guide.agents.length)
    expect(list.length).toBe(12)
    for (const a of source.agents.agents) {
      const row = list.find((r) => r.id === a.id)
      const expected = a.defaultModel ? `${a.defaultModel.model}${a.defaultModel.variant ? ` (${a.defaultModel.variant})` : ""}` : ""
      expect([a.id, row?.model]).toEqual([a.id, expected])
    }
    expect(list.find((r) => r.id === "judge")?.model).toBe("")
  })

  test("#given the guide #when the change-model explanation is read #then it carries the verified path and the canonical example", () => {
    // given / when / then
    for (const lang of ["es", "en"] as const) {
      expect(GUIDE[lang]).toContain("~/.omo/omo.jsonc")
      expect(GUIDE[lang]).toContain("[opencode]")
      expect(GUIDE[lang]).toContain('id="modelos-por-agente"')
    }
    expect(example(GUIDE.es)).toBe(example(GUIDE.en))
    expect(example(GUIDE.en)).toBe(MODEL_OVERRIDE_EXAMPLE.replaceAll('"', "&quot;"))
  })

  test("#given the cover #when the agent configuration section is read #then it is brief and links the guide, with no duplicated rows or example", () => {
    // given / when / then
    for (const lang of ["es", "en"] as const) {
      const home = HOME[lang]
      const title = lang === "es" ? "Configuración de agentes" : "Agent configuration"
      expect(home).toContain('id="configuracion-agentes"')
      expect(home).toContain(`>${title}</span>`)
      expect(home).toContain("/agentes-y-modelos/guia-modelos/")
      expect(home.includes("data-agent-id=")).toBe(false)
      expect(home.includes('id="modelos-por-agente"')).toBe(false)
    }
    expect(HOME.es.includes(MODEL_OVERRIDE_EXAMPLE.replaceAll('"', "&quot;"))).toBe(false)
  })
})

describe("#given the cover what-is block #when read #then it positions OMR, keeps the beta split and invents no date", () => {
  const section = (html: string) => html.match(/<section id="que-es"[\s\S]*?<\/section>/)?.[0] ?? ""

  test("#given the two covers #when the what-is block is read #then it states the orchestration-layer positioning", () => {
    // given / when / then
    expect(HOME.es).toContain('id="que-es"')
    expect(HOME.en).toContain('id="que-es"')
    expect(section(HOME.es)).toContain("capa de orquestación")
    expect(section(HOME.en)).toContain("orchestration layer")
  })

  test("#given the what-is block #when the OmO/beta distinction and dates are checked #then it separates the layers and invents no date", () => {
    // given / when / then
    for (const lang of ["es", "en"] as const) {
      const text = section(HOME[lang])
      expect(/beta/i.test(text)).toBe(true)
      expect(/\b(?:19|20)\d{2}\b/.test(text)).toBe(false)
    }
  })
})

describe("#given the header navigation #when the route is read #then only the matching section is active", () => {
  test("#given the cover #when scanned #then no nav item is marked active (never a hardcoded first item)", () => {
    // given / when / then
    for (const lang of ["es", "en"] as const) {
      expect(HOME[lang].includes('class="is-active" aria-current="page"')).toBe(false)
    }
  })

  test("#given the catalogue #when scanned #then Catálogo is the active section", () => {
    // given / when / then
    expect(CATALOG.en).toContain('href="/en/#benefits" class="is-active" aria-current="page"')
  })

  test("#given the nested guide #when scanned #then Recursos is the active section", () => {
    // given / when / then
    for (const lang of ["es", "en"] as const) {
      expect(GUIDE[lang]).toContain(`href="/${lang}/#agentes-skill-comandos" class="is-active" aria-current="page"`)
    }
  })

  test("#given each language page #when the nav is counted #then it carries the six localized sections", () => {
    // given
    const labels = {
      es: ["Catálogo", "Proyecto", "Instalar", "Configurar", "Recursos", "Ciclo de vida"],
      en: ["Catalogue", "Project", "Install", "Configure", "Resources", "Lifecycle"],
    }
    // when / then
    for (const lang of ["es", "en"] as const) {
      expect((HOME[lang].match(/class="top-nav"/g) || []).length).toBe(1)
      for (const label of labels[lang]) expect(HOME[lang]).toContain(`>${label}</a>`)
    }
  })

  test("#given the nav toggle #when rendered #then it carries the hamburger and close icons", () => {
    // given / when / then
    for (const lang of ["es", "en"] as const) {
      expect(HOME[lang]).toContain('class="nav-toggle__icon nav-toggle__icon--menu"')
      expect(HOME[lang]).toContain('class="nav-toggle__icon nav-toggle__icon--close"')
    }
  })
})
