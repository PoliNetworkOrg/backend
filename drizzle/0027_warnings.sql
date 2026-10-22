CREATE TABLE "tg_warnings" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tg_warnings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"target_id" bigint NOT NULL,
	"admin_id" bigint NOT NULL,
	"group_id" bigint NOT NULL,
	"reason" varchar(256),
	"is_expired" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "warnings_target_idx" ON "tg_warnings" USING btree ("target_id");