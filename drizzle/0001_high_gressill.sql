ALTER TABLE "tg_audit_log" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (0);--> statement-breakpoint
ALTER TABLE "tg_audit_log" ALTER COLUMN "created_at" SET DATA TYPE timestamp (0);--> statement-breakpoint
ALTER TABLE "tg_groups" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (0);--> statement-breakpoint
ALTER TABLE "tg_groups" ALTER COLUMN "created_at" SET DATA TYPE timestamp (0);--> statement-breakpoint
ALTER TABLE "tg_link" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (0);--> statement-breakpoint
ALTER TABLE "tg_link" ALTER COLUMN "created_at" SET DATA TYPE timestamp (0);--> statement-breakpoint
ALTER TABLE "tg_messages" ALTER COLUMN "created_at" SET DATA TYPE timestamp (0);--> statement-breakpoint
ALTER TABLE "tg_group_admins" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (0);--> statement-breakpoint
ALTER TABLE "tg_group_admins" ALTER COLUMN "created_at" SET DATA TYPE timestamp (0);--> statement-breakpoint
ALTER TABLE "tg_permissions" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (0);--> statement-breakpoint
ALTER TABLE "tg_permissions" ALTER COLUMN "created_at" SET DATA TYPE timestamp (0);