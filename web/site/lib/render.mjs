import { absoluteUrl, publicPath, SITE } from "./config.mjs"

const LANGS = ["es", "en"]

const STAR_SVG = `<svg class="star" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><polygon fill="currentColor" points="32.00,6.50 33.76,25.25 40.49,21.02 36.25,27.74 55.00,29.50 36.25,31.26 40.49,37.98 33.76,33.75 32.00,52.50 30.24,33.75 23.51,37.98 27.75,31.26 9.00,29.50 27.75,27.74 23.51,21.02 30.24,25.25"/><circle fill="currentColor" cx="14.61" cy="46.89" r="3.5"/></svg>`

export const GITHUB_URL = "https://github.com/GaboEI/oh-my-rigel/tree/v2-mirror"
export const GITHUB_ISSUES_URL = "https://github.com/GaboEI/oh-my-rigel/issues"
const GITHUB_SVG = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`

// Two-sheets "copy" glyph, a check glyph and an error X. The check is hidden until the button
// carries `is-done` and the X until it carries `is-error`; all three are decorative
// (aria-hidden) because the button has an accessible name and a live status region.
const COPY_ICON = `<svg class="copy__icon copy__icon--copy" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.4" d="M5.7 5.7V2.4A1.4 1.4 0 0 1 7.1 1h6.5A1.4 1.4 0 0 1 15 2.4v6.5a1.4 1.4 0 0 1-1.4 1.4h-3.3"/><rect fill="none" stroke="currentColor" stroke-width="1.4" x="1" y="5.7" width="9.3" height="9.3" rx="1.4"/></svg>`
const CHECK_ICON = `<svg class="copy__icon copy__icon--done" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M2.6 8.6 6.4 12.4 13.4 4"/></svg>`
const ERROR_ICON = `<svg class="copy__icon copy__icon--error" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4.4 4.4 11.6 11.6M11.6 4.4 4.4 11.6"/></svg>`
const MENU_SVG = `<svg class="nav-toggle__icon nav-toggle__icon--menu" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M2 4h12M2 8h12M2 12h12"/></svg>`
const CLOSE_SVG = `<svg class="nav-toggle__icon nav-toggle__icon--close" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M3.6 3.6 12.4 12.4M12.4 3.6 3.6 12.4"/></svg>`
const SUN_SVG = `<svg class="theme-picker__icon--light" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4.1" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M12 2.7v2.5M12 18.8v2.5M2.7 12h2.5M18.8 12h2.5M5.4 5.4l1.8 1.8M16.8 16.8l1.8 1.8M18.6 5.4l-1.8 1.8M7.2 16.8l-1.8 1.8"/></svg>`
const MOON_SVG = `<svg class="theme-picker__icon--dark" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M20.2 14.6A8.6 8.6 0 1 1 9.6 3.8a6.9 6.9 0 0 0 10.6 10.8z"/></svg>`
const SYSTEM_SVG = `<svg class="theme-picker__icon--system" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.1" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="currentColor" d="M12 3.9a8.1 8.1 0 0 1 0 16.2z"/></svg>`
const CARET_SVG = `<svg class="theme-picker__caret" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M2.5 4.5 6 8l3.5-3.5"/></svg>`

// Pre-paint theme init. It runs in <head> before the stylesheet, so a saved Claro/Oscuro choice
// is applied before first paint (no flash of the wrong theme). Static and identical on every page,
// read once from localStorage inside try/catch (storage may be denied); an absent attribute means
// Sistema. Kept as a constant so check.mjs can pin the exact text and a CSP can allow it by sha256.
export const THEME_INIT = `(function(){try{var v=localStorage.getItem("omr-theme");if(v==="light"||v==="dark"){document.documentElement.setAttribute("data-theme",v)}}catch(e){}})()`

// The theme control's user-facing copy, single-sourced so the renderer, the gate (check.mjs) and
// the suite (theme.test.ts) agree on the ES/EN labels instead of restating them.
export const THEME_COPY = {
  es: { system: "Sistema", light: "Claro", dark: "Oscuro", options: "Sistema, claro u oscuro" },
  en: { system: "System", light: "Light", dark: "Dark", options: "System, light or dark" },
}

// Canonical agent-first install prompt published in OH-MY-RIGEL.md ("Install and run the V2
// preview" -> "Agent-first route"). Kept in ENGLISH so the ES and EN pages are byte-identical.
// It contains no double quote, so the copy button `data-copy` carries it byte-for-byte.
export const AGENT_PROMPT = `Install and run the Oh My Rigel V2 developer preview from its public source.

Safety requirements:
- Inspect the checkout, AGENTS.md files, repository rules, README.md,
  OH-MY-RIGEL.md, FORK.md, CONTRIBUTING.md, script/agent/setup.sh,
  profiles/gabo/validate-profile.mjs, profiles/gabo/apply-v2-agent-layer.mjs,
  profiles/gabo/switch-live-plugin-to-native-v2.mjs, and
  profiles/gabo/materialize-v2-skills.mjs before changing anything.
- Rigel targets OpenCode V2 only. Detect the installed OpenCode version and
  stop unless it is V2. If OpenCode must be updated, use the current official
  OpenCode installation method and verify the resulting version.
- Confirm that no OpenCode process is running and that this installation will
  not reuse an active V1 installation. Do not create a parallel V1/V2 setup.
- Discover the actual OpenCode V2 config, data, state, cache, plugin, skills,
  and goal-state paths on this machine. Do not assume paths, services,
  credentials, or package managers. Stop and ask for help if ownership or
  isolation is uncertain.
- Never print, copy, or commit credentials or private configuration.

Scope note:
- The Oh My Rigel V2 runtime is the OmO functionality ported to OpenCode V2 and
  confirmed on V2; that ported set is complete.
- The installation additionally includes an external BETA layer of agents
  (including a Judge) and skills from profiles/gabo, which is being polished.
  Keep that extra layer distinct from the confirmed OmO set.

Installation requirements:
1. Use the v2-mirror branch of https://github.com/GaboEI/oh-my-rigel.
2. From the checkout root, run script/agent/setup.sh to verify tools, install
   dependencies, and build.
3. From the checkout root, run node profiles/gabo/validate-profile.mjs.
4. Set RIGEL_V2_HOME to the confirmed V2 home, RIGEL_V2_CONFIG to the absolute
   path of the active V2 JSON config, and RIGEL_V2_USER_ROOT to a dedicated
   Rigel state directory. The variable name RIGEL_V2_LAB_ROOT is a historical
   spelling of that state directory: do not create or require a laboratory or
   service.
5. With those explicit variables, from the checkout root run the user lifecycle
   installer: node profiles/gabo/rigel-v2-user-install.mjs install --version 1.
   It materializes the native runtime and generated agent manifest, exposes the
   V2 skills, and registers the runtime in the selected V2 config. It refuses
   any path that resolves under a V1 root and never launches OpenCode.
6. Verify that the V2 config registers the generated Rigel runtime, launch the
   normal OpenCode V2 command, and confirm that Rigel reports its native V2
   runtime as active. Do not claim unavailable features.

Constraints:
- Do not remove OpenCode V1, the host program, and do not run any destructive
  action without explicit approval from the operator: first report what you
  would do and wait.
- Preserve unrelated and foreign configuration, plugins, skills, and state.
  Only Rigel-owned entries and state may be created, changed, or removed.
- Do not invent commands. Use only the commands in this prompt and the
  canonical guide. If a step is unclear, stop and ask.

Report the detected OpenCode version, resolved non-secret paths, commands run,
checks passed, and remaining limitations. If any safety condition cannot be
demonstrated, do not install or launch anything; explain the blocker and ask
for help.`

// Guide intro. A universal "every agent has a model and a chain" is only true when every guide
// agent declares both; the beta Judge declares neither, so the scoped wording is the one that
// renders. The choice is driven by the data (guideModelScope), never by the copy.
export const GUIDE_LEAD = {
  es: {
    all: "Un agente es un rol con instrucciones propias (planificar, investigar, revisar, etcétera). Un modelo es el motor de IA que ejecuta ese rol. Cada agente tiene un modelo por defecto y una cadena de respaldo.",
    inventory: "Un agente es un rol con instrucciones propias (planificar, investigar, revisar, etcétera). Un modelo es el motor de IA que ejecuta ese rol. Los agentes OmO del inventario llevan un modelo por defecto y una cadena de respaldo cuando se declaran; si el primero no está disponible, se prueba el siguiente. Cuando un agente no declara modelo ni cadena (por ejemplo, el Juez de la capa beta), su ficha lo indica.",
  },
  en: {
    all: "An agent is a role with its own instructions (plan, research, review, and so on). A model is the AI engine that runs that role. Every agent has a default model and a fallback chain.",
    inventory: "An agent is a role with its own instructions (plan, research, review, and so on). A model is the AI engine that runs that role. The OmO agents in this inventory carry a default model and a fallback chain when they are declared; if the first is unavailable, the next is tried. When an agent declares no model or chain (for example, the beta-layer Judge), its card says so.",
  },
}

// Editorial vocabulary for the agent default model: a derived reading of the W2 `reason` field,
// never a historical justification. `reason` is machine-derived in agents.json (`reasonDerived`).
const REASON_LABEL = {
  es: { capacidad: "capacidad", razonamiento: "razonamiento", rapidez: "rapidez", coste: "coste", vision: "visión", investigacion: "investigación", escritura: "escritura" },
  en: { capacidad: "capability", razonamiento: "reasoning", rapidez: "speed", coste: "cost", vision: "vision", investigacion: "research", escritura: "writing" },
}

// Verified example from docs/reference/configuration.md (Quick Start). Byte-identical ES/EN; it
// uses only real provider/model ids and no personal configuration or secrets.
export const MODEL_OVERRIDE_EXAMPLE = `// ~/.omo/omo.jsonc
{
  "[opencode]": {
    "agents": {
      "librarian": { "model": "google/gemini-3.6-flash" },
      "oracle": { "model": "anthropic/claude-opus-5-5", "reasoning": "max" }
    }
  }
}`

// Primary-model example for the OpenCode config file. Uses the verified V2 top-level `model`
// field and the official schema URL, with no personal data. Source: opencode.ai/v2/docs/config.
const OPENCODE_MODEL_EXAMPLE = `{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-5"
}`

// Model ids used by the copyable examples above are pinned to OpenCode V2's authoritative catalog
// (models.dev, per opencode.ai/v2/docs/providers) in web/site/example-models.json. check.mjs fails
// when a copyable example cites a model absent from that catalog snapshot. The product's fallback
// chains are a separate surface and are never treated as a model catalog.

const UI = {
  es: {
    name: "Español",
    short: "ES",
    skip: "Saltar al contenido",
    navLabel: "Navegación principal",
    menu: "Menú",
    langLabel: "Selector de idioma",
    activeLang: "idioma actual",
    onThisPage: "En esta página",
    home: "inicio",
    benefits: "Catálogo",
    relationship: "Proyecto",
    install: "Instalar",
    configure: "Configurar",
    catalog: "Catálogo",
    agents: "Agentes y modelos",
    problems: "Ayuda",
    footerLabel: "Enlaces",
    modelGuide: "Guía de modelos",
    stateActive: "Activo",
    stateDisabled: "Desactivado",
    stateConditional: "Condicional",
    activation: "Activación",
    helps: "Cuándo sirve",
    usage: "Cómo se usa",
    requirements: "Requisitos",
    defaults: "Valores por defecto",
    commands: "Comandos",
    skills: "Skills",
    settings: "Ajustes",
    installTitle: "Instalar",
    configureTitle: "Configuración básica",
    relationshipTitle: "Relación con Oh My OpenCode",
    lead: "Un fork comunitario de Oh My OpenCode (OmO) que lleva sus funciones al runtime de OpenCode\u00A0V2.",
    installLead: "Instala desde la ruta fuente del repositorio.",
    betaNote: "La funcionalidad de OmO en OpenCode V2 está completa y confirmada. La instalación añade además una capa externa BETA de agentes (incluido un Juez) y skills del perfil, que se pulirá más adelante.",
    configureLead: "La configuración es declarativa y por capas.",
    agentsSkillsCommands: "Recursos",
    agentsBody: "Agentes: el equipo que planifica, delega y ejecuta tareas. Los agentes OmO del inventario llevan un modelo por defecto y una cadena de respaldo (fallback) cuando se declaran; ese es el detalle de qué IA los ejecuta.",
    skillsBody: "Skill: instrucciones especializadas que amplían cómo trabaja el agente en tareas concretas, sin cambiar el núcleo del producto.",
    commandsBody: "Comandos: acciones invocables para flujos concretos; se ejecutan cuando los necesitas. Cada ficha de la guía detalla qué hace y qué toca.",
    modelsGuideLink: "Ver guía de modelos, skills y comandos",
    relationshipBody: "Oh My OpenCode (OmO) es el proyecto padre. Oh My Rigel (OMR) es un fork comunitario que migra las funciones de OmO al runtime de OpenCode V2. OpenCode es el programa anfitrión y se mantiene aparte de OMR. La instalación añade además una capa extra en beta, separada en su propio perfil, que se pulirá más adelante. OMR conserva la atribución al proyecto padre.",
    attribution: "Atribución al proyecto padre: Oh My OpenCode.",
    migrationNote: "¿Instalas OpenCode V2 por primera vez? La guía oficial exige retirar OpenCode V1 y sus restos antes de una instalación limpia de V2. OpenCode V1/V2 (el programa anfitrión) y Oh My Rigel V1/V2 (este plugin) son cosas distintas.",
    migrationDoc: "https://opencode.ai/v2/docs/migrate-v1/",
    migrationDocLabel: "Guía de migración de OpenCode",
    githubLabel: "Repositorio en GitHub (rama v2-mirror)",
    copy: "Copiar",
    copied: "Copiado",
    copyError: "Error al copiar",
    lifecycle: "Ciclo de vida",
    lifecycleTitle: "Ciclo de vida del plugin",
    lifecycleLead: "Verifica el estado, reinstala, actualiza, revierte o desinstala Oh My Rigel sin tocar OpenCode V2 ni plugins ajenos.",
    lifecyclePreserveNote: "La desinstalación quita solo las entradas y skills de Oh My Rigel; conserva OpenCode V2, tu configuración y otros plugins.",
    lifecycleHostNote: "No confundir con la retirada de OpenCode V1 (el anfitrión) para migrar a V2.",
    noticeParentSetupPre: "El comando ",
    noticeParentSetupPost: " configura el producto padre Oh My OpenCode, no Oh My Rigel.",
    noticeRigelSetupPre: "",
    noticeRigelSetupPost: " todavía no existe.",
    routeAgentTitle: "Instalar con un agente",
    routeAgentLead: "Copia este prompt y pégalo en un agente (Codex, OpenCode V2 u otro). Está escrito en inglés a propósito y es idéntico en las páginas ES y EN. El agente sigue la guía canónica.",
    routeAgentNote: "Copiar no ejecuta nada. Revisa el plan del agente antes de que actúe.",
    routeManualTitle: "Instalación manual",
    routeManualLead: "Ejecuta estos comandos tú mismo, en orden, desde un shell POSIX. Sustituye la ruta de ejemplo por la ruta real de tu configuración de OpenCode V2.",
    cwdLabel: "Directorio de trabajo",
    cwdAny: "cualquier directorio",
    cwdParent: "el directorio donde quieras el checkout",
    cwdCheckout: "la raíz del checkout (oh-my-rigel)",
    mStep1: "Instala o actualiza OpenCode V2",
    mStep1Text: "Usa el método oficial de instalación de OpenCode V2, confirma que la versión es V2 y cierra todos los procesos de OpenCode antes de continuar.",
    mStep2: "Clona la rama v2-mirror",
    mStep2Text: "Clona el repositorio público y entra en el checkout.",
    mStep3: "Prepara el checkout",
    mStep3Text: "Verifica las herramientas, instala dependencias, compila y valida el perfil.",
    mStep4: "Indica tus rutas de OpenCode V2",
    mStep4Text: "Exporta la home V2, la ruta absoluta de tu configuración JSON V2 y un directorio de estado dedicado para Rigel; comprueba que el archivo existe.",
    mStep5: "Instala el runtime nativo y arranca",
    mStep5Text: "Instala el runtime nativo V2 y después inicia OpenCode con normalidad.",
    copyCommand: "el comando",
    copyAgent: "el prompt para agentes",
    lifecycleCommandsTitle: "Comandos del ciclo de vida",
    lifecycleCommandsNote: "Se ejecutan desde la raíz del checkout. Son las operaciones reales del instalador; ninguna elimina OpenCode V2 ni plugins ajenos.",
    lifecycleEnvNote: "Estos comandos usan las mismas variables que verificaste en Instalar (RIGEL_V2_HOME, RIGEL_V2_CONFIG y RIGEL_V2_USER_ROOT). Si abres un shell nuevo, vuelve a exportarlas antes de ejecutarlos.",
    lifecycleCmdStatus: "Estado y salud",
    lifecycleCmdInstall: "Reinstalación idempotente",
    lifecycleCmdUpgrade: "Transición de versión y migración de estado",
    lifecycleCmdRollback: "Reversión byte a byte a la versión previa",
    lifecycleCmdUninstall: "Desinstalación: quita solo el estado de Rigel",
    helpTitle: "Ayuda",
    helpBody: "Si algo falla: comprueba el estado con el comando de ciclo de vida mostrado arriba, revisa la versión y las rutas de OpenCode (el anfitrión) y sigue la guía del repositorio. No compartas claves ni credenciales en ningún informe.",
    helpIssues: "Incidencias en GitHub (rama v2-mirror)",
    copySetting: "la ruta de configuración",
    settingLabel: "Configuración",
    guideTitle: "Guía de modelos, skills y comandos",
    guideIntroTitle: "Cómo leer esta guía",
    guideLayerNote: "Esta guía separa dos capas. La funcionalidad de OmO portada a OpenCode V2 está completa y confirmada. La capa BETA (el agente Juez y las skills del perfil) es adicional y se pulirá más adelante.",
    guideAgentsSummary: "El equipo que planifica, delega y ejecuta. Primero los agentes primarios (dirigen el trabajo), después los secundarios (trabajan para otros agentes) y al final el Juez de la capa beta.",
    guideGroupPrimaries: "Agentes primarios",
    guideGroupSecondaries: "Agentes secundarios",
    guideGroupBeta: "Capa beta",
    guideSkillsSummary: "Instrucciones especializadas que amplían cómo trabaja el agente en tareas concretas. Primero las skills de OmO, después las de la capa beta.",
    guideSkillsOmo: "Skills de OmO",
    guideSkillsBeta: "Skills de la capa beta",
    guideCommandsSummary: "Acciones invocables. Los comandos `rigel-v2` de esta lista son el registro del laboratorio: se materializan solo en el despliegue de laboratorio y no son un bin publicado. La ruta pública es el instalador de ciclo de vida `rigel-v2-user-install.mjs` (install, upgrade, rollback, uninstall, status). Se muestran además la CLI del producto padre y los comandos de barra del chat.",
    guideSurfaceRigel: "Registro de laboratorio (rigel-v2)",
    guideSurfaceOmo: "CLI del producto padre (omo)",
    guideSurfaceSlash: "Comandos de barra (chat)",
    guideFunction: "Función",
    guideWhenToUse: "Cuándo usarlo",
    guideUsage: "Uso",
    guideWhatItDoes: "Qué hace",
    guideWhatItTouches: "Qué toca",
    guideDefaultModel: "Modelo por defecto",
    guideChain: "Cadena de respaldo",
    guideProviders: "Proveedores",
    guideAliases: "Alias",
    guideNoChain: "Sin cadena declarada en model-core (capa beta).",
    guideProvenanceOmo: "OmO",
    guideProvenanceBeta: "beta",
    noneDeclared: "ninguno declarado",
    defaultsTitle: "Modelos por agente (por defecto)",
    defaultsLead: "Cada agente OmO del inventario lleva un modelo por defecto y una cadena de respaldo. Esta lista muestra el modelo real y una lectura breve de por qué, según su rol y las capacidades, el coste y la disponibilidad que prioriza. El Juez de la capa beta no declara modelo ni cadena.",
    defaultsDerived: "Editorial (derivado)",
    defaultsDocumented: "Documentado (código)",
    defaultsPrioritizes: "Prioriza",
    defaultsFirstRung: "Base: primer peldaño de su cadena en model-core.",
    defaultsProviderGate: "Disponibilidad: requiere un proveedor conectado",
    defaultsBetaNoModel: "La capa beta no declara modelo ni cadena en model-core; no se le asigna ninguno.",
    defaultsChangeTitle: "Cómo cambiar el modelo de un agente",
    defaultsChangeLead: "Edita la configuración unificada en ~/.omo/omo.jsonc (o el archivo del proyecto .omo/omo.jsonc) y añade el agente bajo el bloque [opencode]. El campo model fija el modelo principal; el campo models define la cadena ordenada (el primero es el principal y el resto, respaldos).",
    defaultsEffects: "Un override gana sobre el valor por defecto. Si fijas solo model, el proveedor debe estar conectado (por ejemplo con /login o el flujo de autenticación); si quieres conservar respaldos, usa models con tu propio orden. Hephaestus sigue exigiendo un proveedor GPT compatible.",
    defaultsAgentsLink: "Ver las fichas de agente",
    agentConfigTitle: "Configuración de agentes",
    agentConfigLead: "Revisa el modelo por defecto de cada agente (el Juez de la capa beta no declara ninguno), los criterios de elección y cómo cambiar el modelo de un agente en la guía detallada.",
    agentConfigLink: "Abrir la guía detallada de modelos, skills y comandos",
    whatIsTitle: "Qué es Oh My Rigel",
    whatIsLead: "Oh My Rigel es una capa de orquestación sobre OpenCode: hereda la orquestación y la delegación de Oh My OpenCode (OmO) y las lleva al runtime de plugins de OpenCode V2. OpenCode se mantiene como dependencia independiente; Rigel no es un fork ni una distribución de OpenCode.",
    whatIsValue: "A un programador le aporta planificación, delegación en especialistas, continuidad en tareas largas, herramientas integradas y un flujo más eficaz. Merece la pena si ya trabajas con OpenCode y quieres ese flujo de agentes sin cambiar de host: un asistente único no reparte el trabajo ni conserva el contexto entre sesiones.",
    whatIsReason: "Motivo verificable de su creación: llevar el conjunto de funciones de OmO a OpenCode V2 sin recortar superficies (agentes, delegación, skills, permisos, herramientas, contexto y continuidad); la compatibilidad funcional va primero y las mejoras propias llegan después. La funcionalidad de OmO portada a V2 está confirmada; la capa beta adicional (el Juez y las skills del perfil) se pule aparte.",
  },
  en: {
    name: "English",
    short: "EN",
    skip: "Skip to content",
    navLabel: "Main navigation",
    menu: "Menu",
    langLabel: "Language selector",
    activeLang: "current language",
    onThisPage: "On this page",
    home: "home",
    benefits: "Catalogue",
    relationship: "Project",
    install: "Install",
    configure: "Configure",
    catalog: "Catalog",
    agents: "Agents and models",
    problems: "Help",
    footerLabel: "Links",
    modelGuide: "Model guide",
    stateActive: "Active",
    stateDisabled: "Disabled",
    stateConditional: "Conditional",
    activation: "Activation",
    helps: "When it helps",
    usage: "How to use it",
    requirements: "Requirements",
    defaults: "Defaults",
    commands: "Commands",
    skills: "Skills",
    settings: "Settings",
    installTitle: "Install",
    configureTitle: "Basic configuration",
    relationshipTitle: "Relationship with Oh My OpenCode",
    lead: "A community fork of Oh My OpenCode (OmO) that brings its feature set to the OpenCode\u00A0V2 runtime.",
    installLead: "Install from the repository source route.",
    betaNote: "The OmO functionality on OpenCode V2 is complete and confirmed. The installation additionally includes an external BETA layer of agents (including a Judge) and skills from the profile, to be polished later.",
    configureLead: "Configuration is declarative and layered.",
    agentsSkillsCommands: "Resources",
    agentsBody: "Agents: the team that plans, delegates and runs tasks. The OmO agents in the inventory carry a default model and a fallback chain when they are declared; that is the detail of which AI runs them.",
    skillsBody: "Skills: specialized instructions that extend how the agent works on specific tasks, without changing the product's core.",
    commandsBody: "Commands: invocable actions for concrete flows; you run them when you need them. Each guide card details what it does and what it touches.",
    modelsGuideLink: "Open the models, skills and commands guide",
    relationshipBody: "Oh My OpenCode (OmO) is the parent project. Oh My Rigel (OMR) is a community fork that migrates the OmO feature set to the OpenCode V2 runtime. OpenCode is the host program and stays separate from OMR. The installation also adds an extra beta layer, kept apart in its own profile, to be polished later. OMR keeps attribution to the parent project.",
    attribution: "Parent-project attribution: Oh My OpenCode.",
    migrationNote: "Installing OpenCode V2 for the first time? The official guide requires removing OpenCode V1 and its remnants before a clean V2 install. OpenCode V1/V2 (the host program) and Oh My Rigel V1/V2 (this plugin) are distinct.",
    migrationDoc: "https://opencode.ai/v2/docs/migrate-v1/",
    migrationDocLabel: "OpenCode migration guide",
    githubLabel: "Repository on GitHub (v2-mirror branch)",
    copy: "Copy",
    copied: "Copied",
    copyError: "Copy failed",
    lifecycle: "Lifecycle",
    lifecycleTitle: "Plugin lifecycle",
    lifecycleLead: "Check status, reinstall, update, roll back or uninstall Oh My Rigel without touching OpenCode V2 or unrelated plugins.",
    lifecyclePreserveNote: "Uninstall removes only the Oh My Rigel entries and skills; it preserves OpenCode V2, your configuration and other plugins.",
    lifecycleHostNote: "Not to be confused with removing OpenCode V1 (the host) to migrate to V2.",
    noticeParentSetupPre: "The ",
    noticeParentSetupPost: " command configures the parent Oh My OpenCode product, not Oh My Rigel.",
    noticeRigelSetupPre: "",
    noticeRigelSetupPost: " does not exist yet.",
    routeAgentTitle: "Install with an agent",
    routeAgentLead: "Copy this prompt and paste it into an agent (Codex, OpenCode V2 or another). It is written in English on purpose and is identical on the ES and EN pages. The agent follows the canonical guide.",
    routeAgentNote: "Copying does not run anything. Review the agent's plan before it acts.",
    routeManualTitle: "Manual installation",
    routeManualLead: "Run these commands yourself, in order, from a POSIX shell. Substitute the example path with the real path of your OpenCode V2 config.",
    cwdLabel: "Working directory",
    cwdAny: "any directory",
    cwdParent: "the directory where you want the checkout",
    cwdCheckout: "the checkout root (oh-my-rigel)",
    mStep1: "Install or update OpenCode V2",
    mStep1Text: "Use the official OpenCode V2 installation method, confirm the version is V2, and close every OpenCode process before continuing.",
    mStep2: "Clone the v2-mirror branch",
    mStep2Text: "Clone the public repository and enter the checkout.",
    mStep3: "Prepare the checkout",
    mStep3Text: "Verify the tools, install dependencies, build and validate the profile.",
    mStep4: "Provide your OpenCode V2 paths",
    mStep4Text: "Export the V2 home, the absolute path of your V2 JSON config, and a dedicated state directory for Rigel; check that the file exists.",
    mStep5: "Install the native runtime and start",
    mStep5Text: "Install the V2 native runtime, then start OpenCode normally.",
    copyCommand: "the command",
    copyAgent: "the agent prompt",
    lifecycleCommandsTitle: "Lifecycle commands",
    lifecycleCommandsNote: "Run from the checkout root. These are the installer's real operations; none removes OpenCode V2 or unrelated plugins.",
    lifecycleEnvNote: "These commands use the same variables you verified in Install (RIGEL_V2_HOME, RIGEL_V2_CONFIG and RIGEL_V2_USER_ROOT). If you open a new shell, export them again before running.",
    lifecycleCmdStatus: "Status and health",
    lifecycleCmdInstall: "Idempotent reinstall",
    lifecycleCmdUpgrade: "Version transition and state migration",
    lifecycleCmdRollback: "Byte-identical revert to the previous version",
    lifecycleCmdUninstall: "Uninstall: removes only Rigel state",
    helpTitle: "Help",
    helpBody: "If something fails: check the status with the lifecycle command shown above, review the OpenCode (host) version and paths, and follow the repository guide. Never share keys or credentials in any report.",
    helpIssues: "GitHub issues (v2-mirror branch)",
    copySetting: "the configuration path",
    settingLabel: "Configuration",
    guideTitle: "Models, skills and commands guide",
    guideIntroTitle: "How to read this guide",
    guideLayerNote: "This guide separates two layers. The OmO functionality ported to OpenCode V2 is complete and confirmed. The BETA layer (the Judge agent and the profile skills) is additional and will be polished later.",
    guideAgentsSummary: "The team that plans, delegates and runs work. Primary agents (they direct the work) come first, then secondary agents (they work for other agents) and finally the Judge from the beta layer.",
    guideGroupPrimaries: "Primary agents",
    guideGroupSecondaries: "Secondary agents",
    guideGroupBeta: "Beta layer",
    guideSkillsSummary: "Specialized instructions that extend how the agent works on specific tasks. OmO skills first, then the beta layer.",
    guideSkillsOmo: "OmO skills",
    guideSkillsBeta: "Beta layer skills",
    guideCommandsSummary: "Invocable actions. The `rigel-v2` commands in this list are the laboratory registry: they are materialized only into the lab deployment and are not a published bin. The public route is the lifecycle installer `rigel-v2-user-install.mjs` (install, upgrade, rollback, uninstall, status). The parent product CLI and the in-chat slash commands are shown as well.",
    guideSurfaceRigel: "Laboratory registry (rigel-v2)",
    guideSurfaceOmo: "Parent product CLI (omo)",
    guideSurfaceSlash: "Slash commands (chat)",
    guideFunction: "Function",
    guideWhenToUse: "When to use it",
    guideUsage: "Usage",
    guideWhatItDoes: "What it does",
    guideWhatItTouches: "What it touches",
    guideDefaultModel: "Default model",
    guideChain: "Fallback chain",
    guideProviders: "Providers",
    guideAliases: "Aliases",
    guideNoChain: "No chain declared in model-core (beta layer).",
    guideProvenanceOmo: "OmO",
    guideProvenanceBeta: "beta",
    noneDeclared: "none declared",
    defaultsTitle: "Default model per agent",
    defaultsLead: "Every OmO agent in the inventory has a default model and a fallback chain. This list shows the real model and a short reading of why, by its role and the capabilities, cost and availability it favours. The beta-layer Judge declares no model or chain.",
    defaultsDerived: "Editorial (derived)",
    defaultsDocumented: "Documented (code)",
    defaultsPrioritizes: "Favours",
    defaultsFirstRung: "Basis: first rung of its chain in model-core.",
    defaultsProviderGate: "Availability: requires a connected provider",
    defaultsBetaNoModel: "The beta layer declares no model or chain in model-core; none is assigned to it.",
    defaultsChangeTitle: "How to change an agent's model",
    defaultsChangeLead: "Edit the unified configuration at ~/.omo/omo.jsonc (or the project file .omo/omo.jsonc) and add the agent under the [opencode] block. The model field pins the primary model; the models field sets the ordered chain (the first is primary, the rest are fallbacks).",
    defaultsEffects: "An override wins over the default. If you set only model, the provider must be connected (for example via /login or the auth flow); if you want to keep fallbacks, use models with your own order. Hephaestus still requires a compatible GPT provider.",
    defaultsAgentsLink: "See the agent cards",
    agentConfigTitle: "Agent configuration",
    agentConfigLead: "See each agent's default model (the beta-layer Judge declares none), the selection criteria and how to change an agent's model in the detailed guide.",
    agentConfigLink: "Open the detailed models, skills and commands guide",
    whatIsTitle: "What Oh My Rigel is",
    whatIsLead: "Oh My Rigel is an orchestration layer over OpenCode: it inherits the orchestration and delegation of Oh My OpenCode (OmO) and brings them to the OpenCode V2 plugin runtime. OpenCode stays an independent dependency; Rigel is not a fork or a distribution of OpenCode.",
    whatIsValue: "For a programmer it brings planning, delegation to specialists, continuity across long tasks, integrated tools and a more efficient workflow. It is worth it if you already work with OpenCode and want that agent workflow without changing host: a single assistant does not split the work or keep context across sessions.",
    whatIsReason: "Verifiable reason it exists: to bring the OmO feature set to OpenCode V2 without dropping surfaces (agents, delegation, skills, permissions, tools, context and continuity); functional compatibility comes first and fork-specific improvements come after. The OmO functionality ported to V2 is confirmed; the additional beta layer (the Judge and the profile skills) is polished separately.",
  },
}

// Anchors into the single-page cover (quick access), not separate top-level pages. The third
// element maps an item to the route section it represents, so the active state is derived from
// the real path (including nested routes) instead of a hardcoded first item.
const NAV = [
  ["benefits", "#benefits", "catalog"],
  ["relationship", "#relationship", null],
  ["install", "#install", null],
  ["configure", "#configure", null],
  ["agentsSkillsCommands", "#agentes-skill-comandos", "agents"],
  ["lifecycle", "#lifecycle", null],
]

// User-facing state vocabulary. Migration state ("v2") is never shown in the UI.
const STATE_LABEL = {
  es: { activada: "Activo", desactivada: "Desactivado", condicionada: "Condicional" },
  en: { activada: "Active", desactivada: "Disabled", condicionada: "Conditional" },
}

// Agent category vocabulary. `mode` is the real field the product declares; it is shown
// as "primario"/"secundario"/"mixto" and is never conflated with a model or a capability.
const MODE_LABEL = {
  es: { primary: "primario", subagent: "secundario", all: "mixto" },
  en: { primary: "primary", subagent: "secondary", all: "mixed" },
}

export function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function attr(value) {
  return htmlEscape(value)
}

export function stateLabel(lang, estado) {
  return STATE_LABEL[lang]?.[estado] ?? htmlEscape(estado)
}

function stripLang(logicalPath) {
  return logicalPath.replace(/^\/(es|en)(?=\/|$)/, "") || "/"
}

export function langLogicalPath(lang, pathWithoutLang) {
  const suffix = pathWithoutLang === "/" ? "/" : pathWithoutLang
  return `/${lang}${suffix}`.replace(/\/+/g, "/")
}

function anchorPath(lang, hash) {
  return `${publicPath(langLogicalPath(lang, "/"))}${hash}`
}

function sectionFor(pathWithoutLang) {
  if (pathWithoutLang.startsWith("/catalogo/")) return "catalog"
  if (pathWithoutLang.startsWith("/agentes-y-modelos/")) return "agents"
  if (pathWithoutLang.startsWith("/problemas/")) return "problems"
  return "home"
}

function languageSelector(lang, logicalPath) {
  const t = UI[lang]
  const currentRest = stripLang(logicalPath)
  const item = (code) => {
    const current = code === lang
    const href = publicPath(langLogicalPath(code, currentRest))
    return `<li role="none"><a class="lang-picker__option${current ? " is-active" : ""}" href="${attr(href)}" lang="${code}" hreflang="${code}" aria-label="${attr(UI[code].name)}"${current ? ' aria-current="true"' : ""}>${htmlEscape(UI[code].name)}${current ? ` <span class="visually-hidden">(${htmlEscape(t.activeLang)})</span>` : ""}</a></li>`
  }
  return `<div class="lang-picker" data-lang-picker>
    <button class="lang-picker__button" type="button" data-lang-menu-button aria-haspopup="true" aria-expanded="false" aria-controls="lang-menu" aria-label="${attr(t.langLabel)}">${htmlEscape(UI[lang].short)}</button>
    <ul class="lang-picker__menu" id="lang-menu" data-lang-menu hidden>${LANGS.map(item).join("")}</ul>
  </div>`
}

function themePicker(lang) {
  const t = THEME_COPY[lang]
  const option = (value, text) => `<li role="none"><button class="theme-picker__option" type="button" data-theme-option="${value}" aria-pressed="false">${htmlEscape(text)}</button></li>`
  return `<div class="theme-picker" data-theme-switch>
    <button class="theme-picker__button" type="button" data-theme-menu-button aria-haspopup="true" aria-expanded="false" aria-controls="theme-menu" aria-label="${attr(t.options)}">
      <span class="theme-picker__icon" aria-hidden="true">${SUN_SVG}${MOON_SVG}${SYSTEM_SVG}</span>${CARET_SVG}
    </button>
    <ul class="theme-picker__menu" id="theme-menu" data-theme-menu hidden>${option("system", t.system)}${option("light", t.light)}${option("dark", t.dark)}</ul>
  </div>`
}

function siteHeader(lang, logicalPath) {
  const t = UI[lang]
  const currentSection = sectionFor(stripLang(logicalPath))
  return `<header class="site-header">
    <a class="skip-link" href="#main">${t.skip}</a>
    <div class="site-header__inner">
      <a class="brand" href="${attr(publicPath(langLogicalPath(lang, "/")))}" aria-label="Oh My Rigel (${t.home})">
        <span class="brand__mark" aria-hidden="true">${STAR_SVG}</span><span class="brand__name">OMR</span>
      </a>
      <nav class="top-nav" id="site-nav" aria-label="${attr(t.navLabel)}">
        ${NAV.map(([key, hash, section]) => {
          const active = section !== null && section === currentSection
          return `<a href="${attr(anchorPath(lang, hash))}"${active ? ' class="is-active" aria-current="page"' : ""}>${t[key]}</a>`
        }).join("\n")}
        <a class="github-link" href="${GITHUB_URL}" aria-label="${attr(t.githubLabel)}" rel="external noopener">${GITHUB_SVG}<span>GitHub</span></a>
      </nav>
      <div class="header-actions">
        ${themePicker(lang)}
        ${languageSelector(lang, logicalPath)}
        <a class="github-link" href="${GITHUB_URL}" aria-label="${attr(UI[lang].githubLabel)}" rel="external noopener">${GITHUB_SVG}</a>
      </div>
      <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav" aria-label="${attr(t.menu)}">${MENU_SVG}${CLOSE_SVG}</button>
    </div>
  </header>`
}

function breadcrumbs(lang, logicalPath, items = []) {
  if (stripLang(logicalPath) === "/") return ""
  const t = UI[lang]
  const trail = [[t.home ?? "Oh My Rigel", publicPath(langLogicalPath(lang, "/"))], ...items]
  return `<nav class="breadcrumbs" aria-label="Breadcrumb">
    <ol itemscope itemtype="https://schema.org/BreadcrumbList">
      ${trail.map(([label, href], index) => {
        const isLast = index === trail.length - 1
        return `<li itemprop="itemListElement" itemscope itemtype="https://schema.org/ListItem">
          ${isLast || !href ? `<span itemprop="name">${htmlEscape(label)}</span>` : `<a itemprop="item" href="${attr(href)}"><span itemprop="name">${htmlEscape(label)}</span></a>`}
          <meta itemprop="position" content="${index + 1}">
        </li>`
      }).join("\n")}
    </ol>
  </nav>`
}

function pageHead({ lang, logicalPath, title, description }) {
  const rest = stripLang(logicalPath)
  const other = lang === "es" ? "en" : "es"
  return `<meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(title === "Oh My Rigel" ? title : `${title} · Oh My Rigel`)}</title>
  <meta name="description" content="${attr(description)}">
  <meta name="color-scheme" content="dark light">
  <link rel="canonical" href="${attr(absoluteUrl(logicalPath))}">
  <link rel="alternate" hreflang="${lang}" href="${attr(absoluteUrl(logicalPath))}">
  <link rel="alternate" hreflang="${other}" href="${attr(absoluteUrl(langLogicalPath(other, rest)))}">
  <link rel="alternate" hreflang="x-default" href="${attr(absoluteUrl("/"))}">
  <link rel="icon" type="image/svg+xml" sizes="32x32" href="${attr(publicPath("/assets/favicon-32.svg"))}">
  <link rel="icon" type="image/svg+xml" sizes="16x16" href="${attr(publicPath("/assets/favicon-16.svg"))}">
  <link rel="preload" href="${attr(publicPath("/assets/fonts/newsreader-latin-var.woff2"))}" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="${attr(publicPath("/assets/fonts/plex-mono-400-latin.woff2"))}" as="font" type="font/woff2" crossorigin>
  <script>${THEME_INIT}</script>
  <link rel="stylesheet" href="${attr(publicPath("/assets/styles.css"))}">
  <script src="${attr(publicPath("/assets/catalog.js"))}" defer></script>`
}

function footer(lang, seal) {
  const t = UI[lang]
  return `<footer class="site-footer">
    <div class="site-footer__inner">
      <p class="site-footer__note">${htmlEscape(t.attribution)}</p>
      <nav class="footer-nav" aria-label="${attr(t.footerLabel)}">
        <a href="${attr(publicPath(langLogicalPath(lang, "/agentes-y-modelos/")))}">${htmlEscape(t.agents)}</a>
        <a href="${GITHUB_URL}" rel="external noopener">GitHub</a>
      </nav>
    </div>
    <!-- omr-internal traceability: productVersion=${htmlEscape(seal.productVersion)} dataSha256=${htmlEscape(seal.dataSha256)} baselineCommit=${htmlEscape(seal.baselineCommit)} -->
  </footer>`
}

function decorateHeadings(html) {
  return html.replace(/<(h1|h2)([^>]*)>([\s\S]*?)<\/\1>/g, (match, tag, attrs, inner) => {
    if (inner.includes("anchor-star")) return match
    const id = attrs.match(/\bid="([^"]+)"/)?.[1] ?? null
    const label = inner.replace(/<[^>]+>/g, "").trim()
    const permalink = id ? `<a class="permalink" href="#${attr(id)}" aria-label="${attr(label)}">${STAR_SVG}</a>` : ""
    return `<${tag}${attrs}><span class="anchor-star" aria-hidden="true">${STAR_SVG}</span><span class="heading__text">${inner}</span>${permalink}</${tag}>`
  })
}

export function page({ lang, logicalPath, title, description, body, crumbItems = [], seal }) {
  return decorateHeadings(`<!doctype html>
<html lang="${lang}">
<head>
  ${pageHead({ lang, logicalPath, title, description })}
</head>
<body>
  ${siteHeader(lang, logicalPath)}
  <main id="main" class="page-shell">
    ${breadcrumbs(lang, logicalPath, crumbItems)}
    ${body}
  </main>
  ${footer(lang, seal)}
</body>
</html>
`)
}

function notices(lang) {
  const t = UI[lang]
  return `<ul class="warnings">
    <li>${htmlEscape(t.noticeParentSetupPre)}<span class="command">omo setup</span>${htmlEscape(t.noticeParentSetupPost)}</li>
    <li>${htmlEscape(t.noticeRigelSetupPre)}<span class="command">rigel setup</span>${htmlEscape(t.noticeRigelSetupPost)}</li>
  </ul>`
}

function statusSummary(items, getState) {
  const totals = new Map()
  for (const item of items) totals.set(getState(item), (totals.get(getState(item)) ?? 0) + 1)
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b))
}

function statusList(lang, summary) {
  return `<dl class="summary-grid">${summary.map(([state, count]) => `<div><dt>${htmlEscape(stateLabel(lang, state))}</dt><dd>${count}</dd></div>`).join("")}</dl>`
}

// Reusable copyable block: the command/value text and a single icon share ONE bordered row
// (icon at the right end, same height, no external button, no visible label). Success swaps
// the icon to a check and announces Copiado/Copied through a live region; failure swaps it
// to an X and marks the row so the same message is visible inside the row, not colour-only.
// The exact text lives in data-copy.
function copyableBlock(lang, text, context) {
  const t = UI[lang]
  return `<div class="cmd">
    <pre class="cmd__code"><code>${htmlEscape(text)}</code></pre>
    <button class="copy" type="button" data-copy="${attr(text)}" data-copied="${attr(t.copied)}" data-error="${attr(t.copyError)}" aria-label="${attr(t.copy)}: ${attr(context)}">${COPY_ICON}${CHECK_ICON}${ERROR_ICON}</button>
    <span class="cmd__status visually-hidden" role="status" aria-live="polite"></span>
  </div>`
}

// Real commands from OH-MY-RIGEL.md ("Install and run the V2 preview"). None is invented;
// the working directory for each step is shown to the user.
const MANUAL_SETUP_COMMANDS = ["curl -fsSL https://opencode.ai/v2/install | bash", "opencode --version"]
const MANUAL_CLONE_COMMANDS = ["git clone --branch v2-mirror --single-branch https://github.com/GaboEI/oh-my-rigel.git", "cd oh-my-rigel"]
const MANUAL_PREPARE_COMMANDS = ["script/agent/setup.sh", "node profiles/gabo/validate-profile.mjs"]
const MANUAL_PATHS_COMMANDS = ["export RIGEL_V2_HOME=\"$HOME\"", "export RIGEL_V2_CONFIG=\"/absolute/path/to/the/active-v2/opencode.json\"", "export RIGEL_V2_USER_ROOT=\"${XDG_DATA_HOME:-$HOME/.local/share}/oh-my-rigel\"", "test -f \"$RIGEL_V2_CONFIG\""]
const MANUAL_INSTALL_COMMANDS = ["node profiles/gabo/rigel-v2-user-install.mjs install --version 1", "opencode"]

function installRoutes(lang) {
  const t = UI[lang]
  const steps = [
    [t.mStep1, t.mStep1Text, t.cwdAny, MANUAL_SETUP_COMMANDS],
    [t.mStep2, t.mStep2Text, t.cwdParent, MANUAL_CLONE_COMMANDS],
    [t.mStep3, t.mStep3Text, t.cwdCheckout, MANUAL_PREPARE_COMMANDS],
    [t.mStep4, t.mStep4Text, t.cwdCheckout, MANUAL_PATHS_COMMANDS],
    [t.mStep5, t.mStep5Text, t.cwdCheckout, MANUAL_INSTALL_COMMANDS],
  ]
  const agent = `<div class="install-route install-route--agent" id="install-agent">
    <h3>${htmlEscape(t.routeAgentTitle)}</h3>
    <p>${htmlEscape(t.routeAgentLead)}</p>
    <div class="agent-prompt">${copyableBlock(lang, AGENT_PROMPT, t.copyAgent)}</div>
    <p class="prompt-note">${htmlEscape(t.routeAgentNote)}</p>
  </div>`
  const manual = `<div class="install-route install-route--manual" id="install-manual">
    <h3>${htmlEscape(t.routeManualTitle)}</h3>
    <p>${htmlEscape(t.routeManualLead)}</p>
    <ol class="steps">${steps.map(([title, text, cwd, cmds]) => `<li><h4>${htmlEscape(title)}</h4><p>${htmlEscape(text)}</p><p class="cwd"><span class="cwd__label">${htmlEscape(t.cwdLabel)}</span> <code>${htmlEscape(cwd)}</code></p>${cmds.map((c) => copyableBlock(lang, c, t.copyCommand)).join("")}</li>`).join("")}</ol>
  </div>`
  return `${agent}${manual}`
}

function lifecycleCommands(lang) {
  const t = UI[lang]
  const bin = "node profiles/gabo/rigel-v2-user-install.mjs"
  const rows = [
    [t.lifecycleCmdStatus, `${bin} status`],
    [t.lifecycleCmdInstall, `${bin} install --version 1`],
    [t.lifecycleCmdUpgrade, `${bin} upgrade --version 2`],
    [t.lifecycleCmdRollback, `${bin} rollback`],
    [t.lifecycleCmdUninstall, `${bin} uninstall`],
  ]
  return `<h3>${htmlEscape(t.lifecycleCommandsTitle)}</h3>
    <p class="meta">${htmlEscape(t.lifecycleCommandsNote)}</p>
    <ol class="lifecycle-list">${rows.map(([label, cmd]) => `<li><span class="lifecycle-list__label">${htmlEscape(label)}</span>${copyableBlock(lang, cmd, label)}</li>`).join("")}</ol>
    <p class="lifecycle-env-note">${htmlEscape(t.lifecycleEnvNote)}</p>`
}

function benefits(lang) {
  const es = lang === "es"
  const head = es ? "Catálogo" : "Catalogue"
  const intro = es
    ? "Rigel lleva el conjunto de funciones de OmO a OpenCode V2. En vez de un único asistente que hace de todo, tienes un equipo pequeño que planifica, delega y conserva su propio contexto."
    : "Rigel brings the full OmO feature set to OpenCode V2. Instead of one assistant doing everything, you get a small team that plans, delegates and keeps its own context."
  const items = es ? [
    ["Delegar en especialistas", "Entrega una tarea al agente adecuado (planificador, investigador, revisor) y recibe un resultado comprobado antes de darlo por hecho."],
    ["Seguir en tareas largas", "El contexto y el trabajo pendiente sobreviven a la compactación: una tarea larga continúa en lugar de reiniciarse."],
    ["Trabajar en segundo plano", "Los trabajos lentos siguen avanzando mientras continúas, y te avisan al terminar."],
    ["Usar tus modelos", "Combina modelos punteros y económicos; los agentes OmO del inventario llevan un modelo por defecto y una cadena de respaldo cuando se declaran."],
  ] : [
    ["Delegate to specialists", "Hand a task to the right agent (planner, researcher, reviewer) and get a result checked before it is called done."],
    ["Keep going on long tasks", "Context and pending work survive compaction, so a long job continues instead of restarting."],
    ["Work in the background", "Slow jobs keep running while you move on, and wake you when they finish."],
    ["Use your own models", "Mix frontier and cheap models; the OmO agents in the inventory carry a default model and a fallback chain when they are declared."],
  ]
  const more = es ? "Explora el catálogo completo: cada función y área con detalle." : "Browse the full catalogue: every function and area in detail."
  return `<section id="benefits" class="panel">
    <h2>${htmlEscape(head)}</h2>
    <p class="lead">${htmlEscape(intro)}</p>
    <ul class="benefits">${items.map(([heading, text]) => `<li class="benefit"><h3>${htmlEscape(heading)}</h3><p>${htmlEscape(text)}</p></li>`).join("")}</ul>
    <p><a href="${attr(publicPath(langLogicalPath(lang, "/catalogo/")))}">${htmlEscape(more)}</a></p>
  </section>`
}

function agentDefaultModel(agent) {
  return agent.defaultModel ? `${agent.defaultModel.model}${agent.defaultModel.variant ? ` (${agent.defaultModel.variant})` : ""}` : ""
}

// One vertical row per guide agent: real default model plus the editorial-vs-documented split. The
// beta Judge declares no model and is shown without one. Lives on the deep guide page, not the cover.
function agentDefaultsList(lang, source) {
  const t = UI[lang]
  return source.guide.agents.map((entry) => {
    const omo = source.agents.agents.find((a) => a.id === entry.id)
    const name = omo?.displayName ?? entry.displayName ?? entry.id
    if (!omo) {
      return `<li class="agent-default" data-agent-id="${attr(entry.id)}" data-default-model="">
      <span class="agent-default__name">${htmlEscape(name)}</span> <span class="agent-default__none">\u2014</span>
      <span class="agent-default__why">${htmlEscape(t.defaultsBetaNoModel)}</span>
    </li>`
    }
    const model = agentDefaultModel(omo)
    const priorities = (omo.reason ?? []).map((reason) => REASON_LABEL[lang]?.[reason] ?? reason).join(", ")
    const documented = omo.requiresProvider.length ? `${t.defaultsProviderGate}: ${omo.requiresProvider.join(", ")}.` : t.defaultsFirstRung
    return `<li class="agent-default" data-agent-id="${attr(entry.id)}" data-default-model="${attr(model)}">
      <span class="agent-default__name">${htmlEscape(name)}</span> <span class="agent-default__model"><code>${htmlEscape(model)}</code></span>
      <span class="agent-default__why"><span class="agent-default__tag">${htmlEscape(t.defaultsDerived)}</span> ${htmlEscape(t.defaultsPrioritizes)} ${htmlEscape(priorities)}.</span>
      <span class="agent-default__doc"><span class="agent-default__tag">${htmlEscape(t.defaultsDocumented)}</span> ${htmlEscape(documented)}</span>
    </li>`
  }).join("")
}

function agentDefaultsBody(lang, source) {
  const t = UI[lang]
  return `<p class="agent-defaults__lead">${htmlEscape(t.defaultsLead)}</p>
    <ul class="agent-defaults__list">${agentDefaultsList(lang, source)}</ul>
    <h3>${htmlEscape(t.defaultsChangeTitle)}</h3>
    <p class="agent-defaults__lead">${htmlEscape(t.defaultsChangeLead)}</p>
    ${copyableBlock(lang, MODEL_OVERRIDE_EXAMPLE, t.defaultsChangeTitle)}
    <p class="agent-defaults__lead">${htmlEscape(t.defaultsEffects)}</p>`
}

function guideDefaultsSection(lang, source) {
  const t = UI[lang]
  const agentsHref = `${publicPath(langLogicalPath(lang, "/agentes-y-modelos/guia-modelos/"))}#agentes`
  return `<section class="guide-group" id="modelos-por-agente">
    <h2>${htmlEscape(t.defaultsTitle)}</h2>
    ${agentDefaultsBody(lang, source)}
    <p><a href="${attr(agentsHref)}">${htmlEscape(t.defaultsAgentsLink)}</a></p>
  </section>`
}

// Providers and the primary model are OpenCode surfaces; Oh My Rigel only overlays agent and
// category tuning. Every command and key rendered here is a verified OpenCode V2 surface
// (docs: /v2/docs/cli/providers, /v2/docs/cli/commands, /v2/docs/config). The older
// `opencode providers list|login|logout` names do not exist in V2 and must never render.
function guideProvidersSection(lang) {
  const es = lang === "es"
  const t = UI[lang]
  const block = (heading, body, commands) => `<h3>${htmlEscape(heading)}</h3><p>${htmlEscape(body)}</p>${commands.map((command) => copyableBlock(lang, command, t.copyCommand)).join("")}`
  const steps = es
    ? [
      block("Ver el catálogo de modelos", "OpenCode aporta el catálogo. Este comando lista todos los modelos disponibles.", ["opencode models"]),
      block("Elegir el modelo principal", "En la TUI, /models elige el modelo principal. En opencode.jsonc, el campo model de nivel superior fija el principal del proyecto. La clave small_model de V1 no es nativa en V2: se normaliza al modelo del agente title (agents.title.model).", ["/models", OPENCODE_MODEL_EXAMPLE]),
      block("Conectar un proveedor", "/connect en la TUI lista las integraciones disponibles; opencode auth login hace lo mismo sin abrir la TUI, y el método se elige en el propio flujo.", ["/connect", "opencode auth login"]),
      block("Listar las cuentas conectadas", "Muestra las cuentas guardadas y su estado; las conexiones por variable de entorno aparecen con su tipo.", ["opencode auth list"]),
      block("Desconectar un proveedor", "Quita una cuenta guardada. Las conexiones por variable de entorno no son cuentas: se quitan al retirar la variable.", ["opencode auth logout"]),
    ]
    : [
      block("List the model catalog", "OpenCode provides the catalog. This command lists every model available.", ["opencode models"]),
      block("Choose the primary model", "In the TUI, /models chooses the primary model. In opencode.jsonc, the top-level model field sets the project's primary model. The V1 small_model key is not native in V2: it is normalized to the title agent's model (agents.title.model).", ["/models", OPENCODE_MODEL_EXAMPLE]),
      block("Connect a provider", "/connect in the TUI lists the available integrations; opencode auth login does the same without the TUI, and the method is chosen in the flow.", ["/connect", "opencode auth login"]),
      block("List connected accounts", "Shows the saved accounts and their state; environment connections appear with their type.", ["opencode auth list"]),
      block("Disconnect a provider", "Removes a saved account. Environment connections are not accounts: they are removed by unsetting the variable.", ["opencode auth logout"]),
    ]
  const title = es ? "Proveedores y modelo principal" : "Providers and primary model"
  const lead = es
    ? "Elegir el modelo principal y conectar proveedores es cosa de OpenCode, no de Oh My Rigel: OpenCode guarda las cuentas y las credenciales, y Oh My Rigel solo superpone el modelo y la cadena de un agente o categoría."
    : "Choosing the primary model and connecting providers is OpenCode's job, not Oh My Rigel's: OpenCode stores the accounts and credentials, and Oh My Rigel only overlays an agent's or category's model and chain."
  const boundary = es
    ? "Las credenciales viven en la base de datos de OpenCode, no en el archivo de Oh My Rigel. Para ajustar el modelo o la cadena de un agente o categoría, edita el bloque [opencode] en ~/.omo/omo.jsonc (usuario) o .omo/omo.jsonc (proyecto)."
    : "Credentials live in OpenCode's database, not in the Oh My Rigel file. To tune an agent's or category's model or chain, edit the [opencode] block in ~/.omo/omo.jsonc (user) or .omo/omo.jsonc (project)."
  return `<section class="guide-group" id="proveedores">
    <h2>${htmlEscape(title)}</h2>
    <p class="guide-group__summary">${htmlEscape(lead)}</p>
    ${steps.join("\n")}
    <p class="beta-note">${htmlEscape(boundary)}</p>
  </section>`
}

function agentConfigSection(lang, source) {
  const t = UI[lang]
  const guideHref = publicPath(langLogicalPath(lang, "/agentes-y-modelos/guia-modelos/"))
  return `<section id="configuracion-agentes" class="panel">
    <h2>${htmlEscape(t.agentConfigTitle)}</h2>
    <p>${htmlEscape(t.agentConfigLead)}</p>
    <p><a href="${attr(guideHref)}">${htmlEscape(t.agentConfigLink)}</a></p>
  </section>`
}

function whatIsSection(lang) {
  const t = UI[lang]
  return `<section id="que-es" class="panel">
    <h2>${htmlEscape(t.whatIsTitle)}</h2>
    <p class="lead">${htmlEscape(t.whatIsLead)}</p>
    <p>${htmlEscape(t.whatIsValue)}</p>
    <p class="beta-note">${htmlEscape(t.whatIsReason)}</p>
  </section>`
}

export function homePage(lang, source) {
  const t = UI[lang]
  const body = `<section class="hero" id="top" aria-labelledby="top-title">
    <h1 id="top-title">Oh My Rigel</h1>
    <p class="lead">${htmlEscape(t.lead)}</p>
  </section>
  ${whatIsSection(lang)}
  ${benefits(lang)}
  <section id="relationship" class="panel">
    <h2>${t.relationshipTitle}</h2>
    <p>${htmlEscape(t.relationshipBody)}</p>
  </section>
  <section id="install" class="panel">
    <h2>${t.installTitle}</h2>
    <p>${htmlEscape(t.installLead)}</p>
    <p class="beta-note">${htmlEscape(t.betaNote)}</p>
    ${installRoutes(lang)}
    <p class="cta-row"><a class="button" href="${GITHUB_URL}" rel="external noopener">${GITHUB_SVG}<span>GitHub</span></a></p>
    ${notices(lang)}
    <p class="migration-note">${htmlEscape(t.migrationNote)} <a href="${attr(t.migrationDoc)}" rel="external noopener">${t.migrationDocLabel}</a></p>
  </section>
  <section id="configure" class="panel">
    <h2>${t.configureTitle}</h2>
    <p>${htmlEscape(t.configureLead)}</p>
    <div class="setting-block"><span class="setting-block__label">${htmlEscape(t.settingLabel)}</span>${copyableBlock(lang, "~/.omo/omo.jsonc", t.copySetting)}</div>
    ${notices(lang)}
  </section>
  ${agentConfigSection(lang, source)}
  <section id="agentes-skill-comandos" class="panel">
    <h2>${htmlEscape(t.agentsSkillsCommands)}</h2>
    <p>${htmlEscape(t.agentsBody)}</p>
    <p>${htmlEscape(t.skillsBody)}</p>
    <p>${htmlEscape(t.commandsBody)}</p>
    <p><a href="${attr(publicPath(langLogicalPath(lang, "/agentes-y-modelos/guia-modelos/")))}">${htmlEscape(t.modelsGuideLink)}</a></p>
  </section>
  <section id="lifecycle" class="panel">
    <h2>${t.lifecycleTitle}</h2>
    <p>${htmlEscape(t.lifecycleLead)}</p>
    ${lifecycleCommands(lang)}
    <p class="preserve-note">${htmlEscape(t.lifecyclePreserveNote)}</p>
    <p class="migration-note">${htmlEscape(t.lifecycleHostNote)} <a href="${attr(t.migrationDoc)}" rel="external noopener">${t.migrationDocLabel}</a></p>
  </section>
  <section id="help" class="panel">
    <h2>${t.helpTitle}</h2>
    <p>${htmlEscape(t.helpBody)}</p>
    <p><a href="${GITHUB_ISSUES_URL}" rel="external noopener">${htmlEscape(t.helpIssues)}</a></p>
  </section>`
  return page({ lang, logicalPath: langLogicalPath(lang, "/"), title: "Oh My Rigel", description: t.lead, body, seal: source.seal })
}

export function catalogPage(lang, source) {
  const t = UI[lang]
  const ficha = (fn) => `<details class="ficha" id="${attr(fn.id)}">
    <summary>
      <span class="ficha__name">${htmlEscape(fn.nombre)}</span>
      <span class="ficha__one">${htmlEscape(fn.que_es)}</span>
      <span class="ficha__state setting">${htmlEscape(stateLabel(lang, fn.estado))}</span>
    </summary>
    <div class="ficha__body">
      <p class="activation-line"><span class="activation-line__label">${t.activation}</span><span class="activation-line__value">${htmlEscape(fn.modo_de_activacion)}</span></p>
      <h3>${t.usage}</h3><p>${htmlEscape(fn.como_se_usa)}</p>
      ${commandChips(fn)}
      <h3>${t.helps}</h3><p>${htmlEscape(fn.cuando_sirve)}</p>
      <h3>${t.requirements}</h3><p>${htmlEscape(valueText(fn.requisitos))}</p>
      <h3>${t.defaults}</h3><p>${htmlEscape(valueText(fn.valores_por_defecto))}</p>
    </div>
  </details>`
  const groups = source.catalog.areas.map((area) => {
    const functions = source.catalog.functions.filter((fn) => fn.area === area.id)
    return `<section class="catalog-area" id="area-${attr(area.slug)}">
      <h2>${htmlEscape(area.name)}</h2>
      <div class="fichas">${functions.map(ficha).join("")}</div>
    </section>`
  }).join("\n")
  const body = `<section class="page-title"><h1>${t.catalog}</h1></section>${groups}`
  return page({ lang, logicalPath: langLogicalPath(lang, "/catalogo/"), title: t.catalog, description: t.catalog, body, crumbItems: [[t.catalog, ""]], seal: source.seal })
}

function valueText(field) {
  if (!field) return ""
  if (field.procedencia === "derivado") return Array.isArray(field.valor) ? field.valor.join(", ") : field.valor
  return field.razon
}

function commandChips(fn) {
  const list = Array.isArray(fn.comandos?.valor) ? fn.comandos.valor : []
  if (!list.length) return ""
  return `<p class="commands">${list.map((cmd) => `<span class="command">${htmlEscape(cmd)}</span>`).join(" ")}</p>`
}

export function agentsPage(lang, source) {
  const t = UI[lang]
  const summary = statusSummary(source.agents.agents, (agent) => agent.defaultState)
  const body = `<section class="page-title"><h1>${t.agents}</h1></section>
  <section class="panel"><h2>${t.agents}</h2>${statusList(lang, summary)}<p><a href="${attr(publicPath(langLogicalPath(lang, "/agentes-y-modelos/guia-modelos/")))}">${t.modelGuide}</a></p></section>
  <ol class="row-list">${source.agents.agents.map((agent) => `<li><a href="${attr(publicPath(langLogicalPath(lang, `/agentes-y-modelos/${agent.id}/`)))}"><span>${htmlEscape(agent.displayName)}</span><small>${htmlEscape(agent.mode)}</small></a></li>`).join("")}</ol>`
  return page({ lang, logicalPath: langLogicalPath(lang, "/agentes-y-modelos/"), title: t.agents, description: t.agents, body, crumbItems: [[t.agents, ""]], seal: source.seal })
}

export function agentPage(lang, source, agent) {
  const t = UI[lang]
  const model = agent.defaultModel ? `${agent.defaultModel.model}${agent.defaultModel.variant ? ` (${agent.defaultModel.variant})` : ""}` : "not declared"
  const body = `<article class="detail">
    <p class="eyebrow">${htmlEscape(agent.mode)}</p>
    <h1>${htmlEscape(agent.displayName)}</h1>
    <p class="lead">${htmlEscape(agent.description)}</p>
    <dl class="fact-list">
      <div><dt>${t.activation}</dt><dd>${htmlEscape(agent.defaultState === "active" ? stateLabel(lang, "activada") : stateLabel(lang, "condicionada"))}</dd></div>
      <div><dt>${t.modelGuide}</dt><dd><code>${htmlEscape(model)}</code></dd></div>
      <div><dt>Providers</dt><dd>${htmlEscape(agent.requiresProvider.length ? agent.requiresProvider.join(", ") : "none declared")}</dd></div>
    </dl>
  </article>`
  return page({ lang, logicalPath: langLogicalPath(lang, `/agentes-y-modelos/${agent.id}/`), title: agent.displayName, description: agent.description, body, crumbItems: [[t.agents, publicPath(langLogicalPath(lang, "/agentes-y-modelos/"))], [agent.displayName, ""]], seal: source.seal })
}

// --- Guide of models, skills and commands ------------------------------------------------
// Vertical grouped reading: each section is a real surface (agents / skills / commands),
// each item is an independent inline <details> so several can stay open at once. No grid,
// no exclusive accordion, no tab strip. Names, modes, models and chains come from the W2
// source (agents.json / chains.json / cli.json); the prose comes from guide.json and its
// id-anchored EN overlay. An agent is never presented as a model.
function guideAliases(source, surface, name) {
  const owner = source.cli.owners?.[surface]
  const entry = (owner?.commands ?? []).find((c) => typeof c === "object" && c.name === name)
  return entry && Array.isArray(entry.aliases) ? entry.aliases : []
}

function guideAgentMode(source, entry) {
  const omo = source.agents.agents.find((a) => a.id === entry.id)
  return omo?.mode ?? entry.mode ?? "primary"
}

function guideItems(items) {
  return `<div class="guide-items">${items.join("")}</div>`
}

function guideAgentItem(lang, source, entry) {
  const t = UI[lang]
  const omo = source.agents.agents.find((a) => a.id === entry.id)
  const displayName = omo?.displayName ?? entry.displayName ?? entry.id
  const mode = guideAgentMode(source, entry)
  const badge = MODE_LABEL[lang]?.[mode] ?? mode
  const provenance = entry.provenance === "beta" ? t.guideProvenanceBeta : t.guideProvenanceOmo
  const chain = source.chains.agents.find((c) => c.id === entry.id)
  const chainText = chain ? chain.rungs.map((r) => `${r.model}${r.variant ? `@${r.variant}` : ""}`).join(" \u2192 ") : t.guideNoChain
  const defaultModel = omo?.defaultModel ? `${omo.defaultModel.model}${omo.defaultModel.variant ? ` (${omo.defaultModel.variant})` : ""}` : "\u2014"
  const providers = omo && omo.requiresProvider.length ? omo.requiresProvider.join(", ") : t.noneDeclared
  return `<details class="guide-item" id="agente-${attr(entry.id)}">
    <summary>
      <span class="guide-item__head">
        <span class="guide-item__name">${htmlEscape(displayName)}</span>
        <span class="guide-item__badge">${htmlEscape(badge)}</span>
        <span class="guide-item__prov">${htmlEscape(provenance)}</span>
      </span>
      <span class="guide-item__one">${htmlEscape(entry.funcion)}</span>
    </summary>
    <div class="guide-item__body">
      <h4>${htmlEscape(t.guideFunction)}</h4><p>${htmlEscape(entry.funcion)}</p>
      <h4>${htmlEscape(t.guideWhenToUse)}</h4><p>${htmlEscape(entry.cuandoUsar)}</p>
      <dl class="fact-list">
        <div><dt>${htmlEscape(t.guideDefaultModel)}</dt><dd><code>${htmlEscape(defaultModel)}</code></dd></div>
        <div><dt>${htmlEscape(t.guideChain)}</dt><dd>${htmlEscape(chainText)}</dd></div>
        <div><dt>${htmlEscape(t.guideProviders)}</dt><dd>${htmlEscape(providers)}</dd></div>
      </dl>
    </div>
  </details>`
}

function guideSkillItem(lang, entry) {
  const t = UI[lang]
  const provenance = entry.provenance === "beta" ? t.guideProvenanceBeta : t.guideProvenanceOmo
  return `<details class="guide-item" id="skill-${attr(entry.id)}">
    <summary>
      <span class="guide-item__head">
        <span class="guide-item__name"><code>${htmlEscape(entry.id)}</code></span>
        <span class="guide-item__prov">${htmlEscape(provenance)}</span>
      </span>
      <span class="guide-item__one">${htmlEscape(entry.funcion)}</span>
    </summary>
    <div class="guide-item__body">
      <h4>${htmlEscape(t.guideFunction)}</h4><p>${htmlEscape(entry.funcion)}</p>
      <h4>${htmlEscape(t.guideUsage)}</h4><p>${htmlEscape(entry.uso)}</p>
    </div>
  </details>`
}

function guideCommandItem(lang, source, entry) {
  const t = UI[lang]
  const label = entry.surface === "slash" ? `/${entry.name}` : `${entry.surface} ${entry.name}`
  const aliases = guideAliases(source, entry.surface, entry.name)
  const aliasLine = aliases.length
    ? `<h4>${htmlEscape(t.guideAliases)}</h4><p>${aliases.map((a) => `<code>${htmlEscape(a)}</code>`).join(", ")}</p>`
    : ""
  return `<details class="guide-item" id="cmd-${attr(entry.id.replace(":", "-"))}">
    <summary>
      <span class="guide-item__head">
        <span class="guide-item__name"><code>${htmlEscape(label)}</code></span>
      </span>
      <span class="guide-item__one">${htmlEscape(entry.queHace)}</span>
    </summary>
    <div class="guide-item__body">
      <h4>${htmlEscape(t.guideWhatItDoes)}</h4><p>${htmlEscape(entry.queHace)}</p>
      <h4>${htmlEscape(t.guideWhatItTouches)}</h4><p>${htmlEscape(entry.queToca)}</p>
      ${aliasLine}
    </div>
  </details>`
}

function guideModelScope(source) {
  const chained = new Set(source.chains.agents.map((c) => c.id))
  const complete = source.guide.agents.every((agent) => {
    const omo = source.agents.agents.find((a) => a.id === agent.id)
    return chained.has(agent.id) && Boolean(omo && omo.defaultModel)
  })
  return complete ? "all" : "inventory"
}

export function guidePage(lang, source) {
  const t = UI[lang]
  const guide = source.guide
  const scope = guideModelScope(source)
  const lead = GUIDE_LEAD[lang][scope]
  const omoAgents = guide.agents.filter((a) => a.provenance === "omo")
  const betaAgents = guide.agents.filter((a) => a.provenance === "beta")
  const primaries = omoAgents.filter((a) => guideAgentMode(source, a) === "primary")
  const secondaries = omoAgents.filter((a) => guideAgentMode(source, a) !== "primary")
  const omoSkills = guide.skills.filter((s) => s.provenance === "omo")
  const betaSkills = guide.skills.filter((s) => s.provenance === "beta")
  const bySurface = (surface) => guide.commands.filter((c) => c.surface === surface)
  const body = `<section class="page-title"><h1>${htmlEscape(t.guideTitle)}</h1></section>
  <section class="panel" id="guia-intro">
    <h2>${htmlEscape(t.guideIntroTitle)}</h2>
    <p class="lead" data-agent-model-scope="${scope}">${htmlEscape(lead)}</p>
    <p class="beta-note">${htmlEscape(t.guideLayerNote)}</p>
  </section>
  ${guideDefaultsSection(lang, source)}
  ${guideProvidersSection(lang)}
  <section class="guide-group" id="agentes">
    <h2>${htmlEscape(t.agents)}</h2>
    <p class="guide-group__summary">${htmlEscape(t.guideAgentsSummary)}</p>
    <h3>${htmlEscape(t.guideGroupPrimaries)}</h3>${guideItems(primaries.map((a) => guideAgentItem(lang, source, a)))}
    <h3>${htmlEscape(t.guideGroupSecondaries)}</h3>${guideItems(secondaries.map((a) => guideAgentItem(lang, source, a)))}
    <h3>${htmlEscape(t.guideGroupBeta)}</h3>${guideItems(betaAgents.map((a) => guideAgentItem(lang, source, a)))}
  </section>
  <section class="guide-group" id="skills">
    <h2>${htmlEscape(t.skills)}</h2>
    <p class="guide-group__summary">${htmlEscape(t.guideSkillsSummary)}</p>
    <h3>${htmlEscape(t.guideSkillsOmo)}</h3>${guideItems(omoSkills.map((s) => guideSkillItem(lang, s)))}
    <h3>${htmlEscape(t.guideSkillsBeta)}</h3>${guideItems(betaSkills.map((s) => guideSkillItem(lang, s)))}
  </section>
  <section class="guide-group" id="comandos">
    <h2>${htmlEscape(t.commands)}</h2>
    <p class="guide-group__summary">${htmlEscape(t.guideCommandsSummary)}</p>
    <h3>${htmlEscape(t.guideSurfaceRigel)}</h3>${guideItems(bySurface("rigel-v2").map((c) => guideCommandItem(lang, source, c)))}
    <h3>${htmlEscape(t.guideSurfaceOmo)}</h3>${guideItems(bySurface("omo").map((c) => guideCommandItem(lang, source, c)))}
    <h3>${htmlEscape(t.guideSurfaceSlash)}</h3>${guideItems(bySurface("slash").map((c) => guideCommandItem(lang, source, c)))}
    ${notices(lang)}
  </section>`
  return page({ lang, logicalPath: langLogicalPath(lang, "/agentes-y-modelos/guia-modelos/"), title: t.guideTitle, description: lead, body, crumbItems: [[t.agents, publicPath(langLogicalPath(lang, "/agentes-y-modelos/"))], [t.guideTitle, ""]], seal: source.seal })
}

// Legacy-path compatibility page. GitHub Pages is static and cannot emit an HTTP 301/302, so the
// moved /oh-my-rigel/ project paths ship a real 200 document that declares the root URL as its
// canonical, redirects the reader via meta refresh (no JS), and keeps a visible fallback link. It is
// noindex, and it is emitted only for known routes: an unknown legacy path has no file and still
// falls through to the 404 page.
export function legacyRedirectPage(target) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta http-equiv="refresh" content="0; url=${target}">
  <link rel="canonical" href="${attr(target)}">
  <title>Oh My Rigel</title>
</head>
<body>
  <p>This guide now lives at <a href="${attr(target)}">${attr(target)}</a>.</p>
</body>
</html>`
}

export function notFoundPage(source) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>404 · Oh My Rigel</title>
  <meta name="robots" content="noindex">
  <link rel="icon" type="image/svg+xml" sizes="32x32" href="${attr(publicPath("/assets/favicon-32.svg"))}">
  <link rel="icon" type="image/svg+xml" sizes="16x16" href="${attr(publicPath("/assets/favicon-16.svg"))}">
  <script>${THEME_INIT}</script>
  <link rel="stylesheet" href="${attr(publicPath("/assets/styles.css"))}">
</head>
<body>
  <main class="not-found">
    <p class="eyebrow">404</p>
    <h1>Page not found</h1>
    <p>The page you asked for does not exist.</p>
    <a class="button button--primary" href="${attr(publicPath("/"))}">Oh My Rigel</a>
  </main>
</body>
</html>`
}
