/**
 * Clasificación de migración para las superficies `cli/` de OmO V1.
 *
 * Cada fila mapea un directorio o archivo real bajo
 * `packages/omo-opencode/src/cli/` a su destino en el runtime nativo de
 * OpenCode V2 (`profiles/gabo/opencode/rigel-v2-native.mjs` y sus satélites) y
 * en el registro de comandos del arnes de laboratorio
 * (`profiles/gabo/rigel-v2-cli.mjs`), que NO es una CLI publica: `package.json` no
 * publica ningun bin `rigel-v2`. El generador
 * `profiles/gabo/generate-v2-migration-inventory.mjs` consume este objeto
 * como la sección `cli` del ledger.
 *
 * T38 cierra las 19 filas que citaban `task:38` owner por owner. Ninguna fila
 * se cierra como `Interno de build` por mera clasificación: el efecto existe en
 * un artefacto V2 real y se prueba sobre ESE artefacto:
 *  - el registro de comandos del arnes (`profiles/gabo/rigel-v2-cli.mjs`) implementa
 *    el valor portado y delega solo el install/uninstall real a los paquetes
 *    adaptadores (`@oh-my-opencode/omo-codex/install`,
 *    `@oh-my-opencode/omo-senpi/install`) y a `@oh-my-opencode/utils`;
 *  - ese registro se MATERIALIZA en el despliegue del laboratorio V2 unicamente a
 *    traves de `apply-v2-runtime-service.sh` (via `materialize-v2-cli.mjs`):
 *    launcher en `<labRoot>/rigel/bin/rigel-v2` y `<labHome>/.local/bin/rigel-v2`,
 *    enraizado en el HOME/XDG del lab. La aceptacion `qa-v2-cli-installed.mjs`
 *    invoca ESE launcher instalado (no el archivo fuente);
 *  - `install --platform=opencode` usa solo el wrapper autorizado
 *    `apply-v2-runtime-service.sh`, nunca los scripts retirados
 *    (`apply-v2-agent-layer.mjs`, `switch-live-plugin-to-native-v2.mjs`);
 *  - las filas con efecto de runtime tienen contrato hermético/vivo
 *    (`cli-runtime-parity.test.mjs`, `qa-v2-builtin-mcps.mjs`).
 * Pruebas del CLI: `rigel-v2-cli.test.mjs` (integración, spawnea el CLI real) y
 * `cli/commands/commands.test.mjs` (contrato por comando, positivo y negativo).
 *
 * Forma: `{ "<fila>": { classification, status?, rationale, futureEvidence } }`.
 * `futureEvidence` usa los tokens `task:<n>`, `contract:<archivo>.mjs` o
 * `gate:<config.key>`.
 */
export default {
  boulder: {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "El inspector de estado boulder de `packages/omo-opencode/src/cli/boulder/boulder.ts` se adapta al registro de continuidad nativo de V2 (`.omo/boulder.json`, schema_version 2, escrito por `rigel-v2-ulw-execute.mjs`), ya que el CLI de OpenCode no ofrece un comando de progreso boulder. El comando nativo `boulder` (`profiles/gabo/cli/commands/boulder.mjs`) lee el store real, resuelve el plan con preferencia de worktree, calcula progreso/elapsed/tarea actual y expone `--json`; ausente -> exit 1, ilegible -> exit 2.",
    futureEvidence: "`profiles/gabo/cli/commands/boulder.mjs`; `profiles/gabo/cli/commands/boulder.test.mjs`; `rigel-v2-ulw-execute.mjs` (store real)",
  },
  cleanup: {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "`cleanup.ts` limpia el estado de Codex Light. El efecto existe como comando del arnes de laboratorio: `rigel-v2 uninstall --platform=codex` delega en el cleanup real de Codex (`cleanupCodexLight` de `@oh-my-opencode/omo-codex/install`); el uninstall de opencode revierte el runtime del fork. Probado positivo (dry-run del plan + cleanup codex con adaptador inyectado) y negativo (plataforma desconocida).",
    futureEvidence: "`profiles/gabo/rigel-v2-cli.test.mjs` (uninstall codex); `profiles/gabo/cli/commands/uninstall.mjs`; `profiles/gabo/cli/commands/commands.test.mjs`",
  },
  "cleanup-command": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El cableado del comando cleanup/uninstall existe como comando del arnes de laboratorio: el comando `uninstall` (alias `cleanup`) del arnes de laboratorio. Probado positivo (alias `cleanup --dry-run` -> plan) y negativo (entrada foránea -> exit 1).",
    futureEvidence: "`profiles/gabo/rigel-v2-cli.test.mjs` (cleanup alias); `profiles/gabo/cli/commands/uninstall.mjs`",
  },
  "cli-installer": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "El instalador no interactivo de `packages/omo-opencode/src/cli/cli-installer.ts` se adapta al instalador del runtime nativo, conservando la selección de proveedores y la generación de configuración.",
    futureEvidence: "contract:qa-v2-lab-install-contract.mjs; contract:rigel-v2-cli.test.mjs",
  },
  "cli-program": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El entry Commander de V1 (`packages/omo-opencode/src/cli/cli-program.ts`) queda con su superficie publica recortada a `install`, `get-local-version` y `doctor`, tras retirar `run` (PR2/F72) y `config migrate` (PR2/F71). Su equivalente en el arnes de laboratorio es el dispatcher `runRigelV2Cli` + registro de `profiles/gabo/rigel-v2-cli.mjs`, que NO es una CLI publica: no hay bin `rigel-v2` en `package.json`. Probado positivo (`--help` lista la superficie, `version` responde) y negativo (comando desconocido -> exit 1).",
    futureEvidence: "`profiles/gabo/rigel-v2-cli.test.mjs`; `profiles/gabo/rigel-v2-cli.mjs`; `profiles/gabo/cli/rigel-v2-cli-registry.mjs`",
  },
  "codex-ulw-loop": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "El comando ulw-loop de Codex existe como comando del arnes de laboratorio: `rigel-v2 ulw-loop` resuelve el bin del componente (CODEX_LOCAL_BIN_DIR / cache de Codex / sentinel de delegación) con una implementación propia, no importando el owner V1. Probado positivo (bin presente -> resuelto) y negativo (ausente -> exit 1; sentinel -> no-op).",
    futureEvidence: "`profiles/gabo/rigel-v2-cli.test.mjs` (ulw-loop); `profiles/gabo/cli/commands/ulw-loop.mjs`; `profiles/gabo/cli/commands/commands.test.mjs`",
  },
  "config-manager": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "Las utilidades de configuración de `packages/omo-opencode/src/cli/config-manager/` (carga, fusión, protección de campos de usuario) se adaptan al resolvedor nativo V2: `resolveNativePluginConfig` carga la cadena, fusiona con precedencia proyecto>usuario, protege `mcp_env_allowlist` como campo solo-usuario (incluida su colocación en el bloque `[opencode]`, que el resolvedor no leía y T38 corrigió) y migra claves legadas. Contrato diferencial contra el loader V1 real.",
    futureEvidence: "`profiles/gabo/cli-runtime-parity.test.mjs` (config-manager); `profiles/gabo/opencode/rigel-v2-native-config.mjs`; `profiles/gabo/opencode/rigel-v2-native-config.parity.test.mjs`; `profiles/gabo/validate-profile.mjs`",
  },
  "config-migrate": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "La capacidad de migración legada se conserva y la superficie pública se retira (PR2/F71). `packages/omo-opencode/src/cli/config-migrate.ts` era solo un impresor de consola sobre `runOpenCodeStartupMigration`, con un único importador (`cli-program.ts`), así que el comando público `config migrate` (`--dry-run`, `--json`) se elimina junto con su módulo y su test; ningún script, bin, instalador ni plugin lo invocaba. La migración sigue siendo automática en `packages/omo-opencode/src/startup-migration.ts` (`runOpenCodeStartupMigration`) en el arranque del plugin OpenCode, el arranque de Senpi, el arranque de Codex (solo el grupo `config.jsonc`) y la instalación, y el resolvedor nativo V2 migra las mismas claves legadas en memoria: `ralph_loop -> goal` (igual que `validatePluginConfig`) y `experimental.hashline_edit -> hashline_edit` raíz (igual que `migrateConfigFile`). Contrato diferencial por clave contra los owners V1 reales.",
    futureEvidence: "`packages/omo-opencode/src/startup-migration.ts`; `packages/omo-opencode/src/startup-migration.test.ts`; `profiles/gabo/cli-runtime-parity.test.mjs` (config-migrate); `profiles/gabo/opencode/rigel-v2-native-config.parity.test.mjs`",
  },
  doctor: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El diagnóstico de cuatro categorías de `packages/omo-opencode/src/cli/doctor/` se porta al CLI nativo como cuatro categorías (SYSTEM / CONFIG / TOOLS / MODELS) mas los extras necesarios del fork: `profiles/gabo/cli/commands/doctor.mjs` comprueba el binario V2 y la version minima, la validez del config JSONC, las herramientas de PATH (sg/comment-checker/gh) y los MCP, y el catalogo/overrides de modelos, todo sobre un `io` inyectable y solo rutas del lab (nunca V1). `--json`/`--status`/`--verbose`; exit 1 si alguna categoria falla.",
    futureEvidence: "`profiles/gabo/cli/commands/doctor.mjs`; `profiles/gabo/cli/commands/commands.test.mjs`",
  },
  "fallback-chain-resolution": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "La resolución de cadenas de fallback de `packages/omo-opencode/src/cli/fallback-chain-resolution.ts` es lógica de generación de configuración en instalación, sin superficie de runtime propia; el fallback de runtime lo cubre la tarea 8.",
    futureEvidence: "contract:rigel-v2-native-model-chains.mjs (cadenas portadas de model-core)",
  },
  "fallback-lane-policy": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "La política de carriles excluidos de `packages/omo-opencode/src/cli/fallback-lane-policy.ts` solo participa en la generación de configuración de instalación y no expone comportamiento de runtime en V2.",
    futureEvidence: "contract:rigel-v2-native-model-chains.mjs (cadenas portadas de model-core)",
  },
  "get-local-version": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "La deteccion de version local frente a la publicada se porta al CLI nativo: `profiles/gabo/cli/commands/get-local-version.mjs` reutiliza exactamente el registro/paquete que el propio fork sigue para su update-check (`oh-my-openagent` por defecto, override `RIGEL_UPDATE_PACKAGE`/`RIGEL_UPDATE_REGISTRY_URL`), resuelve el canal con el primitivo portado (`extractChannel`) y reporta `{currentVersion, latestVersion, isUpToDate, channel, status}` con el mismo `--json`. Un fallo de red degrada a `status: error` con exit 1, nunca lanza.",
    futureEvidence: "`profiles/gabo/cli/commands/get-local-version.mjs`; `profiles/gabo/cli/commands/get-local-version.test.mjs`; `rigel-v2-native-update-core.mjs` (mismos primitivos)",
  },
  install: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El instalador de `packages/omo-opencode/src/cli/install.ts` se mantiene como subconjunto necesario del CLI, portando la selección de proveedores y el registro del plugin al runtime nativo de V2.",
    futureEvidence: "contract:qa-v2-lab-install-contract.mjs; contract:rigel-v2-cli.test.mjs; contract:cli/commands/install.mjs",
  },
  "install-ast-grep-sg": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "El aprovisionamiento del binario sg existe como comando V2 real: `rigel-v2 ast-grep` provee el binario fijado de `@oh-my-opencode/utils` (`provisionSgBinary` sobre `SG_PINNED_VERSION` + sha256, `astGrepRuntimeDir`) hacia `<home>/.omo`. Estrategia única: no se usa el `install.sh` sin checksum del skill. Probado positivo (installer inyectado -> target bajo ~/.omo) y negativo (fallo -> exit 1 con la razón).",
    futureEvidence: "`profiles/gabo/rigel-v2-cli.test.mjs` (ast-grep); `profiles/gabo/cli/commands/ast-grep.mjs`; `profiles/gabo/cli/commands/commands.test.mjs`",
  },
  "install-codex": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "La instalación de la edición Codex Light existe como comando V2 real: `rigel-v2 install --platform=codex` delega en el instalador real de Codex (`runCodexInstaller` de `@oh-my-opencode/omo-codex/install`) con el Codex home resuelto. Probado positivo (adaptador inyectado recibe el codexHome) y negativo (plataforma desconocida -> exit 1; dry-run nombra el paso codex).",
    futureEvidence: "`profiles/gabo/rigel-v2-cli.test.mjs` (install codex); `profiles/gabo/cli/commands/install.mjs`; `profiles/gabo/cli/commands/commands.test.mjs`",
  },
  "install-native": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "La instalación de OmO Native (motor senpi) existe como comando V2 real: `rigel-v2 install --platform=native` delega en el instalador real de senpi (`runSenpiInstaller` de `@oh-my-opencode/omo-senpi/install`). Probado positivo (adaptador inyectado invocado) y negativo (dry-run nombra el paso senpi).",
    futureEvidence: "`profiles/gabo/rigel-v2-cli.test.mjs` (install native); `profiles/gabo/cli/commands/install.mjs`; `profiles/gabo/cli/commands/commands.test.mjs`",
  },
  "install-native-dev": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "El envoltorio de instalación nativa dev existe como comando V2 real: `rigel-v2 install --platform=native-dev`, con el opt-in obligatorio `OMO_ENABLE_NATIVE_DEV_PLATFORM` (legacy `OMO_ENABLE_SENPI_PLATFORM`) y delegación al instalador senpi. Probado positivo (con flag -> plan) y negativo (sin flag -> exit 1).",
    futureEvidence: "`profiles/gabo/rigel-v2-cli.test.mjs` (install native-dev); `profiles/gabo/cli/commands/install.mjs`; `profiles/gabo/cli/commands/commands.test.mjs`",
  },
  "install-validators": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "La validación de opciones de instalación existe como comando del arnes de laboratorio: `rigel-v2 install` valida la plataforma (implementación propia) y rechaza valores desconocidos con exit 1. Probado positivo (plan válido) y negativo (plataforma desconocida).",
    futureEvidence: "`profiles/gabo/rigel-v2-cli.test.mjs` (install validation); `profiles/gabo/cli/commands/install.mjs`; `profiles/gabo/cli/commands/commands.test.mjs`",
  },
  "mcp-oauth": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El efecto del CLI V1 `mcp oauth login/logout/status` se porta como el comando nativo V2 `mcp-oauth` registrado con `ctx.command.transform`. Reutiliza el proveedor PKCE/DCR y el callback local del manager (`rigel-v2-skill-mcp-oauth.mjs`) y persiste el token en el dominio `ctx.storage`; no duplica discovery/DCR/PKCE, nunca imprime tokens y expone modo manual de callback cuando no hay navegador interactivo. El experimento vivo fijó el mecanismo: el comando ejecuta el efecto sin modelo y el reporte viaja por el canal oficial `session.prompt`.",
    futureEvidence: "`profiles/gabo/opencode/rigel-v2-native-mcp-oauth-command.mjs`; `profiles/gabo/opencode/rigel-v2-native-mcp-oauth-command.test.mjs`; `profiles/gabo/qa-v2-t30-mcp-oauth.mjs`; `.omo/evidence/20261007-t30-mcp-oauth/`",
  },
  "minimum-opencode-version": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "La verificación de versión mínima de `packages/omo-opencode/src/cli/minimum-opencode-version.ts` se porta al runtime nativo V2 como un gate de setup real (no un valor estático): el mínimo se materializa desde `integration-manifest.platform.opencode` (`>=2.0.19`) en `metadata.global.minOpenCodeVersion`, y `setup()` rechaza un host por debajo del mínimo leyendo `context.app.version` (degrada en silencio si el host no publica versión).",
    futureEvidence: "`profiles/gabo/cli-runtime-parity.test.mjs` (minimum-opencode-version); `profiles/gabo/opencode/rigel-v2-native.mjs` (setup); `profiles/gabo/opencode/rigel-v2-native-config.mjs`; `profiles/gabo/generate-v2-agents.mjs`",
  },
  "model-fallback": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "La generación de configuración de fallback por disponibilidad de proveedores de `packages/omo-opencode/src/cli/model-fallback.ts` se adapta al esquema unificado de V2; el fallback de runtime se porta en la tarea 8.",
    futureEvidence: "contract:rigel-v2-native-model-chains.mjs (cadenas portadas de model-core)",
  },
  "model-fallback-requirements": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "Las cadenas de fallback por agente de `packages/omo-opencode/src/cli/model-fallback-requirements.ts` se adaptan al runtime nativo, con las cadenas portadas desde model-core en la tarea 8.",
    futureEvidence: "contract:rigel-v2-native-model-chains.mjs (cadenas portadas de model-core)",
  },
  "model-fallback-types": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "Los tipos de `packages/omo-opencode/src/cli/model-fallback-types.ts` son contratos de datos de la generación de configuración de instalación y no tienen superficie de runtime propia.",
    futureEvidence: "contract:rigel-v2-native-model-chains.mjs (cadenas portadas de model-core)",
  },
  "native-dev-platform-flag": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "La bandera de plataforma native-dev existe como comando del arnes de laboratorio: `rigel-v2 install --platform=native-dev` exige `OMO_ENABLE_NATIVE_DEV_PLATFORM` (legacy aceptada) y rechaza la plataforma sin el opt-in. Probado positivo (con flag) y negativo (sin flag -> exit 1).",
    futureEvidence: "`profiles/gabo/rigel-v2-cli.test.mjs` (native-dev gate); `profiles/gabo/cli/commands/install.mjs`; `profiles/gabo/cli/commands/commands.test.mjs`",
  },
  "native-edition-hint": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El aviso de la edición OmO Native existe como comando del arnes de laboratorio: `rigel-v2 install` imprime el hint (comando de instalación + guía) cuando la edición nativa no está presente. Probado positivo (el hint aparece en el dry-run) y negativo (no se imprime al instalar native/native-dev).",
    futureEvidence: "`profiles/gabo/rigel-v2-cli.test.mjs` (native-edition hint); `profiles/gabo/cli/commands/install.mjs`; `profiles/gabo/cli/commands/commands.test.mjs`",
  },
  "openai-only-model-catalog": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "El filtrado de catálogo solo OpenAI de `packages/omo-opencode/src/cli/openai-only-model-catalog.ts` se adapta a la resolución de modelos del runtime nativo de V2.",
    futureEvidence: "contract:rigel-v2-native-model-chains.mjs; rigel-v2-native-model-chains.test.mjs",
  },
  "provider-availability": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "La detección de disponibilidad de proveedores de `packages/omo-opencode/src/cli/provider-availability.ts` se adapta a las credenciales y proveedores reales del runtime nativo de V2.",
    futureEvidence: "contract:rigel-v2-native-model-chains.mjs (readAvailableModels)",
  },
  "provider-model-id-transform": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "El reenvío de transformación de id de modelo de `packages/omo-opencode/src/cli/provider-model-id-transform.ts` es un shim de model-core sin comportamiento de runtime propio.",
    futureEvidence: "contract:rigel-v2-native-model-chains.mjs (modelKey/parseModel)",
  },
  "refresh-model-capabilities": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "El refresco de la caché de capacidades de modelos de `packages/omo-opencode/src/cli/refresh-model-capabilities.ts` se adapta al host V2, que resuelve el catálogo/capacidades (`/api/model`). El efecto existe como comando V2 real: `rigel-v2 refresh-model-capabilities` resuelve el catálogo del host y escribe un snapshot. Probado positivo (host con catálogo -> snapshot escrito) y negativo (host inalcanzable -> exit 1 sin archivo). Además el runtime resuelve contra ese inventario (sin caché propia).",
    futureEvidence: "`profiles/gabo/rigel-v2-cli.test.mjs` (refresh); `profiles/gabo/cli/commands/refresh-model-capabilities.mjs`; `profiles/gabo/cli/commands/commands.test.mjs`; `profiles/gabo/cli-runtime-parity.test.mjs`; `profiles/gabo/opencode/rigel-v2-native-model-chains.mjs`",
  },
  run: {
    classification: "Equivale a builtin V2",
    status: "Migrado",
    rationale:
      "El comando publico `run` (`packages/omo-opencode/src/cli/run/`, 62 archivos) se retira por PR2/F72: su unico importador era `cli-program.ts` y duplicaba el modo no interactivo del host. Se CONSERVA el guard interno no interactivo (`profiles/gabo/opencode/rigel-v2-native-noninteractive.mjs`) y los lectores de `OPENCODE_CLI_RUN_MODE` (`plugin-handlers/tool-config-handler.ts`, `hooks/auto-update-checker/hook.ts`). El flujo no interactivo del host V2 (crear sesión -> prompt -> idle). El runtime nativo no implementa un bucle propio: conduce la API de sesión del host (`create -> prompt(resume) -> wait -> context`) y rechaza si el host no la expone. Prueba de laboratorio, no concluyente (el servicio de laboratorio esta prohibido como gate vivo; kris es el unico laboratorio designado y NLS1 queda como historico retirado): `qa-v2-builtin-mcps.mjs` conduce create+prompt+idle contra ese servicio.",
    futureEvidence: "`profiles/gabo/cli-runtime-parity.test.mjs` (run); `profiles/gabo/qa-v2-builtin-mcps.mjs` (laboratorio, no concluyente); `profiles/gabo/qa-v2-native-delegation.mjs`",
  },
  "runtime-commands": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El registro de comandos de runtime de `packages/omo-opencode/src/cli/runtime-commands.ts` se conserva en el producto (`configureRuntimeCommands(program)`); su equivalente en el arnes de laboratorio expone version, doctor, install, uninstall, ulw-loop, worktree-sweep, refresh-model-capabilities y ast-grep. Probado positivo (`--help` lista la superficie; `version` responde) y negativo (comando desconocido -> exit 1).",
    futureEvidence: "`profiles/gabo/rigel-v2-cli.test.mjs`; `profiles/gabo/cli/rigel-v2-cli-registry.mjs`",
  },
  "star-request": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "La cortesía de estrella en GitHub existe como comando del arnes de laboratorio: `rigel-v2 install --star` ejecuta `gh api ... /user/starred/<repo>` por repositorio de la plataforma, con implementación propia. Probado positivo (dry-run muestra el comando; el runner invoca gh) y negativo (fallo por repo se registra sin abortar).",
    futureEvidence: "`profiles/gabo/rigel-v2-cli.test.mjs` (star); `profiles/gabo/cli/commands/install.mjs`; `profiles/gabo/cli/commands/commands.test.mjs`",
  },
  "tui-install-prompts": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "Los prompts interactivos de `packages/omo-opencode/src/cli/tui-install-prompts.ts` se adaptan al instalador nativo, conservando las mismas decisiones de proveedor y plataforma.",
    futureEvidence: "contract:qa-v2-lab-install-contract.mjs; contract:rigel-v2-cli.test.mjs",
  },
  "tui-installer": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "El instalador interactivo de `packages/omo-opencode/src/cli/tui-installer.ts` se adapta al flujo nativo del runtime V2, sin dependencia del plugin V1.",
    futureEvidence: "contract:qa-v2-lab-install-contract.mjs; contract:rigel-v2-cli.test.mjs",
  },
  "worktree-sweep": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El barrido de worktrees obsoletos existe como comando V2 real: `rigel-v2 worktree-sweep` implementa el parseo de `git worktree list --porcelain`, la clasificación SWEEP/KEEP/PRUNE y la remoción/purga (con prefijos protegidos) sobre git, sin acoplamiento al runtime. Probado positivo (repo real con worktree enlazado -> reporte JSON) y negativo (ruta no-git -> exit 1).",
    futureEvidence: "`profiles/gabo/rigel-v2-cli.test.mjs` (worktree-sweep); `profiles/gabo/cli/commands/worktree-sweep.mjs`; `profiles/gabo/cli/commands/commands.test.mjs`",
  },
}
