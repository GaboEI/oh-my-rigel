/**
 * Native V2 OpenClaw transports: the two outbound delivery mechanisms V1 owned.
 * Ported from `packages/openclaw-core/src/dispatcher.ts`.
 *
 * Only Node built-ins are imported so the flat laboratory runtime (no
 * `node_modules`) can load this module. Both transports take their side-effect
 * dependencies (`fetchImpl`, `spawnImpl`, `env`) as parameters so a unit test can
 * drive them without a real network or process.
 */
import { spawn as nodeSpawn } from "node:child_process"
import {
  DEFAULT_HTTP_TIMEOUT_MS,
  interpolateCommand,
  parseWakeMetadata,
  resolveCommandTimeoutMs,
  validateGatewayUrl,
} from "./rigel-v2-native-openclaw-core.mjs"
import {
  deliverDiscordNotification,
  deliverTelegramNotification,
  notificationEnvelope,
} from "./rigel-v2-native-openclaw-notification.mjs"

/** Terminate a command transport process, preferring its process group on unix. */
export function terminateCommandProcess(proc, signal = "SIGKILL", platform = process.platform) {
  if (!proc || typeof proc.kill !== "function") return
  if (platform !== "win32" && typeof proc.pid === "number" && proc.pid > 0) {
    try {
      process.kill(-proc.pid, signal)
      return
    } catch {
      // process group already gone: fall back to the direct kill
    }
  }
  try {
    proc.kill(signal)
  } catch {
    // already exited
  }
}

/**
 * Port of `wakeGateway`. A non-valid URL fails without a request; a non-2xx
 * response fails with `HTTP <status>`; a 2xx response is parsed for correlation
 * metadata. Single attempt, no retry (V1 parity). `timeout` defaults to 10000.
 */
export async function wakeGateway({ gatewayName, gateway, payload, fetchImpl = globalThis.fetch, timeoutMs } = {}) {
  const name = gatewayName
  if (typeof gateway?.url !== "string" || !validateGatewayUrl(gateway.url)) {
    return { gateway: name, success: false, error: "Invalid URL (HTTPS required)" }
  }
  const headers = { "Content-Type": "application/json", ...(gateway.headers ?? {}) }
  const timeout = Number.isFinite(timeoutMs) ? timeoutMs : Number.isFinite(gateway.timeout) ? gateway.timeout : DEFAULT_HTTP_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetchImpl(gateway.url, {
      method: typeof gateway.method === "string" && gateway.method.length > 0 ? gateway.method : "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!response.ok) {
      return { gateway: name, success: false, error: `HTTP ${response.status}`, statusCode: response.status }
    }
    const metadata = parseWakeMetadata(await response.text())
    return { gateway: name, success: true, statusCode: response.status, ...metadata }
  } catch (error) {
    const aborted = error instanceof Error && (error.name === "AbortError" || controller.signal.aborted)
    return { gateway: name, success: false, error: aborted ? "Request timed out" : error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Port of `wakeCommandGateway`. The command is interpolated with shell-escaped
 * variables (undefined placeholders stay literal), run through `sh -c` with the
 * inherited environment, and killed as a group on timeout. Exit code 0 is
 * success; stdout is parsed for correlation metadata.
 */
export async function wakeCommandGateway({
  gatewayName,
  gateway,
  variables,
  spawnImpl = nodeSpawn,
  env = process.env,
  platform = process.platform,
  commandTimeoutEnv,
} = {}) {
  const name = gatewayName
  if (typeof gateway?.command !== "string" || gateway.command.length === 0) {
    return { gateway: name, success: false, error: "No command configured" }
  }
  const timeout = resolveCommandTimeoutMs(gateway.timeout, commandTimeoutEnv)
  const interpolated = interpolateCommand(gateway.command, variables)
  try {
    const proc = spawnImpl(["sh", "-c", interpolated], {
      env,
      stdout: "pipe",
      stderr: "ignore",
      detached: platform !== "win32",
    })
    const stdoutPromise = new Response(proc.stdout).text()
    const outcome = await Promise.race([
      proc.exited.then((exitCode) => ({ kind: "exit", exitCode })),
      new Promise((resolve) => {
        setTimeout(() => {
          terminateCommandProcess(proc, "SIGKILL", platform)
          resolve({ kind: "timeout" })
        }, timeout)
      }),
    ])
    if (outcome.kind === "timeout") throw new Error("Command timed out")
    if (outcome.exitCode !== 0) throw new Error(`Command exited with code ${outcome.exitCode}`)
    const stdout = await stdoutPromise
    return { gateway: name, success: true, ...parseWakeMetadata(stdout) }
  } catch (error) {
    return { gateway: name, success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Which transport an endpoint selects.
 *
 * `http` is the default, exactly as `resolveGateway` has always coerced it, so
 * an endpoint that names nothing new keeps the legacy HTTP behaviour. The two
 * notification transports are only reachable from the new `channels.<name>`
 * namespace: the legacy adapter never produces those types (§5.2 rule 5).
 */
export function resolveGatewayTransport(gateway) {
  if (gateway?.type === "command") return "command"
  if (gateway?.type === "discord") return "discord"
  if (gateway?.type === "telegram") return "telegram"
  return "http"
}

/**
 * Dispatch one resolved endpoint.
 *
 * A command transport receives the interpolation variables; HTTP receives the
 * payload; a notification transport receives the message text and returns the
 * §1 receipt, which is composed into the envelope this function has always
 * returned so reporting and correlation keep their shape.
 */
export function dispatchGateway({ gatewayName, gateway, payload, variables, message, fetchImpl, spawnImpl, env, platform, commandTimeoutEnv, timeoutMs } = {}) {
  const transport = resolveGatewayTransport(gateway)
  if (transport === "command") {
    return wakeCommandGateway({ gatewayName, gateway, variables, spawnImpl, env, platform, commandTimeoutEnv })
  }
  if (transport === "discord") {
    return deliverDiscordNotification({ gatewayName, gateway, message, fetchImpl, env, timeoutMs })
      .then((receipt) => notificationEnvelope(gatewayName, receipt))
  }
  if (transport === "telegram") {
    return deliverTelegramNotification({ gatewayName, gateway, message, fetchImpl, env, timeoutMs })
      .then((receipt) => notificationEnvelope(gatewayName, receipt))
  }
  return wakeGateway({ gatewayName, gateway, payload, fetchImpl })
}
