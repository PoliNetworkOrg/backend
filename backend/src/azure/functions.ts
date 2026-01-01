import { render, toPlainText } from "@react-email/components"
import MailComposer from "nodemailer/lib/mail-composer"
import type { JSX } from "react"
import { env } from "@/env"
import { logger } from "@/logger"
import { client } from "./client"

export async function sendEmail(to: string, subject: string, component: JSX.Element) {
  const html = await render(component)
  const text = toPlainText(html)
  const sender = env.AZURE_EMAIL_SENDER

  // To send multipart emails (both HTML and plain text) with Microsoft Graph API,
  // we need to send raw MIME content.
  const mail = new MailComposer({
    from: sender,
    to,
    subject,
    text,
    html,
  })
  const mimeMessage = await mail.compile().build()
  const base64Encoded = mimeMessage.toString("base64")

  try {
    client.api(`/users/${sender}/sendMail`).header("Content-Type", "text/plain").post(base64Encoded)
    logger.info({ subject, to }, "[Azure Graph API] Email sent")
    return true
  } catch (error) {
    logger.error({ error }, "[Azure Graph API] Could not send email")
    return false
  }
}
// /users/${this.SENDER_EMAIL}/sendMail
