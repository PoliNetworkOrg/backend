import { and, desc, eq, inArray } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import { z } from "zod"
import { DB, SCHEMA } from "@/db"
import { ARRAY_AUDIT_STATUS, ARRAY_AUDIT_TYPE, AUDIT_STATUS } from "@/db/schema/tg/audit-log"
import { createTRPCRouter, publicProcedure } from "@/trpc"
import { decryptUser } from "@/utils/users"

const auditProgress = {
  status: z.enum(ARRAY_AUDIT_STATUS).optional(),
  deletedMessageCount: z.number().int().nonnegative().nullable().optional(),
  totalGroupCount: z.number().int().nonnegative().optional(),
  successGroupCount: z.number().int().nonnegative().optional(),
  failedGroupCount: z.number().int().nonnegative().optional(),
}

export default createTRPCRouter({
  create: publicProcedure
    .input(
      z.object({
        adminId: z.number(),
        targetId: z.number(),
        type: z.enum(ARRAY_AUDIT_TYPE),
        groupId: z.number().nullable(), // NULL in "*_ALL" audit types
        until: z.date().nullable(),
        reason: z.string().max(256).optional(),
        ...auditProgress,
      })
    )
    .mutation(async ({ input }) => {
      const [created] = await DB.insert(SCHEMA.TG.auditLog).values(input).returning({ id: SCHEMA.TG.auditLog.id })

      return created ?? null
    }),

  update: publicProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        ...auditProgress,
      })
    )
    .mutation(async ({ input: { id, ...progress } }) => {
      const where =
        progress.status !== undefined
          ? and(
              eq(SCHEMA.TG.auditLog.id, id),
              inArray(SCHEMA.TG.auditLog.status, [AUDIT_STATUS.PENDING, AUDIT_STATUS.RUNNING])
            )
          : eq(SCHEMA.TG.auditLog.id, id)
      const [updated] = await DB.update(SCHEMA.TG.auditLog)
        .set({ ...progress, updatedAt: new Date() })
        .where(where)
        .returning({ id: SCHEMA.TG.auditLog.id })

      return { updated: updated !== undefined }
    }),

  getById: publicProcedure
    .input(
      z.object({
        targetId: z.number(),
      })
    )
    .query(async ({ input }) => {
      const admin = alias(SCHEMA.TG.users, "admin")

      const res = await DB.select()
        .from(SCHEMA.TG.auditLog)
        .where((t) => eq(t.targetId, input.targetId))
        .leftJoin(SCHEMA.TG.groups, eq(SCHEMA.TG.auditLog.groupId, SCHEMA.TG.groups.telegramId))
        .leftJoin(admin, eq(SCHEMA.TG.auditLog.adminId, admin.userId))
        .orderBy(desc(SCHEMA.TG.auditLog.createdAt))

      return await Promise.all(
        res.map(async (e) => ({
          ...e.audit_log,
          groupTitle: e.groups?.title,
          admin: e.admin ? await decryptUser(e.admin).catch(() => null) : null,
        }))
      )
    }),

  getAll: publicProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(100) }).optional())
    .query(async ({ input }) => {
      const admin = alias(SCHEMA.TG.users, "admin")
      const target = alias(SCHEMA.TG.users, "target")
      const res = await DB.select()
        .from(SCHEMA.TG.auditLog)
        .leftJoin(SCHEMA.TG.groups, eq(SCHEMA.TG.auditLog.groupId, SCHEMA.TG.groups.telegramId))
        .leftJoin(admin, eq(SCHEMA.TG.auditLog.adminId, admin.userId))
        .leftJoin(target, eq(SCHEMA.TG.auditLog.targetId, target.userId))
        .orderBy(desc(SCHEMA.TG.auditLog.createdAt))
        .limit(input?.limit ?? 100)

      return await Promise.all(
        res.map(async (entry) => ({
          ...entry.audit_log,
          groupTitle: entry.groups?.title,
          admin: entry.admin ? await decryptUser(entry.admin).catch(() => null) : null,
          target: entry.target ? await decryptUser(entry.target).catch(() => null) : null,
        }))
      )
    }),
})
