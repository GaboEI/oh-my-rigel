import { describe, expect, test } from "bun:test"
import { createNativeOpenclaw } from "./rigel-v2-native-openclaw.mjs"
import { normalizeOpenclawConfig } from "./rigel-v2-native-openclaw-core.mjs"

/**
 * U10: `discordMention` was declared in the type and the schema and never read.
 * It has no documented functional requirement (`Unidades_Atomicas_OpenClaw.md`
 * §U10), so it is removed and a configuration that declares it is rejected by
 * the U1 normalizer with a named error instead of being silently discarded.
 */

const VALID_RAW = {
  enabled: true,
  gateways: { primary: { type: "http", url: "https://gateway.test", method: "PUT", headers: { authorization: "Bearer test" } } },
  hooks: { "session.idle": { gateway: "primary", instruction: "notify" } },
  replyListener: {
    discordBotToken: "token",
    discordChannelId: "channel",
    authorizedDiscordUserIds: ["u1"],
    includePrefix: false,
  },
}

describe("native OpenClaw discordMention removal", () => {
  test("#given a listener that does not declare it #when normalized #then the legacy payload is unchanged", () => {
    // given
    const raw = VALID_RAW

    // when
    const errors = []
    const normalized = normalizeOpenclawConfig(raw, { onInvalid: (error) => errors.push(error) })

    // then
    expect(errors).toEqual([])
    expect(normalized).toEqual({
      ...raw,
      replyListener: {
        ...raw.replyListener,
        pollIntervalMs: 3000,
        rateLimitPerMinute: 10,
        maxMessageLength: 500,
      },
    })
  })

  test("#given a listener that declares it #when normalized #then U1 rejects it with the exact named path", () => {
    // given
    const raw = { ...VALID_RAW, replyListener: { ...VALID_RAW.replyListener, discordMention: "@here" } }

    // when
    const errors = []
    const normalized = normalizeOpenclawConfig(raw, { onInvalid: (error) => errors.push(error) })

    // then
    expect(normalized).toBeNull()
    expect(errors).toHaveLength(1)
    expect(errors[0].name).toBe("OpenclawConfigValidationError")
    expect(errors[0].path).toBe("openclaw.replyListener.discordMention")
    expect(errors[0].message).toBe("unknown OpenClaw configuration key at openclaw.replyListener.discordMention")
  })

  test("#given a configuration that declares it #when the surface boots #then it stays disabled, names the path once and never calls fetch", async () => {
    // given
    const raw = { ...VALID_RAW, replyListener: { ...VALID_RAW.replyListener, discordMention: "<@123>" } }
    let fetches = 0
    const logs = []

    // when
    const native = createNativeOpenclaw({
      config: raw,
      fetchImpl: async () => { fetches += 1 },
      log: (line) => logs.push(line),
    })
    const readiness = await native.ready
    const dispatched = await native.handleEvent({ type: "session.idle" })
    await native.dispose()

    // then
    expect(native.enabled).toBe(false)
    expect(readiness).toEqual({ started: false, reason: "disabled" })
    expect(dispatched).toBeNull()
    expect(fetches).toBe(0)
    expect(logs).toEqual([
      "[oh-my-rigel] Native V2 OpenclawConfigValidationError: unknown OpenClaw configuration key at openclaw.replyListener.discordMention",
    ])
  })

  test("#given the same block with only the declaration removed #when normalized #then the valid behavior returns, so the rollback is one key", async () => {
    // given
    const declared = { ...VALID_RAW, replyListener: { ...VALID_RAW.replyListener, discordMention: "@here" } }
    const { discordMention: _removed, ...rolledBackListener } = declared.replyListener
    const rolledBack = { ...declared, replyListener: rolledBackListener }

    // when
    const declaredErrors = []
    const declaredNormalized = normalizeOpenclawConfig(declared, { onInvalid: (error) => declaredErrors.push(error) })
    const normalized = normalizeOpenclawConfig(rolledBack)
    const native = createNativeOpenclaw({ config: rolledBack, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "" }), log: () => {} })
    const readiness = await native.ready
    await native.dispose()

    // then
    expect(declaredNormalized).toBeNull()
    expect(declaredErrors).toHaveLength(1)
    expect(normalized).toEqual({
      ...VALID_RAW,
      replyListener: {
        ...VALID_RAW.replyListener,
        pollIntervalMs: 3000,
        rateLimitPerMinute: 10,
        maxMessageLength: 500,
      },
    })
    expect(native.enabled).toBe(true)
    expect(readiness).toEqual({ started: true })
  })
})
