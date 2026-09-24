import {
  boolean,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const runStatus = pgEnum("run_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
  "paused",
  "cancelled",
]);

export const decisionStatus = pgEnum("decision_status", [
  "pending",
  "approved",
  "rejected",
  "expired",
]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const inboundEvents = pgTable(
  "inbound_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("inbound_events_source_external_uidx").on(table.source, table.externalId)],
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workflow: text("workflow").notNull(),
    workflowRunId: text("workflow_run_id").notNull(),
    result: jsonb("result"),
    scheduledWindow: text("scheduled_window"),
    status: runStatus("status").default("pending").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    errorCode: text("error_code"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("workflow_runs_workflow_run_uidx").on(table.workflowRunId),
    uniqueIndex("workflow_runs_schedule_window_uidx").on(table.workflow, table.scheduledWindow),
  ],
);

export const actionAttempts = pgTable(
  "action_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactId: text("contact_id").notNull(),
    action: text("action").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    providerRunId: text("provider_run_id"),
    status: runStatus("status").default("pending").notNull(),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    result: jsonb("result"),
    errorCode: text("error_code"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("action_attempts_idempotency_uidx").on(table.idempotencyKey),
    index("action_attempts_contact_idx").on(table.contactId),
  ],
);

export const approvalBatches = pgTable("approval_batches", {
  id: uuid("id").defaultRandom().primaryKey(),
  snapshot: jsonb("snapshot").notNull(),
  status: decisionStatus("status").default("pending").notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decidedBy: text("decided_by"),
  ...timestamps,
});

export const messageAudit = pgTable(
  "message_audit",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactId: text("contact_id").notNull(),
    kind: text("kind").notNull(),
    promptVersion: text("prompt_version"),
    messageText: text("message_text").notNull(),
    complianceResult: jsonb("compliance_result"),
    providerMessageId: text("provider_message_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index("message_audit_contact_idx").on(table.contactId)],
);

export const inboxMessages = pgTable(
  "inbox_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    providerMessageId: text("provider_message_id").notNull(),
    contactId: text("contact_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    preview: text("preview").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("inbox_messages_provider_message_uidx").on(table.providerMessageId),
    index("inbox_messages_contact_idx").on(table.contactId),
  ],
);

export const suppressionEntries = pgTable(
  "suppression_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactId: text("contact_id").notNull(),
    reason: text("reason").notNull(),
    source: text("source").notNull(),
    active: boolean("active").default(true).notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("suppression_entries_contact_uidx").on(table.contactId)],
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: text("updated_by").notNull(),
  ...timestamps,
});

export const monitoringAlertStatus = pgEnum("monitoring_alert_status", ["pending", "sending", "sent", "unknown"]);
export const monitoringAlerts = pgTable("monitoring_alerts", {
  id: uuid("id").defaultRandom().primaryKey(),
  dedupeKey: text("dedupe_key").notNull(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull(),
  status: monitoringAlertStatus("status").default("pending").notNull(),
  providerMessageId: text("provider_message_id"),
  ...timestamps,
}, (table) => [uniqueIndex("monitoring_alerts_dedupe_uidx").on(table.dedupeKey)]);

export const escalationQueue = pgTable("escalation_queue", {
  id: uuid("id").defaultRandom().primaryKey(),
  contactId: text("contact_id").notNull(),
  priority: text("priority").notNull(),
  reason: text("reason").notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  ...timestamps,
});


