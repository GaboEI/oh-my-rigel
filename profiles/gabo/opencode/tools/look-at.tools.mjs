/**
 * Native OpenCode V2 `look_at` tool.
 *
 * Ports `packages/omo-opencode/src/tools/look-at/tools.ts` onto the V2 session
 * domain. V1 created a child session through the SDK and attached the file as a
 * message part; V2 exposes the same flow through `context.session.create` +
 * `context.session.prompt` with `files` attachments, and the child's final text
 * is read from `context.session.context` after `context.session.wait`.
 *
 * Preserved V1 behavior:
 *   - Argument aliases (`file_path`/`path`, `image_data`), the one-of rules,
 *     remote-URL rejection, and the exact validation error strings.
 *   - JSON files are inlined as text; images are attached as file content.
 *   - The child is the `multimodal-looker` agent with `read` disabled and
 *     `task`/`call_omo_agent`/`look_at` disabled to prevent recursion.
 *   - A missing file yields `Error: File not found: <path>`.
 *   - No assistant text yields `Error: No response from multimodal-looker agent`.
 *
 * V2 adaptation: the file is passed as a `ToolFileContent`-shaped attachment
 * (`{ type: "file", uri, mime, name }`) rather than a V1 message part. The
 * runtime maps it to a `PromptInput.FileAttachment`.
 */

import { readFileSync, existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import * as childProcess from "node:child_process"

export const MULTIMODAL_LOOKER_AGENT = "multimodal-looker"

export const LOOK_AT_DESCRIPTION = `Extract basic information from media files (PDFs, images, diagrams) when a quick summary suffices over precise reading. Good for simple text-based content extraction without using the Read tool. NEVER use for visual precision, aesthetic evaluation, or exact accuracy - use Read tool instead for those cases.`

const READ_ENABLED = false

const MIME_BY_EXTENSION = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  tiff: "image/tiff",
  tif: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
  cr2: "image/x-canon-cr2",
  crw: "image/x-canon-crw",
  nef: "image/x-nikon-nef",
  nrw: "image/x-nikon-nrw",
  arw: "image/x-sony-arw",
  sr2: "image/x-sony-sr2",
  srf: "image/x-sony-srf",
  pef: "image/x-pentax-pef",
  orf: "image/x-olympus-orf",
  raw: "image/x-panasonic-raw",
  raf: "image/x-fuji-raf",
  dng: "image/x-adobe-dng",
  psd: "image/vnd.adobe.photoshop",
  pdf: "application/pdf",
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
})

// V1 image-converter.ts: formats the model accepts directly, and formats that
// must be converted to JPEG first. Anything else under `image/` is converted.
const SUPPORTED_IMAGE_FORMATS = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp", "image/tiff"])
const UNSUPPORTED_IMAGE_FORMATS = new Set([
  "image/heic", "image/heif", "image/x-canon-cr2", "image/x-canon-crw", "image/x-nikon-nef", "image/x-nikon-nrw",
  "image/x-sony-arw", "image/x-sony-sr2", "image/x-sony-srf", "image/x-pentax-pef", "image/x-olympus-orf",
  "image/x-panasonic-raw", "image/x-fuji-raf", "image/x-adobe-dng", "image/vnd.adobe.photoshop", "image/x-photoshop",
])
const CONVERSION_TIMEOUT_MS = 30_000

export function needsConversion(mimeType) {
  if (SUPPORTED_IMAGE_FORMATS.has(mimeType)) return false
  if (UNSUPPORTED_IMAGE_FORMATS.has(mimeType)) return true
  return mimeType.startsWith("image/")
}

function cleanupTemporaryFileAfterFailure(filePath) {
  try {
    if (existsSync(filePath)) unlinkSync(filePath)
  } catch { /* best effort */ }
}

/**
 * Convert an unsupported image to JPEG using the same local tools V1 used
 * (sips on macOS, ImageMagick elsewhere). Returns the converted path; throws
 * with the V1 install guidance when no converter is available.
 */
export function convertImageToJpeg(inputPath, mimeType) {
  if (!existsSync(inputPath)) throw new Error(`File not found: ${inputPath}`)
  const tempDir = mkdtempSync(join(tmpdir(), "opencode-img-"))
  const outputPath = join(tempDir, "converted.jpg")
  try {
    if (process.platform === "darwin") {
      try {
        childProcess.execFileSync("sips", ["-s", "format", "jpeg", "--", inputPath, "--out", outputPath], { stdio: "pipe", encoding: "utf-8", timeout: CONVERSION_TIMEOUT_MS })
        if (existsSync(outputPath)) return outputPath
      } catch { /* fall through to ImageMagick */ }
    }
    try {
      const imagemagickCommand = process.platform === "darwin" ? "convert" : "magick"
      childProcess.execFileSync(imagemagickCommand, ["--", inputPath, outputPath], { stdio: "pipe", encoding: "utf-8", timeout: CONVERSION_TIMEOUT_MS })
      if (existsSync(outputPath)) return outputPath
    } catch { /* fall through to the error below */ }
    throw new Error(
      `No image conversion tool available. Please install ImageMagick:\n` +
      `  macOS: brew install imagemagick\n` +
      `  Ubuntu/Debian: sudo apt install imagemagick\n` +
      `  RHEL/CentOS: sudo yum install ImageMagick`,
    )
  } catch (error) {
    cleanupTemporaryFileAfterFailure(outputPath)
    if (error instanceof Error) Reflect.set(error, "temporaryOutputPath", outputPath)
    throw error
  }
}

export function cleanupConvertedImage(filePath) {
  try {
    const tempDirectory = dirname(filePath)
    if (existsSync(filePath)) unlinkSync(filePath)
    if (existsSync(tempDirectory)) rmSync(tempDirectory, { recursive: true, force: true })
  } catch { /* best effort */ }
}

export function convertBase64ImageToJpeg(base64Data, mimeType) {
  const tempDir = mkdtempSync(join(tmpdir(), "opencode-b64-"))
  const inputExt = mimeType.split("/")[1] || "bin"
  const inputPath = join(tempDir, `input.${inputExt}`)
  const tempFiles = [inputPath]
  try {
    const cleanBase64 = base64Data.replace(/^data:[^;]+;base64,/, "")
    writeFileSync(inputPath, Buffer.from(cleanBase64, "base64"))
    const outputPath = convertImageToJpeg(inputPath, mimeType)
    tempFiles.push(outputPath)
    return { base64: readFileSync(outputPath).toString("base64"), tempFiles }
  } catch (error) {
    for (const file of tempFiles) cleanupTemporaryFileAfterFailure(file)
    throw error
  }
}

function extensionOf(filePath) {
  const match = /\.([a-zA-Z0-9]+)$/.exec(String(filePath))
  return match ? match[1].toLowerCase() : ""
}

export function inferMimeTypeFromFilePath(filePath) {
  return MIME_BY_EXTENSION[extensionOf(filePath)] ?? "application/octet-stream"
}

export function inferMimeTypeFromBase64(imageData) {
  const match = /^data:([^;]+);base64,/.exec(String(imageData))
  return match ? match[1] : "image/png"
}

export function extractBase64Data(imageData) {
  const value = String(imageData)
  const comma = value.indexOf(",")
  return value.startsWith("data:") && comma !== -1 ? value.slice(comma + 1) : value
}

function hasNonEmptyString(value) {
  return typeof value === "string" && value.length > 0
}

function hasValues(values) {
  return Array.isArray(values) && values.length > 0
}

function isRemoteUrl(value) {
  return /^https?:\/\//i.test(value)
}

export function normalizeArgs(args = {}) {
  const filePath = args.file_path ?? args.path
  const imageData = args.image_data
  const filePathsFromSingular = !args.file_paths && hasNonEmptyString(filePath)
  const imageDataListFromSingular = !args.image_data_list && hasNonEmptyString(imageData)
  return {
    file_path: filePath,
    file_paths: args.file_paths ?? (filePathsFromSingular ? [filePath] : undefined),
    image_data: imageData,
    image_data_list: args.image_data_list ?? (imageDataListFromSingular ? [imageData] : undefined),
    goal: args.goal ?? "",
    _normalized_file_paths_from_singular: filePathsFromSingular || undefined,
    _normalized_image_data_list_from_singular: imageDataListFromSingular || undefined,
  }
}

export function validateArgs(args) {
  const hasFilePath = hasNonEmptyString(args.file_path)
  const hasFilePaths = hasValues(args.file_paths)
  const hasImageData = hasNonEmptyString(args.image_data)
  const hasImageDataList = hasValues(args.image_data_list)
  const filePathsFromSingular = args._normalized_file_paths_from_singular === true
  const imageDataListFromSingular = args._normalized_image_data_list_from_singular === true

  if (hasFilePath && hasFilePaths && !filePathsFromSingular) {
    return "Error: Provide either 'file_path' or 'file_paths', not both."
  }
  if (hasImageData && hasImageDataList && !imageDataListFromSingular) {
    return "Error: Provide either 'image_data' or 'image_data_list', not both."
  }
  if (hasValues(args.file_paths)) {
    for (const filePath of args.file_paths) {
      if (!hasNonEmptyString(filePath)) return "Error: 'file_paths' must contain only non-empty local file paths."
      if (isRemoteUrl(filePath)) return "Error: Remote URLs are not supported for file_paths. Download the file first or use a local path."
    }
  }
  if (hasValues(args.image_data_list)) {
    for (const imageData of args.image_data_list) {
      if (!hasNonEmptyString(imageData)) return "Error: 'image_data_list' must contain only non-empty Base64 image strings."
    }
  }
  if (hasNonEmptyString(args.file_path) && isRemoteUrl(args.file_path)) {
    return "Error: Remote URLs are not supported for file_path. Download the file first or use a local path."
  }
  if (!hasFilePath && !hasFilePaths && !hasImageData && !hasImageDataList) {
    return `Error: Must provide at least one of 'file_path', 'file_paths', 'image_data', or 'image_data_list'. Usage:
- look_at(file_path="/path/to/file", goal="what to extract")
- look_at(file_paths=["/path/to/file-1", "/path/to/file-2"], goal="what to extract")
- look_at(image_data="base64_encoded_data", goal="what to extract")`
  }
  if (!args.goal) {
    return "Error: Missing required parameter 'goal'. Usage: look_at(file_path=\"/path/to/file\", goal=\"what to extract\")"
  }
  return null
}

function sanitizeFilename(filename) {
  const base = String(filename).split("/").pop() ?? String(filename)
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100)
}

export function buildLookAtPrompt(goal, fileParts) {
  const isPlural = fileParts.length > 1
  const subjectNoun = isPlural ? "files/images" : "file/image"
  const pronoun = isPlural ? "them" : "it"
  const labels = isPlural
    ? `\n\nAttached files/images:\n${fileParts.map((filePart, index) => `File ${index + 1}: ${sanitizeFilename(filePart.name)}`).join("\n")}`
    : ""
  const sourceClause = READ_ENABLED
    ? "Use the Read tool on the provided file path to load its contents, then analyze it."
    : `The attached ${subjectNoun} ${isPlural ? "are" : "is"} already included in this message. Analyze ${pronoun} directly from the attachment. Do NOT attempt to load by path — the ${subjectNoun} cannot be loaded by path.`
  return `Analyze ${isPlural ? "these files/images" : "this file/image"} and extract the requested information.${labels}

${sourceClause}

Goal: ${goal}

Provide ONLY the extracted information that matches the goal.
Be thorough on what was requested, concise on everything else.
If the requested information is not found, clearly state what is missing.`
}

/**
 * Build the V2 attachment list from the normalized args. A JSON file becomes a
 * text part (V1 inlined it); every other file becomes a `ToolFileContent`
 * attachment. A missing file throws an `ENOENT`-coded error so the caller can
 * map it to the V1 `File not found:` string.
 */
export function prepareLookAtInput(args) {
  const filePaths = args.file_paths ?? (args.file_path ? [args.file_path] : [])
  const imageDataList = args.image_data_list ?? (args.image_data ? [args.image_data] : [])
  const totalInputs = filePaths.length + imageDataList.length
  if (totalInputs === 0) {
    return { ok: false, error: "Error: Must provide either 'file_path', 'file_paths', 'image_data', or 'image_data_list'." }
  }

  const files = []
  const textParts = []
  const tempFilesToCleanup = []
  for (const filePath of filePaths) {
    // V1 surfaced a missing file as `Error: File not found:` (mapped from the
    // child session's ENOENT). V2's child may not surface ENOENT cleanly, so
    // the observable V1 behavior is preserved by checking existence up front.
    if (!existsSync(filePath)) return { ok: false, error: `Error: File not found: ${filePath}` }
    let mimeType = inferMimeTypeFromFilePath(filePath)
    let actualFilePath = filePath
    if (mimeType === "application/json") {
      let content
      try {
        content = readFileSync(filePath, "utf-8")
      } catch (error) {
        const code = error instanceof Error ? Reflect.get(error, "code") : undefined
        if (code === "ENOENT") return { ok: false, error: `Error: File not found: ${filePath}` }
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, error: `Error: Failed to read JSON file ${filePath}: ${message}` }
      }
      textParts.push(`Attached JSON file (${basename(filePath)}):\n\n${content}`)
      continue
    }
    // V1 converted HEIC/RAW/PSD and other unsupported images to JPEG before
    // attaching them. Preserve that so the model receives a readable format.
    if (needsConversion(mimeType)) {
      try {
        const convertedFilePath = convertImageToJpeg(filePath, mimeType)
        tempFilesToCleanup.push(convertedFilePath)
        actualFilePath = convertedFilePath
        mimeType = "image/jpeg"
      } catch (conversionError) {
        const failedPath = conversionError instanceof Error ? Reflect.get(conversionError, "temporaryOutputPath") : undefined
        if (typeof failedPath === "string") tempFilesToCleanup.push(failedPath)
        for (const file of tempFilesToCleanup) cleanupConvertedImage(file)
        return { ok: false, error: `Error: Failed to convert image format. ${conversionError instanceof Error ? conversionError.message : String(conversionError)}` }
      }
    }
    files.push({ type: "file", uri: pathToFileURL(actualFilePath).href, mime: mimeType, name: basename(actualFilePath) })
  }

  for (const imageData of imageDataList) {
    let mimeType = inferMimeTypeFromBase64(imageData)
    let base64 = extractBase64Data(imageData)
    if (needsConversion(mimeType)) {
      try {
        const converted = convertBase64ImageToJpeg(base64, mimeType)
        base64 = converted.base64
        tempFilesToCleanup.push(...converted.tempFiles)
        mimeType = "image/jpeg"
      } catch (conversionError) {
        for (const file of tempFilesToCleanup) cleanupConvertedImage(file)
        return { ok: false, error: `Error: Failed to convert Base64 image format. ${conversionError instanceof Error ? conversionError.message : String(conversionError)}` }
      }
    }
    files.push({ type: "file", uri: `data:${mimeType};base64,${base64}`, mime: mimeType, name: `clipboard-image.${mimeType.split("/")[1] || "png"}` })
  }

  const sourceDescription = totalInputs > 1
    ? `${totalInputs} files/images`
    : imageDataList.length === 1
      ? "clipboard/pasted image"
      : filePaths[0]

  return { ok: true, value: { files, textParts, sourceDescription, cleanup: () => { for (const file of tempFilesToCleanup) cleanupConvertedImage(file) } } }
}

function responseData(response) {
  return response?.data ?? response
}

function sessionIdOf(response) {
  const data = responseData(response)
  const id = data?.id ?? data?.sessionID ?? data?.session?.id
  return typeof id === "string" && id ? id : undefined
}

function contextMessages(response) {
  const data = responseData(response)
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.messages)) return data.messages
  return []
}

export function extractLatestAssistantText(messages) {
  if (!Array.isArray(messages)) return ""
  const assistant = [...messages].reverse().find((message) => message?.type === "assistant" || message?.role === "assistant")
  if (!assistant) return ""
  const parts = Array.isArray(assistant.content) ? assistant.content : Array.isArray(assistant.parts) ? assistant.parts : []
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
}

function sessionDomain(client) {
  const api = client?.session ?? client?.v2?.session
  if (typeof api?.create !== "function" || typeof api?.prompt !== "function") {
    throw new Error("OpenCode V2 session.create/session.prompt is unavailable")
  }
  return api
}

/**
 * Surface the child session's provider failure instead of the generic
 * "No response" string. V2 records a failed generation on the assistant message
 * (`error` object / `finish: "error"`) and an idle part with `outcome: "failed"`;
 * either is a real, provider-supplied reason the caller must see (Fase 6 contract:
 * an EXPLICIT error when the provider rejects).
 */
export function extractChildFailure(messages) {
  if (!Array.isArray(messages)) return ""
  let generic = ""
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const error = message?.error
    const detail = typeof error === "string" ? error : error?.message ?? error?.data?.message
    if (typeof detail === "string" && detail.trim()) return detail.trim()
    if (!generic && (message?.finish === "error" || (message?.type === "idle" && message?.outcome === "failed"))) {
      generic = "the child session ended without an assistant response"
    }
  }
  return generic
}

/**
 * Run the multimodal-looker child session. Returns the child's final text, or
 * an `Error:` string matching V1. `clients` is the ordered candidate list.
 * `resolveModel` (optional) resolves the child's start model the same way the
 * delegation path does; V1 resolved a vision-capable model for this child, so
 * omitting it left the child inheriting an unrelated global (the `model=NULL`
 * symptom). Resolution failure degrades to the inherited global, never blocks.
 */
export async function runLookAtSession({ clients, location, goal, files, textParts, parentSessionID, resolveModel }) {
  let resolvedModel
  if (typeof resolveModel === "function") {
    try {
      resolvedModel = await resolveModel()
    } catch (error) {
      console.error(`[oh-my-rigel] Native V2 look_at child model resolution failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  let lastError
  for (const client of clients.filter(Boolean)) {
    try {
      const sessions = sessionDomain(client)
      const created = await sessions.create({
        agent: MULTIMODAL_LOOKER_AGENT,
        location,
        ...(parentSessionID ? { parentID: parentSessionID } : {}),
        ...(resolvedModel ? { model: resolvedModel } : {}),
      })
      const sessionID = sessionIdOf(created)
      if (!sessionID) throw new Error("OpenCode V2 did not return a look_at child session ID")
      const promptText = [buildLookAtPrompt(goal, files), ...textParts].join("\n\n")
      await sessions.prompt({
        sessionID,
        text: promptText,
        files,
        resume: true,
      })
      if (typeof sessions.wait === "function") await sessions.wait({ sessionID })
      const messages = typeof sessions.context === "function" ? contextMessages(await sessions.context({ sessionID })) : []
      const text = extractLatestAssistantText(messages)
      if (!text) {
        const failure = extractChildFailure(messages)
        return failure ? `Error: multimodal-looker child failed: ${failure}` : "Error: No response from multimodal-looker agent"
      }
      return text
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error("OpenCode V2 look_at child session could not be created")
}

export function createLookAtTool({ clients, location, resolveModel }) {
  return {
    description: LOOK_AT_DESCRIPTION,
    input: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the file to analyze" },
        file_paths: { type: "array", items: { type: "string" }, description: "Absolute paths to the files to analyze" },
        image_data: { type: "string", description: "Base64 encoded image data (for clipboard/pasted images)" },
        image_data_list: { type: "array", items: { type: "string" }, description: "Base64 encoded image data entries (for multiple clipboard/pasted images)" },
        goal: { type: "string", description: "What specific information to extract from the file" },
      },
      required: ["goal"],
      additionalProperties: false,
    },
    async execute(rawArgs = {}, toolContext = {}) {
      const args = normalizeArgs(rawArgs)
      const validationError = validateArgs(args)
      if (validationError) return validationError
      const prepared = prepareLookAtInput(args)
      if (!prepared.ok) return prepared.error
      const { files, textParts, sourceDescription, cleanup } = prepared.value
      try {
        return await runLookAtSession({
          clients,
          location,
          goal: args.goal,
          files,
          textParts,
          parentSessionID: toolContext?.sessionID,
          resolveModel,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") {
          return `Error: File not found: ${args.file_path ?? args.file_paths?.[0] ?? sourceDescription}`
        }
        return `Error: Failed to analyze ${sourceDescription}: ${message}`
      } finally {
        cleanup?.()
      }
    },
  }
}
