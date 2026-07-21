import type { Group as TGroup, User as TUser } from "@microsoft/microsoft-graph-types"
import { logger } from "@/logger"
import { withRetry } from "@/utils/wait"
import { client } from "../client"
import type { ParsedGroup } from "../types"

export type Group = Pick<Required<TGroup>, "id" | "displayName" | "mailNickname" | "mailEnabled"> & {
  members: Array<Pick<Required<TUser>, "id" | "displayName">>
}

export async function getAllGroups(): Promise<ParsedGroup[]> {
  try {
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

export async function addGroupMember(groupId: string, userId: string): Promise<boolean> {
  try {
    const res = withRetry(() =>
      client.api(`/groups/${groupId}/members/$ref`).post({
        "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${userId}`,
      })
    )
    logger.debug({ res, userId, groupId }, "[MS Graph API] OK addGroupMember call")
    return true
  } catch (error) {
    logger.error({ error, userId, groupId }, "[MS Graph API] Error in addGroupMember call")
    return false
  }
}
export async function removeGroupMember(groupId: string, userId: string): Promise<boolean> {
  try {
    withRetry(() => client.api(`/groups/${groupId}/members/${userId}/$ref`).delete())
    logger.debug({ userId, groupId }, "[MS Graph API] OK removeGroupMember call")
    return true
  } catch (error) {
    logger.error({ error, userId, groupId }, "[MS Graph API] Error in removeGroupMember call")
    return false
  }
}
