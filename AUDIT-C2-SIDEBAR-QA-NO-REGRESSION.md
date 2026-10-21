# AUDIT-C2-SIDEBAR-QA-NO-REGRESSION - Auditoria C2 independiente (desde cero) (QA real / no-regresion)

> **DRAFT / NO IMPLEMENTAR.** Auditoria de solo lectura. No se edito el plan, ni el handoff, ni codigo productivo,
> ni tests, ni la boveda, ni el stash. No hubo commit / push / PR. No se lanzo ningun proceso OpenCode. No se uso
> Docker. No se toco V1, NLS1, produccion ni secretos. No se delego a sub-agentes ni se uso orquestacion: la
> verificacion se hizo directamente contra fuentes primarias (codigo, tests existentes, seam de QA, helper de
> contexto, compositor, scripts de instalacion/lab, historial git y el propio plan).

## 0. Alcance, metodo e independencia

- **Objetivo auditado:** `.omo/drafts/v2-sidebar-parity-reversible-plan.md` (969 lineas) y
  `HANDOFF-SIDEBAR-RESEARCH.md` (294 lineas), en el worktree
  `/home/gabodev/oh-my-rigel-worktrees/research-v2-sidebar-parity-plan`, rama `research/v2-sidebar-parity-plan`,
  baseline `404a629`.
- **Encargo:** contrato `sidebar-audit-c2-prompt.txt`. Repeticion **desde cero** del gate C (QA real / no-regresion):
  revalidar **toda** la Auditoria C (no solo C-1..C-3), verificar **individualmente C-01..C-10** y la **matriz de 27
  conductas**, y confirmar que el plan es un plan **ejecutable** que impide repetir el **crash de texto-plano** y
  **bloquea P5** hasta la aceptacion real del host.
- **Independencia (explicita):** esta ronda **no** adopta los veredictos de `AUDIT-A3-SIDEBAR-FIDELITY.md` (PASS),
  `AUDIT-B2-SIDEBAR-ARCHITECTURE.md` (PASS) ni de `AUDIT-C-SIDEBAR-QA-NO-REGRESSION.md` (NEEDS_CORRECTION), ni las
  tablas de correccion C-01..C-10 del handoff §15. Se re-verifico contra fuentes primarias: los tests reales, el
  seam `qa-v2-t25-live-surfaces.mjs`, el helper `fake-context.mjs`, la superficie y el core, el compositor, `git`
  (HEAD, status, `sha256sum`) y las lineas citadas del propio plan.
- **Fuentes primarias releidas:** `profiles/gabo/opencode/rigel-v2-native-cli-sidebar.mjs` (+ test),
  `profiles/gabo/opencode/rigel-v2-sidebar-core.mjs`, `profiles/gabo/opencode/rigel-v2-native-cli.mjs`,
  `profiles/gabo/qa-v2-t25-live-surfaces.mjs`, `profiles/gabo/opencode/differential-oracle/entrypoint/fake-context.mjs`,
  y las secciones §0..§8 del plan + §3..§8 y §12..§15 del handoff.
- **Baseline verificado:** `HEAD = 404a6290134d1704bb44eff7c092c161770f49e2`; `git status` sin cambios en codigo
  rastreado (solo untracked de auditoria/handoff); los `sha256` de los archivos de codigo coinciden byte a byte con
  los del plan §6.9 (`a15f4ea2...`, `20d8a659...`, `10785b83...`, `e96566ea...`). El codigo **no** cambio respecto a
  lo auditado por C, A3 y B2.

## 1. Veredicto

**NEEDS_CORRECTION.**

Las **correcciones documentales C-01..C-10 estan presentes** en el plan y el handoff y, en su mayoria, son completas
y verificables: el gate del render existe (§6.4 P1.2, §6.5, §6.7), la inversion de los tests de texto esta instruida
en el **mismo** commit P1.2, las filas 6/15 estan asignadas a gates concretos, el seam esta **honestamente** relabelado
como contexto sintetico/fiel (`fake-context.mjs`) con `setup()` real y host simulado, el **riesgo residual de
aceptacion por el host** esta declarado y **P5 queda BLOQUEADO** por el gate §6.11, el baseline OFF tiene artefacto de
captura/diff (C-6), la caracterizacion pre-cambio esta nombrada (C-4), el procedimiento de mutacion esta descrito
(C-5), los comandos de suite estan fijados (C-8) y el aislamiento respecto a delegacion/orquestacion/modelos es
explicito (C-9).

Sin embargo, **el gate del render (C-1) no discrimina correctamente el artefacto que debe proteger**. El plan exige
que `render()` devuelva "un nodo estructurado (**objeto con `kind`**)" (plan §6.4 P1.2(a)/(c), §6.7, §6.10 fila 6).
Ese discriminador es **exactamente** la forma de la **IR del core**, `{kind:"box"|"text"}`
(`rigel-v2-sidebar-core.mjs:506,511,515`), que el **propio plan** clasifica como "IR agnostica" y que **no** es el nodo
del host (se materializa con `@opentui/solid createElement/insert/setProp`, plan §3.2). En consecuencia, la
implementacion mas obvia (devolver `buildViewNodes(...)`) **satisface el gate** sin materializar nada, y el canario P3
puede quedar **verde con el render aun inaceptable para el host**. Es la misma clase de falso verde que el BLOCKER
C-1 exigia eliminar.

Hay **1 MAJOR** (C2-1) y **varios MINOR/INFO**. Bajo la regla del contrato C2 ("PASS solo sin BLOCKER/MAJOR"), un
MAJOR impide PASS. **No** se encontro BLOCKER.

## 2. Evidencia primaria verificada (reproducible)

Cada fila es lo que devolvio la fuente, no lo que afirma el plan.

### 2.1 Codigo y tests en HEAD (sin cambios; hashes verificados)

| Hecho verificado | Fuente observada | Veredicto |
| --- | --- | --- |
| `render` de la superficie devuelve `describeView(view)` por defecto (cadena); en error devuelve `""` | `rigel-v2-native-cli-sidebar.mjs:331-334` (`renderView` -> `return describeView(view)`), `:341-345` (`render` -> `renderView(view)`) | OK (causa historica intacta) |
| La suite **fija el texto plano** como esperado | `rigel-v2-native-cli-sidebar.test.mjs:163-164` (`toContain("atlas running")`, `toContain("Agents")`), `:170` (`toBe("No configured models")`) | **Confirmado** (a invertir en P1.2) |
| El core produce la **IR** `{kind:"box"\|"text"}` y `buildViewNodes` la ensambla | `rigel-v2-sidebar-core.mjs:506` (`{kind:"box"}`), `:511` (`{kind:"text"}`), `:515` (`export function buildViewNodes`) | **Confirmado** (colision con el gate; C2-1) |
| `resolveSidebarGate` es fail-**open** sin options (`{enabled:true}`) | `rigel-v2-native-cli-sidebar.mjs:77-81` | OK (lo que P1.1 corrige) |
| `resolveStateRoot` cae a `homedir()/.local/state` sin `XDG_STATE_HOME` | `rigel-v2-native-cli-sidebar.mjs:83-86` | OK (justifica B-13) |
| La superficie se suscribe a eventos, sin temporizadores | `rigel-v2-native-cli-sidebar.mjs:374-393` (`session.created/deleted/updated/execution.*`) | OK (fila 9 incognita honesta) |
| Compositor exige `=== true` (OFF por defecto en dev/canario) | `rigel-v2-native-cli.mjs:48,54` | OK |
| Hashes de codigo identicos a §6.9 | `sha256sum` de los 4 archivos | OK (byte a byte) |

### 2.2 Seam de QA (citado por el plan; verificado linea a linea)

| Afirmacion del plan | Fuente observada | Veredicto |
| --- | --- | --- |
| Contexto CLI con `{options, renderer, location, data, ui, keymap, ...}` en `qa-v2-t25-live-surfaces.mjs:171-186` | L171 `const context = {`; L172 `options: {}`; L173 `renderer: { isDestroyed: false, requestRender() {} }`; L186 `}` | OK (cita exacta) |
| `setup()` real en `:211` | L211 `const dispose = plugin.setup(context)` | OK |
| Slot capturado en `:246-247` | L246 asercion `sidebar.content`; L247 `check("tui-sidebar", ...)` | OK |
| Recibo leido en `:248-249` | L248 lectura `sidebar-snapshot.json`; L249 `check(...)` | OK |
| Negativo de gate `enabled:false` en `:268-278` | L269 `options: { tui: { sidebar: { enabled: false } } }`; L278 `check(...)` | OK |
| El seam **no** invoca `render()` | `grep '.render('` en el seam = **NONE** | OK (hueco a cerrar en P1.2) |
| `fake-context.mjs` documentado como `Fake OpenCode V2 setup context` | `fake-context.mjs:1-2` | OK |
| El seam **importa** `createEntrypointContext` desde `fake-context.mjs` | `qa-v2-t25-live-surfaces.mjs:39` (`import { createEntrypointContext, hooksNamed } from "./opencode/differential-oracle/entrypoint/fake-context.mjs"`); usado en `:71` (entrypoint servidor) y `:137` (negativo) | OK (pero el contexto del **sidebar** es inline, L171-186; ver C2-3) |
| Sandbox XDG del seam | L43-51 (`mkdtempSync`, `XDG_STATE_HOME`/`XDG_DATA_HOME`/`XDG_CONFIG_HOME`) | OK |

### 2.3 Plan: correcciones C-01..C-10 presentes (ubicacion verificada)

Todas las correcciones del handoff §15 existen tambien **en el plan** (no solo en el handoff). La colision de C2-1
afecta a la implementacion literal del discriminador de C-1.

## 3. Verificacion individual C-01..C-10

| ID | Sev. original | Correccion exigida | Presente en el plan (ubicacion) | Veredicto C2 |
| --- | --- | --- | --- | --- |
| C-1 | **BLOCKER** | Gate ejecutable del render; inversion de tests de texto en el **mismo** P1.2; filas 6/15 a gates concretos | §0.9, §5, §6.4 P1.2(a)(b)(c), §6.5, §6.6, §6.7, §6.10 filas 6/15, §7A/B/C | **Parcial -> MAJOR (C2-1)**: presente pero el discriminador (`objeto con kind`) coincide con la IR; puede quedar verde sin materializar |
| C-2 | MAJOR | Declarar riesgo residual y definir el gate real antes de P5; condicionar P5 | §0.10, §6.4 P4/P5, §6.5, §6.6, **§6.11 (nuevo)**, §7B/C | **PASS**: §6.11 declara el hueco y bloquea P5; el mecanismo concreto queda condicional (honesto; ver INFO) |
| C-3 | MAJOR | Relabelar el seam como contexto sintetico/fiel; `setup()` real, host simulado | §0.10, §5, §6.5, §6.6, §6.7, §6.11, §7C | **PASS (con precision, C2-3)**: sustancia correcta; la atribucion del contexto del sidebar a `fake-context.mjs` es imprecisa (es inline) |
| C-4 | MINOR | Nombrar caracterizacion pre-cambio (render actual + baseline OFF) y su pre/post | §0.9, §6.4 P4, §6.7, §7B | **PASS** |
| C-5 | MINOR | Definir procedimiento de mutacion (hash pre/post, mutantes RED, comando, umbral) | §6.4 P4, §6.7, §7B/C | **Parcial -> MINOR (C2-2)**: el procedimiento esta; el "comando y umbral" remite a §6.8 y **no existe** alli |
| C-6 | MINOR | Artefacto de captura/diff del baseline OFF | §0, §6.1 (`{composedSurfaces[], registeredSlots[], receiptsWritten[], logEvents[], renderType}`), §6.9, §7B | **PASS** |
| C-7 | MINOR | Gate ejecutable por fila; filas 9/10 como riesgo aceptado | §6.10 (filas 8, 9, 10, 20-23, 25 + leyenda + nota), §7A/B | **PASS** |
| C-8 | INFO | Fijar comandos y umbral de no-regresion | §6.4 P4, §6.7, §7C (`bun test profiles/gabo` verde + `node profiles/gabo/validate-profile.mjs` exit 0) | **PASS** |
| C-9 | INFO | Mencion explicita de no tocar delegacion/orquestacion/modelos | §0, §6.1 (parrafo nuevo) | **PASS** |
| C-10 | INFO | Nota cruzada en fila 26 | §6.10 fila 26 | **PASS** |

**C-01..C-10: presentes 10/10.** C-1 queda debil por el discriminador (C2-1); C-5 tiene una referencia colgante (C2-2);
C-3 tiene una imprecision de atribucion (C2-3). Ninguna correccion quedo **ausente**.

## 4. Tabla de las 27 conductas y su gate (revalidada)

Columnas: **#** y capacidad (plan §6.10); **Gate** (donde el plan la ubica); **Veredicto C2**; **Nota**.

| # | Capacidad | Gate | Veredicto C2 | Nota |
| --- | --- | --- | --- | --- |
| 1 | Banner de config invalida | core + seam (recibo) | Observable | - |
| 2 | ULW goals/pass/fail/pending/blocked/active | core + seam (recibo `loop`) | Observable | - |
| 3 | Seccion Agents | core + seam (recibo) | Observable | - |
| 4 | Seccion Jobs `toolCalls`/`lastTool` | core + seam (recibo) | Observable | - |
| 5 | Vista idle + roster Models | core + seam (recibo) | Observable | - |
| 6 | Arbol `ViewNode` y materializacion | **seam hermetico (`render()` -> nodo) + §6.11 (host)** | **Parcial (C2-1)** | El gate `objeto con kind` es satisfacible por la IR; la materializacion real no se discrimina |
| 7 | Maquina de estados active/broken/idle | core + fault injection | Observable | - |
| 8 | Transiciones (idle<->active, active->broken, sesion creada/cerrada) | **gate P3** (eventos de sesion en el seam) | Cubierta (gate asignado) | El seam actual no emite eventos de sesion; P3 debe implementarlo |
| 9 | Debounce 250/heartbeat 2 s/poll 1 s | **gate T (§6.4 P3.2)** | Incognita/Bloqueada (riesgo aceptado) | Honesto; no se declara cubierta |
| 10 | Frescura snapshot 6 s | n/a (sin canal de espejo) | Inerte (riesgo aceptado) | Honesto |
| 11 | Frescura loop 120 s | core + canario | Observable | - |
| 12 | Caps MAX_AGENTS/MAX_JOBS/LABEL_MAX | core | Observable | - |
| 13 | Redaccion goal activo -> `private` | core | Observable | - |
| 14 | Espejo ruta/hash/projectDir/0600 | core + seam (recibo) | Observable | - |
| 15 | Tema | **unit adaptador + seam (`render()` -> nodo) + §6.11** | **Parcial (C2-1)** | Igual que fila 6: el tipo del nodo no se discrimina de la IR |
| 16 | Agentes activos busy/retry/running | core + canario | Observable | - |
| 17 | Nombre de agente por ultimo mensaje | core + seam | Observable | - |
| 18 | Roster = tabla de resolucion | core + canario | Observable | - |
| 19 | Compuerta loop live (algun `in_progress`) | core + canario | Observable | - |
| 20 | Ciclo de vida attach | **gate P4** | Cubierta (gate asignado) | Adaptacion V2 (`setup` compone); semantica de default en fila 27 |
| 21 | Dispose (tres rutas) | **gate P1.3/P3** (contador de disposers) | Cubierta (gate asignado) | - |
| 22 | Concurrencia: dedup de flush | **gate P1.3** (doble setup concurrente) | Cubierta (gate asignado) | - |
| 23 | Reconexion inexistente + degradacion | **gate P4** | Cubierta (gate asignado) | - |
| 24 | Permisos: sin chequeos | n/a | n/a (correcto) | - |
| 25 | Fallos parciales: degrada sin lanzar | **gate P4** | Cubierta (gate asignado) | - |
| 26 | No interactivo: recibo por el companion CLI | seam hermetico (no el lab) | Cubierta | C-10: "recibo observado" != "render aceptado" (nota presente) |
| 27 | Semantica de config: ON salvo `false` | unit config + **cableado P0.4**; objetivo P5 | Cubierta | Ver INFO-1 (etiqueta de estado en el presente) |

**Lectura:** las filas de datos/derivacion (1-5, 7, 11-14, 16-19) son observables por core+recibo. Las filas 6/15
tienen gate asignado pero **el tipo del render no se discrimina de la IR** (C2-1). Las filas 8/20-23/25 tienen gate
ejecutable asignado (C-7 resuelto). Las filas 9/10 quedan honestamente Incognita/Inerte como riesgo aceptado. La
matriz tiene **27 filas** (conteo verificado). Cobertura observable: **amplia**, con la salvedad de C2-1.

## 5. Gates transversales del contrato C2 (checklist)

| Gate exigido por el contrato C2 | Resultado | Evidencia |
| --- | --- | --- |
| Gate hermetico ejecutable; `render()` -> nodo, nunca texto/vacio | **PARCIAL** | El gate existe (seam invoca `render()`, §6.4 P1.2(c)); pero el discriminador `objeto con kind` coincide con la IR -> C2-1 |
| Inversion del test de texto en el **mismo** P1.2 | PASS | §6.4 P1.2(b) cita los tests exactos (`toBe("No configured models")`, `toContain("atlas running")`, `toContain("Agents")`) |
| Filas 6/15 asignadas a gates concretos | PASS | §6.10 filas 6/15 + §6.11 |
| Distincion honesta `setup()` real vs `fake-context` sintetico | PASS (con precision C2-3) | §6.5/§6.6/§11; el contexto del sidebar es inline (L171-186) y `fake-context` se usa para el entrypoint servidor (L71/137) |
| Riesgo residual de aceptacion por host declarado | PASS | §0.10, §6.11 ("riesgo residual explicito") |
| Gate real visual/host definido y obligatorio antes de P5 | PASS (con condicion) | §6.11; P5 BLOQUEADO; el mecanismo concreto depende de un camino autorizado o decision firmada de Gabo |
| Flag OFF conductualmente identico | PASS | §6.1 + §6.9 (inventario conductual: superficies/slots/recibos/logs/render) |
| Lifecycle / transiciones / fallos | PASS (asignado) | Filas 8/20/21/23/25 con gate |
| Rollback (artefactos desplegados) | PASS | §6.8 pasos 1-5; `status` real |
| `XDG_STATE_HOME` explicito | PASS | §2.7, §6.6, §6.7 + `resolveStateRoot` (`:83-86`) |
| Doble setup / concurrencia | PASS | P1.3 + §6.7 |
| Peers / flat install con flag ON | PASS | §6.3/§6.4 P1.2/§6.7 (`peerDependencies`) |
| No-gating de modelos/delegacion/orquestacion | PASS | §6.1 (parrafo C-9) + §6.3 P2.3 |
| Caracterizacion pre-cambio | PASS | §6.7 (C-4) |
| Negativos | PASS | §6.2 matriz + §6.7 |
| Fault/mutacion restaurada (hash exacto) | PARCIAL | §6.7 (C-5) pero el "comando y umbral" remite a §6.8 y no esta -> C2-2 |
| Suites completas (comando/umbral) | PASS | §6.7 (C-8): `bun test profiles/gabo` + `validate-profile.mjs` |
| Laboratorio V2 real | PASS (honesto) | Solo el lab para lo vivo (`apply-v2-runtime-service.sh`); el lab **no** observa el sidebar (declarado) |
| Ninguna simulacion presentada como evidencia de host | PASS | §6.5/§6.6/§6.11 (C-3): el seam prueba rutas, no host |

## 6. Hallazgos nuevos

### BLOCKER

Ninguno.

### MAJOR

| ID | Sev. | Hallazgo | Evidencia | Impacto | Correccion exigida |
| --- | --- | --- | --- | --- | --- |
| C2-1 | **MAJOR** | El **discriminador del gate del render (C-1) coincide con la IR del core**. El plan exige que `render()` devuelva "nodo estructurado (**objeto con `kind`**)" (§6.4 P1.2(a)/(c), §6.7, §6.10 fila 6). La IR del core es `{kind:"box"\|"text"}` (`rigel-v2-sidebar-core.mjs:506,511,515`), que el **propio plan** llama "IR agnostica" y que **no** es el nodo del host (se materializa con `@opentui/solid createElement/insert/setProp`, §3.2). Devolver `buildViewNodes(...)` -la implementacion naive mas probable- **satisface el gate** sin materializar, y el canario P3 puede quedar **verde con el render aun inaceptable para el host**. | plan §6.4 P1.2(a)/(c), §6.7, §6.10 fila 6 vs `rigel-v2-sidebar-core.mjs:506,511,515` + plan §3.2 (IR vs materializacion `@opentui/solid`); `test.mjs:163-170` (texto actual) | Reintroduce la clase de falso verde que el BLOCKER C-1 debia eliminar: el gate no distingue "nodo materializado" de "IR"; la aceptacion del host queda solo en el gate diferido §6.11 | El gate debe asertar el **nodo materializado** (salida de `rigel-v2-sidebar-node.mjs`), no un objeto `{kind}`: (1) asertar que el output es producido por el materializador / la fabrica de `context.renderer` (o un elemento `@opentui/solid`), **distinto** de la IR `buildViewNodes`; (2) anadir un negativo explicito de que devolver la IR cruda **falla** el gate; (3) no usar `kind` como discriminador (es el marcador de la IR) |

### MINOR

| ID | Sev. | Hallazgo | Evidencia | Impacto | Correccion exigida |
| --- | --- | --- | --- | --- | --- |
| C2-2 | MINOR | **Referencia colgante en C-5.** §6.7 dice "Comando y umbral en §6.8", pero §6.8 (Stop/go y rollback) **no** contiene ningun comando ni umbral de mutacion. | plan §6.7 (linea 755) vs §6.8 (lineas 759-777); `grep 'umbral\|mutant'` solo aparece en la linea 755 | El procedimiento de mutacion queda sin comando/umbral -> el gate C-5 no es plenamente ejecutable | Poner el comando y el umbral de mutacion en §6.7 o anadir una subseccion en §6.8 |
| C2-3 | MINOR | **Atribucion imprecisa (C-3).** El plan atribuye el contexto del sidebar a `fake-context.mjs`, pero el seam construye el contexto del sidebar **inline** (`options`, `renderer`, `location`, `data`, `ui`, `keymap`) en L171-186; `fake-context.mjs` (importado en L39) se usa para el **entrypoint servidor** (L71) y el negativo (L137). | `qa-v2-t25-live-surfaces.mjs:39,71,137,171-186`; `fake-context.mjs:1-2` | La sustancia (contexto sintetico, host simulado) se mantiene; la cita del modulo es imprecisa para la ruta del sidebar | Precisar que el contexto del sidebar es inline (L171-186) y que `fake-context.mjs` cubre el entrypoint servidor |
| C2-4 | MINOR | **Ejecutabilidad del gate del render atada a la procedencia no decidida + renderer stub.** El seam arma `renderer: { isDestroyed:false, requestRender(){} }` (L173), **sin** fabrica `createElement`. Si el materializador usa la fabrica del host via `context.renderer` (procedencia diferida, B2-2), el seam **no puede** materializar el nodo y la asercion de tipo en el seam no es ejecutable; si usa `@opentui/solid` directo, el seam necesita ese peer. El plan no especifica el renderer del seam para el gate. | §6.3/§6.4 P1.2 (procedencia "decidir y documentar") vs `qa-v2-t25-live-surfaces.mjs:173` (stub sin fabrica) | El gate del render podria no ser ejecutable en el seam hasta fijar la procedencia y el renderer del seam, retrasando P1.2 | Fijar la procedencia en P1.2 y especificar un renderer del seam capaz de materializar (o acotar el gate a la asercion unitaria y documentarlo) |

### INFO

| ID | Sev. | Hallazgo | Evidencia | Impacto | Correccion exigida |
| --- | --- | --- | --- | --- | --- |
| C2-5 | INFO | La fila 27 figura como "Cubierta" aunque el cableado real es P0.4 y la semantica default-ON es P5; hoy "sin cablear". El gate future-existe pero la etiqueta sugiere cobertura presente. | §6.10 fila 27 (`| 27 | ... | Cubierta |`) | Trazabilidad; riesgo de lectura "ya probado" | Etiquetar "Cubierta (gate P0.4/P5)" como en las filas 8/20-23 |
| C2-6 | INFO | Las filas 9/10 se declaran "riesgo aceptado". El plan ya preserva el contrato (si el gate T falla, conserva refresco explicito). Conviene blindar que "riesgo aceptado" no se lea como reduccion de un item no-reducible. | §6.10 filas 9/10 + notas A2-02/A-05; §6.4 P3.2 | ninguno material | Mantener la condicion "o se conserva un refresco explicito" junto a la etiqueta |
| C2-7 | INFO | **Confirmaciones positivas:** las lineas del plan citadas al seam (171-186, 211, 246-249, 268-278) son **exactas**; el conteo de filas de la matriz es **27**; las C-01..C-10 estan **todas** presentes en el plan; los hashes de codigo coinciden byte a byte. | §2.1/§2.2/§2.3; `awk` count = 27; `sha256sum` | ninguno | ninguna |

## 7. Aislamiento, limites y lo no verificado

- **Ejecucion de esta auditoria:** verificacion directa, sin sub-agentes, sin team-mode, sin orquestacion. Solo
  comandos de lectura (`git` de consulta, `grep`, `sed`, `sha256sum`, `awk`). No se lanzo ningun proceso OpenCode;
  no se uso Docker; no se toco V1 / NLS1 / produccion / secretos. La boveda no se leyo en esta ronda (no era
  necesaria para el gate C2; los artefactos de boveda ya fueron validados por A3/B2 y se conservan).
- **Aislamiento en el plan:** §6.1 prohibe V1, NLS1, produccion, secretos, Docker/contenedores,
  `run`/`serve`/`--standalone` directos, big-bang, autoaprobar y usar el sidebar como gate de modelos; ademas exige
  no tocar delegacion/orquestacion/routing/prompts/agentes/categorias/fallbacks/permisos/continuidad/background
  handoff/seleccion de modelo (C-9). La unica via viva es `opencode-v2-lab.service` via
  `apply-v2-runtime-service.sh`; el seam no lanza procesos.
- **No verificado (por prohibicion del contrato):** no se ejecuto ningun gate (render, T, suite, flat install,
  mutaciones, drill de rollback, canario) porque el contrato prohibe implementacion y el plan es DRAFT. Esta
  auditoria es de **suficiencia y ejecutabilidad del diseno de QA**, contrastada con los tests, el seam, el core y
  el compositor reales.
- **Lo verificado como correcto:** flag OFF sin side effects; controles negativos; cableado del flag por ruta unica;
  matriz de capacidad fail-closed asignada a P1; rollback de artefactos desplegados con `status` real; XDG explicito;
  doble setup; peers/`peerDependencies`; no-gating de modelos; y cobertura unit/core amplia.
- **Limitacion:** no fue posible determinar la forma exacta del nodo del host (`@opentui/solid`) en este entorno; el
  hallazgo C2-1 se sostiene precisamente porque el plan **tampoco** la fija y usa como discriminador el marcador de
  la IR, que si es verificable.

## 8. Conclusion

El plan corregido resuelve **C-01..C-10** de forma verificable en el 100% de los casos y responde, en su mayoria, al
contrato C2: gate del render presente, inversion de tests de texto en el mismo commit P1.2, filas 6/15 con gate,
seam honestamente relabelado, riesgo residual declarado y **P5 bloqueado** por un gate real de aceptacion del host,
baseline OFF con artefacto, caracterizacion, mutacion (procedimiento), suites, y aislamiento explicito.

El defecto que impide PASS es concreto y reproducible por lectura: **el discriminador del gate del render
(`objeto con kind`) coincide con la IR del core** (`rigel-v2-sidebar-core.mjs:506,511,515`), que el propio plan
declara **no** ser el nodo del host. El gate, por tanto, puede quedar **verde con el render aun inaceptable para el
host** -exactamente la clase de falso verde que C-1 mandaba eliminar-, y el canario P3 podria no detectarlo. Los
MINOR (referencia colgante de C-5; atribucion de `fake-context`; ejecutabilidad del gate frente al renderer stub)
son recomendados y no bloquean por si solos.

**Veredicto: NEEDS_CORRECTION.**

Correccion minima para levantar el MAJOR: **reformular el gate del render para asertar el nodo materializado**
(salida del materializador / fabrica de `context.renderer` o elemento `@opentui/solid`), **distinto** de la IR
`buildViewNodes`, y anadir un negativo de que devolver la IR cruda **falla** el gate; no usar `kind` como
discriminador. Con eso, mas el cierre de C2-2/C2-3/C2-4, el plan quedaria en condiciones de PASS en una C3.

Esta auditoria **no se autoaprueba** como autoridad final. A3 y B2 emitieron PASS en sus gates; C2 (gate de QA) emite
NEEDS_CORRECTION. La aprobacion de release (P5) sigue requiriendo A + B + C y gates reales, segun §6.4/§7.

## 9. Limites de acceso y estado del repositorio

- `git status`: sin cambios en codigo rastreado; los unicos untracked son los documentos de auditoria/handoff
  (`AUDIT-A*`, `AUDIT-B*`, `AUDIT-C*`, `HANDOFF-SIDEBAR-RESEARCH.md`) y este `AUDIT-C2-SIDEBAR-QA-NO-REGRESSION.md`.
- `HEAD` = `404a6290134d1704bb44eff7c092c161770f49e2`. Sin commit / push / PR. Sin procesos OpenCode lanzados. Sin
  Docker. V1 / NLS1 / produccion / secretos intactos.
- Plan, handoff, codigo, tests, boveda y stash **no** editados. `sha256` de codigo sin cambios respecto a §6.9.
- Unico proceso permitido si se autoriza canario: `opencode-v2-lab.service` via `apply-v2-runtime-service.sh` (no
  usado).

---

**Firma independiente:** Auditor C2 (independiente) - repeticion desde cero del gate de QA real y no-regresion del
plan de paridad del sidebar V2. Ejecutada de forma directa, sin delegacion ni orquestacion, contra fuentes primarias
(tests existentes, seam de QA, helper de contexto, superficie, core, compositor, historial git y el propio plan). No
confio en los veredictos de A3, B2 ni C, ni en las tablas de correccion del handoff. Veredicto: **NEEDS_CORRECTION**.
