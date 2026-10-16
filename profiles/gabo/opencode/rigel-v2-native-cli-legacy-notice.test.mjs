import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  LEGACY_NOTICE_MESSAGE,
  LEGACY_NOTICE_TITLE,
  LEGACY_NOTICE_VARIANT,
} from "./rigel-v2-native-legacy-plugin-notice.mjs"
import {
  LEGACY_NOTICE_PLUGIN_ID,
  createLegacyNoticeCliSurface,
  resolveLegacyNoticeReceiptPath,
} from "./rigel-v2-native-cli-legacy-notice.mjs"

const NOW = 1_700_000_000_000

function fakeContext(input = {}) {
  const { renderer = { isDestroyed: false }, sessions = {}, stateConfig, toastThrows = false } = input
  // Honour an explicitly-passed `options: undefined` (the "gate absent" case);
  // a destructuring default would turn it into `{}`.
  const options = "options" in input ? input.options : {}
  const handlers = new Map()
  const toasts = []
  const unsubscribed = []
  const api = {
    options,
    renderer,
    state: stateConfig === undefined ? {} : { config: stateConfig },
    location: { current: { directory: "/tmp/work" } },
    data: {
      on(name, handler) {
        handlers.set(name, handler)
        return () => {
          handlers.delete(name)
          unsubscribed.push(name)
        }
      },
      session: { get: (id) => sessions[id] },
    },
    ui: {
      toast: {
        show: (toast) => {
          if (toastThrows) throw new Error("toast exploded")
          toasts.push(toast)
        },
      },
    },
  }
  return { api, handlers, toasts, unsubscribed, handler: (name) => handlers.get(name) }
}

let dir
let receiptPath

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rigel-legacy-notice-"))
  receiptPath = join(dir, "legacy-plugin-notice.json")
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function deps(extra = {}) {
  return { now: () => NOW, logFile: join(dir, "legacy-plugin-notice.log"), receiptPath, ...extra }
}

function sessionCreated(sessionID = "ses_1") {
  return { type: "session.created", data: { sessionID } }
}

function readReceipt() {
  return JSON.parse(readFileSync(receiptPath, "utf-8"))
}

describe("an absent gate is exactly zero side effects", () => {
  test("#given no plugin options #when setup runs #then nothing registers", () => {
    // given
    const fake = fakeContext({ options: undefined })

    // when
    const cleanup = createLegacyNoticeCliSurface(deps({ config: { plugin: ["oh-my-opencode"] } })).setup(fake.api)

    // then
    expect(cleanup).toBeUndefined()
    expect(fake.handlers.size).toBe(0)
  })

  test("#given an explicit kill switch #when setup runs #then nothing registers", () => {
    // given
    const fake = fakeContext({ options: { legacyPluginNotice: { enabled: false } } })

    // when
    const cleanup = createLegacyNoticeCliSurface(deps({ config: { plugin: ["oh-my-opencode"] } })).setup(fake.api)

    // then
    expect(cleanup).toBeUndefined()
    expect(fake.handlers.size).toBe(0)
  })

  test("#given a headless renderer #when setup runs #then nothing registers", () => {
    // given
    const fake = fakeContext({ renderer: null })

    // when
    const cleanup = createLegacyNoticeCliSurface(deps({ config: { plugin: ["oh-my-opencode"] } })).setup(fake.api)

    // then
    expect(cleanup).toBeUndefined()
    expect(fake.handlers.size).toBe(0)
  })

  test("#given no toast surface #when setup runs #then nothing registers", () => {
    // given
    const fake = fakeContext()
    fake.api.ui = {}

    // when
    const cleanup = createLegacyNoticeCliSurface(deps({ config: { plugin: ["oh-my-opencode"] } })).setup(fake.api)

    // then
    expect(cleanup).toBeUndefined()
  })
})

describe("a legacy entry produces the rename toast and a durable receipt", () => {
  test("#given a legacy entry #when session.created fires #then the warning toast and receipt are produced", () => {
    // given
    const fake = fakeContext()
    createLegacyNoticeCliSurface(deps({ config: { plugin: ["oh-my-opencode"] } })).setup(fake.api)

    // when
    fake.handler("session.created")(sessionCreated())

    // then
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]).toEqual({
      title: LEGACY_NOTICE_TITLE,
      message: LEGACY_NOTICE_MESSAGE,
      variant: LEGACY_NOTICE_VARIANT,
      duration: 10000,
    })
    expect(existsSync(receiptPath)).toBe(true)
    expect(readReceipt()).toEqual({ schemaVersion: 1, notifiedAt: NOW, entries: ["oh-my-opencode"] })
  })

  test("#given a versioned legacy entry #when session.created fires #then the entry name reaches the receipt", () => {
    // given
    const fake = fakeContext()
    createLegacyNoticeCliSurface(deps({ config: { plugin: ["oh-my-opencode@3.2.1"] } })).setup(fake.api)

    // when
    fake.handler("session.created")(sessionCreated())

    // then
    expect(readReceipt().entries).toEqual(["oh-my-opencode@3.2.1"])
  })

  test("#given a canonical entry #when session.created fires #then nothing is shown or written", () => {
    // given
    const fake = fakeContext()
    createLegacyNoticeCliSurface(deps({ config: { plugin: ["oh-my-openagent"] } })).setup(fake.api)

    // when
    fake.handler("session.created")(sessionCreated())

    // then
    expect(fake.toasts).toHaveLength(0)
    expect(existsSync(receiptPath)).toBe(false)
  })

  test("#given a miss #when the config later gains a legacy entry #then the per-process guard has already been consumed", () => {
    // given
    const config = { plugin: ["oh-my-openagent"] }
    const fake = fakeContext()
    createLegacyNoticeCliSurface(deps({ config })).setup(fake.api)
    const handler = fake.handler("session.created")

    // when
    handler(sessionCreated())
    config.plugin = ["oh-my-opencode"]
    handler(sessionCreated())

    // then
    expect(fake.toasts).toHaveLength(0)
  })

  test("#given a legacy entry on two root events #when they fire #then the toast is shown once", () => {
    // given
    const fake = fakeContext()
    createLegacyNoticeCliSurface(deps({ config: { plugin: ["oh-my-opencode"] } })).setup(fake.api)
    const handler = fake.handler("session.created")

    // when
    handler(sessionCreated())
    handler(sessionCreated())

    // then
    expect(fake.toasts).toHaveLength(1)
  })
})

describe("a legacy entry is reported as early as setup (row 61)", () => {
  test("#given a legacy entry present when the surface loads #then the toast and receipt fire before any session.created", () => {
    // given
    const fake = fakeContext()
    // when the surface is set up with the in-memory config already carrying the legacy entry
    createLegacyNoticeCliSurface(deps({ config: { plugin: ["oh-my-opencode"] } })).setup(fake.api)
    // then the notice is produced without waiting for a session event
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0].title).toBe(LEGACY_NOTICE_TITLE)
    expect(existsSync(receiptPath)).toBe(true)
    expect(readReceipt().entries).toEqual(["oh-my-opencode"])
  })

  test("#given no legacy at setup #when the config later gains one #then the late session.created path still fires", () => {
    // given: a miss at setup must NOT consume the once-guard
    const config = { plugin: ["oh-my-openagent"] }
    const fake = fakeContext()
    createLegacyNoticeCliSurface(deps({ config })).setup(fake.api)
    expect(fake.toasts).toHaveLength(0)

    // when the config later carries the legacy entry and a root session starts
    config.plugin = ["oh-my-opencode"]
    fake.handler("session.created")(sessionCreated())

    // then the late path reports it
    expect(fake.toasts).toHaveLength(1)
  })

  test("#given a canonical entry at setup #then nothing fires early or late", () => {
    // given / when
    const fake = fakeContext()
    createLegacyNoticeCliSurface(deps({ config: { plugin: ["oh-my-openagent"] } })).setup(fake.api)
    fake.handler("session.created")(sessionCreated())

    // then
    expect(fake.toasts).toHaveLength(0)
    expect(existsSync(receiptPath)).toBe(false)
  })
})

describe("only root sessions are considered", () => {
  test("#given a legacy entry appearing after setup #when session.created fires #then the notice waits for a root session", () => {
    // given: no legacy at setup (the early path misses), legacy present when sessions start
    const config = { plugin: ["oh-my-openagent"] }
    const fake = fakeContext({ sessions: { ses_child: { id: "ses_child", parentID: "ses_root" } } })
    createLegacyNoticeCliSurface(deps({ config })).setup(fake.api)
    const handler = fake.handler("session.created")
    config.plugin = ["oh-my-opencode"]

    // when a child session fires
    handler(sessionCreated("ses_child"))

    // then nothing is shown and the guard stays open
    expect(fake.toasts).toHaveLength(0)

    // when a root session later fires, the guard was not consumed
    handler(sessionCreated("ses_root"))

    // then the notice is produced
    expect(fake.toasts).toHaveLength(1)
  })
})

describe("the in-memory config is resolved from the host context", () => {
  test("#given the config on context.state #when session.created fires #then it is detected without any override", () => {
    // given
    const fake = fakeContext({ stateConfig: { plugin: ["oh-my-opencode"] } })
    createLegacyNoticeCliSurface({ now: () => NOW, receiptPath, logFile: join(dir, "log") }).setup(fake.api)

    // when
    fake.handler("session.created")(sessionCreated())

    // then
    expect(fake.toasts).toHaveLength(1)
  })
})

describe("a contained failure never throws into the host", () => {
  test("#given the toast throws #when session.created fires #then the handler does not throw", () => {
    // given
    const fake = fakeContext({ toastThrows: true })
    createLegacyNoticeCliSurface(deps({ config: { plugin: ["oh-my-opencode"] } })).setup(fake.api)

    // when / then
    expect(() => fake.handler("session.created")(sessionCreated())).not.toThrow()
  })
})

describe("the surface is disposed cleanly", () => {
  test("#given a set-up surface #when disposed #then the subscription is released", () => {
    // given
    const fake = fakeContext()
    const cleanup = createLegacyNoticeCliSurface(deps({ config: { plugin: ["oh-my-opencode"] } })).setup(fake.api)

    // when
    cleanup()

    // then
    expect(fake.unsubscribed).toContain("session.created")
  })
})

describe("the surface identity and receipt path are stable", () => {
  test("#given the surface #when read #then it carries the plugin id", () => {
    // given / when / then
    expect(createLegacyNoticeCliSurface().id).toBe(LEGACY_NOTICE_PLUGIN_ID)
  })

  test("#given an XDG state home #when the receipt path is resolved #then it is the documented path", () => {
    // given / when / then
    expect(resolveLegacyNoticeReceiptPath({ env: { XDG_STATE_HOME: "/xdg/state" }, home: "/home/example" })).toBe(
      join("/xdg/state", "oh-my-rigel", "legacy-plugin-notice.json"),
    )
  })

  test("#given no XDG state home #when the receipt path is resolved #then it falls back to the home", () => {
    // given / when / then
    expect(resolveLegacyNoticeReceiptPath({ env: {}, home: "/home/example" })).toBe(
      join("/home/example", ".local", "state", "oh-my-rigel", "legacy-plugin-notice.json"),
    )
  })
})
