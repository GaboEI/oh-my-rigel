import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { OmoConfigSchema } from "../packages/omo-config-core/src/schema"
import { OhMyOpenCodeConfigSchema } from "../packages/omo-opencode/src/config/schema/oh-my-opencode-config"
import { createOmoJsonSchema } from "../script/build-omo-schema-document"

const REPO_ROOT = join(import.meta.dir, "..")
const SCHEMA_PATH = join(REPO_ROOT, "assets", "omo.schema.json")
const DOC_PATH = join(REPO_ROOT, "docs", "reference", "omo-json.md")

type JsonSchemaNode = {
  readonly type?: string
  readonly required?: readonly string[]
  readonly anyOf?: readonly JsonSchemaNode[]
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>
  readonly additionalProperties?: JsonSchemaNode
}

function extractSchemaExample(markdown: string): unknown {
  const fences = markdown.match(/```json\n([\s\S]*?)```/g) ?? []
  for (const fence of fences) {
    const body = fence.replace(/```json\n/, "").replace(/```$/, "")
    if (body.includes("\"$schema\"")) return JSON.parse(body)
  }
  throw new Error("no $schema-bearing json example found in omo-json.md")
}

describe("omo schema freshness", () => {
  test("#given the current Zod schema #when regenerated #then it matches the committed artifact", () => {
    // given
    const committed = readFileSync(SCHEMA_PATH, "utf-8")

    // when
    const regenerated = JSON.stringify(createOmoJsonSchema(), null, 2)

    // then
    expect(regenerated).toBe(committed)
  })

  test("#given the docs example omo.json #when parsed by OmoConfigSchema #then it validates", () => {
    // given
    const example = extractSchemaExample(readFileSync(DOC_PATH, "utf-8"))

    // when
    const result = OmoConfigSchema.safeParse(example)

    // then
    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error.message)
  })

  test("#given the docs example #when read #then it points at the documented dev-branch schema URL", () => {
    // given
    const example = extractSchemaExample(readFileSync(DOC_PATH, "utf-8")) as { readonly $schema?: string }

    // when
    const schemaUrl = example.$schema

    // then
    expect(schemaUrl).toBe(
      "https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/dev/assets/omo.schema.json",
    )
  })

  test("#given the generated schema #when the OpenClaw credentials are inspected #then both reference forms are accepted and no token is required", () => {
    // given
    const schema = createOmoJsonSchema() as { readonly properties: Readonly<Record<string, JsonSchemaNode>> }

    // when
    const openclaw = schema.properties.openclaw
    const replyListener = openclaw?.properties?.replyListener
    const discordBotToken = replyListener?.properties?.discordBotToken

    // then
    // A default on the token would make the generator mark it `required` and
    // invalidate every existing configuration, so the absence of `required` is
    // the property that makes the reference form non-breaking.
    expect(openclaw?.required ?? []).not.toContain("replyListener")
    expect(replyListener?.required ?? []).toEqual([])
    expect(discordBotToken?.anyOf?.map((branch) => branch.type)).toEqual(["string", "object"])
    expect(discordBotToken?.anyOf?.[1]?.required).toEqual(["env"])
  })

  test("#given the generated schema #when the strict OpenCode OpenClaw node is inspected #then namespace nodes are optional and token fields retain the decided string shape", () => {
    // given
    const schema = createOmoJsonSchema() as { readonly properties: Readonly<Record<string, JsonSchemaNode>> }
    const profiles = schema.properties.profiles
    const openCode = profiles?.additionalProperties?.properties?.["[opencode]"]
    const openclaw = openCode?.properties?.openclaw
    const replyListener = openclaw?.properties?.replyListener
    const discordBotToken = replyListener?.properties?.discordBotToken

    // when
    const required = openclaw?.required ?? []

    // then
    expect(openclaw?.properties?.channels).toBeDefined()
    expect(openclaw?.properties?.replyPolicy).toBeDefined()
    expect(required).not.toContain("channels")
    expect(required).not.toContain("replyPolicy")
    expect(replyListener?.required ?? []).toEqual([])
    expect(discordBotToken?.type).toBe("string")
  })
})

/**
 * The published `[opencode]` node is generated from `OhMyOpenCodeConfigSchema`, so
 * this is the schema an author of `openclaw.channels` is actually validated
 * against. `channels.a2a` is the A2A converser's reserved namespace (vendor
 * contract §2.7), not a notification channel, and `resolveOpenclawAgentPeers`
 * accepts exactly `enabled`, `advertisedUrl` and `peers`, with `url`, `token`,
 * `outboundToken` and `replyTimeoutMs` per peer. Tokens below are references, so
 * no secret material reaches this file.
 */
const A2A_CHANNELS = {
  a2a: {
    enabled: true,
    advertisedUrl: "https://rigel.example.test",
    peers: {
      alpha: { token: "env:ALPHA_TOKEN", url: "http://127.0.0.1:4011" },
      beta: { token: { env: "BETA_TOKEN" }, outboundToken: "env:BETA_OUTBOUND_TOKEN", replyTimeoutMs: 30000 },
    },
  },
  alerts: { transport: "telegram", token: "env:TELEGRAM_BOT_TOKEN", chatId: "-100200300" },
}

describe("omo openclaw channels.a2a schema", () => {
  test("#given a valid channels.a2a peer configuration #when parsed by the schema #then it is accepted", () => {
    // given
    const config = { openclaw: { enabled: true, channels: A2A_CHANNELS } }

    // when
    const parsed = OhMyOpenCodeConfigSchema.safeParse(config)

    // then
    if (!parsed.success) throw new Error(parsed.error.message)
    // The block must be MODELLED, not dropped: a node the schema does not know
    // is what the published artifact turns into `additionalProperties: false`.
    expect(parsed.data.openclaw?.channels?.a2a).toEqual(A2A_CHANNELS.a2a)
    expect(parsed.data.openclaw?.channels?.alerts).toEqual(A2A_CHANNELS.alerts)
  })

  test("#given an a2a block with an undeclared key #when parsed by the schema #then it is rejected", () => {
    // given
    const config = {
      openclaw: { enabled: true, channels: { a2a: { enabled: true, peerz: { alpha: { token: "env:ALPHA" } } } } },
    }

    // when
    const parsed = OhMyOpenCodeConfigSchema.safeParse(config)

    // then
    expect(parsed.success).toBe(false)
  })

  test("#given the generated schema #when the channels node is inspected #then a2a is typed and no node is left open", () => {
    // given
    const schema = createOmoJsonSchema() as { readonly properties: Readonly<Record<string, JsonSchemaNode>> }
    const openclaw = schema.properties.profiles?.additionalProperties?.properties?.["[opencode]"]?.properties?.openclaw
    const channels = openclaw?.properties?.channels
    const a2a = channels?.properties?.a2a
    const peers = a2a?.properties?.peers

    // when
    const catchAll = channels?.additionalProperties
    const peerCatchAll = peers?.additionalProperties

    // then
    expect(a2a?.properties?.enabled?.type).toBe("boolean")
    expect(peers?.type).toBe("object")
    expect(a2a?.required ?? []).not.toContain("peers")
    expect(a2a?.additionalProperties).toBe(false)
    expect(peerCatchAll).not.toBe(true)
    expect(catchAll).not.toBe(true)
    expect(catchAll?.properties?.transport).toBeDefined()
    expect(channels?.required ?? []).not.toContain("a2a")
  })
})
