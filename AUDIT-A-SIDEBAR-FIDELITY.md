# AUDIT-A-SIDEBAR-FIDELITY

**Auditoría A — fidelidad histórica y contrato conductual del sidebar de Oh My Rigel V2**
Revisión independiente, solo lectura. No se editó el plan, no se tocó código productivo, no hubo commit/push/PR, no se aplicó el stash, no se usó Docker ni V1/NLS1, no se lanzó ningún proceso OpenCode.

- Worktree auditado: `/home/gabodev/oh-my-rigel-worktrees/research-v2-sidebar-parity-plan`
- Rama: `research/v2-sidebar-parity-plan` — HEAD: `404a6290134d1704bb44eff7c092c161770f49e2`
- Objetos auditados: `.omo/drafts/v2-sidebar-parity-reversible-plan.md` (481 líneas) y `HANDOFF-SIDEBAR-RESEARCH.md` (122 líneas)
- Fuentes primarias contrastadas: código del padre (`packages/omo-opencode/src/tui.ts`, `features/tui-sidebar/*`), puerto V2 (`profiles/gabo/opencode/rigel-v2-*`), commits `c92e0a5e / a38e8431f / 843983475 / e434d1600 / 2e84941b2 / 6a46ed3ef / a4aefc291 / 404a62901`, `stash@{0}` (`ddea0b7d`, leído sin aplicar), bóveda `oh-my-rigel-vault`, y doc oficial `https://opencode.ai/v2/docs/build/plugins/cli`.
- Resultado de integridad de baseline: los cinco hashes SHA-256 del plan (§6.9) y del handoff (§10) coinciden **byte a byte** con HEAD (verificado con `sha256sum`). El orden de la línea temporal de §2.1 coincide exactamente con `git log --ancestry-path 63c529818..HEAD`. Esto es fidelidad verificada: buen trabajo en la reconstrucción.

---

## 1. VEREDICTO

**NEEDS_CORRECTION.**

El plan reconstruye con precisión la historia del sidebar y el inventario de la mayoría de los efectos del padre, y sus citas de código son en general exactas (ver §5). **No puede recibir PASS** porque: (a) institucionaliza como "verdad" un **estado por defecto reducido** (sidebar OFF) frente al contrato del padre (ON salvo `false`) y frente al catálogo público de la bóveda, **sin registrar la excepción explícita de Gabo** que exige el propio principio vinculante; (b) su matriz conducta→prueba (§6.10) **omite conductas del padre que el propio plan documenta en §3**; y (c) **no reconcilia las divergencias con la bóveda**, que afirma explícitamente que el sidebar quedó integrado/validado/cerrado cuando HEAD lo tiene revertido y apagado.

No es REJECT: los defectos son de alcance y de registro, corregibles de forma aditiva sin derribar el plan. Ninguna corrección exige tocar V1.

---

## 2. HALLAZGOS

### A-01 — ALTA — El plan normaliza una reducción del contrato: el default de configuración.

**Hecho del padre (contrato observable):** el sidebar está **encendido salvo `false`**. Prueba: `packages/omo-opencode/src/config/schema/tui.ts:3-5` (`enabled: z.boolean().default(true)`) y `packages/omo-opencode/src/config/schema/oh-my-opencode-config.ts:99` (`tui: TuiConfigSchema.default({ sidebar: { enabled: true } }).optional()`). En runtime, el padre solo se autoexcluye si `enabled === false` (`packages/omo-opencode/src/tui.ts:145`).

**Estado aceptado hoy en V2 (reducido):** `profiles/gabo/opencode/rigel-v2-native-cli.mjs:48` exige `context?.options?.tui?.sidebar?.enabled === true`; ausente = OFF. El propio plan lo declara en §2.5 (tabla "Doble gate") y §6.2 ("Default OFF (`=== true` para componer)").

**Divergencia con la bóveda (fuente primaria de producto):** `Catalogo_Funciones_OMR_V2.md:170` publica el sidebar como **"Migrada · Activada · Automático — viene visible de fábrica. Ajuste — `tui.sidebar.enabled: false` la oculta."** Es decir, el contrato de producto publicado es **default-ON**, exactamente lo contrario del estado aceptado que el plan adopta.

**Lo que hace el plan (y por qué es una reducción):**
- §3.9 documenta correctamente el default-ON del padre.
- §2.5 lo presenta como "divergencia" donde el ledger está "mal" y el código es "la verdad".
- **P0** propone: "Reconciliar el ledger `tui-sidebar` ... con la verdad default-off". Es decir, se reescribe el registro documental **hacia abajo** para que coincida con la conducta reducida, en lugar de exigir la restauración del default-ON (o una excepción explícita).
- La regla vinculante de la bóveda prohíbe exactamente esto: `Principios_de_Migracion_V2.md:14` ("Nunca reducir el contrato funcional."), `:20` ("La ausencia del mecanismo original en V2 no convierte la funcionalidad en opcional."), `:58` ("sustituir comportamiento real por ... no-ops ... fallos silenciosos") y `:82` ("Toda excepción requiere una decisión explícita de Gabo; ningún agente puede crearla por inferencia.").

**Corrección exigida:**
1. Clasificar el **default de configuración** como parte del contrato no-reducible, en igual rango que vistas/campos/caps/frescura.
2. (a) Declarar restaurado el default-ON como objetivo de paridad, **o** (b) registrar explícitamente una **excepción de Gabo** que autorice default-OFF; ninguna de las dos cosas está en el plan hoy.
3. P0 no puede "reconciliar el ledger al default-off" mientras el catálogo de la bóveda siga publicando "visible de fábrica": la reconciliación debe cubrir **catálogo + ledger + código** de forma coherente, o marcar el catálogo como contradicción pendiente de decisión.

### A-02 — ALTA — Divergencias con la bóveda no reconciliadas (la bóveda dice "cerrado/integrado", HEAD lo tiene revertido).

La bóveda, fuente primaria obligatoria, afirma un estado que HEAD contradice, y el plan cita esos artefactos como fuentes (§1) sin marcarlos como obsoletos:

| Artefacto de la bóveda | Lo que afirma | Realidad en HEAD |
|---|---|---|
| `evidencias/2026-10-11-correccion-sidebar-tui-v2.md` (estado `INTEGRADA`) | La corrección del sidebar se integró (`843983475`), "Sidebar preservado: vistas idle, active y broken ... No se ocultó ni degradó ninguna función"; suite `bun test profiles/gabo` 2301 verdes. | `6a46ed3ef` revirtió todo el bloque (24 archivos, +85/−1779) y `a4aefc291` apagó la superficie. |
| `mantenimiento/Mantenimiento_OMR_MOC.md:73` | "Validación V2 del sidebar **cerrada e integrada**." | Revertido en HEAD. |
| `mantenimiento/Contrato_Ejecucion_Independencia_Repositorio_OMR.md:53` | "Validación V2 cerrada e integrada (2026-10-11)." | Revertido en HEAD. |
| `evidencias/2026-10-11-pausa-independencia-repositorio.md:48` | "Validación V2 cerrada e integrada." | Revertido en HEAD. |
| `Catalogo_Funciones_OMR_V2.md:170` | Sidebar "Activada / visible de fábrica". | Default-OFF en HEAD (ver A-01). |

Gate A pide explícitamente "divergencias con la bóveda". El plan **sí** detecta la divergencia ledger↔código (§2.5), pero **no** presenta la divergencia bóveda↔código como un hallazgo con su propia fila y acción.

**Corrección exigida:** añadir un bloque de reconciliación con bóveda que, artefacto por artefacto, registre (i) qué afirma, (ii) qué muestra HEAD (commit exacto), (iii) qué debe corregirse y dónde. Sin esto, un lector que siga la bóveda creería que el sidebar ya está entregado.

### A-03 — MEDIA — La matriz conducta→prueba (§6.10) omite conductas del padre documentadas en §3.

§6.10 tiene 9 filas. §3 documenta conductas observables que **no tienen fila**:

- **Default de configuración** (padre: ON salvo `false`; §3.9) — sin fila (ligado a A-01).
- **Debounce `WRITE_DEBOUNCE_MS=250`, heartbeat `HEARTBEAT_MS=2000`, poll `POLL_INTERVAL_MS=1000`** (§3.3, §6.3 "Reescribir"). Sin fila que pruebe que la cadencia reactiva de V2 equivale a debounce+heartbeat+poll.
- **Tema** (`render-view.ts:14-23`; §3.7) — sin fila; §6.3 lo marca "Adaptar" pero la matriz no lo verifica.
- **Transiciones** idle→active→idle, active→broken, sesión creada/cerrada (§3.4/§3.6). Están en §6.7 (pruebas) pero no en la matriz §6.10.
- **Degradación error/stale/empty** (§3.4) — sin fila.
- **Contrato del recibo/espejo** versión/projectDir/updatedAt/0600 (§3.3/§3.8) — solo cubierto parcialmente por "Frescura 6 s".
- **Filtro de agentes activos `busy|retry|running`** (§3.5) y **resolución de nombre por último mensaje saltando compactación** (§3.6) — sin fila.
- **Roster = tabla de resolución de modelos** (§3.5: agentes+categorías, orden por etiqueta, incluye `sisyphus` y `deep-low`), distinto de "agentes habilitados" — sin fila específica.
- **Compuerta de loop "live"** (ver A-09) — sin fila.

**Corrección exigida:** completar la matriz hasta cubrir **todas** las conductas de §3, o marcar cada omisión con justificación explícita (por qué no es observable/prueba en V2).

### A-04 — MEDIA — La checklist de la propia auditoría A (§7A) omite el default de configuración.

§7A enumera el contrato a no reducir como "vistas, campos, caps, frescura, redacción, debounce/heartbeat" y **no incluye el default de configuración**, aunque §3.9 lo documenta. La checklist que debe atrapar reducciones es, por tanto, incapaz de detectar la reducción A-01. Inconsistencia interna del plan.

**Corrección exigida:** añadir "semántica de configuración (default-ON salvo `false`)" a la lista de §7A.

### A-05 — MEDIA — "Frescura 6 s" presenta como paridad una conducta muerta en la superficie V2.

La fila §6.10 "Frescura 6 s / loop 120 s — `isSnapshotFresh`/`isLoopFresh`" mezcla dos cosas distintas:
- `isLoopFresh` (120 s) **sí** se usa en la superficie V2 (`rigel-v2-native-cli-sidebar.mjs:44,239`).
- `isSnapshotFresh`/`STALE_MS` (6 s) se portó al core (`rigel-v2-sidebar-core.mjs:160-163`) pero **ningún camino de runtime V2 lo usa** (el adaptador construye el snapshot, nunca lee un espejo; grep confirma que `isSnapshotFresh` solo aparece en el core y en su test). Es paridad de código, no conducta observable.

**Corrección exigida:** separar en la matriz la frescura **observable** (loop 120 s, en uso) de la frescura **portada pero inerte** (snapshot 6 s), y declarar explícitamente que en V2 la antigüedad de snapshot no aplica porque no hay canal de espejo (el espejo se adaptó a recibo). No presentarlas como una sola paridad.

### A-06 — MEDIA — P3/§7C asumen observación de TUI en el laboratorio; la bóveda dice que el laboratorio es headless y que lanzar la TUI directa está prohibido.

`evidencias/2026-10-08-fase-6-tarea-25.md:45` (fuente primaria) afirma: "El render visual ... de toasts y sidebar **no es observable** en `opencode-v2-lab.service`: ese servicio es **headless y no construye el contexto de plugin CLI** (el companion `./tui` solo lo carga el renderer/TUI) ... **Lanzar la TUI directa está prohibido.**" El plan, sin embargo, escribe en P3 "observar idle/active/broken, ciclo de sesiones, dispose, sin crash" en el lab, y §7C exige "TUI real en el lab (varias dimensiones)".

**Corrección exigida:** reconciliar explícitamente cómo se observará el slot en el lab dada la restricción (probablemente vía el recibo durable `sidebar-snapshot.json`, no vía render). Corregir P3 y §7C para no prometer una observación de píxeles en el lab si la vía autorizada no la produce, y declarar la UI real como seam separado (como ya se hizo en la evidencia del 10-08 y en el 10-11).

### A-07 — BAJA — §2.2 afirma incorrectamente que el revert "eliminó" `notification-activation-config.*`.

Verificado: `profiles/gabo/notification-activation-config.mjs` y `notification-activation-config.test.mjs` **existen en la base `63c529818`** (`git cat-file -e` → EXISTS), existían antes de `2e84941b2`, y **existen en HEAD**. `git show --stat 2e84941b2` los **modifica** (`36` y `90` líneas); `git show --stat 6a46ed3ef` revierte ese contenido (`36 +--`, `90 ------`) — **no los borra**. El plan los agrupa bajo "eliminando" (borrado), lo cual es falso para esos dos archivos (sí es correcto para `rigel-v2-sidebar-node.mjs`, `rigel-v2-sidebar-theme.mjs` y `v2-agent-selection-core.mjs`, que c92e0a5e creó y el revert borró, ausentes en HEAD).

**Corrección exigida:** describir esos dos archivos como **modificados y revertidos en contenido**, no eliminados.

### A-08 — BAJA — §3.2: la raíz del árbol omite `gap: 1`.

§3.2 describe la raíz como `box{flexDirection:"column"}`. El caso `active` real es `box({ flexDirection: "column", gap: 1 }, [...])` (`render-view.ts:29`) y `materialize()` envuelve en otra caja raíz `flexDirection:"column"` (`tui.ts:50-51`). Detalle menor de fidelidad del árbol.

### A-09 — BAJA — §3.3/§3.6 omiten la compuerta "live requiere algún goal `in_progress`".

`loop-reader.ts:107-115` (padre) y `rigel-v2-native-cli-sidebar.mjs:241` (V2) descartan un loop fresco si ningún goal está `in_progress`. Es un input observable de la máquina de estados (un `goals.json` fresco sin goal en curso **no** produce estado `active`) y no está inventariado en §3.3/§3.4/§3.6.

### A-10 — BAJA — §4 cita `docs/guide/btw.md:86-89` para el fallback `ui.slots.register`.

`btw.md:86-89` sostiene "OpenCode's plugin API does not expose that split presentation", que respalda "no hay presentación split", pero **no** el fallback a `ui.slots.register`; ese fallback vive en el código, `profiles/gabo/opencode/rigel-v2-native-cli-btw.mjs` (`context?.ui?.slot ?? context?.ui?.slots` + `slots.register(...)`). Cita mal atribuida.

### A-11 — INFO — La columna "V2 (superficie real)" de §4 describe la API documentada, no el código actual.

§4 presenta como fuente de datos V2 `context.data.session.list/get/status` y `context.data.location.{agent,model}.list(location)`. Esto **coincide con la doc oficial** (`build/plugins/cli`, verificada: `context.data.session.list/get/status`, `context.data.location.agent.list(location)`, `context.data.location.model.list(location)`, `context.ui.model.current()`, `context.theme.text.base`, `context.renderer`). Pero el adaptador de HEAD **no** usa esas rutas: lee `data.roster | data.agents | data.models` (`rigel-v2-native-cli-sidebar.mjs:186-196`) y `data.session.list()` (líneas 128-133). Debe quedar explícito que §4 describe el objetivo de P2 (§6.4), no el estado actual. (P2 ya propone las rutas documentadas, así que es un problema de etiquetado, no de diseño.)

---

## 3. TABLA DE COBERTURA DE CAPACIDADES

Leyenda: **Cubierta** = conducta del padre con fila de matriz y prueba identificable. **Parcial** = aparece en §3 pero sin fila propia o cubierta de refilón. **Ausente** = conducta del padre sin fila ni prueba.

| # | Capacidad del padre (fuente) | Plan § | Fila en matriz §6.10 | Estado |
|---|---|---|---|---|
| 1 | Banner de configuración inválida (`render-view.ts:67-76`) | §3.1 | "Vista active/broken" (implícita) | Parcial |
| 2 | Sección ULW: goals/pass/fail/pending/blocked/active (`render-view.ts:95-100`) | §3.1, §3.6 | "Vista active" | Cubierta |
| 3 | Sección Agents (`render-view.ts:131-137`) | §3.1 | "Vista active" | Cubierta |
| 4 | Sección Jobs, `toolCalls`/`lastTool` (`render-view.ts:159-166`) | §3.1 | "Vista active" | Cubierta |
| 5 | Vista idle + roster Models (`render-view.ts:196-209`) | §3.1, §3.5 | "Vista idle con roster" | Cubierta |
| 6 | Árbol de elementos `ViewNode` y materialización (`element-helpers.ts`, `tui.ts:49-70`) | §3.2 | — | Parcial (va en P1, sin fila) |
| 7 | Máquina de estados active/broken/idle (`compute-view.ts:20-36`) | §3.4 | idle/active/broken | Cubierta |
| 8 | Transiciones (idle↔active, active→broken, sesión creada/cerrada) | §3.4, §3.6 | `—` (solo en §6.7) | Ausente |
| 9 | Debounce 250 ms / heartbeat 2 s / poll 1 s (`constants.ts`, `mirror-manager.ts`, `tui.ts:165-189`) | §3.3, §6.3 | — | Ausente |
| 10 | Frescura snapshot 6 s (`mirror-io.ts:36-38`) | §3.3 | "Frescura 6 s" | Ausente en V2 (código muerto, A-05) |
| 11 | Frescura loop 120 s (`loop-reader.ts:108`) | §3.3 | "Frescura 120 s" | Cubierta |
| 12 | Caps MAX_AGENTS/MAX_JOBS 12 y LABEL_MAX 24 (`derivers.ts`, `render-view.ts:218-220`) | §3.3 | "Caps 12/12 y LABEL_MAX" | Cubierta |
| 13 | Redacción de goal activo → `private` (`snapshot-builder.ts:101-106`, `render-view.ts:222-224`) | §3.6 | "Redacción de goal activo" | Cubierta |
| 14 | Espejo: ruta/hash/projectDir canónico/escritura atómica 0600 (`mirror-path.ts`, `mirror-io.ts`) | §3.3, §3.8 | Parcial ("Frescura") | Parcial |
| 15 | Tema (`api.theme.current`, tokens) (`render-view.ts:14-23`, `tui.ts:162`) | §3.7 | — | Ausente |
| 16 | Agentes activos: status `busy|retry|running` (`snapshot-builder.ts:64-90`) | §3.5 | — | Parcial |
| 17 | Nombre del agente por último mensaje no-compactación (`session-last-agent.ts`) | §3.5, §3.6 | — | Ausente |
| 18 | Roster = tabla de resolución de modelos (agentes+categorías, orden, `sisyphus`/`deep-low`) (`roster-resolver.ts`) | §3.5 | "Vista idle con roster" | Parcial |
| 19 | Compuerta loop live (algún `in_progress`) (`loop-reader.ts:113`) | — | — | Ausente (A-09) |
| 20 | Ciclo de vida attach: servidor arranca mirror si `enabled !== false` (`create-managers.ts:199-205`) | §3.8 | — | Ausente |
| 21 | Dispose: tres rutas de `stop()` (`create-managers.ts:120,184`, `plugin-dispose.ts:28`) | §3.8 | "Dispose sin leaks" | Cubierta |
| 22 | Concurrencia: dedup de flush, heartbeat `unref()` (`mirror-manager.ts`) | §3.8 | — | Parcial |
| 23 | Reconexión inexistente + degradación a idle/broken | §3.8 | — | Parcial |
| 24 | Permisos: sin chequeos en el sidebar | §3.8 | n/a | n/a |
| 25 | Fallos parciales: degrada sin lanzar | §3.8 | Parcial (Vista broken) | Parcial |
| 26 | No interactivo: sin TUI, el servidor **sí** escribe el espejo (`qa/register-and-run.sh`) | §3.7 | "Flat install sin crash" + recibo headless | Parcial |
| 27 | Semántica de configuración: ON salvo `false` (`tui.ts:3-5`, `oh-my-opencode-config.ts:99`) | §3.9 (padre) / §6.2 (V2 OFF) | — | Ausente (A-01) |

---

## 4. PREGUNTAS DESCONOCIDAS (explícitas)

1. **¿Default-ON o default-OFF es el contrato exigido?** El padre y el catálogo de la bóveda dicen ON; el estado aceptado dice OFF. ¿Existe una decisión explícita de Gabo que autorice la reducción (exigida por `Principios_de_Migracion_V2.md:82`)? Si no existe, el plan debe restaurar el default-ON.
2. **¿Qué hago con el catálogo público** (`Catalogo_Funciones_OMR_V2.md:170`, "visible de fábrica")? ¿Actualizarlo a OFF o restaurar el código a ON? El plan solo propone tocar el ledger interno.
3. **¿Qué artefactos de la bóveda son autoritativos tras el revert?** ¿Se corrigen las notas de "validación cerrada" (A-02) o se reabren?
4. **¿Cómo se observa el slot en el laboratorio** si `opencode-v2-lab.service` es headless y "lanzar la TUI directa está prohibido"? ¿Basta el recibo durable como único seam autorizado para el slot (no solo para el recibo)?
5. **¿Cuál es la forma real del retorno de `context.ui.slot`** en el host (¿función de limpieza o `{dispose}`)? El adaptador cubre ambas; la doc solo muestra devolver la función. ¿Comportamiento confirmado en el lab?
6. **¿Está `solid-js` disponible como peer del host** (`>=1.9.0` según la doc) sin romper el modelo de peers? §2.4/P1 lo dejan "por evaluar".
7. **¿Es `context.data.session.status(sessionID)` por sesión o el mapa `session.status()` de V1?** La doc lista `session.status(sessionID)`; el adaptador actual enumera `session.list()`. Fuente real para agentes activos en cabeza.
8. **¿El snapshot de frescura 6 s debe existir en V2?** Si no hay canal de espejo, ¿se elimina `isSnapshotFresh`/`STALE_MS` o se conserva como paridad inerte documentada (A-05)?
9. **¿La sonda t25 se repara o se marca stale?** §P0 deja la elección abierta; la decisión determina si el gate positivo usa opt-in o si la sonda sale del conjunto activo.

---

## 5. ANEXO — Verificación puntual de citas (muestra)

Citas del plan **verificadas como exactas** (ruta/línea/símbolo):

- `tui.ts:22-27,35-47,49-70,120-197` (tipos, `registerSidebarContentSlot` con `order:900`/`sidebar_content`, `materialize`, módulo TUI). ✔
- `state-types.ts:55-64` (`SidebarView` active/broken/idle) y `:51-53` (`ConfigBanner`). ✔
- `constants.ts` (los 10 knobs, incluidos `STALE_MS=6000`, `LOOP_FRESH_MS=120000`, `POLL_INTERVAL_MS=1000`, `HEARTBEAT_MS=2000`, `WRITE_DEBOUNCE_MS=250`, `MAX_AGENTS=12`, `MAX_JOBS=12`, `LABEL_MAX=24`). ✔
- `compute-view.ts:20-36,31-33,35,57-59,38-123`. ✔
- `render-view.ts:14-23,67-76,95-100,126-137,154-166,187-194,196-209,211-216,222-224`. ✔
- `derivers.ts:23-32,45-54,56-65,14-21` (prioridad de jobs). ✔
- `loop-reader.ts:59-206,107-118,199-206`. ✔
- `mirror-io.ts:10-40,36-38` (0600, projectDir canónico, frescura). ✔
- `mirror-path.ts:8-31` (XDG + sha1 projectDir). ✔
- `mirror-manager.ts:42-136` (debounce/in-flight/heartbeat/stop). ✔
- `snapshot-builder.ts:55-90,92-99,101-106` (statuses, `toJobRow`, redacción). ✔
- `roster-resolver.ts:23-36,53-81`; `roster-resolver.test.ts:64-65` (`sisyphus` + `deep-low` por defecto). ✔
- `session-last-agent.ts:56,120` (salto de compactación). ✔
- `config/schema/tui.ts:3-11`; `config/schema/oh-my-opencode-config.ts:99`; `testing/create-plugin-module.ts:229` (`ensureTuiPluginEntry`). ✔
- `create-managers.ts:199-205` (mirror si `enabled !== false`); rutas de `stop()` en `create-managers.ts:120,184` **y** `plugin-dispose.ts:28` (tres rutas: §3.8 correcto). ✔
- `plugin/event.ts:135` (`managers.tuiStateMirror?.onEvent(event)`). ✔
- `rigel-v2-sidebar-core.mjs` (contrato puro: constantes, schema, `computeLoopLive`, `buildRuntimeSnapshot`, `computeView`/`viewKey`, `buildViewNodes`, `describeView`). ✔
- `rigel-v2-native-cli-sidebar.mjs:77-81,331-339,341-350,352-368` (gate `!== false`, `describeView` como render, registro del slot). ✔
- `rigel-v2-native-cli.mjs:48` (`=== true`). ✔
- `qa-v2-t25-live-surfaces.mjs:170` (`options: {}`) y `:246-249` (exige slot + recibo) → con default-OFF el positivo falla. **Confirmado por lectura.** ✔
- `V2_MIGRATION_INVENTORY.md:166` ("ausente = encendida") y `migration-classifications/features.mjs:182/186` (misma afirmación). ✔
- Baseline SHA-256 de los 5 archivos (§6.9/§10) = HEAD. ✔
- Línea temporal §2.1 = `git log --ancestry-path`. ✔
- `stash@{0}` = `ddea0b7d85caf734a819dcad3aae99db9aa3abad`, contenido declarado en §2.4 (`solid-js`/`createSignal`, `client.session.list()`, `state.config.agent[].model`, `test-env.ts` HOME/USERPROFILE). ✔ (leído sin aplicar)

Doc oficial `build/plugins/cli` (verificada en vivo): `context.ui.slot({ append|prepend|before|after|replace, render })` con `sidebar.content` entre los slots permitidos; `context.data.session.list/get/status`; `context.data.location.{agent,model}.list(location)`; `context.ui.model.current()`; `context.theme.text.base`; `context.renderer`; `peerDependencies` `solid-js >=1.9.0`, `@opentui/solid >=0.5.8`; retorno de limpieza desde `setup`. ✔ Coincide con §4.

---

**Firma:** Auditoría A (fidelidad histórica y contrato conductual) — revisión independiente, solo lectura.
No se autoaprueba: el veredicto es **NEEDS_CORRECTION** y requiere las correcciones de §2 antes de cualquier implementación. No se editó el plan, no hubo commit/push/PR.
