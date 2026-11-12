import { describe, expect, test } from "bun:test"
import { createPersistentTerminalPort, encodeInputFrame } from "./terminal-driver.mjs"

// Records every server call and answers with a canned result per method.
function fakeServerApi(results = {}) {
  const calls = { createTerminal: [], listTerminals: [], snapshotTerminal: [], removeTerminal: [], raw: [] }
  const respond = (name, fallback) => (typeof results[name] === "function" ? results[name]() : fallback)
  return {
    origin: "http://127.0.0.1:4999",
    calls,
    async createTerminal(sessionID, options) {
      calls.createTerminal.push({ sessionID, options })
      return respond("createTerminal", { ok: true, status: 200, data: null, error: null })
    },
    async listTerminals(sessionID) {
      calls.listTerminals.push({ sessionID })
      return respond("listTerminals", { ok: true, status: 200, data: null, error: null })
    },
    async snapshotTerminal(ptyID) {
      calls.snapshotTerminal.push({ ptyID })
      return respond("snapshotTerminal", { ok: true, status: 200, data: null, error: null })
    },
    async removeTerminal(ptyID) {
      calls.removeTerminal.push({ ptyID })
      return respond("removeTerminal", { ok: true, status: 204, data: null, error: null })
    },
    async raw(method, path, init) {
      calls.raw.push({ method, path, init })
      return respond("raw", { ok: true, status: 200, data: null, error: null })
    },
  }
}

// An openSocket implementation that records the URL it was handed and the bytes
// sent. It fires `open` (or `error`) then, for the open path, the server's attach
// `message` control frame, so the driver sends the input frame. All dispatch is
// on microtasks so listeners attach first.
function recordingSocket({ fire = "open", errorMessage } = {}) {
  const record = { url: null, sent: [], closed: false }
  const handlers = new Map()
  const factory = (url) => {
    record.url = url
    const socket = {
      addEventListener(name, handler) {
        handlers.set(name, handler)
      },
      send(frame) {
        record.sent.push(frame)
      },
      close() {
        record.closed = true
      },
    }
    queueMicrotask(() => {
      if (fire === "error") {
        handlers.get("error")?.({ message: errorMessage })
        return
      }
      handlers.get("open")?.()
      handlers.get("message")?.({ data: JSON.stringify({ type: "attached", attachmentID: "att" }) })
    })
    return socket
  }
  return { record, factory }
}

describe("encodeInputFrame", () => {
  describe("#given default options", () => {
    describe("#when encoding a frame", () => {
      test("#then it is five bytes with type 1, cols 80, rows 24", () => {
        const frame = encodeInputFrame()
        expect(frame.length).toBe(5)
        expect([...frame]).toEqual([1, 0, 80, 0, 24])
      })
    })
  })

  describe("#given explicit header values and a payload", () => {
    describe("#when encoding a frame", () => {
      test("#then the header carries the values and the payload follows", () => {
        const frame = encodeInputFrame({ type: 1, cols: 300, rows: 40, payload: Buffer.from("ab", "utf8") })
        expect(frame.length).toBe(7)
        expect([...frame.subarray(0, 5)]).toEqual([1, 300 >> 8, 300 & 0xff, 0, 40])
        expect(frame.subarray(5).toString("utf8")).toBe("ab")
      })
    })
  })

  describe("#given a type outside 0 and 1", () => {
    describe("#when encoding a frame", () => {
      test("#then the type byte is coerced into 0 or 1", () => {
        expect(encodeInputFrame({ type: 0 })[0]).toBe(0)
        expect(encodeInputFrame({ type: 1 })[0]).toBe(1)
        expect(encodeInputFrame({ type: "1" })[0]).toBe(1)
        expect(encodeInputFrame({ type: 7 })[0]).toBe(0)
      })
    })
  })
})

describe("createPersistentTerminalPort", () => {
  describe("start", () => {
    describe("#given the server nests info under data.data", () => {
      describe("#when start is called", () => {
        test("#then ptyID and info come from data.data and options are forwarded", async () => {
          const api = fakeServerApi({
            createTerminal: () => ({ ok: true, status: 200, data: { data: { id: "pty_1", title: "t" } }, error: null }),
          })
          const port = createPersistentTerminalPort({ serverApi: api, sessionID: "ses_1" })
          const result = await port.start({ command: "bash", args: ["-l"], title: "t", env: { A: "1" }, cwd: "/work/dir", size: { cols: 80, rows: 24 } })
          expect(result).toEqual({ ok: true, ptyID: "pty_1", info: { id: "pty_1", title: "t" } })
          expect(api.calls.createTerminal[0]).toEqual({
            sessionID: "ses_1",
            options: { command: "bash", args: ["-l"], title: "t", env: { A: "1" }, cwd: "/work/dir", size: { cols: 80, rows: 24 } },
          })
        })
      })
    })

    describe("#given the server returns info at data directly", () => {
      describe("#when start is called", () => {
        test("#then ptyID is still extracted", async () => {
          const api = fakeServerApi({ createTerminal: () => ({ ok: true, status: 200, data: { id: "pty_2" }, error: null }) })
          const port = createPersistentTerminalPort({ serverApi: api, sessionID: "ses_1" })
          expect(await port.start({ command: "bash" })).toEqual({ ok: true, ptyID: "pty_2", info: { id: "pty_2" } })
        })
      })
    })

    describe("#given the server fails", () => {
      describe("#when start is called", () => {
        test("#then ok is false and the server error is returned", async () => {
          const error = { code: "v2_http_error", message: "nope" }
          const api = fakeServerApi({ createTerminal: () => ({ ok: false, status: 500, data: null, error }) })
          const port = createPersistentTerminalPort({ serverApi: api, sessionID: "ses_1" })
          expect(await port.start({ command: "bash" })).toEqual({ ok: false, error })
        })
      })
    })
  })

  describe("list", () => {
    describe("#given the server nests the terminal array under data.data", () => {
      describe("#when list is called", () => {
        test("#then the nested array is returned", async () => {
          const api = fakeServerApi({ listTerminals: () => ({ ok: true, status: 200, data: { data: [{ id: "a" }] }, error: null }) })
          const port = createPersistentTerminalPort({ serverApi: api, sessionID: "ses_1" })
          expect(await port.list()).toEqual({ ok: true, terminals: [{ id: "a" }], error: null })
          expect(api.calls.listTerminals[0]).toEqual({ sessionID: "ses_1" })
        })
      })
    })

    describe("#given the server returns a bare array", () => {
      describe("#when list is called", () => {
        test("#then the bare array is returned", async () => {
          const api = fakeServerApi({ listTerminals: () => ({ ok: true, status: 200, data: [{ id: "b" }], error: null }) })
          const port = createPersistentTerminalPort({ serverApi: api, sessionID: "ses_1" })
          expect(await port.list()).toEqual({ ok: true, terminals: [{ id: "b" }], error: null })
        })
      })
    })

    describe("#given a failed list", () => {
      describe("#when list is called", () => {
        test("#then ok is false with an empty terminal array", async () => {
          const error = { code: "v2_http_error", message: "down" }
          const api = fakeServerApi({ listTerminals: () => ({ ok: false, status: 500, data: null, error }) })
          const port = createPersistentTerminalPort({ serverApi: api, sessionID: "ses_1" })
          expect(await port.list()).toEqual({ ok: false, terminals: [], error })
        })
      })
    })
  })

  describe("snapshot", () => {
    describe("#given the server nests text and info under data.data", () => {
      describe("#when snapshot is called", () => {
        test("#then text and info are extracted", async () => {
          const api = fakeServerApi({
            snapshotTerminal: () => ({ ok: true, status: 200, data: { data: { info: { status: "running" }, text: "hello" } }, error: null }),
          })
          const port = createPersistentTerminalPort({ serverApi: api, sessionID: "ses_1" })
          expect(await port.snapshot({ ptyID: "pty_1" })).toEqual({ ok: true, text: "hello", info: { status: "running" }, error: null })
          expect(api.calls.snapshotTerminal[0]).toEqual({ ptyID: "pty_1" })
        })
      })
    })

    describe("#given the server returns text and info at data directly", () => {
      describe("#when snapshot is called", () => {
        test("#then text and info are still extracted", async () => {
          const api = fakeServerApi({
            snapshotTerminal: () => ({ ok: true, status: 200, data: { info: { status: "exited" }, text: "bye" }, error: null }),
          })
          const port = createPersistentTerminalPort({ serverApi: api, sessionID: "ses_1" })
          expect(await port.snapshot({ ptyID: "pty_1" })).toEqual({ ok: true, text: "bye", info: { status: "exited" }, error: null })
        })
      })
    })

    describe("#given a snapshot with no text", () => {
      describe("#when snapshot is called", () => {
        test("#then text defaults to an empty string", async () => {
          const api = fakeServerApi({
            snapshotTerminal: () => ({ ok: true, status: 200, data: { data: { info: { status: "running" } } }, error: null }),
          })
          const port = createPersistentTerminalPort({ serverApi: api, sessionID: "ses_1" })
          expect(await port.snapshot({ ptyID: "pty_1" })).toEqual({ ok: true, text: "", info: { status: "running" }, error: null })
        })
      })
    })
  })

  describe("remove", () => {
    describe("#given a successful deletion", () => {
      describe("#when remove is called", () => {
        test("#then ok is true with no error", async () => {
          const api = fakeServerApi()
          const port = createPersistentTerminalPort({ serverApi: api, sessionID: "ses_1" })
          expect(await port.remove({ ptyID: "pty_9" })).toEqual({ ok: true, error: null })
          expect(api.calls.removeTerminal[0]).toEqual({ ptyID: "pty_9" })
        })
      })
    })
  })

  describe("write", () => {
    describe("#given a connect ticket and an open socket", () => {
      describe("#when write is called", () => {
        test("#then the token POST, the WS query and the framed bytes are correct", async () => {
          const api = fakeServerApi({
            raw: () => ({ ok: true, status: 200, data: { data: { ticket: "ticket-123" } }, error: null }),
          })
          const { record, factory } = recordingSocket()
          const port = createPersistentTerminalPort({ serverApi: api, sessionID: "ses_1", closeGraceMs: 0, openSocket: factory })

          const result = await port.write({ ptyID: "pty_abc", data: "echo hi\n", cols: 100, rows: 40 })

          expect(result).toEqual({ ok: true })
          expect(api.calls.raw[0]).toEqual({
            method: "POST",
            path: "/api/experimental/persistent-pty/pty_abc/connect-token",
            init: { headers: { "x-opencode-ticket": "1" } },
          })
          const parsed = new URL(record.url)
          expect(parsed.protocol).toBe("ws:")
          expect(parsed.pathname).toBe("/api/experimental/persistent-pty/pty_abc/connect")
          expect(parsed.searchParams.get("ticket")).toBe("ticket-123")
          expect(parsed.searchParams.get("role")).toBe("controller")
          expect(parsed.searchParams.get("takeover")).toBe("true")
          expect(parsed.searchParams.get("input_protocol")).toBe("1")
          expect(record.sent).toHaveLength(1)
          expect([...record.sent[0].subarray(0, 5)]).toEqual([1, 0, 100, 0, 40])
          expect(record.sent[0].subarray(5).toString("utf8")).toBe("echo hi\n")
          expect(record.closed).toBe(true)
        })
      })
    })

    describe("#given a ticket nested one level deeper", () => {
      describe("#when write is called", () => {
        test("#then a bare ticket under data is still accepted", async () => {
          const api = fakeServerApi({ raw: () => ({ ok: true, status: 200, data: { ticket: "bare-ticket" }, error: null }) })
          const { record, factory } = recordingSocket()
          const port = createPersistentTerminalPort({ serverApi: api, sessionID: "ses_1", closeGraceMs: 0, openSocket: factory })
          const result = await port.write({ ptyID: "pty_abc", data: "x" })
          expect(result).toEqual({ ok: true })
          expect(new URL(record.url).searchParams.get("ticket")).toBe("bare-ticket")
        })
      })
    })

    describe("#given no ticket is issued", () => {
      describe("#when write is called", () => {
        test("#then ok is false and the socket is never opened", async () => {
          const api = fakeServerApi({ raw: () => ({ ok: true, status: 200, data: { data: {} }, error: null }) })
          let opened = 0
          const port = createPersistentTerminalPort({
            serverApi: api,
            sessionID: "ses_1", closeGraceMs: 0,
            openSocket: () => {
              opened += 1
              throw new Error("must not open")
            },
          })
          const result = await port.write({ ptyID: "pty_abc", data: "x" })
          expect(result.ok).toBe(false)
          expect(result.error.code).toBe("v2_terminal_write_error")
          expect(opened).toBe(0)
        })
      })
    })

    describe("#given the connect-token request fails", () => {
      describe("#when write is called", () => {
        test("#then the transport error is surfaced", async () => {
          const error = { code: "v2_http_error", message: "down" }
          const api = fakeServerApi({ raw: () => ({ ok: false, status: null, data: null, error }) })
          const port = createPersistentTerminalPort({ serverApi: api, sessionID: "ses_1", closeGraceMs: 0, openSocket: () => { throw new Error("must not open") } })
          expect(await port.write({ ptyID: "pty_abc", data: "x" })).toEqual({ ok: false, error })
        })
      })
    })

    describe("#given the socket factory fails with a message that quotes the ticket-bearing URL", () => {
      describe("#when write is called", () => {
        test("#then the returned error never carries the ticket", async () => {
          const api = fakeServerApi({ raw: () => ({ ok: true, status: 200, data: { data: { ticket: "secret-ticket-value" } }, error: null }) })
          const port = createPersistentTerminalPort({
            serverApi: api,
            sessionID: "ses_1",
            closeGraceMs: 0,
            openSocket: (url) => { throw new Error(`Invalid URL: ${url}`) },
          })
          const result = await port.write({ ptyID: "pty_abc", data: "x" })
          expect(result.ok).toBe(false)
          expect(result.error.code).toBe("v2_terminal_write_error")
          expect(result.error.message).not.toContain("secret-ticket-value")
        })
      })
    })

    describe("#given the socket emits an error", () => {
      describe("#when write is called", () => {
        test("#then it resolves with the write-error code, never rejects", async () => {
          const api = fakeServerApi({ raw: () => ({ ok: true, status: 200, data: { ticket: "t" }, error: null }) })
          const { factory } = recordingSocket({ fire: "error", errorMessage: "boom" })
          const port = createPersistentTerminalPort({ serverApi: api, sessionID: "ses_1", closeGraceMs: 0, openSocket: factory })
          const result = await port.write({ ptyID: "pty_abc", data: "x" })
          expect(result.ok).toBe(false)
          expect(result.error.code).toBe("v2_terminal_write_error")
          expect(result.error.message).toBe("boom")
        })
      })
    })
  })
})
