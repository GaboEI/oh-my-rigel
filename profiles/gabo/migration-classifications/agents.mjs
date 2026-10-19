// Clasificacion de las superficies de `packages/omo-opencode/src/agents/`
// para el espejo nativo V2. Consumido por generate-v2-migration-inventory.mjs.
// Cada entrada: { classification, rationale, futureEvidence }.
export default {
  "agent-builder": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "agent-builder.ts compone el AgentConfig con buildAgent a partir de factories y overrides de categoria durante la generacion, y su salida queda horneada en el manifiesto V2 sin superficie de runtime propia.",
    futureEvidence: "contract:rigel-v2-native-agents.mjs; contract:rigel-v2-native-agents.test.mjs; generate-v2-agents.mjs",
  },
  "agent-skill-resolution": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "agent-skill-resolution.ts resuelve las skills declaradas por el agente e inserta su contenido en el prompt al armar la configuracion, por lo que solo actua en la generacion del manifiesto.",
    futureEvidence: "contract:rigel-v2-native-skills.mjs; contract:rigel-v2-native-skills-injection.test.mjs",
  },
  atlas: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "atlas/agent.ts define el orquestador primario, sus prompts por modelo y su modo; el manifiesto nativo y rigel-v2-native-agents.mjs deben registrar su roster y su modo no delegable.",
    futureEvidence: "rigel-v2-native-agents.mjs; v2-agent-selection.json; generate-v2-agents.mjs",
  },
  "builtin-agents": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "builtin-agents/ contiene las factorias condicionales que arman el roster y aplican overrides, resolucion de modelo y permisos antes de escribir el manifiesto, incluido el gate de Hephaestus, por lo que su efecto debe reproducirse en V2.",
    futureEvidence: "`rigel-v2-native-agents.mjs`; `generate-v2-agents.mjs`; `v2-agent-selection.json`",
  },
  "dynamic-agent-category-skills-guide": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "dynamic-agent-category-skills-guide.ts ensambla las secciones de guia de categorias y skills del prompt de Sisyphus en tiempo de generacion y no tiene superficie de runtime.",
    futureEvidence: "contract:rigel-v2-native-sisyphus-prompt.mjs; contract:rigel-v2-native-sisyphus-prompt.test.mjs",
  },
  "dynamic-agent-core-sections": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "dynamic-agent-core-sections.ts arma las secciones base del prompt, desde identidad hasta tablas de delegacion, durante la generacion del agente.",
    futureEvidence: "contract:rigel-v2-native-sisyphus-prompt.mjs; contract:rigel-v2-native-sisyphus-prompt.test.mjs",
  },
  "dynamic-agent-policy-sections": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "dynamic-agent-policy-sections.ts arma las secciones de politicas y bloques duros del prompt en tiempo de generacion.",
    futureEvidence: "contract:rigel-v2-native-sisyphus-prompt.mjs; contract:rigel-v2-native-sisyphus-prompt.test.mjs",
  },
  "dynamic-agent-prompt-builder": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "dynamic-agent-prompt-builder.ts es un barrel que reexporta los constructores de secciones y solo participa en el armado del prompt de generacion.",
    futureEvidence: "contract:rigel-v2-native-sisyphus-prompt.mjs; contract:rigel-v2-native-sisyphus-prompt.test.mjs",
  },
  "dynamic-agent-prompt-types": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "dynamic-agent-prompt-types.ts define los tipos de las secciones dinamicas del prompt y no aporta comportamiento de runtime.",
    futureEvidence: "contract:rigel-v2-native-sisyphus-prompt.mjs; contract:rigel-v2-native-sisyphus-prompt.test.mjs",
  },
  "dynamic-agent-tool-categorization": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "dynamic-agent-tool-categorization.ts clasifica herramientas para el prompt de generacion y no expone superficie de runtime.",
    futureEvidence: "contract:rigel-v2-native-categories.mjs; contract:rigel-v2-native-categories.test.mjs",
  },
  "env-context": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "env-context.ts produce el bloque de timezone y locale que se anexa al prompt al generar la configuracion, por lo que su valor queda horneado en el manifiesto.",
    futureEvidence: "contract:rigel-v2-native-sisyphus-prompt.mjs; contract:rigel-v2-native-agent-manifest.mjs",
  },
  explore: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "explore.ts define el subagente de busqueda con sus restricciones de herramientas y metadatos; el manifiesto V2 debe incluir su definicion y su cadena de fallback.",
    futureEvidence: "`rigel-v2-native-agents.mjs`; `generate-v2-agents.mjs`; `v2-agent-selection.json`; `rigel-v2-native-prompt.mjs`",
  },
  "frontier-tool-schema-guard": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "frontier-tool-schema-guard.ts niega grep y glob para modelos frontier; en V2 debe adaptarse al vocabulario de acciones y recursos del modelo de permisos de AgentV2Info.",
    futureEvidence: "`rigel-v2-native-permissions.mjs`; `rigel-v2-native-agents.mjs`; `rigel-v2-native-agents.test.mjs`",
  },
  "gpt-apply-patch-guard": {
    classification: "Adaptar",
    status: "Migrado",
    rationale:
      "Las guias de edicion para modelos GPT de `agents/gpt-apply-patch-guard.ts` (constantes byte-identicas) se portan a un selector puro por modelo (`rigel-v2-native-gpt-edit-guidance.mjs`). El runtime nativo NO inyecta una sola guia: `hostExposesPatchTool` replica el predicado del host (`gpt-` sin `oss` ni `gpt-4`) y, para esos ids, inyecta la guia patch-only que nombra `apply_patch`/`patch` y declara `edit`/`write` no disponibles. La presencia de `hashline_edit` se resuelve desde el catalogo `event.tools` de la peticion, que es lo que el modelo vera, y si el host no expone catalogo desde el gate `hashline_edit` (encendido en el perfil Gabo via `omo.jsonc`); en ambos casos inyecta la variante que tambien nombra `hashline_edit` y deja de afirmar que patch es el unico editor. Para los ids GPT que conservan `edit`/`write` (`gpt-4*`, `oss`, y los ids sin `gpt-` como `codex-mini-latest` u `o1`/`o3`/`o4`) conserva la guia generica V1 byte-identica; un id que contiene `gpt-` y ademas `codex` (por ejemplo `gpt-5-codex`) cae en la rama patch-only, y para un modelo no-GPT no inyecta nada. La inyeccion viaja en el canal `system` del hook `context` con marcador idempotente. Contrato de seleccion por modelo, por catalogo de tools y por gate en el seam real.",
    futureEvidence: "`rigel-v2-native-gpt-edit-guidance.mjs`; `rigel-v2-native-gpt-edit-guidance.test.mjs`; `rigel-v2-native-gpt-edit-guidance-wiring.test.mjs`; `rigel-v2-native-prompt.mjs` (hook context); `rigel-v2-native.mjs` (`hashlineEditEnabled`)",
  },
  "gpt-prompt-identity": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "gpt-prompt-identity.ts mapea el modelo a la identidad textual usada por los prompts de Sisyphus y Sisyphus-Junior en tiempo de generacion.",
    futureEvidence: "contract:rigel-v2-native-sisyphus-prompt.mjs; contract:rigel-v2-native-sisyphus-prompt.test.mjs",
  },
  hephaestus: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "hephaestus/agent.ts define el agente autonomo primario y su gate de modelo soportado; el roster nativo debe restaurarlo con el gate de proveedor sobre el manifiesto.",
    futureEvidence: "rigel-v2-native-hephaestus.mjs; rigel-v2-native-hephaestus.test.mjs; v2-agent-selection.json",
  },
  "kimi-tool-loop-guard": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "kimi-tool-loop-guard.ts es una guia textual que evita llamadas repetidas; se migra como parte del prompt del agente hacia la frontera de herramientas V2.",
    futureEvidence: "contract:rigel-v2-native-sisyphus-prompt.mjs; contract:rigel-v2-native-prompt.test.mjs",
  },
  librarian: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "librarian.ts define el subagente de busqueda externa con sus restricciones; su definicion y su cadena de fallback deben portarse al manifiesto nativo.",
    futureEvidence: "`rigel-v2-native-agents.mjs`; `generate-v2-agents.mjs`; `v2-agent-selection.json`; `rigel-v2-native-prompt.mjs`",
  },
  metis: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "metis.ts define el consultor de pre-planificacion con prompts por modelo y restricciones; el manifiesto nativo debe portar su definicion y fallback.",
    futureEvidence: "`rigel-v2-native-agents.mjs`; `generate-v2-agents.mjs`; `v2-agent-selection.json`; `rigel-v2-native-prompt.mjs`",
  },
  momus: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "momus.ts define el revisor de planes y selecciona el prompt segun el modelo; su definicion debe portarse al manifiesto nativo.",
    futureEvidence: "`rigel-v2-native-agents.mjs`; `generate-v2-agents.mjs`; `v2-agent-selection.json`; `rigel-v2-native-prompt.mjs`",
  },
  "momus-gpt-5-6": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "momus-gpt-5-6.ts es la variante de prompt GPT-5.6 consumida por momus.ts; la definicion de Momus en V2 debe conservar esa seleccion por modelo.",
    futureEvidence: "`rigel-v2-native-agents.mjs`; `generate-v2-agents.mjs`; `v2-agent-selection.json`; `rigel-v2-native-prompt.mjs`",
  },
  "multimodal-looker": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "multimodal-looker.ts define el subagente de analisis de medios con allowlist de solo lectura; el modelo de permisos V2 debe reproducir su bloqueo restrictivo.",
    futureEvidence: "`rigel-v2-native-agents.mjs`; `v2-agent-selection.json`",
  },
  oracle: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "oracle.ts define el consultor de solo lectura con prompts por modelo y su cadena de fallback; el manifiesto nativo debe portar la definicion.",
    futureEvidence: "`rigel-v2-native-agents.mjs`; `generate-v2-agents.mjs`; `v2-agent-selection.json`; `rigel-v2-native-prompt.mjs`",
  },
  prometheus: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "prometheus/system-prompt.ts carga el prompt del planificador y su permiso; el manifiesto V2 debe registrar su modo primary y su no delegabilidad.",
    futureEvidence: "rigel-v2-native-agents.mjs; v2-agent-selection.json; generate-v2-agents.mjs",
  },
  sisyphus: {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "sisyphus-agent-factory.ts y el directorio sisyphus/ seleccionan el prompt por modelo y arman el agente orquestador principal; su definicion debe portarse al manifiesto nativo.",
    futureEvidence: "`rigel-v2-native-agents.mjs`; `generate-v2-agents.mjs`; `v2-agent-selection.json`; `rigel-v2-native-prompt.mjs`",
  },
  "sisyphus-agent-config": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "sisyphus-agent-config.ts construye las variantes de AgentConfig de Sisyphus por modelo en tiempo de generacion, sin superficie de runtime.",
    futureEvidence: "contract:rigel-v2-native-agents.mjs; contract:rigel-v2-native-agents.test.mjs; generate-v2-agents.mjs",
  },
  "sisyphus-agent-factory": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "sisyphus-agent-factory.ts enruta al prompt de Sisyphus segun el modelo y compone el AgentConfig durante la generacion del manifiesto.",
    futureEvidence: "contract:rigel-v2-native-agents.mjs; contract:rigel-v2-native-agents.test.mjs; generate-v2-agents.mjs",
  },
  "sisyphus-dynamic-prompt": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "sisyphus-dynamic-prompt.ts orquesta el armado dinamico del prompt de Sisyphus y aplica overrides de Gemini en tiempo de generacion.",
    futureEvidence: "contract:rigel-v2-native-sisyphus-prompt.mjs; contract:rigel-v2-native-sisyphus-prompt.test.mjs",
  },
  "sisyphus-dynamic-prompt-builder": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "sisyphus-dynamic-prompt-builder.ts encadena los renderizadores de secciones del prompt dinamico de Sisyphus durante la generacion.",
    futureEvidence: "contract:rigel-v2-native-sisyphus-prompt.mjs; contract:rigel-v2-native-sisyphus-prompt.test.mjs",
  },
  "sisyphus-dynamic-prompt-execution": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "sisyphus-dynamic-prompt-execution.ts renderiza la seccion de ejecucion y delegacion del prompt de Sisyphus durante la generacion.",
    futureEvidence: "contract:rigel-v2-native-sisyphus-prompt.mjs; contract:rigel-v2-native-sisyphus-prompt.test.mjs",
  },
  "sisyphus-dynamic-prompt-exploration": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "sisyphus-dynamic-prompt-exploration.ts renderiza la seccion de exploracion y busqueda paralela del prompt de Sisyphus en la generacion.",
    futureEvidence: "contract:rigel-v2-native-sisyphus-prompt.mjs; contract:rigel-v2-native-sisyphus-prompt.test.mjs",
  },
  "sisyphus-dynamic-prompt-role": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "sisyphus-dynamic-prompt-role.ts renderiza las secciones de rol e intent gate del prompt de Sisyphus en tiempo de generacion.",
    futureEvidence: "contract:rigel-v2-native-sisyphus-prompt.mjs; contract:rigel-v2-native-sisyphus-prompt.test.mjs",
  },
  "sisyphus-dynamic-prompt-sections": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "sisyphus-dynamic-prompt-sections.ts recolecta las secciones que arman el prompt de Sisyphus durante la generacion.",
    futureEvidence: "contract:rigel-v2-native-sisyphus-prompt.mjs; contract:rigel-v2-native-sisyphus-prompt.test.mjs",
  },
  "sisyphus-dynamic-prompt-style": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "sisyphus-dynamic-prompt-style.ts renderiza la seccion de tono y restricciones del prompt de Sisyphus durante la generacion.",
    futureEvidence: "contract:rigel-v2-native-sisyphus-prompt.mjs; contract:rigel-v2-native-sisyphus-prompt.test.mjs",
  },
  "sisyphus-gemini-fallback-overrides": {
    classification: "Interno de build (sin superficie de runtime)",
    status: "Migrado",
    rationale:
      "sisyphus-gemini-fallback-overrides.ts inserta overrides de Gemini en el prompt ya armado durante la generacion del agente.",
    futureEvidence: "contract:rigel-v2-native-sisyphus-prompt.mjs; contract:rigel-v2-native-sisyphus-prompt.test.mjs",
  },
  "sisyphus-junior": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "sisyphus-junior/agent.ts define el ejecutor por categoria con sus defaults y prompts por modelo; el manifiesto nativo debe llevar su maxTokens y su tuning al payload V2.",
    futureEvidence: "`rigel-v2-native-agents.mjs`; `generate-v2-agents.mjs`; `v2-agent-selection.json`; `rigel-v2-native-prompt.mjs`",
  },
  "sisyphus-runtime-prompt-reconciler": {
    classification: "Migrar",
    status: "Migrado",
    rationale:
      "El cuerpo del prompt de Sisyphus es dependiente del modelo (experimento: el mismo pipeline de registro genera cuerpos distintos por cada modelo exacto; el proveedor no influye). V1 lo reconstruia por request en el system-transform (#5297/#5316/#6966). El runtime nativo lo adapta sobre el hook `context`: el generador hornea el cuerpo de Sisyphus para cada modelo que el runtime puede resolver (la cadena de fallback, el modelo del manifiesto y las identidades gpt explicitas, Astra incluida) y `rigel-v2-native-sisyphus-prompt.mjs` intercambia el cuerpo baked por el del modelo de runtime, con cache por modelo, en `event.system`. Un modelo fuera del conjunto baked no se silencia: se registra un recibo observable (`sisyphus-prompt-reconciled.json`, razon `model-not-baked`); Astra se resuelve de forma explicita (un selector accidental como `custom-gpt-6-astra` no selecciona el cuerpo Astra). No toca los prompts de otros agentes. Gate de delta upstream: el fix de formato de ejemplos (65f159da3) se sincroniza en los owners Sisyphus (ejemplos como lineas planas, sin blockquotes accidentales) y la deteccion explicita de Astra (2096e7805) se refleja en el conjunto baked; ambos con contrato estructural, parity test y QA viva.",
    futureEvidence:
      "`rigel-v2-native-sisyphus-prompt.mjs`; `rigel-v2-native-prompt.mjs` (hook `context`); `generate-v2-agents.mjs`; `rigel-v2-native-sisyphus-prompt.test.mjs`; `qa-v2-t28-sisyphus-prompt.mjs`; `.omo/evidence/20261007-t28-sisyphus-prompt/task-28.txt`",
  },
}
