CREATE TABLE "web_project_resources" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "web_project_resources_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"project_id" integer NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"legacy_created_by_tg_id" bigint,
	"legacy_modified_by_tg_id" bigint,
	"created_by_sub" text,
	"modified_by_sub" text,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_project_resources_creator_check" CHECK ("web_project_resources"."legacy_created_by_tg_id" IS NOT NULL OR "web_project_resources"."created_by_sub" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "web_project_resources" ADD CONSTRAINT "web_project_resources_project_id_web_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."web_projects"("id") ON DELETE cascade ON UPDATE no action;