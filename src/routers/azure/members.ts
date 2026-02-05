import z from "zod"
import { createMember, getMembers } from "@/azure/functions"
import { sendWelcomeEmail } from "@/emails/mailer"
import { createTRPCRouter, publicProcedure } from "@/trpc"

export default createTRPCRouter({
  getAll: publicProcedure.query(async () => {
    const res = await getMembers()
    return res ?? []
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
      } catch (err) {
        console.error(err)
        return { error: JSON.stringify(err) }
      }
    }),
})
