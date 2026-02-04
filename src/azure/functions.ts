import { render, toPlainText } from "@react-email/components"
import MailComposer from "nodemailer/lib/mail-composer/index.js"
import type { JSX } from "react"
import { env } from "@/env"
import { logger } from "@/logger"
import { client } from "./client"
import type { Member } from "./types"
import { generatePassword } from "@/utils/password"
import { wait } from "@/utils/wait"
import { GraphError } from "@microsoft/microsoft-graph-client"
import { which } from "bun"

export async function sendEmail(to: string, subject: string, component: JSX.Element) {
  const html = await render(component)
  const text = toPlainText(html, {
    selectors: [
      { selector: '*[style*="display:none"i]', format: "skip" }, // prevent duplicate text
    ],
  })
  const sender = encodeURIComponent(env.AZURE_EMAIL_SENDER)

  // To send multipart emails (both HTML and plain text) with Microsoft Graph API,
  // we need to send raw MIME content.
  const mail = new MailComposer({
    from: sender,
    to,
    subject,
    text,
    html,
  })
  const mimeMessage = await mail.compile().build()
  const base64Encoded = mimeMessage.toString("base64")

  try {
    await client.api(`/users/${sender}/sendMail`).header("Content-Type", "text/plain").post(base64Encoded)
    logger.info({ subject, to }, "[Azure Graph API] Email sent")

    return true
  } catch (error) {
    logger.error({ error }, "[Azure Graph API] Could not send email")
    return false
  }
}

const GruppoSociID = "1c68dbb8-4ac3-4569-a886-283b5a825cbd"
const Licenses = {
  OFFICE_365: "3b555118-da6a-4418-894f-7df1e2096870",
  POWER_APPS: "5b631642-bd26-49fe-bd20-1daaa972ef80",
  POWER_AUTOMATE: "f30db892-07e9-47e9-837c-80727f46fd3d",
  NON_PROFIT_HUB: "aa2695c9-8d59-4800-9dc8-12e01f1735af",
} as const
const FlippedLicenses = Object.fromEntries(Object.entries(Licenses).map(([key, value]) => [value, key]))

export async function getMembers() {
  try {
    const members: Member[] = await client
      .api(`/groups/${GruppoSociID}/members`)
      .select(["displayName", "mail", "givenName", "surname", "id", "assignedLicenses", "employeeId"])
      .get()
      .then((r) => r.value)

    logger.debug({ count: members.length }, "[Azure Graph API] Get members")

    const outMembers = members.map((m) => ({
      ...m,
      assignedLicensesIds: m.assignedLicenses.map((al) => (al.skuId ? FlippedLicenses[al.skuId] : null)),
      assignedLicenses: undefined,
    }))

    return outMembers
  } catch (error) {
    logger.error({ error }, "[Azure Graph API] Could not get users")
    return []
  }
}

export async function createMember({
  firstName,
  lastName,
  assocNumber,
}: {
  firstName: string
  lastName: string
  assocNumber: number
}) {
  const password = generatePassword()
  const mailNickname = `${firstName.replaceAll(" ", "")}.${lastName.replaceAll(" ", "")}`.toLowerCase()
  const mail = `${mailNickname}@polinetwork.org`

  // create user
  const { id }: { id: string } = await client.api("/users").post({
    accountEnabled: true,
    displayName: `${firstName} ${lastName}`,
    mailNickname,
    userPrincipalName: mail,
    passwordProfile: {
      forceChangePasswordNextSignIn: true,
      password,
    },
  })

  // set firstName and lastName
  await client.api(`/users/${id}`).patch({
    givenName: firstName,
    surname: lastName,
    usageLocation: "IT",
    employeeId: assocNumber.toString(),
  })

  // add to group Soci
  await client.api(`/groups/${GruppoSociID}/members/$ref`).post({
    "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${id}`,
  })

  // assign licenses
  await manageLicenses(id, ["OFFICE_365", "POWER_AUTOMATE"], [])

  return {
    firstName,
    lastName,
    mail,
    id,
    password,
  }
}

export async function manageLicenses(
  userId: string,
  addLicenses: (keyof typeof Licenses)[],
  removeLicenses: (keyof typeof Licenses)[]
) {
  let tries = 0
  while (tries < 6) {
    try {
      await client.api(`/users/${userId}/assignLicense`).post({
        addLicenses: addLicenses.map((l) => ({
          disabledPlans: [],
          skuId: Licenses[l],
        })),
        removeLicenses: removeLicenses.map((l) => ({
          disabledPlans: [],
          skuId: Licenses[l],
        })),
      })
      logger.info("[Azure Graph API] manageLicenses OK")
      return
    } catch (error) {
      tries++
      logger.error({ error, tries }, "[Azure Graph API] manageLicenses error")
      await wait(2 ** tries * 1000)
    }
  }
}
