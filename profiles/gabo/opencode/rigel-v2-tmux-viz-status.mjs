/**
 * Native V2 tmux visualization: the SESSION STATUS seam.
 *
 * The host answers "what is this session doing?" PER SESSION. There is no
 * aggregate: a caller must name the session it is asking about. Reading the seam
 * as an aggregate (`status()` with no id) is unanswerable, and the caller that
 * does it sees an EMPTY container rather than an error - which is exactly how a
 * working feature looked broken on a live host:
 *
 * - the pre-fix manager treated the non-null container as observability, so it
 *   spent the whole readiness budget waiting for a status that could never
 *   appear and deferred every member spawn forever;
 * - the polling loop read the same empty container, so `lastSeenAt` and the
 *   idle-stability rule were dead.
 *
 * Two rules make that class of failure impossible to repeat silently:
 *
 * 1. A MISSING answer is not a status. Only an actually resolved value counts as
 *    observability; absence keeps the caller's "attach anyway" policy, which is
 *    safe because the pane targets the session by id.
 * 2. "I asked and the host answered with nothing for this session" (ABSENT) and
 *    "I could not ask" (UNAVAILABLE) are DIFFERENT answers. Closing a pane is
 *    destructive, so a transient host failure must never be read as proof that a
 *    session vanished.
 *
 * Domain precedence and addressing are NOT invented here: they are copied from
 * the runtime's proven resolver (`rigel-v2-native-session-teardown.mjs`
 * `DOMAIN_CANDIDATES` / `ADDRESS_SHAPES`), which the live host already exercises
 * for member deletion. Object-first addressing is part of that proven order.
 */

/** Session domains the runtime already resolves, in the same precedence it uses. */
export const STATUS_DOMAIN_CANDIDATES = Object.freeze([
  ["v2.session", (domains) => domains?.v2?.session],
  ["session", (domains) => domains?.session],
  ["client.v2.session", (domains) => domains?.client?.v2?.session],
  ["client.session", (domains) => domains?.client?.session],
  ["data.session", (domains) => domains?.data?.session],
])

/** Address shapes, in the runtime's own precedence (object first). */
export const STATUS_ADDRESS_SHAPES = Object.freeze([
  ["{ sessionID }", (sessionID) => ({ sessionID })],
  ["sessionID", (sessionID) => sessionID],
])

/**
 * Normalize a host status value to the lowercase token the attachment policy
 * uses. Accepts a bare string (the shape the read-only panel consumes) and a
 * record carrying the token under `type`, `status` or `state`.
 */
export function normalizeStatusValue(value) {
  if (typeof value === "string") {
    const token = value.trim().toLowerCase()
    return token.length > 0 ? token : undefined
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of ["type", "status", "state"]) {
      const inner = value[key]
      if (typeof inner === "string") {
        const token = inner.trim().toLowerCase()
        if (token.length > 0) return token
      }
    }
  }
  return undefined
}

function isStructuredLookup(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return value.kind === "value" || value.kind === "absent" || value.kind === "unavailable"
}

/**
 * Resolve ONE session's status into a three-state answer:
 *
 * - `{ kind: "value", status }`   the host answered with a usable status;
 * - `{ kind: "absent" }`          the host answered, and has no status for this
 *                                 session (aggregate Map without the key, or a
 *                                 value that carries no token);
 * - `{ kind: "unavailable" }`     the question could not be asked at all (no
 *                                 seam, or the seam threw).
 *
 * The legacy aggregate form (a `Map` of sessionID -> status) is still accepted so
 * an older adapter cannot silently become "observable with no entries".
 */
export async function resolveSessionStatus(fetchSessionStatus, sessionID) {
  if (typeof fetchSessionStatus !== "function") return { kind: "unavailable" }
  let raw
  try {
    raw = await fetchSessionStatus(sessionID)
  } catch {
    return { kind: "unavailable" }
  }
  if (raw === null || raw === undefined) return { kind: "unavailable" }
  if (isStructuredLookup(raw)) return raw
  if (raw instanceof Map) {
    if (!raw.has(sessionID)) return { kind: "absent" }
    const status = normalizeStatusValue(raw.get(sessionID))
    return status === undefined ? { kind: "absent" } : { kind: "value", status }
  }
  const status = normalizeStatusValue(raw)
  return status === undefined ? { kind: "absent" } : { kind: "value", status }
}

/**
 * Build the per-session status reader the tmux visualization hands to both the
 * readiness wait and the polling loop.
 *
 * The chosen domain is logged exactly ONCE: the next live run must be able to
 * tell "which host surface answered" from a log line instead of from a silent
 * zero-pane outcome.
 *
 * @param {object} [context] the V2 plugin context
 * @param {object} [options]
 * @param {(line: string) => void} [options.logger] receives the one line
 * @returns {(sessionID: string) => Promise<{kind: "value"|"absent"|"unavailable", status?: string}>}
 */
export function createSessionStatusReader(context, { logger } = {}) {
  let chosen = null
  let chosenName = null
  let announced = false
  const announce = (name) => {
    if (announced) return
    announced = true
    if (typeof logger === "function") logger(`session status domain=${name}`)
  }

  for (const [name, resolve] of STATUS_DOMAIN_CANDIDATES) {
    let domain
    try {
      domain = resolve(context)
    } catch {
      continue
    }
    if (domain && typeof domain.status === "function") {
      chosen = domain
      chosenName = name
      break
    }
  }

  return async function readSessionStatus(sessionID) {
    announce(chosenName ?? "none")
    if (!chosen) return { kind: "unavailable" }
    if (typeof sessionID !== "string" || sessionID.length === 0) return { kind: "unavailable" }
    for (const [, address] of STATUS_ADDRESS_SHAPES) {
      let raw
      try {
        raw = await chosen.status(address(sessionID))
      } catch {
        // This host addresses the call differently: try the next proven shape.
        continue
      }
      if (raw === null || raw === undefined) return { kind: "absent" }
      if (isStructuredLookup(raw)) return raw
      const status = normalizeStatusValue(raw)
      return status === undefined ? { kind: "absent" } : { kind: "value", status }
    }
    // Every addressing shape threw: the seam is unavailable, not empty.
    return { kind: "unavailable" }
  }
}
