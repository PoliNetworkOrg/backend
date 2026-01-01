import { sendEmail } from "@/azure/functions"
import OtpEmail from "./templates/otp"
import Welcome from "./templates/welcome"

export async function sendLoginOtpEmail(toAddress: string, otp: string) {
  const subject = `${otp} is your login code`
  await sendEmail(toAddress, subject, <OtpEmail otp={otp} />)
}

export async function sendWelcomeEmail(
  toAddress: string,
  accountCredentials: { email: string; password: string },
  memberInfo: { firstName: string; assocNumber: number },
  subject: string = "Welcome to PoliNetwork"
) {
  await sendEmail(
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
