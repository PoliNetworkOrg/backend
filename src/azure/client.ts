import { ClientSecretCredential } from "@azure/identity"
import { Client, type GraphError } from "@microsoft/microsoft-graph-client"
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js"
import type { Organization } from "@microsoft/microsoft-graph-types"
import { env } from "@/env"
import { logger } from "@/logger"

const credentials = new ClientSecretCredential(env.AZURE_TENANT_ID, env.AZURE_CLIENT_ID, env.AZURE_CLIENT_SECRET)

const authProvider = new TokenCredentialAuthenticationProvider(credentials, {
  // the scopes are configured directly on the App Registration
  // this is required by the flow to obtain those scopes
  // https://learn.microsoft.com/en-us/graph/sdks/choose-authentication-providers?tabs=typescript#using-a-client-certificate-5
  scopes: ["https://graph.microsoft.com/.default"],
})

export const client = Client.initWithMiddleware({ authProvider })

// test request -- void because we do not want to wait
void client
  .api(`/organization/${env.AZURE_TENANT_ID}`)
  .get()
  .then((r: Organization) => logger.info({ orgName: r.displayName }, "[Azure Graph API] Client connected successfully"))
  .catch((e: GraphError) => {
    if (e.code === "AuthenticationRequiredError")
      logger.error({ error: e.message }, "[Azure Graph API] Authentication failed, check credentials")
    else logger.error({ error: e }, "[Azure Graph API] Error on TEST request")
  })
