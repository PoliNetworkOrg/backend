import { azureDirectory } from "@/azure/directory"
import { DB, SCHEMA } from "@/db"
import { sendPeopleEmail } from "@/emails/mailer"
import { idp } from "@/idp"
import { decryptUser } from "@/utils/users"
import { provisionMember, setMemberNumber } from "./azure-members"
import { peopleConfig } from "./config"
import { transferType } from "./files"
import { fail, receiptEligible, telegramGroupsWithAdmins } from "./model"
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
  // Group admins are native Telegram status (RFC v3 decision 2): the bot reads them, the backend never stores them.
  async telegramGroups() {
    const groups = await DB.select().from(SCHEMA.TG.groups)
    const { WSS } = await import("@/server")
    return telegramGroupsWithAdmins(groups, await WSS.getGroupAdmins(groups.map((g) => g.telegramId)))
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
  provisionMember,
  setMemberNumber,
  peopleRoles: idp?.peopleRoles ?? null,
  async azureMembers() {
    return (await azureDirectory.getMembers()).flatMap((u) =>
      u.isMember && u.mail
        ? [
            {
              id: u.id,
              mail: u.mail,
              givenName: u.givenName,
              surname: u.surname,
              displayName: u.displayName,
              employeeId: u.employeeId,
              createdOn: u.createdDateTime?.slice(0, 10) ?? null,
            },
          ]
        : []
    )
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
