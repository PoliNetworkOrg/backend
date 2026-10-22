ALTER TABLE "esign_jobs" ALTER COLUMN "placement" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "esign_signers" ALTER COLUMN "placement" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "esign_jobs" ADD COLUMN "places" jsonb;--> statement-breakpoint
ALTER TABLE "esign_jobs" ADD COLUMN "step" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "esign_signers" ADD COLUMN "places" jsonb;--> statement-breakpoint
ALTER TABLE "esign_signers" ADD COLUMN "signatures_done" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Each existing placement becomes the signer's only place. jsonb written by the app may be a JSON string scalar.
UPDATE "esign_jobs" SET "places" = jsonb_build_array(("placement" #>> '{}')::jsonb || '{"kind":"signature"}'::jsonb);--> statement-breakpoint
UPDATE "esign_signers" SET "places" = jsonb_build_array(("placement" #>> '{}')::jsonb || '{"kind":"signature"}'::jsonb);--> statement-breakpoint
ALTER TABLE "esign_jobs" ALTER COLUMN "places" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "esign_signers" ALTER COLUMN "places" SET NOT NULL;
