CREATE TABLE "regulations_assignments" (
	"draft_id" text NOT NULL,
	"user_sub" text NOT NULL,
	"user" jsonb NOT NULL,
	"role" text NOT NULL,
	"assigned_by" jsonb NOT NULL,
	"assigned_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "regulations_assignments_draft_id_user_sub_pk" PRIMARY KEY("draft_id","user_sub"),
	CONSTRAINT "regulations_assignments_role_check" CHECK ("regulations_assignments"."role" in ('editor', 'commenter', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "regulations_blobs" (
	"hash" text PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"content" "bytea" NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regulations_collab_tickets" (
	"hash" text PRIMARY KEY NOT NULL,
	"draft_id" text NOT NULL,
	"user" jsonb NOT NULL,
	"role" text NOT NULL,
	"read_only" boolean NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"used_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "regulations_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"draft_id" text NOT NULL,
	"parent_id" text,
	"file" text,
	"anchor_start" text,
	"anchor_end" text,
	"quote" text,
	"body" text NOT NULL,
	"author" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"edited_at" timestamp (3) with time zone,
	"resolved_at" timestamp (3) with time zone,
	"resolved_by" jsonb,
	"deleted_at" timestamp (3) with time zone,
	CONSTRAINT "regulations_comments_anchor_check" CHECK (("regulations_comments"."parent_id" is null) = ("regulations_comments"."file" is not null and "regulations_comments"."anchor_start" is not null and "regulations_comments"."anchor_end" is not null))
);
--> statement-breakpoint
CREATE TABLE "regulations_compile_refs" (
	"draft_id" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "regulations_compile_refs_draft_id_hash_pk" PRIMARY KEY("draft_id","hash")
);
--> statement-breakpoint
CREATE TABLE "regulations_compiles" (
	"hash" text PRIMARY KEY NOT NULL,
	"ok" boolean NOT NULL,
	"pdf_blob" text,
	"errors" jsonb NOT NULL,
	"log" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regulations_deleghe" (
	"id" text PRIMARY KEY NOT NULL,
	"grantee_sub" text NOT NULL,
	"grantee" jsonb NOT NULL,
	"document_key" text,
	"expires_at" timestamp (3) with time zone,
	"note" text,
	"granted_by" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	"revoked_by" jsonb
);
--> statement-breakpoint
CREATE TABLE "regulations_delibere" (
	"draft_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"body" text,
	"date" date NOT NULL,
	"verbale_url" text,
	"recorded_by" jsonb NOT NULL,
	"recorded_at" timestamp (3) with time zone NOT NULL,
	"delega_id" text,
	"on_behalf_of" jsonb,
	CONSTRAINT "regulations_delibere_kind_check" CHECK ("regulations_delibere"."kind" in ('approvazione', 'rettifica')),
	CONSTRAINT "regulations_delibere_body_check" CHECK (("regulations_delibere"."kind" = 'approvazione') = ("regulations_delibere"."body" in ('consiglio_direttivo', 'assemblea')))
);
--> statement-breakpoint
CREATE TABLE "regulations_diffs" (
	"id" text PRIMARY KEY NOT NULL,
	"draft_id" text NOT NULL,
	"generation" integer NOT NULL,
	"status" text NOT NULL,
	"base_label" text NOT NULL,
	"articles" jsonb NOT NULL,
	"other_changes" jsonb NOT NULL,
	"categories" jsonb,
	"provider" text,
	"model" text,
	"error" text,
	"pdf_blob" text,
	"requested_by" jsonb,
	"created_at" timestamp (3) with time zone NOT NULL,
	"finished_at" timestamp (3) with time zone,
	CONSTRAINT "regulations_diffs_status_check" CHECK ("regulations_diffs"."status" in ('pending', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "regulations_documents" (
	"key" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"dir" text NOT NULL,
	"entry" text NOT NULL,
	"sources" jsonb NOT NULL,
	"outputs" jsonb NOT NULL,
	"tag_prefix" text NOT NULL,
	"procedure" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regulations_draft_compiles" (
	"draft_id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"hash" text,
	"last_good_hash" text,
	"compiled_at" timestamp (3) with time zone,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regulations_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"document_key" text NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"base_version_id" text,
	"base_draft_id" text,
	"base_files" jsonb NOT NULL,
	"frozen_files" jsonb,
	"parses" boolean,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	"state_changed_at" timestamp (3) with time zone NOT NULL,
	"approved_at" timestamp (3) with time zone,
	"emanated_at" timestamp (3) with time zone,
	"notified_at" timestamp (3) with time zone,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" jsonb,
	CONSTRAINT "regulations_drafts_kind_check" CHECK ("regulations_drafts"."kind" in ('modifica', 'rettifica')),
	CONSTRAINT "regulations_drafts_state_check" CHECK ("regulations_drafts"."state" in ('bozza', 'in_approvazione', 'approvata', 'emanata')),
	CONSTRAINT "regulations_drafts_base_check" CHECK (("regulations_drafts"."base_version_id" is null) <> ("regulations_drafts"."base_draft_id" is null))
);
--> statement-breakpoint
CREATE TABLE "regulations_emanations" (
	"draft_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"files" jsonb NOT NULL,
	"tag" text,
	"branch" text NOT NULL,
	"pr_number" integer,
	"merge_sha" text,
	"release_id" bigint,
	"version_id" text,
	"steps" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"started_by" jsonb NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL,
	"next_check_at" timestamp (3) with time zone,
	"finished_at" timestamp (3) with time zone,
	CONSTRAINT "regulations_emanations_status_check" CHECK ("regulations_emanations"."status" in ('running', 'waiting', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "regulations_merges" (
	"id" text PRIMARY KEY NOT NULL,
	"target_draft_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"source_files" jsonb NOT NULL,
	"resolutions" jsonb NOT NULL,
	"merged_by" jsonb NOT NULL,
	"merged_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regulations_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"draft_id" text,
	"delega_id" text,
	"channel" text NOT NULL,
	"kind" text NOT NULL,
	"recipients" jsonb NOT NULL,
	"subject" text,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"sent_at" timestamp (3) with time zone,
	CONSTRAINT "regulations_notifications_key_unique" UNIQUE("key"),
	CONSTRAINT "regulations_notifications_channel_check" CHECK ("regulations_notifications"."channel" in ('email', 'telegram')),
	CONSTRAINT "regulations_notifications_status_check" CHECK ("regulations_notifications"."status" in ('pending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "regulations_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"draft_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"files" jsonb NOT NULL,
	"source_hash" text NOT NULL,
	"created_by" jsonb,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "regulations_snapshots_kind_check" CHECK ("regulations_snapshots"."kind" in ('base', 'auto', 'named', 'state', 'restore', 'merge'))
);
--> statement-breakpoint
CREATE TABLE "regulations_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"document_key" text NOT NULL,
	"tag" text,
	"label" text NOT NULL,
	"files" jsonb NOT NULL,
	"source_hash" text NOT NULL,
	"commit_sha" text,
	"draft_id" text,
	"published_at" timestamp (3) with time zone NOT NULL,
	"release_url" text,
	"pdf_blob" text,
	"assets_blob" text
);
--> statement-breakpoint
CREATE TABLE "regulations_ydocs" (
	"draft_id" text PRIMARY KEY NOT NULL,
	"state" "bytea" NOT NULL,
	"compacted_through" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regulations_yupdates" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "regulations_yupdates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"draft_id" text NOT NULL,
	"update" "bytea" NOT NULL,
	"actor_sub" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "regulations_assignments" ADD CONSTRAINT "regulations_assignments_draft_id_regulations_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."regulations_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulations_collab_tickets" ADD CONSTRAINT "regulations_collab_tickets_draft_id_regulations_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."regulations_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulations_comments" ADD CONSTRAINT "regulations_comments_draft_id_regulations_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."regulations_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulations_comments" ADD CONSTRAINT "regulations_comments_parent_id_regulations_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."regulations_comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulations_compile_refs" ADD CONSTRAINT "regulations_compile_refs_draft_id_regulations_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."regulations_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulations_deleghe" ADD CONSTRAINT "regulations_deleghe_document_key_regulations_documents_key_fk" FOREIGN KEY ("document_key") REFERENCES "public"."regulations_documents"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulations_delibere" ADD CONSTRAINT "regulations_delibere_draft_id_regulations_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."regulations_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulations_delibere" ADD CONSTRAINT "regulations_delibere_delega_id_regulations_deleghe_id_fk" FOREIGN KEY ("delega_id") REFERENCES "public"."regulations_deleghe"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulations_diffs" ADD CONSTRAINT "regulations_diffs_draft_id_regulations_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."regulations_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulations_draft_compiles" ADD CONSTRAINT "regulations_draft_compiles_draft_id_regulations_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."regulations_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulations_drafts" ADD CONSTRAINT "regulations_drafts_document_key_regulations_documents_key_fk" FOREIGN KEY ("document_key") REFERENCES "public"."regulations_documents"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulations_drafts" ADD CONSTRAINT "regulations_drafts_base_version_id_regulations_versions_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "public"."regulations_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulations_drafts" ADD CONSTRAINT "regulations_drafts_base_draft_id_regulations_drafts_id_fk" FOREIGN KEY ("base_draft_id") REFERENCES "public"."regulations_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulations_emanations" ADD CONSTRAINT "regulations_emanations_draft_id_regulations_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."regulations_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulations_emanations" ADD CONSTRAINT "regulations_emanations_version_id_regulations_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."regulations_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulations_merges" ADD CONSTRAINT "regulations_merges_target_draft_id_regulations_drafts_id_fk" FOREIGN KEY ("target_draft_id") REFERENCES "public"."regulations_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulations_notifications" ADD CONSTRAINT "regulations_notifications_draft_id_regulations_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."regulations_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulations_notifications" ADD CONSTRAINT "regulations_notifications_delega_id_regulations_deleghe_id_fk" FOREIGN KEY ("delega_id") REFERENCES "public"."regulations_deleghe"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulations_snapshots" ADD CONSTRAINT "regulations_snapshots_draft_id_regulations_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."regulations_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulations_versions" ADD CONSTRAINT "regulations_versions_document_key_regulations_documents_key_fk" FOREIGN KEY ("document_key") REFERENCES "public"."regulations_documents"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulations_versions" ADD CONSTRAINT "regulations_versions_draft_id_regulations_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."regulations_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulations_ydocs" ADD CONSTRAINT "regulations_ydocs_draft_id_regulations_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."regulations_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regulations_yupdates" ADD CONSTRAINT "regulations_yupdates_draft_id_regulations_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."regulations_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "regulations_assignments_user_idx" ON "regulations_assignments" USING btree ("user_sub");--> statement-breakpoint
CREATE INDEX "regulations_collab_tickets_expiry_idx" ON "regulations_collab_tickets" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "regulations_comments_draft_idx" ON "regulations_comments" USING btree ("draft_id","created_at");--> statement-breakpoint
CREATE INDEX "regulations_deleghe_grantee_idx" ON "regulations_deleghe" USING btree ("grantee_sub");--> statement-breakpoint
CREATE UNIQUE INDEX "regulations_diffs_generation_idx" ON "regulations_diffs" USING btree ("draft_id","generation");--> statement-breakpoint
CREATE INDEX "regulations_drafts_document_idx" ON "regulations_drafts" USING btree ("document_key");--> statement-breakpoint
CREATE UNIQUE INDEX "regulations_drafts_in_approval_idx" ON "regulations_drafts" USING btree ("document_key") WHERE "regulations_drafts"."state" = 'in_approvazione' and "regulations_drafts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "regulations_merges_pair_idx" ON "regulations_merges" USING btree ("target_draft_id","source_kind","source_id","merged_at");--> statement-breakpoint
CREATE INDEX "regulations_notifications_draft_idx" ON "regulations_notifications" USING btree ("draft_id");--> statement-breakpoint
CREATE INDEX "regulations_snapshots_draft_idx" ON "regulations_snapshots" USING btree ("draft_id","created_at");--> statement-breakpoint
CREATE INDEX "regulations_versions_document_idx" ON "regulations_versions" USING btree ("document_key","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "regulations_versions_tag_idx" ON "regulations_versions" USING btree ("document_key","tag");--> statement-breakpoint
CREATE INDEX "regulations_yupdates_draft_idx" ON "regulations_yupdates" USING btree ("draft_id","id");