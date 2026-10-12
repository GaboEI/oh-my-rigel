import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  buildProtectedManifest,
  diffProtectedManifests,
  manifestDigest,
} from "../v1-protected-surfaces.mjs"

const created = []

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rigel-v1-protected-"))
  created.push(home)
  return home
}

function write(home, rel, content) {
  const file = path.join(home, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

afterEach(() => {
  while (created.length > 0) fs.rmSync(created.pop(), { recursive: true, force: true })
})

describe("v1 protected surface manifest", () => {
  test("#given a populated V1 home #when the protected manifest is built #then it covers config, artifacts and credentials", () => {
    const home = tempHome()
    write(home, ".config/opencode/opencode.json", "{}")
    write(home, ".config/opencode/agents/judge.md", "agent")
    write(home, ".config/opencode/skills/foo/SKILL.md", "skill")
    write(home, ".config/opencode/plugins/plugin.js", "plugin")
    write(home, ".config/opencode/mcp-oauth/index.json", "cred")
    write(home, ".local/share/opencode/auth.json", "auth")
    write(home, ".local/share/opencode/mcp-auth.json", "mcp-auth")
    write(home, ".local/share/opencode/storage/session.json", "operational")

    const manifest = buildProtectedManifest(home)

    expect(Object.keys(manifest)).toContain(".config/opencode/opencode.json")
    expect(Object.keys(manifest)).toContain(".config/opencode/agents/judge.md")
    expect(Object.keys(manifest)).toContain(".config/opencode/skills/foo/SKILL.md")
    expect(Object.keys(manifest)).toContain(".config/opencode/plugins/plugin.js")
    expect(Object.keys(manifest)).toContain(".config/opencode/mcp-oauth/index.json")
    expect(Object.keys(manifest)).toContain(".local/share/opencode/auth.json")
    expect(Object.keys(manifest)).toContain(".local/share/opencode/mcp-auth.json")
    expect(Object.keys(manifest)).not.toContain(".local/share/opencode/storage/session.json")
  })

  test("#given operational V1 churn #when manifests are diffed #then no protected change is reported", () => {
    const home = tempHome()
    write(home, ".config/opencode/opencode.json", "{}")
    write(home, ".config/opencode/agents/judge.md", "agent")
    write(home, ".config/opencode/context-mode/sessions/a.db", "db")
    write(home, ".local/share/opencode/storage/oh-my-openagent/tui-state/a.json", "state")

    const before = buildProtectedManifest(home)
    write(home, ".config/opencode/context-mode/sessions/a.db", "db2")
    write(home, ".config/opencode/context-mode/sessions/b.db", "new")
    write(home, ".config/opencode/oh-my-openagent/native-nudge.json", '{"n":1}')
    write(home, ".local/share/opencode/storage/oh-my-openagent/tui-state/a.json", "state2")
    write(home, ".local/share/opencode/opencode.db", "database")
    write(home, ".local/share/opencode/log/opencode.log", "log")
    const after = buildProtectedManifest(home)

    expect(diffProtectedManifests(before, after)).toEqual({ added: [], removed: [], changed: [] })
    expect(manifestDigest(before)).toBe(manifestDigest(after))
  })

  test("#given a modified protected config file #when manifests are diffed #then it is reported (RED)", () => {
    const home = tempHome()
    write(home, ".config/opencode/opencode.json", '{"a":1}')

    const before = buildProtectedManifest(home)
    write(home, ".config/opencode/opencode.json", '{"a":2}')
    const after = buildProtectedManifest(home)

    const diff = diffProtectedManifests(before, after)
    expect(diff.changed).toEqual([".config/opencode/opencode.json"])
    expect(manifestDigest(before)).not.toBe(manifestDigest(after))
  })

  test("#given a same-size content change in a protected artifact #when manifests are diffed #then it is reported (RED)", () => {
    const home = tempHome()
    const file = write(home, ".config/opencode/agents/judge.md", "AAAA")

    const before = buildProtectedManifest(home)
    fs.writeFileSync(file, "BBBB")
    const after = buildProtectedManifest(home)

    expect(diffProtectedManifests(before, after).changed).toContain(".config/opencode/agents/judge.md")
  })

  test("#given an added protected artifact #when manifests are diffed #then it is reported (RED)", () => {
    const home = tempHome()
    write(home, ".config/opencode/opencode.json", "{}")

    const before = buildProtectedManifest(home)
    write(home, ".config/opencode/plugins/new-plugin.js", "plugin")
    const after = buildProtectedManifest(home)

    expect(diffProtectedManifests(before, after).added).toContain(".config/opencode/plugins/new-plugin.js")
  })

  test("#given a removed protected credential #when manifests are diffed #then it is reported (RED)", () => {
    const home = tempHome()
    const credential = write(home, ".local/share/opencode/auth.json", "cred")

    const before = buildProtectedManifest(home)
    fs.rmSync(credential)
    const after = buildProtectedManifest(home)

    expect(diffProtectedManifests(before, after).removed).toContain(".local/share/opencode/auth.json")
  })

  test("#given a new unclassified subdirectory under the config root #when manifests are diffed #then it is reported (RED)", () => {
    const home = tempHome()
    write(home, ".config/opencode/opencode.json", "{}")

    const before = buildProtectedManifest(home)
    write(home, ".config/opencode/rigel-v2/runtime/index.js", "installed")
    const after = buildProtectedManifest(home)

    const diff = diffProtectedManifests(before, after)
    expect(diff.added).toContain(".config/opencode/rigel-v2/")
    expect(diff.added).toContain(".config/opencode/rigel-v2/runtime/index.js")
  })

  test("#given an empty new subdirectory under the config root #when manifests are diffed #then the shape marker is reported (RED)", () => {
    const home = tempHome()
    write(home, ".config/opencode/opencode.json", "{}")

    const before = buildProtectedManifest(home)
    fs.mkdirSync(path.join(home, ".config/opencode", "rigel-v2"), { recursive: true })
    const after = buildProtectedManifest(home)

    expect(diffProtectedManifests(before, after).added).toContain(".config/opencode/rigel-v2/")
  })

  test("#given a new root file under the data root #when manifests are diffed #then it is reported (RED)", () => {
    const home = tempHome()
    write(home, ".local/share/opencode/auth.json", "auth")

    const before = buildProtectedManifest(home)
    write(home, ".local/share/opencode/rigel-v2-state.json", "{}")
    const after = buildProtectedManifest(home)

    expect(diffProtectedManifests(before, after).added).toContain(".local/share/opencode/rigel-v2-state.json")
  })

  test("#given an unclassified credential backup appears #when manifests are diffed #then it is reported (RED)", () => {
    const home = tempHome()
    write(home, ".local/share/opencode/auth.json", "auth")

    const before = buildProtectedManifest(home)
    write(home, ".local/share/opencode/auth.json.before-rigel", "auth-old")
    const after = buildProtectedManifest(home)

    expect(diffProtectedManifests(before, after).added).toContain(".local/share/opencode/auth.json.before-rigel")
  })

  test("#given volatile credential churn #when the digest is compared #then it is stable while presence is still tracked", () => {
    // V1 rewrites auth.json on token refresh, so hashing its CONTENT made the
    // cross-run digest drift for reasons unrelated to this installer. The digest
    // must be reproducible across runs (content-independent for volatile auth)
    // while still detecting the file's presence or absence.
    const home = tempHome()
    const credential = write(home, ".local/share/opencode/auth.json", "token-A")
    const before = buildProtectedManifest(home)
    write(home, ".local/share/opencode/auth.json", "token-B-different-length")
    const after = buildProtectedManifest(home)

    expect(manifestDigest(before)).toBe(manifestDigest(after))
    expect(diffProtectedManifests(before, after)).toEqual({ added: [], removed: [], changed: [] })

    fs.rmSync(credential)
    const removed = buildProtectedManifest(home)
    expect(diffProtectedManifests(after, removed).removed).toContain(".local/share/opencode/auth.json")
  })
})
