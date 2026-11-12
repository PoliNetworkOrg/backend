ALTER TABLE "soci_members" ADD COLUMN "residence" text;--> statement-breakpoint
ALTER TABLE "soci_members" ADD COLUMN "phone" text;--> statement-breakpoint
-- Keep any residence already recorded: the five parts become one line, e.g. `Via Roma 1, 20133 Milano (MI)`.
UPDATE "soci_members" SET "residence" = nullif(concat_ws(', ',
	nullif(trim("residence_street"), ''),
	nullif(trim(concat_ws(' ', "residence_postal_code", "residence_city" || coalesce(' (' || "residence_province" || ')', ''))), ''),
	nullif("residence_country", 'IT')
), '');
