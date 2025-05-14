CREATE TABLE "tg_audit_log" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tg_audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"admin_id" bigint NOT NULL,
	"target_id" bigint NOT NULL,
	"group_id" bigint,
	"type" varchar(32) NOT NULL,
	"until" timestamp (0),
	"reason" varchar(256),
	"updated_at" timestamp (3),
	"created_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "auditlog_adminid_idx" ON "tg_audit_log" USING btree ("admin_id");