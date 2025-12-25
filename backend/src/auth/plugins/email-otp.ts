import { emailOTP as emailOTPSetup } from "better-auth/plugins"
import { createTestAccount, createTransport, getTestMessageUrl } from "nodemailer"
import { logger } from "@/logger"

const testAccount = await createTestAccount()
const testTransport = createTransport({
  host: "smtp.ethereal.email",
  port: 587,
  secure: false, // upgrade later with STARTTLS
  auth: {
    user: testAccount.user, // generated user
    pass: testAccount.pass, // generated password
  },
})

export const emailOTP = () => emailOTPSetup({
  async sendVerificationOTP({ email, otp, type }) {
    if (type === "sign-in") {
      // Send the OTP for sign in
      const info = await testTransport.sendMail({
        from: "PoliNetwork APS <noreply@polinetwork.org>",
        to: email,
        subject: `[TEST] Codice di verifica ${otp}`,
        text: `Il tuo codice di verifica per accedere a PoliNetwork APS è ${otp}`
      })
      logger.info(`Test OTP email sent: ${getTestMessageUrl(info)}`)
    } else if (type === "email-verification") {
      // Send the OTP for email verification
      // not needed as now
    } else {
      // Send the OTP for password reset
      // not needed as now
    }
  },
})
