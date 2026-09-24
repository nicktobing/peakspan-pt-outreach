import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";
import { actionAttempts, escalationQueue, inboxMessages, monitoringAlerts, suppressionEntries, workflowRuns } from "./schema";
import { idempotencyKey } from "../domain/idempotency";
import { monitoringJobSchema, type MonitoringJob } from "../domain/schedules";
import { alertPayloadSchema, replySchema, type AlertPayload, type IncomingReply, type RunSummary } from "../monitoring/contracts";

export class MonitoringRepository {
  constructor(private readonly db: PgDatabase<PgQueryResultHKT>) {}

  async claimWindow(job: MonitoringJob, window: string, now: Date) {
    monitoringJobSchema.parse(job); z.string().min(1).max(40).parse(window); z.date().parse(now);
    const [created] = await this.db.insert(workflowRuns).values({ workflow: job, scheduledWindow: window,
      workflowRunId: `dispatch:${idempotencyKey(job, window)}`, createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: [workflowRuns.workflow, workflowRuns.scheduledWindow] }).returning();
    const row = created ?? (await this.db.select().from(workflowRuns)
      .where(and(eq(workflowRuns.workflow, job), eq(workflowRuns.scheduledWindow, window))))[0];
    if (!row) throw new Error("Missing schedule claim");
    return { acquired: Boolean(created), run: row };
  }

  async getRun(id: string) {
    z.string().uuid().parse(id);
    const [row] = await this.db.select().from(workflowRuns).where(eq(workflowRuns.id, id));
    if (!row) throw new Error("Unknown monitoring run");
    return row;
  }
  async recordDispatch(id: string, workflowRunId: string) {
    await this.db.update(workflowRuns).set({ workflowRunId, updatedAt: new Date() }).where(eq(workflowRuns.id, id));
  }
  async dispatchUncertain(id: string) {
    await this.db.update(workflowRuns).set({ status: "paused", errorCode: "dispatch_unknown", updatedAt: new Date() })
      .where(and(eq(workflowRuns.id, id), eq(workflowRuns.status, "pending")));
  }
  async running(id: string) {
    await this.db.update(workflowRuns).set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(workflowRuns.id, id), eq(workflowRuns.status, "pending")));
  }
  async finish(id: string, summary: RunSummary) {
    await this.db.update(workflowRuns).set({ status: "succeeded", result: summary, endedAt: new Date(), updatedAt: new Date(), errorCode: null })
      .where(eq(workflowRuns.id, id));
  }
  async fail(id: string) {
    await this.db.update(workflowRuns).set({ status: "failed", errorCode: "monitoring_failed", endedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(workflowRuns.id, id), sql`${workflowRuns.status} in ('pending', 'running')`));
  }
  async pause(id: string) {
    await this.db.update(workflowRuns).set({ status: "paused", errorCode: "monitoring_disabled", updatedAt: new Date() })
      .where(and(eq(workflowRuns.id, id), sql`${workflowRuns.status} in ('pending', 'running')`));
  }

  async executionTotals(start: Date, end: Date) {
    const actions = await this.db.select({ status: actionAttempts.status, count: sql<number>`count(*)::int`,
      cost: sql<string>`coalesce(sum(${actionAttempts.costUsd}), 0)::text`,
      missingCost: sql<number>`count(*) filter (where ${actionAttempts.costUsd} is null)::int` })
      .from(actionAttempts).where(and(gte(actionAttempts.createdAt, start), lt(actionAttempts.createdAt, end))).groupBy(actionAttempts.status);
    const runs = await this.db.select({ status: workflowRuns.status, count: sql<number>`count(*)::int` })
      .from(workflowRuns).where(and(gte(workflowRuns.createdAt, start), lt(workflowRuns.createdAt, end))).groupBy(workflowRuns.status);
    return { actions, runs };
  }

  async enqueueAlert(key: string, payload: AlertPayload) {
    const clean = alertPayloadSchema.parse(payload);
    const [created] = await this.db.insert(monitoringAlerts).values({ dedupeKey: key, kind: clean.kind, payload: clean })
      .onConflictDoNothing({ target: monitoringAlerts.dedupeKey }).returning();
    return Boolean(created);
  }

  async pendingReplies() {
    return this.db.select({ providerMessageId: inboxMessages.providerMessageId, contactId: inboxMessages.contactId,
      receivedAt: inboxMessages.receivedAt, preview: inboxMessages.preview })
      .from(inboxMessages).where(isNull(inboxMessages.processedAt)).orderBy(inboxMessages.receivedAt).limit(500);
  }

  async processReply(value: IncomingReply) {
    const input = replySchema.parse(value);
    const key = idempotencyKey("reply-alert", input.providerMessageId);
    return this.db.transaction(async (tx) => {
      await tx.insert(inboxMessages).values(input).onConflictDoNothing({ target: inboxMessages.providerMessageId });
      const [existing] = await tx.select().from(inboxMessages).where(eq(inboxMessages.providerMessageId, input.providerMessageId));
      if (!existing || existing.contactId !== input.contactId) throw new Error("Inbox identity mismatch");
      await tx.insert(suppressionEntries).values({ contactId: input.contactId, reason: "reply_detected", source: "reply_monitor" })
        .onConflictDoUpdate({ target: suppressionEntries.contactId, set: { active: true, updatedAt: new Date() } });
      const payload: AlertPayload = { kind: "reply_monitor", text: `New reply for contact ${input.contactId}. Pending outreach is suppressed. Review the contact in GHL; no response has been sent.` };
      const [alert] = await tx.insert(monitoringAlerts).values({ dedupeKey: key, kind: payload.kind, payload })
        .onConflictDoNothing({ target: monitoringAlerts.dedupeKey }).returning();
      await tx.update(inboxMessages).set({ processedAt: new Date() }).where(eq(inboxMessages.providerMessageId, input.providerMessageId));
      return Boolean(alert);
    });
  }

  async openEscalations() { return this.db.select().from(escalationQueue).where(isNull(escalationQueue.resolvedAt)); }
  async pendingAlerts(kind: MonitoringJob) {
    return this.db.select().from(monitoringAlerts)
      .where(and(eq(monitoringAlerts.kind, kind), eq(monitoringAlerts.status, "pending")))
      .orderBy(monitoringAlerts.createdAt).limit(100);
  }
  async claimAlert(id: string) {
    const [row] = await this.db.update(monitoringAlerts).set({ status: "sending", updatedAt: new Date() })
      .where(and(eq(monitoringAlerts.id, id), eq(monitoringAlerts.status, "pending"))).returning();
    return row ?? null;
  }
  async finishAlert(id: string, status: "sent" | "unknown" | "pending", messageId?: string) {
    await this.db.update(monitoringAlerts).set({ status, providerMessageId: messageId, updatedAt: new Date() })
      .where(and(eq(monitoringAlerts.id, id), eq(monitoringAlerts.status, "sending")));
  }
}


