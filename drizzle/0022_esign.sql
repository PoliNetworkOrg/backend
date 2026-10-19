CREATE TABLE "esign_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"file_name" text NOT NULL,
	"content" "bytea" NOT NULL,
	"sha256" text NOT NULL,
	"size" integer NOT NULL,
	"pages" integer NOT NULL,
	"source" jsonb NOT NULL,
	"created_by_sub" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "esign_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"actor_sub" text,
	"type" text NOT NULL,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "esign_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_hash" text NOT NULL,
	"request_id" uuid NOT NULL,
	"signer_id" uuid NOT NULL,
	"sub" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"base_version" integer NOT NULL,
	"placement" jsonb NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"prepared" jsonb,
	"prepared_pdf" "bytea",
	"error_code" text,
	"error_message" text,
	"seen_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "esign_jobs_ticket_hash_unique" UNIQUE("ticket_hash")
);
--> statement-breakpoint
CREATE TABLE "esign_profiles" (
	"sub" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"fiscal_code" text,
	"certificate_subject" text,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "esign_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"ordered" boolean DEFAULT true NOT NULL,
	"output" jsonb,
	"email" jsonb,
	"delivery" jsonb,
	"created_by_sub" text NOT NULL,
	"completed_at" timestamp (3) with time zone,
	"cancelled_at" timestamp (3) with time zone,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "esign_signers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"sub" text NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"placement" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"signed_at" timestamp (3) with time zone,
	"version" integer,
	"fiscal_code" text,
	"certificate_subject" text,
	"certificate_issuer" text,
	"decline_reason" text,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "esign_documents" ADD CONSTRAINT "esign_documents_request_id_esign_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."esign_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esign_events" ADD CONSTRAINT "esign_events_request_id_esign_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."esign_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esign_jobs" ADD CONSTRAINT "esign_jobs_request_id_esign_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."esign_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esign_jobs" ADD CONSTRAINT "esign_jobs_signer_id_esign_signers_id_fk" FOREIGN KEY ("signer_id") REFERENCES "public"."esign_signers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esign_signers" ADD CONSTRAINT "esign_signers_request_id_esign_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."esign_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "esign_documents_request_version_idx" ON "esign_documents" USING btree ("request_id","version") WHERE "esign_documents"."request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "esign_events_request_idx" ON "esign_events" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "esign_jobs_request_idx" ON "esign_jobs" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "esign_requests_status_idx" ON "esign_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "esign_requests_created_by_idx" ON "esign_requests" USING btree ("created_by_sub");--> statement-breakpoint
CREATE INDEX "esign_signers_request_idx" ON "esign_signers" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "esign_signers_sub_idx" ON "esign_signers" USING btree ("sub");--> statement-breakpoint
CREATE UNIQUE INDEX "esign_signers_request_position_idx" ON "esign_signers" USING btree ("request_id","position");