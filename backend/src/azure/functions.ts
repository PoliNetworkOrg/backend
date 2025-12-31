import { render } from "@react-email/components"
import type { JSX } from "react"
import { env } from "@/env"
import { logger } from "@/logger"
import { client } from "./client"

export async function sendEmail(to: string, subject: string, component: JSX.Element) {
  const html = await render(component)
  const sender = env.AZURE_EMAIL_SENDER

  try {
    client.api(`/users/${sender}/sendMail`).post({
      message: {
        subject,
        body: { contentType: "HTML", content: html },
        toRecipients: [{ emailAddress: { address: to } }],
      },
    })
    logger.info({ subject, to }, "[Azure Graph API] Email sent")
    return true
  } catch (error) {
    logger.error({ error }, "[Azure Graph API] Could not send email")
    return false
  }
}
// /users/${this.SENDER_EMAIL}/sendMail
