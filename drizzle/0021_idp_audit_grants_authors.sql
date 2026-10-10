CREATE TABLE "tg_grants_v2" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tg_grants_v2_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"telegram_user_id" bigint NOT NULL,
	"valid_since" timestamp (0) with time zone NOT NULL,
	"valid_until" timestamp (0) with time zone NOT NULL,
	"reason" text,
	"granted_by_sub" text NOT NULL,
	"granted_via_client" text NOT NULL,
	"interrupted_at" timestamp (0) with time zone,
	"interrupted_by_sub" text,
	"interrupted_by_tg_id" bigint,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tg_grants_v2_validity_check" CHECK ("tg_grants_v2"."valid_since" < "tg_grants_v2"."valid_until")
);
--> statement-breakpoint
ALTER TABLE "common_group_labels" ALTER COLUMN "granted_by_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tg_audit_log" ALTER COLUMN "admin_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "web_associations" ALTER COLUMN "created_by_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "web_faq_categories" ALTER COLUMN "created_by_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "web_faqs" ALTER COLUMN "created_by_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "web_guides_matricole" ALTER COLUMN "created_by_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "web_projects" ALTER COLUMN "created_by_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "common_group_labels" ADD COLUMN "created_by_sub" text;--> statement-breakpoint
ALTER TABLE "common_group_labels" ADD COLUMN "modified_by_sub" text;--> statement-breakpoint
ALTER TABLE "tg_audit_log" ADD COLUMN "actor_sub" text;--> statement-breakpoint
ALTER TABLE "tg_audit_log" ADD COLUMN "actor_tg_id" bigint;--> statement-breakpoint
ALTER TABLE "tg_audit_log" ADD COLUMN "client" text;--> statement-breakpoint
ALTER TABLE "tg_audit_log" ADD COLUMN "basis" varchar(32) DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "tg_audit_log" ADD COLUMN "review" varchar(32);--> statement-breakpoint
ALTER TABLE "tg_audit_log" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
-- RFC v3 §9.2: existing rows keep basis = legacy and move admin_id to actor_tg_id.
UPDATE "tg_audit_log" SET "actor_tg_id" = "admin_id";--> statement-breakpoint
ALTER TABLE "tg_grants" ADD COLUMN "interrupted_at" timestamp (0) with time zone;--> statement-breakpoint
ALTER TABLE "web_associations" ADD COLUMN "created_by_sub" text;--> statement-breakpoint
ALTER TABLE "web_associations" ADD COLUMN "modified_by_sub" text;--> statement-breakpoint
ALTER TABLE "web_faq_categories" ADD COLUMN "created_by_sub" text;--> statement-breakpoint
ALTER TABLE "web_faq_categories" ADD COLUMN "modified_by_sub" text;--> statement-breakpoint
ALTER TABLE "web_faqs" ADD COLUMN "created_by_sub" text;--> statement-breakpoint
ALTER TABLE "web_faqs" ADD COLUMN "modified_by_sub" text;--> statement-breakpoint
ALTER TABLE "web_guides_matricole" ADD COLUMN "created_by_sub" text;--> statement-breakpoint
ALTER TABLE "web_guides_matricole" ADD COLUMN "modified_by_sub" text;--> statement-breakpoint
ALTER TABLE "web_projects" ADD COLUMN "created_by_sub" text;--> statement-breakpoint
ALTER TABLE "web_projects" ADD COLUMN "modified_by_sub" text;--> statement-breakpoint
CREATE INDEX "tg_grants_v2_telegram_user_id_idx" ON "tg_grants_v2" USING btree ("telegram_user_id");--> statement-breakpoint
CREATE INDEX "auditlog_actor_tg_id_idx" ON "tg_audit_log" USING btree ("actor_tg_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auditlog_idempotency_key_idx" ON "tg_audit_log" USING btree ("idempotency_key");--> statement-breakpoint
ALTER TABLE "common_group_labels" ADD CONSTRAINT "common_group_labels_creator_check" CHECK ("common_group_labels"."granted_by_id" IS NOT NULL OR "common_group_labels"."created_by_sub" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "web_associations" ADD CONSTRAINT "web_associations_creator_check" CHECK ("web_associations"."created_by_id" IS NOT NULL OR "web_associations"."created_by_sub" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "web_faq_categories" ADD CONSTRAINT "web_faq_categories_creator_check" CHECK ("web_faq_categories"."created_by_id" IS NOT NULL OR "web_faq_categories"."created_by_sub" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "web_faqs" ADD CONSTRAINT "web_faqs_creator_check" CHECK ("web_faqs"."created_by_id" IS NOT NULL OR "web_faqs"."created_by_sub" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "web_guides_matricole" ADD CONSTRAINT "web_guides_matricole_creator_check" CHECK ("web_guides_matricole"."created_by_id" IS NOT NULL OR "web_guides_matricole"."created_by_sub" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "web_projects" ADD CONSTRAINT "web_projects_creator_check" CHECK ("web_projects"."created_by_id" IS NOT NULL OR "web_projects"."created_by_sub" IS NOT NULL);