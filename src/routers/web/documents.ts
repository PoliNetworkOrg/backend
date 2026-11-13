import { and, asc, desc, eq, max, ne } from "drizzle-orm"
import z from "zod"
import { deleteBlob, uploadBlob } from "@/azure/blob"
import { DB, SCHEMA } from "@/db"
import { authorOf, createdByColumns, modifiedByColumns } from "@/idp/author"
import { dashboard, publicData } from "@/idp/policies"
import { createTRPCRouter, policy } from "@/trpc"

const CATEGORIES = SCHEMA.WEB.webDocumentCategories
const DOCUMENTS = SCHEMA.WEB.webDocuments
const VERSIONS = SCHEMA.WEB.webDocumentVersions

const slugSchema = z
  .string()
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase kebab-case")
const titleSchema = z.string().trim().min(1).max(200)
const descriptionSchema = z.string().trim().max(2000)
const idSchema = z.number().int().positive()
const orderSchema = z
  .array(idSchema)
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, "Duplicate ids")

const documentFileSchema = z
  .file()
  .mime(["application/pdf"])
  .min(1)
  .max(10 * 1024 * 1024)

const versionFormSchema = z.object({
  documentId: z.coerce.number<string>().int().positive(),
  version: z.string().trim().min(1).max(50),
  date: z.iso.date(),
  file: documentFileSchema,
})

const versionSchema = z.object({ id: z.number(), version: z.string(), date: z.string(), file: z.string() })
const categoryRowSchema = z.object({
  id: z.number(),
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  position: z.number(),
})
const documentRowSchema = z.object({
  id: z.number(),
  categoryId: z.number(),
  slug: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  position: z.number(),
})

const versionColumns = { id: VERSIONS.id, version: VERSIONS.version, date: VERSIONS.date, file: VERSIONS.file }
const categoryColumns = {
  id: CATEGORIES.id,
  slug: CATEGORIES.slug,
  title: CATEGORIES.title,
  description: CATEGORIES.description,
  position: CATEGORIES.position,
}
const documentColumns = {
  id: DOCUMENTS.id,
  categoryId: DOCUMENTS.categoryId,
  slug: DOCUMENTS.slug,
  title: DOCUMENTS.title,
  description: DOCUMENTS.description,
  position: DOCUMENTS.position,
}
/** Newest first: the greatest date, then the greatest id. */
const newestFirst = [desc(VERSIONS.date), desc(VERSIONS.id)]

type Tx = Parameters<Parameters<typeof DB.transaction>[0]>[0]

/** Every category, document and version in display order, read from one snapshot. */
async function readCatalog() {
  return DB.transaction(
    async (tx) => {
      const categories = await tx
        .select(categoryColumns)
        .from(CATEGORIES)
        .orderBy(asc(CATEGORIES.position), asc(CATEGORIES.id))
      const documents = await tx
        .select(documentColumns)
        .from(DOCUMENTS)
        .orderBy(asc(DOCUMENTS.position), asc(DOCUMENTS.id))
      const versions = await tx
        .select({ ...versionColumns, documentId: VERSIONS.documentId })
        .from(VERSIONS)
        .orderBy(...newestFirst)

      const versionsByDocument = new Map<number, z.infer<typeof versionSchema>[]>()
      for (const { documentId, ...version } of versions) {
        const list = versionsByDocument.get(documentId) ?? []
        list.push(version)
        versionsByDocument.set(documentId, list)
      }
      return categories.map((category) => ({
        ...category,
        documents: documents
          .filter((document) => document.categoryId === category.id)
          .map(({ categoryId: _, ...document }) => ({
            ...document,
            versions: versionsByDocument.get(document.id) ?? [],
          })),
      }))
    },
    { isolationLevel: "repeatable read", accessMode: "read only" }
  )
}

async function slugTaken(tx: Tx, table: typeof CATEGORIES | typeof DOCUMENTS, slug: string, exceptId?: number) {
  const [row] = await tx
    .select({ id: table.id })
    .from(table)
    .where(exceptId === undefined ? eq(table.slug, slug) : and(eq(table.slug, slug), ne(table.id, exceptId)))
    .limit(1)
  return !!row
}

/** The position after the last document of a category. */
async function nextDocumentPosition(tx: Tx, categoryId: number) {
  const [{ last }] = await tx
    .select({ last: max(DOCUMENTS.position) })
    .from(DOCUMENTS)
    .where(eq(DOCUMENTS.categoryId, categoryId))
  return last === null ? 0 : last + 1
}

/** Locks a category so documents cannot be added to it while it is being deleted, and vice versa. */
async function lockCategory(tx: Tx, id: number) {
  const [row] = await tx.select({ id: CATEGORIES.id }).from(CATEGORIES).where(eq(CATEGORIES.id, id)).for("share")
  return !!row
}

export default createTRPCRouter({
  getCatalog: policy(publicData)
    .output(
      z.array(
        categoryRowSchema.extend({
          documents: z.array(documentRowSchema.omit({ categoryId: true }).extend({ latest: versionSchema })),
        })
      )
    )
    .query(async () => {
      const catalog = await readCatalog()
      return catalog
        .map(({ documents, ...category }) => ({
          ...category,
          documents: documents.flatMap(({ versions, ...document }) =>
            versions.length ? [{ ...document, latest: versions[0] }] : []
          ),
        }))
        .filter((category) => category.documents.length > 0)
    }),

  getDocument: policy(publicData)
    .input(z.object({ slug: z.string() }))
    .output(
      documentRowSchema
        .omit({ categoryId: true, position: true })
        .extend({
          category: categoryRowSchema.pick({ id: true, slug: true, title: true }),
          latest: versionSchema,
          versions: z.array(versionSchema),
        })
        .nullable()
    )
    .query(async ({ input }) => {
      return DB.transaction(
        async (tx) => {
          const [document] = await tx
            .select({
              id: DOCUMENTS.id,
              slug: DOCUMENTS.slug,
              title: DOCUMENTS.title,
              description: DOCUMENTS.description,
              category: { id: CATEGORIES.id, slug: CATEGORIES.slug, title: CATEGORIES.title },
            })
            .from(DOCUMENTS)
            .innerJoin(CATEGORIES, eq(DOCUMENTS.categoryId, CATEGORIES.id))
            .where(eq(DOCUMENTS.slug, input.slug))
            .limit(1)
          if (!document) return null
          const versions = await tx
            .select(versionColumns)
            .from(VERSIONS)
            .where(eq(VERSIONS.documentId, document.id))
            .orderBy(...newestFirst)
          if (!versions.length) return null
          return { ...document, latest: versions[0], versions }
        },
        { isolationLevel: "repeatable read", accessMode: "read only" }
      )
    }),

  getAdminCatalog: policy(dashboard("admin:access"))
    .output(
      z.array(
        categoryRowSchema.extend({
          documents: z.array(documentRowSchema.omit({ categoryId: true }).extend({ versions: z.array(versionSchema) })),
        })
      )
    )
    .query(async () => readCatalog()),

  createCategory: policy(dashboard("web:content:write"))
    .input(z.object({ slug: slugSchema, title: titleSchema, description: descriptionSchema }))
    .mutation(async ({ input, ctx }) => {
      return DB.transaction(async (tx) => {
        const [{ last }] = await tx.select({ last: max(CATEGORIES.position) }).from(CATEGORIES)
        const [row] = await tx
          .insert(CATEGORIES)
          .values({ ...input, position: last === null ? 0 : last + 1, ...createdByColumns(authorOf(ctx.actor)) })
          .onConflictDoNothing({ target: CATEGORIES.slug })
          .returning(categoryColumns)
        if (!row) return { error: "DUPLICATE_SLUG" as const }
        return row
      })
    }),

  updateCategory: policy(dashboard("web:content:write"))
    .input(
      z.object({
        id: idSchema,
        slug: slugSchema.optional(),
        title: titleSchema.optional(),
        description: descriptionSchema.optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { id, ...fields } = input
      return DB.transaction(async (tx) => {
        if (fields.slug !== undefined && (await slugTaken(tx, CATEGORIES, fields.slug, id)))
          return { error: "DUPLICATE_SLUG" as const }
        const [row] = await tx
          .update(CATEGORIES)
          .set({ ...fields, ...modifiedByColumns(authorOf(ctx.actor)) })
          .where(eq(CATEGORIES.id, id))
          .returning(categoryColumns)
        if (!row) return { error: "NOT_FOUND" as const }
        return row
      })
    }),

  deleteCategory: policy(dashboard("web:content:write"))
    .input(z.object({ id: idSchema }))
    .mutation(async ({ input }) => {
      return DB.transaction(async (tx) => {
        const [category] = await tx
          .select({ id: CATEGORIES.id })
          .from(CATEGORIES)
          .where(eq(CATEGORIES.id, input.id))
          .for("update")
        if (!category) return { error: "NOT_FOUND" as const }
        const [document] = await tx
          .select({ id: DOCUMENTS.id })
          .from(DOCUMENTS)
          .where(eq(DOCUMENTS.categoryId, input.id))
          .limit(1)
        if (document) return { error: "CATEGORY_NOT_EMPTY" as const }
        await tx.delete(CATEGORIES).where(eq(CATEGORIES.id, input.id))
        return { error: null }
      })
    }),

  reorderCategories: policy(dashboard("web:content:write"))
    .input(z.object({ ids: orderSchema }))
    .mutation(async ({ input }) => {
      await DB.transaction(async (tx) => {
        for (const [position, id] of input.ids.entries())
          await tx.update(CATEGORIES).set({ position }).where(eq(CATEGORIES.id, id))
      })
      return { error: null }
    }),

  createDocument: policy(dashboard("web:content:write"))
    .input(
      z.object({
        categoryId: idSchema,
        slug: slugSchema,
        title: titleSchema,
        description: descriptionSchema.nullish(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      return DB.transaction(async (tx) => {
        if (!(await lockCategory(tx, input.categoryId))) return { error: "CATEGORY_NOT_FOUND" as const }
        const [row] = await tx
          .insert(DOCUMENTS)
          .values({
            ...input,
            description: input.description || null,
            position: await nextDocumentPosition(tx, input.categoryId),
            ...createdByColumns(authorOf(ctx.actor)),
          })
          .onConflictDoNothing({ target: DOCUMENTS.slug })
          .returning(documentColumns)
        if (!row) return { error: "DUPLICATE_SLUG" as const }
        return row
      })
    }),

  updateDocument: policy(dashboard("web:content:write"))
    .input(
      z.object({
        id: idSchema,
        categoryId: idSchema.optional(),
        slug: slugSchema.optional(),
        title: titleSchema.optional(),
        description: descriptionSchema.nullish(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { id, categoryId, description, ...fields } = input
      return DB.transaction(async (tx) => {
        const [current] = await tx
          .select({ categoryId: DOCUMENTS.categoryId })
          .from(DOCUMENTS)
          .where(eq(DOCUMENTS.id, id))
          .for("update")
        if (!current) return { error: "NOT_FOUND" as const }
        const moving = categoryId !== undefined && categoryId !== current.categoryId
        if (moving && !(await lockCategory(tx, categoryId))) return { error: "CATEGORY_NOT_FOUND" as const }
        if (fields.slug !== undefined && (await slugTaken(tx, DOCUMENTS, fields.slug, id)))
          return { error: "DUPLICATE_SLUG" as const }
        const [row] = await tx
          .update(DOCUMENTS)
          .set({
            ...fields,
            ...(description !== undefined ? { description: description || null } : {}),
            // A document moved to another category goes last in it.
            ...(moving ? { categoryId, position: await nextDocumentPosition(tx, categoryId) } : {}),
            ...modifiedByColumns(authorOf(ctx.actor)),
          })
          .where(eq(DOCUMENTS.id, id))
          .returning(documentColumns)
        return row
      })
    }),

  deleteDocument: policy(dashboard("web:content:write"))
    .input(z.object({ id: idSchema }))
    .mutation(async ({ input }) => {
      const files = await DB.transaction(async (tx) => {
        const [document] = await tx
          .select({ id: DOCUMENTS.id })
          .from(DOCUMENTS)
          .where(eq(DOCUMENTS.id, input.id))
          .for("update")
        if (!document) return null
        const versions = await tx
          .delete(VERSIONS)
          .where(eq(VERSIONS.documentId, input.id))
          .returning({ file: VERSIONS.file })
        await tx.delete(DOCUMENTS).where(eq(DOCUMENTS.id, input.id))
        return versions.map((version) => version.file)
      })
      if (!files) return { error: "NOT_FOUND" as const }
      await Promise.all(files.map((file) => deleteBlob(file)))
      return { error: null }
    }),

  reorderDocuments: policy(dashboard("web:content:write"))
    .input(z.object({ categoryId: idSchema, ids: orderSchema }))
    .mutation(async ({ input }) => {
      await DB.transaction(async (tx) => {
        for (const [position, id] of input.ids.entries())
          await tx
            .update(DOCUMENTS)
            .set({ position })
            .where(and(eq(DOCUMENTS.id, id), eq(DOCUMENTS.categoryId, input.categoryId)))
      })
      return { error: null }
    }),

  addVersion: policy(dashboard("web:content:write"))
    .input(
      z
        .instanceof(FormData)
        .transform((fd): Record<string, string | File> => Object.fromEntries(fd.entries()))
        .pipe(versionFormSchema)
    )
    .mutation(async ({ input, ctx }) => {
      const { documentId, version, date, file } = input
      const author = createdByColumns(authorOf(ctx.actor))

      const [document] = await DB.select({ id: DOCUMENTS.id }).from(DOCUMENTS).where(eq(DOCUMENTS.id, documentId))
      if (!document) return { error: "NOT_FOUND" as const }
      const [existing] = await DB.select({ id: VERSIONS.id })
        .from(VERSIONS)
        .where(and(eq(VERSIONS.documentId, documentId), eq(VERSIONS.version, version)))
      if (existing) return { error: "DUPLICATE_VERSION" as const }

      const uploadedFile = await uploadBlob(Buffer.from(await file.arrayBuffer()), "pdf", file.type)
      // The document may have been deleted, or the version added, while the file was uploading.
      const result = await DB.transaction(async (tx) => {
        const [locked] = await tx
          .select({ id: DOCUMENTS.id })
          .from(DOCUMENTS)
          .where(eq(DOCUMENTS.id, documentId))
          .for("share")
        if (!locked) return { error: "NOT_FOUND" as const }
        const [row] = await tx
          .insert(VERSIONS)
          .values({ documentId, version, date, file: uploadedFile.url, ...author })
          .onConflictDoNothing({ target: [VERSIONS.documentId, VERSIONS.version] })
          .returning(versionColumns)
        return row ?? { error: "DUPLICATE_VERSION" as const }
      })
      if ("error" in result) await deleteBlob(uploadedFile.url)
      return result
    }),

  deleteVersion: policy(dashboard("web:content:write"))
    .input(z.object({ id: idSchema }))
    .mutation(async ({ input }) => {
      const [deleted] = await DB.delete(VERSIONS).where(eq(VERSIONS.id, input.id)).returning({ file: VERSIONS.file })
      if (!deleted) return { error: "NOT_FOUND" as const }
      await deleteBlob(deleted.file)
      return { error: null }
    }),
})
