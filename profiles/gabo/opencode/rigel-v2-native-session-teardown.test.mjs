import { describe, expect, test } from "bun:test"

import { createMemberSessionTerminator } from "./rigel-v2-native-session-teardown.mjs"

// Live failure this file pins (NLS1, OpenCode 2.0.32):
// `team_delete` closed the record, reported `deleted: true`, and left the member
// session (and therefore its persistent pane) alive. Two causes:
//   1. the old teardown trusted the first domain whose `delete` existed, so a
//      shape the host ignores resolved silently and the caller reported success; and
//   2. the plugin host exposes the V2 session client under `client.v2.session`
//      (`client?.v2?.session ?? client?.session`), which was never attempted.

function domainsWith({ sessionDelete, clientDelete, clientV2Delete, sessionGet }) {
  const calls = []
  const wrap = (label, fn) =>
    typeof fn === "function"
      ? async (address) => { calls.push({ shape: label, address }); return fn(address, calls) }
      : undefined
  return {
    calls,
    domains: {
      session: {
        ...(sessionDelete ? { delete: wrap("session.delete", sessionDelete) } : {}),
        ...(sessionGet ? { get: async (address) => sessionGet(address, calls) } : {}),
      },
      client: {
        session: {
          ...(clientDelete ? { delete: wrap("client.session.delete", clientDelete) } : {}),
        },
        ...(clientV2Delete ? { v2: { session: { delete: wrap("client.v2.session.delete", clientV2Delete) } } } : {}),
      },
    },
  }
}

describe("member session teardown", () => {
  test("#given the in-process domain really deletes the session #when terminating #then it is reported deleted and verified", async () => {
    let alive = true
    const { domains, calls } = domainsWith({
      sessionDelete: async () => { alive = false },
      sessionGet: async () => (alive ? { id: "ses_one" } : undefined),
    })

    const result = await createMemberSessionTerminator({ domains })("ses_one")

    expect(result).toEqual({ sessionID: "ses_one", deleted: true, shape: "session.delete({ sessionID })", verified: true })
    expect(calls).toEqual([{ shape: "session.delete", address: { sessionID: "ses_one" } }])
  })

  test("#given a call that RESOLVES WITHOUT deleting #when terminating #then another shape is tried instead of reporting success", async () => {
    // The exact live no-op: a shape resolves, the session survives.
    let alive = true
    const { domains, calls } = domainsWith({
      sessionDelete: async (address) => { if (address?.path?.id === "ses_one") alive = false },
      sessionGet: async () => (alive ? { id: "ses_one" } : undefined),
    })

    const result = await createMemberSessionTerminator({ domains })("ses_one")

    expect(result.deleted).toBe(true)
    expect(result.shape).toBe("session.delete({ path: { id } })")
    expect(calls.map((call) => call.address)).toEqual([{ sessionID: "ses_one" }, { path: { id: "ses_one" } }])
  })

  test("#given every shape resolves but the session survives #when terminating #then deleted is false and the shapes are reported", async () => {
    const { domains } = domainsWith({
      sessionDelete: async () => {},
      clientDelete: async () => {},
      sessionGet: async () => ({ id: "ses_one" }),
    })

    const result = await createMemberSessionTerminator({ domains })("ses_one")

    expect(result.deleted).toBe(false)
    expect(result.error).toContain("session.delete({ sessionID })")
    expect(result.error).toContain("client.session.delete({ path: { id } })")
    expect(result.error).toContain("still exists")
  })

  test("#given a host with no session delete #when terminating #then the reported error names the missing domain", async () => {
    const result = await createMemberSessionTerminator({ domains: { session: { get: async () => ({ id: "ses_one" }) } } })("ses_one")

    expect(result).toEqual({ sessionID: "ses_one", deleted: false, error: "host exposes no session delete" })
  })

  test("#given the client V2 session domain deletes #when terminating #then it is preferred over client.session", async () => {
    // This is the domain the first version of this module never attempted.
    let alive = true
    const { domains, calls } = domainsWith({
      clientV2Delete: async () => { alive = false },
      clientDelete: async () => { throw new Error("client.session must not be reached when client.v2.session works") },
      sessionGet: async () => (alive ? { id: "ses_one" } : undefined),
    })

    const result = await createMemberSessionTerminator({ domains })("ses_one")

    expect(result.shape).toBe("client.v2.session.delete({ sessionID })")
    expect(calls.map((call) => call.shape)).toEqual(["client.v2.session.delete"])
  })

  test("#given the first shape throws #when terminating #then a later shape still deletes the session", async () => {
    let alive = true
    const { domains } = domainsWith({
      sessionDelete: async () => { throw new Error("unknown argument sessionID") },
      clientDelete: async () => { alive = false },
      sessionGet: async () => (alive ? { id: "ses_one" } : undefined),
    })

    const result = await createMemberSessionTerminator({ domains })("ses_one")

    expect(result.deleted).toBe(true)
    expect(result.shape).toBe("client.session.delete({ sessionID })")
  })

  test("#given a host that names the operation remove #when terminating #then the alias is used", async () => {
    const removed = []
    const domains = { session: { remove: async (address) => { removed.push(address) } } }

    const result = await createMemberSessionTerminator({ domains, presence: async () => undefined })("ses_one")

    expect(result).toEqual({ sessionID: "ses_one", deleted: true, shape: "session.remove({ sessionID })", verified: true })
    expect(removed).toEqual([{ sessionID: "ses_one" }])
  })

  test("#given a getter that answers not-found for a deleted session #when the delete resolves #then the close is verified", async () => {
    // ROW55 retest 6 (live): a not-found answer IS the absence proof. Discarding
    // it made a completed teardown look unverified on every single call.
    const domains = { session: { delete: async () => {}, get: async () => { throw new Error("404 not found") } } }
    // when
    const result = await createMemberSessionTerminator({ domains })("ses_one")
    // then
    expect(result).toEqual({ sessionID: "ses_one", deleted: true, shape: "session.delete({ sessionID })", verified: true })
  })

  test("#given a getter that fails for a transport reason #when the delete resolves #then it stays unverified (a failure is not absence)", async () => {
    // Note 5 keeps its teeth: only a not-found (or a real session object) decides.
    const domains = { session: { delete: async () => {}, get: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:4096") } } }
    // when
    const result = await createMemberSessionTerminator({ domains })("ses_one")
    // then
    expect(result.deleted).toBe(true)
    expect(result.verified).toBe(false)
    expect(result.unverified).toBe(true)
    expect(result.reason).toContain("failed")
  })

  test("#given a host with a delete but NO presence probe at all #when the delete resolves #then the result is unverified, never verified", async () => {
    // Note 5: `get` is absent, so nothing can prove the session is gone. A missing
    // accessor must never be read as "absent" - that would be false verification.
    const domains = { session: { delete: async () => {} } }
    // when
    const result = await createMemberSessionTerminator({ domains })("ses_one")
    // then
    expect(result.deleted).toBe(true)
    expect(result.verified).toBe(false)
    expect(result.unverified).toBe(true)
    expect(result.error).toContain("could not be verified")
    expect(result.reason).toContain("no presence probe exists")
  })

  test("#given a host that throws on an already-deleted session #when the probe proves it is gone #then the result is a verified deletion, not a failure", async () => {
    // Retry convergence (R2): a 404-style throw for a session that no longer exists
    // must not be re-classified as a failed teardown, or `team_delete` could never
    // converge on a retry. The positive ABSENCE proof is what converts the throw.
    const { domains } = domainsWith({
      sessionDelete: async () => { throw new Error("Session not found") },
      sessionGet: async () => undefined,
    })

    const result = await createMemberSessionTerminator({ domains })("ses_one")

    expect(result).toEqual({ sessionID: "ses_one", deleted: true, shape: "session.delete({ sessionID }) (already absent)", verified: true })
  })

  test("#given a throwing delete and NO probe #when terminating #then it stays a failure (only an absence proof converts a throw)", async () => {
    const domains = { session: { delete: async () => { throw new Error("Session not found") } } }

    const result = await createMemberSessionTerminator({ domains })("ses_one")

    expect(result.deleted).toBe(false)
    expect(result.error).toContain("Session not found")
  })

  test("#given the session client lives only under client.v2.session #when the delete resolves #then the presence proof comes from that same domain", async () => {
    // ROW55 retest 6 (live): the delete ran through client.v2.session while the
    // probe only read context.session.get, so a real close was reported unverified.
    let alive = true
    const domains = {
      client: {
        v2: {
          session: {
            async delete() { alive = false },
            async get() { return alive ? { id: "ses_one" } : undefined },
          },
        },
      },
    }
    // when (the live boundary: native.mjs passes `context`, not `domains`)
    const result = await createMemberSessionTerminator({ context: { client: { v2: { session: domains.client.v2.session } } } })("ses_one")
    // then
    expect(result).toEqual({ sessionID: "ses_one", deleted: true, shape: "client.v2.session.delete({ sessionID })", verified: true })
  })

  test("#given a getter that only speaks the host RPC shape #when the delete resolves #then absence is still proven", async () => {
    // The host route is `session.get({ params: { sessionID } })`; a probe that only
    // sends `{ sessionID }` is rejected by validation and can never verify a close.
    let alive = true
    const asked = []
    const domains = {
      session: {
        async delete() { alive = false },
        async get(address) {
          asked.push(address)
          if (!address?.params?.sessionID) throw new Error("expected { params: { sessionID } }")
          return alive ? { id: "ses_one" } : undefined
        },
      },
    }
    // when
    const result = await createMemberSessionTerminator({ domains })("ses_one")
    // then
    expect(result).toEqual({ sessionID: "ses_one", deleted: true, shape: "session.delete({ sessionID })", verified: true })
    expect(asked.at(-1)).toEqual({ params: { sessionID: "ses_one" } })
  })

  test("#given a getter that answers not-found inside the SDK envelope #when the delete resolves #then the close is verified", async () => {
    // The v2 SDK does not throw on 404: it returns { data: undefined, error: { name: "NotFound" } }.
    const domains = {
      session: {
        delete: async () => {},
        get: async () => ({ data: undefined, error: { name: "NotFound", message: "session not found" } }),
      },
    }
    // when
    const result = await createMemberSessionTerminator({ domains })("ses_one")
    // then
    expect(result.verified).toBe(true)
  })

  test("#given a getter whose ROUTE is missing #when the delete resolves #then a missing route is never read as a missing session", async () => {
    // Fail-closed guard: a broken endpoint says nothing about the session.
    const domains = {
      session: { delete: async () => {}, get: async () => { throw new Error("404 route not found") } },
    }
    // when
    const result = await createMemberSessionTerminator({ domains })("ses_one")
    // then
    expect(result.verified).toBe(false)
    expect(result.unverified).toBe(true)
  })

  test("#given one address answers empty and another returns the session #when the delete resolves #then survival wins over the empty answer", async () => {
    // Fail-closed guard: an address the host ignores must never outvote a working one.
    const domains = {
      session: {
        async delete() {},
        async get(address) { return address?.params?.sessionID ? { id: "ses_one" } : undefined },
      },
    }
    // when
    const result = await createMemberSessionTerminator({ domains })("ses_one")
    // then
    expect(result.deleted).toBe(false)
    expect(result.error).toContain("still exists")
  })

  // ROW55 retest 7 (live, NLS1): the in-process session domain validates its
  // argument with Effect Schema, so ONLY the root `{ sessionID }` address decodes.
  // `{ path: { id } }` and `{ params: { sessionID } }` are rejected with
  // `Missing key at ["sessionID"]`, and a deleted session's answer carries NO
  // not-found wording at all: the client keeps `name: "ClientError"` and drops the
  // 404. Message matching can never prove absence there; only a live control can.
  function liveHost({ live = [], targetError } = {}) {
    const alive = new Set(live)
    const schemaError = () => Object.assign(new Error('Missing key at ["sessionID"]'), { name: "SchemaError" })
    const requireID = (address) => {
      if (!address || typeof address.sessionID !== "string") throw schemaError()
      return address.sessionID
    }
    const gone = () => targetError ?? Object.assign(new Error("ApiError"), { name: "ClientError" })
    return {
      alive,
      domains: {
        session: {
          async remove(address) { alive.delete(requireID(address)) },
          async get(address) {
            const sessionID = requireID(address)
            if (alive.has(sessionID)) return { id: sessionID }
            throw gone()
          },
        },
      },
    }
  }

  test("#given the live host's wording-free answer and a live control session #when the delete resolves #then the close is verified", async () => {
    // The retest-7 red: the host's answer for a deleted session says nothing about
    // absence, but the caller's own live session proves the call itself works.
    const host = liveHost({ live: ["ses_control"] })
    // when
    const result = await createMemberSessionTerminator({ domains: host.domains })("ses_one", { controlSessionID: "ses_control" })
    // then
    expect(result.deleted).toBe(true)
    expect(result.verified).toBe(true)
    expect(result.unverified).toBeUndefined()
    expect(host.alive.has("ses_one")).toBe(false)
  })

  test("#given the live host's wording-free answer and NO control session #when the delete resolves #then it stays unverified", async () => {
    // Fail-closed guard: without a calibrated address, an unworded failure is not absence.
    const host = liveHost({ live: [] })
    // when
    const result = await createMemberSessionTerminator({ domains: host.domains })("ses_one")
    // then
    expect(result.deleted).toBe(true)
    expect(result.verified).toBe(false)
    expect(result.unverified).toBe(true)
  })

  test("#given a control session the host cannot resolve #when the delete resolves #then it stays unverified", async () => {
    // Fail-closed guard: a control that is not demonstrably alive proves nothing.
    const host = liveHost({ live: [] })
    // when
    const result = await createMemberSessionTerminator({ domains: host.domains })("ses_one", { controlSessionID: "ses_control" })
    // then
    expect(result.verified).toBe(false)
    expect(result.unverified).toBe(true)
  })

  test("#given a resolvable control session #when the target's probe breaks at the transport layer #then it stays unverified", async () => {
    // Fail-closed guard: the host never answered for the target, so nothing is known.
    const transport = Object.assign(new Error("Transport: socket hang up"), { name: "ClientError", reason: "Transport" })
    const host = liveHost({ live: ["ses_control"], targetError: transport })
    // when
    const result = await createMemberSessionTerminator({ domains: host.domains })("ses_one", { controlSessionID: "ses_control" })
    // then
    expect(result.verified).toBe(false)
    expect(result.unverified).toBe(true)
  })

  test("#given the live host rejects two address shapes and answers the root shape opaquely #when absence cannot be proven #then every attempt is reported", async () => {
    // The retest-7 diagnostic red: only the LAST shape's schema rejection reached the
    // caller, which hid what the working root shape actually said.
    const host = liveHost({ live: [] })
    // when
    const result = await createMemberSessionTerminator({ domains: host.domains })("ses_one")
    // then
    expect(result.reason).toContain("session.get({ sessionID })")
    expect(result.reason).toContain("session.get({ params: { sessionID } })")
    expect(result.reason).toContain("Missing key")
  })

  // Final independent gate (ROW55): a CALIBRATED address turns "the call failed"
  // into "the session is gone". A permission refusal is not that - the host
  // answered, and it refused. These three lock the seam shut.
  for (const status of [401, 403]) {
    test(`#given a live control session #when the target probe is refused with ${status} #then the close is not verified`, async () => {
      const refusal = Object.assign(new Error(`Request failed with status ${status}`), { status })
      const host = liveHost({ live: ["ses_control"], targetError: refusal })
      // when
      const result = await createMemberSessionTerminator({ domains: host.domains })("ses_one", { controlSessionID: "ses_control" })
      // then: a refused request proves nothing about the session
      expect(result.deleted).toBe(true)
      expect(result.verified).toBe(false)
      expect(result.unverified).toBe(true)
    })
  }

  test("#given a live control session #when the host answers a 403 envelope with data null #then the close is not verified", async () => {
    // The SDK-shaped hole: `{ data: null, error: { status: 403 } }` used to read as
    // a weak empty answer and verify the close.
    const domains = {
      session: {
        async remove() {},
        async get(address) {
          if (!address?.sessionID) throw Object.assign(new Error('Missing key at ["sessionID"]'), { name: "SchemaError" })
          if (address.sessionID === "ses_control") return { id: "ses_control" }
          return { data: null, error: { status: 403 } }
        },
      },
    }
    // when
    const result = await createMemberSessionTerminator({ domains })("ses_one", { controlSessionID: "ses_control" })
    // then
    expect(result.verified).toBe(false)
    expect(result.unverified).toBe(true)
  })

  // Final gate round 2 (ROW55): a refusal has to be recognized wherever the host
  // stores it - nested in `cause` (the SDK wraps client errors that way),
  // stringified, or expressed only as a structured code - and a rate limit is a
  // refusal too, never an absence.
  const REFUSALS = [
    ["SDK-wrapped 401 in cause.status", () => Object.assign(new Error("Request failed"), { cause: { status: 401 } })],
    ["SDK-wrapped 403 in cause.status", () => Object.assign(new Error("Request failed"), { cause: { status: 403 } })],
    ["a stringified 403", () => Object.assign(new Error("Request failed"), { status: "403" })],
    ["a structured PERMISSION_DENIED code", () => Object.assign(new Error("Request failed"), { code: "PERMISSION_DENIED" })],
    ["a 403 body worded like not-found/params", () => Object.assign(new Error("session not found: params invalid"), { cause: { status: 403 } })],
    ["a numeric 429 rate limit", () => Object.assign(new Error("Too Many Requests"), { status: 429 })],
  ]
  for (const [label, make] of REFUSALS) {
    test(`#given a live control session #when the target probe fails with ${label} #then the close is not verified`, async () => {
      const host = liveHost({ live: ["ses_control"], targetError: make() })
      // when
      const result = await createMemberSessionTerminator({ domains: host.domains })("ses_one", { controlSessionID: "ses_control" })
      // then: a refusal is not an absence, and the delete still resolved
      expect(result.deleted).toBe(true)
      expect(result.verified).toBe(false)
      expect(result.unverified).toBe(true)
    })
  }
})
