import { getAzureClient } from "@/azure/client"
import { azureCredentials } from "@/azure/config"
import { DB } from "@/db"
import { sendSignatureRequestEmail, sendSignedDocumentEmail } from "@/emails/mailer"
import { env } from "@/env"
import { logger } from "@/logger"
import { createGraphDrive } from "./drive/graph"
import { createMockDrive } from "./drive/mock"
import { createEsignService } from "./service"
import { createPgStore } from "./store-pg"

function resolveDrives() {
  if (!azureCredentials) {
    // The in-memory drives forget uploads on restart: never let production report deliveries to them.
    if (env.NODE_ENV === "production") {
      logger.warn("[ESIGN] Azure credentials are not set: signed documents stay in the dashboard only")
      return []
    }
    logger.warn("[ESIGN] Azure credentials are not set, using in-memory development drives")
    return [createMockDrive(), createMockDrive({ id: "dev-archive", label: "Archive (development copy)" })]
  }
  if (env.ESIGN_DRIVES.length === 0)
    logger.warn("[ESIGN] ESIGN_DRIVES is empty: signed documents stay in the dashboard only")
  return env.ESIGN_DRIVES.map((drive) => createGraphDrive({ client: getAzureClient, ...drive }))
}

export const esign = createEsignService({
  store: createPgStore(DB),
  drives: resolveDrives(),
  mailer: { signatureRequest: sendSignatureRequestEmail, signedDocument: sendSignedDocumentEmail },
  logger,
  dashboardUrl: env.ESIGN_DASHBOARD_URL.replace(/\/$/, ""),
  allowTestCertificates: env.ESIGN_ALLOW_TEST_CERTIFICATES,
  revocation: env.ESIGN_REVOCATION,
})

if (env.ESIGN_ALLOW_TEST_CERTIFICATES) logger.warn("[ESIGN] certificates not issued by the CIE CAs are accepted")
