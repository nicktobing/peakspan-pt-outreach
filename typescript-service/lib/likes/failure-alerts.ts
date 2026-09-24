import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";
import { actionAttempts, monitoringAlerts, workflowRuns } from "../db/schema";
import { batchStateSchema } from "./batch-contracts";
import { idempotencyKey } from "../domain/idempotency";
import { sydneyBoundary, sydneyParts } from "../domain/schedules";
import { ProviderError } from "../clients/errors";

export const OUTREACH_REPORT_CHANNEL = "C0B047Q4DEU";
const kind = "instagram_failure";
const dailyKind = "instagram_daily_summary";
const payloadSchema = z.object({ text: z.string().min(1).max(4000), sessionId: z.uuid().optional() });
const directoryIncidentSchema = z.object({ contactId: z.string().min(1).optional(), retryCount: z.number().int().min(0).max(1).optional(),
  pausedFrom: z.string().max(50).optional(), failureCode: z.string().max(100).optional() }).passthrough();
export function directoryFailureKey(id: string, value: unknown) {
  const parsed = directoryIncidentSchema.safeParse(value); const data = parsed.success ? parsed.data : {};
  return idempotencyKey("directory_import_failure", id, String(data.retryCount ?? 0), data.contactId ? "contact" : "none",
    data.pausedFrom ?? "unknown_phase", data.failureCode ?? "unknown_failure");
}
export function directoryFailureText(id: string, value: unknown) {
  const parsed = directoryIncidentSchema.safeParse(value); const hasContact = parsed.success && Boolean(parsed.data.contactId);
  const guidance = hasContact ? "Inspect the saved contact reference before resuming." : "No contact ID was returned; inspect GHL before any retry.";
  return `[PeakSpan outreach] Directory import needs attention. Import: ${id}. No automatic create retry will be attempted. ${guidance}`;
}
export type FailureSink = { channelId: string; enabled(): boolean; send(text: string): Promise<{ channel: string; messageId: string }> };
export class FailureAlertRepository {
  constructor(private readonly db: PgDatabase<PgQueryResultHKT>) {}
  async enqueue(key: string, payload: z.infer<typeof payloadSchema>) {
    const [row] = await this.db.insert(monitoringAlerts).values({ kind, dedupeKey: key, payload: payloadSchema.parse(payload) })
      .onConflictDoNothing({ target: monitoringAlerts.dedupeKey }).returning();
    return row?.id;
  }
  async collect(now = new Date()) {
    const rows = await this.db.select().from(workflowRuns).where(and(eq(workflowRuns.workflow, "instagram_like_batch"),
      inArray(workflowRuns.status, ["pending", "running", "paused", "failed"])));
    let queued = 0;
    for (const row of rows) {
      const parsed = batchStateSchema.safeParse(row.result);
      const s = parsed.success ? parsed.data : undefined;
      const stalled = now.getTime() > Math.max(row.updatedAt.getTime(), s ? Date.parse(s.nextAt) : 0) + 15 * 60000;
      if (!["paused", "failed"].includes(row.status) && !stalled) continue;
      const reason = !s ? "invalid_session_state" : stalled && row.status !== "paused" && row.status !== "failed" ? "stalled_session" : s.reason ?? row.errorCode ?? "session_failed";
      // Never send raw provider errors, arbitrary text, cookies or contact details.
      const safeReason = /^[a-z_]{1,80}$/.test(reason) ? reason : "session_needs_attention";
      const incident = s?.attentionAt ?? row.updatedAt.toISOString();
      const text = `[PeakSpan outreach] Instagram session needs attention\nSession: ${row.id}\nStatus: ${row.status}; reason: ${safeReason}\nProgress: ${s ? `${s.cursor}/${s.items.length} contacts` : "unavailable"}\nReview the saved session before resuming. An uncertain provider action must not be sent again.`;
      if (await this.enqueue(idempotencyKey(kind, row.id, incident, safeReason), { text, sessionId: row.id })) queued++;
    }
    const imports = await this.db.select().from(actionAttempts).where(and(eq(actionAttempts.action, "directory_import"), inArray(actionAttempts.status, ["running", "paused"])));
    for (const row of imports) {
      if (row.status !== "paused" && now.getTime() <= row.updatedAt.getTime() + 15 * 60000) continue;
      if (await this.enqueue(directoryFailureKey(row.id, row.result), {
        text: directoryFailureText(row.id, row.result),
      })) queued++;
    }
    return queued;
  }
  async test(requestId: string) {
    z.uuid().parse(requestId);
    const key = idempotencyKey(kind, "test", requestId);
    await this.enqueue(key, { text: "[TEST] PeakSpan outreach live failure alerts are connected to your private Slack DM. This is a delivery test; no Instagram action was performed." });
    const [row] = await this.db.select().from(monitoringAlerts).where(eq(monitoringAlerts.dedupeKey, key));
    return row.id;
  }
  async read(id: string) {
    const [row] = await this.db.select().from(monitoringAlerts).where(and(eq(monitoringAlerts.id, z.uuid().parse(id)), eq(monitoringAlerts.kind, kind)));
    if (!row) throw new Error("Unknown alert");
    return { id: row.id, status: row.status, messageId: row.providerMessageId };
  }
  async recent() {
    const rows = await this.db.select({ id: monitoringAlerts.id, status: monitoringAlerts.status, messageId: monitoringAlerts.providerMessageId,
      updatedAt: monitoringAlerts.updatedAt }).from(monitoringAlerts).where(eq(monitoringAlerts.kind, kind)).orderBy(desc(monitoringAlerts.createdAt)).limit(30);
    return rows.map((row) => ({ ...row, needsAttention: row.status === "unknown" || row.status === "sending" }));
  }
  async enqueueDailySummary(now = new Date()) {
    const date = sydneyParts(now).date; const start = sydneyBoundary(date);
    const actions = await this.db.select().from(actionAttempts).where(and(gte(actionAttempts.createdAt, start), lt(actionAttempts.createdAt, now),
      inArray(actionAttempts.action, ["directory_import", "like", "follow", "comment_1", "comment_2", "comment_3", "dm"])));
    const sessions = await this.db.select().from(workflowRuns).where(and(gte(workflowRuns.createdAt, start), lt(workflowRuns.createdAt, now),
      eq(workflowRuns.workflow, "instagram_like_batch")));
    const incidents = await this.db.select().from(monitoringAlerts).where(and(gte(monitoringAlerts.createdAt, start), lt(monitoringAlerts.createdAt, now),
      eq(monitoringAlerts.kind, kind)));
    const counts = (values: { status: string }[]) => Object.fromEntries([...new Set(values.map((row) => row.status))].sort()
      .map((status) => [status, values.filter((row) => row.status === status).length]));
    const imports = actions.filter((row) => row.action === "directory_import"); const likes = actions.filter((row) => row.action === "like");
    const follows = actions.filter((row) => row.action === "follow");
    const comments = actions.filter((row) => ["comment_1", "comment_2", "comment_3"].includes(row.action));
    const dms = actions.filter((row) => row.action === "dm");
    const unresolved = incidents.filter((row) => ["pending", "sending", "unknown"].includes(row.status)).length;
    const text = `[PeakSpan outreach] Daily report for ${date} (Australia/Sydney)\n` +
      `Directory imports: ${imports.length}; status ${JSON.stringify(counts(imports))}.\n` +
      `Instagram likes: ${likes.length}; status ${JSON.stringify(counts(likes))}.\n` +
      `Instagram follows: ${follows.length}; status ${JSON.stringify(counts(follows))}.\n` +
      `Instagram comments: ${comments.length}; status ${JSON.stringify(counts(comments))}.\n` +
      `Instagram DMs: ${dms.length}; status ${JSON.stringify(counts(dms))}.\n` +
      `Like batches: ${sessions.length}; status ${JSON.stringify(counts(sessions))}.\n` +
      `Operational incidents: ${incidents.length}; unresolved delivery or handling: ${unresolved}.`;
    const key = idempotencyKey(dailyKind, date);
    const [created] = await this.db.insert(monitoringAlerts).values({ kind: dailyKind, dedupeKey: key, payload: payloadSchema.parse({ text }) })
      .onConflictDoNothing({ target: monitoringAlerts.dedupeKey }).returning();
    const [row] = created ? [created] : await this.db.select().from(monitoringAlerts).where(eq(monitoringAlerts.dedupeKey, key));
    return row.id;
  }
  async drain(sink: FailureSink, alertKind = kind) {
    if (!sink.enabled()) return { sent: 0, uncertain: 0 };
    // A worker killed after claiming may have delivered. Preserve uncertainty, never blind-retry.
    await this.db.update(monitoringAlerts).set({ status: "unknown", updatedAt: new Date() }).where(and(eq(monitoringAlerts.kind, alertKind),
      eq(monitoringAlerts.status, "sending"), lt(monitoringAlerts.updatedAt, new Date(Date.now() - 15 * 60000))));
    const pending = await this.db.select().from(monitoringAlerts).where(and(eq(monitoringAlerts.kind, alertKind), eq(monitoringAlerts.status, "pending")))
      .orderBy(monitoringAlerts.createdAt).limit(20);
    let sent = 0;
    for (const row of pending) {
      if (!sink.enabled()) break;
      const payload = payloadSchema.parse(row.payload);
      const [claimed] = await this.db.update(monitoringAlerts).set({ status: "sending", updatedAt: new Date() }).where(and(
        eq(monitoringAlerts.id, row.id), eq(monitoringAlerts.status, "pending"))).returning();
      if (!claimed) continue;
      try {
        const result = await sink.send(payload.text);
        if (result.channel !== sink.channelId || !/^\d+\.\d+$/.test(result.messageId)) throw new Error("Unverified Slack result");
        await this.db.update(monitoringAlerts).set({ status: "sent", providerMessageId: result.messageId, updatedAt: new Date() })
          .where(and(eq(monitoringAlerts.id, row.id), eq(monitoringAlerts.status, "sending")));
        sent++;
      } catch (error) {
        const definiteRejection = error instanceof ProviderError && !["unknown_outcome", "invalid_response"].includes(error.kind);
        await this.db.update(monitoringAlerts).set({ status: definiteRejection ? "pending" : "unknown", updatedAt: new Date() })
          .where(and(eq(monitoringAlerts.id, row.id), eq(monitoringAlerts.status, "sending")));
        break;
      }
    }
    const [unresolved] = await this.db.select({ count: sql<number>`count(*)::int` }).from(monitoringAlerts)
      .where(and(eq(monitoringAlerts.kind, alertKind), eq(monitoringAlerts.status, "unknown")));
    return { sent, uncertain: unresolved.count };
  }
}

