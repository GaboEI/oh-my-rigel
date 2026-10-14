import { describe, expect, test } from "bun:test"
import { createSessionTools } from "./session.tools.mjs"

const PROJECT = "/work/rigel"

function ok(data) {
  return { ok: true, status: 200, data, error: null }
}

function fail(message, { status = 500, code = "v2_http_error" } = {}) {
  return { ok: false, status, data: null, error: { code, message } }
}

function message(id, role, text, created, agent) {
  return { id, role, agent, time: { created }, parts: [{ type: "text", text }] }
}

function sessionInfo(id, { updated = 0, directory, location, parentID } = {}) {
  const info = { id, time: { created: updated, updated } }
  if (directory !== undefined) info.directory = directory
  if (location !== undefined) info.location = location
  if (parentID !== undefined) info.parentID = parentID
  return info
}

// Injected HTTP server API double. Records every call and answers with canned
// `{ok,status,data,error}` bodies shaped exactly like `createServerApi`:
//   getSessions      -> { data: { data: Session.Info[], cursor } }
//   getSessionContext-> { data: { data: Message.Info[] } }
//   getSessionExport -> { data: { data: { info, messages } } }
function fakeServerApi({ sessions = [], messagesById = {}, exportsById = {}, contextErrors = {}, sessionsResult } = {}) {
  const calls = { getSessions: [], getSessionContext: [], getSessionExport: [] }
  return {
    calls,
    available: true,
    async getSessions(query = {}) {
      calls.getSessions.push(query)
      if (sessionsResult) return sessionsResult
      return ok({ data: sessions, cursor: undefined })
    },
    async getSessionContext(sessionID) {
      calls.getSessionContext.push(sessionID)
      if (contextErrors[sessionID]) return contextErrors[sessionID]
      return ok({ data: messagesById[sessionID] ?? [] })
    },
    async getSessionExport(sessionID) {
      calls.getSessionExport.push(sessionID)
      if (exportsById[sessionID]) return exportsById[sessionID]
      return ok({ data: { info: { id: sessionID }, messages: messagesById[sessionID] ?? [] } })
    },
  }
}

// The preserved setup-context double: `get` (metadata) + `context` (messages).
function fakeClient({ sessions = [], messagesById = {} } = {}) {
  return {
    session: {
      get: async ({ sessionID }) => ({ data: sessions.find((session) => session.id === sessionID) }),
      context: async ({ sessionID }) => ({ data: messagesById[sessionID] ?? [] }),
    },
  }
}

function toolsFor(input) {
  return createSessionTools({ directory: PROJECT, ...input })
}

describe("#given a session list tool backed by the injected server API", () => {
  test("#when main and child sessions exist #then only main sessions are listed", async () => {
    // given
    const api = fakeServerApi({
      sessions: [
        sessionInfo("ses_parent", { updated: 300, location: { directory: PROJECT } }),
        sessionInfo("ses_child", { updated: 400, parentID: "ses_parent", location: { directory: PROJECT } }),
      ],
      messagesById: {
        ses_parent: [message("m1", "user", "hello", 1)],
        ses_child: [message("m2", "user", "hello", 2)],
      },
    })
    // when
    const output = await toolsFor({ serverApi: api }).session_list.execute({})
    // then
    expect(output).toContain("ses_parent")
    expect(output).not.toContain("ses_child")
  })

  test("#when a project_path matches #then only sessions from that directory are listed", async () => {
    // given
    const api = fakeServerApi({
      sessions: [
        sessionInfo("ses_here", { updated: 2, directory: PROJECT }),
        sessionInfo("ses_elsewhere", { updated: 1, directory: "/work/other" }),
      ],
      messagesById: {
        ses_here: [message("m1", "user", "a", 1)],
        ses_elsewhere: [message("m2", "user", "b", 2)],
      },
    })
    // when
    const output = await toolsFor({ serverApi: api }).session_list.execute({ project_path: PROJECT })
    // then
    expect(output).toContain("ses_here")
    expect(output).not.toContain("ses_elsewhere")
  })

  test("#when a session reports its directory through location #then the filter still matches", async () => {
    // given
    const api = fakeServerApi({
      sessions: [sessionInfo("ses_a", { updated: 2, location: { directory: PROJECT } })],
      messagesById: { ses_a: [message("m1", "user", "a", 1)] },
    })
    // when
    const output = await toolsFor({ serverApi: api }).session_list.execute({ project_path: PROJECT })
    // then
    expect(output).toContain("ses_a")
  })

  test("#when the directory is the root #then no directory filter is applied", async () => {
    // given
    const api = fakeServerApi({
      sessions: [
        sessionInfo("ses_a", { updated: 2, directory: "/work/rigel" }),
        sessionInfo("ses_b", { updated: 1, directory: "/work/other" }),
      ],
      messagesById: {
        ses_a: [message("m1", "user", "a", 1)],
        ses_b: [message("m2", "user", "b", 2)],
      },
    })
    // when
    const output = await createSessionTools({ serverApi: api, directory: "/" }).session_list.execute({})
    // then
    expect(output).toContain("ses_a")
    expect(output).toContain("ses_b")
    expect(api.calls.getSessions[0].directory).toBeUndefined()
  })

  test("#when a from_date is supplied #then sessions whose last message is older are dropped", async () => {
    // given
    const api = fakeServerApi({
      sessions: [
        sessionInfo("ses_old", { updated: 2, directory: PROJECT }),
        sessionInfo("ses_new", { updated: 1, directory: PROJECT }),
      ],
      messagesById: {
        ses_old: [message("m1", "user", "a", Date.parse("2026-01-15T00:00:00Z"))],
        ses_new: [message("m2", "user", "b", Date.parse("2026-03-15T00:00:00Z"))],
      },
    })
    // when
    const output = await toolsFor({ serverApi: api }).session_list.execute({ from_date: "2026-02-01T00:00:00Z" })
    // then
    expect(output).toContain("ses_new")
    expect(output).not.toContain("ses_old")
  })

  test("#when a limit is supplied #then only the newest sessions are kept", async () => {
    // given
    const api = fakeServerApi({
      sessions: [
        sessionInfo("ses_1", { updated: 1, directory: PROJECT }),
        sessionInfo("ses_2", { updated: 2, directory: PROJECT }),
        sessionInfo("ses_3", { updated: 3, directory: PROJECT }),
      ],
      messagesById: {
        ses_1: [message("m1", "user", "a", 1)],
        ses_2: [message("m2", "user", "b", 2)],
        ses_3: [message("m3", "user", "c", 3)],
      },
    })
    // when
    const output = await toolsFor({ serverApi: api }).session_list.execute({ limit: 1 })
    // then
    expect(output).toContain("ses_3")
    expect(output).not.toContain("ses_2")
    expect(output).not.toContain("ses_1")
  })

  test("#when sessions have different update times #then they are listed newest first", async () => {
    // given
    const api = fakeServerApi({
      sessions: [
        sessionInfo("ses_old", { updated: 100, directory: PROJECT }),
        sessionInfo("ses_new", { updated: 900, directory: PROJECT }),
      ],
      messagesById: {
        ses_old: [message("m1", "user", "a", 100)],
        ses_new: [message("m2", "user", "b", 900)],
      },
    })
    // when
    const output = await toolsFor({ serverApi: api }).session_list.execute({})
    // then
    expect(output.indexOf("ses_new")).toBeLessThan(output.indexOf("ses_old"))
  })

  test("#when no sessions exist #then the V1 empty string is returned", async () => {
    // given
    const api = fakeServerApi({ sessions: [] })
    // when
    const output = await toolsFor({ serverApi: api }).session_list.execute({})
    // then
    expect(output).toBe("No sessions found.")
  })

  test("#when sessions exist but none carry messages #then the V1 not-valid string is returned", async () => {
    // given
    const api = fakeServerApi({
      sessions: [sessionInfo("ses_a", { updated: 1, directory: PROJECT })],
      messagesById: { ses_a: [] },
    })
    // when
    const output = await toolsFor({ serverApi: api }).session_list.execute({})
    // then
    expect(output).toBe("No valid sessions found.")
  })

  test("#when the enumerate request fails #then the error message is mapped", async () => {
    // given
    const api = fakeServerApi({
      sessionsResult: fail("OpenCode V2 request failed (HTTP 500): GET /api/session"),
    })
    // when
    const output = await toolsFor({ serverApi: api }).session_list.execute({})
    // then
    expect(output).toBe("Error: OpenCode V2 request failed (HTTP 500): GET /api/session")
  })

  test("#when a context enrichment call fails #then the error message is mapped", async () => {
    // given
    const api = fakeServerApi({
      sessions: [sessionInfo("ses_a", { updated: 1, directory: PROJECT })],
      contextErrors: { ses_a: fail("OpenCode V2 context request failed (HTTP 500): GET /api/session/ses_a/context") },
    })
    // when
    const output = await toolsFor({ serverApi: api }).session_list.execute({})
    // then
    expect(output).toBe("Error: OpenCode V2 context request failed (HTTP 500): GET /api/session/ses_a/context")
  })

  test("#when the server API is absent #then the typed unavailable result is returned", async () => {
    // when
    const output = await toolsFor({}).session_list.execute({})
    // then
    expect(output).toBe("Error: OpenCode V2 server API unavailable")
  })

  test("#when sessions are enumerated #then a high server limit is requested", async () => {
    // given
    const api = fakeServerApi({ sessions: [] })
    // when
    await toolsFor({ serverApi: api }).session_list.execute({})
    // then
    expect(api.calls.getSessions[0].limit).toBeGreaterThanOrEqual(100)
  })
})

describe("#given a session search tool", () => {
  test("#when a session_id is supplied #then only that session is searched", async () => {
    // given
    const api = fakeServerApi({
      sessions: [sessionInfo("ses_a", { updated: 2 }), sessionInfo("ses_b", { updated: 1 })],
      messagesById: {
        ses_a: [message("m1", "user", "needle", 1)],
        ses_b: [message("m2", "user", "needle", 2)],
      },
    })
    // when
    const output = await toolsFor({ serverApi: api }).session_search.execute({ query: "needle", session_id: "ses_b" })
    // then
    expect(output).toContain("[ses_b]")
    expect(output).not.toContain("[ses_a]")
  })

  test("#when no session_id is supplied #then every session is scanned and formats accumulate", async () => {
    // given
    const api = fakeServerApi({
      sessions: [sessionInfo("ses_a", { updated: 2 }), sessionInfo("ses_b", { updated: 1 }), sessionInfo("ses_c", { updated: 3 })],
      messagesById: {
        ses_a: [message("m1", "user", "needle here", 1)],
        ses_b: [message("m2", "assistant", "needle too", 2)],
        ses_c: [message("m3", "user", "nothing", 3)],
      },
    })
    // when
    const output = await toolsFor({ serverApi: api }).session_search.execute({ query: "needle" })
    // then
    expect(output).toContain("Found 2 matches:")
    expect(output).toContain("[ses_a] m1 (user)")
    expect(output).toContain("[ses_b] m2 (assistant)")
    expect(output).not.toContain("[ses_c]")
  })

  test("#when a limit is supplied #then accumulation stops at the limit", async () => {
    // given
    const api = fakeServerApi({
      sessions: [sessionInfo("ses_a", { updated: 3 }), sessionInfo("ses_b", { updated: 2 }), sessionInfo("ses_c", { updated: 1 })],
      messagesById: {
        ses_a: [message("m1", "user", "needle", 3)],
        ses_b: [message("m2", "user", "needle", 2)],
        ses_c: [message("m3", "user", "needle", 1)],
      },
    })
    // when
    const output = await toolsFor({ serverApi: api }).session_search.execute({ query: "needle", limit: 1 })
    // then
    expect(output).toContain("Found 1 matches:")
  })

  test("#when more than 50 sessions exist #then only the newest 50 are scanned", async () => {
    // given
    const sessions = []
    const messagesById = {}
    for (let index = 0; index < 51; index += 1) {
      const id = `ses_${String(index).padStart(2, "0")}`
      sessions.push(sessionInfo(id, { updated: index + 1 }))
      messagesById[id] = [message(`m-${id}`, "user", index === 0 ? "needle" : "nothing", index + 1)]
    }
    const api = fakeServerApi({ sessions, messagesById })
    // when
    const output = await toolsFor({ serverApi: api }).session_search.execute({ query: "needle" })
    // then
    expect(output).toBe("No matches found.")
    expect(api.calls.getSessionContext).toHaveLength(50)
  })

  test("#when case_sensitive is set #then the match case is enforced", async () => {
    // given
    const api = fakeServerApi({
      sessions: [sessionInfo("ses_a", { updated: 1 })],
      messagesById: { ses_a: [message("m1", "user", "ULTRAWORK", 1)] },
    })
    // when
    const insensitive = await toolsFor({ serverApi: api }).session_search.execute({ query: "ultrawork" })
    const sensitive = await toolsFor({ serverApi: api }).session_search.execute({ query: "ultrawork", case_sensitive: true })
    // then
    expect(insensitive).toContain("Found 1 matches:")
    expect(sensitive).toBe("No matches found.")
  })

  test("#when the query is missing #then the V1 error is returned", async () => {
    // given
    const api = fakeServerApi({})
    // when
    const output = await toolsFor({ serverApi: api }).session_search.execute({})
    // then
    expect(output).toBe("Error: Missing required parameter 'query'.")
  })

  test("#when the server API is absent for a global search #then the typed unavailable result is returned", async () => {
    // when
    const output = await toolsFor({}).session_search.execute({ query: "needle" })
    // then
    expect(output).toBe("Error: OpenCode V2 server API unavailable")
  })
})

describe("#given a setup-context client that can enumerate sessions", () => {
  // A setup-context double whose `session` surface exposes `list`, so the tools
  // can enumerate through the client instead of an injected HTTP server API.
  function fakeListClient({ sessions = [], messagesById = {} } = {}) {
    return {
      session: {
        list: async () => ({ data: sessions }),
        get: async ({ sessionID }) => ({ data: sessions.find((s) => s.id === sessionID) }),
        context: async ({ sessionID }) => ({ data: messagesById[sessionID] ?? [] }),
      },
    }
  }

  test("#when a setup-context client can list sessions and no server API is present #then session_list enumerates through the client", async () => {
    // given
    const client = fakeListClient({
      sessions: [
        sessionInfo("ses_parent", { updated: 300, directory: PROJECT }),
        sessionInfo("ses_child", { updated: 400, parentID: "ses_parent", directory: PROJECT }),
      ],
      messagesById: {
        ses_parent: [message("m1", "user", "hello", 1)],
        ses_child: [message("m2", "user", "hello", 2)],
      },
    })
    // when
    const output = await createSessionTools({ clients: [client], directory: PROJECT }).session_list.execute({})
    // then
    expect(output).toContain("ses_parent")
    expect(output).not.toContain("ses_child")
    expect(output).not.toBe("Error: OpenCode V2 server API unavailable")
  })

  test("#when a project_path is supplied to a client-enumerated list #then the directory filter still applies", async () => {
    // given
    const client = fakeListClient({
      sessions: [
        sessionInfo("ses_here", { updated: 2, directory: PROJECT }),
        sessionInfo("ses_elsewhere", { updated: 1, directory: "/work/other" }),
      ],
      messagesById: {
        ses_here: [message("m1", "user", "a", 1)],
        ses_elsewhere: [message("m2", "user", "b", 2)],
      },
    })
    // when
    const output = await createSessionTools({ clients: [client], directory: PROJECT }).session_list.execute({ project_path: PROJECT })
    // then
    expect(output).toContain("ses_here")
    expect(output).not.toContain("ses_elsewhere")
  })

  test("#when a setup-context client can list sessions and no server API is present #then a global session_search scans client sessions", async () => {
    // given
    const client = fakeListClient({
      sessions: [sessionInfo("ses_a", { updated: 2 }), sessionInfo("ses_b", { updated: 1 })],
      messagesById: {
        ses_a: [message("m1", "user", "needle", 1)],
        ses_b: [message("m2", "user", "nothing", 2)],
      },
    })
    // when
    const output = await createSessionTools({ clients: [client], directory: PROJECT }).session_search.execute({ query: "needle" })
    // then
    expect(output).toContain("Found 1 matches:")
    expect(output).toContain("[ses_a]")
    expect(output).not.toContain("[ses_b]")
  })
})

describe("#given a session read tool", () => {
  test("#when the session reports no messages #then the V1 not-found string is returned", async () => {
    // given
    const api = fakeServerApi({ messagesById: {} })
    // when
    const output = await toolsFor({ serverApi: api }).session_read.execute({ session_id: "ses_missing" })
    // then
    expect(output).toBe("Session not found: ses_missing")
  })

  test("#when the context endpoint reports 404 #then it is treated as not found", async () => {
    // given
    const api = fakeServerApi({
      contextErrors: {
        ses_missing: fail("OpenCode V2 endpoint not found (HTTP 404): GET /api/session/ses_missing/context", {
          status: 404,
          code: "v2_http_not_found",
        }),
      },
    })
    // when
    const output = await toolsFor({ serverApi: api }).session_read.execute({ session_id: "ses_missing" })
    // then
    expect(output).toBe("Session not found: ses_missing")
  })

  test("#when session_id is missing #then the V1 error is returned", async () => {
    // given
    const api = fakeServerApi({})
    // when
    const output = await toolsFor({ serverApi: api }).session_read.execute({})
    // then
    expect(output).toBe("Error: Missing required parameter 'session_id'.")
  })

  test("#when from_end and limit are set #then the last messages are kept", async () => {
    // given
    const api = fakeServerApi({
      messagesById: {
        ses_a: [
          message("m1", "user", "first", Date.parse("2026-01-01T00:00:00Z")),
          message("m2", "assistant", "second", Date.parse("2026-01-01T00:01:00Z"), "build"),
        ],
      },
    })
    // when
    const output = await toolsFor({ serverApi: api }).session_read.execute({ session_id: "ses_a", limit: 1, from_end: true })
    // then
    expect(output).toContain("second")
    expect(output).not.toContain("first")
  })

  test("#when include_transcript is not set #then no transcript block is appended", async () => {
    // given
    const api = fakeServerApi({
      messagesById: { ses_a: [message("m1", "user", "hello", 1)] },
      exportsById: {
        ses_a: ok({ data: { info: { id: "ses_a" }, messages: [message("m1", "user", "hello", 1)] } }),
      },
    })
    // when
    const output = await toolsFor({ serverApi: api }).session_read.execute({ session_id: "ses_a" })
    // then
    expect(output).not.toContain("=== Transcript")
    expect(api.calls.getSessionExport).toHaveLength(0)
  })

  test("#when include_transcript is set and the export succeeds #then the transcript block is appended", async () => {
    // given
    const api = fakeServerApi({
      messagesById: {
        ses_a: [message("m1", "user", "hello", 1), message("m2", "assistant", "world", 2, "build")],
      },
      exportsById: {
        ses_a: ok({
          data: { info: { id: "ses_a" }, messages: [message("m1", "user", "hello", 1), message("m2", "assistant", "world", 2, "build")] },
        }),
      },
    })
    // when
    const output = await toolsFor({ serverApi: api }).session_read.execute({ session_id: "ses_a", include_transcript: true })
    // then
    expect(output).toContain("=== Transcript (2 entries) ===")
    expect(output).toContain("user/text")
  })

  test("#when include_transcript is set and the export fails #then the reason is stated explicitly", async () => {
    // given
    const api = fakeServerApi({
      messagesById: { ses_a: [message("m1", "user", "hello", 1)] },
      exportsById: { ses_a: fail("OpenCode V2 request failed (HTTP 503): GET /api/experimental/session/ses_a/export") },
    })
    // when
    const output = await toolsFor({ serverApi: api }).session_read.execute({ session_id: "ses_a", include_transcript: true })
    // then
    expect(output).toContain("transcript: unavailable (")
    expect(output).toContain("HTTP 503")
  })
})

describe("#given a session info tool", () => {
  test("#when the export carries entries #then the transcript count is reported", async () => {
    // given
    const api = fakeServerApi({
      messagesById: {
        ses_a: [message("m1", "user", "a", Date.parse("2026-01-01T00:00:00Z")), message("m2", "assistant", "b", Date.parse("2026-01-02T00:00:00Z"))],
      },
      exportsById: {
        ses_a: ok({
          data: {
            info: { id: "ses_a" },
            messages: [message("m1", "user", "a", Date.parse("2026-01-01T00:00:00Z")), message("m2", "assistant", "b", Date.parse("2026-01-02T00:00:00Z"))],
          },
        }),
      },
    })
    // when
    const output = await toolsFor({ serverApi: api }).session_info.execute({ session_id: "ses_a" })
    // then
    expect(output).toContain("Session ID: ses_a")
    expect(output).toContain("Messages: 2")
    expect(output).toContain("Has Transcript: Yes (2 entries)")
  })

  test("#when the export is empty #then no transcript is reported", async () => {
    // given
    const api = fakeServerApi({
      messagesById: { ses_a: [message("m1", "user", "a", 1)] },
      exportsById: { ses_a: ok({ data: { info: { id: "ses_a" }, messages: [] } }) },
    })
    // when
    const output = await toolsFor({ serverApi: api }).session_info.execute({ session_id: "ses_a" })
    // then
    expect(output).toContain("Has Transcript: No")
  })

  test("#when the session does not exist #then the V1 not-found string is returned", async () => {
    // given
    const api = fakeServerApi({ messagesById: {} })
    // when
    const output = await toolsFor({ serverApi: api }).session_info.execute({ session_id: "ses_missing" })
    // then
    expect(output).toBe("Session not found: ses_missing")
  })

  test("#when session_id is missing #then the V1 error is returned", async () => {
    // given
    const api = fakeServerApi({})
    // when
    const output = await toolsFor({ serverApi: api }).session_info.execute({})
    // then
    expect(output).toBe("Error: Missing required parameter 'session_id'.")
  })

  test("#when agents are present #then they are reported", async () => {
    // given
    const api = fakeServerApi({
      messagesById: {
        ses_a: [message("m1", "assistant", "a", Date.parse("2026-01-01T00:00:00Z"), "oracle")],
      },
    })
    // when
    const output = await toolsFor({ serverApi: api }).session_info.execute({ session_id: "ses_a" })
    // then
    expect(output).toContain("Agents Used: oracle")
  })
})

describe("#given the preserved setup-context session domain", () => {
  test("#when a client is injected #then scoped read and info work without a server API", async () => {
    // given
    const client = fakeClient({
      sessions: [{ id: "ses_a" }],
      messagesById: { ses_a: [message("m1", "user", "work", Date.parse("2026-01-01T00:00:00Z"))] },
    })
    const readTodos = async (sessionID) => (sessionID === "ses_a" ? [{ id: "T-1", content: "ship it", status: "pending" }] : [])
    const tools = createSessionTools({ clients: [client], readTodos })
    // when
    const read = await tools.session_read.execute({ session_id: "ses_a", include_todos: true })
    const info = await tools.session_info.execute({ session_id: "ses_a" })
    // then
    expect(read).toContain("[user]")
    expect(read).toContain("=== Todos ===")
    expect(read).toContain("[ ] [pending] ship it")
    expect(info).toContain("Has Todos: Yes (1 items)")
  })
})
