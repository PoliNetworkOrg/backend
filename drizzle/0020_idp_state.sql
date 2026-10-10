CREATE TABLE "common_idp_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
