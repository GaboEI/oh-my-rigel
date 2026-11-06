import { z } from "zod"
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
  channels: z.record(z.string(), OpenClawChannelSchema).optional(),
  replyPolicy: z.record(z.string(), OpenClawReplyPolicySchema).optional(),
})

export type OpenClawConfig = z.infer<typeof OpenClawConfigSchema> & CoreOpenClawConfig
export type OpenClawGateway = z.infer<typeof OpenClawGatewaySchema> & CoreOpenClawGateway
export type OpenClawHook = z.infer<typeof OpenClawHookSchema> & CoreOpenClawHook
export type OpenClawReplyListenerConfig =
  z.infer<typeof OpenClawReplyListenerConfigSchema> & CoreOpenClawReplyListenerConfig
