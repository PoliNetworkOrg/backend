import type { Group as TGroup, User as TUser } from "@microsoft/microsoft-graph-types"
import { logger } from "@/logger"
import { getAzureClient } from "../client"
import type { ParsedGroup } from "../types"

export type Group = Pick<Required<TGroup>, "id" | "displayName" | "mailNickname" | "mailEnabled"> & {
  members: Array<Pick<Required<TUser>, "id" | "displayName">>
}

export async function getAllGroups(): Promise<ParsedGroup[]> {
  try {
    const client = getAzureClient()
    const res: Group[] = await client
      .api("/groups?$select=id,displayName,mailNickname,mailEnabled&$expand=members($select=id,displayName)")
      .get()
      .then((r) => r.value)
    return res.map(({ mailNickname, mailEnabled, displayName, ...g }) => ({
      ...g,
      displayName: displayName ?? "",
      mailAddress: mailEnabled ? `${mailNickname}@polinetwork.org` : null,
      members: g.members.map((m) => ({ ...m, displayName: m.displayName ?? "" })),
    }))
  } catch (error) {
    logger.error({ error }, "[MS Graph API] Error in getAllGroups call")
    return []
  }
}
