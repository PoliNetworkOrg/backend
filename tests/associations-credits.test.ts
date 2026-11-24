import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { estimateCost, type PromotionContent, RRI_CREDIT_RULES } from "@/associations/contract"
import { balanceOf, createCreditService } from "@/associations/credits"
import type { Viewer } from "@/associations/service"
import { harness, outsider, owner, profile, programme, promotionHarness, staff } from "./associations-fixture"

const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
const content = (channels: PromotionContent["channels"]): PromotionContent => ({
  title: "Hackathon",
  text: "Testo",
  link: "",
  poster: null,
  channels,
  audience: { everyone: true, programmes: [], campuses: [] },
  desiredDate: tomorrow,
  deadline: null,
  eventId: null,
})
const course = (channel: PromotionContent["channels"][number]["channel"], slug: string | null = programme) => ({
  channel,
  programme: slug,
  note: "",
})

async function setup({ enabled = true } = {}) {
  const h = harness()
  const id = await h.registered()
  // The association lists Ingegneria Informatica, so its course channels cost half.
  await h.command(owner, id, {
    action: "save",
    requestId: null,
    profile: { ...profile, programmes: [programme] },
    explanation: "Corso",
  })
  await h.command(owner, id, { action: "submit", requestId: h.rows.get(id)?.requests.at(-1)?.id ?? "" })
  await h.command(staff, id, {
    action: "review",
    requestId: h.rows.get(id)?.requests.at(-1)?.id ?? "",
    decision: "approve",
    reason: "OK",
  })
  h.catalogue.push({
    kind: "programme",
    slug: "didattica.x.triennale.altro",
    nameIt: "Altro",
    nameEn: "Other",
    active: true,
  })
  const p = promotionHarness(h)
  p.credits.state.config.enabled = enabled
  const credits = createCreditService(
    p.credits.store,
    {
      get: async (x) => structuredClone(h.rows.get(x) ?? null),
      list: async () => structuredClone([...h.rows.values()]),
    },
    p.store
  )
  const submitted = async (c: PromotionContent) => {
    const { id: pid } = await p.service.create(owner, { associationId: id, content: c, commandId: randomUUID() })
    await p.command(owner, pid, { action: "submit" })
    return pid
  }
  const balance = async () => (await credits.account(owner, id)).balance
  return { h, id, p, credits, submitted, balance }
}

describe("Credit rules (RRI art. 4.7)", () => {
  it("estimates costs per channel with the own-programme reduction and flags channels without a price", () => {
    const own = [programme]
    expect(estimateCost([course("poliassociazioni", null)], own, RRI_CREDIT_RULES)).toEqual({
      total: 0,
      unknown: false,
    })
    expect(estimateCost([course("course_groups", "other")], own, RRI_CREDIT_RULES).total).toBe(300)
    expect(estimateCost([course("course_groups")], own, RRI_CREDIT_RULES).total).toBe(150)
    expect(estimateCost([course("exam_group")], own, RRI_CREDIT_RULES).total).toBe(25)
    expect(estimateCost([course("level_group", null), course("other", null)], own, RRI_CREDIT_RULES)).toEqual({
      total: 200,
      unknown: true,
    })
  })
})

describe("Credit ledger", () => {
  it("debits on approval, once, and reverses after a later rejection or withdrawal", async () => {
    const { id, p, credits, submitted, balance } = await setup()
    await credits.operate(staff, {
      associationId: id,
      kind: "credit",
      amount: 300,
      reason: "Semestre",
      commandId: randomUUID(),
    })
    const a = await submitted(content([course("course_broadcast")]))
    expect((await credits.account(owner, id)).expected).toBe(50)
    await p.command(staff, a, { action: "approve", note: "", cost: null })
    expect(await balance()).toBe(250)
    // A retried or repeated approval never debits twice.
    await expect(p.command(staff, a, { action: "approve", note: "", cost: null })).rejects.toMatchObject({
      code: "CONFLICT",
    })
    await p.command(staff, a, { action: "reject", note: "Annullato" })
    expect(await balance()).toBe(300)
    const b = await submitted(content([course("course_groups", "didattica.x.triennale.altro")]))
    await p.command(staff, b, { action: "approve", note: "", cost: null })
    await p.command(staff, b, {
      action: "schedule",
      scheduledAt: `${tomorrow}T10:00:00Z`,
      channel: "course_groups",
      detail: "",
      note: "",
    })
    expect(await balance()).toBe(0)
    await p.command(owner, b, { action: "withdraw", note: "" })
    const account = await credits.account(owner, id)
    expect(account.balance).toBe(300)
    expect(account.entries.map((e) => [e.kind, e.amount])).toEqual([
      ["credit", 300],
      ["debit", -50],
      ["reversal", 50],
      ["debit", -300],
      ["reversal", 300],
    ])
    expect(account.entries.every((e) => e.authorName && e.createdAt)).toBe(true)
  })

  it("refuses to go below zero unless allowed, and asks the price of unpriced channels", async () => {
    const { id, p, credits, submitted, balance } = await setup()
    await credits.operate(staff, {
      associationId: id,
      kind: "credit",
      amount: 100,
      reason: "Semestre",
      commandId: randomUUID(),
    })
    const expensive = await submitted(content([course("level_group", null)]))
    await expect(p.command(staff, expensive, { action: "approve", note: "", cost: null })).rejects.toMatchObject({
      message: "The association does not have enough credits",
    })
    expect((await p.service.get(owner, expensive)).status).toBe("submitted")
    const other = await submitted(content([course("other", null)]))
    await expect(p.command(staff, other, { action: "approve", note: "", cost: null })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
    await p.command(staff, other, { action: "approve", note: "", cost: 75 })
    expect(await balance()).toBe(25)
    await credits.saveConfig(staff, { ...(await credits.config(staff)), allowNegative: true })
    await p.command(staff, expensive, { action: "approve", note: "", cost: null })
    expect(await balance()).toBe(-175)
  })

  it("posts nothing and shows nothing to representatives while the flag is off", async () => {
    const { id, p, credits, submitted, balance } = await setup({ enabled: false })
    const a = await submitted(content([course("level_group", null)]))
    await p.command(staff, a, { action: "approve", note: "", cost: null })
    expect(await balance()).toBe(0)
    expect(await credits.account(owner, id)).toMatchObject({ enabled: false, entries: [], expected: 0 })
    await credits.operate(staff, {
      associationId: id,
      kind: "credit",
      amount: 300,
      reason: "Prova",
      commandId: randomUUID(),
    })
    expect((await credits.account(staff, id)).entries).toHaveLength(1)
    expect((await credits.account(owner, id)).entries).toEqual([])
  })

  it("lets only operators grant, adjust, change the rules and run the semester grant once per period", async () => {
    const { h, id, credits, balance } = await setup()
    for (const call of [
      () =>
        credits.operate(owner, {
          associationId: id,
          kind: "credit",
          amount: 300,
          reason: "x",
          commandId: randomUUID(),
        }),
      () => credits.config(owner),
      () => credits.semester(owner, { period: "2026-27 S1", amount: 300, resetUnused: true, reason: "x" }),
    ])
      await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(credits.account(outsider, id)).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(
      credits.operate(staff, { associationId: id, kind: "credit", amount: -10, reason: "x", commandId: randomUUID() })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    const key = randomUUID()
    await credits.operate(staff, {
      associationId: id,
      kind: "adjustment",
      amount: 120,
      reason: "Bonus corso piccolo",
      commandId: key,
    })
    await credits.operate(staff, {
      associationId: id,
      kind: "adjustment",
      amount: 120,
      reason: "Bonus corso piccolo",
      commandId: key,
    })
    expect(await balance()).toBe(120)
    await expect(
      credits.operate(staff, {
        associationId: id,
        kind: "adjustment",
        amount: -500,
        reason: "Sanzione",
        commandId: randomUUID(),
      })
    ).rejects.toMatchObject({ code: "CONFLICT" })
    // Not cumulative: unused credits expire when the semester's arrive, and a period is granted once.
    const semester = { period: "2026-27 S1", amount: 300, resetUnused: true, reason: "Crediti del semestre" }
    expect(await credits.semester(staff, semester)).toEqual({ granted: 1 })
    expect(await credits.semester(staff, semester)).toEqual({ granted: 0 })
    expect(await balance()).toBe(300)
    expect(balanceOf((await credits.account(staff, id)).entries)).toBe(300)
    void h
  })
})
