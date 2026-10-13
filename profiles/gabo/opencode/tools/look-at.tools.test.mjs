import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createLookAtTool,
  extractChildFailure,
  normalizeArgs,
  validateArgs,
  prepareLookAtInput,
  buildLookAtPrompt,
  extractLatestAssistantText,
  inferMimeTypeFromFilePath,
  needsConversion,
} from "./look-at.tools.mjs"

// A fake V2 session domain that records the child session and returns a canned
// assistant message. This is the real boundary look_at drives.
function fakeClient({ assistantText = "EXTRACTED", failCreate = false, childMessages } = {}) {
  const calls = { create: [], prompt: [], wait: [], context: [] }
  return {
    calls,
    session: {
      create: async (input) => {
        calls.create.push(input)
        if (failCreate) throw new Error("create failed")
        return { data: { id: "ses_look" } }
      },
      prompt: async (input) => { calls.prompt.push(input); return { data: {} } },
      wait: async (input) => { calls.wait.push(input) },
      context: async (input) => {
        calls.context.push(input)
        if (Array.isArray(childMessages)) return { data: childMessages }
        return { data: [{ type: "assistant", content: [{ type: "text", text: assistantText }] }] }
      },
    },
  }
}

function toolFor(client, options = {}) {
  return createLookAtTool({ clients: [client], location: { directory: "/work" }, ...options })
}

test("look_at validates the one-of rules and rejects remote URLs", () => {
  expect(validateArgs(normalizeArgs({ file_path: "/a.png", file_paths: ["/b.png"], goal: "g" }))).toBe("Error: Provide either 'file_path' or 'file_paths', not both.")
  expect(validateArgs(normalizeArgs({ file_path: "https://example.com/a.png", goal: "g" }))).toBe("Error: Remote URLs are not supported for file_paths. Download the file first or use a local path.")
  expect(validateArgs(normalizeArgs({ file_path: "/a.png" }))).toContain("Missing required parameter 'goal'")
  expect(validateArgs(normalizeArgs({ goal: "g" }))).toContain("Must provide at least one of")
})

test("look_at infers MIME from the file extension", () => {
  expect(inferMimeTypeFromFilePath("/a/photo.PNG")).toBe("image/png")
  expect(inferMimeTypeFromFilePath("/a/doc.pdf")).toBe("application/pdf")
  expect(inferMimeTypeFromFilePath("/a/data.json")).toBe("application/json")
  expect(inferMimeTypeFromFilePath("/a/unknown.xyz")).toBe("application/octet-stream")
})

test("look_at inlines a JSON file as text and attaches other files", () => {
  const dir = mkdtempSync(join(tmpdir(), "look-at-"))
  try {
    const jsonPath = join(dir, "data.json")
    writeFileSync(jsonPath, '{"k":1}')
    const prepared = prepareLookAtInput(normalizeArgs({ file_path: jsonPath, goal: "g" }))
    expect(prepared.ok).toBe(true)
    expect(prepared.value.textParts[0]).toContain('{"k":1}')
    expect(prepared.value.files.length).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("look_at returns the V1 File not found error for a missing file", async () => {
  const tool = toolFor(fakeClient())
  const output = await tool.execute({ file_path: "/definitely/missing.png", goal: "g" })
  expect(output).toBe("Error: File not found: /definitely/missing.png")
})

test("look_at delegates to the multimodal-looker child and returns its text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "look-at-"))
  try {
    const imagePath = join(dir, "shot.png")
    writeFileSync(imagePath, "not-a-real-png")
    const client = fakeClient({ assistantText: "A red square." })
    const tool = toolFor(client)
    const output = await tool.execute({ file_path: imagePath, goal: "what is shown" }, { sessionID: "ses_parent" })
    expect(output).toBe("A red square.")
    expect(client.calls.create[0]).toMatchObject({ agent: "multimodal-looker", parentID: "ses_parent" })
    expect(client.calls.prompt[0].files[0]).toMatchObject({ type: "file", mime: "image/png" })
    expect(client.calls.prompt[0].text).toContain("Goal: what is shown")
    expect(client.calls.wait[0]).toEqual({ sessionID: "ses_look" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("look_at reports no response when the child returns no assistant text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "look-at-"))
  try {
    const imagePath = join(dir, "shot.png")
    writeFileSync(imagePath, "x")
    const tool = toolFor(fakeClient({ assistantText: "" }))
    expect(await tool.execute({ file_path: imagePath, goal: "g" })).toBe("Error: No response from multimodal-looker agent")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Fase 6: V1 resolved a vision-capable model for the look_at child; a dropped
// resolver left the child model-less (`session_v2.model=NULL`). The tool must
// pass the resolved ref to the child create call, like the delegation path.
test("look_at passes the resolved child model into the session create call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "look-at-"))
  try {
    const imagePath = join(dir, "shot.png")
    writeFileSync(imagePath, "x")
    const client = fakeClient({ assistantText: "A red square." })
    const tool = toolFor(client, { resolveModel: async () => ({ providerID: "zai-coding-plan", id: "glm-4.6v" }) })
    await tool.execute({ file_path: imagePath, goal: "g" }, { sessionID: "ses_parent" })
    expect(client.calls.create[0]).toMatchObject({ agent: "multimodal-looker", model: { providerID: "zai-coding-plan", id: "glm-4.6v" } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("look_at omits the model field when no model resolves (inherit the global, unchanged)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "look-at-"))
  try {
    const imagePath = join(dir, "shot.png")
    writeFileSync(imagePath, "x")
    const client = fakeClient({ assistantText: "A red square." })
    const tool = toolFor(client, { resolveModel: async () => undefined })
    await tool.execute({ file_path: imagePath, goal: "g" }, { sessionID: "ses_parent" })
    expect(Object.prototype.hasOwnProperty.call(client.calls.create[0], "model")).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Fase 6 contract: when the provider rejects the child, look_at must return the
// child's real reason, not the generic no-response string that hid the 400.
test("look_at surfaces the child's provider failure instead of the generic no-response string", async () => {
  const dir = mkdtempSync(join(tmpdir(), "look-at-"))
  try {
    const imagePath = join(dir, "shot.png")
    writeFileSync(imagePath, "x")
    const client = fakeClient({ childMessages: [
      { type: "assistant", agent: "multimodal-looker", finish: "error", error: { type: "provider.invalid-request", message: "`temperature` may only be set to 1 when thinking is enabled or in adaptive mode." } },
      { type: "idle", outcome: "failed" },
    ] })
    const output = await toolFor(client).execute({ file_path: imagePath, goal: "g" })
    expect(output).toContain("multimodal-looker child failed")
    expect(output).toContain("temperature")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("extractChildFailure reads the child's error object, an error finish, or a failed idle, and is empty otherwise", () => {
  expect(extractChildFailure([{ type: "assistant", error: { message: "provider boom" } }])).toBe("provider boom")
  expect(extractChildFailure([{ type: "assistant", finish: "error" }])).toContain("ended without an assistant response")
  expect(extractChildFailure([{ type: "idle", outcome: "failed" }])).toContain("ended without an assistant response")
  expect(extractChildFailure([{ type: "assistant", content: [{ type: "text", text: "ok" }] }])).toBe("")
  expect(extractChildFailure([])).toBe("")
})

test("look_at surfaces a child creation failure as the V1 Error string", async () => {
  const dir = mkdtempSync(join(tmpdir(), "look-at-"))
  try {
    const imagePath = join(dir, "shot.png")
    writeFileSync(imagePath, "x")
    const tool = toolFor(fakeClient({ failCreate: true }))
    const output = await tool.execute({ file_path: imagePath, goal: "g" })
    expect(output).toContain("Error: Failed to analyze")
    expect(output).toContain("create failed")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("look_at builds a plural prompt that labels each attached file", () => {
  const prompt = buildLookAtPrompt("goal", [{ name: "a.png" }, { name: "b.png" }])
  expect(prompt).toContain("File 1: a.png")
  expect(prompt).toContain("File 2: b.png")
  expect(prompt).toContain("these files/images")
})

test("extractLatestAssistantText returns the last assistant text block", () => {
  const messages = [
    { type: "assistant", content: [{ type: "text", text: "first" }] },
    { type: "user", content: [{ type: "text", text: "ignored" }] },
    { type: "assistant", content: [{ type: "text", text: "second" }] },
  ]
  expect(extractLatestAssistantText(messages)).toBe("second")
  expect(extractLatestAssistantText([])).toBe("")
})

// Task 15 re-open: V1 converted HEIC/RAW/PSD and other unsupported images to
// JPEG before attaching them. The port must preserve that, not silently attach
// an unreadable format.
test("look_at classifies supported and unsupported image formats", () => {
  expect(needsConversion("image/png")).toBe(false)
  expect(needsConversion("image/jpeg")).toBe(false)
  expect(needsConversion("image/heic")).toBe(true)
  expect(needsConversion("image/x-adobe-dng")).toBe(true)
  expect(needsConversion("image/vnd.adobe.photoshop")).toBe(true)
})

test("look_at reports the V1 conversion error when no converter is available", () => {
  // A HEIC file with no real converter on PATH must surface the V1 install
  // guidance rather than attaching an unreadable format.
  const dir = mkdtempSync(join(tmpdir(), "look-at-heic-"))
  try {
    const heicPath = join(dir, "photo.heic")
    writeFileSync(heicPath, "not-a-real-heic")
    const prepared = prepareLookAtInput(normalizeArgs({ file_path: heicPath, goal: "g" }))
    // Either a converter exists (ok) or the V1 error is returned; both are
    // correct. Assert the shape, not the host's tool availability.
    if (!prepared.ok) {
      expect(prepared.error).toContain("Failed to convert image format")
    } else {
      expect(prepared.value.files[0].mime).toBe("image/jpeg")
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
