CREATE TABLE "people_files" (
	"id" text PRIMARY KEY NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"content" "bytea" NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "people_identities" (
	"person_id" text PRIMARY KEY NOT NULL,
	"account_sub" text,
	"member_number" text,
	"telegram_id" text,
	CONSTRAINT "people_identities_account_sub_unique" UNIQUE("account_sub"),
	CONSTRAINT "people_identities_member_number_unique" UNIQUE("member_number"),
	CONSTRAINT "people_identities_telegram_id_unique" UNIQUE("telegram_id")
);
--> statement-breakpoint
CREATE TABLE "people_receipt_requests" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"receipt_id" text NOT NULL,
	"officer_sub" text NOT NULL,
	"original_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"request_id" uuid,
	"data" jsonb NOT NULL,
	CONSTRAINT "people_receipts_number_unique" UNIQUE("number"),
	CONSTRAINT "people_receipts_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
CREATE TABLE "people_records" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "people_receipt_requests" ADD CONSTRAINT "people_receipt_requests_request_id_esign_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."esign_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_receipt_requests" ADD CONSTRAINT "people_receipt_requests_receipt_id_people_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."people_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_receipts" ADD CONSTRAINT "people_receipts_request_id_esign_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."esign_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "people_receipt_request_identity_idx" ON "people_receipt_requests" USING btree ("receipt_id","request_id");--> statement-breakpoint
CREATE INDEX "people_records_kind_idx" ON "people_records" USING btree ("kind");