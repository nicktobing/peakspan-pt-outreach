CREATE TYPE "public"."decision_status" AS ENUM('pending', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'paused', 'cancelled');--> statement-breakpoint
CREATE TABLE "action_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" text NOT NULL,
	"action" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider_run_id" text,
	"status" "run_status" DEFAULT 'pending' NOT NULL,
	"cost_usd" numeric(12, 6),
	"result" jsonb,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot" jsonb NOT NULL,
	"status" "decision_status" DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_message_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"preview" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" text NOT NULL,
	"kind" text NOT NULL,
	"prompt_version" text,
	"message_text" text NOT NULL,
	"compliance_result" jsonb,
	"provider_message_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppression_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" text NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow" text NOT NULL,
	"workflow_run_id" text NOT NULL,
	"scheduled_window" text,
	"status" "run_status" DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "action_attempts_idempotency_uidx" ON "action_attempts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "action_attempts_contact_idx" ON "action_attempts" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_events_source_external_uidx" ON "inbound_events" USING btree ("source","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_messages_provider_message_uidx" ON "inbox_messages" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "inbox_messages_contact_idx" ON "inbox_messages" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "message_audit_contact_idx" ON "message_audit" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suppression_entries_contact_uidx" ON "suppression_entries" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_workflow_run_uidx" ON "workflow_runs" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_schedule_window_uidx" ON "workflow_runs" USING btree ("workflow","scheduled_window");
