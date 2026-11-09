import { azureDirectory } from "@/azure/directory"
import { currentMember, numberHolder, rememberNumber, serializeMemberWrite } from "@/azure/member-writes"
import { DB } from "@/db"
import { sendMemberNumberChangedEmail, sendWelcomeEmail } from "@/emails/mailer"
import { logger } from "@/logger"
import { createSociService } from "./service"
import { createSociPgStore } from "./store-pg"

export const soci = createSociService({
  store: createSociPgStore(DB),
  directory: azureDirectory,
  writes: { serialize: serializeMemberWrite, numberHolder, currentMember, rememberNumber },
  mail: { welcome: sendWelcomeEmail, numberChanged: sendMemberNumberChangedEmail },
  logger,
})
