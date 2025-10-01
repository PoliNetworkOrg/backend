CREATE TABLE "tg_users" (
	"user_id" bigint PRIMARY KEY NOT NULL,
	"first_name" varchar(192) NOT NULL,
	"last_name" varchar(192),
	"username" varchar(128),
	"is_bot" boolean NOT NULL,
	"lang_code" varchar(35),
	"updated_at" timestamp (0),
	"created_at" timestamp (0) DEFAULT now() NOT NULL
);
