import { describe, expect, it, vi } from "vitest"
import { checkCharacter, codiceFiscaleProblem, matchesBirthDate } from "@/soci/codice-fiscale"
import {
  admitInputSchema,
  codiceFiscaleSchema,
  phoneSchema,
  registerInputSchema,
  updateInputSchema,
} from "@/soci/contract"
import { admitInput, details, harness, OTHER_CF, registerInput, VALID_CF } from "./soci-fixtures"

const ACTOR = "usr_direttivo"

/** RSSMRA80A01H501U with its last Belfiore digit replaced for omocodia (1 -> M), and the check recomputed. */
const OMOCODIC = `RSSMRA80A01H50M${checkCharacter("RSSMRA80A01H50M")}`

describe("codice fiscale", () => {
  it("accepts valid codes, including omocodic ones, and normalizes case and spaces", () => {
    expect(codiceFiscaleProblem(VALID_CF)).toBeNull()
    expect(codiceFiscaleProblem(OTHER_CF)).toBeNull()
    expect(codiceFiscaleProblem(OMOCODIC)).toBeNull()
    expect(codiceFiscaleSchema.parse(" rssmra80a01 h501u ")).toBe(VALID_CF)
  })

  it("refuses a wrong check character, a bad format and a day that can't exist", () => {
    expect(codiceFiscaleProblem("RSSMRA80A01H501X")).toBe("check")
    expect(codiceFiscaleProblem("RSSMRA80A01H501")).toBe("format")
    // `F` is not a month letter.
    expect(codiceFiscaleProblem("RSSMRA80F01H501U")).toBe("format")
    const feb30 = `RSSMRA80B30H501${checkCharacter("RSSMRA80B30H501")}`
    expect(codiceFiscaleProblem(feb30)).toBe("date")
    expect(codiceFiscaleSchema.safeParse("RSSMRA80A01H501X").success).toBe(false)
  })

  it("checks the birth date against the code, for men and women", () => {
    expect(matchesBirthDate(VALID_CF, "1980-01-01")).toBe(true)
    expect(matchesBirthDate(OMOCODIC, "1980-01-01")).toBe(true)
    expect(matchesBirthDate(VALID_CF, "1980-01-02")).toBe(false)
    const anna = `BNCNNA90E52F205${checkCharacter("BNCNNA90E52F205")}`
    expect(matchesBirthDate(anna, "1990-05-12")).toBe(true)
    const parsed = admitInputSchema.safeParse({
      ...admitInput(),
      details: details({ birthDate: "1980-01-02" }),
    })
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed.error?.issues)).toContain("doesn't match the codice fiscale")
  })

  it("requires every detail but the alias and the phone to admit, and only the legal name to register", () => {
    expect(admitInputSchema.safeParse({ ...admitInput(), details: details({ birthPlace: "" }) }).success).toBe(false)
    expect(admitInputSchema.safeParse({ ...admitInput(), details: details({ residence: " " }) }).success).toBe(false)
    expect(admitInput().details).toMatchObject({ residence: "Via Roma 1, 20133 Milano (MI)", phone: null })
    const registered = registerInput("mock-member-alan")
    expect(registered.details).toMatchObject({ codiceFiscale: null, birthDate: null, residence: null, phone: null })
    expect(registerInputSchema.safeParse({ ...registered, details: { lastName: "Turing" } }).success).toBe(false)
  })
})

describe("phone", () => {
  it("accepts international numbers, dropping spaces and separators", () => {
    expect(phoneSchema.parse("+39 333 123 4567")).toBe("+393331234567")
    expect(phoneSchema.parse("+44 (20) 7946-0958")).toBe("+442079460958")
    expect(admitInput({ details: details({ phone: "+39 333.123.4567" }) }).details.phone).toBe("+393331234567")
  })

  it("refuses numbers without the country code", () => {
    for (const phone of ["333 123 4567", "0039 333 123 4567", "+0 333 123 4567", "+39 333", "+39 333 abc 4567"])
      expect(phoneSchema.safeParse(phone).success, phone).toBe(false)
  })
})

describe("soci.members.admit", () => {
  it("creates the account in Soci, writes the record and sends the welcome email", async () => {
    const h = harness()
    const result = await h.service.admit(ACTOR, admitInput())
    expect(result).toMatchObject({ number: 344, mailbox: "mario.rossi@polinetwork.org", welcomeMailSent: true })
    expect(h.welcome).toHaveBeenCalledWith(
      "mario@example.org",
      expect.objectContaining({ email: "mario.rossi@polinetwork.org" }),
      { firstName: "Mario", assocNumber: 344 }
    )
    const record = await h.service.get({ number: 344 })
    expect(record).toMatchObject({
      entraObjectId: result.entraObjectId,
      codiceFiscale: VALID_CF,
      admittedOn: "2026-11-09",
      accountState: "active",
      inSoci: true,
      mismatch: null,
      accountNumber: "344",
      createdBy: ACTOR,
    })
    expect(record.activity.map((a) => a.text)).toEqual([
      "Admitted with number 344; account mario.rossi@polinetwork.org created",
    ])
  })

  it("refuses a number any record has held, an ended one's included, or a Microsoft 365 user has", async () => {
    const h = harness()
    await h.service.admit(ACTOR, admitInput())
    const again = admitInput({
      account: { firstName: "Anna", lastName: "Bianchi", sendEmailTo: "anna@example.org" },
      details: details({ codiceFiscale: OTHER_CF, birthDate: "1985-12-10" }),
    })
    await expect(h.service.admit(ACTOR, again)).rejects.toMatchObject({ code: "CONFLICT" })

    // The record ends (as the lapse issue will do) and its account goes: the number still stays used.
    h.rows[0].endedOn = "2026-12-31"
    h.rows[0].endReason = "resigned"
    await h.directory.deleteUser(h.rows[0].entraObjectId)
    await expect(h.service.admit(ACTOR, again)).rejects.toThrow(/never reused/)

    // Ada holds 1001 in Microsoft 365, without a record.
    await expect(h.service.admit(ACTOR, { ...again, number: 1001 })).rejects.toThrow(/Ada Lovelace/)
    expect(await h.directory.findByMail("anna.bianchi@polinetwork.org")).toBeNull()
    expect(await h.service.admit(ACTOR, { ...again, number: 345 })).toMatchObject({ number: 345 })
  })

  it("refuses a codice fiscale an active socio has, but not one of a former socio", async () => {
    const h = harness()
    await h.service.admit(ACTOR, admitInput())
    const sameCode = admitInput({
      account: {
        firstName: "Mario",
        lastName: "Rossi",
        mailbox: { kind: "custom", localPart: "mario.rossi2" },
        sendEmailTo: "mario@example.org",
      },
      number: 345,
    })
    await expect(h.service.admit(ACTOR, sameCode)).rejects.toThrow(/socio 344, who is still active/)
    expect(await h.directory.findByMail("mario.rossi2@polinetwork.org")).toBeNull()

    h.rows[0].endedOn = "2026-12-31"
    h.rows[0].endReason = "resigned"
    expect((await h.service.admit(ACTOR, sameCode)).number).toBe(345)
  })

  it("deletes the new account when the record can't be written, and leaves the number free", async () => {
    const h = harness()
    vi.spyOn(h.store, "insert").mockRejectedValueOnce(new Error("connection lost"))
    await expect(h.service.admit(ACTOR, admitInput())).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "The record couldn't be saved, so the new account was deleted. Try again.",
    })
    expect(await h.directory.findByMail("mario.rossi@polinetwork.org")).toBeNull()
    expect(await h.directory.findByMemberNumber(344)).toBeNull()
    expect(h.welcome).not.toHaveBeenCalled()
    expect(h.rows).toHaveLength(0)
    expect(await h.service.admit(ACTOR, admitInput())).toMatchObject({ number: 344 })
  })

  it("says so when neither the record nor the cleanup succeed", async () => {
    const h = harness()
    vi.spyOn(h.store, "insert").mockRejectedValueOnce(new Error("connection lost"))
    vi.spyOn(h.directory, "deleteUser").mockRejectedValueOnce(new Error("Graph is down"))
    await expect(h.service.admit(ACTOR, admitInput())).rejects.toThrow(/couldn't be deleted. Contact IT/)
  })

  it("refuses an address in use and a welcome email to the new address", async () => {
    const h = harness()
    await expect(
      h.service.admit(
        ACTOR,
        admitInput({ account: { firstName: "Ada", lastName: "Lovelace", sendEmailTo: "ada@example.org" } })
      )
    ).rejects.toThrow(/already in use/)
    await expect(
      h.service.admit(
        ACTOR,
        admitInput({ account: { firstName: "Mario", lastName: "Rossi", sendEmailTo: "mario.rossi@polinetwork.org" } })
      )
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
  })
})

describe("soci.members.register", () => {
  it("registers an account already in Soci with its number, personal fields optional", async () => {
    const h = harness()
    expect(await h.service.register(ACTOR, registerInput("mock-member-alan"))).toEqual({ number: 1002 })
    const record = await h.service.get({ number: 1002 })
    expect(record).toMatchObject({
      mailbox: "alan.turing@polinetwork.org",
      displayName: "Alan Turing",
      codiceFiscale: null,
      admittedOn: "2025-03-14",
      inSoci: true,
      mismatch: null,
    })
    expect(record.activity[0].text).toBe("Registered from Microsoft 365 with number 1002")
    await expect(h.service.register(ACTOR, registerInput("mock-member-alan"))).rejects.toThrow(/already has a record/)
  })

  it("refuses an account outside Soci, and a number other than the account's", async () => {
    const h = harness()
    await expect(h.service.register(ACTOR, registerInput("mock-member-grace"))).rejects.toThrow(
      /isn't in the Soci group/
    )
    await expect(h.service.register(ACTOR, registerInput("mock-member-alan", { number: 7 }))).rejects.toThrow(
      /has member number 1002/
    )
  })

  it("gives an account without a number the one chosen, if no record ever held it", async () => {
    const h = harness()
    await h.service.admit(ACTOR, admitInput())
    await h.directory.addToSoci("mock-member-grace")
    const grace = (n?: number) =>
      registerInput("mock-member-grace", { number: n, details: { firstName: "Grace", lastName: "Hopper" } })
    await expect(h.service.register(ACTOR, grace())).rejects.toThrow(/no member number/)
    await expect(h.service.register(ACTOR, grace(344))).rejects.toMatchObject({ code: "CONFLICT" })
    expect(await h.service.register(ACTOR, grace(500))).toEqual({ number: 500 })
    expect((await h.directory.getMember("mock-member-grace"))?.employeeId).toBe("500")
  })

  it("refuses a codice fiscale an active socio has", async () => {
    const h = harness()
    await h.service.admit(ACTOR, admitInput())
    await expect(
      h.service.register(ACTOR, registerInput("mock-member-alan", { details: details({ firstName: "Alan" }) }))
    ).rejects.toThrow(/still active/)
  })
})

describe("soci.members.list and unregistered", () => {
  it("lists Soci members without a record, with their number and creation date", async () => {
    const h = harness()
    await h.service.register(ACTOR, registerInput("mock-member-alan"))
    expect(await h.service.unregistered()).toEqual([
      {
        entraObjectId: "mock-member-ada",
        displayName: "Ada Lovelace",
        givenName: "Ada",
        surname: "Lovelace",
        mail: "ada.lovelace@polinetwork.org",
        employeeId: "1001",
        createdDateTime: "2024-10-02T09:00:00Z",
      },
    ])
  })

  it("reports active records outside Soci and ended records still in it", async () => {
    const h = harness()
    await h.service.register(ACTOR, registerInput("mock-member-alan"))
    await h.service.register(ACTOR, registerInput("mock-member-ada", { details: { firstName: "Ada", lastName: "L" } }))
    expect((await h.service.list()).members.map((m) => m.mismatch)).toEqual([null, null])

    await h.directory.removeFromSoci("mock-member-ada")
    const alan = h.rows.find((r) => r.number === 1002)
    Object.assign(alan ?? {}, { endedOn: "2026-12-31", endReason: "resigned" })
    const list = await h.service.list()
    expect(list.directoryAvailable).toBe(true)
    expect(list.members.map((m) => [m.number, m.inSoci, m.mismatch])).toEqual([
      [1001, false, "not_in_soci"],
      [1002, true, "still_in_soci"],
    ])
  })

  it("still lists the register when Microsoft 365 can't be read", async () => {
    const h = harness()
    await h.service.register(ACTOR, registerInput("mock-member-alan"))
    vi.spyOn(h.directory, "getSociMembers").mockRejectedValue(new Error("Graph is down"))
    const list = await h.service.list()
    expect(list).toMatchObject({ directoryAvailable: false, members: [{ number: 1002, inSoci: null, mismatch: null }] })
    await expect(h.service.unregistered()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" })
  })
})

describe("soci.members.update and setNumber", () => {
  it("records which fields changed, and refuses another active socio's code", async () => {
    const h = harness()
    await h.service.admit(ACTOR, admitInput())
    await h.service.register(ACTOR, registerInput("mock-member-alan"))
    const update = (number: number, d: Record<string, unknown>) =>
      updateInputSchema.parse({ number, details: d, admittedOn: number === 344 ? "2026-11-09" : "2025-03-14" })

    await h.service.update(ACTOR, update(344, details({ alias: "Super Mario" })))
    const record = await h.service.get({ number: 344 })
    expect(record.alias).toBe("Super Mario")
    expect(record.activity[0].text).toBe("Edited alias")

    await h.service.update(ACTOR, update(344, details({ alias: "Super Mario" })))
    expect((await h.service.get({ number: 344 })).activity).toHaveLength(2)

    await expect(
      h.service.update(ACTOR, update(1002, details({ firstName: "Alan", lastName: "Turing" })))
    ).rejects.toThrow(/socio 344, who is still active/)
  })

  it("changes the number in Microsoft 365 and on the record, and never gives the old one again", async () => {
    const h = harness()
    await h.service.admit(ACTOR, admitInput())
    await expect(h.service.setNumber(ACTOR, { number: 344, newNumber: 1001 })).rejects.toThrow(/Ada Lovelace/)
    expect(await h.service.setNumber(ACTOR, { number: 344, newNumber: 350, notifyEmail: "mario@example.org" })).toEqual(
      { number: 350, notificationSent: true }
    )
    expect(h.numberChanged).toHaveBeenCalledWith(
      "mario@example.org",
      expect.objectContaining({ assocNumber: 350, previousAssocNumber: "344" })
    )
    const record = await h.service.get({ number: 350 })
    expect(record.accountNumber).toBe("350")
    expect(record.activity[0].text).toBe("Member number changed from 344 to 350")
    await expect(h.service.get({ number: 344 })).rejects.toMatchObject({ code: "NOT_FOUND" })

    // 344 is free in Microsoft 365 now, but a record held it.
    const anna = admitInput({
      account: { firstName: "Anna", lastName: "Bianchi", sendEmailTo: "anna@example.org" },
      details: details({ codiceFiscale: OTHER_CF, birthDate: "1985-12-10" }),
    })
    await expect(h.service.admit(ACTOR, anna)).rejects.toThrow(/never reused/)
    // The same record may go back to it.
    expect(await h.service.setNumber(ACTOR, { number: 350, newNumber: 344 })).toEqual({
      number: 344,
      notificationSent: null,
    })
  })

  it("puts the account back on the old number when the record can't be saved", async () => {
    const h = harness()
    await h.service.admit(ACTOR, admitInput())
    vi.spyOn(h.store, "changeNumber").mockRejectedValueOnce(new Error("connection lost"))
    await expect(h.service.setNumber(ACTOR, { number: 344, newNumber: 350 })).rejects.toThrow(/keeps the old one/)
    expect((await h.service.get({ number: 344 })).accountNumber).toBe("344")
  })
})
