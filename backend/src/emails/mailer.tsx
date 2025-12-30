import { EmailService } from "./service"
import Welcome from "./templates/welcome"

export async function sendWelcomeEmail(
  toAddress: string,
  accountCredentials: { email: string; password: string },
  memberInfo: { firstName: string; assocNumber: number },
  subject: string = "Welcome to PoliNetwork"
) {
  const emailService = EmailService.getInstance()
  await emailService.sendEmail(
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
