CREATE TABLE "response_feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model_db_id" integer,
	"platform" text,
	"model_id" text,
	"task_class" text,
	"had_image" boolean DEFAULT false NOT NULL,
	"rating" text NOT NULL,
	"consumer" text
);
