import type { Chat, Message, User, ApiResponse } from "@grammyjs/types"

export type Duration = {
  raw: string
  date: string
  timestamp_s: number
  secondsFromNow: number
  dateStr: string
}

export type PreDeleteResult = {
  count: number
  logMessageIds: number[]
  link?: string
}

export type GroupLinkRegenerationFailure = {
  telegramId: number
  title: string
  stage: "TELEGRAM" | "BACKEND"
  reason: string
}

export const MODERATION_ACTION_TYPE = {
  BAN: "ban",
  UNBAN: "unban",
  KICK: "kick",
  MUTE: "mute",
  UNMUTE: "unmute",
  MULTI_CHAT_SPAM: "multi_chat_spam",
  SILENT: "silent",
} as const
export type TModerationActionType = (typeof MODERATION_ACTION_TYPE)[keyof typeof MODERATION_ACTION_TYPE]

export const MODERATION_AUDIT_STATUS = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  PARTIAL: "partial",
  FAILED: "failed",
} as const
export type TModerationAuditStatus = (typeof MODERATION_AUDIT_STATUS)[keyof typeof MODERATION_AUDIT_STATUS]

export type ModerationActionBase = {
  from: User
  target: User
  chat: Chat
  preDeleteRes?: PreDeleteResult | null
}

export type ModerationAction =
  | (ModerationActionBase & {
      action: typeof MODERATION_ACTION_TYPE.BAN | typeof MODERATION_ACTION_TYPE.MUTE
      duration?: Duration
      reason?: string
    })
  | (ModerationActionBase & {
      action: typeof MODERATION_ACTION_TYPE.KICK
      reason?: string
    })
  | (ModerationActionBase & {
      action: typeof MODERATION_ACTION_TYPE.UNBAN | typeof MODERATION_ACTION_TYPE.UNMUTE
    })
  | (ModerationActionBase & {
      action: typeof MODERATION_ACTION_TYPE.MULTI_CHAT_SPAM
      duration: Duration
      messages: Message[]
    })
  | (ModerationActionBase & {
      action: typeof MODERATION_ACTION_TYPE.SILENT
      reason?: string
    })

export const GROUP_MANAGEMENT_ACTION_TYPE = {
  LEAVE: "leave",
  LEAVE_FAIL: "leave_fail",
  DELETE: "delete",
  CREATE: "create",
  UPDATE: "update",
  CREATE_FAIL: "create_fail",
  UPDATE_FAIL: "update_fail",
  REGENERATE_LINKS_START: "regenerate_links_start",
  REGENERATE_LINKS_COMPLETE: "regenerate_links_complete",
  REGENERATE_LINKS_ABORTED: "regenerate_links_aborted",
} as const
export type TGroupManagementActionType = (typeof GROUP_MANAGEMENT_ACTION_TYPE)[keyof typeof GROUP_MANAGEMENT_ACTION_TYPE]

export type GroupManagementAction =
  | {
      type: typeof GROUP_MANAGEMENT_ACTION_TYPE.LEAVE | typeof GROUP_MANAGEMENT_ACTION_TYPE.LEAVE_FAIL
      chat: Chat
      addedBy: User
    }
  | {
      type: typeof GROUP_MANAGEMENT_ACTION_TYPE.DELETE
      chat: Chat
    }
  | {
      type: typeof GROUP_MANAGEMENT_ACTION_TYPE.CREATE | typeof GROUP_MANAGEMENT_ACTION_TYPE.UPDATE
      chat: Chat
      addedBy: User
      inviteLink: string
    }
  | {
      type: typeof GROUP_MANAGEMENT_ACTION_TYPE.CREATE_FAIL | typeof GROUP_MANAGEMENT_ACTION_TYPE.UPDATE_FAIL
      reason: string
      inviteLink?: string
    }
  | {
      type: typeof GROUP_MANAGEMENT_ACTION_TYPE.REGENERATE_LINKS_START
      requestedBy: User
    }
  | {
      type: typeof GROUP_MANAGEMENT_ACTION_TYPE.REGENERATE_LINKS_COMPLETE
      requestedBy: User
      total: number
      regenerated: number
      synchronized: number
      failures: GroupLinkRegenerationFailure[]
    }
  | {
      type: typeof GROUP_MANAGEMENT_ACTION_TYPE.REGENERATE_LINKS_ABORTED
      requestedBy: User
      reason: string
    }

export const BAN_ALL_ACTION_TYPE = {
  BAN: "ban",
  UNBAN: "unban",
} as const
export type TBanAllActionType = (typeof BAN_ALL_ACTION_TYPE)[keyof typeof BAN_ALL_ACTION_TYPE]

export type BanAllAction =
  | {
      type: typeof BAN_ALL_ACTION_TYPE.BAN
      target: User
      from: User
      reason?: string
    }
  | {
      type: typeof BAN_ALL_ACTION_TYPE.UNBAN
      target: User
      from: User
    }

export const GRANT_ACTION_TYPE = {
  USAGE: "usage",
  CREATE: "create",
  INTERRUPT: "interrupt",
} as const
export type TGrantActionType = (typeof GRANT_ACTION_TYPE)[keyof typeof GRANT_ACTION_TYPE]

export type GrantAction =
  | {
      action: typeof GRANT_ACTION_TYPE.USAGE
      from: User
      message: Message
      chat: Chat
    }
  | {
      action: typeof GRANT_ACTION_TYPE.CREATE
      target: User
      by: User
      since: Date
      until: Date
      reason?: string
    }
  | {
      action: typeof GRANT_ACTION_TYPE.INTERRUPT
      target: User
      by: User
    }

export type ModerationErrorCode =
  | "CANNOT_MOD_YOURSELF"
  | "CANNOT_MOD_BOT"
  | "CANNOT_MOD_GROUPADMIN"
  | "PERFORM_ERROR"
export type ModerationError = { code: ModerationErrorCode; fmtError: string; strError: string }

export type ExceptionLog =
  | { type: "UNHANDLED_PROMISE"; error: Error; promise: Promise<unknown> }
  | { type: "BOT_ERROR"; error: ApiResponse<never> & { ok: false } }
  | { type: "HTTP_ERROR"; error: Error }
  | { type: "GENERIC"; error: Error }
  | { type: "UNKNOWN"; error: unknown }

export type DeletedMessageLog = {
  messageId: number
  chatId: number
  authorId: number
  deletedBy: User
  deletedAt: Date
  preDeleteRes?: PreDeleteResult | null
}

export const AUDIT_CATEGORY = {
  MODERATION: "moderation",
  BAN_ALL: "ban_all",
  GROUP_MANAGEMENT: "group_management",
  GRANT: "grant",
  EXCEPTION: "exception",
  DELETED: "deleted",
} as const
export type TAuditCategory = (typeof AUDIT_CATEGORY)[keyof typeof AUDIT_CATEGORY]

export type AuditAction =
  | { category: typeof AUDIT_CATEGORY.MODERATION; action: ModerationAction }
  | { category: typeof AUDIT_CATEGORY.BAN_ALL; action: BanAllAction }
  | { category: typeof AUDIT_CATEGORY.GROUP_MANAGEMENT; action: GroupManagementAction }
  | { category: typeof AUDIT_CATEGORY.GRANT; action: GrantAction }
  | { category: typeof AUDIT_CATEGORY.EXCEPTION; action: ExceptionLog }
  | { category: typeof AUDIT_CATEGORY.DELETED; action: DeletedMessageLog }

export const AUDIT_TYPE = {
  BAN: "ban",
  UNBAN: "unban",
  KICK: "kick",
  MUTE: "mute",
  UNMUTE: "unmute",
  BAN_ALL: "ban_all",
  UNBAN_ALL: "unban_all",
} as const
export type TAuditType = (typeof AUDIT_TYPE)[keyof typeof AUDIT_TYPE]

export const ARRAY_AUDIT_TYPE = [
  AUDIT_TYPE.BAN,
  AUDIT_TYPE.UNBAN,
  AUDIT_TYPE.KICK,
  AUDIT_TYPE.MUTE,
  AUDIT_TYPE.UNMUTE,
  AUDIT_TYPE.BAN_ALL,
  AUDIT_TYPE.UNBAN_ALL,
] as const