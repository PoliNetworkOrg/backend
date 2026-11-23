CREATE TABLE "web_acknowledgement_groups" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "web_acknowledgement_groups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"title" text NOT NULL,
	"icon" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"legacy_created_by_tg_id" bigint,
	"legacy_modified_by_tg_id" bigint,
	"created_by_sub" text,
	"modified_by_sub" text,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_acknowledgement_groups_creator_check" CHECK ("web_acknowledgement_groups"."legacy_created_by_tg_id" IS NOT NULL OR "web_acknowledgement_groups"."created_by_sub" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "web_acknowledgements" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "web_acknowledgements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"section" text NOT NULL,
	"group_id" integer,
	"name" text NOT NULL,
	"detail" text,
	"position" integer DEFAULT 0 NOT NULL,
	"legacy_created_by_tg_id" bigint,
	"legacy_modified_by_tg_id" bigint,
	"created_by_sub" text,
	"modified_by_sub" text,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_acknowledgements_creator_check" CHECK ("web_acknowledgements"."legacy_created_by_tg_id" IS NOT NULL OR "web_acknowledgements"."created_by_sub" IS NOT NULL),
	CONSTRAINT "web_acknowledgements_group_check" CHECK (("web_acknowledgements"."section" = 'website') = ("web_acknowledgements"."group_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "web_acknowledgements" ADD CONSTRAINT "web_acknowledgements_group_id_web_acknowledgement_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."web_acknowledgement_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "web_acknowledgements_group_id_idx" ON "web_acknowledgements" USING btree ("group_id");