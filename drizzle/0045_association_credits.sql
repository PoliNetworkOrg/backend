CREATE TABLE "web_association_credit_config" (
	"id" integer PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"updated_by_sub" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_association_credit_config_single" CHECK ("web_association_credit_config"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "web_association_credit_entry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"association_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"amount" integer NOT NULL,
	"reason" text NOT NULL,
	"author_sub" text NOT NULL,
	"author_name" text NOT NULL,
	"promotion_id" uuid,
	"reverses_id" uuid,
	"period" varchar(40),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_association_credit_entry_sign" CHECK ((kind = 'credit' AND amount > 0) OR (kind = 'debit' AND amount < 0) OR (kind = 'reversal' AND amount > 0) OR (kind = 'adjustment' AND amount <> 0))
);
--> statement-breakpoint
ALTER TABLE "web_association_credit_entry" ADD CONSTRAINT "web_association_credit_entry_association_id_web_association_registry_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."web_association_registry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_association_credit_entry" ADD CONSTRAINT "web_association_credit_entry_promotion_id_web_association_promotion_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."web_association_promotion"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_association_credit_entry" ADD CONSTRAINT "web_association_credit_entry_reverses_id_web_association_credit_entry_id_fk" FOREIGN KEY ("reverses_id") REFERENCES "public"."web_association_credit_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "web_association_credit_entry_association_idx" ON "web_association_credit_entry" USING btree ("association_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "web_association_credit_entry_one_debit" ON "web_association_credit_entry" USING btree ("promotion_id") WHERE kind = 'debit';--> statement-breakpoint
CREATE UNIQUE INDEX "web_association_credit_entry_one_reversal" ON "web_association_credit_entry" USING btree ("reverses_id");--> statement-breakpoint
CREATE UNIQUE INDEX "web_association_credit_entry_one_grant" ON "web_association_credit_entry" USING btree ("association_id","period") WHERE kind = 'credit' AND period IS NOT NULL;--> statement-breakpoint
CREATE TRIGGER "web_association_credit_entry_append_only"
  BEFORE UPDATE OR DELETE ON "web_association_credit_entry"
  FOR EACH ROW EXECUTE FUNCTION "web_association_append_only"();
--> statement-breakpoint
-- RRI art. 4.7: 3 credits a semester, not cumulative; costs per channel in hundredths; half price on the association's
-- own programme; PoliNetwork prices "other" cases. Turned off until PoliNetwork enables it.
INSERT INTO "web_association_credit_config" ("id", "config") VALUES (1, '{"enabled": false, "semesterGrant": 300, "costs": {"poliassociazioni": 0, "course_broadcast": 100, "exam_group": 50, "level_group": 200, "course_groups": 300, "other": null}, "ownProgrammePercent": 50, "allowNegative": false, "cooldownDays": 15}'::jsonb) ON CONFLICT DO NOTHING;
