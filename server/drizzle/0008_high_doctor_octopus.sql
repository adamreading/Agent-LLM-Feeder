CREATE TABLE "model_health" (
	"model_db_id" integer PRIMARY KEY NOT NULL,
	"health_score" real DEFAULT 1 NOT NULL,
	"recent_latency_ms" integer,
	"recent_success_rate" real,
	"consecutive_429" integer DEFAULT 0 NOT NULL,
	"last_429_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"cooldown_until" timestamp with time zone,
	"quota_exhausted_until" timestamp with time zone,
	"status" text DEFAULT 'healthy' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "disabled_reason" text;--> statement-breakpoint
ALTER TABLE "model_health" ADD CONSTRAINT "model_health_model_db_id_models_id_fk" FOREIGN KEY ("model_db_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;