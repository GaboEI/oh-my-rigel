import { describe, expect, test } from "bun:test"

import * as layout from "./rigel-v2-tmux-viz-layout.mjs"

// Row 55, stage C. The member pane used to be respawned with
// `opencode attach <url> --session <id> --dir <dir>`. That command does not
// exist in OpenCode V2 (`attach` is not a subcommand and `--dir` is not a
// flag), so a member pane could never become the member's TUI. V2 does expose
// the real interface this feature needs: `--server <url>`, `--session <id>`
// and a positional directory.
//
// Contract: the built command targets a specific session on a specific server
// through flags the V2 CLI actually accepts, is safe to hand to a shell, and
// never carries a credential.

const URL = "http://127.0.0.1:49374"
const SESSION = "ses_member_1"
const DIRECTORY = "/home/rigeltest/proj"

describe("member pane attach command targets the real V2 interface", () => {
  test("#given row 55 is unfixed #when the runtime asks for the attach command #then the corrected builders exist", () => {
    expect(typeof layout.buildAttachCommand).toBe("function")
    expect(typeof layout.buildAttachAuthEnv).toBe("function")
  })

  test("#given a server and session #when the attach command is built #then it uses the real V2 flags", () => {
    const command = layout.buildAttachCommand({ serverUrl: URL, sessionID: SESSION, directory: DIRECTORY })
    expect(command).toContain("--server")
    expect(command).toContain("--session")
    expect(command).toContain(URL)
    expect(command).toContain(SESSION)
    expect(command).toContain(DIRECTORY)
  })

  test("#given the obsolete interface #when the attach command is built #then it is not used", () => {
    const command = layout.buildAttachCommand({ serverUrl: URL, sessionID: SESSION, directory: DIRECTORY })
    expect(command).not.toMatch(/(^|\s)attach(\s|$)/)
    expect(command).not.toContain("--dir")
  })

  test("#given paths containing spaces #when the attach command is built #then every value is shell-quoted", () => {
    const command = layout.buildAttachCommand({
      serverUrl: "http://127.0.0.1:49374/path with spaces",
      sessionID: "session with spaces",
      directory: "/tmp/project with spaces",
    })
    expect(command).toContain("'http://127.0.0.1:49374/path with spaces'")
    expect(command).toContain("'session with spaces'")
    expect(command).toContain("'/tmp/project with spaces'")
  })

  test("#given a value containing a single quote #when the attach command is built #then the quote cannot escape the argument", () => {
    const command = layout.buildAttachCommand({ serverUrl: URL, sessionID: "ses'`whoami`", directory: DIRECTORY })
    expect(command).toContain(`'ses'\\''\`whoami\`'`)
  })

  test("#given no server URL is resolvable #when the attach command is built #then the session is still targeted", () => {
    const command = layout.buildAttachCommand({ serverUrl: undefined, sessionID: SESSION, directory: DIRECTORY })
    expect(command).toContain("--session")
    expect(command).toContain(SESSION)
    expect(command).not.toContain("--server")
    expect(command).not.toContain("undefined")
  })

  test("#given a server password #when the pane auth environment is built #then the credential travels outside the command", () => {
    const command = layout.buildAttachCommand({ serverUrl: URL, sessionID: SESSION, directory: DIRECTORY })
    const authEnv = layout.buildAttachAuthEnv({ password: "sup3r-s3cret", username: undefined })
    expect(command).not.toContain("sup3r-s3cret")
    expect(authEnv).toContain("-e")
    expect(authEnv).toContain("OPENCODE_PASSWORD=sup3r-s3cret")
  })

  test("#given no credential #when the pane auth environment is built #then nothing is injected", () => {
    expect(layout.buildAttachAuthEnv({ password: undefined })).toEqual([])
    expect(layout.buildAttachAuthEnv()).toEqual([])
  })
})
