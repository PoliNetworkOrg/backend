import { z } from "zod"
import { addGroupMember, getAllGroups, removeGroupMember } from "@/azure/functions/groups"
import { createTRPCRouter, publicProcedure } from "@/trpc"

export default createTRPCRouter({
  getAll: publicProcedure.query(async () => {
    return await getAllGroups()
  }),
  addMember: publicProcedure
    .input(z.object({ groupId: z.string(), userId: z.string() }))
    .mutation(async ({ input }) => {
      return await addGroupMember(input.groupId, input.userId)
    }),
  removeMember: publicProcedure
    .input(z.object({ groupId: z.string(), userId: z.string() }))
    .mutation(async ({ input }) => {
      return await removeGroupMember(input.groupId, input.userId)
    }),
})
