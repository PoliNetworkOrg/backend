ALTER TABLE "regulations_drafts" DROP CONSTRAINT "regulations_drafts_state_check";--> statement-breakpoint
ALTER TABLE "regulations_documents" ALTER COLUMN "procedure" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "regulations_documents" ADD COLUMN "storage" text DEFAULT 'repo' NOT NULL;--> statement-breakpoint
ALTER TABLE "regulations_documents" ADD COLUMN "origin" text DEFAULT 'latex' NOT NULL;--> statement-breakpoint
ALTER TABLE "regulations_documents" ADD COLUMN "template" text;--> statement-breakpoint
ALTER TABLE "regulations_documents" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "regulations_documents" ADD COLUMN "creation" jsonb;--> statement-breakpoint
ALTER TABLE "regulations_versions" ADD COLUMN "origin" text DEFAULT 'import' NOT NULL;--> statement-breakpoint
UPDATE "regulations_versions" SET "origin" = 'draft' WHERE "draft_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "regulations_documents" ADD CONSTRAINT "regulations_documents_procedure_check" CHECK ("regulations_documents"."procedure" is null or "regulations_documents"."procedure" in ('rri', 'documento'));--> statement-breakpoint
ALTER TABLE "regulations_documents" ADD CONSTRAINT "regulations_documents_storage_check" CHECK ("regulations_documents"."storage" in ('repo', 'private'));--> statement-breakpoint
ALTER TABLE "regulations_documents" ADD CONSTRAINT "regulations_documents_origin_check" CHECK ("regulations_documents"."origin" in ('latex', 'upload'));--> statement-breakpoint
ALTER TABLE "regulations_documents" ADD CONSTRAINT "regulations_documents_status_check" CHECK ("regulations_documents"."status" in ('active', 'creating', 'failed'));--> statement-breakpoint
ALTER TABLE "regulations_documents" ADD CONSTRAINT "regulations_documents_private_check" CHECK ("regulations_documents"."storage" = 'repo' or ("regulations_documents"."status" = 'active' and "regulations_documents"."creation" is null));--> statement-breakpoint
ALTER TABLE "regulations_documents" ADD CONSTRAINT "regulations_documents_upload_check" CHECK ("regulations_documents"."origin" = 'latex' or ("regulations_documents"."storage" = 'private' and "regulations_documents"."procedure" is null));--> statement-breakpoint
ALTER TABLE "regulations_drafts" ADD CONSTRAINT "regulations_drafts_state_check" CHECK ("regulations_drafts"."state" in ('bozza', 'in_approvazione', 'approvata', 'emanata', 'pubblicata'));--> statement-breakpoint
ALTER TABLE "regulations_versions" ADD CONSTRAINT "regulations_versions_origin_check" CHECK ("regulations_versions"."origin" in ('import', 'draft', 'template', 'upload'));