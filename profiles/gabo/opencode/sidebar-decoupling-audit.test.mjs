import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Decoupling audit for the retired native V2 sidebar.
 *
 * Gabo's decision (2026-10-14) is a full withdrawal, not a quarantine: the
 * dormant sidebar surface and its pure core are deleted, and the composed
 * `./tui` entry no longer wires any sidebar surface. The future sidebar will be
 * rewritten from scratch and will not reuse the retired modules.
 *
 * This guards the three decoupling invariants a later edit could silently undo:
 * no `rigel-v2-*sidebar*.mjs` module survives under `opencode/`, the compositor
 * carries neither the retired symbol nor the retired module specifier, and the
 * compositor still composes exactly the five protected surfaces in their
 * protected order.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const COMPOSITOR = "rigel-v2-native-cli.mjs"
const compositorSource = fs.readFileSync(path.join(HERE, COMPOSITOR), "utf8")

// The five surfaces the composed `./tui` entry must keep, in composition order.
const PROTECTED_SURFACES = [
  "createNotificationPlugin",
  "createLegacyNoticeCliSurface",
  "createNudgeCliSurface",
  "createTaskToastCliSurface",
  "createBtwCliSurface",
]

// Name-based on purpose: it must never match `rigel-v2-native.mjs`, whose
// protected comment mentions `cli-sidebar` without naming a sidebar module.
const RETIRED_MODULE = /^rigel-v2-.*sidebar.*\.mjs$/

function filesUnder(directory) {
  const found = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) found.push(...filesUnder(absolute))
    else if (entry.isFile()) found.push(absolute)
  }
  return found
}

// Reads the factory calls inside the compositor's `surfaces` array, in order.
function composedSurfaceFactories(source) {
  const marker = "const surfaces = ["
  const start = source.indexOf(marker)
  if (start === -1) throw new Error("compositor has no `surfaces` array")
  const open = source.indexOf("[", start)
  let depth = 0
  let end = -1
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "[") depth += 1
    else if (source[index] === "]") {
      depth -= 1
      if (depth === 0) {
        end = index
        break
      }
    }
  }
  if (end === -1) throw new Error("unbalanced `surfaces` array")
  return [...source.slice(open + 1, end).matchAll(/([A-Za-z_$][\w$]*)\(/g)].map((match) => match[1])
}

describe("native sidebar decoupling audit", () => {
  describe("#given the retired native V2 sidebar", () => {
    test("#then no rigel-v2-*sidebar*.mjs module survives under profiles/gabo/opencode", () => {
      const modules = filesUnder(HERE)
        .map((file) => path.basename(file))
        .filter((name) => RETIRED_MODULE.test(name))
      expect(modules).toEqual([])
    })

    test("#then the compositor carries neither the retired symbol nor the retired module specifier", () => {
      expect(compositorSource).not.toContain("createSidebarCliSurface")
      expect(compositorSource).not.toContain("rigel-v2-native-cli-sidebar")
    })
  })

  describe("#given the composed ./tui entry", () => {
    test("#then it composes exactly the five protected surfaces in order", () => {
      expect(composedSurfaceFactories(compositorSource)).toEqual(PROTECTED_SURFACES)
    })
  })
})
