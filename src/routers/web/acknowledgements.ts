import { and, asc, eq, isNull, max, sql } from "drizzle-orm"
import z from "zod"
import { audit } from "@/audit/option"
import { DB, SCHEMA } from "@/db"
import { acknowledgementIcons } from "@/db/schema/web/acknowledgements"
import { authorOf, createdByColumns, modifiedByColumns } from "@/idp/author"
import { dashboard, publicData } from "@/idp/policies"
import { createTRPCRouter, policy } from "@/trpc"

const GROUPS = SCHEMA.WEB.acknowledgementGroups
const ENTRIES = SCHEMA.WEB.acknowledgements

const idSchema = z.int32().positive() // The id columns are PostgreSQL integers.
const orderSchema = z
  .array(idSchema)
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, "Duplicate ids")
const titleSchema = z.string().trim().min(1).max(80)
const iconSchema = z.enum(acknowledgementIcons)
const nameSchema = z.string().trim().min(1).max(120)
/** The label under the name: a role in the group, or the project. Empty means none. */
const detailSchema = z.string().trim().max(80).nullish()

/** One list of people: a role group of the website section, or the flat list of the projects section. */
const listSchema = z.discriminatedUnion("section", [
  z.object({ section: z.literal("website"), groupId: idSchema }),
  z.object({ section: z.literal("projects") }),
])
type List = z.infer<typeof listSchema>

const entrySchema = z.object({ id: z.number(), name: z.string(), detail: z.string().nullable() })
const groupSchema = z.object({ id: z.number(), title: z.string(), icon: iconSchema, entries: z.array(entrySchema) })

const groupColumns = { id: GROUPS.id, title: GROUPS.title, icon: GROUPS.icon, position: GROUPS.position }
const entryColumns = {
  id: ENTRIES.id,
  section: ENTRIES.section,
  groupId: ENTRIES.groupId,
  name: ENTRIES.name,
  detail: ENTRIES.detail,
  position: ENTRIES.position,
}

type Tx = Parameters<Parameters<typeof DB.transaction>[0]>[0]

const sameIds = (a: number[], b: number[]) => a.length === b.length && new Set([...a, ...b]).size === a.length

/** The entries of one list, as a drizzle condition. */
const inList = (list: List) =>
  list.section === "website"
    ? and(eq(ENTRIES.section, "website"), eq(ENTRIES.groupId, list.groupId))
    : and(eq(ENTRIES.section, "projects"), isNull(ENTRIES.groupId))

const listOf = (entry: { section: "website" | "projects"; groupId: number | null }): List =>
  entry.section === "website" && entry.groupId !== null
    ? { section: "website", groupId: entry.groupId }
    : { section: "projects" }

/** Serialises changes to the list of groups (creation, reordering, deletion), which row locks cannot cover. */
const lockGroupList = (tx: Tx) => tx.execute(sql`select pg_advisory_xact_lock(hashtext('web_acknowledgement_groups'))`)

/**
 * Serialises changes to one list of people (adding, reordering, deleting). A group's row lock guards its people, so a
 * group cannot be deleted under a change to them; the projects list has no row, so it takes an advisory lock.
 * Returns false when the group does not exist.
 */
async function lockList(tx: Tx, list: List) {
  if (list.section === "projects") {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('web_acknowledgements'), 0)`)
    return true
  }
  const [group] = await tx.select({ id: GROUPS.id }).from(GROUPS).where(eq(GROUPS.id, list.groupId)).for("update")
  return !!group
}

/** The position after the last person of a list. */
async function nextEntryPosition(tx: Tx, list: List) {
  const [{ last }] = await tx
    .select({ last: max(ENTRIES.position) })
    .from(ENTRIES)
    .where(inList(list))
  return last === null ? 0 : last + 1
}

/** Every group and person in display order, read from one snapshot. */
async function readAll() {
  return DB.transaction(
    async (tx) => {
      const groups = await tx.select(groupColumns).from(GROUPS).orderBy(asc(GROUPS.position), asc(GROUPS.id))
      const entries = await tx.select(entryColumns).from(ENTRIES).orderBy(asc(ENTRIES.position), asc(ENTRIES.id))
      const entry = ({ id, name, detail }: (typeof entries)[number]) => ({ id, name, detail })
      return {
        website: groups.map(({ id, title, icon }) => ({
          id,
          title,
          icon,
          entries: entries.filter((row) => row.section === "website" && row.groupId === id).map(entry),
        })),
        projects: entries.filter((row) => row.section === "projects").map(entry),
      }
    },
    { isolationLevel: "repeatable read", accessMode: "read only" }
  )
}

const groupTarget = (row: { id: number; title?: string }) => ({
  type: "web.acknowledgementGroup",
  id: row.id,
  label: row.title,
})
const entryTarget = (row: { id: number; name?: string }) => ({
  type: "web.acknowledgement",
  id: row.id,
  label: row.name,
})
const listOrderTarget = (list: List) =>
  list.section === "website"
    ? { type: "web.acknowledgementGroup", id: list.groupId, label: "Acknowledgements order" }
    : { type: "web.acknowledgements", id: "projects", label: "Projects acknowledgements order" }

// Audit states are set once a transaction has committed, and only for calls that changed something.
export default createTRPCRouter({
  /** The acknowledgements page: the website's role groups with their people, then the projects' people. */
  getAll: policy(publicData)
    .output(z.object({ website: z.array(groupSchema), projects: z.array(entrySchema) }))
    .query(() => readAll()),

  createGroup: policy(dashboard("web:content:write"))
    .meta(audit.full())
    .input(z.object({ title: titleSchema, icon: iconSchema }))
    .mutation(async ({ input, ctx }) => {
      const row = await DB.transaction(async (tx) => {
        await lockGroupList(tx)
        const [{ last }] = await tx.select({ last: max(GROUPS.position) }).from(GROUPS)
        const [row] = await tx
          .insert(GROUPS)
          .values({ ...input, position: last === null ? 0 : last + 1, ...createdByColumns(authorOf(ctx.actor)) })
          .returning(groupColumns)
        return row
      })
      ctx.audit.set({ target: groupTarget(row), after: row })
      return row
    }),

  updateGroup: policy(dashboard("web:content:write"))
    .meta(audit.full())
    .input(z.object({ id: idSchema, title: titleSchema.optional(), icon: iconSchema.optional() }))
    .mutation(async ({ input, ctx }) => {
      const { id, ...fields } = input
      const result = await DB.transaction(async (tx) => {
        const [before] = await tx.select(groupColumns).from(GROUPS).where(eq(GROUPS.id, id)).for("update")
        if (!before) return { error: "NOT_FOUND" as const }
        const [row] = await tx
          .update(GROUPS)
          .set({ ...fields, ...modifiedByColumns(authorOf(ctx.actor)) })
          .where(eq(GROUPS.id, id))
          .returning(groupColumns)
        return { before, row }
      })
      if (result.error) return { error: result.error }
      ctx.audit.set({ target: groupTarget(result.row), before: result.before, after: result.row })
      return result.row
    }),

  /** Deletes the group with its people. */
  deleteGroup: policy(dashboard("web:content:write"))
    .meta(audit.full())
    .input(z.object({ id: idSchema }))
    .mutation(async ({ input, ctx }) => {
      const deleted = await DB.transaction(async (tx) => {
        await lockGroupList(tx)
        if (!(await lockList(tx, { section: "website", groupId: input.id }))) return null
        const entries = await tx
          .delete(ENTRIES)
          .where(inList({ section: "website", groupId: input.id }))
          .returning(entryColumns)
        const [group] = await tx.delete(GROUPS).where(eq(GROUPS.id, input.id)).returning(groupColumns)
        return { group, entries: entries.sort((a, b) => a.position - b.position || a.id - b.id) }
      })
      if (!deleted?.group) return { error: "NOT_FOUND" as const }
      ctx.audit.set({ target: groupTarget(deleted.group), before: { ...deleted.group, entries: deleted.entries } })
      return { error: null }
    }),

  /** Saves the order of every group: `ids` must list each of them once. */
  reorderGroups: policy(dashboard("web:content:write"))
    .meta(audit.full())
    .input(z.object({ ids: orderSchema }))
    .mutation(async ({ input, ctx }) => {
      const result = await DB.transaction(async (tx) => {
        await lockGroupList(tx)
        const order = () =>
          tx
            .select({ id: GROUPS.id, title: GROUPS.title, position: GROUPS.position })
            .from(GROUPS)
            .orderBy(asc(GROUPS.position), asc(GROUPS.id))
        const before = await order()
        if (
          !sameIds(
            before.map((row) => row.id),
            input.ids
          )
        )
          return { error: "INVALID_ORDER" as const }
        for (const [position, id] of input.ids.entries())
          await tx.update(GROUPS).set({ position }).where(eq(GROUPS.id, id))
        return { before, after: await order() }
      })
      if (result.error) return { error: result.error }
      ctx.audit.set({
        target: { type: "web.acknowledgementGroups", id: "order", label: "Acknowledgement groups order" },
        before: result.before,
        after: result.after,
      })
      return { error: null }
    }),

  /** Adds a person at the end of a list. */
  createEntry: policy(dashboard("web:content:write"))
    .meta(audit.full())
    .input(z.object({ list: listSchema, name: nameSchema, detail: detailSchema }))
    .mutation(async ({ input, ctx }) => {
      const { list, name, detail } = input
      const result = await DB.transaction(async (tx) => {
        if (!(await lockList(tx, list))) return { error: "GROUP_NOT_FOUND" as const }
        const [row] = await tx
          .insert(ENTRIES)
          .values({
            section: list.section,
            groupId: list.section === "website" ? list.groupId : null,
            name,
            detail: detail || null,
            position: await nextEntryPosition(tx, list),
            ...createdByColumns(authorOf(ctx.actor)),
          })
          .returning(entryColumns)
        return { row }
      })
      if (result.error) return { error: result.error }
      ctx.audit.set({ target: entryTarget(result.row), after: result.row })
      return result.row
    }),

  updateEntry: policy(dashboard("web:content:write"))
    .meta(audit.full())
    .input(z.object({ id: idSchema, name: nameSchema.optional(), detail: detailSchema }))
    .mutation(async ({ input, ctx }) => {
      const { id, name, detail } = input
      const result = await DB.transaction(async (tx) => {
        const [before] = await tx.select(entryColumns).from(ENTRIES).where(eq(ENTRIES.id, id)).for("update")
        if (!before) return { error: "NOT_FOUND" as const }
        const [row] = await tx
          .update(ENTRIES)
          .set({
            ...(name !== undefined ? { name } : {}),
            ...(detail !== undefined ? { detail: detail || null } : {}),
            ...modifiedByColumns(authorOf(ctx.actor)),
          })
          .where(eq(ENTRIES.id, id))
          .returning(entryColumns)
        return { before, row }
      })
      if (result.error) return { error: result.error }
      ctx.audit.set({ target: entryTarget(result.row), before: result.before, after: result.row })
      return result.row
    }),

  deleteEntry: policy(dashboard("web:content:write"))
    .meta(audit.full())
    .input(z.object({ id: idSchema }))
    .mutation(async ({ input, ctx }) => {
      const deleted = await DB.transaction(async (tx) => {
        const [entry] = await tx.select(entryColumns).from(ENTRIES).where(eq(ENTRIES.id, input.id))
        if (!entry) return null
        await lockList(tx, listOf(entry))
        const [row] = await tx.delete(ENTRIES).where(eq(ENTRIES.id, input.id)).returning(entryColumns)
        return row ?? null
      })
      if (!deleted) return { error: "NOT_FOUND" as const }
      ctx.audit.set({ target: entryTarget(deleted), before: deleted })
      return { error: null }
    }),

  /** Saves the order of a list: `ids` must list each of its people once. */
  reorderEntries: policy(dashboard("web:content:write"))
    .meta(audit.full())
    .input(z.object({ list: listSchema, ids: orderSchema }))
    .mutation(async ({ input, ctx }) => {
      const { list, ids } = input
      const result = await DB.transaction(async (tx) => {
        if (!(await lockList(tx, list))) return { error: "INVALID_ORDER" as const }
        const order = () =>
          tx
            .select({ id: ENTRIES.id, name: ENTRIES.name, position: ENTRIES.position })
            .from(ENTRIES)
            .where(inList(list))
            .orderBy(asc(ENTRIES.position), asc(ENTRIES.id))
        const before = await order()
        if (
          !sameIds(
            before.map((row) => row.id),
            ids
          )
        )
          return { error: "INVALID_ORDER" as const }
        for (const [position, id] of ids.entries()) await tx.update(ENTRIES).set({ position }).where(eq(ENTRIES.id, id))
        return { before, after: await order() }
      })
      if (result.error) return { error: result.error }
      ctx.audit.set({ target: listOrderTarget(list), before: result.before, after: result.after })
      return { error: null }
    }),
})
