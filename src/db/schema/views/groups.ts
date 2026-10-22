import { sql } from "drizzle-orm"
import { pgView, QueryBuilder } from "drizzle-orm/pg-core"
import * as TG from "../tg"
import * as WA from "../wa"

const qb = new QueryBuilder()

const TG_GROUPS = TG.schema.groups
const WA_GROUPS = WA.schema.waGroups

export const groupsView = pgView("groups_view").as(
  qb
    .select({
      id: TG_GROUPS.telegramId,
      title: TG_GROUPS.title,
      link: TG_GROUPS.link,
      hide: TG_GROUPS.hide,
      type: sql`'tg'`.as("type"),
    })
    .from(TG_GROUPS)
    .unionAll(
      qb
        .select({
          id: WA_GROUPS.id,
          title: WA_GROUPS.title,
          link: WA_GROUPS.link,
          hide: WA_GROUPS.hide,
          type: sql`'wa'`.as("type"),
        })
        .from(WA_GROUPS)
    )
)

export const labelsRelationsView = pgView("group_label_relations_view").as(
  qb
    .select({
      groupId: TG.schema.tgGroupLabelRelations.groupId,
      labelId: TG.schema.tgGroupLabelRelations.labelId,
      type: sql`'tg'`.as("type"),
    })
    .from(TG.schema.tgGroupLabelRelations)
    .unionAll(
      qb
        .select({
          groupId: WA.schema.waGroupLabelRelations.groupId,
          labelId: WA.schema.waGroupLabelRelations.labelId,
          type: sql`'wa'`.as("type"),
        })
        .from(WA.schema.waGroupLabelRelations)
    )
)
