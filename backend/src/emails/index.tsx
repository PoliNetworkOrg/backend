import { render } from "@react-email/components"
import { createTestAccount, createTransport, getTestMessageUrl } from "nodemailer"
import type Mail from "nodemailer/lib/mailer"
import type React from "react"
import { env } from "@/env"
import { logger } from "@/logger"
import type { MaybeArray } from "@/utils/types"

// SMTP_PASS expires in 104 (arbitrary value) years because of Azure restrictions
// To reset or renew the token, use the Azure CLI:
//    az ad app credential reset --id <email-app-id> --display-name backend --years 104
// You can find the <email-app-id> using `az ad app list` or in the Microsoft Entra ID (Azure Portal)
const transport = createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  tls: {
    minVersion: env.SMTP_TLS_VERSION,
  },
})

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

// biome-ignore lint/complexity/noBannedTypes: this is how React does it
export async function sendEmail<P extends {} = {}>(options: {
  to: MaybeArray<string | Mail.Address>
  subject: string
  email: React.FC<P>
  props: P
  forceProd?: boolean
}): Promise<void> {
  try {
    const isProd = options.forceProd || env.NODE_ENV === "production"

    const html = await render(<options.email {...options.props} />)
    const res = isProd
      ? await transport.sendMail({
        from: env.SMTP_USER,
        to: options.to,
        subject: options.subject,
        html,
      })
      : await testTransport.sendMail({
        from: "Test PoliNetwork APS <noreply@example.com",
        to: options.to,
        subject: `[TEST] ${options.subject}`,
        html,
      })

    if (isProd) {
      logger.debug({ subject: options.subject, to: options.to }, `[EMAIL] email sent successfully.`)
    } else {
      logger.info(
        { subject: options.subject, to: options.to },
        `[EMAIL] fake email sent (dev). Preview URL: ${getTestMessageUrl(res)}`
      )
    }
  } catch (err) {
    logger.error({ subject: options.subject, to: options.to, err }, `[EMAIL] error while sending email`)
  }
}
