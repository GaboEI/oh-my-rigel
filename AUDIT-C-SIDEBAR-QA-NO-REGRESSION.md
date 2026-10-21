# AUDIT-C-SIDEBAR-QA-NO-REGRESSION - Auditoria C independiente (QA real / no-regresion)

> **DRAFT / NO IMPLEMENTAR.** Auditoria de solo lectura. No se edito el plan, ni el handoff, ni codigo productivo,
> ni tests, ni la boveda, ni el stash. No hubo commit / push / PR. No se lanzo ningun proceso OpenCode. No se uso
> Docker. No se toco V1, NLS1, produccion ni secretos. No se delego a sub-agentes ni se uso orquestacion: la
> verificacion se hizo directamente contra fuentes primarias (codigo, tests existentes, seam de QA, scripts de
> instalacion/lab, historial git y el propio plan).

## 0. Alcance, metodo e independencia

- **Objetivo auditado:** `.omo/drafts/v2-sidebar-parity-reversible-plan.md` (865 lineas) y
  `HANDOFF-SIDEBAR-RESEARCH.md` (246 lineas), en el worktree
  `/home/gabodev/oh-my-rigel-worktrees/research-v2-sidebar-parity-plan`, rama `research/v2-sidebar-parity-plan`,
  baseline `404a629`.
- **Encargo:** contrato `sidebar-audit-c-prompt.txt`. Determinar si el plan define pruebas **reales, suficientes y
  ejecutables** para lograr paridad del sidebar **sin alterar el baseline actual, especialmente con el feature flag
  OFF**, y si cada conducta historica tiene prueba positiva, negativa, lifecycle, fallo, rollback y no-regresion.
- **Independencia:** esta ronda **no** adopta el veredicto de `AUDIT-A3-SIDEBAR-FIDELITY.md` (PASS) ni de
  `AUDIT-B2-SIDEBAR-ARCHITECTURE.md` (PASS). A3 audito fidelidad documental y B2 audito arquitectura/aislamiento;
  **ninguno de los dos es un gate de QA ejecutable**, que es exactamente lo que este contrato exige. Se re-verifico
  contra fuentes primarias: los tests que existen hoy, el seam `qa-v2-t25-live-surfaces.mjs`, el helper de contexto
  que ese seam importa, la superficie y el compositor, y las lineas del plan que prometen pruebas.
- **Fuentes primarias releidas:** `profiles/gabo/**` (compositor CLI `rigel-v2-native-cli.mjs`; superficie
  `rigel-v2-native-cli-sidebar.mjs` + su test; core puro `rigel-v2-sidebar-core.mjs` + su test; seam
  `qa-v2-t25-live-surfaces.mjs`; helper `differential-oracle/entrypoint/fake-context.mjs`; scripts de lab/instalador),
  `git` (SHAs, `--stat`, `--numstat`, `stash show`, `cat-file`) y el padre
  (`packages/omo-opencode/src/features/tui-sidebar/**`, `tui.ts`, `config/schema/tui.ts`).
- **Baseline verificado:** `HEAD = 404a6290134d1704bb44eff7c092c161770f49e2`; `git status` del arbol rastreado
  limpio; los unicos untracked son los documentos de auditoria/handoff.

## 1. Veredicto

**NEEDS_CORRECTION.**

El plan protege correctamente el baseline con el flag OFF (gate del compositor `=== true`, cero side effects con el
flag apagado) y define una bateria de gates transversalmente amplia (capacidad fail-closed, XDG, rollback desplegado,
activacion/desactivacion, doble setup, no-gating de modelos, flat install/peers). Esos puntos son correctos y se
registran como PASS.

Sin embargo, el plan **no cierra el gate de QA mas critico del propio objetivo**: no existe un gate ejecutable que
observe el **render** del slot y que distinga nodo de **texto plano**, que es la causa raiz historica del crash y del
revert en bloque. La responsabilidad del render se delega a la fila "Seam visual" (declarada **no observada**), el
seam hermetico designado **no invoca `render()` ni valida su salida**, y la suite existente **fija hoy el texto plano
como comportamiento esperado** (`rigel-v2-native-cli-sidebar.test.mjs:170`). En consecuencia el canario P3 puede
quedar **verde** con el render aun roto, y la implementacion por fases P0..P4 no queda protegida contra la
reincidencia exacta que el plan debe eliminar.

Ademas, el plan describe el seam como "contexto de plugin CLI **real**" cuando el propio modulo que lo construye se
documenta como `Fake OpenCode V2 setup context` (`fake-context.mjs:1`): el `setup()` es real, pero el contexto es un
sustituto armado a mano. El contrato C exige "QA en laboratorio V2 real" y "rechaza helpers simulados como sustituto
de la ruta real"; el plan no reconcilia ninguna de las dos cosas, y deja el gate de render real "a definir".

Hay **1 BLOCKER**, **2 MAJOR** y varios MINOR/INFO. Un BLOCKER impide PASS bajo la regla del contrato ("PASS solo si
el plan puede autorizar una implementacion por fases sin huecos de QA ni riesgo no controlado").

## 2. Evidencia primaria verificada (reproducible)

Cada fila es lo que devolvio la fuente, no lo que afirma el plan.

### 2.1 El render actual entrega texto plano (causa del crash), y la suite lo fija como esperado

| Hecho verificado | Fuente observada | Veredicto |
| --- | --- | --- |
| `render` de la superficie devuelve `describeView(view)` por defecto (una **cadena**); en error devuelve `""` (tambien cadena) | `rigel-v2-native-cli-sidebar.mjs:329-345` (`renderView` -> `return describeView(view)`; `render` -> `renderView(view)`) | OK (es la causa historica) |
| La suite existente **asserta el texto plano**: `expect(fake.slotCalls[0].render()).toBe("No configured models")` | `rigel-v2-native-cli-sidebar.test.mjs:170` (y llama `render()` en `:162`; `typeof render === "function"` en `:105`) | **Confirmado** |
| El core produce una **IR agnostica** `{kind:"box"\|"text"}` (`buildViewNodes`), no un nodo del host | `rigel-v2-sidebar-core.mjs:506` (`{kind:"box"}`), `:511` (`{kind:"text"}`), `:514` (`buildViewNodes`); el unico test es `buildViewNodes(view, {}).length === 1` (`rigel-v2-sidebar-core.test.mjs:433`) | OK (IR, no nodo) |
| El seam **no** llama a `render()` ni comprueba su tipo; solo verifica que el slot se registro y que existe el recibo | `qa-v2-t25-live-surfaces.mjs` (asercion de slot y lectura del recibo); `grep` de `.render(` en el seam: sin resultados | OK (hueco) |
| No existe ningun test que ejecute el host real y cargue `./tui` | `grep` de `opencode serve\|opencode run\|./tui\|renderTree\|sidebar.content` en `profiles/gabo/**/*.mjs`: sin un test de host real; el seam es in-process | OK |

Conclusion de 2.1: hoy el comportamiento con flag ON es **texto plano**, la suite lo **aprueba**, y no hay gate que lo
atrape. El plan propone materializar un nodo (P1.2) pero **no** asigna una asercion ejecutable "render devuelve nodo,
no texto" a ningun gate, y **no** instruye actualizar/invertir el test que hoy fija el texto.

### 2.2 El observador designado usa un contexto sustituto, no el host

| Hecho verificado | Fuente observada | Veredicto |
| --- | --- | --- |
| El seam importa `createEntrypointContext` desde `differential-oracle/entrypoint/fake-context.mjs` | `qa-v2-t25-live-surfaces.mjs:33` | OK |
| Ese modulo se documenta literalmente como `Fake OpenCode V2 setup context` | `fake-context.mjs:1-2` | OK |
| El plan lo llama "contexto de plugin CLI **real**" | `.omo/drafts/...:828` (encabezado §7C) y §6.5/§6.7 | **Imprecision material** |
| El laboratorio `opencode-v2-lab.service` (`opencode serve`) **no** construye el contexto CLI ni carga `./tui` | plan §6.4 P3.1, §7C; `qa-v2-t25-live-surfaces.mjs:4-12` | OK |

Conclusion de 2.2: el `setup()` ejercitado es el real, pero el contexto es un **fake** deliberado. El seam prueba
rutas de codigo y registros, no la aceptacion del host. La afirmacion "contexto CLI real" es exagerada y el contrato
rechaza explicitamente usar un helper simulado como sustituto de la ruta real.

### 2.3 Gates que si estan bien fundados (se registran como PASS)

| Gate | Evidencia primaria | Veredicto |
| --- | --- | --- |
| Flag OFF no altera el baseline | Compositor exige `=== true` (`rigel-v2-native-cli.mjs:48,54`); superficie `!== false` (`rigel-v2-native-cli-sidebar.mjs:77-81`). Con flag OFF no se compone la superficie: sin slot, sin recibo, sin log, sin suscripciones | PASS |
| Controles negativos | Seam: negativo de gate con `enabled:false` -> `gatedSlots.length === 0`; test de superficie con gate deshabilitado -> sin slot, sin recibo, sin handlers, sin logs | PASS |
| Capacidad fail-closed | Plan §6.2 matriz unica + P1.1 (compositor antes de instanciar); §6.7 exige cubrir todas las filas | PASS (diseno) |
| `XDG_STATE_HOME` explicito | Plan §6.6/§6.7; fallback real en `resolveStateRoot` (`rigel-v2-native-cli-sidebar.mjs:83-86`) | PASS |
| Rollback de artefactos desplegados | Plan §6.8 pasos 1-5; campos reales `cli.singleRigelEntry`/`cli.runtimeMatchesConfig`/`runtime.digestMatches` (`rigel-v2-user-install.mjs:328,340,341,345`) | PASS |
| Activacion/desactivacion por config | Plan P0.4/P0.5 + §6.9; ruta unica §2.7 verificada por B2 | PASS (diseno) |
| Doble setup / concurrencia | Plan P1.3 + §6.7 (contadores de suscripciones y slots) | PASS (diseno) |
| No-gating de modelos / delegacion / orquestacion | Plan §6.3 P2.3 (read-only) + prueba de no alterar la seleccion; superficie importa solo core + Node (`rigel-v2-native-cli-sidebar.mjs:31-48`) | PASS (diseno) |
| Flat install / peers | Plan §6.7; peers declarados como `peerDependencies` | PASS (diseno) |
| Lifecycle / eventos / transiciones / config / ULW / goals / agents / jobs / models / privacidad | Core puro con **34** tests (`rigel-v2-sidebar-core.test.mjs`), superficie con **13** tests (`rigel-v2-native-cli-sidebar.test.mjs`), y eventos por `context.data.on` (`rigel-v2-native-cli-sidebar.mjs:374-393`) | PASS (nivel unit/seam) |

## 3. Tabla de las 27 conductas y su prueba propuesta (con veredicto de QA)

Columnas: **#** y capacidad (del plan §6.10); **Prueba propuesta** (del plan); **Gate asignado** (donde vive hoy o
donde el plan la ubica); **Veredicto QA** (observable / parcial / no observable / incognita / inerte).

| # | Capacidad | Prueba propuesta (plan §6.10/§6.7) | Gate asignado | Veredicto QA |
| --- | --- | --- | --- | --- |
| 1 | Banner de config invalida | unit core + canario | core + seam | Observable (core) |
| 2 | ULW: goals/pass/fail/pending/blocked/active | unit core + canario | core + seam | Observable (core) |
| 3 | Seccion Agents | unit core + canario | core + seam | Observable (core) |
| 4 | Seccion Jobs, `toolCalls`/`lastTool` | unit core + canario | core + seam | Observable (core) |
| 5 | Vista idle + roster Models | unit core + canario | core + seam | Observable (core) |
| 6 | Arbol `ViewNode` y materializacion | "unit (IR pura) + test del materializador" / "arbol de nodos valido" | **Seam visual (no observado)** | **Parcial / no observable**: solo IR unit; la aceptacion del nodo por el host no tiene gate |
| 7 | Maquina de estados active/broken/idle | unit core + fault injection | core + seam | Observable (core) |
| 8 | Transiciones (idle<->active, active->broken, crear/cerrar sesion) | unit secuencial + eventos del seam | seam | Parcial: propuesta, no implementada en el seam (el seam hoy no emite eventos de sesion) |
| 9 | Debounce 250 / heartbeat 2 s / poll 1 s | gate T (recibo sin eventos vs `HEARTBEAT_MS`) | seam (gate T) | Incognita declarada: el gate T es ejecutable y honesto; aun no corrido |
| 10 | Frescura snapshot 6 s | n/a (sin canal de espejo) | inerte | Inerte (declarado) |
| 11 | Frescura loop 120 s | unit core + canario | core | Observable (core) |
| 12 | Caps MAX_AGENTS/MAX_JOBS/LABEL_MAX | unit core | core | Observable (core) |
| 13 | Redaccion de goal activo -> `private` | unit core | core | Observable (core) |
| 14 | Espejo: ruta/hash/projectDir/escritura 0600 | unit (espejo/recibo) + canario | core + seam | Observable (core/seam) |
| 15 | Tema | unit adaptador (tokens planos/anidados) | **Seam visual (no observado)** | Parcial / no observable: solo adaptador unit; el render no se observa |
| 16 | Agentes activos (busy/retry/running) | unit core + canario | core | Observable (core) |
| 17 | Nombre de agente por ultimo mensaje | unit core + seam | core + seam | Observable (core/seam) |
| 18 | Roster = tabla de resolucion (agentes+categorias) | unit core + canario | core | Observable (core) |
| 19 | Compuerta loop live (algun `in_progress`) | unit core + canario | core | Observable (core) |
| 20 | Ciclo de vida attach | unit lifecycle | core | Parcial: propuesta, no existe test de attach hoy |
| 21 | Dispose (tres rutas) | unit + canario | seam | Parcial: el seam corre `dispose()` una vez; no hay contador de liberaciones |
| 22 | Concurrencia: dedup de flush | unit | core | Parcial: propuesta |
| 23 | Reconexion inexistente + degradacion | unit + fault injection | core | Parcial: propuesta |
| 24 | Permisos: sin chequeos | n/a | n/a | n/a (correcto) |
| 25 | Fallos parciales: degrada sin lanzar | unit fault injection | core | Parcial: propuesta |
| 26 | No interactivo: recibo por el companion CLI | integracion (seam hermetico, no el lab) | seam | Observable en seam; el lab no lo observa (declarado) |
| 27 | Semantica de config: ON salvo `false` | unit config + cableado real P0.4 | core + config | Parcial: el gate de semantica real es P0.4/P5; hoy el compositor usa `=== true` |

**Lectura de la tabla:** las conductas de datos/derivacion (1-5, 7, 11-14, 16-19) tienen pruebas **observables de
nivel unit/core** y son la parte mas solida. Las conductas de **capacidad/terminal** (6, 15) quedan **no observadas**
por diseno ("seam visual"); las de **timers/frescura** (9, 10) quedan honestamente Incognita/Inerte; y varias de
**lifecycle/fallo** (8, 20-23, 25) estan **propuestas pero no asignadas a un gate ejecutable existente**. Cuatro
filas (6, 9, 10, 15) no tienen prueba observable hoy, lo cual el plan declara con honestidad pero que no satisface
literalmente el gate C "27 conductas con pruebas observables".

## 4. Gates transversales del contrato C (checklist)

| Gate exigido por el contrato C | Resultado | Evidencia |
| --- | --- | --- |
| 27 conductas con pruebas **observables** (no solo assertions de helpers) | **PARCIAL** | Filas 6, 15 no observadas; 9 Incognita; 10 Inerte; 8, 20-23, 25 propuestas sin gate ejecutable. Varias filas son unit de funciones puras (helpers), lo que el contrato cuestiona |
| Flag OFF demuestra baseline **conductualmente identico** | PASS (diseno) | Compositor `=== true`; con OFF no hay slot/recibo/log/suscripcion. Falta cerrar el **artefacto concreto** de comparacion (ver C-6) |
| Flag ON cubre **render real del slot/nodos y no texto plano** | **FAIL** | `render` devuelve `describeView` (texto) `sidebar.mjs:329-345`; la suite lo fija `test.mjs:170`; el seam no llama `render()`; fila 6 = Seam visual. Ver BLOCKER C-1 |
| Lifecycle / eventos | PARCIAL | Seam no emite eventos de sesion hoy; `context.data.on` existe |
| Transiciones active/broken/idle | PARCIAL | unit core OK; secuencia por eventos en el seam no implementada |
| Polling/heartbeat/debounce o equivalencia reactiva | INCOGNITA (declarado) | Gate T ejecutable, no corrido; fila 9 |
| config / ULW / goals / agents / jobs / models | PASS | Core 34 tests + seam |
| Privacidad | PASS | Redaccion a `private` en core |
| Errores / fallos parciales | PARCIAL | Propuesto, sin gate asignado |
| Doble setup / concurrencia | PASS (diseno) | P1.3 + §6.7 |
| Capability fail-closed | PASS (diseno) | §6.2 + P1.1 |
| Flat install / peers | PASS (diseno) | §6.7 |
| `XDG_STATE_HOME` explicito | PASS | §6.6/§6.7 + `resolveStateRoot` |
| Rollback de artefactos desplegados | PASS | §6.8 + `status` real |
| Activacion / desactivacion | PASS (diseno) | P0.4/P0.5/§6.9 |
| Canario | **PARCIAL / falso verde posible** | El canario P3.1 es seam-only y no observa render; puede quedar verde con el render roto (ver C-1) |
| No-gating de modelos / delegacion / orquestacion | PASS | §6.3 P2.3 |
| Pruebas de **caracterizacion pre-cambio** | **AUSENTE** | `grep` de `caracteriza|characteriz` en el plan: sin resultados. Solo hay "baseline conductual" conceptual (ver C-4) |
| Controles negativos | PASS | Seam + tests de superficie |
| Mutacion / fault injection **restaurada byte-identically** | PARCIAL | Plan dice "restauracion exacta del archivo mutado" (§6.7) pero sin mecanismo, runner ni prueba de hash (ver C-5) |
| Suites completas | PARCIAL | "suite `profiles/gabo` verde" sin comando fijado (ver C-8) |
| **QA en laboratorio V2 real** | **NO SATISFECHO para el sidebar** | El lab no carga `./tui`; el plan no define observacion real del render (ver C-2) |
| Rechaza helpers simulados como sustituto de la ruta real | **NO SATISFECHO** | El observador designado usa `fake-context.mjs` (ver C-3) |

## 5. Hallazgos

### BLOCKER

| ID | Sev. | Hallazgo | Evidencia | Impacto | Correccion exigida |
| --- | --- | --- | --- | --- | --- |
| C-1 | **BLOCKER** | El plan **no tiene un gate ejecutable que observe el render del slot y distinga nodo de texto plano**. `render` devuelve `describeView(view)` (cadena) hoy (`sidebar.mjs:329-345`); la suite lo asserta como esperado (`test.mjs:170`); el seam no invoca `render()`; la fila 6 (arbol de nodos) esta marcada "Seam visual (no observado)". El plan §6.7 promete "arbol de nodos valido" pero §7C (lista de lo que P3/P4 debe cubrir) **omite** la asercion "render devuelve nodo, no texto", y §6.10 fila 6 se contradice con §6.7 al clasificarla como no observable. | plan §6.7 vs §6.10 fila 6 vs §7C; `sidebar.mjs:329-345`; `test.mjs:170,162`; `qa-v2-t25-live-surfaces.mjs` (sin `.render(`) | El canario P3 y la suite pueden quedar **verdes con el render aun en texto plano**; la implementacion por fases no se protege contra la reincidencia exacta del crash/revert. Es el objetivo central del plan y queda sin gate | El plan debe: (1) exigir una asercion **hermetica** en el seam de que `render()` devuelve un nodo (objeto con `kind`/estructura), no una cadena ni `""`; (2) instruir que el test `test.mjs:170` se **invierta** (hoy fija texto) en el mismo commit P1.2; (3) asignar la fila 6/15 a un gate concreto (seam hermetico para tipo/estructura del nodo + seam visual para aceptacion del host) y dejar de marcarlas como "no observado" sin sustituto |

### MAJOR

| ID | Sev. | Hallazgo | Evidencia | Impacto | Correccion exigida |
| --- | --- | --- | --- | --- | --- |
| C-2 | **MAJOR** | El contrato exige "QA en laboratorio V2 real", pero el plan **no observa el sidebar en ningun host real** (el lab no carga `./tui`) y deja el "seam visual" **a definir**, sin nombrar el camino ni el gate real de P5. La aceptacion del nodo por el host queda, por tanto, como riesgo no observado que bloquea la paridad (P5). | plan §6.4 P3.1/P5, §7C; `qa-v2-t25-live-surfaces.mjs:4-12` | La paridad objetivo (P5) no puede autorizarse con evidencia: no hay gate real de aceptacion del render | Declarar explicitamente el **riesgo residual no observable** y definir el camino autorizado del seam visual (o su version observable sin TUI directa) **antes** de P5; condicionar P5 a ese gate |
| C-3 | **MAJOR** | El observador designado se describe como "contexto de plugin CLI **real**", pero el contexto lo construye `fake-context.mjs`, cuyo encabezado dice `Fake OpenCode V2 setup context`. El contrato "rechaza helpers simulados como sustituto de la ruta real", y el plan no reconcilia esta tension. | plan §6.5/§6.7/§7C ("contexto CLI real") vs `fake-context.mjs:1-2`; import en `qa-v2-t25-live-surfaces.mjs:33` | Se sobreestima la fuerza probatoria del seam: prueba codigo y registros, no aceptacion del host. Riesgo de "verde" que no significa "funciona en el host" | Renombrar el observador como "contexto CLI **sintetico/fiel (fake-context)**", declarar que `setup()` es real pero el host no, y anadir un gate (o una nota de riesgo aceptado firmada) para la aceptacion del host |

### MINOR

| ID | Sev. | Hallazgo | Evidencia | Impacto | Correccion exigida |
| --- | --- | --- | --- | --- | --- |
| C-4 | MINOR | El contrato exige **pruebas de caracterizacion pre-cambio**. El plan no usa/define caracterizacion alguna; solo "baseline conductual" conceptual (P0.3). En particular, no pide caracterizar la salida actual del render antes de tocar P1.2 (hoy texto plano), ni fija que el test `test.mjs:170` es la caracterizacion a invertir. | `grep caracteriza|characteriz` en el plan: sin resultados; `test.mjs:170` | Sin caracterizacion explicita, la inversion del contrato de render queda a criterio del implementador | Nombrar las pruebas de caracterizacion (al menos la del gate OFF y la del render actual) y su pre/post |
| C-5 | MINOR | "Mutacion/fault injection restaurada byte-identically" queda como intencion ("restauracion exacta del archivo mutado", §6.7) sin mecanismo: no hay runner de mutacion, ni paso de hash pre/post, ni lista de mutantes RED. | plan §6.7, §7C | La restauracion exacta no es verificable sin procedimiento | Definir el procedimiento (hash pre/post del archivo mutado, lista de mutantes, comando) |
| C-6 | MINOR | El baseline "conductualmente identico" (§6.1/§6.9) enumera categorias (superficies/slots/recibos/logs/render) pero no define el **artefacto de comparacion** concreto (formato de captura, normalizacion, diff). | plan §6.1, §6.9 | El gate go/no-go "sin cambio observable con flag OFF" no es reproducible sin el artefacto | Fijar el artefacto de captura/diff del baseline OFF |
| C-7 | MINOR | Cuatro de las 27 filas no tienen prueba observable (6, 15 visuales; 9 Incognita; 10 Inerte). El plan lo declara con honestidad, pero el gate C pide "27 conductas con pruebas observables". Ademas, varias filas (8, 20-23, 25) son propuestas sin gate ejecutable asignado. | plan §6.10 filas 6, 8, 9, 10, 15, 20-23, 25 | Cobertura observable incompleta respecto del gate literal | Asignar gate ejecutable a cada fila propuesta o justificar formalmente su no-observabilidad como riesgo aceptado |

### INFO

| ID | Sev. | Hallazgo | Evidencia | Impacto | Correccion exigida |
| --- | --- | --- | --- | --- | --- |
| C-8 | INFO | "Suites completas" no fija el comando ni el conjunto exacto (el handoff cita `bun test profiles/gabo`); `validate-profile.mjs` se menciona pero no se ancla al cierre de fase. | plan §6.7; handoff §7 | Trazabilidad de no-regresion | Fijar comandos y umbral (suite + validate) como criterio de Go por fase |
| C-9 | INFO | El plan no menciona literalmente "delegacion/orquestacion" entre sus prohibiciones (ya observado por B2-3); el aislamiento es estructural. | plan §6.1 vs `sidebar.mjs:31-48`, `cli.mjs:22-27` | Trazabilidad del gate de aislamiento | Anadir la mencion explicita (sin impacto material) |
| C-10 | INFO | La fila 26 (recibo por el companion CLI) es correcta, pero refuerza que **toda** la observabilidad del sidebar depende del seam, que es fake-context; conviene que el lector no confunda "recibo observado" con "render aceptado por el host". | plan §6.10 fila 26; `qa-v2-t25-live-surfaces.mjs` | Prevencion de interpretacion erronea | Nota cruzada hacia C-1/C-2 |

## 6. Aislamiento, limites y lo no verificado

- **Ejecucion de esta auditoria:** verificacion directa, sin sub-agentes, sin team-mode, sin orquestacion. Solo
  comandos de lectura (`git` de consulta, `grep`, `sed`). No se lanzo ningun proceso OpenCode; no se uso Docker; no
  se toco V1 / NLS1 / produccion / secretos. La boveda no se leyo en esta ronda (no era necesaria para el gate C).
- **Aislamiento en el plan:** §6.1 prohibe V1, NLS1, produccion, secretos, Docker, `run`/`serve`/`--standalone`
  directos, big-bang y usar el sidebar como gate de modelos; la unica via viva es `opencode-v2-lab.service`; el seam
  no lanza procesos. La superficie importa solo el core puro + Node (`sidebar.mjs:31-48`), sin delegacion ni
  orquestacion.
- **No verificado (por prohibicion del contrato):** no se ejecuto ningun gate (T, suite, flat install, mutaciones,
  drill de rollback, canario) porque el contrato prohibe implementacion y el plan es DRAFT. Esta auditoria es de
  **suficiencia y ejecutabilidad del diseno de QA**, contrastada con los tests y el seam reales, no de ejecucion.
- **Lo verificado como correcto:** flag OFF sin side effects; controles negativos presentes; rollback desplegado con
  campos reales; XDG explicito; capability fail-closed asignada a P1; doble setup; no-gating de modelos; y cobertura
  unit/core amplia (34 + 13 tests).

## 7. Conclusion

El plan es solido en proteccion del baseline con el flag OFF y en la mayoria de los gates transversales, pero **falla
el gate de QA que define su propio objetivo**: no puede observar ni distinguir el render de nodo frente al texto
plano, que es la causa raiz del crash y del revert. El observador designado no invoca `render()`, la fila del arbol
de nodos esta declarada "no observada", la suite actual **fija el texto plano** como esperado, y el canario puede
quedar verde con el render roto. A eso se suma que el observador usa un contexto sustituto (`fake-context.mjs`)
descrito en el plan como "real", y que no existe QA del sidebar en un host real (el laboratorio no carga `./tui`).

**Veredicto: NEEDS_CORRECTION.**

Correcciones minimas para levantar el BLOCKER y los MAJOR: (1) anadir un gate hermetico que asierte `render()` ->
nodo (no cadena) e invertir `test.mjs:170` en P1.2; (2) declarar el riesgo residual de aceptacion por el host y
definir el gate real antes de P5; (3) relabelar el seam como contexto sintetico y reconciliar con el contrato "no
helpers simulados". Las correcciones MINOR (caracterizacion, mutacion byte-identical, artefacto de baseline,
asignacion de gates por fila) son recomendadas y no bloquean por si solas.

Esta auditoria **no se autoaprueba** como autoridad final. A3 y B2 emitieron PASS en sus gates; C es el gate de QA y
emite NEEDS_CORRECTION. La aprobacion de release (P5) sigue requiriendo A + B + C y gates reales, segun §6.4/§7.

## 8. Limites de acceso y estado del repositorio

- `git status`: sin cambios en codigo rastreado; los unicos untracked son los documentos de auditoria/handoff
  (`AUDIT-A*`, `AUDIT-B*`, `HANDOFF-SIDEBAR-RESEARCH.md`) y este `AUDIT-C-SIDEBAR-QA-NO-REGRESSION.md`.
- Sin commit / push / PR. Sin procesos OpenCode lanzados. Sin Docker. V1 / NLS1 / produccion / secretos intactos.
- Plan, handoff, codigo, tests, boveda y stash **no** editados.
- Unico proceso permitido si se autoriza canario: `opencode-v2-lab.service` via `apply-v2-runtime-service.sh` (no
  usado).

---

**Firma independiente:** Auditor C (independiente) - gate de QA real y no-regresion del plan de paridad del sidebar
V2. Ejecutada de forma directa, sin delegacion ni orquestacion, contra fuentes primarias (tests existentes, seam de
QA, helper de contexto, superficie, compositor y el propio plan). No confio en los veredictos de A3 ni de B2.
Veredicto: **NEEDS_CORRECTION**.
