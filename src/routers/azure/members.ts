import z from "zod"
import { azureDirectory } from "@/azure/directory"
import { sendWelcomeEmail } from "@/emails/mailer"
import { dashboard } from "@/idp/policies"
import { logger } from "@/logger"
import { createTRPCRouter, legacyProcedure, policy } from "@/trpc"

// Becomes the Entra display name and mail nickname.
const personName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[\p{L}\p{M}' -]+$/u, "Only letters, spaces, apostrophes and hyphens")

export default createTRPCRouter({
  getAll: legacyProcedure.query(async () => {
    return await azureDirectory.getMembers()
  }),
  setAssocNumber: legacyProcedure
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
  /**
   * The dashboard's only Azure capability (RFC v3 §4 decision 9): create a new Entra user and add
   * only that user to the fixed Soci group. No caller-supplied group or existing user.
   */
  create: policy(dashboard("azure:members:create"))
    .input(
      z.object({
        firstName: personName,
        lastName: personName,
        assocNumber: z.number().int().positive(),
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
    .mutation(async ({ input, ctx }) => {
      const by = ctx.actor?.kind === "user" ? { sub: ctx.actor.sub, client: ctx.actor.client } : { legacy: true }
      try {
        const member = await azureDirectory.createMember({
          firstName: input.firstName,
          lastName: input.lastName,
          assocNumber: input.assocNumber,
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
