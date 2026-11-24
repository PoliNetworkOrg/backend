CREATE TABLE "polimi_courses" (
	"code" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"level" text NOT NULL,
	"school" text NOT NULL,
	"regulation" text NOT NULL,
	"campuses" text[] DEFAULT '{}'::text[] NOT NULL,
	"languages" text[] DEFAULT '{}'::text[] NOT NULL,
	"active_years" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"degree_class" text DEFAULT '' NOT NULL,
	"active" boolean NOT NULL,
	"academic_year" integer NOT NULL,
	CONSTRAINT "polimi_courses_level_check" CHECK ("polimi_courses"."level" in ('bachelor', 'master', 'single-cycle')),
	CONSTRAINT "polimi_courses_school_check" CHECK ("polimi_courses"."school" in ('auic', 'icat', '3i', 'design'))
);
--> statement-breakpoint
ALTER TABLE "people_persons" ADD COLUMN "course_code" integer;--> statement-breakpoint
ALTER TABLE "people_persons" ADD COLUMN "campus" text;--> statement-breakpoint
ALTER TABLE "people_persons" ADD COLUMN "other_associations" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "people_persons" ADD COLUMN "representative_roles" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "people_persons" ADD COLUMN "representative_other" text;--> statement-breakpoint
ALTER TABLE "people_persons" ADD CONSTRAINT "people_persons_course_code_polimi_courses_code_fk" FOREIGN KEY ("course_code") REFERENCES "public"."polimi_courses"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_persons" ADD CONSTRAINT "people_persons_campus_check" CHECK ("people_persons"."campus" in ('leonardo', 'bovisa', 'lecco', 'cremona', 'mantova', 'piacenza', 'external'));--> statement-breakpoint
ALTER TABLE "people_persons" ADD CONSTRAINT "people_persons_representative_roles_check" CHECK ("people_persons"."representative_roles" <@ array['ccs', 'school', 'senate', 'board', 'other']::text[]);--> statement-breakpoint
ALTER TABLE "people_persons" ADD CONSTRAINT "people_persons_representative_other_check" CHECK (("people_persons"."representative_other" is not null) = ('other' = any("people_persons"."representative_roles")));--> statement-breakpoint
ALTER TABLE "people_persons" ADD CONSTRAINT "people_persons_representative_course_check" CHECK ("people_persons"."course_code" is not null or not ("people_persons"."representative_roles" && array['ccs', 'school']::text[]));