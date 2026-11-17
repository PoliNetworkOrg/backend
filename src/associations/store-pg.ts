import { TRPCError } from "@trpc/server"
import { eq, inArray, sql } from "drizzle-orm"
import type { DB } from "@/db"
import { associationMail, associationRegistry } from "@/db/schema/web/association-portal"
import { associations } from "@/db/schema/web/associations"
import type { Mail, Record, Store } from "./service"

export function createAssociationStore(db: typeof DB): Store {
  return {
    async list() {
      return (await db.select().from(associationRegistry)).map((row) => row.state)
    },
    async create(state, commandId, actor) {
      const creationKey = `${actor}:${commandId}`
      return db.transaction(async (tx) => {
        // Per-account lock bounds abandoned submissions and concurrent retries without blocking other applicants.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${actor}, 0))`)
        const existing = await tx
          .select()
          .from(associationRegistry)
          .where(eq(associationRegistry.creationKey, creationKey))
        if (existing[0]) return existing[0].id
        const [{ count }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(associationRegistry)
          .where(
            sql`${associationRegistry.state}->>'creator' = ${actor} AND (${associationRegistry.state}->>'registered')::boolean = false`
          )
        if (count >= 10)
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: "You already have ten registration drafts or requests. Contact PoliNetwork.",
          })
        await tx.insert(associationRegistry).values({ id: state.id, state, creationKey })
        return state.id
      })
    },
    async transfer<T>(from: string, to: string, operation: (source: Record, destination: Record) => T) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(associationRegistry)
          .where(inArray(associationRegistry.id, [from, to]))
          .orderBy(associationRegistry.id)
          .for("update")
        const source = rows.find((r) => r.id === from)?.state
        const destination = rows.find((r) => r.id === to)?.state
        if (!source || !destination) throw new TRPCError({ code: "NOT_FOUND" })
        const result = operation(source, destination)
        for (const state of [source, destination])
          await tx.update(associationRegistry).set({ state }).where(eq(associationRegistry.id, state.id))
        return result
      })
    },
    async change<T>(id: string, operation: (record: Record, mail: Mail[]) => T) {
      return db.transaction(async (tx) => {
        const [row] = await tx.select().from(associationRegistry).where(eq(associationRegistry.id, id)).for("update")
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Association not found" })
        const state = row.state
        const mail: Mail[] = []
        const result = operation(state, mail)
        // Preserve the old numeric public IDs and API shape. Only an approved version is copied into the old catalog.
        if (state.published) {
          const p = state.published
          const links = Object.fromEntries(p.links.map((link) => [link.platform, link.url]))
          const values = {
            name: p.name,
            descriptionIt: p.descriptionIt,
            descriptionEn: p.descriptionEn,
            logo: p.logo,
            email: p.email || null,
            website: links.website ?? null,
            facebook: links.facebook ?? null,
            instagram: links.instagram ?? null,
            tiktok: links.tiktok ?? null,
            x: links.x ?? null,
            youtube: links.youtube ?? null,
            telegram: links.telegram ?? null,
            linkedin: links.linkedin ?? null,
            spotify: links.spotify ?? null,
          }
          if (state.legacyId) await tx.update(associations).set(values).where(eq(associations.id, state.legacyId))
          else {
            const [created] = await tx
              .insert(associations)
              .values({ ...values, createdBySub: state.creator })
              .returning({ id: associations.id })
            state.legacyId = created.id
          }
        }
        await tx.update(associationRegistry).set({ state }).where(eq(associationRegistry.id, id))
        if (mail.length) await tx.insert(associationMail).values(mail.map((m) => ({ id: m.id, mail: m })))
        return result
      })
    },
  }
}
