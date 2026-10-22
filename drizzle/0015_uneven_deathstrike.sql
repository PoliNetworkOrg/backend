ALTER TABLE "tg_group_label_relations" DROP CONSTRAINT "tg_group_label_relations_group_id_tg_groups_telegram_id_fk";
--> statement-breakpoint
ALTER TABLE "wa_group_label_relations" DROP CONSTRAINT "wa_group_label_relations_group_id_wa_groups_group_id_fk";
--> statement-breakpoint
ALTER TABLE "tg_group_label_relations" ADD CONSTRAINT "tg_group_label_relations_group_id_tg_groups_telegram_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."tg_groups"("telegram_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_group_label_relations" ADD CONSTRAINT "wa_group_label_relations_group_id_wa_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."wa_groups"("group_id") ON DELETE cascade ON UPDATE no action;