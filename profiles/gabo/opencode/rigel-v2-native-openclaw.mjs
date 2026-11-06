/**
 * Native V2 OpenClaw composition: the runtime-owned, bidirectional OpenClaw
 * surface. It binds the four pure halves together and exposes the three effects
 * the V2 runtime needs:
 *
 *   - `handleEvent(event)` is the OUTBOUND entry. The runtime calls it from its
 *     existing shared `ctx.event.subscribe` loop, so OpenClaw never opens a
 *     second subscription; an event whose hook has no gateway is a no-op.
 *   - `ready` is the INBOUND lifecycle. Construction starts the reply listener
 *     (owned by `setup`), and `dispose()` stops it, so no listener outlives the
 *     plugin. With no `replyListener` credentials the listener never starts and
 *     no request is made.
 *   - `status()` is the observability surface (enabled, listener started,
 *     registry size) for live QA.
 *   - `report()` is the DERIVED state report `/openclaw-status` renders: the
 *     status document plus the two composition-level facts (enabled, started).
 *     `hasReport()` decides whether that command is worth registering at all.
 *   - `agentCore` is the NEW namespace's correlation key space, bounded queue and
 *     status document. It is built only when `channels` names an identity, so a
 *     legacy config never constructs it and its call sequence cannot move.
 *   - the NEW namespace's notification channels (U5) are resolved ONCE here
 *     (`channels.<name>` → Discord/Telegram endpoints) and handed to the
 *     outbound route. A legacy config resolves none, which is what keeps
 *     "legacy only" free of any new Discord/Telegram send.
 *   - the NEW namespace's reply authorization (U6) is resolved ONCE here too
 *     (`replyPolicy.<identity>.allowedAuthors`), reported when it authorizes
 *     nobody, and handed to the inbound listener as the ONLY source of
 *     authorized authors. A config that never declares it keeps the legacy
 *     silent disablement.
 *   - the Telegram user filter (U7) reuses that same resolution. Telegram has no
 *     legacy user list (defect 8: it filters by chat only), so while the new
 *     namespace is in play its absence is a REPORTED configuration error with the
 *     poller down, and the listener gets the list as its only filter. A legacy
 *     config keeps the chat-only filter byte for byte.
 *
 * The single strict gate is the normalized config: `normalizeOpenclawConfig`
 * returns `null` unless `enabled === true`, so an absent or disabled block means
 * zero dispatch, zero listener and zero network. Every other effect keys off
 * that one gate.
 *
 * Only sibling native modules are imported so the flat laboratory runtime can
 * load this module.
 */
import { normalizeOpenclawConfig } from "./rigel-v2-native-openclaw-core.mjs"
import { projectOpenclawEndpointIdentities } from "./rigel-v2-native-openclaw-identity.mjs"
import { resolveOpenclawReplyListenerSecrets } from "./rigel-v2-native-openclaw-secrets.mjs"
import { createOpenclawOutbound } from "./rigel-v2-native-openclaw-outbound.mjs"
import { createOpenclawInbound, createInternalPromptGate } from "./rigel-v2-native-openclaw-inbound.mjs"
import { createOpenclawRegistry } from "./rigel-v2-native-openclaw-registry.mjs"
import { createOpenclawAgentRegistry, resolveOpenclawAgentNamespace } from "./rigel-v2-native-openclaw-agent-registry.mjs"
import { createOpenclawAgentQueue } from "./rigel-v2-native-openclaw-agent-queue.mjs"
import { createOpenclawStatusDocument } from "./rigel-v2-native-openclaw-agent-status.mjs"
import { createOpenclawAgentTransport, describeOpenclawAgentPeerDiagnostic, resolveOpenclawAgentPeers } from "./rigel-v2-native-openclaw-agent-transport.mjs"
import { createOpenclawAgentResponder } from "./rigel-v2-native-openclaw-agent-responder.mjs"
import { describeOpenclawChannelDiagnostic, resolveOpenclawNotificationChannels } from "./rigel-v2-native-openclaw-notification.mjs"
import { authorizeDiscordAuthors, authorizeTelegramAuthors, describeOpenclawReplyPolicyDiagnostic, resolveOpenclawReplyPolicy } from "./rigel-v2-native-openclaw-reply-policy.mjs"

/**
 * Build the new namespace's core over the same storage domain the chat registry
 * uses. Four independent pieces, no network and no host API beyond storage:
 *
 *   - `registry` is the agent key space (`rigel-v2/openclaw/agent/`), which is
 *     where the durable single-in-flight slot lives;
 *   - `queue` is the bounded structure the conversational path must cross, so a
 *     120 s send can never block the shared event iterable;
 *   - `status` is the `rigel-v2/openclaw/status` document the report is derived
 *     from. It is INJECTED, not built here: the composition owns one document, so
 *     the legacy surfaces (outbound, discord, telegram, injection, config,
 *     credentials) and the agent namespace report into the same storage key
 *     instead of overwriting each other;
 *   - `transport` + `responder` (U11) are the conversational path: the JSON-RPC
 *     client that speaks `SendMessage`/`GetTask`, and the reconciliation half that
 *     injects answers through the SAME internal-prompt gate the chat responder
 *     uses. Both are inert until a peer is resolved, so a `channels` block with no
 *     usable peer costs nothing.
 *
 * `hydrate()` reads the durable halves once at setup. It performs storage reads
 * only: zero network, which is the invariant the whole unit is measured against.
 */
function createAgentCore({ context, namespace, peers, now, log, status, fetchImpl, deliverAgentReply }) {
  const registry = createOpenclawAgentRegistry({ storage: context?.storage, now, log })
  const queue = createOpenclawAgentQueue({ registry, status, now, log })
  const transport = createOpenclawAgentTransport({ peers, fetchImpl, log })
  const responder = createOpenclawAgentResponder({
    peers,
    registry,
    queue,
    transport,
    status,
    deliverAgentReply,
    now,
    log,
  })
  return {
    namespace,
    registry,
    queue,
    status,
    transport,
    responder,
    async hydrate() {
      await registry.hydrate()
      await status.hydrate()
    },
    outline() {
      return {
        namespace: { identities: [...namespace.identities], peers: [...namespace.peers], a2a: namespace.a2aEnabled },
        pending: queue.pendingTotal(),
        records: registry.size(),
        inflight: registry.inflightCount(),
        surfaces: status.snapshot().surfaces,
        // The peers the transport can actually dial. The namespace's `peers` above
        // is what the configuration declares; this list is what survived U11's
        // validation, so the difference is visible instead of silent.
        dialablePeers: transport.peerNames(),
      }
    },
    async dispose() {
      await responder.shutdown()
      responder.dispose()
      queue.clearAll()
    },
  }
}

/**
 * Compose the OpenClaw surface over a V2 setup context.
 *
 * @param {object} [options]
 * @param {object} [options.context] the V2 setup context (`storage`, `session`)
 * @param {object} [options.config] the materialized `openclaw` profile block
 * @param {typeof fetch} [options.fetchImpl] outbound HTTP + inbound poll transport
 * @param {Function} [options.spawnImpl] outbound command transport
 * @param {Record<string, string|undefined>} [options.env]
 * @param {string} [options.platform]
 * @param {(line: string) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {(sessionID: string) => boolean} [options.isSubagentSession]
 * @param {"declared"|"undeclared"|"error"} [options.configState] the live-resolution
 *   state the caller resolved the block from (`resolveNativeOpenclaw`). `error`
 *   means the live chain could not be read, which is a FATAL for the surface and
 *   is mirrored into the status document.
 */
export function createNativeOpenclaw({
  context,
  config,
  fetchImpl,
  spawnImpl,
  env = process.env,
  platform = process.platform,
  log = () => {},
  now,
  isSubagentSession,
  configState,
} = {}) {
  // U4: ONE status document for the whole surface, created before anything can
  // fail so a setup fatal has somewhere to be recorded.
  const statusDocument = createOpenclawStatusDocument({ storage: context?.storage, now, log })
  /** Fatals setup already announced on its own line; recorded without a second. */
  const setupFatals = []

  let configError = null
  const normalized = normalizeOpenclawConfig(config, {
    onInvalid: (error) => {
      configError = error
      log(`[oh-my-rigel] Native V2 ${error.name}: ${error.message}`)
    },
  })
  const enabled = normalized !== null

  // Credential references (`"env:VAR"` / `{ env: "VAR" }`) resolve ONCE, here at
  // setup, never per send: a broken reference is one reported line instead of one
  // per event. An unresolvable or malformed reference removes only that surface's
  // token, so the listener's own presence rule keeps exactly that platform down
  // while the others stay up (fail closed per surface, never per plugin). The
  // diagnostic names the configuration key and the variable, never a value.
  const secrets = enabled
    ? resolveOpenclawReplyListenerSecrets(normalized.replyListener, { env })
    : { replyListener: undefined, diagnostics: [], disabled: [] }
  for (const diagnostic of secrets.diagnostics) log(`[oh-my-rigel] Native V2 openclaw ${diagnostic}`)

  // The NEW namespace's notification channels (U5). Resolution happens once,
  // here at setup, never per send (§8), and it reads the RAW block because
  // `channels` is not part of the normalized legacy shape. A legacy
  // configuration has no `channels`, so this resolves zero endpoints and no new
  // Discord/Telegram send can exist for it. A channel that fails a check stays
  // disabled and reports one named line: never in silence (criterion 4).
  const notifications = enabled
    ? resolveOpenclawNotificationChannels(config?.channels, { env })
    : { channels: [], diagnostics: [] }
  for (const diagnostic of notifications.diagnostics) {
    log(`[oh-my-rigel] Native V2 openclaw ${describeOpenclawChannelDiagnostic(diagnostic)}`)
  }

  // The NEW namespace's REPLY POLICY (U6). `openclaw.replyPolicy.<identity>` is
  // the authorization the reply surface applies (`Contrato_Transportes_OpenClaw.md`
  // §5.1), resolved once here like every other setup-time decision. Declaring it
  // is what makes Discord authorization explicit, and a declared policy that
  // authorizes nobody is a REPORTED configuration error instead of the silent
  // disablement the legacy gate has always produced.
  const replyPolicy = enabled
    ? resolveOpenclawReplyPolicy(config?.replyPolicy)
    : { declared: false, identities: [], diagnostics: [] }
  for (const diagnostic of replyPolicy.diagnostics) {
    log(`[oh-my-rigel] Native V2 openclaw ${describeOpenclawReplyPolicyDiagnostic(diagnostic)}`)
  }

  // §5.2 rule 2 governs a named chat identity only. Raw named malformed entries
  // remain visible through `chatIdentities`; valid notification endpoints add their
  // served platform. Reserved `a2a` remains out of this chat key space.
  const agentNamespace = resolveOpenclawAgentNamespace(config)
  const channelChatIdentities = new Set(agentNamespace.chatIdentities)
  for (const channel of notifications.channels) {
    channelChatIdentities.add(channel.transport === "discord" ? "discord-bot" : "telegram")
  }
  const endpointIdentities = projectOpenclawEndpointIdentities({ normalized, config })
  const collidingEndpointIdentity = endpointIdentities.legacy.find((identity) => endpointIdentities.channels.includes(identity))

  // U11: the NEW namespace's A2A converser. Peer resolution happens ONCE here and
  // performs no network at all: the agent card is discovered lazily, on the first
  // send (§11.3). A peer with a broken secret reference, an invalid URL, an
  // unknown key or a duplicate token is dropped and named, never ignored.
  const agentPeers = enabled && agentNamespace.a2aDeclared
    ? resolveOpenclawAgentPeers(config?.channels?.a2a, { env })
    : { declared: false, enabled: false, peers: [], diagnostics: [], disabled: [] }
  for (const diagnostic of agentPeers.diagnostics) {
    log(`[oh-my-rigel] Native V2 openclaw ${describeOpenclawAgentPeerDiagnostic(diagnostic)}`)
  }
  const legacyAuthorizedAuthors = Array.isArray(normalized?.replyListener?.authorizedDiscordUserIds)
    ? normalized.replyListener.authorizedDiscordUserIds
    : []
  const hasDiscordInbound = Boolean(secrets.replyListener?.discordBotToken && secrets.replyListener?.discordChannelId)
  const hasTelegramInbound = Boolean(secrets.replyListener?.telegramBotToken && secrets.replyListener?.telegramChatId)
  /** Identities the policy resolver already rejected: its line is their one line. */
  const reportedIdentities = new Set(
    replyPolicy.diagnostics.map((diagnostic) => diagnostic.identity).filter((identity) => typeof identity === "string"),
  )
  const replyPolicyIdentities = new Set([
    ...replyPolicy.identities.map((entry) => entry.identity),
    ...reportedIdentities,
  ])
  const discordReplyPolicyGoverned = replyPolicyIdentities.has("discord-bot")
  const discordNamespaceGoverned = channelChatIdentities.has("discord-bot") || discordReplyPolicyGoverned
  const telegramNamespaceGoverned = channelChatIdentities.has("telegram") || replyPolicyIdentities.has("telegram") || replyPolicy.declared

  // §U6: a named Discord policy replaces the legacy list. A Discord notification
  // channel still requires the existing legacy list, while Telegram policy cannot
  // alter Discord's route.
  const discordAuthorization = authorizeDiscordAuthors(replyPolicy)
  const discordAuthorized = discordReplyPolicyGoverned ? discordAuthorization.explicit : legacyAuthorizedAuthors.length > 0
  const unauthorizedDiscordInNewNamespace = enabled
    && hasDiscordInbound
    && discordNamespaceGoverned
    && !discordAuthorized
    && !reportedIdentities.has("discord-bot")

  // §U7: a Telegram-owned new channel or policy requires an explicit user list.
  // Any declared reply policy also keeps Telegram on the secure route: dropping
  // that requirement when a Discord policy exists would restore the legacy
  // chat-only poller, which is an unauthorized permissive transition.
  const telegramAuthorization = enabled && telegramNamespaceGoverned ? authorizeTelegramAuthors(replyPolicy) : undefined
  const unauthorizedTelegramInNewNamespace = telegramAuthorization !== undefined
    && hasTelegramInbound
    && !telegramAuthorization.explicit
    && !reportedIdentities.has("telegram")

  const authorizationReports = []
  if (unauthorizedDiscordInNewNamespace) {
    authorizationReports.push({
      surface: "discord",
      detail: discordReplyPolicyGoverned
        ? "openclaw.replyPolicy.discord-bot.allowedAuthors"
        : "openclaw.replyListener.authorizedDiscordUserIds",
      line: discordReplyPolicyGoverned
        ? "[oh-my-rigel] Native V2 openclaw Discord replies stay off: openclaw.replyPolicy.discord-bot.allowedAuthors is not declared, so no author is authorized"
        : "[oh-my-rigel] Native V2 openclaw Discord replies stay off: openclaw.channels.discord is declared but openclaw.replyListener.authorizedDiscordUserIds is empty, so no author is authorized",
    })
  }
  if (unauthorizedTelegramInNewNamespace) {
    authorizationReports.push({
      surface: "telegram",
      detail: "openclaw.replyPolicy.telegram.allowedAuthors",
      line: replyPolicyIdentities.has("telegram") || replyPolicy.declared
        ? "[oh-my-rigel] Native V2 openclaw Telegram replies stay off: openclaw.replyPolicy.telegram.allowedAuthors is not declared, so no user is authorized"
        : "[oh-my-rigel] Native V2 openclaw Telegram replies stay off: openclaw.channels.telegram is declared but openclaw.replyPolicy.telegram.allowedAuthors is not, so no user is authorized",
    })
  }
  for (const report of authorizationReports) log(report.line)

  // Mirror the fatals setup just announced into the document, so `/openclaw-status`
  // can explain WHY a surface is down. `emitLine:false` is deliberate: the line
  // above is the banner, and a second line for one transition would break the
  // one-line-per-transition rule the unit is measured by.
  if (configError !== null) {
    setupFatals.push({
      surface: "config",
      errorClass: configError.name,
      detail: configError.message,
    })
  } else if (configState === "error") {
    setupFatals.push({ surface: "config", errorClass: "live-config-error", detail: null })
  }
  if (collidingEndpointIdentity !== undefined) {
    setupFatals.push({
      surface: "config.identity-collision",
      errorClass: `identity-collision:${collidingEndpointIdentity}`,
      detail: collidingEndpointIdentity,
    })
  }
  for (const failure of secrets.disabled) {
    setupFatals.push({
      surface: `credentials.${failure.surface}`,
      errorClass: failure.reason,
      detail: failure.path,
    })
  }
  for (const diagnostic of notifications.diagnostics) {
    setupFatals.push({
      surface: `channels.${typeof diagnostic.path === "string" ? diagnostic.path.split(".")[2] : "unknown"}`,
      errorClass: diagnostic.reason,
      detail: diagnostic.path,
    })
  }
  for (const report of authorizationReports) {
    setupFatals.push({ surface: report.surface, errorClass: "missing-authorized-authors", detail: report.detail })
  }
  for (const diagnostic of replyPolicy.diagnostics) {
    setupFatals.push({
      // A missing authorization disables that reply surface, so the document says
      // `discord` or `telegram`; a structural mistake about an identity this
      // runtime does not serve is a configuration fault with no disabled surface,
      // so it reports under `replyPolicy`. The exact path always travels as
      // `detail`, never an author id.
      surface: diagnostic.identity === "discord-bot"
        ? "discord"
        : diagnostic.identity === "telegram"
          ? "telegram"
          : "replyPolicy",
      errorClass: diagnostic.reason,
      detail: diagnostic.path,
    })
  }
  for (const diagnostic of agentPeers.diagnostics) {
    setupFatals.push({
      // A peer-level fault disables exactly that peer; a channel-level fault closes
      // the whole A2A surface, so the document distinguishes the two.
      surface: typeof diagnostic.peer === "string" ? `a2a.${diagnostic.peer}` : "a2a",
      errorClass: diagnostic.reason,
      detail: diagnostic.path,
    })
  }

  // The registry is the durable correlation store; `ctx.storage` is the V2
  // domain, and an absent one still works from the in-process index.
  const registry = createOpenclawRegistry({ storage: context?.storage, now, log })

  // The inbound listener delivers ONLY through the internal prompt gate: the V2
  // equivalent of V1's `tmux send-keys` injection, but a real queued session
  // prompt the host has to accept. The agent responder reuses the SAME gate, so
  // there is exactly one chokepoint an injected text can cross (§2).
  const deliverInboundReply = createInternalPromptGate({ session: context?.session })

  // The agent core is separate from chat namespace governance. Only the reserved
  // A2A declaration constructs its queue and registry; named chat channels cannot
  // create agent state.
  const agentCore = enabled && agentNamespace.a2aDeclared
    ? createAgentCore({
      context,
      namespace: agentNamespace,
      // Only the peers that survived validation: an empty list builds an inert
      // core whose responder never starts, which is what a `channels` block
      // without a usable peer must cost.
      peers: agentPeers.peers,
      now,
      log,
      status: statusDocument,
      fetchImpl,
      deliverAgentReply: deliverInboundReply,
    })
    : null

  const outbound = createOpenclawOutbound({
    config: normalized,
    registry,
    fetchImpl,
    spawnImpl,
    env,
    platform,
    log,
    now,
    isSubagentSession,
    statusDocument,
    notificationChannels: notifications.channels,
  })

  const inbound = createOpenclawInbound({
    replyListener: secrets.replyListener,
    registry,
    deliverInboundReply,
    fetchImpl,
    log,
    now,
    statusDocument,
    // §U8: the cursor is the poller's mutable state, so the poller owns it, while
    // the storage domain is the composition's to hand over. Absent, the cursor
    // stays in the process, which is exactly the pre-U8 behaviour.
    storage: context?.storage,
    // §U6: only a named Discord reply policy replaces the legacy author list.
    // A Discord notification channel retains the pinned legacy authorization path.
    ...(discordReplyPolicyGoverned ? { discordAuthorization } : {}),
    // §U7: undefined preserves the legacy chat-only route; every declared reply
    // policy remains a security boundary that prevents reopening it.
    ...(telegramAuthorization === undefined ? {} : { telegramAuthorization }),
    ...(typeof env?.RIGEL_OPENCLAW_DISCORD_API_BASE === "string"
      ? { discordApiBase: env.RIGEL_OPENCLAW_DISCORD_API_BASE }
      : {}),
    // The Telegram half of the same lab seam: the notification transport reads
    // the variable itself, and the poller must dial the same base for the reply
    // loop the notification opens to be reachable end to end.
    ...(typeof env?.RIGEL_OPENCLAW_TELEGRAM_API_BASE === "string"
      ? { telegramApiBase: env.RIGEL_OPENCLAW_TELEGRAM_API_BASE }
      : {}),
  })

  /**
   * Record the setup fatals the validation/credential paths already announced,
   * exactly once per surface, before anything starts. This runs on the startup
   * path (`ready` is awaited by setup), which is what makes the record a startup
   * banner rather than a line discovered later.
   */
  async function recordSetupFatals() {
    for (const fatal of setupFatals) {
      await statusDocument.recordFailure(fatal.surface, {
        errorClass: fatal.errorClass,
        fatal: true,
        emitLine: false,
        detail: fatal.detail,
      })
    }
  }

  const ready = (async () => {
    await recordSetupFatals()
    if (collidingEndpointIdentity !== undefined) return { started: false, reason: "identity-collision" }
    if (!enabled) return { started: false, reason: "disabled" }
    try {
      await registry.hydrate()
    } catch (error) {
      log(`[oh-my-rigel] Native V2 openclaw registry hydrate failed: ${error instanceof Error ? error.message : String(error)}`)
      await statusDocument.recordFailure("registry", { errorClass: "hydrate-failed" })
    }
    if (agentCore) {
      try {
        // Storage reads only. The discovery of the vendor endpoint stays lazy in
        // the first send, never in setup.
        await agentCore.hydrate()
      } catch (error) {
        log(`[oh-my-rigel] Native V2 openclaw agent core hydrate failed: ${error instanceof Error ? error.message : String(error)}`)
        await statusDocument.recordFailure("agent-core", { errorClass: "hydrate-failed" })
      }
      // Reconciliation starts only when a peer survived validation. It is a timer,
      // not a request, so setup still performs zero network; and a core without a
      // dialable peer never schedules anything.
      if (agentPeers.peers.length > 0) {
        const reconciling = agentCore.responder.start()
        if (!reconciling.started) {
          log(`[oh-my-rigel] Native V2 openclaw a2a reconciliation did not start: ${reconciling.reason}`)
        }
      }
    }
    const started = await inbound.start()
    return started.started ? { started: true } : { started: false, reason: started.reason ?? "no-credentials" }
  })()

  async function handleEvent(event) {
    if (!enabled) return null
    const result = await outbound.handleEvent(event)
    // A successful wake that returned correlation metadata just wrote a fresh
    // registry mapping; wake the listener so a reply quoting that message is
    // delivered on the next poll instead of after a full interval. `wake()` is a
    // no-op while the listener is not running, so an outbound-only config pays
    // nothing.
    if (result !== null && result.success === true && typeof result.messageId === "string" && typeof result.platform === "string" && event?.type !== "session.deleted") {
      inbound.wake()
    }
    return result
  }

  async function dispose() {
    await inbound.stop()
    await agentCore?.dispose()
  }

  function status() {
    const value = { enabled, started: inbound.status().started }
    if (enabled) value.registry = registry.size()
    // Reported only when the new namespace exists, so a legacy config keeps the
    // exact three-key surface the pinned tests assert.
    if (agentCore) value.agent = agentCore.outline()
    // Notification routes (U5): names and events only. The resolved credential is
    // deliberately absent from every observability surface.
    if (notifications.channels.length > 0) {
      value.channels = notifications.channels.map((channel) => ({ name: channel.name, transport: channel.transport, events: [...channel.events] }))
    }
    // Reply authorization reports the policy identities it named. Notification
    // channels alone do not manufacture an authorization status surface.
    const authorization = {}
    if (replyPolicyIdentities.has("discord-bot")) {
      authorization.discord = { source: discordAuthorization.source, explicit: discordAuthorization.explicit }
    }
    if (replyPolicy.declared && telegramAuthorization !== undefined && hasTelegramInbound) {
      authorization.telegram = {
        source: telegramAuthorization.source,
        explicit: telegramAuthorization.explicit,
      }
    }
    if (Object.keys(authorization).length > 0) value.authorization = authorization
    return value
  }

  /**
   * The DERIVED report `/openclaw-status` renders (`Contrato_Transportes_OpenClaw.md`
   * §9.2): the state document plus the two facts the document cannot know because
   * they are composition-level (is the surface on, did the listener start).
   *
   * It hydrates first, because the command is a user-initiated read and the point
   * of a durable document is to survive a restart. Identity only: no token, no
   * URL, no instruction ever enters this shape.
   */
  async function report() {
    // A `fatal` row is this plugin's setup verdict, and the setup that just ran is
    // the authority on whether it still holds. Reconciling on the read (rather than
    // at startup) is what keeps a healthy install at zero status access - the read
    // is one this command performs anyway - and it is what stops a repaired
    // configuration or credential from staying `fatal` in the durable report.
    await statusDocument.reconcileFatals(setupFatals.map((fatal) => fatal.surface))
    const document = statusDocument.snapshot()
    return {
      enabled,
      started: inbound.status().started,
      configState: configState ?? null,
      surfaces: document.surfaces,
      updatedAt: document.updatedAt,
    }
  }

  /**
   * Whether there is anything worth reporting: an active surface or a recorded
   * state. A surface that was never configured and never failed registers no
   * command, so `/openclaw-status` does not appear on an inert install.
   */
  function hasReport() {
    if (enabled) return true
    return Object.keys(statusDocument.snapshot().surfaces).length > 0
  }

  return { enabled, ready, handleEvent, dispose, status, report, hasReport, registry, inbound, agentCore }
}
