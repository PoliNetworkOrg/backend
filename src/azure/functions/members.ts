import { logger } from "@/logger"
import { generatePassword } from "@/utils/password"
import { withRetry } from "@/utils/wait"
import { getAzureClient } from "../client"
import { IncompleteMemberError } from "../errors"
import { MAIL_DOMAIN } from "../mailbox"
import type { CreatedMember, CreateMemberInput, MemberSummary, ParsedUser, User } from "../types"

const GruppoSociID = "1c68dbb8-4ac3-4569-a886-283b5a825cbd"
const Licenses = {
  OFFICE_365: "3b555118-da6a-4418-894f-7df1e2096870",
  POWER_APPS: "5b631642-bd26-49fe-bd20-1daaa972ef80",
  POWER_AUTOMATE: "f30db892-07e9-47e9-837c-80727f46fd3d",
  NON_PROFIT_HUB: "aa2695c9-8d59-4800-9dc8-12e01f1735af",
} as const
const FlippedLicenses = Object.fromEntries(Object.entries(Licenses).map(([key, value]) => [value, key]))

type Page<T> = { value: T[]; "@odata.nextLink"?: string }

async function allPages<T>(client: ReturnType<typeof getAzureClient>, first: Page<T>, advanced = false): Promise<T[]> {
  const items = [...first.value]
  let next = first["@odata.nextLink"]
  while (next) {
    const request = client.api(next)
    if (advanced) request.header("ConsistencyLevel", "eventual")
    const page: Page<T> = await request.get()
    items.push(...page.value)
    next = page["@odata.nextLink"]
  }
  return items
}

export async function getMembers(): Promise<ParsedUser[]> {
  try {
    const client = getAzureClient()
    const allPolinetworkUsers = await allPages<User>(
      client,
      await client
        .api(`/users`)
        .header("ConsistencyLevel", "eventual")
        .count(true)
        .select(["displayName", "mail", "givenName", "surname", "id", "assignedLicenses", "employeeId"])
        .filter("endswith(mail, '@polinetwork.org') or endswith(userPrincipalName, '@polinetwork.org')")
        .get(),
      true
    )

    const members = await allPages<{ id: string }>(
      client,
      await client.api(`/groups/${GruppoSociID}/members`).select(["id"]).get()
    )
    const memberIds = new Set(members.map((member) => member.id))

    logger.debug({ count: members.length }, "[Azure Graph API] Get members")

    return allPolinetworkUsers.map<ParsedUser>(
      ({ assignedLicenses, ...u }) =>
        ({
          ...u,
          isMember: memberIds.has(u.id),
          assignedLicensesIds: assignedLicenses.map((al) => (al.skuId ? FlippedLicenses[al.skuId] : "UNKNOWN")),
        }) satisfies ParsedUser
    )
  } catch (error) {
    logger.error({ error }, "[Azure Graph API] Could not get users")
    throw error
  }
}

const SUMMARY_FIELDS = ["id", "displayName", "givenName", "mail", "employeeId"]

function toSummary(user: Partial<MemberSummary> & { id: string }): MemberSummary {
  return {
    id: user.id,
    displayName: user.displayName ?? null,
    givenName: user.givenName ?? null,
    mail: user.mail ?? null,
    employeeId: user.employeeId ?? null,
  }
}

export async function getMember(userId: string): Promise<MemberSummary | null> {
  try {
    const user = await getAzureClient()
      .api(`/users/${encodeURIComponent(userId)}`)
      .select(SUMMARY_FIELDS)
      .get()
    return toSummary(user)
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return null
    throw error
  }
}

/** Callers pass only validated values (integers, `localPartSchema` addresses), so the filter needs no escaping. */
async function findOne(filter: string): Promise<MemberSummary | null> {
  const users: MemberSummary[] = await getAzureClient()
    .api("/users")
    .filter(filter)
    .select(SUMMARY_FIELDS)
    .top(1)
    .get()
    .then((r) => r.value)
  return users[0] ? toSummary(users[0]) : null
}

export async function findByMemberNumber(assocNumber: number) {
  return findOne(`employeeId eq '${assocNumber}'`)
}

export async function findByMail(mail: string) {
  return findOne(`userPrincipalName eq '${mail}' or mail eq '${mail}'`)
}

export async function setMemberNumber(userId: string, assocNumber: number) {
  try {
    const client = getAzureClient()
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
  localPart,
}: CreateMemberInput): Promise<CreatedMember> {
  const client = getAzureClient()
  const password = generatePassword()
  const mail = `${localPart}@${MAIL_DOMAIN}`

  // create user
  const { id }: { id: string } = await client.api("/users").post({
    accountEnabled: true,
    displayName: `${firstName} ${lastName}`,
    givenName: firstName,
    surname: lastName,
    usageLocation: "IT",
    employeeId: assocNumber.toString(),
    mailNickname: localPart,
    userPrincipalName: mail,
    passwordProfile: {
      forceChangePasswordNextSignIn: true,
      password,
    },
  })

  try {
    await withRetry(() =>
      client.api(`/groups/${GruppoSociID}/members/$ref`).post({
        "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${id}`,
      })
    )
    await manageLicenses(id, ["OFFICE_365", "POWER_AUTOMATE"], [])
  } catch (error) {
    try {
      await withRetry(async () => {
        try {
          await client.api(`/users/${id}`).delete()
        } catch (cleanupError) {
          if ((cleanupError as { statusCode?: number }).statusCode !== 404) throw cleanupError
        }
      })
    } catch (cleanupError) {
      logger.error({ error: cleanupError, memberId: id }, "[AZURE] incomplete account cleanup failed")
      throw new IncompleteMemberError(
        { id, displayName: `${firstName} ${lastName}`, givenName: firstName, mail, employeeId: assocNumber.toString() },
        error
      )
    }
    throw error
  }

  return {
    firstName,
    lastName,
    mail,
    id,
    password,
  }
}

export async function changePassword(userId: string) {
  const client = getAzureClient()
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
  const client = getAzureClient()
  await withRetry(() =>
    client.api(`/users/${userId}/assignLicense`).post({
      addLicenses: addLicenses.map((l) => ({
        disabledPlans: [],
        skuId: Licenses[l],
      })),
      removeLicenses: removeLicenses.map((l) => Licenses[l]),
    })
  )
  logger.info("[Azure Graph API] members:manageLicenses OK")
}
