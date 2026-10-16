/**
 * Oh My Rigel legacy plugin-name notice, V2 companion CLI plugin surface.
 *
 * V1 owner: packages/omo-opencode/src/hooks/legacy-plugin-toast/hook.ts
 *
 * V2 contract: the host config is normalised IN MEMORY and MUST NOT be
 * rewritten. This surface therefore never touches a config file - it reads the
 * already-loaded in-memory config, detects a legacy `oh-my-opencode` entry, and
 * shows the rename toast once per process. It records a durable receipt under
 * `$XDG_STATE_HOME/oh-my-rigel/legacy-plugin-notice.json` as evidence, but the
 * receipt is never used to suppress a later process (matching V1's per-process
 * `fired` guard).
 *
 * Effect mapping, V1 -> V2 CLI context:
 *   event.type === "session.created"          -> context.data.on("session.created", handler)
 *   props.info.parentID                       -> context.data.session.get(sessionID)?.parentID
 *   ctx.client.tui.showToast({ body })        -> context.ui.toast.show({ title, message, variant, duration })
 *   checkForLegacyPluginEntry() reads disk    -> detectLegacyPluginEntry(in-memory config)
 *   autoMigrateLegacyPluginEntry()            -> REMOVED (config is never rewritten)
 *
 * Zero side effects when the surface is not enabled or the host UI is absent:
 * `setup` returns `undefined` and registers nothing and writes nothing. Every
 * effect is contained and logged; a failure never throws into the host.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import {
  LEGACY_NOTICE_DURATION,
  LEGACY_NOTICE_MESSAGE,
  LEGACY_NOTICE_TITLE,
  LEGACY_NOTICE_VARIANT,
  detectLegacyPluginEntry,
} from "./rigel-v2-native-legacy-plugin-notice.mjs"
import { extractSessionID } from "./rigel-v2-native-notification-core.mjs"

export const LEGACY_NOTICE_PLUGIN_ID = "oh-my-rigel.legacy-plugin-notice"

/** Receipt filename under `$XDG_STATE_HOME/oh-my-rigel/`. */
export const LEGACY_NOTICE_RECEIPT_FILE = "legacy-plugin-notice.json"

/** Resolve the durable receipt path (`$XDG_STATE_HOME/oh-my-rigel/legacy-plugin-notice.json`). */
export function resolveLegacyNoticeReceiptPath({ env = {}, home } = {}) {
  const stateHome =
    typeof env.XDG_STATE_HOME === "string" && env.XDG_STATE_HOME.length > 0
      ? env.XDG_STATE_HOME
      : join(typeof home === "string" && home.length > 0 ? home : homedir(), ".local", "state")
  return join(stateHome, "oh-my-rigel", LEGACY_NOTICE_RECEIPT_FILE)
}

/**
 * The V1 warning was always on unless the hook was disabled. In V2 the
 * companion CLI plugin carries its own options, so the rule is: absent plugin
 * options means inert (the companion was never enabled); a loaded companion
 * with no explicit kill switch is active; an explicit `enabled: false`
 * disables it.
 */
function resolveLegacyNoticeGate(options) {
  if (options === undefined || options === null || typeof options !== "object") return false
  const block = options.legacyPluginNotice
  if (block === undefined || block === null || typeof block !== "object") return true
  return block.enabled !== false
}

function resolveLogPath(overrides, contextOptions) {
  if (typeof overrides?.logFile === "string" && overrides.logFile.length > 0) return overrides.logFile
  if (typeof contextOptions?.logFile === "string" && contextOptions.logFile.length > 0) return contextOptions.logFile
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(base, "oh-my-rigel", "legacy-plugin-notice.log")
}

function createLogger(logPath) {
  let active = true
  return {
    log(entry) {
      if (!active) return
      try {
        mkdirSync(dirname(logPath), { recursive: true })
        appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf-8")
      } catch {
        active = false
      }
    },
  }
}

/** The in-memory host config: injected first, then the V2 context shapes. */
function resolveConfig(context, overrides) {
  if (overrides?.config !== undefined) return overrides.config
  const candidates = [context?.state?.config, context?.config, context?.options?.config]
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") return candidate
  }
  return undefined
}

function readSession(api, sessionID) {
  try {
    return api?.data?.session?.get?.(sessionID)
  } catch {
    return undefined
  }
}

function writeReceipt(receiptPath, entries, at, logger) {
  try {
    mkdirSync(dirname(receiptPath), { recursive: true })
    writeFileSync(
      receiptPath,
      `${JSON.stringify({ schemaVersion: 1, notifiedAt: at, entries }, null, 2)}\n`,
      { mode: 0o600 },
    )
  } catch (error) {
    logger.log({ event: "receipt-write-failed", error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Build the legacy-notice CLI plugin surface. Tests drive `setup` with a fake
 * context; the default export wires `setup` for the host.
 */
export function createLegacyNoticeCliSurface(overrides = {}) {
  return {
    id: LEGACY_NOTICE_PLUGIN_ID,
    setup(context) {
      if (!resolveLegacyNoticeGate(context?.options ?? overrides.options)) return undefined

      const renderer = context?.renderer
      if (!renderer || renderer.isDestroyed === true) return undefined

      const toastSurface = context?.ui?.toast
      if (!toastSurface) return undefined
      const hasToast =
        (typeof toastSurface === "object" && typeof toastSurface.show === "function") || typeof toastSurface === "function"
      if (!hasToast) return undefined

      if (typeof context?.data?.on !== "function") return undefined

      const logger = createLogger(resolveLogPath(overrides, context?.options))
      const now = typeof overrides.now === "function" ? overrides.now : () => Date.now()
      const receiptPath =
        overrides.receiptPath ?? resolveLegacyNoticeReceiptPath({ env: process.env, home: overrides.home ?? homedir() })
      let fired = false

      // Report the rename notice for a legacy `oh-my-opencode` entry in the given
      // in-memory config. Consumes the per-process slot only when a legacy entry is
      // actually reported (the late path sets its once-guard separately first).
      const notifyLegacyFromConfig = (config, at) => {
        const result = detectLegacyPluginEntry(config)
        if (!result.legacy) return false
        const toast = {
          title: LEGACY_NOTICE_TITLE,
          message: LEGACY_NOTICE_MESSAGE,
          variant: LEGACY_NOTICE_VARIANT,
          duration: LEGACY_NOTICE_DURATION,
        }
        if (typeof toastSurface === "function") toastSurface(toast)
        else toastSurface.show(toast)
        writeReceipt(receiptPath, result.entries, now(), logger)
        logger.log({ event: "legacy-notice", entries: result.entries, at })
        fired = true
        return true
      }

      // Early detection: when the surface loads with the in-memory config already
      // available, warn BEFORE the `session.created` edge, so a legacy remnant is
      // reported before it can influence startup. A miss here does NOT consume the
      // once-guard, so the session.created path still fires when the config only
      // becomes available later.
      const earlyConfig = resolveConfig(context, overrides)
      if (earlyConfig !== undefined) {
        try {
          notifyLegacyFromConfig(earlyConfig, "setup")
        } catch (error) {
          logger.log({ event: "legacy-notice-failed", error: error instanceof Error ? error.message : String(error) })
        }
      }

      const onSessionCreated = (event) => {
        try {
          if (fired) return

          const sessionID = extractSessionID(event)
          const session = sessionID ? readSession(context, sessionID) : undefined
          // Root sessions only: a subagent session carries a parentID.
          if (session !== undefined && session !== null && session.parentID !== undefined && session.parentID !== null) {
            return
          }

          // V1 sets its once-guard before the detection result, so a miss still
          // consumes the per-process slot.
          fired = true

          notifyLegacyFromConfig(resolveConfig(context, overrides), "session.created")
        } catch (error) {
          logger.log({ event: "legacy-notice-failed", error: error instanceof Error ? error.message : String(error) })
        }
      }

      let dispose
      try {
        dispose = context.data.on("session.created", onSessionCreated)
      } catch (error) {
        logger.log({ event: "subscribe-failed", error: error instanceof Error ? error.message : String(error) })
        return undefined
      }

      return () => {
        try {
          if (typeof dispose === "function") dispose()
        } catch (error) {
          logger.log({ event: "dispose-failed", error: error instanceof Error ? error.message : String(error) })
        }
      }
    },
  }
}

export default createLegacyNoticeCliSurface()
