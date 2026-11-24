import { createTestAccount, createTransport, getTestMessageUrl } from "nodemailer"
import type { JSX } from "react"
import { sendEmail as azureSendEmail, type EmailAttachment, type EmailOptions } from "@/azure/functions/emails"
import { env } from "@/env"
import type { RequestUpdate } from "@/esign/service"
import { logger } from "@/logger"
import type { FeeMailKind, SociMail } from "@/soci/types"
import { renderEmail } from "./render"
import type { SecretSantaEmailRequest } from "./secret-santa-routes"
import AssociationEventEmail, { type AssociationEventProps } from "./templates/association-event"
import AssociationPromotionEmail, { type AssociationPromotionProps } from "./templates/association-promotion"
import BirthdayEmail, { birthdaySubject } from "./templates/birthday"
import FeeConfirmedEmail, { feeConfirmedSubject } from "./templates/fee-confirmed"
import FeeOpeningEmail, { feeOpeningSubject } from "./templates/fee-opening"
import FeeRejectedEmail, { feeRejectedSubject } from "./templates/fee-rejected"
import FeeReminderEmail, { feeReminderSubject } from "./templates/fee-reminder"
import MemberNumberChanged, { memberNumberChangedSubject } from "./templates/member-number-changed"
import RegulationDelegaEmail, { delegaSubject, type RegulationDelegaProps } from "./templates/regulation-delega"
import RegulationEmanatedEmail, { type RegulationEmanatedProps } from "./templates/regulation-emanated"
import RequestUpdateEmail, { requestUpdateSubject } from "./templates/request-update"
import SecretSantaEmail, { secretSantaSubject } from "./templates/secret-santa"
import SecretSantaConfirmationEmail, { secretSantaConfirmationSubject } from "./templates/secret-santa-confirmation"
import SecretSantaReassignedEmail, { secretSantaReassignedSubject } from "./templates/secret-santa-reassigned"
import SignatureRequestEmail, { signatureRequestSubject } from "./templates/signature-request"
import SignedDocumentEmail, { type SignedDocumentProps } from "./templates/signed-document"
import Welcome, { welcomeSubject } from "./templates/welcome"

const makeSubject = (subject: string) => (env.NODE_ENV === "development" ? `[DEV] ${subject}` : subject)

export async function sendSecretSantaEmail(mail: SecretSantaEmailRequest) {
  let subject: string
  let component: JSX.Element
  if (mail.kind === "draw") {
    subject = secretSantaSubject(mail)
    component = <SecretSantaEmail {...mail} />
  } else if (mail.kind === "reassigned") {
    subject = secretSantaReassignedSubject(mail)
    component = <SecretSantaReassignedEmail {...mail} />
  } else {
    subject = secretSantaConfirmationSubject(mail)
    component = <SecretSantaConfirmationEmail {...mail} />
  }
  if (env.NODE_ENV === "development" && env.USE_DEV_MAILER) {
    await devSendMail(mail.to, makeSubject(subject), component)
  } else {
    await azureSendEmail(mail.to, makeSubject(subject), component, [], {
      throwOnError: true,
      messageId: `<secret-santa-${Buffer.from(mail.id).toString("base64url")}@polinetwork.org>`,
    })
  }
}

async function createDevTransport() {
  const account = await createTestAccount()
  return createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: { user: account.user, pass: account.pass },
  })
}

let devTransport: ReturnType<typeof createDevTransport> | undefined

async function devSendMail(
  to: string | string[],
  subject: string,
  component: JSX.Element,
  attachments: EmailAttachment[] = [],
  options: EmailOptions = {}
) {
  const { html, text, inlineImages } = await renderEmail(component)
  devTransport ??= createDevTransport()
  const transporter = await devTransport
  const res = await transporter.sendMail({
    from: options.from,
    to,
    cc: options.cc?.length ? options.cc : undefined,
    replyTo: options.replyTo,
    subject,
    html,
    text,
    attachments: [...inlineImages, ...attachments.map((a) => ({ ...a, content: Buffer.from(a.content) }))],
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
  const subject = makeSubject(welcomeSubject)
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
  const subject = makeSubject(memberNumberChangedSubject)
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
  return sendEmail(toAddress, makeSubject(signatureRequestSubject(props)), <SignatureRequestEmail {...props} />)
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
} satisfies Record<FeeMailKind, unknown>

/** Soci's outbox: throws on failure, and gives each email a stable Message-ID from its idempotency key. */
export async function sendSociEmail(mail: SociMail) {
  let subject: string
  let component: JSX.Element
  if (mail.kind === "birthday") {
    subject = birthdaySubject(mail.data)
    component = <BirthdayEmail {...mail.data} />
  } else {
    const { subject: subjectOf, Template } = FEE_EMAILS[mail.kind]
    subject = subjectOf(mail.data)
    component = <Template {...mail.data} />
  }
  if (env.NODE_ENV === "development" && env.USE_DEV_MAILER) {
    await devSendMail(mail.to, makeSubject(subject), component)
  } else {
    await azureSendEmail(mail.to, makeSubject(subject), component, [], {
      throwOnError: true,
      messageId: `<soci-${Buffer.from(mail.id).toString("base64url")}@polinetwork.org>`,
    })
  }
}

/** Regulations: errors propagate, so the notification record says why it failed and the emanation retries. */
async function sendRegulationsMail(
  to: string | string[],
  subject: string,
  component: JSX.Element,
  attachments: EmailAttachment[],
  options: EmailOptions
) {
  if (env.NODE_ENV === "development" && env.USE_DEV_MAILER)
    await devSendMail(to, subject, component, attachments, options)
  else await azureSendEmail(to, subject, component, attachments, { ...options, throwOnError: true })
}

export async function sendRegulationEmanatedEmail(
  input: { to: string; cc?: string[]; from?: string; replyTo?: { name: string; address: string }; messageId: string },
  props: RegulationEmanatedProps,
  attachments: EmailAttachment[]
) {
  await sendRegulationsMail(
    input.to,
    makeSubject(`${props.documentTitle}: nuova versione ${props.tag}`),
    <RegulationEmanatedEmail {...props} />,
    attachments,
    { from: input.from, cc: input.cc, replyTo: input.replyTo, messageId: input.messageId }
  )
}

export async function sendRegulationDelegaEmail(
  input: { to: string; from?: string; messageId: string },
  props: RegulationDelegaProps
) {
  await sendRegulationsMail(input.to, makeSubject(delegaSubject(props)), <RegulationDelegaEmail {...props} />, [], {
    from: input.from,
    messageId: input.messageId,
  })
}

type AssociationMail = {
  id: string
  to: string
  subject: string
  text: string
  template?: { kind: string; props: { [key: string]: string | null } }
}
/** Templates the association outbox can name; an unknown or missing one falls back to the plain text. */
function associationComponent(mail: AssociationMail): JSX.Element {
  // SAFETY: the registry service writes these props for exactly this template kind (`promotions.ts`).
  if (mail.template?.kind === "association-promotion")
    return <AssociationPromotionEmail {...(mail.template.props as unknown as AssociationPromotionProps)} />
  // SAFETY: written by `events.ts` for exactly this template kind.
  if (mail.template?.kind === "association-event")
    return <AssociationEventEmail {...(mail.template.props as unknown as AssociationEventProps)} />
  return (
    <div>
      <h1>{mail.subject}</h1>
      <p style={{ whiteSpace: "pre-line" }}>{mail.text}</p>
    </div>
  )
}

export async function sendAssociationEmail(mail: AssociationMail) {
  return sendEmail(mail.to, makeSubject(mail.subject), associationComponent(mail), [], {
    throwOnError: true,
    messageId: `<association-${mail.id}@polinetwork.org>`,
  })
}
