import { eq, and, desc, isNull, count } from "drizzle-orm"
import { z } from "zod"
import { alias } from "drizzle-orm/pg-core"
import { DB, SCHEMA } from "@/db"
import { createTRPCRouter } from "@/trpc";
import { loggerProcedure } from "@/utils/loggerProc";
import { decryptUser } from "@/utils/users";


/**
 * Warnings router - CRUD for per-user warnings across PoliNetwork groups.
 *
 * A warning is a soft-deletable record tied to a target user, an admin who
 * issued it, and the group where it was created. When the bot detects that a
 * user has crossed configurable thresholds (3 in a group → kick, 4 globally →
 * ban-all), it uses the `getActiveCountInGroup` and `getTotalActiveCount`
 * queries to decide whether to trigger automatic moderation.
 */
export default createTRPCRouter({
    /**
     * create - Inserts a new warning for a target user in a specific group.
     *
     * Accepts the target, admin, and group Telegram IDs plus an optional
     * reason string. Returns `{ error: null }` on success or an error message
     * if the insert failed (e.g. constraint violation).
     *
     * Used by: /warn command handler.
     */
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
            const [result] = await DB.insert(SCHEMA.TG.warnings)
                .values(input)
                .returning()
            return { error: result ? null : "Failed to create warning" }
        }),
    /**
     * getByTarget - Returns all warnings (active, expired, and soft-deleted)
     * for a given user, joined with the issuing group, admin, and target user
     * records. Ordered by creation date descending (newest first).
     *
     * Admin and target user data is decrypted before being returned.
     *
     * Used by: /warns command handler.
     */
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
    /**
     * deleteById - Soft-deletes a warning by setting its `deletedAt` timestamp.
     *
     * Accepts an optional `groupId` scoping parameter. When provided, the
     * delete only succeeds if the warning also belongs to that group. This
     * prevents group admins from deleting warnings that were issued in other
     * groups. Without `groupId` (i.e. when called from DMs by owner/direttivo),
     * the delete applies globally by warning ID alone.
     *
     * Only active, non-expired warnings can be deleted.
     *
     * Used by: /unwarn command handler.
     */
    deleteById: loggerProcedure
        .input(
            z.object({
                id: z.number(),
                groupId: z.number().optional(),
            })
        )
        .mutation(async ({input}) => {
            const conditions = [
                eq(SCHEMA.TG.warnings.id, input.id),
                isNull(SCHEMA.TG.warnings.deletedAt),
                eq(SCHEMA.TG.warnings.isExpired, false),
            ]
            if (input.groupId !== undefined) {
                conditions.push(eq(SCHEMA.TG.warnings.groupId, input.groupId))
            }
            const [updated] = await DB.update(SCHEMA.TG.warnings)
                .set({ deletedAt: new Date() })
                .where(and(...conditions))
                .returning()
            return { deleted: !!updated, error: null }
        }),
    /**
     * getTotalActiveCount - Returns the number of active (non-deleted,
     * non-expired) warnings for a user across ALL groups.
     *
     * Used by: /warn command handler to trigger the global auto-ban-all
     * threshold (4+ active warnings).
     */
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
    /**
     * getActiveCountInGroup - Returns the number of active warnings for a
     * user scoped to a specific group.
     *
     * Used by: /warn command handler to trigger the group-level auto-kick
     * threshold (3+ active warnings in the same group).
     */
    getActiveCountInGroup: loggerProcedure
        .input(
            z.object({
                targetId: z.number(),
                groupId: z.number()
            })
        )
        .query(async ({ input }) => {
            // Only count warnings that are not deleted and not expired.
            return await DB.select({ count: count() })
                .from(SCHEMA.TG.warnings)
                .where(and(eq(SCHEMA.TG.warnings.targetId, input.targetId), eq(SCHEMA.TG.warnings.groupId, input.groupId), isNull(SCHEMA.TG.warnings.deletedAt), eq(SCHEMA.TG.warnings.isExpired, false)))
        })
})
