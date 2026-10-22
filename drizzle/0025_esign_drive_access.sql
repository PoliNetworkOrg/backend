CREATE TABLE "esign_drive_access" (
	"drive_id" text PRIMARY KEY NOT NULL,
	"request_roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"request_permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"sign_roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"sign_permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_by_sub" text,
	"updated_at" timestamp (0) with time zone,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "esign_requests" ADD COLUMN "drives" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
-- Existing requests: the drive they save to and the drive their original PDF came from. jsonb written by the app may
-- be a JSON string scalar.
UPDATE "esign_requests" r SET "drives" = ARRAY(
	SELECT DISTINCT d FROM (
		SELECT (r."output" #>> '{}')::jsonb ->> 'driveId' AS d
		UNION
		SELECT (doc."source" #>> '{}')::jsonb ->> 'driveId' FROM "esign_documents" doc
		WHERE doc."request_id" = r."id" AND doc."version" = 0
	) drives WHERE d IS NOT NULL
);
