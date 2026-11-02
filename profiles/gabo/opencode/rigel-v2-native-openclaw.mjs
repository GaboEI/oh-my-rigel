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
import { resolveOpenclawReplyListenerSecrets } from "./rigel-v2-native-openclaw-secrets.mjs"
import { createOpenclawOutbound } from "./rigel-v2-native-openclaw-outbound.mjs"
import { createOpenclawInbound, createInternalPromptGate } from "./rigel-v2-native-openclaw-inbound.mjs"
import { createOpenclawRegistry } from "./rigel-v2-native-openclaw-registry.mjs"
import { createOpenclawAgentRegistry, resolveOpenclawAgentNamespace } from "./rigel-v2-native-openclaw-agent-registry.mjs"
import { createOpenclawAgentQueue } from "./rigel-v2-native-openclaw-agent-queue.mjs"
import { createOpenclawStatusDocument } from "./rigel-v2-native-openclaw-agent-status.mjs"
import { describeOpenclawChannelDiagnostic, resolveOpenclawNotificationChannels } from "./rigel-v2-native-openclaw-notification.mjs"
import { authorizeDiscordAuthors, describeOpenclawReplyPolicyDiagnostic, resolveOpenclawReplyPolicy } from "./rigel-v2-native-openclaw-reply-policy.mjs"

/**
 * Build the new namespace's core over the same storage domain the chat registry
 * uses. Three independent pieces, no network and no host API beyond storage:
 *
 *   - `registry` is the agent key space (`rigel-v2/openclaw/agent/`), which is
 *     where the durable single-in-flight slot lives;
 *   - `queue` is the bounded structure the conversational path must cross, so a
 *     120 s send can never block the shared event iterable;
 *   - `status` is the `rigel-v2/openclaw/status` document the report is derived
 *     from. It is INJECTED, not built here: the composition owns one document, so
 *     the legacy surfaces (outbound, discord, telegram, injection, config,
 *     credentials) and the agent namespace report into the same storage key
 *     instead of overwriting each other.
 *
 * `hydrate()` reads the durable halves once at setup. It performs storage reads
 * only: zero network, which is the invariant the whole unit is measured against.
 */
function createAgentCore({ context, namespace, now, log, status }) {
  const registry = createOpenclawAgentRegistry({ storage: context?.storage, now, log })
  const queue = createOpenclawAgentQueue({ registry, status, now, log })
  return {
    namespace,
    registry,
    queue,
    status,
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
      }
    },
    dispose() {
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

  // §5.2 rule 1: `channels` declared means the new namespace is in play, and its
  // inbound half may not be silently off. A Discord reply port with credentials
  // and no authorized author at all is a configuration error the operator has to
  // see; a configuration that never mentions `channels` keeps the legacy silence
  // (that is `unauthorizedInNewNamespace`, which is false without the namespace).
  const agentNamespace = resolveOpenclawAgentNamespace(config)
  const legacyAuthorizedAuthors = Array.isArray(normalized?.replyListener?.authorizedDiscordUserIds)
    ? normalized.replyListener.authorizedDiscordUserIds
    : []
  const hasDiscordInbound = Boolean(secrets.replyListener?.discordBotToken && secrets.replyListener?.discordChannelId)
  const unauthorizedInNewNamespace = enabled
    && hasDiscordInbound
    && agentNamespace.declared
    && !replyPolicy.declared
    && legacyAuthorizedAuthors.length === 0
  if (unauthorizedInNewNamespace) {
    log("[oh-my-rigel] Native V2 openclaw Discord replies stay off: openclaw.channels is declared but openclaw.replyListener.authorizedDiscordUserIds is empty, so no author is authorized")
  }

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
  if (unauthorizedInNewNamespace) {
    setupFatals.push({ surface: "discord", errorClass: "missing-authorized-authors", detail: "openclaw.replyListener.authorizedDiscordUserIds" })
  }
  for (const diagnostic of replyPolicy.diagnostics) {
    setupFatals.push({
      // A missing authorization disables the Discord reply surface, so the
      // document says `discord`; a structural mistake about an identity this
      // runtime does not serve is a configuration fault with no disabled
      // surface, so it reports under `replyPolicy`. The exact path always
      // travels as `detail`, never an author id.
      surface: diagnostic.identity === "discord-bot" ? "discord" : "replyPolicy",
      errorClass: diagnostic.reason,
      detail: diagnostic.path,
    })
  }

  // The registry is the durable correlation store; `ctx.storage` is the V2
  // domain, and an absent one still works from the in-process index.
  const registry = createOpenclawRegistry({ storage: context?.storage, now, log })

  // The new namespace gets its own core, and ONLY when it is declared AND the
  // global switch is on. The predicate reads the raw block: recognizing
  // `channels` is not config normalization, it is the gate that decides whether
  // this composition builds the agent path at all. A legacy
  // `gateways`/`hooks`/`replyListener` config has no `channels` key, so nothing
  // below is constructed for it, and `openclaw.enabled` stays the single global
  // switch (Contrato_Transportes_OpenClaw.md §5.2 rule 4).
  const agentCore = enabled && agentNamespace.declared
    ? createAgentCore({ context, namespace: agentNamespace, now, log, status: statusDocument })
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

  // The inbound listener delivers ONLY through the internal prompt gate: the V2
  // equivalent of V1's `tmux send-keys` injection, but a real queued session
  // prompt the host has to accept.
  const deliverInboundReply = createInternalPromptGate({ session: context?.session })
  const inbound = createOpenclawInbound({
    replyListener: secrets.replyListener,
    registry,
    deliverInboundReply,
    fetchImpl,
    log,
    now,
    statusDocument,
    // §U6: the new namespace's authorization REPLACES the legacy author list
    // when it is declared. Undefined here means "legacy governs", which is the
    // path every pinned listener test and every pre-U6 configuration takes.
    ...(replyPolicy.declared ? { discordAuthorization: authorizeDiscordAuthors(replyPolicy) } : {}),
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
    agentCore?.dispose()
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
    // Reply authorization (U6): whether the new namespace supplied it, and whether
    // it actually authorizes anyone. Booleans and a source name only — the author
    // ids are configuration, not observability.
    if (replyPolicy.declared) {
      const authorization = authorizeDiscordAuthors(replyPolicy)
      value.authorization = { discord: { source: authorization.source, explicit: authorization.explicit } }
    }
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
    await statusDocument.hydrate()
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
