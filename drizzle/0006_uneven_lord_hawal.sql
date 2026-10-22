CREATE TABLE "auth_passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp,
	"aaguid" text
);
--> statement-breakpoint
ALTER TABLE "auth_verifications" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_verifications" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_passkey" ADD CONSTRAINT "auth_passkey_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "passkey_userId_idx" ON "auth_passkey" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_credentialID_idx" ON "auth_passkey" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "auth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "auth_verifications" USING btree ("identifier");