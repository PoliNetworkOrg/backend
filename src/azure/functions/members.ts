import { logger } from "@/logger"
import { generatePassword } from "@/utils/password"
import { wait, withRetry } from "@/utils/wait"
import { client } from "../client"
import type { ParsedUser, User } from "../types"

const GruppoSociID = "1c68dbb8-4ac3-4569-a886-283b5a825cbd"
const Licenses = {
  OFFICE_365: "3b555118-da6a-4418-894f-7df1e2096870",
  POWER_APPS: "5b631642-bd26-49fe-bd20-1daaa972ef80",
  POWER_AUTOMATE: "f30db892-07e9-47e9-837c-80727f46fd3d",
  NON_PROFIT_HUB: "aa2695c9-8d59-4800-9dc8-12e01f1735af",
} as const
const FlippedLicenses = Object.fromEntries(Object.entries(Licenses).map(([key, value]) => [value, key]))

export async function getMembers(): Promise<ParsedUser[]> {
  try {
    const allPolinetworkUsers: User[] = await client
      .api(`/users`)
      .header("ConsistencyLevel", "eventual")
      .select(["displayName", "mail", "givenName", "surname", "id", "assignedLicenses", "employeeId"])
      .filter("endswith(mail, '@polinetwork.org')")
      .get()
      .then<User[]>((r) => r.value)

    const members: { id: string }[] = await client
      .api(`/groups/${GruppoSociID}/members`)
      .select(["id"])
      .get()
      .then((r) => r.value)

    logger.debug({ count: members.length }, "[Azure Graph API] Get members")

    return allPolinetworkUsers.map<ParsedUser>(
      ({ assignedLicenses, ...u }) =>
        ({
          ...u,
          isMember: members.findIndex((m) => m.id === u.id) !== -1,
          assignedLicensesIds: assignedLicenses.map((al) => (al.skuId ? FlippedLicenses[al.skuId] : "UNKNOWN")),
        }) satisfies ParsedUser
    )
  } catch (error) {
    logger.error({ error }, "[Azure Graph API] Could not get users")
    return []
  }
}

export async function setMemberNumber(userId: string, assocNumber: number) {
  try {
    await client.api(`/users/${userId}`).patch({
      employeeId: assocNumber.toString(),
    })
    return { error: null }
  } catch (err) {
    return { error: JSON.stringify(err) }
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
  // TODO: separate steps and add better error handling, maybe with neverthrow
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
  await withRetry(() =>
    client.api(`/users/${id}`).patch({
      givenName: firstName,
      surname: lastName,
      usageLocation: "IT",
      employeeId: assocNumber.toString(),
    })
  )

  // add to group Soci
  await withRetry(() =>
    client.api(`/groups/${GruppoSociID}/members/$ref`).post({
      "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${id}`,
    })
  )

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

export async function changePassword(userId: string) {
  const password = generatePassword()

  await withRetry(() =>
    client.api(`/users/${userId}`).patch({
      passwordProfile: {
        forceChangePasswordNextSignIn: true,
        password,
      },
    })
  ).catch((e) => logger.error({ error: e }, "[Azure Graph API] members:changePassword ERROR"))
  logger.info("[Azure Graph API] members:changePassword OK")
}

export async function manageLicenses(
  userId: string,
  addLicenses: (keyof typeof Licenses)[],
  removeLicenses: (keyof typeof Licenses)[]
) {
  await withRetry(() =>
    client.api(`/users/${userId}/assignLicense`).post({
      addLicenses: addLicenses.map((l) => ({
        disabledPlans: [],
        skuId: Licenses[l],
      })),
      removeLicenses: removeLicenses.map((l) => Licenses[l]),
    })
  ).catch((e) => logger.error({ error: e }, "[Azure Graph API] members:manageLicenses ERROR"))
  logger.info("[Azure Graph API] members:manageLicenses OK")
}
