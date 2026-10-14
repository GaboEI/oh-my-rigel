/**
 * Clasificación de migración para las superficies V1 de OmO bajo
 * `packages/omo-opencode/src/plugin/`.
 *
 * Cada fila mapea un módulo real de `plugin/` a su destino en el runtime
 * nativo de OpenCode V2 (`profiles/gabo/opencode/rigel-v2-native.mjs`,
 * `rigel-v2-native-core.mjs`, `rigel-v2-native-prompt.mjs`). El generador
 * `profiles/gabo/generate-v2-migration-inventory.mjs` consume este objeto
 * como la sección `plugin` del ledger.
 *
 * Frontera V2: `OH-MY-RIGEL.md` (líneas 56-80) y `AGENTS.rigel.md` declaran
 * que V2 no tiene mapeo verificado para `chat.headers`, `chat.params`,
 * `command.execute.before`, `config`, `event`,
 * `experimental.chat.messages.transform`,
 * `experimental.compaction.autocontinue` y `tool.definition`; esos handlers
 * se reportan en el arranque en vez de declararse activos.
 *
 * Forma: `{ "<fila>": { classification, rationale, futureEvidence } }`.
 * `futureEvidence` usa los tokens `task:<n>`, `contract:<archivo>.mjs` o
 * `gate:<config.key>`.
 */
export default {
  "available-categories": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "`plugin/available-categories.ts` solo construye la lista `AvailableCategory[]` que alimenta el prompt de agentes; no expone comportamiento propio y viaja con la capacidad de categorías que lo consume.",
    futureEvidence: "contract:rigel-v2-native-categories.mjs; contract:rigel-v2-native-categories.test.mjs",
  },
  "build-team-idle-wake-hint-client": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "`plugin/build-team-idle-wake-hint-client.ts` solo acota el cliente SDK a `promptAsync`/`status`/`messages` para el handler de team mode; es soporte de construcción sin comportamiento de runtime propio.",
    futureEvidence: "contract:rigel-v2-team-events.mjs (createNativeTeamEventHandlers usa ctx.session directa de V2)",
  },
  "chat-headers": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "`plugin/chat-headers.ts` inyecta la cabecera `x-initiator` de Copilot. La documentacion oficial mapea `chat.headers` a `ctx.session.hook(\"model.request\", ...)`; el runtime nativo registra `createNativeModelRequestHook` y aplica `x-initiator` cuando el mensaje lleva el marcador interno, con gate de proveedor, conservando la semantica V1.",
    futureEvidence: "`rigel-v2-native-prompt.mjs` (createNativeModelRequestHook); `rigel-v2-native-prompt.test.mjs`; `rigel-v2-native.mjs`",
  },
  "chat-message": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "`plugin/chat-message.ts` resuelve la variante del primer mensaje, la sesion y la deteccion de keywords; V2 no expone `chat.message`, asi que se adapta a la frontera `http.request`. La deteccion de keywords (`ultrawork`/`ulw`, team, `hyperplan` y combo), el enrutado por modelo y la inyeccion de los cuerpos V1 se portan en `rigel-v2-native-keyword-seam.mjs` y `rigel-v2-native-prompt.mjs`; la variante por turno del primer mensaje sigue siendo el muro documentado y no se reimplemento.",
    futureEvidence: "contract:rigel-v2-native-prompt.mjs; contract:rigel-v2-native-keyword-seam.mjs; contract:rigel-v2-native-prompt.test.mjs",
  },
  "chat-params": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "`plugin/chat-params.ts` ajusta esfuerzo Anthropic, think mode y fallback de modelo. La documentacion oficial mapea `chat.params` al hook `context` de V2 (`event.options`). Demostrado en vivo con captura del body final del proveedor: `event.options.reasoningEffort` llega como `reasoning_effort` (adaptador OpenAI, modelo loopback) y `event.options.thinking` llega como `thinking: {type:'enabled', budget_tokens}` (adaptador Anthropic REAL de V2, endpoint loopback, claude-opus-4-7); `reasoningEffort` lo ignora Anthropic y `thinking` lo ignora OpenAI, asi que `rigel-v2-native-reasoning-options.mjs` emite AMBOS carriers (como hacia el chat.params V1) y `rigel-v2-native-prompt.mjs` los aplica en el hook `context`.",
    futureEvidence: "`rigel-v2-native-reasoning-options.mjs`; `rigel-v2-native-reasoning-options.test.mjs`; `rigel-v2-native-prompt.mjs`; `qa-v2-reasoning-variant-mechanism.mjs`; `qa-v2-reasoning-anthropic.mjs`; `.omo/evidence/20261006-t23-think-variants/`",
  },
  "command-execute-before": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "`plugin/command-execute-before.ts` aplica guards de comando (stop-continuation, /goal, ulw-execute, auto-slash-command). V2 no expone `command.execute.before`; los cuatro comportamientos estan implementados sobre superficies oficiales V2 y probados: stop-continuation en la frontera del request (`rigel-v2-native-request-steps.mjs` + `rigel-v2-background-manager.mjs`), los comandos nativos `/goal` y `/ulw-execute` via `ctx.command.transform` (`rigel-v2-native.mjs`) y la intercepcion de comandos embebidos en el hook `prompt` de V2 (`rigel-v2-auto-slash-command-bridge.mjs`, seam confirmado contra la documentacion oficial de admision de prompts).",
    futureEvidence: "`rigel-v2-native-request-steps.mjs`; `rigel-v2-background-manager.mjs`; `rigel-v2-native.mjs` (command.transform goal/ulw-execute); `rigel-v2-auto-slash-command-bridge.mjs`; `live-qa/wave1-goal.md`; `live-qa/wave3-auto-slash.md`; mutaciones del ledger",
  },
  event: {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "`plugin/event.ts` cablea el ciclo de vida de sesion, openclaw y el fallback reactivo; V2 no expone `event`, y el runtime nativo se suscribe con `ctx.event.subscribe` y adapta el handoff de background, la limpieza de `session.deleted`, el fallback reactivo (`applyReactiveFallback` en `rigel-v2-native.mjs` + `rigel-v2-native-model-chains.mjs`) y la actividad de sesion. Divergencia de mensajes resuelta (T36): un experimento vivo en el laboratorio aislado (v2.0.22) prueba que V2 NO emite `message.updated`/`message.removed`/`message.part.*` (set vacio); la actividad real es el vocabulario `session.*`, capturado con trazas de turnos reales, un revert real y una tool fallida real. `rigel-v2-native-activity.mjs` separa el vocabulario por efecto: salida del assistant (incluye el progreso `session.tool.progress` y el terminal `session.tool.failed`), mensaje de usuario (`session.inbox.enqueued`/`delivered`) y mutacion de transcript (`session.revert.staged`/`cleared`). tmux y notificacion consumen la union general, de modo que una herramienta larga con progreso y una reversion real incrementan actividad (no parecen estables) y cancelan una notificacion idle pendiente; todo-continuation consume solo la salida como respuesta (nunca una reversion) y el mensaje de usuario como interrupcion. Los demas efectos de `message.updated` quedan cubiertos: agente y modelo de sesion via `createSessionAgentResolver` y el modelo enviado en `model.request`; la invalidacion del cache de uso de contexto no aplica porque V2 no tiene cache de truncator (la compactacion lee el transcript); el fallback por error del asistente lo cubren `session.execution.failed` y `session.error`, demostrado en vivo. El unico consumidor de `message.removed` (`restoreBackgroundOutputConsumption`) no aplica: V2 no publica `background_output` con cursor y entrega un unico handoff. `features/team-mode/messaging-*` no consume eventos de mensaje: usa `session.idle`, `session.error`, `session.deleted` y el storage del mailbox. openclaw queda sin consumidor en este perfil (sin config), y el mirror TUI queda sin consumidor nativo: ese port se retiro el 2026-10-14 y la reescritura futura del sidebar sigue pendiente (fila `tui-sidebar`).",
    futureEvidence: "`rigel-v2-native-activity.mjs`; `rigel-v2-tmux-viz-polling.mjs`; `rigel-v2-tmux-viz-polling.test.mjs`; `rigel-v2-native-notification-core.mjs`; `rigel-v2-native-todo-continuation.mjs`; `rigel-v2-native.mjs`; `rigel-v2-native-model-chains.mjs`; `.omo/evidence/20261006-t36-message-events/task-36.txt`; `.omo/evidence/20261006-t36-message-events/e3-tool-verdicts.json`",
  },
  "event-error-utils": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "La normalización V1 viaja con el fallback reactivo nativo, que conserva estado por sesión y selecciona el siguiente modelo desde la cadena resuelta en vez de volver a parsear texto de proveedor.",
    futureEvidence: "`rigel-v2-native.mjs`; `rigel-v2-native-model-chains.mjs`; `rigel-v2-native-runtime.test.mjs`",
  },
  "event-hook-dispatcher": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "`plugin/event-hook-dispatcher.ts` solo resuelve el sessionID y ejecuta los hooks de evento con aislamiento de errores; es plomería de despacho, no un handler de comportamiento.",
    futureEvidence: "Suscripción única y despacho aislado en `rigel-v2-native.mjs`; `rigel-v2-native-runtime.test.mjs`",
  },
  "event-model-fallback": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "`plugin/event-model-fallback.ts` implementa el fallback reactivo sobre errores de sesión; se adapta a la suscripción de eventos nativa de V2 y a las cadenas de `model-core`, como exige la tarea de fallback.",
    futureEvidence: "`rigel-v2-native.mjs` (applyReactiveFallback sobre session.error/execution.failed); `rigel-v2-native-model-chains.mjs`",
  },
  "event-model-fallback-state": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "`plugin/event-model-fallback-state.ts` solo mantiene el estado de continuación y deduplicación del fallback reactivo; es soporte de construcción que viaja con el handler de fallback.",
    futureEvidence: "contract:rigel-v2-native.mjs (sessionFallback map, limpiado en session.deleted)",
  },
  "event-session-lifecycle": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "`plugin/event-session-lifecycle.ts` maneja created/deleted/idle/error y el estado de sesión; se adapta a los eventos nativos de V2 que el runtime nativo ya consume para el handoff de background.",
    futureEvidence: "`rigel-v2-native-session-state.mjs`; `rigel-v2-native-phase4-events.mjs`; `rigel-v2-native-runtime.test.mjs`",
  },
  "event-team-handlers": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "`plugin/event-team-handlers.ts` cablea los cuatro handlers de team mode (orphan, member error, member status, idle wake hint); se adapta a los eventos nativos de V2 porque team mode se migra completo.",
    futureEvidence: "`rigel-v2-team-events.mjs`; `rigel-v2-team-events.test.mjs`; `rigel-v2-native.mjs` (bucle de eventos compartido)",
  },
  "event-types": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "`plugin/event-types.ts` solo declara los tipos de entrada y salida del handler de eventos; es una superficie de tipos sin comportamiento de runtime.",
    futureEvidence: "Tipos sustituidos por el contrato del contexto V2; no existe comportamiento de runtime que portar.",
  },
  hooks: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "`plugin/hooks/` compone los tiers Session, ToolGuard, Transform, Continuation y Skill que el runtime nativo V2 debe reproducir; se migra completo con equivalencia demostrada por el oráculo diferencial.",
    futureEvidence: "`rigel-v2-native-flow-rules.mjs`; `rigel-v2-native-hook-chain.mjs`; `rigel-v2-native-runtime.test.mjs`",
  },
  "messages-transform": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "`plugin/messages-transform.ts` corre sobre `experimental.chat.messages.transform` (mapeado a `ctx.session.hook(\"context\", ...)`), encadena los inyectores y al final repara la cola assistant-prefill. T19 reubico los inyectores a los hooks `context`/`http.request`. T27 completa UNICAMENTE los dos efectos que el owner V1 actual todavia realiza, en el modulo puro `rigel-v2-native-message-repair.mjs` cableado en el hook `context` de `rigel-v2-native.mjs`: (a) validacion y reparacion de pares de herramienta en la forma real V2 (`tool-call`/`tool-result` en `content[]`), delegando la forma legacy Chat Completions al `repairChatToolPairs` existente para no duplicar; el owner V1 asienta el estado terminal de la tool part, y en V2 (sin estado de part) el equivalente es insertar el `tool-result` terminal; (b) reparacion de la cola assistant-prefill (`ensureUserTurnAfterAssistantTail`) con el gate de modelo V1 conservado. La validacion de thinking blocks NO se porta: el hook proactivo V1 fue reducido a no-op (733f141bb) y eliminado en 9a16b54e4, por lo que el owner V1 actual no tiene efecto saliente de thinking, y la normalizacion de reasoning pertenece al transform del proveedor V2 (`anthropic-messages.js:790-816`), observado en experimento binario (reasoning firmado llega como `thinking`; reasoning sin firma llega como `text`), no como efecto de plugin. Un historial valido queda byte-identico y cada reparacion se hace observable con log y recibo de estado (solo conteos).",
    futureEvidence: "`rigel-v2-native-message-repair.mjs`; `rigel-v2-native-message-repair.test.mjs`; `rigel-v2-native.mjs` (hook context); `.omo/evidence/20261007-t27-thinking-prefill/task-27.txt`",
  },
  "native-skills": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "`plugin/native-skills.ts` carga las skills nativas del host V2 y alimenta el descubrimiento perezoso de skill/delegate; se porta a la superficie nativa de skills del runtime V2.",
    futureEvidence: "`rigel-v2-native-skills.mjs` (registerNativeSkills); `rigel-v2-native.mjs`",
  },
  "normalize-tool-arg-schemas": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "`plugin/normalize-tool-arg-schemas.ts` solo coacciona los esquemas de argumentos de herramientas a una forma normalizada; es plomería de registro sin comportamiento de runtime propio.",
    futureEvidence: "contract:rigel-v2-native-core.mjs (normalizeToolDefinition); contract:rigel-v2-native-tool-args.test.mjs",
  },
  "recent-synthetic-idles": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "`plugin/recent-synthetic-idles.ts` solo deduplica eventos idle sintéticos recientes para el handler de eventos; es soporte de construcción sin superficie de runtime propia.",
    futureEvidence: "`createNativeIdleGate` en `rigel-v2-native-phase4-events.mjs`; `rigel-v2-native-phase4-events.test.mjs`",
  },
  "runtime-skill-resolver": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "`plugin/runtime-skill-resolver.ts` lee las skills del config fusionado en runtime para descubrir fuentes que otros plugins agregan; se porta a la superficie nativa de skills de V2.",
    futureEvidence: "`rigel-v2-native-skills.mjs` (createRuntimeHostSkillSource); `rigel-v2-native-skills.test.mjs`",
  },
  "session-agent-resolver": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "`plugin/session-agent-resolver.ts` solo resuelve qué agente posee una sesión leyendo sus mensajes; es un helper de construcción que consumen los guards de herramientas.",
    futureEvidence: "`createSessionAgentResolver` en `rigel-v2-native.mjs`; `rigel-v2-native-runtime.test.mjs`",
  },
  "session-compacting": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "`plugin/session-compacting.ts` preserva contexto y todos en la compactación, pero V2 no tiene mapeo verificado para `experimental.session.compacting`; se adapta en la frontera `http.request` del resumen.",
    futureEvidence: "contract:rigel-v2-native-compaction-context.mjs; contract:rigel-v2-native-compaction-context.test.mjs; contract:qa-v2-compaction-hook-contract.mjs",
  },
  "session-status-normalizer": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "`plugin/session-status-normalizer.ts` solo normaliza `session.status` idle a `session.idle` entre versiones de OpenCode; es plomería de normalización sin comportamiento propio.",
    futureEvidence: "V2 emite `session.idle` nativamente; `createNativeIdleGate` normaliza la variante `session.status` si aparece.",
  },
  "skill-context": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "`plugin/skill-context.ts` solo descubre y fusiona skills para construir el contexto compartido con la creación de herramientas; es soporte de construcción sin superficie de runtime.",
    futureEvidence: "contract:rigel-v2-native-skills.mjs; contract:rigel-v2-native-skills.test.mjs",
  },
  "stop-continuation": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "`plugin/stop-continuation.ts` detiene keyword detector, guard de continuacion, enforcer de todos y goal para una sesion. En V2: el keyword se limpia en la frontera del request (`rigel-v2-keyword-seam.mjs`), el guard marca la sesion detenida, cancela descendientes y escribe el marcador `stop` (`rigel-v2-native-request-steps.mjs` + `rigel-v2-background-manager.mjs`), y el apagado del goal (`goal.clearGoal`) esta implementado en el `onStop` del runtime (`rigel-v2-native.mjs`, mutacion del ledger). Gap restante: el enforcer de todos y el estado boulder (T22, Fase 5).",
    futureEvidence: "contract:rigel-v2-native-request-steps.mjs; contract:rigel-v2-background-manager.mjs; contract:rigel-v2-native.mjs (onStop + goalController.clearGoal)",
  },
  "system-transform": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "`plugin/system-transform.ts` reconcilia el prompt de Sisyphus y restaura ultrawork a nivel de sistema. El runtime nativo lo adapta al hook `context`: la restauracion de ultrawork vive en `rigel-v2-native-prompt.mjs` y la reconciliacion del prompt de Sisyphus por modelo de runtime ya esta implementada (generador hornea el cuerpo por modelo exacto resoluble; `rigel-v2-native-sisyphus-prompt.mjs` intercambia en `event.system` con cache por modelo; modelo fuera del conjunto -> recibo observable). Ambos efectos V1 quedan cubiertos.",
    futureEvidence:
      "`rigel-v2-native-prompt.mjs`; `rigel-v2-native-sisyphus-prompt.mjs`; `rigel-v2-native-prompt.test.mjs`; `rigel-v2-native-sisyphus-prompt.test.mjs`; `agents/sisyphus-runtime-prompt-reconciler` (Migrado)",
  },
  "tool-definition": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "El unico override de V1 (`hooks/todo-description-override`: `todowrite` -> `TODOWRITE_DESCRIPTION`) se aplica ahora al CONSTRUIR la definicion que el runtime nativo crea (`NATIVE_TOOL_DESCRIPTION_OVERRIDES` + `applyNativeToolDescriptionOverride` en `rigel-v2-native-todo-description.mjs`, registrada por `registerNativeTodoTool`), no mutando una definicion del host. El contrato positivo/negativo del editor prueba que `todowrite` lleva el texto V1 byte-identico y que una tool del host pre-sembrada queda intacta (cero `update`/`remove`). El gate `tool.definition` deja de reportarse: no existe emisor en el runtime y la frontera documentada se actualiza.",
    futureEvidence:
      "`rigel-v2-native-todo-description.mjs`; `rigel-v2-native-todo-description.test.mjs`; `rigel-v2-native.mjs`; `qa-v2-t31-surface-walls.mjs`; `.omo/evidence/20261008-t31-surface-walls/`",
  },
  "tool-execute-after": {
    classification: "Migrar",
    rationale:
      "`plugin/tool-execute-after.ts` runs truncation, comment-checker, hashline read tagging and error recovery; the native `execute.after` hook registered by `rigel-v2-native.mjs` now invokes recovery (edit + JSON), the comment-checker (real binary) and the plan-format validator, on top of the reminders and rules already migrated.",
    status: "Migrado",
    futureEvidence: ".omo/evidence/20261004-phase4-task18-guards/task-18.txt",
  },
  "tool-execute-before": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "Los guards V1 se entregan sobre `tool.execute.before`: la cadena existente protege escritura y reglas, y `createNativeToolBeforeRules` normaliza el prefijo MCP, elimina bytes nulos de bash y bloquea el polling `sleep` mientras hay trabajo background activo.",
    futureEvidence: "`rigel-v2-native-tool-before.mjs`; `rigel-v2-native-tool-before.test.mjs`; `rigel-v2-native-runtime.test.mjs`",
  },
  "tool-registry": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "`plugin/tool-registry.ts` ensambla el registro de herramientas con sus gates de configuración; se migra al registro nativo de V2 respetando cada gate en runtime.",
    futureEvidence: "`rigel-v2-native-tools.mjs`; `rigel-v2-native-conditional-tools.mjs`; `rigel-v2-native.mjs`",
  },
  "tool-registry-core-tools": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "`plugin/tool-registry-core-tools.ts` construye las herramientas base (grep, glob, sesión, background, task, skill); se migra al registro nativo de V2 con la semántica V1.",
    futureEvidence: "`rigel-v2-native-tools.mjs`; `rigel-v2-native.mjs`",
  },
  "tool-registry-factories": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "`plugin/tool-registry-factories.ts` solo agrupa las fábricas de herramientas en un objeto inyectable; es plomería de construcción sin comportamiento de runtime propio.",
    futureEvidence: "contract:rigel-v2-native-tools.mjs; contract:rigel-v2-native-tools.test.mjs",
  },
  "tool-registry-gated-tools": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "`plugin/tool-registry-gated-tools.ts` arma las familias condicionales (task system, hashline, monitor, goal); se migra al registro nativo de V2 respetando cada gate de configuración.",
    futureEvidence: "`rigel-v2-native-conditional-tools.mjs`; `rigel-v2-native-conditional-tools.test.mjs`",
  },
  "tool-registry-team-tools": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "`plugin/tool-registry-team-tools.ts` arma las doce herramientas de team mode y el override de modelo de Sisyphus-Junior; se migra al registro nativo de V2 porque team mode se migra completo.",
    futureEvidence: "`tools/team.tools.mjs`; `rigel-v2-native-conditional-tools.mjs`; `rigel-v2-team-events.mjs`; `rigel-v2-team-events.test.mjs`",
  },
  "tool-registry-trimming": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "`plugin/tool-registry-trimming.ts` solo recorta el registro cuando se fija `experimental.max_tools`; es plomería de construcción sin comportamiento de runtime propio.",
    futureEvidence: "`rigel-v2-native-tool-trimming.mjs`; `rigel-v2-native-tool-trimming.test.mjs`; `rigel-v2-native-conditional-tools.mjs`; `rigel-v2-native-config.mjs` (readNativeMaxTools)",
  },
  "ultrawork-db-model-override": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "`plugin/ultrawork-db-model-override.ts` programa un override de modelo a nivel de base de datos para ultrawork; se adapta a la mutación del cuerpo real de la petición en la frontera `http.request` de V2.",
    futureEvidence: "contract:rigel-v2-native-request-steps.mjs; contract:rigel-v2-native-request-steps.test.mjs; contract:rigel-v2-native-reasoning-options.mjs",
  },
  "ultrawork-model-override": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "`plugin/ultrawork-model-override.ts` detecta ultrawork y aplica el override de modelo y variante por mensaje; se adapta a la frontera `http.request` porque V2 fija la variante antes de esa frontera.",
    futureEvidence: "contract:rigel-v2-native-reasoning-options.mjs; contract:rigel-v2-native-reasoning-options.test.mjs; contract:qa-v2-reasoning-variant-mechanism.mjs",
  },
  "ultrawork-variant-availability": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "`plugin/ultrawork-variant-availability.ts` solo consulta los proveedores para validar que una variante de ultrawork existe; es soporte de construcción del override de modelo.",
    futureEvidence: "contract:rigel-v2-native-model-chains.mjs; contract:rigel-v2-native-categories.mjs",
  },
  "unstable-agent-babysitter": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El babysitter V1 detecta subagentes inestables y fuerza fallback/abort. El port nativo: el first-prompt watchdog vive en `rigel-v2-native-phase4-events.mjs` (sesiones hijas sin progreso) y el reintento de delegacion en `rigel-v2-delegate-retry-core.mjs` + `rigel-v2-background-retry.mjs`, con la misma reaccion (reintentar con el siguiente escalon o abortar).",
    futureEvidence: "`rigel-v2-native-phase4-events.mjs`; `rigel-v2-delegate-retry-core.mjs`; `rigel-v2-background-retry.mjs`; `rigel-v2-background-manager.test.mjs`",
  },
}
