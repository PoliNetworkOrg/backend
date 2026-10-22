ALTER TABLE "web_group_link_reports" ALTER COLUMN "group_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "web_group_link_reports" ALTER COLUMN "type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "web_group_link_reports" ADD COLUMN "label" varchar(256);--> statement-breakpoint
ALTER TABLE "web_group_link_reports" ADD COLUMN "details" varchar(500);