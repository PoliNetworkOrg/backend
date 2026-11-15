CREATE TABLE "web_document_categories" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "web_document_categories_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"legacy_created_by_tg_id" bigint,
	"legacy_modified_by_tg_id" bigint,
	"created_by_sub" text,
	"modified_by_sub" text,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_document_categories_slug_unique" UNIQUE("slug"),
	CONSTRAINT "web_document_categories_creator_check" CHECK ("web_document_categories"."legacy_created_by_tg_id" IS NOT NULL OR "web_document_categories"."created_by_sub" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "web_document_versions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "web_document_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"document_id" integer NOT NULL,
	"version" text NOT NULL,
	"date" text NOT NULL,
	"file" text NOT NULL,
	"legacy_created_by_tg_id" bigint,
	"legacy_modified_by_tg_id" bigint,
	"created_by_sub" text,
	"modified_by_sub" text,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_document_versions_document_id_version_unique" UNIQUE("document_id","version"),
	CONSTRAINT "web_document_versions_creator_check" CHECK ("web_document_versions"."legacy_created_by_tg_id" IS NOT NULL OR "web_document_versions"."created_by_sub" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "web_documents" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "web_documents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"category_id" integer NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"position" integer DEFAULT 0 NOT NULL,
	"legacy_created_by_tg_id" bigint,
	"legacy_modified_by_tg_id" bigint,
	"created_by_sub" text,
	"modified_by_sub" text,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_documents_slug_unique" UNIQUE("slug"),
	CONSTRAINT "web_documents_creator_check" CHECK ("web_documents"."legacy_created_by_tg_id" IS NOT NULL OR "web_documents"."created_by_sub" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "web_document_versions" ADD CONSTRAINT "web_document_versions_document_id_web_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."web_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_documents" ADD CONSTRAINT "web_documents_category_id_web_document_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."web_document_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "web_documents_category_id_idx" ON "web_documents" USING btree ("category_id");