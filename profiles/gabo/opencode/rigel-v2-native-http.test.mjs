import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createServerApi, parseServerOrigin, readServiceRegistration, resolveCredential, resolveServerOrigin, serviceConfigPath, serviceRegistrationPath, socketOwnedBySelf } from "./rigel-v2-native-http.mjs"

const SERVE_ARGV = ["/usr/bin/opencode", "serve", "--hostname", "127.0.0.1", "--port", "4097"]
const ORIGIN = "http://127.0.0.1:4097"
const PASSWORD = "s3cret-pw"
const EXPECTED_AUTH = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`

function jsonResponse(body, status = 200) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

// An api backed by a hand-rolled fetch that records every functional request
// and answers with the responder's canned Response. The identity probe is
// answered with a valid V2 document and the api is verified before it is
// returned, so callers exercise the post-verification behavior; the identity
// probe is not left in `calls`. No network is touched.
const IDENTITY_DOCUMENT = { version: "2.0.22", pid: 4242, urls: ["http://127.0.0.1:4097"] }

async function recordingApi(responder) {
  const calls = []
  const api = createServerApi({
    argv: SERVE_ARGV,
    env: { OPENCODE_PASSWORD: PASSWORD },
    fetchImpl: async (url, init = {}) => {
      if (url.endsWith("/api/info")) return jsonResponse(IDENTITY_DOCUMENT)
      calls.push({ url, init })
      return await responder(url, init, calls.length)
    },
  })
  await api.verifyIdentity()
  return { api, calls }
}

describe("parseServerOrigin", () => {
  describe("given a loopback host and a non-default port", () => {
    describe("when the flags are space-separated", () => {
      test("then it returns the origin, host and port", () => {
        expect(parseServerOrigin(["/usr/bin/opencode", "serve", "--hostname", "127.0.0.1", "--port", "4097"])).toEqual({
          origin: "http://127.0.0.1:4097",
          host: "127.0.0.1",
          port: "4097",
        })
      })
    })
    describe("when the flags use equals syntax", () => {
      test("then it returns the same origin", () => {
        expect(parseServerOrigin(["/usr/bin/opencode", "serve", "--hostname=127.0.0.1", "--port=4097"])).toEqual({
          origin: "http://127.0.0.1:4097",
          host: "127.0.0.1",
          port: "4097",
        })
      })
    })
  })

  describe("given no port", () => {
    describe("when only a hostname is present", () => {
      test("then the origin is undefined", () => {
        expect(parseServerOrigin(["/usr/bin/opencode", "serve", "--hostname", "127.0.0.1"])).toEqual({ origin: undefined })
      })
    })
  })

  describe("given a non-loopback host", () => {
    describe("when a port is present", () => {
      test("then the origin is refused", () => {
        expect(parseServerOrigin(["--hostname", "0.0.0.0", "--port", "4097"])).toEqual({ origin: undefined })
        expect(parseServerOrigin(["--hostname=10.0.0.5", "--port", "4097"])).toEqual({ origin: undefined })
      })
    })
  })

  describe("given port 4096, a legitimate V2 default", () => {
    describe("when the port is spelled either way", () => {
      test("then the origin is accepted, never refused by port number", () => {
        expect(parseServerOrigin(["--port", "4096"])).toEqual({ origin: "http://127.0.0.1:4096", host: "127.0.0.1", port: "4096" })
        expect(parseServerOrigin(["--port=4096", "--hostname", "127.0.0.1"]).origin).toBe("http://127.0.0.1:4096")
      })
    })
  })

  describe("given a loopback host", () => {
    describe("when the hostname is omitted", () => {
      test("then it defaults to 127.0.0.1", () => {
        expect(parseServerOrigin(["/usr/bin/opencode", "serve", "--port", "4097"])).toEqual({
          origin: "http://127.0.0.1:4097",
          host: "127.0.0.1",
          port: "4097",
        })
      })
    })
    describe("when the host is localhost", () => {
      test("then it is accepted", () => {
        expect(parseServerOrigin(["--hostname=localhost", "--port", "4097"])).toEqual({
          origin: "http://localhost:4097",
          host: "localhost",
          port: "4097",
        })
      })
    })
    describe("when the host is ::1", () => {
      test("then it is accepted and bracketed", () => {
        expect(parseServerOrigin(["--hostname", "::1", "--port", "4097"])).toEqual({
          origin: "http://[::1]:4097",
          host: "::1",
          port: "4097",
        })
      })
    })
  })

  describe("given malformed input", () => {
    describe("when the value is not a usable argv", () => {
      test("then it never throws and returns an undefined origin", () => {
        for (const input of [undefined, null, "serve", 42, {}, [], ["--port"], ["--hostname", "127.0.0.1"]]) {
          expect(() => parseServerOrigin(input)).not.toThrow()
          expect(parseServerOrigin(input).origin).toBeUndefined()
        }
      })
    })
  })
})

describe("socketOwnedBySelf", () => {
  test("reports true when this process owns the port's listening socket", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-socket-"))
    const netTcp = path.join(tmp, "tcp")
    fs.writeFileSync(netTcp, "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n 0: 00000000:1001 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 424242 1 0000000000000000 100 0 0 10 0\n")
    const fdDir = path.join(tmp, "fd")
    fs.mkdirSync(fdDir)
    // A descriptor is a symlink to `socket:[<inode>]`; any regular file stands in.
    fs.writeFileSync(path.join(fdDir, "7"), "")
    const realReadlink = fs.readlinkSync
    fs.readlinkSync = (target) => (String(target) === path.join(fdDir, "7") ? "socket:[424242]" : realReadlink(target))
    try {
      expect(socketOwnedBySelf("127.0.0.1", 4097, { netTcp, netTcp6: path.join(tmp, "none"), fdDir })).toBe(true)
      expect(socketOwnedBySelf("127.0.0.1", 5222, { netTcp, netTcp6: path.join(tmp, "none"), fdDir })).toBeUndefined()
    } finally {
      fs.readlinkSync = realReadlink
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe("createServerApi availability", () => {
  describe("given a loopback server and a password", () => {
    describe("when identity is verified", () => {
      test("then it becomes available and exposes the origin", async () => {
        const api = createServerApi({
          argv: SERVE_ARGV,
          env: { OPENCODE_PASSWORD: PASSWORD },
          fetchImpl: async (url) => (url.endsWith("/api/info") ? jsonResponse(IDENTITY_DOCUMENT) : jsonResponse({})),
        })
        expect(api.available).toBe(false)
        const identity = await api.verifyIdentity()
        expect(identity.ok).toBe(true)
        expect(api.available).toBe(true)
        expect(api.origin).toBe(ORIGIN)
      })
    })
  })

  describe("given an untrusted environment-only origin", () => {
    describe("when identity is verified", () => {
      test("then no credential is sent and the api never becomes available", async () => {
        const calls = []
        const api = createServerApi({
          argv: ["opencode"],
          env: { RIGEL_V2_SERVER_ORIGIN: "http://127.0.0.1:5000", OPENCODE_PASSWORD: PASSWORD },
          fetchImpl: async (...args) => {
            calls.push(args)
            return jsonResponse(IDENTITY_DOCUMENT)
          },
          socketOwner: () => false,
        })
        expect(api.trusted).toBe(false)
        const identity = await api.verifyIdentity()
        expect(identity.ok).toBe(false)
        expect(api.available).toBe(false)
        expect(calls.length).toBe(0)
        expect((await api.getSessions()).error.code).toBe("v2_http_untrusted")
        expect(calls.length).toBe(0)
      })
      test("then the same origin becomes usable when this process owns the port socket", async () => {
        const calls = []
        const api = createServerApi({
          argv: ["opencode"],
          env: { RIGEL_V2_SERVER_ORIGIN: "http://127.0.0.1:5000", OPENCODE_PASSWORD: PASSWORD },
          fetchImpl: async (url, init) => {
            calls.push(url)
            return url.endsWith("/api/info") ? jsonResponse(IDENTITY_DOCUMENT) : jsonResponse({ data: [] })
          },
          socketOwner: () => true,
        })
        expect(api.trusted).toBe(true)
        expect(api.anchor).toBe("process-socket")
        expect((await api.verifyIdentity()).ok).toBe(true)
        expect((await api.getSessions()).ok).toBe(true)
        expect(calls.length).toBe(2)
      })
    })
  })

  describe("given a trusted origin whose identity cannot be verified", () => {
    describe("when a functional method is called before verification", () => {
      test("then the call is refused as unverified and no request is sent", async () => {
        const calls = []
        const api = createServerApi({
          argv: SERVE_ARGV,
          env: { OPENCODE_PASSWORD: PASSWORD },
          fetchImpl: async (url, init) => {
            calls.push(url)
            return jsonResponse({})
          },
        })
        const result = await api.getSessions()
        expect(result.error.code).toBe("v2_http_unverified")
        expect(calls.length).toBe(0)
      })
    })
  })

  describe("given no OPENCODE_PASSWORD", () => {
    describe("when a method is called", () => {
      test("then it fails closed as unavailable and never calls fetch", async () => {
        const calls = []
        const api = createServerApi({
          argv: SERVE_ARGV,
          env: {},
          fetchImpl: async (...args) => {
            calls.push(args)
            return jsonResponse({})
          },
        })
        expect(api.available).toBe(false)
        expect(api.origin).toBe(ORIGIN)
        expect((await api.verifyIdentity()).ok).toBe(false)
        const result = await api.getSessions({ limit: 5 })
        expect(result.ok).toBe(false)
        expect(result.status).toBeNull()
        expect(result.data).toBeNull()
        expect(result.error).toEqual({ code: "v2_http_unavailable", message: expect.any(String) })
        expect(calls.length).toBe(0)
      })
    })
  })

  describe("given an empty OPENCODE_PASSWORD", () => {
    describe("when identityCheck is called", () => {
      test("then it is unavailable and never calls fetch", async () => {
        const calls = []
        const api = createServerApi({
          argv: SERVE_ARGV,
          env: { OPENCODE_PASSWORD: "" },
          fetchImpl: async () => {
            calls.push(1)
            return jsonResponse({})
          },
        })
        expect(api.available).toBe(false)
        expect((await api.verifyIdentity()).ok).toBe(false)
        expect((await api.identityCheck("ses_1")).ok).toBe(false)
        expect(calls.length).toBe(0)
      })
    })
  })

  describe("given argv without a server port", () => {
    describe("when a method is called", () => {
      test("then the origin is undefined and the api is unverified", async () => {
        const calls = []
        const api = createServerApi({
          argv: ["/usr/bin/opencode", "serve", "--hostname", "127.0.0.1"],
          env: { OPENCODE_PASSWORD: PASSWORD },
          fetchImpl: async () => {
            calls.push(1)
            return jsonResponse({})
          },
        })
        expect(api.origin).toBeUndefined()
        expect(api.available).toBe(false)
        expect((await api.verifyIdentity()).ok).toBe(false)
        expect((await api.getSessions()).error.code).toBe("v2_http_untrusted")
        expect(calls.length).toBe(0)
      })
    })
  })
})

describe("createServerApi credential", () => {
  describe("given an OPENCODE_PASSWORD", () => {
    describe("when a request is issued", () => {
      test("then it carries the exact Basic header bytes", async () => {
        const { api, calls } = await recordingApi(() => jsonResponse({}))
        await api.identityCheck("ses_1")
        expect(calls[0].init.headers.Authorization).toBe(EXPECTED_AUTH)
        expect(EXPECTED_AUTH).toBe(`Basic ${Buffer.from("opencode:" + PASSWORD).toString("base64")}`)
      })
    })
  })
})

describe("createServerApi identityCheck", () => {
  describe("given the server reports the requested session at data.id", () => {
    describe("when identityCheck runs", () => {
      test("then it confirms identity with the exact GET URL", async () => {
        const { api, calls } = await recordingApi(() => jsonResponse({ data: { id: "ses_target" } }))
        expect(await api.identityCheck("ses_target")).toEqual({ ok: true })
        expect(calls[0].url).toBe(`${ORIGIN}/api/session/ses_target`)
        expect(calls[0].init.method).toBe("GET")
      })
    })
  })

  describe("given the server reports the session at the top-level id", () => {
    describe("when identityCheck runs", () => {
      test("then it still matches", async () => {
        const { api } = await recordingApi(() => jsonResponse({ id: "ses_target" }))
        expect(await api.identityCheck("ses_target")).toEqual({ ok: true })
      })
    })
  })

  describe("given the server reports a different session", () => {
    describe("when identityCheck runs", () => {
      test("then it fails closed with a reason", async () => {
        const { api } = await recordingApi(() => jsonResponse({ data: { id: "ses_other" } }))
        const result = await api.identityCheck("ses_target")
        expect(result.ok).toBe(false)
        expect(typeof result.reason).toBe("string")
        expect(result.reason).toContain("ses_other")
      })
    })
  })

  describe("given the request itself fails", () => {
    describe("when identityCheck runs", () => {
      test("then it fails closed with the request reason", async () => {
        const { api } = await recordingApi(() => jsonResponse({}, 500))
        const result = await api.identityCheck("ses_target")
        expect(result.ok).toBe(false)
        expect(result.reason).toContain("HTTP 500")
      })
    })
  })
})

describe("createServerApi request shapes", () => {
  describe("given a reachable server", () => {
    describe("when getSessions receives allowed and unknown params", () => {
      test("then it GETs /api/session with only the allowed params", async () => {
        const { api, calls } = await recordingApi(() => jsonResponse({ data: [] }))
        await api.getSessions({ limit: 10, order: "desc", directory: "/w", bogus: "drop", search: undefined })
        expect(calls[0].url).toBe(`${ORIGIN}/api/session?limit=10&order=desc&directory=%2Fw`)
        expect(calls[0].init.method).toBe("GET")
        expect(calls[0].init.body).toBeUndefined()
        expect(calls[0].init.headers.Authorization).toBe(EXPECTED_AUTH)
        expect(calls[0].init.headers.Accept).toBe("application/json")
        expect(calls[0].init.headers["Content-Type"]).toBeUndefined()
      })
    })

    describe("when getSessions receives no params", () => {
      test("then it GETs /api/session with no query string", async () => {
        const { api, calls } = await recordingApi(() => jsonResponse({ data: [] }))
        await api.getSessions()
        expect(calls[0].url).toBe(`${ORIGIN}/api/session`)
      })
    })

    describe("when getSessionContext and getSessionExport run", () => {
      test("then they GET encoded context and export endpoints", async () => {
        const { api, calls } = await recordingApi(() => jsonResponse({ data: [] }))
        await api.getSessionContext("ses a/b")
        await api.getSessionExport("ses a/b")
        expect(calls[0].url).toBe(`${ORIGIN}/api/session/ses%20a%2Fb/context`)
        expect(calls[1].url).toBe(`${ORIGIN}/api/experimental/session/ses%20a%2Fb/export`)
        expect(calls[0].init.method).toBe("GET")
        expect(calls[1].init.method).toBe("GET")
      })
    })

    describe("when createTerminal receives terminal fields", () => {
      test("then it POSTs the JSON body with a content type", async () => {
        const { api, calls } = await recordingApi(() => jsonResponse({ data: { id: "pty_1" } }))
        await api.createTerminal("ses_1", {
          command: "bash",
          args: ["-lc", "ls"],
          title: "t",
          env: { A: "1" },
          size: { cols: 80, rows: 24 },
          ignored: true,
        })
        expect(calls[0].url).toBe(`${ORIGIN}/api/experimental/session/ses_1/terminal`)
        expect(calls[0].init.method).toBe("POST")
        expect(calls[0].init.headers["Content-Type"]).toBe("application/json")
        expect(JSON.parse(calls[0].init.body)).toEqual({
          command: "bash",
          args: ["-lc", "ls"],
          title: "t",
          env: { A: "1" },
          size: { cols: 80, rows: 24 },
        })
      })
    })

    describe("when createTerminal receives only a command", () => {
      test("then it omits the undefined fields", async () => {
        const { api, calls } = await recordingApi(() => jsonResponse({}))
        await api.createTerminal("ses_1", { command: "bash" })
        expect(calls[0].init.body).toBe('{"command":"bash"}')
      })
    })

    describe("when listTerminals runs", () => {
      test("then it GETs the session terminal collection", async () => {
        const { api, calls } = await recordingApi(() => jsonResponse({ data: [] }))
        await api.listTerminals("ses_1")
        expect(calls[0].url).toBe(`${ORIGIN}/api/experimental/session/ses_1/terminal`)
        expect(calls[0].init.method).toBe("GET")
      })
    })

    describe("when snapshotTerminal runs", () => {
      test("then it GETs the persistent pty snapshot", async () => {
        const { api, calls } = await recordingApi(() => jsonResponse({ data: {} }))
        await api.snapshotTerminal("pty_1")
        expect(calls[0].url).toBe(`${ORIGIN}/api/experimental/persistent-pty/pty_1/snapshot`)
        expect(calls[0].init.method).toBe("GET")
      })
    })

    describe("when removeTerminal runs", () => {
      test("then it DELETEs the persistent pty with no body", async () => {
        const { api, calls } = await recordingApi(() => new Response(null, { status: 204 }))
        await api.removeTerminal("pty_1")
        expect(calls[0].url).toBe(`${ORIGIN}/api/experimental/persistent-pty/pty_1`)
        expect(calls[0].init.method).toBe("DELETE")
        expect(calls[0].init.body).toBeUndefined()
      })
    })

    describe("when shellOnce receives shell fields", () => {
      test("then it POSTs the shell body", async () => {
        const { api, calls } = await recordingApi(() => jsonResponse({ data: {} }))
        await api.shellOnce({ command: "ls", cwd: "/w", timeout: 1000, metadata: { a: 1 }, ignored: true })
        expect(calls[0].url).toBe(`${ORIGIN}/api/shell`)
        expect(calls[0].init.method).toBe("POST")
        expect(JSON.parse(calls[0].init.body)).toEqual({ command: "ls", cwd: "/w", timeout: 1000, metadata: { a: 1 } })
      })
    })

    describe("when raw runs", () => {
      test("then it resolves the origin-relative path with the basic credential", async () => {
        const { api, calls } = await recordingApi(() => jsonResponse({ ok: true }))
        const result = await api.raw("GET", "/api/anything", {})
        expect(result).toEqual({ ok: true, status: 200, data: { ok: true }, error: null })
        expect(calls[0].url).toBe(`${ORIGIN}/api/anything`)
        expect(calls[0].init.headers.Authorization).toBe(EXPECTED_AUTH)
      })
    })
  })
})

describe("createServerApi error mapping", () => {
  describe("given the server answers 401", () => {
    test("then the result is a typed auth error", async () => {
      const { api } = await recordingApi(() => new Response("{}", { status: 401 }))
      const result = await api.getSessionContext("ses_1")
      expect(result.ok).toBe(false)
      expect(result.status).toBe(401)
      expect(result.data).toBeNull()
      expect(result.error).toEqual({ code: "v2_http_auth", message: expect.any(String) })
    })
  })

  describe("given the server answers 403", () => {
    test("then the result is a typed auth error", async () => {
      const { api } = await recordingApi(() => new Response("{}", { status: 403 }))
      expect((await api.getSessionContext("ses_1")).error.code).toBe("v2_http_auth")
    })
  })

  describe("given the server answers 404", () => {
    test("then the result is a typed not_found error", async () => {
      const { api } = await recordingApi(() => new Response("{}", { status: 404 }))
      const result = await api.snapshotTerminal("pty_1")
      expect(result.status).toBe(404)
      expect(result.error.code).toBe("v2_http_not_found")
    })
  })

  describe("given the server answers 500", () => {
    test("then the result is a typed generic error", async () => {
      const { api } = await recordingApi(() => new Response("boom", { status: 500 }))
      const result = await api.shellOnce({ command: "ls" })
      expect(result.status).toBe(500)
      expect(result.error.code).toBe("v2_http_error")
    })
  })

  describe("given the transport rejects", () => {
    test("then the result is a typed generic error", async () => {
      const { api } = await recordingApi(() => {
        throw new Error("ECONNREFUSED")
      })
      const result = await api.getSessions({ limit: 1 })
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe("v2_http_error")
      expect(result.error.message).toContain("ECONNREFUSED")
    })
  })

  describe("given a 204 with no body", () => {
    test("then it is a successful result with null data", async () => {
      const { api } = await recordingApi(() => new Response(null, { status: 204 }))
      expect(await api.removeTerminal("pty_1")).toEqual({ ok: true, status: 204, data: null, error: null })
    })
  })

  describe("given a 2xx with a non-JSON body", () => {
    test("then it is successful with null data", async () => {
      const { api } = await recordingApi(() => new Response("not json", { status: 200 }))
      expect(await api.getSessionExport("ses_1")).toEqual({ ok: true, status: 200, data: null, error: null })
    })
  })

  describe("given the request never resolves", () => {
    test("then raw reports a typed timeout error", async () => {
      const { api } = await recordingApi(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => {
              const error = new Error("aborted")
              error.name = "AbortError"
              reject(error)
            })
          }),
      )
      const result = await api.raw("GET", "/api/slow", { timeout: 25 })
      expect(result.ok).toBe(false)
      expect(result.status).toBeNull()
      expect(result.error).toEqual({ code: "v2_http_timeout", message: expect.any(String) })
    })
  })
})

describe("resolveServerOrigin", () => {
  describe("given a V2 setup context with a serverUrl", () => {
    test("then it resolves without any argv --port (the normal TUI path)", () => {
      const resolved = resolveServerOrigin({
        argv: ["opencode"],
        env: {},
        context: { serverUrl: new URL("http://127.0.0.1:4100") },
      })
      expect(resolved).toEqual({ origin: "http://127.0.0.1:4100", host: "127.0.0.1", port: "4100", source: "context.serverUrl" })
    })
  })

  describe("given the synthetic fallback context serverUrl", () => {
    test("then localhost:4096 is treated as no-live-server, while an explicit origin on 4096 is honoured", () => {
      expect(resolveServerOrigin({ argv: [], env: {}, context: { serverUrl: "http://localhost:4096" } }).origin).toBeUndefined()
      expect(resolveServerOrigin({ argv: [], env: { RIGEL_V2_SERVER_ORIGIN: "http://127.0.0.1:4096" }, context: {} }).origin).toBe("http://127.0.0.1:4096")
      expect(resolveServerOrigin({ argv: ["--port", "4096"], env: {}, context: {} }).origin).toBe("http://127.0.0.1:4096")
    })
  })

  describe("given only an injected environment origin", () => {
    test("then OPENCODE_SERVER_URL resolves and the explicit env origin is the source", () => {
      expect(resolveServerOrigin({ argv: [], env: { OPENCODE_SERVER_URL: "http://127.0.0.1:4101" }, context: {} })).toEqual({
        origin: "http://127.0.0.1:4101",
        host: "127.0.0.1",
        port: "4101",
        source: "env.OPENCODE_SERVER_URL",
      })
    })
    test("then a contextual serverUrl outranks the environment", () => {
      const resolved = resolveServerOrigin({
        argv: [],
        env: { RIGEL_V2_SERVER_ORIGIN: "http://127.0.0.1:4101" },
        context: { serverUrl: "http://127.0.0.1:4102" },
      })
      expect(resolved.origin).toBe("http://127.0.0.1:4102")
      expect(resolved.source).toBe("context.serverUrl")
    })
    test("then this process's own serve argv outranks the environment", () => {
      expect(resolveServerOrigin({ argv: ["--port", "5000"], env: { OPENCODE_SERVER_URL: "http://127.0.0.1:4101" }, context: {} })).toEqual({
        origin: "http://127.0.0.1:5000",
        host: "127.0.0.1",
        port: "5000",
        source: "argv",
      })
    })
  })

  describe("given a non-loopback or malformed source", () => {
    test("then it is refused closed and never throws", () => {
      expect(resolveServerOrigin({ argv: [], env: { RIGEL_V2_SERVER_ORIGIN: "http://10.0.0.5:4100" }, context: {} }).origin).toBeUndefined()
      expect(resolveServerOrigin({ argv: [], env: { OPENCODE_SERVER_URL: "ftp://127.0.0.1:4100" }, context: {} }).origin).toBeUndefined()
      expect(resolveServerOrigin({ argv: [], env: {}, context: { serverUrl: "not a url" } }).origin).toBeUndefined()
      expect(() => resolveServerOrigin({ argv: null, env: null, context: null })).not.toThrow()
    })
  })
})

describe("resolveCredential", () => {
  test("accepts OPENCODE_PASSWORD with the default username", () => {
    expect(resolveCredential({ OPENCODE_PASSWORD: "pw" })).toEqual({
      username: "opencode",
      password: "pw",
      authorization: `Basic ${Buffer.from("opencode:pw").toString("base64")}`,
    })
  })
  test("accepts OPENCODE_SERVER_PASSWORD and OPENCODE_SERVER_USERNAME when OPENCODE_PASSWORD is absent", () => {
    const credential = resolveCredential({ OPENCODE_SERVER_PASSWORD: "pw2", OPENCODE_SERVER_USERNAME: "custom" })
    expect(credential.authorization).toBe(`Basic ${Buffer.from("custom:pw2").toString("base64")}`)
  })
  test("prefers OPENCODE_PASSWORD when both are set and non-empty", () => {
    expect(resolveCredential({ OPENCODE_PASSWORD: "primary", OPENCODE_SERVER_PASSWORD: "secondary" }).password).toBe("primary")
  })
  test("falls through an empty primary and fails closed when neither is usable", () => {
    expect(resolveCredential({ OPENCODE_PASSWORD: "  ", OPENCODE_SERVER_PASSWORD: "secondary" }).password).toBe("secondary")
    expect(resolveCredential({ OPENCODE_PASSWORD: "", OPENCODE_SERVER_PASSWORD: "" })).toBeUndefined()
    expect(resolveCredential({})).toBeUndefined()
  })
})

describe("createServerApi verifyIdentity", () => {
  const CONTEXT = { serverUrl: "http://127.0.0.1:4100" }
  const ENV = { OPENCODE_PASSWORD: PASSWORD }

  test("confirms a V2 server by its /api/info identity document", async () => {
    const seen = []
    const api = createServerApi({
      argv: [],
      env: ENV,
      context: CONTEXT,
      fetchImpl: async (url) => {
        seen.push(url)
        return jsonResponse({ version: "2.0.22", pid: 4242, urls: ["http://127.0.0.1:4100"], paths: { tmp: "/tmp" } })
      },
    })
    const result = await api.verifyIdentity()
    expect(result.ok).toBe(true)
    expect(result.info.version).toBe("2.0.22")
    expect(result.info.pid).toBe(4242)
    expect(seen).toContain("http://127.0.0.1:4100/api/info")
  })

  test("rejects a served origin that is not an OpenCode V2 server", async () => {
    const api = createServerApi({ argv: [], env: ENV, context: CONTEXT, fetchImpl: async () => jsonResponse({ hello: "world" }) })
    const result = await api.verifyIdentity()
    expect(result.ok).toBe(false)
    expect(typeof result.reason).toBe("string")
  })

  test("rejects a 401 origin and fails closed without any origin", async () => {
    const unauth = createServerApi({ argv: [], env: ENV, context: CONTEXT, fetchImpl: async () => new Response("{}", { status: 401 }) })
    expect((await unauth.verifyIdentity()).ok).toBe(false)
    const noOrigin = createServerApi({ argv: [], env: ENV, context: {}, fetchImpl: async () => jsonResponse({}) })
    expect((await noOrigin.verifyIdentity()).ok).toBe(false)
  })
})

// The host's own local service handoff: the STATE registration (origin + pid)
// and the CONFIG file (the persisted password) that `opencode serve --service`
// and `@opencode/client` share. A memory filesystem keeps these tests hermetic
// and never reads the developer's real XDG roots.
const SERVICE_HOME = "/tmp/rigel-service-home"
const SERVICE_STATE_FILE = path.join(SERVICE_HOME, ".local", "state", "opencode", "service.json")
const SERVICE_CONFIG_FILE = path.join(SERVICE_HOME, ".config", "opencode", "service.json")
const SERVICE_ORIGIN = "http://127.0.0.1:49374"
const SERVICE_USER = "opencode"

function memFs(files) {
  return {
    readFileSync(file) {
      if (Object.prototype.hasOwnProperty.call(files, file)) return files[file]
      const error = new Error(`ENOENT: no such file or directory, open '${file}'`)
      error.code = "ENOENT"
      throw error
    },
  }
}

function basicFor(password, username = SERVICE_USER) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

describe("serviceRegistrationPath", () => {
  test("defaults to the XDG state dir and honours an explicit override", () => {
    expect(serviceRegistrationPath({ env: { HOME: "/h" } })).toBe(path.join("/h", ".local", "state", "opencode", "service.json"))
    expect(serviceRegistrationPath({ env: { HOME: "/h", XDG_STATE_HOME: "/s" } })).toBe(path.join("/s", "opencode", "service.json"))
    expect(serviceRegistrationPath({ env: { OPENCODE_SERVICE_FILE: "/x/service.json" } })).toBe("/x/service.json")
    expect(serviceConfigPath({ env: { HOME: "/h" } })).toBe(path.join("/h", ".config", "opencode", "service.json"))
  })
})

describe("readServiceRegistration", () => {
  const PID = 4242

  test("merges the state origin+pid with the config password and marks this process's own", () => {
    const fs = memFs({
      [SERVICE_STATE_FILE]: JSON.stringify({ url: SERVICE_ORIGIN, pid: PID, version: "2.0.27" }),
      [SERVICE_CONFIG_FILE]: JSON.stringify({ hostname: "127.0.0.1", port: 49374, password: "svc-pw" }),
    })
    expect(readServiceRegistration({ env: { HOME: SERVICE_HOME }, processPid: PID, fsImpl: fs })).toEqual({
      origin: SERVICE_ORIGIN,
      host: "127.0.0.1",
      port: "49374",
      pid: PID,
      pidMatches: true,
      password: "svc-pw",
      version: "2.0.27",
      path: SERVICE_STATE_FILE,
    })
  })

  test("returns undefined without a host home, never touching disk", () => {
    const fs = { readFileSync() { throw new Error("readFileSync must not be called without a host home") } }
    expect(readServiceRegistration({ env: {}, processPid: PID, fsImpl: fs })).toBeUndefined()
  })

  test("fails closed on a missing, malformed, or non-loopback registration", () => {
    expect(readServiceRegistration({ env: { HOME: SERVICE_HOME }, processPid: PID, fsImpl: memFs({}) })).toBeUndefined()
    expect(readServiceRegistration({ env: { HOME: SERVICE_HOME }, processPid: PID, fsImpl: memFs({ [SERVICE_STATE_FILE]: "{ not json" }) })).toBeUndefined()
    expect(readServiceRegistration({ env: { HOME: SERVICE_HOME }, processPid: PID, fsImpl: memFs({ [SERVICE_STATE_FILE]: JSON.stringify({ url: "http://10.0.0.5:49374", pid: PID }) }) })).toBeUndefined()
  })

  test("marks pidMatches false when the registration belongs to another process", () => {
    const fs = memFs({ [SERVICE_STATE_FILE]: JSON.stringify({ url: SERVICE_ORIGIN, pid: PID + 1 }) })
    expect(readServiceRegistration({ env: { HOME: SERVICE_HOME }, processPid: PID, fsImpl: fs }).pidMatches).toBe(false)
  })

  test("accepts the config-only handoff (origin from hostname/port, no pid)", () => {
    const fs = memFs({ [SERVICE_CONFIG_FILE]: JSON.stringify({ hostname: "127.0.0.1", port: 49374, password: "svc-pw" }) })
    const registration = readServiceRegistration({ env: { HOME: SERVICE_HOME }, processPid: PID, fsImpl: fs })
    expect(registration.origin).toBe(SERVICE_ORIGIN)
    expect(registration.password).toBe("svc-pw")
    expect(registration.pidMatches).toBe(false)
  })

  test("does not pair the config password to a different origin", () => {
    const fs = memFs({
      [SERVICE_STATE_FILE]: JSON.stringify({ url: SERVICE_ORIGIN, pid: PID }),
      [SERVICE_CONFIG_FILE]: JSON.stringify({ hostname: "127.0.0.1", port: 4096, password: "other" }),
    })
    expect(readServiceRegistration({ env: { HOME: SERVICE_HOME }, processPid: PID, fsImpl: fs }).password).toBeUndefined()
  })
})

describe("createServerApi host service registration", () => {
  const PID = process.pid

  test("builds a trusted, verified API from the host handoff and sends its Basic credential", async () => {
    const seen = []
    const fs = memFs({
      [SERVICE_STATE_FILE]: JSON.stringify({ url: SERVICE_ORIGIN, pid: PID, version: "2.0.27" }),
      [SERVICE_CONFIG_FILE]: JSON.stringify({ hostname: "127.0.0.1", port: 49374, password: "svc-pw" }),
    })
    const api = createServerApi({
      argv: ["opencode", "serve", "--service"],
      env: { HOME: SERVICE_HOME },
      context: {},
      processPid: PID,
      fsImpl: fs,
      fetchImpl: async (url, init = {}) => {
        seen.push({ url, auth: init.headers?.Authorization })
        return jsonResponse({ version: "2.0.27", pid: PID, urls: [SERVICE_ORIGIN] })
      },
    })
    const identity = await api.verifyIdentity()
    expect(identity.ok).toBe(true)
    expect(api.available).toBe(true)
    expect(api.anchor).toBe("process-registration")
    expect(seen[0].url).toBe(`${SERVICE_ORIGIN}/api/info`)
    expect(seen[0].auth).toBe(basicFor("svc-pw"))
  })

  test("fails closed and sends nothing when the registration pid is not this process", async () => {
    let fetched = 0
    const fs = memFs({
      [SERVICE_STATE_FILE]: JSON.stringify({ url: SERVICE_ORIGIN, pid: PID + 1 }),
      [SERVICE_CONFIG_FILE]: JSON.stringify({ hostname: "127.0.0.1", port: 49374, password: "svc-pw" }),
    })
    const api = createServerApi({
      argv: ["opencode", "serve", "--service"],
      env: { HOME: SERVICE_HOME },
      context: {},
      processPid: PID,
      fsImpl: fs,
      fetchImpl: async () => {
        fetched += 1
        return jsonResponse({})
      },
    })
    const identity = await api.verifyIdentity()
    expect(identity.ok).toBe(false)
    expect(api.available).toBe(false)
    expect(fetched).toBe(0)
  })

  test("prefers the process env credential over the registration password", async () => {
    const seen = []
    const fs = memFs({
      [SERVICE_STATE_FILE]: JSON.stringify({ url: SERVICE_ORIGIN, pid: PID }),
      [SERVICE_CONFIG_FILE]: JSON.stringify({ hostname: "127.0.0.1", port: 49374, password: "svc-pw" }),
    })
    const api = createServerApi({
      argv: [],
      env: { HOME: SERVICE_HOME, OPENCODE_SERVER_PASSWORD: "env-pw" },
      context: {},
      processPid: PID,
      fsImpl: fs,
      fetchImpl: async (url, init = {}) => {
        seen.push(init.headers?.Authorization)
        return jsonResponse({ version: "2.0.27", pid: PID, urls: [SERVICE_ORIGIN] })
      },
    })
    await api.verifyIdentity()
    expect(seen[0]).toBe(basicFor("env-pw"))
  })

  test("the registration origin outranks this process's serve argv", async () => {
    const fs = memFs({
      [SERVICE_STATE_FILE]: JSON.stringify({ url: SERVICE_ORIGIN, pid: PID }),
      [SERVICE_CONFIG_FILE]: JSON.stringify({ hostname: "127.0.0.1", port: 49374, password: "svc-pw" }),
    })
    const api = createServerApi({
      argv: ["opencode", "serve", "--port", "4097"],
      env: { HOME: SERVICE_HOME },
      context: {},
      processPid: PID,
      fsImpl: fs,
      fetchImpl: async () => jsonResponse({ version: "2.0.27", pid: PID, urls: [SERVICE_ORIGIN] }),
    })
    expect(api.origin).toBe(SERVICE_ORIGIN)
    expect(api.anchor).toBe("process-registration")
  })
})
