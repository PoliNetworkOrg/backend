import { getAzureClient } from "@/azure/client"
import { azureCredentials } from "@/azure/config"
import { DB } from "@/db"
import { sendSignatureRequestEmail, sendSignedDocumentEmail } from "@/emails/mailer"
import { env } from "@/env"
import { logger } from "@/logger"
import { createGraphDrive } from "./drive/graph"
import { createMockDrive } from "./drive/mock"
import type { Drive } from "./drive/types"
import { createEsignService } from "./service"
import { createPgStore } from "./store-pg"

function resolveDrive(): Drive | null {
  if (!azureCredentials) {
    // The in-memory drive forgets uploads on restart: never let production report deliveries to it.
    if (env.NODE_ENV === "production") {
      logger.warn("[ESIGN] Azure credentials are not set: signed documents stay in the dashboard only")
      return null
    }
    logger.warn("[ESIGN] Azure credentials are not set, using the in-memory development drive")
    return createMockDrive()
  }
  if (!env.ESIGN_DRIVE_ID) {
    logger.warn("[ESIGN] ESIGN_DRIVE_ID is not set: signed documents stay in the dashboard only")
    return null
  }
  return createGraphDrive({
    client: getAzureClient,
    driveId: env.ESIGN_DRIVE_ID,
    rootId: env.ESIGN_DRIVE_ROOT_ID,
    label: env.ESIGN_DRIVE_LABEL,
  })
}

export const esign = createEsignService({
  store: createPgStore(DB),
  drive: resolveDrive(),
  mailer: { signatureRequest: sendSignatureRequestEmail, signedDocument: sendSignedDocumentEmail },
  logger,
  dashboardUrl: env.ESIGN_DASHBOARD_URL.replace(/\/$/, ""),
  allowTestCertificates: env.ESIGN_ALLOW_TEST_CERTIFICATES,
  revocation: env.ESIGN_REVOCATION,
})

if (env.ESIGN_ALLOW_TEST_CERTIFICATES) logger.warn("[ESIGN] certificates not issued by the CIE CAs are accepted")
