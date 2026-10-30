ALTER TABLE "people_persons" ADD COLUMN "linked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "people_persons" ADD COLUMN "linked_by" text;--> statement-breakpoint
ALTER TABLE "people_persons" ADD COLUMN "link_method" text;--> statement-breakpoint
ALTER TABLE "people_role_commands" ADD COLUMN "purpose" text DEFAULT 'roles' NOT NULL;--> statement-breakpoint
ALTER TABLE "people_role_commands" ADD CONSTRAINT "people_role_commands_purpose_check" CHECK ("people_role_commands"."purpose" in ('roles', 'unlink'));