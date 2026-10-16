CREATE TABLE "web_project_resources" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "web_project_resources_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"project_id" integer NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"created_by_id" bigint,
	"modified_by_id" bigint,
	"created_by_sub" text,
	"modified_by_sub" text,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_project_resources_creator_check" CHECK ("web_project_resources"."created_by_id" IS NOT NULL OR "web_project_resources"."created_by_sub" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "web_project_resources" ADD CONSTRAINT "web_project_resources_project_id_web_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."web_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_project_resources" ADD CONSTRAINT "web_project_resources_created_by_id_tg_permissions_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."tg_permissions"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_project_resources" ADD CONSTRAINT "web_project_resources_modified_by_id_tg_permissions_user_id_fk" FOREIGN KEY ("modified_by_id") REFERENCES "public"."tg_permissions"("user_id") ON DELETE no action ON UPDATE no action;