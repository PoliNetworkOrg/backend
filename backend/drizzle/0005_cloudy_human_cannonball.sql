CREATE TABLE "tg_grants" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tg_grants_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" bigint,
	"granted_by_id" bigint NOT NULL,
	"valid_since" timestamp (0) NOT NULL,
	"valid_until" timestamp (0) NOT NULL,
	"interrupted_by_id" bigint,
	"reason" text,
	"updated_at" timestamp (0),
	"created_at" timestamp (0) DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tg_grants" ADD CONSTRAINT "tg_grants_granted_by_id_tg_permissions_user_id_fk" FOREIGN KEY ("granted_by_id") REFERENCES "public"."tg_permissions"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_grants" ADD CONSTRAINT "tg_grants_interrupted_by_id_tg_permissions_user_id_fk" FOREIGN KEY ("interrupted_by_id") REFERENCES "public"."tg_permissions"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tg_grants_user_id_idx" ON "tg_grants" USING btree ("user_id");