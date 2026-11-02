import { describe, expect, test } from "bun:test"
import { createOpenclawInbound } from "./rigel-v2-native-openclaw-inbound.mjs"

/**
 * §U9: the Discord rate-limit threshold. The contract `Unidades_Atomicas_OpenClaw.md`
 * §U9 states is a single condition — the backoff fires when `x-ratelimit-remaining`
 * is `0`, not when it is below `2` — and both directions matter: `1` must keep
 * polling, `0` must back off. Everything else about the backoff (the `until`
 * instant derived from `x-ratelimit-reset`, the 10s fallback, the missing-header
 * path) is untouched, so it is pinned here too.
 *
 * The clock is injected and the poll cadence is the `sleep` seam, so the assertions
 * never depend on wall time or on a timer being slow enough.
 */

const DISCORD_BASE = "http://127.0.0.1:9/discord"
const SECRET = `synthetic-${Math.random().toString(36).slice(2)}`
const AUTHORIZED_USER = "u-authorized"
const START_MS = 1_700_000_000_000

async function waitFor(predicate, message, maxIterations = 5000) {
  for (let index = 0; index < maxIterations; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`timed out: ${message}`)
}

/**
 * A Discord port that answers every poll with an empty window and the given
 * rate-limit headers. `headers === null` means "the platform sent no header".
 */
function discordPort(headers) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name) => (headers === null ? null : headers[name] ?? null),
      },
      json: async () => [],
      text: async () => "[]",
    }
  }
  fetchImpl.calls = calls
  return fetchImpl
}

function replyListener() {
  return {
    discordBotToken: SECRET,
    discordChannelId: "channel-u9",
    authorizedDiscordUserIds: [AUTHORIZED_USER],
    pollIntervalMs: 5,
  }
}

function listening({ fetchImpl, now }) {
  let sleeps = 0
  const inbound = createOpenclawInbound({
    replyListener: replyListener(),
    registry: { lookup: () => undefined, prune: async () => {} },
    deliverInboundReply: async () => true,
    fetchImpl,
    now,
    discordApiBase: DISCORD_BASE,
    sleep: () => {
      sleeps += 1
      return new Promise((resolve) => setImmediate(resolve))
    },
    log: () => {},
  })
  return { inbound, sleeps: () => sleeps }
}

describe("openclaw inbound: the Discord rate-limit backoff threshold is zero", () => {
  test("#given x-ratelimit-remaining 1 #when the poller keeps running #then it never backs off", async () => {
    const fetchImpl = discordPort({ "x-ratelimit-remaining": "1", "x-ratelimit-reset": String(START_MS / 1000 + 10) })
    const { inbound, sleeps } = listening({ fetchImpl, now: () => START_MS })

    await inbound.start()
    await waitFor(() => sleeps() >= 4, "four poll intervals at remaining=1")
    await inbound.stop()

    // One GET per loop iteration: a `remaining` of 1 still has budget, so the
    // poller must not stand down. The pre-§U9 `remaining < 2` condition stops after
    // the first GET and this assertion is what catches it.
    expect(fetchImpl.calls.length).toBeGreaterThanOrEqual(4)
    expect(fetchImpl.calls[0].url).toContain("/channels/channel-u9/messages")
  })

  test("#given x-ratelimit-remaining 0 #when the poller keeps running #then it backs off until the reset instant", async () => {
    const fetchImpl = discordPort({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(START_MS / 1000 + 10) })
    const { inbound, sleeps } = listening({ fetchImpl, now: () => START_MS })

    await inbound.start()
    await waitFor(() => sleeps() >= 4, "four poll intervals at remaining=0")
    await inbound.stop()

    // Zero remaining is exhausted budget: exactly one GET, then the loop keeps
    // turning without touching Discord until `x-ratelimit-reset`.
    expect(sleeps()).toBeGreaterThanOrEqual(4)
    expect(fetchImpl.calls.length).toBe(1)
  })

  test("#given a backoff from remaining 0 #when the clock passes x-ratelimit-reset #then polling resumes", async () => {
    let clock = START_MS
    const fetchImpl = discordPort({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(START_MS / 1000 + 10) })
    const { inbound, sleeps } = listening({ fetchImpl, now: () => clock })

    await inbound.start()
    await waitFor(() => sleeps() >= 3 && fetchImpl.calls.length === 1, "the backoff to take hold")
    clock = START_MS + 11_000
    await waitFor(() => fetchImpl.calls.length >= 2, "polling to resume past the reset instant")
    await inbound.stop()

    expect(fetchImpl.calls.length).toBeGreaterThanOrEqual(2)
  })

  test("#given no x-ratelimit-remaining header #when the poller keeps running #then it never backs off", async () => {
    const fetchImpl = discordPort(null)
    const { inbound, sleeps } = listening({ fetchImpl, now: () => START_MS })

    await inbound.start()
    await waitFor(() => sleeps() >= 3, "three poll intervals without the header")
    await inbound.stop()

    expect(fetchImpl.calls.length).toBeGreaterThanOrEqual(3)
  })
})
