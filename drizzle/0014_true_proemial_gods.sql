CREATE TABLE "common_group_labels" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "common_group_labels_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"label" varchar(128) NOT NULL,
	"description" varchar,
	"color" varchar(7) DEFAULT '#ffffff' NOT NULL,
	"granted_by_id" bigint NOT NULL,
	"modified_by_id" bigint,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "common_group_labels_label_unique" UNIQUE("label")
);
--> statement-breakpoint
CREATE TABLE "tg_group_label_relations" (
	"group_id" bigint NOT NULL,
	"label_id" integer NOT NULL,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tg_group_label_relations_group_id_label_id_pk" PRIMARY KEY("group_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "wa_group_label_relations" (
	"group_id" bigint NOT NULL,
	"label_id" integer NOT NULL,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_group_label_relations_group_id_label_id_pk" PRIMARY KEY("group_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "wa_groups" (
	"group_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "wa_groups_group_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"title" varchar NOT NULL,
	"link" varchar(128),
	"hide" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_groups_link_unique" UNIQUE("link")
);
--> statement-breakpoint
ALTER TABLE "common_group_labels" ADD CONSTRAINT "common_group_labels_granted_by_id_tg_permissions_user_id_fk" FOREIGN KEY ("granted_by_id") REFERENCES "public"."tg_permissions"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "common_group_labels" ADD CONSTRAINT "common_group_labels_modified_by_id_tg_permissions_user_id_fk" FOREIGN KEY ("modified_by_id") REFERENCES "public"."tg_permissions"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_group_label_relations" ADD CONSTRAINT "tg_group_label_relations_group_id_tg_groups_telegram_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."tg_groups"("telegram_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_group_label_relations" ADD CONSTRAINT "tg_group_label_relations_label_id_common_group_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."common_group_labels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_group_label_relations" ADD CONSTRAINT "wa_group_label_relations_group_id_wa_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."wa_groups"("group_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_group_label_relations" ADD CONSTRAINT "wa_group_label_relations_label_id_common_group_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."common_group_labels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE VIEW "public"."groups_view" AS ((select "telegram_id", "title", "link", "hide", 'tg' as "type" from "tg_groups") union all (select "group_id", "title", "link", "hide", 'wa' as "type" from "wa_groups"));--> statement-breakpoint
CREATE VIEW "public"."group_label_relations_view" AS ((select "group_id", "label_id", 'tg' as "type" from "tg_group_label_relations") union all (select "group_id", "label_id", 'wa' as "type" from "wa_group_label_relations"));