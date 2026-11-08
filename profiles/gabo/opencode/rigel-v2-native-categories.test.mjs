import { test, expect } from "bun:test"
import { availableCategoryNames, mergeCategories, normalizeUserChain, normalizeUserChainEntry, resolveCategory } from "./rigel-v2-native-categories.mjs"

test("exports the complete upstream builtin category set", () => {
  expect(availableCategoryNames()).toEqual([
    "artistry", "deep-high", "deep-low", "quick", "ultrabrain",
    "unspecified-high", "unspecified-low", "visual-engineering", "writing",
  ])
})

test("merges user categories over the builtin set and drops disabled entries", () => {
  const merged = mergeCategories({
    quick: { disable: true },
    "my-lane": { model: "openai/gpt-6-luna-fast", description: "Custom lane" },
  })
  expect(merged.quick).toBeUndefined()
  expect(merged["my-lane"]).toEqual({ model: "openai/gpt-6-luna-fast", description: "Custom lane" })
  // Every builtin except the disabled one survives.
  expect(Object.keys(merged).sort()).toEqual([
    "artistry", "deep-high", "deep-low", "my-lane", "ultrabrain",
    "unspecified-high", "unspecified-low", "visual-engineering", "writing",
  ])
})

test("availableCategoryNames includes user categories and excludes disabled ones", () => {
  expect(availableCategoryNames({ "my-lane": { model: "openai/gpt-6-luna-fast" }, writing: { disable: true } }))
    .toEqual([
      "artistry", "deep-high", "deep-low", "my-lane", "quick", "ultrabrain",
      "unspecified-high", "unspecified-low", "visual-engineering",
    ])
})

test("resolves a user category through its own model chain", async () => {
  const result = await resolveCategory({
    model: { list: async () => ({ data: [{ providerID: "openai", id: "gpt-6-luna-fast", enabled: true }] }) },
  }, { directory: "/project" }, "my-lane", {
    userCategories: { "my-lane": { models: ["openai/gpt-6-luna-fast(low)"], description: "Custom lane", caller_guidance: "<Selection_Gate>custom</Selection_Gate>" } },
  })
  expect(result.model).toEqual({ providerID: "openai", id: "gpt-6-luna-fast", variant: "low" })
  expect(result.description).toBe("Custom lane")
  expect(result.callerGuidance).toBe("<Selection_Gate>custom</Selection_Gate>")
})

test("a user category with no chain falls back to its configured model lane", async () => {
  const result = await resolveCategory({
    model: { list: async () => ({ data: [{ providerID: "openai", id: "gpt-6-luna-fast", enabled: true }] }) },
  }, { directory: "/project" }, "my-lane", {
    userCategories: { "my-lane": { model: "openai/gpt-6-luna-fast", variant: "low" } },
  })
  expect(result.model).toEqual({ providerID: "openai", id: "gpt-6-luna-fast", variant: "low" })
})

test("a user override replaces the builtin description and guidance", async () => {
  const result = await resolveCategory({
    model: { list: async () => ({ data: [{ providerID: "openai", id: "gpt-6-luna-fast", enabled: true }] }) },
  }, { directory: "/project" }, "quick", {
    userCategories: { quick: { description: "Overridden", caller_guidance: "<Caller_Warning>overridden</Caller_Warning>" } },
  })
  expect(result.description).toBe("Overridden")
  expect(result.callerGuidance).toBe("<Caller_Warning>overridden</Caller_Warning>")
})

test("a disabled builtin category is not resolvable", async () => {
  await expect(resolveCategory({
    model: { list: async () => ({ data: [{ providerID: "openai", id: "gpt-6-luna-fast", enabled: true }] }) },
  }, { directory: "/project" }, "quick", { userCategories: { quick: { disable: true } } }))
    .rejects.toThrow('Unknown category: "quick". Available:')
})

test("an unknown category returns the V1-equivalent tolerant resolution error", async () => {
  await expect(resolveCategory({
    model: { list: async () => ({ data: [] }) },
  }, { directory: "/project" }, "nope", { userCategories: { "my-lane": { model: "openai/gpt-6-luna-fast" } } }))
    .rejects.toThrow('Unknown category: "nope". Available: artistry, deep-high, deep-low, my-lane, quick, ultrabrain, unspecified-high, unspecified-low, visual-engineering, writing')
})

test("resolves a category against the location-scoped V2 model inventory", async () => {
  const calls = []
  const result = await resolveCategory({
    model: { list: async (input) => {
      calls.push(input)
      return { data: [{ providerID: "openai", id: "gpt-6-luna-fast", enabled: true }] }
    } },
  }, { directory: "/project" }, "quick")
  expect(calls).toEqual([{ location: { directory: "/project" } }])
  expect(result.model).toEqual({ providerID: "openai", id: "gpt-6-luna-fast", variant: "low" })
})

test("falls to the next reachable rung when the primary category model is absent", async () => {
  const result = await resolveCategory({
    model: { list: async () => ({ data: [{ providerID: "deepseek", id: "deepseek-flash", enabled: true }] }) },
  }, { directory: "/project" }, "quick")
  expect(result.model).toEqual({ providerID: "deepseek", id: "deepseek-flash", variant: "off" })
})

test("never silently substitutes an unavailable category model", async () => {
  await expect(resolveCategory({
    model: { list: async () => ({ data: [{ providerID: "other", id: "model" }] }) },
  }, { directory: "/project" }, "quick")).rejects.toThrow('Category "quick" requires one of its canonical fallback models')
})

test("never cross-routes a category rung to an undeclared provider", async () => {
  await expect(resolveCategory({
    model: { list: async () => ({ data: [{ providerID: "some-other", id: "gpt-6-luna-fast", enabled: true }] }) },
  }, { directory: "/project" }, "quick")).rejects.toThrow('Category "quick" requires one of its canonical fallback models')
})

// Upstream 5a9bb74a4: an explicit user model suppresses the built-in chain.
test("a user category model suppresses the built-in chain and marks the category explicit", async () => {
  const result = await resolveCategory({
    model: { list: async () => ({ data: [
      { providerID: "openai", id: "gpt-6-luna-fast", enabled: true },
      { providerID: "deepseek", id: "deepseek-flash", enabled: true },
    ] }) },
  }, { directory: "/project" }, "quick", {
    userCategories: { quick: { model: "deepseek/deepseek-flash", fallback_models: ["openai/gpt-6-luna-fast(off)"] } },
  })
  expect(result.explicit).toBe(true)
  // The user's model wins over quick's built-in first rung (openai/gpt-6-luna-fast).
  expect(result.model).toEqual({ providerID: "deepseek", id: "deepseek-flash" })
  expect(result.fallbackChain).toEqual([{ providers: ["openai"], model: "gpt-6-luna-fast", variant: "off" }])
})

test("a built-in category without a user model is not explicit and carries no fallback_models chain", async () => {
  const result = await resolveCategory({
    model: { list: async () => ({ data: [{ providerID: "openai", id: "gpt-6-luna-fast", enabled: true }] }) },
  }, { directory: "/project" }, "quick")
  expect(result.explicit).toBe(false)
  expect(result.fallbackChain).toBeUndefined()
})

test("an explicit user model with no reachable model names the user model in the error", async () => {
  await expect(resolveCategory({
    model: { list: async () => ({ data: [{ providerID: "openai", id: "gpt-6-luna-fast", enabled: true }] }) },
  }, { directory: "/project" }, "quick", {
    userCategories: { quick: { model: "anthropic/claude-opus-5-5" } },
  })).rejects.toThrow('was pinned to the user model(s) (anthropic/claude-opus-5-5)')
})

// An OBJECT chain entry carries the same provider-scoped identity a string does:
// `{ model: "anthropic/claude-opus-5-5" }` must resolve to the anthropic
// provider, not to a provider-less rung the resolver silently drops.
test("normalizeUserChainEntry parses a provider-prefixed object model", () => {
  expect(normalizeUserChainEntry({ model: "anthropic/claude-opus-5-5", reasoning: "medium" }))
    .toEqual({ providers: ["anthropic"], model: "claude-opus-5-5" })
})

test("an object entry as the FIRST user chain rung is the selected model", async () => {
  const result = await resolveCategory({
    model: { list: async () => ({ data: [
      { providerID: "anthropic", id: "claude-opus-5-5", enabled: true },
      { providerID: "openai", id: "gpt-6-luna-fast", enabled: true },
      { providerID: "opencode-go", id: "deepseek-flash", enabled: true },
    ] }) },
  }, { directory: "/project" }, "quick", {
    userCategories: { quick: { models: [
      { model: "anthropic/claude-opus-5-5", reasoning: "medium" },
      "openai/gpt-6-luna-fast",
      "opencode-go/deepseek-flash",
    ] } },
  })
  expect(result.model).toEqual({ providerID: "anthropic", id: "claude-opus-5-5" })
})

test("an object entry in SECOND position is picked when the head is unavailable", async () => {
  const result = await resolveCategory({
    model: { list: async () => ({ data: [
      { providerID: "anthropic", id: "claude-opus-5-5", enabled: true },
    ] }) },
  }, { directory: "/project" }, "quick", {
    userCategories: { quick: { models: ["openai/gpt-6-luna-fast", { model: "anthropic/claude-opus-5-5" }] } },
  })
  expect(result.model).toEqual({ providerID: "anthropic", id: "claude-opus-5-5" })
})

test("an object entry in LAST position is picked when every earlier rung is unavailable", async () => {
  const result = await resolveCategory({
    model: { list: async () => ({ data: [
      { providerID: "anthropic", id: "claude-opus-5-5", enabled: true },
    ] }) },
  }, { directory: "/project" }, "quick", {
    userCategories: { quick: { models: [
      "openai/gpt-6-luna-fast",
      "opencode-go/deepseek-flash",
      { model: "anthropic/claude-opus-5-5" },
    ] } },
  })
  expect(result.model).toEqual({ providerID: "anthropic", id: "claude-opus-5-5" })
})

test("an object-only chain does not throw when its model is the only one available", async () => {
  const result = await resolveCategory({
    model: { list: async () => ({ data: [
      { providerID: "anthropic", id: "claude-opus-5-5", enabled: true },
    ] }) },
  }, { directory: "/project" }, "quick", {
    userCategories: { quick: { models: [{ model: "anthropic/claude-opus-5-5", reasoning: "medium" }] } },
  })
  expect(result.model).toEqual({ providerID: "anthropic", id: "claude-opus-5-5" })
  expect(result.explicit).toBe(true)
})

test("an explicit providers list in an object entry wins over the model prefix", async () => {
  expect(normalizeUserChainEntry({ model: "anthropic/claude-opus-5-5", providers: ["deepseek"] }))
    .toEqual({ providers: ["deepseek"], model: "claude-opus-5-5" })
  // Behavioural proof: the prefix provider is never consulted when the entry
  // declares its own provider list.
  const result = await resolveCategory({
    model: { list: async () => ({ data: [
      { providerID: "deepseek", id: "claude-opus-5-5", enabled: true },
    ] }) },
  }, { directory: "/project" }, "quick", {
    userCategories: { quick: { models: [{ model: "anthropic/claude-opus-5-5", providers: ["deepseek"] }] } },
  })
  expect(result.model).toEqual({ providerID: "deepseek", id: "claude-opus-5-5" })
})

test("a bare object model without a prefix keeps its provider-less shape", () => {
  expect(normalizeUserChainEntry({ model: "claude-opus-5-5" }))
    .toEqual({ providers: [], model: "claude-opus-5-5" })
})

test("fallback_models normalizes an object entry like a string one", () => {
  expect(normalizeUserChain([{ model: "anthropic/claude-opus-5-5", reasoning: "medium" }, "openai/gpt-6-luna-fast(low)"]))
    .toEqual([
      { providers: ["anthropic"], model: "claude-opus-5-5" },
      { providers: ["openai"], model: "gpt-6-luna-fast", variant: "low" },
    ])
})
