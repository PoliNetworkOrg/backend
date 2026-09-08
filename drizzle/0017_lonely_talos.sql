CREATE TABLE "tg_log_ban_all" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tg_log_ban_all_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"admin_id" bigint NOT NULL,
	"admin" jsonb NOT NULL,
	"target_id" bigint NOT NULL,
	"target" jsonb NOT NULL,
	"type" varchar(32) NOT NULL,
	"reason" varchar(256),
	"source" varchar(64) DEFAULT 'manual' NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"total_group_count" integer DEFAULT 0 NOT NULL,
	"success_group_count" integer DEFAULT 0 NOT NULL,
	"failed_group_count" integer DEFAULT 0 NOT NULL,
	"deleted_message_count" integer,
	"telegram_log_message_id" bigint,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tg_log_deleted" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tg_log_deleted_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"message_id" bigint NOT NULL,
	"chat_id" bigint NOT NULL,
	"author_id" bigint NOT NULL,
	"author" jsonb,
	"deleted_by_id" bigint NOT NULL,
	"deleted_by" jsonb NOT NULL,
	"deleted_at" timestamp (0) with time zone NOT NULL,
	"reason" varchar(256),
	"source" varchar(64) DEFAULT 'moderation' NOT NULL,
	"pre_delete_res" jsonb,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tg_log_exception" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tg_log_exception_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"type" varchar(64) NOT NULL,
	"error" jsonb NOT NULL,
	"context" jsonb,
	"source" varchar(64) DEFAULT 'bot' NOT NULL,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tg_log_grant" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tg_log_grant_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"action" varchar(32) NOT NULL,
	"from_user" jsonb,
	"message" jsonb,
	"chat" jsonb,
	"target" jsonb,
	"by_user" jsonb,
	"since" timestamp (0) with time zone,
	"until" timestamp (0) with time zone,
	"reason" varchar(256),
	"interrupted_by" jsonb,
	"source" varchar(64) DEFAULT 'bot' NOT NULL,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tg_log_group_management" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tg_log_group_management_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"type" varchar(64) NOT NULL,
	"chat" jsonb,
	"added_by" jsonb,
	"invite_link" varchar(256),
	"reason" varchar(256),
	"requested_by" jsonb,
	"total" integer,
	"regenerated" integer,
	"synchronized" integer,
	"failures" jsonb,
	"source" varchar(64) DEFAULT 'bot' NOT NULL,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tg_log_moderation" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tg_log_moderation_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"admin_id" bigint NOT NULL,
	"admin" jsonb NOT NULL,
	"target_id" bigint NOT NULL,
	"target" jsonb NOT NULL,
	"chat_id" bigint NOT NULL,
	"chat" jsonb NOT NULL,
	"type" varchar(32) NOT NULL,
	"duration" jsonb,
	"reason" varchar(256),
	"source" varchar(64) DEFAULT 'manual' NOT NULL,
	"pre_delete_res" jsonb,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"deleted_message_count" integer,
	"total_group_count" integer DEFAULT 0 NOT NULL,
	"success_group_count" integer DEFAULT 0 NOT NULL,
	"failed_group_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tg_audit_log" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "tg_audit_log" CASCADE;--> statement-breakpoint
ALTER TABLE "tg_messages" ADD COLUMN "deleted_at" timestamp (0) with time zone;--> statement-breakpoint
CREATE INDEX "log_ban_all_admin_id_idx" ON "tg_log_ban_all" USING btree ("admin_id");--> statement-breakpoint
CREATE INDEX "log_ban_all_target_id_idx" ON "tg_log_ban_all" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "log_ban_all_status_idx" ON "tg_log_ban_all" USING btree ("status");--> statement-breakpoint
CREATE INDEX "log_deleted_chat_id_idx" ON "tg_log_deleted" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "log_deleted_author_id_idx" ON "tg_log_deleted" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "log_deleted_deleted_by_id_idx" ON "tg_log_deleted" USING btree ("deleted_by_id");--> statement-breakpoint
CREATE INDEX "log_deleted_deleted_at_idx" ON "tg_log_deleted" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "log_exception_type_idx" ON "tg_log_exception" USING btree ("type");--> statement-breakpoint
CREATE INDEX "log_exception_created_at_idx" ON "tg_log_exception" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "log_grant_action_idx" ON "tg_log_grant" USING btree ("action");--> statement-breakpoint
CREATE INDEX "log_grant_target_id_idx" ON "tg_log_grant" USING btree ("target");--> statement-breakpoint
CREATE INDEX "log_group_management_type_idx" ON "tg_log_group_management" USING btree ("type");--> statement-breakpoint
CREATE INDEX "log_group_management_created_at_idx" ON "tg_log_group_management" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "log_moderation_admin_id_idx" ON "tg_log_moderation" USING btree ("admin_id");--> statement-breakpoint
CREATE INDEX "log_moderation_target_id_idx" ON "tg_log_moderation" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "log_moderation_chat_id_idx" ON "tg_log_moderation" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "log_moderation_status_idx" ON "tg_log_moderation" USING btree ("status");--> statement-breakpoint
CREATE INDEX "log_moderation_type_idx" ON "tg_log_moderation" USING btree ("type");--> statement-breakpoint
CREATE INDEX "tg_messages_deleted_at_idx" ON "tg_messages" USING btree ("deleted_at");