import { render } from "@react-email/components"
import { createTestAccount, createTransport, getTestMessageUrl } from "nodemailer"
import type { JSX } from "react"
import { sendEmail as azureSendEmail, type EmailAttachment, type EmailOptions } from "@/azure/functions/emails"
import { env } from "@/env"
import type { RequestUpdate } from "@/esign/service"
import { logger } from "@/logger"
import MemberNumberChanged from "./templates/member-number-changed"
import RequestUpdateEmail, { requestUpdateSubject } from "./templates/request-update"
import SignatureRequestEmail from "./templates/signature-request"
import SignedDocumentEmail, { type SignedDocumentProps } from "./templates/signed-document"
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
  attachments: EmailAttachment[] = [],
  options: EmailOptions = {}
) {
  const html = await render(component)
  const res = await transporter.sendMail({
    to,
    replyTo: options.replyTo,
    subject,
    html,
    attachments: attachments.map((a) => ({ ...a, content: Buffer.from(a.content) })),
  })
  logger.info(`[EMAIL] new email, click to see: ${getTestMessageUrl(res)}`)
  return true
}

const sendEmail = env.NODE_ENV === "development" && env.USE_DEV_MAILER ? devSendMail : azureSendEmail

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

export async function sendMemberNumberChangedEmail(
  toAddress: string,
  memberInfo: {
    firstName: string | null
    assocNumber: number
    previousAssocNumber: string | null
    email: string | null
  }
) {
  const subject = makeSubject("Your PoliNetwork member number has changed")
  return sendEmail(
    toAddress,
    subject,
    <MemberNumberChanged
      firstName={memberInfo.firstName}
      assocNum={memberInfo.assocNumber}
      previousAssocNum={memberInfo.previousAssocNumber}
      email={memberInfo.email}
    />
  )
}

export async function sendSignatureRequestEmail(
  toAddress: string,
  props: {
    signerName: string
    requestedBy: string
    title: string
    role: string | null
    ordered: boolean
    url: string
    setupUrl: string
  }
) {
  return sendEmail(toAddress, makeSubject(`Signature needed: ${props.title}`), <SignatureRequestEmail {...props} />)
}

export async function sendRequestUpdateEmail(toAddress: string, props: RequestUpdate) {
  return sendEmail(toAddress, makeSubject(requestUpdateSubject(props)), <RequestUpdateEmail {...props} />)
}

/** In Italian: it goes to offices and people outside PoliNetwork. Replies reach whoever sent the request. */
export async function sendSignedDocumentEmail(
  to: string[],
  props: SignedDocumentProps,
  attachment: EmailAttachment | null
) {
  const { sentBy } = props
  return sendEmail(
    to,
    makeSubject(`Documento firmato: ${props.title}`),
    <SignedDocumentEmail {...props} />,
    attachment ? [attachment] : [],
    sentBy?.email ? { replyTo: { name: sentBy.name, address: sentBy.email } } : {}
  )
}
