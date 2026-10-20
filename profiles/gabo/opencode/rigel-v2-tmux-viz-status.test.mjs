import { describe, expect, test } from "bun:test"
import {
  createSessionStatusReader,
  normalizeStatusValue,
  resolveSessionStatus,
} from "./rigel-v2-tmux-viz-status.mjs"

describe("tmux-viz status value normalization", () => {
  test("a string status is trimmed and lowercased", () => {
    expect(normalizeStatusValue("Busy")).toBe("busy")
    expect(normalizeStatusValue("  IDLE  ")).toBe("idle")
  })

  test("a record status is read from type, status or state", () => {
    expect(normalizeStatusValue({ type: "running" })).toBe("running")
    expect(normalizeStatusValue({ status: "idle" })).toBe("idle")
    expect(normalizeStatusValue({ state: "retry" })).toBe("retry")
  })

  test("anything that is not a status reads as no token", () => {
    expect(normalizeStatusValue("")).toBeUndefined()
    expect(normalizeStatusValue("   ")).toBeUndefined()
    expect(normalizeStatusValue({})).toBeUndefined()
    expect(normalizeStatusValue({ type: 7 })).toBeUndefined()
    expect(normalizeStatusValue(null)).toBeUndefined()
    expect(normalizeStatusValue(undefined)).toBeUndefined()
    expect(normalizeStatusValue(42)).toBeUndefined()
    expect(normalizeStatusValue(["busy"])).toBeUndefined()
  })
})

describe("tmux-viz per-session status resolution", () => {
  test("an aggregate Map that carries this session is a VALUE", async () => {
    const fetchSessionStatus = async () => new Map([["ses_1", "busy"]])
    expect(await resolveSessionStatus(fetchSessionStatus, "ses_1")).toEqual({ kind: "value", status: "busy" })
  })

  test("an aggregate Map WITHOUT this session is ABSENT, not a value", async () => {
    const fetchSessionStatus = async () => new Map([["ses_other", "busy"]])
    expect(await resolveSessionStatus(fetchSessionStatus, "ses_1")).toEqual({ kind: "absent" })
  })

  test("RETEST-4 replay: the empty aggregate output is ABSENT, never observability", async () => {
    // given: the exact pre-fix seam output - the argument-less aggregate call a
    // per-session host answers with nothing, so the manager always saw an empty
    // container and read its non-nullness as a live signal
    const fetchSessionStatus = async () => new Map()
    // when
    const result = await resolveSessionStatus(fetchSessionStatus, "ses_1")
    // then
    expect(result.kind).toBe("absent")
    expect(result.status).toBeUndefined()
  })

  test("a per-session accessor reports a value only for the session it is asked about", async () => {
    const fetchSessionStatus = async (id) => (id === "ses_1" ? "Busy" : undefined)
    expect(await resolveSessionStatus(fetchSessionStatus, "ses_1")).toEqual({ kind: "value", status: "busy" })
    // The accessor answered with nothing at all for the other session: that is
    // "could not ask", not "this session has a status of undefined".
    expect(await resolveSessionStatus(fetchSessionStatus, "ses_2")).toEqual({ kind: "unavailable" })
  })

  test("a throwing, missing or non-function seam is UNAVAILABLE instead of fatal", async () => {
    const throwing = async () => {
      throw new Error("host rejected the call")
    }
    expect(await resolveSessionStatus(throwing, "ses_1")).toEqual({ kind: "unavailable" })
    expect(await resolveSessionStatus(null, "ses_1")).toEqual({ kind: "unavailable" })
    expect(await resolveSessionStatus(undefined, "ses_1")).toEqual({ kind: "unavailable" })
    expect(await resolveSessionStatus("not-a-function", "ses_1")).toEqual({ kind: "unavailable" })
    expect(await resolveSessionStatus(async () => null, "ses_1")).toEqual({ kind: "unavailable" })
  })

  test("a record status from a per-session accessor is normalized", async () => {
    const fetchSessionStatus = async () => ({ type: "running" })
    expect(await resolveSessionStatus(fetchSessionStatus, "ses_1")).toEqual({ kind: "value", status: "running" })
  })
})

describe("tmux-viz status reader over the host session domain", () => {
  test("it asks for THIS session using the object form first", async () => {
    const received = []
    const context = {
      session: {
        status: async (address) => {
          received.push(address)
          return "busy"
        },
      },
    }
    const read = createSessionStatusReader(context)
    expect(await read("ses_1")).toEqual({ kind: "value", status: "busy" })
    expect(received).toEqual([{ sessionID: "ses_1" }])
  })

  test("domain precedence matches the runtime resolver", async () => {
    const only = (status) => ({ status: async () => status })
    expect(await createSessionStatusReader({ v2: { session: only("running") }, session: only("idle") })("ses_1"))
      .toEqual({ kind: "value", status: "running" })
    expect(await createSessionStatusReader({ session: only("idle"), client: { v2: { session: only("retry") }, session: only("busy") } })("ses_1"))
      .toEqual({ kind: "value", status: "idle" })
    expect(await createSessionStatusReader({ client: { v2: { session: only("retry") }, session: only("busy") } })("ses_1"))
      .toEqual({ kind: "value", status: "retry" })
    expect(await createSessionStatusReader({ client: { session: only("busy") } })("ses_1"))
      .toEqual({ kind: "value", status: "busy" })
    expect(await createSessionStatusReader({ data: { session: only("retry") } })("ses_1"))
      .toEqual({ kind: "value", status: "retry" })
  })

  test("a domain whose object form throws is retried in positional form", async () => {
    const calls = []
    const context = {
      session: {
        status: async (address) => {
          calls.push(address)
          if (address && typeof address === "object") throw new TypeError("expected a string id")
          return "idle"
        },
      },
    }
    expect(await createSessionStatusReader(context)("ses_1")).toEqual({ kind: "value", status: "idle" })
    expect(calls).toEqual([{ sessionID: "ses_1" }, "ses_1"])
  })

  test("an accessor that throws on every form reads as UNAVAILABLE, never as absent", async () => {
    const context = {
      session: {
        status: async () => {
          throw new Error("host unavailable")
        },
      },
    }
    expect(await createSessionStatusReader(context)("ses_1")).toEqual({ kind: "unavailable" })
  })

  test("no session domain, or no usable session id, reads as UNAVAILABLE", async () => {
    expect(await createSessionStatusReader({})("ses_1")).toEqual({ kind: "unavailable" })
    expect(await createSessionStatusReader(undefined)("ses_1")).toEqual({ kind: "unavailable" })
    const context = { session: { status: async () => "busy" } }
    expect(await createSessionStatusReader(context)("")).toEqual({ kind: "unavailable" })
    expect(await createSessionStatusReader(context)(undefined)).toEqual({ kind: "unavailable" })
    expect(await createSessionStatusReader(context)(42)).toEqual({ kind: "unavailable" })
  })

  test("the host answering with no status reads as ABSENT", async () => {
    const emptyRecord = createSessionStatusReader({ session: { status: async () => ({}) } })
    const nothing = createSessionStatusReader({ session: { status: async () => undefined } })
    expect(await emptyRecord("ses_1")).toEqual({ kind: "absent" })
    expect(await nothing("ses_1")).toEqual({ kind: "absent" })
  })

  test("the chosen domain is announced exactly once so a live run is diagnosable", async () => {
    const lines = []
    const read = createSessionStatusReader(
      { session: { status: async () => "busy" } },
      { logger: (line) => lines.push(line) },
    )
    await read("ses_1")
    await read("ses_2")
    await read("ses_3")
    expect(lines).toEqual(["session status domain=session"])
  })
})
