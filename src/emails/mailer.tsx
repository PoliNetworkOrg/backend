import { render } from "@react-email/components"
import { createTestAccount, createTransport, getTestMessageUrl } from "nodemailer"
import type { JSX } from "react"
import { sendEmail as azureSendEmail } from "@/azure/functions/emails"
import { env } from "@/env"
import { logger } from "@/logger"
import OtpEmail from "./templates/otp"
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

async function devSendMail(to: string, subject: string, component: JSX.Element) {
  const html = await render(component)
  const res = await transporter.sendMail({ to, subject, html })
  logger.info(`[EMAIL] new email, click to see: ${getTestMessageUrl(res)}`)
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
