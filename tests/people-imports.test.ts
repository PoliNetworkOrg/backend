import { strToU8, zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { transferType } from "@/people/files"
import { parseImport, unzipBounded } from "@/people/imports"
import { harness, master, profile, viewer } from "./people-fixtures"

const header = "firstName,lastName,personalEmail,phone,telegramUsername,course,year,campus,answer"
const csv = `${header}\nSara,Neri,sara@example.org,,sara_test,Informatica,2nd year,Leonardo,continues\n`
const csvFile = (text = csv) => new File([text], "export.csv")

describe("People census imports", () => {
  it("previews, commits and deduplicates real CSV responses without touching membership", async () => {
    const h = harness()
    await h.seed()
    await h.service.listCampaigns(master)
    const preview = await h.service.importPreview(master, { campaignId: "2026/27", file: csvFile() })
    expect(preview.counts).toMatchObject({ newPeople: 1, invalid: 0, duplicates: 0 })
    expect(await h.service.importCommit(master, { importId: preview.importId, duplicates: {}, telegram: {} })).toEqual({
      imported: 1,
    })
    expect(await h.service.importCommit(master, { importId: preview.importId, duplicates: {}, telegram: {} })).toEqual({
      imported: 0,
    })
    const again = await h.service.importPreview(master, { campaignId: "2026/27", file: csvFile() })
    expect(again.counts.alreadyImported).toBe(1)
    const p = h.state().persons["P-0004"]
    expect(p).toMatchObject({ member: null, accountSub: null, census: [{ answer: "continues", source: "forms" }] })
  })
  it("requires the preview's exact duplicate decisions and isolates previews by owner", async () => {
    const h = harness()
    await h.seed()
    await h.service.createPerson(master, { ...profile("Sara", "Neri"), personalEmail: "other@example.org" })
    await h.service.listCampaigns(master)
    const preview = await h.service.importPreview(master, { campaignId: "2026/27", file: csvFile() })
    expect(preview.counts.duplicates).toBe(1)
    await expect(
      h.service.importCommit(master, { importId: preview.importId, duplicates: {}, telegram: {} })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    await expect(
      h.service.importCommit(viewer("someone-else", ["admin:access", "people:write"]), {
        importId: preview.importId,
        duplicates: { [preview.duplicates[0].pairId]: "same" },
        telegram: {},
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(
      await h.service.importCommit(master, {
        importId: preview.importId,
        duplicates: { [preview.duplicates[0].pairId]: "different" },
        telegram: {},
      })
    ).toEqual({ imported: 1 })
    expect(Object.values(h.state().persons)).toHaveLength(5)
  })
  it("ends volunteer roles on leaving while preserving association membership", async () => {
    const h = harness()
    await h.seed()
    await h.service.listCampaigns(master)
    await h.service.createMember(master, { personId: "P-0003", number: "0003", admittedOn: "2026-10-01", fee: "due" })
    const file = csvFile(`${header}\nLuca,Verdi,luca@example.org,,,Informatica,2nd year,Leonardo,leaving\n`)
    const preview = await h.service.importPreview(master, { campaignId: "2026/27", file })
    await h.service.importCommit(master, { importId: preview.importId, duplicates: {}, telegram: {} })
    expect(h.state().persons["P-0003"]).toMatchObject({
      admin: { status: "former" },
      member: { status: "active", number: "0003" },
      accountSub: "member",
    })
  })
  it("rejects a stale preview rather than overwriting a newer dashboard answer", async () => {
    const h = harness()
    await h.seed()
    await h.service.listCampaigns(master)
    const file = csvFile(`${header}\nLuca,Verdi,luca@example.org,,,Informatica,2nd year,Leonardo,continues\n`)
    const preview = await h.service.importPreview(master, { campaignId: "2026/27", file })
    await h.service.answerCensus(viewer("member", ["people:self"]), {
      answer: "continues",
      course: "New course",
      year: "3rd year",
      campus: "Bovisa",
      keepGroups: [],
      keepTeams: [],
      reason: "",
      note: "",
    })
    await expect(
      h.service.importCommit(master, { importId: preview.importId, duplicates: {}, telegram: {} })
    ).rejects.toMatchObject({ code: "CONFLICT" })
    expect(h.state().persons["P-0003"].profile.course).toBe("New course")
  })
  it("parses a real XLSX container, shared strings and inline values", async () => {
    const headers = header.split(",")
    const values = [
      "Sara",
      "Neri",
      "sara@example.org",
      "",
      "sara_test",
      "Informatica",
      "2nd year",
      "Leonardo",
      "continues",
    ]
    const cells = (values: string[], row: number) =>
      `<row r="${row}">${values.map((v, i) => `<c r="${String.fromCharCode(65 + i)}${row}" t="inlineStr"><is><t>${v}</t></is></c>`).join("")}</row>`
    const bytes = zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "xl/workbook.xml": strToU8("<workbook/>"),
      "xl/worksheets/sheet1.xml": strToU8(
        `<worksheet><sheetData>${cells(headers, 1)}${cells(values, 2)}</sheetData></worksheet>`
      ),
    })
    const parsed = await parseImport(new File([new Uint8Array(bytes)], "actually-a-workbook.csv"))
    expect(parsed[0]).toMatchObject({
      answer: "continues",
      profile: { firstName: "Sara", campus: "Leonardo" },
      error: null,
    })
  })
  it("checks content, archive budgets, row bounds and CSV quoting", async () => {
    await expect(parseImport(new File(["not a workbook"], "fake.xlsx"))).rejects.toMatchObject({ code: "BAD_REQUEST" })
    await expect(
      parseImport(new File([zipSync({ "file.txt": strToU8("text") })], "archive.xlsx"))
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    await expect(parseImport(csvFile(`${header}\n"unclosed`))).rejects.toMatchObject({ code: "BAD_REQUEST" })
    await expect(
      parseImport(csvFile(`${header}\n${"Sara,Neri,sara@example.org,,,IT,2nd year,Leonardo,continues\n".repeat(5001)}`))
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    const many = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`f${i}`, new Uint8Array()]))
    expect(() => unzipBounded(zipSync(many))).toThrow()
    expect(() => unzipBounded(zipSync({ "large.xml": new Uint8Array(51 * 1024 * 1024) }))).toThrow()
  })
  it("rejects fake or corrupt transfer images even with a matching extension", async () => {
    await expect(transferType(new TextEncoder().encode("not an image.png"))).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
    await expect(transferType(new Uint8Array([0xff, 0xd8, 0xff, 0, 0xff, 0xd9]))).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
    const png = new Uint8Array(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64"
      )
    )
    expect(await transferType(png)).toBe("image/png")
  })
})
