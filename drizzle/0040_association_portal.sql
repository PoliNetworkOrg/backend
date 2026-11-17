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
  -- Legacy values are normalised to what the registry contract accepts: only http(s) links and logos, valid emails.
  'name', left(coalesce(nullif(btrim(a.name), ''), 'Association'), 200), 'acronym', '',
  'descriptionIt', left(a.description_it, 20000), 'descriptionEn', left(a.description_en, 20000),
  'logo', CASE WHEN a.logo ~* '^https?://[^[:space:]]+$' AND length(a.logo) <= 2048 THEN to_jsonb(a.logo) ELSE 'null'::jsonb END,
  'email', CASE WHEN a.email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' AND length(a.email) <= 320 THEN a.email ELSE '' END,
  'links', coalesce((SELECT jsonb_agg(jsonb_build_object('platform', v.k, 'label', v.k, 'url', v.u) ORDER BY v.ord)
    FROM (VALUES (1, 'website', a.website), (2, 'facebook', a.facebook), (3, 'instagram', a.instagram),
      (4, 'tiktok', a.tiktok), (5, 'x', a.x), (6, 'youtube', a.youtube), (7, 'telegram', a.telegram),
      (8, 'linkedin', a.linkedin), (9, 'spotify', a.spotify)) AS v(ord, k, u)
    WHERE v.u ~* '^https?://[^[:space:]]+$' AND length(v.u) <= 2048), '[]'::jsonb)
) AS profile) profiles;
