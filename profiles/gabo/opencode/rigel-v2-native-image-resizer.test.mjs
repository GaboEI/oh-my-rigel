import { describe, expect, test } from "bun:test"
import { parseImageDimensions as v1ParseImageDimensions } from "../../../packages/omo-opencode/src/hooks/read-image-resizer/image-dimensions.ts"
import { calculateTargetDimensions as v1CalculateTargetDimensions } from "../../../packages/omo-opencode/src/hooks/read-image-resizer/image-resizer.ts"
import {
  ANTHROPIC_MAX_FILE_SIZE,
  ANTHROPIC_MAX_LONG_EDGE,
  DEFAULT_RESIZER_PROVIDERS,
  HEADER_BASE64_CHARS,
  HEADER_BYTES,
  calculateTargetDimensions,
  extractBase64Data,
  isResizerProvider,
  isWithinFileSizeLimit,
  parseImageDimensions,
  resizeImageDataUrl,
  resolveResizerFormat,
  resolveResizerProviders,
} from "./rigel-v2-native-image-resizer.mjs"
import { createImageResizerStep } from "./rigel-v2-native-request-steps.mjs"

// The native V2 runtime cannot import `packages/` TypeScript, so the resizer
// decisions are a plain-JS port of the real owners:
//   packages/omo-opencode/src/hooks/read-image-resizer/image-dimensions.ts
//   packages/omo-opencode/src/hooks/read-image-resizer/image-resizer.ts
// The differential block imports the real TS and pins agreement, so an upstream
// parser or threshold edit not mirrored here fails the suite.

const PNG_1X1_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

const GIF_1X1_DATA_URL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"

function createPngDataUrl(width, height) {
  const buf = Buffer.alloc(33)
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  buf.writeUInt32BE(13, 8)
  buf.set([0x49, 0x48, 0x44, 0x52], 12)
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return `data:image/png;base64,${buf.toString("base64")}`
}

function createLargePngDataUrl(width, height, extraBase64Chars) {
  const base64Data = createPngDataUrl(width, height).split(",")[1]
  return `data:image/png;base64,${base64Data}${"A".repeat(extraBase64Chars)}`
}

function createGifDataUrl(width, height) {
  const buf = Buffer.alloc(10)
  buf.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0)
  buf.writeUInt16LE(width, 6)
  buf.writeUInt16LE(height, 8)
  return `data:image/gif;base64,${buf.toString("base64")}`
}

function createJpegDataUrl(width, height) {
  const buf = Buffer.alloc(30)
  buf.set([0xff, 0xd8], 0)
  buf.set([0xff, 0xe0], 2)
  buf.writeUInt16BE(16, 4)
  buf.set([0xff, 0xc0], 20)
  buf.writeUInt16BE(17, 22)
  buf[24] = 8
  buf.writeUInt16BE(height, 25)
  buf.writeUInt16BE(width, 27)
  return `data:image/jpeg;base64,${buf.toString("base64")}`
}

function createSoiOnlyJpegDataUrl() {
  const buf = Buffer.alloc(4)
  buf.set([0xff, 0xd8, 0xff, 0xd9], 0)
  return `data:image/jpeg;base64,${buf.toString("base64")}`
}

function createVp8WebpDataUrl(width, height) {
  const buf = Buffer.alloc(30)
  buf.write("RIFF", 0, "ascii")
  buf.write("WEBP", 8, "ascii")
  buf.write("VP8 ", 12, "ascii")
  buf.set([0x9d, 0x01, 0x2a], 23)
  buf.writeUInt16LE(width, 26)
  buf.writeUInt16LE(height, 28)
  return `data:image/webp;base64,${buf.toString("base64")}`
}

function createVp8lWebpDataUrl(width, height) {
  const buf = Buffer.alloc(25)
  buf.write("RIFF", 0, "ascii")
  buf.write("WEBP", 8, "ascii")
  buf.write("VP8L", 12, "ascii")
  buf[20] = 0x2f
  const bits = (width - 1) | ((height - 1) << 14)
  buf.writeUInt32LE(bits >>> 0, 21)
  return `data:image/webp;base64,${buf.toString("base64")}`
}

function createVp8xWebpDataUrl(width, height) {
  const buf = Buffer.alloc(30)
  buf.write("RIFF", 0, "ascii")
  buf.write("WEBP", 8, "ascii")
  buf.write("VP8X", 12, "ascii")
  buf.writeUIntLE(width - 1, 24, 3)
  buf.writeUIntLE(height - 1, 27, 3)
  return `data:image/webp;base64,${buf.toString("base64")}`
}

function createTruncatedVp8WebpDataUrl() {
  const buf = Buffer.alloc(26)
  buf.write("RIFF", 0, "ascii")
  buf.write("WEBP", 8, "ascii")
  buf.write("VP8 ", 12, "ascii")
  buf.set([0x9d, 0x01, 0x2a], 23)
  return `data:image/webp;base64,${buf.toString("base64")}`
}

describe("parseImageDimensions", () => {
  test("parses PNG dimensions from IHDR", () => {
    // given
    const dataUrl = createPngDataUrl(3000, 2000)

    // when
    const result = parseImageDimensions(dataUrl, "image/png")

    // then
    expect(result).toEqual({ width: 3000, height: 2000 })
  })

  test("parses the real PNG 1x1 fixture", () => {
    // given / when
    const result = parseImageDimensions(PNG_1X1_DATA_URL, "image/png")

    // then
    expect(result).toEqual({ width: 1, height: 1 })
  })

  test("parses PNG dimensions from a payload far larger than the 32KB header window", () => {
    // given
    const dataUrl = createLargePngDataUrl(4096, 2160, 10 * 1024 * 1024)

    // when
    const result = parseImageDimensions(dataUrl, "image/png")

    // then
    expect(result).toEqual({ width: 4096, height: 2160 })
  })

  test("parses GIF dimensions from the logical screen descriptor", () => {
    // given
    const dataUrl = createGifDataUrl(320, 240)

    // when
    const result = parseImageDimensions(dataUrl, "image/gif")

    // then
    expect(result).toEqual({ width: 320, height: 240 })
  })

  test("parses the real GIF 1x1 fixture", () => {
    // given / when
    const result = parseImageDimensions(GIF_1X1_DATA_URL, "image/gif")

    // then
    expect(result).toEqual({ width: 1, height: 1 })
  })

  test("parses JPEG dimensions from an SOF0 segment", () => {
    // given
    const dataUrl = createJpegDataUrl(4032, 3024)

    // when
    const result = parseImageDimensions(dataUrl, "image/jpeg")

    // then
    expect(result).toEqual({ width: 4032, height: 3024 })
  })

  test("accepts the image/jpg alias", () => {
    // given
    const dataUrl = createJpegDataUrl(640, 480)

    // when
    const result = parseImageDimensions(dataUrl, "image/jpg")

    // then
    expect(result).toEqual({ width: 640, height: 480 })
  })

  test("parses WebP VP8 (lossy) dimensions", () => {
    // given
    const dataUrl = createVp8WebpDataUrl(1920, 1080)

    // when
    const result = parseImageDimensions(dataUrl, "image/webp")

    // then
    expect(result).toEqual({ width: 1920, height: 1080 })
  })

  test("parses WebP VP8L (lossless) dimensions from packed bits", () => {
    // given
    const dataUrl = createVp8lWebpDataUrl(1600, 900)

    // when
    const result = parseImageDimensions(dataUrl, "image/webp")

    // then
    expect(result).toEqual({ width: 1600, height: 900 })
  })

  test("parses WebP VP8X (extended) dimensions as 24-bit minus one", () => {
    // given
    const dataUrl = createVp8xWebpDataUrl(2000, 1500)

    // when
    const result = parseImageDimensions(dataUrl, "image/webp")

    // then
    expect(result).toEqual({ width: 2000, height: 1500 })
  })

  test("returns null for empty input", () => {
    // given / when
    const result = parseImageDimensions("", "image/png")

    // then
    expect(result).toBeNull()
  })

  test("returns null when the mime is absent", () => {
    // given / when
    const result = parseImageDimensions(PNG_1X1_DATA_URL, null)

    // then
    expect(result).toBeNull()
  })

  test("returns null for a too-short PNG buffer", () => {
    // given / when
    const result = parseImageDimensions("data:image/png;base64,AAAA", "image/png")

    // then
    expect(result).toBeNull()
  })

  test("returns null for an unsupported mime type", () => {
    // given / when
    const result = parseImageDimensions(PNG_1X1_DATA_URL, "image/heic")

    // then
    expect(result).toBeNull()
  })

  test("returns null for a JPEG with no SOF segment", () => {
    // given / when
    const result = parseImageDimensions(createSoiOnlyJpegDataUrl(), "image/jpeg")

    // then
    expect(result).toBeNull()
  })

  test("returns null when a truncated VP8 WebP cannot be read", () => {
    // given / when
    const result = parseImageDimensions(createTruncatedVp8WebpDataUrl(), "image/webp")

    // then
    expect(result).toBeNull()
  })

  test("returns null for a non-image string that fails the signature check", () => {
    // given / when
    const result = parseImageDimensions("not-a-data-url", "image/png")

    // then
    expect(result).toBeNull()
  })
})

describe("calculateTargetDimensions", () => {
  test("returns null when dimensions are already within limits", () => {
    // given / when / then
    expect(calculateTargetDimensions(800, 600)).toBeNull()
  })

  test("returns null at the exact long-edge boundary", () => {
    // given / when / then
    expect(calculateTargetDimensions(1568, 1000)).toBeNull()
    expect(calculateTargetDimensions(1000, 1568)).toBeNull()
    expect(calculateTargetDimensions(1568, 1568)).toBeNull()
  })

  test("scales one pixel over the boundary", () => {
    // given / when
    const landscape = calculateTargetDimensions(1569, 1000)
    const square = calculateTargetDimensions(1569, 1569)

    // then
    expect(landscape).toEqual({ width: 1568, height: 999 })
    expect(square).toEqual({ width: 1568, height: 1568 })
  })

  test("scales landscape dimensions to the long-edge cap", () => {
    // given / when
    const result = calculateTargetDimensions(3000, 2000)

    // then
    expect(result).toEqual({ width: 1568, height: 1045 })
  })

  test("scales portrait dimensions to the long-edge cap", () => {
    // given / when
    const result = calculateTargetDimensions(2000, 3000)

    // then
    expect(result).toEqual({ width: 1045, height: 1568 })
  })

  test("scales square dimensions to the exact target", () => {
    // given / when
    const result = calculateTargetDimensions(4000, 4000)

    // then
    expect(result).toEqual({ width: 1568, height: 1568 })
  })

  test("uses a custom maxLongEdge when provided", () => {
    // given / when
    const result = calculateTargetDimensions(2000, 1000, 1000)

    // then
    expect(result).toEqual({ width: 1000, height: 500 })
  })

  test("never floors the short edge below one", () => {
    // given / when
    const wide = calculateTargetDimensions(3000, 1)
    const tall = calculateTargetDimensions(1, 3000)

    // then
    expect(wide).toEqual({ width: 1568, height: 1 })
    expect(tall).toEqual({ width: 1, height: 1568 })
  })

  test("returns null for non-positive inputs", () => {
    // given / when / then
    expect(calculateTargetDimensions(0, 100)).toBeNull()
    expect(calculateTargetDimensions(100, 0)).toBeNull()
    expect(calculateTargetDimensions(-1, 100)).toBeNull()
    expect(calculateTargetDimensions(100, 100, 0)).toBeNull()
  })
})

describe("isWithinFileSizeLimit", () => {
  test("accepts the exact 5MB boundary", () => {
    // given
    const fiveMegabytes = 5 * 1024 * 1024

    // when / then
    expect(isWithinFileSizeLimit(fiveMegabytes)).toBe(true)
    expect(isWithinFileSizeLimit(fiveMegabytes + 1)).toBe(false)
  })

  test("treats zero and non-finite byte lengths as expected", () => {
    // given / when / then
    expect(isWithinFileSizeLimit(0)).toBe(true)
    expect(isWithinFileSizeLimit(-1)).toBe(false)
    expect(isWithinFileSizeLimit(Number.NaN)).toBe(false)
    expect(isWithinFileSizeLimit("1024")).toBe(false)
  })

  test("honors a custom cap", () => {
    // given / when / then
    expect(isWithinFileSizeLimit(1024, 1024)).toBe(true)
    expect(isWithinFileSizeLimit(1025, 1024)).toBe(false)
  })
})

describe("exported thresholds", () => {
  test("exposes the Anthropic limits and the 32KB header window", () => {
    // given / when / then
    expect(ANTHROPIC_MAX_LONG_EDGE).toBe(1568)
    expect(ANTHROPIC_MAX_FILE_SIZE).toBe(5 * 1024 * 1024)
    expect(HEADER_BYTES).toBe(32_768)
    expect(HEADER_BASE64_CHARS).toBe(Math.ceil(HEADER_BYTES / 3) * 4)
  })

  test("extractBase64Data strips the data URL prefix and tolerates plain input", () => {
    // given / when / then
    expect(extractBase64Data("data:image/png;base64,QUJD")).toBe("QUJD")
    expect(extractBase64Data("QUJD")).toBe("QUJD")
    expect(extractBase64Data("")).toBe("")
  })
})

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

async function makeEncodedPngDataUrl(width, height) {
  const base = Buffer.from(TINY_PNG_BASE64, "base64")
  const resized = await new Bun.Image(base).resize(width, height, { fit: "fill" })
  const bytes = Buffer.from(await (await resized.png()).toBuffer())
  return `data:image/png;base64,${bytes.toString("base64")}`
}

async function decodePngDimensions(dataUrl) {
  const bytes = Buffer.from(dataUrl.split(",")[1], "base64")
  const metadata = await new Bun.Image(bytes).metadata()
  return { width: metadata.width, height: metadata.height }
}

const LARGE_PNG_2000X1000 = await makeEncodedPngDataUrl(2000, 1000)
const SMALL_PNG_800X600 = await makeEncodedPngDataUrl(800, 600)

describe("resizeImageDataUrl (real Bun.Image byte flow)", () => {
  test("downscales an oversized PNG to the Anthropic long-edge cap and re-encodes it", async () => {
    // given
    const input = LARGE_PNG_2000X1000

    // when
    const result = await resizeImageDataUrl(input, "image/png")

    // then
    expect(result.resized).toBe(true)
    expect(result.original).toEqual({ width: 2000, height: 1000 })
    expect(result.dimensions).toEqual({ width: 1568, height: 784 })
    expect(result.dataUrl.startsWith("data:image/png;base64,")).toBe(true)
    const decoded = await decodePngDimensions(result.dataUrl)
    expect(decoded.width).toBe(1568)
    expect(decoded.height).toBeLessThanOrEqual(1568)
  })

  test("leaves an image already within limits untouched", async () => {
    // given
    const input = SMALL_PNG_800X600

    // when
    const result = await resizeImageDataUrl(input, "image/png")

    // then
    expect(result.resized).toBe(false)
    expect(result.reason).toBe("within-limits")
    expect(result.original).toEqual({ width: 800, height: 600 })
  })

  test("re-encodes an oversized image declared as JPEG to image/jpeg", async () => {
    // given
    const bytes = Buffer.from(LARGE_PNG_2000X1000.split(",")[1], "base64")

    // when
    const result = await resizeImageDataUrl(`data:image/jpeg;base64,${bytes.toString("base64")}`, "image/jpeg")

    // then
    expect(result.resized).toBe(true)
    expect(result.mimeType).toBe("image/jpeg")
    expect(result.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true)
  })

  test("reports unavailable when no image constructor is present", async () => {
    // given / when
    const result = await resizeImageDataUrl(LARGE_PNG_2000X1000, "image/png", { imageCtor: "not-a-constructor" })

    // then
    expect(result.resized).toBe(false)
    expect(result.unavailable).toBe(true)
  })

  test("never throws on unusable input", async () => {
    // given / when
    const empty = await resizeImageDataUrl("", "image/png")
    const garbage = await resizeImageDataUrl("data:image/png;base64,AAAA", "image/png")

    // then
    expect(empty.resized).toBe(false)
    expect(garbage.resized).toBe(false)
  })
})

describe("resizer provider gate and format", () => {
  test("defaults to the anthropic-only provider set", () => {
    // given / when / then
    expect([...DEFAULT_RESIZER_PROVIDERS]).toEqual(["anthropic"])
    expect(isResizerProvider("anthropic")).toBe(true)
    expect(isResizerProvider("opencode-go")).toBe(false)
    expect(isResizerProvider("")).toBe(false)
    expect(isResizerProvider(undefined)).toBe(false)
  })

  test("honors the RIGEL_IMAGE_RESIZER_PROVIDERS override", () => {
    // given / when / then
    expect(resolveResizerProviders({ RIGEL_IMAGE_RESIZER_PROVIDERS: "anthropic, opencode-go" })).toEqual(["anthropic", "opencode-go"])
    expect(resolveResizerProviders({})).toEqual(DEFAULT_RESIZER_PROVIDERS)
    expect(resolveResizerProviders({ RIGEL_IMAGE_RESIZER_PROVIDERS: "  " })).toEqual(DEFAULT_RESIZER_PROVIDERS)
    expect(isResizerProvider("opencode-go", ["opencode-go"])).toBe(true)
  })

  test("maps mime types to encoder formats (gif re-encodes to png)", () => {
    // given / when / then
    expect(resolveResizerFormat("image/png")).toBe("png")
    expect(resolveResizerFormat("image/jpeg")).toBe("jpeg")
    expect(resolveResizerFormat("image/jpg")).toBe("jpeg")
    expect(resolveResizerFormat("image/webp")).toBe("webp")
    expect(resolveResizerFormat("image/gif")).toBe("png")
  })
})

describe("differential parity with the V1 resizer owners", () => {
  const PARSE_FIXTURES = [
    { label: "PNG 3000x2000", url: createPngDataUrl(3000, 2000), mime: "image/png", expected: { width: 3000, height: 2000 } },
    { label: "PNG 1x1", url: PNG_1X1_DATA_URL, mime: "image/png", expected: { width: 1, height: 1 } },
    { label: "GIF 320x240", url: createGifDataUrl(320, 240), mime: "image/gif", expected: { width: 320, height: 240 } },
    { label: "JPEG 4032x3024", url: createJpegDataUrl(4032, 3024), mime: "image/jpeg", expected: { width: 4032, height: 3024 } },
    { label: "WebP VP8 1920x1080", url: createVp8WebpDataUrl(1920, 1080), mime: "image/webp", expected: { width: 1920, height: 1080 } },
    { label: "WebP VP8L 1600x900", url: createVp8lWebpDataUrl(1600, 900), mime: "image/webp", expected: { width: 1600, height: 900 } },
    { label: "WebP VP8X 2000x1500", url: createVp8xWebpDataUrl(2000, 1500), mime: "image/webp", expected: { width: 2000, height: 1500 } },
    { label: "truncated VP8 WebP", url: createTruncatedVp8WebpDataUrl(), mime: "image/webp", expected: null },
    { label: "SOI-only JPEG", url: createSoiOnlyJpegDataUrl(), mime: "image/jpeg", expected: null },
    { label: "short PNG", url: "data:image/png;base64,AAAA", mime: "image/png", expected: null },
    { label: "unsupported mime", url: PNG_1X1_DATA_URL, mime: "image/heic", expected: null },
    { label: "empty input", url: "", mime: "image/png", expected: null },
  ]

  for (const fixture of PARSE_FIXTURES) {
    test(`agrees with V1 parseImageDimensions for ${fixture.label}`, () => {
      // given / when
      const ported = parseImageDimensions(fixture.url, fixture.mime)
      const owner = v1ParseImageDimensions(fixture.url, fixture.mime)

      // then: the independent expected value and the real owner both hold
      expect(ported).toEqual(fixture.expected)
      expect(ported).toEqual(owner)
    })
  }

  const TARGET_MATRIX = [
    [800, 600],
    [1568, 1000],
    [1000, 1568],
    [1568, 1568],
    [1569, 1000],
    [1569, 1569],
    [3000, 2000],
    [2000, 3000],
    [4000, 4000],
    [3000, 1],
    [1, 3000],
    [0, 100],
    [-1, 100],
  ]

  test("agrees with V1 calculateTargetDimensions across the boundary matrix", () => {
    // given / when / then
    for (const [width, height] of TARGET_MATRIX) {
      expect(calculateTargetDimensions(width, height)).toEqual(v1CalculateTargetDimensions(width, height))
    }
  })

  test("agrees with V1 for a custom maxLongEdge", () => {
    // given / when / then
    expect(calculateTargetDimensions(2000, 1000, 1000)).toEqual(v1CalculateTargetDimensions(2000, 1000, 1000))
    expect(calculateTargetDimensions(50, 50, 1000)).toEqual(v1CalculateTargetDimensions(50, 50, 1000))
  })
})

// ---------------------------------------------------------------------------
// createImageResizerStep `onOutcome` observability seam
//
// The callback is a receipt: it reports the decision the step reached and must
// never change the returned outcome, the request body it was handed, or the
// request itself. A callback that throws is observed and logged, never fatal.
// ---------------------------------------------------------------------------

function chatImageBody(url) {
  return { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }] }
}

function silentLogger() {
  const calls = []
  return { calls, error: (message) => calls.push(message) }
}

const OVERSIZED_PNG_URL = createLargePngDataUrl(3000, 2000, 4096)
const WITHIN_LIMITS_PNG_URL = createPngDataUrl(800, 600)
const RESIZED_DATA_URL = "data:image/png;base64,RESIZED"

describe("createImageResizerStep onOutcome seam", () => {
  test("reports a provider skip once and returns the same outcome as a callback-free run", async () => {
    // given
    const observed = []
    const body = chatImageBody(OVERSIZED_PNG_URL)
    const baselineBody = chatImageBody(OVERSIZED_PNG_URL)
    const input = { model: { providerID: "opencode-go" } }
    const step = createImageResizerStep({
      providers: ["anthropic"],
      log: silentLogger(),
      onOutcome: (outcome, context) => observed.push({ outcome, context }),
    })
    const baselineStep = createImageResizerStep({ providers: ["anthropic"], log: silentLogger() })

    // when
    const reported = await step.run({ body, shape: "chat", input })
    const baseline = await baselineStep.run({ body: baselineBody, shape: "chat", input })

    // then
    expect(observed).toHaveLength(1)
    expect(observed[0].outcome).toEqual({ considered: 0, resized: 0, removed: 0, skipped: "provider" })
    expect(observed[0].context).toEqual({ providerID: "opencode-go" })
    expect(reported).toEqual(baseline)
    expect(JSON.stringify(body)).toBe(JSON.stringify(baselineBody))
  })

  test("reports a completed resize with the allowed provider", async () => {
    // given
    const observed = []
    const body = chatImageBody(OVERSIZED_PNG_URL)
    const resize = async () => ({ resized: true, dataUrl: RESIZED_DATA_URL })
    const step = createImageResizerStep({
      providers: ["anthropic"],
      resize,
      log: silentLogger(),
      onOutcome: (outcome, context) => observed.push({ outcome, context }),
    })

    // when
    const reported = await step.run({ body, shape: "chat", input: { model: { providerID: "anthropic" } } })

    // then
    expect(reported.resized).toBe(1)
    expect(observed).toHaveLength(1)
    expect(observed[0].outcome.resized).toBe(1)
    expect(observed[0].outcome).toEqual(reported)
    expect(observed[0].context).toEqual({ providerID: "anthropic" })
    expect(body.messages[0].content[0].image_url.url).toBe(RESIZED_DATA_URL)
  })

  const THROWING_CALLBACK_SCENARIOS = [
    { label: "a provider skip", providerID: "opencode-go" },
    {
      label: "a completed resize",
      providerID: "anthropic",
      resize: async () => ({ resized: true, dataUrl: RESIZED_DATA_URL }),
    },
  ]

  for (const scenario of THROWING_CALLBACK_SCENARIOS) {
    test(`a throwing onOutcome cannot change the outcome or the body for ${scenario.label}`, async () => {
      // given
      const logger = silentLogger()
      const body = chatImageBody(OVERSIZED_PNG_URL)
      const baselineBody = chatImageBody(OVERSIZED_PNG_URL)
      const input = { model: { providerID: scenario.providerID } }
      const step = createImageResizerStep({
        providers: ["anthropic"],
        resize: scenario.resize,
        log: logger,
        onOutcome: () => { throw new Error("callback exploded") },
      })
      const baselineStep = createImageResizerStep({
        providers: ["anthropic"],
        resize: scenario.resize,
        log: silentLogger(),
      })

      // when
      const attempted = await step.run({ body, shape: "chat", input })
      const baseline = await baselineStep.run({ body: baselineBody, shape: "chat", input })

      // then
      expect(attempted).toEqual(baseline)
      expect(JSON.stringify(body)).toBe(JSON.stringify(baselineBody))
      expect(logger.calls).toHaveLength(1)
      expect(logger.calls[0]).toContain("image-resizer outcome callback failed")
      expect(logger.calls[0]).toContain("callback exploded")
    })
  }

  test("leaves the request body bytes unchanged when nothing needs resizing", async () => {
    // given
    const observed = []
    const body = chatImageBody(WITHIN_LIMITS_PNG_URL)
    const snapshot = JSON.stringify(body)
    const resize = async () => { throw new Error("resize must not run for a within-limits image") }
    const step = createImageResizerStep({
      providers: ["anthropic"],
      resize,
      log: silentLogger(),
      onOutcome: (outcome) => observed.push(outcome),
    })

    // when
    const result = await step.run({ body, shape: "chat", input: { model: { providerID: "anthropic" } } })

    // then
    expect(result).toEqual({ considered: 1, resized: 0, removed: 0, skips: [] })
    expect(JSON.stringify(body)).toBe(snapshot)
    expect(observed).toEqual([result])
  })
})
