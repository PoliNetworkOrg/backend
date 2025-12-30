import { render } from "@react-email/components"
import type { JSX } from "react"
import { logger } from "@/logger"
import { env } from "../env" // Importa il tuo schema validato

interface TokenCache {
  accessToken: string
  expiresAt: number
}

export class EmailService {
  private static instance: EmailService
  private tokenCache: TokenCache | null = null
  private readonly SENDER_EMAIL = env.AZURE_EMAIL_SENDER

  private constructor() {}

  public static getInstance(): EmailService {
    if (!EmailService.instance) {
      EmailService.instance = new EmailService()
    }
    return EmailService.instance
  }

  private async getValidToken(): Promise<string> {
    const now = Date.now()
    if (this.tokenCache && this.tokenCache.expiresAt > now + 300000) {
      // if not-expired token in cache return that
      return this.tokenCache.accessToken
    }

    const params = new URLSearchParams({
      client_id: env.AZURE_EMAIL_CLIENT_ID,
      scope: "https://graph.microsoft.com/.default",
      client_secret: env.AZURE_EMAIL_CLIENT_SECRET,
      grant_type: "client_credentials",
    })

    const response = await fetch(`https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    })

    if (!response.ok) throw new Error("Azure Auth Failed")

    const data = (await response.json()) as { access_token: string; expires_in: number }
    this.tokenCache = {
      accessToken: data.access_token,
      expiresAt: now + data.expires_in * 1000,
    }

    logger.debug("[EMAIL] Azure access token obtained successfully")
    return data.access_token
  }

  public async sendEmail(to: string, subject: string, component: JSX.Element) {
    const html = await render(component)
    const token = await this.getValidToken()

    const response = await fetch(`https://graph.microsoft.com/v1.0/users/${this.SENDER_EMAIL}/sendMail`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: "HTML", content: html },
          from: {
            emailAddress: {
              name: "PoliNetwork APS",
              address: this.SENDER_EMAIL,
            },
          },
          toRecipients: [{ emailAddress: { address: to } }],
        },
      }),
    })

    logger.debug({ response, to, subject }, "[EMAIL] Send Email response")
    return response.ok
  }
}
