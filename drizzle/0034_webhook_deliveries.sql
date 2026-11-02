CREATE TABLE "common_webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"event" text NOT NULL,
	"received_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "common_webhook_deliveries_received_idx" ON "common_webhook_deliveries" USING btree ("received_at");