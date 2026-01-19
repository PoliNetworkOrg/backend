import { emailOTP as emailOTPSetup } from "better-auth/plugins"
import { sendLoginOtpEmail } from "@/emails/mailer"
import { logger } from "@/logger"

export const emailOTP = () =>
  emailOTPSetup({
    expiresIn: 300,
    allowedAttempts: 5,
    async sendVerificationOTP({ email, otp, type }) {
      if (type === "sign-in") {
        const expiresInMinutes = this.expiresIn ? Math.floor(this.expiresIn / 60) : undefined
        await sendLoginOtpEmail(email, otp, expiresInMinutes)
      } else if (type === "email-verification") {
        logger.warn({ email, type }, "User requested email verification, but it is not implemented")
        // Send the OTP for email verification
        // not needed as now
      } else {
        logger.warn({ email, type }, "User requested password reset, but it is not implemented")
        // Send the OTP for password reset
        // not needed as now
      }
    },
  })
