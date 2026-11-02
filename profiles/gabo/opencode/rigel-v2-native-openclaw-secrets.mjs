/**
 * Native V2 OpenClaw secret references (`Contrato_Transportes_OpenClaw.md` §8).
 *
 * A credential may be written as a reference instead of a literal:
 *
 *   token: "env:DISCORD_BOT_TOKEN"        // short form
 *   token: { env: "DISCORD_BOT_TOKEN" }   // preferred form
 *
 * Both forms name an environment variable; neither carries the secret, so the
 * install-time manifest can keep the reference verbatim instead of baking a
 * plaintext credential onto disk. A plaintext string keeps working, because
 * every existing configuration is written that way.
 *
 * Failure is fail-closed PER SURFACE, never per plugin: an unresolvable or
 * malformed reference removes that surface's token, so exactly that surface
 * stays down while the others keep working. A diagnostic names the configuration
 * key and, when it exists, the environment variable - never a value, because the
 * whole point of a reference is that a leaked log line cannot leak the secret.
 *
 * Reference parsing is deliberately narrow: only a string with the `env:` prefix
 * or an object is interpreted as a reference. Any other scalar is passed through
 * untouched, so a legacy value this module never documented cannot change
 * behavior by passing through it.
 *
 * Only sibling native modules are imported so the flat laboratory runtime can
 * load this module.
 */
import { isPlainObject } from "./rigel-v2-native-openclaw-core.mjs"

const ENV_REFERENCE_PREFIX = "env:"
/** A POSIX-ish environment variable name: no `=`/`:`/whitespace, never empty. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * The credential-bearing fields this runtime consumes today, in a stable order.
 *
 * The new `channels.a2a.peers.<name>.token` namespace is NOT listed here: nothing
 * in this runtime serves A2A yet, so resolving those references now would have no
 * consumer and no observable effect.
 */
const SECRET_FIELDS = Object.freeze([
  Object.freeze({ key: "discordBotToken", surface: "discord", path: "openclaw.replyListener.discordBotToken" }),
  Object.freeze({ key: "telegramBotToken", surface: "telegram", path: "openclaw.replyListener.telegramBotToken" }),
])

/**
 * Classify a credential value.
 *
 * @param {unknown} value
 * @returns {{ kind: "env", name: string } | { kind: "plaintext" } | { kind: "opaque" } | { kind: "invalid", reason: string }}
 */
export function parseOpenclawSecretRef(value) {
  if (typeof value === "string") {
    if (!value.startsWith(ENV_REFERENCE_PREFIX)) return { kind: "plaintext" }
    const name = value.slice(ENV_REFERENCE_PREFIX.length)
    return ENV_NAME_PATTERN.test(name)
      ? { kind: "env", name }
      : { kind: "invalid", reason: "malformed-env-reference" }
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    // An object credential is only ever an environment reference. A different
    // object cannot be sent as a header or a URL segment, so treating it as a
    // usable credential would be the silent failure this contract forbids.
    if (!keys.includes("env")) return { kind: "invalid", reason: "unknown-secret-reference" }
    if (keys.length !== 1) return { kind: "invalid", reason: "malformed-env-reference" }
    return typeof value.env === "string" && ENV_NAME_PATTERN.test(value.env)
      ? { kind: "env", name: value.env }
      : { kind: "invalid", reason: "malformed-env-reference" }
  }
  return { kind: "opaque" }
}

/**
 * Resolve one credential value against the environment.
 *
 * @param {unknown} value
 * @param {{ env?: Record<string, string|undefined> }} [options]
 * @returns {{ ok: true, value: unknown } | { ok: false, reason: string, envName?: string }}
 */
export function resolveOpenclawSecretRef(value, { env } = {}) {
  const parsed = parseOpenclawSecretRef(value)
  if (parsed.kind === "plaintext" || parsed.kind === "opaque") return { ok: true, value }
  if (parsed.kind === "invalid") return { ok: false, reason: parsed.reason }
  const candidate = isPlainObject(env) ? env[parsed.name] : undefined
  if (candidate === undefined) return { ok: false, reason: "missing-env-variable", envName: parsed.name }
  if (typeof candidate !== "string" || candidate.length === 0) {
    return { ok: false, reason: "empty-env-variable", envName: parsed.name }
  }
  return { ok: true, value: candidate }
}

function describeFailure(path, failure) {
  if (failure.envName !== undefined) {
    return `credential ${path} names ${failure.envName}, which ${failure.reason === "empty-env-variable" ? "is empty" : "is not set"}; that surface stays disabled`
  }
  return `credential ${path} is not a usable secret reference (expected "env:VAR" or { env: "VAR" }); that surface stays disabled`
}

/**
 * Resolve every credential of a normalized `openclaw.replyListener` block.
 *
 * Returns a block whose tokens are the resolved plaintext values the transport
 * already consumes, plus one diagnostic per surface that has to stay down. A
 * disabled surface's token is REMOVED rather than blanked, so the listener's own
 * presence rule keeps that platform off without this module duplicating it.
 *
 * The resolved block is a fresh object; every field this module does not touch is
 * carried by reference, so a plaintext configuration behaves exactly as before.
 *
 * @param {object|undefined} replyListener
 * @param {{ env?: Record<string, string|undefined> }} [options]
 * @returns {{ replyListener: object|undefined, diagnostics: string[], disabled: Array<{ surface: string, path: string, reason: string, envName?: string }> }}
 */
export function resolveOpenclawReplyListenerSecrets(replyListener, { env } = {}) {
  if (!isPlainObject(replyListener)) return { replyListener, diagnostics: [], disabled: [] }
  const resolved = { ...replyListener }
  const diagnostics = []
  const disabled = []
  for (const field of SECRET_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(replyListener, field.key)) continue
    const failure = resolveOpenclawSecretRef(replyListener[field.key], { env })
    if (failure.ok) {
      resolved[field.key] = failure.value
      continue
    }
    delete resolved[field.key]
    disabled.push({ surface: field.surface, path: field.path, reason: failure.reason, ...(failure.envName !== undefined ? { envName: failure.envName } : {}) })
    diagnostics.push(describeFailure(field.path, failure))
  }
  return { replyListener: resolved, diagnostics, disabled }
}

/**
 * Report how an `openclaw` block carries its credentials, for the install-time
 * manifest generator.
 *
 * `references` names the key paths that already use the reference form, which are
 * written to the manifest verbatim (so no secret reaches disk). `plaintext` names
 * the key paths still holding a literal, which keep working but are deprecated.
 * `invalid` names the key paths whose value parses as neither form, which the
 * runtime will fail closed. Values are never returned: the caller has no way to
 * print a secret by accident.
 *
 * @param {unknown} openclaw
 * @returns {{ references: string[], plaintext: string[], invalid: string[] }}
 */
export function auditOpenclawSecretRefs(openclaw) {
  const references = []
  const plaintext = []
  const invalid = []
  if (!isPlainObject(openclaw)) return { references, plaintext, invalid }
  const replyListener = openclaw.replyListener
  if (!isPlainObject(replyListener)) return { references, plaintext, invalid }
  for (const field of SECRET_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(replyListener, field.key)) continue
    const parsed = parseOpenclawSecretRef(replyListener[field.key])
    if (parsed.kind === "env") references.push(field.path)
    else if (parsed.kind === "plaintext") plaintext.push(field.path)
    else if (parsed.kind === "invalid") invalid.push(field.path)
  }
  return { references, plaintext, invalid }
}
