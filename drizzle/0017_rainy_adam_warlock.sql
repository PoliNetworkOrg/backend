CREATE TABLE "email_email_templates" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "email_email_templates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"created_by_id" bigint NOT NULL,
	"modified_by_id" bigint,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_email_templates" ADD CONSTRAINT "email_email_templates_created_by_id_tg_permissions_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."tg_permissions"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_email_templates" ADD CONSTRAINT "email_email_templates_modified_by_id_tg_permissions_user_id_fk" FOREIGN KEY ("modified_by_id") REFERENCES "public"."tg_permissions"("user_id") ON DELETE no action ON UPDATE no action;