-- admin_id is superseded by actor_tg_id. Copy any value an older release wrote only to admin_id, so no author is lost.
UPDATE "tg_audit_log" SET "actor_tg_id" = "admin_id" WHERE "actor_tg_id" IS NULL AND "admin_id" IS NOT NULL;--> statement-breakpoint
DROP INDEX "auditlog_adminid_idx";--> statement-breakpoint
ALTER TABLE "tg_audit_log" DROP COLUMN "admin_id";
