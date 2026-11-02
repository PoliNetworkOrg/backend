import { and, asc, desc, eq, lte, max } from "drizzle-orm"
import { nanoid } from "nanoid"
import * as Y from "yjs"
import type { SnapshotKind } from "@/db/schema/regulations"
import { drafts, snapshots, ydocs, yupdates } from "@/db/schema/regulations"
import { sourceHash } from "../compile/protocol"
import type { Files, PersonRef } from "../contract"
import type { RegulationsDb } from "../db"

/**
 * Yjs persistence in Postgres: a compacted state per draft plus the updates received since, appended as they arrive
 * so a crash loses nothing. Compaction folds the log into the state when the collab service stores the document.
 */
export function createYjsPersistence(db: RegulationsDb) {
  return {
    /** The document's state (compacted state plus the log), or null when the draft has none yet. */
    async load(draftId: string): Promise<Uint8Array | null> {
      const [row] = await db.select().from(ydocs).where(eq(ydocs.draftId, draftId))
      const updates = await db
        .select({ update: yupdates.update })
        .from(yupdates)
        .where(eq(yupdates.draftId, draftId))
        .orderBy(asc(yupdates.id))
      if (!row && !updates.length) return null
      return Y.mergeUpdates([...(row ? [row.state] : []), ...updates.map((u) => u.update)])
    },

    async append(draftId: string, update: Uint8Array, actorSub: string | null) {
      await db.insert(yupdates).values({ draftId, update, actorSub })
    },

    /** Stores `state` (which includes every logged update) and drops the log it replaces. */
    async compact(draftId: string, state: Uint8Array) {
      await db.transaction(async (tx) => {
        const [{ through }] = await tx
          .select({ through: max(yupdates.id) })
          .from(yupdates)
          .where(eq(yupdates.draftId, draftId))
        const compactedThrough = through ?? 0
        await tx
          .insert(ydocs)
          .values({ draftId, state, compactedThrough, updatedAt: new Date() })
          .onConflictDoUpdate({ target: ydocs.draftId, set: { state, compactedThrough, updatedAt: new Date() } })
        if (through !== null)
          await tx.delete(yupdates).where(and(eq(yupdates.draftId, draftId), lte(yupdates.id, compactedThrough)))
      })
    },
  }
}

/** Takes a snapshot of a draft's text (history). */
export async function saveSnapshot(
  db: RegulationsDb,
  input: { draftId: string; kind: SnapshotKind; name: string | null; files: Files; by: PersonRef | null }
) {
  const id = nanoid(16)
  await db.insert(snapshots).values({
    id,
    draftId: input.draftId,
    kind: input.kind,
    name: input.name,
    files: input.files,
    sourceHash: await sourceHash({ entry: "", files: input.files, assets: "" }),
    createdBy: input.by,
    createdAt: new Date(),
  })
  return id
}

/** An automatic snapshot when the text changed since the last one and that one is older than `everyMs`. */
export async function autoSnapshot(db: RegulationsDb, draftId: string, files: Files, everyMs: number) {
  const [last] = await db
    .select({ createdAt: snapshots.createdAt, sourceHash: snapshots.sourceHash })
    .from(snapshots)
    .where(eq(snapshots.draftId, draftId))
    .orderBy(desc(snapshots.createdAt))
    .limit(1)
  const hash = await sourceHash({ entry: "", files, assets: "" })
  if (last && (last.sourceHash === hash || Date.now() - last.createdAt.getTime() < everyMs)) return null
  return saveSnapshot(db, { draftId, kind: "auto", name: null, files, by: null })
}

export async function setParses(db: RegulationsDb, draftId: string, parses: boolean) {
  await db.update(drafts).set({ parses, updatedAt: new Date() }).where(eq(drafts.id, draftId))
}
