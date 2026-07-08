CREATE TABLE "platform_key_watch" (
	"platform" text PRIMARY KEY NOT NULL,
	"keys_missing_since" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "auto_disabled_no_key" boolean DEFAULT false NOT NULL;