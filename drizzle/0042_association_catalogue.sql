CREATE TABLE "web_association_catalogue" (
	"kind" varchar(16) NOT NULL,
	"slug" varchar(160) NOT NULL,
	"name_it" varchar(200) NOT NULL,
	"name_en" varchar(200) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_by_sub" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_association_catalogue_kind_slug_pk" PRIMARY KEY("kind","slug"),
	CONSTRAINT "web_association_catalogue_kind" CHECK ("web_association_catalogue"."kind" IN ('programme', 'campus'))
);
--> statement-breakpoint
-- Programmes come from the group labels (didattica.<school>.<level>.<course>[.<cohort>]), so associations and
-- per-programme groups share one key. Names are humanised slugs: operators should review them after the migration.
INSERT INTO "web_association_catalogue" ("kind", "slug", "name_it", "name_en")
SELECT DISTINCT ON (slug) 'programme', slug,
  left(initcap(replace(course, '-', ' ')) || ' (' || CASE level WHEN 'ciclo-unico' THEN 'ciclo unico' ELSE level END || ')', 200),
  left(initcap(replace(course, '-', ' ')) || ' (' || CASE level WHEN 'triennale' THEN 'bachelor' WHEN 'magistrale' THEN 'master' WHEN 'ciclo-unico' THEN 'single cycle' ELSE level END || ')', 200)
FROM (
  SELECT parts[1] || '.' || parts[2] || '.' || parts[3] || '.' || parts[4] AS slug, parts[3] AS level, parts[4] AS course
  FROM (SELECT string_to_array("label", '.') AS parts FROM "common_group_labels" WHERE "label" LIKE 'didattica.%') l
  WHERE cardinality(parts) >= 4 AND parts[4] ~ '^[a-z0-9-]+$' AND parts[4] !~ '^[0-9]{2}-[0-9]{2}$'
) programmes
WHERE slug ~ '^[a-z0-9-]+(\.[a-z0-9-]+)*$' AND length(slug) <= 160
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Current Politecnico campuses (Como closed in 2018). Operators can add or retire entries.
INSERT INTO "web_association_catalogue" ("kind", "slug", "name_it", "name_en") VALUES
  ('campus', 'leonardo', 'Milano Leonardo', 'Milan Leonardo'),
  ('campus', 'bovisa', 'Milano Bovisa', 'Milan Bovisa'),
  ('campus', 'cremona', 'Cremona', 'Cremona'),
  ('campus', 'lecco', 'Lecco', 'Lecco'),
  ('campus', 'mantova', 'Mantova', 'Mantua'),
  ('campus', 'piacenza', 'Piacenza', 'Piacenza')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Registry records gain programmes, campuses, the cross-programme flag and contacts (public ones in the profile).
UPDATE "web_association_registry" SET "state" = "state" || jsonb_build_object(
  'profile', d.v || ("state"->'profile'),
  'published', CASE WHEN jsonb_typeof("state"->'published') = 'object' THEN d.v || ("state"->'published') ELSE 'null'::jsonb END,
  'requests', coalesce((
    SELECT jsonb_agg(CASE WHEN jsonb_typeof(q->'profile') = 'object' THEN jsonb_set(q, '{profile}', d.v || (q->'profile')) ELSE q END ORDER BY o)
    FROM jsonb_array_elements("state"->'requests') WITH ORDINALITY AS e(q, o)
  ), '[]'::jsonb),
  'contacts', coalesce("state"->'contacts', '[]'::jsonb)
)
FROM (SELECT '{"programmes": [], "campuses": [], "crossProgramme": false, "contacts": []}'::jsonb AS v) d;
