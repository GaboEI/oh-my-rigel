## Summary / Resumen

<!-- Explain what changed, why, and how observable behavior differs. Use plain reviewer-facing language, not a file list. / Explica qué cambió, por qué y cómo difiere el comportamiento observable. Usa lenguaje claro para quien revisa, no una lista de archivos. -->

- <!-- summary item / punto del resumen -->

## Changes / Cambios

<!-- Group by reviewer-relevant area. Each bullet should say what changed and how it maps to the diff. / Agrupa por área relevante para la revisión. Cada punto debe indicar qué cambió y cómo se corresponde con el diff. -->

- <!-- change item / punto del cambio -->

## QA & Evidence / QA y evidencia

<!-- Follow the QA discipline in CONTRIBUTING.md: drive the real harness, not only typecheck or unit tests. Keep evidence local under .omo/evidence/ (gitignored, never committed) and paste only a sanitized summary here: what was tested, what was observed, the artifact path, and why it is sufficient. Redact secrets, tokens, auth headers, environment dumps, and machine paths. / Sigue la disciplina de QA de CONTRIBUTING.md: ejercita el harness real, no solo el typecheck o las pruebas unitarias. Mantén la evidencia local en .omo/evidence/ (ignorada por git, nunca commiteada) y pega aquí solo un resumen saneado: qué se probó, qué se observó, la ruta del artefacto y por qué es suficiente. Redacta secretos, tokens, cabeceras de autenticación, volcados de entorno y rutas de máquina. -->

- **What was tested / Qué se probó:** <!-- command or surface driven / comando o superficie ejercitada -->
  **Observed result / Resultado observado:** <!-- actual result / resultado real -->
  **Artifact / Artefacto:** <!-- saved sanitized artifact or log path / ruta del artefacto o log saneado -->
  **Why sufficient / Por qué es suficiente:** <!-- covered behavior or remaining risk / comportamiento cubierto o riesgo restante -->

## Risks & Residuals / Riesgos y pendientes

<!-- Map each meaningful risk to the evidence above and state the conclusion: mitigated, accepted, blocked, or not applicable. / Relaciona cada riesgo relevante con la evidencia anterior e indica la conclusión: mitigado, aceptado, bloqueado o no aplicable. -->

- <!-- risk item / punto de riesgo -->

## Screenshots / Capturas

<!-- If applicable, add before/after screenshots or GIFs. Delete this section if not needed. / Si aplica, agrega capturas o GIF de antes y después. Elimina esta sección si no es necesaria. -->

| Before / Antes | After / Después |
|:---:|:---:|
|  |  |

## Automated checks / Verificaciones automáticas

<!-- Keep only the commands you actually ran. Explain unavailable gates in Risks & Residuals. See CONTRIBUTING.md for the full PR checklist. / Conserva solo los comandos que realmente ejecutaste. Explica las comprobaciones no disponibles en Riesgos y pendientes. Consulta CONTRIBUTING.md para la lista completa del PR. -->

- [ ] `bun run typecheck`
- [ ] `bun run build`
- [ ] `bun test`
- [ ] `bun run test:codex` <!-- if the Codex side changed / si cambió el lado Codex -->

## Related issues / Issues relacionados

<!-- Link related issues. Use "Closes #123" to auto-close on merge. / Enlaza issues relacionados. Usa "Closes #123" para cerrarlos al hacer merge. -->

<!-- Closes # -->
