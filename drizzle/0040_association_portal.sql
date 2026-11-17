CREATE TABLE "web_association_mail" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mail" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "web_association_registry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"state" jsonb NOT NULL,
	"creation_key" text NOT NULL,
	CONSTRAINT "web_association_registry_creation_key_unique" UNIQUE("creation_key")
);

--> statement-breakpoint
-- Existing public records remain published, but no one is automatically made their representative.
INSERT INTO "web_association_registry" (id, state, creation_key)
SELECT rid, jsonb_build_object(
  'id', rid, 'legacyId', a.id, 'revision', 0, 'creator', 'system', 'registered', true, 'status', 'active',
  'profile', profile, 'published', profile, 'members', '[]'::jsonb, 'requests', '[]'::jsonb,
  'events', '[]'::jsonb, 'invitations', '[]'::jsonb, 'notes', '', 'commands', '[]'::jsonb
), 'legacy:' || a.id
FROM web_associations a
CROSS JOIN LATERAL (SELECT gen_random_uuid() AS rid WHERE a.id IS NOT NULL) ids
CROSS JOIN LATERAL (SELECT jsonb_build_object(
  'name', a.name, 'acronym', '', 'descriptionIt', a.description_it, 'descriptionEn', a.description_en,
  'logo', a.logo, 'email', coalesce(a.email, ''),
  'links', coalesce((SELECT jsonb_agg(jsonb_build_object('platform', key, 'label', key, 'url', value))
    FROM jsonb_each_text(jsonb_build_object('website', a.website, 'facebook', a.facebook, 'instagram', a.instagram,
      'tiktok', a.tiktok, 'x', a.x, 'youtube', a.youtube, 'telegram', a.telegram, 'linkedin', a.linkedin, 'spotify', a.spotify))
    WHERE value IS NOT NULL AND value <> ''), '[]'::jsonb)
) AS profile) profiles;
