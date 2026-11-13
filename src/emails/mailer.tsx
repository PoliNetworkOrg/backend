import { render } from "@react-email/components"
import { createTestAccount, createTransport, getTestMessageUrl } from "nodemailer"
import type { JSX } from "react"
import { sendEmail as azureSendEmail, type EmailAttachment, type EmailOptions } from "@/azure/functions/emails"
import { env } from "@/env"
import type { RequestUpdate } from "@/esign/service"
import { logger } from "@/logger"
import type { SociMail } from "@/soci/types"
import FeeConfirmedEmail, { feeConfirmedSubject } from "./templates/fee-confirmed"
import FeeOpeningEmail, { feeOpeningSubject } from "./templates/fee-opening"
import FeeRejectedEmail, { feeRejectedSubject } from "./templates/fee-rejected"
import FeeReminderEmail, { feeReminderSubject } from "./templates/fee-reminder"
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

/** People retains the provider's error and records a stable Message-ID for delivery reconciliation. */
export async function sendPeopleEmail(input: { id: string; to: string; subject: string; text: string }) {
  const component = <div style={{ whiteSpace: "pre-wrap" }}>{input.text}</div>
  if (env.NODE_ENV === "development" && env.USE_DEV_MAILER) {
    await devSendMail(input.to, input.subject, component)
  } else {
    await azureSendEmail(input.to, input.subject, component, [], {
      throwOnError: true,
      messageId: `<people-${Buffer.from(input.id).toString("base64url")}@polinetwork.org>`,
    })
  }
}

const FEE_EMAILS = {
  opening: { subject: feeOpeningSubject, Template: FeeOpeningEmail },
  reminder: { subject: feeReminderSubject, Template: FeeReminderEmail },
  confirmed: { subject: feeConfirmedSubject, Template: FeeConfirmedEmail },
  rejected: { subject: feeRejectedSubject, Template: FeeRejectedEmail },
} satisfies Record<SociMail["kind"], unknown>

/** Soci's outbox: throws on failure, and gives each email a stable Message-ID from its idempotency key. */
export async function sendSociEmail(mail: SociMail) {
  const { subject, Template } = FEE_EMAILS[mail.kind]
  const component = <Template {...mail.data} />
  if (env.NODE_ENV === "development" && env.USE_DEV_MAILER) {
    await devSendMail(mail.to, makeSubject(subject(mail.data)), component)
  } else {
    await azureSendEmail(mail.to, makeSubject(subject(mail.data)), component, [], {
      throwOnError: true,
      messageId: `<soci-${Buffer.from(mail.id).toString("base64url")}@polinetwork.org>`,
    })
  }
}
