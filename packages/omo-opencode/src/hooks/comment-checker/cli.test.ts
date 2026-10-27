/// <reference types="bun-types" />

import { describe, test, expect, mock, afterAll } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { processWithCli } from "./cli-runner"
import type { PendingCall } from "./types"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"

const FAILURE_NOTICE_MARKER = "[comment-checker] Comment review did not run."

function createMockInput() {
  return {
    session_id: "test",
    tool_name: "Write",
    transcript_path: "",
    cwd: "/tmp",
    hook_event_name: "PostToolUse",
    tool_input: { file_path: "/tmp/test.ts", content: "const x = 1" },
  }
}

function createScriptBinary(scriptContent: string, windowsScriptContent?: string): string {
  const directory = mkdtempSync(join(tmpdir(), "comment-checker-cli-test-"))
  const binaryPath = join(directory, process.platform === "win32" ? "comment-checker.cmd" : "comment-checker")
  writeFileSync(binaryPath, process.platform === "win32" ? windowsScriptContent ?? scriptContent : scriptContent)
  if (process.platform !== "win32") {
    chmodSync(binaryPath, 0o755)
  }
  return binaryPath
}

afterAll(() => { mock.restore() })

describe("comment-checker CLI", () => {
  describe("lazy initialization", () => {
    test("#given PATH-only binary #when resolving from PATH #then returns Bun.which result", async () => {
      // given
      const cliModule = await import(`./cli?path-only=${crypto.randomUUID()}`)
      const calls: string[] = []

      // when
      const result = cliModule.resolveCommentCheckerPathFromPath("comment-checker.exe", (binary: string) => {
        calls.push(binary)
        return "C:\\tools\\comment-checker.exe"
      })

      // then
      expect(result).toBe("C:\\tools\\comment-checker.exe")
      expect(calls).toEqual(["comment-checker.exe"])
    })

    test("#given PATH lookup throws #when resolving from PATH #then returns null", async () => {
      // given
      const cliModule = await import(`./cli?path-error=${crypto.randomUUID()}`)

      // when
      const result = cliModule.resolveCommentCheckerPathFromPath("comment-checker", () => {
        throw new Error("lookup failed")
      })

      // then
      expect(result).toBeNull()
    })
  })

  describe("runCommentChecker", () => {
    test("sends SIGKILL after grace period when process ignores SIGTERM", async () => {
      // given
      const { runCommentChecker } = await import("./cli")
      const binaryPath = createScriptBinary(`#!/bin/sh
if [ "$1" != "check" ]; then
  exit 1
fi
trap '' TERM
while :; do
  :
done
`, `@echo off
if "%~1" neq "check" exit /b 1
:loop
goto loop
`)
      const originalSetTimeout = globalThis.setTimeout
      globalThis.setTimeout = ((fn: (...args: unknown[]) => void, _ms?: number) => {
        fn()
        return unsafeTestValue<ReturnType<typeof setTimeout>>(0)
      }) as typeof setTimeout

      try {
        // when
        const result = await runCommentChecker(createMockInput(), binaryPath)
        // then
        expect(result).toEqual({ hasComments: false, message: "" })
      } finally {
        globalThis.setTimeout = originalSetTimeout
      }
    })

    test("returns empty result on timeout", async () => {
      // given
      const { runCommentChecker } = await import("./cli")
      const binaryPath = createScriptBinary(`#!/bin/sh
if [ "$1" != "check" ]; then
  exit 1
fi
trap '' TERM
while :; do
  :
done
`, `@echo off
if "%~1" neq "check" exit /b 1
:loop
goto loop
`)
      const originalSetTimeout = globalThis.setTimeout
      globalThis.setTimeout = ((fn: (...args: unknown[]) => void, _ms?: number) => {
        fn()
        return unsafeTestValue<ReturnType<typeof setTimeout>>(0)
      }) as typeof setTimeout

      try {
        // when
        const result = await runCommentChecker(createMockInput(), binaryPath)
        // then
        expect(result).toEqual({ hasComments: false, message: "" })
      } finally {
        globalThis.setTimeout = originalSetTimeout
      }
    })

    test("keeps non-timeout flow unchanged", async () => {
      // given
      const { runCommentChecker } = await import("./cli")
      const binaryPath = createScriptBinary(`#!/bin/sh
if [ "$1" != "check" ]; then
  exit 1
fi
cat >/dev/null
echo "found comments" 1>&2
exit 2
`, `@echo off
if "%~1" neq "check" exit /b 1
more > nul
1>&2 echo(found comments
exit /b 2
`)
      // when
      const result = await runCommentChecker(createMockInput(), binaryPath)
      // then
      expect(result).toEqual({ hasComments: true, message: "found comments\n" })
    })
  })

  describe("processWithCli semaphore", () => {
    test("skips second concurrent processWithCli call", async () => {
      // given
      let callCount = 0
      let resolveFirst = () => {}
      const firstCallPromise = new Promise<void>((resolve) => {
        resolveFirst = resolve
      })
      const cliMockFactory = () => ({
        runCommentChecker: mock(async () => {
          callCount += 1
          if (callCount === 1) {
            await firstCallPromise
          }
          return { hasComments: false, message: "" }
        }),
        getCommentCheckerPath: mock(async () => "/fake"),
        startBackgroundInit: mock(() => {}),
      })
      const cliMocks = cliMockFactory()
      const pendingCall: PendingCall = {
        tool: "write",
        sessionID: "ses-1",
        filePath: "/tmp/a.ts",
        newString: "// new comment",
        timestamp: Date.now(),
      }
      const firstCall = processWithCli({ tool: "write", sessionID: "ses-1", callID: "call-1" }, pendingCall, { output: "" }, "/fake", undefined, () => {}, { runCommentChecker: cliMocks.runCommentChecker })
      const secondCall = processWithCli({ tool: "write", sessionID: "ses-2", callID: "call-2" }, pendingCall, { output: "" }, "/fake", undefined, () => {}, { runCommentChecker: cliMocks.runCommentChecker })

      // when
      await secondCall
      resolveFirst()
      await firstCall
      // then
      expect(callCount).toBe(1)
    })

    test("allows second call after first call completes", async () => {
      // given
      let callCount = 0
      const cliMockFactory = () => ({
        runCommentChecker: mock(async () => {
          callCount += 1
          return { hasComments: false, message: "" }
        }),
        getCommentCheckerPath: mock(async () => "/fake"),
        startBackgroundInit: mock(() => {}),
      })
      const cliMocks = cliMockFactory()
      const firstPendingCall: PendingCall = {
        tool: "write",
        sessionID: "ses-first",
        filePath: "/tmp/a.ts",
        newString: "// new comment",
        timestamp: Date.now(),
      }
      const secondPendingCall: PendingCall = {
        tool: "write",
        sessionID: "ses-second",
        filePath: "/tmp/b.ts",
        newString: "// another comment",
        timestamp: Date.now(),
      }
      // when
      await processWithCli({ tool: "write", sessionID: "ses-first", callID: "call-1" }, firstPendingCall, { output: "" }, "/fake", undefined, () => {}, { runCommentChecker: cliMocks.runCommentChecker })
      await processWithCli({ tool: "write", sessionID: "ses-second", callID: "call-2" }, secondPendingCall, { output: "" }, "/fake", undefined, () => {}, { runCommentChecker: cliMocks.runCommentChecker })
      // then
      expect(callCount).toBe(2)
    })
  })

  describe("comment review failure notice", () => {
    test("#given a checker that cannot start #when processWithCli runs #then it appends a visible notice", async () => {
      // given
      const pendingCall: PendingCall = {
        tool: "write",
        sessionID: "ses-failure-visible",
        filePath: "/tmp/a.ts",
        newString: "// new comment",
        timestamp: Date.now(),
      }
      const output = { output: "Success" }

      // when
      await processWithCli(
        { tool: "write", sessionID: pendingCall.sessionID, callID: "call-failure" },
        pendingCall,
        output,
        "/fake",
        undefined,
        () => {},
        {
          runCommentChecker: async () => ({
            hasComments: false,
            message: "",
            failure: { exitCode: null, stderr: "spawn EACCES" },
          }),
        },
      )

      // then
      expect(output.output.startsWith("Success")).toBe(true)
      expect(output.output).toContain(FAILURE_NOTICE_MARKER)
      expect(output.output).toContain("spawn EACCES")
      expect(output.output).toContain("NOT checked")
    })

    test("#given a checker that cannot start #when the same session edits again #then the notice is not repeated", async () => {
      // given
      const sessionID = "ses-failure-bounded"
      const pendingCall: PendingCall = {
        tool: "write",
        sessionID,
        filePath: "/tmp/a.ts",
        newString: "// new comment",
        timestamp: Date.now(),
      }
      const first = { output: "Success" }
      const second = { output: "Success" }
      const failingChecker = async () => ({
        hasComments: false,
        message: "",
        failure: { exitCode: null, stderr: "spawn EACCES" },
      })

      // when
      await processWithCli({ tool: "write", sessionID, callID: "call-bounded-1" }, pendingCall, first, "/fake", undefined, () => {}, { runCommentChecker: failingChecker })
      await processWithCli({ tool: "write", sessionID, callID: "call-bounded-2" }, pendingCall, second, "/fake", undefined, () => {}, { runCommentChecker: failingChecker })

      // then
      expect(first.output).toContain(FAILURE_NOTICE_MARKER)
      expect(second.output).toBe("Success")
    })

    test("#given a checker that finds comments #when processWithCli runs #then the findings message is appended unchanged", async () => {
      // given
      const pendingCall: PendingCall = {
        tool: "write",
        sessionID: "ses-findings-found",
        filePath: "/tmp/a.ts",
        newString: "// new comment",
        timestamp: Date.now(),
      }
      const output = { output: "Success" }

      // when
      await processWithCli(
        { tool: "write", sessionID: pendingCall.sessionID, callID: "call-found" },
        pendingCall,
        output,
        "/fake",
        undefined,
        () => {},
        {
          runCommentChecker: async () => ({ hasComments: true, message: "found comments" }),
        },
      )

      // then
      expect(output.output).toBe("Success\n\nfound comments")
    })

    test("#given a checker that finds nothing #when processWithCli runs #then no failure notice is appended", async () => {
      // given
      const pendingCall: PendingCall = {
        tool: "write",
        sessionID: "ses-findings-clean",
        filePath: "/tmp/a.ts",
        newString: "// new comment",
        timestamp: Date.now(),
      }
      const output = { output: "Success" }

      // when
      await processWithCli(
        { tool: "write", sessionID: pendingCall.sessionID, callID: "call-clean" },
        pendingCall,
        output,
        "/fake",
        undefined,
        () => {},
        {
          runCommentChecker: async () => ({ hasComments: false, message: "" }),
        },
      )

      // then
      expect(output.output).toBe("Success")
    })

    test("#given the comment-checker binary cannot be resolved #when runCommentChecker runs #then it reports a failure", async () => {
      // given
      const { runCommentChecker } = await import("./cli")
      const missingBinaryPath = join(tmpdir(), "comment-checker-missing-binary", "comment-checker")

      // when
      const result = await runCommentChecker(createMockInput(), missingBinaryPath)

      // then
      expect(result.hasComments).toBe(false)
      expect(result.failure).toBeDefined()
      expect(result.failure?.exitCode).toBeNull()
      expect(result.failure?.stderr.length).toBeGreaterThan(0)
    })

    test("#given a checker that exits outside its protocol #when runCommentChecker runs #then it reports the exit code as a failure", async () => {
      // given
      const { runCommentChecker } = await import("./cli")
      const binaryPath = createScriptBinary(`#!/bin/sh
if [ "$1" != "check" ]; then
  exit 1
fi
cat >/dev/null
echo "checker exploded" 1>&2
exit 3
`, `@echo off
if "%~1" neq "check" exit /b 1
more > nul
1>&2 echo(checker exploded
exit /b 3
`)

      // when
      const result = await runCommentChecker(createMockInput(), binaryPath)

      // then
      expect(result.hasComments).toBe(false)
      expect(result.failure?.exitCode).toBe(3)
      expect(result.failure?.stderr).toContain("checker exploded")
    })
  })
})
