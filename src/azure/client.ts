import { ClientSecretCredential } from "@azure/identity"
import { Client } from "@microsoft/microsoft-graph-client"
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js"
import { logger } from "@/logger"
import { azureCredentials } from "./config"

let client: Client | undefined

export function getAzureClient(): Client {
  if (client) return client
  if (!azureCredentials) throw new Error("Azure Graph cannot be used without credentials")

  const credentials = new ClientSecretCredential(
    azureCredentials.tenantId,
    azureCredentials.clientId,
    azureCredentials.clientSecret
  )
  const authProvider = new TokenCredentialAuthenticationProvider(credentials, {
    // the scopes are configured directly on the App Registration
    // this is required by the flow to obtain those scopes
    // https://learn.microsoft.com/en-us/graph/sdks/choose-authentication-providers?tabs=typescript#using-a-client-certificate-5
    scopes: ["https://graph.microsoft.com/.default"],
  })

  client = Client.initWithMiddleware({ authProvider })
  logger.info("[Azure Graph API] Client initialized")
  return client
}
