import { expect, test } from "bun:test"
import { createNativeAutoSlashCommandHook } from "./rigel-v2-auto-slash-command-bridge.mjs"
import { findCommand, renderCommandTemplate } from "./rigel-v2-auto-slash-command-executor.mjs"

function event(text, messageID = "msg_1") {
  return { sessionID: "ses_1", messageID, prompt: { text } }
}

test("embedded slash command expands the matching skill template before admission", async () => {
  // given
  const hook = createNativeAutoSlashCommandHook({
    skills: [{ name: "review", template: "Review ${ARGUMENTS}; first=$1 second=$2" }],
  })
  const draft = event("/review src tests")

  // when
  await hook.before(draft)

  // then
  expect(draft.prompt.text).toContain("Review src tests; first=src second=tests")
})

test("slash command detector ignores fenced code, exclusions, and unknown commands", async () => {
  // given
  const hook = createNativeAutoSlashCommandHook({ skills: [{ name: "review", template: "expanded" }] })
  const drafts = [
    event("```\n/review src\n```", "fenced"),
    event("/ralph-loop src", "excluded"),
    event("/missing src", "unknown"),
  ]

  // when
  for (const draft of drafts) await hook.before(draft)

  // then
  expect(drafts.map((draft) => draft.prompt.text)).toEqual([
    "```\n/review src\n```",
    "/ralph-loop src",
    "/missing src",
  ])
})

test("processed embedded command is expanded once when admission repeats", async () => {
  // given
  const hook = createNativeAutoSlashCommandHook({ skills: [{ name: "review", template: "expanded" }] })
  const draft = event("/review src")

  // when
  await hook.before(draft)
  const first = draft.prompt.text
  await hook.before(draft)

  // then
  expect(draft.prompt.text).toBe(first)
  expect(draft.prompt.text.match(/<auto-slash-command>/g)).toHaveLength(1)
})

test("#given a native command sharing a skill name #when the same slash is admitted #then the native handler runs and the skill template never reaches the model", async () => {
  // given: the `team-mode` skill and the native `/team-mode` command collide on
  // name. Skills normally win, which is exactly how the visible command drifted
  // into an agentic skill prompt.
  const calls = []
  const hook = createNativeAutoSlashCommandHook({
    skills: [{ name: "team-mode", template: "SKILL BODY: inspect the repo with shell commands before acting" }],
    listCommands: async () => {
      calls.push("listCommands")
      return []
    },
    nativeCommands: {
      "team-mode": async ({ sessionID, args }) => {
        calls.push({ sessionID, args })
        return "DETERMINISTIC: the team was created"
      },
    },
  })
  const draft = event("/team-mode team: host55check. worktree: no")

  // when
  await hook.before(draft)

  // then: the native command owns the name, and discovery/skill expansion is
  // never consulted for it
  expect(calls).toEqual([{ sessionID: "ses_1", args: "team: host55check. worktree: no" }])
  expect(draft.prompt.text).toContain("DETERMINISTIC: the team was created")
  expect(draft.prompt.text).not.toContain("SKILL BODY")
  expect(draft.prompt.text).not.toContain("inspect the repo")
})

test("command resolution gives skills priority before the V1 scope order", () => {
  // given
  const commands = {
    skills: [{ name: "review", template: "skill" }],
    project: [{ name: "review", template: "project" }],
    user: [{ name: "user-only", template: "user" }],
    plugin: [{ name: "user-only", template: "plugin" }],
  }

  // when
  const skill = findCommand("review", commands)
  const user = findCommand("user-only", commands)

  // then
  expect(skill.template).toBe("skill")
  expect(user.template).toBe("user")
  expect(renderCommandTemplate("$ARGUMENTS ${ARGUMENTS} $1 $2", "one two")).toBe("one two one two one two")
})
