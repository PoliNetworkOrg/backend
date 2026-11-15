import { describe, expect, it } from "vitest"
import { isBirthday } from "@/soci/birthdays"
import { admitInput, harness, registerInput } from "./soci-fixtures"

const ACTOR = "usr_direttivo"

/** Mario (344, born 1 January 1980, admitted), Ada (1001, alias "Ada") and Alan (1002) without a birth date. */
async function register() {
  const h = harness()
  await h.service.admit(ACTOR, admitInput())
  await h.service.register(
    ACTOR,
    registerInput("mock-member-ada", { details: { firstName: "Augusta Ada", lastName: "King", alias: "Ada" } })
  )
  await h.service.register(ACTOR, registerInput("mock-member-alan"))
  const socio = (number: number) => {
    const row = h.rows.find((r) => r.number === number)
    if (!row) throw new Error(`No socio ${number}`)
    return row
  }
  return { ...h, socio }
}

const birthdays = (h: ReturnType<typeof harness>) =>
  [...h.outbox.values()].filter((m) => m.kind === "birthday").map((m) => [m.id, m.to, m.data])

describe("birthdays", () => {
  it("fall on the day, and on 28 February for the 29th in years without one", () => {
    expect(isBirthday("1980-01-01", "2027-01-01")).toBe(true)
    expect(isBirthday("1980-01-01", "2027-01-02")).toBe(false)
    expect(isBirthday("2004-02-29", "2027-02-28")).toBe(true)
    expect(isBirthday("2004-02-29", "2028-02-28")).toBe(false)
    expect(isBirthday("2004-02-29", "2028-02-29")).toBe(true)
    // 2100 is not a leap year, 2000 was.
    expect(isBirthday("2004-02-29", "2100-02-28")).toBe(true)
    expect(isBirthday("2004-02-29", "2000-02-28")).toBe(false)
    expect(isBirthday("2003-02-28", "2027-02-28")).toBe(true)
  })

  it("greet every active socio born that day by the name they go by, once a year", async () => {
    const h = await register()
    h.socio(1001).birthDate = "2004-02-29"
    h.socio(344).birthDate = "1980-02-28"
    h.setNow("2027-02-28")
    expect(await h.service.sendBirthdays()).toBe(2)
    expect(await h.service.sendBirthdays()).toBe(0)
    expect(birthdays(h)).toEqual([
      ["birthday:2027:1", "mario.rossi@polinetwork.org", { name: "Mario", number: 344, since: 2026 }],
      ["birthday:2027:2", "ada.lovelace@polinetwork.org", { name: "Ada", number: 1001, since: 2025 }],
    ])

    // In a leap year Ada's comes on the 29th.
    h.setNow("2028-02-28")
    expect(await h.service.sendBirthdays()).toBe(1)
    h.setNow("2028-02-29")
    expect(await h.service.sendBirthdays()).toBe(1)
    expect(birthdays(h).map(([id]) => id)).toEqual([
      "birthday:2027:1",
      "birthday:2027:2",
      "birthday:2028:1",
      "birthday:2028:2",
    ])
  })

  it("skip ended soci, deleted accounts and records without a birth date, without needing bank details", async () => {
    const h = await register()
    const noBank = harness({ store: h.store, fees: { bank: null, myAreaUrl: "x", send: h.send } })
    for (const n of [344, 1001]) h.socio(n).birthDate = "1990-06-15"
    Object.assign(h.socio(344), { endedOn: "2027-01-01", endReason: "resigned" })
    noBank.setNow("2027-06-15")
    expect(await noBank.service.sendBirthdays()).toBe(1)
    h.socio(1001).accountState = "deleted"
    h.setNow("2028-06-15")
    expect(await h.service.sendBirthdays()).toBe(0)
    expect(birthdays(h).map(([id]) => id)).toEqual(["birthday:2027:2"])
  })

  it("are sent by the outbox like the fee emails", async () => {
    const h = await register()
    h.setNow("2027-01-01")
    await h.service.sendBirthdays()
    await h.service.deliverPending()
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "birthday:2027:1",
        kind: "birthday",
        data: { name: "Mario", number: 344, since: 2026 },
      })
    )
    expect(h.outbox.get("birthday:2027:1")?.status).toBe("sent")
    expect((await h.service.get({ number: 344 })).activity[0].text).toBe("Sent the birthday email")
  })
})
