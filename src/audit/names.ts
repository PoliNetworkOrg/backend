import { inArray } from "drizzle-orm"
import { DB, SCHEMA } from "@/db"
import { idp } from "@/idp"
import { logger } from "@/logger"
import { decryptUser } from "@/utils/users"

const DIRECTORY_TTL_MS = 5 * 60_000
let directory: { at: number; names: Map<string, string> } | null = null

/** The IdP directory's names by subject, cached for `DIRECTORY_TTL_MS`; empty without a directory. */
async function directoryNames(): Promise<Map<string, string>> {
  if (!idp?.directory) return new Map()
  if (directory && Date.now() - directory.at < DIRECTORY_TTL_MS) return directory.names
  try {
    const people = await idp.directory()
    directory = { at: Date.now(), names: new Map(people.map((person) => [person.sub, person.name])) }
  } catch (error) {
    logger.warn({ err: error }, "[AUDIT] cannot read the IdP directory")
    // Keeps the last names and waits a full TTL before asking again, rather than on every read.
    directory = { at: Date.now(), names: directory?.names ?? new Map() }
  }
  return directory.names
}

/** Display names of IdP subjects: from the IdP's directory, else from the profiles Signatures keeps. */
export async function userNames(subs: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (subs.length === 0) return names
  const profiles = SCHEMA.ESIGN.profiles
  for (const profile of await DB.select({ sub: profiles.sub, name: profiles.name })
    .from(profiles)
    .where(inArray(profiles.sub, subs)))
    names.set(profile.sub, profile.name)
  const known = await directoryNames()
  for (const sub of subs) {
    const name = known.get(sub)
    if (name) names.set(sub, name)
  }
  return names
}

/** Display names of Telegram users the backend has seen, e.g. "Ada Lovelace (@ada)". */
export async function telegramNames(ids: number[]): Promise<Map<number, string>> {
  const names = new Map<number, string>()
  if (ids.length === 0) return names
  const rows = await DB.select().from(SCHEMA.TG.users).where(inArray(SCHEMA.TG.users.userId, ids))
  await Promise.all(
    rows.map(async (row) => {
      const user = await decryptUser(row).catch(() => null)
      if (!user) return
      const name = [user.firstName, user.lastName].filter(Boolean).join(" ")
      names.set(row.userId, user.username ? `${name} (@${user.username})` : name)
    })
  )
  return names
}
