/**
 * Native V2 member-session teardown.
 *
 * A team member's tmux pane is deliberately PERSISTENT: a teammate goes idle
 * after every turn by design, so the ordinary idle-stability close would drop
 * its pane seconds after creation. The ONLY thing that closes a member pane is
 * `session.deleted` (`native.mjs` fans that event into
 * `tmuxVizManager.onSessionDeleted`). Deleting the member session is therefore
 * not bookkeeping: it IS the pane cleanup.
 *
 * Two things were observed live on NLS1 (OpenCode 2.0.32):
 *   - the old teardown trusted the FIRST domain whose `delete` existed, so a
 *     call that RESOLVED WITHOUT DELETING reported success and left a live pane
 *     behind; and
 *   - the plugin host exposes the V2 session client under `client.v2.session`
 *     (`client?.v2?.session ?? client?.session`, the same precedence the runtime
 *     delegation path uses), which the first version of this module never tried.
 *
 * The authoritative V2 session API is `delete({ sessionID })`
 * (`@opencode-ai/sdk` v2 `session.delete`, `buildClientParams` -> path param).
 * Callers may also be handed the HTTP-shaped domain, which addresses a session
 * as `{ path: { id } }`, and some hosts expose `remove` instead of `delete`.
 * Every known shape is attempted in the runtime's own precedence order and the
 * outcome is VERIFIED against `session.get`, because a resolved promise is not
 * evidence of deletion.
 *
* Note 5: a presence probe that is UNAVAILABLE, or that throws, proves nothing.
* In that case the result is reported as `unverified` with `verified: false` — it
* is never reported as verified success, because a resolved promise is not
 * evidence.
 *
 * The converse also holds: a THROWING end call is not automatically a failure. If
 * the probe proves the session is gone (a host rejecting a delete of an
 * already-deleted session), the objective is met and the close is verified.
 */

/** Session domains the runtime already resolves, in the same precedence it uses. */
const DOMAIN_CANDIDATES = Object.freeze([
  ["v2.session", (domains) => domains?.v2?.session],
  ["session", (domains) => domains?.session],
  ["client.v2.session", (domains) => domains?.client?.v2?.session],
  ["client.session", (domains) => domains?.client?.session],
  ["data.session", (domains) => domains?.data?.session],
])

const END_METHODS = Object.freeze(["delete", "remove"])

/**
 * Address shapes every attempt speaks, delete and presence alike. The last one is
 * the host's HTTP/RPC envelope
 * (`session.get("/api/session/:sessionID", { params: { sessionID } })`): a host that
 * only accepts that envelope can otherwise never be deleted or verified.
 */
const ADDRESS_SHAPES = Object.freeze([
  ["{ sessionID }", (sessionID) => ({ sessionID })],
  ["{ path: { id } }", (sessionID) => ({ path: { id: sessionID } })],
  ["{ params: { sessionID } }", (sessionID) => ({ params: { sessionID } })],
])

/**
 * The ONLY presence capability consulted. `list` is deliberately never used: a
 * filtered or partial list would read as absence and falsely verify a live
 * session, which is exactly the failure this module exists to prevent.
 */
const PROBE_METHOD = "get"

function errorText(error) {
  if (typeof error === "string") return error
  if (!error || typeof error !== "object") return ""
  // `reason`/`_tag` matter: the host's client keeps the transport-level reason
  // (`this.reason = "Transport"`, ...) and drops the HTTP status, so the plain
  // message alone can describe a 404 and a broken socket identically.
  return [error.message, error.name, error.code, error.statusText, error.reason, error._tag, error.data?.message, error.data?.code, error.cause?.message]
    .filter((part) => typeof part === "string" && part.length > 0)
    .join(" | ")
    .slice(0, 600)
}

/**
 * Normalize a status value. Clients disagree about its type: some stringify it
 * (`"403"`), so a bare `typeof value === "number"` check would miss the status
 * entirely and let a refusal read as an ordinary failure.
 */
function toHttpStatus(value) {
  if (typeof value === "number") return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined
  if (typeof value === "string" && /^\d{3}$/.test(value.trim())) {
    const status = Number(value.trim())
    return status >= 100 && status <= 599 ? status : undefined
  }
  return undefined
}

/**
 * Every place a host may hide the HTTP status. The live SDK's `wrapClientError`
 * stores it at `error.cause.status`, so a top-level-only read misses EVERY
 * wrapped refusal - 401/403/429 included - and the calibrated address then
 * reports a refusal as a verified absence (final gate round 2, ROW55).
 */
const STATUS_PATHS = Object.freeze([
  (error) => error.status,
  (error) => error.statusCode,
  (error) => error.response?.status,
  (error) => error.response?.statusCode,
  (error) => error.data?.status,
  (error) => error.data?.statusCode,
  (error) => error.cause?.status,
  (error) => error.cause?.statusCode,
  (error) => error.cause?.response?.status,
  (error) => error.cause?.response?.statusCode,
  (error) => error.cause?.data?.status,
  (error) => error.cause?.data?.statusCode,
])

function errorStatus(error) {
  if (!error || typeof error !== "object") return undefined
  for (const read of STATUS_PATHS) {
    const status = toHttpStatus(read(error))
    if (status !== undefined) return status
  }
  return undefined
}

/**
 * Error wording with `_`/`-` folded to spaces, so a structured code such as
 * `PERMISSION_DENIED` reads exactly like `permission denied`. Reporting keeps the
 * raw text; only classification normalizes.
 */
function normalizedText(error) {
  return errorText(error).replace(/[_-]+/g, " ")
}

/**
 * A PERMISSION answer (401/403/407) is never evidence about a session's
 * existence, and it is not a rejected address either: the call was formed
 * correctly and refused. It must therefore leave presence UNKNOWN - including on
 * a calibrated address, where "everything else is absence" would otherwise turn a
 * 403 into a verified close (final independent gate, ROW55).
 *
 * The structured status is authoritative when the host provides one; wording is
 * consulted only when it did not, exactly like the not-found and broken-probe
 * predicates.
 */
 const PERMISSION_TEXT = /\b(401|403|407)\b|\b(unauthori[sz]ed|forbidden|permission\s+denied|not\s+authori[sz]ed|access\s+denied|insufficient\s+(?:scope|scopes|permission|permissions)|eacces|eperm)\b/i
 function isPermissionFailure(error) {
  if (!error || (typeof error !== "object" && typeof error !== "string")) return false
  const status = errorStatus(error)
  if (typeof status === "number") return status === 401 || status === 403 || status === 407
  return PERMISSION_TEXT.test(normalizedText(error))
 }

 /**
 * A NOT-FOUND answer is the strongest ABSENCE proof a host can give: the request
 * reached the session resource and the host said no such session exists.
 *
 * This stays fail-closed. A structured status is authoritative (404 only: 401,
 * 403 and 5xx stay UNKNOWN). A message-only match never counts when it describes
 * a missing ROUTE or METHOD - a broken endpoint says nothing about the session -
 * and a "route not found" 404 must not be read as a deleted session.
 */
function isNotFoundError(error) {
  // A refusal is never a not-found, even when the body masks the 404.
  if (isPermissionFailure(error)) return false
  const status = errorStatus(error)
  if (typeof status === "number") return status === 404
  const text = normalizedText(error)
  if (!text) return false
  if (/\b(route|endpoint|method\s+not\s+allowed|unsupported|not\s+implemented)\b/i.test(text)) return false
  return /\b404\b/.test(text)
    || /\bnot[\s_-]?found\b/i.test(text)
    || /\bno\s+such\s+session\b/i.test(text)
    || /\bsession\s+(?:is\s+)?(?:already\s+)?(?:gone|deleted|removed)\b/i.test(text)
}

/**
 * A rejected ADDRESS (the host refused this argument shape) is not a broken
 * probe: it only says "try the next shape". Anything else - transport, timeout,
 * 5xx, a missing route - leaves presence UNKNOWN and can never be turned into an
 * absence proof by another address's empty answer.
 */
function isAddressRejection(error) {
  // A refusal means the call was well formed: it is not an address rejection, so
  // it cannot license another shape's empty answer nor a calibrated absence.
  if (isPermissionFailure(error)) return false
  const status = errorStatus(error)
  if (typeof status === "number") return status === 400 || status === 415 || status === 422
  const text = normalizedText(error)
  return /\b(argument|params?|validation|expected|unexpected|schema|shape)\b/i.test(text)
}

/**
 * A BROKEN probe (transport, timeout, 5xx, malformed body) leaves presence
 * UNKNOWN. It must never be converted into an absence answer - not even through
 * a calibrated address - because the host never answered the question.
 */
const BROKEN_PROBE_REASONS = /^(transport|unexpectedstatus|malformedresponse|unsupportedcontenttype|sseeventtoolarge|offline|unavailable|timeout)$/i
function isBrokenProbe(error) {
  if (!error || typeof error !== "object") return false
  if (typeof error.reason === "string" && BROKEN_PROBE_REASONS.test(error.reason)) return true
  const status = errorStatus(error)
  // 429 is a RATE LIMIT: the host refused to answer, so it is not an absence.
  if (typeof status === "number" && (status >= 500 || status === 429)) return true
  const text = normalizedText(error)
  if (!text) return false
  return /\b(transport|econn\w*|etimedout|timeout|timed\s*out|socket|network|offline|unavailable|fetch\s+failed|malformed|unsupported\s+content|rate\s+limit|too\s+many\s+requests|429)\b/i.test(text)
}

/** The id of a real session object, wherever a host nests it. */
function sessionIdOf(value) {
  const id = value?.id ?? value?.sessionID ?? value?.session?.id
    ?? value?.data?.id ?? value?.data?.sessionID ?? value?.data?.session?.id
  return typeof id === "string" && id.length > 0 ? id : undefined
}

/**
 * Classify one presence answer.
 *  - "present": a session object came back (positive survival proof)
 *  - "absent-strong": the host answered NOT-FOUND (positive absence proof)
 *  - "absent-weak": an empty/`data: null` answer (absence only from the primary probe)
 *  - "unknown": anything unrecognized - never read as absence (note 5)
 */
function classifyPresence(value) {
  if (value === undefined || value === null || value === false) return "absent-weak"
  if (typeof value !== "object") return "unknown"
  // The v2 SDK does not throw on 404: it returns { data: undefined, error: { name: "NotFound" } }.
  if (isNotFoundError(value.error)) return "absent-strong"
  // A structured error envelope is NEVER weak absence: a 401/403 - or any other
  // failed call - carrying `data: null` describes a refused request, not a gone
  // session.
  if (value.error !== undefined && value.error !== null && value.error !== false) return "unknown"
  if (sessionIdOf(value)) return "present"
  if (value.data === null) return "absent-weak"
  return "unknown"
}

/**
 * Build the idempotent member-session terminator used by the team tools.
 *
 * ROW55 retest 6 (live): the delete ran through `client.v2.session`, but the
 * presence probe only ever read `context.session.get({ sessionID })`, so a close
 * that really happened was reported `unverified` on every teardown. Presence is
 * now resolved across the SAME domains and address shapes the delete uses, and a
 * not-found answer counts as absence - without softening fail-closed behavior.
 *
 * @param {object} options
 * @param {object} [options.domains] session domains to address, defaulted from `context`
 * @param {(sessionID: string) => Promise<unknown>} [options.presence]
 *        caller-supplied probe; a falsy answer proves deletion, a session object
 *        proves survival, a not-found error proves absence, and any other throw
 *        stays UNKNOWN (note 5).
 * @param {string} [options.controlSessionID]
 *        a session the caller KNOWS is alive (its own). It calibrates the probe:
 *        only an address that resolves this live session may turn a wording-free
 *        failure into an absence answer (ROW55 retest 7). May also be passed per
 *        call as `options.controlSessionID`.
 * @returns {(sessionID: string, options?: { controlSessionID?: string }) => Promise<{ sessionID: string, deleted: boolean, shape?: string, verified?: boolean, unverified?: boolean, reason?: string, error?: string }>}
 */
export function createMemberSessionTerminator({ context = {}, domains, presence, controlSessionID: defaultControlSessionID } = {}) {
  const resolvedDomains = domains ?? {
    v2: context?.v2,
    session: context?.session,
    client: context?.client,
    data: context?.data,
  }
  // Note 5: the probe must be a REAL capability. A caller-injected `presence` is
  // one; otherwise any supported domain's `get` is. If neither exists there is no
  // probe at all and the answer is UNKNOWN — never "absent" — so a host without a
  // session getter can never be mistaken for proof that a session was deleted.
  const injectedProbe = typeof presence === "function" ? presence : undefined

  // One attempt per (domain, address shape). `run` takes the id so the SAME
  // attempt list can be replayed against a control session: a control has to
  // speak the identical call, or its answer proves nothing about this address.
  const buildProbeAttempts = () => {
    const attempts = []
    for (const [domainLabel, pick] of DOMAIN_CANDIDATES) {
      const domain = pick(resolvedDomains)
      if (!domain) continue
      const fn = domain[PROBE_METHOD]
      if (typeof fn !== "function") continue
      for (const [addressLabel, build] of ADDRESS_SHAPES) {
        attempts.push({ shape: `${domainLabel}.${PROBE_METHOD}(${addressLabel})`, run: (id) => fn.call(domain, build(id)) })
      }
    }
    return attempts
  }

  // Classify ONE attempt without deciding anything: the caller owns the policy.
  const describePresence = async (attempt, sessionID) => {
    try {
      const verdict = classifyPresence(await attempt.run(sessionID))
      if (verdict === "present") return { state: "present", reason: `${attempt.shape} reports the session still exists` }
      if (verdict === "absent-strong") return { state: "absent", reason: `${attempt.shape} answered not-found` }
      if (verdict === "absent-weak") return { state: "absent", weak: true, reason: `${attempt.shape} returned no session` }
      return { state: "unknown", reason: `${attempt.shape} returned an unrecognized answer` }
    } catch (error) {
      if (isNotFoundError(error)) return { state: "absent", reason: `${attempt.shape} answered not-found (${errorText(error)})` }
      return {
        state: "failed",
        reason: `${attempt.shape} failed (${errorText(error) || "no detail"})`,
        error,
        addressRejected: isAddressRejection(error),
      }
    }
  }

  // Presence CALIBRATION (ROW55 retest 7). The live host answers a deleted
  // session with an error that carries no not-found wording at all - its client
  // keeps only a transport-level reason and drops the HTTP status - so no message
  // match can ever prove absence there. What CAN be proven is that the call
  // itself works: the caller's own session is alive. Whichever address resolves
  // that live control is therefore the only address whose failure counts as an
  // absence answer, and only when the failure is not a broken probe.
  let calibratedAttempt
  const calibrate = async (controlSessionID) => {
    if (calibratedAttempt) return calibratedAttempt
    if (typeof controlSessionID !== "string" || controlSessionID.length === 0) return undefined
    for (const attempt of buildProbeAttempts()) {
      try {
        if (classifyPresence(await attempt.run(controlSessionID)) === "present") {
          calibratedAttempt = attempt
          return calibratedAttempt
        }
      } catch {
        // An address that cannot even resolve a live session says nothing about
        // the target: keep calibrating rather than concluding anything.
      }
    }
    return undefined
  }

  // Returns { state: "present" | "absent" | "unknown", reason } so the caller can
  // report WHY a close could not be proven instead of an opaque "unavailable".
  const probeOnce = async (sessionID, controlSessionID) => {
    if (injectedProbe) {
      try {
        const verdict = classifyPresence(await injectedProbe(sessionID))
        if (verdict === "present") return { state: "present", reason: "the injected presence probe reports the session still exists" }
        if (verdict === "absent-strong") return { state: "absent", reason: "the injected presence probe answered not-found" }
        if (verdict === "absent-weak") return { state: "absent", reason: "the injected presence probe reports the session is gone" }
        return { state: "unknown", reason: "the injected presence probe returned an unrecognized answer" }
      } catch (error) {
        if (isNotFoundError(error)) return { state: "absent", reason: `the injected presence probe answered not-found (${errorText(error)})` }
        return { state: "unknown", reason: `the injected presence probe failed (${errorText(error) || "no detail"})` }
      }
    }
    const attempts = buildProbeAttempts()
    if (attempts.length === 0) {
      // Note 5: no getter on any supported domain -> UNKNOWN, never "absent".
      return { state: "unknown", reason: "no presence probe exists (no session get on any supported domain)" }
    }
    // A weak (empty) answer is DEFERRED, never returned immediately: another
    // address on the same getter may still see the session, so a wrong address
    // that silently answers empty can never outvote an address that works.
    let weakAbsence
    let hardFailure = false
    // EVERY attempt is reported, not just the last one: retest 7 surfaced only
    // the final shape's schema rejection and hid what the working address said.
    const notes = []
    for (const attempt of attempts) {
      const outcome = await describePresence(attempt, sessionID)
      if (outcome.state === "present") return { state: "present", reason: outcome.reason }
      if (outcome.state === "absent") {
        if (!outcome.weak) return { state: "absent", reason: outcome.reason }
        weakAbsence ??= outcome
        notes.push(outcome.reason)
        continue
      }
      notes.push(outcome.reason)
      // A rejected ADDRESS (validation/400-class) only means this shape is
      // wrong; a BROKEN probe (transport/5xx) means nothing is knowable, and a
      // broken probe must never be converted into an absence proof by another
      // shape's empty answer.
      if (outcome.state === "failed" && !outcome.addressRejected) hardFailure = true
    }
    if (weakAbsence && !hardFailure) return { state: "absent", reason: weakAbsence.reason }
    // Control-calibrated absence: the address is proven to work (it resolved a
    // live session), the target still does not answer with a session, and the
    // failure is not a broken probe. That is the host saying the session is gone,
    // with no reliance on error wording and no fail-open relaxation.
    const control = await calibrate(controlSessionID)
    if (control) {
      const again = await describePresence(control, sessionID)
      if (again.state === "present") return { state: "present", reason: again.reason }
      if (again.state === "absent") return { state: "absent", reason: again.reason }
      if (again.state === "failed" && !again.addressRejected && !isBrokenProbe(again.error) && !isPermissionFailure(again.error)) {
        return {
          state: "absent",
          reason: `${again.reason}; the same call resolves the live control session ${controlSessionID}, so this failure is the host's absence answer`
        }
      }
      notes.push(again.reason)
    }
    return { state: "unknown", reason: [...new Set(notes)].join("; ").slice(0, 800) || "no presence probe answered" }
  }

  return async (sessionID, options) => {
    if (typeof sessionID !== "string" || sessionID.length === 0) {
      return { sessionID, deleted: false, error: "sessionID is required" }
    }
    // ROW55 retest 7: a LIVE control session (the caller's own) calibrates the
    // presence capability. Without one, behavior is exactly as before.
    const controlSessionID = typeof options?.controlSessionID === "string" && options.controlSessionID
      ? options.controlSessionID
      : defaultControlSessionID
    const attempts = []
    for (const [domainLabel, pick] of DOMAIN_CANDIDATES) {
      const domain = pick(resolvedDomains)
      if (!domain) continue
      for (const method of END_METHODS) {
        const fn = domain[method]
        if (typeof fn !== "function") continue
        for (const [addressLabel, build] of ADDRESS_SHAPES) {
          attempts.push({ shape: `${domainLabel}.${method}(${addressLabel})`, run: () => fn.call(domain, build(sessionID)) })
        }
      }
    }
    if (attempts.length === 0) return { sessionID, deleted: false, error: "host exposes no session delete" }

    const errors = []
    const unverified = []
    const reasons = []
    for (const attempt of attempts) {
      try {
        await attempt.run()
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        // Retry convergence (round-2 review R2): a THROWING end call is NOT
        // automatically a failure. If the presence probe proves the session is
        // GONE, the objective - no live session - is met. A host that rejects a
        // second delete of an already deleted session ("Session not found") must
        // not be re-classified as failed, because `team_delete` would then retain
        // the record forever and never converge on a retry. A throw with no probe
        // answer stays a failure: only a positive absence proof converts it.
        const afterThrow = await probeOnce(sessionID, controlSessionID)
        if (afterThrow.state === "absent") return { sessionID, deleted: true, shape: `${attempt.shape} (already absent)`, verified: true }
        errors.push(`${attempt.shape}: ${reason}`)
        continue
      }
      const probeResult = await probeOnce(sessionID, controlSessionID)
      if (probeResult.state === "present") {
        errors.push(`${attempt.shape}: resolved but the session still exists`)
        continue
      }
      if (probeResult.state === "unknown") {
        // Note 5: the end call resolved but the ONLY proof of deletion (a presence
        // probe answering "gone") was unavailable or failed. A resolved promise is
        // not evidence, so this is UNVERIFIED and never a verified success; the
        // remaining shapes are still tried for a provable deletion.
        unverified.push(`${attempt.shape}: resolved but deletion could not be verified (${probeResult.reason})`)
        reasons.push(probeResult.reason)
        continue
      }
      return { sessionID, deleted: true, shape: attempt.shape, verified: true }
    }
    if (unverified.length > 0) {
      return {
        sessionID,
        deleted: true,
        unverified: true,
        verified: false,
        reason: [...new Set(reasons)].join("; ").slice(0, 800),
        error: unverified.join("; "),
      }
    }
    return { sessionID, deleted: false, error: errors.join("; ") || "session delete failed" }
  }
}
