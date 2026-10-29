// Clasificación de migración de los hooks V1 con destino pendiente (tarea 7).
// Cada fila mapea el hook V1 a Migrar, Adaptar, Equivale a builtin V2 o
// Interno de build (sin superficie de runtime), con su rationale y la evidencia
// futura (tarea, contrato o gate) que demostrará la equivalencia.
export default {
  "agent-usage-reminder": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El hook V1 en `hooks/agent-usage-reminder/` decora el resultado de una herramienta de búsqueda o fetch dirigida a un agente orquestador, se detiene tras usar una herramienta de delegación y limita el aviso a tres veces por sesión. El reemplazo nativo en `rigel-v2-native-reminders.mjs` reproduce el conjunto exacto de orquestadores, el mensaje byte a byte, el tope de MAX 3, el conteo de diez herramientas no-task y la persistencia por sessionID mediante storage inyectado (get/set/delete), con la continuidad tras reinicio comprobada por prueba.",
    futureEvidence: "`rigel-v2-native-reminders.mjs`; `rigel-v2-native-reminders.test.mjs`",
  },
  "anthropic-context-window-limit-recovery": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "La recuperación V1 ante límite de contexto se adapta a `ctx.session.compact`: `rigel-v2-native-phase4-events.mjs` reconoce el error de límite, solicita una compactación V2 una sola vez por incidente y libera el dedupe al terminar o borrar la sesión.",
    futureEvidence: "`rigel-v2-native-phase4-events.mjs`; `rigel-v2-native-phase4-events.test.mjs`; OpenCode V2 Plugins API: `ctx.session.compact`",
  },
  "ast-grep-sg-provision": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "unwired upstream",
    rationale:
      "La provision V1 en `hooks/ast-grep-sg-provision/hook.ts` asegura el binario sg que consume la skill ast-grep; el perfil gabo no incluye la skill ast-grep y skills-loader-core no la expone como builtin del bundle nativo, asi que la provision no tiene consumidor en este perfil y queda desconectada hasta que la skill viaje con el kit.",
    futureEvidence: "contract:profiles/gabo/skills (sin skill ast-grep en el kit); packages/skills-loader-core",
  },
  atlas: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El trabajo Atlas V1 se entrega por `/ulw-execute` con estado boulder durable y por la continuación nativa de idle: `rigel-v2-native-phase4-events.mjs` detecta trabajo background activo del orquestador y entrega una continuación sintética mediante la API V2.",
    futureEvidence: "`rigel-v2-ulw-execute.mjs`; `rigel-v2-ulw-execute.test.mjs`; `rigel-v2-native-phase4-events.mjs`; `rigel-v2-native-phase4-events.test.mjs`",
  },
  "auto-slash-command": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El ejecutor V1 en `hooks/auto-slash-command/hook.ts` detecta y ejecuta comandos embebidos en el mensaje del usuario, cubriendo los comandos de skill y de plugin. El puerto nativo corre sobre el seam oficial de admisión de prompts de V2 (`ctx.session.hook(\"prompt\")`, draft canónico mutable), con detector, ejecutor, dedupe y el puente skill-command propios.",
    futureEvidence:
      "`rigel-v2-auto-slash-command-bridge.mjs`; `rigel-v2-auto-slash-command-bridge.test.mjs`; `rigel-v2-native.mjs` (hook prompt); `live-qa/wave3-auto-slash.md`",
  },
  "auto-update-checker": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "Efecto V1 portado: aviso no bloqueante de una version publicada mas nueva, consultando el registry npm al arranque con cache durable en `ctx.storage` y como maximo un chequeo por dia (el intento se registra, asi un fallo no re-chequea en bucle). El paquete y el registry son los de V1 (`oh-my-openagent` dist-tags) y la version actual es la del build empaquetado materializada en el manifiesto; el runtime nunca instala. El aviso llega al body del proveedor por `event.system` (patron del roster, con marcador propio e idempotente, solo en sesion raiz). Fallo de red o version irresoluble degradan a silencio funcional con log y recibo durable (`update-check.json`). Adaptado de `hooks/auto-update-checker/{hook,checker,version-channel,constants}.ts`.",
    futureEvidence:
      "`rigel-v2-native-update-core.mjs`; `rigel-v2-native-update-state.mjs`; `rigel-v2-native-update-checker.mjs`; `rigel-v2-native-update-checker.test.mjs`; `rigel-v2-native-prompt.mjs`; `qa-v2-t31-surface-walls.mjs`; `.omo/evidence/20261008-t31-surface-walls/`",
  },
  "category-skill-reminder": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El recordatorio V1 en `hooks/category-skill-reminder/` avisa cargar skills tras tres herramientas delegables sin delegar, una vez por sesión. El reemplazo nativo en `rigel-v2-native-category-skill-reminder.mjs` conserva el conjunto de agentes objetivo, el umbral de tres, la supresión por delegación, el formateador byte a byte y el consumo único; `rigel-v2-native-prompt.mjs` lee `pending` y llama `consume` en la frontera http.request del orquestador sin mutar el resultado de la herramienta.",
    futureEvidence: "`rigel-v2-native-category-skill-reminder.mjs`; `rigel-v2-native-category-skill-reminder.test.mjs`; `rigel-v2-native-prompt.mjs`",
  },
  "claude-code-hooks": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El despachador V1 se adapta con `createNativeClaudeCodeHooks`, que registra prompt, compactación y hooks before/after de herramientas y consume SessionStart/Stop desde la suscripción V2; sus salidas de prompt llegan al colector de contexto nativo.",
    futureEvidence:
      "`rigel-v2-claude-code-hooks.mjs`; `rigel-v2-claude-code-hooks.test.mjs`; `rigel-v2-context-collector.mjs`",
  },
  "compaction-context-injector": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "El hook V1 inyecta la plantilla de contexto de 8 secciones mas el historial de sesiones delegadas en el pedido de resumen de la compactacion, captura el agent/model/tools antes de compactar y los restaura tras la compactacion. Experimento A (drive hermetico qa-v2-t21-compaction-experiment.mjs, 2026-10-06): en V2.0.22 la mutacion de event.system en el hook compaction NO llega al proveedor (contrato previo), pero la mutacion de event.messages SI llega al body del resumen (marcador capturado; kind \"compaction\" observable en http.request) -> estrategia A1. El contenido viaja como V2 message parts (el shape string crashea SessionModelRequest.prepare). EFECTO 1: port completo en `rigel-v2-native-compaction-context.mjs` (plantilla byte-port + formatDelegatedSessionHistory con limites V1 20/240/6000 + formatForCompaction sobre el background manager) cableado en rigel-v2-native.mjs con dispose; contrato re-graduado qa-v2-compaction-hook-contract.mjs (deuda 2026-10-03 de expectativas invertidas corregida) afirma la propagacion positiva con el runtime nativo real. EFECTO 2: Experimento B demostro que el host V2 preserva agent y tools del request primario a traves de la compactacion (pre/post hasTaskTool true, session agent estable) -> el checkpoint V1 equivale a builtin V2; la restauracion de ultrawork/roster/reglas/directorio ya corre nativamente (eventos de compactacion + keyword seam + clear/reinject) y quedo cubierta por regresion. Refinamientos 2026-10-06: (1) disparador redundante de restauracion en el boundary http.request (`noteCompactionRestoration` sobre la heuristica del resumen y/o kind \"compaction\") que marca needsRestoration en el keyword state independientemente del stream de eventos (volatil por contrato: overflow y eventos perdidos en desconexion, opencode.ai/v2/docs/api event.subscribe); (2) drivers deterministas con `POST /api/experimental/session/{id}/wait` (disponible en el binario: wait-endpoint) en lugar de sleep-polling fijo. disabled_hooks deja de listar el hook (siempre-on como V1).",
    futureEvidence:
      "`rigel-v2-native-compaction-context.mjs`; `rigel-v2-native-compaction-context.test.mjs`; `rigel-v2-background-manager.mjs` (formatForCompaction); `rigel-v2-native.mjs` (hook compaction + trigger redundante http.request + dispose); `qa-v2-t21-compaction-experiment.mjs`; `qa-v2-compaction-hook-contract.mjs` (re-graduado); `.omo/evidence/20261006-t21-compaction/`",
  },
  "compaction-todo-preserver": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "El hook V1 en `hooks/compaction-todo-preserver/hook.ts` mantiene viva la lista de todos a traves de la compactacion: captura la instantanea detallada antes de compactar, la restaura en `session.compacted` solo cuando la lista posterior quedo vacia o con los dos todos de arranque de Atlas, protege la instantanea restaurada frente a un `todowrite` tardio que la degradaria y limpia ambos mapas en idle/delete. El port nativo `rigel-v2-native-compaction-todo-preserver.mjs` conserva los predicados byte a byte (coincidencia por id O por content), la tabla `ATLAS_BOOTSTRAP_TODOS` y la decision de restauracion, pero se retargeta al registro de todos respaldado por storage de V2 (`createV2SessionTodoStore` en `tools/session-todo-store.mjs`) en vez de `ctx.client.session.todo`; `rigel-v2-native.mjs` lo cablea en la compactacion (capture), en los eventos de compactacion (restore) y en el `beforeWrite` del store. La paridad de la tabla con el fuente V1 esta fijada por prueba.",
    futureEvidence:
      "`rigel-v2-native-compaction-todo-preserver.mjs`; `rigel-v2-native-compaction-todo-preserver.test.mjs`; `rigel-v2-native-todo-preserver-wiring.test.mjs`; `tools/session-todo-store.mjs`; `rigel-v2-native.mjs`",
  },
  "comment-checker": {
    classification: "Migrar",
    rationale:
      "V1 guard in `hooks/comment-checker/hook.ts` invokes the real binary (`check`, JSON on stdin, exit 0 clean / exit 2 comments); the native V2 runtime replicates the protocol from tool.execute.after against the cached binary (0.8.0 marker) and IMPLEMENTS both `// @allow` and `// comment-checker-disable-file` in the native layer, which the 0.8.0 binary does not honor by itself. Both bypasses are LIVE-PROVEN in the lab (file-disable vs control: control warned, disabled not; @allow: not warned) and covered by positive/negative contracts for write, edit and multiedit.",
    status: "Migrado",
    futureEvidence: ".omo/evidence/20261004-phase4-task18-guards/task-18.txt",
  },
  "delegate-task-retry": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El reintento V1 en `hooks/delegate-task-retry/hook.ts` reintenta delegaciones fallidas sobre el resultado de la herramienta. El core puro `rigel-v2-delegate-retry-core.mjs` porta el clasificador de fallos y la decision de reintento, y `rigel-v2-native-flow-after.mjs` lo monta como regla `tool.execute.after` compuesta en `rigel-v2-native-flow-rules.mjs`; la secuencia observada del runtime incluye `delegate-task-retry` en la cadena after.",
    futureEvidence:
      "`rigel-v2-native-flow-after.mjs`; `rigel-v2-delegate-retry-core.mjs`; `rigel-v2-native-flow-after.test.mjs`; `rigel-v2-delegate-retry-oracle.test.mjs`",
  },
  "directory-agents-injector": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El hook V1 en `hooks/directory-agents-injector/` descubre los `AGENTS.md` aplicables a una lectura y los anexa al resultado de lectura (`output.output +=`). El reemplazo nativo en `rigel-v2-directory-instructions.mjs` reproduce el recorrido hacia arriba con `skipRoot`, el orden raiz primero, la contencion canonica por realpath, la deduplicacion por directorio y la truncacion por tokens, y anexa el sobre `<rigel-native-directory-agents>` al mismo resultado de lectura en `tool.execute.after`.",
    futureEvidence: "`rigel-v2-directory-instructions.mjs`; `rigel-v2-directory-instructions.test.mjs`",
  },
  "directory-readme-injector": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El hook V1 en `hooks/directory-readme-injector/` conserva los `README.md` aplicables a una lectura y los anexa al resultado de lectura. El mismo almacen nativo en `rigel-v2-directory-instructions.mjs` recorre los README incluido el de la raiz del workspace, aplica el orden raiz primero, la deduplicacion por directorio y la truncacion por tokens, y anexa el bloque al mismo resultado de lectura en `tool.execute.after`.",
    futureEvidence: "`rigel-v2-directory-instructions.mjs`; `rigel-v2-directory-instructions.test.mjs`",
  },
  "fsync-skip-warning": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El aviso V1 en `hooks/fsync-skip-warning/index.ts` advierte cuando se omite fsync en una escritura atomica. `rigel-v2-native-flow-after.mjs` monta las reglas `fsync-skip-warning:record-start` (before) y `fsync-skip-warning` (after) sobre el clasificador puro de `rigel-v2-flow-logic.mjs`, con un unico tracker inyectado por `createFlowRules`.",
    futureEvidence:
      "`rigel-v2-native-flow-after.mjs`; `rigel-v2-flow-logic.mjs`; `rigel-v2-native-flow-after.test.mjs`; `rigel-v2-flow-logic.test.mjs`",
  },
  goal: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El objetivo persistente V1 en `hooks/goal/index.ts` gobierna la continuidad por idle y el uso por sesión; se migra al runtime nativo V2 con estado por sessionID, suscripción al evento de idle y las herramientas create_goal, update_goal y get_goal bajo el gate goal.enabled.",
    futureEvidence: "tools/goal.tools.mjs; rigel-v2-native.mjs (comando goal + onStop); rigel-v2-native-conditional-tools.mjs; live-qa/wave1-goal.md",
  },
  "hashline-read-enhancer": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El enhancer V1 en `hooks/hashline-read-enhancer/hook.ts` etiqueta cada lectura con LINE#ID. La superficie V2 mutable de `tool.execute.after` permite portarlo directamente: `createHashlineReadEnhancer` en `rigel-v2-native-hashline.mjs` reescribe el contenido del resultado de lectura (cabecera `Read file ...` incluida) con LINE#ID y reescribe el marcador de escritura. La paridad con `hashline-core` de V1 está fijada por prueba y la ejecución viva lo comprueba en la sesión del laboratorio.",
    futureEvidence: "`rigel-v2-native-hashline.mjs`; `rigel-v2-native-hashline.test.mjs`",
  },
  "interactive-bash-session": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "La sesión V1 en `hooks/interactive-bash-session/hook.ts` gestiona el ciclo de vida tmux de interactive_bash; se migra al runtime nativo V2 cuando tmux está disponible, replicando el tracker y el estado por sesión.",
    futureEvidence: "`tools/interactive-bash.tools.mjs`; `rigel-v2-native-conditional-tools.mjs`",
  },
  "json-error-recovery": {
    classification: "Equivale a builtin V2",
    status: "Migrado",
    rationale:
      "V1 hook `hooks/json-error-recovery/hook.ts` appends a model-visible reminder when a tool result carries a JSON parse error. In V2 the host plugin `opencode.tool.input.repair` (decompiled from the v2.0.22 binary) normalizes tool arguments at execute.before ONLY in the string-to-type direction: stringified objects/arrays are parsed and string numbers/booleans are coerced. The opposite direction is NOT normalized: live evidence on NLS1 shows a number or an object supplied for a string argument is REJECTED by argument validation (`Invalid arguments for tool \"read\": - path: Expected string`, error type `tool.execution`) and the tool does not execute, so no JSON-parse-error tool result exists to observe. RAW lab evidence (opencode-v2-lab.service): over real sessions every tool call arrives as a parsed object; the model never emits string/malformed arguments (explicit attempts refused); and a JSON string injected by the runtime's execute.before was NOT repaired and the tool errored, so the native hook cannot be the observer and has no trigger. The V1-shaped extraction is retained only as a defensive after-result fallback. Live observables: `.omo/evidence/20261016-v2-release-closure-c5a/raw/c-num-context.json`, `.omo/evidence/20261016-v2-release-closure-c5a/raw/c-obj-context.json`.",
    futureEvidence: ".omo/evidence/20261004-phase4-task18-guards/json-input-recovery/; .omo/evidence/20261016-v2-release-closure-c5a/raw/c-num-context.json; .omo/evidence/20261016-v2-release-closure-c5a/raw/c-obj-context.json",
  },
  "keyword-detector": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El detector V1 en `hooks/keyword-detector/` decide e inyecta las guias de `ultrawork`/`ulw`, team mode, `hyperplan` y el combo `hyperplan`+`ultrawork`. El core puro `rigel-v2-keyword-core.mjs` reproduce el orden de filtros, las regexes exactas (incluidas la negacion `interface.hpp` y la correccion de `ultraworker`), la interseccion de deshabilitados, la allowlist, la supresion del combo, el enrutado por fuente (planner/gpt/gemini/glm/default), el replay y la restauracion tras compactacion. `rigel-v2-native-keyword-seam.mjs` lo enlaza a la frontera verificada `http.request` de V2 sobre `body.messages[role=user].content`, con `rigel-v2-keyword-state.mjs` (tope 256 FIFO, clear en `session.deleted`) y los cuerpos V1 por tipo staged desde `rigel-v2-native-prompt.mjs`; el drive staged prueba la cadena completa.",
    futureEvidence:
      "`rigel-v2-keyword-core.mjs`; `rigel-v2-keyword-state.mjs`; `rigel-v2-native-keyword-seam.mjs`; `rigel-v2-native-prompt.mjs`; `rigel-v2-keyword-core.test.mjs`; `rigel-v2-keyword-state.test.mjs`; `rigel-v2-native-prompt.test.mjs`",
  },
  "legacy-plugin-toast": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El aviso V1 en `hooks/legacy-plugin-toast/hook.ts` detectaba y migraba un entrypoint legacy; como el contrato V2 NORMALIZA la config en memoria sin reescribirla, el port conserva la deteccion + el aviso y elimina la reescritura de archivo. `rigel-v2-native-legacy-plugin-notice.mjs` (puro) detecta `oh-my-opencode`/`@*`; `rigel-v2-native-cli-legacy-notice.mjs` suscribe `session.created` (raiz only), muestra el toast V1 (`warning`, 10000 ms) y escribe un recibo durable; jamas escribe un config. Contrato positivo/negativo (deteccion, hijo, una vez por proceso).",
    futureEvidence: "`rigel-v2-native-legacy-plugin-notice.mjs`; `rigel-v2-native-cli-legacy-notice.mjs`; `rigel-v2-native-legacy-plugin-notice.test.mjs`; `rigel-v2-native-cli-legacy-notice.test.mjs`; `rigel-v2-native-cli.mjs` (composicion ./tui)",
  },
  "model-fallback": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "La cadena proactiva V1 en `hooks/model-fallback/hook.ts` reescribe el modelo en chat.params; se migra resolviendo la cadena por agente en la frontera http.request del runtime nativo V2 y reescribiendo el campo model del payload. Un modelo explicito del usuario suprime la cadena built-in (upstream 5a9bb74a4): `rigel-v2-native-explicit-chain.mjs` devuelve solo la cadena `fallback_models` del usuario (o vacia) para un agente/categoria explicitos, y la cadena built-in cuando no hay override.",
    futureEvidence: "`rigel-v2-native-explicit-chain.mjs`; `rigel-v2-native-model-chains.mjs`; `rigel-v2-native-model-chains.test.mjs`; `rigel-v2-native.mjs` (fallback proactivo en model.request y reactivo en session.error)",
  },
  "monitor-status-injector": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El inyector V1 en `hooks/monitor-status-injector/hook.ts` añade el estado de los monitores vigilados al turno. El port nativo `createNativeMonitorStatusInjector` (`rigel-v2-monitor-status.mjs`) consume el registro real de monitores (`tools/monitor-engine.mjs`) sobre el hook `context` de V2, tras los inyectores team y bajo el gate `monitor.enabled`: filtra los monitores activos (`running`/`starting`), compone la linea V1 `Active monitors: ... - call monitor_stop to stop` sin exponer el comando crudo, refresca el bloque existente in situ o lo antepone al ultimo mensaje de usuario real, y es no-op con cero monitores activos o gate apagado. El runtime construye y verifica la API de servidor (`createServerApi`/`verifyIdentity`) que da de alta el registro y las herramientas `monitor_*`.",
    futureEvidence:
      "`rigel-v2-monitor-status.mjs`; `rigel-v2-monitor-status.test.mjs`; `rigel-v2-monitor-status-wiring.test.mjs`; `rigel-v2-native.mjs` (hook context); `tools/monitor-engine.mjs`",
  },
  "native-edition-nudge": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El nudge V1 en `hooks/native-edition-nudge/hook.ts` decide y muestra un aviso de una sola vez. `rigel-v2-native-nudge-core.mjs` porta la escalera de supresion completa (opted-out, ya-migrado, no-interactivo, hijo, mostrado-este-proceso, estado-no-escribible, corrupto+3d, tope de por vida=4, no-elegible, mostrar con [3,7,14]d clamp 14d) y `rigel-v2-native-nudge-state.mjs` el estado durable v1; `rigel-v2-native-cli-nudge.mjs` compone el toast de inicio (encendido por defecto, kill switch `nativeEditionNudge.enabled=false`). Contrato positivo/negativo por rama + estado.",
    futureEvidence: "`rigel-v2-native-nudge-core.mjs`; `rigel-v2-native-nudge-state.mjs`; `rigel-v2-native-cli-nudge.mjs`; `rigel-v2-native-nudge.test.mjs`; `rigel-v2-native-cli-nudge.test.mjs`",
  },

  "bash-file-read-guard": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "El guard V1 (`hooks/bash-file-read-guard.ts`) avisa cuando un comando bash simple usa cat/head/tail para leer un archivo, prefiriendo la tool Read. El port nativo `rigel-v2-native-tool-guards.mjs` reproduce el mensaje V1 byte a byte y los tres patrones exactos como regla `tool.execute.before`; como V2 no admite un mensaje en `execute.before` (probado para el guard non-interactive), la advertencia se hace observable prefijando el comando con un echo a stderr y preservando la lectura. Contrato positivo/negativo y mutation RED/restore en `rigel-v2-native-tool-guards.test.mjs`.",
    futureEvidence: "`rigel-v2-native-tool-guards.mjs`; `rigel-v2-native-tool-guards.test.mjs`; `rigel-v2-native-flow-rules.mjs`; V1 `hooks/bash-file-read-guard.ts:6-20`; `.omo/evidence/20261007-t38-coverage-guards/mutations.txt`",
  },
  "empty-task-response-detector": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "El detector V1 (`hooks/empty-task-response-detector.ts`) advierte cuando una invocacion de task termina sin respuesta. El port nativo `rigel-v2-native-tool-guards.mjs` aplica la regla `tool.execute.after` al nombre nativo de delegacion (`rigel_task`/`RIGEL_NATIVE_TASK_NAME`) y a `task`, sustituye un resultado completado vacio por el bloque V1 byte a byte, y no toca resultados no vacios, errores ni otras tools. Contrato positivo/negativo y mutation RED/restore en `rigel-v2-native-tool-guards.test.mjs`.",
    futureEvidence: "`rigel-v2-native-tool-guards.mjs`; `rigel-v2-native-tool-guards.test.mjs`; `rigel-v2-native-flow-rules.mjs`; V1 `hooks/empty-task-response-detector.ts:5-19`; `.omo/evidence/20261007-t38-coverage-guards/mutations.txt`",
  },
  "tool-output-truncator": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "El truncador V1 (`hooks/tool-output-truncator.ts`) recorta la salida de grep/glob/lsp_diagnostics/interactive_bash/skill_mcp/webfetch sobre un limite de tokens (50k general, 10k webfetch). El port nativo `rigel-v2-native-tool-guards.mjs` conserva la lista TRUNCATABLE_TOOLS, los dos presupuestos, el truncador de 4 chars/token con 3 lineas de cabecera y el gate `experimental.truncate_all_tool_outputs` (materializado en config/manifiesto/lector y cableado desde `rigel-v2-native.mjs`). Contrato positivo/negativo incluyendo gate on/off y mutation RED/restore.",
    futureEvidence: "`rigel-v2-native-tool-guards.mjs`; `rigel-v2-native-tool-guards.test.mjs`; `rigel-v2-native-flow-rules.mjs`; `rigel-v2-native-config.mjs`; `rigel-v2-native.mjs`; `generate-v2-agents.mjs`; V1 `hooks/tool-output-truncator.ts:5-24`; `.omo/evidence/20261007-t38-coverage-guards/mutations.txt`",
  },
  "session-notification": {
    classification: "Equivale a builtin V2",
    status: "Migrado",
    rationale:
      "La notificacion V1 (`hooks/session-notification/`) avisa al usuario fuera del contexto del modelo al terminar el turno, al pedir permiso y al abrir una pregunta. En V2 esa superficie es del anfitrion: el notificador nativo de OpenCode V2 es el dueno del aviso, y el companion `./tui` de Rigel no compone ninguna superficie de notificacion ni registra un plugin equivalente. El perfil tampoco declara `notification` y la activacion no escribe el marcador `-opencode.notifications`, de modo que Rigel no notifica ni desactiva el builtin del anfitrion. La retirada es completa: `rigel-v2-native-cli-notification.mjs` y `rigel-v2-native-emission-guard.mjs` se eliminaron junto con sus pruebas exclusivas. `rigel-v2-native-notification-core.mjs` y `rigel-v2-native-todo-pending.mjs` se conservan porque tienen otros consumidores nativos, no porque emitan avisos.",
    futureEvidence: "`rigel-v2-native-notification-core.mjs`; `rigel-v2-native-todo-pending.mjs`; `sidebar-decoupling-audit.test.mjs` (composicion sin notifier); `notification-activation-config.test.mjs` (sin marcador); `qa-v2-user-install-contract.mjs`",
  },
  "preemptive-compaction": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "La compactacion preventiva V1 (`hooks/preemptive-compaction/`, gate experimental apagado por defecto) compacta antes del limite de contexto: mira los tokens del ultimo mensaje assistant, calcula `(input + cache.read) / limite real` y pide el resumen sobre el umbral 0.78 con cooldown de 60s. Dueno: T34 del plan maestro. El port nativo `rigel-v2-native-preemptive-compaction.mjs` conserva la matematica V1 (umbral, cooldown, `contextUsage`, resolver de limite Anthropic, recuperacion post-compactacion acotada por epoch y cap) y la cablea sobre los hooks V2 `context`/`compaction` + `ctx.session.compact`: el hook `context` lee el transcript via `ctx.session.context` (los assistant llevan `tokens`, mismo shape que `message.updated` en V1), resuelve el limite real desde la fila `model.list` `limit.context` mas las reglas Anthropic V1 y admite `session.compact` una sola vez por umbral; los eventos `session.compacted`/`session.compaction.ended` re-arman y arman el monitor de degradacion; `session.deleted` limpia. Un registro de incidencia compartido con el context-limit recovery reactivo (`rigel-v2-native-phase4-events.mjs`) impide dos compactaciones pendientes por sesion. Gate `experimental.preemptive_compaction` materializado en el manifiesto (apagado por defecto) y umbral propio configurable (`experimental.preemptive_compaction_threshold`) con fallback 0.78. QA viva en el lab con gate on/off/umbral y captura del request de resumen; contratos hermeticos de umbral, idempotencia, race, recovery, cleanup e isolation.",
    futureEvidence:
      "`rigel-v2-native-preemptive-compaction.mjs`; `rigel-v2-native-preemptive-compaction.test.mjs`; `rigel-v2-native-config.mjs` (gate/umbral); `rigel-v2-native-phase4-events.mjs` (incidencia compartida); `rigel-v2-native.mjs` (hook context + re-armado); `.omo/evidence/20261006-t34-preemptive-compaction/`",
  },

  "no-hephaestus-non-gpt": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El guard V1 en `hooks/no-hephaestus-non-gpt/hook.ts` restringe Hephaestus a modelos GPT; se migra con el gate de proveedor del roster V2 (requiresProvider e isHephaestusSupportedModel) al registrar el agente.",
    futureEvidence: "`rigel-v2-native-hephaestus.mjs`; `rigel-v2-native-hephaestus.test.mjs`",
  },
  "no-sisyphus-gpt": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El hook V1 en `hooks/no-sisyphus-gpt/hook.ts` (post-fix upstream 5fd04b590) redirige una sesion Sisyphus sobre un modelo GPT sin prompt nativo (`isGptModel && !isGptNativeSisyphusModel && !isGpt6Model`) a Hephaestus SOLO cuando Hephaestus esta en el roster REGISTRADO; si no, conserva Sisyphus con un aviso distinto y log, sin persistir un turno bajo un agente desconocido. `rigel-v2-native-no-sisyphus-gpt.mjs` porta la deteccion de modelo y la decision; el runtime lo aplica en el hook `context` (`rigel-v2-native.mjs`), usa `context.session.switchAgent` para el redirect (mismo seam que ulw-execute) y un aviso observable (`context.attention.notify`) mas recibo durable, nunca prompt-only. El estado previo de esta fila afirmaba un gate de cadena inexistente; se corrige.",
    futureEvidence: "`rigel-v2-native-no-sisyphus-gpt.mjs`; `rigel-v2-native-no-sisyphus-gpt.test.mjs`; `rigel-v2-native.mjs` (hook context + switchAgent); `rigel-v2-native-hephaestus.mjs` (roster gate)",
  },
  "notepad-write-guard": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El guard V1 en `hooks/notepad-write-guard/index.ts` bloquea escrituras a rutas de notepad append-only. `rigel-v2-native-flow-guards.mjs` monta la regla `notepad-write-guard` en `tool.execute.before` sobre la logica pura de rutas de `rigel-v2-flow-logic.mjs`, con la misma decision de bloqueo; la prueba de aislamiento del bastidor before la ejercita.",
    futureEvidence:
      "`rigel-v2-native-flow-guards.mjs`; `rigel-v2-flow-logic.mjs`; `rigel-v2-native-flow-guards.test.mjs`; `rigel-v2-flow-logic.test.mjs`",
  },
  "plan-format-validator": {
    classification: "Migrar",
    rationale:
      "V1 validator in `hooks/plan-format-validator/hook.ts` checks checkbox format in boulder plans; the native V2 runtime runs it in tool.execute.after on Write/Edit of `.omo/plans/*.md`, rewrites `**Effort:** <duration>` to its band and appends the malformed-row warning. Parity with `boulder-state` is pinned by test.",
    status: "Migrado",
    futureEvidence: ".omo/evidence/20261004-phase4-task18-guards/task-18.txt",
  },
  "prometheus-md-only": {
    classification: "Migrar",
    rationale:
      "V1 guard in `hooks/prometheus-md-only/hook.ts` restricts Prometheus to writing only .md files; the native V2 runtime runs it in tool.execute.before with the same path policy (`isAllowedFile`: confinement, `.omo` segment, `.md` extension) and the session-resolved agent matcher.",
    status: "Migrado",
    futureEvidence: ".omo/evidence/20261004-phase4-task18-guards/task-18.txt",
  },
  "question-label-truncator": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El truncador V1 en `hooks/question-label-truncator/hook.ts` acorta etiquetas largas de la herramienta de pregunta. `rigel-v2-native-flow-guards.mjs` aplica el mismo limite en `tool.execute.before` sobre la logica pura de `rigel-v2-flow-logic.mjs`.",
    futureEvidence:
      "`rigel-v2-native-flow-guards.mjs`; `rigel-v2-flow-logic.mjs`; `rigel-v2-native-flow-guards.test.mjs`; `rigel-v2-flow-logic.test.mjs`",
  },
  "read-image-resizer": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El redimensionador V1 real (`hooks/read-image-resizer/hook.ts`) se migra a la frontera V2 comprobada `session.hook(\"http.request\")` como `imageResizerStep` en `rigel-v2-native-request-steps.mjs`. El cuerpo saliente lleva las imagenes como data URL (`body.messages` chat, `body.input` responses); el gate V1 `providerID === \"anthropic\"` se conserva por defecto (`RIGEL_IMAGE_RESIZER_PROVIDERS` solo para QA viva) y `rigel-v2-native-image-resizer.mjs` decodifica, redimensiona y re-codifica con el `Bun.Image` del runtime (Bun 1.4.2 embebido en el binario V2.0.22) respetando los limites de 1568px y 5MB, con reintento de calidad para jpeg/webp. Los parsers y el calculo de dimensiones siguen anclados a los duenos V1.",
    futureEvidence:
      "`rigel-v2-native-image-resizer.mjs`; `rigel-v2-native-request-steps.mjs`; `rigel-v2-native-image-resizer.test.mjs`; `rigel-v2-native-request-steps.test.mjs`",
  },
  "rules-injector": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El hook V1 en `hooks/rules-injector/` descubre reglas de proyecto y de usuario y las anexa al resultado de la herramienta. El reemplazo nativo en `rigel-v2-native-rules.mjs` porta el descubrimiento por marcador de raíz, el recorrido por ancestros con orden por distancia, el parser de frontmatter, el matcher de globs, el truncador por tokens y la deduplicación por sesión con `clear` en compactación. La prueba fija la paridad del matcher con picomatch en modo dot+bash sobre un corpus de globs, clases de caracteres, llaves y negaciones.",
    futureEvidence: "`rigel-v2-native-rules.mjs`; `rigel-v2-native-rules.test.mjs`",
  },
  "runtime-fallback": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El fallback reactivo V1 reacciona a los errores del proveedor; el port nativo marca el modelo fallido en los eventos `session.execution.failed`/`session.error` y resuelve el siguiente escalon con `switchModel` (pre-seleccion, permite cambiar proveedor) via `applyReactiveFallback`.",
    futureEvidence: "`rigel-v2-native-model-chains.mjs`; `rigel-v2-native.mjs` (applyReactiveFallback en el bucle de eventos); `rigel-v2-native-model-chains.test.mjs`",
  },
  "sisyphus-junior-notepad": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El hook V1 en `hooks/sisyphus-junior-notepad/hook.ts` inyecta el notepad al prompt del subagente. `rigel-v2-native-flow-guards.mjs` monta la regla en `tool.execute.before` sobre la decision pura de `rigel-v2-flow-logic.mjs`, reproduciendo la eleccion de inyeccion del notepad cuando la delegacion crea un hijo; la secuencia before observada del runtime la incluye.",
    futureEvidence:
      "`rigel-v2-native-flow-guards.mjs`; `rigel-v2-flow-logic.mjs`; `rigel-v2-native-flow-guards.test.mjs`; `rigel-v2-flow-logic.test.mjs`",
  },
  "stop-continuation-guard": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El guard V1 en `hooks/stop-continuation-guard/hook.ts` atiende el comando de parada, cancela las tareas background descendientes en estado running/pending y escribe el marcador de continuacion `stop`. V2 no expone `command.execute.before`, asi que el paso `stop-continuation-guard` de `rigel-v2-native-request-steps.mjs` observa el ultimo mensaje de usuario en la frontera `http.request`, marca la sesion detenida y elimina cualquier continuacion encolada; en la remediacion de la auditoria de Fase 4 el runtime ademas cancela los descendientes (queued/starting/running) via `rigel-v2-background-manager.mjs` y escribe/limpia el marcador `sources.stop` (`.omo/run-continuation/<sessionID>.json`) via `rigel-v2-background-marker.mjs`; el estado se limpia en `session.deleted`.",
    futureEvidence:
      "`rigel-v2-native-request-steps.mjs`; `rigel-v2-native-request-steps.test.mjs`; `rigel-v2-background-manager.mjs`; `rigel-v2-background-manager.test.mjs`; `.omo/evidence/20261005-phase4-audit-remediation/task-r1.txt`",
  },
  "tasks-todowrite-disabler": {
    classification: "Equivale a builtin V2",
    status: "Migrado",
    rationale:
      "El bloqueo V1 en `hooks/tasks-todowrite-disabler/hook.ts` desactiva todowrite cuando el sistema de tareas está activo; V2 no publica todowrite, así que el comportamiento queda cubierto por el host y el sistema de tareas migrado conserva el flujo.",
    futureEvidence: "contract:qa-v2-compaction-hook-contract.mjs",
  },
  "team-mailbox-injector": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El inyector V1 incorpora los mensajes pendientes del buzon en el turno. El port nativo inyecta un bloque `<team-mailbox>` con los mensajes no leidos del miembro y los marca leidos (la inyeccion ES la entrega), sobre el hook `context` de V2 bajo el gate team_mode.",
    futureEvidence: "`rigel-v2-team-gating.mjs` (createNativeTeamMailboxInjector); `rigel-v2-team-gating.test.mjs`; `rigel-v2-native.mjs` (hook context)",
  },
  "team-mode-status-injector": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El inyector V1 incorpora el estado del equipo en el turno. El port nativo inyecta un bloque `<team-status>` (estado del team y de cada miembro) en el ultimo mensaje de usuario real via el hook `context` de V2, para cualquier participante (lead o miembro), bajo el gate team_mode.",
    futureEvidence: "`rigel-v2-team-gating.mjs` (createNativeTeamStatusInjector); `rigel-v2-team-gating.test.mjs`; `rigel-v2-native.mjs` (hook context)",
  },
  "team-tool-gating": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El gate V1 en `hooks/team-tool-gating/hook.ts` restringe las herramientas de equipo segun el rol. La regla nativa corre en la cadena `execute.before` de V2 bajo el gate team_mode: team_create denegado a participantes, delete/shutdown_request solo lead, approve/reject participantes, herramientas universales solo participantes del team nombrado; la denegacion lanza y bloquea la llamada.",
    futureEvidence: "`rigel-v2-team-gating.mjs` (createNativeTeamGatingRule); `rigel-v2-team-gating.test.mjs`; `rigel-v2-native.mjs` (nativeBeforeRules)",
  },
  "todo-continuation-enforcer": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "El hook V1 en `hooks/todo-continuation-enforcer/` reinyecta un prompt de continuacion cuando la sesion queda idle con todos incompletos. El port nativo divide el contrato en tres piezas puras: `rigel-v2-native-todo-continuation-gate.mjs` (`decideTodoContinuation`) reproduce el orden exacto de compuertas de skip (todos completos, recuperacion, cancelacion, limite de tokens, error irrecuperable, ventana de aborto, trabajo background, preguntas pendientes/sin responder, aborto del ultimo asistente, guard de compactacion, agente saltado, parada manual, estancamiento, fallos consecutivos y cooldown); `rigel-v2-native-todo-continuation-state.mjs` porta el store por sesion con la semantica de progreso de V1 (menos incompletos, mas completos o cambio de `{id -> status}`; un cambio solo de content/priority NO es progreso, issue #4013); y `rigel-v2-todo-continuation-prompt.mjs` mantiene el marcador y el prompt byte a byte. `rigel-v2-native.mjs` los cablea sobre la MISMA frontera de idle aceptado que el resto de continuaciones, con dedupe, parada manual y limpieza en delete.",
    futureEvidence:
      "`rigel-v2-native-todo-continuation-gate.mjs`; `rigel-v2-native-todo-continuation-state.mjs`; `rigel-v2-todo-continuation-prompt.mjs`; `rigel-v2-native-todo-continuation-wiring.test.mjs`; `rigel-v2-native-todo-continuation-gate.test.mjs`; `rigel-v2-native-todo-continuation-state.test.mjs`; `rigel-v2-todo-continuation-prompt.test.mjs`; `rigel-v2-native.mjs`",
  },
  "todo-description-override": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El override V1 (`hooks/todo-description-override/hook.ts`, hook `tool.definition`) se entrega en V2 registrando un `todowrite` real cuyo `description` ES el texto V1 `TODOWRITE_DESCRIPTION` (`rigel-v2-native-todo-description.mjs`, cableado en `rigel-v2-native.mjs`), respaldado por el store de todos por sesion del runtime. La definicion registrada es lo que el host convierte en el schema de tools del modelo, de modo que la descripcion V1 llega al modelo. El veredicto previo de que `tool.transform` era add-only era incorrecto: el editor expone add/get/update/list/namespace/remove, y `todowrite` no es un builtin de V2.",
    futureEvidence:
      "`rigel-v2-native-todo-description.mjs`; `rigel-v2-native-todo-description.test.mjs`; `rigel-v2-native.mjs`",
  },
  "tool-pair-validator": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El validador V1 en `hooks/tool-pair-validator/hook.ts` repara pares de llamada y resultado de herramienta desemparejados. El paso `tool-pair-validator` de `rigel-v2-native-request-steps.mjs` repara ambos formatos (Chat Completions `body.messages` y OpenAI Responses `body.input`) insertando el resultado terminal con `INTERRUPTED_TOOL_ERROR`, de forma idempotente, en la unica frontera `http.request`.",
    futureEvidence:
      "`rigel-v2-native-request-steps.mjs`; `rigel-v2-native-request-steps.test.mjs`",
  },
  "ulw-execute": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El comando V1 se entrega como comando V2 `/ulw-execute`: crea o reanuda estado boulder durable, selecciona plan, prepara notepads, cambia al agente Atlas cuando está disponible y entrega el contexto sin duplicarlo.",
    futureEvidence:
      "`rigel-v2-ulw-execute.mjs`; `rigel-v2-ulw-execute.test.mjs`; registro `context.command.transform` en `rigel-v2-native.mjs`",
  },
  "unstable-agent-babysitter": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El vigilante V1 se adapta al estado durable de hijos V2: en idle, `rigel-v2-native-phase4-events.mjs` consulta el conteo background del padre y entrega una advertencia sintética una sola vez hasta limpiar la sesión.",
    futureEvidence: "`rigel-v2-native-phase4-events.mjs`; `rigel-v2-native-phase4-events.test.mjs`; `rigel-v2-background-manager.mjs`",
  },
  "webfetch-redirect-guard": {
    classification: "Migrar",
    rationale:
      "V1 guard in `hooks/webfetch-redirect-guard/hook.ts` resolves and bounds webfetch redirects; the native V2 runtime replicates `resolveWebFetchRedirects` (max 10, statuses 301/302/303/307/308, normalized timeout) in tool.execute.before/after, tested against a real local HTTP server.",
    status: "Migrado",
    futureEvidence: ".omo/evidence/20261004-phase4-task18-guards/task-18.txt",
  },
}
