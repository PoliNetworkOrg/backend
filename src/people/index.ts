import { azureCredentials } from "@/azure/config"
import { azureDirectory } from "@/azure/directory"
import { DB, SCHEMA } from "@/db"
import { sendPeopleEmail, sendWelcomeEmail } from "@/emails/mailer"
import { env } from "@/env"
import { idp } from "@/idp"
import { decryptUser } from "@/utils/users"
import { peopleConfig } from "./config"
import { transferType } from "./files"
import { fail, receiptEligible } from "./model"
import { createPeopleService } from "./service"
import { createPeoplePgStore } from "./store-pg"

export function permissionsFor(sub: string) {
  return (permission: string) => {
    const index = idp?.snapshot?.current()
    return index?.has(index.bySub(sub), permission) ?? false
  }
}
export const people = createPeopleService({
  store: createPeoplePgStore(DB),
  config: peopleConfig,
  async directory() {
    if (!idp?.directory) fail("PRECONDITION_FAILED", "The IdP account directory is not configured")
    return (await idp.directory()).map((a) => ({
      ...a,
      emailVerified: a.emailVerified === true,
      telegramId: idp?.snapshot?.current()?.bySub(a.sub)?.telegramId ?? null,
    }))
  },
  async telegramGroups() {
    const [groups, admins] = await Promise.all([
      DB.select().from(SCHEMA.TG.groups),
      DB.select().from(SCHEMA.TG.groupAdmins),
    ])
    const adminsByGroup = new Map<string, string[]>()
    for (const admin of admins) {
      const id = String(admin.groupId)
      const members = adminsByGroup.get(id) ?? []
      members.push(String(admin.userId))
      adminsByGroup.set(id, members)
    }
    return groups.map((g) => ({
      chatId: String(g.telegramId),
      title: g.title,
      admins: adminsByGroup.get(String(g.telegramId)) ?? [],
    }))
  },
  async telegramUsers() {
    const users = await DB.select().from(SCHEMA.TG.users)
    return Promise.all(
      users.map(async (u) => {
        const p = await decryptUser(u)
        return {
          id: String(p.id),
          name: [p.firstName, p.lastName].filter(Boolean).join(" "),
          username: p.username ?? null,
        }
      })
    )
  },
  async provisionMember(person, number) {
    if (!azureCredentials && env.NODE_ENV === "production")
      fail("PRECONDITION_FAILED", "Microsoft 365 provisioning is not configured")
    const members = await azureDirectory.getMembers()
    const prior = members.find((m) => Number(m.employeeId) === Number(number))
    if (prior) {
      if (prior.givenName !== person.profile.firstName || prior.surname !== person.profile.lastName || !prior.mail)
        fail("CONFLICT", "Member number already belongs to a different Microsoft 365 account")
      return { id: prior.id, email: prior.mail }
    }
    const created = await azureDirectory.createMember({
      firstName: person.profile.firstName,
      lastName: person.profile.lastName,
      assocNumber: Number(number),
    })
    if (person.profile.personalEmail)
      await sendWelcomeEmail(
        person.profile.personalEmail,
        { email: created.mail, password: created.password },
        { firstName: person.profile.firstName, assocNumber: Number(number) }
      )
    return { id: created.id, email: created.mail }
  },
  async setMemberNumber(person, number) {
    if (!person.azureId) fail("PRECONDITION_FAILED", "Microsoft 365 account is missing")
    if (!azureCredentials && env.NODE_ENV === "production")
      fail("PRECONDITION_FAILED", "Microsoft 365 is not configured")
    const result = await azureDirectory.setMemberNumber(person.azureId, Number(number))
    if (result.error) fail("PRECONDITION_FAILED", result.error)
  },
  sendMail: sendPeopleEmail,
  async inspectSigned(sub, bytes) {
    const { esign } = await import("@/esign")
    return esign.inspectUpload(sub, bytes)
  },
  async verifySigned(sub, requestId, bytes) {
    const { esign } = await import("@/esign")
    return esign.verifyUpload({ sub, canManage: false, peopleManual: true }, requestId, bytes)
  },
  async completeSigned(sub, requestId, bytes) {
    const { esign } = await import("@/esign")
    await esign.uploadSigned({ sub, canManage: false, peopleManual: true }, requestId, bytes)
  },
  transferType,
})

export const receiptEligibility = (requestId: string, sub: string, requireEsign = true) =>
  people.eligibleReceipt(requestId, sub, permissionsFor(sub), requireEsign)
export const receiptVisibility = (receiptId: string, sub: string) =>
  people.canViewReceipt(receiptId, sub, permissionsFor(sub))
export const eligibleAtCommit = (
  receipt: Parameters<typeof receiptEligible>[1],
  sub: string,
  state: Parameters<typeof receiptEligible>[0],
  requireEsign: boolean
) => receiptEligible(state, receipt, { sub, telegramId: null, can: permissionsFor(sub) }, peopleConfig, requireEsign)
