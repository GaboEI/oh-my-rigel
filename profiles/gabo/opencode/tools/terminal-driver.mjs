// Native OpenCode V2 persistent-terminal driver for the Rigel runtime.
//
// The V2 plugin setup context exposes no pty domain, so interactive read and
// write go through the server's own persistent-pty HTTP API (see
// `rigel-v2-native-http.mjs` for the transport). Read uses the snapshot
// endpoint; write needs a short-lived connect ticket and a WebSocket carrying
// the framed [type][cols][rows][payload] binary message the server decodes when
// `input_protocol=1`.
//
// This module is dependency-free: it consumes an injected `serverApi`, uses the
// `WebSocket` global by default, and never throws. Every public method on the
// returned port resolves to a typed `{ ok, ... }` result.

function typedError(code, message) {
  return { code, message: String(message ?? "") }
}

// A connect ticket travels in the WebSocket URL query. Platform errors may quote
// that URL, so every message that leaves this module is scrubbed of it.
function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error ?? "unknown error")
  return message.replace(/ticket=[^&\s"']*/gi, "ticket=[redacted]")
}

function clampUint16(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return 0
  return Math.min(Math.floor(number), 0xffff)
}

// Encode the WS input frame the server consumes under `input_protocol=1`:
// byte 0 = type (0 control, 1 input), bytes 1..2 = uint16BE cols, bytes 3..4 =
// uint16BE rows, bytes 5.. = payload. Minimum length is five bytes.
export function encodeInputFrame({ type = 1, cols = 80, rows = 24, payload = Buffer.alloc(0) } = {}) {
  const frameType = Number(type) === 1 ? 1 : 0
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ""), "utf8")
  const frame = Buffer.alloc(5 + bytes.length)
  frame.writeUInt8(frameType, 0)
  frame.writeUInt16BE(clampUint16(cols), 1)
  frame.writeUInt16BE(clampUint16(rows), 3)
  bytes.copy(frame, 5)
  return frame
}

// Replace the leading `http` of an origin with `ws` (https becomes wss) and
// append the connect query. All values are URL-encoded.
function buildConnectUrl(origin, ptyID, ticket) {
  const base = String(origin ?? "").replace(/^http/i, "ws")
  const query = new URLSearchParams()
  query.set("ticket", String(ticket))
  query.set("role", "controller")
  query.set("takeover", "true")
  query.set("input_protocol", "1")
  const path = `/api/experimental/persistent-pty/${encodeURIComponent(ptyID)}/connect`
  return `${base}${path}?${query.toString()}`
}

// Attach a handler across the event-registration shapes sockets expose.
function listen(socket, name, handler) {
  if (typeof socket?.addEventListener === "function") {
    socket.addEventListener(name, handler)
    return
  }
  if (typeof socket?.on === "function") {
    socket.on(name, handler)
    return
  }
  socket[`on${name}`] = handler
}

// Best-effort socket close that never propagates a failure.
function tryClose(socket) {
  if (!socket || typeof socket.close !== "function") return false
  try {
    socket.close()
    return true
  } catch {
    return false
  }
}

// The server attaches the socket asynchronously and drops an input frame that
// arrives before the attachment is ready (`if (!T) return` in the connect
// handler). The frame is therefore sent only after the server's attach control
// frame (`attached`/`replay_complete`/`controller_changed`), with a short grace
// fallback for a host that emits none. The timeout is a circuit breaker; it
// never rejects and never throws.
function isAttachFrame(data) {
  if (typeof data !== "string") return false
  return data.includes('"attached"') || data.includes('"replay_complete"') || data.includes('"controller_changed"')
}

function awaitSocket({ openSocket, url, frame, timeoutMs, closeGraceMs, end }) {
  return new Promise((resolve) => {
    let settled = false
    let socket
    let graceTimer
    let closeTimer
    const settle = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(graceTimer)
      resolve(value)
    }
    const closeNow = () => {
      clearTimeout(closeTimer)
      tryClose(socket)
    }
    const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000
    const timer = setTimeout(() => {
      closeNow()
      settle(end(typedError("v2_terminal_write_timeout", `Persistent PTY socket did not attach within ${effectiveTimeout}ms.`)))
    }, effectiveTimeout)
    const sendFrame = () => {
      if (settled) return
      try {
        socket.send(frame)
        settle({ ok: true })
        // Keep the socket open briefly so the frame flushes to the PTY before the
        // close handshake; closing immediately after `send` drops the frame.
        const grace = Number.isFinite(closeGraceMs) && closeGraceMs >= 0 ? closeGraceMs : 1000
        if (grace <= 0) closeNow()
        else closeTimer = setTimeout(closeNow, grace)
      } catch (error) {
        closeNow()
        settle(end(typedError("v2_terminal_write_error", errorMessage(error))))
      }
    }
    const factory = openSocket ?? ((socketUrl) => new WebSocket(socketUrl))
    try {
      socket = factory(url)
    } catch (error) {
      settle(end(typedError("v2_terminal_write_error", errorMessage(error))))
      return
    }
    listen(socket, "open", () => {
      // Fallback for a host that emits no distinct attach control frame.
      graceTimer = setTimeout(sendFrame, 1200)
    })
    listen(socket, "message", (event) => {
      const data = event?.data ?? event
      if (isAttachFrame(data)) sendFrame()
    })
    listen(socket, "error", (event) => {
      closeNow()
      settle(end(typedError("v2_terminal_write_error", errorMessage(event?.message ?? "Persistent PTY socket error."))))
    })
    listen(socket, "close", () => {
      settle(end(typedError("v2_terminal_write_error", "Persistent PTY socket closed before the input frame was sent.")))
    })
  })
}

export function createPersistentTerminalPort({ serverApi, sessionID, openSocket, closeGraceMs } = {}) {
  const end = (error) => ({ ok: false, error })

  async function start({ command, args = [], title, env = {}, cwd, size } = {}) {
    let result
    try {
      result = await serverApi.createTerminal(sessionID, { command, args, title, env, cwd, size })
    } catch (error) {
      return end(typedError("v2_terminal_start_error", errorMessage(error)))
    }
    if (!result?.ok) return end(result?.error)
    const info = result.data?.data ?? result.data
    return { ok: true, ptyID: info?.id, info }
  }

  async function list() {
    let result
    try {
      result = await serverApi.listTerminals(sessionID)
    } catch (error) {
      return { ok: false, terminals: [], error: typedError("v2_terminal_list_error", errorMessage(error)) }
    }
    const data = result?.data
    const terminals = data?.data ?? data ?? []
    return { ok: Boolean(result?.ok), terminals, error: result?.error ?? null }
  }

  async function snapshot({ ptyID } = {}) {
    let result
    try {
      result = await serverApi.snapshotTerminal(ptyID)
    } catch (error) {
      return { ok: false, text: "", info: undefined, error: typedError("v2_terminal_snapshot_error", errorMessage(error)) }
    }
    const data = result?.data
    const text = (data?.data?.text ?? data?.text) ?? ""
    const info = data?.data?.info ?? data?.info
    return { ok: Boolean(result?.ok), text, info, error: result?.error ?? null }
  }

  async function remove({ ptyID } = {}) {
    let result
    try {
      result = await serverApi.removeTerminal(ptyID)
    } catch (error) {
      return end(typedError("v2_terminal_remove_error", errorMessage(error)))
    }
    return { ok: Boolean(result?.ok), error: result?.error ?? null }
  }

  async function write({ ptyID, data, cols = 80, rows = 24, timeoutMs = 15000, closeGraceMs: callCloseGraceMs } = {}) {
    let result
    try {
      result = await serverApi.raw("POST", `/api/experimental/persistent-pty/${encodeURIComponent(ptyID)}/connect-token`, {
        headers: { "x-opencode-ticket": "1" },
      })
    } catch (error) {
      return end(typedError("v2_terminal_write_error", errorMessage(error)))
    }
    const ticket = result?.data?.data?.ticket ?? result?.data?.ticket
    if (!ticket) {
      return end(result?.error ?? typedError("v2_terminal_write_error", "Persistent PTY connect token was not issued."))
    }
    let url
    let frame
    try {
      url = buildConnectUrl(serverApi.origin, ptyID, ticket)
      frame = encodeInputFrame({ type: 1, cols, rows, payload: Buffer.from(String(data ?? ""), "utf8") })
    } catch (error) {
      return end(typedError("v2_terminal_write_error", errorMessage(error)))
    }
    return await awaitSocket({ openSocket, url, frame, timeoutMs, closeGraceMs: callCloseGraceMs ?? closeGraceMs, end })
  }

  return { start, list, snapshot, remove, write }
}
