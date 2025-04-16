CREATE TABLE "tg_link" (
	"code" text PRIMARY KEY NOT NULL,
	"ttl" integer NOT NULL,
	"user_id" text NOT NULL,
	"tg_username" text NOT NULL,
	"tg_id" bigint,
	"updated_at" timestamp (3),
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "tg_link_tg_id_unique" UNIQUE("tg_id")
);
--> statement-breakpoint
ALTER TABLE "auth_users" ADD COLUMN "tg_id" bigint;--> statement-breakpoint
ALTER TABLE "auth_users" ADD COLUMN "tg_username" text;--> statement-breakpoint
ALTER TABLE "tg_link" ADD CONSTRAINT "tg_link_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE no action ON UPDATE no action;