ALTER TABLE "tg_audit_log" ADD COLUMN "status" varchar(32) DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE "tg_audit_log" ADD COLUMN "deleted_message_count" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "tg_audit_log" ADD COLUMN "total_group_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tg_audit_log" ADD COLUMN "success_group_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tg_audit_log" ADD COLUMN "failed_group_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tg_messages" ADD COLUMN "deleted_at" timestamp (0) with time zone;--> statement-breakpoint
CREATE INDEX "auditlog_targetid_idx" ON "tg_audit_log" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "auditlog_createdat_idx" ON "tg_audit_log" USING btree ("created_at");