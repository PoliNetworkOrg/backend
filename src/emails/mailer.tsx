import { render } from "@react-email/components"
import { createTestAccount, createTransport, getTestMessageUrl } from "nodemailer"
import type { JSX } from "react"
import { sendEmail as azureSendEmail, type EmailAttachment } from "@/azure/functions/emails"
import { env } from "@/env"
import { logger } from "@/logger"
import OtpEmail from "./templates/otp"
import SignatureRequestEmail from "./templates/signature-request"
import SignedDocumentEmail from "./templates/signed-document"
import Welcome from "./templates/welcome"

const makeSubject = (subject: string) => (env.NODE_ENV === "development" ? `[DEV] ${subject}` : subject)

const testAccount = await createTestAccount()
const transporter = createTransport({
  host: testAccount.smtp.host,
  port: testAccount.smtp.port,
  secure: testAccount.smtp.secure,
  auth: {
    user: testAccount.user,
    pass: testAccount.pass,
  },
})

async function devSendMail(
  to: string | string[],
  subject: string,
  component: JSX.Element,
  attachments: EmailAttachment[] = []
) {
  const html = await render(component)
  const res = await transporter.sendMail({
    to,
    subject,
    html,
    attachments: attachments.map((a) => ({ ...a, content: Buffer.from(a.content) })),
  })
  logger.info(`[EMAIL] new email, click to see: ${getTestMessageUrl(res)}`)
  return true
}

const sendEmail = env.NODE_ENV === "development" && env.USE_DEV_MAILER ? devSendMail : azureSendEmail

export async function sendLoginOtpEmail(toAddress: string, otp: string, expiresInMinutes?: number) {
  const subject = makeSubject("Your login code for PoliNetwork")
  return sendEmail(toAddress, subject, <OtpEmail otp={otp} expiresInMinutes={expiresInMinutes} />)
}

export async function sendWelcomeEmail(
  toAddress: string,
  accountCredentials: { email: string; password: string },
  memberInfo: { firstName: string; assocNumber: number }
) {
  const subject = makeSubject("Welcome to PoliNetwork!")
  return sendEmail(
    toAddress,
    subject,
    <Welcome
      email={accountCredentials.email}
      password={accountCredentials.password}
      assocNum={memberInfo.assocNumber}
      firstName={memberInfo.firstName}
    />
  )
}

export async function sendSignatureRequestEmail(
  toAddress: string,
  props: { signerName: string; requestedBy: string; title: string; role: string | null; url: string }
) {
  return sendEmail(toAddress, makeSubject(`Signature needed: ${props.title}`), <SignatureRequestEmail {...props} />)
}

export async function sendSignedDocumentEmail(
  to: string[],
  props: {
    title: string
    signers: { name: string; role: string | null }[]
    message: string | null
    link: string | null
  },
  attachment: EmailAttachment | null
) {
  return sendEmail(
    to,
    makeSubject(`Signed: ${props.title}`),
    <SignedDocumentEmail {...props} />,
    attachment ? [attachment] : []
  )
}
