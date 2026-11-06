import { describe, expect, test } from "bun:test"
import { resolveOpenclawNotificationChannels } from "./rigel-v2-native-openclaw-notification.mjs"
import { resolveOpenclawReplyListenerSecrets } from "./rigel-v2-native-openclaw-secrets.mjs"

/**
 * One Telegram platform is served by two credential points with different jobs:
 * `replyListener` carries the poll credentials consumed by `getUpdates`, and
 * `channels.<name>` carries the publish credentials consumed by `sendMessage`.
 *
 * These cases pin the observable consequence of that split at the two exported
 * resolvers: each point resolves from its own declaration, a difference between the
 * two chat ids produces no diagnostic, and a point that fails closed leaves the
 * other one intact. Nothing here asserts contract wording, and no case requires the
 * composition to compare the two points.
 *
 * Every credential below is synthetic and every resolver is pure, so no platform is
 * contacted and no real chat id is used.
 *
 * Retention: this guards the OpenClaw configuration contract that one platform may
 * carry two credential points, at the public boundary where both are resolved. It
 * fails if either resolver starts comparing the two points, derives one from the
 * other, or turns a difference into a diagnostic.
 */

const POLL_TOKEN = `synthetic-${Math.random().toString(36).slice(2)}-poll-token`
const PUBLISH_TOKEN = `synthetic-${Math.random().toString(36).slice(2)}-publish-token`

/** The operator named the same conversation twice, which is what the split allows. */
const POLL_CHAT_ID = "424242"
/** Deliberately a different conversation from POLL_CHAT_ID. */
const PUBLISH_CHAT_ID = "777777"

const TELEGRAM_CHANNEL_INSTRUCTION = "finished {{sessionId}} on {{event}}"

/** A `channels.<name>` Telegram block with every key the resolver requires. */
function telegramChannel({ token, chatId }) {
  return {
    transport: "telegram",
    token,
    chatId,
    instruction: TELEGRAM_CHANNEL_INSTRUCTION,
    events: ["session.idle"],
  }
}

/** The legacy poll block. It carries the poll credentials and the poll chat id. */
function replyListener({ token, chatId }) {
  return { telegramBotToken: token, telegramChatId: chatId }
}

describe("openclaw telegram sources: two credential points for one platform", () => {
  test("#given differing chatId values at the poll and publish points #when both resolvers run in one process #then each keeps its own token and chat and neither reports the difference", () => {
    const poll = resolveOpenclawReplyListenerSecrets(
      replyListener({ token: "env:POLL_TOKEN", chatId: POLL_CHAT_ID }),
      { env: { POLL_TOKEN } },
    )
    const publish = resolveOpenclawNotificationChannels(
      { alerts: telegramChannel({ token: PUBLISH_TOKEN, chatId: PUBLISH_CHAT_ID }) },
      { env: {} },
    )

    // The poll point resolves its own reference and carries its own chat id through.
    expect(poll.replyListener.telegramBotToken).toBe(POLL_TOKEN)
    expect(poll.replyListener.telegramChatId).toBe(POLL_CHAT_ID)
    expect(poll.disabled).toEqual([])

    // The publish point resolves its own credential and its own target.
    expect(publish.channels).toHaveLength(1)
    expect(publish.channels[0]).toMatchObject({
      name: "alerts",
      transport: "telegram",
      token: PUBLISH_TOKEN,
      target: PUBLISH_CHAT_ID,
    })

    // The difference is not a diagnostic at either point: no divergence line exists
    // to emit, and neither value is rewritten to match the other.
    expect(poll.diagnostics).toEqual([])
    expect(publish.diagnostics).toEqual([])
    expect(publish.channels[0].target).not.toBe(poll.replyListener.telegramChatId)
  })

  test("#given an unresolvable publish token #when both resolvers run in one process #then only the publish point reports and the poll point keeps its own chatId and token", () => {
    const poll = resolveOpenclawReplyListenerSecrets(
      replyListener({ token: POLL_TOKEN, chatId: POLL_CHAT_ID }),
      { env: {} },
    )
    const publish = resolveOpenclawNotificationChannels(
      { alerts: telegramChannel({ token: "env:PUBLISH_TOKEN_UNSET", chatId: PUBLISH_CHAT_ID }) },
      { env: {} },
    )

    // Fail closed is per point: the publish endpoint is withheld and named.
    expect(publish.channels).toEqual([])
    expect(publish.diagnostics).toEqual([
      { path: "openclaw.channels.alerts.token", reason: "missing-env-variable", envName: "PUBLISH_TOKEN_UNSET" },
    ])

    // The poll point never learns about it.
    expect(poll.replyListener.telegramBotToken).toBe(POLL_TOKEN)
    expect(poll.replyListener.telegramChatId).toBe(POLL_CHAT_ID)
    expect(poll.diagnostics).toEqual([])
    expect(poll.disabled).toEqual([])
  })

  test("#given an unresolvable poll token #when both resolvers run in one process #then the publish point keeps its own chatId and token", () => {
    const poll = resolveOpenclawReplyListenerSecrets(
      replyListener({ token: "env:POLL_TOKEN_UNSET", chatId: POLL_CHAT_ID }),
      { env: {} },
    )
    const publish = resolveOpenclawNotificationChannels(
      { alerts: telegramChannel({ token: PUBLISH_TOKEN, chatId: PUBLISH_CHAT_ID }) },
      { env: {} },
    )

    // The poll credential is withheld rather than blanked, so the listener's own
    // presence rule keeps the poller down without this module duplicating it.
    expect(poll.replyListener).not.toHaveProperty("telegramBotToken")
    expect(poll.replyListener.telegramChatId).toBe(POLL_CHAT_ID)
    expect(poll.disabled).toEqual([
      { surface: "telegram", path: "openclaw.replyListener.telegramBotToken", reason: "missing-env-variable", envName: "POLL_TOKEN_UNSET" },
    ])
    expect(poll.diagnostics).toHaveLength(1)

    // The publish point never learns about it.
    expect(publish.channels).toHaveLength(1)
    expect(publish.channels[0]).toMatchObject({ token: PUBLISH_TOKEN, target: PUBLISH_CHAT_ID })
    expect(publish.diagnostics).toEqual([])
  })

  test("#given only a channels Telegram block with its own chatId #when both resolvers run #then a publish endpoint exists and no poll token is produced", () => {
    const publish = resolveOpenclawNotificationChannels(
      { alerts: telegramChannel({ token: PUBLISH_TOKEN, chatId: PUBLISH_CHAT_ID }) },
      { env: {} },
    )
    const poll = resolveOpenclawReplyListenerSecrets(undefined, { env: {} })

    // The publish block is a notification channel: it yields a target and a token,
    // and it is never read as a reply listener.
    expect(publish.channels).toHaveLength(1)
    expect(publish.channels[0]).toMatchObject({ transport: "telegram", target: PUBLISH_CHAT_ID })
    expect(publish.diagnostics).toEqual([])

    // No poll credential is derived from it.
    expect(poll.replyListener).toBeUndefined()
    expect(poll.disabled).toEqual([])
    expect(poll.diagnostics).toEqual([])
  })
})
