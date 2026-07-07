ALTER TABLE "model_capabilities" DROP CONSTRAINT "model_capabilities_model_db_id_models_id_fk";
--> statement-breakpoint
ALTER TABLE "probe_results" DROP CONSTRAINT "probe_results_probe_id_probe_bank_id_fk";
--> statement-breakpoint
ALTER TABLE "probe_results" DROP CONSTRAINT "probe_results_model_db_id_models_id_fk";
--> statement-breakpoint
ALTER TABLE "quota_snapshots" DROP CONSTRAINT "quota_snapshots_api_key_id_api_keys_id_fk";
--> statement-breakpoint
ALTER TABLE "model_capabilities" ADD CONSTRAINT "model_capabilities_model_db_id_models_id_fk" FOREIGN KEY ("model_db_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_results" ADD CONSTRAINT "probe_results_probe_id_probe_bank_id_fk" FOREIGN KEY ("probe_id") REFERENCES "public"."probe_bank"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_results" ADD CONSTRAINT "probe_results_model_db_id_models_id_fk" FOREIGN KEY ("model_db_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_snapshots" ADD CONSTRAINT "quota_snapshots_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;