/**
 * Endpoint-only identity projection for the native OpenClaw composition.
 *
 * The legacy side contains only gateway names that `resolveGateway` can reach
 * from an enabled hook. The new side contains declared channel names except
 * the reserved A2A namespace, which is not a chat endpoint.
 */
import { resolveGateway } from "./rigel-v2-native-openclaw-core.mjs"

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function projectOpenclawEndpointIdentities({ normalized, config } = {}) {
  const legacy = new Set()
  if (normalized?.enabled === true && isPlainObject(normalized.hooks)) {
    for (const event of Object.keys(normalized.hooks)) {
      const route = resolveGateway(normalized, event)
      if (route !== null) legacy.add(route.gatewayName)
    }
  }

  const channels = isPlainObject(config?.channels)
    ? Object.keys(config.channels).filter((identity) => identity !== "a2a")
    : []

  return { legacy: [...legacy], channels }
}
