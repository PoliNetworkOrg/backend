ALTER TABLE "web_freshman_cards" ADD COLUMN "telegram_group_id" bigint;--> statement-breakpoint
ALTER TABLE "web_freshman_cards" ADD CONSTRAINT "web_freshman_cards_telegram_group_id_tg_groups_telegram_id_fk" FOREIGN KEY ("telegram_group_id") REFERENCES "public"."tg_groups"("telegram_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_freshman_cards" ADD CONSTRAINT "web_freshman_cards_telegram_group_check" CHECK ("web_freshman_cards"."telegram_group_id" is null or "web_freshman_cards"."id" like 'telegram-%');--> statement-breakpoint
-- Link each Telegram slot to the group behind its link (an invite link, in either t.me/joinchat/ or t.me/+ form,
-- or the group's public t.me/<tag> link), then drop the link it replaces. Unmatched slots keep their legacy link
-- until an editor picks a group.
UPDATE "web_freshman_cards" AS "card"
SET "telegram_group_id" = (
	SELECT "group"."telegram_id"
	FROM "tg_groups" AS "group"
	-- Like updateTelegramCard, only a group with an invite link replaces the slot's link.
	WHERE coalesce("group"."link", '') <> ''
		AND (lower(replace("group"."link", '/joinchat/', '/+')) = lower(replace(trim("card"."href"), '/joinchat/', '/+'))
			OR ("group"."tag" IS NOT NULL
				AND lower('https://t.me/' || ltrim("group"."tag", '@')) = lower(rtrim(trim("card"."href"), '/'))))
	ORDER BY ("group"."link" = trim("card"."href")) DESC, "group"."hide", "group"."telegram_id"
	LIMIT 1
)
WHERE "card"."id" LIKE 'telegram-%';--> statement-breakpoint
UPDATE "web_freshman_cards" SET "href" = '' WHERE "telegram_group_id" IS NOT NULL;
