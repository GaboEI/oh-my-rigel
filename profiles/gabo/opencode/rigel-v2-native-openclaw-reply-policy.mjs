/**
 * Native V2 OpenClaw REPLY POLICY: explicit authorization for the reply surface
 * (`Unidades_Atomicas_OpenClaw.md` §U6) and its Telegram user filter (`§U7`).
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
 * Telegram has the same shape of defect one step further: its poller is gated on
 * `token && chatId` and filters messages by CHAT only, so anybody who can write in
 * that conversation reaches the session (defect 8). §U7 makes the user list
 * mandatory in the new namespace — `openclaw.replyPolicy.telegram.allowedAuthors`
 * — and lets legacy keep the chat-only filter it has always had.
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
 * Identities a `replyPolicy` block may name today. Each one is the platform tag
 * the chat correlation registry already writes for that wake — `discord-bot` for
 * a Discord bot message and `telegram` for a Telegram one — so a policy names
 * exactly the identity its poller reads.
 *
 * `telegram` arrived with §U7. It is the same key that used to be rejected as
 * `unsupported-identity`, and now it is the ONLY source of Telegram
 * authorization: the legacy reply listener has no user field at all (defect 8 —
 * it filters by chat only), so there is no legacy list for it to fall back to.
 */
export const OPENCLAW_REPLY_POLICY_IDENTITIES = Object.freeze(["discord-bot", "telegram"])

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
 * `declared` records the key's presence for diagnostics, but governance stays at
 * the identity level: a policy can report only the identity it names and never
 * manufacture authorization state for another inbound surface.
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


  return { declared: true, identities, diagnostics }
}

/**
 * The authorization one identity's poller must apply, derived from a resolved
 * policy.
 *
 * `explicit` is false when the policy was declared but authorized nobody: the
 * poller then stays down (fail closed) and the composition reports why. Returning
 * the descriptor even when it authorizes nobody is deliberate — the caller must be
 * able to tell "legacy, no list, silently off" from "new namespace, no list,
 * reported".
 *
 * @param {ReturnType<typeof resolveOpenclawReplyPolicy>} policy
 * @param {"discord-bot"|"telegram"} identity
 * @returns {{ source: "replyPolicy", explicit: boolean, allowedAuthors: string[] }}
 */
function authorizeIdentity(policy, identity) {
  const entry = Array.isArray(policy?.identities)
    ? policy.identities.find((candidate) => candidate?.identity === identity)
    : undefined
  const allowedAuthors = entry && Array.isArray(entry.allowedAuthors) ? [...entry.allowedAuthors] : []
  return { source: "replyPolicy", explicit: allowedAuthors.length > 0, allowedAuthors }
}

/**
 * The Discord inbound poller's authorization (`§U6`).
 *
 * @param {ReturnType<typeof resolveOpenclawReplyPolicy>} policy
 * @returns {{ source: "replyPolicy", explicit: boolean, allowedAuthors: string[] }}
 */
export function authorizeDiscordAuthors(policy) {
  return authorizeIdentity(policy, "discord-bot")
}

/**
 * The Telegram inbound poller's authorization (`§U7`).
 *
 * The list is of USERS (`message.from.id`), not chats: the chat filter keeps
 * narrowing the poll to the configured conversation, and this narrows it to the
 * people allowed to write in it. One field name for both identities
 * (`allowedAuthors`, `Contrato_Transportes_OpenClaw.md` §5.1) so the intermediate
 * representation keeps a single shape.
 *
 * @param {ReturnType<typeof resolveOpenclawReplyPolicy>} policy
 * @returns {{ source: "replyPolicy", explicit: boolean, allowedAuthors: string[] }}
 */
export function authorizeTelegramAuthors(policy) {
  return authorizeIdentity(policy, "telegram")
}
