import { z } from "zod"
import { azureDirectory } from "@/azure/directory"
import { createTRPCRouter, legacyProcedure } from "@/trpc"

export default createTRPCRouter({
  getAll: legacyProcedure.query(async () => {
    return await azureDirectory.getAllGroups()
  }),
  addMember: legacyProcedure
    .input(z.object({ groupId: z.string(), userId: z.string() }))
    .mutation(async ({ input }) => {
      return await azureDirectory.addGroupMember(input.groupId, input.userId)
    }),
  removeMember: legacyProcedure
    .input(z.object({ groupId: z.string(), userId: z.string() }))
    .mutation(async ({ input }) => {
      return await azureDirectory.removeGroupMember(input.groupId, input.userId)
    }),
})
