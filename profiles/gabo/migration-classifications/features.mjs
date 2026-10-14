/**
 * Clasificación de migración para los módulos de features V1 de OmO.
 *
 * Cada fila mapea un directorio real bajo
 * `packages/omo-opencode/src/features/<fila>/` a su destino en el runtime
 * nativo de OpenCode V2 (`profiles/gabo/opencode/rigel-v2-native.mjs`,
 * `rigel-v2-native-core.mjs` y `rigel-v2-native-prompt.mjs`). Varios módulos
 * son shims del adaptador sobre paquetes de núcleo extraídos
 * (`packages/team-core/`, `packages/tmux-core/`, `packages/skills-loader-core/`,
 * `packages/mcp-client-core/`, `packages/claude-code-compat-core/`,
 * `packages/boulder-state/`). El generador
 * `profiles/gabo/generate-v2-migration-inventory.mjs` consume este objeto
 * como la sección `features` del ledger.
 *
 * Forma: `{ "<fila>": { classification, rationale, futureEvidence } }`.
 * `futureEvidence` usa los tokens `task:<n>`, `contract:<archivo>.mjs` o
 * `gate:<config.key>`.
 */
export default {
  "background-agent": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El motor de ciclo de vida de tareas de `features/background-agent/` se porta al runtime nativo V2 sobre eventos de sesion y un registro propio. `rigel-v2-background-manager.mjs` compone la cola FIFO por clave y el reintento (`rigel-v2-background-queue.mjs`, `rigel-v2-background-retry.mjs`), el handoff no bloqueante (`rigel-v2-background-handoff.mjs`, tope MAX_WAKE_ATTEMPTS=3) y el marcador de continuacion en disco (`rigel-v2-background-marker.mjs`, `.omo/run-continuation/<parent>.json`, fuente `background-task`) sin ningun timer ni poller. `rigel-v2-native.mjs` encola el handoff (sin await) en el bucle de eventos y limpia los hijos en `session.deleted` mediante el registro de T11. Ademas, una sesion hija cuyo turno assistant termina errado se finaliza (upstream a0b2e96c3) en su borde terminal real: V2 emite `session.execution.failed` (la sesion pasa a idle sin evento idle visible para el plugin, por lo que no hay borde idle que contar), `rigel-v2-background-stopped.mjs` porta el lector de error (`getStoppedSessionErrorInfo`, tolerante a la forma V2 plana con `type` y a la V1 `info.role`, saltando los marcadores `idle`/`system`/`model-switched`) y `handleChildFailure` lee ese error, clasifica el reintento y finaliza por `enqueueHandoff(..., 'failed')` con guarda de reentrada (finaliza una sola vez ante eventos repetidos). El clasificador `classifyRetry` ya tiene llamador de produccion (`handleChildFailure`, cableado en el borde `session.execution.failed`) y el filtro de proveedores que sirven el modelo (upstream 8e705a122) corre en `rigel-v2-background-retry.mjs` con `modelsByProvider`, sin doble reintento con el `delegate-task-retry` de primer plano.",
    futureEvidence:
      "`rigel-v2-background-manager.mjs`; `rigel-v2-background-queue.mjs`; `rigel-v2-background-retry.mjs`; `rigel-v2-background-handoff.mjs`; `rigel-v2-background-marker.mjs`; `rigel-v2-background-stopped.mjs`; `rigel-v2-background-manager.test.mjs`; `rigel-v2-background-queue.test.mjs`; `rigel-v2-background-retry.test.mjs`; `rigel-v2-background-stopped.test.mjs`",
  },
  "boulder-state": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El estado persistente de trabajo boulder de `features/boulder-state/` sobre `packages/boulder-state/` sostiene el plan activo entre sesiones y se migra como base del enforcer de continuidad nativo de V2.",
    futureEvidence: "contract:rigel-v2-native-todo-continuation-state.mjs; contract:rigel-v2-ulw-execute-boulder.mjs; contract:rigel-v2-ulw-execute.test.mjs",
  },
  "btw-side": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "Las conversaciones laterales efimeras de `features/btw-side/` inyectan contexto del padre mediante un hook Transform que V2 no ofrece; se adapta el inyector al hook `context` de V2. `rigel-v2-btw-core.mjs` porta metadata (`omo_btw_side` v1), el budget de padre (64 mensajes / 64 KiB), la maquina de estados del controlador (retained sides, tombstones cap 512, escape-return doble <=1000 ms) y las opciones del picker; `rigel-v2-native-btw-context.mjs` compone el inyector dentro del hook `context` (positivo con metadata -> inyeccion bounded + recibo durable; negativo sin metadata -> byte-identico) y `rigel-v2-native-cli-btw.mjs` provee `/btw`, picker y creacion de sesion side con metadata sin parentID.",
    futureEvidence: "`rigel-v2-btw-core.mjs`; `rigel-v2-btw-core.test.mjs`; `rigel-v2-native-btw-context.mjs`; `rigel-v2-native-btw-context.test.mjs`; `rigel-v2-native-cli-btw.mjs`; `rigel-v2-native-cli-btw.test.mjs`; `rigel-v2-native.mjs` (hook context)",
  },
  "builtin-commands": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "Las plantillas de comandos de `features/builtin-commands/` (refactor, ulw-execute, stop-continuation, handoff, remove-ai-slops, hyperplan, goal) se migran al modelo de comandos de V2 conservando los mismos disparadores y cuerpos. `goal` y `ulw-execute` se registran directamente en el runtime nativo; `stop-continuation` se entrega por el seam de prompt; los cuatro comandos restantes (`refactor`, `remove-ai-slops`, `handoff`, `hyperplan`) se registran via `ctx.command.transform` con su plantilla V1 generada desde el dueno y entregada al turno real de la sesion (`ctx.session.prompt`).",
    futureEvidence: "`rigel-v2-native-builtin-commands.mjs`; `rigel-v2-native-builtin-command-manifest.mjs`; `generate-v2-builtin-command-manifest.mjs`; `rigel-v2-native-builtin-commands.test.mjs`; `generate-v2-builtin-command-manifest.test.mjs`; `rigel-v2-native-runtime.test.mjs`; `qa-v2-builtin-commands-contract.mjs`; `.omo/evidence/20261006-t35-builtin-commands/task-35.txt`",
  },
  "claude-code-agent-loader": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "La carga de agentes desde `.opencode/agents/` y plugins de Claude Code de `features/claude-code-agent-loader/` delega en `packages/claude-code-compat-core/`; se migra reutilizando el cargador neutral y registrando el resultado en el roster de V2.",
    futureEvidence: "contract:rigel-v2-native-agents.mjs; contract:rigel-v2-claude-code-config.mjs; contract:rigel-v2-native-agents.test.mjs",
  },
  "claude-code-command-loader": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "La carga de comandos desde `.opencode/commands/` y plugins de Claude Code de `features/claude-code-command-loader/` sobre `packages/claude-code-compat-core/` se migra al modelo de comandos de V2 junto con builtin-commands.",
    futureEvidence: "contract:rigel-v2-native-builtin-commands.mjs; contract:rigel-v2-native-builtin-commands.test.mjs",
  },
  "claude-code-mcp-loader": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El cargador MCP de tier 2 de `features/claude-code-mcp-loader/` esta portado: la lista de archivos V1 (.claude.json, .mcp.json user y project, .claude/.mcp.json local), last-wins, `disabled: true` que elimina de scopes previos, filtro de scope local, expansion `${VAR}`/`${VAR:-default}` con la regla de seguridad V1 (la allowlist `mcp_env_allowlist` es de capa usuario y un proyecto no puede extenderla) y registro via `ctx.mcp.transform` con la traduccion local/remote del loader tier-3.",
    futureEvidence: "`rigel-v2-claude-code-mcp.mjs`; `rigel-v2-claude-code-mcp.test.mjs`; `rigel-v2-native-config.mjs` (readNativeMcpPolicy, allowlist solo capa user); `rigel-v2-native.mjs` (registro); mutaciones del ledger (2 casos tier-2)",
  },
  "claude-code-session-state": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "El registro en memoria de sesiones de subagente de `features/claude-code-session-state/` no expone comportamiento propio; es un módulo de soporte que viaja con la superficie de delegación e inyección que lo consume.",
    futureEvidence: "contract:rigel-v2-native-session-state.mjs; contract:rigel-v2-native-session-state.test.mjs",
  },
  "claude-tasks": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "El esquema y almacenamiento atómico de tareas de `features/claude-tasks/` se migran, pero su sincronización con la API de todos de OpenCode es un muro de V2 y se adapta con el registro persistente propio de la tarea 22.",
    futureEvidence: "contract:tools/task.tools.mjs; contract:tools/task.tools.test.mjs; contract:rigel-v2-native-todo-integration.test.mjs",
  },
  "context-injector": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "`features/context-injector/` es un colector generico de contexto (register/getPending/consume con orden por prioridad y separador canonico) mas un hook de transform. Ola 4b lo porto completo: el colector nativo (`rigel-v2-context-collector.mjs`) alimenta el consumidor del hook `context` de V2 (`event.messages`), y el productor claude-code-hooks registra su contexto con source custom y prioridad high. El consumo real en la peticion del proveedor se demostro en el lab con un proveedor simulado loopback (captura del body con el marcador del hook).",
    futureEvidence: "`rigel-v2-context-collector.mjs`; `rigel-v2-native-prompt.test.mjs` (casos del colector); `rigel-v2-claude-code-hooks.mjs`; `rigel-v2-native.mjs` (hook context); `live-qa/wave4-collector-claude-code-hooks.md`; `live-qa/wave4b-mock-provider-capture.json`",
  },
  "hook-message-injector": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "El inyector de mensajes de sistema de `features/hook-message-injector/` es un helper de soporte consumido por otros hooks y no expone comportamiento propio; viaja con los hooks que lo usan.",
    futureEvidence: "contract:rigel-v2-native-prompt.mjs; contract:rigel-v2-native-prompt.test.mjs",
  },
  "mcp-oauth": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El flujo OAuth 2.0 con PKCE, DCR y step-up de `features/mcp-oauth/` sobre `packages/mcp-client-core/` se migra como parte del sistema MCP de tres niveles de V2 con la misma seguridad; el efecto interactivo del CLI V1 se completa con el comando nativo `mcp-oauth`.",
    futureEvidence: "`rigel-v2-skill-mcp-oauth.mjs`; `rigel-v2-native-skill-mcp.mjs`; `rigel-v2-skill-mcp-oauth.test.mjs`; `profiles/gabo/opencode/rigel-v2-native-mcp-oauth-command.mjs`; `profiles/gabo/qa-v2-t30-mcp-oauth.mjs`",
  },
  monitor: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El backend de `monitor_start/stop/list/output` de `features/monitor/` (procesos vigilados, anillo de salida, filtrado e inyección por lotes) se porta a V2 condicionado a la clave `monitor.enabled`, apagada por defecto.",
    futureEvidence: "contract:tools/monitor.tools.mjs; contract:tools/monitor.tools.test.mjs; contract:rigel-v2-monitor-status.test.mjs",
  },
  "native-edition-nudge": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El aviso de TUI de `features/native-edition-nudge/` que ofrece instalar la edicion nativa se migra con su dialogo, acciones y estado de snooze al runtime nativo V2: `applyNativeEditionNudgeAction` porta las cuatro acciones (install sin escritura de estado; guide +7d; later snoozed +7d; never) y `rigel-v2-native-cli-nudge.mjs` registra el comando `/native` (alias omo-native) con el dialogo de seleccion sobre el mismo store durable.",
    futureEvidence: "`rigel-v2-native-cli-nudge.mjs`; `rigel-v2-native-cli-nudge.test.mjs`; `rigel-v2-native-nudge-core.mjs`; `rigel-v2-native-nudge-state.mjs`",
  },
  "opencode-runtime-skills": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "La fuente de skills en runtime de `features/opencode-runtime-skills/` se cubre consumiendo el catalogo fusionado del host (`ctx.skill.list()`) con single-flight y fallback al disco (`createRuntimeHostSkillSource`); el servidor de fuente de skills de seguridad por sesion no tiene seam equivalente en el dominio de skills de V2 y se considera adaptado fuera.",
    futureEvidence: "contract:rigel-v2-native-skills.mjs (createRuntimeHostSkillSource); contract:rigel-v2-native-skills.test.mjs",
  },
  "opencode-skill-loader": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El descubrimiento de skills de cuatro ámbitos con prioridad numérica de `features/opencode-skill-loader/` sobre `packages/skills-loader-core/` se migra para alimentar las herramientas `skill` y `skill_mcp` nativas.",
    futureEvidence: "`rigel-v2-native-skills.mjs` (discoverSkills/registerNativeSkills); `rigel-v2-native-skills.test.mjs`",
  },
  "opengateway-provider": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "La inyeccion del proveedor OpenGateway de `features/opengateway-provider/`, activada solo con credencial real (env `OPENGATEWAY_API_KEY` o el auth store del lab) y con el catalogo empaquetado (60 modelos), se migra al modelo de proveedores de V2 mediante `context.provider.transform`: `rigel-v2-native-opengateway.mjs` rellena solo campos ausentes (los del usuario ganan), agrega cada modelo del catalogo solo si su id falta y clona cada valor inyectado. Sin credencial es un no-op byte-identico (el transform nunca corre).",
    futureEvidence: "`rigel-v2-native-opengateway.mjs`; `rigel-v2-native-opengateway.test.mjs`; `rigel-v2-opengateway-models.json`; `rigel-v2-native.mjs` (install en setup)",
  },
  "run-continuation-state": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "Los dos orígenes vivos V1, `background-task` y `stop`, se conservan en `.omo/run-continuation/<session>.json`; el manager actualiza el primero y el guard de parada escribe o libera el segundo antes de cancelar descendientes. La finalizacion de una sesion hija idle sobre un turno errado (upstream a0b2e96c3) comparte el mismo manager y su contador se limpia con el registro (`clearSession`/`session.deleted`).",
    futureEvidence: "`rigel-v2-background-marker.mjs`; `rigel-v2-background-manager.mjs`; `rigel-v2-background-stopped.mjs`; `rigel-v2-background-manager.test.mjs`; `rigel-v2-background-stopped.test.mjs`; `rigel-v2-native-request-steps.test.mjs`",
  },
  "skill-mcp-manager": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El ciclo de vida de MCP de tier 3 de `features/skill-mcp-manager/` sobre `packages/mcp-client-core/`, aislado por la clave `${sessionID}:${skillName}:${serverName}`, se migra para el MCP embebido en skills con transporte stdio y HTTP.",
    futureEvidence: "`rigel-v2-native-skill-mcp.mjs`; `rigel-v2-native.mjs`",
  },
  "task-toast-manager": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El gestor de notificaciones de progreso de tareas de `features/task-toast-manager/` se migra a los avisos de la TUI de V2 conservando el seguimiento de estado y la informacion de fallback de modelo: `rigel-v2-native-task-toast-core.mjs` porta el manager (titulos, variantes, regla de duracion, lista running/queued con marcadores y duraciones, prefijos [FALLBACK], toast de completado) con el sink inyectado, y `rigel-v2-native-cli-task-toast.mjs` lo conduce desde los eventos V2 y el marcador/estado durable de background, encendido por defecto.",
    futureEvidence: "`rigel-v2-native-task-toast-core.mjs`; `rigel-v2-native-task-toast-core.test.mjs`; `rigel-v2-native-cli-task-toast.mjs`; `rigel-v2-native-cli-task-toast.test.mjs`",
  },
  "team-mode": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "La coordinacion multiagente de `features/team-mode/` vive sobre el modelo nativo de storage (`rigel-v2/team/<name>`): las 12 herramientas team_*, los 4 handlers de eventos (idle wake hint, member status, member error, lead orphan), el gating por rol y los inyectores de mailbox y estado. Cierra el ultimo gap: cada miembro recibe un worktree git exclusivo (rama `rigel-team/<team>/<member>`), la ruta se persiste en el record del team y la sesion del miembro se enlaza a su worktree via `session.move`; el shutdown aprobado y el lead-orphan limpian worktrees, ramas y directorios sin bloquear, con reintento acotado y registro observable. Un diario persistente de cleanup y la reconciliacion al arrancar evitan residuos si el proceso muere a mitad del cleanup.",
    futureEvidence: "`rigel-v2-team-worktrees.mjs`; `rigel-v2-team-worktrees.test.mjs`; `tools/team.tools.mjs`; `tools/team.tools.test.mjs`; `rigel-v2-team-events.mjs`; `rigel-v2-team-events.test.mjs`; `rigel-v2-native-conditional-tools.mjs`; `rigel-v2-native.mjs`",
  },
  "tmux-subagent": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "Resuelto por decision de Gabo (2026-10-05, opcion A): reescritura nativa completa. La visualizacion vive en `profiles/gabo/opencode/rigel-v2-tmux-viz-*.mjs`: elegibilidad y degradacion explicita (`rigel-v2-tmux-viz-env.mjs`), runner del CLI tmux + salud del server (`rigel-v2-tmux-viz-runner.mjs`), query y parseo del estado de paneles con la heuristica de main pane (`rigel-v2-tmux-viz-pane-state.mjs`), planificacion de grid y decisiones de split con las constantes V1 (`rigel-v2-tmux-viz-layout.mjs`), polling con activacion por foco/gracia 5s, estabilidad 10s/3 ticks, grace 30s y timeout 60min (`rigel-v2-tmux-viz-polling.mjs`), cleanup con C-c + kill-pane, reintentos 3/15min y zombie sweep (`rigel-v2-tmux-viz-cleanup.mjs`), y el manager orquestador (`rigel-v2-tmux-viz-manager.mjs`) cableado en `rigel-v2-native.mjs` bajo el gate `team_mode.tmux_visualization`. El contrato completo se demostro contra tmux 3.4 real: deteccion dentro de tmux, split de panel con titulo omo-subagent-*, tracking y limpieza tras session.deleted.",
    futureEvidence: "`rigel-v2-tmux-viz-*.mjs` + `rigel-v2-tmux-viz-*.test.mjs`; `.omo/evidence/20261005-tmux-subagent-native/live-tmux-pane-lifecycle.json`; mutaciones del ledger (5 casos tmux-viz); wiring `rigel-v2-native.mjs`",
  },
  "tool-metadata-store": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "El almacén de metadatos de ejecución de herramientas de `features/tool-metadata-store/` no expone comportamiento propio; es un módulo de soporte que viaja con las herramientas de tarea que publican y recuperan su metadata.",
    futureEvidence: "contract:rigel-v2-native-core.mjs; contract:qa-v2-native-delegation.mjs",
  },
  "tui-sidebar": {
    classification: "Migrar",
    status: "Pendiente de ejecución",
    rationale:
      "Decision cerrada de Gabo (2026-10-14): el sidebar V2 nativo previo se retira por completo, sin cuarentena. El sidebar heredado activo de OmO sigue siendo `features/tui-sidebar/` (superficie V1 intacta, fuera del alcance del port nativo). Se eliminan `rigel-v2-native-cli-sidebar.mjs` y `rigel-v2-sidebar-core.mjs`; el compositor `rigel-v2-native-cli.mjs` deja de componer `createSidebarCliSurface` y conserva exactamente las cinco superficies protegidas (Notification, LegacyNotice, Nudge, TaskToast y BTW) en su orden. La fila queda pendiente de ejecucion: el sidebar V2 futuro se reescribira desde cero, no reutilizara los modulos retirados y su prueba aislada todavia no existe.",
    futureEvidence: "`sidebar-decoupling-audit.test.mjs`; el sidebar heredado de OmO en `packages/omo-opencode/src/features/tui-sidebar/` (superficie V1, sin port nativo V2); reescritura del sidebar V2 pendiente",
  },
}
