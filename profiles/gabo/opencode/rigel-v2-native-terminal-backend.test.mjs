import { describe, expect, test } from "bun:test"
import { resolveInteractiveTerminalBackend } from "./rigel-v2-native-terminal-backend.mjs"

// Records every createTerminal call the persistent-terminal port makes.
function fakeServerApi({ available = true } = {}) {
  const created = []
  return {
    created,
    available,
    origin: "http://127.0.0.1:4999",
    async createTerminal(sessionID, options) {
      created.push({ sessionID, options })
      return { ok: true, status: 200, data: { data: { id: "pty_1" } }, error: null }
    },
  }
}

const SERVER_ENV = {
  PATH: "/srv/bin:/usr/bin",
  HOME: "/home/service",
  LANG: "en_US.UTF-8",
  TERM: "dumb",
  ANTHROPIC_API_KEY: "provider-secret",
  OMO_PROFILE: "gabo",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
}

function backendFor(overrides = {}) {
  const serverApi = overrides.serverApi ?? fakeServerApi()
  const lookups = []
  const backend = resolveInteractiveTerminalBackend({
    serverApi,
    env: SERVER_ENV,
    platform: "linux",
    isExecutable: (candidate) => candidate === "/usr/bin/env",
    resolveSessionDirectory: async (sessionID) => { lookups.push(sessionID); return "/work/session-root" },
    ...overrides,
  })
  return { backend, serverApi, lookups }
}

describe("interactive_bash persistent-terminal backend", () => {
  describe("#given a process environment that carries a server credential selector", () => {
    for (const selector of ["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"]) {
      test(`#then ${selector} makes the backend unavailable without echoing its value`, () => {
        const control = backendFor()
        expect(control.backend.status).toBe("ready")

        const { backend } = backendFor({ env: { ...SERVER_ENV, [selector]: "hunter2-secret" } })

        expect(backend.status).toBe("unavailable")
        expect(backend.reason).toContain(selector)
        expect(backend.reason).not.toContain("hunter2-secret")
        expect(backend.terminalFactory).toBeUndefined()
      })
    }
  })

  describe("#given no verified server API", () => {
    test("#then the backend is unavailable and no other backend may stand in", () => {
      for (const serverApi of [fakeServerApi({ available: false }), undefined]) {
        const { backend } = backendFor({ serverApi })
        expect(backend.status).toBe("unavailable")
        expect(backend.terminalFactory).toBeUndefined()
      }
    })
  })

  describe("#given no usable POSIX env wrapper", () => {
    test("#then the backend is unavailable instead of falling back to an unfiltered PTY", () => {
      const missing = backendFor({ isExecutable: () => false }).backend
      expect(missing.status).toBe("unavailable")
      expect(missing.terminalFactory).toBeUndefined()
      expect(backendFor({ platform: "win32" }).backend.status).toBe("unavailable")
    })
  })

  describe("#given a ready backend", () => {
    test("#then start sends only the allowlisted environment behind env -i, rooted in the session directory", async () => {
      const { backend, serverApi, lookups } = backendFor()

      const result = await backend.terminalFactory("ses_a").start({ command: "/bin/bash", args: [], title: "bash", env: {} })

      expect(result).toMatchObject({ ok: true, ptyID: "pty_1" })
      expect(lookups).toEqual(["ses_a"])
      expect(serverApi.created).toEqual([{
        sessionID: "ses_a",
        options: {
          command: "/usr/bin/env",
          args: ["-i", "--", "PATH=/srv/bin:/usr/bin", "HOME=/home/service", "TERM=xterm-256color", "LANG=en_US.UTF-8", "/bin/bash"],
          title: "bash",
          env: {},
          cwd: "/work/session-root",
        },
      }])
    })

    test("#then a server environment without PATH and LANG still gets portable defaults", async () => {
      const { backend, serverApi } = backendFor({ env: { HOME: "/home/service" } })

      await backend.terminalFactory("ses_a").start({ command: "sh", args: ["-l"] })

      const { args } = serverApi.created[0].options
      expect(args.slice(0, 2)).toEqual(["-i", "--"])
      expect(args.slice(2)).toEqual(["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/home/service", "TERM=xterm-256color", "LANG=C.UTF-8", "sh", "-l"])
    })

    test("#then an absolute cwd is forwarded as given without resolving the session", async () => {
      const { backend, serverApi, lookups } = backendFor()

      await backend.terminalFactory("ses_a").start({ command: "sh", cwd: "/srv/elsewhere" })

      expect(serverApi.created[0].options.cwd).toBe("/srv/elsewhere")
      expect(lookups).toEqual([])
    })

    test("#then a relative cwd is resolved against the session directory", async () => {
      const { backend, serverApi } = backendFor()

      await backend.terminalFactory("ses_a").start({ command: "sh", cwd: "packages/app" })

      expect(serverApi.created[0].options.cwd).toBe("/work/session-root/packages/app")
    })

    test("#then an unresolvable session fails closed before any terminal is created", async () => {
      const { backend, serverApi } = backendFor({ resolveSessionDirectory: async () => undefined })

      const result = await backend.terminalFactory("ses_a").start({ command: "sh" })

      expect(result.ok).toBe(false)
      expect(result.error.code).toBe("v2_terminal_session_unresolved")
      expect(serverApi.created).toEqual([])
    })

    test("#then a command that env would parse as an assignment is refused before creation", async () => {
      const { backend, serverApi } = backendFor()

      const result = await backend.terminalFactory("ses_a").start({ command: "OPENCODE_PASSWORD=x" })

      expect(result.ok).toBe(false)
      expect(result.error.code).toBe("v2_terminal_command_invalid")
      expect(serverApi.created).toEqual([])
    })
  })
})
