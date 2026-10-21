# AUDIT-A2-SIDEBAR-FIDELITY

**Segunda auditoría independiente A2 — fidelidad histórica y contrato conductual del sidebar de Oh My Rigel V2.**
Repetición desde cero. Revisión solo-lectura: no se editó el plan ni el handoff, no se tocó código productivo, tests, bóveda ni stashes, no se aplicó `stash@{0}`, no hubo commit/push/PR, no se lanzó ningún proceso OpenCode, no se usó Docker ni V1/NLS1.

- Worktree auditado: `/home/gabodev/oh-my-rigel-worktrees/research-v2-sidebar-parity-plan`
- Rama: `research/v2-sidebar-parity-plan` — HEAD: `404a6290134d1704bb44eff7c092c161770f49e2`
- Objetos auditados: `.omo/drafts/v2-sidebar-parity-reversible-plan.md` (606 líneas) y `HANDOFF-SIDEBAR-RESEARCH.md` (156 líneas)
- **Método:** no se confió en `AUDIT-A-SIDEBAR-FIDELITY.md` ni en la tabla de correcciones A-01..A-11 del autor. Se volvió a contrastar cada afirmación contra fuentes primarias: código/tests del padre (`packages/omo-opencode/src/**`), puerto V2 (`profiles/gabo/opencode/rigel-v2-*.mjs`), ledger (`profiles/gabo/V2_MIGRATION_INVENTORY.md`, `profiles/gabo/migration-classifications/features.mjs`), sonda QA (`profiles/gabo/qa-v2-t25-live-surfaces.mjs`), commits/revert y `refs/stash` (leído sin aplicar), bóveda `oh-my-rigel-vault` y doc oficial `https://opencode.ai/v2/docs/build/plugins/cli`.
- `rigel-session-start` cargado; runtime de laboratorio = `opencode-v2-lab.service` (no se invocó). `protect-opencode-v1.md` respetado.

---

## 0. Integridad de baseline y estado git (verificado)

- Los cinco hashes SHA-256 de baseline (§6.9 del plan / §10 del handoff) coinciden **byte a byte** con HEAD:
  `rigel-v2-native-cli-sidebar.mjs` `a15f4ea2…b443`, `.test.mjs` `20d8a659…7846`, `sidebar-core.mjs` `10785b83…c508`,
  `sidebar-core.test.mjs` `3b3197c8…f85a`, `native-cli.mjs` `e96566ea…649a`. **Fidelidad verificada.**
- Línea temporal de §2.1 = `git log --oneline --ancestry-path 63c529818..HEAD` (18 entradas, mismo orden). ✔
- `6a46ed3ef`: `24 files changed, 85 insertions(+), 1779 deletions(-)` — coincide con §2.2. ✔
- `refs/stash` = `stash@{0}` ("On fix/v2-live-sidebar-propagation: pre-rollback-candidate 20261011"), no aplicado. ✔
- `git status`: solo `?? AUDIT-A-SIDEBAR-FIDELITY.md` y `?? HANDOFF-SIDEBAR-RESEARCH.md` antes de esta auditoría; sin cambios de código productivo.

---

## 1. VEREDICTO

**NEEDS_CORRECTION.**

El plan corregido es, en sustancia, fiel: preserva el contrato (default-ON como objetivo, OFF en dev/canario, activación en fase de release separada), reconcilia la bóveda artefacto por artefacto, cubre las 27 capacidades con fila y prueba, separa frescura observable de código inerte, separa el seam headless del seam visual, y etiqueta la API objetivo frente al código actual. La mayoría de las citas de código del padre son exactas (ver §6).

**No puede recibir PASS** por dos razones de materialidad y varias de precisión:

1. **(material) El seam headless del recibo se atribuye a `opencode-v2-lab.service`, pero la fuente primaria de la bóveda que el propio plan cita (línea 45 de `2026-10-08-fase-6-tarea-25.md`) dice que ese servicio NO construye el contexto de plugin CLI y que los recibos durables los aserta la sonda, no el servicio.** Tal como está redactado, el gate de P3 (§6.4) y §7C quedarían vacíos: el servicio no produciría ni el recibo ni los eventos de slot. Ver A2-01.
2. **(material) La equivalencia reactiva de los timers (`WRITE_DEBOUNCE_MS`/`HEARTBEAT_MS`/`POLL_INTERVAL_MS`) se clasifica "Cubierta" con una prueba propuesta ("cadencia en log/recibo") que no puede existir en la superficie V2 sin temporizadores, y no se marca como inferencia/incógnita.** El contrato A2 exige cada timer en la matriz. Ver A2-02.
3. **(precisión) El inventario de `stash@{0}` de §2.4 tiene cifras incorrectas y omite 3 archivos.** Ver A2-03.

No es REJECT: los defectos son de seam/registro y son corregibles de forma aditiva; el contrato funcional no se reduce; nada exige tocar V1.

**Pregunta central de A-01 (default ON/OFF):** resuelta de forma compatible con la regla vinculante. El plan declara el default-ON del padre + catálogo como **objetivo de paridad no rebajado** y el OFF como **estado de dev/canario**, con la activación en **P5 (fase de release separada)** y la resolución del mantenedor registrada en §2.5. La excepción de Gabo que exige `Principios_de_Migracion_V2.md:82` queda cubierta por esa resolución (contrato `sidebar-correction-a-contract.md`) y por la separación P0..P4 / P5. ✔ Esto satisface A-01/A-02 de la auditoría previa.

---

## 2. HALLAZGOS

### A2-01 — ALTA — El seam headless del recibo se atribuye al servicio del laboratorio, que según la bóveda no carga el companion CLI.

**Hecho (fuente primaria citada por el propio plan):** `evidencias/2026-10-08-fase-6-tarea-25.md:45` afirma: *"El render visual … de toasts y sidebar no es observable en `opencode-v2-lab.service`: ese servicio es headless y **no construye el contexto de plugin CLI** (el companion `./tui` solo lo carga el renderer/TUI). **La sonda aserta** las llamadas reales al sink (`ui.toast.show`, `ui.slot`, `ui.dialog.select`) y **los recibos durables**, que es la observación más fuerte por la vía autorizada."*

**Lo que hace el plan:**
- §6.4 P3: *"Encender el flag solo en `opencode-v2-lab.service` … El laboratorio es headless: **valida el recibo durable** `sidebar-snapshot.json`, la registracion/fallo del slot y los eventos de log …"*.
- §7C: *"**Seam headless autorizado (lab):** recibo durable `sidebar-snapshot.json`; registracion/fallo del slot; eventos de log … **Esto es lo que el laboratorio puede observar realmente.**"*

**Por qué es un defecto material:** el recibo `sidebar-snapshot.json` (y los eventos `slot-registered` / `slot-register-failed` / `headless-receipt-only`) los produce `createSidebarCliSurface().setup()`, es decir el **companion CLI** (`rigel-v2-native-cli-sidebar.mjs:306-311,352-368`), que el plan ubica en `rigel-v2-native-cli.mjs` (entrada `./tui`). El servicio del laboratorio es `opencode serve` (ver `apply-v2-runtime-service.sh` y `qa-v2-t25-live-surfaces.mjs:4-8`, que documentan la misma causa raíz), que **no** carga `./tui`. La aceptación del laboratorio (`run-lab-acceptance.sh`) ejercita el **launcher CLI instalado** con comandos (`qa-v2-cli-installed.mjs`), no el `setup()` del plugin CLI. Por tanto, tal como está escrito, P3 no produciría ninguna de las observaciones que promete, y el `--refresh`/`run-lab-acceptance.sh` no las asertaría.

**Corrección exigida:** designar explícitamente el **seam hermético que sí construye el contexto de plugin CLI** (el patrón `qa-v2-t25-live-surfaces.mjs`, que arma `{ options, renderer, location, data, ui:{slot}, … }` y acciona el `setup()` real) como el observador del recibo/slot/logs; y aclarar en §6.4 P3, §6.6 y §7C que `opencode-v2-lab.service` **por sí solo** no observa el companion CLI (coherente con la línea 45 de la bóveda que el propio plan cita para el seam visual). Alternativamente, mover el escritor del recibo al entrypoint servidor o probar que el laboratorio carga `./tui`. No se puede afirmar "esto es lo que el laboratorio puede observar realmente" para el recibo mientras la bóveda diga lo contrario.

### A2-02 — MEDIA — Los timers se marcan "Cubierta" con una prueba inejecutable y sin marcar la equivalencia como inferencia.

**Hecho del padre:** `WRITE_DEBOUNCE_MS=250`, `HEARTBEAT_MS=2000`, `POLL_INTERVAL_MS=1000` (`constants.ts:5-7`); el servidor hace `flush()` con debounce 250 ms y un heartbeat de 2 s (`mirror-manager.ts:42-85`, `HEARTBEAT_MS`, `unref()`), y la TUI sondea con `setTimeout(..., POLL_INTERVAL_MS)` (`tui.ts:165-189`). El **heartbeat es el driver de reloj** que mantiene el espejo fresco sin eventos (la TUI descarta el espejo a los 6 s, `mirror-io.ts:36-38`).

**Lo que hace el plan:**
- §6.3: *"Poll/debounce/heartbeat → **Reescribir** (donde aplique) … sin temporizadores si el host ya reactividad"*.
- §6.10 fila 9: estado **"Cubierta"**, prueba propuesta *"unit (reloj inyectado) + canario"*, evidencia *"cadencia en log/recibo; equivalencia reactiva"*.

**Por qué es un defecto:** la superficie V2 (`rigel-v2-native-cli-sidebar.mjs`) **no tiene temporizadores**: se suscribe a eventos (`context.data.on(...)`, líneas 374-393) y recalcula en cada render. No existe ninguna "cadencia en log/recibo" que observar, así que la prueba propuesta no mapea a la superficie. La equivalencia "reactivo sustituye heartbeat" es una **inferencia no demostrada** (y potencialmente una reducción, si la frescura periódica no se preserva sin eventos), pero la fila la da por **Cubierta** sin marcar la incógnita, a diferencia del tratamiento correcto que A-05 dio a la frescura 6 s (fila 10, "Inerte").

**Corrección exigida:** reclasificar la fila 9 de forma honesta: (a) aportar evidencia de que la vía reactiva reproduce la frescura periódica del heartbeat, o (b) conservar un refresco periódico explícito en V2, o (c) marcar la equivalencia como **inferencia/incógnita abierta** (no "Cubierta"), y sustituir "cadencia en log/recibo" por la observación realmente disponible. El contrato A2 exige cada timer en la matriz con estado veraz.

### A2-03 — MEDIA — El inventario de `stash@{0}` (§2.4) tiene cifras incorrectas y está incompleto.

**Hecho verificado** (`git stash show --numstat stash@{0}`):

```
1	0	bun.lock
1	0	package.json
52	0	profiles/gabo/opencode/rigel-v2-native-agents.test.mjs
147	38	profiles/gabo/opencode/rigel-v2-native-cli-sidebar.mjs
113	5	profiles/gabo/opencode/rigel-v2-native-cli-sidebar.test.mjs
72	1	profiles/gabo/opencode/rigel-v2-native-runtime.test.mjs
4	1	profiles/gabo/opencode/rigel-v2-sidebar-node.mjs
6	0	test-env.ts
```

**Lo que dice §2.4:**
- *"`rigel-v2-native-cli-sidebar.mjs` (+185/-45)"* → incorrecto: es **+147/−38** (`185` es el total de líneas cambiadas de `--stat` y `45` es el total de borrados de todo el stash; ni son añadidos).
- *"`rigel-v2-sidebar-node.mjs` (+5)"* → incorrecto: es **+4/−1**.
- **Omite 3 archivos del candidato:** `rigel-v2-native-cli-sidebar.test.mjs` (+113/−5), `rigel-v2-native-agents.test.mjs` (+52) y `rigel-v2-native-runtime.test.mjs` (+72/−1). Los dos últimos tocan selección de agente/modelo y el runtime — justo lo que §2.4 advierte que "roza la tarea paralela de modelos" — y el plan no los menciona.

**Por qué importa:** §2.4 se titula "Contenido del candidato (diff verificado)" y sirve de materia prima para P1/P2; una cifra errónea y un inventario incompleto rompen la trazabilidad que la auditoría A2 debe verificar.

**Corrección exigida:** corregir las cifras a **+147/−38** y **+4/−1** y enumerar los 8 archivos del stash (o declarar explícitamente que la lista es parcial), señalando los tres tests omitidos.

### A2-04 — BAJA — `session-last-agent.ts` se cita sin su ruta real (no está en `features/tui-sidebar/`).

`session-last-agent.ts` **no** vive en `packages/omo-opencode/src/features/tui-sidebar/`: está en `packages/omo-opencode/src/hooks/atlas/session-last-agent.ts` (importado por `snapshot-builder.ts:1`). El plan lo cita desnudo junto a archivos de `tsb/` en §3.1 (*"`snapshot-builder.ts:64-90`; `session-last-agent.ts:73-141`"*), §3.5, §3.6 y en la fila 17 de §6.10. Los números de línea sí son correctos (`getLastAgentFromSession` en 73-141; saltos de compactación en 56 y 120), pero la ubicación se presenta como si fuera del módulo tui-sidebar. **Corrección:** dar la ruta completa `hooks/atlas/session-last-agent.ts`.

### A2-05 — BAJA — Fila 27 de la matriz cita `tui.ts:3-5` donde el esquema vive en `config/schema/tui.ts:3-5`.

§6.10 fila 27 escribe *"(`tui.ts:3-5`, `oh-my-opencode-config.ts:99`)"*. El esquema del flag es `packages/omo-opencode/src/config/schema/tui.ts:3-5` (el propio plan usa esa ruta en §2.5 y §3.9). `tui.ts:3-5` es ambiguo con `packages/omo-opencode/src/tui.ts:3-5` (imports de `btw-side`/`native-edition-nudge`), que no tiene nada que ver. **Corrección:** usar `config/schema/tui.ts:3-5`.

---

## 3. TABLA DE COBERTURA DE CAPACIDADES (verificación independiente)

Leyenda: **Cubierta** = conducta del padre con fila en §6.10 y prueba verificable en la superficie V2 autorizada. **Seam visual** = solo verificable en el render (correctamente separado por A-06). **Inerte** = código portado sin camino de runtime. **Objetada** = fila presente pero con estado/prueba incorrectos (ver hallazgo).

| # | Capacidad del padre (fuente verificada) | Fila §6.10 | Verificación A2 | Estado |
|---|---|---|---|---|
| 1 | Banner config invalida (`render-view.ts:67-76`) | 1 | Cita exacta; `configBanner` en `view` del recibo (`sidebar.mjs:309`) | Cubierta |
| 2 | ULW goals/pass/fail/pending/blocked/active (`render-view.ts:95-100`) | 2 | Cita exacta | Cubierta |
| 3 | Seccion Agents (`render-view.ts:131-137`) | 3 | Cita exacta | Cubierta |
| 4 | Seccion Jobs, `toolCalls`/`lastTool` (`render-view.ts:159-166`) | 4 | Cita exacta (texto en 164) | Cubierta |
| 5 | Vista idle + roster Models (`render-view.ts:196-209`) | 5 | Cita exacta | Cubierta |
| 6 | Arbol `ViewNode` + materializacion (`element-helpers.ts`, `tui.ts:49-70`) | 6 | Citas exactas; correctamente "Seam visual" | Seam visual |
| 7 | Maquina de estados active/broken/idle (`compute-view.ts:20-36`) | 7 | Cita exacta (`isActive` 57-59) | Cubierta |
| 8 | Transiciones idle↔active, active→broken, sesion creada/cerrada | 8 | Existe prueba propuesta (secuencia de `viewKey`); sin contradiccion | Cubierta |
| 9 | Debounce 250 ms / heartbeat 2 s / poll 1 s (`constants.ts`, `mirror-manager.ts`, `tui.ts:165-189`) | 9 | **Sin temporizadores en V2; prueba propuesta inejecutable; equivalencia no demostrada** | **Objetada (A2-02)** |
| 10 | Frescura snapshot 6 s (`mirror-io.ts:36-38`) | 10 | Correcto: `isSnapshotFresh`/`STALE_MS` solo en core+test; sin canal de espejo | Inerte (OK) |
| 11 | Frescura loop 120 s (`loop-reader.ts:108`) | 11 | Correcto: `isLoopFresh` **en uso** (`sidebar.mjs:44,239`) | Cubierta |
| 12 | Caps `MAX_AGENTS`/`MAX_JOBS` 12 y `LABEL_MAX` 24 (`derivers.ts`, `render-view.ts:218-220`) | 12 | Citas exactas (core `:43-45`) | Cubierta |
| 13 | Redaccion goal activo → `private` (`snapshot-builder.ts:101-106`, `render-view.ts:222-224`) | 13 | Citas exactas | Cubierta |
| 14 | Espejo ruta/hash/projectDir canonico/0600 (`mirror-path.ts`, `mirror-io.ts`) | 14 | Citas exactas; recibo 0600 (`sidebar.mjs:310`) | Cubierta |
| 15 | Tema (`render-view.ts:14-23`, `tui.ts:162`) | 15 | Cita exacta; correctamente "Seam visual" | Seam visual |
| 16 | Agentes activos `busy\|retry\|running` (`snapshot-builder.ts:64-90`) | 16 | Cita exacta (`activeStatus` 81-90) | Cubierta |
| 17 | Nombre por ultimo mensaje no-compactacion (`session-last-agent.ts`) | 17 | Lineas exactas (56, 120); **ruta imprecisa** | Cubierta (A2-04) |
| 18 | Roster = tabla de resolucion de modelos (`roster-resolver.ts`) | 18 | Cita exacta; `sisyphus`+`deep-low` por defecto verificados en `roster-resolver.test.ts:64-65` | Cubierta |
| 19 | Compuerta loop live (algun `in_progress`) (`loop-reader.ts:113`) | 19 | Cita exacta (`loop-reader.ts:113`; V2 `sidebar.mjs:241`) | Cubierta |
| 20 | Attach: mirror si `!== false` (`create-managers.ts:199-205`) | 20 | Cita exacta (`if` en 199; `start()` 205) | Cubierta |
| 21 | Dispose: tres rutas de `stop()` (`create-managers.ts:120,184`, `plugin-dispose.ts:28`) | 21 | Cita exacta (grep confirma 120/184/28) | Cubierta |
| 22 | Concurrencia: dedup flush, heartbeat `unref()` (`mirror-manager.ts`) | 22 | Cita exacta | Cubierta |
| 23 | Reconexion inexistente + degradacion a idle/broken | 23 | Sin contradiccion | Cubierta |
| 24 | Permisos: sin chequeos en el sidebar | 24 | n/a por contrato | n/a |
| 25 | Fallos parciales: degrada sin lanzar | 25 | Sin contradiccion | Cubierta |
| 26 | No interactivo: sin TUI el servidor escribe el espejo (`qa/register-and-run.sh` existe) | 26 | Fila correcta como seam; **ver A2-01 sobre la atribucion del recibo V2** | Cubierta |
| 27 | Semantica de configuracion: ON salvo `false` (`config/schema/tui.ts:3-5`, `oh-my-opencode-config.ts:99`) | 27 | Esquema exacto (`enabled: z.boolean().default(true)`); **cita abreviada erronea** | Cubierta (A2-05) |

**Resultado:** las 27 capacidades tienen fila. 22 Cubiertas, 2 Seam visual, 1 Inerte (correcto), 1 n/a, y **1 objetada** (fila 9). Las áreas exigidas por A2 (transición, timer, tema, espejo, filtro, roster, gate, config) están todas presentes; la de timers es la única con estado no veraz.

---

## 4. VERIFICACIÓN DE LAS ÁREAS EXIGIDAS POR EL CONTRATO A2

| Área exigida | Resultado | Evidencia |
|---|---|---|
| default-ON objetivo final; flag OFF en dev/canario | **CUMPLE** | Plan §2.5 (resolución del mantenedor), §6.2, §6.4 (P5), §6.10 fila 27, §7A. Contrato del padre `config/schema/tui.ts:3-5` + `tui.ts:145`; catalogo `Catalogo_Funciones_OMR_V2.md:170`; gate actual `native-cli.mjs:48` (`=== true`) y superficie `native-cli-sidebar.mjs:77-81` (`!== false`) — "doble gate" documentado correctamente. |
| Separación baseline seguro / activación de release | **CUMPLE** | P0..P4 no activan por defecto; P5 es fase de release separada gated en auditorías A+B+C. §6.4, §6.8. |
| Reconciliación completa de notas de bóveda superadas por el revert | **CUMPLE** | §2.6 lista los 5 artefactos que afirman "cerrado/integrado": `Mantenimiento_OMR_MOC.md:73`, `Contrato_Ejecucion…:53`, `pausa-independencia…:48`, `correccion-sidebar-tui-v2.md` (estado INTEGRADA), `Catalogo…:170`. Barrido del vault (`grep -rin "Validación V2" *.md`) no encontró un sexto artefacto relevante. Citas de línea exactas. |
| Cobertura de las 27 capacidades y cada transición/timer/tema/espejo/filtro/roster/gate/config | **CUMPLE salvo timers** | §6.10, ver §3. La única fila con estado incorrecto es la 9 (timers). |
| Frescura observable vs código inerte | **CUMPLE** | Fila 11 (loop 120 s, `isLoopFresh` en uso) vs fila 10 (snapshot 6 s, `isSnapshotFresh` solo core+test). Nota A-05 correcta. |
| Recibo headless vs seam visual real, sin prometer TUI directa | **PARCIAL** | El seam visual está correctamente marcado "no observado"/separado (§6.4 P3, §6.6, §7C) y no se promete TUI. **Pero** el seam headless se atribuye al servicio del laboratorio (A2-01), contra la línea 45 de la bóveda. |
| Citas/hechos corregidos | **PARCIAL** | Mayoría exacta (§5). Persisten: cifras del stash (A2-03), ruta `session-last-agent.ts` (A2-04), `tui.ts:3-5` (A2-05). |
| API objetivo diferenciada del código actual | **CUMPLE** | §4 etiqueta la columna "V2 (API objetivo, doc oficial)" y aclara que HEAD lee `data.session.list()` / `data.roster\|data.agents\|data.models` (`sidebar.mjs:128-133,186-196`). Doc oficial verificada: `context.ui.slot({append:"sidebar.content"})`, `context.data.session.list/get/status`, `context.data.location.{agent,model}.list(location)`, `context.ui.model.current()`, `context.theme.text.base`, `context.renderer`, peers `solid-js >=1.9.0`/`@opentui/solid >=0.5.8`, `setup`→cleanup. A-10 correcta: `btw.md:86-89` solo respalda "no split"; el fallback `ui.slots.register` está atribuido al código (`btw.mjs:246-248`), no a la doc. `context.rpc` no aparece en la doc (consistente con "no confirmado"). |

---

## 5. ANEXO — Verificación puntual de citas (muestra)

Verificadas **exactas**:
- `tui.ts:35-47` (`registerSidebarContentSlot`, `order:900`, `sidebar_content`), `:49-56` (`materialize` con caja raíz `flexDirection:"column"`), `:145` (`enabled === false`), `:162` (`api.theme.current`), `:165-189` (poll 1 s + diff `viewKey`), `:192-195` (`onDispose`). ✔
- `render-view.ts:14-23` (tokens de tema), `:29` (raíz `gap:1` — A-08 correcta), `:67-76`, `:95-100`, `:131-137`, `:159-166`, `:187-194`, `:196-209`, `:211-216`, `:218-220`, `:222-224`. ✔
- `state-types.ts:51-53,55-64`; `constants.ts` (los 10 knobs con valores exactos); `compute-view.ts:20-36,31-33,35,57-59,38-123`; `derivers.ts:14-21,23-32,45-54,56-65`. ✔
- `loop-reader.ts:59-206,107-115,113,160-185,171-179,189-190,199-206`; `mirror-io.ts:10-40,36-38` (0600 en 15, projectDir canónico en 33); `mirror-path.ts:8-31` (sha1 slice 16); `mirror-manager.ts:42-136,72-84,122-136`. ✔
- `snapshot-builder.ts:51,55-90,64-90,81-90,92-99,101-106`; `snapshot-schema.ts` (version literal 1); `roster-resolver.ts:23-36,53-81,68-81`; `element-helpers.ts:1-16`. ✔
- `hooks/atlas/session-last-agent.ts:56,73-141,120` (líneas correctas; ruta imprecisa — A2-04). ✔
- `create-managers.ts:120,184,199-205`; `plugin/event.ts:135`; `plugin-dispose.ts:28`; `testing/create-plugin-module.ts:229`; `cli/doctor/checks/tui-plugin-config.ts`; `features/tui-sidebar/qa/register-and-run.sh`; `hooks/goal/controller.ts:29-45` (escribe `.omo/ulw-loop/<id>/goals.json` v1). ✔
- V2: `native-cli-sidebar.mjs:77-81` (`!== false`), `:128-133` (`data.session.list()`), `:186-196` (`data.roster|agents|models`), `:239,241` (`isLoopFresh` + `in_progress`), `:306-311` (recibo 0600), `:331-334,341-350` (`describeView` como render por defecto), `:352-368` (slot). `native-cli.mjs:48` (`=== true`). ✔
- `qa-v2-t25-live-surfaces.mjs:172` (`options: {}`), `:182` (captura de slot), `:246-247` (positivo exige `sidebar.content`), `:273-278` (negativo `enabled:false`). Con el gate actual `=== true` el positivo falla → "stale" confirmado. ✔
- Ledger: `V2_MIGRATION_INVENTORY.md:166` y `features.mjs:182/186` ("ausente = encendida; false = inerte"), estado "Migrado". ✔
- Revert: `notification-activation-config.mjs`/`.test.mjs` **existen** en HEAD y en `63c529818`; `2e84941b2` los modifica (`35/1` y `90/0`); `6a46ed3ef` los revierte en contenido (`1/35` y `0/90`) — **modificados y revertidos, no borrados** (A-07 correcta). Los archivos `rigel-v2-sidebar-node/-theme.mjs` y `v2-agent-selection-core.mjs` existen en HEAD y en base = **MISSING** (creados por `c92e0a5e`, borrados por el revert). ✔
- Bóveda: `Principios_de_Migracion_V2.md:14,20,58,82` (texto citado exacto); `Catalogo…:170`; `Mantenimiento_OMR_MOC.md:73`; `Contrato_Ejecucion…:53`; `pausa-independencia…:48`; `2026-10-08-fase-6-tarea-25.md:45`; `correccion-sidebar-tui-v2.md` (PR #12, `843983475`, TUI 200×50, suite 2301). ✔

---

## 6. PREGUNTAS DESCONOCIDAS (explícitas)

1. **¿Qué seam autorizado construye realmente el contexto de plugin CLI** para asertar el recibo/slot/logs del sidebar, dado que `opencode-v2-lab.service` es `opencode serve` y no carga `./tui`? (A2-01) ¿Se adopta el patrón de sonda `qa-v2-t25-live-surfaces.mjs`, se mueve el recibo al entrypoint servidor, o se reconfigura el laboratorio?
2. **¿La vía reactiva de V2 (`context.data.on`) reproduce la frescura periódica del heartbeat del padre** sin eventos, o se necesita un refresco periódico explícito? (A2-02) Sin esto, la fila 9 no puede marcarse "Cubierta".
3. **¿Debe `stash@{0}` tratarse como fuente canónica de P1/P2** pese a que la rama `fix/v2-live-sidebar-propagation` ya fue revertida? Los 3 tests omitidos (A2-03) sugieren que el candidato arrastra cambios ajenos al sidebar.
4. **¿El estado OFF de dev/canario es la única divergencia de ledger**, o `features.mjs:186` ("ausente = encendida") describe correctamente la semántica de la *superficie* (`resolveSidebarGate`) y por tanto no es "desactualizado" sino la contraparte del composer? El plan lo trata como divergencia de tres capas; conviene fijar cuál de las dos semánticas es la canónica en P0.

---

**Firma:** Auditoría A2 (fidelidad histórica y contrato conductual) — segunda pasada, revisión independiente, solo lectura.
No se autoaprueba. Veredicto **NEEDS_CORRECTION** por A2-01 y A2-02 (materiales) y A2-03/A2-04/A2-05 (precisión). No se editó el plan ni el handoff, no se tocó código productivo, tests, bóveda ni stashes, no hubo commit/push/PR, no se aplicó `stash@{0}`, no se lanzó OpenCode, no se usó Docker.
