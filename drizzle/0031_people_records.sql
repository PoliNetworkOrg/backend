CREATE TABLE "people_activity" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "people_activity_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"person_id" text NOT NULL,
	"actor" text NOT NULL,
	"text" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" text NOT NULL,
	"kind" text NOT NULL,
	"team" text,
	"team_role" text,
	"capo_scope" text,
	"capo_of_reference_id" text,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"since" date NOT NULL,
	"ended_on" date,
	"end_reason" text,
	"assigned_by" text NOT NULL,
	"change" text NOT NULL,
	"status" text NOT NULL,
	"refusal" text,
	"command_id" uuid,
	CONSTRAINT "people_assignments_kind_check" CHECK ("people_assignments"."kind" in ('admin', 'capo', 'team')),
	CONSTRAINT "people_assignments_team_check" CHECK (("people_assignments"."kind" = 'team') = ("people_assignments"."team" is not null and "people_assignments"."team_role" in ('member', 'lead'))),
	CONSTRAINT "people_assignments_capo_ref_check" CHECK ("people_assignments"."kind" = 'admin' or "people_assignments"."capo_of_reference_id" is null),
	CONSTRAINT "people_assignments_change_check" CHECK ("people_assignments"."change" in ('start', 'end')),
	CONSTRAINT "people_assignments_status_check" CHECK ("people_assignments"."status" in ('pending', 'sent', 'applied', 'refused')),
	CONSTRAINT "people_assignments_sent_check" CHECK (("people_assignments"."status" = 'sent') = ("people_assignments"."command_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "people_counters" (
	"key" text PRIMARY KEY NOT NULL,
	"value" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people_invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"email" text NOT NULL,
	"sent_by" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"accepted_by" text,
	CONSTRAINT "people_invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "people_mail" (
	"id" text PRIMARY KEY NOT NULL,
	"person_id" text NOT NULL,
	"to" text NOT NULL,
	"subject" text NOT NULL,
	"text" text NOT NULL,
	"status" text NOT NULL,
	"attempted_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "people_persons" (
	"id" text PRIMARY KEY NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"contact_email" text,
	"phone" text,
	"telegram_username" text,
	"notes" text,
	"account_sub" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "people_persons_account_sub_unique" UNIQUE("account_sub")
);
--> statement-breakpoint
CREATE TABLE "people_role_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" text NOT NULL,
	"request" jsonb NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"answered_at" timestamp with time zone,
	CONSTRAINT "people_role_commands_status_check" CHECK ("people_role_commands"."status" in ('queued', 'applied', 'refused'))
);
--> statement-breakpoint
DROP TABLE "people_identities" CASCADE;--> statement-breakpoint
DROP TABLE "people_records" CASCADE;--> statement-breakpoint
ALTER TABLE "people_activity" ADD CONSTRAINT "people_activity_person_id_people_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people_persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_assignments" ADD CONSTRAINT "people_assignments_person_id_people_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people_persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_assignments" ADD CONSTRAINT "people_assignments_capo_of_reference_id_people_persons_id_fk" FOREIGN KEY ("capo_of_reference_id") REFERENCES "public"."people_persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_assignments" ADD CONSTRAINT "people_assignments_command_id_people_role_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."people_role_commands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_invites" ADD CONSTRAINT "people_invites_person_id_people_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people_persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_mail" ADD CONSTRAINT "people_mail_person_id_people_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people_persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_role_commands" ADD CONSTRAINT "people_role_commands_person_id_people_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people_persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "people_activity_person_idx" ON "people_activity" USING btree ("person_id","id");--> statement-breakpoint
CREATE INDEX "people_assignments_person_idx" ON "people_assignments" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "people_assignments_current_idx" ON "people_assignments" USING btree ("person_id","kind",coalesce("team", '')) WHERE "people_assignments"."ended_on" is null;--> statement-breakpoint
CREATE INDEX "people_invites_person_idx" ON "people_invites" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "people_role_commands_queued_idx" ON "people_role_commands" USING btree ("created_at") WHERE "people_role_commands"."status" = 'queued';