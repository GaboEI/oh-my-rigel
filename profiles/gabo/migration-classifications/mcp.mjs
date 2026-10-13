/**
 * Clasificación de migración para las superficies V1 de MCP de OmO.
 *
 * Cada fila mapea un módulo real bajo
 * `packages/omo-opencode/src/mcp/<fila>.ts` (o su directorio `shared/`) a su
 * destino en el runtime nativo de OpenCode V2. El generador
 * `profiles/gabo/generate-v2-migration-inventory.mjs` consume este objeto
 * como la sección `mcp` del ledger.
 *
 * El sistema MCP de tres capas se migra completo: los builtins tier-1
 * (`websearch`, `context7`, `grep_app`, `lsp`) y los helpers de runtime que
 * resuelven el CLI del MCP local `lsp` (`cli-suffix`, `runtime-executable`,
 * `shared`). La política de propiedad vive en
 * `profiles/gabo/integration-manifest.json` (`mcpPolicy`).
 *
 * Forma: `{ "<fila>": { classification, rationale, futureEvidence } }`.
 * `futureEvidence` usa los tokens `task:<n>`, `contract:<archivo>.mjs` o
 * `gate:<config.key>`.
 */
export default {
  "cli-suffix": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El helper `hasCliSuffix` de `packages/omo-opencode/src/mcp/cli-suffix.ts` es soporte de runtime del MCP local tier-1 `lsp`, porque normaliza separadores y decide entre CLI dist y fuente. Se porta a `rigel-v2-native-builtin-mcps.mjs` (`normalizeCliPath`/`hasCliSuffix`) y lo consume el resolvedor del servidor `lsp` al elegir el candidato dist o fuente. La correccion de la documentacion oficial V2 (V2 no ejecuta language servers ni expone tools LSP) obliga a registrar el servidor `lsp` nativamente, no a depender de `lsp: true`.",
    futureEvidence: "`profiles/gabo/opencode/rigel-v2-native-builtin-mcps.mjs` (hasCliSuffix consumido por resolveLspCommand); `profiles/gabo/opencode/rigel-v2-native-builtin-mcps.test.mjs`; `profiles/gabo/qa-v2-builtin-mcps.mjs` (vivo)",
  },
  context7: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El MCP remoto tier-1 `context7` de `packages/omo-opencode/src/mcp/context7.ts` se migra como builtin oficial registrado nativamente con `context.mcp.transform` (`createContext7McpConfig` y `registerNativeBuiltinMcps` en `rigel-v2-native-builtin-mcps.mjs`), bajo una politica exclusiva viva: si el host ya sirve un `context7` externo la colision gana y el builtin no se emite; si no existe, el builtin se emite. La instalacion limpia NO siembra `context7` en `disabled_mcps`, para que el runtime reconcilie en cada setup y nunca queden cero ni dos Context7; solo se respeta un `disabled_mcps` que el usuario ya haya elegido en una configuracion existente. La clave opcional se lee de `CONTEXT7_API_KEY` como cabecera bearer y nunca se registra ni se expone.",
    futureEvidence: "`profiles/gabo/opencode/rigel-v2-native-builtin-mcps.mjs` (builtin context7 + politica exclusiva); `profiles/gabo/opencode/rigel-v2-native-builtin-mcps.test.mjs` (positivo/negativo/transicion); `profiles/gabo/rigel-v2-user-install-config-bootstrap.test.mjs` (el seed no lo deshabilita); `profiles/gabo/qa-v2-builtin-mcps.mjs` (vivo `/api/mcp`); `profiles/gabo/integration-manifest.json` (mcpPolicy.omoBuiltinsRetained)",
  },
  "grep-app": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El MCP remoto tier-1 `grep_app` de `packages/omo-opencode/src/mcp/grep-app.ts` se registra nativamente con `context.mcp.transform` (`registerNativeBuiltinMcps` en `rigel-v2-native-builtin-mcps.mjs`) porque el host V2 no lo lista. Conserva la definición V1 `{type:remote,url:https://mcp.grep.app,oauth:false}` y la política `mcpPolicy.omoBuiltinsRetained`. La precedencia V1 de permisos (default-deny global + re-allow por agente) se corrigió para que el librarian pueda buscar (allow) y el resto siga denegado.",
    futureEvidence: "`profiles/gabo/opencode/rigel-v2-native-builtin-mcps.mjs` (GREP_APP_MCP); `profiles/gabo/opencode/rigel-v2-native-builtin-mcps.test.mjs`; `profiles/gabo/opencode/rigel-v2-native-permissions.mjs` (precedencia); `profiles/gabo/qa-v2-builtin-mcps.mjs` (vivo)",
  },
  lsp: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El MCP local stdio tier-1 `lsp` de `packages/omo-opencode/src/mcp/lsp.ts` se registra nativamente con `context.mcp.transform` (`createLspMcpConfig` en `rigel-v2-native-builtin-mcps.mjs`), conservando la resolución dist/fuente, el env por proyecto/config y el daemon compartido. El bootstrap npm se elimina porque no resuelve el protocolo `workspace:*` del repo: la resolución prefiere el dist autocontenido que el instalador materializa en el despliegue (no la fuente temporal) y degrada a servidor deshabilitado cuando no hay CLI. La documentación oficial V2 (migrate-v1) confirma que V2 acepta `lsp` pero NO ejecuta language servers ni expone tools LSP, así que `lsp: true` no basta: el servidor se registra como V1 lo hacía. El gate de permisos también se corrigió: los built-ins PascalCase `Lsp*` ya no colapsan sobre la familia retenida `lsp_*`.",
    futureEvidence: "`profiles/gabo/opencode/rigel-v2-native-builtin-mcps.mjs` (createLspMcpConfig); `profiles/gabo/opencode/rigel-v2-native-builtin-mcps.test.mjs`; `profiles/gabo/opencode/rigel-v2-native-permissions.mjs`; `profiles/gabo/qa-v2-builtin-mcps.mjs` (vivo)",
  },
  "runtime-executable": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El resolvedor `resolveRuntimeExecutable` de `packages/omo-opencode/src/mcp/runtime-executable.ts` es soporte de runtime del MCP local tier-1 `lsp`, porque localiza node o bun de forma segura. Se porta a `rigel-v2-native-builtin-mcps.mjs` (`whichExecutable`/`resolveRuntimeExecutable`, incluido el rechazo de nombres inseguros) y lo consume el resolvedor del servidor `lsp`.",
    futureEvidence: "`profiles/gabo/opencode/rigel-v2-native-builtin-mcps.mjs` (resolveRuntimeExecutable consumido por resolveLspCommand); `profiles/gabo/opencode/rigel-v2-native-builtin-mcps.test.mjs`",
  },
  shared: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El resolvedor `createAncestorCliCandidates` de `packages/omo-opencode/src/mcp/shared/ancestor-cli-resolver.ts` es soporte de runtime del MCP local tier-1 `lsp`, porque busca el CLI en directorios ancestros. Se porta a `rigel-v2-native-builtin-mcps.mjs` (`createAncestorCliCandidates`/`resolveJavaScriptRuntime`) anclado al repo root materializado en el manifiesto, y lo consume el resolvedor del servidor `lsp`.",
    futureEvidence: "`profiles/gabo/opencode/rigel-v2-native-builtin-mcps.mjs` (createAncestorCliCandidates consumido por resolveLspCommand); `profiles/gabo/opencode/rigel-v2-native-builtin-mcps.test.mjs`",
  },
  websearch: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El MCP remoto tier-1 `websearch` de `packages/omo-opencode/src/mcp/websearch.ts` se cubre con la superficie host-provided de V2 (`context.websearch`) y la política `mcpPolicy.websearch` de `profiles/gabo/integration-manifest.json` fija Tavily como proveedor del perfil; el runtime nativo no emite un servidor websearch propio.",
    futureEvidence: "`profiles/gabo/opencode/rigel-v2-native-builtin-mcps.mjs` (websearch host-provided, no emitido); `profiles/gabo/integration-manifest.json` (mcpPolicy.websearch); `profiles/gabo/omo.jsonc` (websearch.provider tavily)",
  },
}
