# AUDIT-B2-SIDEBAR-ARCHITECTURE - Repeticion desde cero de la Auditoria B (arquitectura, aislamiento, rollback)

> **DRAFT / NO IMPLEMENTAR.** Auditoria de solo lectura. No se edito el plan, ni el handoff, ni codigo productivo,
> ni tests, ni la boveda, ni el stash. No hubo commit / push / PR. No se lanzo ningun proceso OpenCode. No se uso
> Docker. No se toco V1, NLS1, produccion ni secretos. No se delego a sub-agentes ni se uso orquestacion: la
> verificacion se hizo directamente contra fuentes primarias (codigo, historial git, scripts de instalacion/lab,
> ledger y configuracion del perfil).

## 0. Alcance, metodo e independencia

- **Objetivo auditado:** `.omo/drafts/v2-sidebar-parity-reversible-plan.md` (865 lineas) y
  `HANDOFF-SIDEBAR-RESEARCH.md` (246 lineas), en el worktree
  `/home/gabodev/oh-my-rigel-worktrees/research-v2-sidebar-parity-plan`, rama `research/v2-sidebar-parity-plan`,
  baseline `404a629`.
- **Naturaleza:** repeticion **desde cero** de la Auditoria B (no una continuacion ni una autoaprobacion). Esta ronda
  **no** adopta el veredicto de `AUDIT-B-SIDEBAR-ARCHITECTURE.md` ni confia en sus tablas; re-verifica el gate B
  (arquitectura/aislamiento/rollback) y la resolucion de B-01..B-13 contra fuentes primarias. Tampoco confia en
  `AUDIT-A3-SIDEBAR-FIDELITY.md` (que emitio PASS): A y B son gates independientes.
- **Fuentes primarias releidas:** `profiles/gabo/**` (compositor CLI, superficie sidebar, escritor de `options`,
  materializadores, instalador de usuario, helper del lab, config del perfil, ledger, seam de QA), `git`
  (`rev-parse`, `show --stat`, `stash show --numstat`, `cat-file -e`, `sha256sum`) y el padre
  (`packages/omo-opencode/src/tui.ts`, `config/schema/tui.ts`, `config/schema/oh-my-opencode-config.ts`).
- **Baseline verificado:** `HEAD = 404a6290134d1704bb44eff7c092c161770f49e2`; `stash@{0}` presente; `git status` del
  arbol rastreado limpio; los unicos untracked son los documentos de auditoria/handoff.

## 1. Veredicto

**PASS.**

El plan corregido protege el baseline V2 con el flag OFF, cablea el feature flag por una ruta real y unica hasta
`context.options`, hace fail-closed el gate de capacidad/version asignandolo a una fase, parte las fases en commits
atomicos sin mezclar runtime/roster/modelos, sustituye la API no documentada `context.state`, declara los peers como
`peerDependencies`, extiende el rollback a los artefactos desplegados con verificacion por `status` real, exige
setup doble idempotente, reformula el baseline como conductual, repara el seam, fija el orden de auditorias, condiciona
el comando de desactivacion al cableado, reformula la fila 26 y exige `XDG_STATE_HOME` explicito.

**Los 13 hallazgos B-01..B-13 quedan resueltos (PASS)**, con tres observaciones nuevas de severidad **MINOR/INFO**
(ninguna BLOCKER ni MAJOR). El gate de aislamiento (V1 intacta, sin Docker, sin NLS1, sin delegacion ni orquestacion)
se sostiene. En consecuencia el plan **puede pasar a Auditoria C sin implementar**.

Las tres observaciones nuevas no bloquean porque: (1) no introducen reduccion de contrato, (2) no dejan un gate
inejecutable, (3) no hay falsedad material en el plan, y (4) el unico punto diferido (procedencia de las primitivas de
nodo) esta fijado en su parte consecuente (peers + flat-install con flag ON + "el slot nunca recibe texto") y asignado
a un commit concreto.

## 2. Evidencia primaria verificada (reproducible)

Cada fila es lo que devolvio la fuente primaria, no lo que afirma el plan. Comandos ejecutados desde la raiz del
worktree.

### 2.1 Historial, hashes y stash

| Afirmacion del plan | Fuente | Observado | Veredicto |
| --- | --- | --- | --- |
| `HEAD = 404a62901` (Merge PR #19) | `git rev-parse HEAD` | `404a6290134d1704bb44eff7c092c161770f49e2` | OK |
| Revert `6a46ed3ef` = 24 archivos, `+85/-1779` | `git show --stat 6a46ed3ef` | `24 files changed, 85 insertions(+), 1779 deletions(-)` | OK (exacto) |
| Creados y luego borrados (ausentes en HEAD): `rigel-v2-sidebar-node.mjs`, `rigel-v2-sidebar-theme.mjs`, `v2-agent-selection-core.mjs` | `git cat-file -e HEAD:<ruta>` | Los tres **ABSENT** en HEAD | OK |
| `stash@{0}` = 8 archivos con numstat exacto | `git stash show --numstat stash@{0}` | 8 lineas; `cli-sidebar.mjs 147/38`; `...test.mjs 113/5`; `sidebar-node.mjs 4/1`; `agents.test.mjs 52/0`; `runtime.test.mjs 72/1`; `test-env.ts 6/0`; `package.json 1/0`; `bun.lock 1/0` | OK (exacto) |
| Hashes de baseline (§6.9) | `sha256sum` de los 5 archivos | Coinciden byte a byte (`a15f4ea2...`, `20d8a659...`, `10785b83...`, `3b3197c8...`, `e96566ea...`) | OK |

### 2.2 Cableado del feature flag (nucleo de B-01) - ruta real verificada

| Hecho verificado | Fuente observada | Veredicto |
| --- | --- | --- |
| `resolveProfileOpenCodeBlock()` en `notification-activation-config.mjs:92-103` | L92-103 exacto | OK |
| Escritor unico del `options` del entry CLI: `registerCompanionCliPlugin()` L204-225, entry L207 = `{ package: runtimeDir, options: { notification: options } }` | L207 **sin `tui`** | OK (confirma B-01) |
| `resolveRuntimeNotificationOptions()` en `rigel-v2-runtime-materialize.mjs:71-81` | L71-81 exacto | OK |
| `materializeNativeRuntime()` escribe `cli.json` por `registerCompanionCliPlugin` | `rigel-v2-runtime-materialize.mjs:138-147` | OK |
| 2 escritores de `cli.json`, ambos via el mismo helper | lab: `switch-live-plugin-to-native-v2.mjs:33` -> `materializeNativeRuntime`; usuario: `rigel-v2-user-install.mjs:282` (install) y `:433` (rollback/migrate). Sin tercer escritor | OK (ruta unica) |
| Ambos escritores reciben `profileFile` | `switch-live-plugin-to-native-v2.mjs:40`; `rigel-v2-user-install.mjs:289` | OK |
| Helper nuevo debe copiarse al lab: lista en `materialize-v2-cli.mjs:115-118` (hoy solo `notification-activation-config.mjs`) | L115-118 exacto | OK |
| Fuente de config disponible: `omo.jsonc` tiene `profiles.gabo["[opencode]"]` con bloque `notification` (`omo.jsonc:5,27`); sin `tui` | Confirmado | OK |
| Compositor consume `context?.options?.tui?.sidebar?.enabled === true` | `rigel-v2-native-cli.mjs:48,54` | OK |
| `uninstall` limpia por `removeRigelCliEntries` | `rigel-v2-user-install.mjs:217` | OK |

Conclusion: la ruta `omo.jsonc ([opencode]) -> resolveRuntimeSidebarOptions -> registerCompanionCliPlugin (emite options.tui.sidebar) -> cli.json -> context.options -> compositor` es **materializable en los dos caminos de despliegue existentes**, sin un segundo escritor. La correccion B-01 esta fundada.

### 2.3 Rollback (nucleo de B-06) - campos reales verificados

| Hecho verificado | Fuente observada | Veredicto |
| --- | --- | --- |
| `statusOf()` existe y emite las comprobaciones citadas | `rigel-v2-user-install.mjs:315` | OK |
| `config.singleRigelEntry` | L328 | OK |
| `cli.singleRigelEntry` | L340 | OK |
| `cli.runtimeMatchesConfig` | L341 | OK |
| `runtime.digestMatches` | L345 | OK |
| Subcomando `status` real | uso en L16; dispatch `command === "status"` L497 | OK |

### 2.4 Superficie, gate y ausencia de side effects con flag OFF

| Hecho verificado | Fuente observada | Veredicto |
| --- | --- | --- |
| Un solo registrador de `sidebar.content` | `rigel-v2-native-cli-sidebar.mjs:53,356` | OK |
| Compositor exige `=== true` (OFF por defecto) | `rigel-v2-native-cli.mjs:48,54` | OK |
| Superficie `resolveSidebarGate` es fail-OPEN sin options (`{ enabled: true }`) | `rigel-v2-native-cli-sidebar.mjs:77-81` | OK (lo que P1.1 corrige) |
| Con flag OFF: sin slot, sin recibo, sin log, sin suscripciones | la superficie no se compone; `setReceipt`/`subscribe` viven dentro de su `setup` | OK |
| Sin temporizadores en superficie ni core | `grep setInterval\|setTimeout\|heartbeat\|debounce` = NONE | OK |
| El plugin de servidor no toca UI/slot/renderer | `rigel-v2-native.mjs` limpio | OK |
| Fallback `ui.slots.register` en btw | `rigel-v2-native-cli-btw.mjs:247` | OK |
| La superficie importa **solo** el core puro + modulos Node (`fs`/`path`/`os`) | `rigel-v2-native-cli-sidebar.mjs:31-48` | OK (sin delegacion/orquestacion) |

### 2.5 Ledger, padre y seam

| Afirmacion del plan | Fuente observada | Veredicto |
| --- | --- | --- |
| Fila `tui-sidebar` dice "ausente = encendida" | `V2_MIGRATION_INVENTORY.md:166` | OK |
| Clasificacion duplicada en `features.mjs:186-187` | L184-188 con `status: "Migrado"` y rationale idem | OK |
| Padre: ON salvo `false` (`z.boolean().default(true)`) | `config/schema/tui.ts:3-5`; `oh-my-opencode-config.ts:99` (`TuiConfigSchema.default({sidebar:{enabled:true}})`); `tui.ts:145` (`enabled === false -> return`) | OK |
| Seam: contexto CLI real en `qa-v2-t25-live-surfaces.mjs:171-186`, `setup()` en `:211`, slot en `:246-247`, recibo en `:248-249`, negativo `enabled:false` en `:269`, sandbox XDG en `:43-52` | Observado: `options: {}` L172; `renderer` L173; `slot` L182; `createCompanionCliPlugin` L188; `sidebar` override L203; `setup` L211; `enabled: false` L269; `mkdtempSync` L43; `XDG_STATE_HOME` L50 | OK |
| Seam stale: exige el slot con `options: {}` | Con el gate `=== true` el slot no se registra -> la asercion L247 falla | OK (confirma B-09) |

## 3. Verificacion de los gates obligatorios

| Gate | Resultado | Evidencia |
| --- | --- | --- |
| Cableado real y documentado del flag hasta `context.options` | PASS | §2.2: ruta unica materializable; un solo escritor; ambos despliegues reciben `profileFile` |
| Capability/version gate fail-closed | PASS | §6.2 matriz unica; asignada a P1.1; superficie tambien fail-closed; "sin options/capacidad -> OFF" |
| Fases atomicas y separacion absoluta de runtime/roster/modelos/delegacion/orquestacion | PASS | P0.1..P0.5, P1.1..P1.3, P2.1..P2.3, P3.1..P3.2; P2 separa sesiones/roster/overrides; sidebar sin imports de delegacion/orquestacion |
| APIs reales documentadas y ausencia de `context.state` inventado | PASS | §6.3 prohibe `context.state`; objetivos `context.data.session/location` y `ui.model.current()`; HEAD ya usa `data.*` |
| Estrategia JSX compatible con peers y flat install | PASS (con nota) | Peers `@opentui/core`/`@opentui/solid`/`solid-js` como `peerDependencies`; flat-install con flag ON; ver INF-2 |
| Setup idempotente y seguro ante doble registro | PASS | P1.3: guarda de reentrada + prueba doble/concurrente con contadores |
| Rollback que restaura tambien artefactos desplegados | PASS | §6.8 rematerializa + verifica `status`; campos reales en §2.3 |
| `XDG_STATE_HOME` explicito | PASS | §2.7, §6.6, §6.7; `resolveStateRoot` cae al home real sin la variable |
| Baseline conductualmente identico con flag OFF | PASS | §6.1 define inventario exacto (superficies/slots/recibos/logs/render); hashes = deriva de codigo |
| Flag OFF durante desarrollo/canario | PASS | §2.5, §6.2, P0.4; default-ON solo P5 |
| Ningun big-bang | PASS | Fases y commits atomicos revertibles; ningun commit P0..P4 cambia el default |
| Ninguna dependencia del sidebar como gate de modelos | PASS | §6.3 P2.3 read-only + prueba de no-gating; superficie no escribe seleccion |
| Matriz conducta a prueba completa | PASS | §6.10 tiene exactamente 27 filas (conteo programatico) |
| Resolucion verificable de B-01..B-13 | PASS | Ver §4 |

## 4. Resolucion de B-01..B-13

| ID | Sev. | Correccion exigida | Resolucion en el plan corregido | Evidencia | Veredicto |
| --- | --- | --- | --- | --- | --- |
| B-01 | ALTA | Cablear `tui.sidebar` de config al `options` del entry CLI; declarar que hoy solo seam/tests lo setean | §2.7 ruta unica por tabla de 7 pasos; P0.4; §6.9 | §2.2: ruta materializable, un escritor, ambos despliegues con `profileFile` | PASS |
| B-02 | ALTA | Matriz unica de capacidad fail-closed asignada a fase; superficie fail-closed | §6.2 matriz de 4 filas; P1.1 la implementa en el compositor antes de instanciar; superficie fail-closed | §6.2 + §6.7 (cubrir todas las filas; sin options/capacidad -> OFF) | PASS |
| B-03 | MEDIA | Partir P0/P2/P3; aislar overrides (display-only) y probar no-gating | P0.1..P0.5; P2.1 sesiones / P2.2 roster / P2.3 overrides; P3.1 canario / P3.2 gate T | §6.4 lista cada commit; P2.3 exige prueba de no alterar la seleccion | PASS |
| B-04 | MEDIA | Fijar procedencia de nodos; peers correctos; flat-install con flag ON | §6.3/P1.2: peers `@opentui/core`/`@opentui/solid`/`solid-js` como `peerDependencies`; "el slot nunca recibe texto"; flat-install flag ON | §6.3, §6.4 P1.2, §6.7; ver INF-2 (fábrica diferida a P1.2) | PASS |
| B-05 | MEDIA | Sustituir `context.state` por rutas documentadas | §0, §2.4, §6.3, P2.3: `context.data.location.agent/model.list` y `ui.model.current()`; `context.state` prohibido | grep: `context.state` solo aparece como prohibido | PASS |
| B-06 | MEDIA | Extender rollback a artefactos desplegados + `cli.json`; verificar con `status` | §6.8 pasos 1-5; verifica `cli.singleRigelEntry`, `cli.runtimeMatchesConfig`, `runtime.digestMatches` | §2.3: campos reales en `rigel-v2-user-install.mjs:328,340,341,345` | PASS |
| B-07 | MEDIA | Prueba (y guarda) de setup doble/concurrente idempotente | P1.3 guarda + prueba con contadores y disposer limpio; §6.7 | §6.4 P1.3, §6.7 | PASS |
| B-08 | BAJA | Definir "byte-identico" como conductual | §6.1 define inventario exacto; §6.9 hashes = control de deriva; §6.8 go/no-go conductual | §6.1, §6.9 | PASS |
| B-09 | BAJA | Exigir reparacion del seam (sin "stale") | P0.2 repara el positive a opt-in y conserva el negativo; sin alternativa stale | §6.4 P0.2; §2.5/§2.7 | PASS |
| B-10 | BAJA | Fijar orden de auditorias | §6.4 nota + §7: A+B+C auditan el plan y son prerequisito de P0; P4/P5 re-auditoria | §6.4, §7 | PASS |
| B-11 | BAJA | Documentar desactivacion solo tras B-01 y probar e2e | §6.9 condiciona a P0.4 y prueba activar->slot+recibo / desactivar->ausencia; P0.5 | §6.4 P0.5, §6.9 | PASS |
| B-12 | INFO | Reformular fila 26 (recibo por companion CLI) | Fila 26 reformulada: el recibo lo escribe el companion CLI en `setup()`; el servidor V2 no participa | §6.10 fila 26 | PASS |
| B-13 | INFO | Exigir `XDG_STATE_HOME` explicito en opt-in | §2.7 restricciones, §6.6, §6.7 | §6.6 cita `resolveStateRoot` (`sidebar.mjs:83-86`) | PASS |

## 5. Hallazgos nuevos (clasificados)

Ninguno alcanza BLOCKER ni MAJOR; el veredicto PASS se mantiene.

| ID | Sev. | Hallazgo | Evidencia | Impacto | Recomendacion |
| --- | --- | --- | --- | --- | --- |
| B2-1 | MINOR | La matriz de capacidad §6.2, fila "renderer ausente", deja el recibo **condicional** ("o recibo headless solo si el diseno lo exige"), mientras la fila "renderer destruido" exige recibo headless. La particion es coherente pero el efecto de la fila "ausente" no queda cerrado. | §6.2 filas 3-4 vs `rigel-v2-native-cli-sidebar.mjs:366-367` (hoy escribe recibo headless) | Podria dejar una ambiguedad al implementar P1.1 y al asertar el seam | Cerrar la fila: decidir si "renderer ausente" tambien emite recibo headless (consistente con el codigo actual) o no; eliminar el "si el diseno lo exige" |
| B2-2 | MINOR | B-04 exige fijar la **procedencia** de las primitivas de nodo (fabrica `context.renderer` vs `@opentui/solid`); el plan la **difiere** a P1.2 en vez de decidirla, aunque fija lo consecuente (peers como `peerDependencies`, "el slot nunca recibe texto", flat-install con flag ON). | §6.3 / §6.4 P1.2 ("decidir y documentar si...") | El riesgo de reincidir el crash por empaquetado queda mitigado por los peers y el test flat-install ON, pero la decision sigue abierta | Fijar la procedencia en el propio plan (o justificar explicitamente por que P1.2 puede decidirla sin cambiar la estrategia de peers) |
| B2-3 | INFO | El plan no nombra literalmente "delegacion" ni "orquestacion" entre sus prohibiciones; el aislamiento es **estructural** (la superficie importa solo el core + Node; el compositor solo superficies) y el trabajo de modelos se mantiene en tareas paralelas separadas. | §6.1 (lista de prohibiciones) vs `rigel-v2-native-cli-sidebar.mjs:31-48`, `rigel-v2-native-cli.mjs:22-27` | Sin impacto material; solo trazabilidad del gate de aislamiento | Anadir "delegacion/orquestacion" a la lista de §6.1 para que el gate quede explicito |
| B2-4 | INFO | Precision de rutas: `notification-activation-config.mjs`, `rigel-v2-runtime-materialize.mjs`, `materialize-v2-cli.mjs`, `rigel-v2-user-install.mjs` y `switch-live-plugin-to-native-v2.mjs` viven en `profiles/gabo/` (no en `profiles/gabo/opencode/`); el plan los cita sin prefijo de ruta. Las numeraciones de linea verificadas son correctas. | §0 punto 5, §2.7 tabla, §1 | Ninguno; solo precision de cita | Opcional: usar la ruta completa en las citas |

## 6. Aislamiento, limites y lo no verificado

- **Ejecucion de esta auditoria:** verificacion directa, sin sub-agentes, sin team-mode, sin orquestacion. Solo
  comandos de lectura (`git` de consulta, `grep`, `sed`, `sha256sum`). No se lanzo ningun proceso OpenCode; no se uso
  Docker; no se toco V1 / NLS1 / produccion / secretos. La boveda no se leyo en esta ronda (no fue necesaria para el
  gate B; los artefactos de boveda citados se validaron indirectamente via el handoff y el ledger del repo).
- **Aislamiento en el plan:** §6.1 prohibe V1, NLS1, produccion, secretos, Docker, `run`/`serve`/`--standalone`
  directos, big-bang, autoaprobar y usar el sidebar como gate de modelos; §6.2 fija dueño unico; la unica via viva es
  `opencode-v2-lab.service` via `apply-v2-runtime-service.sh`; el seam hermetico no lanza procesos. Ver B2-3 (mencion
  explicita de delegacion/orquestacion recomendada, no obligatoria).
- **No verificado:** no se ejecuto ningun gate (T, suite, flat install, mutaciones, drill de rollback) porque el
  contrato prohibe implementacion y el plan es DRAFT; esta auditoria es de **diseño y de fuentes**, no de ejecucion de
  runtime. No se reprodujo el crash ni el revert (auditados por lectura de codigo e historial, suficiente para la causa
  declarada y para los hallazgos de cableado/atomicidad/rollback). El seam visual (pixeles) queda fuera de alcance por
  diseño y se marca no observado. No se aplico el stash.
- **Lo verificado como correcto (no requiere correccion):** dueño unico y un solo registro; cero side effects con flag
  OFF; ruta unica de cableado; campos reales de `status`; ledger/features/padre citados con exactitud; hashes y
  numstat exactos; sin temporizadores en la superficie; sin `context.state` como fuente.

## 7. Conclusion

El plan corregido resuelve de forma completa y verificable **B-01..B-13** contra fuentes primarias. Protege el baseline
V2 (flag OFF conductualmente identico, un solo escritor de `cli.json`, cero side effects con el flag apagado), cablea el
flag por una ruta real y unica, hace fail-closed el gate de capacidad con matriz unica asignada a P1, mantiene las fases
atomicas y la separacion de runtime/roster/modelos, elimina la API no documentada, declara los peers correctamente,
extiende el rollback a los artefactos desplegados, exige setup idempotente, repara el seam, fija el orden de auditorias
y exige `XDG_STATE_HOME` explicito. Las cuatro observaciones nuevas son MINOR/INFO y no bloquean. El aislamiento se
mantiene (V1 intacta, sin Docker, sin NLS1).

**Veredicto: PASS.**

El plan **puede pasar a Auditoria C sin implementar**. Esta auditoria **no se autoaprueba** como autoridad final: la
aprobacion de release (P5) sigue requiriendo las revisiones independientes A + B + C y gates reales, segun §6.4/§7.

## 8. Limites de acceso y estado del repositorio

- `git status`: sin cambios en codigo rastreado; los unicos untracked son los documentos de auditoria/handoff
  (`AUDIT-A-SIDEBAR-FIDELITY.md`, `AUDIT-A2-*`, `AUDIT-A3-*`, `AUDIT-B-*`, `HANDOFF-SIDEBAR-RESEARCH.md`) y este
  `AUDIT-B2-SIDEBAR-ARCHITECTURE.md`.
- Sin commit / push / PR. Sin procesos OpenCode lanzados. Sin Docker. V1 / NLS1 / produccion / secretos intactos.
- Plan y handoff **no** editados. Stash **no** aplicado. Boveda no editada.
- Unico proceso permitido si se autoriza canario: `opencode-v2-lab.service` via `apply-v2-runtime-service.sh` (no usado).

---

**Firma independiente:** Auditor B2 (independiente) - repeticion desde cero del gate de arquitectura, aislamiento y
rollback del plan de paridad del sidebar V2. Ejecutada de forma directa, sin delegacion ni orquestacion, contra fuentes
primarias (codigo, historial git, scripts de instalacion/lab, ledger y configuracion del perfil). No confio en los
veredictos de A3 ni de B. Veredicto: **PASS**.
