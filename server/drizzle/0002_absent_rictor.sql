ALTER TABLE "model_capabilities" DROP CONSTRAINT "model_capabilities_model_capability_unique";--> statement-breakpoint
ALTER TABLE "model_capabilities" ADD COLUMN "source" text DEFAULT 'declared' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_capabilities" ADD CONSTRAINT "model_capabilities_model_capability_source_unique" UNIQUE("model_db_id","capability","source");