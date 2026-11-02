/**
 * Native V2 OpenClaw REPLY POLICY: explicit authorization for the reply surface
 * (`Unidades_Atomicas_OpenClaw.md` §U6).
 *
 * The legacy reply listener gates its Discord poller on
 * `token && channelId && authorizedDiscordUserIds.length > 0`
 * (`rigel-v2-native-openclaw-inbound.mjs`). Three of those four are configured
 * credentials; the fourth is an AUTHORIZATION, and today an empty list disables
 * the poller without a single line. That silence is the defect this module
 * removes for the new namespace: §9.3 keeps an *unauthorized author* silent
 * (answering would be an oracle), but a configuration with no authorized author
 * at all is a configuration error and has to be named.
 *
 * Two rules decide the shape here:
 *
 *   - **The new namespace can declare authorization, and only it can.** §5.1
 *     gives the intermediate representation a `replyPolicy` map keyed by
 *     identity; `openclaw.replyPolicy.<identity>.allowedAuthors` is that map in
 *     raw configuration. A declared policy GOVERNS its identity: the legacy
 *     `replyListener.authorizedDiscordUserIds` is not consulted and the two
 *     lists are never merged field by field (§5.2 rules 2 and 5 — merging would
 *     give a legacy record new semantics).
 *   - **Legacy keeps its silent disablement.** A configuration without
 *     `replyPolicy` and without `channels` is governed exactly as before, so
 *     `Contrato_Transportes_OpenClaw.md` §5.2 rule 1 holds and the pinned
 *     listener tests keep their call sequence.
 *
 * Fail closed, never fail open: a policy that is not usable yields no authorized
 * author, so the poller stays down. Fail-open here would turn a misconfigured
 * authorization into a poller that answers anybody.
 */

import { isPlainObject } from "./rigel-v2-native-openclaw-core.mjs"

/**
 * Identities a `replyPolicy` block may name today. `discord-bot` is the platform
 * tag the chat correlation registry already writes for a Discord wake, so a
 * policy names the same identity the poller reads. Telegram's user filter is a
 * separate seam (`§U7`); naming it here before that unit exists would give an
 * unimplemented identity the appearance of support.
 */
export const OPENCLAW_REPLY_POLICY_IDENTITIES = Object.freeze(["discord-bot"])

/** Keys a `replyPolicy.<identity>` block may carry. `allowedAuthors` is the gate. */
export const OPENCLAW_REPLY_POLICY_KEYS = Object.freeze(["allowedAuthors"])

function isAuthorList(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.length > 0)
}

/**
 * Human text for one rejected policy block. Names the exact configuration path
 * and, when known, the environment variable; never an author id, because a user
 * id in a log line is data the operator did not ask to publish.
 */
export function describeOpenclawReplyPolicyDiagnostic(diagnostic) {
  const path = typeof diagnostic?.path === "string" ? diagnostic.path : "openclaw.replyPolicy"
  const reason = diagnostic?.reason
  if (reason === "not-an-object") return `reply policy ${path} is not an object; that identity stays unauthorized`
  if (reason === "unsupported-identity") return `reply policy ${path} names an identity this runtime does not serve; it is ignored`
  if (reason === "unknown-key") return `reply policy ${path} is not a known key; that identity stays unauthorized`
  if (reason === "invalid-authorized-authors") return `reply policy ${path} must list non-empty author ids; that identity stays unauthorized`
  if (reason === "missing-authorized-authors") return `reply policy ${path} is missing, so no author is authorized; that identity stays unauthorized`
  return `reply policy ${path} is not usable (${String(reason)}); that identity stays unauthorized`
}

/**
 * Resolve the raw `openclaw.replyPolicy` block into the identities it actually
 * authorizes plus one diagnostic per rejected block.
 *
 * `declared` is true whenever the key exists, even when every block is invalid:
 * that is what makes the absence of authorization REPORTABLE instead of
 * indistinguishable from a configuration that never mentioned the namespace.
 *
 * @param {unknown} rawPolicy raw `openclaw.replyPolicy` from the live chain
 * @returns {{ declared: boolean, identities: Array<{ identity: string, allowedAuthors: string[] }>, diagnostics: Array<{ path: string, reason: string, identity: string|null }> }}
 */
export function resolveOpenclawReplyPolicy(rawPolicy) {
  const identities = []
  const diagnostics = []
  if (rawPolicy === undefined || rawPolicy === null) return { declared: false, identities, diagnostics }
  if (!isPlainObject(rawPolicy)) {
    return {
      declared: true,
      identities,
      diagnostics: [{ path: "openclaw.replyPolicy", reason: "not-an-object", identity: null }],
    }
  }

  for (const [identity, block] of Object.entries(rawPolicy)) {
    const path = `openclaw.replyPolicy.${identity}`
    if (!OPENCLAW_REPLY_POLICY_IDENTITIES.includes(identity)) {
      diagnostics.push({ path, reason: "unsupported-identity", identity: null })
      continue
    }
    if (!isPlainObject(block)) {
      diagnostics.push({ path, reason: "not-an-object", identity })
      continue
    }
    const unknownKey = Object.keys(block).find((key) => !OPENCLAW_REPLY_POLICY_KEYS.includes(key))
    if (unknownKey !== undefined) {
      diagnostics.push({ path: `${path}.${unknownKey}`, reason: "unknown-key", identity })
      continue
    }
    const authors = block.allowedAuthors
    if (!Array.isArray(authors) || authors.length === 0) {
      diagnostics.push({ path: `${path}.allowedAuthors`, reason: "missing-authorized-authors", identity })
      continue
    }
    if (!isAuthorList(authors)) {
      diagnostics.push({ path: `${path}.allowedAuthors`, reason: "invalid-authorized-authors", identity })
      continue
    }
    identities.push({ identity, allowedAuthors: [...new Set(authors)] })
  }

  // Declaring the block without naming the served identity IS the absence of
  // authorization, so it is reported rather than treated as an empty namespace.
  if (identities.length === 0 && !diagnostics.some((diagnostic) => diagnostic.identity === "discord-bot")) {
    diagnostics.push({ path: "openclaw.replyPolicy.discord-bot", reason: "missing-authorized-authors", identity: "discord-bot" })
  }

  return { declared: true, identities, diagnostics }
}

/**
 * The authorization the Discord inbound poller must apply, derived from a
 * resolved policy.
 *
 * `explicit` is false when the policy was declared but authorized nobody: the
 * poller then stays down (fail closed) and the composition reports why. Returning
 * the descriptor even when it authorizes nobody is deliberate — the caller must be
 * able to tell "legacy, no list, silently off" from "new namespace, no list,
 * reported".
 *
 * @param {ReturnType<typeof resolveOpenclawReplyPolicy>} policy
 * @returns {{ source: "replyPolicy", explicit: boolean, allowedAuthors: string[] }}
 */
export function authorizeDiscordAuthors(policy) {
  const entry = Array.isArray(policy?.identities)
    ? policy.identities.find((candidate) => candidate?.identity === "discord-bot")
    : undefined
  const allowedAuthors = entry && Array.isArray(entry.allowedAuthors) ? [...entry.allowedAuthors] : []
  return { source: "replyPolicy", explicit: allowedAuthors.length > 0, allowedAuthors }
}
