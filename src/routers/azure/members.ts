import type { Actor } from "@polinetwork/auth-kit"
import z from "zod"
import { azureDirectory } from "@/azure/directory"
import { IncompleteMemberError } from "@/azure/errors"
import { MAIL_DOMAIN, mailboxLocalPart, mailboxSchema } from "@/azure/mailbox"
import type { CreatedMember, MemberSummary } from "@/azure/types"
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

/**
 * Runs member writes one at a time, so two requests cannot both pass the duplicate checks before either writes.
 * Entra does not enforce a unique `employeeId`, and the backend runs as a single instance.
 */
let memberWrites: Promise<unknown> = Promise.resolve()
function serializeMemberWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = memberWrites.then(task, task)
  memberWrites = run.catch(() => undefined)
  return run
}

// Keep successful writes until both directory searches and user reads can see them.
const pendingNumbers = new Map<
  number,
  { member: MemberSummary; previousNumbers: Set<string | null>; created: boolean; userVisible: boolean }
>()

function rememberNumber(member: MemberSummary, assocNumber: number, created = false) {
  const previousNumbers = new Set([member.employeeId])
  for (const [number, pending] of pendingNumbers) {
    if (pending.member.id === member.id) {
      for (const previous of pending.previousNumbers) previousNumbers.add(previous)
      previousNumbers.add(pending.member.employeeId)
      created ||= pending.created && !pending.userVisible
      pendingNumbers.delete(number)
    }
  }
  if (created) previousNumbers.add(null)
  pendingNumbers.set(assocNumber, {
    member: { ...member, employeeId: assocNumber.toString() },
    previousNumbers,
    created,
    userVisible: false,
  })
}

async function currentMember(userId: string) {
  const member = await azureDirectory.getMember(userId)
  const entry = [...pendingNumbers.entries()].find(([, pending]) => pending.member.id === userId)
  if (!entry) return member
  const [number, pending] = entry
  if (member?.employeeId === pending.member.employeeId) pending.userVisible = true
  const externalChange =
    (member === null && !pending.created) ||
    (member !== null &&
      !pending.previousNumbers.has(member.employeeId) &&
      member.employeeId !== pending.member.employeeId)
  if (pending.userVisible || externalChange) {
    // Once the user read has caught up, later edits or deletions in Entra are authoritative.
    if (member?.employeeId !== pending.member.employeeId) pendingNumbers.delete(number)
    return member
  }
  return { ...(member ?? pending.member), employeeId: pending.member.employeeId }
}

async function numberHolder(assocNumber: number) {
  const holder = await azureDirectory.findByMemberNumber(assocNumber)
  const pending = pendingNumbers.get(assocNumber)
  if (pending) {
    await currentMember(pending.member.id)
    if (!pendingNumbers.has(assocNumber)) return holder
    if (holder?.id === pending.member.id && pending.userVisible) pendingNumbers.delete(assocNumber)
    return pending.member
  }
  return holder
}

/** Entra's message when the sign-in name or an address already belongs to another object. */
function isAddressConflict(error: unknown) {
  return error instanceof Error && /same value for property (userPrincipalName|proxyAddresses)/i.test(error.message)
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
        const changed = await serializeMemberWrite(async () => {
          const member = await currentMember(input.userId)
          if (!member) return { error: "This member no longer exists in the directory." }
          if (member.employeeId === input.assocNumber.toString())
            return { error: `The member already has number ${input.assocNumber}.` }

          const holder = await numberHolder(input.assocNumber)
          if (holder && holder.id !== member.id) return { error: numberTaken(input.assocNumber, holder) }

          const { error } = await azureDirectory.setMemberNumber(member.id, input.assocNumber)
          if (error) {
            logger.error({ error, by, memberId: member.id }, "[trpc:azure:members] could not set the member number")
            return { error: "Microsoft 365 refused the change, see the backend logs." }
          }
          rememberNumber(member, input.assocNumber)
          return { error: null, member }
        })
        if (changed.error !== null) return { error: changed.error, notificationSent: null }
        const { member } = changed
        logger.info(
          {
            by,
            memberId: member.id,
            from: member.employeeId,
            to: input.assocNumber,
            notify: Boolean(input.notifyEmail),
          },
          "[AZURE] member number changed"
        )

        let notificationSent: boolean | null = null
        if (input.notifyEmail) {
          try {
            notificationSent = await sendMemberNumberChangedEmail(input.notifyEmail, {
              firstName: member.givenName,
              assocNumber: input.assocNumber,
              previousAssocNumber: member.employeeId,
              email: member.mail,
            })
          } catch (error) {
            logger.error({ error, by, memberId: member.id }, "[AZURE] member number notification failed")
            notificationSent = false
          }
        }
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
      const localPart = mailboxLocalPart(input.firstName, input.lastName, input.mailbox)
      if (localPart === null) return { error: "This name cannot form a standard address: choose a custom one." }
      const mail = `${localPart}@${MAIL_DOMAIN}`
      if (input.sendEmailTo.toLowerCase() === mail)
        return { error: "The welcome email cannot go to the address being created: it has no mailbox yet." }
      try {
        const created = await serializeMemberWrite(async () => {
          if (await azureDirectory.findByMail(mail)) return { error: `The address ${mail} is already in use.` }
          const holder = await numberHolder(input.assocNumber)
          if (holder) return { error: numberTaken(input.assocNumber, holder) }

          let member: CreatedMember
          try {
            member = await azureDirectory.createMember({
              firstName: input.firstName,
              lastName: input.lastName,
              assocNumber: input.assocNumber,
              localPart,
            })
          } catch (error) {
            if (error instanceof IncompleteMemberError) rememberNumber(error.member, input.assocNumber, true)
            throw error
          }
          rememberNumber(
            {
              id: member.id,
              displayName: `${input.firstName} ${input.lastName}`,
              givenName: input.firstName,
              mail: member.mail,
              employeeId: input.assocNumber.toString(),
            },
            input.assocNumber,
            true
          )
          return { error: null, member }
        })
        if (created.error !== null) return { error: created.error }
        const { member } = created
        logger.info({ by, memberId: member.id, assocNumber: input.assocNumber }, "[AZURE] member created")

        let mailOk = false
        try {
          mailOk = await sendWelcomeEmail(
            input.sendEmailTo,
            { email: member.mail, password: member.password },
            { firstName: input.firstName, assocNumber: input.assocNumber }
          )
        } catch (error) {
          logger.error({ error, by, memberId: member.id }, "[AZURE] welcome email failed")
        }

        return {
          error: null,
          id: member.id,
          email: member.mail,
          welcomeMailSent: mailOk,
        }
      } catch (error) {
        if (error instanceof IncompleteMemberError) {
          logger.error({ error: error.cause, by, memberId: error.member.id }, "[AZURE] member setup incomplete")
          return { error: error.message }
        }
        logger.error({ error, by, assocNumber: input.assocNumber }, "[trpc:azure:members] error in create procedure")
        if (isAddressConflict(error)) return { error: `The address ${mail} is already in use.` }
        return { error: error instanceof Error ? error.message : "Unknown error, see backend logs" }
      }
    }),
})
