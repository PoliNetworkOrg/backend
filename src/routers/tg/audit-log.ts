import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { DB, SCHEMA } from "@/db"
import { createTRPCRouter, publicProcedure } from "@/trpc"
import {
  AUDIT_TYPE,
  MODERATION_ACTION_TYPE,
  BAN_ALL_ACTION_TYPE,
  GROUP_MANAGEMENT_ACTION_TYPE,
  GRANT_ACTION_TYPE,
  MODERATION_AUDIT_STATUS,
  type TModerationActionType,
  type Duration,
  type PreDeleteResult,
} from "@/routers/tg/types"
import type { User, Chat, Message } from "@grammyjs/types"
import { logger } from "@/logger"

const durationSchema = z.object({
  raw: z.string(),
  date: z.string().datetime(),
  timestamp_s: z.number(),
  secondsFromNow: z.number(),
  dateStr: z.string(),
}) satisfies z.ZodType<Duration>

const preDeleteResultSchema = z.object({
  count: z.number(),
  logMessageIds: z.array(z.number()),
  link: z.string().optional(),
}) satisfies z.ZodType<PreDeleteResult>

// Use actual Grammy types for validation
const userSchema = z.custom<User>((val): val is User => typeof val === "object" && val !== null && "id" in val)
const chatSchema = z.custom<Chat>((val): val is Chat => typeof val === "object" && val !== null && "id" in val && "type" in val)
const messageSchema = z.custom<Message>((val): val is Message => typeof val === "object" && val !== null && "message_id" in val)

/**
 * Bot/backend audit protocol
 *
 * `category` is the only discriminator on the wire. A caller must send one
 * of the six categories below and only the fields belonging to that category.
 * The backend validates the payload, inserts it into the matching audit
 * table, and returns `{ id }` when a row is inserted.
 *
 * Example moderation payload:
 * ```ts
 * {
 *   category: "moderation",
 *   adminId: 7,
 *   targetId: 42,
 *   type: "ban",
 *   action: "BAN",
 *   groupId: -1001,
 *   until: null,
 *   from: moderator,
 *   target,
 *   chat,
 * }
 * ```
 *
 * The bot owns the typed helper that builds these objects. New callers should
 * use that helper rather than calling this tRPC procedure directly.
 */
const moderationInput = z.object({
  category: z.literal("moderation"),
  adminId: z.number(),
  targetId: z.number(),
  type: z.enum([
    AUDIT_TYPE.BAN,
    AUDIT_TYPE.UNBAN,
    AUDIT_TYPE.KICK,
    AUDIT_TYPE.MUTE,
    AUDIT_TYPE.UNMUTE,
    "multi_chat_spam",
  ]),
  action: z.enum([
    MODERATION_ACTION_TYPE.BAN,
    MODERATION_ACTION_TYPE.UNBAN,
    MODERATION_ACTION_TYPE.KICK,
    MODERATION_ACTION_TYPE.MUTE,
    MODERATION_ACTION_TYPE.UNMUTE,
    MODERATION_ACTION_TYPE.MULTI_CHAT_SPAM,
    MODERATION_ACTION_TYPE.SILENT,
  ]),
  groupId: z.number().nullable(),
  until: z.date().nullable(),
  reason: z.string().optional(),
  duration: durationSchema.optional(),
  preDeleteRes: preDeleteResultSchema.nullish(),
  chat: chatSchema,
  from: userSchema,
  target: userSchema,
  messages: z.array(messageSchema).optional(),
  source: z.enum(["manual", "auto", "chat_member_update"]).optional(),
})

/** Cross-group ban/unban protocol. */
const banAllInput = z.object({
  category: z.literal("ban_all"),
  adminId: z.number(),
  targetId: z.number(),
  type: z.enum([AUDIT_TYPE.BAN_ALL, AUDIT_TYPE.UNBAN_ALL]),
  action: z.enum([BAN_ALL_ACTION_TYPE.BAN, BAN_ALL_ACTION_TYPE.UNBAN]).optional(),
  groupId: z.number().nullable(),
  until: z.date().nullable(),
  reason: z.string().optional(),
  from: userSchema.optional(),
  target: userSchema.optional(),
  source: z.enum(["manual", "auto"]).optional(),
})

/**
 * One deleted-message protocol event. The bot sends one event per message,
 * only after Telegram confirms that message deletion succeeded.
 */
const deletedInput = z.object({
  category: z.literal("deleted"),
  messageId: z.number(),
  chatId: z.number(),
  authorId: z.number(),
  author: userSchema.optional(),
  deletedById: z.number(),
  deletedBy: userSchema,
  deletedAt: z.date(),
  reason: z.string().optional(),
  preDeleteRes: preDeleteResultSchema.nullish(),
  source: z.enum(["moderation", "auto", "manual"]).optional(),
})

/** Exception/error protocol event. */
const exceptionInput = z.object({
  category: z.literal("exception"),
  type: z.enum(["UNHANDLED_PROMISE", "BOT_ERROR", "HTTP_ERROR", "GENERIC", "UNKNOWN"]),
  error: z.unknown(),
  context: z.unknown().optional(),
  source: z.enum(["bot", "api", "web"]).optional(),
})

/** Group lifecycle and management protocol event. */
const groupManagementInput = z.object({
  category: z.literal("group_management"),
  type: z.enum([
    GROUP_MANAGEMENT_ACTION_TYPE.LEAVE,
    GROUP_MANAGEMENT_ACTION_TYPE.LEAVE_FAIL,
    GROUP_MANAGEMENT_ACTION_TYPE.DELETE,
    GROUP_MANAGEMENT_ACTION_TYPE.CREATE,
    GROUP_MANAGEMENT_ACTION_TYPE.UPDATE,
    GROUP_MANAGEMENT_ACTION_TYPE.CREATE_FAIL,
    GROUP_MANAGEMENT_ACTION_TYPE.UPDATE_FAIL,
    GROUP_MANAGEMENT_ACTION_TYPE.REGENERATE_LINKS_START,
    GROUP_MANAGEMENT_ACTION_TYPE.REGENERATE_LINKS_COMPLETE,
    GROUP_MANAGEMENT_ACTION_TYPE.REGENERATE_LINKS_ABORTED,
  ]),
  chat: chatSchema.optional(),
  addedBy: userSchema.optional(),
  inviteLink: z.string().optional(),
  reason: z.string().optional(),
  requestedBy: userSchema.optional(),
  total: z.number().optional(),
  regenerated: z.number().optional(),
  synchronized: z.number().optional(),
  failures: z
    .array(
      z.object({
        telegramId: z.number(),
        title: z.string(),
        stage: z.enum(["TELEGRAM", "BACKEND"]),
        reason: z.string(),
      })
    )
    .optional(),
  source: z.enum(["bot", "api"]).optional(),
})

/** Grant usage, creation, and interruption protocol event. */
const grantInput = z.object({
  category: z.literal("grant"),
  action: z.enum([GRANT_ACTION_TYPE.USAGE, GRANT_ACTION_TYPE.CREATE, GRANT_ACTION_TYPE.INTERRUPT]),
  from: userSchema.optional(),
  message: messageSchema.optional(),
  chat: chatSchema.optional(),
  target: userSchema.optional(),
  by: userSchema.optional(),
  since: z.date().optional(),
  until: z.date().optional(),
  reason: z.string().optional(),
  interruptedBy: userSchema.optional(),
  source: z.enum(["bot", "api"]).optional(),
})

const markDeletedInput = z.object({
  chatId: z.number(),
  messageIds: z.array(z.number()),
})

const updateModerationInput = z.object({
  id: z.number(),
  status: z.enum([
    MODERATION_AUDIT_STATUS.PENDING,
    MODERATION_AUDIT_STATUS.RUNNING,
    MODERATION_AUDIT_STATUS.COMPLETED,
    MODERATION_AUDIT_STATUS.PARTIAL,
    MODERATION_AUDIT_STATUS.FAILED,
  ]).optional(),
  deletedMessageCount: z.number().nullable().optional(),
  totalGroupCount: z.number().optional(),
  successGroupCount: z.number().optional(),
  failedGroupCount: z.number().optional(),
})

/**
 * Central protocol validator. Add a new category here when extending the
 * protocol, and add the matching insert branch in `create` below. Do not add
 * compatibility schemas for old payloads: invalid or legacy shapes must fail.
 */
const unifiedInput = z.discriminatedUnion("category", [
  moderationInput,
  banAllInput,
  deletedInput,
  exceptionInput,
  groupManagementInput,
  grantInput,
])

export default createTRPCRouter({
  /**
   * Insert one category-specific audit event and return its row ID.
   *
   * The `switch` is intentionally exhaustive by category. To add a category:
   * 1. Define a Zod schema above with `category: z.literal("new_category")`.
   * 2. Add it to `unifiedInput`.
   * 3. Add its table insert and `.returning({ id: ... })` branch here.
   * 4. Add the matching bot type/helper and focused tests on both sides.
   * 5. Keep field names identical between the bot type, this schema, and DB.
   */
  create: publicProcedure
    .input(unifiedInput)
    .mutation(async ({ input }) => {
      logger.info(`Recived ${JSON.stringify(input)}`)
      switch (input.category) {
        case "moderation": {
          const chatId = input.groupId ?? input.chat.id
          const [created] = await DB.insert(SCHEMA.TG.moderationLog).values({
            adminId: input.adminId,
            admin: input.from,
            targetId: input.targetId,
            target: input.target,
            chatId,
            chat: input.chat,
            type: input.action as TModerationActionType,
            duration: input.duration
              ? {
                  raw: input.duration.raw,
                  date: input.duration.date,
                  timestamp_s: input.duration.timestamp_s,
                  secondsFromNow: input.duration.secondsFromNow,
                  dateStr: input.duration.dateStr,
                }
              : null,
            reason: input.reason ?? null,
            preDeleteRes: input.preDeleteRes ?? null,
            source: input.source ?? "manual",
          }).onConflictDoNothing().returning({ id: SCHEMA.TG.moderationLog.id })
          return created ?? null
        }
        case "ban_all": {
          const action = input.action ?? (input.type === AUDIT_TYPE.BAN_ALL ? BAN_ALL_ACTION_TYPE.BAN : BAN_ALL_ACTION_TYPE.UNBAN)
          const [created] = await DB.insert(SCHEMA.TG.banAllLog).values({
            adminId: input.adminId,
            admin: input.from ?? { id: input.adminId, is_bot: false, first_name: "Unknown", last_name: "", username: "", language_code: "" },
            targetId: input.targetId,
            target: input.target ?? { id: input.targetId, is_bot: false, first_name: "Unknown", last_name: "", username: "", language_code: "" },
            type: action,
            reason: input.reason ?? null,
            source: input.source ?? "manual",
          }).onConflictDoNothing().returning({ id: SCHEMA.TG.banAllLog.id })
          return created ?? null
        }
        case "deleted": {
          const [created] = await DB.insert(SCHEMA.TG.deletedLog).values({
            messageId: input.messageId,
            chatId: input.chatId,
            authorId: input.authorId,
            author: input.author ?? null,
            deletedById: input.deletedById,
            deletedBy: input.deletedBy,
            deletedAt: input.deletedAt,
            reason: input.reason ?? null,
            preDeleteRes: input.preDeleteRes ?? null,
            source: input.source ?? "moderation",
          }).onConflictDoNothing().returning({ id: SCHEMA.TG.deletedLog.id })
          return created ?? null
        }
        case "exception": {
          const [created] = await DB.insert(SCHEMA.TG.exceptionLog).values({
            type: input.type,
            error: input.error,
            context: input.context ?? null,
            source: input.source ?? "bot",
          }).onConflictDoNothing().returning({ id: SCHEMA.TG.exceptionLog.id })
          return created ?? null
        }
        case "group_management": {
          const [created] = await DB.insert(SCHEMA.TG.groupManagementLog).values({
            type: input.type,
            chat: input.chat ?? null,
            addedBy: input.addedBy ?? null,
            inviteLink: input.inviteLink ?? null,
            reason: input.reason ?? null,
            requestedBy: input.requestedBy ?? null,
            total: input.total ?? null,
            regenerated: input.regenerated ?? null,
            synchronized: input.synchronized ?? null,
            failures: input.failures ?? null,
            source: input.source ?? "bot",
          }).onConflictDoNothing().returning({ id: SCHEMA.TG.groupManagementLog.id })
          return created ?? null
        }
        case "grant": {
          const sourceMessage = input.message
          const message = sourceMessage?.from
            ? {
                message_id: sourceMessage.message_id,
                date: sourceMessage.date,
                chat: {
                  id: sourceMessage.chat.id,
                  type: sourceMessage.chat.type,
                },
                from: sourceMessage.from,
              }
            : null

          const [created] = await DB.insert(SCHEMA.TG.grantLog).values({
            action: input.action,
            from: input.from ?? null,
            message,
            chat: input.chat ?? null,
            target: input.target ?? null,
            by: input.by ?? null,
            since: input.since ?? null,
            until: input.until ?? null,
            reason: input.reason ?? null,
            interruptedBy: input.interruptedBy ?? null,
            source: input.source ?? "bot",
          }).onConflictDoNothing().returning({ id: SCHEMA.TG.grantLog.id })
          return created ?? null
        }
      }
    }),

  /** Update progress for a moderation or ban-all operation using its row ID. */
  update: publicProcedure
    .input(updateModerationInput)
    .mutation(async ({ input }) => {
      const { id, ...updates } = input
      const updated = await DB.update(SCHEMA.TG.moderationLog)
        .set(updates)
        .where(eq(SCHEMA.TG.moderationLog.id, id))
        .returning()
      return { updated: updated.length > 0 }
    }),

  /**
   * Mark message storage rows as deleted after Telegram deletion succeeds.
   * This does not create an audit event; the bot separately sends one
   * `category: "deleted"` event per successfully deleted message.
   */
  markMessagesDeleted: publicProcedure
    .input(markDeletedInput)
    .mutation(async ({ input }) => {
      const { chatId, messageIds } = input
      const deletedAt = new Date()
      let count = 0
      for (const messageId of messageIds) {
        const updated = await DB.update(SCHEMA.TG.messages)
          .set({ deletedAt })
          .where(and(eq(SCHEMA.TG.messages.chatId, chatId), eq(SCHEMA.TG.messages.messageId, messageId)))
          .returning()
        if (updated.length > 0) count++
      }
      return { count, deletedAt }
    }),
})