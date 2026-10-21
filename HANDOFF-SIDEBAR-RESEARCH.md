# HANDOFF-SIDEBAR-RESEARCH - Investigacion y plan de paridad del sidebar V2

> **DRAFT / NO IMPLEMENTAR.** Este handoff resume una investigacion **exclusivamente de lectura/analisis**. No se
> cambio codigo productivo, no se reactivo `ui.slot`, no hubo commit/push/PR. El plan detallado vive en
> [`.omo/drafts/v2-sidebar-parity-reversible-plan.md`](.omo/drafts/v2-sidebar-parity-reversible-plan.md).

---

## 1. Encargo y resultado

Contrato ejecutado: `sidebar-research-contract.md`. Objetivo: recuperar TODA la funcionalidad observable del sidebar
del padre (OmO) en OpenCode V2 **sin alterar el comportamiento hoy aceptado**, entregando evidencia y un plan reversible
para auditorias independientes.

Entregables producidos (ambos DRAFT / NO IMPLEMENTAR):

1. `.omo/drafts/v2-sidebar-parity-reversible-plan.md` - contrato conductual + maquina de estados + comparacion de
   mecanismos + causa del crash + plan aditivo/reversible + matriz + checklist de auditorias.
2. Este `HANDOFF-SIDEBAR-RESEARCH.md` - resumen de estado, evidencia y proximos pasos.

## 2. Baseline

- Worktree: `/home/gabodev/oh-my-rigel-worktrees/research-v2-sidebar-parity-plan`.
- Rama: `research/v2-sidebar-parity-plan`.
- HEAD: `404a6290134d1704bb44eff7c092c161770f49e2` (Merge PR #19).
- Arbol limpio. `stash@{0}` = `ddea0b7d85caf734a819dcad3aae99db9aa3abad` (candidato pre-rollback, no aplicado).

## 3. Hallazgos clave (evidencia)

1. **Mecanismo padre vs V2.** El padre registra `api.slots.register({ order: 900, slots: { sidebar_content } })` y
   materializa nodos `@opentui/solid` (`packages/omo-opencode/src/tui.ts:35-47,49-70`). V2 usa un **CLI plugin**
   `{ id, setup(context) }` que registra `context.ui.slot({ append: "sidebar.content", render })`
   (`profiles/gabo/opencode/rigel-v2-native-cli-sidebar.mjs:352-365`; doc oficial CLI plugins).
2. **Causa del crash de hoy.** El adaptador V2 entregaba **texto plano** al slot (`render` -> `describeView`).
   El host V2 espera nodo/JSX. El arreglo (materializar el arbol + adaptar tema) fue correcto en causa raiz, pero se
   entrego junto con cambios de runtime/roster y se **revirtio en bloque** (`6a46ed3ef`, +85/-1779, 24 archivos),
   y luego se apago por defecto (`a4aefc291`).
3. **Estado actual.** Sidebar **OFF en dev/canario**; sin `ui.slot` salvo opt-in explicito (`=== true`). Creados por
   `c92e0a5e` y **borrados** por el revert (ausentes en HEAD): `rigel-v2-sidebar-node.mjs` (+test),
   `rigel-v2-sidebar-theme.mjs` (+test), `v2-agent-selection-core.mjs` (+test). **Distinto** (correccion A-07):
   `notification-activation-config.mjs` y `notification-activation-config.test.mjs` **existen** en HEAD, fueron
   **modificados** por `2e84941b2` y **revertidos en contenido** por `6a46ed3ef` (no borrados). Nota: el archivo
   `rigel-v2-native-runtime.test.mjs` existe, pero `rigel-v2-native-runtime.mjs` nunca existio como modulo.
4. **Ledger y QA desactualizados (divergencia de tres capas).** `V2_MIGRATION_INVENTORY.md:166` y
   `migration-classifications/features.mjs:186-187` dicen "ausente = encendida"; el codigo de dev/canario esta OFF. El
   **contrato objetivo sigue siendo default-ON** (padre + catalogo de la boveda `Catalogo_Funciones_OMR_V2.md:170`); el
   OFF es solo dev/canario y su activacion es la fase de release P5 (resolucion A-01; ver plan seccion 2.5).
   `qa-v2-t25-live-surfaces.mjs` exige el slot con `options: {}` y hoy fallaria (staleness introducida por `a4aefc291`).
5. **Candidato util en stash.** `stash@{0}` toca **ocho archivos** (`git stash show --numstat`):
   `rigel-v2-native-cli-sidebar.mjs` **+147/-38**, `rigel-v2-native-cli-sidebar.test.mjs` **+113/-5**,
   `rigel-v2-sidebar-node.mjs` **+4/-1**, `rigel-v2-native-agents.test.mjs` **+52/-0**,
   `rigel-v2-native-runtime.test.mjs` **+72/-1**, `test-env.ts` **+6/-0**, `package.json`/`bun.lock` **+1/-0** cada uno.
   La parte sidebar aporta `solid-js`/`createSignal` para reconciliar el arbol, `client.session.list()` para enumerar
   sesiones, y `state.config.agent[].model` para overrides vivos (esta ultima, API **no documentada**: B-05 la sustituye
   por rutas documentadas). Los tests `rigel-v2-native-agents.test.mjs` y `rigel-v2-native-runtime.test.mjs` son de
   **agentes/modelos y runtime**, fuera del alcance del sidebar, y no deben contaminar la tarea paralela de modelos
   (A2-03). Materia prima, no aplicada.
6. **Hallazgos B (arquitectura/aislamiento/rollback) - veredicto NEEDS_CORRECTION.** La Auditoria B
   (`AUDIT-B-SIDEBAR-ARCHITECTURE.md`) verifico que el feature flag `tui.sidebar.enabled` **no esta cableado a ninguna
   configuracion real** (B-01): el unico escritor del `options` del entry CLI emite `{ notification }` sin `tui`
   (`notification-activation-config.mjs:207`) y el laboratorio/instalador reconstruyen el entry perdiendo claves extra,
   de modo que hoy **solo el seam/tests** setean el flag. En consecuencia el opt-in de canario y el `enabled:false` de
   emergencia/P5 eran **inejecutables** y un canario verde por el seam seria un falso verde. Ademas, el gate de
   capacidad/version fail-closed **no estaba asignado a una fase** ni la superficie era fail-closed (B-02), y habia
   defectos de **atomicidad** (P0/P2/P3 mezclaban concerns; P2 mezclaba runtime/roster/modelos y usaba `context.state`),
   **peers** (`solid-js` como `dependency` en vez de `peerDependency`), **rollback** (solo `git revert`, sin artefactos
   desplegados) e **idempotencia** (doble setup sin guarda) (B-03..B-07), mas precisiones B-08..B-13. Correccion
   documental aplicada en esta ronda al plan y a este handoff; tabla de trazabilidad en la seccion 14.
7. **Hallazgos C (QA real / no-regresion) - veredicto NEEDS_CORRECTION (1 BLOCKER + 2 MAJOR).** La Auditoria C
   (`AUDIT-C-SIDEBAR-QA-NO-REGRESSION.md`) encontro que **no habia gate ejecutable del render**: `render` devuelve
   `describeView(view)` (texto; `""` en error) -la causa raiz del crash-, la suite **fijaba el texto plano como
   esperado** (`rigel-v2-native-cli-sidebar.test.mjs`: `toBe("No configured models")`, `toContain("atlas running")`),
   el seam no invocaba `render()` y la fila 6 estaba marcada "Seam visual (no observado)" (C-1, **BLOCKER**). Ademas, el
   observador designado se describia como "contexto CLI **real**" cuando lo arma `fake-context.mjs` (encabezado `Fake
   OpenCode V2 setup context`) -el `setup()` es real, el **host es simulado**- (C-3), y **no existe QA de aceptacion del
   render por el host real** (el lab no carga `./tui`), dejando el "seam visual" a definir sin gate real de P5 (C-2).
   Mas MINOR/INFO (C-4..C-10: caracterizacion, mutacion con hash, artefacto de baseline, gates por fila, comandos de
   suite, aislamiento explicito, nota cruzada). Correccion documental aplicada en esta ronda; tabla en la seccion 15.
8. **Hallazgos C2 (repeticion desde cero) - veredicto NEEDS_CORRECTION (1 MAJOR).** La Auditoria C2
   (`AUDIT-C2-SIDEBAR-QA-NO-REGRESSION.md`) confirmo que C-01..C-10 estan presentes (10/10), pero detecto que el
   **discriminador del gate del render** (`render()` -> "objeto con `kind`") **coincide con la IR del core**
   `{kind:"box"|"text"}` (`rigel-v2-sidebar-core.mjs:506,511,515`), que **no** es el nodo del host: devolver
   `buildViewNodes(...)` satisfaria el gate **sin materializar** (C2-1, **MAJOR**). Ademas: referencia colgante del
   comando/umbral de mutacion (C2-2), atribucion imprecisa del contexto del sidebar a `fake-context.mjs` cuando es
   **inline** (C2-3), ejecutabilidad del gate atada a la procedencia no decidida + renderer stub (C2-4), y etiqueta de
   cobertura futura de la fila 27 (C2-5). Correccion documental aplicada en esta ronda; tabla en la seccion 16.

## 4. Reconstruccion historica (resumen)

```
63c529818  base "pre-c92e0a5e" (PR #11)
c92e0a5e4  materialize sidebar element tree + theme + harden          (PR #12)
a38e8431f  harden Rigel runtime detection + agent defaults
843983475  materialize and harden Rigel runtime                       (integracion PR #12)
e434d1600  populate sidebar model roster from real sources            (PR #14)
2e84941b2  register exactly one Rigel CLI runtime                     (PR #16)
6a46ed3ef  REVERT post-63c529818 TUI -> pre-c92e0a5e                  (PR #17)
a4aefc291  default the sidebar CLI surface off (no ui.slot)          (PR #17)
c1351a3c7 / 5463a64ac / c2983037c  (PR #17/#18/#19)
404a62901  HEAD
```

Clasificacion: **padre** = `packages/omo-opencode/src/{tui.ts,features/tui-sidebar/*}`; **primer port V2** = los 4
modulos actuales; **arreglos** = c92e0a5e/a38e8431f/843983475/e434d1600/2e84941b2; **intento fallido + revert** =
6a46ed3ef + a4aefc291 + stash; **estado actual** = HEAD OFF en dev/canario (objetivo de paridad ON, ver §3.4 y plan §2.5).

## 5. Contrato conductual resumido

- Vistas: `active | broken | idle`. Secciones: banner de config, ULW (goals/pass/fail/pending/blocked/active), Agents,
  Jobs, y Models (idle).
- Knobs: `STALE_MS=6000`, `LOOP_FRESH_MS=120000`, `POLL_INTERVAL_MS=1000`, `HEARTBEAT_MS=2000`,
  `WRITE_DEBOUNCE_MS=250`, `MAX_AGENTS=12`, `MAX_JOBS=12`, `LABEL_MAX=24`.
- El goal activo se redacta a `null` -> en runtime siempre `active private`.
- El roster es la tabla de resolucion de modelos (agentes + categorias), no los agentes habilitados.
- Compuerta de loop live: un loop cuenta como `live` solo si esta fresco y tiene algun goal `in_progress` (A-09).
- Timers: debounce 250 ms / heartbeat 2 s / poll 1 s son **contrato historico**; la superficie V2 **no tiene
  temporizadores** (solo `context.data.on`), asi que la equivalencia reactiva queda **Incognita/Bloqueada** hasta pasar
  el **gate T** del plan §6.4 (A2-02); si no preserva la frescura periodica, el plan conserva un refresco explicito.
- Semantica de configuracion: **ON salvo `false`** (contrato no-reducible, A-01); OFF solo en dev/canario; default-ON
  objetivo de la fase de release P5. **Cableado real (B-01):** la unica ruta soportada es
  `omo.jsonc` (`[opencode].tui.sidebar`) -> `resolveRuntimeSidebarOptions` -> `registerCompanionCliPlugin` -> `cli.json`
  -> `context.options` (plan §2.7); el seam de QA es observador, **no** la unica fuente del flag.
- Capacidad/version gate: **matriz unica fail-closed** (plan §6.2), implementada en **P1** antes de instanciar la
  superficie; sin `options`/capacidad el sidebar queda **OFF** (B-02).
- Gate del render materializado (**C-1/C2-1**): con el flag ON, `render()` debe devolver la **salida del materializador**
  (nodo del host via fabrica `context.renderer`), nunca cadena, `""` **ni la IR cruda** `{kind}`; **negativo: devolver la
  IR cruda FALLA**. Se asierta en el **seam hermetico** (renderer capaz, C2-4) y los tests que hoy fijan texto se
  **invierten** en el mismo commit P1.2 (plan §6.4 P1.2, §6.7, §6.10 filas 6/15).
- Aceptacion real del host (**C-2/C-3**): el seam usa **contexto sintetico/fiel** (`fake-context.mjs`); el `setup()` es
  real pero el **host es simulado**. La aceptacion del render por el host real es **riesgo residual** y se cubre con el
  **gate pre-P5** de plan §6.11; **P5 queda bloqueado** hasta que pase (o decision firmada de Gabo).
- Detalle completo y evidencia por conducta en el plan (seccion 3) y matriz de 27 capacidades en el plan (seccion 6.10).

## 6. Prohibiciones que el plan respeta

V1, NLS1, produccion y secretos fuera de alcance; sin Docker; sin `run`/`serve`/`--standalone`; sin activacion por
defecto en las fases P0..P4 (el default-ON es la fase de release P5); sin big-bang; sin usar el sidebar como gate de
modelos; sin helpers simulados; sin integracion sin gates; sin autoaprobar.

## 7. Proximos pasos (con otro encargo explicito; esto NO es autorizacion)

Orden (B-10): A+B+C auditan el **plan** y son **prerequisito de arranque de P0**; P4/P5 requieren ademas re-auditoria y
gates reales. Fases en commits atomicos (plan §6.4):

1. **P0** (5 commits): docs ledger/catalogo; **reparar** el seam t25 (sin salida "stale", B-09); guardas negativas
   flat-install + baseline conductual; **cablear el flag** `tui.sidebar` por la ruta §2.7 (default OFF, B-01/B-11);
   runbook opt-in/opt-out probado end-to-end.
2. **P1** (3 commits): **matriz de capacidad fail-closed** en el compositor + superficie fail-closed (B-02); renderer por
   **nodo del host materializado** (fabrica `context.renderer`, procedencia decidida C2-4) con **peers declarados**
   (`@opentui/core`/`@opentui/solid`/`solid-js`, B-04) **+ gate del render materializado (nodo, no texto, no IR `{kind}`;
   negativo IR cruda FALLA) e inversion de los tests de texto en el mismo commit P1.2 (C-1/C2-1)**; **setup
   doble/concurrente idempotente** (B-07).
3. **P2** (3 commits, sin mezclar): sesiones vivas; roster; overrides de modelo **solo-lectura** por rutas documentadas
   (sin `context.state`, B-05).
4. **P3** (2 commits): canario del **seam hermetico CLI** `qa-v2-t25-live-surfaces.mjs` con opt-in por config + refresco
   del lab via `apply-v2-runtime-service.sh` (lado servidor; **no** observa el companion CLI, A2-01); **gate T** de
   frescura; **sin** TUI.
5. **P4** verificacion + las tres auditorias + **drill de rollback con artefactos desplegados** (B-06) + **gate del
   render (C-1)** + **gate de aceptacion real del host (§6.11, C-2)** o expediente BLOCKED.
6. **P5** (fase de **release separada**, fuera de P0..P4) restaurar el default-ON por la misma ruta de configuracion,
   gated en auditorias A+B+C + gates reales + **gate de aceptacion del host**; **bloqueado** hasta que ese gate pase o
   exista decision firmada de Gabo (C-2/C-3).

## 8. Checklist de las tres auditorias posteriores

- **A. Fidelidad historica:** las **27 capacidades** del padre tienen prueba y fila en la matriz (incl. transiciones, timers, tema, espejo, filtros, roster, compuerta de loop y **semantica de configuracion ON salvo `false`**); **la fila de timers no se declara cubierta mientras su equivalencia reactiva siga sin prueba** (Incognita/Bloqueada hasta el gate T del plan §6.4); sin reduccion del contrato; ledger reconciliado (catalogo+ledger+codigo); boveda marcada segun plan 2.6.
- **B. Arquitectura/aislamiento/rollback (cubre B-01..B-13 completo):** ruta real y unica del flag hasta
  `context.options.tui.sidebar.enabled` (B-01); matriz de capacidad fail-closed asignada a P1 y superficie fail-closed
  (B-02); fases/commits atomicos sin mezclar runtime/roster/modelos (B-03); arbol de nodos/peers como
  `peerDependencies` (B-04); sin `context.state` (B-05); rollback de artefactos desplegados + `cli.json` + servicio lab
  verificado con `rigel-v2-user-install.mjs status` (B-06); setup doble/concurrente idempotente (B-07); baseline
  **conductual** con inventario exacto (B-08); seam reparado sin salida "stale" (B-09); orden de auditorias (B-10);
  comando de desactivacion probado tras el cableado (B-11); fila 26 (B-12); `XDG_STATE_HOME` explicito (B-13). Dueño
  unico; V1 intacta; sin Docker/NLS1; canario de runtime solo lab.
- **C. QA real/no-regresion (seams separados; cubre C-01..C-10 y C2-1..C2-7, tablas handoff §15/§16):** seam
  **headless hermetico CLI con contexto sintetico/fiel INLINE (`qa-v2-t25-live-surfaces.mjs:171-186`; C2-3)** (recibo
  `sidebar-snapshot.json`, eventos de slot, **gate del render MATERIALIZADO `render()` -> nodo del host via fabrica
  `context.renderer`, no texto, no IR `{kind}`; negativo IR cruda FALLA (C-1/C2-1)**, **opt-in por config §2.7**, sesion
  nueva/cambio/cierre, dispose, **setup doble**, fault injection, flat install **con flag ON + peers**, suites
  `bun test profiles/gabo` + `validate-profile.mjs`, mutaciones RED/restore con **hash exacto + comando/umbral (C-5/C2-2)**,
  caracterizacion, **gate T** de frescura) asertado con `qa-v2-t25-live-surfaces.mjs`; el **lab** `opencode serve` **no**
  observa el companion CLI (A2-01); el **gate de aceptacion real del host** es separado y **bloquea P5** (§6.11, C-2); el
  sidebar no es gate de modelos (aislamiento explicito, C-9).

Cada auditoria la firma un revisor independiente. No hay autoaprobacion.

## 9. git status y limites de acceso

- `git status`: sin cambios de codigo productivo rastreado. `HEAD` = `404a6290134d1704bb44eff7c092c161770f49e2`.
  En las rondas de correccion B, C y C2 solo se editaron **este handoff** y el plan
  (`.omo/drafts/v2-sidebar-parity-reversible-plan.md`, gitignored por `.gitignore:2`); **no** se toco codigo, tests,
  boveda ni stash.
- Sin commit / push / PR. Sin procesos OpenCode lanzados. Sin Docker.
- Boveda leida en solo-lectura; sin editar; sin copiar secretos.
- No se toco la tarea paralela de modelos (`audit/v2-user-model-config`, `fix/v2-user-model-delegation`).

## 10. Hashes de baseline (HEAD 404a62901)

```
a15f4ea2d9dc1051ee61c797b3ea0f766ce2c39c047e36ff6f4323e72404b443  profiles/gabo/opencode/rigel-v2-native-cli-sidebar.mjs
20d8a6592dca86f69d573c0a2b3c00db2f14162bb8c84cb4d8b053977878bf46  profiles/gabo/opencode/rigel-v2-native-cli-sidebar.test.mjs
10785b8384c1fcbeecf797858ebc4b69b595cfa2b672da8aeddf95731f7ec508  profiles/gabo/opencode/rigel-v2-sidebar-core.mjs
3b3197c8c7c2cfabcb8a32b1493151f14333964dedfa49a6e02c782bdbadf85a  profiles/gabo/opencode/rigel-v2-sidebar-core.test.mjs
e96566ea006272f72c6257b73f1574ceca57a93269ab3cdf0b384da7ee7649aa  profiles/gabo/opencode/rigel-v2-native-cli.mjs
```

## 11. Fuentes citadas

Boveda `oh-my-rigel-vault`: `00_INDEX.md`, `Principios_de_Migracion_V2.md`, `Entorno_OpenCode_V1_V2.md`,
`Oh_My_Rigel_MOC.md`, `Handoff.md`, `planes/migracion-espejo-v2-omr.md`, `Catalogo_Funciones_OMR_V2.md` (fila
"Barra lateral", linea 170), `Deudas_Tecnicas.md`, `evidencias/2026-10-11-correccion-sidebar-tui-v2.md`,
`mantenimiento/Mantenimiento_OMR_MOC.md`, `mantenimiento/Contrato_Ejecucion_Independencia_Repositorio_OMR.md`,
`evidencias/2026-10-11-pausa-independencia-repositorio.md`.

Doc oficial V2: `migrate-v1`, `build/plugins/migrate-v1`, `build/plugins`, `build/plugins/cli`, `api`.

## 12. Correcciones de la Auditoria A aplicadas (A-01..A-11)

Tabla de trazabilidad: cada hallazgo de `AUDIT-A-SIDEBAR-FIDELITY.md` con su correccion aplicada y ubicacion. Estas
correcciones son **documentales** (solo el plan y este handoff); **no** se toco codigo productivo, tests, boveda,
stashes ni otros worktrees. Sigue **DRAFT / NO IMPLEMENTAR**.

| Hallazgo | Severidad | Correccion aplicada | Ubicacion |
| --- | --- | --- | --- |
| A-01 | ALTA | Default de configuracion clasificado como contrato **no-reducible**; default-ON **no** rebajado y declarado objetivo de paridad; OFF solo en dev/canario; activacion = fase de release separada. Reconciliacion de **tres capas** (contrato/catalogo, ledger, codigo), sin reescribir el ledger a la baja. | Plan §0, §2.5, §3.9, §6.1, §6.2, §6.4 (P0 + P5), §6.10 (fila 27), §7A; handoff §3.4, §5, §7, §8A |
| A-02 | ALTA | Bloque de reconciliacion con la boveda **artefacto por artefacto**; notas de "cerrado/integrado" marcadas como **historicamente superadas** por `6a46ed3ef`+`a4aefc291`; actualizacion futura enumerada, **boveda NO editada**. | Plan §2.6 (nuevo), §6.4 P0; handoff §3 |
| A-03 | MEDIA | Matriz conducta->prueba ampliada a las **27 capacidades** del padre (transiciones, timers, tema, espejo, filtros, roster, compuerta de loop, default). | Plan §6.10, §7A; handoff §5 |
| A-04 | MEDIA | Checklist A incluye **semantica de configuracion (default-ON salvo `false`)**. | Plan §7A; handoff §8A |
| A-05 | MEDIA | Frescura **separada**: loop 120 s **observable** (en uso) vs snapshot 6 s **portado e inerte** (sin canal de espejo); no se presentan como una sola paridad. | Plan §6.10 (filas 10/11 + nota A-05), §6.6; handoff §5 |
| A-06 | MEDIA | **Seam headless autorizado** (recibo + eventos) separado del **seam visual real**; P3 y §7C ya no prometen TUI/pixeles en el lab ni lanzar la TUI directa; validacion de cada seam sin simulacion. | Plan §6.4 (P3), §6.6, §7C; handoff §7, §8C |
| A-07 | BAJA | `notification-activation-config.*` = **modificados y revertidos en contenido** (existen en HEAD), distinto de los archivos **borrados** (`node`/`theme`/`v2-agent-selection-core`). | Plan §2.2; handoff §3.3 |
| A-08 | BAJA | Raiz del arbol `active` incluye `gap: 1`; `materialize()` envuelve en una caja raiz. | Plan §3.2 (y fila 6 de §6.10) |
| A-09 | BAJA | Compuerta **live requiere algun goal `in_progress`** inventariada como input observable. | Plan §3.3, §3.4, §3.6, §6.10 (fila 19); handoff §5 |
| A-10 | BAJA | Cita del fallback `ui.slots.register` **atribuida al codigo** (`rigel-v2-native-cli-btw.mjs:246-248`); `btw.md:86-89` solo respalda "no split". | Plan §4 |
| A-11 | INFO | Columna "V2" **etiquetada como API objetivo (doc oficial)** vs codigo actual (HEAD lee `data.roster\|data.agents\|data.models` y `data.session.list()`). | Plan §4 |

**Estado:** corregido en documentacion (plan + este handoff). Contrato de esta ronda: `sidebar-correction-a2-contract.md`.
Proximo paso: **tercera repeticion independiente de la Auditoria A** (desde cero) sobre el plan y el handoff corregidos,
verificando A2-01..A2-05. No autoaprobar; sin commit/push/PR.

## 13. Correcciones de la Auditoria A2 aplicadas (A2-01..A2-05)

Tabla de trazabilidad de `AUDIT-A2-SIDEBAR-FIDELITY.md`. Correcciones **documentales** (solo el plan y este handoff);
**no** se toco codigo productivo, tests, boveda, stashes ni otros worktrees. Sigue **DRAFT / NO IMPLEMENTAR**.

| Hallazgo | Severidad | Correccion aplicada | Ubicacion |
| --- | --- | --- | --- |
| A2-01 | ALTA | Se **declara** que `opencode-v2-lab.service` (`opencode serve`) **no** construye el contexto de plugin CLI ni carga el companion `./tui`, por lo que **no produce** recibo/slot/log del sidebar; se **designa el seam hermetico real** `qa-v2-t25-live-surfaces.mjs` (contexto CLI real + `setup()` real, sin lanzar OpenCode) como observador del recibo/slot/log; el lab queda solo para refresco / lado servidor; el **seam visual** sigue **separado y no observado**. (**Relabel posterior C-3:** el contexto es **sintetico/fiel** (`fake-context.mjs`); el `setup()` es real, el **host simulado**; ver §15.) | Plan §0, §2.5 (cita QA), §6.4 (P3), §6.5, §6.6, §6.7, §6.10 (fila 26 + nota A-06/A2-01), §7C, §8; handoff §7 (P3), §8C |
| A2-02 | MEDIA | Timers (debounce/heartbeat/poll) registrados como **contrato historico**; equivalencia reactiva marcada **Incognita/Bloqueada**; se define el **gate T** ejecutable (recibo/render sin eventos vs `HEARTBEAT_MS`, o se conserva un refresco explicito); la fila 9 deja de estar "Cubierta". | Plan §6.3, §6.4 (P3, gate T), §6.7, §6.10 (fila 9 + leyenda + nota A2-02), §7A; handoff §5, §8A |
| A2-03 | MEDIA | Inventario de `stash@{0}` corregido a **ocho archivos** con numstat exacto (`rigel-v2-native-cli-sidebar.mjs` **+147/-38**; `rigel-v2-sidebar-node.mjs` **+4/-1**; anadidos `rigel-v2-native-cli-sidebar.test.mjs` **+113/-5**, `rigel-v2-native-agents.test.mjs` **+52/-0**, `rigel-v2-native-runtime.test.mjs` **+72/-1**); alcance sidebar separado de los tests de agentes/runtime (tarea paralela de modelos). | Plan §2.4; handoff §3.5 |
| A2-04 | BAJA | Ruta completa `hooks/atlas/session-last-agent.ts` (no esta en `features/tui-sidebar/`). | Plan §3.1, §3.5, §3.6, §6.10 (fila 17) |
| A2-05 | BAJA | Cita corregida a `config/schema/tui.ts:3-5` (no `tui.ts:3-5`). | Plan §6.10 (fila 27) |

## 14. Correcciones de la Auditoria B aplicadas (B-01..B-13)

Tabla de trazabilidad de `AUDIT-B-SIDEBAR-ARCHITECTURE.md` (veredicto **NEEDS_CORRECTION**). Correcciones
**documentales** (solo el plan y este handoff); **no** se toco codigo productivo, tests, boveda, stashes ni otros
worktrees. Sigue **DRAFT / NO IMPLEMENTAR**. Se mantienen: default-ON como objetivo **P5**, flag **OFF** en
desarrollo/canario y las **27 capacidades** de A3 (plan §6.10).

| Hallazgo | Severidad | Correccion aplicada | Ubicacion |
| --- | --- | --- | --- |
| B-01 | ALTA | Se **disena la ruta real y unica** `omo.jsonc ([opencode].tui.sidebar)` -> `resolveRuntimeSidebarOptions` -> `registerCompanionCliPlugin` (emite `options.tui.sidebar`) -> `cli.json` -> `context.options` -> composer, con install/materialize/lab/user-install, opt-in de canario y `enabled:false` de emergencia/P5; **idempotente y preservada** en refresh/reinstall/rollback. Se declara que hoy **solo el seam/tests** setean el flag y que **el seam no puede ser la unica fuente**. | Plan §0 (hallazgo 5), §2.5, **§2.7 (nuevo)**, §6.1, §6.2, §6.4 (P0.4/P0.5, P3.1, P5), §6.5, §6.7, §6.9, §6.10 (fila 27), §7A/§7B; handoff §3.6, §5, §7, §8B |
| B-02 | ALTA | Se fija **una matriz unica de capacidad/version fail-closed** (renderer presente/vivo, ausente, destruido; `ui.slot` presente/ausente) y se **asigna a P1**, implementada en el compositor **antes** de instanciar la superficie; la superficie aislada tambien queda fail-closed. Sin `options`/capacidad, **OFF**. | Plan §0 (hallazgo 6), §6.1, **§6.2 (matriz)**, §6.4 (P1.1), §6.7, §7B; handoff §5, §7, §8B |
| B-03 | MEDIA | Se parten **P0, P2 y P3 en commits atomicos** (P0.1..P0.5; P2.1 sesiones / P2.2 roster / P2.3 overrides; P3.1 canario / P3.2 gate T); P2 **no** mezcla runtime/roster/modelos y los overrides son **solo-lectura para display** con prueba explicita de que **no** alteran la seleccion de modelo. | Plan §0 (hallazgo 7), §6.4; handoff §7, §8B |
| B-04 | MEDIA | Se decide y documenta la **procedencia del arbol de nodos** (fabrica del host via `context.renderer` vs `@opentui/solid`) y se declaran los peers (`@opentui/core`, `@opentui/solid`, `solid-js`) como **`peerDependencies`** (nunca `dependency`), cubierto con flat-install **con flag ON**. | Plan §0 (hallazgo 7), §2.4, §6.3, §6.4 (P1.2), §6.5, §6.7, §7B; handoff §3.5, §7 |
| B-05 | MEDIA | Se **sustituye `context.state.config.agent[].model`** por rutas **documentadas** (`context.data.location.agent/model.list(location)`, `ui.model.current()`), best-effort tolerante con prueba ante su ausencia. | Plan §0 (hallazgo 4 y 7), §2.4, §6.3, §6.4 (P2.3), §7B; handoff §3.5, §7 |
| B-06 | MEDIA | El **rollback por fase** se extiende a la **rematerializacion** del runtime + `cli.json` + servicio lab; se verifica con `rigel-v2-user-install.mjs status` (`cli.singleRigelEntry`, `cli.runtimeMatchesConfig`, `runtime.digestMatches`); incluye inventario/hashes pre/post y **ensayo**. | Plan §0 (hallazgo 7), §6.4 (P4), §6.8, §6.9, §7B; handoff §7, §8B |
| B-07 | MEDIA | Se anade **prueba (y guarda) de setup doble/concurrente idempotente** con contadores de suscripciones/slots y verificacion de que el disposer deja el estado limpio. | Plan §0 (hallazgo 7), §6.4 (P1.3), §6.7, §7B; handoff §8C |
| B-08 | BAJA | "Byte-identico" se redefine como **baseline conductual** (conjunto identico de superficies compuestas, slots, recibos, logs y render con el flag OFF), con **inventario exacto**; los hashes son control de **deriva de codigo**, no prueba de equivalencia. | Plan §0, §2.5, §6.1, §6.8, §6.9, §7B; handoff §8B |
| B-09 | BAJA | Se **exige la reparacion** del seam (positive con opt-in); se elimina la alternativa "marcarlo stale". | Plan §0 (hallazgo 8), §6.4 (P0.2); handoff §7, §8B |
| B-10 | BAJA | Se fija el **orden**: A+B+C auditan el **plan** y son **prerequisito de arranque de P0**; P4/P5 requieren re-auditoria y gates reales. | Plan §0, §6.4 (nota de orden), §7; handoff §7, §8 |
| B-11 | BAJA | El **comando de opt-in/desactivacion** se documenta **solo tras** cablear el flag (P0.4) y se prueba **end-to-end** (activar -> slot+recibo; desactivar -> ausencia). | Plan §0 (hallazgo 8), §2.7, §6.2, §6.4 (P0.5), §6.9, §7B; handoff §7 |
| B-12 | INFO | Se **reformula la fila 26**: el recibo lo escribe el **companion CLI en su `setup()`**; el servidor V2 **no** participa (no hay equivalente servidor). | Plan §0 (hallazgo 8), §6.10 (fila 26); handoff §8A |
| B-13 | INFO | Se exige **`XDG_STATE_HOME` explicito** en toda ruta de opt-in (el fallback a `homedir()/.local/state` escribiria bajo el home real); se anota en el contrato del seam y en las pruebas. | Plan §0 (hallazgo 8), §2.7, §6.6, §6.7, §7B; handoff §8B |

**Estado:** corregido en documentacion (plan + este handoff). Contrato de esta ronda:
`sidebar-correction-b-contract.md`. Las correcciones **no** se autoaprueban: la repeticion **desde cero** de la
**Auditoria B** (y, si procede, de A/C) queda como el proximo paso, verificando B-01..B-13 sobre el plan y el handoff ya
corregidos. Sin commit / push / PR.

## 15. Correcciones de la Auditoria C aplicadas (C-01..C-10)

Tabla de trazabilidad de `AUDIT-C-SIDEBAR-QA-NO-REGRESSION.md` (veredicto **NEEDS_CORRECTION**: 1 BLOCKER + 2 MAJOR +
MINOR/INFO). Correcciones **documentales** (solo el plan y este handoff); **no** se toco codigo productivo, tests,
boveda, stashes ni otros worktrees. Sigue **DRAFT / NO IMPLEMENTAR**. Se preservan los contratos de **A3** (27
capacidades) y **B2**, el **flag OFF** en desarrollo/canario, la **reversibilidad** y los invariantes protegidos de
**modelos / delegacion / orquestacion**.

| Hallazgo | Severidad | Correccion aplicada | Ubicacion |
| --- | --- | --- | --- |
| C-1 | **BLOCKER** | Se anade un **gate ejecutable del render**: con el flag ON, `render()` devuelve un **nodo estructurado** (objeto con `kind`), **nunca** cadena ni `""`; el **seam hermetico** invoca `render()` y lo asierta; los tests que hoy fijan el **texto plano** (`rigel-v2-native-cli-sidebar.test.mjs`: `toBe("No configured models")`, `toContain("atlas running")`/`toContain("Agents")`) se **invierten** en el **mismo commit P1.2**; las **filas 6/15** se asignan a gates concretos (nodo en el seam + aceptacion del host en §6.11). (**Superseded por C2-1:** el discriminador `objeto con kind` coincide con la IR del core; el gate ahora exige el **nodo materializado** y un **negativo** de IR cruda; ver §16.) | Plan §0 (hallazgo 9), §5, §6.4 (P1.2, P4), §6.5, §6.6, §6.7, §6.10 (filas 6/15 + leyenda + nota), §7A/§7B/§7C; handoff §3.7, §5, §7, §8C |
| C-2 | **MAJOR** | Se **registra el riesgo residual** de aceptacion del render por el host y se define el **gate de aceptacion real (visual/host) antes de P5** (plan §6.11), con **P5 BLOQUEADO** hasta que pase (o decision firmada de Gabo pre-P5). | Plan §0 (hallazgo 10), §6.4 (P4, P5), §6.5, §6.6, **§6.11 (nuevo)**, §7B/§7C; handoff §3.7, §5, §7, §8C |
| C-3 | **MAJOR** | El seam se **relabela** como **contexto CLI SINTETICO/FIEL (`fake-context.mjs`)**; se declara que el **`setup()` es real** pero el **host es simulado**, de modo que el seam prueba rutas/registros y el **tipo del render**, **no** la aceptacion del host; se reconcilia con el contrato "no helpers simulados" remitiendo al gate de §6.11. | Plan §0 (hallazgo 10), §5, §6.5, §6.6, §6.7, **§6.11**, §7C; handoff §3.7, §5, §8C |
| C-4 | MINOR | Se nombran las **pruebas de caracterizacion pre-cambio**: (1) salida actual del render (texto, que P1.2 invierte) y (2) baseline OFF (que P0.3 conserva); pre/post explicitos. | Plan §0 (hallazgo 9), §6.4 (P4), §6.7, §7B; handoff §8C |
| C-5 | MINOR | Se define el **procedimiento de mutacion**: hash **pre**, lista de **mutantes RED**, corrida esperando fallo (RED), restauracion con **hash post == pre** (restauracion exacta byte a byte) y comando/umbral. | Plan §6.4 (P4), §6.7, §7B/§7C; handoff §8C |
| C-6 | MINOR | Se fija el **artefacto de captura/diff del baseline OFF**: JSON normalizado `{ composedSurfaces, registeredSlots, receiptsWritten, logEvents, renderType }` con diff vacio (o diferencias declaradas) como gate go/no-go. | Plan §0, §6.1, §6.9, §7B; handoff §8B |
| C-7 | MINOR | Se **asigna gate ejecutable** a las filas propuestas (8 -> eventos de sesion en el seam P3; 20/23/25 -> P4; 21 -> contador de disposers P1.3/P3; 22 -> setup doble/concurrente P1.3) y se declaran las filas 9/10 como **riesgo aceptado** formal (gate T / sin canal de espejo). | Plan §6.10 (filas 8, 9, 10, 20-23, 25 + leyenda + nota), §7A/§7B; handoff §8A/§8C |
| C-8 | INFO | Se fijan **comandos y umbral** de no-regresion: `bun test profiles/gabo` (verde) + `node profiles/gabo/validate-profile.mjs` (exit 0) como **criterio de Go por fase**, junto con el gate del render y el baseline OFF. | Plan §6.4 (P4), §6.7, §7C; handoff §8C |
| C-9 | INFO | Se anade la **mencion explicita** de no tocar **delegacion/orquestacion/routing/prompts/agentes/categorias/fallbacks/permisos/continuidad/background handoff/seleccion de modelo**; el sidebar solo lee para display y nunca es gate de modelos. | Plan §0, §6.1 (parrafo nuevo); handoff §8C |
| C-10 | INFO | Se anade **nota cruzada** en la fila 26: "recibo observado" **no** equivale a "render aceptado por el host" -> ver C-1/§6.11. | Plan §6.10 (fila 26); handoff §8C |

**Estado:** corregido en documentacion (plan + este handoff). Contrato de esta ronda: `sidebar-correction-c-contract.md`
(prompt de auditoria: `sidebar-audit-c-prompt.txt`). Las correcciones **no** se autoaprueban: el proximo paso es una
**nueva auditoria C independiente desde cero (C2)** sobre el plan y el handoff corregidos, verificando C-01..C-10, con
parada para esa revision. Sin commit / push / PR.

## 16. Correcciones de la Auditoria C2 aplicadas (C2-1..C2-7)

Tabla de trazabilidad de `AUDIT-C2-SIDEBAR-QA-NO-REGRESSION.md` (veredicto **NEEDS_CORRECTION**: 1 MAJOR + MINOR/INFO).
Correcciones **documentales** (solo el plan y este handoff); **no** se toco codigo productivo, tests, boveda, stashes ni
otros worktrees. Sigue **DRAFT / NO IMPLEMENTAR**. Se preservan los contratos de **A3**, **B2** y **C** (C-01..C-10), el
**flag OFF** en desarrollo/canario, la **reversibilidad** y los invariantes protegidos de **modelos / delegacion /
orquestacion**.

| Hallazgo | Severidad | Correccion aplicada | Ubicacion |
| --- | --- | --- | --- |
| C2-1 | **MAJOR** | El gate del render ya **no** usa `kind` (marcador de la IR) como discriminador. Ahora asierta la **salida del materializador** (nodo del host producido por la fabrica `context.renderer`), **explicitamente distinta** de la **IR cruda** `buildViewNodes` `{kind:"box"|"text"}`; incluye un **negativo** donde devolver la IR cruda **FALLA** el gate. | Plan §0 (hallazgo 9), §5, §6.3, §6.4 (P1.2), §6.5, §6.6, §6.7, §6.10 (filas 6/15 + leyenda), §6.11, §7A/§7B/§7C; handoff §3.8, §5, §7, §8C |
| C2-2 | MINOR | Se anaden el **comando y el umbral de mutacion** (por mutante: `bun test profiles/gabo` o el archivo del gate debe **fallar** = al menos 1 RED) y la **restauracion** (`git checkout -- <archivo>` + `sha256sum` post == pre); se elimina la referencia colgante a §6.8. | Plan §6.7, §7B; handoff §8C |
| C2-3 | MINOR | Se corrige la **atribucion**: el contexto del **sidebar** es **inline** (`qa-v2-t25-live-surfaces.mjs:171-186`); `fake-context.mjs` (importado L39) cubre el **entrypoint servidor** (L71) y su negativo (L137), no el sidebar. | Plan §6.5, §6.6, §6.7, §7C; handoff §3.8, §8C |
| C2-4 | MINOR | Se **decide la procedencia** (fabrica del host via `context.renderer`: `createElement`/`insert`/`setProp`) y se exige un **renderer capaz** en el seam para que el gate sea ejecutable; si la fabrica no estuviera disponible, el gate se **acota a una asercion unitaria** sobre `rigel-v2-sidebar-node.mjs` con fabrica inyectada (documentado, no presentado como aceptacion del host). | Plan §6.3, §6.4 (P1.2), §6.7; handoff §3.8, §7 |
| C2-5 | INFO | La fila 27 se **relabela** a "Cubierta (gate P0.4/P5)" (cobertura futura, no presente), consistente con las filas 8/20-23. | Plan §6.10 (fila 27 + leyenda); handoff §8A |
| C2-6 | INFO | Las filas 9/10 mantienen la condicion de **riesgo aceptado** sin reducir el contrato: "o se conserva un **refresco/equivalencia explicita**" queda junto a la etiqueta (fila 9 gate T; fila 10 sin canal de espejo). | Plan §6.10 (leyenda + filas 9/10 + notas A2-02/A-05), §6.4 (P3.2); handoff §8A |
| C2-7 | INFO | **Confirmaciones positivas** (sin accion): citas del seam exactas (171-186, 211, 246-249, 268-278), matriz = **27 filas**, C-01..C-10 presentes 10/10 y hashes de codigo byte a byte. Se conservan. | Plan §2.2/§6.9/§6.10; handoff §15 |

**Estado:** corregido en documentacion (plan + este handoff). Contrato de esta ronda: `sidebar-correction-c2-contract.md`
(prompt de auditoria: `sidebar-audit-c2-prompt.txt`). Las correcciones **no** se autoaprueban: el proximo paso es una
**nueva auditoria C3 independiente desde cero** sobre el plan y el handoff corregidos, verificando C2-1..C2-7 y
revalidando C-01..C-10 y la matriz de 27 conductas. Sin commit / push / PR.
