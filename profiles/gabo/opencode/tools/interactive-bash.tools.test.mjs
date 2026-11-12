import { describe, expect, test } from "bun:test"
import {
  buildAdaptedBlockedTmuxCommandMessage,
  buildBlockedTmuxCommandMessage,
  buildProhibitedTmuxCommandMessage,
  classifyTmuxCommand,
  createInteractiveBashTool,
  createPtyCommandRunner,
  detectTmuxAvailability,
  findExecutableOnPath,
  findSubcommandIndex,
  INTERACTIVE_BASH_TOOL_NAME,
  tokenizeCommand,
} from "./interactive-bash.tools.mjs"

describe("interactive_bash tokenizer and subcommand resolution", () => {
  test("tokenizes quoted and escaped arguments like the V1 tool", () => {
    expect(tokenizeCommand('send-keys -t omo-dev "vim file" Enter')).toEqual(["send-keys", "-t", "omo-dev", "vim file", "Enter"])
    expect(tokenizeCommand("new-session -d -s 'my session'")).toEqual(["new-session", "-d", "-s", "my session"])
    expect(tokenizeCommand("send-keys -t s hello\\ world")).toEqual(["send-keys", "-t", "s", "hello world"])
  })

  test("finds the subcommand past global options that take an argument", () => {
    expect(findSubcommandIndex(["-L", "demo", "kill-server"])).toBe(2)
    expect(findSubcommandIndex(["-f", "/tmp/x.conf", "list-sessions"])).toBe(2)
    expect(findSubcommandIndex(["--", "kill-server"])).toBe(1)
  })

  test("classifies prohibited and blocked subcommands case-insensitively", () => {
    expect(classifyTmuxCommand(["-L", "demo", "KILL-SERVER"])).toEqual({ kind: "prohibited", rawSubcommand: "KILL-SERVER" })
    expect(classifyTmuxCommand(["capture-pane", "-p"])).toEqual({ kind: "blocked", rawSubcommand: "capture-pane" })
    expect(classifyTmuxCommand(["send-keys", "-t", "s", "ls", "Enter"])).toEqual({ kind: "allowed", rawSubcommand: "send-keys" })
  })

  test("blocked message points at Bash and names the target session", () => {
    const message = buildBlockedTmuxCommandMessage("capture-pane", ["capture-pane", "-t", "omo-dev"])
    expect(message).toContain("Error: 'capture-pane' is blocked in interactive_bash.")
    expect(message).toContain("tmux capture-pane -p -t omo-dev")
    expect(message).toContain("Do NOT retry with interactive_bash.")
  })

  test("adapted blocked message points at the read action and drops the Bash route", () => {
    const message = buildAdaptedBlockedTmuxCommandMessage("capture-pane", ["capture-pane", "-t", "omo-dev"])
    expect(message).toContain("Error: 'capture-pane' is blocked in interactive_bash.")
    expect(message).toContain('"action": "read"')
    expect(message).toContain("omo-dev")
    expect(message).not.toContain("USE BASH TOOL INSTEAD")
  })

  test("prohibited message forbids kill-server", () => {
    expect(buildProhibitedTmuxCommandMessage("kill-server")).toContain("NEVER EVER run tmux kill-server from interactive_bash.")
  })
})

describe("interactive_bash tool execution", () => {
  function toolWithRunner(runner) {
    return createInteractiveBashTool({ runner, tmuxPath: "/usr/bin/tmux" })
  }

  test("rejects an empty command before running anything", async () => {
    let calls = 0
    const tool = toolWithRunner({ run: async () => { calls++; return { stdout: "", stderr: "", exitCode: 0 } } })
    expect(await tool.execute({ tmux_command: "   " })).toBe("Error: Empty tmux command")
    expect(calls).toBe(0)
  })

  test("returns the strong prohibition for kill-server without invoking the runner", async () => {
    let calls = 0
    const tool = toolWithRunner({ run: async () => { calls++; return { stdout: "", stderr: "", exitCode: 0 } } })
    const output = await tool.execute({ tmux_command: "-L omo-socket kill-server" })
    expect(output).toContain("Error: 'kill-server' is prohibited in interactive_bash.")
    expect(calls).toBe(0)
  })

  test("returns the blocked message for capture-pane without invoking the runner", async () => {
    const tool = toolWithRunner({ run: async () => ({ stdout: "should not run", stderr: "", exitCode: 0 }) })
    const output = await tool.execute({ tmux_command: "capture-pane -t omo-dev" })
    expect(output).toContain("'capture-pane' is blocked")
  })

  test("passes the tmux path and tokenized args to the V2 runner and returns stdout", async () => {
    const calls = []
    const tool = toolWithRunner({ run: async (input) => { calls.push(input); return { stdout: "session-1\n", stderr: "", exitCode: 0 } } })
    expect(await tool.execute({ tmux_command: "list-sessions" })).toBe("session-1\n")
    expect(calls).toEqual([{ command: "/usr/bin/tmux", args: ["list-sessions"], timeoutMs: 60000 }])
  })

  test("returns (no output) for an empty successful result", async () => {
    const tool = toolWithRunner({ run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) })
    expect(await tool.execute({ tmux_command: "new-session -d -s s" })).toBe("(no output)")
  })

  test("formats a non-zero exit like V1: stderr first, exit code fallback", async () => {
    const stderrTool = toolWithRunner({ run: async () => ({ stdout: "", stderr: "no server running\n", exitCode: 1 }) })
    expect(await stderrTool.execute({ tmux_command: "list-sessions" })).toBe("Error: no server running")
    const bareTool = toolWithRunner({ run: async () => ({ stdout: "", stderr: "", exitCode: 3 }) })
    expect(await bareTool.execute({ tmux_command: "list-sessions" })).toBe("Error: Command failed with exit code 3")
  })

  test("surfaces a runner failure as a V1-style Error string", async () => {
    const tool = toolWithRunner({ run: async () => { throw new Error("Timeout after 60000ms") } })
    expect(await tool.execute({ tmux_command: "list-sessions" })).toBe("Error: Timeout after 60000ms")
  })

  test("exposes the V1 tool name and the combined JSON Schema input", () => {
    const tool = toolWithRunner({ run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) })
    expect(tool.name).toBe(INTERACTIVE_BASH_TOOL_NAME)
    expect(Object.keys(tool.input.properties)).toContain("action")
    expect(Object.keys(tool.input.properties)).toContain("tmux_command")
    expect(tool.input.required).toEqual([])
  })
})

describe("interactive_bash persistent-terminal (no tmux) path", () => {
  function createFakeTerminalFactory() {
    const calls = { start: [], write: [], snapshot: [], remove: [], list: 0 }
    // Chronology of the PTY-touching calls and permission assertions.
    const order = []
    const terminals = []
    let nextId = 1
    const port = {
      async start(input) {
        calls.start.push(input)
        order.push("start")
        const ptyID = `pty_${nextId++}`
        terminals.push({ id: ptyID, command: input.command })
        return { ok: true, ptyID, info: { id: ptyID } }
      },
      async write(input) {
        calls.write.push(input)
        order.push("write")
        return { ok: true }
      },
      async snapshot(input) {
        calls.snapshot.push(input)
        return { ok: true, text: `snap:${input.ptyID}` }
      },
      async remove(input) {
        calls.remove.push(input)
        const found = terminals.findIndex((terminal) => terminal.id === input.ptyID)
        if (found >= 0) terminals.splice(found, 1)
        return { ok: true }
      },
      async list() {
        calls.list += 1
        return { ok: true, terminals: [...terminals] }
      },
    }
    return { factory: () => port, calls, terminals, order }
  }

  // Stands in for the host's `context.permission`: records every assertion in the
  // fake's chronology and rejects when the resource text is listed in `deny`.
  function recordingPermission(fake, { deny = [] } = {}) {
    const asserted = []
    return {
      asserted,
      assert: async (request) => {
        fake.order.push("assert")
        asserted.push(request)
        if (request.resources.some((resource) => deny.includes(resource))) throw new Error("permission denied")
      },
    }
  }

  function createTool(fake, permission = recordingPermission(fake)) {
    return createInteractiveBashTool({ terminalFactory: fake.factory, permission })
  }

  test("drives the persistent terminal through start/send/read/stop", async () => {
    const fake = createFakeTerminalFactory()
    const tool = createTool(fake)
    const ctx = { sessionID: "sess_actions" }

    const started = await tool.execute({ action: "start", command: "bash", cwd: "/work" }, ctx)
    expect(started).toContain("interactive_bash started")
    expect(started).toContain("pty_1")
    expect(fake.calls.start).toEqual([{ command: "bash", args: [], title: "bash", env: {}, cwd: "/work" }])

    expect(await tool.execute({ action: "send", input: "ls\n" }, ctx)).toBe("ok")
    expect(fake.calls.write).toEqual([{ ptyID: "pty_1", data: "ls\n" }])

    expect(await tool.execute({ action: "read" }, ctx)).toBe("snap:pty_1")
    expect(fake.calls.snapshot).toEqual([{ ptyID: "pty_1" }])

    expect(await tool.execute({ action: "stop" }, ctx)).toBe("ok")
    expect(fake.calls.remove).toEqual([{ ptyID: "pty_1" }])
  })

  test("lists the session terminals", async () => {
    const fake = createFakeTerminalFactory()
    const tool = createTool(fake)
    const ctx = { sessionID: "sess_list_terminals" }
    await tool.execute({ action: "start" }, ctx)
    const listed = await tool.execute({ action: "list" }, ctx)
    expect(JSON.parse(listed)).toEqual([{ id: "pty_1", command: "/bin/bash" }])
  })

  test("an explicit target overrides the remembered terminal when the session owns it", async () => {
    const fake = createFakeTerminalFactory()
    const tool = createTool(fake)
    const ctx = { sessionID: "sess_target_override" }
    await tool.execute({ action: "start" }, ctx)
    await tool.execute({ action: "start" }, ctx)
    await tool.execute({ action: "send", input: "x", target: "pty_1" }, ctx)
    expect(fake.calls.write).toEqual([{ ptyID: "pty_1", data: "x" }])
  })

  test("errors when no terminal was started for the session", async () => {
    const fake = createFakeTerminalFactory()
    const tool = createTool(fake)
    expect(await tool.execute({ action: "read" }, { sessionID: "sess_no_start" })).toContain("no active terminal")
  })

  test("fails closed before touching the terminal factory when the call has no session id", async () => {
    let factoryCalls = 0
    const tool = createInteractiveBashTool({ terminalFactory: () => { factoryCalls += 1; return {} } })
    expect(await tool.execute({ action: "list" })).toContain("calling session")
    expect(factoryCalls).toBe(0)
  })

  test("a remembered terminal the session no longer owns is refused like any other target", async () => {
    const fake = createFakeTerminalFactory()
    const tool = createTool(fake)
    const ctx = { sessionID: "sess_stale_remembered" }
    await tool.execute({ action: "start" }, ctx)
    expect(await tool.execute({ action: "read" }, ctx)).toBe("snap:pty_1")

    fake.terminals.length = 0
    fake.calls.snapshot.length = 0

    expect(await tool.execute({ action: "read" }, ctx)).toContain("does not belong to this session")
    expect(fake.calls.snapshot).toEqual([])
  })

  test("refuses a target the calling session does not own, before permission or any PTY access", async () => {
    const fake = createFakeTerminalFactory()
    const permission = recordingPermission(fake)
    const tool = createTool(fake, permission)
    const ctx = { sessionID: "sess_owner" }
    await tool.execute({ action: "start" }, ctx)
    fake.order.length = 0
    permission.asserted.length = 0

    for (const action of ["send", "read", "stop"]) {
      const output = await tool.execute({ action, input: "x", target: "pty_foreign" }, ctx)
      expect(output).toContain("does not belong to this session")
    }

    expect(fake.calls.write).toEqual([])
    expect(fake.calls.snapshot).toEqual([])
    expect(fake.calls.remove).toEqual([])
    expect(permission.asserted).toEqual([])
  })

  test("fails closed when the session terminal list cannot be read", async () => {
    const fake = createFakeTerminalFactory()
    const tool = createTool(fake)
    const ctx = { sessionID: "sess_list_down" }
    await tool.execute({ action: "start" }, ctx)
    const port = fake.factory()
    port.list = async () => ({ ok: false, terminals: [], error: { code: "v2_http_error", message: "list down" } })

    expect(await tool.execute({ action: "send", input: "x" }, ctx)).toContain("list down")
    expect(await tool.execute({ action: "read" }, ctx)).toContain("list down")
    expect(fake.calls.write).toEqual([])
    expect(fake.calls.snapshot).toEqual([])
  })

  describe("shell permission", () => {
    test("asserts the shell action with the exact command before the terminal starts", async () => {
      const fake = createFakeTerminalFactory()
      const permission = recordingPermission(fake)
      const tool = createTool(fake, permission)

      await tool.execute({ action: "start", command: "htop", cwd: "/work" }, { sessionID: "sess_perm", agent: "sisyphus", messageID: "msg_1", id: "call_1" })

      expect(fake.order).toEqual(["assert", "start"])
      expect(permission.asserted).toHaveLength(1)
      const [request] = permission.asserted
      expect(request).toMatchObject({
        sessionID: "sess_perm",
        agent: "sisyphus",
        source: { type: "tool", messageID: "msg_1", id: "call_1" },
        action: "shell",
        resources: ["htop"],
        metadata: { cwd: "/work" },
      })
      // No wildcard approval may be offered for a model-driven shell.
      expect("save" in request).toBe(false)
    })

    test("asserts every write, action send and translated send-keys, before it reaches the PTY", async () => {
      const fake = createFakeTerminalFactory()
      const permission = recordingPermission(fake)
      const tool = createTool(fake, permission)
      const ctx = { sessionID: "sess_perm_write" }
      await tool.execute({ action: "start" }, ctx)
      fake.order.length = 0
      permission.asserted.length = 0

      await tool.execute({ action: "send", input: "rm -rf build\n" }, ctx)
      await tool.execute({ tmux_command: "send-keys -t any ls Enter" }, ctx)

      expect(fake.order).toEqual(["assert", "write", "assert", "write"])
      expect(permission.asserted.map((request) => request.resources)).toEqual([["rm -rf build\n"], ["ls\n"]])
      expect(permission.asserted.every((request) => request.action === "shell")).toBe(true)
    })

    test("a denial propagates and nothing reaches the PTY", async () => {
      const fake = createFakeTerminalFactory()
      const permission = recordingPermission(fake, { deny: ["htop", "whoami\n"] })
      const tool = createTool(fake, permission)
      const ctx = { sessionID: "sess_perm_denied" }

      await expect(tool.execute({ action: "start", command: "htop" }, ctx)).rejects.toThrow("permission denied")
      expect(fake.calls.start).toEqual([])

      await tool.execute({ action: "start" }, ctx)
      await expect(tool.execute({ action: "send", input: "whoami\n" }, ctx)).rejects.toThrow("permission denied")
      expect(fake.calls.write).toEqual([])
    })

    test("fails closed when the host exposes no permission service", async () => {
      const fake = createFakeTerminalFactory()
      const tool = createInteractiveBashTool({ terminalFactory: fake.factory })
      const ctx = { sessionID: "sess_no_permission" }

      expect(await tool.execute({ action: "start" }, ctx)).toContain("permission service is unavailable")
      expect(fake.calls.start).toEqual([])

      // a terminal that exists anyway still cannot be written without the service
      await fake.factory().start({ command: "sh" })
      const withoutService = createInteractiveBashTool({ terminalFactory: fake.factory, permission: {} })
      expect(await withoutService.execute({ action: "send", input: "x", target: "pty_1" }, ctx)).toContain("permission service is unavailable")
      expect(fake.calls.write).toEqual([])
    })
  })

  test("translates the supported tmux verbs onto the persistent terminal", async () => {
    const fake = createFakeTerminalFactory()
    const tool = createTool(fake)
    const ctx = { sessionID: "sess_tmux_verbs" }
    expect(await tool.execute({ tmux_command: "new-session -d -s omo-dev" }, ctx)).toContain("interactive_bash started")
    expect(await tool.execute({ tmux_command: "send-keys -t omo-dev ls Enter" }, ctx)).toBe("ok")
    expect(fake.calls.write).toEqual([{ ptyID: "pty_1", data: "ls\n" }])
    expect(JSON.parse(await tool.execute({ tmux_command: "list-sessions" }, ctx))).toHaveLength(1)
    expect(await tool.execute({ tmux_command: "kill-session -t omo-dev" }, ctx)).toBe("ok")
    expect(fake.calls.remove).toEqual([{ ptyID: "pty_1" }])
  })

  test("names the supported verbs for an allowed-but-unmapped tmux verb", async () => {
    const fake = createFakeTerminalFactory()
    const tool = createTool(fake)
    const output = await tool.execute({ tmux_command: "select-pane -t 1" }, { sessionID: "sess_unmapped" })
    expect(output).toContain("'select-pane' tmux verb is not supported")
    expect(output).toContain("new-session")
    expect(output).toContain("start, send, read, stop, list")
  })

  test("adapts the blocked capture-pane message to the read action on the no-tmux path", async () => {
    const fake = createFakeTerminalFactory()
    const tool = createTool(fake)
    const output = await tool.execute({ tmux_command: "capture-pane -t omo-dev" }, { sessionID: "sess_blocked" })
    expect(output).toContain("'capture-pane' is blocked")
    expect(output).toContain('"action": "read"')
    expect(output).not.toContain("USE BASH TOOL INSTEAD")
  })

  test("returns the strong prohibition for kill-server on the no-tmux path", async () => {
    const fake = createFakeTerminalFactory()
    const tool = createTool(fake)
    const output = await tool.execute({ tmux_command: "-L omo-socket kill-server" }, { sessionID: "sess_prohibited" })
    expect(output).toContain("Error: 'kill-server' is prohibited in interactive_bash.")
  })

  test("rejects providing both action and tmux_command", async () => {
    const fake = createFakeTerminalFactory()
    const tool = createTool(fake)
    const output = await tool.execute({ action: "list", tmux_command: "list-sessions" })
    expect(output).toContain("provide exactly one of 'action' or 'tmux_command'")
  })

  test("requires a runner or a terminalFactory", () => {
    expect(() => createInteractiveBashTool({})).toThrow("requires a runner with run() or a terminalFactory")
  })
})

describe("tmux availability gate", () => {
  test("finds an executable on PATH without spawning", () => {
    const found = findExecutableOnPath({
      command: "tmux",
      env: { PATH: "/usr/bin:/opt/bin" },
      platform: "linux",
      isFile: (candidate) => candidate === "/opt/bin/tmux",
      isExecutable: () => true,
    })
    expect(found).toBe("/opt/bin/tmux")
  })

  test("returns null when tmux is absent", () => {
    expect(detectTmuxAvailability({ env: { PATH: "/usr/bin" }, platform: "linux", isFile: () => false, isExecutable: () => true })).toBeNull()
  })

  test("detects tmux through the injected filesystem ports", () => {
    expect(detectTmuxAvailability({
      env: { PATH: "/usr/local/bin" },
      platform: "linux",
      isFile: (candidate) => candidate === "/usr/local/bin/tmux",
      isExecutable: () => true,
    })).toBe("/usr/local/bin/tmux")
  })
})

describe("V2 pty command runner", () => {
  test("creates the pty with the command and args, reads output, and removes the session", async () => {
    const calls = []
    const pty = {
      create: async (input) => { calls.push(["create", input]); return { data: { id: "pty_1" } } },
      remove: async (input) => { calls.push(["remove", input]) },
    }
    const runner = createPtyCommandRunner({
      pty,
      location: { directory: "/work" },
      attach: async () => ({ stdout: "ok\n", stderr: "", exitCode: 0 }),
    })
    const result = await runner.run({ command: "tmux", args: ["list-sessions"] })
    expect(result).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0 })
    expect(calls).toEqual([
      ["create", { location: { directory: "/work" }, command: "tmux", args: ["list-sessions"] }],
      ["remove", { ptyID: "pty_1", location: { directory: "/work" } }],
    ])
  })

  test("removes the pty even when the output reader fails, then rethrows", async () => {
    const removed = []
    const pty = {
      create: async () => ({ data: { id: "pty_2" } }),
      remove: async (input) => { removed.push(input.ptyID) },
    }
    const runner = createPtyCommandRunner({ pty, attach: async () => { throw new Error("stream unavailable") } })
    await expect(runner.run({ command: "tmux", args: ["list-sessions"] })).rejects.toThrow("stream unavailable")
    expect(removed).toEqual(["pty_2"])
  })

  test("rejects a pty domain that cannot create sessions", () => {
    expect(() => createPtyCommandRunner({ pty: {} })).toThrow("requires a V2 pty domain")
  })

  test("reports an unsupported pty stream instead of returning empty output", async () => {
    const pty = { create: async () => ({ data: { id: "pty_3" } }), remove: async () => {} }
    const runner = createPtyCommandRunner({ pty })
    await expect(runner.run({ command: "tmux", args: ["list-sessions"] })).rejects.toThrow("V2 pty output stream is unavailable")
  })
})
