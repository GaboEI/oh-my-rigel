import { MIN_OPENCODE_VERSION } from "./doctor/framework/constants"
import { compareVersions } from "../shared/opencode-version"

export function getUnsupportedOpenCodeVersionMessage(openCodeVersion: string | null): string | null {
  if (!openCodeVersion) {
    return null
  }

  if (compareVersions(openCodeVersion, MIN_OPENCODE_VERSION) >= 0) {
    return null
  }

  return `Detected OpenCode ${openCodeVersion}, but this build requires OpenCode ${MIN_OPENCODE_VERSION}+ (V2). Upgrade OpenCode to ${MIN_OPENCODE_VERSION} or newer, then rerun the installer.`
}
