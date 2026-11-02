import * as z from "zod"

/**
 * A credential written as a REFERENCE instead of a literal, which is the whole
 * point of this schema (`Contrato_Transportes_OpenClaw.md` §8):
 *
 *   token: "env:DISCORD_BOT_TOKEN"        // short form
 *   token: { env: "DISCORD_BOT_TOKEN" }   // preferred form
 *
 * The union is a WIDENING: a plaintext string keeps validating exactly as before,
 * because every existing configuration holds one. The object branch is strict
 * (`{ env: "X", other: 1 }` is not a reference) so a malformed attempt fails here
 * instead of reaching a transport as an unusable credential.
 */
export const OmoOpenclawSecretRefSchema = z.union([
  z.string(),
  z.object({ env: z.string().min(1) }).strict(),
])

/**
 * The reply-listener block.
 *
 * Only the two credential fields are typed, because they are the fields whose
 * accepted shape this schema adds. Everything else stays open through `catchall`:
 * the runtime's own normalizer is the authority for their shape, and tightening
 * them here would reject configurations that work today.
 *
 * Both credentials are `.optional()` and carry NO default on purpose. The schema
 * generator marks a field `required` when it has a default, so an optional field
 * without one cannot invalidate an existing configuration. That is the entire
 * reason `{ env: ... }` is safe to introduce at all.
 */
export const OmoOpenclawReplyListenerSchema = z.object({
  discordBotToken: OmoOpenclawSecretRefSchema.optional(),
  telegramBotToken: OmoOpenclawSecretRefSchema.optional(),
}).catchall(z.unknown())

/**
 * The `openclaw` block. It stays permissive outside `replyListener` for the same
 * reason: this schema must accept every configuration the runtime accepts.
 */
export const OmoOpenclawConfigSchema = z.object({
  replyListener: OmoOpenclawReplyListenerSchema.optional(),
}).catchall(z.unknown())
