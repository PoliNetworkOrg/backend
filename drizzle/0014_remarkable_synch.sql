ALTER TABLE "web_faq_categories" RENAME COLUMN "title" TO "title_it";--> statement-breakpoint
ALTER TABLE "web_faqs" RENAME COLUMN "title" TO "title_it";--> statement-breakpoint
ALTER TABLE "web_faqs" RENAME COLUMN "description" TO "description_it";--> statement-breakpoint
ALTER TABLE "web_faq_categories" ADD COLUMN "title_en" text NOT NULL;--> statement-breakpoint
ALTER TABLE "web_faqs" ADD COLUMN "title_en" text NOT NULL;--> statement-breakpoint
ALTER TABLE "web_faqs" ADD COLUMN "description_en" text NOT NULL;