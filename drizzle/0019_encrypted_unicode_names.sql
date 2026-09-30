SET LOCAL lock_timeout = '500ms';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "tg_users" ALTER COLUMN "first_name" SET DATA TYPE varchar(512);--> statement-breakpoint
ALTER TABLE "tg_users" ALTER COLUMN "last_name" SET DATA TYPE varchar(512);
