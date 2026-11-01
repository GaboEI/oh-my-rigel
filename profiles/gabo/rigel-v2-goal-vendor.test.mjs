/**
 * Contract tests for the dark goal vendor (PR A).
 *
 * They guard a package/provenance contract, not prose: the pinned artifact's
 * integrity and identity, the closure's offline resolvability, the determinism
 * of the materialized tree, and the mutation sensitivity of every recorded
 * digest, license and notice entry.
 *
 * Temp trees live under the gitignored `.omo/` root because a materialization is
 * ~40 MB of extracted closure, which the OS temp directory cannot hold under the
 * per-user quota this repository is developed with.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { renderGoalVendorNotice, noticeHeadingFor } from "./goal-vendor-notice.mjs"
import { digestOfDirectory, digestOfEntries, extractEntries, sha256Hex, sha512Base64 } from "./goal-vendor-tarball.mjs"
import {
  GOAL_VENDOR_ARTIFACT,
  GOAL_VENDOR_CLOSURE,
  goalVendorDigestKey,
  goalVendorSourceDir,
  goalVendorTargetDir,
  materializeGoalVendor,
  verifyGoalVendor,
} from "./rigel-v2-goal-vendor.mjs"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const sourceDir = goalVendorSourceDir(repoRoot)
const temporaryRoot = fs.mkdtempSync(path.join(repoRoot, ".omo", "tmp-goal-vendor-tests-"))

afterAll(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
})

function copyVendor(name) {
  const target = path.join(temporaryRoot, name)
  fs.cpSync(sourceDir, target, { recursive: true })
  return target
}

function readPin(vendorDir = sourceDir) {
  return JSON.parse(fs.readFileSync(path.join(vendorDir, "pin.json"), "utf8"))
}

describe("#given the pinned goal artifact vendored in-tree", () => {
  describe("#when the vendored bytes are checked against the audited pin", () => {
    test("#then the tarball integrity, version, tag, commit and license match", () => {
      const tarball = fs.readFileSync(path.join(sourceDir, GOAL_VENDOR_ARTIFACT.tarball))
      expect(`sha512-${sha512Base64(tarball)}`).toBe(GOAL_VENDOR_ARTIFACT.distIntegrity)
      expect(sha256Hex(tarball)).toBe(GOAL_VENDOR_ARTIFACT.tarballSha256)

      const pin = readPin()
      expect(pin.artifact.version).toBe("0.1.91")
      expect(pin.artifact.tag).toBe("v0.1.91")
      expect(pin.artifact.commit).toBe("ccdd288fd595f41d1482e03088612b7eb7704cde")
      expect(pin.artifact.license).toBe("MIT")
      expect(pin.artifact.name).toBe("@prevalentware/opencode-goal-plugin")
    })

    test("#then every vendored closure tarball matches its recorded integrity", () => {
      const pin = readPin()
      for (const pinned of GOAL_VENDOR_CLOSURE) {
        const tarball = fs.readFileSync(path.join(sourceDir, pinned.tarball))
        expect(`${pinned.name} sha512-${sha512Base64(tarball)}`).toBe(`${pinned.name} ${pinned.integrity}`)
        const record = pin.closure.find((entry) => entry.name === pinned.name)
        expect(record.sha256).toBe(sha256Hex(tarball))
        expect(record.installPath).toBe(pinned.installPath)
      }
    })

    test("#then verification succeeds and reports the recorded tree digests", () => {
      const verified = verifyGoalVendor({ sourceDir })
      expect(verified.closure.length).toBe(GOAL_VENDOR_CLOSURE.length)
      expect(verified.digests.artifactTree).toBe(readPin().digests.artifactTree)
      expect(verified.digests.closureTree).toBe(readPin().digests.closureTree)
    })
  })

  describe("#when the attribution is inspected", () => {
    test("#then the shipped NOTICE carries one entry per vendored package and is regenerable", () => {
      const pin = readPin()
      const shipped = fs.readFileSync(path.join(sourceDir, "NOTICE"), "utf8")
      for (const attributed of [pin.artifact, ...pin.closure]) {
        expect(shipped).toContain(noticeHeadingFor(attributed))
      }
      expect(shipped).toBe(renderGoalVendorNotice(pin.artifact, pin.closure))
      expect(sha256Hex(Buffer.from(shipped, "utf8"))).toBe(pin.digests.notice)
    })

    test("#then the shipped LICENSE is the upstream MIT text byte-identical to the pinned tarball", () => {
      const artifactEntries = extractEntries(fs.readFileSync(path.join(sourceDir, GOAL_VENDOR_ARTIFACT.tarball)))
      const upstream = artifactEntries.find((entry) => entry.path === "LICENSE")
      const shipped = fs.readFileSync(path.join(sourceDir, "LICENSE"))
      expect(shipped.compare(upstream.bytes)).toBe(0)
      expect(shipped.toString("utf8")).toContain("MIT License")
    })
  })

  describe("#when the dark vendor is materialized", () => {
    test("#then a second materialization produces an identical tree digest (deterministic and idempotent)", () => {
      const first = materializeGoalVendor({ sourceRoot: repoRoot, runtimeDir: path.join(temporaryRoot, "runtime-a") })
      const second = materializeGoalVendor({ sourceRoot: repoRoot, runtimeDir: path.join(temporaryRoot, "runtime-b") })
      const repeated = materializeGoalVendor({ sourceRoot: repoRoot, runtimeDir: path.join(temporaryRoot, "runtime-a") })
      expect(fs.existsSync(first.engineEntry)).toBe(true)
      expect(fs.existsSync(first.tuiEntry)).toBe(true)
      expect(second.treeDigest).toBe(first.treeDigest)
      expect(repeated.treeDigest).toBe(first.treeDigest)
      expect(goalVendorDigestKey("1")).toBe("opencode-goal-plugin:1")
    })

    test("#then the plugin-owned dependency resolves its nested runtime closure from its own directory", () => {
      const runtimeDir = path.join(temporaryRoot, "runtime-closure")
      const vendor = path.join(goalVendorTargetDir(runtimeDir), "node_modules")
      materializeGoalVendor({ sourceRoot: repoRoot, runtimeDir })
      const insideEffect = createRequire(path.join(vendor, "effect-goal-state", "package.json"))
      for (const spec of ["fast-check", "pure-rand"]) {
        const resolved = insideEffect.resolve(spec)
        expect(resolved.startsWith(path.join(vendor, "effect-goal-state", "node_modules"))).toBe(true)
      }
    })

    test("#then materializing never modifies the vendored source tree", () => {
      // The acquisition form (tarballs + pin + NOTICE + LICENSE) is the source of
      // truth and must stay untouched by materialization: PR A's generation may not
      // dirty any surface it does not own.
      const before = digestOfDirectory(sourceDir)
      materializeGoalVendor({ sourceRoot: repoRoot, runtimeDir: path.join(temporaryRoot, "runtime-purity") })
      expect(digestOfDirectory(sourceDir)).toBe(before)
    })

    test("#then materializing in a networkless child process works and the artifact specifiers resolve", () => {
      const runtimeDir = path.join(temporaryRoot, "runtime-offline")
      const preload = path.join(repoRoot, "profiles/gabo/goal-vendor-offline-preload.mjs")
      const vendorModule = path.join(repoRoot, "profiles/gabo/rigel-v2-goal-vendor.mjs")
      const offline = spawnSync(
        process.execPath,
        ["--import", pathToFileURL(preload).href, vendorModule, "materialize", "--out", runtimeDir],
        { cwd: repoRoot, encoding: "utf8", timeout: 240_000 },
      )
      expect(offline.status, `offline materialize failed: ${offline.stderr || offline.stdout}`).toBe(0)
      const digest = JSON.parse(offline.stdout.trim()).treeDigest
      expect(typeof digest).toBe("string")

      const probe = path.join(temporaryRoot, "resolve-probe.mjs")
      fs.writeFileSync(
        probe,
        [
          'import { createRequire } from "node:module"',
          'import path from "node:path"',
          "const artifactDir = process.argv[2]",
          'const require = createRequire(path.join(artifactDir, "package.json"))',
          'const resolved = Object.fromEntries(["zod", "effect-goal-state", "@opentui/solid", "solid-js"].map((spec) => { try { return [spec, require.resolve(spec)] } catch (error) { return [spec, `UNRESOLVED ${error.code ?? error.message}`] } }))',
          "console.log(JSON.stringify(resolved))",
        ].join("\n"),
      )
      const artifactDir = path.join(goalVendorTargetDir(runtimeDir), "node_modules", "@prevalentware", "opencode-goal-plugin")
      const resolved = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, probe, artifactDir], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 60_000,
      })
      expect(resolved.status, `offline resolution failed: ${resolved.stderr}`).toBe(0)
      for (const target of Object.values(JSON.parse(resolved.stdout.trim()))) {
        expect(target.startsWith("UNRESOLVED")).toBe(false)
      }
    })
  })

  describe("#when a recorded byte, entry or field is mutated", () => {
    test("#then altering one byte of the vendored artifact fails verification", () => {
      const vendorDir = copyVendor("mutant-artifact")
      const tarball = path.join(vendorDir, GOAL_VENDOR_ARTIFACT.tarball)
      const bytes = fs.readFileSync(tarball)
      bytes[Math.floor(bytes.length / 2)] ^= 0xff
      fs.writeFileSync(tarball, bytes)
      expect(() => verifyGoalVendor({ sourceDir: vendorDir })).toThrow(/integrity/)
    })

    test("#then removing the NOTICE attribution of one package fails verification", () => {
      const vendorDir = copyVendor("mutant-notice")
      const noticePath = path.join(vendorDir, "NOTICE")
      const notice = fs.readFileSync(noticePath, "utf8")
      fs.writeFileSync(noticePath, notice.replace(noticeHeadingFor({ name: "zod", version: "4.6.7" }), "## zod removed"))
      expect(() => verifyGoalVendor({ sourceDir: vendorDir })).toThrow(/NOTICE/)
    })

    test("#then altering the recorded version or integrity fails verification", () => {
      const versionDir = copyVendor("mutant-version")
      const versionPin = readPin(versionDir)
      versionPin.artifact.version = "0.1.61"
      fs.writeFileSync(path.join(versionDir, "pin.json"), `${JSON.stringify(versionPin, null, 2)}\n`)
      expect(() => verifyGoalVendor({ sourceDir: versionDir })).toThrow(/version/)

      const integrityDir = copyVendor("mutant-integrity")
      const integrityPin = readPin(integrityDir)
      integrityPin.closure = integrityPin.closure.map((entry) =>
        entry.name === "solid-js" ? { ...entry, integrity: GOAL_VENDOR_CLOSURE[0].integrity } : entry,
      )
      fs.writeFileSync(path.join(integrityDir, "pin.json"), `${JSON.stringify(integrityPin, null, 2)}\n`)
      expect(() => verifyGoalVendor({ sourceDir: integrityDir })).toThrow(/integrity/)
    })
  })
})

describe("#given the vendor tree digest helper", () => {
  test("#when a pinned tarball is read #then entries come back in a deterministic sorted order", () => {
    const entries = extractEntries(fs.readFileSync(path.join(sourceDir, GOAL_VENDOR_ARTIFACT.tarball)))
    const paths = entries.map((entry) => entry.path)
    expect(paths).toEqual([...paths].sort())
    expect(digestOfEntries(entries)).toBe(readPin().digests.artifactTree)
  })

  test("#when a tarball escapes its archive root #then the reader fails instead of writing outside", () => {
    const artifactBytes = fs.readFileSync(path.join(sourceDir, GOAL_VENDOR_ARTIFACT.tarball))
    expect(() => extractEntries(artifactBytes, { strip: "another-root/" })).toThrow(/outside the required archive root/)
  })
})
