ALTER TABLE "tg_permissions" ALTER COLUMN "roles" DROP DEFAULT;--> statement-breakpoint 
ALTER TABLE "tg_permissions" ALTER COLUMN "roles" SET DATA TYPE text[] USING roles::text[];--> statement-breakpoint 
ALTER TABLE "tg_permissions" ALTER COLUMN "roles" SET DEFAULT '{"admin"}';
