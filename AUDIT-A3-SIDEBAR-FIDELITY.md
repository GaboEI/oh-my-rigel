# AUDIT-A3-SIDEBAR-FIDELITY - Tercera auditoria A independiente (desde cero)

> **DRAFT / NO IMPLEMENTAR.** Auditoria de solo lectura. No se edito el plan, ni el handoff, ni codigo, ni la
> boveda, ni el stash. No hubo commit / push / PR. No se lanzo ningun proceso OpenCode. No se uso Docker. No se
> toco V1, NLS1, produccion ni secretos. No se delego a sub-agentes ni se uso orquestacion: la verificacion se
> hizo directamente contra fuentes primarias.

## 0. Alcance, metodo e independencia

- **Objetivos auditados:** `.omo/drafts/v2-sidebar-parity-reversible-plan.md` (677 lineas) y
  `HANDOFF-SIDEBAR-RESEARCH.md` (179 lineas) en el worktree
  `/home/gabodev/oh-my-rigel-worktrees/research-v2-sidebar-parity-plan`.
- **Independencia:** esta ronda **no** confio en `AUDIT-A-SIDEBAR-FIDELITY.md`, `AUDIT-A2-SIDEBAR-FIDELITY.md`, ni
  en las tablas de correccion (A-01..A-11, A2-01..A2-05). Se re-verifico todo contra fuentes primarias: codigo del
  padre (OmO), codigo del puerto V2, historial git (commits / revert / stash), ledger, seam de QA, boveda Obsidian
  y documentacion oficial de OpenCode V2. Los archivos de A y A2 existian en el worktree y se ignoraron
  deliberadamente.
- **Fuentes primarias usadas:** `packages/omo-opencode/src/**`; `profiles/gabo/**`; `git` (SHAs, `--stat`,
  `--numstat`, `cat-file`, `stash show`); boveda `/home/gabodev/Desktop/oh-my-rigel-vault` (solo lectura);
  `https://opencode.ai/v2/docs/build/plugins/cli`, `.../build/plugins/migrate-v1`, `.../migrate-v1/`.
- **Baseline:** rama `research/v2-sidebar-parity-plan`; `HEAD = 404a6290134d1704bb44eff7c092c161770f49e2` (Merge
  PR #19); `stash@{0} = ddea0b7d85caf734a819dcad3aae99db9aa3abad`. `git status` del arbol rastreado: limpio (los
  unicos untracked son los documentos de auditoria/handoff).

## 1. Veredicto

**PASS.**

Tras reconstruir el contrato historico y contrastarlo con fuentes primarias, **no se encontro reduccion del
contrato, afirmacion falsa material, gate inejecutable, ni omision material**. Las 27 capacidades estan
inventariadas y trazadas; el default-ON se conserva como objetivo (no se rebaja); los timers historicos quedan
honestamente en **Incognita/Bloqueada** con un gate T ejecutable; el seam hermetico CLI queda designado como
observador del recibo/slot/log y el laboratorio queda correctamente descrito como incapaz de cargar `./tui`; el
seam visual queda separado y no prometido; el inventario del stash es exacto; las rutas y hashes de baseline son
correctos.

Se registran **cinco observaciones menores** (F1..F5) y dos aclaraciones (N1, N2). Ninguna alcanza el umbral de
reduccion / falsedad material / gate inejecutable / omision material que exigiria FAIL. Se recomiendan como
refinamientos documentales, no como bloqueos.

## 2. Evidencia primaria verificada (reproducible)

Cada fila fue comprobada contra el artefacto real. "Observado" es lo que devolvio la fuente, no lo que afirma el
plan.

### 2.1 Historial git

| Afirmacion del plan | Fuente | Observado | Veredicto |
| --- | --- | --- | --- |
| `HEAD = 404a62901` (Merge PR #19) | `git rev-parse HEAD` | `404a6290134d1704bb44eff7c092c161770f49e2` | OK |
| Commits `c92e0a5e/a38e8431f/843983475/e434d1600/2e84941b2/6a46ed3ef/a4aefc291/c1351a3c7/5463a64ac/c2983037c` | `git show -s` | Todos existen con los mensajes citados; `843983475` es el merge de PR #12 (GaboEI) | OK |
| Revert `6a46ed3ef` = 24 archivos, `+85/-1779` | `git show --stat 6a46ed3ef` | `24 files changed, 85 insertions(+), 1779 deletions(-)` | OK (exacto) |
| Creados y luego borrados (ausentes en HEAD): `rigel-v2-sidebar-node.mjs` (+test), `rigel-v2-sidebar-theme.mjs` (+test), `v2-agent-selection-core.mjs` (+test) | `git cat-file -e HEAD:<ruta>` | Los 6 estan **ABSENT** en HEAD; aparecen en `--stat` del revert como `-54/-91/-44/-84/-66/-82` | OK |
| `notification-activation-config.mjs` y `.test.mjs` **existen** en HEAD y base; modificados por `2e84941b2` y revertidos en contenido por `6a46ed3ef` (no borrados) | `git cat-file -e HEAD:` y `63c529818:` | Ambos **EXISTS** en HEAD y base. `2e84941b2` numstat `+35/-1` (.mjs) y `+90/-0` (test) = `+125/-1` combinado; `6a46ed3ef` numstat `+1/-35` y `+0/-90` = `+1/-125` combinado | OK (A-07 confirmado) |
| `rigel-v2-native-runtime.mjs` **nunca** existio como modulo; su `.test.mjs` si | `git log --all -- <ruta>` + `cat-file` | `--all` vacio (nunca rastreado); `.test.mjs` EXISTS en HEAD | OK |
| `stash@{0} = ddea0b7d`, **ocho** archivos con numstat exacto | `git stash show --numstat stash@{0}` | Ver 2.2 | OK (exacto) |

### 2.2 Inventario del stash (ocho archivos, exacto)

`git stash show --numstat stash@{0}` devuelve **8 lineas**:

```
1   0    bun.lock
1   0    package.json
52  0    profiles/gabo/opencode/rigel-v2-native-agents.test.mjs
147 38   profiles/gabo/opencode/rigel-v2-native-cli-sidebar.mjs
113 5    profiles/gabo/opencode/rigel-v2-native-cli-sidebar.test.mjs
72  1    profiles/gabo/opencode/rigel-v2-native-runtime.test.mjs
4   1    profiles/gabo/opencode/rigel-v2-sidebar-node.mjs
6   0    test-env.ts
```

Coincide **exactamente** con la tabla §2.4 del plan (incluido `+147/-38` para `rigel-v2-native-cli-sidebar.mjs` y
`+4/-1` para `rigel-v2-sidebar-node.mjs`). La separacion de alcance (los tests `rigel-v2-native-agents.test.mjs` y
`rigel-v2-native-runtime.test.mjs` son de agentes/runtime, fuera del sidebar) es correcta y esta justificada.

### 2.3 Codigo del padre (OmO, V1) - contrato conductual

| Afirmacion | Fuente citada | Observado | Veredicto |
| --- | --- | --- | --- |
| Sidebar ON salvo `false` (semantica de config) | `config/schema/tui.ts:3-5`; `oh-my-opencode-config.ts:99`; `tui.ts:145` | `enabled: z.boolean().default(true)` (L4); `tui: TuiConfigSchema.default({ sidebar: { enabled: true } })` (L99); `config.tui?.sidebar?.enabled === false` -> return (tui.ts:145) | OK |
| Vistas `active\|broken\|idle` | `state-types.ts:55-64` | Union con `active`, `broken`, `idle` (L55-64) | OK |
| Sub-estados `Agents.none`/`Jobs.none`/`Roster.empty` | `state-types.ts:26-36` | `RosterState`/`AgentsState`/`JobBoardState` con `empty`/`none` (L26-36) | OK |
| Arbol raiz `active` = `box({flexDirection:"column", gap:1}, [...])` | `render-view.ts:29` | `box({ flexDirection: "column", gap: 1 }, [` (L29) | OK |
| `buildViewNodes` produce el arbol; `describeView` es solo de tests en el padre | `render-view.ts:211-216,29` | `buildViewNodes` esta en **L25**, `describeView` en **L45**; 211-216 es el helper `section()`. Uso runtime: `tui.ts:162` usa `buildViewNodes`; `describeView` solo aparece en `render-view.test.ts` | Ver F1 (cita imprecisa; conducta correcta) |
| Banner de config invalida | `render-view.ts:67-76` | `return [text({ fg: theme.warning }, "config invalid - run doctor")]` (L72) | OK |
| ULW / goals / pass / fail / pending-blocked / active-private | `render-view.ts:95-100,222-224` | L95 `section("ULW",...)`; L96 `goals {done}/{total}`; L97 `pass N`; L98 `fail N`; L99 `pending N blocked N`; L100 `active ...`; L222-224 `activeGoal ?? "private"` | OK |
| Compuerta loop "live" = fresco **y** algun `in_progress` | `loop-reader.ts:107-115` | `if (parsed === null \|\| !parsed.goals.some((goal) => goal.status === "in_progress")) {` (L113) | OK |
| `computeView` active/broken/idle | `compute-view.ts:20-36,57-59` | L20-36 la seleccion; `isActive` en L57-59 = `agents.kind==="list" \|\| jobs.kind==="list" \|\| loop.kind==="live"` | OK |
| Constantes centralizadas | `constants.ts` | `MIRROR_DIR_NAME="tui-state"` L1; `STALE_MS=6_000` L3; `LOOP_FRESH_MS=120_000` L4; `POLL_INTERVAL_MS=1_000` L5; `HEARTBEAT_MS=2_000` L6; `WRITE_DEBOUNCE_MS=250` L7; `MAX_AGENTS=12` L8; `MAX_JOBS=12` L9; `LABEL_MAX=24` L10 | OK |
| Espejo: ruta/hash/projectDir/escritura atomica 0600 | `mirror-path.ts:8-31`; `mirror-io.ts:10-40` | `mirrorStorageDir()` = `$XDG_DATA_HOME/opencode/storage/oh-my-openagent/tui-state`; `mirrorFilePath()` = `sha1(canonicalProjectDir).slice(0,16)+".json"`; `writeMirror` -> `writeFileAtomically(..., {mode:0o600})`; `readMirror` valida JSON, schema, projectDir canonico y `STALE_MS` | OK |
| Compuerta attach del mirror: servidor arranca si `enabled !== false` | `create-managers.ts:199-205` | `if (pluginConfig.tui?.sidebar?.enabled !== false) {` (L199) | OK |
| Dispose: tres rutas de `stop()` | `create-managers.ts:120,184`; `plugin-dispose.ts:28` | `tuiStateMirror?.stop()` en L120, L184, L28 | OK |
| Flush por evento | `plugin/event.ts:135` | `managers.tuiStateMirror?.onEvent(event);` (L135) | OK |
| Nombre de agente por ultimo mensaje no-compactacion | `hooks/atlas/session-last-agent.ts:56,73-141` | `getLastAgentFromSession` en L73; salto de compactacion en L56 (`deps.isCompactionMessage(message)`) | OK |
| Roster = tabla de resolucion de modelos (agentes + categorias) | `roster-resolver.ts:53-81,68-81` | `resolveRoster()` en L68; `[...resolution.agents, ...resolution.categories].map(toRosterRow).sort(...)` L72-74 | OK (cita 23-36 = ver F5) |

### 2.4 Puerto V2 y divergencia de default

| Afirmacion | Fuente citada | Observado | Veredicto |
| --- | --- | --- | --- |
| Composer gate `=== true` (OFF por defecto en dev/canario) | `rigel-v2-native-cli.mjs:48` | `const sidebarEnabled = context?.options?.tui?.sidebar?.enabled === true` (L48); superficie agregada solo si `sidebarEnabled` (L54) | OK |
| Superficie gate `!== false` (ausente = ON) | `rigel-v2-native-cli-sidebar.mjs:77-81` | `resolveSidebarGate`: `if (isObject(sidebar) && sidebar.enabled === false) return null; return { enabled: true }` (L77-81) | OK |
| Doble gate contradictorio | `cli.mjs:48` vs `cli-sidebar.mjs:77-81` | Composer `=== true` y superficie `!== false`, ambos leyendo `context.options` | OK (ver N1) |
| `describeView` como `render` por defecto (texto plano = causa del crash) | `rigel-v2-native-cli-sidebar.mjs:331-334,341-345` | L331-334 `renderView` devuelve `describeView(view)` por defecto; L341-345 `render` -> `renderView(view)` | OK |
| Slot `context.ui.slot({append:"sidebar.content", render})` | `:352-368` | L353 `context?.ui?.slot`; L356 `slot({ append: SIDEBAR_SLOT_APPEND, render })`; `SIDEBAR_SLOT_APPEND="sidebar.content"` (L53); evento `slot-registered`/`slot-register-failed`/`headless-receipt-only` L359/361/367 | OK |
| Recibo durable 0600 | `:306-316` | `writeReceipt` -> `writeFileSync(snapshotPath, JSON.stringify(receipt), { mode: 0o600 })` (L310) | OK |
| Suscripcion a eventos (sin temporizadores) | `:374-393` | `subscribe(name)` usa `context.data.on(name, () => refresh())`; eventos `session.created/deleted/updated/execution.*` (L374-393) | OK |
| Superficie V2 sin temporizadores | (afirmado en §6.3) | `grep setInterval\|setTimeout\|heartbeat\|debounce` en `rigel-v2-native-cli-sidebar.mjs` y `rigel-v2-sidebar-core.mjs` = **NONE** | OK |
| `isLoopFresh` en uso | `sidebar.mjs:44,239` | Importado L44; usado L239 `if (!isLoopFresh(candidate.mtimeMs, now)) return null` | OK |
| Lectura de datos actual (HEAD) | `:186-196`, `:128-133` | `readRosterRows` -> `[data.roster, data.agents, data.models]` (L189); `readSessions` -> `data.session?.list?.()` (L129) | OK (ver F4) |
| Fallback `ui.slots.register` en btw | `rigel-v2-native-cli-btw.mjs:246-248` | `if (slots && typeof slots.register === "function") {` (L247) | OK |
| Tests del adaptador usan contexto falso | `rigel-v2-native-cli-sidebar.test.mjs:12-43` | `createFakeContext({...})` (L12-43), no reproduce el host | OK |

### 2.5 Ledger

| Afirmacion | Fuente citada | Observado | Veredicto |
| --- | --- | --- | --- |
| Fila `tui-sidebar` dice "ausente = encendida" | `V2_MIGRATION_INVENTORY.md:166` | "se migra bajo la clave `tui.sidebar.enabled` (**ausente = encendida**; false = inerte)" | OK |
| Clasificacion duplicada en `features.mjs` | `migration-classifications/features.mjs:186-187` | L186 idem "ausente = encendida"; L187 `futureEvidence` con los 4 modulos | OK |
| Contradiccion ledger (ausente=ON) vs codigo (OFF dev/canario) | §2.5 | Confirmada: ledger dice ausente=ON; composer exige `=== true` | OK |

### 2.6 Seam de QA y laboratorio

| Afirmacion | Fuente citada | Observado | Veredicto |
| --- | --- | --- | --- |
| `opencode-v2-lab.service` corre `opencode serve`, headless, **no** construye el contexto de plugin CLI ni carga `./tui` | `qa-v2-t25-live-surfaces.mjs:4-12`; `evidencias/2026-10-08-fase-6-tarea-25.md:45` | Cabecera L4-12: "a headless `opencode serve` cannot exercise... the companion `./tui` entrypoint is not loaded there". Boveda L45: "ese servicio es headless y no construye el contexto de plugin CLI (el companion `./tui` solo lo carga el renderer/TUI)" | OK |
| Seam hermetico: contexto CLI real + `setup()` real, sin proceso OpenCode, state roots temporales | `:171-186`, `:211`, `:43-52` | `context = { options:{}, renderer, location, data:{on,session}, ui:{slot,...}, keymap, attention }` (L171-186); `const dispose = plugin.setup(context)` (L211); `fs.mkdtempSync(...)` + XDG al sandbox (L43-52) | OK |
| Recibo + slot capturados; negativo de gate | `:246-247`, `:248-249`, `:268-278` | L246-247 asercion de slot `sidebar.content`; L248-249 lectura del recibo `sidebar-snapshot.json`; L268-278 contexto con `enabled:false` -> `gatedSlots.length===0` | OK |
| t25 "stale": exige el slot con `options:{}` y hoy fallaria | `:172,246-247` vs `cli.mjs:48` | `options: {}` (L172) -> composer gate `undefined === true` = false -> no se registra el slot -> la asercion L247 falla | OK |
| Refresco del lab por `apply-v2-runtime-service.sh` | script | Existe; refresca `opencode-v2-lab.service` via `systemctl --user` y `materialize-v2-cli.mjs`; "never addresses opencode-lan.service" | OK |
| `run-lab-acceptance.sh` valida el lab | script | Existe; lee `ExecStart` del servicio y valida aislamiento | OK |

### 2.7 Boveda (fuente primaria de producto)

| Afirmacion | Fuente citada | Observado | Veredicto |
| --- | --- | --- | --- |
| Catalogo: sidebar "Migrada / Activada / Automatico - viene visible de fabrica" | `Catalogo_Funciones_OMR_V2.md:170` | "Barra lateral... Migrada \| Activada \| Se puede ocultar. \| Automatico - viene visible de fabrica. Ajuste - `tui.sidebar.enabled: false` la oculta." | OK |
| Principios: nunca reducir el contrato; ausencia de mecanismo no vuelve opcional; no sustituir por mocks/no-ops; excepcion solo por Gabo | `Principios_de_Migracion_V2.md:14,20,58,82` | L14 "Nunca reducir el contrato funcional."; L20 "La ausencia del mecanismo original en V2 no convierte la funcionalidad en opcional."; L58 "sustituir comportamiento real por prompts, mocks, no-ops..."; L82 "Toda excepcion requiere una decision explicita de Gabo" | OK |
| Boveda afirma sidebar "cerrado e integrado" (a reconciliar) | `Mantenimiento_OMR_MOC.md:73`; `Contrato_Ejecucion_Independencia_Repositorio_OMR.md:53`; `evidencias/2026-10-11-pausa-independencia-repositorio.md:48` | L73 "Validacion V2 del sidebar cerrada e integrada"; L53 "Validacion V2 cerrada e integrada (2026-10-11)"; L48 "Validacion V2 cerrada e integrada" | OK |
| Evidencia del intento: INTEGRADA, `843983475`, TUI 200x50, suite 2301, "sidebar preservado: vistas idle, active y broken" | `evidencias/2026-10-11-correccion-sidebar-tui-v2.md` | `estado: INTEGRADA`; L22 commit `843983475...`; L28 "TUI real aislada... 200x50"; L31 "Suite final: `bun test profiles/gabo` - 2301"; L23 "Sidebar preservado: vistas idle, active y broken; secciones, colores, limites y diseno de V1." | OK |

### 2.8 Documentacion oficial OpenCode V2

| Afirmacion | Observado en doc oficial | Veredicto |
| --- | --- | --- |
| Slot `sidebar.content` permitido; `append/prepend/before/after/replace` | Doc `build/plugins/cli` > Slots: lista `... sidebar.content, sidebar.footer` y los 5 placements | OK |
| `context.ui.slot({ append, render })` | Doc: ejemplo `context.ui.slot({ append: "sidebar.content", render: ... })` | OK |
| Datos: `context.data.session.list/get/status`, `context.data.location.{agent,model}.list(location)` | Doc: `context.data.session.list/get/root/family/cost/status`; `context.data.location.agent.list(location)`, `...model.list(location)` | OK |
| Tema semantico `context.theme.text.base` | Doc > Theme and renderer: `<text fg={context.theme.text.base}>` | OK |
| Renderer `context.renderer` | Doc: `const renderer = context.renderer` | OK |
| `context.keymap`, `context.attention` | Doc: secciones "Commands and keymaps" y "Attention" | OK |
| `context.app.version` / `context.app.channel` (telemetria, no gate unico) | Doc > Context: `context.app.version`, `context.app.channel` | OK |
| `context.ui.model.current()` | Doc > Model: `const selected = context.ui.model.current()` | OK |
| `./tui` + `cli.json` | Doc > Publish and load: `exports["./tui"]` y `cli.json { "plugins": [...] }` | OK |
| `setup` devuelve funcion de limpieza | Doc migrate-v1: "Return a cleanup function for resources owned by the plugin" | OK |
| `context.rpc` **no** confirmado | Doc: sin resultados para `context.rpc` | OK (el comentario del modulo coincide) |

### 2.9 Hashes de baseline (§6.9)

Los cinco `sha256` del plan coinciden **byte a byte** con los archivos en HEAD:

```
a15f4ea2... rigel-v2-native-cli-sidebar.mjs      OK
20d8a659... rigel-v2-native-cli-sidebar.test.mjs OK
10785b83... rigel-v2-sidebar-core.mjs            OK
3b3197c8... rigel-v2-sidebar-core.test.mjs       OK
e96566ea... rigel-v2-native-cli.mjs              OK
```

## 3. Cobertura de los puntos exigidos por el contrato

| Punto exigido | Donde vive | Evidencia primaria | Veredicto |
| --- | --- | --- | --- |
| Default-ON como objetivo final, OFF en dev/canario | §0, §2.5, §3.9, §6.1, §6.2, §6.4 (P0 + P5), §6.10 fila 27 | Padre `default(true)` (schema L4; tui.ts:145) + catalogo boveda:170 (ON objetivo) vs composer `=== true` (OFF dev/canario). No se rebaja el contrato | OK |
| Reconciliacion de boveda | §2.6 (artefacto por artefacto) + §6.4 P0 | Los 5 artefactos citados existen y dicen lo citado; boveda **no editada** | OK |
| 27 capacidades y transiciones | §6.10 (filas 1..27) + §3 + §7A | Conteo programatico: **27** filas; incluye fila 8 (transiciones) y fila 27 (semantica de config) | OK |
| Seam hermetico CLI como unico observador de recibo/slot/log; lab no carga `./tui` | §0, §6.4 P3, §6.5, §6.6, §6.10 nota, §7C | `qa-v2-t25-live-surfaces.mjs` (contexto+`setup()`+recibo+slot+negativo) y boveda `fase-6-tarea-25.md:45` (lab headless, sin companion) | OK |
| Seam visual separado y no observado | §6.6, §7C, filas 6 y 15 "Seam visual" | No se promete pixeles en el lab ni se lanza la TUI directa | OK |
| Timers historicos marcados Incognita/Bloqueada con gate T ejecutable | §6.3, §6.4 P3 (gate T), §6.7, §6.10 fila 9 | `grep` de temporizadores en la superficie/core = NONE; fila 9 = "Incognita/Bloqueada"; gate T usa el mismo seam con reloj inyectable (`overrides.now`) | OK |
| Inventario exacto de ocho archivos del stash | §2.4 | `git stash show --numstat stash@{0}` = 8 lineas, cifras identicas | OK |
| Rutas/citas completas | §1..§6 | 60+ citas verificadas; 5 imprecisiones menores (F1..F5) | OK (con observaciones) |
| Aislamiento absoluto respecto a delegacion y orquestacion | §6.1, §6.2, §8; ejecucion de esta auditoria | Ver §4 | OK |

## 4. Aislamiento respecto a delegacion y orquestacion

- **Ejecucion de esta auditoria:** verificacion directa, sin sub-agentes, sin team-mode, sin orquestacion. No se
  lanzo ningun proceso OpenCode; no se uso Docker; no se toco V1 / NLS1 / produccion / secretos. Toda lectura de
  boveda fue solo-lectura y sin copiar secretos.
- **Aislamiento en el plan:** `§6.1` prohibe tocar V1, NLS1, produccion, secretos, Docker/contenedores,
  `run`/`serve`/`--standalone` directos y autoaprobar; `§6.2` fija **dueño unico** (un solo compositor y una sola
  superficie, sin segundo camino de registro); `§2.4`/`§8` mantienen el trabajo del sidebar separado de la tarea
  paralela de modelos (`rigel-v2-native-agents.test.mjs` / `rigel-v2-native-runtime.test.mjs` fuera de alcance).
  La unica via de ejecucion viva es el laboratorio via `apply-v2-runtime-service.sh`, y el seam hermetico no
  lanza procesos.
- **Observacion de vocabulario:** ni el plan ni el handoff usan literalmente la palabra "delegacion" u
  "orquestacion"; el aislamiento queda cubierto materialmente por §6.1/§6.2/§8 y la regla de dueño unico. No hay
  omision material, pero una mencion explicita reforzaria la trazabilidad.

## 5. Hallazgos

Ninguno bloquea el veredicto PASS. Se listan con severidad y recomendacion.

| ID | Sev. | Hallazgo | Evidencia | Impacto | Recomendacion |
| --- | --- | --- | --- | --- | --- |
| F1 | BAJA (cita) | §3.2 cita `render-view.ts:211-216` para la afirmacion sobre `buildViewNodes`/`describeView`, pero 211-216 es el helper `section()`. | `buildViewNodes` esta en L25; `describeView` en L45; L211-216 = `function section(...)` | La conducta afirmada es correcta (padre usa `buildViewNodes` en `tui.ts:162`; `describeView` solo en tests del padre). Solo la cita esta desalineada | Corregir a `render-view.ts:25,45` (y mantener `:29` para `gap:1`) |
| F2 | BAJA (precision) | §7C usa "Cubre:" y enumera fault-injection, flat install, mutaciones RED/restore y gate T como cobertura del seam. El `qa-v2-t25-live-surfaces.mjs` actual implementa slot + recibo + negativo de gate + dispose (mas superficies no-sidebar), pero **no** esos cuatro items. | `qa-v2-t25-live-surfaces.mjs` (todo el archivo) vs §6.4 P3 / §6.7 | Riesgo de lectura: un revisor de C podria creer que el artefacto ya prueba esos items. No es falsedad sobre el presente porque §6.4/§6.7 los enmarcan como **requeridos/propuestos** de P3/P4 | Reformular a "P3 debera cubrir:" o "Cubrira:" |
| F3 | BAJA (cifras) | §2.2 etiqueta como reducciones los conteos `--stat` (cambios totales) de modulos supervivientes: `cli-sidebar.mjs (-334)`, `sidebar-core.mjs (-63)`, `doctor.mjs (-126)`. | `git show --numstat 6a46ed3ef`: `+46/-288`, `+1/-62`, `+7/-119` | Los totales 334/63/126 son insertions+deletions; el signo negativo sugiere solo borrados. El total del revert (24 archivos, +85/-1779) si es exacto | Escribir el par `+/-` real por archivo |
| F4 | BAJA (cita) | §4 escribe `data.session.list()` y `context.ui.slot({append:"sidebar.content", render})`; el codigo usa encadenamiento opcional y la constante. | `cli-sidebar.mjs:129` `data.session?.list?.()`; `:53` `SIDEBAR_SLOT_APPEND = "sidebar.content"` | Equivalente semantico; solo precision de cita | Anotar el encadenamiento opcional / la constante |
| F5 | INFO (cita) | §3.1 cita `roster-resolver.ts:23-36` para la tabla de resolucion (agentes+categorias); ese rango es `formatModelLabel`/`toRosterRow`. | L23-29 `formatModelLabel`; L31-36 `toRosterRow`; la resolucion esta en L53-72 (ya citada como 53-81/68-81) | Ninguno; la fila tambien cita 53-81 y 68-81 correctamente | Opcional: ajustar 23-36 a "formato de etiqueta" |

**Aclaraciones (no defectos):**

- **N1 - Doble gate (real y bien senalado).** El composer usa `=== true` (`cli.mjs:48`) y la superficie usa
  `!== false` (`cli-sidebar.mjs:77-81`), ambos leyendo `context.options`. Como el composer es la unica via de
  instanciacion, el default efectivo es OFF; el `!== false` de la superficie es latente. El plan lo registra como
  contradiccion a reconciliar (P0/P5), lo cual es correcto.
- **N2 - Gate T y seam visual son propuestas, no ejecutadas.** El plan los define como P3/P4 y no afirma haberlos
  ejecutado. La ejecucion del gate T es viable dentro del aislamiento (seam in-process con reloj inyectable); el
  seam visual permanece **no observado**, como corresponde.

## 6. Limites y lo no verificado

- No se ejecuto ningun gate (T, suite, flat install, mutaciones) porque el contrato prohibe implementacion y el
  plan es DRAFT; esta auditoria es de **fidelidad documental y de citas**, no de ejecucion de runtime.
- No se reprodujo el crash ni el revert; se auditaron por lectura de codigo e historial, que es suficiente para
  la causa declarada (texto plano a `sidebar.content`).
- El seam visual (pixeles/render) queda fuera de alcance por diseno y se marca no observado.
- No se edito la boveda; solo se leyo y se contrastaron las lineas citadas.

## 7. Conclusion

El plan y el handoff resisten una tercera revision independiente desde cero: el contrato historico esta
completamente reconstruido, las 27 capacidades trazadas, el default-ON conservado como objetivo, la boveda
reconciliada artefacto por artefacto (sin editarla), el seam hermetico CLI correctamente designado como unico
observador del recibo/slot/log, el laboratorio honestamente descrito como incapaz de cargar `./tui`, el seam
visual separado, los timers en Incognita/Bloqueada con gate T ejecutable, y el stash inventariado con precision
de byte. Las cinco observaciones son de cita/precision y no constituyen reduccion, falsedad material, gate
inejecutable ni omision material.

**Veredicto: PASS.**

Esta auditoria **no se autoaprueba** como autoridad final: A3 es una revision A independiente. La aprobacion de
release (P5) sigue requiriendo las revisiones independientes A + B + C y gates reales, segun §6.4.

## 8. Limites de acceso y estado del repositorio

- `git status`: solo untracked `AUDIT-A-SIDEBAR-FIDELITY.md`, `AUDIT-A2-SIDEBAR-FIDELITY.md`,
  `HANDOFF-SIDEBAR-RESEARCH.md` (documentos de auditoria/handoff). Sin cambios en codigo rastreado.
- Sin commit / push / PR. Sin procesos OpenCode lanzados. Sin Docker. V1 / NLS1 / produccion / secretos intactos.
- Boveda leida en solo-lectura; no editada; sin copiar secretos. Plan y handoff **no** editados. Stash **no**
  aplicado.
- Unico proceso permitido si se autoriza canario: `opencode-v2-lab.service` via `apply-v2-runtime-service.sh`
  (no usado en esta auditoria).
