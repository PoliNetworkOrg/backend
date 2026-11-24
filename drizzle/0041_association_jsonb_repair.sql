-- Rows written through drizzle's jsonb() with Bun SQL hold the JSON text as a jsonb string, so JSON operators
-- (published profiles, invitation hashes, request counts) did not see them. Store them as objects again.
UPDATE "web_association_registry" SET "state" = ("state" #>> '{}')::jsonb WHERE jsonb_typeof("state") = 'string';
--> statement-breakpoint
UPDATE "web_association_mail" SET "mail" = ("mail" #>> '{}')::jsonb WHERE jsonb_typeof("mail") = 'string';
