import { z } from "zod"
import { OmoOpenclawSecretRefSchema } from "@oh-my-opencode/omo-config-core"
import type {
  OpenClawConfig as CoreOpenClawConfig,
  OpenClawGateway as CoreOpenClawGateway,
  OpenClawHook as CoreOpenClawHook,
  OpenClawReplyListenerConfig as CoreOpenClawReplyListenerConfig,
} from "@oh-my-opencode/openclaw-core"

export const OpenClawGatewaySchema = z.object({
  type: z.enum(["http", "command"]).default("http"),
  // HTTP specific
  url: z.string().optional(),
  method: z.string().default("POST"),
  headers: z.record(z.string(), z.string()).optional(),
  // Command specific
  command: z.string().optional(),
  // Shared
  timeout: z.number().optional(),
})

export const OpenClawHookSchema = z.object({
  enabled: z.boolean().default(true),
  gateway: z.string(),
  instruction: z.string(),
})

export const OpenClawReplyListenerConfigSchema = z.object({
  discordBotToken: z.string().optional(),
  discordChannelId: z.string().optional(),
  authorizedDiscordUserIds: z.array(z.string()).optional(),

  telegramBotToken: z.string().optional(),
  telegramChatId: z.string().optional(),

  pollIntervalMs: z.number().optional(),
  rateLimitPerMinute: z.number().optional(),
  maxMessageLength: z.number().optional(),
  includePrefix: z.boolean().optional(),
})

const OpenClawChannelSchema = z.object({
  transport: z.enum(["discord", "telegram"]).optional(),
  token: z.string().optional(),
  channelId: z.union([z.string(), z.number()]).optional(),
  chatId: z.union([z.string(), z.number()]).optional(),
  instruction: z.string().optional(),
  events: z.array(z.enum(["session.created", "session.deleted", "session.idle"])).optional(),
})

/**
 * One `channels.a2a.peers.<name>` block. The keys are `PEER_KEYS` from the A2A
 * resolver (`profiles/gabo/opencode/rigel-v2-native-openclaw-agent-transport.mjs:65`),
 * which fails closed with an `unknown-key` diagnostic on anything else, so the node
 * is strict. The credential shape is the decided reference form shared with the
 * neutral schema (`OmoOpenclawSecretRefSchema`), never a schema-only widening.
 *
 * `url`, `replyTimeoutMs` and the environment a token names are NOT pinned to their
 * runtime-valid values here: an invalid one drops exactly that peer with a
 * diagnostic while the rest of the configuration keeps working, so turning it into
 * a whole-file schema error would reject a configuration the runtime accepts.
 */
const OpenClawA2aPeerSchema = z
  .object({
    url: z.string().optional(),
    token: OmoOpenclawSecretRefSchema.optional(),
    outboundToken: OmoOpenclawSecretRefSchema.optional(),
    replyTimeoutMs: z.number().optional(),
  })
  .strict()

/**
 * `channels.a2a` is the A2A converser's reserved node, not a notification
 * channel: the resolver reads exactly `A2A_KEYS`
 * (`rigel-v2-native-openclaw-agent-transport.mjs:62`) and the notification
 * resolver skips the name entirely. Typing it here is what lets the generated
 * artifact stop rejecting a configuration the runtime serves.
 */
const OpenClawA2aChannelSchema = z
  .object({
    enabled: z.boolean().optional(),
    advertisedUrl: z.string().optional(),
    peers: z.record(z.string(), OpenClawA2aPeerSchema).optional(),
  })
  .strict()

/**
 * `channels` holds the reserved `a2a` node plus one notification channel per
 * remaining key, which keep the strict channel shape: the node stays bounded,
 * never an open record.
 */
const OpenClawChannelsSchema = z
  .object({ a2a: OpenClawA2aChannelSchema.optional() })
  .catchall(OpenClawChannelSchema)

const OpenClawReplyPolicySchema = z.object({
  allowedAuthors: z.array(z.string()).min(1).optional(),
})

export const OpenClawConfigSchema = z.object({
  enabled: z.boolean().default(false),

  // Outbound Configuration
  gateways: z.record(z.string(), OpenClawGatewaySchema).default({}),
  hooks: z.record(z.string(), OpenClawHookSchema).default({}),

  // Inbound Configuration (Reply Listener)
  replyListener: OpenClawReplyListenerConfigSchema.optional(),
  channels: OpenClawChannelsSchema.optional(),
  replyPolicy: z.record(z.string(), OpenClawReplyPolicySchema).optional(),
})

export type OpenClawConfig = z.infer<typeof OpenClawConfigSchema> & CoreOpenClawConfig
export type OpenClawGateway = z.infer<typeof OpenClawGatewaySchema> & CoreOpenClawGateway
export type OpenClawHook = z.infer<typeof OpenClawHookSchema> & CoreOpenClawHook
export type OpenClawReplyListenerConfig =
  z.infer<typeof OpenClawReplyListenerConfigSchema> & CoreOpenClawReplyListenerConfig
