import { azureCredentials } from "@/azure/config"
import { azureDirectory } from "@/azure/directory"
import { IncompleteMemberError } from "@/azure/errors"
import { MAIL_DOMAIN, standardLocalPart } from "@/azure/mailbox"
import { currentMember, numberHolder, rememberNumber, serializeMemberWrite } from "@/azure/member-writes"
import type { CreatedMember } from "@/azure/types"
import { sendWelcomeEmail } from "@/emails/mailer"
import { env } from "@/env"
import { fail } from "./model"
import type { Person } from "./types"

export async function provisionMember(person: Person, number: string) {
  if (!azureCredentials && env.NODE_ENV === "production")
    fail("PRECONDITION_FAILED", "Microsoft 365 provisioning is not configured")
  const assocNumber = Number(number)
  const created = await serializeMemberWrite(async () => {
    const prior = await numberHolder(assocNumber)
    if (prior) {
      if (prior.id !== person.azureId || !prior.mail)
        fail("CONFLICT", "Member number already belongs to a different Microsoft 365 account")
      return { id: prior.id, mail: prior.mail, password: null }
    }
    if (person.azureId) fail("CONFLICT", "The linked Microsoft 365 account has a different member number")
    const localPart = standardLocalPart(person.profile.firstName, person.profile.lastName)
    if (!localPart) fail("BAD_REQUEST", "This name cannot form a standard Microsoft 365 address")
    if (await azureDirectory.findByMail(`${localPart}@${MAIL_DOMAIN}`))
      fail("CONFLICT", "The Microsoft 365 address is already in use")
    let member: CreatedMember
    try {
      member = await azureDirectory.createMember({
        firstName: person.profile.firstName,
        lastName: person.profile.lastName,
        assocNumber,
        localPart,
      })
    } catch (error) {
      if (error instanceof IncompleteMemberError) rememberNumber(error.member, assocNumber, true)
      throw error
    }
    rememberNumber(
      {
        id: member.id,
        displayName: `${person.profile.firstName} ${person.profile.lastName}`,
        givenName: person.profile.firstName,
        mail: member.mail,
        employeeId: number,
      },
      assocNumber,
      true
    )
    return member
  })
  if (created.password && person.profile.personalEmail)
    await sendWelcomeEmail(
      person.profile.personalEmail,
      { email: created.mail, password: created.password },
      { firstName: person.profile.firstName, assocNumber }
    )
  return { id: created.id, email: created.mail }
}

export async function setMemberNumber(person: Person, number: string) {
  const userId = person.azureId
  if (!userId) fail("PRECONDITION_FAILED", "Microsoft 365 account is missing")
  if (!azureCredentials && env.NODE_ENV === "production") fail("PRECONDITION_FAILED", "Microsoft 365 is not configured")
  await serializeMemberWrite(async () => {
    const member = await currentMember(userId)
    if (!member) fail("PRECONDITION_FAILED", "The Microsoft 365 account no longer exists")
    const assocNumber = Number(number)
    const holder = await numberHolder(assocNumber)
    if (holder && holder.id !== userId)
      fail("CONFLICT", "Member number already belongs to another Microsoft 365 account")
    if (member.employeeId === assocNumber.toString()) return
    const result = await azureDirectory.setMemberNumber(userId, assocNumber)
    if (result.error) fail("PRECONDITION_FAILED", result.error)
    rememberNumber(member, assocNumber)
  })
}
