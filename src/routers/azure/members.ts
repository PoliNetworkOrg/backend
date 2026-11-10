import { azureDirectory } from "@/azure/directory"
import { dashboard } from "@/idp/policies"
import { createTRPCRouter, policy } from "@/trpc"

/**
 * Read-only. Admitting a socio and changing a member number are `soci.members.admit` and `soci.members.setNumber`,
 * which keep the Libro Soci in step with Microsoft 365.
 */
export default createTRPCRouter({
  getAll: policy(dashboard("azure:members:read")).query(async () => {
    return await azureDirectory.getMembers()
  }),
})
