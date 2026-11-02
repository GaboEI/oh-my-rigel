import { describe, expect, test } from "bun:test"
import { createNativeOpenclaw } from "./rigel-v2-native-openclaw.mjs"
import { normalizeOpenclawConfig } from "./rigel-v2-native-openclaw-core.mjs"

describe("native OpenClaw configuration validation", () => {
  test("rejects a nested unknown key by exact path without starting OpenClaw", async () => {
    const errors = []
    const normalized = normalizeOpenclawConfig({
      enabled: true,
      gateways: { primary: { url: "https://gateway.test", stray: true } },
      hooks: {},
    }, { onInvalid: (error) => errors.push(error) })

    expect(normalized).toBeNull()
    expect(errors).toHaveLength(1)
    expect(errors[0].name).toBe("OpenclawConfigValidationError")
    expect(errors[0].path).toBe("openclaw.gateways.primary.stray")

    let fetches = 0
    const logs = []
    const native = createNativeOpenclaw({
      config: { enabled: true, gateways: { primary: { url: "https://gateway.test", stray: true } }, hooks: {} },
      fetchImpl: async () => { fetches += 1 },
      log: (line) => logs.push(line),
    })
    expect(native.enabled).toBe(false)
    expect(await native.ready).toEqual({ started: false, reason: "disabled" })
    expect(await native.handleEvent({ type: "session.idle" })).toBeNull()
    await native.dispose()
    expect(fetches).toBe(0)
    expect(logs).toEqual([expect.stringContaining("openclaw.gateways.primary.stray")])
  })

  test("preserves valid legacy gateway and hook payloads while retaining listener defaults", () => {
    const raw = {
      enabled: true,
      gateways: { primary: { type: "http", url: "https://gateway.test", method: "PUT", headers: { authorization: "Bearer test" } } },
      hooks: { "session.idle": { gateway: "primary", instruction: "notify" } },
      replyListener: { discordBotToken: "token", authorizedDiscordUserIds: ["u1"], includePrefix: false },
    }
    expect(normalizeOpenclawConfig(raw)).toEqual({
      ...raw,
      replyListener: {
        ...raw.replyListener,
        pollIntervalMs: 3000,
        rateLimitPerMinute: 10,
        maxMessageLength: 500,
      },
    })
  })
})
