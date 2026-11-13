CREATE TABLE "soci_fees" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "soci_fees_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"member_id" integer NOT NULL,
	"year" integer NOT NULL,
	"status" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"file_id" uuid,
	"transfer_date" date,
	"declared_cents" integer,
	"uploaded_at" timestamp with time zone,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"rejection_reason" text,
	"paid_on" date,
	"method" text,
	"note" text,
	"recorded_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "soci_fees_status_check" CHECK ("soci_fees"."status" in ('due', 'uploaded', 'paid', 'exempt')),
	CONSTRAINT "soci_fees_method_check" CHECK ("soci_fees"."method" in ('transfer', 'admission', 'other')),
	CONSTRAINT "soci_fees_paid_check" CHECK (("soci_fees"."status" = 'paid') = ("soci_fees"."paid_on" is not null and "soci_fees"."method" is not null and "soci_fees"."recorded_by" is not null)),
	CONSTRAINT "soci_fees_upload_check" CHECK ("soci_fees"."status" <> 'uploaded' or ("soci_fees"."file_id" is not null and "soci_fees"."transfer_date" is not null and "soci_fees"."declared_cents" is not null and "soci_fees"."uploaded_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "soci_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"member_id" integer NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"content" "bytea" NOT NULL,
	"uploaded_by" text NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "soci_files_type_check" CHECK ("soci_files"."content_type" in ('application/pdf', 'image/png', 'image/jpeg'))
);
--> statement-breakpoint
CREATE TABLE "soci_mail" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" integer NOT NULL,
	"to" text NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"attempted_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "soci_mail_status_check" CHECK ("soci_mail"."status" in ('pending', 'sending', 'sent', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "soci_fees" ADD CONSTRAINT "soci_fees_member_id_soci_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."soci_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "soci_fees" ADD CONSTRAINT "soci_fees_file_id_soci_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."soci_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "soci_files" ADD CONSTRAINT "soci_files_member_id_soci_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."soci_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "soci_mail" ADD CONSTRAINT "soci_mail_member_id_soci_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."soci_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "soci_fees_member_year_idx" ON "soci_fees" USING btree ("member_id","year");--> statement-breakpoint
CREATE INDEX "soci_fees_year_idx" ON "soci_fees" USING btree ("year","status");--> statement-breakpoint
CREATE INDEX "soci_files_member_idx" ON "soci_files" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "soci_mail_status_idx" ON "soci_mail" USING btree ("status");