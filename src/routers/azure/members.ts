import type { Actor } from "@polinetwork/auth-kit"
import z from "zod"
import { azureDirectory } from "@/azure/directory"
import { MAIL_DOMAIN, mailboxLocalPart, mailboxSchema } from "@/azure/mailbox"
import type { MemberSummary } from "@/azure/types"
import { sendMemberNumberChangedEmail, sendWelcomeEmail } from "@/emails/mailer"
import { dashboard } from "@/idp/policies"
import { logger } from "@/logger"
import { createTRPCRouter, policy } from "@/trpc"

// Becomes the Entra display name and mail nickname.
const personName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[\p{L}\p{M}' -]+$/u, "Only letters, spaces, apostrophes and hyphens")

function auditActor(actor: Actor | null) {
  return actor?.kind === "user" ? { sub: actor.sub, client: actor.client } : { legacy: true }
}

function numberTaken(assocNumber: number, holder: MemberSummary) {
  return `Member number ${assocNumber} is already assigned to ${holder.displayName ?? holder.mail ?? "another user"}.`
}

export default createTRPCRouter({
  getAll: policy(dashboard("azure:members:read")).query(async () => {
    return await azureDirectory.getMembers()
  }),
  /**
   * Change the member number (`employeeId`) of an existing user, refusing a number another user holds, and
   * optionally email the new number. Token callers only: it can send mail to a caller-supplied address.
   */
  setAssocNumber: policy(dashboard("azure:members:write"), { tokenOnly: true })
    .input(
      z.object({
        userId: z.string().min(1),
        assocNumber: z.number().int().positive(),
        notifyEmail: z.email().optional(),
      })
    )
    .output(z.object({ error: z.nullable(z.string()), notificationSent: z.nullable(z.boolean()) }))
    .mutation(async ({ input, ctx }) => {
      const by = auditActor(ctx.actor)
      try {
        const member = await azureDirectory.getMember(input.userId)
        if (!member) return { error: "This member no longer exists in the directory.", notificationSent: null }
        if (member.employeeId === input.assocNumber.toString())
          return { error: `The member already has number ${input.assocNumber}.`, notificationSent: null }

        const holder = await azureDirectory.findByMemberNumber(input.assocNumber)
        if (holder && holder.id !== member.id)
          return { error: numberTaken(input.assocNumber, holder), notificationSent: null }

        const { error } = await azureDirectory.setMemberNumber(member.id, input.assocNumber)
        if (error) {
          logger.error({ error, by, memberId: member.id }, "[trpc:azure:members] could not set the member number")
          return { error: "Microsoft 365 refused the change, see the backend logs.", notificationSent: null }
        }
        logger.info(
          { by, memberId: member.id, from: member.employeeId, to: input.assocNumber, notifyEmail: input.notifyEmail },
          "[AZURE] member number changed"
        )

        const notificationSent = input.notifyEmail
          ? await sendMemberNumberChangedEmail(input.notifyEmail, {
              firstName: member.givenName,
              assocNumber: input.assocNumber,
              previousAssocNumber: member.employeeId,
              email: member.mail,
            })
          : null
        return { error: null, notificationSent }
      } catch (error) {
        logger.error({ error, by, userId: input.userId }, "[trpc:azure:members] error in setAssocNumber procedure")
        return {
          error: error instanceof Error ? error.message : "Unknown error, see backend logs",
          notificationSent: null,
        }
      }
    }),
  /**
   * Create a new Entra user and add only that user to the fixed Soci group (RFC v3 §4 decision 9). No
   * caller-supplied group or existing user. The address is `firstname.lastname` unless a custom one is chosen.
   */
  create: policy(dashboard("azure:members:create"))
    .input(
      z.object({
        firstName: personName,
        lastName: personName,
        assocNumber: z.number().int().positive(),
        sendEmailTo: z.email(),
        mailbox: mailboxSchema.default({ kind: "standard" }),
      })
    )
    .output(
      z.union([
        z.object({ error: z.string() }),
        z.object({
          error: z.null(),
          id: z.string(),
          email: z.email(),
          welcomeMailSent: z.boolean(),
        }),
      ])
    )
    .mutation(async ({ input, ctx }) => {
      const by = auditActor(ctx.actor)
      try {
        const localPart = mailboxLocalPart(input.firstName, input.lastName, input.mailbox)
        if (localPart === null) return { error: "This name cannot form a standard address: choose a custom one." }
        const mail = `${localPart}@${MAIL_DOMAIN}`
        if (input.sendEmailTo.toLowerCase() === mail)
          return { error: "The welcome email cannot go to the address being created: it has no mailbox yet." }
        if (await azureDirectory.findByMail(mail)) return { error: `The address ${mail} is already in use.` }
        const holder = await azureDirectory.findByMemberNumber(input.assocNumber)
        if (holder) return { error: numberTaken(input.assocNumber, holder) }

        const member = await azureDirectory.createMember({
          firstName: input.firstName,
          lastName: input.lastName,
          assocNumber: input.assocNumber,
          localPart,
        })
        logger.info({ by, memberId: member.id, assocNumber: input.assocNumber }, "[AZURE] member created")

        const mailOk = await sendWelcomeEmail(
          input.sendEmailTo,
          { email: member.mail, password: member.password },
          {
            firstName: input.firstName,
            assocNumber: input.assocNumber,
          }
        )

        return {
          error: null,
          id: member.id,
          email: member.mail,
          welcomeMailSent: mailOk,
        }
      } catch (error) {
        logger.error({ error, by, assocNumber: input.assocNumber }, "[trpc:azure:members] error in create procedure")
        return { error: error instanceof Error ? error.message : "Unknown error, see backend logs" }
      }
    }),
})
