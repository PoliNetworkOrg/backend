ALTER TABLE "auth_accounts" ALTER COLUMN "access_token_expires_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_accounts" ALTER COLUMN "refresh_token_expires_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_accounts" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_accounts" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_passkey" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_sessions" ALTER COLUMN "expires_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_sessions" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_sessions" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_users" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_users" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_verifications" ALTER COLUMN "expires_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_verifications" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_verifications" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tg_audit_log" ALTER COLUMN "until" SET DATA TYPE timestamp (0) with time zone;--> statement-breakpoint
ALTER TABLE "tg_audit_log" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (0) with time zone;--> statement-breakpoint
ALTER TABLE "tg_audit_log" ALTER COLUMN "created_at" SET DATA TYPE timestamp (0) with time zone;--> statement-breakpoint
ALTER TABLE "tg_audit_log" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "tg_grants" ALTER COLUMN "valid_since" SET DATA TYPE timestamp (0) with time zone;--> statement-breakpoint
ALTER TABLE "tg_grants" ALTER COLUMN "valid_until" SET DATA TYPE timestamp (0) with time zone;--> statement-breakpoint
ALTER TABLE "tg_grants" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (0) with time zone;--> statement-breakpoint
ALTER TABLE "tg_grants" ALTER COLUMN "created_at" SET DATA TYPE timestamp (0) with time zone;--> statement-breakpoint
ALTER TABLE "tg_grants" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "tg_groups" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (0) with time zone;--> statement-breakpoint
ALTER TABLE "tg_groups" ALTER COLUMN "created_at" SET DATA TYPE timestamp (0) with time zone;--> statement-breakpoint
ALTER TABLE "tg_groups" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "tg_link" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (0) with time zone;--> statement-breakpoint
ALTER TABLE "tg_link" ALTER COLUMN "created_at" SET DATA TYPE timestamp (0) with time zone;--> statement-breakpoint
ALTER TABLE "tg_link" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "tg_messages" ALTER COLUMN "timestamp" SET DATA TYPE timestamp (0) with time zone;--> statement-breakpoint
ALTER TABLE "tg_messages" ALTER COLUMN "created_at" SET DATA TYPE timestamp (0) with time zone;--> statement-breakpoint
ALTER TABLE "tg_messages" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "tg_group_admins" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (0) with time zone;--> statement-breakpoint
ALTER TABLE "tg_group_admins" ALTER COLUMN "created_at" SET DATA TYPE timestamp (0) with time zone;--> statement-breakpoint
ALTER TABLE "tg_group_admins" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "tg_permissions" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (0) with time zone;--> statement-breakpoint
ALTER TABLE "tg_permissions" ALTER COLUMN "created_at" SET DATA TYPE timestamp (0) with time zone;--> statement-breakpoint
ALTER TABLE "tg_permissions" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "tg_users" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (0) with time zone;--> statement-breakpoint
ALTER TABLE "tg_users" ALTER COLUMN "created_at" SET DATA TYPE timestamp (0) with time zone;--> statement-breakpoint
ALTER TABLE "tg_users" ALTER COLUMN "created_at" SET DEFAULT now();