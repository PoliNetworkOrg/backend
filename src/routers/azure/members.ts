import z from "zod"
import { createMember, getMembers, setMemberNumber } from "@/azure/functions/members"
import { sendWelcomeEmail } from "@/emails/mailer"
import { logger } from "@/logger"
import { createTRPCRouter, publicProcedure } from "@/trpc"

export default createTRPCRouter({
  getAll: publicProcedure.query(async () => {
    return await getMembers()
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
      const { error } = await setMemberNumber(input.userId, input.assocNumber)
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
        const member = await createMember({
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
})
