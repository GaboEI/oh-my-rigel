import { describe, expect, test } from "bun:test"
import { buildCategorySkillReminderMessage, createNativeCategorySkillReminder } from "./rigel-v2-native-category-skill-reminder.mjs"

const MARKER = "[Category+Skill Reminder]"

function agentResolver(agentsBySession) {
  return ({ sessionID }) => agentsBySession[sessionID]
}

async function useTools(hook, sessionID, tools, agent) {
  for (const tool of tools) {
    await hook.after({ tool, sessionID, agent })
  }
}

const NEUTRAL_REMINDER = "You have performed several operations directly. Consider delegating through the modality that fits this task (category, specialist, or team, as appropriate), following the available orchestration tools and rules; continuing directly is also valid."

function expectedMessage({ builtinText, customText }) {
  return [
    "",
    MARKER,
    "",
    `**Built-in**: ${builtinText}`,
    `**⚡ YOUR SKILLS (PRIORITY)**: ${customText}`,
    "",
    "> User-installed skills OVERRIDE built-in defaults. ALWAYS prefer YOUR SKILLS when domain matches.",
    "",
    NEUTRAL_REMINDER,
    "",
  ].join("\n")
}

describe("native category-skill reminder: threshold and targeting", () => {
  test.each([
    "sisyphus",
    "sisyphus-junior",
    "atlas",
    "Sisyphus - ultraworker",
    "3|Sisyphus",
    "Atlas - Plan Executor",
  ])("#given target agent %s #when three delegatable tools finish #then a pending reminder is armed", async (agent) => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => agent })

    await useTools(hook, `ses-${agent}`, ["edit", "shell", "write"])

    const pending = hook.pending(`ses-${agent}`)
    expect(pending).not.toBe("")
    expect(pending).toContain(MARKER)
  })

  test("#given a target agent inline on the event #when three delegatable tools finish #then the reminder is armed", async () => {
    const hook = createNativeCategorySkillReminder()

    await useTools(hook, "ses-inline", ["read", "grep", "glob"], "Sisyphus")

    expect(hook.pending("ses-inline")).toContain(MARKER)
  })

  test("#given an async session-agent resolver #when three delegatable tools finish #then the reminder is armed", async () => {
    const hook = createNativeCategorySkillReminder({
      getAgent: async ({ sessionID }) => (sessionID === "ses-async" ? "Atlas - Plan Executor" : undefined),
    })

    await useTools(hook, "ses-async", ["edit", "edit", "edit"])

    expect(hook.pending("ses-async")).toContain(MARKER)
  })

  test("#given fewer than three delegatable tools #when they finish #then nothing is pending", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })

    await useTools(hook, "ses-two", ["edit", "read"])

    expect(hook.pending("ses-two")).toBe("")
  })

  test("#given non-listed tools #when many finish #then the counter is untouched and nothing is pending", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })

    await useTools(hook, "ses-ignored", ["lsp_symbols", "lsp_goto_definition", "todowrite", "webfetch", "skill"])

    expect(hook.pending("ses-ignored")).toBe("")
  })

  test("#given a non-target agent #when three delegatable tools finish #then nothing is pending", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "librarian" })

    await useTools(hook, "ses-librarian", ["edit", "edit", "edit"])

    expect(hook.pending("ses-librarian")).toBe("")
  })

  test("#given no resolvable agent #when three delegatable tools finish #then nothing is pending", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => undefined })

    await useTools(hook, "ses-anon", ["edit", "edit", "edit"])

    expect(hook.pending("ses-anon")).toBe("")
  })

  test("#given a target agent #when the threshold is reached #then the tool output is not mutated", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })
    const event = { tool: "read", sessionID: "ses-bytes", agent: "Sisyphus", result: { content: "original\r\nbytes\u0000" } }

    await hook.after(event)
    await hook.after(event)
    await hook.after(event)

    expect(event.result.content).toBe("original\r\nbytes\u0000")
    expect(hook.pending("ses-bytes")).toContain(MARKER)
  })
})

describe("native category-skill reminder: delegation suppression", () => {
  test.each([
    { tool: "task", order: "before", tools: ["task", "edit", "edit", "edit"] },
    { tool: "task", order: "after", tools: ["edit", "edit", "edit", "task"] },
    { tool: "call_omo_agent", order: "before", tools: ["call_omo_agent", "edit", "edit", "edit"] },
    { tool: "call_omo_agent", order: "after", tools: ["edit", "edit", "edit", "call_omo_agent"] },
    { tool: "rigel_task", order: "before", tools: ["rigel_task", "read", "grep", "glob"] },
    { tool: "rigel_task", order: "after", tools: ["read", "grep", "glob", "rigel_task"] },
  ])("#given $tool finishes $order the threshold #when the sequence completes #then nothing is pending", async ({ tools }) => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })

    await useTools(hook, "ses-delegation", tools)

    expect(hook.pending("ses-delegation")).toBe("")
  })

  test("#given a delegation tool already used #when the threshold is reached again #then delegation stays suppressed", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })

    await useTools(hook, "ses-locked", ["task"])
    await useTools(hook, "ses-locked", ["edit", "edit", "edit"])
    await useTools(hook, "ses-locked", ["read", "read", "read"])

    expect(hook.pending("ses-locked")).toBe("")
  })
})

describe("native category-skill reminder: once per session and clear", () => {
  test("#given an armed reminder #when consumed #then pending clears and a later threshold stays empty", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })
    await useTools(hook, "ses-once", ["edit", "write", "shell"])

    const armed = hook.pending("ses-once")
    const consumed = hook.consume("ses-once")

    expect(armed).toContain(MARKER)
    expect(consumed).toBe(armed)
    expect(hook.pending("ses-once")).toBe("")
    expect(hook.consume("ses-once")).toBe("")

    await useTools(hook, "ses-once", ["edit", "write", "shell"])
    expect(hook.pending("ses-once")).toBe("")
  })

  test("#given a consumed reminder #when delegatable tools finish #then the session is not re-armed", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })
    await useTools(hook, "ses-consumed", ["read", "read", "read"])
    hook.consume("ses-consumed")

    await useTools(hook, "ses-consumed", ["read", "read", "read", "read"])

    expect(hook.pending("ses-consumed")).toBe("")
  })

  test("#given an armed reminder #when the session is cleared #then a fresh threshold re-arms it", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })
    await useTools(hook, "ses-clear", ["edit", "edit", "edit"])
    expect(hook.pending("ses-clear")).toContain(MARKER)

    hook.clear("ses-clear")
    expect(hook.pending("ses-clear")).toBe("")

    await useTools(hook, "ses-clear", ["edit", "edit", "edit"])
    expect(hook.pending("ses-clear")).toContain(MARKER)
  })

  test("#given state in multiple sessions #when only one is cleared #then the others keep their state", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })
    await useTools(hook, "ses-a", ["edit", "edit", "edit"])
    await useTools(hook, "ses-b", ["edit", "edit", "edit"])

    hook.clear("ses-a")

    expect(hook.pending("ses-a")).toBe("")
    expect(hook.pending("ses-b")).toContain(MARKER)

    hook.clearAll()
    expect(hook.pending("ses-b")).toBe("")
  })
})

describe("native category-skill reminder: formatter", () => {
  test("#given built-in skills #when the reminder fires #then built-in names fill the Built-in line and load_skills picks the first built-in", async () => {
    const hook = createNativeCategorySkillReminder({
      getSkills: () => [
        { name: "frontend", location: "plugin" },
        { name: "git-master", location: "builtin" },
      ],
      getAgent: () => "Sisyphus",
    })
    await useTools(hook, "ses-builtin", ["read", "read", "read"])

    const message = hook.pending("ses-builtin")
    expect(message).toBe(expectedMessage({
      builtinText: "frontend, git-master",
      customText: "(none)",
    }))
    expect(message).toContain("**Built-in**: frontend, git-master")
    expect(message).toContain("**⚡ YOUR SKILLS (PRIORITY)**: (none)")
  })

  test("#given a user skill beside a built-in #when the reminder fires #then the user skill leads YOUR SKILLS and load_skills", async () => {
    const hook = createNativeCategorySkillReminder({
      getSkills: () => [
        { name: "frontend", location: "plugin" },
        { name: "react-19", location: "user" },
      ],
      getAgent: () => "Sisyphus",
    })
    await useTools(hook, "ses-custom", ["read", "read", "read"])

    const message = hook.pending("ses-custom")
    expect(message).toBe(expectedMessage({
      builtinText: "frontend",
      customText: "react-19",
    }))
    expect(message).toContain("**Built-in**: frontend")
    expect(message).toContain("**⚡ YOUR SKILLS (PRIORITY)**: react-19")
  })

  test("#given no skills #when the reminder fires #then both lists read (none) and load_skills is empty", async () => {
    const hook = createNativeCategorySkillReminder({ getSkills: () => [], getAgent: () => "Sisyphus" })
    await useTools(hook, "ses-none", ["read", "read", "read"])

    const message = hook.pending("ses-none")
    expect(message).toBe(expectedMessage({ builtinText: "(none)", customText: "(none)" }))
    expect(message).toContain("**Built-in**: (none)")
    expect(message).toContain("**⚡ YOUR SKILLS (PRIORITY)**: (none)")
  })

  test("#given more than eight skills in a list #when formatted #then only eight show and the count is appended", async () => {
    const builtin = Array.from({ length: 10 }, (_value, index) => ({ name: `builtin-${index + 1}`, location: "plugin" }))
    const custom = Array.from({ length: 9 }, (_value, index) => ({ name: `custom-${index + 1}`, location: "user" }))
    const hook = createNativeCategorySkillReminder({
      getSkills: () => [...builtin, ...custom],
      getAgent: () => "Sisyphus",
    })
    await useTools(hook, "ses-more", ["read", "read", "read"])

    const message = hook.pending("ses-more")
    expect(message).toContain("**Built-in**: builtin-1, builtin-2, builtin-3, builtin-4, builtin-5, builtin-6, builtin-7, builtin-8 (+2 more)")
    expect(message).toContain("**⚡ YOUR SKILLS (PRIORITY)**: custom-1, custom-2, custom-3, custom-4, custom-5, custom-6, custom-7, custom-8 (+1 more)")
  })

  test("#given skills with no location or source #when classified #then they count as user skills", async () => {
    const hook = createNativeCategorySkillReminder({
      getSkills: () => [{ name: "loose" }],
      getAgent: () => "Sisyphus",
    })
    await useTools(hook, "ses-loose", ["read", "read", "read"])

    const message = hook.pending("ses-loose")
    expect(message).toContain("**Built-in**: (none)")
    expect(message).toContain("**⚡ YOUR SKILLS (PRIORITY)**: loose")
  })
})

describe("native category-skill reminder: D1 (shell counts) and D2 (neutral text)", () => {
  test("#given a target agent #when three shell tools finish #then the reminder is armed and the tool output is untouched (D1 positive + no side effects)", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })
    const event = { tool: "shell", sessionID: "ses-shell", agent: "Sisyphus", result: { content: "original\r\nbytes\u0000" } }

    await hook.after(event)
    await hook.after(event)
    await hook.after(event)

    expect(hook.pending("ses-shell")).toContain(MARKER)
    expect(event.result.content).toBe("original\r\nbytes\u0000")
  })

  test("#given a target agent #when only two shell tools finish #then nothing is armed (D1 threshold boundary)", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })

    await useTools(hook, "ses-shell-two", ["shell", "shell"])

    expect(hook.pending("ses-shell-two")).toBe("")
  })

  test("#given the former V1 name bash #when three bash tools finish #then the counter is untouched and nothing is armed (D1 negative)", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })

    await useTools(hook, "ses-bash", ["bash", "bash", "bash"])

    expect(hook.pending("ses-bash")).toBe("")
  })

  test("#given the reminder fires #when the block is built #then it is neutral: no tool/API name, the three modalities by intent, and freedom to continue (D2)", async () => {
    const hook = createNativeCategorySkillReminder({
      getSkills: () => [{ name: "frontend", location: "plugin" }],
      getAgent: () => "Sisyphus",
    })

    await useTools(hook, "ses-text", ["read", "read", "read"])
    const message = hook.pending("ses-text")

    expect(message).toContain(NEUTRAL_REMINDER)
    expect(message).toContain("category, specialist, or team")
    expect(message).toContain("continuing directly is also valid")
    // no tool or API name is embedded: nothing nonexistent, old, or unexposed is pushed
    expect(message).not.toContain("rigel_task")
    expect(message).not.toContain("team_")
    expect(message).not.toContain("task(")
    expect(message).not.toContain("```")
  })

  test("#given a target agent #when delegation precedes the shell threshold #then delegation still suppresses the reminder (non regression)", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })

    await useTools(hook, "ses-shell-deleg", ["rigel_task", "shell", "shell", "shell"])

    expect(hook.pending("ses-shell-deleg")).toBe("")
  })

  test("#given a non-target agent #when three shell tools finish #then nothing is armed (non regression)", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "librarian" })

    await useTools(hook, "ses-shell-librarian", ["shell", "shell", "shell"])

    expect(hook.pending("ses-shell-librarian")).toBe("")
  })

  test("#given three shell tools arm the reminder #when consumed #then a later shell threshold stays empty (pending/consume, non regression)", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })
    await useTools(hook, "ses-shell-once", ["shell", "shell", "shell"])

    const armed = hook.pending("ses-shell-once")
    expect(armed).toContain(MARKER)
    expect(hook.consume("ses-shell-once")).toBe(armed)
    expect(hook.pending("ses-shell-once")).toBe("")

    await useTools(hook, "ses-shell-once", ["shell", "shell", "shell"])
    expect(hook.pending("ses-shell-once")).toBe("")
  })

  test("#given a tool result that only mentions a delegation tool #when the threshold is reached #then the reminder still arms (a textual mention does not suppress; only a real delegation does)", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })
    const event = { tool: "read", sessionID: "ses-mention", agent: "Sisyphus", result: { content: "next time call rigel_task with subagent_type explore" } }

    await hook.after(event)
    await hook.after(event)
    await hook.after(event)

    expect(hook.pending("ses-mention")).toContain(MARKER)
  })
})

// Category and specialist delegation both go through the `rigel_task` tool
// name, already covered by the "delegation suppression" describe above. These
// tests cover the third interface (team) added by the G3 corrective.
describe("native category-skill reminder: real delegation via the team interface suppresses", () => {
  test.each(["team_create", "team_send_message", "team_task_create"])(
    "#given a target agent #when the team delegation action %s runs before the threshold #then the reminder stays suppressed",
    async (tool) => {
      const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })

      await useTools(hook, `ses-team-${tool}`, [tool, "read", "read", "read"])

      expect(hook.pending(`ses-team-${tool}`)).toBe("")
    },
  )

  test.each(["team_status", "team_list", "team_task_list", "team_task_get"])(
    "#given a target agent #when only the read-only team query %s runs #then it neither counts nor suppresses the reminder",
    async (tool) => {
      const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })

      await useTools(hook, `ses-query-${tool}`, [tool, tool, tool, tool])
      expect(hook.pending(`ses-query-${tool}`)).toBe("")

      await useTools(hook, `ses-query-${tool}`, ["read", "read", "read"])
      expect(hook.pending(`ses-query-${tool}`)).toContain(MARKER)
    },
  )

  test.each(["team_delete", "team_shutdown_request", "team_approve_shutdown", "team_reject_shutdown"])(
    "#given a target agent #when only the team lifecycle action %s runs #then it neither counts nor suppresses the reminder",
    async (tool) => {
      const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })

      await useTools(hook, `ses-life-${tool}`, [tool, tool, tool, tool])
      expect(hook.pending(`ses-life-${tool}`)).toBe("")

      await useTools(hook, `ses-life-${tool}`, ["read", "read", "read"])
      expect(hook.pending(`ses-life-${tool}`)).toContain(MARKER)
    },
  )

  test("#given a target agent #when the team delegation action runs after the threshold armed #then pending is dropped and the session never re-arms", async () => {
    const hook = createNativeCategorySkillReminder({ getAgent: () => "Sisyphus" })

    await useTools(hook, "ses-team-after", ["read", "read", "read"])
    expect(hook.pending("ses-team-after")).toContain(MARKER)

    await hook.after({ tool: "team_send_message", sessionID: "ses-team-after", agent: "Sisyphus" })
    expect(hook.pending("ses-team-after")).toBe("")
    expect(hook.consume("ses-team-after")).toBe("")

    await useTools(hook, "ses-team-after", ["read", "read", "read"])
    expect(hook.pending("ses-team-after")).toBe("")
  })
})
