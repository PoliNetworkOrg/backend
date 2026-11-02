import { eq } from "drizzle-orm"
import { documents, drafts, versions } from "@/db/schema/regulations"
import type { RegulationsDb } from "./db"

export type DraftContext = {
  id: string
  documentKey: string
  entry: string
  state: (typeof drafts.$inferSelect)["state"]
  kind: (typeof drafts.$inferSelect)["kind"]
  /** Text can change: `bozza` and not frozen (in approval, or a rettifica being emanated). */
  editable: boolean
  deleted: boolean
  /** The asset bundle of the version the draft's lineage starts from. */
  assetsHash: string | null
  baseFiles: (typeof drafts.$inferSelect)["baseFiles"]
}

export const isEditable = (draft: Pick<typeof drafts.$inferSelect, "state" | "frozenFiles" | "deletedAt">) =>
  draft.state === "bozza" && draft.frozenFiles === null && draft.deletedAt === null

/** What the collab service and the compiler need to know about a draft. */
export async function draftContext(db: RegulationsDb, draftId: string): Promise<DraftContext | null> {
  const [row] = await db
    .select({ draft: drafts, entry: documents.entry })
    .from(drafts)
    .innerJoin(documents, eq(documents.key, drafts.documentKey))
    .where(eq(drafts.id, draftId))
  if (!row) return null
  let assetsHash: string | null = null
  let cursor: { baseVersionId: string | null; baseDraftId: string | null } = row.draft
  for (let depth = 0; depth < 50; depth++) {
    if (cursor.baseVersionId) {
      const [version] = await db
        .select({ assets: versions.assetsBlob })
        .from(versions)
        .where(eq(versions.id, cursor.baseVersionId))
      assetsHash = version?.assets ?? null
      break
    }
    if (!cursor.baseDraftId) break
    const [parent] = await db
      .select({ baseVersionId: drafts.baseVersionId, baseDraftId: drafts.baseDraftId })
      .from(drafts)
      .where(eq(drafts.id, cursor.baseDraftId))
    if (!parent) break
    cursor = parent
  }
  return {
    id: row.draft.id,
    documentKey: row.draft.documentKey,
    entry: row.entry,
    state: row.draft.state,
    kind: row.draft.kind,
    editable: isEditable(row.draft),
    deleted: row.draft.deletedAt !== null,
    assetsHash,
    baseFiles: row.draft.baseFiles,
  }
}
