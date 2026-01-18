import { sendEmail } from "@/azure/functions"
import { env } from "@/env"
import OtpEmail from "./templates/otp"
import Welcome from "./templates/welcome"

const makeSubject = (subject: string) => (env.NODE_ENV === "development" ? `[DEV] ${subject}` : subject)

export async function sendLoginOtpEmail(toAddress: string, otp: string) {
  const subject = makeSubject("Your login code for PoliNetwork")
  return sendEmail(toAddress, subject, <OtpEmail otp={otp} />)
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
