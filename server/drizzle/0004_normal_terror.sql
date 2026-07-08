CREATE TABLE "canonical_model_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"canonical_model_id" integer NOT NULL,
	"alias_key" text NOT NULL,
	CONSTRAINT "canonical_model_aliases_alias_key_unique" UNIQUE("alias_key")
);
--> statement-breakpoint
CREATE TABLE "canonical_models" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"summary" text,
	"vision" boolean DEFAULT false NOT NULL,
	"video" boolean DEFAULT false NOT NULL,
	"audio" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "canonical_models_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "canonical_model_id" integer;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "match_status" text DEFAULT 'unmatched' NOT NULL;--> statement-breakpoint
ALTER TABLE "canonical_model_aliases" ADD CONSTRAINT "canonical_model_aliases_canonical_model_id_canonical_models_id_fk" FOREIGN KEY ("canonical_model_id") REFERENCES "public"."canonical_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_canonical_model_id_canonical_models_id_fk" FOREIGN KEY ("canonical_model_id") REFERENCES "public"."canonical_models"("id") ON DELETE no action ON UPDATE no action;