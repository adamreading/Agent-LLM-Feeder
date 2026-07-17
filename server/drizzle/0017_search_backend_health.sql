CREATE TABLE "search_backend_health" (
	"backend" text PRIMARY KEY NOT NULL,
	"recent_latency_ms" integer,
	"success_count" integer DEFAULT 0 NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"calls_total" integer DEFAULT 0 NOT NULL,
	"cooldown_until" timestamp with time zone,
	"last_error" text,
	"last_used_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
