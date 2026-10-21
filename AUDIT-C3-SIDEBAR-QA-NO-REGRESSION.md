# AUDIT-C3-SIDEBAR-QA-NO-REGRESSION - Tercera repeticion C independiente (desde cero) (QA real / no-regresion)

> **DRAFT / NO IMPLEMENTAR.** Auditoria de solo lectura. No se edito el plan, ni el handoff, ni codigo productivo,
> ni tests, ni la boveda, ni el stash. No hubo commit / push / PR. No se lanzo ningun proceso OpenCode. No se uso
> Docker. No se toco V1, NLS1, produccion ni secretos. No se delego a sub-agentes ni se uso orquestacion: la
> verificacion se hizo directamente contra fuentes primarias (codigo, tests existentes, seam de QA, helper de
> contexto, compositor, hashes y el propio plan).

## 0. Alcance, metodo e independencia

- **Objetivo auditado:** `.omo/drafts/v2-sidebar-parity-reversible-plan.md` (**993 lineas** en esta ronda) y
  `HANDOFF-SIDEBAR-RESEARCH.md` (**329 lineas**), en el worktree
  `/home/gabodev/oh-my-rigel-worktrees/research-v2-sidebar-parity-plan`, rama `research/v2-sidebar-parity-plan`,
  baseline `404a629`.
- **Encargo:** contrato `sidebar-audit-c3-prompt.txt`. Auditoria **desde cero** de las **correcciones posteriores a
  C2**: revalidar **toda** la Auditoria C, **C2-1..C2-7** y la **matriz de 27 conductas**; verificar el **punto
  critico** (gate del **nodo materializado** por fabrica/renderer real o fiel, **distinto** de la IR cruda `{kind}`;
  negativo de IR cruda **FALLA**; **procedencia** del materializador y renderer del seam **fijada y ejecutable**);
  verificar mutation command/threshold/restauracion, atribucion honesta inline vs fake-context, etiquetas de cobertura
  futura, filas de riesgo aceptado, **gate real de host obligatorio pre-P5**, flag OFF identico, lifecycle, rollback,
  XDG, doble setup, peers/flat install, caracterizacion, controles negativos, suites y no-gating
  de modelos/delegacion/orquestacion.
- **Independencia (explicita):** esta ronda **no** adopta los veredictos ni las tablas de
  `AUDIT-A3-SIDEBAR-FIDELITY.md` (PASS), `AUDIT-B2-SIDEBAR-ARCHITECTURE.md` (PASS),
  `AUDIT-C-SIDEBAR-QA-NO-REGRESSION.md` (NEEDS_CORRECTION) ni `AUDIT-C2-SIDEBAR-QA-NO-REGRESSION.md`
  (NEEDS_CORRECTION). Se re-verifico contra fuentes primarias: el core puro, el adaptador de superficie, el
  compositor, el seam `qa-v2-t25-live-surfaces.mjs` leido entero (310 lineas), `fake-context.mjs`, los tests
  actuales, `git` y `sha256sum`.
- **Cambio de estado observado desde C2 (dato de partida):** el plan paso de **969** (C2) a **993** lineas
  (mtime `2026-10-12 01:34`), es decir **fue corregido despues de la ronda C2**; el handoff paso de **294/329**
  lineas (mtime `01:36`). El **codigo rastreado NO cambio**: `git diff --stat 404a629` vacio; los cinco
  `sha256` de §6.9 coinciden byte a byte (ver §2.1). Por tanto C3 audita **correcciones documentales** sobre un
  baseline de codigo estable.
- **Baseline verificado:** `HEAD = 404a6290134d1704bb44eff7c092c161770f49e2`; `git status` sin cambios en codigo
  rastreado (solo untracked de auditoria/handoff); `rigel-v2-sidebar-node.mjs` y `rigel-v2-sidebar-theme.mjs`
  **ausentes** en HEAD (son objetivos de P1.2, no artefactos presentes).

## 1. Veredicto

**PASS.**

Las correcciones posteriores a C2 cierran el MAJOR que bloqueaba la ronda anterior. El **discriminador del gate del
render ya no es `{kind}`**: el plan exige que `render()` devuelva la **salida del materializador** (nodo del host
producido por la fabrica de `context.renderer`), **explicitamente distinta** de la **IR cruda** `buildViewNodes`
`{kind:"box"|"text"}`, e incorpora un **negativo** donde devolver la IR cruda **FALLA** el gate. La **procedencia**
del materializador esta **fijada** (fabrica del host via `context.renderer`, `createElement`/`insert`/`setProp`) y el
seam debe aportar un **renderer capaz** para que el gate sea **ejecutable** (con una asercion unitaria de respaldo
documentada). El **riesgo residual de aceptacion por el host** sigue declarado y **P5 sigue BLOQUEADO** por el gate
§6.11.

Resultado de la revalidacion: **C-01..C-10 presentes (10/10)** y **C2-1..C2-7 resueltos (7/7)**. La matriz tiene
**27 filas** (conteo programatico). **No se encontro BLOCKER ni MAJOR.** Bajo la regla del contrato C3 ("PASS solo
sin BLOCKER/MAJOR y si el plan impide el falso verde IR-vs-nodo y bloquea P5 hasta aceptacion real del host"), el
plan **cumple ambas condiciones** y emite PASS. Se registran **1 MINOR** (C3-1, residuo de atribucion) y **varios
INFO**; ninguno bloquea.

## 2. Evidencia primaria verificada (reproducible)

Cada fila es lo que devolvio la fuente, no lo que afirma el plan.

### 2.1 Codigo y tests en HEAD (sin cambios; hashes byte a byte)

| Hecho verificado | Fuente observada | Veredicto |
| --- | --- | --- |
| `render` de la superficie devuelve `describeView(view)` (cadena) por defecto; en error `""` | `rigel-v2-native-cli-sidebar.mjs:331-334` (`renderView` -> `describeView`), `:341-349` (`render` -> `renderView`) | OK (causa historica intacta) |
| La suite actual **fija el texto plano como esperado** | `rigel-v2-native-cli-sidebar.test.mjs:163-164` (`toContain("atlas running")`, `toContain("Agents")`), `:170` (`toBe("No configured models")`) | **Confirmado** (a invertir en P1.2) |
| El core produce la **IR** `{kind}` y `buildViewNodes` la ensambla; `describeView` es texto | `rigel-v2-sidebar-core.mjs:506` (`{kind:"box"}`), `:511` (`{kind:"text"}`), `:515` (`buildViewNodes`), `:536` (`describeView`) | **Confirmado** (IR != nodo del host) |
| `resolveSidebarGate` es fail-**open** sin options (`{enabled:true}`) | `rigel-v2-native-cli-sidebar.mjs:77-81` | OK (lo que P1.1 corrige) |
| `resolveStateRoot` cae a `homedir()/.local/state` sin `XDG_STATE_HOME` | `rigel-v2-native-cli-sidebar.mjs:83-86` | OK (justifica B-13) |
| La superficie se suscribe a eventos (`session.created/deleted/updated/execution.*`), **sin temporizadores** | `rigel-v2-native-cli-sidebar.mjs:374-393`; `grep setInterval/setTimeout` en superficie+core = NONE | OK (fila 9 incognita honesta) |
| Compositor exige `=== true` y despliega la superficie solo entonces | `rigel-v2-native-cli.mjs:48,54` | OK |
| `rigel-v2-sidebar-node.mjs` / `rigel-v2-sidebar-theme.mjs` | `ls` -> **no existen** en HEAD | OK (objetivos de P1.2) |
| Hashes de §6.9 | `sha256sum` de los 5 archivos | **Byte a byte** (`a15f4ea2...`, `20d8a659...`, `10785b83...`, `3b3197c8...`, `e96566ea...`) |

### 2.2 Seam de QA y helper (citado por el plan; verificado linea a linea)

| Afirmacion del plan | Fuente observada | Veredicto |
| --- | --- | --- |
| Contexto CLI **inline** `{options, renderer, location, data, ui, keymap, attention}` en `qa-v2-t25-live-surfaces.mjs:171-186` | L171 `const context = {`; L172 `options: {}`; L173 `renderer: { isDestroyed: false, requestRender() {} }`; L179-183 `ui:{toast,dialog,slot}`; L184 `keymap`; L186 `}` | OK (cita exacta) |
| `setup()` real en `:211` | L211 `const dispose = plugin.setup(context)` | OK |
| Slot capturado en `:246-247`; recibo en `:248-249` | L246 asercion `sidebar.content`; L247 `check("tui-sidebar", ...)`; L248 lectura `sidebar-snapshot.json`; L249 `check(...)` | OK |
| Negativo de gate `enabled:false` en `:268-278` | L269 `options: { tui: { sidebar: { enabled: false } } }`; L278 `check(...)`; L270 `renderer: { isDestroyed: false }` (sin fabrica) | OK (y muestra el hueco a cerrar en P1.2) |
| El seam **no** invoca `render()` | `grep '\.render('` en el seam = **NONE** (solo asercion de slot y recibo) | OK (gap de P1.2) |
| El seam **importa** `createEntrypointContext` desde `fake-context.mjs` (`:39`), usado para el **entrypoint servidor** (`:71`) y su negativo (`:137`) | L39 import; L71 server; L137 negativo | OK (el contexto del sidebar es inline, L171-186) |
| `fake-context.mjs` documentado literalmente como `Fake OpenCode V2 setup context` | `fake-context.mjs:1-2` | OK |
| Sandbox XDG del seam | L43-52 (`mkdtempSync`, `XDG_STATE_HOME`/`XDG_DATA_HOME`/`XDG_CONFIG_HOME`) | OK |

### 2.3 Plan: correcciones C2 presentes (ubicacion verificada en el plan de 993 lineas)

| Correccion C2 | Ubicacion observada | Verificado |
| --- | --- | --- |
| C2-1 (nodo materializado, no IR; negativo IR cruda) | §0 hallazgo 9 (86-90), §6.3 (595), §6.4 P1.2 (631-652), §6.5 (718-721), §6.7 (770), §6.10 filas 6/15 (842/851) + leyenda (829-831), §7A/§7C | Si |
| C2-2 (comando/umbral de mutacion, sin referencia colgante) | §6.7 (772: M1..M4, `bun test profiles/gabo`, umbral >=1 RED, `git checkout --` + `sha256sum` post==pre) | Si (`grep umbral` solo en §6.7/§7) |
| C2-3 (atribucion inline vs fake-context) | §6.5 (714-717), §6.6 (745-748), §6.7 (759), §7C (954-956) | Si (con residuo en §0/§6.10 -> C3-1) |
| C2-4 (procedencia decidida + renderer del seam ejecutable) | §6.3 (595), §6.4 P1.2 (633-651), §6.7 (770) | Si |
| C2-5 (fila 27 = cobertura futura) | §6.10 fila 27 (863) `Cubierta (gate P0.4/P5)` | Si |
| C2-6 (filas 9/10 riesgo aceptado con condicion) | §6.10 filas 9/10 (845/846) + leyenda (825-829) | Si |
| C2-7 (confirmaciones positivas) | §2.2/§6.9/§6.10 del plan | Si (re-verificado: 27 filas, hashes, citas) |

## 3. Revalidacion individual C-01..C-10 (desde cero)

| ID | Sev. original | Correccion exigida | Presente (ubicacion) | Veredicto C3 |
| --- | --- | --- | --- | --- |
| C-1 | **BLOCKER** | Gate ejecutable del render; inversion de tests de texto en el MISMO P1.2; filas 6/15 a gates | §6.4 P1.2(a)(b)(c), §6.5, §6.7, §6.10 filas 6/15, §7C | **RESUELTO** (y reforzado por C2-1: nodo materializado, no IR) |
| C-2 | MAJOR | Declarar riesgo residual + gate real antes de P5; condicionar P5 | §0.10, §6.4 P4/P5, §6.11, §7B/C | **RESUELTO** (§6.11; P5 BLOQUEADO) |
| C-3 | MAJOR | Relabelar seam como contexto sintetico/fiel; setup real, host simulado | §0.10, §6.5, §6.6, §6.7, §6.11 | **RESUELTO** (con residuo de atribucion -> C3-1) |
| C-4 | MINOR | Nombrar caracterizacion pre-cambio y su pre/post | §6.7 (771), §7B | **RESUELTO** |
| C-5 | MINOR | Procedimiento de mutacion (hash pre/post, mutantes RED, comando, umbral) | §6.7 (772), §7B/C | **RESUELTO** (comando/umbral inline) |
| C-6 | MINOR | Artefacto de captura/diff del baseline OFF | §0, §6.1 (546-550), §6.9, §7B | **RESUELTO** |
| C-7 | MINOR | Gate ejecutable por fila; filas 9/10 riesgo aceptado | §6.10 (filas 8, 9, 10, 20-23, 25, 27 + leyenda + notas), §7A/B | **RESUELTO** |
| C-8 | INFO | Fijar comandos y umbral de no-regresion | §6.7 (773), §7C (`bun test profiles/gabo` + `validate-profile.mjs` exit 0) | **RESUELTO** |
| C-9 | INFO | Mencion explicita de no tocar delegacion/orquestacion/modelos | §6.1 (557-560), §0 | **RESUELTO** |
| C-10 | INFO | Nota cruzada en fila 26 | §6.10 fila 26 (862) | **RESUELTO** |

**C-01..C-10: presentes 10/10, y ahora sin el defecto de discriminador que C2 detecto.**

## 4. Revalidacion individual C2-1..C2-7 (desde cero) y punto critico

| ID | Sev. | Exigencia | Resolucion verificada en el plan | Veredicto C3 |
| --- | --- | --- | --- | --- |
| C2-1 | **MAJOR** | El gate no debe usar `{kind}`; debe asertar el **nodo materializado** distinto de la IR; negativo de IR cruda **FALLA** | §6.4 P1.2(a): `render` devuelve la salida del materializador (fabrica `context.renderer`), "**nunca** ... **ni la IR cruda** `{kind}`"; (c)(i) `context.renderer.createElement` invocada (>0) y el output es **su producto**; (c)(iii) **negativo: devolver `buildViewNodes(...)` FALLA**; §6.7 (770) y §6.10 filas 6/15 repiten el criterio; mutante **M2** (§6.7, 772) | **RESUELTO (PASS)** |
| C2-2 | MINOR | Comando y umbral de mutacion; quitar referencia colgante a §6.8 | §6.7 (772): M1..M4, comando `bun test profiles/gabo` (o el archivo del gate), **umbral = >=1 test RED**, restauracion `git checkout -- <archivo>` + `sha256sum` **post == pre**. `grep umbral` aparece solo en §6.7/§7; §6.8 ya no lo referencia | **RESUELTO (PASS)** |
| C2-3 | MINOR | Atribucion: contexto del sidebar **inline**; `fake-context.mjs` cubre el entrypoint servidor | §6.5 (715), §6.6 (746), §6.7 (759), §7C (955) lo dicen correctamente. **Residuo:** §0 hallazgo 10 (92-94) y §6.10 nota A-06 (876) aun atribuyen el contexto del **sidebar** a `fake-context.mjs` | **RESUELTO con residuo -> C3-1 (MINOR)** |
| C2-4 | MINOR | Procedencia decidida + renderer del seam ejecutable (o acotar a asercion unitaria documentada) | §6.3 (595) "**Procedencia decidida (C2-4):** fabrica del host via `context.renderer` (`createElement`/`insert`/`setProp`)"; §6.4 P1.2 (649-651) "El seam aporta un **renderer capaz**" con respaldo unitario documentado | **RESUELTO (PASS)** |
| C2-5 | INFO | Fila 27 = cobertura futura | §6.10 fila 27 (863) `Cubierta (gate P0.4/P5)` | **RESUELTO (PASS)** |
| C2-6 | INFO | Filas 9/10 riesgo aceptado sin reducir el contrato | §6.10 fila 9 (845) `Incognita/Bloqueada (A2-02; riesgo aceptado hasta que el gate T pase o se conserve un refresco explicito)`; fila 10 (846) `Inerte (A-05; riesgo aceptado: V2 no tiene canal de espejo)` | **RESUELTO (PASS)** |
| C2-7 | INFO | Confirmaciones positivas | `sha256sum` byte a byte; matriz = **27** filas (conteo programatico); citas del seam exactas | **RESUELTO (PASS)** |

### 4.1 Punto critico (verificacion directa del contrato C3)

El contrato C3 exige: (a) gate de **nodo materializado por fabrica/renderer real o fiel**, distinto de la IR cruda
`{kind}`; (b) un **negativo** que devuelve `buildViewNodes`/IR cruda **debe fallar**; (c) **procedencia** del
materializador y renderer del seam **fijada y ejecutable**.

| Requisito C3 | Evidencia en el plan | Veredicto |
| --- | --- | --- |
| (a) Nodo materializado, no `{kind}` | §6.4 P1.2(a) + (c)(i): el output es producto de `context.renderer.createElement`; §6.10 filas 6/15: `Cubierta (nodo materializado) / host pendiente` | **CUMPLE** |
| (a) La IR **no** es el nodo (C2-1) | §0 hallazgo 9 (87-88), §6.3 (595), §6.7 (770) | **CUMPLE** |
| (b) Negativo: IR cruda **FALLA** | §6.4 P1.2(c)(iii) + mutante M2 (§6.7, 772) | **CUMPLE** |
| (c) Procedencia fijada | §6.4 P1.2 (633-634) "**Procedencia decidida** ... fabrica del host via `context.renderer`" | **CUMPLE** |
| (c) Ejecutable en el seam | §6.4 P1.2 (649) y §6.7 (770): "El seam aporta un **renderer capaz** (`createElement`/`insert`/`setProp`)" | **CUMPLE** (ver C3-2/INFO: el renderer del seam esta hoy stubeado en L173, sin fabrica; P1.2 lo dota) |

Conclusion del punto critico: la clase de **falso verde IR-vs-nodo** que definia el MAJOR C2-1 esta **eliminada por
diseno**. El gate no puede quedar verde devolviendo `buildViewNodes(...)`: el output debe ser el **producto de la
fabrica** y el negativo lo confirma.

## 5. Tabla de las 27 conductas y su gate (revalidada)

Columnas: **#** y capacidad (plan §6.10); **Gate**; **Veredicto C3**; **Nota**.

| # | Capacidad | Gate | Veredicto C3 | Nota |
| --- | --- | --- | --- | --- |
| 1 | Banner de config invalida | core + seam (recibo) | Observable | - |
| 2 | ULW goals/pass/fail/pending/blocked/active | core + seam (recibo `loop`) | Observable | - |
| 3 | Seccion Agents | core + seam (recibo) | Observable | - |
| 4 | Seccion Jobs `toolCalls`/`lastTool` | core + seam (recibo) | Observable | - |
| 5 | Vista idle + roster Models | core + seam (recibo) | Observable | - |
| 6 | Arbol `ViewNode` y materializacion | seam hermetico (`render()` -> nodo materializado) + §6.11 (host) | **Cubierta (nodo materializado) / host pendiente** | C2-1 resuelto: se asierta el nodo, no `{kind}`; negativo IR cruda |
| 7 | Maquina de estados active/broken/idle | core + fault injection | Observable | - |
| 8 | Transiciones (idle<->active, active->broken, sesion creada/cerrada) | **gate P3** (eventos de sesion en el seam) | Cubierta (gate asignado) | El seam actual no emite eventos de sesion; P3 debe implementarlo |
| 9 | Debounce 250/heartbeat 2 s/poll 1 s | **gate T (§6.4 P3.2)** | Incognita/Bloqueada (riesgo aceptado) | Honesto; condicion de conservar refresco explicito |
| 10 | Frescura snapshot 6 s | n/a (sin canal de espejo) | Inerte (riesgo aceptado) | Honesto |
| 11 | Frescura loop 120 s | core + canario | Observable | - |
| 12 | Caps MAX_AGENTS/MAX_JOBS/LABEL_MAX | core | Observable | - |
| 13 | Redaccion goal activo -> `private` | core | Observable | - |
| 14 | Espejo ruta/hash/projectDir/0600 | core + seam (recibo) | Observable | - |
| 15 | Tema | unit adaptador + seam (`render()` -> nodo materializado) + §6.11 | **Cubierta (nodo materializado) / host pendiente** | Igual que fila 6 (C2-1 resuelto) |
| 16 | Agentes activos busy/retry/running | core + canario | Observable | - |
| 17 | Nombre de agente por ultimo mensaje | core + seam | Observable | - |
| 18 | Roster = tabla de resolucion | core + canario | Observable | - |
| 19 | Compuerta loop live (algun `in_progress`) | core + canario | Observable | - |
| 20 | Ciclo de vida attach | **gate P4** | Cubierta (gate asignado) | Adaptacion V2 (`setup` compone) |
| 21 | Dispose (tres rutas) | **gate P1.3/P3** (contador de disposers) | Cubierta (gate asignado) | - |
| 22 | Concurrencia: dedup de flush | **gate P1.3** (doble setup concurrente) | Cubierta (gate asignado) | - |
| 23 | Reconexion inexistente + degradacion | **gate P4** | Cubierta (gate asignado) | - |
| 24 | Permisos: sin chequeos | n/a | n/a (correcto) | - |
| 25 | Fallos parciales: degrada sin lanzar | **gate P4** | Cubierta (gate asignado) | - |
| 26 | No interactivo: recibo por el companion CLI | seam hermetico (no el lab) | Cubierta | C-10: "recibo observado" != "render aceptado por el host" |
| 27 | Semantica de config: ON salvo `false` | unit config + **cableado P0.4**; objetivo P5 | **Cubierta (gate P0.4/P5)** | Etiqueta de cobertura futura (C2-5) |

**Lectura:** las filas de datos/derivacion (1-5, 7, 11-14, 16-19) son observables por core+recibo. Las filas 6/15
tienen gate asignado al **nodo materializado** (ya **no** a la IR; C2-1 resuelto). Las filas 8/20-23/25/27 tienen
gate ejecutable asignado (C-7/C2-5). Las filas 9/10 quedan honestamente Incognita/Inerte como riesgo aceptado.
Conteo de filas: **27** (verificado programaticamente).

## 6. Gates transversales del contrato C3 (checklist)

| Gate exigido por el contrato C3 | Resultado | Evidencia |
| --- | --- | --- |
| Gate del render: nodo **materializado** por fabrica real o fiel, distinto de IR `{kind}` | **PASS** | §6.4 P1.2(a)/(c), §6.7 (770), §6.10 filas 6/15 |
| Negativo: devolver `buildViewNodes`/IR cruda **FALLA** | **PASS** | §6.4 P1.2(c)(iii) + mutante M2 (§6.7, 772) |
| Procedencia del materializador/renderer del seam **fijada** | **PASS** | §6.3 (595), §6.4 P1.2 (633-634) |
| Renderer del seam **ejecutable** (capaz de materializar) | **PASS (con fallback documentado)** | §6.4 P1.2 (649), §6.7 (770); respaldo unitario documentado (C3-2 INFO) |
| Mutation command/threshold/restauracion | **PASS** | §6.7 (772): M1..M4, `bun test profiles/gabo`, >=1 RED, `git checkout --` + `sha256sum` post==pre |
| Atribucion honesta inline vs fake-context | **PASS (con residuo)** | §6.5/§6.6/§6.7/§7C correctos; §0/§6.10 nota -> C3-1 (MINOR) |
| Etiquetas de cobertura futura (fila 27) | **PASS** | §6.10 fila 27 `Cubierta (gate P0.4/P5)` |
| Filas de riesgo aceptado (9/10) | **PASS** | §6.10 filas 9/10 + leyenda |
| Gate real de host **obligatorio pre-P5** | **PASS** | §6.11; §6.4 P5 "**P5 queda BLOQUEADO**" |
| Flag OFF conductualmente identico | **PASS** | §6.1 (546-550) inventario exacto `{composedSurfaces[], registeredSlots[], receiptsWritten[], logEvents[], renderType}` + §6.9 |
| Lifecycle / transiciones / fallos | **PASS (asignado)** | Filas 8/20/21/23/25 con gate |
| Rollback (artefactos desplegados) | **PASS** | §6.8 pasos 1-5; `status` real |
| `XDG_STATE_HOME` explicito | **PASS** | §6.6 (737-739), §6.7 (769) + `resolveStateRoot` (`:83-86`) |
| Doble setup / concurrencia | **PASS** | P1.3 + §6.7 (765) |
| Peers / flat install con flag ON | **PASS** | §6.3/§6.4 P1.2/§6.7 (768) `peerDependencies` |
| Caracterizacion pre-cambio | **PASS** | §6.7 (771) |
| Controles negativos | **PASS** | §6.2 matriz + §6.7 (760) |
| Suites (comando/umbral) | **PASS** | §6.7 (773) `bun test profiles/gabo` + `validate-profile.mjs` |
| No-gating de modelos/delegacion/orquestacion | **PASS** | §6.1 (557-560) + §6.3 P2.3 |
| Laboratorio V2 real | **PASS (honesto)** | §6.5/§6.11: solo el lab para lo vivo; el lab **no** observa el sidebar (declarado) |
| Ninguna simulacion presentada como evidencia de host | **PASS** | §6.5/§6.6/§6.11 (C-3) |

## 7. Hallazgos nuevos

### BLOCKER

Ninguno.

### MAJOR

Ninguno. El MAJOR C2-1 (discriminador `{kind}` == IR) esta **cerrado** por §6.4 P1.2(a)/(c) + el negativo y el
mutante M2.

### MINOR

| ID | Sev. | Hallazgo | Evidencia | Impacto | Correccion exigida |
| --- | --- | --- | --- | --- | --- |
| C3-1 | MINOR | **Residuo de atribucion (C2-3 parcialmente aplicado).** El plan ya precisa correctamente que el contexto del **sidebar** es **inline** (`qa-v2-t25-live-surfaces.mjs:171-186`) y que `fake-context.mjs` cubre el **entrypoint servidor** (L71) y su negativo (L137) en §6.5 (715), §6.6 (746), §6.7 (759) y §7C (955). Sin embargo, **dos** lugares siguen atribuyendo el contexto del **sidebar** a `fake-context.mjs`: el resumen §0 hallazgo 10 (lineas 92-94, "El seam arma el contexto con `fake-context.mjs`") y la nota §6.10 A-06 (linea 876, "el **seam hermetico** (contexto CLI sintetico/fiel `fake-context.mjs`)"). | plan §0 (92-94) y §6.10 (876) vs `qa-v2-t25-live-surfaces.mjs:39,71,137,171-186` | La sustancia (contexto sintetico/fiel, `setup()` real, host simulado) es correcta y esta declarada; solo la **atribucion del modulo** es imprecisa en dos resumenes. Riesgo de trazabilidad, no de falso verde | Alinear §0 hallazgo 10 y §6.10 nota A-06 con la atribucion correcta (contexto del sidebar **inline**; `fake-context.mjs` = entrypoint servidor) |

### INFO

| ID | Sev. | Hallazgo | Evidencia | Recomendacion |
| --- | --- | --- | --- | --- |
| C3-2 | INFO | El gate del render tiene un **camino primario** (seam con renderer capaz) y un **respaldo** documentado (asercion unitaria sobre `rigel-v2-sidebar-node.mjs` con fabrica inyectada, "no presentada como aceptacion del host"). El respaldo fue una opcion legitima de C2-4, pero no debe sustituir al camino primario. | §6.4 P1.2 (649-651), §6.7 (770) | Implementar el **renderer capaz del seam** en P1.2 para que el camino primario sea el ejecutado; reservar la asercion unitaria estrictamente como respaldo |
| C3-3 | INFO | La **procedencia** del materializador se fija en la fabrica del host via `context.renderer` (`createElement`/`insert`/`setProp`). La disponibilidad de esos metodos en el `context.renderer` real del host es una **suposicion** que el propio plan no verifica documentalmente aqui; la cubren el flat-install con flag ON y el gate de host §6.11. | §6.4 P1.2 (633-634), §6.7 (768/770), §6.11 | Que P1.2 confirme/anote en la doc oficial que el host expone la fabrica (o que los peers la proveen), para que la procedencia no dependa de una suposicion no citada |
| C3-4 | INFO | La nota §6.10 A-06 usa presente ("el seam hermetico ... **asierta** que `render()` devuelve un nodo") para un gate que P1.2/P3 aun **debe implementar**; §6.7 y §7C ya lo marcan como requerido/futuro ("P3/P4 debera cubrir"). | §6.10 (876) vs §6.7 (770), §7C (957-963) | Redactar en futuro ("debera asertar") para no leerse como cobertura presente |
| C3-5 | INFO | **Confirmaciones positivas (sin accion):** los cinco `sha256` de §6.9 coinciden **byte a byte**; la matriz tiene **exactamente 27** filas (conteo programatico); las citas del seam (171-186, 211, 246-249, 268-278, 39, 71, 137) son **exactas**; el negativo de IR cruda y el mutante M2 estan presentes; y **P5 esta bloqueado** por §6.11. | §2.1/§2.2/§2.3; `sha256sum`; `awk` count = 27; §6.4 P5, §6.11 | Ninguna |

## 8. Aislamiento, limites y lo no verificado

- **Ejecucion de esta auditoria:** verificacion directa, sin sub-agentes, sin team-mode, sin orquestacion. Solo
  comandos de lectura (`git` de consulta, `grep`, `sed`, `awk`, `sha256sum`, `ls`, `wc`). No se lanzo ningun proceso
  OpenCode; no se uso Docker; no se toco V1 / NLS1 / produccion / secretos. La boveda **no** se leyo en esta ronda
  (no era necesaria para el gate C3; los artefactos de boveda ya fueron validados por A3/B2 y se conservan).
- **Aislamiento en el plan:** §6.1 prohibe V1, NLS1, produccion, secretos, Docker/contenedores,
  `run`/`serve`/`--standalone` directos, big-bang, autoaprobar y usar el sidebar como gate de modelos; ademas exige
  no tocar delegacion/orquestacion/routing/prompts/agentes/categorias/fallbacks/permisos/continuidad/background
  handoff/seleccion de modelo (C-9). La unica via viva es `opencode-v2-lab.service` via
  `apply-v2-runtime-service.sh`; el seam no lanza procesos.
- **No verificado (por prohibicion del contrato):** no se ejecuto ningun gate (render, T, suite, flat install,
  mutaciones, drill de rollback, canario, gate de host) porque el contrato prohibe implementacion y el plan es DRAFT.
  Esta auditoria es de **suficiencia y ejecutabilidad del diseno de QA**, contrastada con los tests, el seam, el core
  y el compositor reales.
- **Limitacion:** no fue posible determinar la forma exacta del nodo del host (`@opentui/solid`) en este entorno; el
  hallazgo C3-3 lo refleja. El punto critico C3 se sostiene porque el plan ahora **no usa `kind`** como
  discriminador y exige el **producto de la fabrica**, que si es verificable.
- **Plan y handoff no editados; codigo, tests, boveda y stash sin tocar.**

## 9. Conclusion

El plan corregido **cierra el MAJOR C2-1**: el gate del render ya no se satisface con la IR del core. Exige la
**salida del materializador** (nodo del host via fabrica `context.renderer`), la contrasta con la **IR cruda**
`{kind}` e incorpora el **negativo** de que devolver `buildViewNodes(...)` **FALLA** (reforzado por el mutante M2).
La **procedencia** esta fijada y el seam debe aportar un **renderer capaz** (con respaldo unitario documentado).
C-01..C-10 estan presentes (10/10) y **C2-1..C2-7 resueltos** (7/7); la matriz tiene **27** filas. El **riesgo
residual de aceptacion por el host** sigue declarado y **P5 sigue BLOQUEADO** por §6.11 hasta que pase el gate real
(o exista decision firmada de Gabo). No se encontro **BLOCKER ni MAJOR**; solo **1 MINOR** (C3-1, residuo de
atribucion en dos resumenes) y **INFO**.

**Veredicto: PASS.**

El plan **impide el falso verde IR-vs-nodo** y **bloquea P5 hasta la aceptacion real del host**: las dos condiciones
del contrato C3 para PASS se cumplen. El MINOR C3-1 no reduce el contrato ni deja un gate inejecutable; es una
recomendacion de precision. Esta auditoria **no se autoaprueba** como autoridad final: A3 y B2 emitieron PASS en sus
gates, C y C2 emitieron NEEDS_CORRECTION (ya corregidos y verificados aqui), y C3 (gate de QA) emite **PASS**. La
aprobacion de release (P5) sigue requiriendo A + B + C y **gates reales** (render materializado + aceptacion del
host), segun §6.4/§7.

## 10. git status y limites de acceso

- `git status`: sin cambios en codigo rastreado; los unicos untracked son los documentos de auditoria/handoff
  (`AUDIT-A*`, `AUDIT-B*`, `AUDIT-C*`, `HANDOFF-SIDEBAR-RESEARCH.md`) y este `AUDIT-C3-SIDEBAR-QA-NO-REGRESSION.md`.
- `HEAD` = `404a6290134d1704bb44eff7c092c161770f49e2`. Sin commit / push / PR. Sin procesos OpenCode lanzados. Sin
  Docker. V1 / NLS1 / produccion / secretos intactos.
- Plan, handoff, codigo, tests, boveda y stash **no** editados. `sha256` de codigo sin cambios respecto a §6.9.
- Unico proceso permitido si se autoriza canario: `opencode-v2-lab.service` via `apply-v2-runtime-service.sh` (no
  usado).

---

**Firma independiente:** Auditor C3 (independiente) - tercera repeticion desde cero del gate de QA real y
no-regresion del plan de paridad del sidebar V2. Ejecutada de forma directa, sin delegacion ni orquestacion, contra
fuentes primarias (core, superficie, compositor, seam de QA, helper de contexto, tests existentes, hashes y el propio
plan). No confio en los veredictos de A3, B2, C ni C2, ni en las tablas de correccion del handoff. Veredicto:
**PASS** (1 MINOR, varios INFO).
