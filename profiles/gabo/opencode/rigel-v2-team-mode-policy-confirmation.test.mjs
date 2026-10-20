import { describe, expect, test } from "bun:test"
import { createMemberWorktrees, createTeamWorktreeManager } from "./rigel-v2-team-worktrees.mjs"
import { createTeamModeCommand } from "./rigel-v2-native-team-mode-command.mjs"
import { createTeamTools } from "./tools/team.tools.mjs"

/**
 * PROMPT-BYTE CONTRACT (named per `.omo/rules/test-discipline.md` retention bar).
 *
 * The runtime's emitted instruction is not documentation: it is the exact text
 * injected into the model's turn. It is the only thing that decides whether the
 * agent stops or acts, so it is a product surface with a machine consumer, not
 * prose.
 *
 * The round-4 defect: the worktree thrower said "retry with worktree: false"
 * while the `/team-mode` failure prompt said "do not retry blindly". The agent
 * read BOTH sentences in the SAME turn, resolved the contradiction toward the
 * actionable one, flipped a policy the user had chosen, and produced an unwanted
 * team. Neither sentence is wrong alone; the CONTRADICTION is the defect.
 *
 * The contract enforced here is the branch the runtime owns:
 *   given a failed create, the emitted instruction
 *     (a) forbids acting again in the same turn, and
 *     (b) makes any worktree-policy change the USER's decision by demanding an
 *         explicit confirmation before a retry.
 *
 * Both messages are taken from the REAL thrower and driven through the REAL
 * create path, so the assertions cannot drift from what production emits and no
 * wording is hand-copied into this file. `team_create`'s description and
 * `skills/team-mode/SKILL.md` are pure prose with no machine consumer; per
 * test-discipline they are guarded by review, not by a phrase pin.
 */

/** Decision-complete objective that EXPLICITLY asks for per-member worktrees. */
const WORKTREE_YES_OBJECTIVE =
  'team: auth-audit. audit the auth module. members: scout=quick "map the auth paths", builder=unspecified-low "write the missing tests". worktree: yes'

const REPO_ROOT = "/tmp/row55-non-git-root"

/** Answers like git does on a directory that is not inside a work tree. */
const notARepository = async () => ({
  code: 128,
  stdout: "",
  stderr: "fatal: not a git repository (or any of the parent directories): .git",
})

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key) : undefined },
    async set(key, value) { map.set(key, value) },
    async remove(key) { map.delete(key) },
    async scan({ prefix = "" } = {}) {
      return { entries: [...map.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }
    },
  }
}

/**
 * The whole production chain: a non-git root, the real worktree manager calling
 * the real thrower, the real `team_create`, and the real `/team-mode` renderer.
 */
function buildHarness() {
  const storage = memoryStorage()
  const spawns = []
  const worktreeManager = createTeamWorktreeManager({
    repoRoot: REPO_ROOT,
    runGit: notARepository,
    removeDir: async () => {},
  })
  const tools = createTeamTools({
    storage,
    getSessionID: () => "lead-session",
    startMemberSession: async (member, meta) => {
      spawns.push({ ...member, teamName: meta.teamName, leadSessionID: meta.leadSessionID })
      return { sessionID: `ses_member_${spawns.length}` }
    },
    worktreeManager,
  })
  const prompts = []
  const context = {
    session: { prompt: async (args) => { prompts.push(args) } },
    command: {
      transform: async (mutator) => {
        const editor = { add: (definition) => definition }
        mutator(editor)
        return { dispose() {} }
      },
    },
  }
  const command = createTeamModeCommand({
    context,
    createTeam: async (spec, toolContext) => tools.team_create.execute(spec, toolContext),
  })
  return { storage, spawns, prompts, tools, command }
}

describe("native V2 team worktree policy confirmation", () => {
  test("#given a non-git root #when per-member worktrees are provisioned #then the error makes the policy change the user's decision", async () => {
    // given a root git refuses, exactly as a plain directory behaves
    let captured
    try {
      await createMemberWorktrees({
        repoRoot: REPO_ROOT,
        teamName: "auth-audit",
        members: [{ name: "scout" }],
        runGit: notARepository,
        removeDir: async () => {},
      })
    } catch (error) {
      captured = error
    }

    // then it fails loudly...
    expect(captured).toBeInstanceOf(Error)
    expect(captured.message).toContain("require a git repository")
    // ...and routes the decision to the user instead of handing the model a bypass
    expect(captured.message).toMatch(/confirm/i)
    expect(captured.message).not.toMatch(/retry with worktree/i)
  })

  test("#given the worktree provision fails #when /team-mode creates the team #then nothing is spawned, no record survives and the injected turn forbids an autonomous retry", async () => {
    // given a decision-complete objective that explicitly chose worktrees
    const harness = buildHarness()

    // when the command runs against the real create path on a non-git root
    await harness.command.execute({ sessionID: "lead-session", prompt: { text: WORKTREE_YES_OBJECTIVE } })
    const injected = harness.prompts[0]?.text ?? ""

    // then the failed create is inert: no member session, no durable record
    expect(harness.spawns).toHaveLength(0)
    expect(harness.storage.map.size).toBe(0)

    // and the turn the agent reads surfaces the real failure verbatim
    expect(injected).toContain("require a git repository")

    // and it forbids acting again in the same turn...
    expect(injected).toMatch(/in this turn/i)

    // ...and it demands the user's confirmation before the policy may change,
    // so the two sentences the agent reads can no longer contradict each other
    expect(injected).toMatch(/confirm/i)
    expect(injected).not.toMatch(/retry with worktree/i)

    const failureTurn = injected.slice(injected.indexOf("Creating the team FAILED"))
    expect(failureTurn).toMatch(/confirm/i)
  })
})
