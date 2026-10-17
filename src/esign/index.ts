import { getAzureClient } from "@/azure/client"
import { azureCredentials } from "@/azure/config"
import { DB } from "@/db"
import { sendSignatureRequestEmail, sendSignedDocumentEmail } from "@/emails/mailer"
import { env } from "@/env"
import { idp } from "@/idp"
import { logger } from "@/logger"
import { createGraphDrive } from "./drive/graph"
import { createMockDrive } from "./drive/mock"
import { type Access, type AccessCatalog, createEsignService } from "./service"
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

/** The dashboard's development user (routers/esign), who holds every e-signing permission without an IdP. */
const DEV_SUB = "agent-preview-user"
const ESIGN_PERMISSIONS = ["esign:sign", "esign:requests:manage", "esign:drives:manage"]

/** Roles and permissions shown in development without an IdP, so the drive settings can be tried. */
const DEV_CATALOG: AccessCatalog = {
  roles: [
    { key: "direttivo", name: "Direttivo" },
    { key: "socio", name: "Socio" },
  ],
  permissions: ESIGN_PERMISSIONS.map((key) => ({ key, name: key })),
}

function accessOf(sub: string): Access | null {
  const index = idp?.snapshot?.current()
  if (!index)
    return env.NODE_ENV === "development" && sub === DEV_SUB
      ? { roles: ["direttivo"], permissions: ESIGN_PERMISSIONS }
      : null
  const subject = index.bySub(sub)
  return subject ? { roles: index.roles(subject), permissions: index.permissions(subject) } : null
}

function catalog(): AccessCatalog {
  const index = idp?.snapshot?.current()
  if (!index) return env.NODE_ENV === "development" ? DEV_CATALOG : { roles: [], permissions: [] }
  const { roles, permissions } = index.catalog()
  return { roles: [...roles], permissions: [...permissions] }
}

export const esign = createEsignService({
  store: createPgStore(DB),
  drives: resolveDrives(),
  mailer: { signatureRequest: sendSignatureRequestEmail, signedDocument: sendSignedDocumentEmail },
  logger,
  dashboardUrl: env.ESIGN_DASHBOARD_URL.replace(/\/$/, ""),
  allowTestCertificates: env.ESIGN_ALLOW_TEST_CERTIFICATES,
  revocation: env.ESIGN_REVOCATION,
  access: accessOf,
  catalog,
})

if (env.ESIGN_ALLOW_TEST_CERTIFICATES) logger.warn("[ESIGN] certificates not issued by the CIE CAs are accepted")
