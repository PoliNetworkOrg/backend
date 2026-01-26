import { bigint, index, primaryKey, text } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { createTable } from "../create-table"

export const USER_ROLE = {
  ADMIN: "admin",
  HR: "hr",
  PRESIDENT: "president",
  DIRETTIVO: "direttivo",
  CREATOR: "creator",
  OWNER: "owner",
} as const

export const ARRAY_USER_ROLE = [
  USER_ROLE.ADMIN,
  USER_ROLE.HR,
  USER_ROLE.PRESIDENT,
  USER_ROLE.DIRETTIVO,
  USER_ROLE.OWNER,
  USER_ROLE.CREATOR,
] as const
export type TUserRole = (typeof USER_ROLE)[keyof typeof USER_ROLE]

export const permissions = createTable.tg("permissions", {
  userId: bigint("user_id", { mode: "number" }).primaryKey(),
  roles: text("roles").array().$type<TUserRole[]>().default([USER_ROLE.ADMIN]).notNull(),
  addedBy: bigint("added_by_id", { mode: "number" }).notNull(),
  modifiedBy: bigint("modified_by_id", { mode: "number" }),

  ...timeColumns,
})

export const groupAdmins = createTable.tg(
  "group_admins",
  {
    userId: bigint("user_id", { mode: "number" }).notNull(),
    groupId: bigint("group_id", { mode: "number" }).notNull(),
    addedBy: bigint("added_by_id", { mode: "number" }).notNull(),

    ...timeColumns,
  },
  (t) => [primaryKey({ columns: [t.userId, t.groupId] }), index("user_id_idx").on(t.userId)]
)
