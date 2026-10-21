# AUDIT-B-SIDEBAR-ARCHITECTURE - Auditoria B independiente (arquitectura, aislamiento, rollback)

> **DRAFT / NO IMPLEMENTAR.** Auditoria de solo lectura. No se edito el plan, ni el handoff, ni codigo
> productivo, ni tests, ni la boveda, ni el stash. No hubo commit / push / PR. No se lanzo ningun proceso
> OpenCode. No se uso Docker. No se toco V1, NLS1, produccion ni secretos. No se delego a sub-agentes ni se
> uso orquestacion: la verificacion se hizo directamente contra fuentes primarias (codigo, historial git,
> scripts de instalacion/lab, ledger y documentacion oficial V2).

## 0. Alcance, metodo e independencia

- **Objetivo auditado:** `.omo/drafts/v2-sidebar-parity-reversible-plan.md` (677 lineas) y
  `HANDOFF-SIDEBAR-RESEARCH.md` (179 lineas), en el worktree
  `/home/gabodev/oh-my-rigel-worktrees/research-v2-sidebar-parity-plan`.
- **Independencia:** esta ronda **no** confio en `AUDIT-A-SIDEBAR-FIDELITY.md`, `AUDIT-A2-SIDEBAR-FIDELITY.md`
  ni `AUDIT-A3-SIDEBAR-FIDELITY.md`, ni en sus tablas de correccion. A3 emitio **PASS**; esta auditoria
  re-verifica el **gate B** (arquitectura/aislamiento/rollback) desde cero y **no** adopta ese veredicto.
  Se releyeron fuentes primarias: `profiles/gabo/**`, `packages/omo-opencode/src/features/tui-sidebar/**`,
  `git` (SHAs, `--stat`, `--numstat`, `cat-file`, `stash show`), ledger, scripts de laboratorio, boveda
  Obsidian (solo lectura) y documentacion oficial OpenCode V2 (`docs/build/plugins/cli`, `.../plugins`,
  `.../plugins/migrate-v1`).
- **Baseline:** rama `research/v2-sidebar-parity-plan`; `HEAD = 404a6290134d1704bb44eff7c092c161770f49e2`
  (Merge PR #19); `stash@{0} = ddea0b7d85caf734a819dcad3aae99db9aa3abad`. `git status` del arbol rastreado:
  limpio; los unicos untracked son los documentos de auditoria/handoff.
- **Ejes del gate B verificados:** dueño unico y un solo registro; feature flag OFF preservando baseline;
  default-ON solo en P5 tras A+B+C; gates de capacidad/version fail-closed; empaquetado/flat install y peers;
  lifecycle attach/detach/dispose sin listeners/timers/leaks; concurrencia y doble setup idempotentes; datos
  vivos tolerantes y sin acceso a V1; seam hermetico separado del lab y del seam visual; fases/commits
  atomicos; inventarios/hashes; rollback ensayable y comando de desactivacion suficiente; no tocar
  delegacion/orquestacion/routing/prompts/agentes/categorias/fallbacks/permisos/continuidad/background
  handoff/seleccion de modelo; sidebar nunca gate de modelos.

## 1. Veredicto

**NEEDS_CORRECTION.**

La arquitectura propuesta es, en su forma, la correcta: **aditiva**, con **dueño unico** de la superficie y
del registro, **flag-gated**, **fase por fase**, con seam hermetico definido, hashes de baseline exactos y
rollback por `git revert`. Nada obliga a un REJECT: el plan puede por fases sin reescribir funciones
existentes.

Sin embargo, **no es implementable tal como esta escrito** por tres defectos materiales del gate B, y varios
de atomicidad/rollback que el propio contrato marca:

1. **(B-01, ALTA)** El feature flag `tui.sidebar.enabled` **no esta cableado** desde ninguna configuracion real
   a `context.options`. Ninguna ruta de registro escribe esa clave. Por tanto el "modo opt-in en dev/canario"
   y el "comando exacto de desactivacion" del plan **no son ejecutables**, y un canario verde por el seam
   hermetico seria **falso verde** (probado sobre una configuracion que el host desplegado no puede producir).
2. **(B-02, ALTA)** El "version gate por capacidad fail-closed" de la seccion 6.2 **no esta asignado a una
   fase** ni existe hoy: el compositor no consulta `ui.slot`/renderer, y la superficie aislada **no** es
   fail-closed (sin `options`, `resolveSidebarGate` devuelve `{ enabled: true }`).
3. **(B-03 a B-06, MEDIA)** Fases no atomicas (P0/P2/P3), P2 mezcla runtime/roster/overrides de modelo y usa
   una API **no documentada** (`context.state`), el renderer/peer de P1 esta sin resolver, y el rollback por
   `git revert` **no** cubre los artefactos desplegados (runtime del lab + `cli.json`).

PASS queda **descartado** mientras B-01 y B-02 sigan abiertos: con el flag sin cablear, la paridad objetivo
(P5, "visible de fabrica" + `enabled:false` para ocultar) no puede alcanzarse ni probarse. REJECT queda
**descartado** porque el diseño es aditivo y reversible y las correcciones son de alcance y cableado, no de
reescritura.

## 2. Evidencia primaria verificada (reproducible)

Cada fila es lo que devolvio la fuente primaria, no lo que afirma el plan. Comandos ejecutados desde la raiz
del worktree salvo indicacion.

### 2.1 Historial, hashes y stash (coinciden con el plan)

| Afirmacion del plan | Fuente | Observado | Veredicto |
| --- | --- | --- | --- |
| `HEAD = 404a62901` (Merge PR #19) | `git rev-parse HEAD` | `404a6290134d1704bb44eff7c092c161770f49e2` | OK |
| Revert `6a46ed3ef` = 24 archivos, `+85/-1779` | `git show --stat 6a46ed3ef` | `24 files changed, 85 insertions(+), 1779 deletions(-)` | OK (exacto) |
| Creados y borrados (ausentes en HEAD): `rigel-v2-sidebar-node.mjs`, `rigel-v2-sidebar-theme.mjs`, `v2-agent-selection-core.mjs` | `git cat-file -e HEAD:<ruta>` | Los tres **ABSENT** en HEAD | OK |
| `notification-activation-config.mjs` **existe** en HEAD (modificado y revertido en contenido, no borrado) | `git cat-file -e HEAD:` | `EXISTS` | OK |
| `rigel-v2-native-runtime.mjs` nunca existio | `git cat-file -e HEAD:` | `ABSENT` | OK |
| `stash@{0}` = 8 archivos con numstat exacto | `git stash show --numstat stash@{0}` | 8 lineas; `rigel-v2-native-cli-sidebar.mjs 147/38`; `...test.mjs 113/5`; `rigel-v2-sidebar-node.mjs 4/1`; `rigel-v2-native-agents.test.mjs 52/0`; `rigel-v2-native-runtime.test.mjs 72/1`; `test-env.ts 6/0`; `package.json 1/0`; `bun.lock 1/0` | OK (exacto) |
| Hashes de baseline (§6.9) | `sha256sum` de los 5 archivos | Los 5 coinciden byte a byte con el plan | OK |

### 2.2 Composer, superficie y registro (dueño unico y un solo registro)

| Afirmacion / hecho | Fuente observada | Veredicto |
| --- | --- | --- |
| Un solo compositor del slot: `rigel-v2-native-cli.mjs` | `createCompanionCliPlugin()` compone las 6 superficies y decide el sidebar en L48/L54 | OK |
| Gate del compositor: OFF salvo `=== true` | `rigel-v2-native-cli.mjs:48` `const sidebarEnabled = context?.options?.tui?.sidebar?.enabled === true`; L54 compose solo si `sidebarEnabled` | OK |
| Un solo registrador de `sidebar.content` | `grep sidebar\.content\|ui\.slot` en `profiles/gabo/opencode/*.mjs`: solo `rigel-v2-native-cli-sidebar.mjs:352-368` | OK |
| El plugin de servidor no toca UI/slot | `rigel-v2-native.mjs`: sin `ui.slot`/`renderer`/`sidebar.content` | OK |
| Registro del paquete CLI en `cli.json` exactamente una vez | `registerCompanionCliPlugin(cliBefore, ...)` deduplica por `familyRoot` (`notification-activation-config.mjs:204-225`) | OK |
| El compositor **no** es idempotente ante doble `setup` | `setup` no guarda estado de "ya compuesto"; cada llamada vuelve a suscribir 6 eventos y a registrar el slot | **GAP (B-07)** |
| La superficie aislada **no** es fail-closed | `resolveSidebarGate(options)` (`...sidebar.mjs:77-81`): sin `options` ni bloque, devuelve `{ enabled: true }` | **OBS (B-02)** |

### 2.3 Cableado del feature flag (hallazgo central B-01)

| Hecho | Fuente observada | Veredicto |
| --- | --- | --- |
| El unico consumidor del flag es el compositor (`context.options.tui.sidebar.enabled`) y la superficie | `rigel-v2-native-cli.mjs:48`; `...sidebar.mjs:78` | OK |
| El unico escritor del `options` del paquete CLI es `registerCompanionCliPlugin` | `notification-activation-config.mjs:207` `const entry = { package: runtimeDir, options: { notification: options } }` | **Sin `tui`** |
| El laboratorio escribe `cli.json` reconstruyendo el entry (pierde cualquier clave extra) | `rigel-v2-runtime-materialize.mjs:139-147` | **Sin `tui`** |
| El instalador de usuario reescribe `cli.json` con el mismo helper | `rigel-v2-user-install.mjs:431-439` | **Sin `tui`** |
| Ninguna plantilla de config define `tui` | `grep tui` en `profiles/gabo/omo.jsonc` y `profiles/gabo/opencode/opencode.json`: sin resultados | **Sin `tui`** |
| El unico lugar que setea `options.tui.sidebar` es el seam de QA (negativo) y los tests | `qa-v2-t25-live-surfaces.mjs:269`; `rigel-v2-native-cli-sidebar.test.mjs:86,112` | **Solo test/seam** |
| El entry del runtime en `opencode.json` es un string (sin options) | `materialize-v2-cli.mjs` / `rigel-v2-runtime-materialize.mjs:132-136` | **Sin `tui`** |

Conclusion verificada: **no existe ruta de configuracion que ponga `context.options.tui.sidebar.enabled` en
`true` (ni en `false`) en un host real.** La unica forma de componer el sidebar hoy es inyectar `options`
directamente sobre el objeto `context`, que es exactamente lo que hace el seam hermetico y los unit tests.

### 2.4 Documentacion oficial V2 (la doc precede a inferencias)

| Afirmacion del plan | Observado en doc oficial | Veredicto |
| --- | --- | --- |
| `context.ui.slot({ append, render })` y el slot `sidebar.content` | Doc `build/plugins/cli` > Slots: lista `sidebar.content`; ejemplo `context.ui.slot({ append: "sidebar.content", render: ({ sessionID }) => <text>...</text> })` | OK |
| El `render` devuelve **JSX/nodo** (no texto) | Doc > Slots: todos los ejemplos devuelven elementos JSX; no hay forma "texto plano" | OK (confirma la causa del crash) |
| `context.data.on(name, handler)` devuelve unsubscribe | Doc > Events: "both return an unsubscribe function" | OK |
| `context.data.session.list/get/status` | Doc > Sessions: `list()`, `get(id)`, `status(id)`, `sync`, `invalidate` | OK |
| `context.data.location.agent/model.list(location)` | Doc > Location data: `agent.list(location)`, `model.list(location)` | OK |
| `context.ui.model.current()` | Doc > Model: `context.ui.model.current()` (reactivo en computo Solid) | OK |
| `setup` devuelve funcion de limpieza | Doc > Context: "Return a cleanup function for resources owned by the plugin" | OK |
| **`context.state` (propuesto en P2)** | Doc: **no aparece** `context.state`; el contexto documentado es `options/location/app/client/data/renderer/theme/ui/keymap/attention` | **NO DOCUMENTADO (B-05)** |
| **Peers al renderizar JSX** | Doc > Publish and load: `peerDependencies: { "@opentui/core": ">=0.5.8", "@opentui/solid": ">=0.5.8", "solid-js": ">=1.9.0" }` | **peer, no dependency (B-04)** |
| `cli.json` = `{ "plugins": [...] }`; exports `./tui` | Doc > Publish and load | OK |

### 2.5 Empaquetado / despliegue

| Hecho | Fuente observada | Veredicto |
| --- | --- | --- |
| Los modulos nuevos importados por el composer se descubren y despliegan solos | `native-runtime-modules.mjs:24-43` camina el grafo de imports relativos desde `rigel-v2-native.mjs` y `rigel-v2-native-cli.mjs` | OK (P1 no requiere lista manual) |
| `discoverRuntimeModules` **no** sigue imports bare (paquetes) | el regex solo captura `from "."` relativos | Los peers quedan al host (coherente con doc) |
| El lab symlinkea `node_modules` del repo y hornea `RIGEL_V2_REPO_ROOT` | `materialize-v2-cli.mjs:120-146` | **Dependencia del repo (contexto, no del sidebar)** |
| El instalador de usuario **no** symlinkea `node_modules` | `rigel-v2-user-install.mjs:278-313` (copia a `versions/<v>/runtime`) | Flat install real; necesita peers del host |

### 2.6 Estado actual del sidebar (OFF en dev/canario) y sin side effects con flag OFF

| Hecho | Fuente observada | Veredicto |
| --- | --- | --- |
| Con el flag ausente/false, el composer no instancia la superficie | `rigel-v2-native-cli.mjs:54` (`...(sidebarEnabled ? [...] : [])`) | OK |
| Con el flag OFF: sin slot, sin recibo, sin log, sin suscripciones del sidebar | el `setup` de la superficie no corre; el `setReceipt`/`subscribe` viven dentro de `createSidebarCliSurface().setup` | OK (side effects nulos) |
| La superficie no tiene temporizadores | `grep setInterval\|setTimeout\|setImmediate\|heartbeat\|debounce\|unref` en `...sidebar.mjs` y `...sidebar-core.mjs`: **NONE** | OK |
| El render por defecto devuelve texto plano (causa del crash con flag ON) | `...sidebar.mjs:331-334` `return describeView(view)`; `describeView` es string (`...core.mjs:536-538`) | OK |

## 3. Matriz de aislamiento / rollback (gate B)

Leyenda: **OK** = verificado y suficiente; **PARCIAL** = existe pero incompleto; **GAP** = no cubierto.

| Eje del gate B | Estado | Evidencia |
| --- | --- | --- |
| Arquitectura aditiva | OK | Fases P0..P4 no activan por defecto; composer OFF por defecto (`cli.mjs:48,54`) |
| Dueño unico de la superficie | OK | Solo `rigel-v2-native-cli-sidebar.mjs` registra `sidebar.content` |
| Un solo registro del paquete CLI | OK | `registerCompanionCliPlugin` deduplica por `familyRoot`; `statusOf` chequea `cli.singleRigelEntry` |
| Flag OFF preserva baseline *conductual* | OK | Con flag OFF la superficie no se compone: cero slot/recibo/log/suscripcion |
| Flag OFF preserva baseline *byte-identico* | PARCIAL | P0 edita ledger/tests/seam y P1 edita la superficie; "byte-identico" solo puede significar el modelo de comportamiento, no el arbol (B-08) |
| Comando de opt-in (dev/canario) | **GAP** | No hay ruta config -> `context.options.tui` (B-01) |
| Comando de desactivacion suficiente | **GAP** | Idem; con P5 default-ON, `enabled:false` tampoco llega sin cableado (B-01) |
| default-ON solo en P5 tras A+B+C | PARCIAL | Estructuralmente OK; P5 no describe el cableado del opt-out (B-01) |
| Version/capability gate fail-closed | **GAP** | §6.2 lo enuncia; no hay fase que lo implemente; el composer no consulta `ui.slot` (B-02) |
| Empaquetado/flat install y peers | PARCIAL | Sin resolver como obtiene el materializador sus primitivas; patch del stash usa `dependency` no `peerDependency` (B-04) |
| Lifecycle attach/detach/dispose sin leaks | OK (con reserva) | `subscribe` guarda los `off` en `disposers`; `slot()` guarda el disposer; sin timers |
| Concurrencia y doble setup idempotentes | **GAP** | `setup` no es idempotente ante doble invocacion (B-07) |
| Datos vivos tolerantes, sin acceso a V1 | OK (con reserva) | Lectores con try/catch; no toca raices V1; reserva: XDG_STATE_HOME ausente cae al home real (B-13) |
| Seam hermetico separado del lab y del visual | OK | §6.4 P3/§7C distinguen recibo/slot/log (seam) de pixeles (visual) y explican por que el lab no carga `./tui` |
| Fases/commits atomicos | PARCIAL | P0/P2/P3 mezclan concerns (B-03) |
| Inventarios/hashes pre/post | OK | §6.9 exacto |
| Rollback ensayable por fase | PARCIAL | `git revert` no cubre artefactos desplegados (B-06) |
| No tocar delegacion/routing/prompts/agentes/permisos/continuidad | OK | §6.1/§6.2; ningun modulo del sidebar importa esos subsistemas |
| No tocar seleccion de modelo / sidebar no es gate | PARCIAL | Lectura de overrides es display-only, pero P2 mezcla ese territorio con roster (B-03) |
| Aislamiento V1 / sin Docker / sin NLS1 | OK | Ninguna ruta del sidebar o del seam toca V1; seam sin procesos y XDG a sandbox |

## 4. Hallazgos (clasificados, con correccion exigida)

### B-01 - ALTA - El feature flag `tui.sidebar.enabled` no esta cableado a ninguna configuracion

- **Hecho:** el unico escritor del `options` del paquete CLI es `registerCompanionCliPlugin`, que construye
  `{ package: runtimeDir, options: { notification: options } }` (`notification-activation-config.mjs:207`).
  El laboratorio (`rigel-v2-runtime-materialize.mjs:139-147`) y el instalador de usuario
  (`rigel-v2-user-install.mjs:431-439`) usan ese helper y **reconstruyen** el entry, descartando cualquier
  clave `tui`. Ninguna plantilla (`omo.jsonc`, `opencode/opencode.json`) define `tui`. El entry del runtime en
  `opencode.json` es un string sin options. El unico punto que setea `options.tui.sidebar` es el seam de QA
  (negativo) y los unit tests.
- **Impacto:** el "modo opt-in (encender en dev/canario)" y el "comando exacto de desactivacion" del plan
  **no son ejecutables**; la fase P5 ("restaurar ON salvo false" del contrato del padre y del catalogo de la
  boveda: *`tui.sidebar.enabled: false` la oculta*) no puede completarse, porque `false` nunca llega a
  `context.options`. Un canario P3 verde seria **falso verde**: probaria una configuracion que el host real no
  produce.
- **Correccion exigida:** el plan debe (a) declarar explicitamente que hoy la unica via de componer el sidebar
  es inyectar `options` en el objeto `context` (seam/tests), y (b) incluir en el alcance (P0 de reconciliacion
  y/o P5) el **cableado del flag**: resolver `tui.sidebar` desde el perfil `[opencode]` y hacerlo fluir al
  `options` del entry CLI (`registerCompanionCliPlugin` / `resolveRuntimeNotificationOptions`), de forma
  idempotente y preservada en refresh/reinstall. Sin esto, ni el opt-in ni el opt-out son suficientes.

### B-02 - ALTA - Gate de capacidad/version "fail-closed" sin fase que lo implemente

- **Hecho:** §6.2 promete "componer la superficie solo si el contexto ofrece `ui.slot` (funcion) y un
  `renderer` vivo; degradar a no-op logueado si falta la capacidad". El compositor actual (`cli.mjs:48,54`)
  decide solo por el flag y **no** consulta `ui.slot` ni renderer; la superficie aislada
  (`...sidebar.mjs:77-81`) devuelve `{ enabled: true }` cuando no hay `options`, es decir **no** es
  fail-closed por si sola. El plan tampoco asigna la implementacion de ese gate a P1/P2/P3.
- **Impacto:** el requisito del contrato ("compatibilidad/version/capability gates fail-closed") queda
  enunciado pero no planificado; ademas hay tension entre §6.2 ("no-op si falta capacidad") y §6.6/§6.7
  ("renderer destruido -> recibo headless"), que particionan de forma distinta (renderer ausente vs
  destruido vs `ui.slot` ausente).
- **Correccion exigida:** fijar una **matriz de capacidad unica** (renderer presente y vivo, renderer ausente,
  renderer destruido, `ui.slot` presente, `ui.slot` ausente) -> efecto esperado (slot+recibo, solo recibo,
  no-op logueado), asignarla a una fase concreta y exigir que la superficie sola tambien sea fail-closed
  (`ui.slot` no-funcion -> no registrar, no lanzar).

### B-03 - MEDIA - Fases no atomicas y P2 mezcla runtime/roster/overrides de modelo

- **Hecho:** P0 junta en un commit ledger+catalogo + reparacion del seam + pruebas negativas flat-install +
  documentar desactivacion (`test(profiles): reconcile sidebar ledger...`). P2 junta `readSessions`
  (runtime), roster (modelos) y "overrides vivos de modelo" (`state.config.agent[].model`). P3 junta el
  canario del seam con el **gate T** (que puede anadir un refresco periodico, cambio de runtime).
- **Impacto:** el contrato pide explicitamente detectar si "alguna fase mezcla runtime/roster/modelos"; P2 lo
  hace, y toca territorio de **seleccion de modelo**, que el gate B declara intocable. La falta de atomicidad
  impide revertir por partes (el motivo declarado del revert en bloque `6a46ed3ef`).
- **Correccion exigida:** partir P0 en commits atomicos (docs de ledger/catalogo; reparacion del seam;
  guardas negativas flat-install; comando de desactivacion). Partir P2 en (a) sesiones vivas, (b) roster, (c)
  overrides de modelo **solo-lectura para display**, con prueba explicita de que (c) no altera la seleccion de
  modelo. Partir P3 en (a) canario del seam y (b) gate T / refresco explicito (y solo entonces el timer, si
  de verdad hace falta).

### B-04 - MEDIA - Renderer/JSX y peers sin resolver; el patch del stash usa la forma equivocada

- **Hecho:** P1 propone "reintroducir el materializador como modulo puro" y §6.3 dice "usar `@opentui/solid`
  del host o JSX", pero no fija **como** obtiene el arbol de nodos. El candidato del stash anade `solid-js`
  como **dependency** (`package.json +1/-0`). La doc oficial exige que, al renderizar JSX, `@opentui/core`,
  `@opentui/solid` y `solid-js` sean **peerDependencies** del host, no dependencias empaquetadas.
- **Impacto:** riesgo de reincidir la clase de fallo del crash (renderer) por empaquetado/peer incorrecto:
  importar un motor distinto al del host, o depender del `node_modules` del repo (que el flat install no
  tiene).
- **Correccion exigida:** decidir y documentar la procedencia exacta de las primitivas de nodo (fabrica del
  host via `context.renderer` vs `@opentui/solid`), declarar los peers correctos (no `dependency`) y cubrirlo
  con la prueba de flat-install **con el flag ON** (una vez resuelto B-01).

### B-05 - MEDIA - P2 usa `context.state`, que no esta en la API documentada

- **Hecho:** §2.4 P2 y §6.3 proponen leer overrides vivos por `state.config.agent[].model` (del candidato). La
  documentacion oficial del CLI plugin **no expone `context.state`**; la superficie documentada es
  `context.data.location.agent/model.list(location)` y `context.ui.model.current()`.
- **Impacto:** contradice la regla del propio proyecto y del `rigel-session-start` ("la doc precede a
  inferencias"). La lectura de un `context.state` no documentado es un riesgo de compatibilidad (puede no
  existir en el host V2 real).
- **Correccion exigida:** sustituir `context.state.config.agent[].model` por las rutas **documentadas**
  (`context.data.location.agent.list(location)` / `model.list(location)` y, si aplica, `ui.model.current()`),
  o marcar la lectura como best-effort tolerante y probar el comportamiento ante su ausencia.

### B-06 - MEDIA - Rollback por fase incompleto (no cubre artefactos desplegados)

- **Hecho:** §6.8 define rollback por `git revert <commit>`. Pero el sidebar compuesto depende de artefactos
  **fuera de git**: el runtime materializado (`versions/<v>/runtime`), `cli.json` y el launcher
  (`materialize-v2-cli.mjs`, `rigel-v2-runtime-materialize.mjs`, `rigel-v2-user-install.mjs`). Un `git
  revert` no restaura esos artefactos.
- **Impacto:** un rollback podria dejar el runtime desplegado con modulos nuevos y `cli.json` desincronizado
  del arbol revertido.
- **Correccion exigida:** extender el drill de rollback por fase a la **rematerializacion** (relanzar
  `apply-v2-runtime-service.sh --refresh` / reinstalar) y verificar con `rigel-v2-user-install.mjs status`
  (`cli.singleRigelEntry`, `cli.runtimeMatchesConfig`, `runtime.digestMatches`) que el estado desplegado
  vuelve al baseline.

### B-07 - MEDIA - Doble setup / doble registro no cubierto

- **Hecho:** el contrato del gate B exige "concurrencia y doble setup idempotentes". El `setup` del compositor
  (`cli.mjs:43-76`) no tiene guarda de reentrada: una segunda invocacion vuelve a suscribir los 6 eventos y a
  registrar el slot. §6.7 solo menciona "registrar y disponer N veces sin acumular" (secuencial), no setup
  doble ni concurrencia.
- **Impacto:** si el host recompone (reload), podria duplicar listeners/slot.
- **Correccion exigida:** anadir al plan una prueba (y, si procede, una guarda) de setup doble/concurrente
  idempotente, con contador de suscripciones y de slots, y demostrar que el disposer deja el estado limpio.

### B-08 - BAJA - "Byte-identico" y "conductualmente identico" conflados

- **Hecho:** §6.1/§6.8 usan "baseline byte-identico con el flag apagado", pero P0 edita ledger/tests/seam y
  P1 edita la superficie; los hashes de §6.9 son del **codigo**, no del comportamiento.
- **Correccion exigida:** definir el invariante con precision: con el flag ausente/false, el **conjunto de
  superficies compuestas, slots registrados, recibos, logs y salida de render** es identico a HEAD; los
  hashes son de control de deriva del codigo, no prueba de equivalencia conductual.

### B-09 - BAJA - "o marcarlo explicitamente como stale" es una salida no-op

- **Hecho:** P0 ofrece "Reparar `qa-v2-t25-live-surfaces.mjs` (o marcarlo explicitamente como stale)". El seam
  es el **unico** observador designado del recibo/slot/log (§6.4 P3, §7C). Marcarlo stale como alternativa
  dejaria el canario sin observador.
- **Correccion exigida:** exigir la **reparacion** del seam (positive con opt-in) como requisito, sin la
  alternativa "stale"; el marcado stale solo vale como anotacion adicional.

### B-10 - BAJA - Orden de las auditorias ambiguo (riesgo de documentacion prematura)

- **Hecho:** §0 y §7 dicen que el plan "requiere las tres auditorias"; §6.4 P4 lista "las tres auditorias"
  otra vez tras la implementacion. No queda claro si A+B+C auditan el plan (antes de P0) o la implementacion
  (P4). P0 edita ledger/catalogo y P5 depende de A+B+C.
- **Correccion exigida:** fijar el orden: A+B+C auditan el **plan** y son **prerequisito de arranque** de P0;
  P4/P5 requieren ademas re-auditoria y gates reales. Asi P0 no es "documentacion prematura".

### B-11 - BAJA - Comando de desactivacion documentado antes de probar el cableado

- **Hecho:** §6.9 documenta el comando de desactivacion ("dejar `tui.sidebar.enabled` ausente o `false`")
  antes de que exista el cableado (B-01). Con el flag sin cablear, el comando es vacuamente cierto con `flag
  OFF` y no ejecutable con `flag ON`.
- **Correccion exigida:** condicionar la documentacion del comando a la resolucion de B-01 y probarlo
  end-to-end (activar, verificar slot; desactivar, verificar ausencia).

### B-12 - INFO - Fila 26 cita una conducta V1 sin equivalente directo

- **Hecho:** la fila 26 de §6.10 dice "No interactivo: sin TUI, el servidor **si** escribe el espejo
  (`qa/register-and-run.sh`)". En V2 el espejo lo escribe el **companion CLI** (la superficie), no el
  servidor; `opencode serve` no carga `./tui`. El plan lo reconoce en §6.6/A2-01, pero la fila conserva la
  formulacion V1.
- **Correccion exigida:** reformular la fila 26 como "el recibo lo escribe el companion CLI en su `setup()`;
  el servidor V2 no participa" para no dar a entender que hay un equivalente servidor.

### B-13 - INFO - Fallback de `XDG_STATE_HOME` al home real

- **Hecho:** `resolveStateRoot` (`...sidebar.mjs:83-86`) cae a `homedir()/.local/state` si `XDG_STATE_HOME`
  esta ausente. Con el flag OFF es inerte; con el flag ON (dev), un host sin XDG escribiria el recibo bajo el
  home real (no es una raiz V1 protegida, pero si el home real).
- **Correccion exigida:** exigir XDG_STATE_HOME explicito en cualquier ruta de opt-in y anotarlo en el
  contrato del seam.

## 5. Correcciones exigidas (resumen accionable)

| ID | Severidad | Correccion exigida (bloqueante de PASS) |
| --- | --- | --- |
| B-01 | ALTA | Cablear `tui.sidebar` desde config/perfil al `options` del entry CLI (idempotente y preservado en refresh/reinstall); declarar que hoy solo el seam/tests lo setean. |
| B-02 | ALTA | Fijar y asignar la matriz unica de capacidad/version fail-closed; hacer fail-closed a la superficie aislada. |
| B-03 | MEDIA | Partir P0/P2/P3 en commits atomicos; aislar overrides de modelo (display-only) y probar que no gated la seleccion. |
| B-04 | MEDIA | Definir procedencia del arbol de nodos y declarar peers correctos (`@opentui/core`, `@opentui/solid`, `solid-js`), con flat-install con flag ON. |
| B-05 | MEDIA | Sustituir `context.state` por las rutas documentadas (`context.data.location.agent/model.list`, `ui.model.current()`). |
| B-06 | MEDIA | Extender el rollback por fase a la rematerializacion del runtime + `cli.json`; verificar con `rigel-v2-user-install.mjs status`. |
| B-07 | MEDIA | Anadir prueba (y guarda si procede) de doble setup/concurrencia idempotente. |
| B-08 | BAJA | Definir el invariante "byte-identico" como conductual; hashes son de deriva de codigo. |
| B-09 | BAJA | Exigir la reparacion del seam (no la alternativa "stale"). |
| B-10 | BAJA | Fijar el orden de auditorias (A+B+C prerequisito de P0; re-auditoria en P4/P5). |
| B-11 | BAJA | Documentar el comando de desactivacion solo tras B-01 y probarlo end-to-end. |
| B-12 | INFO | Reformular la fila 26 (recibo por el companion CLI, no el servidor). |
| B-13 | INFO | Exigir `XDG_STATE_HOME` explicito en el opt-in. |

## 6. Lo verificado como correcto (no requiere correccion)

- Dueño unico y un solo registro: un compositor (`rigel-v2-native-cli.mjs`), una superficie registradora de
  `sidebar.content`, una entrada de familia en `cli.json` (`registerCompanionCliPlugin`) con guardas de
  estado (`cli.singleRigelEntry` en `rigel-v2-user-install.mjs statusOf`).
- Con flag OFF: **cero** side effects del sidebar (sin slot, recibo, log ni suscripciones); sin temporizadores
  en superficie ni core.
- Historial, revert, stash y hashes de baseline: exactos.
- Aislamiento: el sidebar y el seam no tocan V1; el seam no lanza procesos; XDG al sandbox; sin Docker/NLS1.
- La causa del crash declarada (texto plano a `sidebar.content`) concuerda con el codigo (`describeView` como
  `render` por defecto) y con la doc oficial (el `render` debe devolver JSX).
- El sidebar es de solo lectura respecto a modelos y datos; no es gate de modelos.

## 7. Limites y lo no verificado

- No se ejecuto ningun gate (T, suite, flat install, mutaciones) porque el contrato prohibe implementacion y
  el plan es DRAFT; esta auditoria es de **diseño y de fuentes**, no de ejecucion de runtime.
- No se reprodujo el crash ni el revert; se auditaron por lectura de codigo e historial, suficiente para la
  causa declarada y para los hallazgos de cableado/atomicidad.
- El seam visual (pixeles) queda fuera de alcance por diseño y se marca **no observado**.
- No se edito la boveda; solo se leyo y se contrastaron las lineas citadas.
- No se aplico el stash; no se lanzo `opencode`.

## 8. Conclusion

El diseno del plan es el correcto y **no** amerita REJECT: es aditivo, con dueño unico, flag-gated, por fases
y con hashes/rollback. Pero **no** puede pasar el gate B tal como esta escrito, porque el feature flag **no
esta cableado** a ninguna configuracion real (B-01), el gate de capacidad fail-closed **no** esta implementado
ni asignado (B-02), y P0/P2/P3 rompen atomicidad, P2 usa una API no documentada y el rollback ignora los
artefactos desplegados (B-03..B-06). Mientras B-01 y B-02 sigan abiertos, ni el canario ni la fase de release
P5 pueden probar la paridad.

**Veredicto: NEEDS_CORRECTION.**

Esta auditoria **no se autoaprueba** como autoridad final: es una revision B independiente. La aprobacion de
release (P5) sigue requiriendo las revisiones independientes A + B + C y gates reales, segun §6.4.

## 9. Limites de acceso y estado del repositorio

- `git status`: sin cambios en codigo rastreado; los unicos untracked son los documentos de auditoria/handoff
  (`AUDIT-A*`, `HANDOFF-SIDEBAR-RESEARCH.md`) y este `AUDIT-B-SIDEBAR-ARCHITECTURE.md`.
- Sin commit / push / PR. Sin procesos OpenCode lanzados. Sin Docker. V1 / NLS1 / produccion / secretos
  intactos.
- Boveda leida en solo-lectura; no editada; sin copiar secretos. Plan y handoff **no** editados. Stash **no**
  aplicado.
- Unico proceso permitido si se autoriza canario: `opencode-v2-lab.service` via `apply-v2-runtime-service.sh`
  (no usado en esta auditoria).

---

**Firma independiente:** Auditor B (independiente) - revision de arquitectura, aislamiento y rollback del plan
de paridad del sidebar V2. Ejecutada de forma directa, sin delegacion ni orquestacion, contra fuentes
primarias (codigo, historial git, scripts de instalacion/lab, ledger, boveda en solo-lectura y documentacion
oficial OpenCode V2). No confio en las conclusiones de A ni A2 ni A3. Veredicto: **NEEDS_CORRECTION**.
