import { eq, and, desc, isNull, count } from "drizzle-orm"
import { z } from "zod"
import { alias } from "drizzle-orm/pg-core"
import { DB, SCHEMA } from "@/db"
import { createTRPCRouter } from "@/trpc";
import { loggerProcedure } from "@/utils/loggerProc";
import { decryptUser } from "@/utils/users";


export default createTRPCRouter({
    // Create a new warning
    create: loggerProcedure
        .input(
            z.object({
                targetId: z.number(),
                adminId: z.number(),
                groupId: z.number(),
                reason: z.string().optional(),
            })
        )
        .mutation(async ({ input }) => {
            await DB.insert(SCHEMA.TG.warnings)
                .values(input)
                .onConflictDoNothing()
                .returning()
            return { error: null }
        }),
    // All warnings (including expired), joined with users/groups, ordered by createdAt desc
    getByTarget: loggerProcedure
        .input(
            z.object({
                targetId: z.number()
            })
        )
        .query(async ({ input }) => {
            const admin = alias(SCHEMA.TG.users, "admin")
            const target = alias(SCHEMA.TG.users, "target")

            const res = await DB.select()
                .from(SCHEMA.TG.warnings)
                .where(eq(SCHEMA.TG.warnings.targetId, input.targetId))
                .leftJoin(SCHEMA.TG.groups, eq(SCHEMA.TG.warnings.groupId, SCHEMA.TG.groups.telegramId))
                .leftJoin(admin, eq(SCHEMA.TG.warnings.adminId, admin.userId))
                .leftJoin(target, eq(SCHEMA.TG.warnings.targetId, target.userId))
                .orderBy(desc(SCHEMA.TG.warnings.createdAt))

            return await Promise.all(
                res.map(async (row) => ({
                    ...row.warnings,
                    group: row.groups ? { title: row.groups.title, inviteLink: row.groups.link } : null,
                    admin: row.admin ? await decryptUser(row.admin).catch(() => null) : null,
                    target: row.target ? await decryptUser(row.target).catch(() => null) : null,
                }))
            )
        }),
    // Set deletedAt on a specific warning (used by unwarn)
    deleteById: loggerProcedure
        .input(
            z.object({
                id: z.number()
            })
        )
        .mutation(async ({input}) => {
            const [updated] = await DB.update(SCHEMA.TG.warnings)
                .set({ deletedAt: new Date() })
                .where(and(
                    eq(SCHEMA.TG.warnings.id, input.id),
                    isNull(SCHEMA.TG.warnings.deletedAt),
                    eq(SCHEMA.TG.warnings.isExpired, false)
                ))
                .returning()
            return { deleted: !!updated, error: null }
        }),
    // Count active warnings for user across ALL groups
    getTotalActiveCount: loggerProcedure
        .input(
            z.object({
                targetId: z.number()
            })
        )
        .query(async ({ input }) => {
            return await DB.select({ count: count() })
                .from(SCHEMA.TG.warnings)
                .where(and(eq(SCHEMA.TG.warnings.targetId, input.targetId), isNull(SCHEMA.TG.warnings.deletedAt), eq(SCHEMA.TG.warnings.isExpired, false)))
        }),
    // Count active warnings for user in group 
    getActiveCountInGroup: loggerProcedure
        .input(
            z.object({
                targetId: z.number(),
                groupId: z.number()
            })
        )
        .query(async ({ input }) => {
            return await DB.select({ count: count() })
                .from(SCHEMA.TG.warnings)
                .where(and(eq(SCHEMA.TG.warnings.targetId, input.targetId), eq(SCHEMA.TG.warnings.groupId, input.groupId), isNull(SCHEMA.TG.warnings.deletedAt), eq(SCHEMA.TG.warnings.isExpired, false)))
        })
})