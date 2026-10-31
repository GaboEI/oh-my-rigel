/**
 * Rewrite model-facing legacy delegation examples to native V2 tool syntax.
 * Shared commands also contain a Codex-only compatibility table. Its OpenCode
 * side must still name the V2 tool, while its Codex-native translation remains
 * intact. Both legacy delegation APIs therefore map to the one V2 tool name.
 */
export function rewriteLegacyDelegationToolExamples(prompt) {
  if (typeof prompt !== "string" || prompt.length === 0) return prompt
  return replaceLegacyCalls(prompt)
    .replace("`rigel_task(...)`, `rigel_task(...)`,", "`rigel_task(...)`,")
}

function replaceLegacyCalls(text) {
  return text.replace(/\b(?:call_omo_agent|task)\(/g, "rigel_task(")
}
