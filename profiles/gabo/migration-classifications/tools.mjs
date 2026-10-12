/**
 * Clasificación de migración para las herramientas V1 de OmO.
 *
 * Cada fila mapea un directorio real bajo
 * `packages/omo-opencode/src/tools/<fila>/index.ts` a su destino en el
 * runtime nativo de OpenCode V2 (`profiles/gabo/opencode/rigel-v2-native.mjs`
 * y `rigel-v2-native-core.mjs`). El generador
 * `profiles/gabo/generate-v2-migration-inventory.mjs` consume este objeto
 * como la sección `tools` del ledger.
 *
 * Forma: `{ "<fila>": { classification, rationale, futureEvidence } }`.
 * `futureEvidence` usa los tokens `task:<n>`, `contract:<archivo>.mjs` o
 * `gate:<config.key>`.
 */
export default {
  "call-omo-agent": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "La delegación nombrada V1 (`tools/call-omo-agent/tools.ts`) se adapta a la superficie nativa `rigel_task` de V2, que resuelve agentes por inventario y crea sesiones hijas con `session.create`/`session.prompt` en `rigel-v2-native-core.mjs`. El modelo de cada agente se resuelve SOLO desde `~/.omo/omo.jsonc` (el manifiesto no se consulta para modelos tras la instalación): `rigel-v2-native-explicit-chain.mjs` resuelve la cadena efectiva desde el JSON vivo (`resolveAuthoritativeAgentOverrides`), `rigel-v2-native-categories.mjs` y `rigel-v2-native-agents.mjs` honran el modelo explicito en las cuatro rutas (agente, categoria, background, resume) y `fallback_models` del usuario es la unica cadena de reintento del caso explicito.",
    futureEvidence: "`rigel-v2-native.mjs` (rigel_task); `rigel-v2-native-explicit-chain.mjs`; `rigel-v2-native-categories.mjs`; `rigel-v2-native-agents.mjs`; `rigel-v2-native-config.mjs` (readLiveAgentOverridesSource); `generate-v2-agents.mjs`; `rigel-v2-native-explicit-chain.test.mjs`; `rigel-v2-native-categories.test.mjs`; `rigel-v2-native-agents.test.mjs`; `qa-v2-native-delegation.mjs`",
  },
  "delegate-task": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "El enrutado por categoría y subagente de `tools/delegate-task/tools.ts` se adapta al `rigel_task` nativo, que resuelve categorías y agentes llamables y delega con modelo por categoría en `rigel-v2-native.mjs`; la paridad de categorías, la clave de concurrencia background y la cadena explícita se cubren en los modulos citados.",
    futureEvidence: "`rigel-v2-native-categories.mjs`; `rigel-v2-native-categories.test.mjs`; `rigel-v2-background-key.mjs`; `rigel-v2-native-explicit-chain.mjs`; `rigel-v2-native.mjs`; `qa-v2-native-delegation.mjs`",
  },
  glob: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El builtin del host no es equivalente a V1: excluye archivos ocultos por defecto, no sigue enlaces ni limita la profundidad igual, y usa otro formato. La herramienta V1 `tools/glob/tools.ts` se porta a una herramienta nativa V2 en `opencode/tools/glob-grep*.mjs`, registrada con `ctx.tool.transform` bajo el mismo nombre `glob` (una registracion posterior reemplaza la del host) conservando el schema V1 (pattern/path), el default de ocultos y `--follow`, el limite de 100 resultados, el timeout de 60s, el orden por mtime descendente y el formato V1. El contrato `qa-v2-builtin-parity.mjs` prueba la paridad en vivo con la misma llamada observable y comprueba que las mismas aserciones FALLAN contra el builtin del host. Conserva ademas la resolucion V1 completa (rg empaquetado, PATH, instalado y fallback a grep) con autoaprovisionamiento, el semaforo de concurrencia (2) y el backend fallback de `find` en Unix y PowerShell en Windows.",
    futureEvidence: "`opencode/tools/glob-grep.tools.mjs`; `opencode/tools/glob-grep-search.mjs`; `opencode/tools/glob-grep-format.mjs`; `opencode/tools/glob-grep-cli.mjs`; `opencode/tools/glob-grep-install.mjs`; `opencode/tools/glob-grep-concurrency.mjs`; `opencode/tools/glob-grep.tools.test.mjs`; `opencode/tools/glob-grep-fallback.test.mjs`; `qa-v2-builtin-parity.mjs`; `.omo/evidence/20261007-builtin-glob-grep-parity/report.txt`",
  },
  grep: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El builtin del host no es equivalente a V1: busca ocultos siempre (`--hidden`), no expone los modos `content`/`files_with_matches`/`count` ni `head_limit`, y omite los limites V1 por archivo. La herramienta V1 `tools/grep/tools.ts` se porta a una herramienta nativa V2 en `opencode/tools/glob-grep*.mjs`, registrada con `ctx.tool.transform` bajo el mismo nombre `grep` conservando el schema V1 (pattern/include/path/output_mode/head_limit), la exclusion de ocultos, los modos y formatos V1, y los limites `--max-count=500`, `--max-columns=1000`, `--max-filesize=10M`, `--max-depth=20` y `head_limit`. El contrato `qa-v2-builtin-parity.mjs` prueba la paridad en vivo y comprueba que las mismas aserciones FALLAN contra el builtin del host. Conserva ademas la resolucion V1 completa (rg empaquetado, PATH, instalado y fallback a grep) con autoaprovisionamiento, el semaforo de concurrencia (2) y el backend fallback de grep clasico.",
    futureEvidence: "`opencode/tools/glob-grep.tools.mjs`; `opencode/tools/glob-grep-search.mjs`; `opencode/tools/glob-grep-format.mjs`; `opencode/tools/glob-grep-cli.mjs`; `opencode/tools/glob-grep-install.mjs`; `opencode/tools/glob-grep-concurrency.mjs`; `opencode/tools/glob-grep.tools.test.mjs`; `opencode/tools/glob-grep-fallback.test.mjs`; `qa-v2-builtin-parity.mjs`; `.omo/evidence/20261007-builtin-glob-grep-parity/report.txt`",
  },
  "hashline-edit": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El editor por hashes de `tools/hashline-edit/tools.ts` se adapta al modelo de edición de V2 con `createHashlineEditTool` en `rigel-v2-native-hashline.mjs`, registrado como `hashline_edit`: valida el hash LINE#ID antes de escribir, restaura el envoltorio de BOM y CRLF, permite crear un archivo ausente con append o prepend sin ancla y rechaza el hash obsoleto sin tocar el archivo. El port de `hashline-core` vive en `rigel-v2-native-hashline-core.mjs` y su paridad con V1 está fijada por prueba.",
    futureEvidence: "`rigel-v2-native-hashline.mjs`; `rigel-v2-native-hashline-core.mjs`; `rigel-v2-native-hashline.test.mjs`",
  },
  "interactive-bash": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "La shell interactiva por tmux de `tools/interactive-bash/tools.ts` se porta a la superficie nativa V2, condicionada a la detección de tmux disponible en el host.",
    futureEvidence: "`tools/interactive-bash.tools.mjs`; `rigel-v2-native-conditional-tools.mjs`; `rigel-v2-native-conditional-tools.test.mjs`",
  },
  "look-at": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El análisis multimodal de `tools/look-at/tools.ts` se porta a V2 con enrutado al agente multimodal-looker y el permiso runtime correspondiente.",
    futureEvidence: "`tools/look-at.tools.mjs`; `rigel-v2-native-tools.mjs`",
  },
  monitor: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "La familia `monitor_start/stop/list/output` de `tools/monitor/create-monitor-tools.ts` se porta a V2 (`tools/monitor.tools.mjs` + `monitor-engine.mjs` + `monitor-delivery.mjs`), condicionada a la clave de configuración `monitor.enabled` (apagada por defecto). El estado de los monitores se inyecta en el turno del orquestador por el hook `context` y el gate apagado es un no-op verificado.",
    futureEvidence: "`tools/monitor.tools.mjs`; `tools/monitor-engine.mjs`; `tools/monitor-delivery.mjs`; `tools/monitor.tools.test.mjs`; `rigel-v2-monitor-status.mjs`; `rigel-v2-monitor-status.test.mjs`; `rigel-v2-monitor-status-wiring.test.mjs`",
  },
  "session-manager": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "Las herramientas de sesión `session_list/read/search/info` de `tools/session-manager/tools.ts` se portan a V2 envolviendo el SDK nativo con la semántica V1 de dominio, paginación y formatos.",
    futureEvidence: "`tools/session.tools.mjs`; `rigel-v2-native-tools.mjs`",
  },
  skill: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "La selección y carga de skills de `tools/skill/tools.ts` se porta a V2 con el descubrimiento por `SCOPE_PRIORITY` de skills-loader-core y la inyección real del cuerpo de la skill en el hijo delegado.",
    futureEvidence: "`rigel-v2-native-skills.mjs` (discoverSkills); `rigel-v2-native.mjs` (inyeccion de cuerpos en hijos delegados)",
  },
  "skill-mcp": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El MCP embebido en skill de `tools/skill-mcp/tools.ts` se porta a V2 como tier-3 con transporte stdio y HTTP y aislamiento por sesión.",
    futureEvidence: "`rigel-v2-native-skill-mcp.mjs`; `rigel-v2-skill-mcp-oauth.mjs`; `rigel-v2-skill-mcp-oauth.test.mjs`",
  },
  slashcommand: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El descubrimiento de comandos de `tools/slashcommand/command-discovery.ts` se migra a la herramienta nativa `slashcommand`, que lee el catalogo de comandos del host (`ctx.command.list()`), union de los comandos del runtime (`goal`, `ulw-execute`) y del host V2.",
    futureEvidence: "`tools/slashcommand.tools.mjs`; `tools/slashcommand.tools.test.mjs`; `rigel-v2-native.mjs`",
  },
  task: {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "La familia `task_create/get/list/update` de `tools/task/` se adapta al motor de tareas nativo de V2 (`tools/task.tools.mjs`), con los gates de configuración respetados en runtime mediante las herramientas condicionales; el espejo de todos ligado a la sesión se prueba en la integración.",
    futureEvidence: "`tools/task.tools.mjs`; `rigel-v2-native-conditional-tools.mjs`; `tools/task.tools.test.mjs`; `rigel-v2-native-todo-integration.test.mjs`; `rigel-v2-native-todo-wiring.test.mjs`",
  },
}
