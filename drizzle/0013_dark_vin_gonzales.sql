CREATE TABLE "web_projects" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "web_projects_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"title" text NOT NULL,
	"description_it" text NOT NULL,
	"description_en" text NOT NULL,
	"logo" text,
	"link" text,
	"category" text DEFAULT 'general' NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"created_by_id" bigint NOT NULL,
	"modified_by_id" bigint,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "web_projects" ADD CONSTRAINT "web_projects_created_by_id_tg_permissions_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."tg_permissions"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_projects" ADD CONSTRAINT "web_projects_modified_by_id_tg_permissions_user_id_fk" FOREIGN KEY ("modified_by_id") REFERENCES "public"."tg_permissions"("user_id") ON DELETE no action ON UPDATE no action;
