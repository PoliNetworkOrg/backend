import { render, toPlainText } from "@react-email/components"
// import nodemailer from "nodemailer"
import MailComposer from "nodemailer/lib/mail-composer"
import type { JSX } from "react"
import { env } from "@/env"
import { logger } from "@/logger"
import { client } from "./client"

// Create a local transporter for Mailpit
// const localTransporter = nodemailer.createTransport({
//   host: "localhost",
//   port: 1035,
//   secure: false,
// })

export async function sendEmail(to: string, subject: string, component: JSX.Element) {
  const html = await render(component)
  const text = toPlainText(html, {
    selectors: [
      { selector: '*[style*="display:none"i]', format: "skip" }, // prevent duplicate text
    ],
  })
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
    await client.api(`/users/${sender}/sendMail`).header("Content-Type", "text/plain").post(base64Encoded)
    logger.info({ subject, to }, "[Azure Graph API] Email sent")

    // localTransporter
    //   .sendMail({
    //     from: sender,
    //     to,
    //     subject,
    //     text,
    //     html,
    //   })
    //   .then(() => logger.info({ subject, to }, "[Mailpit] Local email captured"))
    //   .catch((err) => logger.error({ err }, "[Mailpit] Error while sending email"))

    return true
  } catch (error) {
    logger.error({ error }, "[Azure Graph API] Could not send email")
    return false
  }
}
