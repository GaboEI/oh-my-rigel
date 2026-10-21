# HANDOFF — Regresión de delegación V2 (corrección JSON-only + gate vivo en laboratorio)

Estado: **corregido en el working tree y verificado en el laboratorio V2**. Sin commit / push / PR / despliegue.
Rama: `fix/v2-delegation-regression` (worktree `oh-my-rigel-worktrees/fix-v2-delegation-regression`).
Base `dev` = `10e62d871` (merge PR #20); baseline sano = `404a62901`.

> NLS1 NO se tocó. El gate vivo de NLS1 es del mantenedor (procedimiento en §7). Aquí solo se corrió el
> laboratorio autorizado `opencode-v2-lab.service`; nunca V1, nunca Docker.

## 1. Hallazgo obligatorio (esta ronda)

`resolveEffectiveChain` (`profiles/gabo/opencode/rigel-v2-native-explicit-chain.mjs`) devolvía
`agentChain(agent)` —la cadena canónica incrustada en el código— cuando el agente **no** tenía
override JSON. Eso hacía que el reintento reactivo caminara una cadena que el usuario nunca escribió
(`switchModel` a un rung canónico), y que un agente sin entrada no heredara limpio el global.

Corrección: `~/.omo/omo.jsonc` es la **única** fuente runtime. Agente sin entrada, o con entrada
vacía (sin `model` ni `fallback_models`), devuelve **cadena efectiva vacía** → hereda el global.
Sin manifiesto y sin cadena canónica incorporada.

## 2. Causa raíz compuesta de la delegación rota (PR #20 + NLS1)

1. **Cadena canónica en runtime** (§1): `resolveEffectiveChain` usaba `agentChain`.
2. **Siembra incompleta** (`rigel-v2-user-install.mjs`): PR #20 sembró sólo el primer modelo por
   agente en `~/.omo/omo.jsonc` (sin cadena ordenada).
3. **`session.create` NO aplica `Agent.Info.model`** (probado vivo, §5): crear una sesión para
   `agent: explore` sin `model` explícito **no** pone `model`. Por eso el manifold del registro
   (`agent.transform`) por sí solo no basta; el Model.Ref **debe** pasar explícito en
   `session.create` (lo hace `delegateNamedAgent`).
4. **El proceso lee el JSON una sola vez en `setup`**: editar `~/.omo/omo.jsonc` sin reiniciar NO
   cambia nada (control §5). Si NLS1 editó `/root/.omo/omo.jsonc` sin reiniciar (o con un HOME del
   servicio distinto), los hijos corrieron el global (`exo-free`).

## 3. Corrección (diff mínimo)

| Archivo | Cambio |
| --- | --- |
| `profiles/gabo/opencode/rigel-v2-native-explicit-chain.mjs` | `resolveEffectiveChain`: la rama de agente devuelve `[]` (JSON-only); elimina el import y el uso de `agentChain`. Encabezado reescrito. |
| `profiles/gabo/opencode/rigel-v2-native-agents.mjs` | `resolveProactiveAgentModels`: `agentChain(id)` y el `model` del manifiesto se calculan **sólo** en la rama `chainFallback:true` (legacy). El runtime pasa `chainFallback:false`, así que ninguna ruta de registro evalúa la cadena canónica ni el modelo del manifiesto. |
| `profiles/gabo/opencode/rigel-v2-native-models-command.mjs` | `/rmo-models` ahora dice explícitamente que **el reinicio es obligatorio**, que el `Target file` se resuelve desde el HOME del proceso del plugin (editar otro `~` no tiene efecto), y añade el paso 9 "RESTART IS REQUIRED". |
| Tests | Ver §4. |

Semántica resultante para un agente delegado:
- Cadena JSON → el hijo arranca en el **primer rung alcanzable** (`model` → `fallback_models`, en orden).
- Entrada vacía / sin rung alcanzable → el hijo **hereda el global** (sin `model`), y el reintento
  reactivo no llama `switchModel` (cadena efectiva vacía).
- Datos de manifiesto (`agent.model`, `record.chain`) y `agentChain`/`categoryChain` se usan **sólo**
  en instalación limpia para sembrar JSON. (Las categorías no cambian: usan su propia ruta.)

No se tocó: `rigel_task`, prompts, routing, permisos, categorías, continuidad, background handoff,
Hephaestus (conserva la desaparición segura si la config efectiva no es OpenAI), override de sesión.

## 4. Pruebas herméticas (focused) — 267 pass / 0 fail

```
bun test --timeout 240000 \
  profiles/gabo/opencode/rigel-v2-native-explicit-chain.test.mjs \
  profiles/gabo/opencode/rigel-v2-native-agents.test.mjs \
  profiles/gabo/opencode/rigel-v2-native-runtime.test.mjs \
  profiles/gabo/opencode/rigel-v2-native-delegation-chain.test.mjs \
  profiles/gabo/opencode/rigel-v2-native-core.test.mjs \
  profiles/gabo/opencode/rigel-v2-native-model-chains.test.mjs \
  profiles/gabo/opencode/rigel-v2-native-models-command.test.mjs \
  profiles/gabo/opencode/rigel-v2-native-categories.test.mjs \
  profiles/gabo/opencode/rigel-v2-native-prompt.test.mjs \
  profiles/gabo/opencode/rigel-v2-native-hephaestus.test.mjs \
  profiles/gabo/rigel-v2-user-install-config-bootstrap.test.mjs \
  profiles/gabo/rigel-v2-user-install-manifest.test.mjs \
  profiles/gabo/build-target-agent-manifest.test.mjs
# -> 267 pass / 0 fail
```

### Pruebas mutantes (fallan en el código pre-fix por la razón buscada)

Con `resolveEffectiveChain` revertido a `agentChain(agent)` (pre-fix), 4 casos fallan (RED):
- `an explicit agent model suppresses the built-in chain`
- `an agent with no JSON override inherits the global (empty chain, canonical chain never consulted)`
- `an agent with an empty JSON entry inherits the global (empty chain)`
- `empty JSON: no Model.Ref reaches session.create and switchModel is never called (decoy canonical chain ignored)`
Con el fix: GREEN.

- **Manifiesto + chain señuelo**: `rigel-v2-native-agents.test.mjs` extiende su fixture con `model`
  y `chain` señuelo + `oracle` (que tiene cadena canónica) → `chainFallback:false` NO produce ref.
- **JSON vacío ⇒ sin `Model.Ref` y `switchModel` nunca llamado**: `rigel-v2-native-delegation-chain.test.mjs`
  con `switchModel` spy + feed de eventos; inventario que **sirve** la cabeza canónica (kimi) para que
  el mutante pre-fix sí llamara `switchModel`. Post-fix: `switchModel` = `[]`.
- **Control sin reinicio** (`control: an edit after setup is NOT observed until restart`): el plugin lee
  el JSON en `setup`; editar después no se observa. Documenta el comportamiento real.
- Tests reactivos ahora **siembran la cadena por JSON** en un HOME sandbox (`withLiveAgentConfig`),
  eliminando además la dependencia del `~/.omo/omo.jsonc` real del desarrollador.

## 5. Gate vivo en el laboratorio (`opencode-v2-lab.service`) — PASS

HOME efectivo del servicio (unit): `Environment=HOME=/home/gabodev/.local/share/opencode-v2-lab/home`.
Se desplegó el fix con el refresco oficial `profiles/gabo/apply-v2-runtime-service.sh` (V1 no fue
tocado) y se condujo el servidor real por su API (`http://127.0.0.1:4097`, auth Basic desde el
`secret.env` del laboratorio; sin exponer secretos). Evidencia cruda en
`.omo/evidence/20261012-v2-model-propagation/`.

| Caso | JSON `agents.explore` | Reinicio | Hijo real (rigel_task) `info.model` | Veredicto |
| --- | --- | --- | --- | --- |
| A (sync) | `{model:"opencode-go/qwen3.7-plus",variant:"max"}` | sí | `{qwen3.7-plus, opencode-go, max}` (corrió: cost/tokens) | PASS |
| Control sin reinicio | se editó a B, **sin** reiniciar | no | `{qwen3.7-plus, opencode-go, max}` (= A) | PASS (no recarga) |
| B (sync) | `{model:"opencode-go/glm-5.3",variant:"high"}` | sí | `{glm-5.3, opencode-go, high}` | PASS |
| B (background) | idem, `run_in_background=true` | sí | `{glm-5.3, opencode-go, high}` | PASS |
| Cadena A→fallback B | `{model:"opencode-go/does-not-exist-free", fallback_models:["opencode-go/glm-5.3(high)"]}` | sí | `{glm-5.3, opencode-go, high}` | PASS |
| Campo vacío | `{agents:{explore:{}}}` | sí | hijo **sin** `model` (global) | PASS |
| Registro (no delegación) | `{model:A}` + `session.create {agent:explore}` sin model | sí | **sin** `model` → el host ignora `Agent.Info.model` | informativo |

Roster tras el refresco: 18 agentes presentes, sin pérdidas —
`Atlas - Plan Executor, Metis - Plan Consultant, Momus - Plan Critic, Prometheus - Plan Builder,
Sisyphus - ultraworker, Sisyphus-Junior, build, compaction, explore, forja, general, judge, librarian,
multimodal-looker, oracle, plan, summary, title`.

Respuesta vuelve al padre: las delegaciones **sync** completaron con el hijo ejecutado (cost/tokens) y
el padre continuó su turno con el resultado del tool. Se probó `explore` (sync+background). **Pendiente
en NLS1**: `librarian`, `oracle`, `Sisyphus-Junior` y Hephaestus según su regla OpenAI (§7).

Nota de no-determinismo: la delegación la dispara el modelo; ocasionalmente el padre no llama
`rigel_task` a la primera. Los casos de arriba se obtuvieron con un prompt imperativo; el fallo de
"sin hijo" no es del fix (los casos canónicos sí crearon hijo).

El laboratorio se restauró a su estado previo (se eliminó el `omo.jsonc` de prueba; servicio `active`).

## 6. Aislamiento y límites

- Sin Docker, sin V1. `apply-v2-runtime-service.sh` (ruta sancionada) y `systemctl --user restart
  opencode-v2-lab.service` (reinicio soportado del mismo servicio). Nada fuera del laboratorio.
- Los secretos del laboratorio (`secret.env`) se leyeron en shell y nunca se imprimieron.
- No se ejecutó NLS1.

## 7. Procedimiento NLS1 (REVERSIBLE) — para el mantenedor, NO ejecutado aquí

> Autorizado: deshabilitar/desinstalar temporalmente el plugin activo, instalar la corrección como
> usuario real y reiniciar OpenCode. **Nunca imprimir la key de OpenCode Go.** Todo el procedimiento
> es reversible con snapshot + checksums y rollback por el instalador oficial.

### 7.0 Parámetros (ajustar en NLS1)
```
REPO=<ruta del checkout oh-my-rigel>      # p.ej. ~/oh-my-rigel
BRANCH=fix/v2-delegation-regression        # o el PR una vez publicado
OMO=~/.omo
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SNAP=$OMO/rigel-gate-$STAMP
```

### 7.1 Snapshot + checksums (antes de tocar nada)
```
mkdir -p "$SNAP"
[ -f "$OMO/omo.jsonc" ] && cp -a "$OMO/omo.jsonc" "$SNAP/omo.jsonc.pre" || echo "no prior omo.jsonc" > "$SNAP/omo-absent.txt"
printf 'HOME=%s\nUSER=%s\n' "$HOME" "$(id -un)" > "$SNAP/context.txt"
{ cd "$OMO" 2>/dev/null && find . -maxdepth 3 -type f ! -path './rigel-gate-*' -exec sha256sum {} \; ; } | sort > "$SNAP/CHECKSUMS-pre.txt"
# roster/estado del plugin previo (según el instalador usado):
<comando-de-estado-del-plugin> > "$SNAP/roster-pre.txt" 2>&1 || true
sha256sum "$SNAP/omo.jsonc.pre" >> "$SNAP/CHECKSUMS-pre.txt" 2>/dev/null || true
```
Verify: `sha256sum -c "$SNAP/CHECKSUMS-pre.txt"` (desde `$OMO`).

### 7.2 Desinstalar/deshabilitar el plugin activo (oficial)
```
# Desinstalación oficial del producto (elige la que use NLS1):
bunx oh-my-openagent cleanup      # o: bunx oh-my-openagent uninstall
# y/o deshabilita/retira la entrada de plugin en la config activa de OpenCode.
```
Registra el mismo comando en `$SNAP/roster-pre.txt` con su salida.

### 7.3 Instalar la corrección como usuario real
```
git -C "$REPO" fetch origin
git -C "$REPO" checkout "$BRANCH"
script/agent/setup.sh             # único punto de setup (bun install + build)
bash "$REPO/profiles/gabo/validate-profile.mjs"
# Instalación según OH-MY-RIGEL.md (ruta de instalación desde fuente):
<instalar-plugin-del-checkout>
```

### 7.4 Primer arranque + roster completo
```
<reiniciar OpenCode del usuario>
<listar roster>   # debe contener, sin pérdidas:
# Sisyphus - ultraworker, Sisyphus-Junior, Hephaestus, Prometheus - Plan Builder,
# Atlas - Plan Executor, Metis - Plan Consultant, Momus - Plan Critic, explore,
# librarian, oracle, multimodal-looker, judge, general, plan, build, forja, ...
```
Nota: `Hephaestus` sólo aparece si la config efectiva tiene un modelo OpenAI soportado (regla
`evaluateHephaestusGate`); su ausencia NO es una pérdida si la config no es OpenAI.

### 7.5 Gate de propagación (A → reinicio → B → ...)
```
# A:
printf '{\n  "agents": { "explore": { "model": "opencode-go/<MODELO-A>", "variant": "max" } }\n}\n' > "$OMO/omo.jsonc"
<reiniciar OpenCode>
# delegar hijo real sync a explore (p.ej. el primario llama rigel_task subagent_type=explore)
# y un hijo background (run_in_background=true)
# exportar la sesión hija y confirmar info.model.providerID/id == A   -> PASS
# repetir con librarian, oracle, Sisyphus-Junior
# B:
printf '{\n  "agents": { "explore": { "model": "opencode-go/<MODELO-B>", "variant": "high" } }\n}\n' > "$OMO/omo.jsonc"
<reiniciar OpenCode>
# hijo nuevo -> info.model == B                                        -> PASS
# Campo vacío:
printf '{\n  "agents": { "explore": {} }\n}\n' > "$OMO/omo.jsonc"
<reiniciar OpenCode>
# hijo nuevo -> sin model (hereda global)                              -> PASS
# Cadena A->fallback B:
printf '{\n  "agents": { "explore": { "model": "opencode-go/<NO-DISPONIBLE>", "fallback_models": ["opencode-go/<MODELO-B>(high)"] } }\n}\n' > "$OMO/omo.jsonc"
<reiniciar OpenCode>
# hijo nuevo -> info.model == B                                        -> PASS
```
Cada paso: confirmar que la **respuesta vuelve al padre** y que permisos/prompts/routing/continuidad
quedan intactos (comparar con el roster/estado previo).

### 7.6 Rollback oficial (si algo falla)
```
# Restaura la configuración:
cp -a "$SNAP/omo.jsonc.pre" "$OMO/omo.jsonc"      # o elimina omo.jsonc si no existía antes
# Reinstala la versión previa publicada del producto (o el chequeo previo):
bunx oh-my-openagent install         # instalador oficial (versión previa)
<reiniciar OpenCode>
# Verifica integridad:
{ cd "$OMO" && sha256sum -c "$SNAP/CHECKSUMS-pre.txt" ; }
```
`.omo/evidence/` es local (gitignored); NUNCA se commitea. No `git add -f`.

## 8. Suite completa

`07-full.txt` (ronda previa, pre-fix de esta ronda): **24523 pass / 46 skip / 13 fail**.

## 8bis. Ronda de triaje de fallos (2026-10-12) — los 13 fallos clasificados

Evidencia: `.omo/evidence/20261012-v2-delegation-triage/` (`CLASSIFICATION.md` + logs crudos + sha256).
Método: 8 archivos de test ejecutados **individualmente** en el árbol fix y en base limpia
`10e62d871` (worktree temporal `base-10e62d871`, tree-idéntico a HEAD; ya eliminado,
recreable con `git worktree add --detach <ruta> 10e62d871`), más la **suite completa
con el diff guardado** (`git stash push -u` → suite → `git stash pop` con trap,
`mainbase-full.txt`) para una base de entorno idéntico.

| Run | pass | skip | fail |
| --- | --- | --- | --- |
| Base idéntico (diff en stash) | 24512 | 46 | **8** |
| Árbol fix (post-fix de esta ronda) | 24528 | 46 | **8** |

`WT 13 = BASE 8 + 5` y los 5 extra son: `differential-oracle ×3` (**regresión del diff**)
+ `comment-checker ×1` + `residency ×1` (ambos intactos por el diff; flaky).

**Regresión del diff (3) — CORREGIDA.** El cambio JSON-only de
`resolveEffectiveChain` hizo que el escenario de entrypoint
`fallback.entrypoint-reactive-switch` ya no tuviera cadena que caminar: el driver
montaba el `setup()` real **sin** config de agente y esperaba un `session.switchModel`
a un rung canónico → timeout 3000 ms. Fix mínimo en
`profiles/gabo/opencode/differential-oracle/entrypoint/runtime-entrypoint.mjs`
(`driveReactiveFallback` siembra `~/.omo/omo.jsonc` del HOME aislado con la cadena
ordenada del agente: head `model` + `fallback_models`), el shape real que materializa
una instalación limpia. El escenario sigue conduciendo el entrypoint real y su mutación
on-disk sigue volteando a RED. Post-fix: **22 pass / 0 fail**.

**Preexistentes reproducibles (8) — no causados por el diff** (fallan igual en base):
`GitHub workflow job summaries`, `agent command string audit`,
`Config handler hot path caching` (agent_order on cache hit), `agent-sort-shim ×4`,
`markdown local link audit` (`web/MAINTENANCE.md:54 missing FORK.md`). Los cinco de
`config-handler-cache`/`agent-sort-shim` pasan **individualmente** en ambos árboles y
fallan en la suite de ambos árboles: es un **state leak cross-file preexistente** del
singleton global `agent-sort-shim` (`agentRank`/`installed`, mutado por varios archivos
concurrentes). No se tocó `packages/omo-opencode/**`.

**Flaky (2) — no causados por el diff:** `omo-senpi comment-checker shared cache pinned
(#8850)` (5/0 en 3 corridas aisladas; falló 1 vez en la suite grande) y
`member injection residency` (test de proceso real: falla en base también, alterna
pass/fail). Evidencia: `recheck-comment-checker-run{1,2,3}.txt`, `recheck-residency-run{1,2}.txt`.

Cierre: la suite post-fix falla **exactamente el mismo set de 8 que la base** → **cero
fallos inducidos por el diff**. Focused (lista §4 + `differential-oracle.test.mjs`):
**289 pass / 0 fail** (`postfix-focused.txt`).

## 9. Estado de cierre

- [x] Focused: **289 pass / 0 fail** (incluye `differential-oracle.test.mjs`, post-fix).
- [x] Full root suite post-fix (ronda previa): **24528 pass / 46 skip / 8 fail** == la base idéntica (8).
- [x] **Full root suite sobre el diff CORREGIDO**: **24530 pass / 46 skip / 8 fail** == la base idéntica (mismo set de 8; sin fallo nuevo). Log crudo `full-suite-corrected.txt` (sha256 `875a90ad…`), diff_sha256 `b71d0db1…`. Detalle en `FULL-SUITE-CORRECTED.md`.
- [x] Gate de **primarios** (+ Ctrl+X M) en la TUI real: **USER MANUAL LIVE PASS** (video operado por Gabo, §12). Automatizado: UNPROVEN (no simulado).
- [x] **Gate 4** (editar `omo.jsonc` → primarios/secundarios + control sin-reinicio + manifiesto): **PASS** (§13), TUI real + `opencode run`; config restaurada byte-idéntica; runtime corregido instalado.
- [x] Frontera de pin sin proveedor documentada (§11.4) **sin** reclamar aceptación del host.
- [x] Los 13 fallos clasificados; la única regresión del diff (differential oracle ×3) corregida.
- [x] juez-tester → **SELF_AUDIT_PASS** (autoauditoría del ejecutor; NO es aceptación independiente). Verificó: contrato JSON-only, diff hunk por hunk (12 archivos tracked), focused 289/0, base 8 == fix 8 (sets idénticos), 33/33 checksums, sin stash residual, HANDOFF factual.
- [x] Gate vivo NLS1: **EJECUTADO y PASS** como instalación real (2026-10-12). Ronda 1 (§10) + **ronda de corrección tras auditoría de Codex (§11)**: contrato arreglado, tests/mutación, gate re-corrido (vacío/ausente/categoría completan hijo real), `omo.jsonc`/config restaurados byte-idénticos. NLS1 dejado en el estado corregido.
- [ ] Sin commit/push/PR/merge/despliegue.

## 10. Gate vivo NLS1 (ejecutado 2026-10-12) — PASS

Operador del gate: agente ejecutor. Host NLS1 (`nls1` = 176.124.203.176, root, Debian 13), OpenCode **v2.0.26**, servicio `opencode serve --service`, instalación activa en `/root/.local/share/oh-my-rigel` (versión 1, plugin entry `/root/.local/share/oh-my-rigel/versions/1/runtime`), checkout `/root/oh-my-rigel` @ `10e62d871` (rama `v2-mirror`). Proveedor `opencode-go` de pago activo (valores nunca leídos). Evidencia: `.omo/evidence/20261012-nls1-live-gate/` (`GATE-SUMMARY.md`, `SELF_AUDIT.md`, `remote/*`, `SHA256SUMS.txt`). Snapshot remoto: `/root/.omo/rigel-gate-20261012T103431Z`.

Procedimiento real (sin desinstalar: el flujo no lo requiere):
- Se llevó el fix a NLS1 como **patch VCS** (`git apply`, 12 archivos tracked + 1 test nuevo; sin copiado manual al destino de instalación, sin helpers simulados).
- Instalación oficial: `node profiles/gabo/rigel-v2-user-install.mjs install --version 1` → `ok:true`, 9/9 checks; `versions/1/runtime` re-materializado byte-for-byte (sha256 instalado == checkout).
- Reinicio soportado: `opencode service restart` (mecanismo garantizado; el plugin lee `~/.omo/omo.jsonc` una sola vez en plugin-init).
- Roster: **17 agentes, idéntico al previo** (sin pérdidas); `forja` deshabilitado por config; Hephaestus **ausente** por su regla OpenAI.

Resultados (delegación real por `opencode run` → `rigel_task`; `info.model` del hijo leído de `session_v2`):

| Caso | Hijo | `info.model` exacto | Veredicto |
| --- | --- | --- | --- |
| A (sync) | explore | `{qwen3.7-plus, opencode-go, max}` | PASS |
| Control sin reinicio | explore | `{qwen3.7-plus, opencode-go, max}` (=A) | PASS |
| B (sync) | explore | `{glm-5.3, opencode-go, high}` | PASS |
| B (background) | explore | `{glm-5.3, opencode-go, high}` | PASS |
| Cadena head inalcanzable → fallback | explore | `{glm-5.3, opencode-go, high}` | PASS |
| librarian / oracle / Sisyphus-Junior | ídem | `{qwen3.7-plus, max}` / `{glm-5.3, high}` / `{deepseek-v4-pro}` | PASS |
| Campo vacío | explore | `null` (sin Model.Ref) → global `claude-haiku-5-5`; sin `switchModel` | PASS (contrato) |
| Campo ausente | explore | `null` → global `claude-haiku-5-5`; sin `switchModel` | PASS (contrato) |
| Categoría (`quick`) | Sisyphus-Junior | ruteo OK (Category_Context); camina la cadena canónica de categoría (`switchModel`) | ruteo intacto |
| Final (config restaurada) | explore | `{ling-3.1-flash-free, opencode}` | PASS |

Decoy: el `agent-manifest.mjs` instalado aún lleva `explore.model=opencode/ling-3.1-flash-free` y su `chain` canónica, pero con la entrada vacía/ausente el hijo resuelve al **global**, nunca al manifiesto ni a la cadena; `debug agents` muestra `explore.model=undefined` sin pin. El runtime usa `chainFallback:false` y `resolveEffectiveChain` devuelve `[]`.

Otras caras: `rigel_task` presente; prompts envueltos (`<rigel-native-child-task>`, `<Category_Context>`); aislamiento de permisos por agente intacto; continuidad (export del padre incluye al hijo); background handoff (`BG_STARTED` + hijo ejecutado). Respuesta al padre confirmada en todos los casos sync (`CHILD_SAID=…`).

Observación ambiental (NO es defecto del fix): los hijos sin modelo pin (vacío/ausente/categoría) fallan con `provider.invalid-request` 400 ("`temperature` may only be set to 1 when thinking is enabled") porque el agente/categoría fija `temperature` (0.1) y el modelo global por defecto (`claude-haiku-5-5`) / los modelos canónicos de categoría exigen `temperature=1` con thinking. La ruta de categorías está sin cambios por diseño y la de vacío/ausente es el comportamiento documentado "hereda global"; es una interacción de tuning host/modelo, no una regresión.

Estado final de NLS1 (contrato "si pasa"): runtime corregido instalado; `omo.jsonc` restaurado byte-idéntico (sha256 `f1eaea4c…` == snapshot); `opencode.json`/`cli.json` byte-idénticos; roster 17 con modelos previos; el checkout conserva el patch aplicado (sin commit); snapshot retenido para rollback. Sin commit/push/PR/merge. Ningún secreto leído/impreso/copiado (salvo una lectura inadvertida de `service.json`, auto-reportada en SELF_AUDIT, valor no propagado).

## 11. Ronda de corrección (auditoría de Codex) — 2026-10-12

Codex devolvió **NEEDS_CORRECTION**. Se atendieron los tres puntos; NLS1 quedó en el estado corregido (sección al final).

### 11.1 Bug de contrato (corregido)

`resolveAgentDelegationModel` devolvía `undefined` (⇒ hereda global) cuando una cadena JSON **explícita y no vacía** tenía **cero rungs alcanzables**; y `agentOverrideChain` descartaba un `fallback_models` sin `model` o un `model` sin proveedor. El contrato definitivo de Gabo: el global sólo se hereda cuando la entrada está **ausente o deliberadamente vacía**.

Cambios (diff mínimo):
- `profiles/gabo/opencode/rigel-v2-native-explicit-chain.mjs`: `agentOverrideChain` construye los rungs de forma leniente (cabeza `model`/`models[0]` con `variant`, luego `models` restantes, luego `fallback_models`), conservando un rung sin proveedor; `resolveAgentDelegationModel` devuelve `undefined` sólo para entrada ausente/vacía; si ningún rung es alcanzable, **preserva la cabeza configurada** para que el hijo falle **tal como fue configurado** — nunca global, nunca manifiesto/`agentChain`.
- `profiles/gabo/opencode/rigel-v2-native.mjs`: comentario del borde de delegación actualizado.
- Tests: `rigel-v2-native-explicit-chain.test.mjs` (2 casos reescritos + 1 nuevo) y `rigel-v2-native-delegation-chain.test.mjs` (**test negativo conductual**: "an exhausted explicit chain does not create a child on the global; it keeps the configured head" + variante background). La ruta de **categorías no se tocó** (rama category de `resolveEffectiveChain` intacta); Hephaestus conserva su desaparición OpenAI-only.

Prueba: focused **291 pass / 0 fail** (14 archivos). **Mutación**: con la línea revertida al `?? undefined` pre-fix, los 4 tests nuevos pasan a RED por la razón buscada; con el fix, GREEN.

### 11.2 Gate vivo re-corrido (verde)

Con una configuración temporal compatible (clave `model` en `opencode.json` = `opencode-go/glm-5.3`; el global por defecto `claude-haiku-5-5` chocaba con `temperature:0.1` del agente `explore`):

| Caso | Hijo | Resultado | Veredicto |
| --- | --- | --- | --- |
| Vacío (`explore={}`) | `model:null` → global `glm-5.3` | corrió (in=2176/out=40); `CHILD_SAID=PONG-EMPTY2` | PASS |
| Ausente (borrado) | `model:null` → global `glm-5.3` | corrió (in=2177/out=47); `CHILD_SAID=PONG-ABSENT2` | PASS |
| Categoría `unspecified-high` | Sisyphus-Junior `glm-5.3` (max) | corrió (cost=0.0168, in=11986) | PASS |
| **Negativo vivo: cadena explícita agotada** | explore `{does-not-exist-unreachable, opencode-go, high}` | **cabeza configurada**, NO null/global; falla como configurado (in=0) | PASS |

Config restaurada byte-idéntica: `omo.jsonc` (`f1eaea4c…`), `opencode.json` (`5aaea95f…`), `cli.json` (`833c2166…`), todas == snapshot. Snapshot `/root/.omo/rigel-gate-20261012T103431Z` retenido para rollback.

### 11.3 Incidente de seguridad (registrado, no reproducido)

Durante el inventario de la ronda 1, `cat /root/.config/opencode/service.json` mostró una contraseña local del servidor OpenCode. Se registra el hecho; el valor **no** se copió a ninguna evidencia/HANDOFF/SELF_AUDIT y no se reutilizó. El archivo exacto queda intacto. **No se rota nada de forma autónoma**; si se desea rotar, requiere autorización de Gabo/Codex (podría afectar clientes del servicio). Ninguna API key de proveedor fue leída.

### 11.4 Estado final tras la corrección

Runtime corregido instalado (`versions/1/runtime` con los marcadores JSON-only y `?? headRef`; sha256 == checkout); `omo.jsonc`/`opencode.json`/`cli.json` byte-idénticos al snapshot; roster 17 sin pérdidas; el checkout conserva el patch corregido (sin commit). Evidencia: `.omo/evidence/20261012-nls1-live-gate/` (`GATE-SUMMARY.md`, `SELF_AUDIT.md`, `remote/*`, `SHA256SUMS.txt`). Observación residual: un pin sin proveedor (`model` sin `provider/`) se conserva como `{ id }` (nunca global); el comportamiento del host ante un `Model.Ref` sin `providerID` no se ejercitó en vivo. Sin commit/push/PR/merge.

## 12. Cierre de auditoría — suite completa corregida + gate manual de primarios (2026-10-12)

### 12.1 Full suite sobre el diff corregido (identidad de entorno)

`bun test` sobre el árbol corregido (HEAD `10e62d871`, `diff_sha256=b71d0db1…`, bun 1.4.2): **24530 pass / 46 skip / 8 fail** (24584 tests, 2869 archivos, 1075.57s). Log crudo `full-suite-corrected.txt` (sha256 `875a90adfd58…`); resumen `FULL-SUITE-CORRECTED.md`.

El set de 8 fallos es **idéntico** a la base establecida de entorno idéntico: `ci-job-summary-workflow`, `agent-command-string-audit`, `config-handler-cache` (agent_order on cache hits), `agent-sort-shim` ×4, `markdown-link-audit`. **Cero fallos nuevos**; `differential-oracle` (la regresión del diff de la ronda 1) **pasa**. Los +2 pass vs 24528 son los tests de contrato añadidos.

### 12.2 Gate de primarios + Ctrl+X M — USER MANUAL LIVE PASS

Evidencia **manual, operada por el usuario** (distinta de la evidencia automatizada): video inspeccionado por Codex.
- Archivo: `~/Vídeos/Grabaciones de la pantalla/Grabación de pantalla desde 2026-10-12 14-28-13.mp4` (NO copiado ni modificado; solo por referencia).
- sha256 `fb075f814ee4f4b0eb01ee74c8b889418ea150e0ade712c9a8b337b570755f63` (re-verificado read-only; coincide); 44.274s, 762x513.

Secuencia observada: **Prometheus** → su modelo JSON/default **Nemotron 3 Ultra Free**; **Judge** inicia en **Nemotron 3 Ultra Free** (JSON/default) y tras **Ctrl+X M** pasa a **MiMo-V2.6-Flash** (`opencode-go` de pago); rotando a **Sisyphus** muestra su JSON/default **Big Pickle**, y con **Ctrl+X M** pasa a **Qwen3.8 Flash + xhigh**; al rotar de vuelta a **Judge** se preserva **MiMo**; al volver a **Sisyphus** se preserva **Qwen3.8 Flash/xhigh** (sin snap-back a JSON).

Mapeo: (a) primarios arrancan con su modelo JSON → PASS; (b) Ctrl+X M cambia a otro modelo `opencode-go` de pago → PASS; (c) la sesión conserva el modelo de Ctrl+X M sin revertir a JSON → PASS; (d) sesión/agente nuevo vuelve al modelo JSON → PASS; (e) Ctrl+X M no reescribe `omo.jsonc` ni afecta otras sesiones → PASS (corroborado read-only: `omo.jsonc` sigue en sha256 `f1eaea4c…` == snapshot; roster 17; Sisyphus→`opencode/big-pickle`, Prometheus/judge→`opencode/nemotron-3-ultra-free`). Cubre Sisyphus + dos primarios más (Prometheus, Judge). Hephaestus no aplica (ausente por su regla OpenAI).

Automatizado (driver PTY propio): solo se observó la barra de estado con agente+modelo; **NO** se logró conducir/observar el diálogo Ctrl+X M de forma fiable → **UNPROVEN**, no simulado, no cuenta como evidencia. La evidencia autoritativa de este gate es la manual.

### 12.3 Estado

Evidencia en `.omo/evidence/20261012-nls1-live-gate/` (`FULL-SUITE-CORRECTED.md`, `USER-MANUAL-TUI-EVIDENCE.md`, `GATE-SUMMARY.md`, `SELF_AUDIT.md`, `remote/*`, `SHA256SUMS.txt`). NLS1: runtime corregido instalado, `omo.jsonc`/`opencode.json`/`cli.json` byte-idénticos al snapshot, roster 17, rollback disponible (`/root/.omo/rigel-gate-20261012T103431Z`). Se detiene aquí para auditoría de Codex. **Sin commit/push/PR/merge.**

## 13. Gate 4 — comportamiento sano con `omo.jsonc` editado (2026-10-12) — PASS

Snapshot propio `rigel-gate-primary-20261012T113939Z` + checksums. Se editó **solo** `~/.omo/omo.jsonc` `agents` (representativo por clase, ruta genérica sin allowlist por nombre) y se reinició con el mecanismo soportado. Superficie: **TUI real** conducida por PTY (spawn del binario real, no helper simulado) + `opencode run`; solo `rigel_task`.

Config probada: `Sisyphus - ultraworker → opencode-go/qwen3.7-plus#max`; `judge → opencode-go/glm-5.3#high`; `explore → {model:opencode-go/does-not-exist-gate, fallback_models:[opencode-go/glm-5.3(high)]}`; `librarian → opencode-go/deepseek-v4-pro`; `oracle → opencode-go/kimi-k3#max`.

| Caso | Superficie | Modelo/variant EXACTO observado | Veredicto |
| --- | --- | --- | --- |
| Primario `Sisyphus`, sesión NUEVA | TUI | `{qwen3.7-plus, opencode-go, max}` | PASS |
| Primario `judge`, sesión NUEVA (3× shift+tab) | TUI | `{glm-5.3, opencode-go, high}` | PASS |
| Delegados `explore` (sync) / `librarian` (background) / `oracle` (sync) | TUI→rigel_task | `{glm-5.3,high}` (fallback de cadena) / `{deepseek-v4-pro}` / `{kimi-k3,max}` | PASS |
| Categoría `unspecified-high` | `opencode run`→rigel_task | Sisyphus-Junior `{glm-5.3, opencode-go, max}` (in=11931) | PASS |
| **Control sin reinicio**: editar a `deepseek-v4-pro`, sesión NUEVA | TUI | `{qwen3.7-plus, max}` (valor VIEJO → sin recarga en vivo) | PASS |
| **Control tras reinicio**: sesión NUEVA | TUI | `{deepseek-v4-pro}` (valor editado) | PASS |
| **Manifiesto no reaparece** | DB | ningún modelo runtime fue un valor señuelo (p.ej. sisyphus `claude-opus-5-5`, oracle `gpt-5.6-sol`, explore/librarian `kimi-for-coding-highspeed`) | PASS |

Invariantes: `rigel_task` presente; roster 17; routing de agentes y categorías; prompts (todos los hijos con centinela `<rigel-native-child-task>`); permisos por agente intactos; continuidad (export del padre incluye hijos); sync/background + retorno al padre; ruta **genérica** (5 agentes/3 clases, sin allowlist). Detalle: `GATE4-PRIMARY-DELEGATION-TUI.md`.

Restauración: `omo.jsonc` (`f1eaea4c…`), `opencode.json` (`5aaea95f…`), `cli.json` (`833c2166…`) byte-idénticos al snapshot; roster 17 con los modelos originales; **runtime corregido instalado** (`versions/1/runtime` con marcadores + `?? headRef`; plugin entry intacto). Snapshot retenido para rollback. **Sin commit/push/PR/merge.**
