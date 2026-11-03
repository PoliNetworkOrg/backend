ALTER TABLE "people_files" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "people_receipt_requests" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "people_receipts" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "people_files" CASCADE;--> statement-breakpoint
DROP TABLE "people_receipt_requests" CASCADE;--> statement-breakpoint
DROP TABLE "people_receipts" CASCADE;--> statement-breakpoint
ALTER TABLE "people_identities" DROP CONSTRAINT "people_identities_member_number_unique";--> statement-breakpoint
ALTER TABLE "people_identities" DROP COLUMN "member_number";--> statement-breakpoint
-- The People records hold only test data shaped for the removed features (PoliNetworkOrg/backend#100): start empty.
DELETE FROM "people_identities";--> statement-breakpoint
DELETE FROM "people_records";