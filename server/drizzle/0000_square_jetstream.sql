CREATE TABLE "api_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"encrypted_key" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "consumer_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"key_hash" text NOT NULL,
	"trust_tier" text DEFAULT 'external' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "consumer_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "fallback_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_db_id" integer NOT NULL,
	"priority" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "fallback_config_model_db_id_unique" UNIQUE("model_db_id")
);
--> statement-breakpoint
CREATE TABLE "model_capabilities" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_db_id" integer NOT NULL,
	"capability" text NOT NULL,
	"supported" boolean DEFAULT false NOT NULL,
	"dialect" text,
	"score" real,
	"measured_at" timestamp with time zone,
	"evidence" text,
	"suspect" boolean DEFAULT false NOT NULL,
	CONSTRAINT "model_capabilities_model_capability_unique" UNIQUE("model_db_id","capability")
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"model_id" text NOT NULL,
	"display_name" text NOT NULL,
	"intelligence_rank" integer NOT NULL,
	"speed_rank" integer NOT NULL,
	"size_label" text DEFAULT '' NOT NULL,
	"rpm_limit" integer,
	"rpd_limit" integer,
	"tpm_limit" integer,
	"tpd_limit" integer,
	"monthly_token_budget" text DEFAULT '' NOT NULL,
	"context_window" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "models_platform_model_id_unique" UNIQUE("platform","model_id")
);
--> statement-breakpoint
CREATE TABLE "policy_matrix" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_class" text NOT NULL,
	"user_pref" text NOT NULL,
	"cost_tier_ceiling" text NOT NULL,
	"quality_floor" text,
	"latency_ceiling_ms" integer,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"hard_cap" boolean DEFAULT false NOT NULL,
	CONSTRAINT "policy_matrix_task_class_user_pref_unique" UNIQUE("task_class","user_pref")
);
--> statement-breakpoint
CREATE TABLE "probe_bank" (
	"id" serial PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"capability" text NOT NULL,
	"prompt" jsonb NOT NULL,
	"expected_shape" jsonb,
	"is_paid_probe" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "probe_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"probe_id" integer NOT NULL,
	"model_db_id" integer NOT NULL,
	"passed" boolean NOT NULL,
	"latency_ms" integer,
	"cost_estimate" real,
	"raw_response" text,
	"lease_id" text,
	"measured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"is_paid" boolean DEFAULT false NOT NULL,
	"quota_model" text DEFAULT 'metered' NOT NULL,
	"window_hours" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quota_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"model_id" text,
	"api_key_id" integer,
	"quota_remaining" real,
	"quota_limit" real,
	"reset_at" timestamp with time zone,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quota_snapshots_platform_model_key_unique" UNIQUE("platform","model_id","api_key_id")
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"model_id" text NOT NULL,
	"status" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_probe" boolean DEFAULT false NOT NULL,
	"session_id" text,
	"task_class" text
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fallback_config" ADD CONSTRAINT "fallback_config_model_db_id_models_id_fk" FOREIGN KEY ("model_db_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_capabilities" ADD CONSTRAINT "model_capabilities_model_db_id_models_id_fk" FOREIGN KEY ("model_db_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_results" ADD CONSTRAINT "probe_results_probe_id_probe_bank_id_fk" FOREIGN KEY ("probe_id") REFERENCES "public"."probe_bank"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_results" ADD CONSTRAINT "probe_results_model_db_id_models_id_fk" FOREIGN KEY ("model_db_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_snapshots" ADD CONSTRAINT "quota_snapshots_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;