// Native OpenCode V2 webfetch compatibility and redirect permission guard.
//
// The V1 resolver remains exported for the differential migration oracle. The
// V2 runtime does not call it: native webfetch follows redirects internally,
// which can request a denied redirect target before an execute.before hook gets
// a chance to help. Instead, V2 updates the native webfetch executor so every
// manually resolved hop is permission-asserted before its request.

import { convertHTMLToMarkdown, extractTextFromHTML, MAX_MARKDOWN_BYTES } from "./rigel-v2-native-webfetch-html-markdown.ts"

export const DEFAULT_WEBFETCH_TIMEOUT_MS = 30_000
export const MAX_WEBFETCH_TIMEOUT_MS = 120_000
export const MAX_WEBFETCH_REDIRECTS = 10
export const WEBFETCH_REDIRECT_GUARD_STALE_TIMEOUT_MS = 15 * 60 * 1000
export const WEBFETCH_REDIRECT_ERROR_PATTERNS = [
  /redirected too many times/i,
  /too many redirects/i,
]
export const WEBFETCH_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
export const MAX_WEBFETCH_RESPONSE_BYTES = MAX_MARKDOWN_BYTES

const WEBFETCH_FORMATS = new Set(["markdown", "text", "html"])
const WEBFETCH_USER_AGENT =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OpenCode-User/1.0; +https://opencode.ai"

function buildAcceptHeader(format) {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
    default:
      return undefined
  }
}

function buildWebFetchHeaders(format, userAgent = WEBFETCH_USER_AGENT) {
  return {
    "User-Agent": userAgent,
    Accept: buildAcceptHeader(format),
    "Accept-Language": "en-US,en;q=0.9",
  }
}

function normalizeTimeoutSeconds(timeout) {
  if (timeout === undefined) return DEFAULT_WEBFETCH_TIMEOUT_MS / 1000
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    return DEFAULT_WEBFETCH_TIMEOUT_MS / 1000
  }
  return Math.min(Math.ceil(timeout), MAX_WEBFETCH_TIMEOUT_MS / 1000)
}

function normalizeFormat(format) {
  return WEBFETCH_FORMATS.has(format) ? format : "markdown"
}

function assertHttpUrl(url) {
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("URL must use http:// or https://")
  }
  return parsed
}

function resolveRedirectLocation(currentUrl, location) {
  if (typeof location !== "string" || location.trim() === "") {
    throw new Error("Redirect response did not include a valid Location header")
  }
  const resolved = new URL(location, currentUrl)
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    throw new Error("Redirect Location must use http:// or https://")
  }
  return resolved.toString()
}

function makeAbortController(timeoutSeconds, externalSignal) {
  const controller = new AbortController()
  let timedOut = false
  let removeAbortListener = () => {}
  let timeout
  let remainingMs = timeoutSeconds * 1000
  let resumedAt

  const expire = () => {
    timedOut = true
    controller.abort(new Error("Request timed out"))
  }

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason)
    } else if (typeof externalSignal.addEventListener === "function") {
      const onAbort = () => controller.abort(externalSignal.reason)
      externalSignal.addEventListener("abort", onAbort, { once: true })
      removeAbortListener = () => externalSignal.removeEventListener("abort", onAbort)
    }
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    pause() {
      if (timeout === undefined) return
      clearTimeout(timeout)
      timeout = undefined
      remainingMs -= Date.now() - resumedAt
      resumedAt = undefined
      if (remainingMs <= 0) expire()
    },
    resume() {
      if (controller.signal.aborted || timeout !== undefined) return
      if (remainingMs <= 0) {
        expire()
        return
      }
      resumedAt = Date.now()
      timeout = setTimeout(expire, remainingMs)
    },
    dispose() {
      if (timeout !== undefined) clearTimeout(timeout)
      removeAbortListener()
    },
  }
}

async function reportProgress(toolContext, details) {
  if (typeof toolContext?.progress !== "function") return
  await toolContext.progress(details)
}

async function cancelBody(response) {
  try {
    await response?.body?.cancel?.()
  } catch {
    // The redirect response is already being discarded; cancellation failure is
    // not allowed to turn an otherwise deterministic permission decision into a
    // second request or an unhandled rejection.
  }
}

function responseStatus(response) {
  return Number.isInteger(response?.status) ? response.status : 0
}

function contentTypeOf(response) {
  return response?.headers?.get?.("content-type") ?? ""
}

function mimeFrom(contentType) {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? ""
}

function isTextualMime(mime) {
  return !mime ||
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime.endsWith("+json") ||
    mime === "application/xml" ||
    mime.endsWith("+xml") ||
    mime === "application/javascript" ||
    mime === "application/x-javascript"
}

function convert(content, contentType, format) {
  if (!contentType.toLowerCase().includes("text/html")) return content
  if (format === "markdown") return convertHTMLToMarkdown(content)
  if (format === "text") return extractTextFromHTML(content)
  return content
}

async function readResponseBody(response, signal, toolContext, url, format) {
  const contentLength = response.headers?.get?.("content-length")
  if (contentLength && Number.parseInt(contentLength, 10) > MAX_WEBFETCH_RESPONSE_BYTES) {
    await cancelBody(response)
    throw new Error(`Response too large (exceeds ${MAX_WEBFETCH_RESPONSE_BYTES} byte limit)`)
  }

  if (!response.body) {
    const text = await response.text()
    const body = new TextEncoder().encode(text)
    if (body.byteLength > MAX_WEBFETCH_RESPONSE_BYTES) {
      throw new Error(`Response too large (exceeds ${MAX_WEBFETCH_RESPONSE_BYTES} byte limit)`)
    }
    return body
  }

  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error("Request aborted")
      const next = await reader.read()
      if (next.done) break
      const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value)
      total += chunk.byteLength
      if (total > MAX_WEBFETCH_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error(`Response too large (exceeds ${MAX_WEBFETCH_RESPONSE_BYTES} byte limit)`)
      }
      chunks.push(chunk)
      await reportProgress(toolContext, { phase: "downloading", url, format, bytesRead: total })
    }
  } finally {
    reader.releaseLock?.()
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

async function assertPermission(permission, input, url, toolContext) {
  if (typeof permission?.assert !== "function") {
    throw new Error("WebFetch permission service is unavailable")
  }
  return await permission.assert({
    action: "webfetch",
    resources: [url],
    save: ["*"],
    metadata: input,
    sessionID: toolContext?.sessionID,
    agent: toolContext?.agent,
    source: {
      type: "tool",
      messageID: toolContext?.messageID,
      id: toolContext?.id,
    },
  })
}

async function assertPermissionOutsideTimeout(timeout, permission, input, url, toolContext) {
  timeout.pause()
  const permissionPromise = assertPermission(permission, input, url, toolContext)
  let removeAbortListener = () => {}
  try {
    const aborted = new Promise((_, reject) => {
      const rejectOnAbort = () => reject(timeout.signal.reason ?? new Error("Request aborted"))
      if (timeout.signal.aborted) {
        rejectOnAbort()
        return
      }
      timeout.signal.addEventListener("abort", rejectOnAbort, { once: true })
      removeAbortListener = () => timeout.signal.removeEventListener("abort", rejectOnAbort)
    })
    await Promise.race([permissionPromise, aborted])
  } finally {
    removeAbortListener()
  }
  if (timeout.signal.aborted) {
    throw timeout.signal.reason ?? new Error("Request aborted")
  }
  timeout.resume()
  if (timeout.signal.aborted) {
    throw timeout.signal.reason ?? new Error("Request aborted")
  }
}

/** Execute native webfetch with permission checked before every HTTP hop. */
export function createPermissionedWebFetchExecutor({ permission, fetch: fetchImpl = globalThis.fetch } = {}) {
  return async (input, toolContext = {}) => {
    const format = normalizeFormat(input?.format)
    const timeoutSeconds = normalizeTimeoutSeconds(input?.timeout)
    const originalUrl = input?.url
    assertHttpUrl(originalUrl)
    const initialUrl = originalUrl
    const timeout = makeAbortController(timeoutSeconds, toolContext?.signal ?? toolContext?.abortSignal)
    let currentUrl = initialUrl
    let redirectCount = 0

    try {
      await reportProgress(toolContext, { phase: "fetching", url: originalUrl, format, timeoutSeconds })
      while (true) {
        await assertPermissionOutsideTimeout(timeout, permission, input, currentUrl, toolContext)
        let response = await fetchImpl(currentUrl, {
          method: "GET",
          headers: buildWebFetchHeaders(format),
          redirect: "manual",
          signal: timeout.signal,
        })
        const isCloudflareChallenge = response.status === 403 &&
          response.headers?.get?.("cf-mitigated") === "challenge"
        if (isCloudflareChallenge) {
          await cancelBody(response)
          await assertPermissionOutsideTimeout(timeout, permission, input, currentUrl, toolContext)
          response = await fetchImpl(currentUrl, {
            method: "GET",
            headers: buildWebFetchHeaders(format, "opencode"),
            redirect: "manual",
            signal: timeout.signal,
          })
        }
        const status = responseStatus(response)
        if (WEBFETCH_REDIRECT_STATUSES.has(status)) {
          const location = response.headers?.get?.("location")
          if (redirectCount >= MAX_WEBFETCH_REDIRECTS) {
            await cancelBody(response)
            throw new Error("OpenCode reported too many redirects")
          }
          let nextUrl
          try {
            nextUrl = resolveRedirectLocation(currentUrl, location)
          } catch (error) {
            await cancelBody(response)
            throw error
          }
          await cancelBody(response)
          currentUrl = nextUrl
          redirectCount += 1
          continue
        }
        if (!response.ok && !(status >= 200 && status < 300)) {
          await cancelBody(response)
          throw new Error(`HTTP ${status}`)
        }

        const contentType = contentTypeOf(response)
        const mime = mimeFrom(contentType)
        if (mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet") {
          await cancelBody(response)
          throw new Error(`Unsupported fetched image content type: ${mime}`)
        }
        if (!isTextualMime(mime)) {
          await cancelBody(response)
          throw new Error(`Unsupported fetched file content type: ${mime}`)
        }

        const body = await readResponseBody(response, timeout.signal, toolContext, originalUrl, format)
        const raw = new TextDecoder().decode(body)
        await reportProgress(toolContext, { phase: "converting", url: originalUrl, format, bytesRead: body.byteLength })
        const output = convert(raw, contentType, format)
        const result = { url: originalUrl, contentType, format, output }
        return { output: result, content: result.output, metadata: { contentType: result.contentType } }
      }
    } catch (error) {
      if (timeout.timedOut()) throw new Error("Request timed out", { cause: error })
      if (timeout.signal.aborted) throw new Error("Request aborted", { cause: error })
      throw error
    } finally {
      timeout.dispose()
    }
  }
}

/** Update the host's existing native definition without changing its identity/schema. */
export function updateNativeWebFetchDefinition(editor, { permission, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (typeof editor?.get !== "function" || typeof editor?.update !== "function") return false
  const existing = editor.get("webfetch")
  if (!existing || typeof existing.execute !== "function") return false
  editor.update("webfetch", (tool) => {
    tool.execute = createPermissionedWebFetchExecutor({ permission, fetch: fetchImpl })
  })
  return true
}

export async function resolveWebFetchRedirects({
  url,
  format = "markdown",
  timeoutSeconds,
  fetch: fetchImpl = globalThis.fetch,
}) {
  const timeoutMs = normalizeTimeoutMs(timeoutSeconds)
  const signal = AbortSignal.timeout(timeoutMs)
  const headers = buildLegacyWebFetchHeaders(format)

  let currentUrl = url
  let redirectCount = 0

  while (true) {
    const response = await fetchImpl(currentUrl, { headers, redirect: "manual", signal })
    if (!WEBFETCH_REDIRECT_STATUSES.has(response.status)) return { type: "resolved", url: currentUrl }
    const location = response.headers.get("location")
    if (!location) return { type: "resolved", url: currentUrl }
    if (redirectCount >= MAX_WEBFETCH_REDIRECTS) return { type: "exceeded", url, maxRedirects: MAX_WEBFETCH_REDIRECTS }
    currentUrl = new URL(location, currentUrl).toString()
    redirectCount += 1
  }
}

function normalizeTimeoutMs(timeoutSeconds) {
  if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return DEFAULT_WEBFETCH_TIMEOUT_MS
  }
  return Math.min(timeoutSeconds * 1000, MAX_WEBFETCH_TIMEOUT_MS)
}

function buildLegacyWebFetchHeaders(format) {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    Accept: buildAcceptHeader(format),
    "Accept-Language": "en-US,en;q=0.9",
  }
}

function isRedirectLoopError(text) {
  return WEBFETCH_REDIRECT_ERROR_PATTERNS.some((pattern) => pattern.test(text))
}

function buildRedirectErrorMessage() {
  return "Error: WebFetch failed: OpenCode reported too many redirects"
}

function writeIfMutable(target, key, value) {
  if (!target || typeof target !== "object" || Object.isFrozen(target)) return false
  try {
    target[key] = value
    return true
  } catch {
    return false
  }
}

function textParts(target, key) {
  const content = target?.[key]
  if (typeof content === "string") return [{ read: () => target[key], write: (value) => writeIfMutable(target, key, value) }]
  if (!Array.isArray(content)) return []
  return content
    .filter((part) => part && typeof part === "object" && typeof part.text === "string")
    .map((part) => ({ read: () => part.text, write: (value) => writeIfMutable(part, "text", value) }))
}

function findResultText(event) {
  const candidates = []
  const addString = (target, key) => {
    if (typeof target?.[key] === "string") candidates.push({ read: () => target[key], write: (value) => writeIfMutable(target, key, value) })
  }
  const addError = (target, key) => {
    const error = target?.[key]
    if (typeof error === "string") candidates.push({ read: () => target[key], write: (value) => writeIfMutable(target, key, value) })
    else if (error && typeof error === "object" && typeof error.message === "string") candidates.push({ read: () => error.message, write: (value) => writeIfMutable(error, "message", value) })
  }
  addError(event, "error")
  addError(event?.result, "error")
  addString(event?.result, "output")
  candidates.push(...textParts(event?.result, "content"))
  addString(event, "output")
  candidates.push(...textParts(event?.output, "content"))
  candidates.push(...textParts(event, "content"))
  addString(event, "result")
  return candidates
}

/** Normalize redirect-loop failures after OpenCode's own webfetch execution. */
export function createNativeWebFetchRedirectGuard(_deps = {}) {
  return {
    async after(event) {
      if (String(event?.tool ?? "").toLowerCase() !== "webfetch") return
      const failure = findResultText(event).find(({ read }) => {
        const current = read()
        if (typeof current !== "string" || !current) return false
        const failed = event?.status === "error" || (event?.status !== "completed" && current.trimStart().toLowerCase().startsWith("error:"))
        return failed && isRedirectLoopError(current)
      })
      if (failure) failure.write(buildRedirectErrorMessage())
    },
  }
}
