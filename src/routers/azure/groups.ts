import { z } from "zod"
import { azureDirectory } from "@/azure/directory"
import { dashboard } from "@/idp/policies"
import { createTRPCRouter, policy } from "@/trpc"

export default createTRPCRouter({
  getAll: policy(dashboard("azure:groups:read")).query(async () => {
    return await azureDirectory.getAllGroups()
  }),
  addMember: policy(dashboard("azure:groups:write"))
    .input(z.object({ groupId: z.string(), userId: z.string() }))
    .mutation(async ({ input }) => {
      return await azureDirectory.addGroupMember(input.groupId, input.userId)
    }),
  removeMember: policy(dashboard("azure:groups:write"))
    .input(z.object({ groupId: z.string(), userId: z.string() }))
    .mutation(async ({ input }) => {
      return await azureDirectory.removeGroupMember(input.groupId, input.userId)
    }),
})
