import { z } from "zod"
import { azureDirectory } from "@/azure/directory"
import { createTRPCRouter, publicProcedure } from "@/trpc"

export default createTRPCRouter({
  getAll: publicProcedure.query(async () => {
    return await azureDirectory.getAllGroups()
  }),
  addMember: publicProcedure
    .input(z.object({ groupId: z.string(), userId: z.string() }))
    .mutation(async ({ input }) => {
      return await azureDirectory.addGroupMember(input.groupId, input.userId)
    }),
  removeMember: publicProcedure
    .input(z.object({ groupId: z.string(), userId: z.string() }))
    .mutation(async ({ input }) => {
      return await azureDirectory.removeGroupMember(input.groupId, input.userId)
    }),
})
