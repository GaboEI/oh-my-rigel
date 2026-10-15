/**
 * C1 parity contract: `rigel-v2-ast-grep-runtime.mjs` is a deliberate copy of the
 * ast-grep pieces the shipped `profiles/gabo` tree needs from `packages/utils`.
 * This test pins the two surfaces together so the pinned manifest or the slug
 * rules cannot drift silently - it guards the cross-package duplication contract
 * (the shipped tree is standalone; the source of truth stays in `packages/utils`).
 */
import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import {
  SG_PINNED_VERSION as SRC_VERSION,
  SG_RELEASE_ASSETS as SRC_ASSETS,
  astGrepRuntimeDir as srcRuntimeDir,
  normalizeRuntimeArch as srcArch,
  normalizeRuntimePlatform as srcPlatform,
  runtimeSlug as srcSlug,
  sgBinaryName as srcBinaryName,
} from "@oh-my-opencode/utils"
import {
  SG_PINNED_VERSION,
  SG_RELEASE_ASSETS,
  astGrepRuntimeDir,
  normalizeRuntimeArch,
  normalizeRuntimePlatform,
  runtimeSlug,
  sgBinaryName,
} from "./rigel-v2-ast-grep-runtime.mjs"

const MATRIX = [
  ["linux", "x64"],
  ["linux", "arm64"],
  ["darwin", "x64"],
  ["darwin", "arm64"],
  ["win32", "x64"],
  ["win32", "arm64"],
  ["freebsd", "ia32"],
  ["freebsd", "arm64"],
  ["sunos", "aarch64"],
]

describe("#given the ast-grep runtime vendored under profiles/gabo", () => {
  test("#when compared to packages/utils #then the pin, the manifest, and the slug rules are identical", () => {
    expect(SG_PINNED_VERSION).toBe(SRC_VERSION)
    expect(SG_RELEASE_ASSETS).toEqual(SRC_ASSETS)
    for (const [platform, arch] of MATRIX) {
      expect(normalizeRuntimePlatform(platform)).toBe(srcPlatform(platform))
      expect(normalizeRuntimeArch(arch)).toBe(srcArch(arch))
      expect(runtimeSlug(platform, arch)).toBe(srcSlug(platform, arch))
      expect(sgBinaryName(platform)).toBe(srcBinaryName(platform))
      expect(astGrepRuntimeDir(join("/base", ".omo"), platform, arch)).toBe(srcRuntimeDir(join("/base", ".omo"), platform, arch))
    }
  })
})
