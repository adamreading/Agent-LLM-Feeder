ALTER TABLE "models" ADD COLUMN "last_seen_live" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "missing_polls" integer DEFAULT 0 NOT NULL;
