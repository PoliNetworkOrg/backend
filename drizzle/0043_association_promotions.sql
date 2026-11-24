CREATE TABLE "web_association_command_key" (
	"key" text PRIMARY KEY NOT NULL,
	"result" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_association_promotion" (
	"id" uuid PRIMARY KEY NOT NULL,
	"association_id" uuid NOT NULL,
	"status" varchar(24) NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"content" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text NOT NULL,
	"notify" text[] NOT NULL,
	"desired_date" date,
	"scheduled_at" timestamp with time zone,
	"scheduled_channel" varchar(32),
	"scheduled_detail" text DEFAULT '' NOT NULL,
	"published_url" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "web_association_promotion_status" CHECK (status IN ('draft', 'submitted', 'changes_requested', 'approved', 'scheduled', 'published', 'rejected', 'withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "web_association_promotion_transition" (
	"id" uuid PRIMARY KEY NOT NULL,
	"promotion_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"from_status" varchar(24),
	"to_status" varchar(24),
	"actor_sub" text NOT NULL,
	"actor_name" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "web_association_promotion" ADD CONSTRAINT "web_association_promotion_association_id_web_association_registry_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."web_association_registry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_association_promotion_transition" ADD CONSTRAINT "web_association_promotion_transition_promotion_id_web_association_promotion_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."web_association_promotion"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "web_association_promotion_association_idx" ON "web_association_promotion" USING btree ("association_id");--> statement-breakpoint
CREATE INDEX "web_association_promotion_queue_idx" ON "web_association_promotion" USING btree ("status","desired_date");--> statement-breakpoint
CREATE INDEX "web_association_promotion_transition_promotion_idx" ON "web_association_promotion_transition" USING btree ("promotion_id","at");--> statement-breakpoint
-- Transitions are an audit trail: rows are only ever inserted.
CREATE FUNCTION "web_association_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "web_association_promotion_transition_append_only"
  BEFORE UPDATE OR DELETE ON "web_association_promotion_transition"
  FOR EACH ROW EXECUTE FUNCTION "web_association_append_only"();
