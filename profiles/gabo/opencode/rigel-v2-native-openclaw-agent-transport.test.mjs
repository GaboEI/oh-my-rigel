import { describe, expect, test } from "bun:test"
import {
  OPENCLAW_A2A_DEFAULT_REPLY_TIMEOUT_MS,
  OPENCLAW_A2A_MAX_REPLY_TIMEOUT_MS,
  OPENCLAW_A2A_MIN_REPLY_TIMEOUT_MS,
  createOpenclawAgentTransport,
  normalizeTaskState,
  openclawTaskReplyText,
  resolveClientTimeoutMs,
  resolveOpenclawAgentPeers,
} from "./rigel-v2-native-openclaw-agent-transport.mjs"

const PEER_URL = "http://127.0.0.1:4011"
const ENV = { ALPHA_TOKEN: "alpha-secret-value", BETA_TOKEN: "beta-secret-value" }

const rawChannel = (overrides = {}) => ({
  enabled: true,
  peers: { alpha: { token: "env:ALPHA_TOKEN", url: PEER_URL } },
  ...overrides,
})

function peerOf(overrides = {}) {
  const resolved = resolveOpenclawAgentPeers(rawChannel(overrides), { env: ENV })
  return resolved.peers[0]
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }
}

function textResponse(text, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => text }
}

function spyFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    return handler(url, init, calls.length)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

const sendCall = (calls) => calls.find((call) => call.init?.method === "POST")
const bodyOf = (call) => JSON.parse(call.init.body)

describe("openclaw A2A peer resolution", () => {
  test("#given no a2a block #when resolving #then the namespace is undeclared and nothing is enabled", () => {
    expect(resolveOpenclawAgentPeers(undefined, { env: ENV })).toEqual({
      declared: false,
      enabled: false,
      peers: [],
      diagnostics: [],
      disabled: [],
    })
  })

  test("#given an explicitly disabled a2a block #when resolving #then the surface is off without a diagnostic", () => {
    const resolved = resolveOpenclawAgentPeers(rawChannel({ enabled: false }), { env: ENV })
    expect(resolved.declared).toBe(true)
    expect(resolved.enabled).toBe(false)
    expect(resolved.diagnostics).toEqual([])
  })

  test("#given an enabled a2a block with no peer #when resolving #then the vendor rule reports it as unusable", () => {
    const resolved = resolveOpenclawAgentPeers({ enabled: true, peers: {} }, { env: ENV })
    expect(resolved.enabled).toBe(false)
    expect(resolved.diagnostics.map((entry) => entry.reason)).toEqual(["missing-peers"])
  })

  test("#given an unknown key on the a2a block #when resolving #then it is named instead of dropped", () => {
    const resolved = resolveOpenclawAgentPeers(rawChannel({ timeoutMs: 1000 }), { env: ENV })
    expect(resolved.enabled).toBe(false)
    expect(resolved.diagnostics).toEqual([
      { path: "openclaw.channels.a2a.timeoutMs", reason: "unknown-key", peer: null },
    ])
  })

  test("#given a peer that names an unset variable #when resolving #then only that peer stays off and no value leaks", () => {
    const resolved = resolveOpenclawAgentPeers(
      { enabled: true, peers: { alpha: { token: "env:MISSING_TOKEN", url: PEER_URL }, beta: { token: "env:BETA_TOKEN", url: PEER_URL } } },
      { env: ENV },
    )
    expect(resolved.peers.map((peer) => peer.name)).toEqual(["beta"])
    expect(resolved.enabled).toBe(true)
    expect(resolved.disabled).toEqual([
      { peer: "alpha", path: "openclaw.channels.a2a.peers.alpha", reason: "unresolvable-token" },
    ])
    expect(JSON.stringify(resolved.diagnostics)).toContain("MISSING_TOKEN")
    expect(JSON.stringify(resolved.peers)).not.toContain("alpha-secret-value")
  })

  test("#given a peer with no url and no advertisedUrl #when resolving #then the missing URL is named", () => {
    const resolved = resolveOpenclawAgentPeers({ enabled: true, peers: { alpha: { token: "env:ALPHA_TOKEN" } } }, { env: ENV })
    expect(resolved.enabled).toBe(false)
    expect(resolved.diagnostics.map((entry) => entry.reason)).toEqual(["missing-url", "no-usable-peers"])
  })

  test("#given a non-loopback plaintext http url #when resolving #then the URL is rejected", () => {
    const resolved = resolveOpenclawAgentPeers(
      { enabled: true, peers: { alpha: { token: "env:ALPHA_TOKEN", url: "http://peer.example.com" } } },
      { env: ENV },
    )
    expect(resolved.enabled).toBe(false)
    expect(resolved.diagnostics[0]).toMatchObject({ reason: "invalid-url", peer: "alpha" })
  })

  test("#given the channel advertises a url #when a peer omits it #then the advertised url is used", () => {
    const resolved = resolveOpenclawAgentPeers(
      { enabled: true, advertisedUrl: PEER_URL, peers: { alpha: { token: "env:ALPHA_TOKEN" } } },
      { env: ENV },
    )
    expect(resolved.peers[0].url).toBe(PEER_URL)
  })

  test("#given an out-of-range reply timeout #when resolving #then that peer stays off", () => {
    const high = resolveOpenclawAgentPeers(rawChannel({ peers: { alpha: { token: "env:ALPHA_TOKEN", url: PEER_URL, replyTimeoutMs: 900_000 } } }), { env: ENV })
    const low = resolveOpenclawAgentPeers(rawChannel({ peers: { alpha: { token: "env:ALPHA_TOKEN", url: PEER_URL, replyTimeoutMs: 1_000 } } }), { env: ENV })
    expect(high.peers).toEqual([])
    expect(high.diagnostics[0]).toMatchObject({ reason: "invalid-reply-timeout", peer: "alpha" })
    expect(low.peers).toEqual([])
    expect(low.diagnostics[0]).toMatchObject({ reason: "invalid-reply-timeout", peer: "alpha" })
  })

  test("#given two peers with the same token #when resolving #then the vendor's first-match rule makes the second unusable", () => {
    const resolved = resolveOpenclawAgentPeers(
      {
        enabled: true,
        peers: {
          alpha: { token: "env:ALPHA_TOKEN", url: PEER_URL },
          beta: { token: "env:ALPHA_TOKEN", url: PEER_URL },
        },
      },
      { env: ENV },
    )
    expect(resolved.peers.map((peer) => peer.name)).toEqual(["alpha"])
    expect(resolved.diagnostics[0]).toMatchObject({ reason: "duplicate-token", peer: "beta" })
  })

  test("#given a valid peer #when resolving #then the client timeout exceeds replyTimeoutMs in both directions", () => {
    const withDefault = peerOf()
    const withDeclared = peerOf({ peers: { alpha: { token: "env:ALPHA_TOKEN", url: PEER_URL, replyTimeoutMs: OPENCLAW_A2A_MIN_REPLY_TIMEOUT_MS } } })
    expect(withDefault.replyTimeoutMs).toBe(OPENCLAW_A2A_DEFAULT_REPLY_TIMEOUT_MS)
    expect(withDefault.clientTimeoutMs).toBeGreaterThan(withDefault.replyTimeoutMs)
    expect(withDeclared.replyTimeoutMs).toBe(OPENCLAW_A2A_MIN_REPLY_TIMEOUT_MS)
    expect(withDeclared.clientTimeoutMs).toBeGreaterThan(OPENCLAW_A2A_MIN_REPLY_TIMEOUT_MS)
    expect(resolveClientTimeoutMs(OPENCLAW_A2A_MAX_REPLY_TIMEOUT_MS)).toBeGreaterThan(OPENCLAW_A2A_MAX_REPLY_TIMEOUT_MS)
  })

  test("#given a peer with a distinct outbound token #when resolving #then the outbound credential is the one used", () => {
    const peer = peerOf({
      peers: { alpha: { token: "env:ALPHA_TOKEN", outboundToken: "env:BETA_TOKEN", url: PEER_URL } },
    })
    expect(peer.token).toBe("beta-secret-value")
  })
})

describe("openclaw A2A task state reading", () => {
  test("#given the vendor's constant spelling and the bare enum #when normalizing #then both map to one vocabulary", () => {
    expect(normalizeTaskState("TASK_STATE_WORKING")).toBe("working")
    expect(normalizeTaskState("working")).toBe("working")
    expect(normalizeTaskState("TASK_STATE_REJECTED")).toBe("rejected")
    expect(normalizeTaskState("finished")).toBeNull()
    expect(normalizeTaskState(undefined)).toBeNull()
  })

  test("#given artifacts with text parts #when reading the reply #then they are joined in order", () => {
    const task = {
      artifacts: [
        { parts: [{ text: "first" }, { data: { ignored: true } }] },
        { parts: [{ text: "second" }] },
      ],
      status: { message: { parts: [{ text: "ignored because artifacts carried text" }] } },
    }
    expect(openclawTaskReplyText(task)).toBe("first\nsecond")
  })

  test("#given a completed task with no artifact text #when reading the reply #then the status message is the answer", () => {
    expect(openclawTaskReplyText({ artifacts: [], status: { message: { parts: [{ text: "done" }] } } })).toBe("done")
    expect(openclawTaskReplyText({ artifacts: [] })).toBe("")
  })
})

describe("openclaw A2A SendMessage", () => {
  test("#given a peer that accepted the turn #when sending #then the request carries the derived context and the vendor task id comes back", async () => {
    const fetchImpl = spyFetch(async () =>
      jsonResponse({ jsonrpc: "2.0", id: "x", result: { task: { id: "task-remote-1", contextId: "rigel-ctx", status: { state: "TASK_STATE_WORKING" } } } }),
    )
    const transport = createOpenclawAgentTransport({ peers: [peerOf()], fetchImpl })
    const outcome = await transport.send({ peer: "alpha", text: "hello", contextId: "rigel-ctx", messageId: "msg-1" })

    expect(outcome).toMatchObject({ kind: "task", remoteTaskId: "task-remote-1", state: "working" })
    const call = sendCall(fetchImpl.calls)
    expect(call.url).toBe(`${PEER_URL}/a2a/v1`)
    expect(call.init.headers.Authorization).toBe("Bearer alpha-secret-value")
    expect(bodyOf(call)).toMatchObject({
      jsonrpc: "2.0",
      method: "SendMessage",
      params: { message: { role: "ROLE_USER", contextId: "rigel-ctx", messageId: "msg-1", parts: [{ text: "hello" }] } },
    })
  })

  test("#given a REJECTED task on an HTTP 200 #when sending #then the rejection is read from status.state, not from the status code", async () => {
    const fetchImpl = spyFetch(async () =>
      jsonResponse({
        result: {
          task: {
            id: "task-r",
            status: { state: "REJECTED", message: { parts: [{ text: "A2A peers cannot execute slash commands." }] } },
          },
        },
      }),
    )
    const transport = createOpenclawAgentTransport({ peers: [peerOf()], fetchImpl })
    const outcome = await transport.send({ peer: "alpha", text: "hello", contextId: "rigel-ctx", messageId: "m" })
    expect(outcome).toMatchObject({
      kind: "task",
      state: "rejected",
      statusMessage: "A2A peers cannot execute slash commands.",
    })
  })

  test("#given a 401 #when sending #then the failure is a named definite class and never a task", async () => {
    const fetchImpl = spyFetch(async () => textResponse("Unauthorized", 401))
    const transport = createOpenclawAgentTransport({ peers: [peerOf()], fetchImpl })
    const outcome = await transport.send({ peer: "alpha", text: "hello", contextId: "rigel-ctx", messageId: "m" })
    expect(outcome).toEqual({ kind: "failed", errorClass: "unauthorized" })
    expect(transport.isDefinitiveSendFailure("unauthorized")).toBe(true)
    expect(transport.isDefinitiveSendFailure("timeout")).toBe(false)
  })

  test("#given a 200 with a JSON-RPC error #when sending #then the code becomes the error class", async () => {
    const fetchImpl = spyFetch(async () => jsonResponse({ jsonrpc: "2.0", id: "x", error: { code: -32601, message: "Method not found" } }))
    const transport = createOpenclawAgentTransport({ peers: [peerOf()], fetchImpl })
    const outcome = await transport.send({ peer: "alpha", text: "hello", contextId: "rigel-ctx", messageId: "m" })
    expect(outcome).toEqual({ kind: "failed", errorClass: "rpc--32601" })
  })

  test("#given a 200 with an empty body #when sending #then the answer is not treated as a task", async () => {
    const fetchImpl = spyFetch(async () => textResponse("", 200))
    const transport = createOpenclawAgentTransport({ peers: [peerOf()], fetchImpl })
    const outcome = await transport.send({ peer: "alpha", text: "hello", contextId: "rigel-ctx", messageId: "m" })
    expect(outcome).toEqual({ kind: "failed", errorClass: "empty-response" })
  })

  test("#given a 200 whose result has no task #when sending #then the malformed answer is named", async () => {
    const fetchImpl = spyFetch(async () => jsonResponse({ result: { message: { parts: [] } } }))
    const transport = createOpenclawAgentTransport({ peers: [peerOf()], fetchImpl })
    const outcome = await transport.send({ peer: "alpha", text: "hello", contextId: "rigel-ctx", messageId: "m" })
    expect(outcome).toEqual({ kind: "failed", errorClass: "malformed-response" })
  })

  test("#given a peer that never answers #when the client budget runs out #then the class is timeout", async () => {
    const fetchImpl = (_url, init = {}) => {
      if (init.method === "GET") return Promise.resolve(jsonResponse({}, 404))
      return new Promise((_resolve, reject) => {
        // The transport's own AbortController is the only thing that can end this
        // wait; the rejection mirrors what fetch does when a signal aborts.
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })
      })
    }
    const transport = createOpenclawAgentTransport({ peers: [peerOf()], fetchImpl })
    const started = Date.now()
    const outcome = await transport.send({ peer: "alpha", text: "hello", contextId: "rigel-ctx", messageId: "m", timeoutMs: 20 })
    expect(outcome).toEqual({ kind: "failed", errorClass: "timeout" })
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test("#given an unknown peer #when sending #then nothing is dialled", async () => {
    const fetchImpl = spyFetch(async () => jsonResponse({ result: { task: { id: "t" } } }))
    const transport = createOpenclawAgentTransport({ peers: [peerOf()], fetchImpl })
    const outcome = await transport.send({ peer: "ghost", text: "hello", contextId: "rigel-ctx", messageId: "m" })
    expect(outcome).toEqual({ kind: "failed", errorClass: "unknown-peer" })
    expect(fetchImpl.calls).toHaveLength(0)
  })
})

describe("openclaw A2A endpoint discovery", () => {
  test("#given a configured base url #when the first send runs #then the card is read once and its advertised endpoint is used", async () => {
    const fetchImpl = spyFetch(async (url, init) => {
      if (init.method === "GET") {
        return jsonResponse({ supportedInterfaces: [{ url: `${PEER_URL}/custom/a2a`, protocolBinding: "JSONRPC" }] })
      }
      return jsonResponse({ result: { task: { id: "task-1", status: { state: "WORKING" } } } })
    })
    const transport = createOpenclawAgentTransport({ peers: [peerOf()], fetchImpl })
    await transport.send({ peer: "alpha", text: "one", contextId: "rigel-ctx", messageId: "m1" })
    await transport.send({ peer: "alpha", text: "two", contextId: "rigel-ctx", messageId: "m2" })

    const gets = fetchImpl.calls.filter((call) => call.init.method === "GET")
    const posts = fetchImpl.calls.filter((call) => call.init.method === "POST")
    expect(gets).toHaveLength(1)
    expect(gets[0].url).toBe(`${PEER_URL}/.well-known/agent-card.json`)
    expect(posts.map((call) => call.url)).toEqual([`${PEER_URL}/custom/a2a`, `${PEER_URL}/custom/a2a`])
  })

  test("#given a card endpoint that 404s #when sending #then the documented endpoint is the fallback and the send still happens", async () => {
    const fetchImpl = spyFetch(async (_url, init) => {
      if (init.method === "GET") return jsonResponse({}, 404)
      return jsonResponse({ result: { task: { id: "task-1", status: { state: "WORKING" } } } })
    })
    const transport = createOpenclawAgentTransport({ peers: [peerOf()], fetchImpl })
    const outcome = await transport.send({ peer: "alpha", text: "one", contextId: "rigel-ctx", messageId: "m1" })
    expect(outcome.kind).toBe("task")
    expect(fetchImpl.calls.filter((call) => call.init.method === "POST")[0].url).toBe(`${PEER_URL}/a2a/v1`)
  })

  test("#given a peer whose url already names the endpoint #when sending #then no discovery request is made", async () => {
    const peer = peerOf({ peers: { alpha: { token: "env:ALPHA_TOKEN", url: `${PEER_URL}/a2a/v1` } } })
    const fetchImpl = spyFetch(async () => jsonResponse({ result: { task: { id: "task-1", status: { state: "WORKING" } } } }))
    const transport = createOpenclawAgentTransport({ peers: [peer], fetchImpl })
    await transport.send({ peer: "alpha", text: "one", contextId: "rigel-ctx", messageId: "m1" })
    expect(fetchImpl.calls.every((call) => call.init.method === "POST")).toBe(true)
  })
})

describe("openclaw A2A GetTask", () => {
  test("#given the bare task the vendor returns #when reading it #then the state and answer are read without a wrapper", async () => {
    const fetchImpl = spyFetch(async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: "x",
        result: { id: "task-remote-1", contextId: "rigel-ctx", status: { state: "COMPLETED" }, artifacts: [{ parts: [{ text: "the answer" }] }] },
      }),
    )
    const transport = createOpenclawAgentTransport({ peers: [peerOf()], fetchImpl })
    const outcome = await transport.getTask({ peer: "alpha", remoteTaskId: "task-remote-1" })
    expect(outcome).toMatchObject({ kind: "task", remoteTaskId: "task-remote-1", state: "completed", replyText: "the answer" })
    const post = sendCall(fetchImpl.calls)
    expect(bodyOf(post)).toMatchObject({ method: "GetTask", params: { id: "task-remote-1" } })
  })

  test("#given an unknown state #when reading the task #then the class is named and the caller can keep it pending", async () => {
    const fetchImpl = spyFetch(async () => jsonResponse({ result: { id: "t", status: { state: "SOMETHING_NEW" } } }))
    const transport = createOpenclawAgentTransport({ peers: [peerOf()], fetchImpl })
    const outcome = await transport.getTask({ peer: "alpha", remoteTaskId: "t" })
    expect(outcome).toMatchObject({ kind: "failed", errorClass: "unknown-task-state" })
  })

  test("#given a task the peer forgot #when reading it #then the JSON-RPC code travels as the class", async () => {
    const fetchImpl = spyFetch(async () => jsonResponse({ error: { code: -32001, message: "Task not found" } }))
    const transport = createOpenclawAgentTransport({ peers: [peerOf()], fetchImpl })
    const outcome = await transport.getTask({ peer: "alpha", remoteTaskId: "t" })
    expect(outcome).toEqual({ kind: "failed", errorClass: "rpc--32001", rpcCode: -32001 })
  })
})

describe("openclaw A2A endpoint policy", () => {
  test("#given a card that advertises a plaintext non-loopback endpoint #when sending #then the bearer never reaches it and the validated base is used", async () => {
    const unsafe = "http://peer.example.com/a2a/v1"
    const logs = []
    const fetchImpl = spyFetch(async (_url, init) => {
      if (init.method === "GET") return jsonResponse({ supportedInterfaces: [{ url: unsafe }] })
      return jsonResponse({ result: { task: { id: "task-1", status: { state: "WORKING" } } } })
    })
    const transport = createOpenclawAgentTransport({ peers: [peerOf()], fetchImpl, log: (line) => logs.push(line) })
    const outcome = await transport.send({ peer: "alpha", text: "one", contextId: "rigel-ctx", messageId: "m1" })

    expect(outcome.kind).toBe("task")
    // The card is decorative; the endpoint it names is not trusted beyond the policy.
    expect(fetchImpl.calls.map((call) => call.url)).toEqual([
      `${PEER_URL}/.well-known/agent-card.json`,
      `${PEER_URL}/a2a/v1`,
    ])
    expect(fetchImpl.calls.filter((call) => call.init.method === "POST")[0].init.headers.Authorization).toBe(`Bearer ${ENV.ALPHA_TOKEN}`)
    // Identity only: the refusal names the peer, never the url and never the token.
    expect(logs.filter((line) => line.includes("peer.example.com") || line.includes(ENV.ALPHA_TOKEN))).toEqual([])
  })

  test("#given a card that advertises a url carrying a credential #when sending #then that url is refused and never logged", async () => {
    const unsafe = "https://peer:card-secret@peer.example.com/a2a/v1"
    const logs = []
    const fetchImpl = spyFetch(async (_url, init) => {
      if (init.method === "GET") return jsonResponse({ supportedInterfaces: [{ url: unsafe }] })
      return jsonResponse({ result: { task: { id: "task-1", status: { state: "WORKING" } } } })
    })
    const transport = createOpenclawAgentTransport({ peers: [peerOf()], fetchImpl, log: (line) => logs.push(line) })
    await transport.send({ peer: "alpha", text: "one", contextId: "rigel-ctx", messageId: "m1" })

    expect(fetchImpl.calls.some((call) => call.url.includes("@peer.example.com"))).toBe(false)
    const posts = fetchImpl.calls.filter((call) => call.init.method === "POST")
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toBe(`${PEER_URL}/a2a/v1`)
    expect(logs.join("\n")).not.toContain("card-secret")
  })

  test("#given a card that advertises a malformed endpoint #when sending #then the documented endpoint is used", async () => {
    const fetchImpl = spyFetch(async (_url, init) => {
      if (init.method === "GET") return jsonResponse({ supportedInterfaces: [{ url: "not a url" }] })
      return jsonResponse({ result: { task: { id: "task-1", status: { state: "WORKING" } } } })
    })
    const transport = createOpenclawAgentTransport({ peers: [peerOf()], fetchImpl })
    const outcome = await transport.send({ peer: "alpha", text: "one", contextId: "rigel-ctx", messageId: "m1" })
    expect(outcome.kind).toBe("task")
    expect(fetchImpl.calls.filter((call) => call.init.method === "POST")[0].url).toBe(`${PEER_URL}/a2a/v1`)
  })

  test("#given a peer url outside the policy #when sending #then the request is refused as invalid-url and nothing is dialled", async () => {
    const fetchImpl = spyFetch(async () => jsonResponse({ result: { task: { id: "task-1", status: { state: "WORKING" } } } }))
    const peer = { ...peerOf(), url: "http://peer.example.com" }
    const transport = createOpenclawAgentTransport({ peers: [peer], fetchImpl })
    const outcome = await transport.send({ peer: "alpha", text: "one", contextId: "rigel-ctx", messageId: "m1" })

    expect(outcome).toEqual({ kind: "failed", errorClass: "invalid-url" })
    expect(fetchImpl.calls).toHaveLength(0)
    // A refused URL provably created no task, so the record can be settled instead of lost.
    expect(transport.isDefinitiveSendFailure("invalid-url")).toBe(true)
  })
})
