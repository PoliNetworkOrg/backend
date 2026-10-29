import { DB } from "@/db"
import { sendPeopleEmail } from "@/emails/mailer"
import { env } from "@/env"
import { idp } from "@/idp"
import { fail } from "./model"
import { createPeopleService } from "./service"
import { createPeoplePgStore } from "./store-pg"

export const people = createPeopleService({
  store: createPeoplePgStore(DB),
  dashboardUrl: env.ESIGN_DASHBOARD_URL.replace(/\/$/, ""),
  async directory() {
    if (!idp?.directory) fail("PRECONDITION_FAILED", "The IdP account directory is not configured")
    return (await idp.directory()).map((a) => ({
      ...a,
      telegramId: idp?.snapshot?.current()?.bySub(a.sub)?.telegramId ?? null,
    }))
  },
  sendMail: sendPeopleEmail,
})
