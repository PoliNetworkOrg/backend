import { render, toPlainText } from "@react-email/components"
import MailComposer from "nodemailer/lib/mail-composer/index.js"
import type { JSX } from "react"
import { env } from "@/env"
import { logger } from "@/logger"
import { getAzureClient } from "../client"

export type EmailAttachment = { filename: string; content: Uint8Array; contentType: string }

/** Where replies go instead of the sender's mailbox. */
export type EmailOptions = { replyTo?: { name: string; address: string } }

export async function sendEmail(
  to: string | string[],
  subject: string,
  component: JSX.Element,
  attachments: EmailAttachment[] = [],
  options: EmailOptions = {}
) {
  const html = await render(component)
  const text = toPlainText(html, {
    selectors: [
      { selector: '*[style*="display:none"i]', format: "skip" }, // prevent duplicate text
    ],
  })
  const sender = encodeURIComponent(env.AZURE_EMAIL_SENDER)

  // To send multipart emails (both HTML and plain text) with Microsoft Graph API,
  // we need to send raw MIME content.
  const mail = new MailComposer({
    from: sender,
    to,
    replyTo: options.replyTo,
    subject,
    text,
    html,
    attachments: attachments.map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.content),
      contentType: a.contentType,
    })),
  })
  const mimeMessage = await mail.compile().build()
  const base64Encoded = mimeMessage.toString("base64")

  try {
    const client = getAzureClient()
    await client.api(`/users/${sender}/sendMail`).header("Content-Type", "text/plain").post(base64Encoded)
    logger.info({ subject, to }, "[Azure Graph API] Email sent")

    return true
  } catch (error) {
    logger.error({ error }, "[Azure Graph API] Could not send email")
    return false
  }
}
