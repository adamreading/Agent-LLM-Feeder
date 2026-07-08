CREATE TABLE "benchmark_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"canonical_model_id" integer NOT NULL,
	"alias_key" text NOT NULL,
	CONSTRAINT "benchmark_aliases_alias_key_unique" UNIQUE("alias_key")
);
--> statement-breakpoint
CREATE TABLE "task_scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"canonical_model_id" integer NOT NULL,
	"task_type" text NOT NULL,
	"score" real NOT NULL,
	"rank" integer,
	"source" text DEFAULT 'benchmark' NOT NULL,
	"evidence" text,
	"measured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_scores_canonical_task_source_unique" UNIQUE("canonical_model_id","task_type","source")
);
--> statement-breakpoint
ALTER TABLE "benchmark_aliases" ADD CONSTRAINT "benchmark_aliases_canonical_model_id_canonical_models_id_fk" FOREIGN KEY ("canonical_model_id") REFERENCES "public"."canonical_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_scores" ADD CONSTRAINT "task_scores_canonical_model_id_canonical_models_id_fk" FOREIGN KEY ("canonical_model_id") REFERENCES "public"."canonical_models"("id") ON DELETE cascade ON UPDATE no action;