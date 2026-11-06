import { describe, expect, test } from "bun:test"
import path from "node:path"

import * as config from "./rigel-v2-native-config.mjs"
import { createNativeOpenclaw } from "./rigel-v2-native-openclaw.mjs"

// U2, Contrato_Transportes_OpenClaw.md S4.2. `openclaw` becomes a LIVE authority
// with the same three states the other live readers already use, because this
// surface reaches the network:
//
//   - `declared`   some layer wrote the key -> the live block is authoritative
//                  WHOLESALE (a per-field merge would refill a deleted gateway
//                  from the manifest and re-silence the deletion).
//   - `undeclared` no layer wrote it -> the install-time manifest stands, which
//                  is why an old install keeps today's behavior exactly.
//   - `error`      the chain could not be resolved, a live file could not be
//                  read/parsed, or the declared value is not an object -> the
//                  surface stays INERT with the error reported. Falling back to
//                  the manifest here would re-enable a network surface from a
//                  value the runtime could not confirm.
//
// The last two cases are the reason the shared layer collection had to report
// `loadFailures`: the loader absorbs a per-file failure, so "unreadable file"
// and "declared nothing" used to be the same observable.

const HOME = path.resolve("/home/rigeltest")
const PROJECT = path.join(HOME, "proj")
const USER_CONFIG = path.join(HOME, ".omo", "omo.jsonc")
const PROJECT_CONFIG = path.join(PROJECT, ".omo", "omo.jsonc")
const ENV = { HOME }

function memoryFileSystem(files) {
  const entries = new Map(Object.entries(files))
  return {
    existsSync: (path) => entries.has(path),
    lstatSync: () => ({ isSymbolicLink: () => false }),
    readFileSync: (path) => {
      const value = entries.get(path)
      if (value === undefined) throw new Error(`ENOENT: ${path}`)
      return value
    },
    realpathSync: (path) => path,
  }
}

function liveOpenclaw(block) {
  return memoryFileSystem({ [USER_CONFIG]: JSON.stringify({ "[opencode]": { openclaw: block } }) })
}

function readSource(fileSystem, env = ENV) {
  return config.readLiveOpenclawSource({ directory: PROJECT, env, fileSystem })
}

function resolveOpenclaw(manifest, fileSystem, env = ENV) {
  return config.resolveNativeOpenclaw({ manifest, directory: PROJECT, env, fileSystem })
}

const LEGACY_BLOCK = {
  enabled: true,
  gateways: { hook: { url: "https://gateway.test/hook" } },
  hooks: { "session.idle": { gateway: "hook", instruction: "notify {{sessionId}}" } },
}

function manifestWith(openclaw) {
  return { metadata: { global: openclaw === undefined ? {} : { openclaw } } }
}

describe("live openclaw reader reports three states", () => {
  test("#given no layer declares openclaw #when read #then it is undeclared rather than an invented value", () => {
    const fileSystem = memoryFileSystem({ [USER_CONFIG]: JSON.stringify({ "[opencode]": { monitor: { enabled: true } } }) })
    expect(readSource(fileSystem)).toEqual({ state: "undeclared" })
  })

  test("#given the user layer declares [opencode].openclaw #when read #then the live block is reported with its declaring path", () => {
    const fileSystem = liveOpenclaw(LEGACY_BLOCK)
    const state = readSource(fileSystem)
    expect(state.state).toBe("declared")
    expect(state.path).toBe(USER_CONFIG)
    expect(state.at).toBe("[opencode].openclaw")
    expect(state.value).toEqual(LEGACY_BLOCK)
  })

  test("#given a project layer declares it too #when read #then the project layer wins, per the documented precedence", () => {
    const fileSystem = memoryFileSystem({
      [USER_CONFIG]: JSON.stringify({ "[opencode]": { openclaw: { enabled: true, gateways: { user: { url: "https://user.test" } } } } }),
      [PROJECT_CONFIG]: JSON.stringify({ "[opencode]": { openclaw: { enabled: true, gateways: { project: { url: "https://project.test" } } } } }),
    })
    const state = readSource(fileSystem)
    expect(state.path).toBe(PROJECT_CONFIG)
    expect(Object.keys(state.value.gateways)).toEqual(["project"])
  })

  test("#given a live file that exists but cannot be read #when read #then it is an error, never undeclared", () => {
    const unreadable = {
      existsSync: () => true,
      lstatSync: () => ({ isSymbolicLink: () => false }),
      readFileSync: () => {
        throw new Error("EIO: cannot read")
      },
      realpathSync: (path) => path,
    }
    const state = readSource(unreadable)
    expect(state.state).toBe("error")
    expect(state.reason).toContain("EIO")
  })

  test("#given a live file that is not valid JSON #when read #then it is an error", () => {
    const fileSystem = memoryFileSystem({ [USER_CONFIG]: "{ [opencode]: " })
    expect(readSource(fileSystem).state).toBe("error")
  })

  test("#given the declaring layer writes a non-object value #when read #then it is an error instead of a manifest fallback", () => {
    const fileSystem = memoryFileSystem({ [USER_CONFIG]: JSON.stringify({ "[opencode]": { openclaw: "on" } }) })
    const state = readSource(fileSystem)
    expect(state.state).toBe("error")
    expect(state.reason).toContain("[opencode].openclaw")
  })
})

describe("openclaw resolution under the three-state contract", () => {
  test("#given the manifest declares openclaw and no layer does #when resolved #then the manifest block is handed over unchanged with no diagnostic", () => {
    const resolution = resolveOpenclaw(manifestWith(LEGACY_BLOCK), memoryFileSystem({}))
    expect(resolution.state).toBe("undeclared")
    expect(resolution.config).toEqual(LEGACY_BLOCK)
    expect(resolution.diagnostics).toEqual([])
  })

  test("#given the manifest declares nothing and the live file declares openclaw #when resolved #then the live block activates with exactly one log line", () => {
    const resolution = resolveOpenclaw(manifestWith(undefined), liveOpenclaw(LEGACY_BLOCK))
    expect(resolution.state).toBe("declared")
    expect(resolution.config).toEqual(LEGACY_BLOCK)
    expect(resolution.diagnostics).toHaveLength(1)
    expect(resolution.diagnostics[0]).toContain("live config declares [opencode].openclaw")
    expect(resolution.diagnostics[0]).toContain(USER_CONFIG)
  })

  test("#given the manifest and the live file agree #when resolved #then no transition is reported", () => {
    const resolution = resolveOpenclaw(manifestWith(LEGACY_BLOCK), liveOpenclaw(LEGACY_BLOCK))
    expect(resolution.config).toEqual(LEGACY_BLOCK)
    expect(resolution.diagnostics).toEqual([])
  })

  test("#given the live file drops a gateway the manifest baked #when resolved #then the live block wins wholesale and the removal is reported", () => {
    const live = { enabled: true, gateways: { bot: { url: "https://bot.test/x" } }, hooks: {} }
    const resolution = resolveOpenclaw(manifestWith(LEGACY_BLOCK), liveOpenclaw(live))
    expect(resolution.config).toEqual(live)
    expect(Object.keys(resolution.config.gateways)).toEqual(["bot"])
    expect(resolution.diagnostics).toHaveLength(1)
    expect(resolution.diagnostics[0]).toContain("gateways +[bot]")
    expect(resolution.diagnostics[0]).toContain("gateways -[hook]")
  })

  test("#given the live file disables openclaw #when resolved #then the live value wins at the single global switch", () => {
    const resolution = resolveOpenclaw(manifestWith(LEGACY_BLOCK), liveOpenclaw({ enabled: false }))
    expect(resolution.config).toEqual({ enabled: false })
    expect(resolution.diagnostics).toHaveLength(1)
    expect(resolution.diagnostics[0]).toContain("enabled true -> false")
  })

  test("#given the live file adds reply-policy allowed-authors #when resolved #then exactly one value-free policy identity difference is reported", () => {
    const manifest = {
      ...LEGACY_BLOCK,
      replyPolicy: { telegram: {} },
    }
    const live = {
      ...manifest,
      replyPolicy: { telegram: { allowedAuthors: ["author-value-not-to-log"] } },
    }
    const resolution = resolveOpenclaw(manifestWith(manifest), liveOpenclaw(live))
    expect(resolution.diagnostics).toHaveLength(1)
    expect(resolution.diagnostics[0]).toContain("replyPolicy.telegram.allowedAuthors")
    expect(resolution.diagnostics[0]).not.toContain("author-value-not-to-log")
  })

  test("#given only reply-policy author values change #when resolved #then no identity difference is reported", () => {
    const manifest = {
      ...LEGACY_BLOCK,
      replyPolicy: { telegram: { allowedAuthors: ["manifest-author-value"] } },
    }
    const live = {
      ...LEGACY_BLOCK,
      replyPolicy: { telegram: { allowedAuthors: ["live-author-value"] } },
    }
    const resolution = resolveOpenclaw(manifestWith(manifest), liveOpenclaw(live))
    expect(resolution.diagnostics).toEqual([])
  })

  test("#given reply-listener field names change #when resolved #then the field-name identity difference is reported without a value", () => {
    const manifest = {
      ...LEGACY_BLOCK,
      replyListener: { discordBotToken: "listener-value-not-to-log" },
    }
    const live = {
      ...LEGACY_BLOCK,
      replyListener: { telegramBotToken: "listener-value-not-to-log" },
    }
    const resolution = resolveOpenclaw(manifestWith(manifest), liveOpenclaw(live))
    expect(resolution.diagnostics).toHaveLength(1)
    expect(resolution.diagnostics[0]).toContain("replyListener +[telegramBotToken]")
    expect(resolution.diagnostics[0]).toContain("replyListener -[discordBotToken]")
    expect(resolution.diagnostics[0]).not.toContain("listener-value-not-to-log")
  })
  test("#given the live chain is unreadable #when resolved #then openclaw fails closed instead of using the baked manifest", () => {
    const unreadable = {
      existsSync: () => true,
      lstatSync: () => ({ isSymbolicLink: () => false }),
      readFileSync: () => {
        throw new Error("EACCES: permission denied")
      },
      realpathSync: (path) => path,
    }
    const resolution = resolveOpenclaw(manifestWith(LEGACY_BLOCK), unreadable)
    expect(resolution.state).toBe("error")
    expect(resolution.config).toBeUndefined()
    expect(resolution.diagnostics).toHaveLength(1)
    expect(resolution.diagnostics[0]).toContain("could not be resolved")
    expect(resolution.diagnostics[0]).toContain("stays disabled")
  })

  test("#given a chain that cannot be resolved at all #when resolved #then it also fails closed", () => {
    const unresolvable = {
      existsSync: () => {
        throw new Error("EACCES: cannot resolve the config chain")
      },
      lstatSync: () => ({ isSymbolicLink: () => false }),
      readFileSync: () => {
        throw new Error("EACCES")
      },
      realpathSync: (path) => path,
    }
    const resolution = resolveOpenclaw(manifestWith(LEGACY_BLOCK), unresolvable)
    expect(resolution.state).toBe("error")
    expect(resolution.config).toBeUndefined()
    expect(resolution.diagnostics).toHaveLength(1)
  })
})

describe("openclaw effects stay lazy at the first send", () => {
  function countingFetch() {
    const calls = []
    const fetchImpl = async (url, init = {}) => {
      calls.push(`${init.method ?? "GET"} ${url}`)
      return { ok: true, status: 200, text: async () => '{"messageId":"m1","platform":"discord"}', json: async () => ({}) }
    }
    fetchImpl.calls = calls
    return fetchImpl
  }

  function memoryStorage() {
    const map = new Map()
    return {
      map,
      get: async (key) => map.get(key),
      set: async (key, value) => {
        map.set(key, value)
      },
      remove: async (key) => {
        map.delete(key)
      },
      scan: async ({ prefix } = {}) => ({
        entries: [...map.entries()]
          .filter(([key]) => (prefix ? key.startsWith(prefix) : true))
          .map(([key, value]) => ({ key, value })),
      }),
    }
  }

  test("#given a live-declared block #when setup completes #then no request has left the process and the first send is what reaches the network", async () => {
    const resolution = resolveOpenclaw(manifestWith(undefined), liveOpenclaw(LEGACY_BLOCK))
    const fetchImpl = countingFetch()
    const native = createNativeOpenclaw({
      context: { storage: memoryStorage(), session: { prompt: async () => ({}) } },
      config: resolution.config,
      fetchImpl,
      env: {},
      log: () => {},
    })

    expect(await native.ready).toEqual({ started: false, reason: "no-credentials" })
    expect(fetchImpl.calls).toEqual([])
    expect(native.status().enabled).toBe(true)

    const receipt = await native.handleEvent({ type: "session.idle", sessionID: "ses_u2", projectPath: "/p" })
    expect(receipt).toMatchObject({ success: true, messageId: "m1" })
    expect(fetchImpl.calls).toEqual(["POST https://gateway.test/hook"])
    await native.dispose()
  })

  test("#given a live chain in error #when the composition is built #then it stays an inert no-op that never reaches the network", async () => {
    const unreadable = {
      existsSync: () => true,
      lstatSync: () => ({ isSymbolicLink: () => false }),
      readFileSync: () => {
        throw new Error("EIO")
      },
      realpathSync: (path) => path,
    }
    const resolution = resolveOpenclaw(manifestWith(LEGACY_BLOCK), unreadable)
    let fetches = 0
    const native = createNativeOpenclaw({
      context: { storage: memoryStorage(), session: { prompt: async () => ({}) } },
      config: resolution.config,
      fetchImpl: async () => {
        fetches += 1
      },
      env: {},
      log: () => {},
    })

    expect(native.enabled).toBe(false)
    expect(await native.ready).toEqual({ started: false, reason: "disabled" })
    expect(await native.handleEvent({ type: "session.idle", sessionID: "ses_u2" })).toBeNull()
    await native.dispose()
    expect(fetches).toBe(0)
  })

  test("#given a legacy install with no live declaration #when resolved and composed #then the manifest block and its call order are unchanged", async () => {
    const resolution = resolveOpenclaw(manifestWith(LEGACY_BLOCK), memoryFileSystem({}))
    expect(resolution.config).toEqual(config.readNativeOpenclaw(manifestWith(LEGACY_BLOCK)))

    const fetchImpl = countingFetch()
    const native = createNativeOpenclaw({
      context: { storage: memoryStorage(), session: { prompt: async () => ({}) } },
      config: resolution.config,
      fetchImpl,
      env: {},
      log: () => {},
    })
    expect(await native.ready).toEqual({ started: false, reason: "no-credentials" })
    expect(fetchImpl.calls).toEqual([])
    await native.handleEvent({ type: "session.idle", sessionID: "ses_legacy", projectPath: "/p" })
    await native.handleEvent({ type: "session.error", sessionID: "ses_legacy" })
    expect(fetchImpl.calls).toEqual(["POST https://gateway.test/hook"])
    expect(Object.keys(native.status()).sort()).toEqual(["enabled", "registry", "started"])
    await native.dispose()
  })
})

// --- Audit remediation (A1, A2, A3): the fail-closed edge of the same contract ---
//
// The three cases below are the defect classes the Codex review of PR #73 found in the
// merged tree, not new behavior: a rejected layer that used to be silent, a declaration
// finder that disagreed with the fold, and a parser message that carried source text.
// Each one is a way to reach the NETWORK surface from a value the runtime could not
// confirm, so each one must end in `error` with the surface inert.

// A synthetic marker, not a credential: it stands in for whatever a malformed live line
// carried. The parser quotes the text around the offending token (V8 a ~10 character
// window, JSC the whole identifier), so the window is what a leak would expose first.
const SYNTHETIC_MARKER = "syntheticfixturemarkernotasecret"
const SYNTHETIC_MARKER_PREFIX = SYNTHETIC_MARKER.slice(0, 10)

describe("a rejected live layer fails closed", () => {
  test.each([
    ["a null root", "null"],
    ["an array root", "[]"],
    ["a scalar root", "\"on\""],
  ])("#given a live file whose root is %s #when read and resolved #then it is an error and the manifest block is never handed over", (_, rootText) => {
    // given a layer that exists and parses, plus a manifest that bakes the block
    const fileSystem = memoryFileSystem({ [USER_CONFIG]: rootText })
    // when
    const state = readSource(fileSystem)
    const resolution = resolveOpenclaw(manifestWith(LEGACY_BLOCK), fileSystem)
    // then the file could not be read as a layer, so the contract's `error` applies and
    // the install-time block is refused (a non-object root used to be `undeclared`,
    // which handed the manifest over and re-enabled the network surface)
    expect(state.state).toBe("error")
    expect(state.reason).toBeString()
    expect(resolution.state).toBe("error")
    expect(resolution.config).toBeUndefined()
    expect(resolution.diagnostics).toHaveLength(1)
    expect(resolution.diagnostics[0]).toContain(USER_CONFIG)
    expect(resolution.diagnostics[0]).toContain("stays disabled")
  })

  test("#given a rejected layer beside a valid lower-precedence declaration #when resolved #then the rejection still wins", () => {
    // given the user file cannot be read as a layer while the project declares an
    // enabled block; a layer that could not be read means the chain is unconfirmed
    const fileSystem = memoryFileSystem({
      [USER_CONFIG]: "[]",
      [PROJECT_CONFIG]: JSON.stringify({ openclaw: { enabled: true, gateways: { project: { url: "https://project.test" } } } }),
    })
    // when
    const resolution = resolveOpenclaw(manifestWith(LEGACY_BLOCK), fileSystem)
    // then nothing is enabled from a chain the runtime could not fully read
    expect(resolution.state).toBe("error")
    expect(resolution.config).toBeUndefined()
  })
})

describe("declaration precedence matches the config fold", () => {
  // Each row is a layer chain plus the placement the FOLD gives the key, so the finder
  // cannot be right by accident. `buildResolvedConfigView` folds placement-major and
  // layer-inner (root, [opencode], profile root, profile [opencode]; user then project
  // inside each placement), and the last view wins. A placement on a farther layer
  // therefore outranks a lower placement on a nearer one:
  //   profiles.<P>.[opencode] > profiles.<P> > [opencode] > root
  // A non-object declaration at that winning placement is `error`, never a silent
  // fall-through to whatever the next view still carries.
  const ROWS = [
    {
      name: "a higher-precedence null declaration beats a lower enabled object",
      user: { profiles: { gabo: { "[opencode]": { openclaw: null } } } },
      project: { openclaw: { enabled: true, gateways: { project: { url: "https://project.test" } } } },
      expect: { state: "error", at: "profiles.gabo.[opencode].openclaw", scope: "user" },
    },
    {
      name: "the user profile block outranks a project root block",
      user: { profiles: { gabo: { "[opencode]": { openclaw: { enabled: true, gateways: { profile: { url: "https://profile.test" } } } } } } },
      project: { openclaw: { enabled: true, gateways: { project: { url: "https://project.test" } } } },
      expect: { state: "declared", at: "profiles.gabo.[opencode].openclaw", scope: "user" },
    },
    {
      name: "a project root null declaration turns the surface off, not on",
      user: { openclaw: { enabled: true, gateways: { user: { url: "https://user.test" } } } },
      project: { openclaw: null },
      expect: { state: "error", at: "openclaw", scope: "project" },
    },
    {
      name: "an [opencode] block outranks the project root it sits beside",
      user: { "[opencode]": { openclaw: { enabled: true, gateways: { harness: { url: "https://harness.test" } } } } },
      project: { openclaw: { enabled: true, gateways: { project: { url: "https://project.test" } } } },
      expect: { state: "declared", at: "[opencode].openclaw", scope: "user" },
    },
    {
      name: "the user profile root outranks the project [opencode] block",
      user: { profiles: { gabo: { openclaw: { enabled: true, gateways: { profile: { url: "https://profile.test" } } } } } },
      project: { "[opencode]": { openclaw: { enabled: true, gateways: { project: { url: "https://project.test" } } } } },
      expect: { state: "declared", at: "profiles.gabo.openclaw", scope: "user" },
    },
    {
      name: "the profile block outranks the same layer's root",
      user: { openclaw: { enabled: false, gateways: { root: { url: "https://root.test" } } }, profiles: { gabo: { "[opencode]": { openclaw: { enabled: true, gateways: { profile: { url: "https://profile.test" } } } } } } },
      project: {},
      expect: { state: "declared", at: "profiles.gabo.[opencode].openclaw", scope: "user" },
    },
    {
      name: "a project profile [opencode] block is the last word",
      user: { profiles: { gabo: { "[opencode]": { openclaw: { enabled: true, gateways: { user: { url: "https://user.test" } } } } } } },
      project: { profiles: { gabo: { "[opencode]": { openclaw: { enabled: true, gateways: { project: { url: "https://project.test" } } } } } } },
      expect: { state: "declared", at: "profiles.gabo.[opencode].openclaw", scope: "project" },
    },
    {
      name: "a project profile root null does not outrank the user profile [opencode] object",
      user: { profiles: { gabo: { "[opencode]": { openclaw: { enabled: true, gateways: { user: { url: "https://user.test" } } } } } } },
      project: { profiles: { gabo: { openclaw: null } } },
      expect: { state: "declared", at: "profiles.gabo.[opencode].openclaw", scope: "user" },
    },
  ]

  test.each(ROWS)("#given $name #when read #then the reported placement and state are the fold's", (row) => {
    // given the profile rows need the selected profile, exactly as a real install sets it
    const env = { HOME, OMO_PROFILE: "gabo" }
    const files = {}
    if (Object.keys(row.user).length > 0) files[USER_CONFIG] = JSON.stringify(row.user)
    if (Object.keys(row.project).length > 0) files[PROJECT_CONFIG] = JSON.stringify(row.project)
    const fileSystem = memoryFileSystem(files)
    // when
    const state = readSource(fileSystem, env)
    const folded = config.resolveNativePluginConfig({ directory: PROJECT, env, fileSystem }).openclaw
    // then
    expect(state.state).toBe(row.expect.state)
    expect(state.at).toBe(row.expect.at)
    expect(state.path).toBe(row.expect.scope === "user" ? USER_CONFIG : PROJECT_CONFIG)
    if (row.expect.state === "declared") {
      // The finder and the fold must agree about the VALUE too, or a caller could accept
      // a declaration the resolved view never produced.
      expect(state.value).toEqual(folded)
    } else {
      expect(state.value).toBeUndefined()
    }
  })
})

describe("a read failure is reported without the source text", () => {
  const malformed = `{ "[opencode]": { "openclaw": { "enabled": true, "channels": { "discord": { "discordBotToken": ${SYNTHETIC_MARKER} } } } } }`

  test("#given a malformed live file whose offending token is a credential #when resolved #then the diagnostic keeps the path and class but no fragment of the value", () => {
    // given
    const fileSystem = memoryFileSystem({ [USER_CONFIG]: malformed })
    // when
    const state = readSource(fileSystem)
    const resolution = resolveOpenclaw(manifestWith(LEGACY_BLOCK), fileSystem)
    // then the JSON parser names the text it choked on, and that text is a credential
    expect(state.state).toBe("error")
    expect(state.reason).not.toContain(SYNTHETIC_MARKER_PREFIX)
    expect(resolution.state).toBe("error")
    expect(resolution.diagnostics).toHaveLength(1)
    expect(resolution.diagnostics[0]).toContain(USER_CONFIG)
    expect(resolution.diagnostics[0]).not.toContain(SYNTHETIC_MARKER_PREFIX)
  })

  test("#given a read failure with a filesystem code #when read #then the code still identifies the failure", () => {
    // given an unreadable file whose error carries an errno code (the non-secret case
    // the sanitizer must not flatten into an opaque message)
    const unreadable = {
      existsSync: () => true,
      lstatSync: () => ({ isSymbolicLink: () => false }),
      readFileSync: () => {
        throw Object.assign(new Error("EACCES: permission denied, open '/home/rigeltest/.omo/omo.jsonc'"), { code: "EACCES" })
      },
      realpathSync: (path) => path,
    }
    // when
    const state = readSource(unreadable)
    // then the operator keeps the class it needs and nothing from the file
    expect(state.state).toBe("error")
    expect(state.reason).toContain("EACCES")
  })
})
