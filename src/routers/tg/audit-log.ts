import { TRPCError } from "@trpc/server"
import { desc, eq, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import { z } from "zod"
import { DB, SCHEMA } from "@/db"
import {
  ARRAY_AUDIT_TYPE,
  AUDIT_BASIS,
  AUDIT_REVIEW,
  type TAuditReview,
  type TAuditType,
} from "@/db/schema/tg/audit-log"
import { dashboard, SCOPE } from "@/idp/policies"
import { createTRPCRouter, legacyProcedure, policy } from "@/trpc"
import { decryptUser } from "@/utils/users"

const AUDIT_LOG = SCHEMA.TG.auditLog

/** The permission an `idp_permission` action claims (RFC v3 §4.1). */
const CLAIMED_PERMISSION: Record<TAuditType, string> = {
  ban: "tg:moderate",
  unban: "tg:moderate",
  kick: "tg:moderate",
  mute: "tg:moderate",
  unmute: "tg:moderate",
  ban_all: "tg:moderate:global",
  unban_all: "tg:moderate:global",
}

/** Bases the bot reports (RFC v3 §10.2); `legacy` is only for old rows. */
const RECORDED_BASES = [
  AUDIT_BASIS.IDP_PERMISSION,
  AUDIT_BASIS.TELEGRAM_CHAT_ADMIN,
  AUDIT_BASIS.AUTOMATIC,
  AUDIT_BASIS.TELEGRAM_UI,
] as const

export default createTRPCRouter({
  /** Legacy path; replaced by `record`. */
  create: legacyProcedure
    .input(
      z.object({
        adminId: z.number(),
        targetId: z.number(),
        type: z.enum(ARRAY_AUDIT_TYPE),
        groupId: z.number().nullable(), // NULL in "*_ALL" audit types
        until: z.date().nullable(),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      await DB.insert(AUDIT_LOG)
        .values({ ...input, actorTgId: input.adminId, basis: AUDIT_BASIS.LEGACY })
        .onConflictDoNothing()
    }),

  /**
   * Records a moderation action that already happened on Telegram (RFC v3 §9.2). It is never
   * rejected for the actor's permissions, which would only lose history: an `idp_permission`
   * action the snapshot does not back is stored and flagged for review instead. A repeated
   * `idempotencyKey` records nothing and returns the first record.
   */
  record: policy({ service: { scope: SCOPE.tgAudit } }, { tokenOnly: true })
    .input(
      z
        .object({
          idempotencyKey: z.string().min(1).max(128),
          type: z.enum(ARRAY_AUDIT_TYPE),
          targetId: z.number().int(),
          groupId: z.number().int().nullable(), // NULL in "*_ALL" audit types
          until: z.date().nullable(),
          reason: z.string().max(256).optional(),
          basis: z.enum(RECORDED_BASES),
          /** Who acted; null only for automatic actions and changes made in Telegram's UI. */
          actorTelegramId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
        })
        .refine(
          (input) =>
            input.actorTelegramId !== null ||
            input.basis === AUDIT_BASIS.AUTOMATIC ||
            input.basis === AUDIT_BASIS.TELEGRAM_UI,
          { message: "This basis needs an actor", path: ["actorTelegramId"] }
        )
    )
    .output(z.object({ id: z.number(), duplicate: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const { actor, access } = ctx
      if (!actor) throw new TRPCError({ code: "UNAUTHORIZED" })

      const telegramId = input.actorTelegramId === null ? null : String(input.actorTelegramId)
      const subject = telegramId ? access?.subjectByTelegramId(telegramId) : undefined
      let review: TAuditReview | null = null
      if (input.basis === AUDIT_BASIS.IDP_PERMISSION && telegramId) {
        const claimed = CLAIMED_PERMISSION[input.type]
        const backed = access?.has(
          { kind: "telegram", client: actor.client, telegramId, sub: subject?.sub ?? null },
          claimed
        )
        if (!access?.status().fresh) review = AUDIT_REVIEW.UNVERIFIED
        else if (!backed) review = AUDIT_REVIEW.PERMISSION_MISSING
      }

      const [inserted] = await DB.insert(AUDIT_LOG)
        .values({
          adminId: input.actorTelegramId,
          actorTgId: input.actorTelegramId,
          actorSub: subject?.sub ?? null,
          targetId: input.targetId,
          groupId: input.groupId,
          type: input.type,
          until: input.until,
          reason: input.reason,
          client: actor.client,
          basis: input.basis,
          review,
          idempotencyKey: input.idempotencyKey,
        })
        .onConflictDoNothing({ target: AUDIT_LOG.idempotencyKey })
        .returning({ id: AUDIT_LOG.id })
      if (inserted) return { id: inserted.id, duplicate: false }

      const [existing] = await DB.select({ id: AUDIT_LOG.id })
        .from(AUDIT_LOG)
        .where(eq(AUDIT_LOG.idempotencyKey, input.idempotencyKey))
        .limit(1)
      if (!existing) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Audit record not stored" })
      return { id: existing.id, duplicate: true }
    }),

  getById: policy({
    service: { scope: SCOPE.tgRead },
    telegram: { scope: SCOPE.tgRead, permission: "tg:audit:read" },
    ...dashboard("tg:audit:read"),
  })
    .input(
      z.object({
        targetId: z.number(),
      })
    )
    .query(async ({ input }) => {
      const admin = alias(SCHEMA.TG.users, "admin")

      const res = await DB.select()
        .from(AUDIT_LOG)
        .where((t) => eq(t.targetId, input.targetId))
        .leftJoin(SCHEMA.TG.groups, eq(AUDIT_LOG.groupId, SCHEMA.TG.groups.telegramId))
        // Rows written by an older release during a rollback have only admin_id.
        .leftJoin(admin, eq(sql`coalesce(${AUDIT_LOG.actorTgId}, ${AUDIT_LOG.adminId})`, admin.userId))
        .orderBy(desc(AUDIT_LOG.createdAt))

      return await Promise.all(
        res.map(async (e) => ({
          ...e.audit_log,
          groupTitle: e.groups?.title,
          admin: e.admin ? await decryptUser(e.admin).catch(() => null) : null,
        }))
      )
    }),
})
