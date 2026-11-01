import { describe, expect, test } from "bun:test"
import {
  MAX_WEBFETCH_REDIRECTS,
  MAX_WEBFETCH_RESPONSE_BYTES,
  createNativeWebFetchRedirectGuard,
  createPermissionedWebFetchExecutor,
  updateNativeWebFetchDefinition,
} from "./rigel-v2-native-webfetch-redirect-guard.mjs"

const initialUrl = "https://allowed.example/start"
const toolContext = {
  sessionID: "ses_webfetch",
  agent: "librarian",
  messageID: "msg_webfetch",
  id: "call_webfetch",
}

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers })
}

function permissionHarness({ denied = new Set() } = {}) {
  const permissionCalls = []
  return {
    permission: {
      async assert(input) {
        permissionCalls.push(input)
        if (denied.has(input.resources[0])) throw new Error(`permission denied: ${input.resources[0]}`)
      },
    },
    permissionCalls,
  }
}

describe("Rigel native V2 webfetch redirect guard", () => {
  test("updates the existing native definition without changing identity or schema", () => {
    const originalExecute = async () => ({ content: "native" })
    const definition = {
      name: "webfetch",
      description: "native description",
      input: { native: "schema" },
      output: { native: "output" },
      options: { codemode: false },
      execute: originalExecute,
    }
    const updates = []
    const editor = {
      get(name) { return name === "webfetch" ? definition : undefined },
      update(name, apply) {
        updates.push(name)
        apply(definition)
      },
    }

    expect(updateNativeWebFetchDefinition(editor, { permission: permissionHarness().permission })).toBe(true)
    expect(updates).toEqual(["webfetch"])
    expect(definition.name).toBe("webfetch")
    expect(definition.description).toBe("native description")
    expect(definition.input).toEqual({ native: "schema" })
    expect(definition.output).toEqual({ native: "output" })
    expect(definition.options).toEqual({ codemode: false })
    expect(definition.execute).not.toBe(originalExecute)
  })

  test("checks the initial URL and denied redirect before requesting the denied target", async () => {
    const deniedUrl = "https://denied.example/secret"
    const { permission, permissionCalls } = permissionHarness({ denied: new Set([deniedUrl]) })
    const requests = []
    const execute = createPermissionedWebFetchExecutor({
      permission,
      fetch: async (url) => {
        requests.push(url)
        return response("redirect", { status: 302, headers: { Location: deniedUrl } })
      },
    })

    await expect(execute({ url: initialUrl, format: "markdown" }, toolContext)).rejects.toThrow("permission denied")
    expect(permissionCalls.map((call) => call.resources[0])).toEqual([initialUrl, deniedUrl])
    expect(requests).toEqual([initialUrl])
  })

  test("allows a relative redirect and checks every resolved URL before its request", async () => {
    const { permission, permissionCalls } = permissionHarness()
    const requests = []
    const execute = createPermissionedWebFetchExecutor({
      permission,
      fetch: async (url, init) => {
        requests.push({ url, init })
        if (url === initialUrl) return response("redirect", { status: 302, headers: { Location: "/docs/final" } })
        return response("<h1>Allowed</h1>", { headers: { "content-type": "text/html" } })
      },
    })

    const result = await execute({ url: initialUrl, format: "markdown" }, toolContext)

    expect(requests.map(({ url }) => url)).toEqual([initialUrl, "https://allowed.example/docs/final"])
    expect(permissionCalls.map((call) => call.resources[0])).toEqual(requests.map(({ url }) => url))
    expect(requests[0].init.redirect).toBe("manual")
    expect(requests[0].init.headers.Accept).toContain("text/markdown")
    expect(result.output).toEqual({
      url: initialUrl,
      contentType: "text/html",
      format: "markdown",
      output: "# Allowed",
    })
    expect(result.content).toBe("# Allowed")
  })

  test("matches native Cloudflare challenge retry while keeping redirects guarded", async () => {
    const { permission, permissionCalls } = permissionHarness()
    const calls = []
    const execute = createPermissionedWebFetchExecutor({
      permission,
      fetch: async (url, init) => {
        calls.push({ url, userAgent: init.headers["User-Agent"] })
        if (calls.length === 1) {
          return response("challenge", {
            status: 403,
            headers: { "cf-mitigated": "challenge", "content-type": "text/plain" },
          })
        }
        return response("page", { headers: { "content-type": "text/plain" } })
      },
    })

    const result = await execute({ url: initialUrl, format: "text" }, toolContext)

    expect(calls.map(({ url }) => url)).toEqual([initialUrl, initialUrl])
    expect(calls[0].userAgent).toContain("OpenCode-User/1.0")
    expect(calls[1].userAgent).toBe("opencode")
    expect(permissionCalls.map((call) => call.resources[0])).toEqual([initialUrl, initialUrl])
    expect(result.output.output).toBe("page")
  })

  test("fails closed at the ten-redirect cap without requesting the eleventh target", async () => {
    const { permission, permissionCalls } = permissionHarness()
    const requests = []
    const execute = createPermissionedWebFetchExecutor({
      permission,
      fetch: async (url) => {
        requests.push(url)
        const hop = Number(new URL(url).pathname.slice(2))
        return response("redirect", { status: 302, headers: { Location: `/r${hop + 1}` } })
      },
    })

    await expect(execute({ url: "https://allowed.example/r0" }, toolContext)).rejects.toThrow("too many redirects")
    expect(requests).toHaveLength(MAX_WEBFETCH_REDIRECTS + 1)
    expect(permissionCalls).toHaveLength(MAX_WEBFETCH_REDIRECTS + 1)
    expect(requests.at(-1)).toBe("https://allowed.example/r10")
  })

  test("fails closed for a malformed or non-HTTP redirect target", async () => {
    const { permission, permissionCalls } = permissionHarness()
    const requests = []
    const execute = createPermissionedWebFetchExecutor({
      permission,
      fetch: async (url) => {
        requests.push(url)
        return response("redirect", { status: 301, headers: { Location: "file:///etc/passwd" } })
      },
    })

    await expect(execute({ url: initialUrl }, toolContext)).rejects.toThrow("http:// or https://")
    expect(requests).toEqual([initialUrl])
    expect(permissionCalls.map((call) => call.resources[0])).toEqual([initialUrl])
  })

  test("forwards external abort and never issues a later redirect request", async () => {
    const external = new AbortController()
    const { permission, permissionCalls } = permissionHarness()
    const requests = []
    const execute = createPermissionedWebFetchExecutor({
      permission,
      fetch: async (url, init) => {
        requests.push(url)
        return await new Promise((resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")), { once: true })
          external.abort(new Error("caller aborted"))
        })
      },
    })

    await expect(execute({ url: initialUrl, timeout: 120 }, { ...toolContext, signal: external.signal })).rejects.toThrow("aborted")
    expect(requests).toEqual([initialUrl])
    expect(permissionCalls).toHaveLength(1)
  })

  test("does not charge initial permission approval against the request timeout", async () => {
    const { permission } = permissionHarness()
    permission.assert = async () => await new Promise((resolve) => setTimeout(resolve, 1_100))
    const requests = []
    const execute = createPermissionedWebFetchExecutor({
      permission,
      fetch: async (url, init) => {
        requests.push({ url, aborted: init.signal.aborted })
        return response("approved")
      },
    })

    const result = await execute({ url: initialUrl, timeout: 1, format: "text" }, toolContext)

    expect(requests).toEqual([{ url: initialUrl, aborted: false }])
    expect(result.output.output).toBe("approved")
  })

  test("does not charge redirect permission approval against the shared request timeout", async () => {
    const { permission } = permissionHarness()
    const requests = []
    permission.assert = async ({ resources }) => {
      if (resources[0] !== initialUrl) await new Promise((resolve) => setTimeout(resolve, 1_100))
    }
    const execute = createPermissionedWebFetchExecutor({
      permission,
      fetch: async (url, init) => {
        requests.push({ url, aborted: init.signal.aborted })
        if (url === initialUrl) return response("redirect", { status: 302, headers: { Location: "/final" } })
        return response("approved redirect")
      },
    })

    const result = await execute({ url: initialUrl, timeout: 1, format: "text" }, toolContext)

    expect(requests).toEqual([
      { url: initialUrl, aborted: false },
      { url: "https://allowed.example/final", aborted: false },
    ])
    expect(result.output.output).toBe("approved redirect")
  })

  test("does not issue a request if the caller aborts while permission is pending", async () => {
    const external = new AbortController()
    const { permission } = permissionHarness()
    let approve
    permission.assert = async () => await new Promise((resolve) => { approve = resolve })
    const requests = []
    const execute = createPermissionedWebFetchExecutor({
      permission,
      fetch: async (url) => {
        requests.push(url)
        return response("must not be fetched")
      },
    })

    const pending = execute({ url: initialUrl, timeout: 1, format: "text" }, { ...toolContext, signal: external.signal })
    await new Promise((resolve) => setImmediate(resolve))
    external.abort(new Error("caller aborted while approval was pending"))
    approve()

    await expect(pending).rejects.toThrow("Request aborted")
    expect(requests).toEqual([])
  })

  test("releases a pending permission wait when the caller aborts", async () => {
    const external = new AbortController()
    const { permission } = permissionHarness()
    let permissionStarted
    const started = new Promise((resolve) => { permissionStarted = resolve })
    permission.assert = async () => {
      permissionStarted()
      await new Promise(() => {})
    }
    const requests = []
    const execute = createPermissionedWebFetchExecutor({
      permission,
      fetch: async (url) => {
        requests.push(url)
        return response("must not be fetched")
      },
    })

    const pending = execute({ url: initialUrl, timeout: 1, format: "text" }, { ...toolContext, signal: external.signal })
    await started
    external.abort(new Error("caller aborted while approval was pending"))
    const outcome = await Promise.race([
      pending.then(() => "resolved", () => "rejected"),
      new Promise((resolve) => setTimeout(() => resolve("still pending"), 50)),
    ])

    expect(outcome).toBe("rejected")
    expect(requests).toEqual([])
  })

  test("enforces the requested timeout when the request does not settle", async () => {
    const { permission } = permissionHarness()
    const execute = createPermissionedWebFetchExecutor({
      permission,
      fetch: async (_url, init) => await new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")), { once: true })
      }),
    })

    await expect(execute({ url: initialUrl, timeout: 0.001 }, toolContext)).rejects.toThrow("timed out")
  })

  test("rejects a response above the native five MiB limit before converting it", async () => {
    const { permission } = permissionHarness()
    const execute = createPermissionedWebFetchExecutor({
      permission,
      fetch: async () => response("x", { headers: { "content-length": String(MAX_WEBFETCH_RESPONSE_BYTES + 1) } }),
    })

    await expect(execute({ url: initialUrl }, toolContext)).rejects.toThrow("Response too large")
  })

  test("preserves native format behavior for text, html, and markdown", async () => {
    const { permission } = permissionHarness()
    const seenAccept = []
    const execute = createPermissionedWebFetchExecutor({
      permission,
      fetch: async (_url, init) => {
        seenAccept.push(init.headers.Accept)
        return response("<p>Hello <strong>world</strong></p>", { headers: { "content-type": "text/html; charset=utf-8" } })
      },
    })

    const text = await execute({ url: initialUrl, format: "text" }, toolContext)
    const html = await execute({ url: initialUrl, format: "html" }, toolContext)
    const markdown = await execute({ url: initialUrl, format: "markdown" }, toolContext)

    expect(text.output.output).toBe("Hello world")
    expect(html.output.output).toContain("<strong>world</strong>")
    expect(markdown.output.output).toBe("Hello **world**")
    expect(seenAccept[0]).toContain("text/plain")
    expect(seenAccept[1]).toContain("text/html")
    expect(seenAccept[2]).toContain("text/markdown")
  })

  test("matches native HTML parser behavior for nested markup, entities, lists, and script omission", async () => {
    const html = "<!doctype html><article><h2>Heading &amp; title</h2><p>intro <strong>bold <em>nested</em></strong> <a href=\"/docs\">link</a>.</p><ul><li>alpha</li><li><code>beta()</code></li></ul><script>bad</script></article>"
    const { permission } = permissionHarness()
    const execute = createPermissionedWebFetchExecutor({
      permission,
      fetch: async () => response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
    })

    const markdown = await execute({ url: initialUrl, format: "markdown" }, toolContext)
    const text = await execute({ url: initialUrl, format: "text" }, toolContext)

    expect(markdown.output.output).toBe("## Heading & title\n\nintro **bold *nested*** [link](/docs).\n\n- alpha\n\n- `beta()`")
    expect(text.output.output).toBe("Heading & titleintro bold nested link.alphabeta()")
    expect(markdown.output.output).not.toContain("bad")
  })

  test("normalizes the actual OpenCode V2 error.message field", async () => {
    const guard = createNativeWebFetchRedirectGuard()
    const event = {
      status: "error",
      tool: "webfetch",
      sessionID: "ses_error_object",
      error: { name: "ToolError", message: "WebFetch failed: redirected too many times" },
    }

    await guard.after(event)

    expect(event.error.message).toBe("Error: WebFetch failed: OpenCode reported too many redirects")
  })

  test("leaves successful page text and non-webfetch errors untouched", async () => {
    const guard = createNativeWebFetchRedirectGuard()
    const success = {
      status: "completed",
      tool: "webfetch",
      result: { content: [{ type: "text", text: "This page explains too many redirects." }] },
    }
    const other = { status: "error", tool: "fetch", error: { message: "too many redirects" } }

    await guard.after(success)
    await guard.after(other)

    expect(success.result.content[0].text).toBe("This page explains too many redirects.")
    expect(other.error.message).toBe("too many redirects")
  })
})
