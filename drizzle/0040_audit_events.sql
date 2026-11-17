CREATE TABLE "common_audit_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "common_audit_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"action" text NOT NULL,
	"request_id" uuid,
	"actor_kind" varchar(16) NOT NULL,
	"actor_sub" text,
	"actor_tg_id" bigint,
	"actor_client" text,
	"target_type" text,
	"target_id" text,
	"target_label" text,
	"reason" text,
	"outcome" varchar(16) NOT NULL,
	"error" text,
	"input" jsonb,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "common_audit_events_action_idx" ON "common_audit_events" USING btree ("action");--> statement-breakpoint
CREATE INDEX "common_audit_events_actor_sub_idx" ON "common_audit_events" USING btree ("actor_sub");--> statement-breakpoint
CREATE INDEX "common_audit_events_actor_tg_id_idx" ON "common_audit_events" USING btree ("actor_tg_id");--> statement-breakpoint
CREATE INDEX "common_audit_events_target_idx" ON "common_audit_events" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "common_audit_events_request_id_idx" ON "common_audit_events" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "common_audit_events_created_at_idx" ON "common_audit_events" USING btree ("created_at");