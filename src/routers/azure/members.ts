import z from "zod"
import { azureDirectory } from "@/azure/directory"
import { sendCustomEmail, sendWelcomeEmail } from "@/emails/mailer"
import { logger } from "@/logger"
import { createTRPCRouter, publicProcedure } from "@/trpc"

export default createTRPCRouter({
  getAll: publicProcedure.query(async () => {
    return await azureDirectory.getMembers()
  }),
  setAssocNumber: publicProcedure
    .input(
      z.object({
        userId: z.string(),
        assocNumber: z.number(),
      })
    )
    .output(z.object({ error: z.nullable(z.string()) }))
    .mutation(async ({ input }) => {
      const { error } = await azureDirectory.setMemberNumber(input.userId, input.assocNumber)
      return { error }
    }),
  create: publicProcedure
    .input(
      z.object({
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        assocNumber: z.number(),
        sendEmailTo: z.email(),
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
    .mutation(async ({ input }) => {
      try {
        const member = await azureDirectory.createMember({
          firstName: input.firstName,
          lastName: input.lastName,
          assocNumber: input.assocNumber,
        })

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
        logger.error({ error }, "[trpc:azure:members] error in create procedure")
        return { error: error instanceof Error ? error.message : "Unknown error, see backend logs" }
      }
    }),
  sendCustomEmail: publicProcedure
    .input(
      z.object({
        userIds: z.array(z.string().min(1)),
        subject: z.string().min(1),
        body: z.string().min(1),
      })
    )
    .output(
      z.object({
        error: z.nullable(z.string()),
        total: z.number(),
        sent: z.number(),
        failed: z.array(z.object({ userId: z.string(), error: z.nullable(z.string()) })),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const members = await azureDirectory.getMembers()
        const targetMembers = members.filter((m) => input.userIds.includes(m.id))

        if (targetMembers.length === 0) {
          return { error: "No valid members found to send email", total: 0, sent: 0, failed: [] }
        }

        let sent = 0
        const failed = []

        for (const member of targetMembers) {
          if (!member.mail) {
            failed.push({ userId: member.id, error: "Member does not have an email address" })
            continue
          }

          const mailOk = await sendCustomEmail(
            member.mail,
            { subject: input.subject, body: input.body },
            member.givenName || "Member"
          )

          if (!mailOk) {
            failed.push({ userId: member.id, error: "Failed to send email" })
          } else {
            sent++
          }
        }

        return { error: null, total: targetMembers.length, sent, failed }
      } catch (error) {
        logger.error({ error }, "[trpc:azure:members] error in sendCustomEmail procedure")
        return {
          error: error instanceof Error ? error.message : "Unknown error, see backend logs",
          total: 0,
          sent: 0,
          failed: [],
        }
      }
    }),
})
