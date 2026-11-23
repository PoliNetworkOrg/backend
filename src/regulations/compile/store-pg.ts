import { and, eq } from "drizzle-orm"
import { blobs, compileRefs, compiles, draftCompiles } from "@/db/schema/regulations"
import type { CompileStatus } from "../contract"
import { type RegulationsDb, sha256 } from "../db"
import type { CompileStore } from "./service"

export function createCompileStore(db: RegulationsDb): CompileStore {
  return {
    async findCompile(hash) {
      const [row] = await db.select().from(compiles).where(eq(compiles.hash, hash))
      return row ? { ok: row.ok, errors: row.errors, log: row.log } : null
    },
    async saveCompile(hash, result) {
      let pdfBlob: string | null = null
      if (result.ok && result.pdf) {
        const content = new Uint8Array(Buffer.from(result.pdf, "base64"))
        pdfBlob = sha256(content)
        await db.insert(blobs).values({ hash: pdfBlob, contentType: "application/pdf", content }).onConflictDoNothing()
      }
      await db
        .insert(compiles)
        .values({ hash, ok: result.ok, pdfBlob, errors: result.errors, log: result.log, durationMs: result.durationMs })
        .onConflictDoNothing()
    },
    async addRef(draftId, hash) {
      await db.insert(compileRefs).values({ draftId, hash }).onConflictDoNothing()
    },
    async setDraftStatus(draftId, status) {
      const now = new Date()
      const done = status.state === "ok" || status.state === "error"
      const values = {
        state: status.state,
        hash: status.hash,
        updatedAt: now,
        ...(status.goodHash ? { lastGoodHash: status.goodHash } : {}),
        ...(done ? { compiledAt: now } : {}),
        ...(status.error !== undefined ? { error: status.error } : {}),
      }
      await db
        .insert(draftCompiles)
        .values({ draftId, ...values })
        .onConflictDoUpdate({ target: draftCompiles.draftId, set: values })
    },
  }
}

/** `compile.status` for a draft. */
export async function readCompileStatus(db: RegulationsDb, draftId: string): Promise<CompileStatus> {
  const [row] = await db.select().from(draftCompiles).where(eq(draftCompiles.draftId, draftId))
  if (!row?.hash) return { state: "idle", hash: null, lastGoodHash: null, compiledAt: null, errors: [], log: null }
  const [compile] = await db.select().from(compiles).where(eq(compiles.hash, row.hash))
  const errors = row.error ? [{ file: null, line: null, message: row.error }] : (compile?.errors ?? [])
  return {
    state: row.state,
    hash: row.hash,
    lastGoodHash: row.lastGoodHash,
    compiledAt: row.compiledAt?.toISOString() ?? null,
    errors: row.state === "error" ? errors : [],
    log: compile?.log ?? null,
  }
}

/** The PDF of a compile of this draft, or null when the draft never compiled `hash` or it failed. */
export async function readCompilePdf(db: RegulationsDb, draftId: string, hash: string): Promise<Uint8Array | null> {
  const [ref] = await db
    .select()
    .from(compileRefs)
    .where(and(eq(compileRefs.draftId, draftId), eq(compileRefs.hash, hash)))
  if (!ref) return null
  const [compile] = await db.select().from(compiles).where(eq(compiles.hash, hash))
  if (!compile?.pdfBlob) return null
  const [blob] = await db.select().from(blobs).where(eq(blobs.hash, compile.pdfBlob))
  return blob?.content ?? null
}
