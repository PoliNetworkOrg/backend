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
        userId: z.string(),
        subject: z.string().min(1),
        body: z.string().min(1),
      })
    )
    .output(z.object({ error: z.nullable(z.string()) }))
    .mutation(async ({ input }) => {
      try {
        const members = await azureDirectory.getMembers()
    const member = members.find(m => m.id === input.userId)
        if (!member || !member.isMember) {
          return { error: "Member not found or not a associated member" }
        }

        if (!member.mail) {
          return { error: "Member does not have an email address" }
        }

        const mailOk = await sendCustomEmail(
          member.mail, 
          { subject: input.subject,
          body: input.body,
          },
          member.givenName || member.displayName || "Member" // tod osk difference
      )
      

        if (!mailOk) {
          return { error: "Failed to send email" }
        }

        return { error: null }
      } catch (error) {
        logger.error({ error }, "[trpc:azure:members] error in sendCustomEmail procedure")
        return { error: error instanceof Error ? error.message : "Unknown error, see backend logs" }
      }
    })
    
})


