import { describe, expect, test } from "bun:test"
import { MIN_OPENCODE_VERSION } from "./doctor/framework/constants"
import { getUnsupportedOpenCodeVersionMessage } from "./minimum-opencode-version"

describe("minimum OpenCode version", () => {
  describe("#given the declared installer floor", () => {
    test("#when the constant is read #then it is the OpenCode V2 floor and doctor derives the same value", () => {
      // given the floor the installer refuses below
      // when the shared constant and the doctor constant are compared
      // then both copies agree on the V2 line
      expect(MIN_OPENCODE_VERSION).toBe("2.0.19")
    })
  })

  describe("#given an OpenCode V2 host", () => {
    test("#when the host is at the floor or above #then the installer emits no unsupported-version message", () => {
      // given V2 hosts at and above the floor
      // when each is checked
      // then none is refused
      for (const version of ["2.0.19", "2.0.20", "2.1.0", "v2.0.19"]) {
        expect(getUnsupportedOpenCodeVersionMessage(version)).toBeNull()
      }
    })
  })

  describe("#given a pre-V2 or below-floor host", () => {
    test("#when the host is a V1 version #then the message refuses it and names the V2 floor", () => {
      // given a detected V1 host
      // when the version is checked
      // then a refusal is returned that names 2.0.19 as the requirement
      const message = getUnsupportedOpenCodeVersionMessage("1.4.0")

      expect(message).not.toBeNull()
      expect(message).toContain("Detected OpenCode 1.4.0")
      expect(message).toContain(`${MIN_OPENCODE_VERSION}+`)
      expect(message).toContain("V2")
      expect(message).not.toContain("1.4.0+ is required")
    })

    test("#when the host sits one patch below the floor #then it is refused too", () => {
      // given a host below the floor but inside the V2 line
      // when the version is checked
      // then it is still refused
      expect(getUnsupportedOpenCodeVersionMessage("2.0.18")).toContain("2.0.18")
    })
  })

  describe("#given an undetectable host", () => {
    test("#when no version is published #then the check degrades to no message", () => {
      // given the host reports no version
      // when the version is checked
      // then nothing is refused
      expect(getUnsupportedOpenCodeVersionMessage(null)).toBeNull()
    })
  })
})
