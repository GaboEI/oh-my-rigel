import { describe, expect, test } from "bun:test"

import * as target from "./rigel-v2-service-target.mjs"

// Row 55, stage C support. The plugin runs inside the `opencode serve
// --service` daemon, and the V2 plugin API exposes no server URL, so the
// runtime had to pass `undefined` and the health probe failed closed. The
// daemon's own registration file is the only V2 channel that carries the
// target, and it also carries the server credential, so the reader must be
// strict: it may only ever hand out a LOOPBACK target.
//
// Contract: absent/unreadable/malformed registration yields no target; a
// non-loopback host yields no target, so the credential can never be sent to a
// remote host; the credential is exposed only for environment injection.

function memoryFileSystem(files) {
  const entries = new Map(Object.entries(files))
  return {
    existsSync: (path) => entries.has(path),
    readFileSync: (path) => {
      const value = entries.get(path)
      if (value === undefined) throw new Error(`ENOENT: ${path}`)
      return value
    },
  }
}

const HOME = "/home/rigeltest"
const ENV = { HOME }
const SERVICE = `${HOME}/.local/state/opencode/service.json`

function registration(overrides) {
  return memoryFileSystem({
    [SERVICE]: JSON.stringify({ id: "svc", version: "2.0.32", url: "http://127.0.0.1:49374", pid: 1, password: "s3cret", ...overrides }),
  })
}

describe("V2 service target resolution", () => {
  test("#given the daemon registration exists #when resolved #then the loopback url and credential are returned", () => {
    expect(target.resolveServiceTarget({ env: ENV, fileSystem: registration({}) })).toEqual({
      url: "http://127.0.0.1:49374",
      password: "s3cret",
    })
  })

  test("#given no registration file #when resolved #then there is no target", () => {
    expect(target.resolveServiceTarget({ env: ENV, fileSystem: memoryFileSystem({}) })).toBeNull()
  })

  test("#given a malformed registration #when resolved #then there is no target", () => {
    const broken = memoryFileSystem({ [SERVICE]: "{not json" })
    expect(target.resolveServiceTarget({ env: ENV, fileSystem: broken })).toBeNull()
  })

  test("#given a registration pointing at a remote host #when resolved #then no target is returned so the credential cannot leak", () => {
    expect(target.resolveServiceTarget({ env: ENV, fileSystem: registration({ url: "https://evil.example.com" }) })).toBeNull()
    expect(target.resolveServiceTarget({ env: ENV, fileSystem: registration({ url: "http://10.0.0.5:49374" }) })).toBeNull()
  })

  test("#given a registration without a credential #when resolved #then only the url is returned", () => {
    const fileSystem = memoryFileSystem({ [SERVICE]: JSON.stringify({ url: "http://localhost:1234" }) })
    expect(target.resolveServiceTarget({ env: ENV, fileSystem })).toEqual({ url: "http://localhost:1234" })
  })

  test("#given an explicit XDG_STATE_HOME #when resolved #then that state root is used", () => {
    const env = { HOME, XDG_STATE_HOME: "/tmp/rigel-state" }
    const fileSystem = memoryFileSystem({ "/tmp/rigel-state/opencode/service.json": JSON.stringify({ url: "http://127.0.0.1:1" }) })
    expect(target.resolveServiceTarget({ env, fileSystem })).toEqual({ url: "http://127.0.0.1:1" })
  })

  test("#given no home and no state override #when resolved #then no path is invented", () => {
    expect(target.resolveServiceStatePath({ env: {} })).toBeNull()
    expect(target.resolveServiceTarget({ env: {}, fileSystem: memoryFileSystem({}) })).toBeNull()
  })
})
