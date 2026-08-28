CREATE TABLE "tg_group_label_relations" (
	"group_id" bigint NOT NULL,
	"label" varchar(128) NOT NULL,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tg_group_label_relations_group_id_label_pk" PRIMARY KEY("group_id","label")
);
--> statement-breakpoint
CREATE TABLE "tg_group_labels" (
	"label" varchar(128) PRIMARY KEY NOT NULL,
	"description" varchar,
	"color" varchar(7) DEFAULT '#ffffff' NOT NULL,
	"granted_by_id" bigint NOT NULL,
	"modified_by_id" bigint,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tg_group_label_relations" ADD CONSTRAINT "tg_group_label_relations_group_id_tg_groups_telegram_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."tg_groups"("telegram_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_group_label_relations" ADD CONSTRAINT "tg_group_label_relations_label_tg_group_labels_label_fk" FOREIGN KEY ("label") REFERENCES "public"."tg_group_labels"("label") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_group_labels" ADD CONSTRAINT "tg_group_labels_granted_by_id_tg_permissions_user_id_fk" FOREIGN KEY ("granted_by_id") REFERENCES "public"."tg_permissions"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_group_labels" ADD CONSTRAINT "tg_group_labels_modified_by_id_tg_permissions_user_id_fk" FOREIGN KEY ("modified_by_id") REFERENCES "public"."tg_permissions"("user_id") ON DELETE no action ON UPDATE no action;