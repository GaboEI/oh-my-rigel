import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"

// Root-package metadata independence gate (contract phase P3, worktree p3-metadata-omr).
//
// The root package.json carries the published npm metadata. OMR keeps the inherited npm
// identity (the `name`) and the upstream Sustainable Use License, but the project-identity
// fields must point at OMR - `GaboEI/oh-my-rigel` and https://omr.gabodev.dev - so npm and
// registry consumers reach the fork instead of the parent project. Only these machine-consumed
// fields are asserted; the version is set by the release flow, and the bin map is covered by
// bin-map.test.ts. Contract protected: package metadata + release identity. Evidence:
// .omo/evidence/20261011-p3-metadata-omr/ (local, gitignored).

const manifestPath = resolve(import.meta.dir, "..", "package.json")
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  name: string
  license?: string
  author?: string
  repository?: { type?: string; url?: string }
  bugs?: { url?: string }
  homepage?: string
}

const OMR_AUTHOR = "GaboEI"
const OMR_REPOSITORY_URL = "git+https://github.com/GaboEI/oh-my-rigel.git"
const OMR_ISSUES_URL = "https://github.com/GaboEI/oh-my-rigel/issues"
const OMR_HOMEPAGE = "https://omr.gabodev.dev"

describe("#given the root package.json #when the P3 metadata independence gate is checked", () => {
  test("#given the project-identity fields #when read #then they identify Oh My Rigel", () => {
    // given / when / then
    expect(manifest.author).toBe(OMR_AUTHOR)
    expect(manifest.repository?.url).toBe(OMR_REPOSITORY_URL)
    expect(manifest.bugs?.url).toBe(OMR_ISSUES_URL)
    expect(manifest.homepage).toBe(OMR_HOMEPAGE)
  })

  test("#given the preserved identity #when read #then the npm name and inherited license are unchanged", () => {
    // given / when / then
    expect(manifest.name).toBe("oh-my-opencode")
    expect(manifest.license).toBe("SUL-1.0")
  })
})
