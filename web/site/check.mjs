import { readFile, readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { absoluteUrl, publicPath, SITE } from "./lib/config.mjs"
import { buildSite } from "./build.mjs"
import { AGENT_PROMPT, GUIDE_LEAD, GITHUB_ISSUES_URL, THEME_COPY, THEME_INIT } from "./lib/render.mjs"

const outPath = fileURLToPath(SITE.outDir)

const FORBIDDEN_VISIBLE = [
  { label: "seal/baseline", re: /sha256|baseline|sello de datos|data seal/i },
  { label: "production jargon", re: /andamiaje|scaffold/i },
  { label: "phase tag", re: /\bW[0-9]\b/ },
  { label: "migration state", re: /migrada|adaptada|reescrita|sustituida|excluida|no_migrada|migrated|adapted|rewritten|replaced|excluded/i },
  { label: "raw state enum", re: /\bactivada\b|\bdesactivada\b|\bcondicionada\b/ },
]

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(full))
    else files.push(full)
  }
  return files
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function readCssBlock(css, openBrace) {
  let depth = 0
  for (let index = openBrace; index < css.length; index += 1) {
    const char = css[index]
    if (char === "{") depth += 1
    if (char === "}") depth -= 1
    if (depth === 0) return { body: css.slice(openBrace + 1, index), end: index + 1, start: openBrace }
  }
  throw new Error("unterminated CSS block")
}

function colorSchemeMediaBody(css) {
  const media = css.indexOf("@media (prefers-color-scheme: light)")
  assert(media >= 0, "CSS is missing the light color-scheme media block")
  const open = css.indexOf("{", media)
  assert(open >= 0, "CSS light color-scheme media block has no body")
  return readCssBlock(css, open).body
}

function mediaRanges(css) {
  const ranges = []
  let offset = 0
  while (offset < css.length) {
    const media = css.indexOf("@media", offset)
    if (media < 0) return ranges
    const open = css.indexOf("{", media)
    assert(open >= 0, "CSS @media rule has no body")
    const block = readCssBlock(css, open)
    ranges.push(block)
    offset = block.end
  }
  return ranges
}

function topLevelFontFaces(css) {
  const ranges = mediaRanges(css)
  return [...css.matchAll(/@font-face\s*\{/g)].filter((match) => {
    const index = match.index ?? 0
    return !ranges.some((range) => index > range.start && index < range.end)
  })
}

function routeFromFile(file) {
  const rel = `/${relative(outPath, file).replaceAll("\\", "/")}`
  return rel.endsWith("/index.html") ? rel.slice(0, -"index.html".length) : rel
}

function attrs(html, name) {
  const re = new RegExp(`${name}="([^"]+)"`, "g")
  return [...html.matchAll(re)].map((match) => match[1])
}

await buildSite()

const LEGACY_PREFIX = "/oh-my-rigel/"
const files = await listFiles(outPath)
const allHtmlFiles = files.filter((file) => file.endsWith(".html"))
const legacyFiles = allHtmlFiles.filter((file) => routeFromFile(file).startsWith(LEGACY_PREFIX))
const htmlFiles = allHtmlFiles.filter((file) => !routeFromFile(file).startsWith(LEGACY_PREFIX))
const routes = htmlFiles.map(routeFromFile)
const esRoutes = new Set(routes.filter((route) => route.startsWith("/es/")).map((route) => route.replace(/^\/es/, "")))
const enRoutes = new Set(routes.filter((route) => route.startsWith("/en/")).map((route) => route.replace(/^\/en/, "")))

assert(routes.includes("/"), "root index.html is missing")
assert(routes.includes("/es/"), "Spanish root is missing")
assert(routes.includes("/en/"), "English root is missing")
assert(!routes.includes("/catalogo/"), "unprefixed catalog route must not be emitted")
assert(JSON.stringify([...esRoutes].sort()) === JSON.stringify([...enRoutes].sort()), "ES/EN route mirrors differ")
assert(!routes.includes("/es/empezar/") && !routes.includes("/en/empezar/"), "the orphan /empezar/ stub must not be published")
const routeManifest = JSON.parse(await readFile(join(outPath, "route-manifest.json"), "utf8"))
assert(!routeManifest.routes.some((route) => route.includes("/empezar/")), "route-manifest must not list the removed /empezar/ stub")
// Publication artifact invariant: the build must emit exactly the expected 32 routes (the uploaded
// Pages artifact), so an accidental extra or dropped page fails the gate instead of shipping.
assert(routes.length === 32 && routeManifest.routes.length === 32, `published route set must be the expected 32 routes (found ${routes.length} html / ${routeManifest.routes.length} manifest)`)

const rootHtml = await readFile(join(outPath, "index.html"), "utf8")
assert(rootHtml.includes('id="benefits"') && rootHtml.includes('id="install"'), "root does not render the English cover journey")
assert(rootHtml.includes("data-lang-picker"), "root is missing the language selector")
assert(rootHtml.includes(`rel="canonical" href="${absoluteUrl("/en/")}"`), "root canonical must be the EN page")

// W6 fail-closed structure gate: every area and every function must carry a visible summary
// line. W5 derives them from real W2 data; W6 replaces the prose but may never drop the slot.
for (const rel of ["es/catalogo/index.html", "en/catalogo/index.html"]) {
  const cat = await readFile(join(outPath, rel), "utf8")
  const fichas = (cat.match(/class="ficha"/g) || []).length
  assert(fichas === 107, `${rel} expected 107 expandable fiches, found ${fichas}`)
  const ids = [...cat.matchAll(/<details class="ficha" id="([^"]+)"/g)].map((m) => m[1])
  assert(ids.length === 107 && new Set(ids).size === 107, `${rel} fiche ids must be 107 unique`)
  assert(!/<details[^>]*\sname=/.test(cat), `${rel} must not use an exclusive accordion (details name)`)
  // Catalogue ACTIVACION is a compact label+value line, never a single-cell grid whose
  // empty tracks render as a decorative band (Gabo 2026-10-09).
  const actLines = (cat.match(/class="activation-line"/g) || []).length
  assert(actLines === 107, `${rel} expected 107 compact activation lines, found ${actLines}`)
  assert(!/class="fact-list"/.test(cat), `${rel} catalogue must not use a grid fact-list (empty-band regression)`)
}

// W6 guide fail-closed structure gate: the near-empty models page is now the complete
// guide of agents, skills and commands. Every group and item is present, ids are unique,
// and no exclusive accordion (details name) hides items behind a tab or grid.
for (const lang of ["es", "en"]) {
  const rel = `${lang}/agentes-y-modelos/guia-modelos/index.html`
  const guide = await readFile(join(outPath, rel), "utf8")
  const items = (guide.match(/class="guide-item"/g) || []).length
  assert(items === 77, `${rel} expected 77 guide items, found ${items}`)
  for (const [prefix, count] of [["agente-", 12], ["skill-", 33], ["cmd-", 32]]) {
    const ids = [...guide.matchAll(new RegExp(`<details class="guide-item" id="${prefix}([^"]+)"`, "g"))].map((m) => m[1])
    assert(ids.length === count && new Set(ids).size === count, `${rel} ${prefix} ids must be ${count} unique, found ${ids.length}`)
  }
  assert(/id="agentes"/.test(guide) && /id="skills"/.test(guide) && /id="comandos"/.test(guide), `${rel} missing a guide group anchor`)
  // The beta Judge declares no model/chain, so the agent/model intro must be scoped to the OmO
  // inventory; a universal "every agent has a model and chain" is false and must never render.
  assert(guide.includes('data-agent-model-scope="inventory"'), `${rel} agent/model intro must be scoped to the inventory (the beta Judge declares neither)`)
  assert(!guide.includes(GUIDE_LEAD[lang].all), `${rel} must not carry the universal agent/model claim`)
  assert(guide.includes(GUIDE_LEAD[lang].inventory), `${rel} must carry the scoped agent/model intro`)
  // rigel-v2 install/uninstall are lab-scoped, not the public human install: the page must name
  // both the isolated laboratory and the public route so the distinction is never lost.
  assert(guide.includes("rigel-v2-user-install.mjs"), `${rel} guide must name the public human install route`)
  assert(guide.includes(lang === "es" ? "laboratorio aislado" : "isolated laboratory"), `${rel} guide must name the isolated laboratory`)
  // omo cleanup is Codex-Light-only; the page must state the accepted platform, never imply an
  // OmO/OpenCode uninstall.
  assert(guide.includes("--platform codex"), `${rel} guide must state that omo cleanup only supports --platform codex`)
  // The default-models inventory (12 rows + verified change path + canonical example) lives here.
  const defaultRows = (guide.match(/data-agent-id="[^"]+" data-default-model="[^"]*"/g) || []).length
  assert(defaultRows === 12, `${rel} guide must list all 12 agents with their real default model, found ${defaultRows}`)
  assert(guide.includes('id="modelos-por-agente"') && guide.includes("~/.omo/omo.jsonc") && guide.includes("[opencode]"), `${rel} guide must carry the default-models block with the verified config path`)
  assert(!/<details[^>]*\sname=/.test(guide), `${rel} must not use an exclusive accordion (details name)`)
  assert(!/class="area-index"|class="summary-grid"/.test(guide), `${rel} must not render a grid inventory (guide is vertical groups)`)
}

// Cover link (Gabo requirement): exact ES text, natural EN text, and the guide route exists.
const esHome = await readFile(join(outPath, "es", "index.html"), "utf8")
const enHome = await readFile(join(outPath, "en", "index.html"), "utf8")
assert(esHome.includes("Ver guía de modelos, skills y comandos"), "ES cover must carry the exact guide link text")
assert(enHome.includes("Open the models, skills and commands guide"), "EN cover must carry a natural guide link text")

// Bilingual guide: the localized prose differs per language (the EN overlay ran end to end).
const esGuide = await readFile(join(outPath, "es", "agentes-y-modelos", "guia-modelos", "index.html"), "utf8")
const enGuide = await readFile(join(outPath, "en", "agentes-y-modelos", "guia-modelos", "index.html"), "utf8")
assert(esGuide.includes("Cuándo usarlo") && enGuide.includes("When to use it"), "guide prose headings must be localized ES and EN")
assert(!enGuide.includes("Cuándo usarlo") && !esGuide.includes("When to use it"), "guide prose must not leak across languages")

// Anti-UX regression: the cover must read as prose, never as an inventory grid.
for (const rel of ["index.html", "es/index.html", "en/index.html"]) {
  const home = await readFile(join(outPath, rel), "utf8")
  assert(!home.includes("area-index"), `${rel} must not render the area inventory grid on the cover`)
  assert(!home.includes(">14<") && !home.includes(">107<") && !/>\s*14\s*·/.test(home), `${rel} must not show inventory counts on the cover`)
  assert(!/>A\.\s/.test(home), `${rel} must not show A-N area codes on the cover`)
  const benefits = (home.match(/class="benefit"/g) || []).length
  assert(benefits >= 3 && benefits <= 5, `${rel} cover needs 3-5 prose benefits, found ${benefits}`)
  assert(home.includes("/catalogo/"), `${rel} cover must link to the full catalogue`)
  // Header identity (Gabo 2026-10-09): the brand shows OMR, the plain "Oh My Rigel" eyebrow
  // above the H1 is removed, and only the H1 keeps the full name in the hero.
  assert(/<span class="brand__name">OMR<\/span>/.test(home), `${rel} header brand must read OMR`)
  assert(!/<p class="eyebrow">Oh My Rigel<\/p>/.test(home), `${rel} still renders the plain brand eyebrow above the title`)
  // Default-models inventory lives on the deep guide, not the cover (Gabo UX correction): the
  // cover keeps a brief Agent-configuration section that links the guide, and must NOT duplicate
  // the 12 rows or the copyable example.
  const agentConfigTitle = rel === "index.html" || rel.startsWith("en/") ? "Agent configuration" : "Configuración de agentes"
  assert(home.includes('id="configuracion-agentes"'), `${rel} cover must carry the Agent configuration section`)
  assert(home.includes(`>${agentConfigTitle}</span>`), `${rel} Agent configuration section title must be exactly "${agentConfigTitle}"`)
  assert(home.includes("/agentes-y-modelos/guia-modelos/"), `${rel} Agent configuration section must link the detailed guide`)
  assert(!/data-agent-id=/.test(home), `${rel} cover must not duplicate the default-model rows (they belong to the guide)`)
  assert(!home.includes('id="modelos-por-agente"'), `${rel} cover must not carry the deep default-models block`)
  // "What Oh My Rigel is": short attractor near the hero. Must position OMR as an orchestration
  // layer over OpenCode, keep the confirmed-OmO vs beta-layer split, and invent no date.
  const isEn = rel === "index.html" || rel.startsWith("en/")
  const queEs = home.match(/<section id="que-es"[\s\S]*?<\/section>/)?.[0] ?? ""
  assert(queEs.includes(isEn ? "orchestration layer" : "capa de orquestación"), `${rel} #que-es must state OMR is an orchestration layer over OpenCode`)
  assert(/beta/i.test(queEs), `${rel} #que-es must keep the confirmed-OmO vs beta-layer distinction`)
  assert(!/\b(?:19|20)\d{2}\b/.test(queEs), `${rel} #que-es must not invent a date (none is documented)`)
  // Factual copy (Gabo, auditor): no universal agent/model claim on the cover; the beta Judge
  // declares neither a default model nor a chain, so the copy must be scoped to the inventory.
  assert(!/cada agente tiene un modelo|each agent has a default/i.test(home), `${rel} must not make a universal agent/model claim (the beta Judge declares neither)`)
  assert(home.includes(isEn ? "when they are declared" : "cuando se declaran"), `${rel} agent/model copy must be scoped to the inventory`)
  // Factual copy (Gabo, auditor): commands must not promise "no side effects"; the guide cards
  // detail what each command does and what it touches.
  assert(!/no cambian el resto|do not change anything else/i.test(home), `${rel} must not promise command side-effect absence`)
  assert(home.includes(isEn ? "what it does and what it touches" : "qué hace y qué toca"), `${rel} commands copy must point to the guide cards' effect detail`)
  // Lifecycle safety (Gabo, auditor): the lifecycle commands resolve their target from the install
  // variables, so the section must name them and warn to re-export in a new shell.
  const lifecycle = home.match(/<section id="lifecycle"[\s\S]*?<\/section>/)?.[0] ?? ""
  assert(lifecycle.includes("RIGEL_V2_HOME") && lifecycle.includes("RIGEL_V2_CONFIG") && lifecycle.includes("RIGEL_V2_USER_ROOT"), `${rel} lifecycle must name the verified install variables`)
  assert(lifecycle.includes(isEn ? "new shell" : "shell nuevo"), `${rel} lifecycle must warn to re-export the variables in a new shell`)
}

// Install path (Gabo 2026-10-09): the public route is the OH-MY-RIGEL.md source install. It
// includes the migrated, confirmed OmO functionality plus an external BETA layer (Judge/agents/
// skills from profiles/gabo). The pages present the human route, the agent route with the
// canonical ENGLISH prompt (byte-identical ES/EN), and the lifecycle commands. No secret value
// may appear in any public page.
const SECRET_PATTERNS = [
  { label: "api key", re: /sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}/ },
  { label: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "bearer token", re: /Bearer\s+[A-Za-z0-9._-]{20,}/ },
]
for (const file of htmlFiles) {
  const html = await readFile(file, "utf8")
  const route = routeFromFile(file)
  for (const secret of SECRET_PATTERNS) assert(!secret.re.test(html), `${route} exposes a secret-like value: ${secret.label}`)
}
for (const rel of ["index.html", "es/index.html", "en/index.html"]) {
  const home = await readFile(join(outPath, rel), "utf8")
  assert(home.includes('id="install-agent"') && home.includes('id="install-manual"'), `${rel} missing the two install route anchors`)
  assert(!home.includes('class="install-routes"'), `${rel} must not render the redundant install route cards`)
  assert(!home.includes("/proyecto/"), `${rel} must not link to the removed /proyecto/ page`)
  assert(!home.includes("/problemas/"), `${rel} must not link to the removed /problemas/ page`)
  assert(home.includes('id="help"') && home.includes(GITHUB_ISSUES_URL), `${rel} must carry the on-cover Help section with the verified issues URL`)
  assert(/#relationship/.test(home) && home.includes('id="relationship"'), `${rel} nav must reach the relationship section`)
  assert(!home.includes('id="more"'), `${rel} must not render the removed #more Fichas section`)
  assert(!home.includes('id="what"') && !home.includes("#what"), `${rel} must not render the removed #what section or link`)
  assert(!home.includes('class="hero__actions"'), `${rel} hero must not render the removed action buttons`)
  assert((home.match(/href="[^"]*\/catalogo\/"/g) || []).length === 1, `${rel} must expose exactly one /catalogo/ link from the cover`)
  assert(home.includes("/agentes-y-modelos/"), `${rel} must keep /agentes-y-modelos/ reachable (not orphaned)`)
  assert(home.includes('id="agentes-skill-comandos"') && home.includes("#agentes-skill-comandos"), `${rel} must carry the Agents/skills/commands section and its nav anchor`)
  assert(home.includes("/agentes-y-modelos/guia-modelos/"), `${rel} must link the existing models guide`)
  assert(home.includes(`data-copy="${AGENT_PROMPT}"`), `${rel} agent prompt is not the canonical byte-identical prompt`)
  for (const cmd of [
    "curl -fsSL https://opencode.ai/v2/install | bash",
    "git clone --branch v2-mirror --single-branch https://github.com/GaboEI/oh-my-rigel.git",
    "script/agent/setup.sh",
    "node profiles/gabo/validate-profile.mjs",
    "node profiles/gabo/rigel-v2-user-install.mjs install --version 1",
    "rigel-v2-user-install.mjs rollback",
    "rigel-v2-user-install.mjs uninstall",
  ]) {
    assert(home.includes(cmd), `${rel} install/lifecycle command missing: ${cmd}`)
  }
}

for (const file of htmlFiles) {
  const html = await readFile(file, "utf8")
  const route = routeFromFile(file)
  assert(!/http-equiv=["']refresh/i.test(html), `${route} contains meta refresh`)
  assert(!/window\.location/i.test(html), `${route} contains window.location`)
  // Scripts: exactly two allowed forms. The same-origin deferred `catalog.js`, and the single
  // inline pre-paint theme init whose text must equal THEME_INIT byte-for-byte (so a CSP can pin
  // it by hash and any injected inline JS fails the build).
  for (const script of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = script[1]
    if (attrs.includes(`src="${publicPath("/assets/catalog.js")}"`)) {
      assert(/\bdefer\b/.test(attrs), `${route} catalog.js must be deferred: ${script[0]}`)
    } else {
      assert(attrs.trim() === "", `${route} inline theme init must carry no attributes`)
      assert(script[2] === THEME_INIT, `${route} has a disallowed or altered inline script`)
    }
  }
  const cmdCount = (html.match(/class="cmd"/g) || []).length
  const copyCount = (html.match(/class="copy"/g) || []).length
  assert(cmdCount === copyCount, `${route} every command block needs exactly one copy button (${cmdCount} vs ${copyCount})`)
  // Reusable icon copy control (Gabo 2026-10-09): one integrated icon per block, no visible
  // text, an accessible name, and a live status region per block.
  const statusCount = (html.match(/class="cmd__status\b/g) || []).length
  const copyIconCount = (html.match(/class="copy__icon copy__icon--copy"/g) || []).length
  const doneIconCount = (html.match(/class="copy__icon copy__icon--done"/g) || []).length
  const errorIconCount = (html.match(/class="copy__icon copy__icon--error"/g) || []).length
  assert(statusCount === cmdCount, `${route} every command block needs exactly one live status region (${statusCount} vs ${cmdCount})`)
  assert(copyIconCount === cmdCount && doneIconCount === cmdCount && errorIconCount === cmdCount, `${route} every copy control needs the copy, check and error icons (${copyIconCount}/${doneIconCount}/${errorIconCount} vs ${cmdCount})`)
  for (const btn of html.matchAll(/<button class="copy"[^>]*>([\s\S]*?)<\/button>/g)) {
    const visual = btn[1].replace(/<svg[\s\S]*?<\/svg>/g, "").trim()
    assert(visual === "", `${route} copy control must be icon-only (no visible text or external button)`)
    assert(/aria-label="[^"]+"/.test(btn[0]), `${route} copy control needs an accessible name`)
    assert(/data-error="[^"]+"/.test(btn[0]), `${route} copy control needs a non-empty data-error message`)
  }
  if (cmdCount > 0) assert(html.includes('class="cmd__status visually-hidden" role="status" aria-live="polite"'), `${route} copy controls need an accessible live status region`)
  // A grid container with a single child renders empty tracks as a same-grid decorative
  // band. Fail-closed on any single-child .fact-list/.summary-grid (Gabo 2026-10-09).
  for (const block of html.matchAll(/<dl class="(?:fact-list|summary-grid)">([\s\S]*?)<\/dl>/g)) {
    const children = (block[1].match(/<div\b/g) || []).length
    assert(children !== 1, `${route} has a ${block[0].includes("fact-list") ? "fact-list" : "summary-grid"} with a single child (empty-band regression)`)
  }
  assert(!/(class="cmd"|data-copy)[^>]*\.\.\./.test(html), `${route} has a pseudo-command with ellipsis`)
  assert(!/<pre><code>[^<]*\.\.\./.test(html), `${route} has an ellipsis command in a code block`)
  assert(/rel="icon"/.test(html), `${route} missing favicon`)
  const visible = html.replace(/<!--[\s\S]*?-->/g, "")
  for (const forbidden of FORBIDDEN_VISIBLE) {
    assert(!forbidden.re.test(visible), `${route} exposes forbidden visible text: ${forbidden.label}`)
  }
  assert(!html.includes("journey-nav"), `${route} still renders the duplicate anchor nav`)
  assert(!html.includes("area-index"), `${route} must not render an inventory grid`)
  if (route !== "/404.html") {
    assert(/<a class="github-link"[^>]*aria-label="[^"]+"/.test(html), `${route} missing accessible GitHub link`)
    assert(html.includes('href="https://github.com/GaboEI/oh-my-rigel/tree/v2-mirror"'), `${route} GitHub link must target v2-mirror`)
    assert(html.includes('aria-label="Español"') && html.includes('aria-label="English"'), `${route} language selector must expose ES/EN with accessible names`)
    // Language picker: one compact control showing the active language, opening an overlay menu
    // (never pushing the page) with both languages; the header GitHub link is icon-only.
    assert((html.match(/data-lang-picker/g) || []).length === 1, `${route} must render exactly one language picker`)
    assert(/<button class="lang-picker__button"[^>]*data-lang-menu-button[^>]*aria-haspopup="true"[^>]*aria-expanded="false"[^>]*aria-controls="lang-menu"[^>]*aria-label="[^"]+"/.test(html), `${route} language picker button needs aria state`)
    assert(html.includes('class="lang-picker__menu" id="lang-menu" data-lang-menu hidden'), `${route} language picker menu must be hidden by default`)
    const headerActionsHtml = html.match(/class="header-actions"[\s\S]*?<\/header>/)?.[0] ?? ""
    assert(/<a class="github-link"[^>]*><svg/.test(headerActionsHtml) && !headerActionsHtml.includes(">GitHub</span>"), `${route} header GitHub must be icon-only (the label lives in the mobile menu)`)
    // Theme picker: one compact control (current-mode icon + caret) opening a menu with the three
    // modes in the route's language, in the header actions, with no visible "Tema"/"Theme" label.
    const themeLang = route.startsWith("/es/") ? "es" : "en"
    const themeCopy = THEME_COPY[themeLang]
    assert((html.match(/data-theme-switch/g) || []).length === 1, `${route} must render exactly one theme picker`)
    assert(/<button class="theme-picker__button"[^>]*data-theme-menu-button[^>]*aria-haspopup="true"[^>]*aria-expanded="false"[^>]*aria-controls="theme-menu"/.test(html), `${route} theme picker button needs aria-haspopup/expanded/controls`)
    assert(html.includes('class="theme-picker__menu" id="theme-menu" data-theme-menu hidden'), `${route} theme picker menu must be hidden by default`)
    for (const value of ["system", "light", "dark"]) {
      assert(new RegExp(`data-theme-option="${value}"[^>]*>${themeCopy[value]}</button>`).test(html), `${route} theme option ${value} must be localized`)
    }
    assert(/class="header-actions"[\s\S]*?class="theme-picker"/.test(html), `${route} theme picker must live in the header actions`)
    assert(!/class="theme-picker__label"/.test(html), `${route} theme picker must not render a visible text label`)
    assert((html.match(/class="top-nav"/g) || []).length === 1, `${route} must render exactly one navigation (no duplicate)`)
    assert(html.includes('id="site-nav"'), `${route} nav needs the id the toggle controls`)
    assert(/<button class="nav-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="site-nav"[^>]*aria-label="[^"]+"/.test(html), `${route} missing the accessible nav toggle`)
    assert(html.includes('class="nav-toggle__icon nav-toggle__icon--menu"') && html.includes('class="nav-toggle__icon nav-toggle__icon--close"'), `${route} nav toggle needs the hamburger and close icons`)
    // Active state derives from the real route (and its nested routes), never a hardcoded first item.
    const pathNoLang = route.replace(/^\/(es|en)(?=\/|$)/, "") || "/"
    const expectedHash = pathNoLang.startsWith("/catalogo/") ? "benefits" : pathNoLang.startsWith("/agentes-y-modelos/") ? "agentes-skill-comandos" : null
    const activeCount = (html.match(/class="is-active" aria-current="page"/g) || []).length
    assert(activeCount === (expectedHash ? 1 : 0), `${route} must mark exactly the route's section active (found ${activeCount})`)
    if (expectedHash) {
      assert(html.includes(`href="${publicPath(`/${themeLang}/`)}#${expectedHash}" class="is-active" aria-current="page"`), `${route} the active nav link must be the route's section`)
    }
    const footerHtml = html.match(/<footer class="site-footer">([\s\S]*?)<\/footer>/)?.[1] ?? ""
    assert(footerHtml.includes("/agentes-y-modelos/"), `${route} footer must keep the Agents link`)
    assert(footerHtml.includes("github.com/GaboEI/oh-my-rigel"), `${route} footer must carry the GitHub link`)
    assert(!footerHtml.includes("/catalogo/"), `${route} footer must not duplicate the catalogue link`)
  }
  // Link integrity: every internal href must resolve to a shipped file (no broken links).
  const base = publicPath("/")
  const shipped = new Set(files)
  for (const href of attrs(html, "href")) {
    if (href.startsWith("#") || href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:")) continue
    assert(href.startsWith(base), `${route} has href without basePath: ${href}`)
    const clean = href.slice(base.length).split("#")[0].split("?")[0]
    const rel = clean === "" || clean.endsWith("/") ? `${clean}index.html` : clean
    assert(shipped.has(join(outPath, rel)), `${route} links a missing target: ${href}`)
  }
  // The EN site is fully translated now (catalogue included), so no translation notice may render.
  assert(!html.includes('class="translation-notice"'), `${route} must not render a translation notice (the EN site is fully translated)`)
  if (route.startsWith("/es/") || route.startsWith("/en/")) {
    const lang = route.startsWith("/es/") ? "es" : "en"
    const logical = route.endsWith("/") ? route : route.replace(/index\.html$/, "")
    assert(html.includes(`rel="canonical" href="${absoluteUrl(logical)}"`), `${route} missing absolute canonical`)
    assert(html.includes(`hreflang="${lang}" href="${absoluteUrl(logical)}"`), `${route} missing same-language alternate`)
    assert(html.includes(`hreflang="x-default" href="${absoluteUrl("/")}"`), `${route} missing x-default alternate`)
    assert(html.includes('class="anchor-star"'), `${route} missing star-anchor signature`)
    assert(html.includes('rel="preload"') && html.includes("as=\"font\""), `${route} missing font preload`)
  }
}

// Blocking criterion (Gabo): no visible Spanish anywhere on an EN route. The only allowed
// non-English token is the language selector's native name ("Español") on the ES link.
const ES_ACCENT = /[^\s]*[áéíóúÁÉÍÓÚñÑ¿¡«»][^\s]*/i
const ES_WORDS = /\b(cómo|qué|cuándo|sirve|activación|requisitos|función|catálogo|instalación|configuración|guía|página|sesión|archivo|modelo|cadena|agentes|herramientas|delegación|permisos|continuidad|contexto|ejecuta|planifica|reparte|tareas|usuario|ajustes|desinstalación|ciclo|ayuda|relación|empezar|idioma|entorno|flujo|aporta|merece|asistente|conserva|portada|recibe|elige|comprueba|muestra|puedes|tienes|también|pregunta|dependencia|riesgo)\b/i
function spanishSignals(html) {
  const stripped = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "")
  const visible = stripped.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ")
  const attrs = [...stripped.matchAll(/(?:aria-label|title|alt|placeholder)="([^"]*)"/g)].map((match) => match[1])
  const signals = []
  for (const [where, text] of [["text", visible], ...attrs.map((value) => ["attr", value])]) {
    const clean = text.replaceAll("Español", "")
    const accent = clean.match(ES_ACCENT)
    if (accent) signals.push(`${where}:accent:${accent[0]}`)
    const word = clean.match(ES_WORDS)
    if (word) signals.push(`${where}:word:${word[0]}`)
  }
  return [...new Set(signals)]
}
for (const file of htmlFiles) {
  const route = routeFromFile(file)
  if (!route.startsWith("/en/")) continue
  const signals = spanishSignals(await readFile(file, "utf8"))
  assert(signals.length === 0, `${route} exposes visible Spanish; the EN site must be fully English: ${signals.slice(0, 4).join(", ")}`)
}

const css = await readFile(new URL("assets/styles.css", SITE.outDir), "utf8")
for (const banned of ["linear-gradient", "radial-gradient", "conic-gradient", "backdrop-filter", "box-shadow"]) {
  assert(!css.includes(banned), `CSS contains banned W4 pattern: ${banned}`)
}
assert(css.includes("@font-face"), "CSS is missing self-hosted @font-face")
assert(!colorSchemeMediaBody(css).includes("@font-face"), "self-hosted @font-face rules must be top-level, not gated by prefers-color-scheme")
assert(topLevelFontFaces(css).length === 4, "CSS must register the four self-hosted font faces at top level so dark and light themes share them")
// Open ficha must be distinguishable from closed WITHOUT relying on colour or the +/- glyph
// alone: a structural left border, a distinct summary background, and a heavier title
// (Gabo 2026-10-09). The single-item grid that produced an empty band is banned outright.
const footerRule = css.match(/\.site-footer\s*\{([^}]*)\}/)
assert(footerRule && !/border-block-start/.test(footerRule[1]), "footer must not add a second separation border")
assert(!css.includes("repeat(3, 1fr)"), "CSS forces a fixed 3-column grid that renders empty cells for single-item lists")
assert(/\.summary-grid,\s*\.fact-list\s*\{[^}]*repeat\(auto-fit/.test(css), "fact-list/summary-grid must use an auto-fit grid so empty tracks collapse")
assert(/\.activation-line\b/.test(css), "missing .activation-line styles")
// WCAG 2.2 target size: the language selector links must be at least 24px wide.
assert(/\.lang-picker__button\s*\{[^}]*min-block-size:\s*2\.25rem/.test(css), "language picker keeps a compact desktop target")
assert(/\.lang-picker__button:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/.test(css), "language picker needs a visible focus ring")
assert(/\.lang-picker__menu\s*\{[^}]*position:\s*absolute/.test(css), "language menu must be an overlay (never pushes the page)")
// WCAG 1.4.10 reflow: the catalogue summary grid must use a shrinkable content track so the page
// reflows at 320 CSS px (and at 200% zoom on a 390 px phone) instead of scrolling horizontally.
assert(/\.ficha > summary\s*\{[^}]*minmax\(0,\s*1fr\)/.test(css), "ficha summary must use a shrinkable track (minmax(0,1fr)) for reflow")
const openSummaryRule = css.match(/\.ficha\[open\]\s*>\s*summary\s*\{([^}]*)\}/)
assert(openSummaryRule, "missing .ficha[open] > summary rule (open state must be styled)")
assert(/border-inline-start/.test(openSummaryRule[1]), "open ficha summary needs a structural left border (not colour-only)")
assert(/background/.test(openSummaryRule[1]), "open ficha summary needs a distinct background")
assert(/\.ficha\[open\]\s+\.ficha__name\s*\{[^}]*font-weight/.test(css), "open ficha title needs a heavier weight (not glyph/colour-only)")
// The guide reuses the same non-colour-only open contract per item.
const guideOpenSummaryRule = css.match(/\.guide-item\[open\]\s*>\s*summary\s*\{([^}]*)\}/)
assert(guideOpenSummaryRule, "missing .guide-item[open] > summary rule (open state must be styled)")
assert(/border-inline-start/.test(guideOpenSummaryRule[1]), "open guide item needs a structural left border (not colour-only)")
assert(/background/.test(guideOpenSummaryRule[1]), "open guide item needs a distinct background")
assert(/\.guide-item\[open\]\s+\.guide-item__name\s*\{[^}]*font-weight/.test(css), "open guide item title needs a heavier weight (not glyph/colour-only)")
// Swiss/editorial direction (Gabo): these structural markers are the visual contract and must persist.
assert(/\.panel > h2[^{]*\{[^}]*border-inline-start/.test(css), "section H2 must carry the accent bar (hierarchy)")
assert(/scroll-margin-top:\s*6rem/.test(css), "anchored sections must set scroll-margin-top (deep-link orientation below the sticky header)")
assert(/\.cmd\s*\{[^}]*border-inline-start:\s*3px solid var\(--info\)/.test(css), "command blocks must carry the dev-tool info left border")
// Copy failure must be visible without colour alone (audit fix): the control swaps to a
// distinct error icon, the command row carries the error border, and the live status text
// becomes visible inside the same row (no extra box). Fail-closed so a CSS refactor cannot
// silently drop the feedback and leave the failure as a colour change only.
assert(/\.copy__icon--error\s*\{[^}]*display:\s*none/.test(css), "error icon must be hidden until a copy fails")
assert(/\.copy\.is-error\s+\.copy__icon--error\s*\{[^}]*display:\s*inline-block/.test(css), "a failed copy must render the error icon")
assert(/\.copy\.is-error\s+\.copy__icon--copy\s*\{[^}]*display:\s*none/.test(css), "a failed copy must replace the copy icon")
const errorRowRule = css.match(/\.cmd\.is-error\s*\{([^}]*)\}/)
assert(errorRowRule && /var\(--err\)/.test(errorRowRule[1]), "a failed copy must mark the command row with the error border")
const errorStatusRule = css.match(/\.cmd\.is-error\s+\.cmd__status\s*\{([^}]*)\}/)
assert(errorStatusRule, "missing the visible error status rule (the failure text must leave the live region)")
assert(/position:\s*static/.test(errorStatusRule[1]) && /clip-path:\s*none/.test(errorStatusRule[1]), "the error status must override the visually-hidden clipping")
assert(/color:\s*var\(--fg\)/.test(errorStatusRule[1]), "the error status text must use an AA text token, not colour alone")
assert(/@media \(prefers-reduced-motion: no-preference\)[\s\S]*?scroll-behavior:\s*smooth/.test(css), "smooth scroll must be gated on reduced-motion")
// Editorial iteration (auditor round 2): the recomposed hero and section rhythm must persist.
assert(/\.hero\s*\{[^}]*background:\s*var\(--surf\)/.test(css), "hero must be an editorial band (surface background)")
assert(/\.panel > h2[^{]*\{[^}]*border-block-start/.test(css), "section H2 must carry a top rule (rhythm)")
// Mobile nav must WRAP so no shortcut is hidden behind an invisible horizontal scroll strip
// (Gabo 2026-10-09, audit round 2). The base rule must not force nowrap or overflow-x.
const navRule = css.match(/\.top-nav\s*\{([^}]*)\}/)
assert(navRule, "missing base .top-nav rule")
assert(/flex-wrap:\s*wrap/.test(navRule[1]), "wide nav must wrap rather than clip")
assert(!/overflow-x/.test(navRule[1]), "nav must not hide shortcuts behind a horizontal scroll strip")
assert(!/flex-wrap:\s*nowrap/.test(navRule[1]), "nav must not force a single clipped line")
// Desktop grouping: the brand and the nav are one left group (nav margin, not centred) and the
// utilities are pushed right by an auto margin, so the flexible gap lives only between the groups.
assert(!/justify-content:\s*center/.test(navRule[1]), "desktop nav must not be artificially centred")
assert(/flex-basis:\s*100%/.test(navRule[1]), "desktop nav must own its own full-width row below the brand")
assert(/\.header-actions\s*\{[^}]*margin-inline-start:\s*auto/.test(css), "utility controls stay pushed to the right of the header")
// Narrow screens use a compact accessible control: a real button toggles the SAME nav (no
// duplicate navigation), hidden by default and revealed by `.is-open` (Gabo 2026-10-09).
assert(/\.nav-toggle\s*\{[^}]*display:\s*none/.test(css), "nav toggle must be hidden by default on wide screens")
assert(/@media\s*\(max-width:\s*1023px\)/.test(css), "missing the narrow-screen navigation media query")
// The mobile menu is an absolute overlay below the header (it must never push the content) with a
// hamburger/close icon swap.
// The header never scrolls away: sticky at the top, above the content, so the mobile overlay
// stays attached to it while the page moves underneath.
assert(/\.site-header\s*\{[^}]*position:\s*sticky/.test(css) && /\.site-header\s*\{[^}]*inset-block-start:\s*0/.test(css), "header must be sticky at the top of the viewport")
assert(/\.site-header\s*\{[^}]*z-index:\s*40/.test(css), "sticky header must paint above the page content")
assert(/\.top-nav\s*\{[^}]*display:\s*none/.test(css), "narrow nav must be hidden until the toggle opens it")
assert(/\.top-nav\s*\{[^}]*position:\s*absolute/.test(css) && /\.top-nav\s*\{[^}]*inset-block-start:\s*100%/.test(css), "mobile nav must be an absolute overlay below the header")
assert(/\.top-nav\.is-open\s*\{[^}]*display:\s*flex/.test(css), "open nav must become visible")
assert(/\.nav-toggle\[aria-expanded="true"\]\s+\.nav-toggle__icon--close\s*\{[^}]*display:\s*inline-block/.test(css), "an open menu must swap the hamburger for the close icon")
// Nav links carry no permanent underline; the active one gets a 2px accent underline, and the
// theme picker keeps a 44px target with a visible focus ring (Gabo minimal technical navbar).
assert(/\.top-nav a:is\(:link, :visited\)\s*\{[^}]*text-decoration:\s*none/.test(css), "inactive nav links must not be permanently underlined")
assert(/\.top-nav a\.is-active\s*\{[^}]*text-decoration:\s*underline[^}]*text-decoration-color:\s*var\(--accent\)[^}]*text-decoration-thickness:\s*2px/.test(css), "the active nav link needs a 2px accent underline")
assert(/\.theme-picker__button\s*\{[^}]*min-block-size:\s*2\.25rem/.test(css), "theme picker keeps a compact desktop target (44px on touch)")
assert(/\.theme-picker__button:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/.test(css), "theme picker button needs a visible focus ring")
assert(!/fonts\.(googleapis|gstatic)\.com/.test(css), "CSS references an external font origin")
assert(!/@import/.test(css), "CSS uses @import (external fetch risk)")
for (const file of ["newsreader-latin-var.woff2", "plex-mono-400-latin.woff2", "plex-mono-500-latin.woff2", "plex-mono-600-latin.woff2", "OFL-Newsreader.txt", "OFL-IBM-Plex-Mono.txt"]) {
  assert(existsSync(join(outPath, "assets", "fonts", file)), `missing shipped font artifact: ${file}`)
}
assert(SITE.basePath.startsWith("/"), "basePath must be absolute")

const enCatalogHtml = await readFile(join(outPath, "en", "catalogo", "index.html"), "utf8")
const esCatalogHtml = await readFile(join(outPath, "es", "catalogo", "index.html"), "utf8")
assert(enCatalogHtml.includes("Agents and delegation"), "EN catalogue did not apply the W3 overlay")
assert(!enCatalogHtml.includes("Agentes y delegación"), "EN catalogue leaked the ES area name")
assert(esCatalogHtml.includes("Agentes y delegación"), "ES catalogue lost the source area name")

// W7 gate 6 (external half): every documented external link must stay critical, secure and
// approved. Each absolute href must be https, its host must be on the frozen allowlist, and the
// critical URLs the site promises must be present. A rogue third-party link (tracer, CDN,
// analytics) or a downgraded http origin fails the build naming the page and the exact URL.
const EXTERNAL_ORIGIN_ALLOWLIST = new Set([
  "omr.gabodev.dev", // the site's own custom domain origin (absolute canonical/hreflang URLs)
  "github.com", // repository and issues
  "opencode.ai", // the host product's official V2 documentation
])
const REQUIRED_EXTERNAL_URLS = [
  "https://github.com/GaboEI/oh-my-rigel/tree/v2-mirror",
  "https://github.com/GaboEI/oh-my-rigel/issues",
  "https://opencode.ai/v2/docs/migrate-v1/",
]
const seenExternal = new Set()
for (const file of htmlFiles) {
  const html = await readFile(file, "utf8")
  const route = routeFromFile(file)
  for (const href of attrs(html, "href")) {
    if (href.startsWith("#") || href.startsWith("mailto:")) continue
    if (!/^https?:\/\//.test(href)) continue
    let url
    try {
      url = new URL(href)
    } catch {
      assert(false, `${route} has a malformed external URL: ${href}`)
      continue
    }
    assert(url.protocol === "https:", `${route} external link must be https (downgraded): ${href}`)
    assert(EXTERNAL_ORIGIN_ALLOWLIST.has(url.host), `${route} external link origin is not approved: ${href}`)
    seenExternal.add(`${url.origin}${url.pathname}`)
  }
}
for (const required of REQUIRED_EXTERNAL_URLS) {
  const url = new URL(required)
  assert(seenExternal.has(`${url.origin}${url.pathname}`), `required external link is missing from the published site: ${required}`)
}

// W7 SEO: the publication ships robots.txt and a sitemap.xml that lists every published route
// (except the noindex 404) with absolute URLs. Fail-closed so an SEO regression cannot ship.
const robots = await readFile(join(outPath, "robots.txt"), "utf8")
assert(/Sitemap:\s*https:\/\/\S+/.test(robots), "robots.txt must point to an absolute sitemap URL")
const sitemap = await readFile(join(outPath, "sitemap.xml"), "utf8")
const sitemapLocs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])
assert(sitemapLocs.length > 0, "sitemap.xml must list at least one URL")
for (const loc of sitemapLocs) assert(loc.startsWith("https://"), `sitemap.xml <loc> must be absolute: ${loc}`)
for (const route of routeManifest.routes.filter((route) => route !== "/404.html")) {
  const expected = absoluteUrl(route)
  assert(sitemapLocs.includes(expected), `sitemap.xml is missing published route: ${expected}`)
}

// W7 gates 5/11: no invented command may be SHOWN to a reader. EVERY line of every command-bearing
// block (copy payloads, <pre><code> blocks, <span class="command"> labels) is scanned, not just the
// first line of a block; a line whose first token is an unrecognized command fails the build with
// the page and the token. The agent-first prompt is a prose block and is skipped by identity; JSON,
// comment and path lines are structural, not commands. `rigel setup` is allowed only as the
// DECLARED-ABSENT command on a page that states its absence; the host `opencode` CLI resolves only
// to its real V2 surfaces (models, auth, service, debug and the TUI's /connect, /models).
const cli = JSON.parse(await readFile(new URL("../data/cli.json", import.meta.url), "utf8"))
const omoCommands = new Set()
for (const c of cli.owners.omo.commands) {
  omoCommands.add(c.name)
  for (const alias of c.aliases ?? []) omoCommands.add(alias)
}
const rigelCommands = new Set()
for (const c of cli.owners["rigel-v2"].commands) {
  rigelCommands.add(c.name)
  for (const alias of c.aliases ?? []) rigelCommands.add(alias)
}
const slashCommands = new Set(cli.owners.slash.commands)
const OPENCODE_COMMANDS = new Set(["--version", "--help", "models", "auth", "service", "debug", "run", "serve"])
const OPENCODE_TUI_COMMANDS = new Set(["connect", "models"])
const SHELL_UTILITIES = new Set(["curl", "git", "cd", "export", "test", "node", "bun", "bunx", "npm", "pnpm", "yarn", "echo", "chmod", "mkdir", "ls", "cat", "sudo", "rm", "cp", "mv", "source", "set", "printf"])
const DECLARED_ABSENT_COMMANDS = new Set(["rigel setup"])
const FORBIDDEN_COMMAND_PATTERNS = [/\bopencode providers\b/]
function isStructuralLine(first) {
  return first === "" || /^[{}\[\]"#<>$@*~]/.test(first) || first === "/" || first.startsWith("//") || first.startsWith("-") || first.startsWith("(") || /^\d+\.$/.test(first)
}
function isShellPath(first) {
  if (first === "get.omo.dev/install.sh") return true
  return /^(?:\.{0,2}\/)?(?:script|profiles)\/[^\s]+\.(?:mjs|sh|js|ts|json)$/.test(first)
}
function unescapeHtml(value) {
  return value.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")
}
function renderedBlocks(html) {
  const blocks = []
  for (const value of attrs(html, "data-copy")) blocks.push(unescapeHtml(value))
  for (const match of html.matchAll(/<span class="command">([^<]+)<\/span>/g)) blocks.push(unescapeHtml(match[1]))
  for (const match of html.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)) blocks.push(unescapeHtml(match[1]))
  return blocks
}
for (const file of htmlFiles) {
  const html = await readFile(file, "utf8")
  const route = routeFromFile(file)
  for (const forbidden of FORBIDDEN_COMMAND_PATTERNS) {
    assert(!forbidden.test(html), `${route} renders a command that does not exist in OpenCode V2: ${forbidden}`)
  }
  const hasAbsenceNotice = html.includes("rigel setup") && /no existe|does not exist yet/.test(html)
  for (const block of renderedBlocks(html)) {
    if (block === AGENT_PROMPT) continue
    for (const line of block.split("\n").map((value) => value.trim()).filter((value) => value.length > 0)) {
      const [first, second = ""] = line.split(/\s+/)
      const pair = `${first} ${second}`
      if (isStructuralLine(first) || isShellPath(first)) continue
      if (SHELL_UTILITIES.has(first)) continue
      if (DECLARED_ABSENT_COMMANDS.has(pair)) {
        assert(hasAbsenceNotice, `${route} shows the declared-absent command "${pair}" without its absence notice`)
      } else if (first === "omo" || first === "oh-my-openagent") {
        assert(omoCommands.has(second), `${route} shows an invented command: ${pair}`)
      } else if (first === "rigel-v2") {
        assert(rigelCommands.has(second), `${route} shows an invented rigel-v2 command: ${pair}`)
      } else if (/^\/[a-z][a-z0-9-]*$/.test(first)) {
        assert(slashCommands.has(first.slice(1)) || OPENCODE_TUI_COMMANDS.has(first.slice(1)), `${route} shows an invented slash command: ${first}`)
      } else if (first === "opencode") {
        assert(second === "" || OPENCODE_COMMANDS.has(second), `${route} shows an undocumented opencode command: ${pair}`)
      } else {
        assert(false, `${route} shows an unrecognized command token: ${first}`)
      }
    }
  }
}

// W7 gates 11/12: the guide must document the real OpenCode provider and model path, and must
// never present the V2-nonexistent `opencode providers list|login|logout` names. This is blocking,
// so an omission fails CI instead of sailing through.
const REQUIRED_OPENCODE_SURFACES = ["opencode models", "/models", "/connect", "opencode auth login", "opencode auth list", "opencode auth logout", "agents.title.model"]
for (const lang of ["es", "en"]) {
  const guide = await readFile(join(outPath, lang, "agentes-y-modelos", "guia-modelos", "index.html"), "utf8")
  for (const surface of REQUIRED_OPENCODE_SURFACES) {
    assert(guide.includes(surface), `${lang}/agentes-y-modelos/guia-modelos/ omits the real OpenCode surface: ${surface}`)
  }
  assert(guide.includes('id="proveedores"'), `${lang}/agentes-y-modelos/guia-modelos/ is missing the providers and primary-model section`)
}

// W7 gate 10: a copyable example may cite only models that exist in OpenCode V2's authoritative
// catalog (models.dev, per opencode.ai/v2/docs/providers), pinned in web/site/example-models.json.
// A model a document merely mentions, or one that appears only in the product's fallback chains, is
// NOT proof of a catalog entry and fails the build.
const exampleCatalog = JSON.parse(await readFile(new URL("example-models.json", import.meta.url), "utf8"))
const catalogModels = new Set(exampleCatalog.models)
for (const file of htmlFiles) {
  const html = await readFile(file, "utf8")
  const route = routeFromFile(file)
  for (const block of renderedBlocks(html)) {
    for (const match of block.matchAll(/"([a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9.-]*)"/g)) {
      assert(catalogModels.has(match[1]), `${route} example cites a model absent from the OpenCode V2 catalog (models.dev): ${match[1]}`)
    }
  }
}

// Legacy-path compatibility gate: the public site moved from the /oh-my-rigel/ project base path to
// the custom-domain root. GitHub Pages is static and cannot issue a server-side 301/302, so the
// verifiable compatibility is a shipped 200 document per known route that declares the root URL as
// canonical and redirects the reader. Fail-closed: a missing stub, a wrong target, an indexed stub, a
// missing fallback link, or a meta-refresh leak onto a real page all fail the build. The legacy
// prefix must never become a catch-all, so an unknown legacy path still resolves to 404.html.
const contentRoutes = routeManifest.routes.filter((route) => route !== "/404.html")
assert(Array.isArray(routeManifest.legacyRedirects), "route-manifest must record the legacy redirect set")
assert(routeManifest.legacyRedirects.length === contentRoutes.length, `legacy redirects must cover every content route (${routeManifest.legacyRedirects.length} vs ${contentRoutes.length})`)
assert(legacyFiles.length === contentRoutes.length, `legacy redirect stubs must cover every content route (${legacyFiles.length} vs ${contentRoutes.length})`)
for (const route of contentRoutes) {
  const legacyRoute = `${LEGACY_PREFIX.slice(0, -1)}${route}`
  const target = absoluteUrl(route)
  const record = routeManifest.legacyRedirects.find((entry) => entry.from === legacyRoute)
  assert(record && record.to === target, `legacy redirect manifest entry missing or wrong for ${legacyRoute}`)
  const stub = await readFile(join(outPath, legacyRoute.slice(1), "index.html"), "utf8")
  assert(stub.includes(`<meta http-equiv="refresh" content="0; url=${target}">`), `${legacyRoute} must redirect to ${target}`)
  assert(stub.includes(`rel="canonical" href="${target}"`), `${legacyRoute} canonical must be ${target}`)
  assert(stub.includes('name="robots" content="noindex"'), `${legacyRoute} must be noindex`)
  assert(stub.includes(`href="${target}"`), `${legacyRoute} must carry a visible fallback link to ${target}`)
}
assert(!existsSync(join(outPath, "oh-my-rigel", "does-not-exist", "index.html")), "the legacy prefix must not fabricate redirects for unknown routes")
for (const file of htmlFiles) {
  assert(!/http-equiv=["']refresh/i.test(await readFile(file, "utf8")), `${routeFromFile(file)} must not carry a meta refresh (the exception is scoped to the legacy stubs)`)
}

console.log(`PASS web/site/check.mjs (${htmlFiles.length} HTML files, ${legacyFiles.length} legacy redirects, ${routes.length} routes, ${seenExternal.size} external URLs)`)
