CREATE TABLE "web_association_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"association_id" uuid NOT NULL,
	"status" varchar(24) NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"content" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text NOT NULL,
	"notify" text[] NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "web_association_event_status" CHECK (status IN ('draft', 'submitted', 'changes_requested', 'approved', 'rejected', 'withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "web_association_event_transition" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
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
ALTER TABLE "web_association_event" ADD CONSTRAINT "web_association_event_association_id_web_association_registry_id_fk" FOREIGN KEY ("association_id") REFERENCES "public"."web_association_registry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_association_event_transition" ADD CONSTRAINT "web_association_event_transition_event_id_web_association_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."web_association_event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "web_association_event_association_idx" ON "web_association_event" USING btree ("association_id");--> statement-breakpoint
CREATE INDEX "web_association_event_calendar_idx" ON "web_association_event" USING btree ("status","starts_at");--> statement-breakpoint
CREATE INDEX "web_association_event_transition_event_idx" ON "web_association_event_transition" USING btree ("event_id","at");--> statement-breakpoint
CREATE TRIGGER "web_association_event_transition_append_only"
  BEFORE UPDATE OR DELETE ON "web_association_event_transition"
  FOR EACH ROW EXECUTE FUNCTION "web_association_append_only"();
--> statement-breakpoint
-- Registry records gain the collaboration flag (closed until a representative opens it).
UPDATE "web_association_registry" SET "state" = "state" || jsonb_build_object('collaboration', jsonb_build_object('open', false, 'contactId', null))
WHERE NOT "state" ? 'collaboration';
