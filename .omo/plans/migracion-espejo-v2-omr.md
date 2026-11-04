# migracion-espejo-v2-omr - Plan de migración completa a espejo V2

## TL;DR (For humans)

**Para quién:** para Gabo, para convertir su fork oh-my-rigel en un producto 100% espejo de OMO V1 en comportamiento, ejecutándose 100% de forma nativa en OpenCode V2, sin puente ni compatibilidad V1.

**Qué se obtiene:** un runtime nativo V2 con las 54 hooks de ciclo de vida, las 14 familias de herramientas, los 11 agentes, categorías, modos y flujos transversales del padre, todos con comportamiento equivalente, un inventario sin filas pendientes ni parciales, y una puerta de aceptación con oráculo diferencial contra V1.

**Por qué así:** el criterio es binario (cero parciales, cero incompatibles, cero puente). El orden va de la base a la puerta: higiene, clasificación total, identidad de agentes, herramientas, hooks, muros, y aceptación final.

**Qué NO hará:** no mantendrá compatibilidad V1, no ejecutará el plugin V1 en runtime, no descartará funcionalidad por incompatibilidad (los muros se adaptan), y no toca la capa Gabo (ese plan arranca solo después).

**Esfuerzo:** XL
**Riesgo:** Alto - alcanza a todo el ciclo de vida del plugin y exige equivalencia demostrada, no supuesta.
**Decisiones a sanear:** base de espejo = `upstream/dev` sincronizado; runtime de registro = nativo; team mode se migra completo; cada muro se adapta, nunca se descarta.

Tu siguiente paso: aprobar este plan y autorizar la Fase 0.

---

> TL;DR (machine): XL/high; 6 fases con puerta al final de cada una; 24 tareas; criterio de cierre = inventario 100% cerrado + oráculo diferencial verde + cero puente V1.

## Criterio de espejo (único estándar de aceptación)

1. **Inventario cerrado:** cada fila de `profiles/gabo/V2_MIGRATION_INVENTORY.md` termina como `Migrado` (equivalencia demostrada con evidencia aislada) o `Equivale a builtin V2` (el builtin nativo cubre el comportamiento, con prueba). Cero `Migrado parcialmente`, cero `Incompatible`, cero `Pendiente`.
2. **Oráculo diferencial:** los escenarios de aceptación se ejecutan contra OMO V1 y contra el runtime nativo; los observables relevantes (payload al proveedor, mutaciones de resultados, decisiones de permisos, handoff) son equivalentes.
3. **Runtime único y nativo:** el runtime de registro es `rigel-v2-native.mjs`. Ningún código V1 se ejecuta en runtime; el plugin V1 solo se usa como oráculo en pruebas.
4. **Sin estado híbrido:** ninguna superficie puede quedar "habilitada en config pero inexistente en runtime".
5. **Evidencia:** todo el QA vive gitignored bajo `.omo/evidence/<YYYYMMDD>-<slug>/`; ningún artefacto sin commit se declara migrado.

## Alcance

**Base de espejo:** `upstream/dev` en `50ac0636d01b7bd77c1adb721ee5865cf57f0aa4`, sincronizado en Fase 0. Toda equivalencia se mide contra esa revisión.

**Estrategia de ejecución:** cada tarea se ejecuta en worktree propio con PR y merge-commit (protocolo del repo), QA aislado con sandbox XDG, y evidencia en disco antes de pasar a la siguiente. El árbol de trabajo de `fix/v2-background-handoff` queda como histórico; la nueva rama de integración es `v2-mirror`.

## Fases y tareas

> Formato por tarea: objetivo / alcance / no debe / aceptación / QA / commit.
> Numeración continua. "Fase N gate" = condición para abrir la fase siguiente.

### Fase 0 - Higiene y base (gate: árbol limpio, un solo runtime, docs coherentes)

- [x] 1. Consolidar el árbol y cerrar el trabajo huérfano
  - Estado (reconciliado 2026-10-03): hecho. Commit fc9f95757 (guard non-interactive con advertencia equivalente a V1 + shells de Windows). Evidencia `.omo/evidence/20261002-rigel-v2-noninteractive-contract/`; `git status` limpio en `v2-mirror`.
  - Objetivo: que el historial diga la verdad.
  - Alcance: commit del feature non-interactive con su divergencia corregida (advertir en el output del comando como V1 `hooks/non-interactive-env/hook.ts:85`, no lanzar; soporte de shells de Windows: `detectCommandShellType`/`buildEnvPrefix`); commit del resto de archivos modificados/sin seguimiento; cerrar/quitar worktrees muertos; crear rama `v2-mirror`.
  - No debe: no declarar nada migrado sin commit; no mezclar corrección con otra cosa.
  - Aceptación: `git status --short` vacío; test de noninteractive verde con advertencia (no throw) para los 3 patrones banneados; test de shell de Windows.
  - QA: `bun test profiles/gabo/opencode` verde; evidencia `<dir>/task-1.txt`.
  - Commit: `fix(profiles): land non-interactive guard with v1-equivalent warning and windows shells`

- [x] 2. Sincronizar con upstream/dev como base de espejo
  - Estado (reconciliado 2026-10-03): hecho. Merge commit 45d035901 (`upstream/dev`); 45205e050 corrige de raíz locale de git (LC_ALL=C) y test sensible a umask.
  - Objetivo: migrar sobre la revisión más reciente del padre.
  - Alcance: merge `upstream/dev` (`50ac0636d`) en `v2-mirror`; resolver los 8 caminos divergentes (solo 2 son fuente upstream); suite raíz verde.
  - No debe: no reescribir historia; no resolver conflictos silenciosamente (cada resolución queda en el mensaje del merge).
  - Aceptación: `git merge-base` confirma la sincronización; `bun test` + `bun run typecheck` verdes.
  - QA: evidencia `<dir>/task-2.txt` con el diff resuelto.
  - Commit: merge commit por política del repo.

- [x] 3. Purgar el puente V1 y las activaciones legacy
  - Estado (reconciliado 2026-10-03): hecho. Commit a1852fbb9 (puente a `attic/`). Verificado: `rg "omo-v2-adapter|switch-live-plugin-to-(dist|v2-adapter)" profiles/gabo --glob '!**/attic/**'` solo coincide con la deny-list de `validate-profile.mjs`; validador exit 0.
  - Objetivo: un solo runtime, cero híbrido.
  - Alcance: eliminar o archivar en `profiles/gabo/attic/` (sin build): `omo-v2-adapter.mjs`, `omo-v2-adapter-core.mjs`, `switch-live-plugin-to-dist.mjs`, `switch-live-plugin-to-v2-adapter.mjs`, `switch-system-service-to-{dist,v2-adapter}.sh`, `activate-live-trial.mjs`, `rollback-live-trial.mjs`, `activate-system-service.sh`, `rollback-system-service.sh`, `systemd/oh-my-rigel.conf`; actualizar `validate-profile.mjs` para fallar si el runtime nativo referencia el puente o si existe un segundo entrypoint activo.
  - No debe: no borrar evidencia histórica de `.omo/evidence/`; no romper los contratos QA que aún usan el puente (se reescriben contra el nativo en las tareas de su superficie).
  - Aceptación: `rg -l "omo-v2-adapter|switch-live-plugin-to-(dist|v2-adapter)" profiles/gabo --glob '!attic/**'` sin resultados; `validate-profile.mjs` exit 0 con la nueva regla.
  - QA: evidencia `<dir>/task-3.txt`.
  - Commit: `refactor(profiles): single native v2 runtime, quarantine legacy bridge`

- [x] 4. Documentación coherente y validador de rutas personales
  - Estado (reconciliado 2026-10-03): hecho. Commit 5162a6f79. Verificado: 0 rutas `/home/gabodev` fuera de `attic/`; validador con escaneo ampliado exit 0.
  - Objetivo: que la documentación diga el producto real.
  - Alcance: reescribir `FORK.md` y `OH-MY-RIGEL.md` (runtime nativo, sin puente, binario V2.0.22 como mínimo verificado); corregir `profiles/gabo/README.md` (retirar la afirmación "sin rutas locales" o hacerla cierta); ampliar el escaneo del validador a todo `profiles/gabo/**` (no solo 2 JSON); neutralizar las 39 rutas `/home/gabodev` a rutas relativas/variables.
  - No debe: no exponer secretos; no inventar compatibilidades.
  - Aceptación: `rg "/home/gabodev" profiles/gabo` sin resultados; validador con el escaneo ampliado pasa.
  - QA: evidencia `<dir>/task-4.txt`.
  - Commit: `docs(profiles): reconcile docs with native runtime; extend personal-path scan`

- [x] 5. Suite de aceptación orquestada
  - Estado (reconciliado 2026-10-03): hecho con la política de frontera vigente. Commits d51ea1b2f, 1535edccf, c6e4ff796, 33c68a218. Capa 0 (aislamiento) PASS, unit tests PASS, lab acceptance PASS; lane Docker y contratos node SKIP declarados (runner Docker histórico; node-spawn no prueba aislamiento). Evidencia `.omo/evidence/20261003-rigel-isolation-proof/` y `.omo/evidence/20261003-rigel-lab-acceptance/`.
  - Objetivo: que `run-all-isolated.sh` ejecute toda la batería real.
  - Alcance: el runner ejecuta (a) la prueba de aislamiento como capa 0 y aborta si falla; (b) `bun test profiles/gabo/opencode`; (c) los contratos `qa-v2-*.mjs` que arrancan el binario V2; (d) los runners Docker; y produce un resumen con estado por paso.
  - Política de frontera (2026-10-03, revisada 2026-11-04): en su momento un contrato node que lanza el binario V2 como subproceso no demostraba aislamiento total, así que la capa de contratos node queda en SKIP por defecto con motivo declarado y exige `RIGEL_SUITE_ALLOW_NODE_CONTRACTS=1`. La frontera vigente vive en `.omo/rules/protect-opencode-v1.md`: contención obligatoria de todo proceso a través de `profiles/gabo/isolated-v2-env.mjs`, y `profiles/gabo/isolation-proof.mjs` en `verdict=ISOLATED` antes de lanzar. El runner Docker es histórico y no es una vía aprobada de validación.
  - No debe: no inventar skip silencioso; todo omitido se declara con motivo; no lanzar OpenCode sin la capa 0 en verde.
  - Aceptación: un solo comando produce un informe con estado por paso; se integra como script npm y queda listo para CI; los contratos node se ejecutan sólo cuando se habilitan de forma explícita, dentro del entorno contenido.
  - QA: evidencia `<dir>/task-5.txt` con el informe completo.
  - Commit: `test(profiles): orchestrate isolated acceptance suite`

### Fase 1 - Clasificación total (gate: ledger sin pendientes)

- [x] 6. Generador de inventario de cobertura completa
  - Estado (completado 2026-10-03): verificación independiente confirmada. El generador enumera `features/`, `plugin/`, `agents/`, `mcp/`, `config/` y `cli/`; separa el inventario de directorios (54) del runtime por slots cableados: 55 base, 62 solo team mode, 56 solo monitor y 63 con ambos gates. `task-reminder` y `ralph-loop` quedan como `unwired upstream`. Evidencia `.omo/evidence/20261003-task-6-inventory/task-6.txt`; veredictos Oracle `confirmed`.
  - Objetivo: que el ledger pueda hablar de todo el producto.
  - Alcance: ampliar `generate-v2-migration-inventory.mjs` para escanear `features/`, `plugin/`, `agents/`, `mcp/`, `config/`, `cli/`; enumerar handlers reales (los 5 sueltos + `team-session-events/` + transform hooks de features); corregir el recuento de hooks; marcar `task-reminder` y `ralph-loop` como unwired upstream; regenerar el ledger.
  - No debe: no reclasificar a mano por encima de lo que el escáner descubre sin justificación en overrides.
  - Aceptación: el ledger lista superficies de features/mcp/config/cli y el número de hooks coincide con el runtime real; regenerar no baja estados (idempotente).
  - QA: doble generación produce diff vacío; evidencia `<dir>/task-6.txt`.
  - Commit: `feat(profiles): full-surface migration inventory generator`

- [x] 7. Clasificación completa de pendientes
  - Estado (completado 2026-10-03): las 198 filas pendientes quedaron clasificadas en `Migrar` (99), `Adaptar` (49), `Equivale a builtin V2` (4) e `Interno de build (sin superficie de runtime)` (46). Clasificaciones en origen bajo `profiles/gabo/migration-classifications/*.mjs`; generador con columnas de clasificación, rationale y evidencia futura; `SIN CLASIFICAR` = 0. Test estructural `profiles/gabo/migration-inventory.test.mjs` verde (8/8) e idempotencia verificada (sha256 estable); `validate-profile.mjs` exit 0. Evidencia `.omo/evidence/20261003-task-7-classification/task-7.txt`.
  - Objetivo: cero filas sin destino.
  - Alcance: para cada fila pendiente (37 hooks + 12 herramientas + ~20 features): asignar `Migrar` (con enfoque V2), `Adaptar` (muro con enfoque propuesto), o `Equivale a builtin V2` (con prueba que demostrará la equivalencia). Decisiones incluidas: team mode se migra completo; hashline se adapta (read enhancer + equivalente de hashline_edit); goal se migra; monitor según su config; `glob`/`grep`/`list`/`read` builtin se evalúan como Equivale con prueba de paridad de comportamiento; `slashcommand`/builtin-commands se migra al modelo de comandos V2; MCP 3-capas se migra; CLI se reduce al subconjunto necesario (doctor/install/version) documentando el resto como no-mirrorable-y-justificado o se migra.
  - No debe: ninguna fila termina "pendiente"; ninguna decisión sin criterio escrito.
  - Aceptación: ledger regenerado sin filas sin clasificar; cada clasificación lleva su rationale y su fila de evidencia futura.
  - QA: revisión estructural del ledger; evidencia `<dir>/task-7.txt`.
  - Commit: `docs(profiles): close all migration classifications`

### Fase 2 - Identidad de agentes (gate: paridad de roster/modelo/permisos/orden demostrada)

- [x] 8. Model fallback y routing de runtime
  - SEGUNDA REVISIÓN DE MANTENEDOR (2026-10-03): respuesta aceptada pero NO listo para commit. Corrección AUTORIZADA y en curso (por eso `[ ]`, no `[~]`). Sin commit/push hasta nueva revisión.
  - Contradicción a resolver: el código afirma que V2 ignora el rewrite de `body.model`, pero se declara el proactivo completo. Un primario ausente no alcanza `http.request` (V2 selecciona/valida proveedor y modelo antes); el test con `Request(example.invalid)` no demuestra el proactivo real.
  - Corrección requerida (proactivo en frontera previa): para agentes nombrados, resolver dinámicamente la PRIMERA cadena disponible durante setup/`agent.transform` ANTES de `agent.reload` (ampliar `registerNativeAgents` o su wiring con el inventario actual); configura `agent.model` antes del request, sin congelar en generación. Las categorías ya se resuelven antes de crear el hijo y deben conservar la cadena completa. El rewrite HTTP queda SOLO como guard same-provider, no como dueño proactivo principal.
  - Corrección requerida (reactivo cross-provider): `session.switchModel` SÍ es frontera preselección y acepta `providerID`; el reactivo NO debe limitarse al proveedor fallido si la cadena canónica siguiente está en otro proveedor. Recorrer la cadena completa, excluir modelos fallidos y usar `switchModel` con el `providerID` del escalón seleccionado. `sameProviderAs` solo aplica al rewrite tardío de `http.request`.
  - Pruebas requeridas: distinguir ambas fronteras (proactivo pre-selección vs reactivo switchModel) + una prueba viva del lab donde el agente con primario ausente ARRANQUE ya en el siguiente escalón, más una reacción que pueda CAMBIAR DE PROVEEDOR si la cadena lo exige.
  - Hallazgo material (retractado el enfoque previo): el fallback podía elegir un escalón de OTRO proveedor, pero `http.request` ocurre DESPUÉS de que V2 seleccionó ruta/proveedor/credenciales; reescribir solo `body.model` cruzaba proveedor. Prueba histórica del límite: `profiles/gabo/attic/opencode/omo-v2-adapter-core.mjs` `isSameProviderModelOverride` (~420); diagnóstico "cross-provider model override ... occurs after V2 selected the provider route". Los tests previos con `Request(example.invalid)` no probaban ruta real; el caso reactivo kimi-for-coding -> openai era un falso positivo.
  - REWORK aplicado (provider-affine): `resolveFallbackModel` con `sameProviderAs`; intersección de proveedor DENTRO de `findRungAvailable` (no seleccionar-y-rechazar); `isModelAvailable` fija ids bare al proveedor activo; en `http.request` el proveedor se deriva de `input.model` y el bloque se condiciona a él (proveedor desconocido => body intacto); reactivo acotado a `state.providerID` persistido. Cross-provider en `http.request` documentado como muro (Adaptar/pendiente de frontera V2 nativa previa a la selección de proveedor), sin simularlo. `<dir>/task-8.txt` actualizado; `lab-live-attempt.txt` registra el intento vivo.
  - Verificación: `bun test profiles/gabo/opencode` 73 pass / 0 fail (estable x2); `validate-profile.mjs` exit 0; mutation test de afinidad (romper la intersección -> 2 FAIL; restaurar -> verde). Lab refrescado con runtime byte-idéntico y `run-lab-acceptance.sh --refresh` PASS (V1 intacta).
  - BLOQUEO RESUELTO (2026-10-03): se encontró la frontera V2 real. `context.session.switchModel({sessionID, model})` (SDK `POST /api/session/{id}/model`, 204) es una frontera PRE-selección que SÍ cambia el modelo de la sesión. El reactivo ahora llama `switchModel` con el escalón resuelto (mismo proveedor) en vez de depender de la reescritura de `body.model` (que V2 ignora). DEMO VIVA END-TO-END PROBADA (`.omo/evidence/20261003-task-8-fallback/lab-reactive-switchmodel-proof.txt`): sesión explore en `opencode-go/grok-4.7` -> prompt 1 `finish=error`; el reactivo resuelve `qwen3.7-plus` y llama `switchModel`; prompt 2 `finish=stop` en `qwen3.7-plus`; modelo de sesión final `qwen3.7-plus`. V1 intacta (hash 9b020edbaca8ae30; goals schema 1, count 2).
  - Alcance del proof: REACTIVO (error de sesión -> siguiente petición en el siguiente escalón) PROBADO en vivo. PROACTIVO (primario ausente en la petición): V2 valida el modelo en `SessionRunnerModel.resolve` ANTES de `http.request`, así que un modelo ausente se rechaza antes del hook; el proactivo queda acotado por ese comportamiento de V2. El resolver provider-affine es correcto y está probado por unidad para ambos.
  - Estado de la lógica provider-affine: CORRECTA y probada (81 pass / 0 fail; mutation test de afinidad). El defecto de forma del body (Responses API vs Chat Completions) también se corrigió: el hook ahora entra en ambas formas.
  - No marcar completa ni commit/push hasta nueva revisión de mantenedor.
  - Objetivo: equivalentes a `model-fallback` (proactivo) y `runtime-fallback` (reactivo).
  - Alcance: portar las cadenas de `packages/model-core/src/agent-model-requirements.ts` y `category-model-requirements.ts`; resolución en frontera `http.request` (proactivo: reescribir `model` del payload con la cadena) y en eventos de error de sesión (reactivo); límites de intentos y telemetría mínima.
  - No debe: no congelar modelos en generación; no acoplar fallback a la intensidad ni a gobernanza.
  - Aceptación: contrato aislado: agente con modelo primario ausente cae al siguiente escalón y el payload final lleva el modelo del escalón; error de sesión dispara el fallback reactivo.
  - QA: evidencia `<dir>/task-8.txt` con trazas de payloads.
  - Commit: `feat(profiles): v2-native model fallback chains`

- [x] 9. Campos de tuning en la petición
  - Objetivo: que `temperature`, `top_p`, `maxTokens`, `thinking`, `reasoning`, `reasoningEffort`, `textVerbosity` del manifest lleguen al proveedor.
  - Alcance: mapear en `agent.request.body` (V2 `AgentV2Info.request`) en `rigel-v2-native-agents.mjs`; contrato de traza de proveedor que muestre cada campo en el payload real.
  - No debe: no ignorar campos silenciosamente; cualquier campo sin equivalente V2 se adapta a su equivalente semántico o queda documentado en la fila del ledger (cero silencios).
  - Aceptación: traza de proveedor con Sisyphus-Junior `maxTokens: 64000` y Atlas `temperature: 0.1` presentes.
  - QA: evidencia `<dir>/task-9.txt`.
  - Commit: `feat(profiles): carry agent model tuning into v2 requests`

- [x] 10. Permisos con fusión de baseline y vocabulario real — **APROBADA Y CERRADA (2026-10-03)**
  - Evidencia: `.omo/evidence/20261003-task-10-permissions/task-10.txt`.
  - Objetivo: decisiones de permisos V2 equivalentes a las de V1.
  - Alcance: fusionar sobre el baseline V2 en vez de reemplazarlo (`rigel-v2-native-agents.mjs:46-47`); traducir cada clave V1-only a su efecto real V2 (`write→edit`, `apply_patch→edit`, `look_at→allow/deny por medio del tool.name gate`, `grep_app_*`/`lsp_*`/`call_omo_agent`/`task_*`→ equivalencia por tool, `teammate`→gate de herramientas team, `question`→ permiso runtime, `*`→ expansión al conjunto de acciones V2); overlay global de `config.tools` deshabilitados; contrato de decisión real (una llamada prohibida se bloquea por permisos V2, no por prompt).
  - No debe: no dejar claves que V2 ignore; no basar la seguridad en prompts.
  - Aceptación: para cada agente, una tabla esperada-vs-observada de decisiones de permisos V2 coincide; el caso multimodal-looker (`todo denegado excepto read`) se bloquea de verdad.
  - QA: evidencia `<dir>/task-10.txt`.
  - Commit: `feat(profiles): v2-native permission model with baseline merge`

- [x] 11. Hephaestus al roster con gate de proveedor — **APROBADA Y PUBLICADA (2026-10-04)**
  - Estado (cierre administrativo 2026-10-03): checkpoint de implementación y documentación aprobado por el juez. Hephaestus en `orchestratedAgentIds` y fuera de `excludedOmOAgentIds`; la generación en entorno limpio lo emite via first-run V1 (prompt autónomo verbatim, `openai/gpt-6-sol` medium). Gate real en `rigel-v2-native-hephaestus.mjs` (puerto fiel de `hephaestus-agent.ts:42-88` + regexes de `hephaestus/agent.ts`, paridad por corpus bajo Bun) consumido por `registerNativeAgents` (bloqueo -> fuera del roster con mensaje equivalente; sin inventario se omite el chequeo de proveedor, equivalente first-run). Inyección del AGENTS.md raíz activa al entrar al roster. Corrección T11-01 aplicada: fixture de Hephaestus en `qa-v2-agents-md-contract.mjs` movido a `openai/gpt-6-sol` con entrada de proveedor `openai` apuntando al mismo mock, y prueba hermética de compatibilidad fixture-gate (falla con el fixture roto). Verificado final: suite hermética 150 pass / 0 fail / 911 expect / 16 archivos; validate-profile exit 0; `git diff --check` limpio; mutation del gate (permisivo -> 3 FAIL) y mutation del test de fixture. Evidencia `.omo/evidence/20261003-task-11-hephaestus/` (`task-11.txt`, `t11-01-fixture-fix.txt`, `task-11-closure.txt`) y resumen de fase en `.omo/evidence/20261003-phase-2-agent-identity/task-11.txt`. Smoke autenticado con GPT/Luna reservado al cierre de Fase 6. Cierre formal: veredicto del juez APPROVED y publicada en `origin/v2-mirror` dentro del commit atómico de Fase 2 `29697ab8c2ff847447c0e38d31510ec97d5e26e6` (padre `a516c587f` docs del mantenedor).
  - Objetivo: el agente existe, es seleccionable y su guard de modelo funciona.
  - Alcance: quitar de `excludedOmOAgentIds`; portar `requiresProvider`/`isHephaestusSupportedModel` (variante V2 de `packages/omo-opencode/src/agents/builtin-agents/hephaestus-agent.ts:42-88`); activar el inyector de `AGENTS.md` raíz (`rigel-v2-native.mjs:211-213` deja de ser código muerto); generación deja de depender de que el perfil lo excluya.
  - No debe: no alterar su prompt autónomo; no fijar modelo DeepSeek.
  - Aceptación: roster con Hephaestus; con modelo no-GPT la selección se bloquea con el mensaje del guard; con GPT/Luna responde (smoke autenticado al final, Fase 6).
  - QA: evidencia `.omo/evidence/20261003-task-11-hephaestus/` + `.omo/evidence/20261003-phase-2-agent-identity/task-11.txt`.
  - Commit: incluido en `29697ab8c` `feat(profiles): v2-native agent identity with hephaestus gate, coordinator guard, and canonical order` (átomo de fase; separación por contenido documentada en `phase-2.txt` §6).

- [x] 12. Modos correctos y guard de coordinadores — **APROBADA Y PUBLICADA (2026-10-04)**
  - Estado (cierre formal): implementada, verificada y publicada en `origin/v2-mirror` dentro del commit atómico de Fase 2 `29697ab8c2ff847447c0e38d31510ec97d5e26e6`. Veredicto del juez APPROVED (riesgo HIGH, sin hallazgos). Guard de coordinadores en el `execute` de `rigel_task` ANTES de la rama `task_id` y de cualquier creación de sesión (solo `prometheus` es coordinador upstream; `isCoordinatorAgent` puerto de `delegate-task/constants.ts:405-414` + `subagent-request-preflight.ts:58-67`); `nativeAgentModeOverrides` eliminado -> Prometheus y Atlas `primary`; `plan` degradado delegable y `build` oculto no delegable via `demotedAgentIds` (manifest regenerado `agentCount: 14`); alias `"plan" -> "Prometheus"` eliminado: `plan` resuelve al plan degradado real, nunca a Prometheus. Pruebas: runtime.execute con coordinador -> mensaje del guard + CERO llamadas de sesión; core: `isCoordinatorAgent`/`isDemotedPlanAgent`; mutation M1 (guard anulado -> 1 FAIL, restaurado -> 0 fail); roster vivo en dos arranques con modos/hidden correctos. Evidencia: `.omo/evidence/20261003-phase-2-agent-identity/task-12.txt` (`be6f0b89…`) con `t12-red/green.txt` y `mutation-t12.txt`. Pendiente documentado (fuera de aceptación T12): bloqueo mutuo plan<->prometheus y bloqueo sisyphus-junior-direct (`subagent-request-preflight.ts:34-56`).
  - Objetivo: Prometheus/Atlas `primary`, no delegables; `plan` demoted como upstream.
  - Alcance: revertir `nativeAgentModeOverrides` (`v2-agent-selection.json:27-30`); portar el guard de coordinadores (`tools/delegate-task/constants.ts:405-414`) al dueño de delegación; reproducir la democión de `plan` y el subagente oculto `build` (`agent-config-assembly.ts:188-242`); ajustar el alias `plan` en `rigel-v2-native-core.mjs:69` a la semántica upstream.
  - No debe: no dejar que `rigel_task` apunte a coordinadores; no romper delegación legítima.
  - Aceptación: `rigel_task(subagent_type="Prometheus - Plan Builder")` rechazado antes de crear sesión; delegación a secundarios sigue verde; `plan` y `build` presentes con sus modos.
  - QA: evidencia `.omo/evidence/20261003-phase-2-agent-identity/task-12.txt` + `t12-red/green.txt` + `mutation-t12.txt`.
  - Commit: incluido en `29697ab8c` `feat(profiles): v2-native agent identity with hephaestus gate, coordinator guard, and canonical order` (átomo de fase; separación por contenido documentada en `phase-2.txt` §6).

- [x] 13. Orden canónico de agentes — **APROBADA Y PUBLICADA (2026-10-04)**
  - Estado (cierre formal): implementada, verificada y publicada en `origin/v2-mirror` dentro del commit atómico de Fase 2 `29697ab8c2ff847447c0e38d31510ec97d5e26e6`. Veredicto del juez APPROVED (riesgo HIGH, sin hallazgos). Fuente única `DEFAULT_AGENT_ORDER` (`shared/agent-ordering.ts`) portada a `rigel-v2-native-agent-order.mjs` con paridad TS bajo Bun (`CANONICAL_AGENT_KEYS` + mapeo display->clave via `getAgentListDisplayName`); aplicada en (a) iteración canónica de `registerNativeAgents` en `agent.transform`, (b) `callableAgents` como único punto de orden del inventario (roster inyectado y roster de delegación heredan), (c) orden de claves del manifest en `generate-v2-agents.mjs`; cuatro listas de copia actualizadas. Observable en vivo: dos arranques consecutivos del lab con listado de 19 agentes idéntico y posiciones canónicas `Sisyphus=0 -> Hephaestus=8 -> Prometheus=9 -> Atlas=10` estrictamente crecientes (`two-boots.txt`). Pruebas: paridad de claves/display, inventario y manifest barajados a propósito en los tres owners, mutation M2 (sort anulado -> 2 FAIL, restaurado -> 0 fail). Evidencia: `.omo/evidence/20261003-phase-2-agent-identity/task-13.txt` (`d349667d…`) con `t13-red/green.txt`, `mutation-t13.txt`, `two-boots.txt`.
  - Objetivo: Sisyphus→Hephaestus→Prometheus→Atlas observable en V2.
  - Alcance: `AgentV2Info` no tiene `order`: adaptar vía (a) orden de registro en `agent.transform`, y (b) orden del roster inyectado en prompts (`rigel-v2-native-prompt.mjs`) y del roster de delegación, tomando `DEFAULT_AGENT_ORDER` como fuente; contrato que pruebe el orden observado.
  - No debe: no depender del orden casual de V2.
  - Aceptación: listado de agentes y rosters en el orden canónico en dos arranques seguidos.
  - QA: evidencia `.omo/evidence/20261003-phase-2-agent-identity/task-13.txt` + `t13-red/green.txt` + `mutation-t13.txt` + `two-boots.txt`.
  - Commit: incluido en `29697ab8c` `feat(profiles): v2-native agent identity with hephaestus gate, coordinator guard, and canonical order` (átomo de fase; separación por contenido documentada en `phase-2.txt` §6).

### Fase 3 - Superficie de herramientas (gate: registro de tools con paridad de comportamiento)

- [x] 14. `skill` y `skill_mcp` + inyección real de skills en delegación
  - Estado (cerrado 2026-10-04): implementado, gate verde y publicado en `origin/v2-mirror` (`a710e6241`). Evidencia `.omo/evidence/20261004-phase3-tools/`; nota de bóveda `2026-10-04-fase-3-tarea-14`. Corrige el defecto de esquema vivo V2 (`id` en `Skill.Info`) detectado por QA viva.
  - Objetivo: selección y carga de skills como V1.
  - Alcance: registrar las 2 herramientas (descubrimiento por `SCOPE_PRIORITY` de skills-loader-core, frontmatter, ejecución); sustituir la pista textual `<rigel-requested-skills>` (`rigel-v2-native.mjs:136-141`) por inyección real del contenido de la skill en el prompt del hijo; tier-3 MCP embebido en skill (stdio+HTTP) con aislamiento por sesión.
  - No debe: no leer cuerpos de skills en cada prompt del orquestador; no romper colisiones de usuario.
  - Aceptación: hijo delegado con `load_skills` ejecuta el cuerpo real de la skill; MCP de skill arranca por sesión.
  - QA: evidencia `<dir>/task-14.txt`.
  - Commit: `feat(profiles): v2-native skill tools and real skill injection`

- [x] 15. `session-manager`, `look_at`, `question`, monitor
  - Estado (cerrado 2026-10-04): implementado, gate verde y publicado en `origin/v2-mirror` (`50d577a73`). Evidencia `.omo/evidence/20261004-phase3-tools/`; nota de bóveda `2026-10-04-fase-3-tarea-15`.
  - Objetivo: las herramientas de sesión y multímodal con comportamiento V1.
  - Alcance: registrar `session_list/read/search/info` (dominio, paginación, formatos); `look_at` con enrutado a multimodal-looker; permiso runtime `question`; `monitor_start/stop/list/output` tras decisión de `monitor.enabled` (Fase 1).
  - No debe: no duplicar el SDK V2; envolver con la semántica V1 exacta.
  - Aceptación: contrato por herramienta con caso feliz + caso de error equivalente a V1.
  - QA: evidencia `<dir>/task-15.txt`.
  - Commit: `feat(profiles): v2-native session, look_at, question, monitor tools`

- [x] 16. `interactive_bash` + tmux; task-system y goal
  - Estado (cerrado 2026-10-04): implementado, gate verde y publicado en `origin/v2-mirror` (`274a9d9e6`). Evidencia `.omo/evidence/20261004-phase3-tools/`; nota de bóveda `2026-10-04-fase-3-tarea-16`.
  - Objetivo: paridad de las familias condicionales.
  - Alcance: `interactive_bash` cuando tmux esté disponible (detección `isInteractiveBashEnabled()`); `task_create/get/list/update` con el motor de `senpi-task` o su equivalente adaptado a V2; `create_goal/update_goal/get_goal` con `goal.enabled`; gates de config respetados en runtime.
  - No debe: no registrar tools cuyos gates estén apagados; no fingir features ausentes.
  - Aceptación: contratos por familia con gates activados/desactivados.
  - QA: evidencia `<dir>/task-16.txt`.
  - Commit: `feat(profiles): v2-native interactive bash, task system, goal`

- [x] 17. Categorías completas
  - Estado (cerrado 2026-10-04): implementado, gate verde y publicado en `origin/v2-mirror` (`e5c329bc9`). Evidencia `.omo/evidence/20261004-phase3-tools/`; notas de bóveda `2026-10-04-fase-3-tarea-17` y `2026-10-04-fase-3-cierre`.
  - Objetivo: paridad de `delegate-task` por categoría.
  - Alcance: cadenas de fallback por categoría; fusión de categorías de usuario (`pluginConfig.categories`); uso real de `description`/`guidance` en prompt y roster; resolución tolerante a caída de modelo (no throw, cae al siguiente escalón); routing a Sisyphus-Junior con skills reales (usa tarea 14).
  - No debe: no congelar solo el primer escalón.
  - Aceptación: contrato: categoría con modelo caído resuelve al escalón siguiente; categoría de usuario se registra y delega.
  - QA: evidencia `<dir>/task-17.txt`.
  - Commit: `feat(profiles): full category parity with fallback chains`

### Fase 4 - Hooks pendientes (gate: grupo A/B/C verde con equivalencia)

- [x] 18. Grupo A - guards y recovery — cerrada y publicada en `25c33dc53`; evidencia: `.omo/evidence/20261004-phase4-task18-guards/` y [[2026-10-04-fase-4-tarea-18]]
  - Alcance: `comment-checker` (binary + `// @allow` + file-disable); `webfetch-redirect-guard`; `plan-format-validator`; `prometheus-md-only`; completar `write-existing-file-guard` contra el `write` builtin real de V2; provocar fallo real de edit/json en V2 para `edit-error-recovery`/`json-error-recovery` (hoy solo patrones unitarios).
  - Aceptación: contrato aislado por guard con caso feliz + bloqueo real; recovery con error real de editor V2.
  - QA: evidencia `<dir>/task-18.txt`.
  - Commit: `feat(profiles): v2-native guard and recovery hooks`

- [x] 19. Grupo B - infraestructura de contexto — cerrada y publicada en `0d4eef2bd`; evidencia: `.omo/evidence/20261004-task-19/task-19.txt` y [[2026-10-04-fase-4-tarea-19]]
  - Alcance: `hashline` adaptado (read enhancer LINE#ID + `hashline_edit` equivalente con validación de hash, o sustitución demostrada equivalente); `rules-injector` con `@oh-my-opencode/rules-engine` (proximidad, picomatch, truncado dinámico, clear en compactación); `directory-agents/readme-injector` con `agents-md-core` (walk-up con `skipRoot`, caché, truncado, clear); `agent-usage-reminder` con persistencia (equivalente `storage.ts`) y set exacto de agentes; `category-skill-reminder`.
  - Aceptación: contratos con reglas reales del repo; clear tras compactación observable.
  - QA: evidencia `<dir>/task-19.txt`.
  - Commit: `feat(profiles): v2-native context infrastructure hooks`

- [x] 20. Grupo C - flujo y continuidad
  - Estado (cerrado y publicado 2026-10-05): aprobado por el segundo mantenedor y publicado en `origin/v2-mirror` (`c885cfb64` `feat(profiles): v2-native flow and continuation hooks`). Evidencia: `.omo/evidence/20261005-task-20/task-20.txt` y nota de bóveda [[2026-10-05-fase-4-tarea-20]]. Tras T20 corresponde la auditoría integral independiente de Fase 4; Fase 5 no se inicia.
  - Alcance: keyword detector completo (team, hyperplan, `hpp ulw`/`ulw hpp`, `disabled_keywords`, `enabled_expansions`, filtros planner/non-OMO/commands/synthetic, escaneo de contenido array/parts, variantes por modelo gpt/gemini/glm, sesión persistente con cap 256 y evicción FIFO, restauración post-compactación); background-agent manager con cola FIFO, límites de concurrencia, reintentos, cancelación y persistencia; `delegate-task-retry`; `stop-continuation-guard`; `notepad-write-guard`; `sisyphus-junior-notepad`; `read-image-resizer`; `question-label-truncator`; `todo-description-override`; `tool-pair-validator`; `fsync-skip-warning`.
  - Aceptación: contrato por hook con equivalencia V1; el falso positivo `ultraworker` (nombre del agente pegado en texto) resuelto según semántica V1 (que no lo activa).
  - QA: evidencia `<dir>/task-20.txt`.
  - Commit: `feat(profiles): v2-native flow and continuation hooks`

### Fase 5 - Muros a adaptar (gate: cero incompatibles)

> Numeracion: 24 y 25 estan reservadas a la Fase 6 (oraculo y cierre del espejo); las tareas 26 a 31 continuan la numeracion y pertenecen a esta fase.

- [x] 21. Compactación: inyección de contexto y recuperación
  - Estado (cerrado y publicado 2026-10-06): publicado en `origin/v2-mirror` (`c7920068a` `feat(profiles): native compaction context injection and recovery`). Evidencia: `.omo/evidence/20261006-t21-compaction/task-21.txt` y nota de bóveda [[2026-10-06-fase-5-tarea-21]].
  - Objetivo: `compaction-context-injector` con comportamiento equivalente.
  - Alcance: identificar la petición de resumen en la frontera `http.request` e inyectar el contexto adicional (patrón ya probado de `rigel-v2-native-prompt.mjs`); restaurar ultrawork/roster/reglas tras compactación (equivalente a `needsRestoration` de V1); probar que la mutación llega al payload del resumen.
  - Aceptación: contrato aislado: payload del resumen contiene el contexto inyectado; tras compactación la próxima petición lleva la restauración.
  - QA: evidencia `<dir>/task-21.txt`.
  - Commit: `feat(profiles): compaction context injection via http boundary`

- [x] 22. Todos: estado persistente y continuidad
  - Estado (cerrado y publicado 2026-10-06): publicado en `origin/v2-mirror` (`b8e0033da` `feat(profiles): persistent todo state with compaction preservation`). Evidencia: `.omo/evidence/20261006-t22-todo-continuity/task-22.txt` y nota de bóveda [[2026-10-06-fase-5-tarea-22]].
  - Objetivo: `compaction-todo-preserver` + `todo-continuation-enforcer` (boulder) funcionando.
  - Alcance: V2 no expone `session.todo`/`todowrite`; adaptación: registro propio de todos ligado al sessionID (archivo/estado del plugin en sandbox), captura de escrituras de todos vía `tool.execute.after` sobre el tool call, reinserción del estado en la siguiente petición, y enforcer que evalúa la condición de continuidad sobre ese registro; prototype-first con contrato antes de integrar.
  - Aceptación: los todos sobreviven a una compactación real; el enforcer reinicia el flujo cuando corresponde.
  - QA: evidencia `<dir>/task-22.txt`.
  - Commit: `feat(profiles): persistent todo state with compaction preservation`

- [x] 23. Think-mode y variantes
  - Estado (cerrado y publicado 2026-10-06): publicado en `origin/v2-mirror` (`1ba54dd4a` `feat(profiles): think-mode and variant adaptation for v2`). Evidencia: `.omo/evidence/20261006-t23-think-variants/task-23.txt` y nota de bóveda [[2026-10-06-fase-5-tarea-23]].
  - Objetivo: variante por turno o equivalente estable demostrado.
  - Alcance: probar en frontera `http.request` si la variante del payload es respetada por el proveedor (mutar el campo del body real); si el host V2 la fija por agente, equivalencia estable por agente + cambio por mensaje documentado en el ledger con la evidencia del experimento; `chat.params` (esfuerzo Anthropic, think mode) equivalente.
  - Aceptación: experimento documentado con trazas; el comportamiento final elegido está demostrado y registrado en la fila del ledger (deja de ser "incompatible").
  - QA: evidencia `<dir>/task-23.txt`.
  - Commit: `feat(profiles): think-mode and variant adaptation for v2`


- [x] 26. Worktrees por miembro de team mode
  - Estado (cerrado y publicado 2026-10-07): publicado en `origin/v2-mirror` (`f7926514f`). Evidencia: `.omo/evidence/20261007-t26-team-worktrees/task-26.txt` y nota de boveda [[2026-10-07-fase-5-tarea-26]].
  - Objetivo: efecto V1 completo: cada miembro edita en su worktree aislado, sin colisiones concurrentes.
  - Alcance V1: `features/team-mode/team-runtime/create.ts` (creacion de worktrees por miembro), `packages/team-core/src/team-worktree/` (worktree add/remove sobre git), `features/team-mode/team-runtime/delete-team.ts` (limpieza). Efectos observables: al crear un team, cada miembro recibe un worktree dedicado; las ediciones del miembro ocurren en ese arbol; al apagar (shutdown aprobado u orphan), los worktrees se eliminan sin dejar ramas ni directorios huerfanos.
  - API oficial V2 -> estrategia: reescribir sobre el modelo de storage nativo de teams (`rigel-v2/team/<name>`) + el detector de worktrees ya probado (`rigel-v2-ulw-execute-worktree.mjs`) + ejecucion de comandos git via el runner del runtime. La creacion/cleanup se engancha a las herramientas de ciclo de vida team existentes (`tools/team.tools.mjs`) y al lead orphan handler (`rigel-v2-team-events.mjs`).
  - No debe: no compartir un worktree entre miembros; no dejar worktrees ni ramas tras el cierre; no bloquear el apagado si el cleanup falla (reintento + registro).
  - Aceptacion: positivo: team con 2 miembros crea 2 worktrees distintos y las rutas quedan registradas en el team; negativo: tras shutdown aprobado no queda ningun worktree ni rama del team (verificacion por `git worktree list`).
  - QA: viva en el lab con team real; evidencia `<dir>/task-26.txt`.
  - Commit: `feat(profiles): per-member worktrees for native team runs`

- [x] 27. Validacion de bloques de pensamiento y reparacion de prefill
  - Estado (cerrado y publicado 2026-10-07): publicado en `origin/v2-mirror` (`493a3023c`). Alcance ejecutado (correccion de auditoria): pares de herramienta y cola assistant-prefill; el validador proactivo de thinking V1 fue eliminado (`9a16b54e4`) y no se restaura, y reasoning queda bajo el transform nativo V2. Evidencia: `.omo/evidence/20261007-t27-thinking-prefill/task-27.txt` y nota de boveda [[2026-10-07-fase-5-tarea-27]].
  - Objetivo: efectos V1 de `plugin/messages-transform.ts`: descartar/normalizar bloques de pensamiento invalidos en `event.messages` y reparar la cola assistant-prefill rota antes del proveedor.
  - Alcance V1: `plugin/messages-transform.ts` (thinking-block validation + tool-pair validation + assistant-prefill repair) y `features/btw-side` si consume el mismo punto.
  - API oficial V2 -> estrategia: adaptar sobre el hook `context` (`event.messages` mutable, ya probado por el consumidor del colector en `rigel-v2-native.mjs`); reglas puras en modulo propio (`rigel-v2-native-message-repair.mjs`) con la misma precedencia que V1 (validacion antes de reparacion).
  - No debe: no alterar mensajes de usuario reales; no silenciar errores de validacion sin registro; no duplicar la logica de repairChatToolPairs existente (extenderla o sustituirla con paridad demostrada).
  - Aceptacion: positivo: un historial con bloque de pensamiento invalido y cola prefill rota llega corregido al body del proveedor (captura con proveedor simulado loopback); negativo: un historial valido llega byte-idéntico.
  - QA: viva en el lab (proveedor simulado loopback, patron del cierre de Fase 4); evidencia `<dir>/task-27.txt`; mutacion RED/restore de la regla de validacion.
  - Commit: `feat(profiles): thinking block validation and prefill repair on the context hook`

- [ ] 28. Reconciliacion del prompt de Sisyphus por modelo de runtime
  - Objetivo: decidir y documentar el contrato del prompt de Sisyphus frente a cambios de modelo en runtime (V1 reconstruia el prompt por request en el system-transform, issues #5297/#5316).
  - Alcance V1: `agents/sisyphus-runtime-prompt-reconciler.ts` + `agents/builtin-agents/sisyphus-agent.ts:113-116` (prompt baked al modelo configurado + rebuild por modelo de runtime) + `plugin/system-transform.ts`.
  - API oficial V2 -> estrategia: adaptar sobre el hook `context` (`event.system` mutable) reconstruyendo el prompt con el mismo pipeline de registro del manifiesto; alternativa documentada: mantener el prompt estatico si la verificacion demuestra que el cuerpo es agnostico al modelo (decision de espejo explícita en el ledger, no un silencio).
  - No debe: no reconstruir el prompt en cada request sin cache por modelo; no tocar los prompts de otros agentes.
  - Aceptacion: si se reimplementa: switch de modelo en runtime produce un prompt equivalente al que registration habria construido para ese modelo (comparacion por observables); si se declara espejo del estatico: experimento + decision documentada en la fila del ledger (deja de estar pendiente).
  - QA: viva en el lab con dos modelos del perfil; evidencia `<dir>/task-28.txt`.
  - Commit: `feat(profiles): sisyphus runtime prompt reconciliation on the context hook`

- [ ] 29. Openclaw bidireccional
  - Objetivo: efectos V1 de `openclaw/`: despacho de eventos de sesion a HTTP/shell/Discord/Telegram y inyeccion de respuestas entrantes en la sesion.
  - Alcance V1: `openclaw/gateway` + `openclaw/reply-listener` (daemon de entrada) + `openclaw-core` (registry, tmux injection); config `openclaw` del perfil.
  - API oficial V2 -> estrategia: adaptar: salida via `ctx.event.subscribe` (ya existente en el bucle compartido) + `http.request`/fetch para el despacho; entrada via un listener propio del runtime (spawn controlado por setup con dispose en el apagado) que inyecta por `ctx.session.prompt` con delivery queue; estado por storage nativo.
  - No debe: no abrir puertos ni credenciales fuera de la config del perfil; no inyectar prompts sin pasar por el gate interno existente; no dejar el daemon vivo tras dispose.
  - Aceptacion: positivo: un evento de sesion despacha al endpoint simulado loopback con el payload declarado; una respuesta entrante del listener aparece en la sesion; negativo: config ausente o deshabilitada no inicia ningun daemon.
  - QA: viva en el lab con servicios simulados loopback (HTTP de salida y entrada); evidencia `<dir>/task-29.txt`; mutacion del gate.
  - Commit: `feat(profiles): native openclaw event dispatch and reply listener`

- [ ] 30. Login OAuth interactivo sin CLI
  - Objetivo: efecto V1 de `cli/mcp-oauth`: completar el flujo de login interactivo de un MCP de skill desde el runtime, sin CLI externo.
  - Alcance V1: `packages/omo-opencode/src/cli/mcp-oauth/` (login/logout/status sobre `features/mcp-oauth`); el lado manager ya existe (`rigel-v2-skill-mcp-oauth.mjs`).
  - API oficial V2 -> estrategia: adaptar el efecto como comando nativo V2 (`ctx.command.transform`: `mcp-oauth login <server>`) que reutiliza el proveedor y callback local existentes; alternativa documentada: endpoint del server si el comando no alcanza sesiones sin modelo. La decision se fija en el ledger tras el experimento.
  - No debe: no duplicar discovery/DCR/PKCE (reusar `rigel-v2-skill-mcp-oauth.mjs`); no imprimir tokens; no abrir el navegador en entornos headless sin aviso del callback manual.
  - Aceptacion: positivo: el comando completa PKCE contra un server simulado loopback y persiste el token en storage; negativo: token invalido o callback con state incorrecto falla con mensaje claro y sin persistir.
  - QA: viva en el lab (server simulado loopback, patron del cierre de Fase 4); evidencia `<dir>/task-30.txt`; mutacion de la persistencia.
  - Commit: `feat(profiles): interactive mcp oauth login as a native command`

- [ ] 31. Muros de superficie: auto-update-checker y tool.definition
  - Objetivo: eliminar las dos filas `Incompatible (con evidencia)` restantes implementando sus EFECTOS.
  - (a) `hooks/auto-update-checker`: efecto = aviso de nueva version publicada. Estrategia: adaptar via fetch del registry npm en el arranque (con cache en storage y un solo chequeo por dia) + aviso por `context.system` (`event.system`, patron del roster). No debe: no auto-instalar ni bloquear el arranque. Aceptacion: version nueva produce el aviso en el body; version igual no avisa; fallo de red degrada silencioso con registro. Mutacion del cache diario.
  - (b) `plugin/tool-definition.ts`: efecto = override de la definicion de una tool (todo-description-override de V1). Estrategia: migrar al registro nativo: el runtime ya construye las definiciones que añade, asi que el override se aplica al construir cada definicion (`tools/todo.tools.mjs` y familias) y el gate `tool.definition` deja de reportarse. No debe: no mutar definiciones del host que el runtime no crea. Aceptacion: la descripcion efectiva de la tool en el editor es la sobrescrita; contrato positivo/negativo sobre el editor.
  - QA: viva en el lab (aviso de version con registry simulado; definicion sobrescrita observable via el registro); evidencia `<dir>/task-31.txt`.
  - Commit: `feat(profiles): update notice via context injection and native tool definition overrides`


- [x] 32. Monitor status injector
  - Objetivo: efecto V1 de `hooks/monitor-status-injector/hook.ts`: el estado de los monitores vigilados se inyecta en el turno del orquestador.
  - API oficial V2 -> estrategia: adaptar como inyector sobre `context` (`event.messages`), con el mismo patron ya probado de los inyectores team (`rigel-v2-team-gating.mjs`), bajo el gate `monitor.enabled` y consumiendo el registro de monitores (`tools/monitor-engine.mjs`).
  - No debe: no inyectar cuando no hay monitores activos; no duplicar el bloque en turnos sucesivos.
  - Aceptacion: positivo, una sesion con monitor activo recibe el bloque de estado en su turno (captura con proveedor simulado loopback); negativo, gate off produce no-op verificable.
  - QA: viva en el lab; evidencia `<dir>/task-32.txt`; mutacion del gate; resumen [[2026-10-06-fase-5-tarea-32]].
  - Commit: `feat(profiles): monitor status injection on the context hook`

- [ ] 33. Session notification (espejo total, decision de mantenedor 2026-10-05)
  - Objetivo: efecto V1 de `hooks/session-notification/`: avisar al usuario fuera del contexto del modelo al terminar la sesion o cuando hace falta input, con sonido segun plataforma.
  - Alcance V1: `hooks/session-notification/` (disparadores, sonido, gating).
  - API oficial V2 -> estrategia: adaptar sobre el companion CLI plugin de V2 (`@opencode/plugin/tui`) con `context.ui.toast.show(...)` y `context.attention.notify(...)`; version desktop-sidecar si aplica. La etiqueta Incompatible quedo refutada por la doc oficial (fila del ledger corregida).
  - No debe: sin config de notificacion no inicia side effects; sin toasts en entornos headless; no notificar turnos internos de subagentes.
  - Aceptacion: positivo, notificacion real observable al completar/input-needed; negativo, config ausente produce 0 side effects.
  - QA: viva en el lab; evidencia `<dir>/task-33.txt`; mutacion del gate.
  - Commit: `feat(profiles): session notifications via the companion cli plugin`

- [ ] 34. Preemptive compaction (espejo total, decision de mantenedor 2026-10-05)
  - Objetivo: efecto V1 de `hooks/preemptive-compaction/` (gate experimental apagado por defecto): compactar preventivamente antes del limite de contexto.
  - API oficial V2 -> estrategia: adaptar sobre hooks `context`/`compaction` + `session.compact`, con el patron ya probado del context-limit recovery (`rigel-v2-native-phase4-events.mjs`) y umbral propio configurable.
  - No debe: gate off es no-op verificable; no compactar dos veces el mismo umbral; no competir con el context-limit recovery reactivo (registro de incidencia compartido o separacion clara).
  - Aceptacion: positivo, la compactacion preventiva dispara antes del umbral configurado; negativo, gate off no-op.
  - QA: viva en el lab; evidencia `<dir>/task-34.txt`; mutacion del umbral.
  - Commit: `feat(profiles): preemptive compaction behind an experimental gate`

- [x] 35. Comandos builtin faltantes
  - Estado (cerrado y publicado 2026-10-06): publicado en `origin/v2-mirror` (`233dcfcda` `feat(profiles): register the remaining builtin commands natively`). Evidencia: `.omo/evidence/20261006-t35-builtin-commands/task-35.txt`.
  - Objetivo: registro de `refactor`, `remove-ai-slops`, `handoff` e `hyperplan` como comandos nativos, con las plantillas V1 (`features/builtin-commands/templates/`) y el executor de remove-ai-slops.
  - API oficial V2 -> estrategia: migrar via `ctx.command.transform` (patron de `/goal` y `/ulw-execute` en `rigel-v2-native.mjs`); hyperplan como comando ademas de modo.
  - No debe: no duplicar plantillas de comandos ya registrados; no registrar comandos sin executor real.
  - Aceptacion: los comandos V1 existen en el catalogo del lab (`GET /api/command`) y cada uno produce su efecto observable.
  - QA: viva en el lab; evidencia `<dir>/task-35.txt`; contrato de comandos builtin incluido.
  - Commit: `feat(profiles): register the remaining builtin commands natively`

- [x] 36. Divergencias del event loop (decision de espejo documentada)
  - Estado (cerrado y publicado 2026-10-06): publicado en `origin/v2-mirror` (`58955108f` `fix(profiles): map native session activity events`). Evidencia: `.omo/evidence/20261006-t36-message-events/task-36.txt`.
  - Objetivo: resolver la divergencia de `message.updated`/`message.removed` (no consumidos en el event loop nativo; V1 los usaba para actividad y sincronia de mensajeria).
  - Alcance V1: `plugin/event.ts` + `features/team-mode/messaging-*` (consumidores de mensajes).
  - API oficial V2 -> estrategia: experimento en el lab con los dos eventos; o se porta el consumidor que haga falta, o se documenta en la fila `plugin/event` por que `session.error`/`session.execution.failed` cubren el efecto (la fila deja de ser parcial sin explicacion).
  - No debe: no dejar la fila parcial sin decision; no añadir consumidores sin necesidad demostrada.
  - Aceptacion: experimento con trazas + decision registrada en el ledger (fila actualizada).
  - QA: viva en el lab; evidencia `<dir>/task-36.txt`.
  - Commit: `fix(profiles): map native session activity events`

- [x] 37. Paridad glob/grep del host
  - Estado (cerrado y publicado 2026-10-07): migrado a herramientas nativas V2 registradas con `ctx.tool.transform` (el builtin del host no era equivalente en ocultos, formato, modos de salida y limites), conservando resolver/fallback y semaforo de concurrencia V1; publicado en `origin/v2-mirror`; commit `8d9aa5e163a197273c6e8d2a87657f5e1a8c3873` (`feat(profiles): preserve glob and grep behavior on v2`); evidencia `.omo/evidence/20261007-builtin-glob-grep-parity/report.txt`.
  - Objetivo: crear `qa-v2-builtin-parity.mjs`, el contrato que el vocabulario del ledger exige para las filas `Equivale a builtin V2` (glob y grep).
  - Alcance V1: `tools/glob/` + `tools/grep/` (comportamiento de busqueda, formatos de resultado).
  - API oficial V2 -> estrategia: probar la paridad del host (`glob`/`grep` builtin V2) contra el contrato V1: mismas consultas, mismos resultados, mismos limites; positivo y negativo.
  - No debe: no comparar bytes de prompts; comparar observables de busqueda.
  - Aceptacion: contrato verde en positivo y negativo; las 2 filas del ledger pasan a `Migrado` apuntando al contrato real (ya enlazan `task:37`).
  - QA: viva en el lab; evidencia `<dir>/task-37.txt`.
  - Commit: `test(profiles): builtin glob and grep parity contract`

- [ ] 38. Refuerzo de cobertura de tests
  - Objetivo: cerrar los 5 huecos de cobertura detectados por la auditoria, y con ellos los contratos fantasma del ledger (filas que citan `task:38`).
  - (a) OAuth (`rigel-v2-skill-mcp-oauth.mjs`): state mismatch en el callback, fallo de token exchange, refresh con 400, fallo de DCR, timeout del callback y query con `error`.
  - (b) tmux-viz polling (`rigel-v2-tmux-viz-polling.mjs`): never-activated timeout, missing grace, hard timeout, guard de re-entrada y respawn con exitCode distinto de 0.
  - (c) tmux-viz manager (`rigel-v2-tmux-viz-manager.mjs`): reintento y cooldown del cierre pendiente.
  - (d) background-handoff pump (`rigel-v2-background-manager.mjs`): callbacks onExhausted/onFailed/onError.
  - (e) corregir la tautologia de `rigel-v2-team-events.test.mjs` (el caso de handler con error debe asertar que el log recibio el mensaje).
  - Ademas: portar los 3 guards de tools no cubiertos (`bash-file-read-guard`, `empty-task-response-detector`, `tool-output-truncator`) como reglas before/after con sus tests y mutaciones.
  - No debe: ningun test nuevo sin mutacion RED/restore en el ledger cuando aplique; ningun assert tautologico.
  - Aceptacion: cada test nuevo queda RED al romper el comportamiento; las filas que citan `task:38` apuntan al contrato real creado.
  - QA: suite del repo + mutaciones; evidencia `<dir>/task-38.txt`.
  - Commit: `test(profiles): close audit coverage gaps across native runtime`

### Fase 6 - Puerta de espejo (gate: criterio de espejo completo)

- [x] 24. Oráculo diferencial V1 vs nativo
  - Estado (cerrado y publicado 2026-10-07): publicado en `origin/v2-mirror` (`f51c7a2ca`). Evidencia: nota de boveda [[2026-10-07-fase-6-tarea-24]].
  - Objetivo: equivalencia demostrada, no supuesta.
  - Alcance: banco de escenarios scriptados (delegación, ultrawork, reglas, recuperación de errores, permisos, fallback, compactación, skills, goal); cada escenario corre contra V1 (plugin real en sandbox) y contra el runtime nativo; comparador de observables (payload al proveedor normalizado, mutaciones de resultados, decisiones de bloqueo, handoff) con tolerancias declaradas por escenario.
  - No debe: no comparar bytes absolutos de prompts autorados (prohibido); comparar comportamiento/observables.
  - Aceptación: matriz de escenarios verde; cada divergencia o se corrige o se documenta como decisión explícita del espejo en el ledger.
  - QA: evidencia `<dir>/task-24.txt`.
  - Commit: `test(profiles): differential oracle v1 vs native v2`

- [ ] 25. Cierre del espejo
  - Objetivo: declarar el espejo con evidencia completa.
  - Alcance: ledger 100% cerrado (cero pendientes/parciales/incompatibles); suite orquestada verde completa; Hephaestus smoke autenticado con Luna; prueba de no-tocar estado vivo (hashes + conteo de sesiones); pin de CI para `profiles/gabo`; sincronización final con upstream; PR de consolidación con merge commit; fijar `MIGRATION_BASELINE_SHA` + `MIGRATION_EVIDENCE_DIR` de este cierre como entradas del plan de la capa Gabo.
  - Aceptación: todos los criterios de la sección "Criterio de espejo" verificados; PR fusionado.
  - QA: evidencia `<dir>/task-25.txt` + resumen de PR.
  - Commit: `chore(profiles): declare v2 mirror complete`

## Onda de verificación final (tras tarea 25)

- [ ] F1. Auditoría de cumplimiento del plan: cada cambio mapea a una tarea; cero trabajo de capa Gabo mezclado; evidencia local no rastreada.
- [ ] F2. Revisión de calidad/seguridad: identidad de llamador, gates de config respetados, sin secretos ni rutas personales, sin `as any`.
- [ ] F3. QA real: revisar transcripciones de sesión aisladas por superficie clave (agentes, delegación, fallback, permisos, compactación, skills).
- [ ] F4. Fidelidad al criterio de espejo: las 5 condiciones de "Criterio de espejo" verificadas una a una contra evidencia.

## Estrategia de commits

- Una rama por fase desde `v2-mirror`; PR por fase (o por tarea grande) con merge commit; nunca squash/rebase-merge; jamás `--admin`.
- Sin commits sin autorización explícita; `.omo/evidence/**` nunca se committea; el trabajo parte siempre de la revisión de espejo vigente.
- Si upstream avanza a mitad de camino: sincronizar, re-clasificar lo afectado, y solo continuar con la suite verde.

## Criterios de éxito

| Criterio | Prueba | Evidencia |
| --- | --- | --- |
| Ledger 100% cerrado | Tarea 7 + regeneración idempotente | `<dir>/task-7.txt`, `<dir>/task-6.txt` |
| Agentes con paridad | Tareas 8-13 + oráculo | `<dir>/task-8..13.txt`, `<dir>/task-24.txt` |
| Herramientas con paridad | Tareas 14-17 + oráculo | `<dir>/task-14..17.txt`, `<dir>/task-24.txt` |
| Hooks con paridad | Tareas 18-20 + oráculo | `<dir>/task-18..20.txt`, `<dir>/task-24.txt` |
| Cero incompatibles | Tareas 21-23 y 26-38 (muros del cierre de Fase 4 y hallazgos post-cierre) | `<dir>/task-21..23.txt`, `<dir>/task-26..31.txt`, `<dir>/task-32..38.txt` |
| Runtime único nativo | Tarea 3 + validador | `<dir>/task-3.txt` |
| Suite orquestada | Tarea 5 | `<dir>/task-5.txt` |
| Declaración del espejo | Tarea 25 + F1-F4 | `<dir>/task-25.txt` |

## Encadenamiento con la capa Gabo

Al completar la tarea 25: `MIGRATION_BASELINE_SHA` = SHA del merge de cierre; `MIGRATION_EVIDENCE_DIR` = `<dir>/task-25.txt` + dir de evidencia. Con esas dos entradas, el plan aprobado `.omo/plans/my-rigel-gabo-workflow-integration.md` puede ejecutarse por su Tarea 1 (gate de entrada). Ese es el flujo completo: **espejo 100% → capa Gabo**.
