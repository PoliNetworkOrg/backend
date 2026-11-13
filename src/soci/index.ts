import { azureDirectory } from "@/azure/directory"
import { currentMember, numberHolder, rememberNumber, serializeMemberWrite } from "@/azure/member-writes"
import { DB } from "@/db"
import { sendMemberNumberChangedEmail, sendSociEmail, sendWelcomeEmail } from "@/emails/mailer"
import { env } from "@/env"
import { logger } from "@/logger"
import { createSociService } from "./service"
import { createSociPgStore } from "./store-pg"

export const soci = createSociService({
  store: createSociPgStore(DB),
  directory: azureDirectory,
  writes: { serialize: serializeMemberWrite, numberHolder, currentMember, rememberNumber },
  mail: { welcome: sendWelcomeEmail, numberChanged: sendMemberNumberChangedEmail },
  logger,
  fees: {
    bank: env.SOCI_IBAN && env.SOCI_BENEFICIARI ? { iban: env.SOCI_IBAN, beneficiary: env.SOCI_BENEFICIARI } : null,
    myAreaUrl: `${env.ESIGN_DASHBOARD_URL.replace(/\/$/, "")}/dashboard/account/me`,
    send: sendSociEmail,
  },
})
