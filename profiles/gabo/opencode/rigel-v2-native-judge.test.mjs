/**
 * Owner test for the Judge agent's selectable id and read-only contract (finding N7).
 *
 * N7 was reported as "the runtime does not register Judge". The independent live
 * reproduction showed the opposite: the agent IS registered, under the canonical
 * id `judge`, and only `--agent Judge` (the display name) fails because OpenCode
 * selects by id. This test pins the contract that makes that true and stops it
 * from drifting, at the real boundaries:
 *   - the profile selection declares the Judge under the id `judge`
 *   - the REAL judge.v2.json, consumed by the REAL definition applier, yields an
 *     agent with mode `primary` and the read-only guarantees intact (edit and
 *     todowrite deny) — making the id explicit must NOT weaken the Judge
 *   - the REAL definition registers under the id `judge`
 *
 * Authoring gate: (1) protects the Judge's selectable id + read-only security
 * contract; (2) a rename to `Judge`/an alias, or an edit/todowrite permission
 * grant, fails it; (3) no existing test consumes judge.v2.json through the
 * applier or pins its permissions; (4) no production seam is added — it uses the
 * exported applier and registrar the runtime already uses.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { applyLegacyAgentDefinition, registerNativeAgents } from "./rigel-v2-native-agents.mjs"

const PROFILE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..")
const selection = JSON.parse(readFileSync(join(PROFILE_DIR, "v2-agent-selection.json"), "utf8"))
const judgeDefinition = JSON.parse(readFileSync(join(PROFILE_DIR, selection.independentJudge.definition), "utf8"))

function effectFor(rules, action) {
  return (rules ?? []).find((rule) => rule.action === action && rule.resource === "*")?.effect
}

describe("Judge selectable id and read-only contract", () => {
  test("#given the profile selection #then the Judge is declared under the canonical id judge", () => {
    expect(selection.independentJudge.id).toBe("judge")
    expect(selection.independentJudge.removeRigelLegacyAlias).toBe("juez")
    // the definition carries the same explicit id it is registered under
    expect(judgeDefinition.id).toBe(selection.independentJudge.id)
  })

  test("#given the real judge.v2.json #then the applier keeps it primary and read-only", () => {
    const agent = { request: {}, permissions: [] }
    const applied = applyLegacyAgentDefinition(agent, selection.independentJudge.id, judgeDefinition)

    expect(agent.mode).toBe("primary")
    expect(agent.name).toBe("Judge")
    expect(effectFor(applied.rules, "edit")).toBe("deny")
    expect(effectFor(applied.rules, "todowrite")).toBe("deny")
  })

  test("#given the real judge.v2.json #then it registers under the id judge", async () => {
    const updated = []
    const editor = {
      update: (id) => { updated.push(id) },
      set: () => {},
      get: () => undefined,
    }
    const agentDomain = {
      transform: async (callback) => { callback(editor); return { dispose() {} } },
      reload: async () => {},
    }

    const registered = await registerNativeAgents(agentDomain, {
      agents: { [selection.independentJudge.id]: judgeDefinition },
    })

    expect(registered).toEqual(["judge"])
    expect(updated).toEqual(["judge"])
  })
})
