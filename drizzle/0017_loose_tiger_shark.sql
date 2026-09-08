CREATE TABLE "web_group_link_reports" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "web_group_link_reports_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"group_id" bigint NOT NULL,
	"type" varchar(2) NOT NULL,
	"report_type" varchar(32) NOT NULL,
	"reported_link" varchar(256),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL
);
