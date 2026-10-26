-- RFC v3 Phase 6 (§9.3, §9.4, §13). Take the backup in the PR description before deploying: this drops data.

-- Author columns: keep the old Telegram IDs for history, without the foreign keys to tg_permissions.
ALTER TABLE "common_group_labels" DROP CONSTRAINT "common_group_labels_granted_by_id_tg_permissions_user_id_fk";--> statement-breakpoint
ALTER TABLE "common_group_labels" DROP CONSTRAINT "common_group_labels_modified_by_id_tg_permissions_user_id_fk";--> statement-breakpoint
ALTER TABLE "common_group_labels" DROP CONSTRAINT "common_group_labels_creator_check";--> statement-breakpoint
ALTER TABLE "common_group_labels" RENAME COLUMN "granted_by_id" TO "legacy_created_by_tg_id";--> statement-breakpoint
ALTER TABLE "common_group_labels" RENAME COLUMN "modified_by_id" TO "legacy_modified_by_tg_id";--> statement-breakpoint
ALTER TABLE "common_group_labels" ADD CONSTRAINT "common_group_labels_creator_check" CHECK ("common_group_labels"."legacy_created_by_tg_id" IS NOT NULL OR "common_group_labels"."created_by_sub" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "web_associations" DROP CONSTRAINT "web_associations_created_by_id_tg_permissions_user_id_fk";--> statement-breakpoint
ALTER TABLE "web_associations" DROP CONSTRAINT "web_associations_modified_by_id_tg_permissions_user_id_fk";--> statement-breakpoint
ALTER TABLE "web_associations" DROP CONSTRAINT "web_associations_creator_check";--> statement-breakpoint
ALTER TABLE "web_associations" RENAME COLUMN "created_by_id" TO "legacy_created_by_tg_id";--> statement-breakpoint
ALTER TABLE "web_associations" RENAME COLUMN "modified_by_id" TO "legacy_modified_by_tg_id";--> statement-breakpoint
ALTER TABLE "web_associations" ADD CONSTRAINT "web_associations_creator_check" CHECK ("web_associations"."legacy_created_by_tg_id" IS NOT NULL OR "web_associations"."created_by_sub" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "web_faq_categories" DROP CONSTRAINT "web_faq_categories_created_by_id_tg_permissions_user_id_fk";--> statement-breakpoint
ALTER TABLE "web_faq_categories" DROP CONSTRAINT "web_faq_categories_modified_by_id_tg_permissions_user_id_fk";--> statement-breakpoint
ALTER TABLE "web_faq_categories" DROP CONSTRAINT "web_faq_categories_creator_check";--> statement-breakpoint
ALTER TABLE "web_faq_categories" RENAME COLUMN "created_by_id" TO "legacy_created_by_tg_id";--> statement-breakpoint
ALTER TABLE "web_faq_categories" RENAME COLUMN "modified_by_id" TO "legacy_modified_by_tg_id";--> statement-breakpoint
ALTER TABLE "web_faq_categories" ADD CONSTRAINT "web_faq_categories_creator_check" CHECK ("web_faq_categories"."legacy_created_by_tg_id" IS NOT NULL OR "web_faq_categories"."created_by_sub" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "web_faqs" DROP CONSTRAINT "web_faqs_created_by_id_tg_permissions_user_id_fk";--> statement-breakpoint
ALTER TABLE "web_faqs" DROP CONSTRAINT "web_faqs_modified_by_id_tg_permissions_user_id_fk";--> statement-breakpoint
ALTER TABLE "web_faqs" DROP CONSTRAINT "web_faqs_creator_check";--> statement-breakpoint
ALTER TABLE "web_faqs" RENAME COLUMN "created_by_id" TO "legacy_created_by_tg_id";--> statement-breakpoint
ALTER TABLE "web_faqs" RENAME COLUMN "modified_by_id" TO "legacy_modified_by_tg_id";--> statement-breakpoint
ALTER TABLE "web_faqs" ADD CONSTRAINT "web_faqs_creator_check" CHECK ("web_faqs"."legacy_created_by_tg_id" IS NOT NULL OR "web_faqs"."created_by_sub" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "web_freshman_cards" DROP CONSTRAINT "web_freshman_cards_created_by_id_tg_permissions_user_id_fk";--> statement-breakpoint
ALTER TABLE "web_freshman_cards" DROP CONSTRAINT "web_freshman_cards_modified_by_id_tg_permissions_user_id_fk";--> statement-breakpoint
ALTER TABLE "web_freshman_cards" DROP CONSTRAINT "web_freshman_cards_creator_check";--> statement-breakpoint
ALTER TABLE "web_freshman_cards" RENAME COLUMN "created_by_id" TO "legacy_created_by_tg_id";--> statement-breakpoint
ALTER TABLE "web_freshman_cards" RENAME COLUMN "modified_by_id" TO "legacy_modified_by_tg_id";--> statement-breakpoint
ALTER TABLE "web_freshman_cards" ADD CONSTRAINT "web_freshman_cards_creator_check" CHECK ("web_freshman_cards"."legacy_created_by_tg_id" IS NOT NULL OR "web_freshman_cards"."created_by_sub" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "web_freshman_faqs" DROP CONSTRAINT "web_freshman_faqs_created_by_id_tg_permissions_user_id_fk";--> statement-breakpoint
ALTER TABLE "web_freshman_faqs" DROP CONSTRAINT "web_freshman_faqs_modified_by_id_tg_permissions_user_id_fk";--> statement-breakpoint
ALTER TABLE "web_freshman_faqs" DROP CONSTRAINT "web_freshman_faqs_creator_check";--> statement-breakpoint
ALTER TABLE "web_freshman_faqs" RENAME COLUMN "created_by_id" TO "legacy_created_by_tg_id";--> statement-breakpoint
ALTER TABLE "web_freshman_faqs" RENAME COLUMN "modified_by_id" TO "legacy_modified_by_tg_id";--> statement-breakpoint
ALTER TABLE "web_freshman_faqs" ADD CONSTRAINT "web_freshman_faqs_creator_check" CHECK ("web_freshman_faqs"."legacy_created_by_tg_id" IS NOT NULL OR "web_freshman_faqs"."created_by_sub" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "web_guides_matricole" DROP CONSTRAINT "web_guides_matricole_created_by_id_tg_permissions_user_id_fk";--> statement-breakpoint
ALTER TABLE "web_guides_matricole" DROP CONSTRAINT "web_guides_matricole_modified_by_id_tg_permissions_user_id_fk";--> statement-breakpoint
ALTER TABLE "web_guides_matricole" DROP CONSTRAINT "web_guides_matricole_creator_check";--> statement-breakpoint
ALTER TABLE "web_guides_matricole" RENAME COLUMN "created_by_id" TO "legacy_created_by_tg_id";--> statement-breakpoint
ALTER TABLE "web_guides_matricole" RENAME COLUMN "modified_by_id" TO "legacy_modified_by_tg_id";--> statement-breakpoint
ALTER TABLE "web_guides_matricole" ADD CONSTRAINT "web_guides_matricole_creator_check" CHECK ("web_guides_matricole"."legacy_created_by_tg_id" IS NOT NULL OR "web_guides_matricole"."created_by_sub" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "web_projects" DROP CONSTRAINT "web_projects_created_by_id_tg_permissions_user_id_fk";--> statement-breakpoint
ALTER TABLE "web_projects" DROP CONSTRAINT "web_projects_modified_by_id_tg_permissions_user_id_fk";--> statement-breakpoint
ALTER TABLE "web_projects" DROP CONSTRAINT "web_projects_creator_check";--> statement-breakpoint
ALTER TABLE "web_projects" RENAME COLUMN "created_by_id" TO "legacy_created_by_tg_id";--> statement-breakpoint
ALTER TABLE "web_projects" RENAME COLUMN "modified_by_id" TO "legacy_modified_by_tg_id";--> statement-breakpoint
ALTER TABLE "web_projects" ADD CONSTRAINT "web_projects_creator_check" CHECK ("web_projects"."legacy_created_by_tg_id" IS NOT NULL OR "web_projects"."created_by_sub" IS NOT NULL);--> statement-breakpoint

-- Grants: the legacy table is not migrated (decision 6); the IdP table takes its name.
DROP TABLE "tg_grants";--> statement-breakpoint
ALTER TABLE "tg_grants_v2" RENAME TO "tg_grants";--> statement-breakpoint
ALTER TABLE "tg_grants" RENAME CONSTRAINT "tg_grants_v2_pkey" TO "tg_grants_pkey";--> statement-breakpoint
ALTER TABLE "tg_grants" RENAME CONSTRAINT "tg_grants_v2_validity_check" TO "tg_grants_validity_check";--> statement-breakpoint
ALTER SEQUENCE "tg_grants_v2_id_seq" RENAME TO "tg_grants_id_seq";--> statement-breakpoint
ALTER INDEX "tg_grants_v2_telegram_user_id_idx" RENAME TO "tg_grants_telegram_user_id_idx";--> statement-breakpoint

-- Roles, group admins and Telegram links now live in the IdP; better-auth is gone.
DROP TABLE "tg_permissions";--> statement-breakpoint
DROP TABLE "tg_group_admins";--> statement-breakpoint
DROP TABLE "tg_link";--> statement-breakpoint
DROP TABLE "auth_passkey";--> statement-breakpoint
DROP TABLE "auth_sessions";--> statement-breakpoint
DROP TABLE "auth_accounts";--> statement-breakpoint
DROP TABLE "auth_verifications";--> statement-breakpoint
DROP TABLE "auth_users";
