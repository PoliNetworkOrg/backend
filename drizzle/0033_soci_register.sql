CREATE TABLE "soci_activity" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "soci_activity_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"member_id" integer NOT NULL,
	"actor" text NOT NULL,
	"text" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "soci_members" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "soci_members_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"number" integer NOT NULL,
	"entra_object_id" text NOT NULL,
	"mailbox" text NOT NULL,
	"display_name" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"alias" text,
	"codice_fiscale" text,
	"birth_date" date,
	"birth_place" text,
	"residence_street" text,
	"residence_postal_code" text,
	"residence_city" text,
	"residence_province" text,
	"residence_country" text,
	"admitted_on" date NOT NULL,
	"ended_on" date,
	"end_reason" text,
	"end_note" text,
	"account_state" text DEFAULT 'active' NOT NULL,
	"account_deleted_on" date,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "soci_members_number_unique" UNIQUE("number"),
	CONSTRAINT "soci_members_entra_object_id_unique" UNIQUE("entra_object_id"),
	CONSTRAINT "soci_members_end_check" CHECK (("soci_members"."ended_on" is null) = ("soci_members"."end_reason" is null) and ("soci_members"."ended_on" is not null or "soci_members"."end_note" is null)),
	CONSTRAINT "soci_members_end_reason_check" CHECK ("soci_members"."end_reason" in ('lapsed', 'resigned', 'expelled', 'deceased', 'other')),
	CONSTRAINT "soci_members_account_state_check" CHECK ("soci_members"."account_state" in ('active', 'pending_deletion', 'deleted')),
	CONSTRAINT "soci_members_account_deleted_check" CHECK (("soci_members"."account_state" = 'deleted') = ("soci_members"."account_deleted_on" is not null)),
	CONSTRAINT "soci_members_number_check" CHECK ("soci_members"."number" > 0)
);
--> statement-breakpoint
CREATE TABLE "soci_numbers" (
	"number" integer PRIMARY KEY NOT NULL,
	"member_id" integer NOT NULL,
	"assigned_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "soci_activity" ADD CONSTRAINT "soci_activity_member_id_soci_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."soci_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "soci_numbers" ADD CONSTRAINT "soci_numbers_member_id_soci_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."soci_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "soci_activity_member_idx" ON "soci_activity" USING btree ("member_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "soci_members_active_codice_fiscale_idx" ON "soci_members" USING btree ("codice_fiscale") WHERE "soci_members"."ended_on" is null and "soci_members"."codice_fiscale" is not null;--> statement-breakpoint
CREATE INDEX "soci_numbers_member_idx" ON "soci_numbers" USING btree ("member_id");