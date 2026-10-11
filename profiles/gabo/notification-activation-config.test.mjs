import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DISABLED_BUILTIN_NOTIFICATION,
  isRigelRuntimeDir,
  parseJsonc,
  registerCompanionCliPlugin,
  registerNotificationCliPlugin,
  removeRigelCliEntries,
  resolveNotificationOptions,
  resolveProfileOpenCodeBlock,
  stripJsonComments,
} from "./notification-activation-config.mjs"
import { registerRuntimePluginEntry } from "./rigel-v2-runtime-materialize.mjs"

/** Create a Rigel runtime directory (package.json name `rigel-v2-native`). */
function makeRigelRuntime(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "rigel-v2-native", type: "module" })}\n`)
  return dir
}

/** Create a foreign plugin directory that merely shares the runtime path shape. */
function makeForeignRuntime(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "some-other-plugin" })}\n`)
  return dir
}

describe("parseJsonc", () => {
  test("#given comments and trailing commas #then the document parses", () => {
    const text = `{
      // a line comment with a URL http://example.com
      "notification": { "force_enable": true, },
      /* block
         comment */
      "disabled_hooks": ["x", "session-notification",],
    }`
    const parsed = parseJsonc(text)
    expect(parsed.notification.force_enable).toBe(true)
    expect(parsed.disabled_hooks).toEqual(["x", "session-notification"])
  })

  test("#given a comment marker inside a string #then it is preserved", () => {
    expect(stripJsonComments('{"a": "//not-a-comment"}')).toBe('{"a": "//not-a-comment"}')
  })
})

describe("resolveProfileOpenCodeBlock", () => {
  test("#given the multi-profile document #then the selected profile's opencode block is returned", () => {
    const document = {
      profiles: {
        gabo: {
          "[opencode]": {
            disabled_hooks: ["session-notification"],
            notification: { force_enable: true },
          },
        },
      },
    }
    const block = resolveProfileOpenCodeBlock(document, "gabo")
    expect(block.disabled_hooks).toEqual(["session-notification"])

    const options = resolveNotificationOptions({ profile: block, externalNotifierDetected: true })
    // A disabled hook wins over force_enable: the plugin must stay inert.
    expect(options.enabled).toBe(false)
    expect(options.forceEnable).toBe(true)
  })

  test("#given an already-merged block #then it is returned unchanged", () => {
    const block = { disabled_hooks: [] }
    expect(resolveProfileOpenCodeBlock(block)).toBe(block)
  })
})

describe("resolveNotificationOptions", () => {
  test("#given a profile without a notification block #then the companion is inert", () => {
    const options = resolveNotificationOptions({ profile: {} })
    expect(options.configured).toBe(false)
    expect(options.enabled).toBe(false)
    expect(resolveNotificationOptions({}).enabled).toBe(false)
  })

  test("#given an explicit enabled block #then the companion takes ownership", () => {
    const options = resolveNotificationOptions({ profile: { notification: { enabled: true } } })
    expect(options.configured).toBe(true)
    expect(options.enabled).toBe(true)
  })

  test("#given an explicit disabled block #then the companion is inert", () => {
    const options = resolveNotificationOptions({ profile: { notification: { enabled: false } } })
    expect(options.configured).toBe(true)
    expect(options.enabled).toBe(false)
  })

  test("#given the hook is disabled #then the plugin is inert", () => {
    const options = resolveNotificationOptions({ profile: { notification: { enabled: true }, disabled_hooks: ["session-notification"] } })
    expect(options.enabled).toBe(false)
  })

  test("#given an external notifier and no force_enable #then it is suppressed", () => {
    const options = resolveNotificationOptions({ profile: { notification: { enabled: true } }, externalNotifierDetected: true })
    expect(options.enabled).toBe(false)
  })

  test("#given an external notifier and force_enable #then it wins", () => {
    const options = resolveNotificationOptions({
      profile: { notification: { enabled: true, force_enable: true } },
      externalNotifierDetected: true,
    })
    expect(options.enabled).toBe(true)
    expect(options.forceEnable).toBe(true)
  })

  test("#given an override #then it sets the gate only when the block is present", () => {
    expect(resolveNotificationOptions({ profile: { notification: { enabled: true } }, enabledOverride: false }).enabled).toBe(false)
    expect(resolveNotificationOptions({ profile: { notification: { enabled: false } }, enabledOverride: true }).enabled).toBe(true)
    // An override cannot enable an unconfigured profile.
    expect(resolveNotificationOptions({ profile: {}, enabledOverride: true }).enabled).toBe(false)
  })

  test("#given sound and timing overrides #then they are honored", () => {
    const options = resolveNotificationOptions({
      profile: { notification: { enabled: true, play_sound: true, sound_name: "chime", idle_confirmation_delay: 25 } },
    })
    expect(options.playSound).toBe(true)
    expect(options.soundName).toBe("chime")
    expect(options.idleConfirmationDelay).toBe(25)
  })
})

describe("registerNotificationCliPlugin", () => {
  const runtimeDir = "/lab/rigel/runtime/rigel-v2-native"
  const options = { enabled: true }

  test("#given an existing config #then unrelated plugins are preserved and ours is appended", () => {
    const config = { plugins: ["./plugins/auto_approve_keybind.mjs", "@prevalentware/opencode-goal-plugin@latest"] }
    const next = registerNotificationCliPlugin(config, { runtimeDir, options })
    expect(next.plugins[0]).toBe("./plugins/auto_approve_keybind.mjs")
    expect(next.plugins[1]).toBe("@prevalentware/opencode-goal-plugin@latest")
    expect(next.plugins).toContainEqual({ package: runtimeDir, options: { notification: options } })
    expect(next.plugins).toContain(DISABLED_BUILTIN_NOTIFICATION)
  })

  test("#given repeated registration #then it is idempotent", () => {
    const once = registerNotificationCliPlugin({ plugins: [] }, { runtimeDir, options })
    const twice = registerNotificationCliPlugin(once, { runtimeDir, options })
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
    expect(twice.plugins.filter((entry) => typeof entry === "object" && entry.package === runtimeDir)).toHaveLength(1)
    expect(twice.plugins.filter((entry) => entry === DISABLED_BUILTIN_NOTIFICATION)).toHaveLength(1)
  })

  test("#given the plugin is already registered as a string #then it is replaced by the object form", () => {
    const next = registerNotificationCliPlugin({ plugins: [runtimeDir] }, { runtimeDir, options })
    expect(next.plugins.filter((entry) => entry === runtimeDir)).toHaveLength(0)
    expect(next.plugins).toContainEqual({ package: runtimeDir, options: { notification: options } })
  })

  test("#given an unconfigured profile #then nothing is registered and the builtin is untouched", () => {
    const config = { plugins: ["./plugins/keep.mjs"] }
    const next = registerNotificationCliPlugin(config, { runtimeDir, options: { configured: false, enabled: false } })
    expect(next.plugins).toEqual(["./plugins/keep.mjs"])
    expect(next.plugins).not.toContain(DISABLED_BUILTIN_NOTIFICATION)
  })

  test("#given a disabled profile #then a previous registration is removed and the builtin is re-enabled", () => {
    const registered = registerNotificationCliPlugin({ plugins: ["./plugins/keep.mjs"] }, { runtimeDir, options: { configured: true, enabled: true } })
    const disabled = registerNotificationCliPlugin(registered, { runtimeDir, options: { configured: true, enabled: false } })
    expect(disabled.plugins).toEqual(["./plugins/keep.mjs"])
    expect(disabled.plugins).not.toContain(DISABLED_BUILTIN_NOTIFICATION)
  })
})

describe("registerCompanionCliPlugin family identity", () => {
  const familyRoot = "/state/oh-my-rigel"
  const v1Runtime = `${familyRoot}/versions/1/runtime`
  const v2Runtime = `${familyRoot}/versions/2/runtime`
  const options = { configured: true, enabled: true }

  test("#given a version transition #then the family entry is replaced in place, not duplicated", () => {
    const installed = registerCompanionCliPlugin(
      { plugins: ["foreign-a.mjs", "foreign-b.mjs"] },
      { runtimeDir: v1Runtime, familyRoot, options, notificationEnabled: true },
    )
    const upgraded = registerCompanionCliPlugin(installed, { runtimeDir: v2Runtime, familyRoot, options, notificationEnabled: true })

    const family = upgraded.plugins.filter((entry) => typeof entry === "object" && entry.package.startsWith(familyRoot))
    expect(family).toHaveLength(1)
    expect(family[0].package).toBe(v2Runtime)
    // Foreign entries keep their position; the family entry keeps its slot.
    expect(upgraded.plugins[0]).toBe("foreign-a.mjs")
    expect(upgraded.plugins[1]).toBe("foreign-b.mjs")
  })

  test("#given a duplicated family entry #then only one survives", () => {
    const cli = { plugins: [{ package: v1Runtime, options: {} }, { package: v2Runtime, options: {} }, "keep.mjs"] }
    const next = registerCompanionCliPlugin(cli, { runtimeDir: v2Runtime, familyRoot, options, notificationEnabled: true })
    expect(next.plugins.filter((entry) => typeof entry === "object" && entry.package.startsWith(familyRoot))).toHaveLength(1)
    expect(next.plugins).toContain("keep.mjs")
  })

  test("#given the notification surface is disabled #then the builtin disable marker is absent", () => {
    const cli = registerCompanionCliPlugin({ plugins: [] }, { runtimeDir: v1Runtime, familyRoot, options: { configured: false, enabled: false }, notificationEnabled: false })
    expect(cli.plugins).not.toContain(DISABLED_BUILTIN_NOTIFICATION)
    expect(cli.plugins.filter((entry) => typeof entry === "object" && entry.package === v1Runtime)).toHaveLength(1)
  })

  test("#given repeated registration #then it is idempotent", () => {
    const once = registerCompanionCliPlugin({ plugins: ["keep.mjs"] }, { runtimeDir: v1Runtime, familyRoot, options, notificationEnabled: true })
    const twice = registerCompanionCliPlugin(once, { runtimeDir: v1Runtime, familyRoot, options, notificationEnabled: true })
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
  })
})

describe("removeRigelCliEntries", () => {
  const familyRoot = "/state/oh-my-rigel"

  test("#given family entries and the marker #then only foreign plugins remain", () => {
    const cli = {
      plugins: [
        "foreign.mjs",
        { package: `${familyRoot}/versions/1/runtime`, options: { notification: { enabled: true } } },
        DISABLED_BUILTIN_NOTIFICATION,
        { package: `${familyRoot}/versions/2/runtime`, options: {} },
      ],
    }
    const next = removeRigelCliEntries(cli, { familyRoot })
    expect(next.plugins).toEqual(["foreign.mjs"])
  })

  test("#given only foreign plugins #then nothing is removed", () => {
    const cli = { plugins: ["a.mjs", "b.mjs"] }
    expect(removeRigelCliEntries(cli, { familyRoot }).plugins).toEqual(["a.mjs", "b.mjs"])
  })
})

describe("Rigel ownership across state roots (single-runtime regression)", () => {
  test("#given a prior Rigel CLI registration under a DIFFERENT state root #then it is replaced, not left loadable, and unrelated plugins survive", () => {
    const root = mkdtempSync(join(tmpdir(), "rigel-crossroot-"))
    try {
      const staleRuntime = makeRigelRuntime(join(root, "state", "versions", "1", "runtime"))
      const currentRuntime = makeRigelRuntime(join(root, "data", "oh-my-rigel", "versions", "nls1", "runtime"))
      const cli = {
        plugins: [
          "unrelated-plugin.mjs",
          { package: staleRuntime, options: { notification: { enabled: true } } },
          { package: "/opt/other/plugin", options: { x: 1 } },
        ],
      }

      const next = registerCompanionCliPlugin(cli, {
        runtimeDir: currentRuntime,
        familyRoot: join(root, "data", "oh-my-rigel"),
      })

      const rigel = next.plugins.filter((entry) => typeof entry === "object" && isRigelRuntimeDir(entry.package))
      expect(rigel).toHaveLength(1)
      expect(rigel[0].package).toBe(currentRuntime)
      expect(next.plugins).toContain("unrelated-plugin.mjs")
      expect(next.plugins).toContainEqual({ package: "/opt/other/plugin", options: { x: 1 } })
      expect(next.plugins).not.toContainEqual({ package: staleRuntime, options: { notification: { enabled: true } } })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("#given a foreign plugin shaped like versions/<v>/runtime #then it is preserved", () => {
    const root = mkdtempSync(join(tmpdir(), "rigel-foreign-"))
    try {
      const foreign = makeForeignRuntime(join(root, "other", "versions", "9", "runtime"))
      const cli = { plugins: [{ package: foreign, options: {} }] }
      const next = registerCompanionCliPlugin(cli, { runtimeDir: join(root, "current", "runtime"), familyRoot: join(root, "current") })
      expect(next.plugins).toContainEqual({ package: foreign, options: {} })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("#given a stale Rigel server entry under another state root #then registerRuntimePluginEntry leaves exactly one current entry", () => {
    const root = mkdtempSync(join(tmpdir(), "rigel-server-crossroot-"))
    try {
      const staleRuntime = makeRigelRuntime(join(root, "state", "versions", "1", "runtime"))
      const currentRuntime = makeRigelRuntime(join(root, "data", "oh-my-rigel", "versions", "nls1", "runtime"))
      const next = registerRuntimePluginEntry([staleRuntime, "/opt/unrelated-plugin", currentRuntime], {
        runtimeDir: currentRuntime,
        familyRoot: join(root, "data", "oh-my-rigel"),
      })
      expect(next.filter((entry) => isRigelRuntimeDir(entry))).toEqual([currentRuntime])
      expect(next).toContain("/opt/unrelated-plugin")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("#given a Rigel CLI entry and the builtin marker #then removeRigelCliEntries leaves only foreign plugins", () => {
    const root = mkdtempSync(join(tmpdir(), "rigel-remove-"))
    try {
      const currentRuntime = makeRigelRuntime(join(root, "data", "oh-my-rigel", "versions", "nls1", "runtime"))
      const cli = { plugins: ["keep.mjs", { package: currentRuntime, options: {} }, DISABLED_BUILTIN_NOTIFICATION] }
      const next = removeRigelCliEntries(cli, { familyRoot: join(root, "data", "oh-my-rigel") })
      expect(next.plugins).toEqual(["keep.mjs"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
