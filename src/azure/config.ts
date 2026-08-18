import { env } from "@/env"

export type AzureCredentials = {
  tenantId: string
  clientId: string
  clientSecret: string
}

function resolveAzureCredentials(): AzureCredentials | null {
  const values = {
    tenantId: env.AZURE_TENANT_ID,
    clientId: env.AZURE_CLIENT_ID,
    clientSecret: env.AZURE_CLIENT_SECRET,
  }
  const configuredCount = Object.values(values).filter(Boolean).length

  if (configuredCount === 0) return null
  if (configuredCount !== Object.keys(values).length) {
    throw new Error("Set AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET together, or omit all three")
  }

  return values as AzureCredentials
}

export const azureCredentials = resolveAzureCredentials()
