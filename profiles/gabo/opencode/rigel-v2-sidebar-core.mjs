/**
 * Pure core for Oh My Rigel's native OpenCode V2 sidebar.
 *
 * V1 `features/tui-sidebar/` split one sidebar into a plugin-side writer and a
 * TUI-side reader that talked only through a JSON mirror file on disk. This
 * module is the behavioural port of the PURE half of that feature: the snapshot
 * contract, the derivers, `computeView` / `viewKey`, the render tree, and the
 * timing knobs. It is dependency-free (no zod, no node:fs) and deterministic,
 * so every branch is unit-testable without a TUI or a file system.
 *
 * V1 owners ported here:
 *   packages/omo-opencode/src/features/tui-sidebar/constants.ts
 *   packages/omo-opencode/src/features/tui-sidebar/state-types.ts
 *   packages/omo-opencode/src/features/tui-sidebar/snapshot-schema.ts
 *   packages/omo-opencode/src/features/tui-sidebar/derivers.ts
 *   packages/omo-opencode/src/features/tui-sidebar/compute-view.ts
 *   packages/omo-opencode/src/features/tui-sidebar/loop-reader.ts   (pure half)
 *   packages/omo-opencode/src/features/tui-sidebar/snapshot-builder.ts (pure half)
 *   packages/omo-opencode/src/features/tui-sidebar/render-view.ts
 *   packages/omo-opencode/src/features/tui-sidebar/element-helpers.ts
 *
 * The non-pure halves (the mirror writer, the fs loop enumeration, the config
 * roster resolver) live in the thin runtime adapter
 * `rigel-v2-native-cli-sidebar.mjs`, which feeds this core from `context.data`
 * and a durable snapshot receipt.
 *
 * Exports keep the V1 names wherever the shape is unchanged, so the port is a
 * mechanical read of the V1 source.
 */

/** V1 `MIRROR_SCHEMA_VERSION`. Bump on any snapshot shape change. */
export const MIRROR_SCHEMA_VERSION = 1

/** V1 `MIRROR_DIR_NAME` (the V1 mirror storage folder name; kept for parity). */
export const MIRROR_DIR_NAME = "tui-state"

/** V1 timing/size knobs, byte-for-byte. */
export const STALE_MS = 6_000
export const LOOP_FRESH_MS = 120_000
export const POLL_INTERVAL_MS = 1_000
export const HEARTBEAT_MS = 2_000
export const WRITE_DEBOUNCE_MS = 250
export const MAX_AGENTS = 12
export const MAX_JOBS = 12
export const LABEL_MAX = 24

/** V1 `AGENT_STATUS_VALUES`. */
export const AGENT_STATUS_VALUES = Object.freeze(["busy", "idle", "error", "running", "retry"])

/** V1 `BACKGROUND_TASK_STATUS_VALUES`. */
export const BACKGROUND_TASK_STATUS_VALUES = Object.freeze([
  "pending",
  "running",
  "completed",
  "error",
  "cancelled",
  "interrupt",
])

/** V1 `JOB_STATUS_PRIORITY`: running first, completed last. */
export const JOB_STATUS_PRIORITY = Object.freeze({
  running: 0,
  pending: 1,
  interrupt: 2,
  error: 3,
  cancelled: 4,
  completed: 5,
})

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

/** V1 `assertNever`. */
export function assertNever(value) {
  throw new Error(`Unexpected variant: ${JSON.stringify(value)}`)
}

/* ------------------------------------------------------------------ *
 * Snapshot schema (V1 snapshot-schema.ts, zod replaced by hand checks)
 * ------------------------------------------------------------------ */

function validateAgentRow(row) {
  return isObject(row) && typeof row.name === "string" && AGENT_STATUS_VALUES.includes(row.status)
}

function validateJobRow(row) {
  return (
    isObject(row) &&
    typeof row.title === "string" &&
    BACKGROUND_TASK_STATUS_VALUES.includes(row.status) &&
    (row.toolCalls === null || isNonNegativeInteger(row.toolCalls)) &&
    (row.lastTool === null || typeof row.lastTool === "string")
  )
}

/** V1 `LoopLiveSchema`. */
export function validateLoopLive(loop) {
  return (
    isObject(loop) &&
    loop.kind === "live" &&
    isNonNegativeInteger(loop.goalsDone) &&
    isNonNegativeInteger(loop.goalsTotal) &&
    isNonNegativeInteger(loop.pass) &&
    isNonNegativeInteger(loop.fail) &&
    isNonNegativeInteger(loop.pending) &&
    isNonNegativeInteger(loop.blocked) &&
    (loop.activeGoal === null || typeof loop.activeGoal === "string")
  )
}

function normalizeAgentRow(row) {
  return { name: row.name, status: row.status }
}

function normalizeJobRow(row) {
  return { title: row.title, status: row.status, toolCalls: row.toolCalls, lastTool: row.lastTool }
}

function normalizeLoopLive(loop) {
  return {
    kind: "live",
    goalsDone: loop.goalsDone,
    goalsTotal: loop.goalsTotal,
    pass: loop.pass,
    fail: loop.fail,
    pending: loop.pending,
    blocked: loop.blocked,
    activeGoal: loop.activeGoal,
  }
}

/**
 * V1 `parseSnapshot` / `TuiRuntimeSnapshotSchema.safeParse`: returns the
 * normalized snapshot or `null`. Unparseable, wrong-version, wrong-shape data
 * collapses to `null` - failure degrades, never throws.
 */
export function parseSnapshot(raw) {
  if (!isObject(raw)) return null
  if (raw.version !== MIRROR_SCHEMA_VERSION) return null
  if (typeof raw.projectDir !== "string") return null
  if (typeof raw.updatedAt !== "number" || !Number.isFinite(raw.updatedAt)) return null
  if (!Array.isArray(raw.activeAgents) || !raw.activeAgents.every(validateAgentRow)) return null
  if (!Array.isArray(raw.jobBoard) || !raw.jobBoard.every(validateJobRow)) return null
  if (!(raw.loop === null || validateLoopLive(raw.loop))) return null
  return {
    version: MIRROR_SCHEMA_VERSION,
    projectDir: raw.projectDir,
    updatedAt: raw.updatedAt,
    activeAgents: raw.activeAgents.map(normalizeAgentRow),
    jobBoard: raw.jobBoard.map(normalizeJobRow),
    loop: raw.loop === null ? null : normalizeLoopLive(raw.loop),
  }
}

/** V1 `readMirror` freshness test: fresh while `now - updatedAt <= STALE_MS`. */
export function isSnapshotFresh(updatedAt, now) {
  return now - updatedAt <= STALE_MS
}

/* ------------------------------------------------------------------ *
 * Loop reader (V1 loop-reader.ts, pure half)
 * ------------------------------------------------------------------ */

function parseCriterion(raw) {
  return isObject(raw) && typeof raw.status === "string" ? { status: raw.status } : null
}

function parseGoal(raw, criteriaKey) {
  if (!isObject(raw)) return null
  if (typeof raw.id !== "string" || typeof raw.title !== "string" || typeof raw.status !== "string") return null
  if (!Array.isArray(raw[criteriaKey])) return null
  const criteria = []
  for (const criterion of raw[criteriaKey]) {
    const parsed = parseCriterion(criterion)
    if (parsed === null) return null
    criteria.push(parsed)
  }
  return { id: raw.id, title: raw.title, status: raw.status, criteria }
}

function parseCurrentLoop(raw) {
  if (raw.version !== 1 || !Array.isArray(raw.goals)) return null
  const goals = []
  for (const goal of raw.goals) {
    const parsed = parseGoal(goal, "successCriteria")
    if (parsed === null) return null
    goals.push(parsed)
  }
  return { activeGoalId: typeof raw.activeGoalId === "string" ? raw.activeGoalId : null, goals }
}

function parseLegacyLoop(raw) {
  if (!Array.isArray(raw.goals)) return null
  const goals = []
  for (const goal of raw.goals) {
    const parsed = parseGoal(goal, "criteria")
    if (parsed === null) return null
    goals.push(parsed)
  }
  return { activeGoalId: null, goals }
}

/**
 * V1 `readParsedLoop`: the current v1 document first, then the legacy shape.
 * Returns `{ activeGoalId, goals }` or `null`.
 */
export function parseLoopDocument(raw) {
  if (!isObject(raw)) return null
  return parseCurrentLoop(raw) ?? parseLegacyLoop(raw)
}

/** V1 `readLiveCandidate` freshness: fresh while `now - mtimeMs <= LOOP_FRESH_MS`. */
export function isLoopFresh(mtimeMs, now) {
  return now - mtimeMs <= LOOP_FRESH_MS
}

/** V1 `computeLoopLive`. */
export function computeLoopLive(loop) {
  const counts = loop.goals.reduce(
    (accumulator, goal) => {
      for (const criterion of goal.criteria) {
        switch (criterion.status) {
          case "pass":
            accumulator.pass += 1
            break
          case "fail":
            accumulator.fail += 1
            break
          case "blocked":
            accumulator.blocked += 1
            break
          case "pending":
            accumulator.pending += 1
            break
          default:
            accumulator.pending += 1
            break
        }
      }
      return accumulator
    },
    { pass: 0, fail: 0, pending: 0, blocked: 0 },
  )

  return {
    kind: "live",
    goalsDone: loop.goals.filter((goal) => goal.status === "complete").length,
    goalsTotal: loop.goals.length,
    pass: counts.pass,
    fail: counts.fail,
    pending: counts.pending,
    blocked: counts.blocked,
    activeGoal: activeGoalTitle(loop),
  }
}

/** V1 `activeGoalTitle`: `activeGoalId` first, then the first in-progress goal. */
export function activeGoalTitle(loop) {
  const byId = loop.goals.find((goal) => goal.id === loop.activeGoalId)
  if (byId !== undefined) {
    return byId.title
  }
  return loop.goals.find((goal) => goal.status === "in_progress")?.title ?? null
}

/* ------------------------------------------------------------------ *
 * Snapshot builder (V1 snapshot-builder.ts, pure half)
 * ------------------------------------------------------------------ */

/** V1 `toJobRow`. */
export function toJobRow(task) {
  const agent = typeof task?.agent === "string" && task.agent.length > 0 ? task.agent : "agent"
  return {
    title: task?.title || `${agent} background task`,
    status: task?.status ?? "pending",
    toolCalls: Number.isInteger(task?.toolCalls) ? task.toolCalls : null,
    lastTool: typeof task?.lastTool === "string" ? task.lastTool : null,
  }
}

/**
 * V1 `redactLoopText`: the goal title never leaves the process; the render side
 * shows the literal "private". A non-live loop is written as `null`.
 */
export function redactActiveGoal(loop) {
  if (loop === null || loop === undefined) return null
  return { ...loop, activeGoal: null }
}

/** Alias matching the V1 internal name. */
export const redactLoopText = redactActiveGoal

/**
 * V1 `buildTuiRuntimeSnapshot` (pure half): assembles the cross-process
 * contract from already-resolved inputs. `updatedAt` defaults to 0 so the
 * function stays deterministic under test; the runtime adapter passes `now()`.
 * The live loop's `activeGoal` is redacted before the snapshot is returned.
 */
export function buildRuntimeSnapshot(input = {}) {
  const activeAgents = Array.isArray(input.activeAgents) ? input.activeAgents : []
  const jobBoard = Array.isArray(input.jobBoard) ? input.jobBoard : []
  const loop = input.loop ?? null
  return {
    version: MIRROR_SCHEMA_VERSION,
    projectDir: typeof input.projectDir === "string" ? input.projectDir : "",
    updatedAt: typeof input.updatedAt === "number" && Number.isFinite(input.updatedAt) ? input.updatedAt : 0,
    activeAgents: activeAgents.map((row) => ({ name: String(row?.name ?? ""), status: row?.status })),
    jobBoard: jobBoard.map(toJobRow),
    loop: loop !== null && loop.kind === "live" ? redactActiveGoal(loop) : null,
  }
}

/* ------------------------------------------------------------------ *
 * Roster (V1 roster-resolver.ts, pure mapping half)
 * ------------------------------------------------------------------ */

/** V1 `formatModelLabel`: keep only the model id after the provider prefix. */
export function formatModelLabel(model) {
  const value = String(model)
  const slashIndex = value.lastIndexOf("/")
  if (slashIndex < 0 || slashIndex === value.length - 1) return value
  return value.slice(slashIndex + 1)
}

/** V1 `toRosterRow`. */
export function toRosterRow(entry) {
  const effectiveModel = entry?.effectiveModel ?? entry?.model ?? ""
  return {
    label: String(entry?.label ?? entry?.name ?? ""),
    model: formatModelLabel(effectiveModel),
  }
}

/* ------------------------------------------------------------------ *
 * Derivers (V1 derivers.ts)
 * ------------------------------------------------------------------ */

/** V1 `deriveConfig`. */
export function deriveConfig(value) {
  if (value.valid) {
    return { kind: "valid" }
  }
  return { kind: "invalid", messages: [...value.messages] }
}

/** V1 `deriveRoster`: sort by label, cap at MAX_AGENTS, empty collapses. */
export function deriveRoster(rows) {
  if (rows.length === 0) {
    return { kind: "empty" }
  }
  return {
    kind: "rows",
    rows: [...rows].sort((left, right) => left.label.localeCompare(right.label)).slice(0, MAX_AGENTS),
  }
}

/** V1 `deriveAgents`: sort by name, cap at MAX_AGENTS. */
export function deriveAgents(snapshot) {
  if (!snapshot || snapshot.activeAgents.length === 0) {
    return { kind: "none" }
  }
  return {
    kind: "list",
    agents: [...snapshot.activeAgents]
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, MAX_AGENTS),
  }
}

/** V1 `deriveJobBoard`: status priority first, title tie-break, cap MAX_JOBS. */
export function deriveJobBoard(snapshot) {
  if (!snapshot || snapshot.jobBoard.length === 0) {
    return { kind: "none" }
  }
  return {
    kind: "list",
    jobs: [...snapshot.jobBoard].sort(compareJobs).slice(0, MAX_JOBS),
  }
}

function compareJobs(left, right) {
  const priority = JOB_STATUS_PRIORITY[left.status] - JOB_STATUS_PRIORITY[right.status]
  if (priority !== 0) return priority
  return left.title.localeCompare(right.title)
}

/** V1 `deriveLoop`. */
export function deriveLoop(snapshot) {
  return snapshot?.loop ?? { kind: "none" }
}

/* ------------------------------------------------------------------ *
 * View selection (V1 compute-view.ts)
 * ------------------------------------------------------------------ */

/** V1 `computeView`. */
export function computeView(sections) {
  if (isActive(sections)) {
    return {
      kind: "active",
      loop: sections.loop,
      agents: sections.agents,
      jobs: sections.jobs,
      configBanner: sections.config.kind === "invalid" ? { kind: "invalid" } : { kind: "none" },
    }
  }
  if (sections.config.kind === "invalid") {
    return { kind: "broken", messages: sections.config.messages }
  }
  return { kind: "idle", roster: sections.roster }
}

function isActive(sections) {
  return sections.agents.kind === "list" || sections.jobs.kind === "list" || sections.loop.kind === "live"
}

/** V1 `viewKey`: a stable JSON string for re-render diffing. */
export function viewKey(view) {
  switch (view.kind) {
    case "active":
      return stableKey([
        "active",
        loopKeyParts(view.loop),
        agentsKeyParts(view.agents),
        jobsKeyParts(view.jobs),
        ["configBanner", view.configBanner.kind],
      ])
    case "broken":
      return stableKey(["broken", [...view.messages]])
    case "idle":
      return stableKey(["idle", rosterKeyParts(view.roster)])
    default:
      return assertNever(view)
  }
}

function stableKey(parts) {
  return JSON.stringify(parts)
}

function rosterKeyParts(roster) {
  switch (roster.kind) {
    case "empty":
      return ["roster", "empty"]
    case "rows":
      return ["roster", "rows", roster.rows.map((row) => [row.label, row.model])]
    default:
      return assertNever(roster)
  }
}

function agentsKeyParts(agents) {
  switch (agents.kind) {
    case "none":
      return ["agents", "none"]
    case "list":
      return ["agents", "list", agents.agents.map((agent) => [agent.name, agent.status])]
    default:
      return assertNever(agents)
  }
}

function jobsKeyParts(jobs) {
  switch (jobs.kind) {
    case "none":
      return ["jobs", "none"]
    case "list":
      return ["jobs", "list", jobs.jobs.map((job) => [job.title, job.status, job.toolCalls, job.lastTool])]
    default:
      return assertNever(jobs)
  }
}

function loopKeyParts(loop) {
  switch (loop.kind) {
    case "none":
      return ["loop", "none"]
    case "live":
      return [
        "loop",
        "live",
        loop.goalsDone,
        loop.goalsTotal,
        loop.pass,
        loop.fail,
        loop.pending,
        loop.blocked,
        loop.activeGoal,
      ]
    default:
      return assertNever(loop)
  }
}

/* ------------------------------------------------------------------ *
 * Render (V1 render-view.ts + element-helpers.ts, renderer-agnostic)
 * ------------------------------------------------------------------ */

/** V1 `box`. */
export function box(props, children = []) {
  return { kind: "box", props, children }
}

/** V1 `text`. */
export function text(props, value) {
  return { kind: "text", props, text: value }
}

/** V1 `buildViewNodes`. */
export function buildViewNodes(view, theme) {
  switch (view.kind) {
    case "active":
      return [
        box({ flexDirection: "column", gap: 1 }, [
          ...configBannerNodes(view.configBanner, theme),
          ...loopNodes(view.loop, theme),
          ...agentNodes(view.agents, theme),
          ...jobNodes(view.jobs, theme),
        ]),
      ]
    case "broken":
      return brokenNodes(view.messages, theme)
    case "idle":
      return idleNodes(view.roster, theme)
    default:
      return assertNever(view)
  }
}

/** V1 `describeView`: plain lines, used by the V2 CLI slot. */
export function describeView(view) {
  return linesForView(view).join("\n")
}

function linesForView(view) {
  switch (view.kind) {
    case "active":
      return [
        ...configBannerLines(view.configBanner),
        ...loopLines(view.loop),
        ...agentLines(view.agents),
        ...jobLines(view.jobs),
      ]
    case "broken":
      return ["config invalid - run doctor", ...view.messages]
    case "idle":
      return rosterLines(view.roster)
    default:
      return assertNever(view)
  }
}

/** V1 `truncate` with LABEL_MAX. */
export function truncate(value) {
  return value.length <= LABEL_MAX ? value : `${value.slice(0, LABEL_MAX - 3)}...`
}

/** V1 `activeGoalLabel`. */
export function activeGoalLabel(activeGoal) {
  return activeGoal ?? "private"
}

function configBannerNodes(banner, theme) {
  switch (banner.kind) {
    case "none":
      return []
    case "invalid":
      return [text({ fg: theme?.warning }, "config invalid - run doctor")]
    default:
      return assertNever(banner)
  }
}

function configBannerLines(banner) {
  switch (banner.kind) {
    case "none":
      return []
    case "invalid":
      return ["config invalid - run doctor"]
    default:
      return assertNever(banner)
  }
}

function loopNodes(loop, theme) {
  switch (loop.kind) {
    case "none":
      return []
    case "live":
      return [
        section("ULW", theme, [
          text({ fg: theme?.text }, `goals ${loop.goalsDone}/${loop.goalsTotal}`),
          text({ fg: theme?.success }, `pass ${loop.pass}`),
          text({ fg: theme?.error }, `fail ${loop.fail}`),
          text({ fg: theme?.textMuted }, `pending ${loop.pending} blocked ${loop.blocked}`),
          text({ fg: theme?.accent }, `active ${truncate(activeGoalLabel(loop.activeGoal))}`),
        ]),
      ]
    default:
      return assertNever(loop)
  }
}

function loopLines(loop) {
  switch (loop.kind) {
    case "none":
      return []
    case "live":
      return [
        "ULW",
        `goals ${loop.goalsDone}/${loop.goalsTotal}`,
        `pass ${loop.pass}`,
        `fail ${loop.fail}`,
        `pending ${loop.pending} blocked ${loop.blocked}`,
        `active ${activeGoalLabel(loop.activeGoal)}`,
      ]
    default:
      return assertNever(loop)
  }
}

function agentNodes(agents, theme) {
  switch (agents.kind) {
    case "none":
      return []
    case "list":
      return [
        section(
          "Agents",
          theme,
          agents.agents.map((agent) => text({ fg: theme?.text }, `${truncate(agent.name)} ${agent.status}`)),
        ),
      ]
    default:
      return assertNever(agents)
  }
}

function agentLines(agents) {
  switch (agents.kind) {
    case "none":
      return []
    case "list":
      return ["Agents", ...agents.agents.map((agent) => `${agent.name} ${agent.status}`)]
    default:
      return assertNever(agents)
  }
}

function jobNodes(jobs, theme) {
  switch (jobs.kind) {
    case "none":
      return []
    case "list":
      return [
        section(
          "Jobs",
          theme,
          jobs.jobs.map((job) =>
            text(
              { fg: theme?.text },
              `${truncate(job.title)} ${job.status} ${job.toolCalls ?? 0} ${job.lastTool ?? "none"}`,
            ),
          ),
        ),
      ]
    default:
      return assertNever(jobs)
  }
}

function jobLines(jobs) {
  switch (jobs.kind) {
    case "none":
      return []
    case "list":
      return jobs.jobs.flatMap((job) => [
        "Jobs",
        `${job.title} ${job.status} calls ${job.toolCalls ?? 0} last ${job.lastTool ?? "none"}`,
      ])
    default:
      return assertNever(jobs)
  }
}

function brokenNodes(messages, theme) {
  return [
    section("Config", theme, [
      text({ fg: theme?.error }, "config invalid - run doctor"),
      ...messages.map((message) => text({ fg: theme?.textMuted }, truncate(message))),
    ]),
  ]
}

function idleNodes(roster, theme) {
  return [section("Models", theme, rosterLines(roster).map((line) => text({ fg: theme?.text }, line)))]
}

function rosterLines(roster) {
  switch (roster.kind) {
    case "empty":
      return ["No configured models"]
    case "rows":
      return roster.rows.map((row) => `${row.label} ${row.model}`)
    default:
      return assertNever(roster)
  }
}

function section(title, theme, children) {
  return box(
    { borderStyle: "single", borderColor: theme?.borderSubtle, flexDirection: "column", padding: 1 },
    [text({ fg: theme?.info }, title), ...children],
  )
}
