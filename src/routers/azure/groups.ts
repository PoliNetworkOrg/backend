import { azureDirectory } from "@/azure/directory"
import { dashboard } from "@/idp/policies"
import { createTRPCRouter, policy } from "@/trpc"

/**
 * Read-only. Group membership is never changed through the API (RFC v3 §4 decision 9): the only group write is
 * `azure.members.create` adding the user it just created to Soci, from which the IdP derives the Socio role.
 */
export default createTRPCRouter({
  getAll: policy(dashboard("azure:groups:read")).query(async () => {
    return await azureDirectory.getAllGroups()
  }),
})
